import { col, compilerInt, compilerText, type Expr } from '../../rel/expr.ts';
import type { LabelRegime } from '../../api.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { TYPED_MEMBERS, type ListOf, type MapOf, type Shape } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/step.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { and, byEncounter, carriedCols, coalesce, EDGE_COLS, eq, fenced, jsonOf, meta, NODE_COLS, PROPERTIES, typeOf, typedNode, withPayload, type Minter } from './build.ts';
import { inferredVtype, LIST_COL } from './list.ts';
import { edgeLabel, elementNode, vertexLabels } from './element.ts';
import { byExpr, byNode, modulations, productivityFilter } from './modulator.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import type { AliasMap } from '../plan/alias.ts';
import { isReducer } from './reducer.ts';

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
          { kind: 'call', fn: 'json', args: [compilerText('[]')] },
        ],
      }],
    }]],
  });
}

/** The column the grouped relation holds its key in. It is `Aggregate`'s FIRST declared column, because
 *  the emitter names `groupBy` exprs before the aggregates (`emit.ts`'s `aggregate` case). */
const KEY_COL = 'gk';
const VAL_COL = 'gv';
/** The MEMBER a collecting group puts in its list — the traverser's rowid where the members are the
 *  elements, the projected value where a value `by()` names one. Named once because the aggregate reads
 *  it either way and the difference is what the column HOLDS, never how it is collected.
 *  A `groupCount()` never carries it: it reduces to a number, and a projection naming a column it never
 *  reads is state nothing reads. */
const MEMBER_COL = 'gt';
/** The member ORDER, carried beside the member for the reason the members' order has to be stated at all:
 *  they ride inside one collected traverser's buffer, so it is fully observable, and `json_group_array`
 *  takes rows in scan order. The emission position where the chain has one, the traverser's own rowid
 *  otherwise — total either way, and a SEPARATE column from the member because a projected VALUE is not
 *  an order (two traversers can share one). */
const ORD_COL = 'go';

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
 * A VALUE `by()` needs no new framing: `byNode`'s second slot already yields a self-describing `{t,v}`
 * node. A wrapped property/token/identity projection collects those nodes; a non-reducing anonymous child
 * assigns one node. A REDUCING child value is a different group-scoped shape and remains declined here.
 */
export function groupBarrier(
  input: Rel, host: ChildHost, step: IRStep, bulked: boolean, child: ChildSeam, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } | null {
  if (step.optionArms) return null;
  if (step.name !== 'groupCount' && step.name !== 'group') return null;
  // A single STRING argument is a side-effect LABEL, and the grouping it names is built exactly the
  // same way — `GroupSideEffectStep` and `GroupStep` differ in what happens to the result, not in how
  // the map is computed. So this builds either, and the CALLER decides: the barrier form returns the
  // map as the traverser, the keyed form registers it and passes the traversers through. Anything
  // else in the argument position is a form this does not serve.
  const args = argValues(step);
  if (args.length > 1 || (args.length === 1 && typeof args[0] !== 'string')) return null;
  // A group's members are the ELEMENTS, so a scalar host has no element to collect. It is a real arm —
  // the members are the values, tagged by their own `vtype` — and it arrives with the scalar-host caller
  // that does not exist yet, rather than being guessed at here.
  if (step.name === 'group' && host.kind !== 'element') return null;

  // TWO SLOTS for `group()`, one for `groupCount()`, and that is the whole of the arity difference:
  // `GroupStep` takes a key `by()` and a value `by()`, `GroupCountStep` only a key.
  const collecting = step.name === 'group';
  const bys = modulations(step, collecting ? 2 : 1, child);
  // A bare `groupCount()` groups by the TRAVERSER, so an element stream would need an element key —
  // which the materializer expands per pair rather than tagging. Over a SCALAR stream the traverser IS
  // a value, so `by()`-less is exactly the identity projection and works.
  if (!bys) return null;
  const key = byNode(bys[0] ?? { key: { kind: 'identity' } }, host, fresh, child);
  if (!key) return null;

  // THE VALUE `by()`, where there is one. A slot `byNode` cannot project declines the whole step rather
  // than silently collecting the elements instead — which would be the right arity and the wrong answer,
  // the one thing the decline contract exists to prevent.
  const valueBy = bys[1];
  // A REDUCING traversal value is one scalar for the WHOLE group, not one member per incoming
  // traverser. The generic child expression reduces per parent, which is composable for neither the
  // framing (it would produce `[n]`) nor every reducer (`mean` needs the complete child-row domain,
  // not an average of per-parent means). That group-scoped reducer is a separate arm; decline until
  // it lands rather than collecting a plausible-looking wrong value.
  if (valueBy?.key.kind === 'child') {
    const terminal = valueBy.key.body.at(-1)?.name;
    if (terminal === 'count' || (terminal !== undefined && isReducer(terminal))) return null;
  }
  const member = valueBy ? byNode(valueBy, host, fresh, child) : undefined;
  if (valueBy && !member) return null;

  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  const encounter = collecting ? input.channels.find((channel) => channel.role === 'encounter') : undefined;
  const extra = [
    ...(collecting ? [meta(MEMBER_COL, 'any', true), meta(ORD_COL, 'int')] : []),
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
      // The MEMBER is the projected value where a value `by()` names one, and the traverser's rowid
      // otherwise — which `elementNode` then expands. The ORDER is separate because a projected value is
      // not an order: two traversers can share one, and the members would then collect in scan order.
      // analyzeChain demands an encounter for every group(), so the id fallback is unreachable for this
      // collecting arm; it remains only as a defensive fallback if that analysis contract is violated.
      ...(collecting ? [[MEMBER_COL, member ?? col(input.id, 'id')] as const, [ORD_COL, col(input.id, encounter ? encounter.col : 'id')] as const] : []),
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
  // BOTH `by()` slots owe the same drop, and the value's is not a refinement of the key's: TinkerPop's
  // unreduced value traversal that produces nothing FILTERS the traverser, so a person-only `by('age')`
  // over the whole graph drops the two software vertices and takes their KEYS with them where no other
  // traverser landed there. `ProductiveByStrategy` turns both off together, which is why this asks the
  // same function twice rather than spelling either test.
  const drop = productivityFilter(step, col(keyed.id, KEY_COL));
  /**
   * A CHILD value `by()` DOES filter the traverser, and a property `by(key)` does NOT — the same slot,
   * two rules, and the reference pins both on the modern graph. It reads like an inconsistency and is
   * not one: `by(key)` names a VALUE of the traverser, so an absent property leaves the traverser (and
   * therefore its key) intact with nothing to contribute; a TRAVERSAL is applied to the traverser, and
   * one that yields nothing yields no traverser to group at all.
   *
   * - key survives, empty list: `g.V().group().by("name").by("age")` → `ripple`/`lop` map to `[]`
   *   (`sideEffect/Group.feature`, the `memberDrop` comment below).
   * - key VANISHES: `g.V().has("person","name",within("vadas","peter")).group().by().by(__.out().order())`
   *   → only `v[peter]`, and the feature file's own comment above it says "validates that a collecting
   *   barrier produces a filtering effect if it is unproductive". Same for
   *   `g.V().group().by(values("name")).by(values("age").fold().unfold())`, where `lop`/`ripple` are
   *   absent rather than empty — a `values()` inside a TRAVERSAL filters where the bare key does not.
   *
   * So this filter is a pre-aggregate DOMAIN filter and belongs before the grouping, unlike
   * `memberDrop`. Removing it was tried during review, on the (wrong) reasoning that `by('age')` is
   * sugar for `by(__.values('age'))`; the second scenario above is what refutes that.
   */
  const childValueDrop = member && valueBy?.key.kind === 'child'
    ? productivityFilter(step, col(keyed.id, MEMBER_COL))
    : undefined;
  const domainDrop = drop && childValueDrop ? and(drop, childValueDrop) : drop ?? childValueDrop;
  // The aggregate's own DIRECT input, because a `Col` names a relation in SCOPE and scope is a node's
  // direct children (§3.3). With the filter present, `keyed` is the GRANDchild — naming it is the
  // "no relation in scope" the checker catches, and it caught this.
  const rows = domainDrop
    ? make.filter({ id: fresh('gf'), input: keyed, channels: keyed.channels, type: keyed.type, pred: domainDrop })
    : keyed;
  // THE VALUE. `groupCount()` reduces the group to a traverser COUNT — `SUM(bulk)` where the stream
  // carries a multiplicity, `COUNT(*)` where it cannot, identical while bulk ≡ 1 and correct after a
  // fan-out. A wrapped value `by()` (property/token/identity) and the default `group()` COLLECT members.
  // An anonymous child with no barrier is different: GroupStep takes the child's first emitted value
  // for each traverser and Operator.assign keeps the LAST arriving traverser's value for the key.
  //
  // MEMBER ORDER IS THE TRAVERSERS' OWN, and it is stated rather than inherited: a group's members ride
  // inside one collected traverser's buffer, so their order is fully observable, and `json_group_array`
  // takes rows in whatever order SQLite scanned. The emission order where the chain carries one, the
  // rowid otherwise — a total order either way, which is what `mise run test:perturbed` exists to check.
  const collected = member
    // A projected VALUE is already a self-describing `{t,v}` node (`byNode` builds it from the row the
    // value came from), so it is written back as it is. `json()` around it for the list module's own
    // reason: without it `json_group_array` re-encodes the envelope as a JSON STRING.
    ? jsonOf(col(rows.id, MEMBER_COL))
    : jsonOf(elementNode(col(rows.id, MEMBER_COL), (host as Extract<ChildHost, { kind: 'element' }>).elem, fresh));
  // THE VALUE'S PRODUCTIVITY DROPS THE MEMBER, NOT THE TRAVERSER AND NOT THE GROUP — and getting that
  // wrong has three distinguishable answers, which is why the reference is quoted rather than reasoned
  // from. `g.V().group().by("name").by("age")` over the modern graph: `ripple` and `lop` have no `age`,
  // and `sideEffect/Group.feature` says they map to **`[]`** — the key survives because the traverser
  // reached it, and the list is empty because the value produced nothing. Filtering the ROWS before the
  // aggregate deletes those keys instead (wrong), and collecting the NULL gives them `[null]` (also
  // wrong, and indistinguishable from a productive null under `ProductiveByStrategy`).
  //
  // So the drop is the aggregate's own `FILTER (WHERE …)`: the group is still whatever `GROUP BY` decided.
  // `productivityFilter` is asked here for the same reason it is asked for the key — `ProductiveByStrategy`
  // turns both off, and then a genuinely null value IS a member.
  const memberDrop = member ? productivityFilter(step, col(rows.id, MEMBER_COL)) : undefined;
  const memberAggregate: Expr = {
    kind: 'agg', fn: 'json_group_array', args: [collected],
    orderBy: [{ expr: col(rows.id, ORD_COL), dir: 'asc' }],
    ...(memberDrop ? { filter: memberDrop } : {}),
  };
  const groupedValue: Expr = valueBy?.key.kind === 'child'
    // ONE aggregate pass over the grouped block: order the typed `{t,v}` nodes by encounter, collect
    // them as JSON (so the envelope is embedded rather than stringified), then select the last one.
    // The child expression itself already yields only its first value for one parent traverser.
    ? { kind: 'call', fn: 'json_extract', args: [memberAggregate, compilerText('$[#-1]')] }
    : {
        kind: 'json-object',
        entries: [['t', compilerText('list')], ['v', memberAggregate]],
        binary: false,
      };
  const count: Expr = bulked && bulk
    ? { kind: 'agg', fn: 'sum', args: [col(rows.id, bulk.col)] }
    : { kind: 'agg', fn: 'count', args: [compilerInt(1)] };
  const value = step.name === 'group' ? groupedValue : count;
  const productive = make.aggregate({
    id: fresh('gb'), input: rows,
    channels: [], type: typeOf(meta(KEY_COL, 'json', true), meta(VAL_COL, step.name === 'group' ? 'json' : 'int')),
    groupBy: [col(rows.id, KEY_COL)],
    aggs: [[VAL_COL, value]],
  });

  // A COUNT is a Gremlin `long`, and the tag is what makes the wire agree with legacy's `countBuffer`
  // (an explicit Int64) rather than letting magnitude inference pick Int for a small count. A COLLECTED
  // group needs no envelope added: a collecting value is already a typed list node, while the child
  // assignment arm extracts the child's typed scalar node unchanged.
  const entry: Entry = {
    key: col(productive.id, KEY_COL),
    val: step.name === 'group' ? col(productive.id, VAL_COL) : typedNode(col(productive.id, VAL_COL), compilerText('long')),
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
 *  it, kept here so the two callers (element and scalar tails) cannot describe it differently.
 *
 *  `aliases` rides along because a `by()` may BE an alias read (`by(__.select('v'))`), which is state on
 *  the ROW rather than a question about the traverser. Optional so a caller with no label map in hand
 *  still gets a host; the alias arm then declines instead of guessing. */
export const elementHost = (rel: Rel, elem: Elem, aliases?: AliasMap): ChildHost =>
  ({ kind: 'element', id: col(rel.id, 'id'), elem, ...(aliases ? { row: { rel, aliases } } : {}) });

// ---------- the PER-ROW producer: `valueMap()`, an element's properties AS a map ----------
//
// `GroupStep extends ReducingBarrierStep<S, Map<K,V>>` and `PropertyMapStep extends
// ScalarMapStep<Element, Map<K,E>>` — TinkerPop separates the two producers by SUPERCLASS while both
// carry the same `Map<K,V>`. So the barrier-versus-per-row difference belongs to the PRODUCER and the
// SHAPE is genuinely one shape, which is why this is a second caller of the pairs encoding above and
// not a second map vocabulary. The module note at the top predicted exactly that; this is it arriving.
//
// **EVERY VALUE SIDE IS A SELF-DESCRIBING `{t,v}` NODE, including the token entries**, and that is what
// keeps `valOf` honest at ONE `MapOf` arm rather than needing a "mixed" one. A vertex key's values are
// a `{t:'list', v:[…]}` node, an edge key's is the stored value's own node, `T.id`'s is the external id
// under its INFERRED tag and `T.label`'s is a string or a set depending on the regime. The framer reads
// all of them by the one rule it already has, and `select(Column.values)` after a `valueMap()` then
// describes what is actually there.

/** One PAIR ROW on its way into the map — the `[keyNode, valNode]` array and the position that orders
 *  it. A relation rather than an expression because the TOKENS and the PROPERTIES are different
 *  relations that meet in one `Union`: SQLite cannot concatenate two JSON arrays, and re-exploding one
 *  to append the other would throw away the order this column exists to state. */
const PAIR_ROW = { pair: 'mp', ord: 'mo' } as const;

const pairRow = (input: Rel, pair: Expr, ord: Expr, fresh: Minter): Rel => make.project({
  id: fresh('pr'), input, channels: [],
  type: typeOf(meta(PAIR_ROW.pair, 'json'), meta(PAIR_ROW.ord, 'int')),
  exprs: [[PAIR_ROW.pair, pair], [PAIR_ROW.ord, ord]],
});

/** A `[keyNode, valNode]` pair, with `json()` around each side for the reason every producer here
 *  carries it: `json_group_array` re-encodes an unwrapped envelope as a JSON STRING. */
const pairOf = (key: Expr, val: Expr): Expr =>
  ({ kind: 'json-array', items: [jsonOf(key), jsonOf(val)], binary: false });

/** A `T` token as a map KEY. Its own node type on the wire (`FrameNode`'s `T` arm) rather than the
 *  string it prints as — `valueMap(true)` keys by `T.id`, not by `"id"`. */
const tokenKey = (name: 'id' | 'label'): Expr =>
  ({ kind: 'json-object', entries: [['t', compilerText('T')], ['v', compilerText(name)]], binary: false });

/** The one ROW an element rowid names, as a relation — the correlated scan every token pair projects
 *  off. `elementRow`'s columns are the physical ones, so `uid`/`id` and an edge's `label` FK are all in
 *  reach without a second subquery each. */
const elementRow = (rowid: Expr, elem: Elem, fresh: Minter): Rel => {
  const scan = make.scan({
    id: fresh('er'), table: elem === 'edge' ? 'edges' : 'nodes', alias: fresh('rer'), channels: [],
    type: typeOf(...(elem === 'edge' ? EDGE_COLS : NODE_COLS)),
  });
  return make.filter({ id: fresh('ef'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'id'), rowid) });
};

/** Which `T` tokens a `valueMap` includes. `valueMap(true)` and `with(WithOptions.tokens)` are both
 *  ALL of them (`PropertyMapStep.configure` — a boolean selects `WithOptions.all`/`none`), and the
 *  selective subsets pick one; the IR pass that desugars `with()` is what decides which arrives. */
export interface MapTokens { readonly ids: boolean; readonly labels: boolean }
export const NO_TOKENS: MapTokens = { ids: false, labels: false };

/**
 * `valueMap()` — an ELEMENT's properties as one map per traverser, or `null` to decline.
 *
 * A VERTEX key is MULTI-VALUED, so its value is a LIST and an EDGE key's is the value itself
 * (`PropertyMapStep.addElementProperties` — `map.compute(key, …values.add(value))` for a Vertex,
 * `map.put(key, value)` otherwise). That is the same asymmetry `vertexProps`/`edgeProps` already carry
 * for the element payload and it is read off the same tables, one aggregate level apart.
 *
 * **The KEY ORDER is ours to state, and it is the insertion order** — each key at its earliest
 * property rowid, which is what the element payload's own bag does. TinkerPop hands back a
 * `LinkedHashMap` in `element.properties()` iteration order, which is a provider's business rather
 * than the spec's; stating it is what stops the two spines differing by whatever SQLite scanned.
 *
 * The token entries lead, `T.id` before `T.label`, which is the order `addIncludedOptions` puts them
 * in before any property is added.
 */
export function elementValueMap(
  input: Rel, elem: Elem, keys: readonly string[] | null, tokens: MapTokens, regime: LabelRegime, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } {
  const rowid = col(input.id, 'id');
  const table = elem === 'edge' ? PROPERTIES.edge : PROPERTIES.vertex;
  const props = make.scan({
    id: fresh('vm'), table: table.table, alias: fresh('rvm'), channels: [],
    type: typeOf(meta('id', 'int'), meta(table.owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  // `keys` is bounded by the QUERY TEXT and never by row count, so an `InList` is right here and the
  // single-JSON-bind rule does not apply (that rule is about DATA-sized sets).
  const mine = make.filter({
    id: fresh('vf'), input: props, channels: [], type: props.type,
    pred: and(eq(col(props.id, table.owner), rowid),
      keys && keys.length ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map(compilerText) } : undefined),
  });
  // A VERTEX collects each key's values into one `{t:'list', v:[…]}` node; an EDGE's key is single by
  // schema (`UNIQUE(edge, key)`, which is TinkerPop's `Property` being single by spec), so the group is
  // still needed to carry the order column but the value is the one node.
  const valued = typedNode(col(mine.id, 'value'), col(mine.id, 'vtype'));
  const grouped = make.aggregate({
    id: fresh('vk'), input: mine, channels: [],
    // The GROUP KEY is a declared column — the emitter names `groupBy` exprs before the aggregates —
    // and the projection below drops it, because what the union and the blob want is the PAIR.
    type: typeOf(meta('key', 'text'), meta(PAIR_ROW.pair, 'json'), meta(PAIR_ROW.ord, 'int')),
    groupBy: [col(mine.id, 'key')],
    aggs: [
      [PAIR_ROW.pair, pairOf(
        typedNode(col(mine.id, 'key'), compilerText('string')),
        elem === 'edge'
          ? { kind: 'agg', fn: 'json_group_array', args: [jsonOf(valued)], orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }] }
          : {
            kind: 'json-object',
            entries: [['t', compilerText('list')], ['v', {
              kind: 'agg', fn: 'json_group_array', args: [jsonOf(valued)],
              orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }],
            }]],
            binary: false,
          },
      )],
      [PAIR_ROW.ord, { kind: 'agg', fn: 'min', args: [col(mine.id, 'id')] }],
    ],
  });
  const perKey = make.project({
    id: fresh('vp'), input: grouped, channels: [],
    type: typeOf(meta(PAIR_ROW.pair, 'json'), meta(PAIR_ROW.ord, 'int')),
    exprs: [[PAIR_ROW.pair, col(grouped.id, PAIR_ROW.pair)], [PAIR_ROW.ord, col(grouped.id, PAIR_ROW.ord)]],
  });
  const rows: Rel[] = [];
  // A NEGATIVE ordinal puts the tokens ahead of every property, whose ordinals are rowids and therefore
  // positive. Stating it that way rather than sorting a tagged column keeps the whole order in ONE term.
  if (tokens.ids) rows.push(tokenRow(rowid, elem, 'id', regime, -2, fresh));
  if (tokens.labels) rows.push(tokenRow(rowid, elem, 'label', regime, -1, fresh));
  const pairs = rows.length ? make.union({
    id: fresh('vu'), inputs: [...rows, perKey], all: true, channels: [], type: perKey.type,
  }) : perKey;
  const blob = make.aggregate({
    id: fresh('va'), input: pairs, channels: [], type: typeOf(meta(MAP_COL, 'json')),
    groupBy: [],
    aggs: [[MAP_COL, { kind: 'call', fn: 'jsonb', args: [coalesce(
      { kind: 'agg', fn: 'json_group_array', args: [jsonOf(col(pairs.id, PAIR_ROW.pair))],
        orderBy: [{ expr: col(pairs.id, PAIR_ROW.ord), dir: 'asc' }] },
      jsonOf(compilerText('[]')),
    )] }]],
  });
  return {
    // `COALESCE` for `mapOfGroups`' reason one level down: an element with NO properties and no tokens
    // is an EMPTY MAP and still one traverser, not a null value.
    rel: withPayload(input, [[MAP_COL, coalesce({ kind: 'scalar', plan: blob }, { kind: 'call', fn: 'jsonb', args: [jsonOf(compilerText('[]'))] })]],
      [meta(MAP_COL, 'json', true)], fresh),
    keyOf: { kind: 'scalar' },
    valOf: { kind: 'scalar' },
  };
}

/** One `T.id`/`T.label` entry, as a pair row correlated to the element. The LABEL follows the
 *  `LabelRegime`: a set of names where a vertex genuinely holds a set, the one first-interned name
 *  otherwise, and an EDGE's label is always the single name TinkerPop fixes its cardinality at. */
function tokenRow(rowid: Expr, elem: Elem, token: 'id' | 'label', regime: LabelRegime, ord: number, fresh: Minter): Rel {
  const row = elementRow(rowid, elem, fresh);
  const external = coalesce(col(row.id, 'uid'), col(row.id, 'id'));
  const value = token === 'id'
    // NOT `typedNode`, and the difference is plan size rather than taste: that helper re-tests the tag
    // for collection-ness (`storedValueOn`), which would spell this whole inference CASE twice. An
    // external id is a rowid or a uid — never a collection — so the node is built directly.
    ? { kind: 'json-object' as const, binary: false, entries: [['t', inferredVtype(external)] as const, ['v', external] as const] }
    : elem === 'edge'
      ? typedNode(edgeLabel(col(row.id, 'label'), fresh), compilerText('string'))
      : regime === 'set'
        ? { kind: 'json-object' as const, entries: [['t', compilerText('set')] as const, ['v', vertexLabels(col(row.id, 'id'), fresh)] as const], binary: false }
        : typedNode(vertexLabelName(col(row.id, 'id'), fresh), compilerText('string'));
  return pairRow(row, pairOf(tokenKey(token), value), compilerInt(ord), fresh);
}

/** A vertex's SINGLE label — the side table's first-interned name, which is the same deterministic pick
 *  `label()` and `by(T.label)` make. Spelled through `byExpr`'s token arm so a third pick cannot exist. */
const vertexLabelName = (rowid: Expr, fresh: Minter): Expr => {
  const projected = byExpr({ key: { kind: 'token', token: 'label' } }, { kind: 'element', id: rowid, elem: 'vertex' }, fresh);
  // `byExpr`'s token arm is total for `T.label`; a null here would be a lowering bug, not a deferral.
  if (!projected) throw new Error('RelIR lowering: the T.label projection declined for a vertex');
  return projected;
};

// ---------- the map as a RE-ENTERABLE traverser: its entries, its sides, its size ----------
//
// A map was TERMINAL here until this section existed, and the decline was honest but expensive: every
// `cap('a').select(Column.values)`, every `groupCount().unfold()` and the whole of `valueMap()`'s tail
// stopped at the same wall. The list module's twin one more time — a map is one JSONB value per row, so
// re-entering it is `json_each` over the pairs array and nothing more exotic than that.
//
// **The pairs array is what makes each of these one expression.** `[[keyNode, valNode], …]` explodes
// into one row per ENTRY with both sides addressable by position, where a JSON OBJECT would have made
// the key a string and lost the order — the two reasons the encoding is a pairs array in the first
// place, now paying for themselves a second time.

/** The two columns a MAP.ENTRY relation carries. The names are `execute.ts`'s (`mapEntryBuffer` reads
 *  `mk`/`mv`), declared once here for `LIST_COL`/`MAP_COL`'s reason: the framing layer reads them too. */
export const ENTRY = { key: 'mk', val: 'mv' } as const;

/** One PAIR as `json_each` hands it back: the two-element `[keyNode, valNode]` array, and its position
 *  in the map (`json_each.key`, which for a JSON array IS the index). */
const PAIR = { value: 'ev', ord: 'eo' } as const;

/** The map's pairs as a relation — `FROM json_each(<map>)`. No `input`, which is what makes it a
 *  correlated subquery over ONE traverser's map (`rel.ts`); the row-multiplying form is `unfoldMap`. */
const pairsOf = (map: Expr, fresh: Minter): Rel => make.explode({
  id: fresh('px'), expr: map, channels: [], as: PAIR,
  type: typeOf(meta(PAIR.value, 'any', true), meta(PAIR.ord, 'int')),
});

/** One SIDE of a pair — `json_extract(<pair>, '$[0]')` for the key, `'$[1]'` for the value. A `{t,v}`
 *  envelope comes back as JSON TEXT, which is exactly what `mapSideBuffer` and `frameTypedNode` read. */
const pairSide = (pair: Expr, side: 'keys' | 'values'): Expr =>
  ({ kind: 'call', fn: 'json_extract', args: [pair, compilerText(side === 'keys' ? '$[0]' : '$[1]')] });

/**
 * WHAT A MAP SIDE BECOMES WHEN IT IS COLLECTED INTO A LIST — the `MapOf`→`ListOf` translation, and it
 * is a translation rather than a coincidence: both vocabularies describe the same self-describing tree,
 * one from the map's side and one from the list's, so `select(Column.keys)` needs no re-encoding at all.
 *
 * A `scalar` side is a `{t,v}` node, which is precisely what a TYPED list's members are. A `list` side
 * is a naked array, so the collected list is a list OF lists. An `elem` side is a rowid the map module
 * never emits (`mapPayload` declines one), so it declines here too rather than claiming an encoding.
 */
const sideList = (of: MapOf): ListOf | null =>
  of.kind === 'scalar' ? TYPED_MEMBERS : of.kind === 'list' ? { kind: 'list', of: of.of } : null;

/**
 * `select(Column.keys)` / `select(Column.values)` — one SIDE of every entry, as a list value.
 *
 * `Column.keys` over a Map is a `LinkedHashSet` and `Column.values` an `ArrayList`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Column.java:22-47`),
 * so the KEY side frames as a GraphBinary SET and the value side as a LIST — one framing marker on an
 * otherwise identical relation, which is the `set` flag the list vocabulary already carries.
 *
 * The entry ORDER carries into the list: the pairs array is ordered (the map's own entry order, stated
 * by whichever producer built it), so `ORDER BY` the pair position is what keeps a key list and a value
 * list aligned. Reading them back in scan order would let the two disagree.
 */
export function mapSide(
  input: Rel, side: 'keys' | 'values', of: MapOf, fresh: Minter,
): { readonly rel: Rel; readonly of: ListOf; readonly set: boolean } | null {
  const items = sideList(of);
  if (!items) return null;
  const rel = fenced(input, fresh);
  const pairs = pairsOf(col(rel.id, MAP_COL), fresh);
  // `json()` around the side is the list module's own warning: without it `json_group_array` re-encodes
  // the `{t,v}` envelope as a JSON STRING and the framer sees text where a tagged value belongs.
  const collected: Expr = {
    kind: 'scalar',
    plan: make.aggregate({
      id: fresh('pa'), input: pairs, channels: [], type: typeOf(meta(LIST_COL, 'json')),
      groupBy: [],
      aggs: [[LIST_COL, {
        kind: 'call', fn: 'jsonb',
        args: [coalesce(
          { kind: 'agg', fn: 'json_group_array', args: [jsonOf(pairSide(col(pairs.id, PAIR.value), side))],
            orderBy: [{ expr: col(pairs.id, PAIR.ord), dir: 'asc' }] },
          jsonOf(compilerText('[]')),
        )],
      }]],
    }),
  };
  return {
    rel: withPayload(rel, [[LIST_COL, collected]], [meta(LIST_COL, 'json', true)], fresh),
    of: items,
    set: side === 'keys',
  };
}

/**
 * `count(Scope.local)` over a map — its ENTRY COUNT, which is `json_array_length` over the pairs array
 * and needs no explode at all. The list vocabulary counts its members by aggregating `json_each`
 * because a member may have been filtered; a map's entries never have been, so the length IS the size.
 */
export const mapSize = (input: Rel, fresh: Minter): Rel =>
  withPayload(input, [['v', { kind: 'call', fn: 'json_array_length', args: [jsonOf(col(input.id, MAP_COL))] }]],
    [meta('v', 'int')], fresh);

/**
 * `unfold()` — one traverser per ENTRY, which is the relation-level explode the side reads are not.
 *
 * A Map.Entry is its own traverser kind on the wire (a size-1 GraphBinary MAP — TinkerPop's
 * `MapEntrySerializer`, TINKERPOP-3104), so the two sides land in their own columns rather than being
 * rebuilt into a one-entry map value. That is what lets `select(Column.keys)` after it be a COLUMN READ
 * rather than a second JSON walk.
 *
 * The entry's POSITION becomes the emission order, re-minted by the caller for `unfoldList`'s reason:
 * `json_each.key` indexes within ONE map, so it is a total order only where the relation has one row.
 */
export function unfoldMap(input: Rel, fresh: Minter): { readonly rel: Rel; readonly ord: string } {
  const rel = fenced(input, fresh);
  const exploded = make.explode({
    id: fresh('ux'), input: rel, expr: col(rel.id, MAP_COL), channels: rel.channels, as: PAIR,
    type: typeOf(...rel.type.cols, meta(PAIR.value, 'any', true), meta(PAIR.ord, 'int')),
  });
  const pair = col(exploded.id, PAIR.value);
  return {
    rel: make.project({
      id: fresh('ue'), input: exploded, channels: rel.channels,
      type: typeOf(meta(ENTRY.key, 'json', true), meta(ENTRY.val, 'json', true),
        ...carriedCols(rel.channels), meta(PAIR.ord, 'int')),
      exprs: [[ENTRY.key, pairSide(pair, 'keys')], [ENTRY.val, pairSide(pair, 'values')],
        ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
        [PAIR.ord, col(exploded.id, PAIR.ord)]],
    }),
    ord: PAIR.ord,
  };
}

/**
 * ONE SIDE of a Map.Entry, as the traverser — `select(Column.keys)` over an entry yields the KEY
 * itself, not a collection (`Column.java:26-29`, the `Map.Entry` arm).
 *
 * The side is a `{t,v}` node in a column, so the retype into the scalar vocabulary is the same unwrap
 * the list module's `memberPayload` does one container along: the value out of `$.v`, its tag out of
 * `$.t`, and the scalar stream then frames PER ROW. A `list` side keeps the list vocabulary instead,
 * and an `elem` side declines for `mapPayload`'s reason.
 */
export function entrySide(
  input: Rel, side: 'keys' | 'values', of: MapOf, fresh: Minter,
): { readonly rel: Rel; readonly of?: ListOf } | null {
  const column = col(input.id, side === 'keys' ? ENTRY.key : ENTRY.val);
  if (of.kind === 'list') return { rel: withPayload(input, [[LIST_COL, { kind: 'call', fn: 'jsonb', args: [column] }]], [meta(LIST_COL, 'json', true)], fresh), of: of.of };
  if (of.kind !== 'scalar') return null;
  const field = (name: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [column, compilerText(`$.${name}`)] });
  return {
    rel: withPayload(input, [['v', field('v')], ['vtype', field('t')]],
      [meta('v', 'any', true), meta('vtype', 'text', true)], fresh),
  };
}

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

/**
 * THE MAP.ENTRY PAYLOAD — the two side columns, as the JSON `mapEntryBuffer` frames.
 *
 * `json()` per side rather than over a whole blob, and that is the only difference from `mapPayload`:
 * a side is already the exact subtree the framer wants, so the projection's whole job is to make
 * SQLite's JSON subtype survive the value boundary (an ELEMENT side declines here for the same reason
 * it does there — the rowid would have to be expanded and nothing produces one yet).
 */
export function mapEntryPayload(
  rel: Rel, keyOf: MapOf, valOf: MapOf, fresh: Minter,
): { readonly rel: Rel; readonly shape: Shape } | null {
  if (keyOf.kind === 'elem' || valOf.kind === 'elem') return null;
  const ordered = byEncounter(rel, fresh);
  return {
    rel: make.project({
      id: fresh('ew'), input: ordered, channels: [],
      type: typeOf(meta(ENTRY.key, 'json', true), meta(ENTRY.val, 'json', true)),
      exprs: [[ENTRY.key, jsonOf(col(ordered.id, ENTRY.key))], [ENTRY.val, jsonOf(col(ordered.id, ENTRY.val))]],
    }),
    shape: { kind: 'mapEntry', keyOf, valOf },
  };
}
