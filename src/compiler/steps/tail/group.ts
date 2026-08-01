import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import { empty, list, q, raw, value, values, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { PER_ROW, perRowColumnOf, staticTypeOf, type ElemShape, type GroupKey, type GroupVal } from '../../../sql/kernel/render.ts';
import { NUMERIC_REDUCERS, REDUCERS } from '../../ir/step.ts';
import { type IRStep } from '../../ir/strategies.ts';
import {
    bareValueMapProps,
    compareKey,
    elemCtx,
    elementPayload,
    elemTable,
    labelNameFor,
    predicateSql,
    propExtract,
    propOwnerCol,
    propRel,
    scalarProp,
    storedValueExpr,
    typedScalarNode,
    vertexLabelIn,
    vertexLabelsJson,
    type Elem,
    type ScalarCtx
} from '../../plan/plan.ts';
import { dropLayoutAtBarrier, elemRel, layoutCols, layoutProjection, layoutProjectionMinting, partitionOver, patchLayout, type ElementStream, type LoweringState, type TraverserLayout } from '../context/context.ts';
import { continueLowering, dispatchShapeTail, groupColumns, loweringStateOf, PROPERTY_PAYLOAD, toElementStream, toGroupStream, toMapStream, toPropertyStream, toResultStream, toScalarStream, type GroupStream, type LoweringResult, type MapOf, type MapStream, type PropertyStream, type ScalarStream, type ShapeTailFn } from '../context/stream.ts';
import { globalRowOps, lowerGlobalCount, numericReducerAggregate, type NumericReducer } from './barrier.ts';
import { assertsGType, childCtx, childSteps, classifyBy, classifyCountChild, classifyElementChildRows, classifyMapChildRows, classifyScalarChildRows, elementScalarBranchArm, reuseCurrentFrame, ROOT_SCOPE, type ChildFrameStack, type ChildParent, type ChildUse } from './child-shape.ts';
import { applyChildCardinality, lowerElementBody, mintChildEncounter, pushChildScope, tryCompileElementImplicitFoldRows, tryCompileElementRowsBeforeFold, tryCompileRowsBeforeReducer, tryCompileScalarRowsBeforeFold, tryCompileScalarValueChild, tryCompileScalarValueRows } from './child.ts';
import { isMapLocalOrder } from './list.ts';

/** The numeric reducers that terminate a nested-group inner value `by(__.values(x).<r>())`. */
const SCALAR_REDUCERS = NUMERIC_REDUCERS;  // no `count`: a count needs no scalar input

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind. */
export interface GroupSource {
  from: Expression;
  ctx: ScalarCtx;
  elem: ElemShape;
  /** A generic child-key result already joined one-to-one with each productive
   * source traverser. When present, buildGroupKey need not parse the traversal. */
  keyExpr?: Expression;
  /** Composite project() key parts compiled independently on one outer origin. */
  keyParts?: readonly { key: string; expr: Expression }[];
  /** Productive rows from a non-reducing scalar value child. Multiple rows per
   * source traverser deliberately remain multiple group-list members. */
  valExpr?: Expression;
  /** A terminal reducer to apply across ALL child rows sharing the final group key,
   * never independently per source parent. */
  valReducer?: 'count' | NumericReducer;
  valMarker?: Expression;
  /** The per-source-traverser multiplicity (a carried `bulk` column, qualified to the
   * group's source relation) that weights a DIRECT source-level aggregation — bare
   * `groupCount()` sums it instead of `COUNT(*)`. Absent (bulk≡1) → the unweighted form,
   * identical result. Matches lowerScalarGroupCount's scalar-key weighting. */
  bulk?: Expression;
  /** The per-CHILD-ROW multiplicity that weights a value reducer over child rows
   * (`by(__.count())` → SUM(bulk); `by(__.values(x).sum())` → SUM(v·bulk)). The child rows
   * inherit the source traverser's bulk through the child scope, so a fanned-out reducer
   * counts each contribution the right number of times.
   *
   * This is the COLLAPSING side of the bulk axis documented on `lowerScopedScalarReducer`
   * (barrier.ts) — a group value reducer folds the whole group's multiset into ONE total per key,
   * so every contribution must be flattened by its traverser's multiplicity. Do not "unify" it
   * with the scoped (per-parent) reducer, which must NOT weight: measured, dropping the weighting
   * here makes `repeat(__.both()).times(2).group().by(T.label).by(__.count())` answer 4/2 (the
   * distinct collapsed rows) instead of 20/10 (the traversers). */
  valBulk?: Expression;
  /** Raw rows folded once per final group key. `valOrder` is parent encounter then
   * child encounter, so folding never relies on incidental join order. */
  valFold?: boolean;
  valOrder?: Expression;
  valElement?: { elem: 'vertex' | 'edge'; ctx: ScalarCtx };
  productiveBy?: boolean;
  /** The live parent traverser stream the group folds over — an element (node/edge) OR
   * a property (properties().group()). Its by() sub-traversals lower through the generic
   * child seam (tryLowerGroupChildSource). Only stashed cap() group sources omit it. */
  parent?: ChildParent;
  /** A nested-group value `by(__.<move>.group()/groupCount())` — the inner key/value read
   * off the child-expanded inner element/property ctx. lowerGroup emits a two-level
   * aggregation (lvl1 groups by (outerKey, innerKey) + reduces; the outer json_group_object
   * folds each outer key's entries into one Map). `from` already carries the inner joins. */
  valNestedMap?: { innerKey: Expression; innerVal: Expression; innerKind: 'count' | 'number' };
}

/** The GROUP source over a live element stream: the element table JOINed to the parent
 *  CTE on identity, plus the matching scalar ctx / elem kind / bulk weight. ONE kernel-built
 *  home for the shape every group entry point needs — the terminal group() tail, the
 *  side-effecting group('a')/groupCount('a'), and cap('a')'s re-run — so none of them
 *  hand-builds a raw SQL string (the former reason GroupSource.from carried a `string` arm).
 *  Aliases are fixed (`n` element table, `p` parent rel) so the returned `ctx` — built over
 *  `n` — lines up with the FROM. */
export function elementGroupSource(st: ElementStream, productiveBy?: boolean): GroupSource {
  const n = elemRel(st, 'n');
  const p = st.rel.as('p');
  return {
    from: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`,
    ctx: elemCtx(n, st.elem),
    elem: st.elem,
    parent: st,
    productiveBy,
    bulk: st.traverserLayout.bulk ? p.c[st.traverserLayout.bulk] : undefined,
  };
}

/** Columns that frame one element (vertex/edge/property) under `prefix`, with its internal
 *  rowid — `elementPayload` (plan.ts) is the shared authority; group's element key/value is one
 *  of its fourteen consumers. */
const elementSelect = (elem: ElemShape, prefix: string, ctx: ScalarCtx): Expression =>
  elementPayload(ctx, elem, prefix, true);

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx): Expression => elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string | Expression }
const scalarGroupKey = (productive?: boolean): GroupKey => productive
  ? { kind: 'scalar', productive: true }
  : { kind: 'scalar' };

/** Build the key columns for group(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, params: Record<string, any>): GroupKeyBuild {
  if (src.keyExpr) return { desc: scalarGroupKey(src.productiveBy), cols: q`${src.keyExpr} AS gk`, group: 'gk' };
  if (src.keyParts) {
    const cols = src.keyParts.map((part, i) => q`${part.expr} AS ${`k${i}_v`}`);
    return {
      desc: { kind: 'map', parts: src.keyParts.map((part) => ({ key: part.key })) },
      cols: list(cols, ', '),
      group: src.keyParts.map((_, i) => `k${i}_v`).join(', '),
    };
  }
  const by = classifyBy(keyArgs);
  if (by.kind === 'none') { // bare by() → the element itself is the key
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx), group: elementIdExpr(src.elem, src.ctx) };
  }
  if (by.kind === 'key') { // by('name') — first-under-multi for a node
    const pe = scalarProp(src.ctx, by.key);
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${pe} AS gk`, group: 'gk' };
  }
  if (by.kind === 'token') { // by(T.label)/by(T.id)
    // A VertexProperty's T.label is its key (pk); its T.id is vpid (ctx.idExpr). For an
    // element, T.label resolves the interned label id to its name.
    const expr = by.token === 'label'
      ? (src.elem === 'property' ? src.ctx.pkExpr! : src.ctx.labelNameExpr)
      : by.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${by.token}) not yet supported`);
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${expr} AS gk`, group: 'gk' };
  }
  {
    // A traversal key lowers through the generic child seam (tryLowerGroupChildSource →
    // keyExpr/keyParts). Reaching here means it did not — a genuine deferral, not an
    // inline reader fallback.
    const inner = stepChain(by.nested, params);
    if (inner[0]?.name === 'project')
      throw new Error('group().by(project(...)) composite key not supported by generic child lowering');
    throw new Error('group().by(traversal) key not supported by generic child lowering');
  }
}

const GROUP_VALUE_REDUCERS = REDUCERS;

/** The inner key + reduced value of a nested-group value body `__.<move>.<group|groupCount>`,
 *  read off the child-expanded inner element/property ctx. Returns null for shapes not yet
 *  generic (element-valued inner keys, non-count/reducer inner values) — a clean deferral,
 *  never a mis-execution. Mirrors buildGroupKey's key resolution for the inner level. The
 *  inner rows carry the OUTER traverser's `bulk` (propagated through the child scope), so the
 *  inner reducer weights by it exactly like the outer level — a bulked outer traverser folds
 *  each inner contribution its multiplicity of times (identical while bulk≡1). */
function nestedInnerKeyVal(
  innerGroup: IRStep,
  ctx: ScalarCtx,
  params: Record<string, any>,
  bulk?: Expression,
): { key: Expression; val: Expression; kind: 'count' | 'number' } | null {
  const innerBys: any[][] = innerGroup.modulators ?? [];
  const keyArg = innerBys[0]?.[0];
  let key: Expression | null = null;
  if (keyArg && typeof keyArg === 'object' && 'token' in keyArg)
    key = keyArg.token === 'label' ? (ctx.elem === 'property' ? ctx.pkExpr! : ctx.labelNameExpr)
      : keyArg.token === 'id' ? ctx.idExpr : null;
  else if (typeof keyArg === 'string') key = scalarProp(ctx, keyArg);
  if (!key) return null; // bare/element inner key deferred
  const countVal = bulk ? q`SUM(${bulk})` : q`COUNT(*)`;
  if (innerGroup.name === 'groupCount') return { key, val: countVal, kind: 'count' };
  // group().by(ik).by(__.count()) or by(__.values(x).<numeric>())
  const reduceArg = innerBys[1]?.[0];
  if (!reduceArg || typeof reduceArg !== 'object' || !('nested' in reduceArg)) return null;
  const rsteps = childSteps(reduceArg.nested, params);
  const reducer = rsteps.at(-1)?.name;
  if (rsteps.length === 1 && reducer === 'count') return { key, val: countVal, kind: 'count' };
  if (rsteps.length === 2 && rsteps[0].name === 'values' && SCALAR_REDUCERS.has(reducer!))
    return { key, val: numericReducerAggregate(scalarProp(ctx, rsteps[0].args[0]), reducer as NumericReducer, bulk).value, kind: 'number' };
  return null;
}

/** The per-origin emission-order column on a retained child-rows stream. Every child-rows
 *  producer mints one (the scalar projection windows ROW_NUMBER over the child ordinal), and the
 *  group aggregates are built on it — it is both the ORDER BY of a folded value and the
 *  productivity MARKER a LEFT-JOINed empty child is filtered by. Its absence is an internal
 *  contradiction (a rows-retaining child that minted no order), so say so instead of emitting
 *  `undefined` as a column name via a bare `!`. */
const childEncounter = (rows: { traverserLayout: TraverserLayout }, site: string): string => {
  const enc = rows.traverserLayout.encounter;
  if (!enc) throw new Error(`${site}: child rows carry no emission-order encounter to fold/mark on`);
  return enc;
};

/** Lower generic scalar key/value children and join them back to the original
 * element through ONE shared parent origin. Keys consume `first`; non-reducing
 * values consume `all`; reducers expose their raw productive rows so the final
 * GROUP BY owns the barrier. Nothing in this phase reduces independently per parent. */
function tryLowerGroupChildSource(bys: any[][], src: GroupSource): GroupSource | null {
  const parent = src.parent;
  if (!parent) return null;
  // The child-body vocabulary depends on the parent SHAPE: an element parent's children
  // are movement/filter/values (isScalarChild); a property parent's children are
  // key()/value()/element().… (isPropertyScalarChild). Element-valued (fold) children are
  // element-parent-only — a property has no adjacency to collect.
  const isProp = parent.kind === 'property';
  const pk = isProp ? 'property' : 'element';
  const isByArg = (a: any) => isNested(a);
  // Shape gates classify the NORMALIZED child body — the exact body tryCompile* compiles —
  // so gating and emit share ONE parse (the body is threaded into emit as preParsed) and
  // the old is*Child re-parse is gone. Raw stepChain still drives STRUCTURE detection
  // (project() head, value terminal), which needs the un-normalized shape.
  // Two classifiers, COMPLEMENTARY rather than alternative — which is what this gate used to get
  // wrong. classifyCountChild covers a body with no scalar projection (`count()`, `out().count()`);
  // classifyScalarChildRows covers `<prefix>.<projection>.<reducer>`. Neither subsumes the other, so
  // TRY BOTH. Selecting one by whether the terminal is `count` meant a count-terminal body with a
  // projection matched neither: `by(__.label().count())` and `by(__.values("n").count())` failed
  // while the identical shape under any OTHER reducer (`.sum()`, `.min()`, …) worked — `count` was
  // special for no semantic reason. The emit side never needed changing: a count-terminal body
  // already routes to genericReducer → tryCompileRowsBeforeReducer, the generic `<rows>.<reducer>`
  // path, which is what lowers `out().count()` today.
  const scalarShape = (body: ReturnType<typeof stepChain>) => isProp
    ? classifyScalarChildRows('property', body) !== null
    : classifyScalarChildRows('element', body, childCtx(parent)) !== null
      || (body.at(-1)?.name === 'count' && classifyCountChild(body, childCtx(parent)) !== null);
  const scalarFoldShape = (body: ReturnType<typeof stepChain>) =>
    body.at(-1)?.name === 'fold' && classifyScalarChildRows(pk, body.slice(0, -1), childCtx(parent)) !== null;

  const keyArg = bys[0]?.[0];
  const valArg = bys[1]?.[0];
  const keySteps = isByArg(keyArg) ? stepChain(keyArg.nested, parent.params) : [];
  const keyBody = isByArg(keyArg) ? childSteps(keyArg.nested, parent.params) : [];
  const valSteps = isByArg(valArg) ? stepChain(valArg.nested, parent.params) : [];
  const valBody = isByArg(valArg) ? childSteps(valArg.nested, parent.params) : [];
  const valTerminal = valSteps.at(-1)?.name;

  const genericKey = isByArg(keyArg) && scalarShape(keyBody);

  const projectStep = keySteps[0]?.name === 'project' ? keySteps[0] : undefined;
  const projectBys = projectStep ? keySteps.slice(1) : [];
  const projectKeys = projectStep?.args.filter((x: any): x is string => typeof x === 'string') ?? [];
  const projectByNested = projectBys.map((step) => step.name === 'by'
    ? step.args.find((x: any) => x && typeof x === 'object' && 'nested' in x)?.nested
    : undefined);
  const projectKeyBodies = projectByNested.map((n) => n ? childSteps(n, parent.params) : null);
  const genericProjectKey = !!projectStep
    && projectBys.length === projectKeys.length
    && projectByNested.every((n, i) => !!n && scalarShape(projectKeyBodies[i]!));

  // An unreduced scalar value: the flat shape OR (element parent only) a nested scalar-armed
  // branch (choose/coalesce/union). group is fan-out-tolerant — values fold into the per-key
  // list — so it shares the scalar seam's arm vocabulary; the emit (tryCompileScalarValueChild
  // 'all') already lowers nested branches. Only genericVal widens here: a nested branch is not a
  // reducer/fold terminal, and a group KEY uses 'first' (no encounter for a branch) so keys stay flat.
  const genericVal = valSteps.length > 0
    && !GROUP_VALUE_REDUCERS.has(valTerminal!)
    && (scalarShape(valBody) || (!isProp && elementScalarBranchArm(valBody, childCtx(parent))));
  const genericReducer = valSteps.length > 0
    && GROUP_VALUE_REDUCERS.has(valTerminal!)
    && scalarShape(valBody);
  const genericFold = valTerminal === 'fold' && scalarFoldShape(valBody);
  const genericElementFold = !isProp && valTerminal === 'fold'
    && classifyElementChildRows(valBody, 'fold', false, childCtx(parent)) !== null;
  // An unreduced element value traversal (by(__.out()), by(__.out().order())) collects
  // into a list — TinkerPop's implicit fold. Same relational path as genericElementFold.
  const genericElementImplicitFold = !isProp && !genericElementFold
    && valSteps.length > 0
    && classifyElementChildRows(valBody, undefined, false, childCtx(parent)) !== null;
  // A nested-group value `by(__.<move>.group()/groupCount())`: the movement prefix expands
  // to inner rows through the SAME generic child engine, and the inner group folds them per
  // outer key (a two-level aggregation in lowerGroup). The prefix is either element movement
  // (compiled via lowerElementSteps) or properties() (the outer element's VertexProperties).
  // valTerminal is the RAW terminal ('by' when the inner group carries by() modulators); the
  // normalized valBody has folded them, so the inner group is its last step.
  const valBodyTerminal = valBody.at(-1)?.name;
  const nestedGroup = parent.kind === 'elements' && (valBodyTerminal === 'group' || valBodyTerminal === 'groupCount') ? valBody.at(-1) : undefined;
  const nestedPrefix = nestedGroup ? valBody.slice(0, -1) : [];
  const nestedElementMove = !!nestedGroup && classifyElementChildRows(nestedPrefix, undefined, false) !== null;
  const nestedPropertiesMove = !!nestedGroup && !nestedElementMove
    && nestedPrefix.length === 1 && nestedPrefix[0].name === 'properties'
    && ((nestedPrefix[0] as IRStep).args ?? []).every((a: any) => typeof a === 'string')
    && parent.kind === 'elements';
  const genericGroupVal = nestedElementMove || nestedPropertiesMove;
  if (!genericKey && !genericProjectKey && !genericVal && !genericReducer && !genericFold && !genericElementFold && !genericElementImplicitFold && !genericGroupVal) return null;

  const outer = pushChildScope(parent);
  const p = outer.seed.rel.as('gp');
  const joins: Expression[] = [];
  let keyExpr: Expression | undefined;
  let keyParts: GroupSource['keyParts'];
  let valExpr: Expression | undefined;
  let valReducer: GroupSource['valReducer'];
  let valMarker: Expression | undefined;
  let valFold = false;
  let valOrder: Expression | undefined;
  let valElement: GroupSource['valElement'];
  let valBulk: Expression | undefined;
  const reuse = () => reuseCurrentFrame(outer.scope, outer.frame);
  if (genericKey) {
    const child = tryCompileScalarValueChild(outer.seed, keyArg.nested, 'first', reuse(), keyBody)!;
    const c = child.rel.as('gk');
    joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    keyExpr = c.c.v;
  }
  if (genericProjectKey) {
    keyParts = projectKeys.map((key, i) => {
      const child = tryCompileScalarValueChild(outer.seed, projectByNested[i], 'first', reuse(), projectKeyBodies[i]!)!;
      const c = child.rel.as(`gkp${i}`);
      joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
      return { key, expr: c.c.v };
    });
  }
  if (genericVal) {
    // An unreduced scalar group value collects its child rows into the key's list, so it shares
    // the explicit fold's AGGREGATE: the child rows keep their scope (tryCompileScalarValueRows
    // retains the frame, so the per-origin `encounter` survives) and the list is built ORDER BY
    // that encounter. It used to pop the scope (tryCompileScalarValueChild 'all') and emit a bare
    // json_group_array — no order at all. Member order merely HAPPENED to match the emission
    // order, until any extra CTE in the body (say a select(label) re-root) permuted it.
    //
    // It keeps its own INNER join, and that is the one thing it must NOT borrow from the fold:
    // an UNREDUCED value traversal that produces nothing FILTERS the traverser, while a fold is
    // a barrier that always produces (an empty list), so the key survives. TinkerPop pins both
    // halves on the same graph — Group.feature `g_V_hasXperson_name_withinXvadas_peterXX_group_
    // by_byXout_foldX` keeps `v[vadas]: []`, and its unreduced twin `…_byXout_orderX` drops the
    // vadas key entirely, annotated "validates that a collecting barrier produces a filtering
    // effect if it is unproductive". So implicit-collect is NOT ≡ fold here; only the ordering
    // is shared.
    const rows = tryCompileScalarValueRows(outer.seed, valArg.nested, reuse(), valBody)!;
    const c = rows.stream.rel.as('gv');
    joins.push(q` JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[childEncounter(rows.stream, 'group value')];
    valFold = true;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${valMarker}`;
  }
  if (genericReducer) {
    const rows = tryCompileRowsBeforeReducer(outer.seed, valArg.nested, reuse(), valBody)!;
    const c = rows.stream.rel.as('gr');
    const join = rows.reducer === 'count' ? ' LEFT JOIN ' : ' JOIN ';
    joins.push(q`${join}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[childEncounter(rows.stream, 'group value reducer')];
    valReducer = rows.reducer;
    // The child rows inherit the source traverser's bulk through the child scope; a value
    // reducer weights by it so a bulked (collapsed/repeat) parent counts each contribution
    // its multiplicity of times (identical while bulk≡1).
    valBulk = rows.stream.traverserLayout.bulk ? c.c[rows.stream.traverserLayout.bulk] : undefined;
  }
  if (genericFold) {
    const rows = tryCompileScalarRowsBeforeFold(outer.seed, valArg.nested, reuse(), valBody)!;
    const c = rows.stream.rel.as('gf');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[childEncounter(rows.stream, 'group value fold')];
    valFold = true;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${valMarker}`;
  }
  if (genericElementFold || genericElementImplicitFold) {
    const rows = (genericElementFold
      ? tryCompileElementRowsBeforeFold(outer.seed, valArg.nested, reuse(), valBody)
      : tryCompileElementImplicitFoldRows(outer.seed, valArg.nested, reuse(), valBody))!;
    const c = rows.stream.rel.as('gef');
    const e = elemTable(rows.stream.elem).as('gev');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]} LEFT JOIN ${e} ON ${e.c.id}=${c.c.id}`);
    valMarker = c.c.id;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${c.c.id}`;
    valElement = { elem: rows.stream.elem, ctx: elemCtx(e, rows.stream.elem) };
  }
  let valNestedMap: GroupSource['valNestedMap'];
  if (genericGroupVal) {
    let innerCtx: ScalarCtx;
    // The inner rows carry the outer traverser's bulk — from the child-expanded element rows
    // (nestedElementMove) or, for a properties() expansion, straight off the pushed domain `p`.
    let innerBulk: Expression | undefined;
    if (nestedElementMove) {
      // The movement prefix expands to inner element rows through lowerElementSteps — any
      // valid movement/filter chain, not a hand-rolled adjacency join. Rejoin nodes/edges
      // so the inner key/value ctx can read the inner element's label/props.
      const rows = tryCompileElementImplicitFoldRows(outer.seed, valArg.nested, reuse(), nestedPrefix)!;
      const c = rows.stream.rel.as('gng');
      const e = elemTable(rows.stream.elem).as('gnge');
      joins.push(q` JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]} JOIN ${e} ON ${e.c.id}=${c.c.id}`);
      innerCtx = elemCtx(e, rows.stream.elem);
      innerBulk = rows.stream.traverserLayout.bulk ? c.c[rows.stream.traverserLayout.bulk] : undefined;
    } else {
      // properties() over the outer element: the SAME `lowerProperties` the properties() step
      // itself runs, over the pushed domain, rejoined on the ordinal — the sibling branch's
      // shape. It used to hand-join `vertex_properties` and hand-build a property ScalarCtx
      // that was `propertyCtx` with the payload names substituted, which is also why it could
      // only be reached over a VERTEX parent (an edge rowid read against `vertex_properties`
      // is a silent wrong answer, so the guard was the only thing making it safe).
      // nestedPropertiesMove is only set over an element parent, so the pushed seed is one —
      // a non-element here is a classify↔emit contradiction, not a fallback.
      if (outer.seed.kind !== 'elements') throw new Error('properties() nested group classified over a non-element parent');
      const props = lowerProperties(outer.seed, nestedPrefix[0]);
      const pp = props.rel.as('gnv');
      joins.push(q` JOIN ${pp} ON ${pp.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
      innerCtx = propertyCtx(pp, props.ownerElem);
      innerBulk = parent.traverserLayout.bulk ? p.c[parent.traverserLayout.bulk] : undefined;
    }
    const kv = nestedInnerKeyVal(nestedGroup as IRStep, innerCtx, parent.params, innerBulk);
    if (!kv) return null; // inner key/value shape not yet generic — clean deferral
    valNestedMap = { innerKey: kv.key, innerVal: kv.val, innerKind: kv.kind };
  }
  // The pushed domain `p` re-projects the parent traverser's bulk, so a source-level count
  // (bare groupCount() over a by(traversal) key) weights by it just like the direct path.
  const bulk = parent.traverserLayout.bulk ? p.c[parent.traverserLayout.bulk] : undefined;
  const common = { keyExpr, keyParts, valExpr, valReducer, valMarker, valFold, valOrder, valElement, valNestedMap, valBulk, bulk, productiveBy: src.productiveBy };
  // Property parent: the pushed domain `p` already carries owner/pk/pv, so the source is
  // `p` itself (plus the child joins) — no element table to rejoin. Element parent rejoins
  // nodes/edges `n` on the domain id so key/value ctx reads its columns.
  if (parent.kind === 'property')
    return { from: q`${p}${list(joins, '')}`, ctx: propertyCtx(p, parent.ownerElem), elem: 'property', ...common };
  if (parent.kind !== 'elements') throw new Error(`group() by-child over a ${parent.kind} parent not yet supported`);
  const n = elemRel(parent, 'gn');
  return {
    from: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${list(joins, '')}`,
    ctx: elemCtx(n, parent.elem),
    elem: parent.elem,
    ...common,
  };
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value can't be aggregated in SQL (props must be
 * framed), so we emit rows ORDER BY the key and the handler folds runs into the Map.
 */
export function lowerGroup(st: LoweringState, isCount: boolean, bys: any[][], src: GroupSource): GroupStream {
  src = tryLowerGroupChildSource(bys, src) ?? src;
  const key = buildGroupKey(bys[0], src, st.params);

  // Nested-group value → a Map per outer key. The child seam has already joined the inner
  // element/property expansion into src.from and read its inner key/value; here we finish
  // the TWO-LEVEL aggregation: lvl1 groups (outerKey, innerKey) applying the inner reducer,
  // then json_group_object folds each outer key's entries into one Map.
  if (src.valNestedMap) {
    if (key.desc.kind !== 'scalar') throw new Error('nested-group value requires a scalar/token outer key');
    const { innerKey, innerVal, innerKind } = src.valNestedMap;
    const lvl1 = st.q.cte(
      q`SELECT ${key.cols}, ${innerKey} AS ik, ${innerVal} AS iv FROM ${src.from} GROUP BY ${key.group}, ik`,
      ['gk', 'ik', 'iv'],
    );
    const l = lvl1.as('l');
    const rel = st.q.cte(
      q`SELECT ${l.c.gk} AS gk, json_group_object(${l.c.ik}, ${l.c.iv}) AS gv FROM ${l} WHERE ${l.c.ik} IS NOT NULL GROUP BY ${l.c.gk}`,
      ['gk', 'gv'],
    );
    return toGroupStream(dropLayoutAtBarrier(st), rel, key.desc, { kind: 'nestedMap', innerVal: innerKind });
  }

  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  // groupCount() (and group().by(k).by(count)) count TRAVERSERS per key: SUM(bulk) when the
  // stream carries a multiplicity (a movement collapse merged convergent walks into (row, N)),
  // else the plain COUNT — identical while bulk≡1, correct after a big fan-out/repeat.
  if (isCount) { val = { kind: 'count' }; valNode = src.bulk ? q`SUM(${src.bulk}) AS gv` : q`COUNT(*) AS gv`; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
  else if (src.valReducer === 'count') {
    // Count the productive (non-null marker) child rows, weighted by their carried bulk. The
    // reducer LEFT-JOINs the child rows, so an empty child's null-padded marker contributes 0.
    val = { kind: 'count' };
    valNode = src.valBulk
      ? q`COALESCE(SUM(CASE WHEN ${src.valMarker!} IS NOT NULL THEN ${src.valBulk} END), 0) AS gv`
      : q`COUNT(${src.valMarker!}) AS gv`;
  }
  else if (src.valReducer) {
    const reduced = numericReducerAggregate(src.valExpr!, src.valReducer, src.valBulk);
    val = { kind: 'sum' };
    valNode = q`${reduced.value} AS gv, ${reduced.type} AS gvt`;
  }
  else if (src.valFold) {
    val = { kind: 'list' };
    valNode = q`COALESCE(json_group_array(${src.valExpr!} ORDER BY ${src.valOrder!}) FILTER (WHERE ${src.valMarker!} IS NOT NULL), json('[]')) AS gv`;
  }
  else if (src.valElement) {
    val = { kind: 'elementList', elem: src.valElement.elem };
    groupBy = false;
    valNode = elementSelect(src.valElement.elem, 'v', src.valElement.ctx);
  }
  else {
    const by = classifyBy(valArgs);
    if (by.kind === 'key') { // by('age') → list of scalars (first-under-multi per member)
      const pe = scalarProp(src.ctx, by.key);
      val = { kind: 'scalarList' }; valNode = q`json_group_array(${pe}) AS gv`;
    } else if (by.kind === 'nested') {
      const inner = stepChain(by.nested, st.params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'tail') { val = { kind: 'elementLast', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'fold') { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'count') { val = { kind: 'count' }; valNode = src.bulk ? q`SUM(${src.bulk}) AS gv` : q`COUNT(*) AS gv`; } // per-key traverser count (weighted like isCount)
      else if (names[names.length - 1] === 'fold')
        throw new Error('this group fold shape is not yet supported by typed child lowering');
      else
        // A scalar/reducer value traversal lowers through the generic child seam
        // (tryLowerGroupChildSource → valExpr/valReducer/valFold); reaching here means it
        // did not — a genuine deferral, not an inline reader fallback.
        throw new Error('group().by(traversal) value not supported by generic child lowering');
    } else throw new Error('unsupported group().by() value modulator');
  }

  const order = src.valElement && src.valOrder ? q`${key.group}, ${src.valOrder}` : key.group;
  const node = q`SELECT ${key.cols}, ${valNode} FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${order}`;
  const rel = st.q.cte(node, groupColumns({ key: key.desc, val }));
  return toGroupStream(dropLayoutAtBarrier(st), rel, key.desc, val);
}

/**
 * valueMap()/elementMap() as a re-enterable, per-element MapStream — one map per input
 * element (an origin ordinal `o0`, unlike group's single global map). Each property is a
 * `(mk=key, mv=value-list)` entry row tagged with its element origin; compileFromMap then
 * aggregates per origin. Reached ONLY with a follower — terminal valueMap keeps the
 * unchanged buildProjection ResultStream. Tokens (valueMap(true)/id/label) and a
 * carried alias/path/branch/sack state defer (the origin ordinal would collide / tokens
 * need extra entry keys).
 */
export function lowerValueMap(st: ElementStream, proj: IRStep): MapStream {
  if (proj.name === 'elementMap') throw new Error('elementMap() re-entry not yet supported');
  if (proj.args.includes(true)) throw new Error('valueMap(true)/token re-entry not yet supported');
  // ORIGINS are admitted (and threaded below): a map is ONE blob per element, so a per-parent
  // ordinal rides it exactly as it rides a movement — which is what lets a valueMap() body be a
  // CHILD (`local(__.valueMap())`) and rejoin its parent. The other carried kinds still defer:
  // an alias/path history would have to be framed INTO the map, and sack/fromV are element state
  // the blob has no slot for.
  if (st.traverserLayout.aliases.size || st.traverserLayout.path || st.traverserLayout.sack || st.traverserLayout.fromV)
    throw new Error('valueMap() re-entry carrying as()/path()/sack state not yet supported');
  const keys = proj.args.filter((a: any) => typeof a === 'string') as string[];
  const p = st.rel.as('p');
  const n = elemRel(st);
  const vlJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  // The carried columns the blob rides out with, declared once and used for both CTEs so each
  // relation's declared schema equals its physical projection.
  //
  // The element's carried columns ride through UNCHANGED — no position-dependent behaviour here.
  // An earlier cut dropped `bulk` (one blob per element consumes it) and then needed an "unless we
  // are in a child" exception, because the parent's rejoin re-projects the parent's carried columns
  // off THIS relation and so needs every one present. Keeping it is simpler AND more correct: a
  // bulked element contributes its multiplicity to any downstream reducer, and the terminal framing
  // selects `map` alone, so the extra column costs nothing at the root.
  const outCarried = st.traverserLayout;
  const outCols = layoutCols(outCarried);
  // One WHOLE-MAP blob per element (mapstream-blob-model): fold its {key:[values]} props into an
  // ordered [[keyNode, valueList], …] pairs array. The key is a string → a self-describing {t,v}
  // scalar node (the uniform typed encoding); the value is the property's value list (a JSON
  // array, embedded via json() — a collection value round-trips as a real nested list, not the
  // typed tree, matching the UNTYPED list substrate the value side feeds). Terminal valueMap()
  // framing uses the typed valueMapProps instead (this path is the re-enterable follower form).
  const base = st.q.cte(
    q`SELECT ${bareValueMapProps(n, st.elem)} AS props${layoutProjection(outCarried, p)} FROM ${vlJoin}`,
    ['props', ...outCols],
  );
  const b = base.as('b');
  const keyFilter = keys.length ? q` WHERE je.key IN (${list(keys.map((k) => value(k)), ', ')})` : empty;
  const pair = q`json_array(json_object('t', 'string', 'v', je.key), json(je.value))`;
  // NO `ORDER BY je.key`. The props object `bareValueMapProps` builds is already in PROPERTY
  // INSERTION order (`ORDER BY MIN(p.id)`), and `json_each` over an object yields document order —
  // so leaving it alone preserves that, while sorting alphabetically destroyed it. That was
  // invisible while this builder only fed the re-entry consumers (which re-aggregate one side), and
  // became observable the moment a map could be FRAMED from here: the root form shows
  // {name, age} and this showed {age, name} for the same vertex.
  const rel = st.q.cte(
    q`SELECT jsonb(COALESCE((SELECT json_group_array(${pair}) FROM json_each(${b.c.props}) je${keyFilter}), json('[]'))) AS map${layoutProjection(outCarried, b)} FROM ${b}`,
    ['map', ...outCols],
  );
  // One blob row per element, carrying whatever the element carried (bar bulk, consumed here).
  const carry: LoweringState = loweringStateOf(st, outCarried);
  return toMapStream(carry, rel, { kind: 'scalar' }, { kind: 'list', of: { kind: 'scalar' } });
}

// ---------- a MAP-shaped child body ----------
//
// The child seam admitted element/scalar/list bodies; a map-producing body (`local(__.valueMap())`)
// was inadmissible at EVERY position, which is why four separate items named it as their blocker —
// item 2's residual, item 5's re-entry, the branch merges' uncovered shape, and the group re-entry
// matrix. It needed no new SQL: `lowerValueMap` (group.ts) is the ONE map builder, and a MapStream
// is a one-column `map` blob plus carried columns — structurally a scalar's `v`. The only thing
// missing was that the builder refused to run with a live origin and declared no carried columns,
// so it could not rejoin a parent. With those threaded, the body composes here through the SAME
// pieces the scalar child uses: the element fold for the prefix, the one map builder for the
// projection, and the shape-agnostic cardinality rejoin.

/** `<element movement/filter prefix>.valueMap(...)` as a child body → one map per parent.
 *  Null when the body is not that shape, so the caller keeps its own deferral. A suffix that
 *  RETYPES the map (`unfold`, `select(Column)`, `count(local)`) is declined for now rather than
 *  answered: those land on a list/entry/scalar shape, so the consumer needs the matching rejoin —
 *  the follow-up slice, not a different mechanism. */
export function tryCompileMapChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: ChildFrameStack = ROOT_SCOPE,
): MapStream | null {
  if (!nested || parent.kind !== 'elements') return null;
  // ONE classification, in the pure classify leaf with its siblings — this compiler never decides
  // shape itself, exactly as the scalar/element/count children don't.
  const shape = classifyMapChildRows(childSteps(nested, parent.params), childCtx(parent));
  if (!shape) return null;
  const { prefix, proj } = shape;

  const pushed = pushChildScope(parent, scope);
  const end = lowerElementBody(pushed.seed, prefix);
  if (!end) return null;
  // The `first` policy ranks per origin by an encounter, so mint one when the prefix carries
  // none — the same ROW_NUMBER-over-the-origin-partition mint every other child provider makes.
  const withEnc = end.traverserLayout.encounter ? end : mintChildEncounter(end);
  let lowered: MapStream;
  try { lowered = lowerValueMap(withEnc, proj); }
  catch { return null; } // the builder's own carried/token deferrals stay authoritative
  return applyChildCardinality(parent, pushed.frame, lowered, use).stream;
}

/** groupCount() over a SCALAR value stream — a barrier grouping by the value itself:
 * V().values('name').groupCount() → Map{name: count}. Bare form only (a by()/name-key
 * defers to the caller). null keys ARE counted (groupCount productive); a typed scalar's
 * compile-time tag (asNumber(BYTE).groupCount()) frames the key, else inference. */
export function lowerScalarGroupCount(s: ScalarStream): GroupStream {
  const c = s.rel.as('c');
  // Per-key count = SUM(bulk) when the scalar stream carries a multiplicity, else the row
  // count (identical while bulk≡1) — matching values().count()'s weighting.
  const gv = s.traverserLayout.bulk ? q`SUM(${c.c[s.traverserLayout.bulk]})` : q`COUNT(*)`;
  // A per-row stored type rides through the barrier as a SIBLING column (gkt) rather than a
  // {t,v} envelope: a bare groupCount() has no map blob for the key to ride inside, and the
  // key is a GROUP BY term — an envelope would group by the JSON text. Grouping spans
  // (value, type) for the same reason dedup() does: equal values of different stored types
  // are distinct Gremlin keys.
  const perRow = perRowColumnOf(s.type);
  if (perRow) {
    const rel = s.q.cte(
      q`SELECT ${c.c.v} AS gk, ${c.c[perRow]} AS gkt, ${gv} AS gv FROM ${c} GROUP BY ${c.c.v}, ${c.c[perRow]}`,
      ['gk', 'gkt', 'gv'],
    );
    return toGroupStream(dropLayoutAtBarrier(loweringStateOf(s)), rel, { kind: 'scalar', productive: true, type: PER_ROW('gkt') }, { kind: 'count' });
  }
  const rel = s.q.cte(q`SELECT ${c.c.v} AS gk, ${gv} AS gv FROM ${c} GROUP BY ${c.c.v}`, ['gk', 'gv']);
  return toGroupStream(dropLayoutAtBarrier(loweringStateOf(s)), rel, { kind: 'scalar', productive: true, type: s.type }, { kind: 'count' });
}

/** Continue from the rich group barrier. Terminal framing consumes the same lowered
 * relation; a supported Column selection derives the narrow entry MapStream without
 * recompiling group semantics based on terminal position. */
/** unfold(), select(Column.keys/values) and order(Scope.local).by(Column.*) all consume the group
 *  AS a map VALUE → derive the whole-map blob and re-enter as a MapStream, which then orders /
 *  unfolds / selects / frames the pairs. Note the cursor does NOT advance: the same step is
 *  re-dispatched against the new shape. */
const asMapValue: ShapeTailFn<GroupStream> = (s, _step, _steps, at) => {
  const { rel, keyOf, valOf } = deriveGroupMap(s);
  return continueLowering(toMapStream(loweringStateOf(s), rel, keyOf, valOf), at);
};

const GROUP_DISPATCH = new Map<string, ShapeTailFn<GroupStream>>([
  // is(typeOf(MAP)) — a group IS a Map → identity. Any other is() predicate over a group is not a
  // narrower version of the same question, so it throws here rather than declining. (The path arm
  // answers the SAME decode with an empty relation; both are deliberate — see `typeOfAssert`.)
  ['is', (s, step, _steps, at) => {
    if (assertsGType(step, 'MAP')) return continueLowering(s, at + 1);
    throw new Error('is() on a group value supports only is(typeOf(GType.MAP))');
  }],
  // count()/count(Scope.local) — the number of map entries (distinct keys). Scope.local on a Map
  // counts its size, the same value.
  ['count', (s, _step, _steps, at) => {
    if (s.key.kind !== 'scalar') throw new Error('count() over a non-scalar-key group not yet supported');
    const g = s.rel.as('g');
    const rel = s.q.cte(q`SELECT COUNT(DISTINCT ${g.c.gk}) AS v FROM ${g}`, ['v']);
    return continueLowering(toScalarStream(dropLayoutAtBarrier(loweringStateOf(s)), rel, 'long', { result: 'count' }), at + 1);
  }],
  ['unfold', asMapValue],
  ['select', asMapValue],
  ['order', (s, step, steps, at) => isMapLocalOrder(step) ? asMapValue(s, step, steps, at) : null],
]);

export function compileFromGroup(s: GroupStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(GROUP_DISPATCH, s, steps, at, (_s, ss, i) => {
    throw new Error(`${ss[i].name}() on a group value not yet supported`);
  });
}

/** Derive the whole-map VALUE blob of a rich group barrier: ONE JSONB `map` column per group
 * (a global group → one row; unused origins would group per-origin), holding an ordered
 * `[[keyNode, valNode], …]` pairs array. Scalar key/value sides are self-describing {t,v}
 * nodes (the uniform typed encoding, mapstream-blob-model); an element key or element-list
 * value keeps bare rowids for downstream rejoin. Shared by unfold()/select(Column)/is(MAP). */
function deriveGroupMap(s: GroupStream): { rel: Relation; keyOf: MapOf; valOf: MapOf } {
  const g = s.rel.as('g');
  let keyNode: Expression, keyOf: MapOf, groupKey: Expression;
  if (s.key.kind === 'scalar') {
    // A per-row stored vtype (gkt, from a bare values() key) is the truth channel; `as` is the
    // compile-time tag a cast left behind. typedScalarNode prefers the column when present.
    const keyPerRow = perRowColumnOf(s.key.type);
    const vtypeExpr = keyPerRow ? g.c[keyPerRow] : undefined;
    keyNode = typedScalarNode(g.c.gk, { staticType: staticTypeOf(s.key.type), vtypeExpr });
    keyOf = { kind: 'scalar' }; groupKey = g.c.gk;
  }
  else if (s.key.kind === 'element') {
    keyNode = g.c.k_rid; groupKey = g.c.k_rid;
    // ElemShape is Elem + 'property', and a property key has no rowid to rejoin on. The ternary
    // this replaces collapsed it to a vertex silently; unreachable today (no producer mints a
    // property group key) but the type permits it, so it fails closed like its value-side twin.
    if (s.key.elem === 'property') throw new Error('select(Column)/unfold() over a group of property-element keys not yet supported');
    keyOf = { kind: 'elem', elem: s.key.elem };
  } else throw new Error('select(Column)/unfold() over a composite project() group key not yet supported');
  const where = s.key.kind === 'scalar' && !s.key.productive ? q` WHERE ${g.c.gk} IS NOT NULL` : empty;

  // An element-valued group lays its values out as one framed row per member (groupBy=false),
  // carrying an internal rowid (v_rid). Per key, fold the member rowids into ONE list-of-elem
  // entry — the same list-of-elem substrate fold() produces (unfold()/framing rejoins by rowid).
  let valNode: Expression, valOf: MapOf;
  if (s.val.kind === 'elementList') {
    if (s.val.elem === 'property') throw new Error('select(Column)/unfold() over a group of property-element values not yet supported');
    const elem = s.val.elem; // narrowed to Elem by the property guard above
    valNode = q`jsonb(COALESCE(json_group_array(${g.c.v_rid}) FILTER (WHERE ${g.c.v_rid} IS NOT NULL), json('[]')))`;
    valOf = { kind: 'list', of: { kind: 'elem', elem } };
  } else if (s.val.kind === 'elementLast') {
    throw new Error('select(Column)/unfold() over a group of single-element (tail) values not yet supported');
  } else if (s.val.kind === 'count') { valNode = typedScalarNode(g.c.gv, { staticType: 'long' }); valOf = { kind: 'scalar' }; }
  else if (s.val.kind === 'sum') { valNode = typedScalarNode(g.c.gv); valOf = { kind: 'scalar' }; }
  else if (s.val.kind === 'list' || s.val.kind === 'scalarList') { valNode = q`json(${g.c.gv})`; valOf = { kind: 'list', of: { kind: 'scalar' } }; }
  else throw new Error('select(Column)/unfold() over this rich group value layout not yet supported');

  // One pair per group key. An element-list value already aggregates member rows (GROUP BY key);
  // a scalar/count/sum value is one row per key. Both fold into a single `map` blob per group.
  const pair = q`json_array(${keyNode}, ${valNode})`;
  const perKey = s.val.kind === 'elementList'
    ? s.q.cte(q`SELECT ${pair} AS pair FROM ${g}${where} GROUP BY ${groupKey}`, ['pair'])
    : s.q.cte(q`SELECT ${pair} AS pair FROM ${g}${where}`, ['pair']);
  const pk = perKey.as('pk');
  const rel = s.q.cte(q`SELECT jsonb(COALESCE(json_group_array(json(${pk.c.pair})), json('[]'))) AS map FROM ${pk}`, ['map']);
  return { rel, keyOf, valOf };
}

// ---------- properties() ----------

/** The `PROPERTY_PAYLOAD` projection for one property row, given the ALIASED property table
 *  `pr` and its owner element `n`. **The one authority on what a property row is**, and it is
 *  derived FROM `PROPERTY_PAYLOAD` rather than transcribing it, so adding a payload column is a
 *  compile error here instead of a silently-short SELECT at one of the two callers.
 *
 *  The whole vertex/edge difference is TinkerPop's VertexProperty-vs-Property split: a
 *  VertexProperty is itself an element (its own id) and carries meta-properties; an edge
 *  Property is neither, so `vpid`/`pmeta` are NULL there.
 *
 *  Two callers, deliberately: `lowerProperties` (the properties() step, keyed off a traverser)
 *  and `tinker.search` (keyed off the FTS index). They provision the ROWS differently and share
 *  the payload — which is what stops a schema change from having to land in two places. */
export function propertyPayload(elem: Elem, pr: Relation, n: Relation): Expression {
  const cols: Record<(typeof PROPERTY_PAYLOAD)[number], Expression> = {
    vpid: elem === 'edge' ? raw('NULL') : pr.c.id,
    owner: n.c.id,
    ownerLabel: labelNameFor(n, elem),
    pk: pr.c.key,
    pv: storedValueExpr(pr.c.value, pr.c.vtype),
    pvtype: pr.c.vtype,
    pmeta: elem === 'edge' ? raw('NULL') : q`json(${pr.c.meta})`,
  };
  return list(PROPERTY_PAYLOAD.map((c) => q`${cols[c]} AS ${raw(c)}`), ', ');
}

/** properties()/properties(keys) is a genuine shape transition. The property row
 * stays relational so filters and projections can consume it one step at a time. */
export function lowerProperties(st: ElementStream, step: IRStep): PropertyStream {
  const keys = step.args.filter((a): a is string => typeof a === 'string');
  const n = elemRel(st);
  const p = st.rel.as('p');
  // The property stream IS the normalized property rows — one per INSTANCE, so a multi-valued
  // vertex key yields several (an edge key is single-cardinality, one row per (edge,key)).
  const pr = propRel(st.elem);
  const keyFilter: Expression = keys.length ? q` AND ${pr.c.key} IN (${list(keys.map(value), ',')})` : empty;
  const propBody = q`SELECT ${propertyPayload(st.elem, pr, n)}${layoutProjection(st.traverserLayout, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${pr} ON ${pr.c[propOwnerCol(st.elem)]}=${n.c.id}${keyFilter}`;
  const rel = st.q.cte(propBody, [...PROPERTY_PAYLOAD, ...layoutCols(st.traverserLayout)]);
  return toPropertyStream(loweringStateOf(st), rel, st.elem);
}

/** A property framing/scalar ctx built from an (already-aliased) PropertyStream/domain
 *  relation. `idExpr` is the VertexProperty's OWN id (vpid) — its Gremlin T.id — NOT the
 *  owner; `pk` is its T.label; `pmeta` backs by(String) meta-property reads. owner/pk/pv
 *  frame the VertexProperty as a group value. (labelNameExpr resolves the OWNER's label,
 *  retained only for the element-framing helpers; a property's own T.label is pk, see
 *  buildGroupKey.)
 *
 *  The owner's label NAME rides in the payload already (`ownerLabel`, resolved for the right
 *  element kind by `propertyPayload`), so this reads it rather than re-deriving it as a vertex
 *  lookup — which was wrong for an EDGE-owned property. The two positions that cannot come off
 *  a name (ALL labels as a payload, ANY-label membership) take `ownerElem`: an edge carries
 *  exactly one label, so both reduce to that same name. */
const propertyCtx = (p: Relation, ownerElem: Elem): ScalarCtx => ({
  elem: 'property', idExpr: p.c.vpid,
  labelNameExpr: p.c.ownerLabel,
  labelPayloadExpr: ownerElem === 'edge' ? p.c.ownerLabel : vertexLabelsJson(p.c.owner),
  labelMatch: (names) => ownerElem === 'edge' ? q`${p.c.ownerLabel} IN (${values(names)})` : vertexLabelIn(p.c.owner, names),
  ownerExpr: p.c.owner, pkExpr: p.c.pk, pvExpr: p.c.pv, metaExpr: p.c.pmeta,
});

function filterProperty(s: PropertyStream, step: IRStep): PropertyStream {
  const p = s.rel.as('p');
  let test: Expression;
  if (step.name === 'has') {
    const [mk, mv] = step.args;
    if (typeof mk !== 'string') throw new Error('properties().has() requires a meta-property key');
    test = predicateSql(propExtract(p.c.pmeta, mk).expr, step.args.length > 1 ? mv : undefined);
  } else if (step.name === 'hasKey') test = predicateSql(p.c.pk, step.args[0]);
  else test = predicateSql(p.c.pv, step.args[0]);
  const rel = s.q.cte(
    q`SELECT ${list(PROPERTY_PAYLOAD.map((c) => p.c[c]), ', ')}${layoutProjection(s.traverserLayout, p)} FROM ${p} WHERE ${test}`,
    [...PROPERTY_PAYLOAD, ...layoutCols(s.traverserLayout)],
  );
  return toPropertyStream(loweringStateOf(s), rel, s.ownerElem);
}

function propertyScalar(s: PropertyStream, col: 'vpid' | 'pk' | 'pv'): ScalarStream {
  const p = s.rel.as('p');
  // value() carries the value's stored type (pvtype) as the scalar's vtype, so a downstream
  // numeric comparison/order over a TEXT-stored number (long/bigdecimal/…) can compareKey it.
  // key()/id() are plain strings/ids — no vtype needed.
  const vtag = col === 'pv' ? { type: PER_ROW('vtype') } : {};
  const vsel = col === 'pv' ? q`, ${p.c.pvtype} AS vtype` : empty;
  // In a child scope (a property-group by(__.key()/value())) the correlated cardinality
  // policy needs a per-origin encounter marker, exactly as lowerScalarProjection mints for
  // element().values(). key()/value() are 1:1 with the property, so any deterministic order
  // suffices. At root (no live origin) the projection stays unchanged.
  const origin = s.traverserLayout.origins.at(-1);
  if (!origin) {
    const rel = s.q.cte(q`SELECT ${p.c[col]} AS v${vsel}${layoutProjection(s.traverserLayout, p)} FROM ${p}`, ['v', ...(col === 'pv' ? ['vtype'] : []), ...layoutCols(s.traverserLayout)]);
    return toScalarStream(loweringStateOf(s), rel, undefined, { result: 'value', ...vtag });
  }
  const layout = patchLayout(s.traverserLayout, { encounter: 'encounter' });
  const mint = q`ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${p.c[origin]})`;
  const rel = s.q.cte(
    q`SELECT ${p.c[col]} AS v${vsel}${layoutProjectionMinting(layout, p, 'encounter', mint)} FROM ${p}`,
    ['v', ...(col === 'pv' ? ['vtype'] : []), ...layoutCols(layout)],
  );
  return toScalarStream(loweringStateOf(s, layout), rel, undefined, { result: 'value', ...vtag });
}

/** The canonical property tie-break ORDER BY terms (all ASC), qualified to `p`. A node
 * property is uniquely identified by its vpid; an edge Property has no id, so its full
 * (owner,key,type,value) tuple is the stable key. Shared by dedup (survivor selection) and
 * order (encounter tie-break) so "which row wins" is consistent across both. */
const propertyTieBreak = (p: Relation, ownerElem: 'vertex' | 'edge'): Expression[] =>
  ownerElem === 'vertex'
    ? [q`${p.c.vpid} ASC`]
    : [q`${p.c.owner} ASC`, q`${p.c.pk} ASC`, q`${p.c.pvtype} ASC`, q`${p.c.pv} ASC`];

/** Deduplicate property traversers while retaining one complete property row.
 * VertexProperty identity is its real vpid. Edge Property has no id and its equality is
 * key/value-based, so repeated edge properties with the same key and value collapse even
 * when they belong to different edges. `by(value)` deliberately changes the key to the
 * property value, matching dedup().by() on the property object. */
function propertyDedup(s: PropertyStream, step: IRStep): PropertyStream {
  if (s.traverserLayout.aliases.size > 0 || s.traverserLayout.path)
    throw new Error('properties().dedup() after as()/path() not yet supported (property-distinct semantics)');
  const bys = step.modulators ?? [];
  if (bys.length > 1) throw new Error('properties().dedup() supports at most one by() modulator');
  const by = bys[0]?.[0];
  let key: Expression;
  if (by === undefined) {
    key = s.ownerElem === 'vertex' ? q`p.vpid` : q`p.pk, p.pv`;
  } else if (by && typeof by === 'object' && 'token' in by && by.token === 'value') {
    key = q`p.pv`;
  } else {
    throw new Error('properties().dedup().by() supports only value');
  }
  const p = s.rel.as('p');
  const partition = key;
  const ranked = s.q.cte(
    q`SELECT ${list(PROPERTY_PAYLOAD.map((c) => p.c[c]), ', ')}${layoutProjection(s.traverserLayout, p)}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${list(propertyTieBreak(p, s.ownerElem), ', ')}) AS rn FROM ${p}`,
    [...PROPERTY_PAYLOAD, ...layoutCols(s.traverserLayout), 'rn'],
  );
  const r = ranked.as('r');
  const layoutSel = layoutCols(s.traverserLayout).map((c) => c === s.traverserLayout.bulk ? q`1 AS ${c}` : q`${r.c[c]}`);
  const rel = s.q.cte(
    q`SELECT ${list(PROPERTY_PAYLOAD.map((c) => r.c[c]), ', ')}${layoutSel.length ? q`, ${list(layoutSel, ', ')}` : empty} FROM ${r} WHERE ${r.c.rn}=1`,
    [...PROPERTY_PAYLOAD, ...layoutCols(s.traverserLayout)],
  );
  return toPropertyStream(loweringStateOf(s), rel, s.ownerElem);
}

/** Order a PropertyStream and retain the provider order as the shared encounter column.
 * Bare order follows Property's natural order: VertexProperty id, or edge key/value.
 * T.key/T.value select one component; a direction-only by(desc) reverses the natural
 * composite key. Stored property values use compareKey so exact long/decimal/duration
 * values sort numerically even when SQLite stores them as TEXT. */
function propertyOrder(s: PropertyStream, step: IRStep): PropertyStream {
  if (s.traverserLayout.aliases.size > 0 || s.traverserLayout.path)
    throw new Error('properties().order() after as()/path() not yet supported (property order semantics)');
  const bys = step.modulators ?? [];
  if (bys.length > 1) throw new Error('properties().order() supports at most one by() modulator');
  const by = classifyBy(bys[0]);
  const dir = by.dir;
  if (dir === 'shuffle') throw new Error('properties().order().by(shuffle) not yet supported');
  if (by.kind === 'nested') {
    const rows = tryCompileScalarValueRows(s, by.nested);
    if (!rows?.stream.traverserLayout.encounter) throw new Error('properties().order().by(traversal) requires a scalar child with encounter order');
    const c = rows.stream.rel.as('c');
    const ord = rows.frame.ordinal;
    // Carry the child value's stored type so the sort key can compareKey it — a numeric
    // property that rides as TEXT (long/bigdecimal/…) must sort numerically, exactly as the
    // token branch below does; without it a mixed-width value ("9" vs "35") sorts lexically.
    const vt = perRowColumnOf(rows.stream.type);
    const firstVal = s.q.cte(
      q`SELECT ${c.c[ord]} AS ord, ${c.c.v} AS k${vt ? q`, ${c.c[vt]} AS kt` : empty}, ROW_NUMBER() OVER (PARTITION BY ${c.c[ord]} ORDER BY ${c.c[rows.stream.traverserLayout.encounter]}) AS rn FROM ${c}`,
      ['ord', 'k', ...(vt ? ['kt'] : []), 'rn'],
    );
    const d = rows.frame.domain.as('d');
    const f = firstVal.as('f');
    const layout = patchLayout(s.traverserLayout, { encounter: 'encounter' });
    const cmpVal = vt ? q`(${compareKey(f.c.k, f.c.kt)})` : q`${f.c.k}`;
    const sortKey = dir === 'desc' ? q`${cmpVal} DESC` : q`${cmpVal} ASC`;
    const orderKey = list([sortKey, ...propertyTieBreak(d, s.ownerElem)], ', ');
    const mint = q`ROW_NUMBER() OVER (${partitionOver(layout, d, orderKey)})`;
    const rel = s.q.cte(
      q`SELECT ${list(PROPERTY_PAYLOAD.map((col) => d.c[col]), ', ')}${layoutProjectionMinting(layout, d, 'encounter', mint)} FROM ${d} LEFT JOIN ${f} ON ${f.c.ord}=${d.c[ord]} AND ${f.c.rn}=1`,
      [...PROPERTY_PAYLOAD, ...layoutCols(layout)],
    );
    return toPropertyStream(loweringStateOf(s, layout), rel, s.ownerElem);
  }
  if (by.kind === 'token' && by.token !== 'key' && by.token !== 'value')
    throw new Error(`properties().order().by(T.${by.token}) not yet supported`);
  if (by.kind === 'key') throw new Error('properties().order().by(key) not yet supported');
  const token = by.kind === 'token' ? by.token : undefined;
  const suffix = dir === 'desc' ? ' DESC' : ' ASC';
  const p = s.rel.as('p');
  const valueKey = q`(${compareKey(p.c.pv, p.c.pvtype)})`;
  const primary = token === 'key'
    ? [q`${p.c.pk}${suffix}`]
    : token === 'value'
      ? [q`${valueKey}${suffix}`]
      : s.ownerElem === 'vertex'
        ? [q`${p.c.vpid}${suffix}`]
        : [q`${p.c.pk}${suffix}`, q`${valueKey}${suffix}`];
  const orderKey = list([...primary, ...propertyTieBreak(p, s.ownerElem)], ', ');
  const layout = patchLayout(s.traverserLayout, { encounter: 'encounter' });
  const mint = q`ROW_NUMBER() OVER (${partitionOver(layout, p, orderKey)})`;
  const rel = s.q.cte(
    q`SELECT ${list(PROPERTY_PAYLOAD.map((c) => p.c[c]), ', ')}${layoutProjectionMinting(layout, p, 'encounter', mint)} FROM ${p}`,
    [...PROPERTY_PAYLOAD, ...layoutCols(layout)],
  );
  return toPropertyStream(loweringStateOf(s, layout), rel, s.ownerElem);
}

/** Consume a PropertyStream. Only property-specific operations live here; once a
 * step changes shape it re-enters the same root dispatcher as every other stream. */
const PROPERTY_SCALAR_COL = { key: 'pk', value: 'pv', id: 'vpid' } as const;

const propertyFilter: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(filterProperty(s, step), at + 1);

const propertyScalarStep: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(propertyScalar(s, PROPERTY_SCALAR_COL[step.name as keyof typeof PROPERTY_SCALAR_COL]), at + 1);

const propertyDedupStep: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(propertyDedup(s, step), at + 1);

const propertyOrderStep: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(propertyOrder(s, step), at + 1);

const propertyGroup: ShapeTailFn<PropertyStream> = (s, step, _steps, at) => {
  // A live property parent — its by() sub-traversals lower through the generic child
  // seam (tryLowerGroupChildSource), exactly as an element group does.
  const p = s.rel.as('p');
  const src: GroupSource = { from: p, ctx: propertyCtx(p, s.ownerElem), elem: 'property', parent: s, productiveBy: step.productiveBy, bulk: s.traverserLayout.bulk ? p.c[s.traverserLayout.bulk] : undefined };
  const isCount = step.name === 'groupCount';
  return continueLowering(lowerGroup(s, isCount, step.modulators ?? [], src), at + 1);
};

const propertyValueMap: ShapeTailFn<PropertyStream> = (s, _step, steps, at) => {
  if (at + 1 < steps.length) throw new Error(`step not implemented after properties().valueMap(): ${steps[at + 1].name}()`);
  const p = s.rel.as('p');
  return continueLowering(toResultStream(s.q, q`SELECT ${p.c.pmeta} AS meta FROM ${p}`, { kind: 'metaMap' }), at + 1);
};

const propertyMetaProperties: ShapeTailFn<PropertyStream> = (s, step, steps, at) => {
  if (at + 1 < steps.length) throw new Error(`step not implemented after properties().properties(): ${steps[at + 1].name}()`);
  const mkeys = step.args.filter((a): a is string => typeof a === 'string');
  const mkeyFilter = mkeys.length ? q` WHERE je.key IN (${list(mkeys.map(value), ',')})` : empty;
  const p = s.rel.as('p');
  return continueLowering(toResultStream(s.q, q`SELECT je.key AS mk, je.value AS mv FROM ${p}, json_each(COALESCE(${p.c.pmeta}, '{}')) je${mkeyFilter}`, { kind: 'metaProperty' }), at + 1);
};

const propertyElement: ShapeTailFn<PropertyStream> = (s, _step, _steps, at) => {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT ${p.c.owner} AS id${layoutProjection(s.traverserLayout, p)} FROM ${p}`,
    ['id', ...layoutCols(s.traverserLayout)],
  );
  const out: ElementStream = toElementStream(loweringStateOf(s), rel, s.ownerElem);
  return continueLowering(out, at + 1);
};

const PROPERTY_DISPATCH = new Map<string, ShapeTailFn<PropertyStream>>([
  ['has', propertyFilter], ['hasKey', propertyFilter], ['hasValue', propertyFilter],
  // One row per Property/VertexProperty instance. `dedup` is NOT taken from the shared set: the
  // property arm has its own, which collapses on the property payload rather than the whole row.
  ...globalRowOps<PropertyStream>().filter(([name]) => name !== 'dedup'),
  ['dedup', propertyDedupStep],
  ['order', propertyOrderStep],
  ['key', propertyScalarStep], ['value', propertyScalarStep], ['id', propertyScalarStep],
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['group', propertyGroup], ['groupCount', propertyGroup],
  ['valueMap', propertyValueMap],
  ['properties', propertyMetaProperties],
  ['element', propertyElement],
]);

export function compileFromProperty(s: PropertyStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(PROPERTY_DISPATCH, s, steps, at, () => {
    throw new Error(`step not implemented after properties(): ${steps[at].name}()`);
  });
}
