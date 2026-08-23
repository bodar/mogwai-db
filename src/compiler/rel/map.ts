import { col, compilerInt, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import type { LabelRegime } from '../../api.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { TYPED_MEMBERS, type ListOf, type MapOf, type Shape } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import type { IRStep } from '../ir/step.ts';
import { argValues } from '../../gremlin/frontend.ts';
import { valueNodeOf, type TypeNode, type ValueNode } from '../../gremlin/types.ts';
import { and, byEncounter, carriedCols, coalesce, collectedArray, collectedOf, eq, fenced, firstOf, jsonOf, meta, typeOf, typedNode, VALUEMAP_PAIR, withPayload, type Minter } from './build.ts';
import { inferredVtype, LIST_COL } from './list.ts';
import { elementNode } from './element.ts';
import { propertyNode } from './property.ts';
import { byExpr, byNode, modulations, producedMemberNode, productivityFilter, type Modulation } from './modulator.ts';
import type { GraphSource } from './source.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import type { AliasMap } from '../plan/alias.ts';
import { isReducer, reducerAggregate } from './reducer.ts';

/**
 * THE MAP SHAPE — a barrier whose result is ONE map, as a value in the algebra.
 *
 * The eighth vocabulary module on `build.ts`, and deliberately the LIST module's twin: a list is one
 * JSONB `list` column per row and a map is one JSONB `map` column, so both are ordinary values that
 * flow through the same relations and reach the wire through this module's own `mapPayload` exactly as a
 * list reaches it through `listPayload` (§6·3 — a shape is a value plus a framing arm, never a delegated
 * step; §6·3 — that arm is a PROJECTION the algebra builds).
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
    aggs: [[MAP_COL, collectedArray(pairOf(entry.key, entry.val), [{ expr: order, dir: 'asc' }])]],
  });
}

/** The column the grouped relation holds its key in. It is `Aggregate`'s FIRST declared column, because
 *  the emitter names `groupBy` exprs before the aggregates (`emit.ts`'s `aggregate` case). Exported so
 *  the consumer-driven read (`collection.ts`'s `groupedKeys`) can project the key SIDE of a grouping's
 *  member rows without folding them into a map first. */
export const KEY_COL = 'gk';
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
export const ORD_COL = 'go';

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
 * cannot, which is identical while bulk ≡ 1 and correct after a fan-out. That is why it is a rule
 * rather than a constant.
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
  input: Rel, host: ChildHost, step: IRStep, bulked: boolean, child: ChildSeam, source: GraphSource, fresh: Minter,
): GroupedMap | null {
  const rows = groupRows(input, host, step, bulked, child, source, fresh);
  return rows && (rows.done ?? groupMap(rows.rel, rows.recipe, fresh));
}

/** A grouped relation folded into one map value, plus what the framing layer must be told about each
 *  side. `groupBarrier`'s answer, and `groupMap`'s. */
export interface GroupedMap { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf }

/**
 * THE PRE-AGGREGATE ROWS of a grouping — one row per contributing traverser, carrying its KEY and its
 * value CONTRIBUTION — plus the recipe that turns them into a map. `null` declines.
 *
 * The split exists because a KEYED `group("a")`/`groupCount("a")` is a SIDE EFFECT: the map it fills is
 * read back at a `cap("a")`, and a label two chain positions fill holds BOTH sites' contributions
 * (`registerIfAbsent` + `GroupBiOperator`). So the grouping cannot happen where the step is — it happens
 * over the UNION of every site's rows, at the read, which is where the reference puts every collecting
 * reduction (`SideEffectCapStep.generateFinalResult`). That is `collection.ts`'s thesis applied to the
 * keyed forms, and this seam is what makes it expressible.
 *
 * It costs the barrier form nothing: `groupBarrier` is `groupMap(groupRows(…))`, because the code was
 * already in this order — project the key and the member, fence, drop the unproductive domain, and only
 * THEN aggregate.
 *
 * ⚠️ **`recipe` is DATA and not a closure, and that is the load-bearing part.** Two sites on one label may
 * carry different `by()`s, and what the aggregation does depends on facts the SITE decided — whether the
 * key is a rowid to expand at the entry, whether the member column holds a projected `{t,v}` node or a
 * rowid, whether the value `by()` owes a productivity drop. A closure cannot be COMPARED, so a second
 * site could be aggregated by the first site's recipe and answer plausibly wrong rows. As data, the
 * accumulation can refuse a disagreement (`sameGroupRecipe`).
 */
export interface GroupRows {
  readonly rel: Rel;
  readonly recipe: GroupRecipe;
  /** The `groupReduced` arm's finished answer. Its value side is a JOIN whose child rows POOL per group,
   *  so there is no `(key, contribution)` row to union and no recipe that could describe one — it is
   *  already a map, and a keyed caller must decline it rather than pretend it is a member relation. */
  readonly done?: GroupedMap;
}

/**
 * HOW A GROUPING'S ROWS BECOME A MAP — every fact the aggregation needs, as comparable data.
 *
 * Structural equality over this IS the question "may these two sites share one grouping?", which is why
 * every field is a primitive or a small tagged value and none is a relation or a function.
 */
export interface GroupRecipe {
  /** `groupCount` reduces the group to a traverser COUNT; `group` COLLECTS its members. */
  readonly counting: boolean;
  /** The key is a ROWID of this element kind, to be expanded into a node at the ENTRY — once per
   *  surviving group rather than once per row. `undefined` when the key column already holds a node. */
  readonly keyElem: Elem | undefined;
  /** What the member column holds: a projected self-describing node, or a rowid this host expands. */
  readonly member: { readonly kind: 'node' } | { readonly kind: 'rowid'; readonly host: ChildHost } | undefined;
  /** `by(__.tail())` / an anonymous child value: the group's value is ONE member, extracted from the
   *  collected array's end, rather than the array itself. */
  readonly single: boolean;
  /** The SHAPE of that single value — `{kind:'map', of}` for a MAP-producing child (`by(__.project())`,
   *  a nested `by(__.group())`), `{kind:'scalar'}` otherwise. What makes a `Map<K,Map>`'s `valOf` carry
   *  the inner map instead of collapsing to an opaque scalar. Unused when `single` is false. */
  readonly singleOf?: MapOf;
  /** The value `by()` owes a productivity drop, applied as the aggregate's own `FILTER (WHERE …)` so the
   *  GROUP survives with an empty list rather than the key vanishing. */
  readonly memberDrop: boolean;
  /** The bulk channel's column where the count must weigh by multiplicity, else `undefined`. */
  readonly bulkCol: string | undefined;
  /** The step whose `productivityFilter` policy the drop reads — carried so the recipe stays data the
   *  aggregation can act on without re-deriving `ProductiveByStrategy`. Two sites of one label are two
   *  positions of one traversal, so they cannot disagree about the strategy. */
  readonly step: IRStep;
}

/** May two sites' rows be grouped together? Structural over everything the aggregation reads, and it
 *  deliberately does NOT compare `step` — that is the strategy carrier, and one traversal has one. */
export const sameGroupRecipe = (a: GroupRecipe, b: GroupRecipe): boolean =>
  a.counting === b.counting && a.keyElem === b.keyElem && a.single === b.single
  && a.memberDrop === b.memberDrop && a.bulkCol === b.bulkCol
  && JSON.stringify(a.singleOf) === JSON.stringify(b.singleOf)
  && a.member?.kind === b.member?.kind
  && (a.member?.kind !== 'rowid' || (b.member as { host: ChildHost }).host.kind === a.member.host.kind);

/** The columns a grouping's rows carry — what a UNION of several sites must narrow to. */
export const groupRowCols = (recipe: GroupRecipe): readonly string[] =>
  [KEY_COL, ...(recipe.counting ? [] : [MEMBER_COL, ORD_COL]), ...(recipe.bulkCol ? [recipe.bulkCol] : [])];

/**
 * AN EXPLICIT EMPTY `by()` IS THE SAME REQUEST AS NO `by()` AT ALL — both name the TRAVERSER ITSELF, and
 * every consumer in `groupRows` wants them to mean one thing.
 *
 * `modulations` reports a missing slot as ABSENT and `by()` as `{key: identity}`, which is the right
 * distinction for a host whose default is not identity (bare `dedup()` is a whole-row `Distinct`, a
 * genuinely different lowering from `dedup().by()`) and the wrong one here: `group()`'s own default for
 * both slots IS the traverser. Not collapsing them declined the whole `group().by().by(X)` family —
 * `group().by()` never reached the cheap ROWID key, and `group().by('name').by()` never reached the
 * COLLECT-the-elements arm, both of which the by()-less form has always had. An `Order` on the slot is
 * NOT collapsed: a comparator is a real request even with an identity key.
 */
const named = (modulation: Modulation | undefined): Modulation | undefined =>
  (modulation && modulation.key.kind === 'identity' && modulation.order === undefined ? undefined : modulation);

/** A bare `by(__.fold())` folds the TRAVERSERS themselves into a list — identical to the by()-less
 *  collecting arm — so it collapses to no value `by()` at all. A `fold()` with a pre-body
 *  (`by(__.out().fold())`) is NOT collapsed: its members are the pooled child rows, which is
 *  `groupCollected`'s pool. */
const bareFold = (modulation: Modulation | undefined): Modulation | undefined =>
  (modulation && modulation.key.kind === 'child' && modulation.key.body.length === 1
    && modulation.key.body[0]!.name === 'fold' && modulation.order === undefined ? undefined : modulation);

export function groupRows(
  input: Rel, host: ChildHost, step: IRStep, bulked: boolean, child: ChildSeam, source: GraphSource, fresh: Minter,
): GroupRows | null {
  if (step.optionArms) return null;
  if (step.name !== 'groupCount' && step.name !== 'group') return null;
  // A single STRING argument is a side-effect LABEL, and the grouping it names is built exactly the
  // same way — `GroupSideEffectStep` and `GroupStep` differ in what happens to the result, not in how
  // the map is computed. So this builds either, and the CALLER decides: the barrier form returns the
  // map as the traverser, the keyed form registers it and passes the traversers through. Anything
  // else in the argument position is a form this does not serve.
  const args = argValues(step);
  if (args.length > 1 || (args.length === 1 && typeof args[0] !== 'string')) return null;
  // TWO SLOTS for `group()`, one for `groupCount()`, and that is the whole of the arity difference:
  // `GroupStep` takes a key `by()` and a value `by()`, `GroupCountStep` only a key.
  const collecting = step.name === 'group';
  const bys = modulations(step, collecting ? 2 : 1, child);
  if (!bys) return null;

  /**
   * A `by()`-LESS KEY GROUPS BY THE TRAVERSER ITSELF, and over an ELEMENT that is the ROWID with the
   * node built at the entry — not the node in the `GROUP BY`.
   *
   * The distinction is the one the MEMBER column already draws and for the same two reasons: an element
   * node carries the whole property bag, so grouping by it would make SQLite hash a JSON document per
   * row where an integer settles it, and the node would then be expanded once per ROW instead of once
   * per surviving GROUP. It is also why this is not `byNode`'s business — that function answers "the
   * traverser as a self-describing member", which is exactly right at the entry and wrong in a key
   * position, so the identity arm over an element stays declined there.
   *
   * A PROPERTY host has no such cheaper spelling — nothing in the `MapOf` vocabulary names a property
   * SIDE, so its `by()`-less key is the property NODE (`byNode`'s own property arm says the same
   * thing from the other side). That is a plan cost and not a wrong answer, and it is the honest
   * trade while the rowid spelling would need a framing arm nothing else wants yet.
   */
  const keyBy = named(bys[0]);
  const elementKey = !keyBy && host.kind === 'element' ? host : undefined;
  const key = elementKey ? elementKey.id : byNode(keyBy ?? { key: { kind: 'identity' } }, host, source, fresh, child);
  if (!key) return null;

  // THE VALUE `by()`, where there is one. A slot `byNode` cannot project declines the whole step rather
  // than silently collecting the elements instead — which would be the right arity and the wrong answer,
  // the one thing the decline contract exists to prevent.
  //
  // A bare `by(__.fold())` names the TRAVERSERS folded into a list, which is exactly the by()-less
  // collecting arm — `convertValueTraversal` wraps the identity value as `map(identity).fold()`
  // (`gremlin-core/.../step/Grouping.java`). So it collapses to that arm rather than reaching
  // `groupCollected`, whose pool exists for a NON-empty pre-fold body.
  const valueBy = bareFold(named(bys[1]));
  /**
   * `by(__.tail())` — the group's value is the LAST TRAVERSER routed to the key, which is the collecting
   * arm with one extraction rather than a value projection.
   *
   * `Grouping.determineBarrierStep` finds the value traversal's barrier and makes it the group's
   * reducer, and `TailGlobalStep(1)` keeps the last traverser to arrive — the members' own encounter
   * order, which is the order the collecting aggregate already states. So this is `member: undefined`
   * (collect the ELEMENTS) plus the `$[#-1]` the child-assign arm below already spells; nothing about
   * the pooling, the ordering or the framing is new.
   *
   * A `tail(n>1)` keeps n and is therefore a LIST value — a different shape, and one nothing produces
   * yet, so it declines rather than silently answering the one-member case.
   */
  const lastOnly = valueBy?.key.kind === 'child' && valueBy.key.body.length === 1
    && valueBy.key.body[0]!.name === 'tail'
    && !argValues(valueBy.key.body[0]!).some((arg) => typeof arg === 'number' && arg !== 1);
  // A REDUCING traversal value is one scalar for the WHOLE GROUP, not one member per incoming
  // traverser — the group's members' child traversers POOL and the barrier reduces the pool once
  // (`Grouping.determineBarrierStep`). So it is its own arm, and the generic per-parent child
  // expression would be a plausible-looking wrong value rather than a decline.
  if (valueBy?.key.kind === 'child' && !lastOnly) {
    const terminal = valueBy.key.body.at(-1)?.name;
    // A `by(<pre>.fold())` COLLECTS the pooled child rows into a LIST per key — the same pool
    // `groupReduced` builds, folded rather than reduced. `fold()` is a reducing barrier that SEEDS `[]`,
    // so an empty pool keeps its key with `l[]` (not a dropped key), which is why it is `groupCollected`
    // and not the per-input collecting arm. A bare `by(__.fold())` is the traverser-collect the by()-less
    // arm already builds, so it is left to fall through (`pre` empty → `groupCollected` declines).
    if (terminal === 'fold') {
      const pooled = groupCollected(input, host, step, keyBy, valueBy.key.body, child, source, fresh);
      if (pooled) return { rel: pooled.rel, recipe: POOLED_RECIPE(step), done: pooled };
    }
    if (terminal === 'count' || (terminal !== undefined && isReducer(terminal))) {
      const pooled = groupReduced(input, host, step, keyBy, valueBy.key.body, bulked, child, source, fresh);
      // A POOLED value is already a map, and there is no `(key, contribution)` row behind it — see
      // `GroupRows.done`. The `rel`/`recipe` are unreachable and stated only so the shape stays total.
      return pooled && { rel: pooled.rel, recipe: POOLED_RECIPE(step), done: pooled };
    }
  }
  // A CHILD value `by()` (`by(__.project(…))`, `by(__.valueMap())`) is lowered here rather than through
  // `byNode` so its FRAMING is captured, not discarded: a MAP-shaped child makes the value a `Map<K,Map>`,
  // whose true `valOf` is `{kind:'map', of}` (`docs/archive/2026-08-21-map-value-shape-plan.md`). Without the
  // shape `select(values).unfold()` silently mis-shaped the inner map as a scalar (`[{}]`). The node
  // encoding is identical to `byNode`'s (both `producedMemberNode`), so only the shape is new.
  let member: Expr | undefined;
  let singleOf: MapOf = { kind: 'scalar' };
  if (valueBy && !lastOnly) {
    if (valueBy.key.kind === 'child') {
      const produced = child.scalar(valueBy.key.body, host);
      if (!produced) return null;
      const node = producedMemberNode(produced.expr, produced.framing, fresh);
      if (!node) return null;
      member = node;
      if (produced.framing.kind === 'map') singleOf = { kind: 'map', of: produced.framing.valOf };
    } else {
      const node = byNode(valueBy, host, source, fresh, child);
      if (!node) return null;
      member = node;
    }
  }
  // A collecting arm is what `tail()` needs, and it is the hosts whose traverser is a ROWID that have
  // members to collect: an element and a property. A scalar host's members are its own value nodes,
  // which `member` already covers, and a record's are not addressable at all.
  if (lastOnly && (!collecting || !ROWID_HOSTS.has(host.kind))) return null;

  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  const encounter = collecting ? input.channels.find((channel) => channel.role === 'encounter') : undefined;
  // A COLLECTING group states its member order, and only an ELEMENT relation has the `id` column the
  // rowid fallback below reads — a value relation has none, and a PROPERTY relation's `id` is the
  // OWNER's rather than the property's. `analyzeChain` demands an encounter for every `group()`, so
  // this declines only if that contract is violated rather than in any reachable chain.
  if (collecting && !encounter && host.kind !== 'element') return null;
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
    // An element-identity key is a ROWID, not a node — the declared type says so, because the factory
    // checks widths and the emitter's own type view is this list.
    type: typeOf(meta(KEY_COL, elementKey ? 'int' : 'json', true), ...extra),
    exprs: [
      [KEY_COL, key],
      // The MEMBER is the projected value where a value `by()` names one, and the traverser's rowid
      // otherwise — which `elementNode` then expands. The ORDER is separate because a projected value is
      // not an order: two traversers can share one, and the members would then collect in scan order.
      // analyzeChain demands an encounter for every group(), so the id fallback is unreachable for this
      // collecting arm; it remains only as a defensive fallback if that analysis contract is violated.
      ...(collecting ? [[MEMBER_COL, member ?? traverserMember(host, source, fresh)] as const, [ORD_COL, col(input.id, encounter ? encounter.col : 'id')] as const] : []),
      ...(bulk ? [[bulk.col, col(input.id, bulk.col)] as const] : []),
      ...(encounter ? [[encounter.col, col(input.id, encounter.col)] as const] : []),
    ],
  });
  // FENCED, or the projection is fused straight back in and the naming buys nothing: the emitter merges
  // a plain `Project` into the aggregate's own block, so `gk` becomes the expression again in the SELECT
  // and the GROUP BY. Without the fence the key's property subquery is copied 3 times (6 for a label
  // key); with the fence the key is computed once, which is an access-path fact and not a cosmetic
  // preference.
  const keyed = make.materialize({ id: fresh('gm'), input: projected, channels: projected.channels, type: projected.type });
  // TinkerPop drops an unproductive key rather than grouping under null — UNLESS `ProductiveByStrategy`
  // asked for the null-keeping behaviour, which is why this asks `productivityFilter` rather than
  // spelling the test. Hardcoding `IS NOT NULL` changed the answer for
  // `withStrategies(ProductiveByStrategy).V().groupCount().by('age')`; the census caught it against the
  // reference, which a byte-level comparison of two equally-wrong answers could not.
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
  const childValueDrop = member && !lastOnly && valueBy?.key.kind === 'child'
    ? productivityFilter(step, col(keyed.id, MEMBER_COL))
    : undefined;
  const domainDrop = drop && childValueDrop ? and(drop, childValueDrop) : drop ?? childValueDrop;
  // The aggregate's own DIRECT input, because a `Col` names a relation in SCOPE and scope is a node's
  // direct children (§3.3). With the filter present, `keyed` is the GRANDchild — naming it is the
  // "no relation in scope" the checker catches, and it caught this.
  const rows = domainDrop
    ? make.filter({ id: fresh('gf'), input: keyed, channels: keyed.channels, type: keyed.type, pred: domainDrop })
    : keyed;
  return {
    rel: rows,
    recipe: {
      counting: !collecting,
      keyElem: elementKey?.elem,
      member: collecting ? (member || host.kind === 'scalar' ? { kind: 'node' } : { kind: 'rowid', host }) : undefined,
      single: lastOnly || valueBy?.key.kind === 'child',
      singleOf,
      memberDrop: !!member,
      bulkCol: bulked && bulk ? bulk.col : undefined,
      step,
    },
  };
}

/** A pooled-value grouping's recipe — never read, because `GroupRows.done` carries the finished map. It
 *  exists so `GroupRows` stays a total shape rather than growing an optional `recipe`. */
const POOLED_RECIPE = (step: IRStep): GroupRecipe =>
  ({ counting: false, keyElem: undefined, member: undefined, single: false, memberDrop: false, bulkCol: undefined, step });

/**
 * A GROUPING'S ROWS, AGGREGATED INTO ONE MAP — the second half of `groupBarrier`, and the whole of what a
 * `cap("a")` runs over the UNION of a keyed label's sites.
 *
 * Everything it needs about the rows is in `recipe`; everything it needs about their VALUES is already in
 * the columns. That is what lets N sites share one call.
 *
 * `order` is the MEMBER order — one column for a single site, and (site ordinal, that site's own) over a
 * union, which is the order `Collection.sites` already pins. It is an argument rather than a `recipe`
 * field because it is a property of the RELATION being aggregated, not of the grouping: two sites must
 * agree about their recipe and cannot agree about a column only their union has.
 */
export function groupMap(rows: Rel, recipe: GroupRecipe, fresh: Minter, order: readonly string[] = [ORD_COL]): GroupedMap {
  const { counting, keyElem, bulkCol } = recipe;
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
  // ⚠️ Built ONLY for the collecting arm, and that is a correctness point rather than a saving: a
  // `groupCount()`'s rows carry no member column at all, so every expression below names a column that is
  // not there. It used to be computed unconditionally and discarded, which was harmless only because the
  // member expression happened to be derivable from the HOST — and the host is exactly what a recipe
  // shared by N sites cannot reach.
  const value: Expr = counting
    ? (bulkCol
      ? { kind: 'agg', fn: 'sum', args: [col(rows.id, bulkCol)] }
      : { kind: 'agg', fn: 'count', args: [compilerInt(1)] })
    : collectedValue(rows, recipe, fresh, order);
  const productive = make.aggregate({
    id: fresh('gb'), input: rows,
    channels: [], type: typeOf(meta(KEY_COL, 'json', true), meta(VAL_COL, counting ? 'int' : 'json')),
    groupBy: [col(rows.id, KEY_COL)],
    aggs: [[VAL_COL, value]],
  });

  // A COUNT is a Gremlin `long`, and the tag is what makes the wire emit an explicit Int64
  // rather than letting magnitude inference pick Int for a small count. A COLLECTED
  // group needs no envelope added: a collecting value is already a typed list node, while the child
  // assignment arm extracts the child's typed scalar node unchanged.
  const entry: Entry = {
    // The KEY NODE is built HERE for an element-identity key — once per surviving group, off the rowid
    // the grouping actually used. That is the same rowids-until-the-root rule the element-membered list
    // follows, one container along.
    key: keyElem
      ? elementNode(col(productive.id, KEY_COL), keyElem, fresh)
      : col(productive.id, KEY_COL),
    val: counting ? typedNode(col(productive.id, VAL_COL), compilerText('long')) : col(productive.id, VAL_COL),
    // THE VALUE'S TRUE SHAPE (`docs/archive/2026-08-21-map-value-shape-plan.md`): the COLLECTING arm's value is
    // a `List` (TinkerPop injects `fold()` into every non-reducing value traversal — `GroupStep.java:61`,
    // `Grouping.java:92-101`), whose members are all self-describing `{t,v}` nodes (a rowid is expanded
    // to an `elementNode` at the aggregate, so both element and scalar members frame the same way) —
    // hence `{kind:'list', of: TYPED_MEMBERS}`. A COUNT (`groupCount`) is a scalar `long`; a SINGLE
    // value (`by(__.tail())`, an anonymous child) is one member, a scalar. The map still frames
    // byte-identically — only the DESCRIPTOR a consumer (`select(values)`/`select(<key>)`/`unfold`) reads
    // becomes precise, so those compose over a list value instead of mis-shaping it as a scalar.
    // AN ELEMENT KEY SAYS SO, and that is what keeps the SIDE READS honest. The blob holds a
    // `{t:'vertex', v:{…}}` node, which the typed framer walks correctly at any depth — but a
    // `select(Column.keys).unfold()` would decode it into the SCALAR vocabulary, whose framer cannot
    // frame an element and emitted the payload as a JSON STRING. `sideList`/`entrySide` decline an
    // `elem` side, so declaring it is the difference between a wrong answer and a deferral.
    keyOf: keyElem ? { kind: 'elem', elem: keyElem } : { kind: 'scalar' },
    valOf: counting ? { kind: 'scalar' }
      : recipe.single ? (recipe.singleOf ?? { kind: 'scalar' })
        : { kind: 'list', of: TYPED_MEMBERS },
  };
  return {
    // Ordered by the KEY ("we emit rows ORDER BY the key"). A map's entry order is not TinkerPop's to
    // dictate, so it is ours to state — and stating it is what makes the order deterministic rather
    // than whatever the grouping happened to produce.
    rel: mapOfGroups(productive, entry, col(productive.id, KEY_COL), fresh),
    keyOf: entry.keyOf,
    valOf: entry.valOf,
  };
}

/**
 * THE COLLECTING ARM'S VALUE — the group's members as one typed list node, or the single member a
 * `tail()`/anonymous-child value extracts from it.
 *
 * Its own function because it is the half of the aggregation that reads the MEMBER column, and a
 * `groupCount()` has none: naming those columns unconditionally worked only while the member expression
 * could be re-derived from the HOST, which is the one thing a recipe shared by N sites cannot reach.
 */
function collectedValue(rows: Rel, recipe: GroupRecipe, fresh: Minter, order: readonly string[]): Expr {
  const { member, single, memberDrop: dropMembers, step } = recipe;
  const collected = member?.kind === 'node'
    // A projected VALUE is already a self-describing `{t,v}` node (`byNode` builds it from the row the
    // value came from), so it is written back as it is — and so is a SCALAR host's own traverser, whose
    // `by()`-less member is that same node. `json()` around it for the list module's own reason: without
    // it `json_group_array` re-encodes the envelope as a JSON STRING.
    ? jsonOf(col(rows.id, MEMBER_COL))
    : jsonOf(rowidMember((member as { readonly host: ChildHost }).host, col(rows.id, MEMBER_COL), fresh));
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
  // A `tail()` value drops nothing: the traverser IS the member, so there is no `by()` that could have
  // been unproductive — the drop belongs to a PROJECTED value only.
  const memberDrop = dropMembers ? productivityFilter(step, col(rows.id, MEMBER_COL)) : undefined;
  const memberAggregate: Expr = {
    kind: 'agg', fn: 'json_group_array', args: [collected],
    orderBy: order.map((name) => ({ expr: col(rows.id, name), dir: 'asc' as const })),
    ...(memberDrop ? { filter: memberDrop } : {}),
  };
  const groupedValue: Expr = single
    // ONE aggregate pass over the grouped block: order the typed `{t,v}` nodes by encounter, collect
    // them as JSON (so the envelope is embedded rather than stringified), then select the last one.
    // The child expression itself already yields only its first value for one parent traverser.
    ? { kind: 'call', fn: 'json_extract', args: [memberAggregate, compilerText('$[#-1]')] }
    : {
        kind: 'json-object',
        entries: [['t', compilerText('list')], ['v', memberAggregate]],
        binary: false,
      };
  return groupedValue;
}

/**
 * A GROUP whose VALUE is a REDUCER over the group's pooled child traversers, or `null` to decline.
 *
 * **The pool is the whole point.** `GroupStep` applies the value traversal's PRE-BARRIER part per
 * traverser and lets the BARRIER reduce what every member of a key contributed
 * (`Grouping.determineBarrierStep`) — so `group().by(T.label).by(__.bothE().values('weight').sum())` is
 * one sum per LABEL, not the sum of per-vertex sums re-summed. The two agree for `sum` and disagree for
 * `mean`, which is precisely why this may not be a decomposition table: `mean` needs the complete
 * child-row domain, and a rule that is right for three reducers and wrong for the fourth is the shape
 * of defect the decline contract exists to prevent.
 *
 * So the value side is a JOIN and the grouping aggregates over it — the seam's `rows` answer (§6·6's
 * fourth), with the `origin` channel naming each child row's host. The KEY is re-projected FROM THE
 * ORIGIN rather than carried, because a join keeps channels and drops payload: one `int` names the
 * parent, and the same `by()` that would have read the parent reads it again off that rowid.
 *
 * THREE DECLINES, each for its own reason and none of them taste:
 *
 * - a host with no ROWID (a scalar, a record) — `origin` is a rowid and a value stream has none (a
 *   channels-core change). It bites only the POOLING arm: the empty-body `count()` below pools
 *   nothing, so it is answered for every host `groupBarrier` itself admits;
 * - `count()` with a NON-EMPTY body — `CountGlobalStep` seeds 0, so a member whose body produced
 *   nothing must still count 0 and keep its key, which needs an OUTER join where every other reducer
 *   wants an inner one (`SumGlobalStep` leaves `NON_EMITTING_SEED` and the key goes with the traverser);
 * - a body that does not reduce to a per-row VALUE — there is nothing for an aggregate to read.
 *
 * `count()` with an EMPTY body is not the same question and is answered here: `by(__.count())` counts
 * the group's own traversers, which is `groupCount`'s value exactly, with no join and no pool.
 */
function groupReduced(
  input: Rel, host: ChildHost, step: IRStep, keyBy: Modulation | undefined, body: readonly IRStep[],
  bulked: boolean, child: ChildSeam, source: GraphSource, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } | null {
  const reducer = body.at(-1)!.name;
  const pre = body.slice(0, -1);
  if (!pre.length) {
    // `by(__.count())` — the group's own traverser count. `groupBarrier` already builds exactly that
    // for `groupCount()`, so this re-enters it rather than growing a second spelling of one answer.
    //
    // BEFORE the host test below, and that ordering is the §6·6 rule rather than a tidy-up: this arm
    // pools nothing, so it needs no `origin` and no rowid, and testing the host first declined every
    // host the POOLING arm cannot serve for a question that never reaches it. Measured on
    // `g.V().properties().group().by(__.element()).by(__.count())`, which the algebra could express
    // the whole time.
    if (reducer !== 'count') return null;
    return groupBarrier(input, host, { ...step, name: 'groupCount', modulators: step.modulators?.slice(0, 1) }, bulked, child, source, fresh);
  }
  // THE POOLING ARM needs a rowid to name each child row's parent by, so only an ELEMENT host reaches
  // it — `origin` is typed `int` and a value stream has none (a channels-core change).
  if (host.kind !== 'element') return null;
  if (reducer !== 'count' && !isReducer(reducer)) return null;
  // `mean` used to DECLINE for the §12 blob-precision reason: SQLite's JSON writer serializes a REAL at
  // 15 significant digits, so `map/Mean.feature:70`'s `d[0.3333333333333333].d` came back a digit short.
  // The map VALUE is a `typedNode` (below), and `typedNode` now makes every numeric member lossless for
  // the JSON channel (`jsonSafeScalar`, `build.ts`) — a binary64 rides as a 17-digit JSON number — so the
  // mean survives and the decline is gone. It was never a mean-specific bug; every reducer whose result
  // needs 16-17 digits goes through the same repair now.
  const counting = reducer === 'count';
  const rows = child.rows(pre, input, host.elem, host.row?.aliases ?? NO_LABELS);
  // A COUNT counts TRAVERSERS, so it needs no value at all and admits any body shape; every other
  // reducer reads one, so a body that does not end in a per-row value has nothing to reduce.
  if (!rows || (!counting && rows.framing.kind !== 'scalar')) return null;

  const elementKey = !keyBy;
  /** The key, from whichever ROWID names the parent — the child rows' `origin`, or the parent's own
   *  `id` in the seed arm below. One function, because the two arms must group by the same thing. */
  const keyOf = (rowid: Expr): Expr | null =>
    (elementKey ? rowid : byNode(keyBy!, { kind: 'element', id: rowid, elem: host.elem }, source, fresh, child));
  const key = keyOf(col(rows.rel.id, rows.origin));
  if (!key) return null;
  const keyCols = typeOf(meta(KEY_COL, elementKey ? 'int' : 'json', true), meta(VAL_COL, 'any', true));
  // THE KEY IS A COLUMN FIRST, for the reason the barrier's own key is: a `by()` key is a correlated
  // subquery and SQL needs it in the SELECT list AND the GROUP BY, so naming it once is what stops the
  // whole subquery being inlined at every position it appears.
  //
  // A COUNT's value column is the traverser WEIGHT rather than a value — `SUM(bulk)` where the stream
  // carries a multiplicity, which is `countExpr`'s rule, and the seed arm below contributes 0.
  const bulk = rows.rel.channels.find((channel) => channel.role === 'bulk');
  const projected = make.project({
    id: fresh('rk'), input: rows.rel, channels: [], type: keyCols,
    exprs: [[KEY_COL, key], [VAL_COL, counting ? (bulk ? col(rows.rel.id, bulk.col) : compilerInt(1)) : col(rows.rel.id, 'v')]],
  });
  /**
   * A COUNT KEEPS ITS KEY WHERE EVERY OTHER REDUCER LOSES IT, and that is a SEED ROW rather than an
   * outer join.
   *
   * `CountGlobalStep` seeds 0 and `ReducingBarrierStep` therefore emits for an empty pool, so a group
   * member whose body produced NOTHING must still contribute a 0 and keep its key; `SumGlobalStep`
   * leaves `NON_EMITTING_SEED` in place and emits nothing, so there the key goes with the traverser.
   * An inner join gives the second, which is why only this arm needs the other.
   *
   * A LEFT JOIN is not available — the child rows are built by the ordinary fold, whose movements are
   * inner joins by construction — but it is also not needed: one row per PARENT contributing WEIGHT
   * ZERO is the same answer, because a parent with children then sums their weights and a parent with
   * none sums its single zero. The union stays inside the same `GROUP BY`, so nothing downstream has
   * to know which arm a row came from.
   */
  const seedKey = counting ? keyOf(col(input.id, 'id')) : null;
  if (counting && !seedKey) return null;
  const arms = counting
    ? make.union({
      id: fresh('ru'), all: true, channels: [], type: keyCols,
      inputs: [make.project({ id: fresh('rz'), input, channels: [], type: keyCols, exprs: [[KEY_COL, seedKey!], [VAL_COL, compilerInt(0)]] }), projected],
    })
    : projected;
  const keyed = make.materialize({ id: fresh('rm'), input: arms, channels: [], type: arms.type });
  const drop = productivityFilter(step, col(keyed.id, KEY_COL));
  const rowsIn = drop
    ? make.filter({ id: fresh('rf'), input: keyed, channels: [], type: keyed.type, pred: drop })
    : keyed;
  // A REDUCER reads the pooled VALUES with no bulk weighting — the child rows are the pool, one
  // traverser each, and re-applying a collapsed parent's multiplicity would count every walk twice. A
  // COUNT sums the weight column the projection above built, `COALESCE`d for the reason `countExpr`
  // carries one: a group whose every row is a zero seed must answer 0, not NULL.
  const reduced = counting
    ? { value: coalesce({ kind: 'agg' as const, fn: 'sum' as const, args: [col(rowsIn.id, VAL_COL)] }, compilerInt(0)), type: compilerText('long') }
    : reducerAggregate(col(rowsIn.id, VAL_COL), reducer);
  const productive = make.aggregate({
    id: fresh('rb'), input: rowsIn, channels: [],
    type: typeOf(meta(KEY_COL, elementKey ? 'int' : 'json', true), meta(VAL_COL, 'any', true)),
    groupBy: [col(rowsIn.id, KEY_COL)],
    aggs: [[VAL_COL, reduced.value]],
  });
  const entry: Entry = {
    key: elementKey ? elementNode(col(productive.id, KEY_COL), host.elem, fresh) : col(productive.id, KEY_COL),
    // THE TAG IS A CANONICAL TYPE, NOT A STORAGE CLASS. `reducerAggregate` reports `typeof(<the
    // aggregate>)` — `'integer'`/`'real'` — which is what `scalarPayload`'s `result: 'number'` arm
    // reads, and the typed tree speaks the OTHER vocabulary (`'long'`/`'double'`). Handing it a storage
    // class made a mean frame as an unmapped tag and come back a digit short; `inferredVtype` is the
    // shared translation, and using it here is the same answer the framer would reach for an untagged
    // value with the big-long case still covered.
    // A COUNT is a Gremlin `long` by declaration, which is what makes the wire emit an explicit Int64
    // rather than letting magnitude inference pick Int for a small count. Every other
    // reducer's result class is DYNAMIC, so its tag is inferred from the value's storage class.
    val: typedNode(col(productive.id, VAL_COL), counting ? compilerText('long') : inferredVtype(col(productive.id, VAL_COL))),
    keyOf: elementKey ? { kind: 'elem', elem: host.elem } : { kind: 'scalar' },
    valOf: { kind: 'scalar' },
  };
  return {
    rel: mapOfGroups(productive, entry, col(productive.id, KEY_COL), fresh),
    keyOf: entry.keyOf,
    valOf: entry.valOf,
  };
}

/**
 * A GROUP whose VALUE is a `by(<pre>.fold())` — the pooled child rows COLLECTED into a list per key, or
 * `null` to decline.
 *
 * The sibling of `groupReduced`, and the front half is the same: `child.rows` pools the pre-fold body's
 * rows and flattens a many-per-traverser body (`by(__.out().fold())`) exactly as it does for
 * `by(__.out().count())`, each row naming its parent by `origin`. The KEY is re-projected FROM THE ORIGIN
 * so N members of one parent share one key. The two diverge at the barrier — a `fold()` COLLECTS where a
 * reducer REDUCES — which is why they are two functions and not one flag.
 *
 * **The SEED is what a `fold()` needs and a `sum()` does not.** `FoldStep` is a reducing barrier that
 * seeds `[]` and emits over an empty pool, so `g.V()...group().by().by(__.out().fold())` maps a childless
 * vertex to `l[]` and KEEPS its key — `sideEffect/Group.feature`'s `g_V_..._group_by_byXout_foldX`:
 * `{"v[vadas]":"l[]", "v[peter]":"l[v[lop]]"}`. `child.rows` is an inner join, so a childless parent
 * contributes no row; a SEED row per parent (its key, a NULL member) creates the group, and the
 * collecting aggregate's own `FILTER (WHERE member IS NOT NULL)` drops the seed so the fold is `[]` rather
 * than `[null]`. This is the same seed `groupReduced`'s COUNT arm unions in, and for the same reason.
 *
 * The pooled rows are then handed to `groupMap` unchanged — member encoding, member order, the empty-list
 * `FILTER`, and the `{t:'list', v}` framing are the collecting arm's, so a `by(<pre>.fold())` frames
 * identically to the by()-less collect one container along.
 */
function groupCollected(
  input: Rel, host: ChildHost, step: IRStep, keyBy: Modulation | undefined, body: readonly IRStep[],
  child: ChildSeam, source: GraphSource, fresh: Minter,
): GroupedMap | null {
  const pre = body.slice(0, -1);
  // A bare `by(__.fold())` is the by()-less collecting arm (`bareFold` already collapsed it); this pool
  // exists for a pre-fold body. THE POOLING needs a rowid to name each child row's parent, so only an
  // ELEMENT host reaches it — `origin` is typed `int` and a value stream has none.
  if (!pre.length || host.kind !== 'element') return null;
  const rows = child.rows(pre, input, host.elem, host.row?.aliases ?? NO_LABELS);
  // A body that lost the origin (a barrier BEFORE the fold — `by(__.out().order().fold())`) is a
  // different first barrier and declines here rather than folding the wrong pool.
  if (!rows) return null;
  // The MEMBER, encoded exactly as a value `by()` member is: an element row's rowid → `{t:'vertex',…}`,
  // a scalar row's value → its `{t,v}` node. A shape a node cannot carry (a map/list member) declines.
  const valueCol = rows.framing.kind === 'elements' ? col(rows.rel.id, 'id') : col(rows.rel.id, 'v');
  const member = producedMemberNode(valueCol, rows.framing, fresh);
  if (!member) return null;

  const elementKey = !keyBy;
  /** The key, from whichever ROWID names the parent — the child rows' `origin`, or the parent's own `id`
   *  in the seed arm. One function so both arms group by the same thing (`groupReduced`'s rule). */
  const keyOf = (rowid: Expr): Expr | null =>
    (elementKey ? rowid : byNode(keyBy!, { kind: 'element', id: rowid, elem: host.elem }, source, fresh, child));
  const key = keyOf(col(rows.rel.id, rows.origin));
  const seedKey = keyOf(col(input.id, 'id'));
  if (!key || !seedKey) return null;

  // MEMBER ORDER is the child rows' own encounter, the same total order `mise run test:perturbed` pins for
  // the collecting arm; the seed rows sort with a `0` they never keep (the `FILTER` drops them).
  const enc = rows.rel.channels.find((channel) => channel.role === 'encounter');
  const cols = typeOf(meta(KEY_COL, elementKey ? 'int' : 'json', true), meta(MEMBER_COL, 'any', true), meta(ORD_COL, 'int'));
  const real = make.project({
    id: fresh('ck'), input: rows.rel, channels: [], type: cols,
    exprs: [[KEY_COL, key], [MEMBER_COL, member], [ORD_COL, enc ? col(rows.rel.id, enc.col) : col(rows.rel.id, rows.origin)]],
  });
  const seed = make.project({
    id: fresh('cz'), input, channels: [], type: cols,
    exprs: [[KEY_COL, seedKey], [MEMBER_COL, compilerNull()], [ORD_COL, compilerInt(0)]],
  });
  const arms = make.union({ id: fresh('cu'), all: true, channels: [], type: cols, inputs: [seed, real] });
  const keyed = make.materialize({ id: fresh('cm'), input: arms, channels: [], type: cols });
  // TinkerPop drops an unproductive KEY rather than grouping under null, the same rule (and the same
  // `ProductiveByStrategy` exception) the barrier's own key obeys — asked here because the seed can
  // introduce a null key a real member never would.
  const drop = productivityFilter(step, col(keyed.id, KEY_COL));
  const rowsIn = drop ? make.filter({ id: fresh('cf'), input: keyed, channels: [], type: cols, pred: drop }) : keyed;
  // The COLLECTING arm frames the list, drops the seed (`memberDrop`), orders by encounter and wraps the
  // members in a `{t:'list', v}` node — a `by(<pre>.fold())` is that arm over a pooled row set.
  const recipe: GroupRecipe = {
    counting: false, keyElem: elementKey ? host.elem : undefined, member: { kind: 'node' },
    single: false, memberDrop: true, bulkCol: undefined, step,
  };
  const grouped = groupMap(rowsIn, recipe, fresh);
  return grouped;
}

/** The hosts whose traverser is addressed by a ROWID, so a collecting group can carry it as an integer
 *  and expand it once per SURVIVING member rather than once per row. Named because three sites read it
 *  (the `tail()` admission, the member projection, the member expansion) and a fourth spelling of the
 *  same set is how they would drift apart. */
const ROWID_HOSTS: ReadonlySet<ChildHost['kind']> = new Set(['element', 'property']);

/** THE TRAVERSER ITSELF as a collected member — a rowid where the host has one (expanded once per
 *  surviving member at the aggregate) and the self-describing value node for a scalar, which is
 *  `byNode`'s own identity answer over that host. One function so the hosts cannot describe "the
 *  traverser" two ways, and a THROW rather than a decline for a host that has neither: `groupBarrier`
 *  reaches this only after admitting the host, so another kind here is a lowering bug and not a
 *  deferral. */
function traverserMember(host: ChildHost, source: GraphSource, fresh: Minter): Expr {
  if (host.kind === 'element' || host.kind === 'property') return host.id;
  const node = byNode({ key: { kind: 'identity' } }, host, source, fresh);
  if (!node) throw new Error(`RelIR lowering: a ${host.kind} host cannot project its own traverser as a group member`);
  return node;
}

/** A collected ROWID expanded back into its self-describing member node, at the AGGREGATE — the other
 *  half of `traverserMember`, and the reason the two are stated together: what goes into `gt` and what
 *  comes back out of it must be the same traverser. A host with no rowid never reaches here (its member
 *  is already a node), so this throws rather than declining, exactly as its twin does. */
function rowidMember(host: ChildHost, rowid: Expr, fresh: Minter): Expr {
  if (host.kind === 'element') return elementNode(rowid, host.elem, fresh);
  if (host.kind === 'property') return propertyNode(rowid, host.ownerElem, fresh);
  throw new Error(`RelIR lowering: a ${host.kind} host has no rowid member to expand`);
}

/** The host a `by()` projects from, for an ELEMENT relation — the shape `groupBarrier` needs handed to
 *  it, kept here so the two callers (element and scalar tails) cannot describe it differently.
 *
 *  `aliases` rides along because a `by()` may BE an alias read (`by(__.select('v'))`), which is state on
 *  the ROW rather than a question about the traverser. Optional so a caller with no label map in hand
 *  still gets a host; the alias arm then declines instead of guessing. */
export const elementHost = (rel: Rel, elem: Elem, aliases?: AliasMap): ChildHost =>
  ({ kind: 'element', id: col(rel.id, 'id'), elem, ...(aliases ? { row: { rel, aliases } } : {}) });

// ---------- the LITERAL producer: a `[k:v, …]` argument AS a map value ----------
//
// The SOURCE half of the map shape (§6·3), and the reason it is four lines: the whole re-enterable map
// tail (`mapSize`, `mapSide`, `mapKey`, `unfoldMap`, `entrySide`) and the framing arm already existed
// for `group()`/`valueMap()`, so a producer for a LITERAL needs nothing new — a `[k:v, …]` argument is
// the same self-describing pairs array `[[keyNode, valNode], …]` those producers emit, only built once
// at compile time here rather than aggregated from rows.
//
// **`valueNodeOf` is the one authority for that tree.** It already turns any value + `TypeNode` into the
// stored `{t,v}` vocabulary the wire framer reads (`gremlin/types.ts`), recursively and for a map as its
// ORDERED PAIRS — which IS the blob. Re-spelling the encoding here would be a second chance to disagree
// with the framer about how a scalar leaf stores, the mistake the shared authority exists to prevent.

/** A map LITERAL as the pairs-array blob a map-valued relation carries (`MAP_COL`), or `null` to
 *  decline. A COMPILE-TIME constant, so it inlines as a typed literal and spends none of the parameter
 *  budget — the bind rule's "a constant the compiler holds inlines" (root `CLAUDE.md`).
 *
 *  Two fail-closed guards keep the blast radius to what the framer already reads: a NON-STRING key (a
 *  `(T.label)` token, whose node `valueNodeOf` cannot yet spell — its key comes back `{t:null, v:{token}}`)
 *  and any value the JSON encoder cannot carry (a bigint leaf throws). Both are the "not learned yet"
 *  `null`, so a map with one such entry declines whole rather than seeding a corrupt blob — the token
 *  keys and exact tails arrive with the write substrate that owns `mergeV`/`mergeE`. */
export function mapLiteralBlob(value: unknown, type: TypeNode | null): Expr | null {
  if (!(value instanceof Map)) return null;
  const node = valueNodeOf(value, type);
  if (node.t !== 'map') return null;
  // Every key must be a plain `{t:'string', v:<string>}` node: that is the only key the map tail's own
  // reads (`mapKey` matches `$[0].v` against a string, `mapSide` collects the key nodes) can resolve
  // today, and a `T` token or a typed key would frame from a malformed node.
  const pairs = (node as { readonly v: readonly (readonly [ValueNode, ValueNode])[] }).v;
  if (!pairs.every(([key]) => key.t === 'string' && typeof key.v === 'string')) return null;
  let json: string;
  try { json = JSON.stringify(pairs); } catch { return null; }
  // `jsonb('…')` over the inlined text: `MAP_COL` is JSONB, exactly what `mapPayload` reads back through
  // `json()`, so a literal map and a `group()` map reach the wire through one column and one framer.
  return { kind: 'call', fn: 'jsonb', args: [compilerText(json)] };
}

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

/**
 * DOES THIS MAP CARRY THE `T` TOKENS — a BOOLEAN, because all-or-nothing is the whole of what can
 * reach here today.
 *
 * `valueMap(true)` and `with(WithOptions.tokens)` are both ALL of them (`PropertyMapStep.configure` —
 * a boolean argument selects `WithOptions.all`/`none`) and `elementMap()`'s are unconditional. The
 * SELECTIVE subsets exist in TinkerPop (`with(tokens, ids)`) and `absorbValueMapWith` deliberately
 * leaves them in place so they fail closed — so NOTHING on this route can construct one, and a
 * two-field record modelling a subset would be an arm with no producer. It arrives with its pass.
 */
export type MapTokens = boolean;

/** No labels in scope — a host built without a row (see `elementHost`). Shared so the two readers
 *  cannot describe "none" differently. */
const NO_LABELS: AliasMap = new Map();

/**
 * `valueMap()` and `elementMap()` — an ELEMENT's properties as one map per traverser.
 *
 * ONE function for both, because the two differ in three FACTS and not in how the map is built —
 * exactly the relationship `group()`/`groupCount()` have inside `groupBarrier`, and the reason that
 * one takes a step rather than a pair of booleans:
 *
 * - **the tokens.** `valueMap`'s are optional (`valueMap(true)`, `with(WithOptions.tokens)`);
 *   `elementMap`'s are unconditional (`ElementMapStep.map` puts `T.id` and `T.label` outright).
 * - **the value arity.** A `valueMap` VERTEX key is MULTI-VALUED so its value is a LIST, and an EDGE
 *   key's is the value itself (`PropertyMapStep.addElementProperties` — `map.compute(key,
 *   …values.add(value))` for a Vertex, `map.put(key, value)` otherwise). An `elementMap` is FLAT
 *   whatever the host, and `map.put` overwrites, so a multi-valued key keeps its LAST value.
 * - **the ENDPOINTS.** An edge `elementMap()` adds `Direction.IN`/`Direction.OUT`, each a nested map
 *   of that vertex's own `T.id`/`T.label` (`ElementMapStep.getVertexStructure`).
 *
 * **The KEY ORDER is ours to state, and it is the insertion order** — each key at its earliest
 * property rowid, which is what the element payload's own bag does. TinkerPop hands back a
 * `LinkedHashMap` in `element.properties()` iteration order, which is a provider's business rather
 * than the spec's; stating it is what makes it deterministic rather than whatever SQLite scanned.
 *
 * The token entries LEAD, in the order the reference puts them: `T.id`, `T.label`, then an edge's
 * `Direction.IN` and `Direction.OUT`, then the properties.
 */
export function elementValueMap(
  input: Rel, elem: Elem, keys: readonly string[] | null, tokens: MapTokens, regime: LabelRegime,
  source: GraphSource, fresh: Minter,
  opts: { readonly flat?: boolean; readonly endpoints?: boolean } = {},
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } {
  const rowid = col(input.id, 'id');
  // The per-key VALUE ARRAYS come from the GRAPH SOURCE — `vertex_properties`/`edge_properties` over the
  // base graph, the landed `{t,v}` tree over a bound one (`keyMembership`'s key-set rule lives inside it:
  // `null` every key, a non-empty set membership, an empty set no entries). The map/flat/token SHAPING
  // stays here so both sources frame identically.
  const pairsRel = source.valueMapPairs(elem, rowid, keys, fresh);
  const perKey = make.project({
    id: fresh('vp'), input: pairsRel, channels: [],
    type: typeOf(meta(PAIR_ROW.pair, 'json'), meta(PAIR_ROW.ord, 'int')),
    exprs: [
      [PAIR_ROW.pair, pairOf(
        typedNode(col(pairsRel.id, VALUEMAP_PAIR.key), compilerText('string')),
        // FLAT (`elementMap`, and a `valueMap` over an EDGE, whose key is single by schema) takes the
        // one node; a `valueMap` VERTEX key wraps the whole array as a `{t:'list', …}` node. `$[#-1]`
        // is LAST-wins, which is what `map.put` per property in insertion order means.
        opts.flat || elem === 'edge'
          ? { kind: 'call', fn: 'json_extract', args: [col(pairsRel.id, VALUEMAP_PAIR.values), compilerText('$[#-1]')] }
          : { kind: 'json-object', entries: [['t', compilerText('list')], ['v', col(pairsRel.id, VALUEMAP_PAIR.values)]], binary: false },
      )],
      [PAIR_ROW.ord, col(pairsRel.id, VALUEMAP_PAIR.ord)],
    ],
  });
  const rows: Rel[] = [];
  // A NEGATIVE ordinal puts the tokens ahead of every property, whose ordinals are rowids and therefore
  // positive. Stating it that way rather than sorting a tagged column keeps the whole order in ONE term.
  if (tokens) {
    rows.push(tokenRow(rowid, elem, 'id', regime, -4, source, fresh));
    rows.push(tokenRow(rowid, elem, 'label', regime, -3, source, fresh));
  }
  if (opts.endpoints && elem === 'edge') {
    rows.push(endpointRow(rowid, 'IN', regime, -2, source, fresh));
    rows.push(endpointRow(rowid, 'OUT', regime, -1, source, fresh));
  }
  const pairs = rows.length ? make.union({
    id: fresh('vu'), inputs: [...rows, perKey], all: true, channels: [], type: perKey.type,
  }) : perKey;
  const blob = make.aggregate({
    id: fresh('va'), input: pairs, channels: [], type: typeOf(meta(MAP_COL, 'json')),
    groupBy: [],
    aggs: [[MAP_COL, collectedArray(jsonOf(col(pairs.id, PAIR_ROW.pair)), [{ expr: col(pairs.id, PAIR_ROW.ord), dir: 'asc' }])]],
  });
  return {
    // `COALESCE` for `mapOfGroups`' reason one level down: an element with NO properties and no tokens
    // is an EMPTY MAP and still one traverser, not a null value.
    rel: withPayload(input, [[MAP_COL, coalesce({ kind: 'scalar', plan: blob }, { kind: 'call', fn: 'jsonb', args: [jsonOf(compilerText('[]'))] })]],
      [meta(MAP_COL, 'json', true)], fresh),
    keyOf: { kind: 'scalar' },
    // A vertex `valueMap()` value is ALWAYS a `List` — one `ArrayList` per key regardless of cardinality
    // (`PropertyMapStep.java:246-267`) — stored here as the `{t:'list', v:values}` node above, so its
    // TRUE shape is `{kind:'list', of: TYPED_MEMBERS}` (docs/archive/2026-08-21-map-value-shape-plan.md). The FLAT
    // form (`elementMap`) takes the single last value (`$[#-1]`), an EDGE's key is single by schema, and
    // `valueMap(true)`'s id/label TOKENS are scalar — a mixed map — so those keep the self-describing
    // scalar arm (framed-correct, opaque to a consumer until a mixed-value increment).
    valOf: elem === 'vertex' && !opts.flat && !tokens ? { kind: 'list', of: TYPED_MEMBERS } : { kind: 'scalar' },
  };
}

/** One `T.id`/`T.label` entry, as a pair row correlated to the element. The LABEL follows the
 *  `LabelRegime`: a set of names where a vertex genuinely holds a set, the one first-interned name
 *  otherwise, and an EDGE's label is always the single name TinkerPop fixes its cardinality at. */
function tokenRow(rowid: Expr, elem: Elem, token: 'id' | 'label', regime: LabelRegime, ord: number, source: GraphSource, fresh: Minter): Rel {
  const gate = token === 'label' && elem !== 'edge' && regime === 'single';
  // The token VALUES are self-correlated source reads (`externalId`/`labelScalar`/`labelArray`), so the
  // anchor supplies only the ONE row per element the pair projects off — a base scan, or a landed rejoin.
  const anchor = source.elementRow(elem, rowid, fresh);
  // A zero-label vertex OMITS its single-regime `T.label` entry (`getVertexStructure`'s `isEmpty()`
  // gate) — a cheap EXISTS probe / array-length test from the source, holding over either graph.
  const row = gate
    ? make.filter({ id: fresh('lg'), input: anchor, channels: [], type: anchor.type, pred: source.hasAnyLabel('vertex', rowid, fresh) })
    : anchor;
  // The element's OWN id/label read off the anchor row (no re-scan); a vertex's label set is a side/tree
  // read that self-correlates. (An endpoint's id/label, which has no anchor row, self-correlates too.)
  const value = token === 'id'
    ? idNode(source.externalIdOf(anchor))
    : elem === 'edge'
      // An edge label is ALWAYS the one name: TinkerPop fixes edge label cardinality at exactly one,
      // so no regime applies to it (`addIncludedOptions` reads `element.labels()` for a Vertex only).
      ? typedNode(source.edgeLabelOf(anchor, fresh), compilerText('string'))
      : labelNode(rowid, regime, source, fresh);
  return pairRow(row, pairOf(tokenKey(token), value), compilerInt(ord), fresh);
}

/**
 * A ZERO-LABEL VERTEX HAS NO `T.label` ENTRY AT ALL in the single regime, which is a filter on the
 * token ROW rather than a null value in it: `addIncludedOptions` puts the label only
 * `if (!label.isEmpty())`, and `ElementMap.feature`'s `g_withXsinglelabelX_V_elementMap_zero_label_vertex`
 * pins the omission (`m[{"t[id]": …, "name": "nobody"}]`, no label key). Under MULTILABEL the entry is
 * always present and may be the empty set (`…_zero_label_vertex` under `with("multilabel")` →
 * `"t[label]": "s[]"`), so the filter is regime-specific and not a general defence. Our `label()`
 * reports `DEFAULT_VERTEX_LABEL` for such a vertex, which is right for the scalar step and would be a
 * WRONG entry here — the same value answering two different questions.
 */
/** An EDGE ENDPOINT as an `elementMap` entry — `Direction.IN`/`Direction.OUT` keyed at a nested map of
 *  that vertex's own `T.id`/`T.label` and nothing else (`ElementMapStep.getVertexStructure`). `IN` is
 *  the edge's TARGET and `OUT` its source, which is TinkerPop's direction convention and our column
 *  naming's (`tgt`/`src`) meeting point. */
function endpointRow(rowid: Expr, side: 'IN' | 'OUT', regime: LabelRegime, ord: number, source: GraphSource, fresh: Minter): Rel {
  const row = source.elementRow('edge', rowid, fresh);
  // The endpoint id (`tgt`/`src`) is on the edge row for either graph; its own id/label then read the
  // VERTEX source (base tables, or the landed vertex relation for a bound endpoint).
  const endpoint = col(row.id, side === 'IN' ? 'tgt' : 'src');
  const nested: Expr = {
    kind: 'json-object', binary: false,
    entries: [['t', compilerText('map')], ['v', {
      kind: 'json-array', binary: false,
      items: [
        { kind: 'json-array', binary: false, items: [jsonOf(tokenKey('id')), jsonOf(idNode(source.externalId('vertex', endpoint, fresh)))] },
        { kind: 'json-array', binary: false, items: [jsonOf(tokenKey('label')), jsonOf(labelNode(endpoint, regime, source, fresh))] },
      ],
    }]],
  };
  return pairRow(row, pairOf(directionKey(side), nested), compilerInt(ord), fresh);
}

/** A `Direction` token as a map KEY — `T`'s standing one enum along (`FrameNode`'s `D` arm). */
const directionKey = (side: 'IN' | 'OUT'): Expr =>
  ({ kind: 'json-object', entries: [['t', compilerText('D')], ['v', compilerText(side)]], binary: false });

/** An element's external id, from the source, as a typed `T.id` node. NOT `typedNode`: that helper
 *  re-tests the tag for collection-ness (`storedValueOn`), which would spell the inference CASE twice —
 *  an external id is a rowid or a uid, never a collection, so the node is built directly. */
const idNode = (external: Expr): Expr =>
  ({ kind: 'json-object', binary: false, entries: [['t', inferredVtype(external)], ['v', external]] });

/** A vertex rowid's LABEL as a typed node, by regime — the endpoint entries' `T.label` value. A zero-label
 *  endpoint keeps the entry (a nested endpoint map is built unconditionally by `getVertexStructure`, which
 *  applies the same `isEmpty()` test only to the NAME); the value is then a null tag the framer infers. */
const labelNode = (rowid: Expr, regime: LabelRegime, source: GraphSource, fresh: Minter): Expr => regime === 'set'
  ? { kind: 'json-object', binary: false, entries: [['t', compilerText('set')], ['v', source.labelArray('vertex', rowid, fresh)]] }
  : typedNode(vertexLabelName(rowid, source, fresh), compilerText('string'));

/** A vertex's SINGLE label — the side table's first-interned name, which is the same deterministic pick
 *  `label()` and `by(T.label)` make. Spelled through `byExpr`'s token arm so a third pick cannot exist. */
const vertexLabelName = (rowid: Expr, source: GraphSource, fresh: Minter): Expr => {
  const projected = byExpr({ key: { kind: 'token', token: 'label' } }, { kind: 'element', id: rowid, elem: 'vertex' }, source, fresh);
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

/**
 * Does this pair's KEY equal `key` — tolerant of BOTH key encodings the map vocabulary carries.
 *
 * A map key is a string here (a property name, a `project()` label), but the two producers spell it
 * differently: `group()`/`valueMap()` emit a `{t,v}` node key (`[{"t":"string","v":"name"},…]`), while
 * `project()` emits a BARE string key (`["n",…]` — `record.ts`'s deliberate choice, since a project key
 * is never in question and the wire framer infers a bare member). Both frame identically, so it was a
 * latent split until `project().fold().unfold().select(k)` made a bare-key map re-enter `mapTail`. So
 * the match reads `$[0].v` (the enveloped key) and falls back to `$[0]` (the bare key) — one comparison
 * that both encodings satisfy, rather than a producer-specific reader.
 */
const keyMatches = (pair: Expr, key: string): Expr => eq(
  { kind: 'call', fn: 'COALESCE', args: [
    { kind: 'call', fn: 'json_extract', args: [pair, compilerText('$[0].v')] },
    { kind: 'call', fn: 'json_extract', args: [pair, compilerText('$[0]')] },
  ] },
  compilerText(key));

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
 * A `scalar` side is a `{t,v}` node, which is precisely what a TYPED list's members are. A `list` VALUE
 * is a list whose members have shape `of.of` — so `select(Column.values)` over a `Map<K,List>` is a
 * list-of-lists (`docs/archive/2026-08-21-map-value-shape-plan.md`): the RESULT list's member IS that value
 * list, so the translation is the identity on the `list` arm (`{kind:'list', of}` describes both the
 * value and the result member). The members are collected at the ROOT encoding (raw inner arrays — see
 * `mapSide`), so `unfoldNested`/`listPayloadExpr` serve them unchanged. An `elem` side is an expanded
 * element node whose decode into the SCALAR vocabulary would be lossy, so it declines.
 */
const sideList = (of: MapOf): ListOf | null =>
  of.kind === 'scalar' ? TYPED_MEMBERS
    // A `list` or `map` VALUE becomes a select(values) member of the SAME kind — the translation is the
    // identity (`{kind:'list'|'map', of}` describes both the value and the member), and both collect at
    // the ROOT encoding in `mapSide` so the existing `unfoldNested`/`unfoldMapMembers`/`listPayloadExpr`
    // serve them. An `elem` KEY frames through the mixed→typedNode path (its nodes self-describe; the
    // scalar list framer decodes them lossily).
    : of.kind === 'list' || of.kind === 'map' ? of
      : of.kind === 'elem' ? { kind: 'mixed', arms: [{ kind: 'elem', elem: of.elem }] }
        : null;

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
  // THE MEMBER IS THE SIDE'S NODE, except a LIST value collects at the ROOT encoding: its `{t:'list',
  // v:[…]}` node is UNWRAPPED to its raw inner array (`$.v`), so `select(Column.values)` over a
  // `Map<K,List>` is a standard root-encoded list-of-lists that `unfoldNested`/`listPayloadExpr` frame
  // unchanged (`docs/archive/2026-08-21-map-value-shape-plan.md`, the encoding fork). A scalar side keeps its
  // self-describing `{t,v}` node (`TYPED_MEMBERS`).
  const node = pairSide(col(pairs.id, PAIR.value), side);
  const member = of.kind === 'list' || of.kind === 'map'
    ? jsonOf({ kind: 'call', fn: 'json_extract', args: [node, compilerText('$.v')] })
    : jsonOf(node);
  const sides = collectedOf(pairs, member, [{ expr: col(pairs.id, PAIR.ord), dir: 'asc' }], LIST_COL, fresh);
  return {
    rel: withPayload(rel, [[LIST_COL, sides]], [meta(LIST_COL, 'json', true)], fresh),
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
export function entrySide(input: Rel, side: 'keys' | 'values', of: MapOf, fresh: Minter): Rel | null {
  return sideOf(input, col(input.id, side === 'keys' ? ENTRY.key : ENTRY.val), of, fresh);
}

/**
 * ONE `{t,v}` NODE as the traverser — the retype both an ENTRY side and a `select(<key>)` need.
 *
 * A scalar side becomes an ordinary per-row-typed value stream, which is the same unwrap the list
 * module's `memberPayload` does one container along (the value out of `$.v`, its tag out of `$.t`). An
 * `elem` side declines for `mapPayload`'s reason: the node frames correctly where it is, and decoding
 * it into the SCALAR vocabulary would be lossy. There is no third side — see `sideList`.
 */
function sideOf(input: Rel, node: Expr, of: MapOf, fresh: Minter): Rel | null {
  const field = (name: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [node, compilerText(`$.${name}`)] });
  // A LIST value UNWRAPS its `{t:'list', v:[…]}` node to the raw inner array in `LIST_COL` — the same
  // root encoding `mapSide` collects — so `select(<key>)`/an entry's value side is a LIST stream the
  // caller continues with `listTail` (`docs/archive/2026-08-21-map-value-shape-plan.md`). Without this a list
  // `valOf` would make `select(<key>)` DECLINE where it executes today — a regression, not a gap.
  if (of.kind === 'list') return withPayload(input, [[LIST_COL, jsonOf(field('v'))]], [meta(LIST_COL, 'json', true)], fresh);
  // A MAP value UNWRAPS its `{t:'map', v:pairs}` node to the raw pairs array in `MAP_COL`, so the caller
  // continues with `mapTail` — a nested `group().by().by(__.group()…)`'s inner map re-enters the map loop.
  if (of.kind === 'map') return withPayload(input, [[MAP_COL, jsonOf(field('v'))]], [meta(MAP_COL, 'json', true)], fresh);
  if (of.kind !== 'scalar') return null;
  return withPayload(input, [['v', field('v')], ['vtype', field('t')]],
    [meta('v', 'any', true), meta('vtype', 'text', true)], fresh);
}

/**
 * `select(<key>)` over a MAP traverser — the map's own value at that key, or `null` to decline.
 *
 * **A MAP IS A SCOPE, and it is consulted BEFORE the path labels** — `Scoping.getScopeValue` asks the
 * traverser's own `Map` first and only then the labels
 * (`gremlin-core/.../step/util/Scoping.java`), which is why this is the map loop's answer to `select`
 * and not the alias vocabulary's.
 *
 * **An ABSENT key DROPS the traverser, and that is a different test from a NULL value.** `select` is
 * `SelectOneStep`, whose `ifProductive` emits nothing for an unproductive read — so presence is an
 * `EXISTS` over the pairs and the value is its own extract, exactly the `present`-beside-the-value
 * split the option-map `choose` needed for `Pick.none` versus `Pick.unproductive`.
 */
export function mapKey(input: Rel, key: string, valOf: MapOf, fresh: Minter): Rel | null {
  const rel = fenced(input, fresh);
  // The key match is tolerant of both key encodings (`keyMatches`) — a `{t,v}` node key from
  // `group()`/`valueMap()` or a bare-string key from `project().fold().unfold()`.
  const matching = (pairs: Rel): Expr => keyMatches(col(pairs.id, PAIR.value), key);
  const probePairs = pairsOf(col(rel.id, MAP_COL), fresh);
  // THE PRESENCE FILTER COMES FIRST, and the order is forced rather than chosen: the projection below
  // spends the `map` column, so a filter after it would reference a column that no longer exists.
  const kept = make.filter({
    id: fresh('kg'), input: rel, channels: rel.channels, type: rel.type,
    pred: {
      kind: 'exists', negated: false,
      plan: make.project({
        id: fresh('kp'), channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]],
        input: make.filter({ id: fresh('kf'), input: probePairs, channels: [], type: probePairs.type, pred: matching(probePairs) }),
      }),
    },
  });
  const valuePairs = pairsOf(col(kept.id, MAP_COL), fresh);
  // The value and the order are written in the inner FILTER's scope, not the explode's — every node
  // addresses its own INPUT, and the filter is a relation between them (`firstOf`'s own contract).
  const matched = make.filter({ id: fresh('kv'), input: valuePairs, channels: [], type: valuePairs.type, pred: matching(valuePairs) });
  return sideOf(kept, firstOf(matched, pairSide(col(matched.id, PAIR.value), 'values'), col(matched.id, PAIR.ord), fresh), valOf, fresh);
}

/**
 * `select(k1, k2, …)` over a MAP traverser — a SUB-MAP of the named keys, or `null` to decline.
 *
 * `SelectStep.processNextStart` (≥2 keys,
 * `vendor/tinkerpop/gremlin-core/.../step/map/SelectStep.java:66-89`) builds a `LinkedHashMap` in
 * select-key ORDER, reading each key from the traverser's own Map first
 * (`Scoping.getScopeValue:121` — `containsKey`, so a PRESENT-NULL key is kept). A key absent from the
 * map — and, the caller having declined a live-alias key for `mapKey`'s reason, absent everywhere —
 * makes the WHOLE traverser drop (`bindings.size() != selectKeysSet.size()` → `EmptyTraverser`).
 *
 * So it is the barrier's own pairs array rebuilt: one matched pair per key, in select order, each the
 * source map's `[keyNode, valNode]` WHOLE — behind an all-keys-present filter. Keys are bounded by the
 * QUERY TEXT (a fixed list), so the sub-map is a fixed-size `json_array`, never a data-sized bind. The
 * values keep their nodes, so `valOf` carries through and `keyOf` stays scalar (the keys are strings).
 */
export function mapSelect(
  input: Rel, keys: readonly string[], valOf: MapOf, fresh: Minter,
): { readonly rel: Rel; readonly keyOf: MapOf; readonly valOf: MapOf } | null {
  const rel = fenced(input, fresh);
  const map = col(rel.id, MAP_COL);
  const matching = (pairs: Rel, key: string): Expr => keyMatches(col(pairs.id, PAIR.value), key);
  // PRESENCE, per key — the traverser survives only if EVERY key is in the map, because a `select` over
  // a map FILTERS on a missing key rather than binding a null entry (the `EmptyTraverser` above).
  const present = keys.map((key): Expr => {
    const pairs = pairsOf(map, fresh);
    return {
      kind: 'exists', negated: false,
      plan: make.project({
        id: fresh('sp'), channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]],
        input: make.filter({ id: fresh('sf'), input: pairs, channels: [], type: pairs.type, pred: matching(pairs, key) }),
      }),
    };
  });
  const kept = make.filter({
    id: fresh('sg'), input: rel, channels: rel.channels, type: rel.type,
    pred: present.reduce((a, b) => and(a, b)),
  });
  // THE SUB-MAP — the matched pair per key, in SELECT order. `firstOf` picks the one matching pair (a
  // key is unique within a map), read in the inner FILTER's scope for `firstOf`'s own reason.
  const keptMap = col(kept.id, MAP_COL);
  const pairs = keys.map((key): Expr => {
    const p = pairsOf(keptMap, fresh);
    const matched = make.filter({ id: fresh('sm'), input: p, channels: [], type: p.type, pred: matching(p, key) });
    return jsonOf(firstOf(matched, col(matched.id, PAIR.value), col(matched.id, PAIR.ord), fresh));
  });
  const blob: Expr = { kind: 'call', fn: 'jsonb', args: [{ kind: 'json-array', items: pairs, binary: false }] };
  return {
    rel: withPayload(kept, [[MAP_COL, blob]], [meta(MAP_COL, 'json', true)], fresh),
    keyOf: { kind: 'scalar' }, valOf,
  };
}

/**
 * THE MAP PAYLOAD — one row's `map` column as the JSON the framing layer reads (§6·3), or `null` to
 * decline.
 *
 * The blob is ALREADY the frameable tree: `[[keyNode, valNode], …]` with self-describing `{t,v}` scalar
 * sides, which is the encoding every producer here emits and the one `frameTypedNode` decodes. So the
 * projection is `json(map)` and nothing else — the relational column is JSONB and `json()` is what turns it
 * into the text the framer parses. A LIST value side needs no conversion either: the blob's value side is a
 * naked array, and the typed framer treats a bare array as a list of bare members exactly as it treats a
 * bare scalar as an inferred value. ONE blob encoding, not two with a rebuild between them.
 *
 * AN ELEMENT SIDE NEEDS NOTHING SPECIAL HERE, and it used to decline. What changed is not this function
 * but what a producer puts in the blob: `elementNode` makes an element a MEMBER of the self-describing
 * tree, so `{t:'vertex', v:{…}}` is walked by the one rule `frameTypedNode` already has, at whatever
 * depth it appears. The `elem` tag on the side is therefore an ALGEBRA fact — it tells the side READS
 * (`sideList`, `entrySide`) that decoding into the scalar vocabulary would be lossy — and not a wire
 * one, which is why the `Shape` below says `scalar` for it (`mapSideBuffer`'s own `elem` arm expects a
 * BARE payload object, and this blob carries the envelope).
 *
 * It therefore takes NO side descriptors and cannot decline: `mapValue` is one blob whatever the sides
 * hold. Keeping the parameters "for symmetry" with `mapEntryPayload` would be keeping the two arguments
 * whose only job was the decline that is now wrong.
 */
export function mapPayload(rel: Rel, fresh: Minter): { readonly rel: Rel; readonly shape: Shape } {
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
  const ordered = byEncounter(rel, fresh);
  return {
    rel: make.project({
      id: fresh('ew'), input: ordered, channels: [],
      type: typeOf(meta(ENTRY.key, 'json', true), meta(ENTRY.val, 'json', true)),
      exprs: [[ENTRY.key, jsonOf(col(ordered.id, ENTRY.key))], [ENTRY.val, jsonOf(col(ordered.id, ENTRY.val))]],
    }),
    // An `elem` side crosses as `scalar`: the column holds a `{t,v}` node, which is what
    // `mapSideBuffer`'s scalar arm frames, while its own `elem` arm expects a bare payload object. The
    // two vocabularies answer two questions (`framing.ts`'s note), and this is that split paying off.
    shape: { kind: 'mapEntry', keyOf: framed(keyOf), valOf: framed(valOf) },
  };
}

/** A side AS THE WIRE sees it — an `elem` side is a typed node here, so it frames like any other. */
// A Map.Entry's key and value columns each hold a self-describing `{t,v}` NODE (the in-map encoding),
// which `mapSideBuffer`'s scalar arm frames by walking its own `t` — so EVERY value shape crosses as
// `scalar` here, not just `elem`. A `list` valOf (a `Map<K,List>` entry) must collapse too: the value
// column is the `{t:'list', v}` node, not the root-encoded raw array, so framing it as a list would
// `items.map` over the node object. The list precision is for CONSUMERS (`select`/`unfold`-then-op),
// never for the entry's own node framing (`docs/archive/2026-08-21-map-value-shape-plan.md`).
const framed = (of: MapOf): MapOf => (of.kind === 'scalar' ? of : { kind: 'scalar' });
