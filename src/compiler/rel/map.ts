import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { MapOf } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/step.ts';
import { meta, typeOf, typedNode, type Minter } from './build.ts';
import { byNode, modulations, productivityFilter, type ByHost } from './modulator.ts';

/**
 * THE MAP SHAPE — a barrier whose result is ONE map, as a value in the algebra.
 *
 * The eighth vocabulary module on `build.ts`, and deliberately the LIST module's twin: a list is one
 * JSONB `list` column per row and a map is one JSONB `map` column, so both are ordinary values that
 * flow through the same relations and are framed by the same single `materializeRootStream` call
 * (§10·9 — a shape is a value plus a framing arm, never a delegated step).
 *
 * ## Calcite's decomposition, which is two ordinary nodes
 *
 * `g.V().groupCount().by('age')` is not a "group step". It is:
 *
 * 1. `Aggregate(groupBy: [<key>], aggs: [<value>])` — the grouped RELATION, one row per key;
 * 2. `Aggregate(groupBy: [], aggs: [<pairs array>])` — that relation folded into ONE map value.
 *
 * Calcite says the same thing: `Aggregate` yields a relation, and a collection VALUE comes from an
 * aggregate FUNCTION over a group (`COLLECT` with `ReturnTypes.TO_MULTISET`, `JSON_OBJECTAGG`) or a
 * constructor expression (`MAP_VALUE_CONSTRUCTOR`), with MAP a first-class type. There is no map
 * STREAM anywhere in it. `Aggregate.groupBy` was already in our node set and unused for this, so the
 * relational half of the family needed nothing built.
 *
 * TinkerPop separates the two producers by SUPERCLASS — `GroupStep extends ReducingBarrierStep<S,
 * Map<K,V>>` against `PropertyMapStep extends ScalarMapStep<Element, Map<K,E>>` — while both carry the
 * same `Map<K,V>` value. So the barrier-versus-per-row difference belongs to the PRODUCER and the shape
 * is genuinely one shape, which is what makes `valueMap` a later caller of this module rather than a
 * second copy of it.
 *
 * ## A PAIRS ARRAY, not a JSON object
 *
 * The value is `[[keyNode, valNode], …]` — the same self-describing tree a stored map property uses.
 * Two reasons, both load-bearing: `json_group_object` would stringify the key, so an element or a
 * numeric key could not round-trip; and an object has no order of its own, while the entry order here
 * is ours to STATE (by the key) rather than to inherit from whatever the grouping produced.
 */

/** The map column every map relation carries. One name, because the framing layer reads it too — the
 *  exact standing `LIST_COL` has. */
export const MAP_COL = 'map';

/** A key and a value as `{t,v}` nodes, plus what the framing layer must be told about each side. */
interface Entry {
  readonly key: Expr;
  readonly val: Expr;
  readonly keyOf: MapOf;
  readonly valOf: MapOf;
}

/**
 * The grouped relation folded into ONE map value.
 *
 * `COALESCE` is not defensive and the list module needs it for the same reason: `json_group_array` over
 * ZERO rows is NULL, so grouping an empty stream would yield a null traverser value instead of an empty
 * map. A `group()` over no traversers is an EMPTY MAP and still one traverser.
 */
function mapOfGroups(grouped: Rel, entry: Entry, order: Expr, fresh: Minter): Rel {
  return make.aggregate({
    id: fresh('mg'), input: grouped, channels: [], type: typeOf(meta(MAP_COL, 'json')),
    groupBy: [],
    aggs: [[MAP_COL, {
      kind: 'call',
      fn: 'jsonb',
      args: [{
        kind: 'call',
        fn: 'COALESCE',
        args: [
          {
            kind: 'agg',
            fn: 'json_group_array',
            // `json()` AROUND EACH SIDE IS LOAD-BEARING, and it is the list module's own warning one
            // shape over: without it `json_group_array` re-encodes the `{t,v}` envelope as a JSON
            // STRING, so the framer sees the text `{"t":"int","v":27}` where a tagged 27 belongs. It
            // shows up as a wire byte diff and nothing else — the entry COUNT and the VALUES are
            // already right, which is what makes a byte-level differential the only instrument that
            // sees it.
            args: [{
              kind: 'json-array',
              items: [
                { kind: 'call', fn: 'json', args: [entry.key] },
                { kind: 'call', fn: 'json', args: [entry.val] },
              ],
              binary: false,
            }],
            orderBy: [{ expr: order, dir: 'asc' }],
          },
          { kind: 'call', fn: 'json', args: [lit('[]', 'text')] },
        ],
      }],
    }]],
  });
}

/** The column the grouped relation holds its key in. It is `Aggregate`'s FIRST declared column, because
 *  the emitter names `groupBy` exprs before the aggregates (`emit.ts`'s `aggregate` case). */
const KEY_COL = 'gk';
const VAL_COL = 'gv';

/**
 * `group()`/`groupCount()` with NO side-effect label — the barrier, as a map value, or `null` to
 * decline.
 *
 * A LABEL argument is a different family entirely: `groupCount('a')` fills a named collection that a
 * later `cap('a')` reads back, which needs the side-effect substrate and not this one. Declining on the
 * argument is what keeps the two apart (and `rel-blockers`' `blame()` counts them apart for the same
 * reason).
 *
 * What is covered: `groupCount()` with a key `by()`, over an element or scalar stream. The value is the
 * TRAVERSER COUNT per key — `SUM(bulk)` where the stream carries a multiplicity, `COUNT(*)` where it
 * cannot, which is identical while bulk ≡ 1 and correct after a fan-out. That is legacy's own rule and
 * the reason it is a rule rather than a constant.
 *
 * `group()` declines for now, and the reason is worth stating because it is not laziness: with no value
 * `by()` its value is a LIST OF ELEMENTS per key, so `valOf` is `{kind: 'list', of: 'elem'}` and the
 * materializer expands each pair — a real arm, and the next one. With a reducer value `by()` it is a
 * scalar and lands with the reducer family's own vocabulary.
 */
export function groupBarrier(
  input: Rel, host: ByHost, step: IRStep, bulked: boolean, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } | null {
  if (step.optionArms || (step.args ?? []).length > 0) return null;
  if (step.name !== 'groupCount') return null;

  const bys = modulations(step, 1);
  // A bare `groupCount()` groups by the TRAVERSER, so an element stream would need an element key —
  // which the materializer expands per pair rather than tagging. Over a SCALAR stream the traverser IS
  // a value, so `by()`-less is exactly the identity projection and works.
  if (!bys) return null;
  const key = byNode(bys[0] ?? { key: { kind: 'identity' } }, host, fresh);
  if (!key) return null;

  const bulk = input.channels.find((channel) => channel.role === 'bulk');

  // THE KEY IS PROJECTED TO A COLUMN FIRST, and that is a plan-quality requirement rather than a
  // tidiness one. A `by()` key is a correlated subquery, and SQL needs it in the SELECT list AND the
  // GROUP BY — so grouping directly by the expression inlines the whole subquery at every position it
  // appears, which an L2 assertion caught at FOUR copies (select, group by, and twice more once the
  // productivity filter became a HAVING). Naming it once means every later reference is a column.
  const projected = make.project({
    id: fresh('gk'), input, channels: bulk ? [bulk] : [],
    type: typeOf(meta(KEY_COL, 'json', true), ...(bulk ? [meta(bulk.col, 'int')] : [])),
    exprs: [[KEY_COL, key], ...(bulk ? [[bulk.col, col(input.id, bulk.col)] as const] : [])],
  });
  // FENCED, or the projection is fused straight back in and the naming buys nothing: the emitter merges
  // a plain `Project` into the aggregate's own block, so `gk` becomes the expression again in the SELECT
  // and the GROUP BY. Measured against legacy, which CTEs its key: 3 copies of the property subquery
  // against legacy's 1, and 6 against 4 for a label key. With the fence the key is computed once, which
  // is §5a's access-path half of the equivalence gate and not a cosmetic preference.
  const keyed = make.materialize({ id: fresh('gm'), input: projected, channels: projected.channels, type: projected.type });
  // TinkerPop drops an unproductive key rather than grouping under null — UNLESS `ProductiveByStrategy`
  // asked for the null-keeping behaviour, which is why this asks `productivityFilter` rather than
  // spelling the test. Hardcoding `IS NOT NULL` changed the answer for
  // `withStrategies(ProductiveByStrategy).V().groupCount().by('age')`; the census caught it and a
  // byte-level differential could not, because both spines were being asked the wrong question
  // identically until one of them stopped.
  //
  // BEFORE the aggregate, now that the key is a column: dropping the rows whose key is null is the same
  // answer as dropping the null GROUP, and a `WHERE` on a column beats a `HAVING` that re-inlines.
  // The traverser count per key, read off the PROJECTION rather than the input — `keyed` is what the
  // aggregate's scope actually holds. `bulked` is the chain-global fact that a row may stand for N
  // traversers and is threaded, not re-derived, for the reason `ordered` is not: `SUM(bulk)` where the
  // stream carries a multiplicity, `COUNT(*)` where it cannot, identical while bulk ≡ 1 and correct
  // after a fan-out.
  const drop = productivityFilter(step, col(keyed.id, KEY_COL));
  // The aggregate's own DIRECT input, because a `Col` names a relation in SCOPE and scope is a node's
  // direct children (§3.3). With the filter present, `keyed` is the GRANDchild — naming it is the
  // "no relation in scope" the checker catches, and it caught this.
  const rows = drop
    ? make.filter({ id: fresh('gf'), input: keyed, channels: keyed.channels, type: keyed.type, pred: drop })
    : keyed;
  const count: Expr = bulked && bulk
    ? { kind: 'agg', fn: 'sum', args: [col(rows.id, bulk.col)] }
    : { kind: 'agg', fn: 'count', args: [lit(1, 'int')] };
  const productive = make.aggregate({
    id: fresh('gb'), input: rows,
    channels: [], type: typeOf(meta(KEY_COL, 'json', true), meta(VAL_COL, 'int')),
    groupBy: [col(rows.id, KEY_COL)],
    aggs: [[VAL_COL, count]],
  });

  // A COUNT is a Gremlin `long`, and the tag is what makes the wire agree with legacy's `countBuffer`
  // (an explicit Int64) rather than letting magnitude inference pick Int for a small count.
  const entry: Entry = {
    key: col(productive.id, KEY_COL),
    val: typedNode(col(productive.id, VAL_COL), lit('long', 'text')),
    keyOf: { kind: 'scalar' },
    valOf: { kind: 'scalar' },
  };
  return {
    // Ordered by the KEY, which is legacy's choice too ("we emit rows ORDER BY the key"). A map's entry
    // order is not TinkerPop's to dictate, so it is ours to state — and stating it is what stops the
    // two spines differing by whatever the grouping happened to produce.
    rel: mapOfGroups(productive, entry, col(productive.id, KEY_COL), fresh),
    keyOf: entry.keyOf,
    valOf: entry.valOf,
  };
}

/** The host a `by()` projects from, for an ELEMENT relation — the shape `groupBarrier` needs handed to
 *  it, kept here so the two callers (element and scalar tails) cannot describe it differently. */
export const elementHost = (rel: Rel, elem: Elem): ByHost => ({ kind: 'element', id: col(rel.id, 'id'), elem });
