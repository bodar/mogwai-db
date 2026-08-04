import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { MapOf, Shape } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/step.ts';
import { byEncounter, jsonOf, meta, typeOf, typedNode, type Minter } from './build.ts';
import { elementNode } from './element.ts';
import { byNode, modulations, productivityFilter, type ByHost } from './modulator.ts';

/**
 * THE MAP SHAPE — a barrier whose result is ONE map, as a value in the algebra.
 *
 * The eighth vocabulary module on `build.ts`, and deliberately the LIST module's twin: a list is one
 * JSONB `list` column per row and a map is one JSONB `map` column, so both are ordinary values that
 * flow through the same relations and reach the wire through this module's own `mapPayload` exactly as a
 * list reaches it through `listPayload` (§10·9 — a shape is a value plus a framing arm, never a delegated
 * step; §10·10 — that arm is a PROJECTION the algebra builds, not a call into legacy's materializer).
 *
 * ## Calcite's decomposition, which is two ordinary nodes
 *
 * `g.V().groupCount().by('age')` is not a "group step". It is:
 *
 * 1. `Aggregate(groupBy: [<key>], aggs: [<value>])` — the grouped RELATION, one row per key;
 * 2. `Aggregate(groupBy: [], aggs: [<pairs array>])` — that relation folded into ONE map value.
 *
 * Calcite says the same thing, and it is checkable at the pin: `Aggregate` yields a relation
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/Aggregate.java:80` — `extends
 * SingleRel`, so a relation in and a relation out), while a collection VALUE comes from an aggregate
 * FUNCTION over a group (`…/sql/fun/SqlStdOperatorTable.java:2494` `COLLECT`, typed by
 * `…/sql/type/ReturnTypes.java:847` `TO_MULTISET`; `…/sql/fun/SqlStdOperatorTable.java:1662`
 * `JSON_OBJECTAGG`) or from a constructor expression (`…:2374` `MAP_VALUE_CONSTRUCTOR`), with MAP a
 * first-class TYPE (`…/rel/type/RelDataTypeFactory.java:134` `createMapType`). There is no map STREAM
 * anywhere in it. `Aggregate.groupBy` was already in our node set and unused for this, so the
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
/** The TRAVERSER, carried into the grouped relation's scope so a collecting group can read it. A
 *  `groupCount()` never needs it — it reduces to a number — so it rides only where `group()` asks. */
const MEMBER_COL = 'gt';

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
 * `group()` is the second arm, and its VALUE is a list of the traversers themselves — `Map<K, List<V>>`,
 * `GroupStep`'s default with no value `by()`. Over an element stream that is a list of elements, and it
 * needs no `MapOf` arm and no per-pair expansion at the root: an element is a MEMBER of the
 * self-describing tree (`elementNode`, `element.ts`), so the value side is `{t: 'list', v: [...]}` whose
 * members are `{t: 'vertex', v: {...}}`, and the framer walks it by the one rule it already has for a
 * typed list. That is what `materialize.ts`'s `'a terminal map with an element key or value not yet
 * supported'` was really blocked on — not the SQL, but a wire vocabulary that made an element a member.
 *
 * `group()` with a value `by()` still declines: a reducer value is a scalar and lands with the reducer
 * family's vocabulary; an element/list value `by()` needs the child seam.
 */
export function groupBarrier(
  input: Rel, host: ByHost, step: IRStep, bulked: boolean, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } | null {
  if (step.optionArms || (step.args ?? []).length > 0) return null;
  if (step.name !== 'groupCount' && step.name !== 'group') return null;
  // A VALUE `by()` is a second slot this arm does not implement. `modulations(step, 1)` would decline it
  // anyway, but saying so here is what keeps the two arms' coverage readable.
  if (step.name === 'group' && (step.modulators ?? []).length > 1) return null;
  // A group's members are the ELEMENTS, so a scalar host has no element to collect. It is a real arm —
  // the members are the values, tagged by their own `vtype` — and it arrives with the scalar-host caller
  // that does not exist yet, rather than being guessed at here.
  if (step.name === 'group' && host.kind !== 'element') return null;

  const bys = modulations(step, 1);
  // A bare `groupCount()` groups by the TRAVERSER, so an element stream would need an element key —
  // which the materializer expands per pair rather than tagging. Over a SCALAR stream the traverser IS
  // a value, so `by()`-less is exactly the identity projection and works.
  if (!bys) return null;
  const key = byNode(bys[0] ?? { key: { kind: 'identity' } }, host, fresh);
  if (!key) return null;

  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  // A COLLECTING group carries the traverser and, where the chain has one, its emission position: the
  // members' order is observable (they ride inside one buffer) so it must be stated, and the position is
  // the only thing that states the TRAVERSERS' order rather than the rowids'. Carried only for `group()`,
  // because a `groupCount()` projection that named columns it never reads would be state nothing reads —
  // the same rule the channel obligations apply one layer down.
  const collecting = step.name === 'group';
  const encounter = collecting ? input.channels.find((channel) => channel.role === 'encounter') : undefined;
  const extra = [
    ...(collecting ? [meta(MEMBER_COL, 'int')] : []),
    ...(bulk ? [meta(bulk.col, 'int')] : []),
    ...(encounter ? [meta(encounter.col, 'int')] : []),
  ];

  // THE KEY IS PROJECTED TO A COLUMN FIRST, and that is a plan-quality requirement rather than a
  // tidiness one. A `by()` key is a correlated subquery, and SQL needs it in the SELECT list AND the
  // GROUP BY — so grouping directly by the expression inlines the whole subquery at every position it
  // appears, which an L2 assertion caught at FOUR copies (select, group by, and twice more once the
  // productivity filter became a HAVING). Naming it once means every later reference is a column.
  //
  // The CHANNELS it declares are the ones it still carries as channels — the traverser rides as an
  // ordinary payload column, because at a barrier it is data being collected rather than per-row state.
  const projected = make.project({
    id: fresh('gk'), input, channels: [...(bulk ? [bulk] : []), ...(encounter ? [encounter] : [])],
    type: typeOf(meta(KEY_COL, 'json', true), ...extra),
    exprs: [
      [KEY_COL, key],
      ...(collecting ? [[MEMBER_COL, col(input.id, 'id')] as const] : []),
      ...(bulk ? [[bulk.col, col(input.id, bulk.col)] as const] : []),
      ...(encounter ? [[encounter.col, col(input.id, encounter.col)] as const] : []),
    ],
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
  // THE VALUE, and the two arms differ only here. `groupCount()` reduces the group to a traverser COUNT
  // — `SUM(bulk)` where the stream carries a multiplicity, `COUNT(*)` where it cannot, identical while
  // bulk ≡ 1 and correct after a fan-out. `group()` COLLECTS the traversers instead, as a typed list of
  // element members.
  //
  // MEMBER ORDER IS THE TRAVERSERS' OWN, and it is stated rather than inherited: a group's members ride
  // inside one collected traverser's buffer, so their order is fully observable, and `json_group_array`
  // takes rows in whatever order SQLite scanned. The emission order where the chain carries one, the
  // rowid otherwise — a total order either way, which is what `mise run test:perturbed` exists to check.
  const members: Expr = {
    kind: 'json-object',
    entries: [['t', lit('list', 'text')], ['v', {
      kind: 'agg', fn: 'json_group_array',
      args: [jsonOf(elementNode(col(rows.id, MEMBER_COL), (host as Extract<ByHost, { kind: 'element' }>).elem, fresh))],
      orderBy: [{ expr: col(rows.id, encounter ? encounter.col : MEMBER_COL), dir: 'asc' }],
    }]],
    binary: false,
  };
  const count: Expr = bulked && bulk
    ? { kind: 'agg', fn: 'sum', args: [col(rows.id, bulk.col)] }
    : { kind: 'agg', fn: 'count', args: [lit(1, 'int')] };
  const value = step.name === 'group' ? members : count;
  const productive = make.aggregate({
    id: fresh('gb'), input: rows,
    channels: [], type: typeOf(meta(KEY_COL, 'json', true), meta(VAL_COL, step.name === 'group' ? 'json' : 'int')),
    groupBy: [col(rows.id, KEY_COL)],
    aggs: [[VAL_COL, value]],
  });

  // A COUNT is a Gremlin `long`, and the tag is what makes the wire agree with legacy's `countBuffer`
  // (an explicit Int64) rather than letting magnitude inference pick Int for a small count. A COLLECTED
  // group needs no envelope added: `members` already IS one.
  const entry: Entry = {
    key: col(productive.id, KEY_COL),
    val: step.name === 'group' ? col(productive.id, VAL_COL) : typedNode(col(productive.id, VAL_COL), lit('long', 'text')),
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

/**
 * THE MAP PAYLOAD — one row's `map` column as the JSON the framing layer reads (§10·10), or `null` to
 * decline.
 *
 * The blob is ALREADY the frameable tree: `[[keyNode, valNode], …]` with self-describing `{t,v}` scalar
 * sides, which is the encoding every producer here emits and the one `frameTypedNode` decodes. So the
 * projection is `json(map)` and nothing else — the relational column is JSONB and `json()` is what turns it
 * into the text the framer parses. A LIST value side needs no conversion either: the blob's value side is a
 * naked array, and the typed framer treats a bare array as a list of bare members exactly as it treats a
 * bare scalar as an inferred value. ONE blob encoding, not two with a rebuild between them.
 *
 * An ELEMENT side declines. This is the `materialize.ts:191` throw that §10·10 names as the thing blocking
 * `group()`, and it now sits on the correct side of the boundary: a decline routes to the spine that
 * answers, and building it is `element.ts`'s payload reached per pair — the same expansion the element-list
 * arm wants. `groupBarrier` above emits scalar sides only, so nothing reachable today declines here.
 */
export function mapPayload(rel: Rel, keyOf: MapOf, valOf: MapOf, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } | null {
  if (keyOf.kind === 'elem' || valOf.kind === 'elem') return null;
  const ordered = byEncounter(rel, fresh);
  return {
    rel: make.project({
      id: fresh('mw'), input: ordered, channels: [], type: typeOf(meta(MAP_COL, 'json', true)),
      exprs: [[MAP_COL, jsonOf(col(ordered.id, MAP_COL))]],
    }),
    shape: { kind: 'mapValue' },
  };
}
