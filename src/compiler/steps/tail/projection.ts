import { isColumnArg, isNested, isOrderArg, isTokenArg } from '../../../gremlin/frontend.ts';
import { empty, list, q, raw, Relation, value, type Expression } from '../../../sql/kernel/q.ts';
import { PER_ROW, STATIC, staticTypeOf, UNKNOWN, type Shape } from '../../../sql/kernel/render.ts';
import { edgeProperties, labels, vertexLabels, vertexProperties } from '../../../sql/schema.ts';
import { engineOf } from '../../engine/deps.ts';
import { type IRStep } from '../../ir/strategies.ts';
import {
    elemCtx,
    elementPayload,
    jsonbGroupArray,
    labelNameFor, labelTokenFor,
    limitOffset,
    predicateSql,
    propSortKeyFor,
    scalarPropSortKey,
    storedValueExpr,
    valueMapProps, tokenExpr
} from '../../plan/plan.ts';
import { appendCte, dropLayoutAtBarrier, elemRel, layoutCols, layoutProjection, layoutProjectionMinting, partitionOver, patchLayout, type ElementStream } from '../context/context.ts';
import { continueLowering, dispatchShapeTail, loweringStateOf, toElementStream, toListStream, toResultStream, toScalarStream, toVariantStream, type ListStream, type LoweringResult, type ResultStream, type ScalarStream, type ShapeTailFn, type Stream } from '../context/stream.ts';
import { lowerReSource } from '../graph-source.ts';
import { choose as lowerElementChoose, coalesce as lowerElementCoalesce, flatMap as lowerElementFlatMap, union as lowerElementUnion, tryLowerListChoose, tryLowerListCoalesce, tryLowerListUnion, tryLowerOptionMapBranch, tryLowerScalarChoose, tryLowerScalarCoalesce, tryLowerScalarUnion, tryLowerVariantChoose, tryLowerVariantCoalesce, tryLowerVariantOptional, tryLowerVariantUnion } from '../prefix/branch.ts';
import { lowerElementDedup } from '../prefix/filter.ts';
import { lowerScalarAggregate, tryLowerLocalAggregate } from '../prefix/sideeffect.ts';
import { lowerGlobalCount, lowerGlobalFold, lowerGlobalNumericReducer, type NumericReducer } from './barrier.ts';
import { isLocalScope, NUMERIC_REDUCERS, sliceOf } from '../../ir/step.ts';
import { lowerCall } from './call.ts';
import { assertsGType, BRANCH_SHAPE_ORDER, childCtx, childSteps, classifyBy, collectionAssert, classifyListChild, classifyTotalScalarChild, isScalarChild, ROOT_SCOPE, type BranchKind, type ByClass } from './child-shape.ts';
import { mintChildEncounter, tryCompileBranchChildAllCard, tryCompileCountChild, tryCompileListChild, tryCompileScalarModulations, type ScalarModulationSpec } from './child.ts';
import { elementGroupSource, lowerGroup, lowerProperties, lowerScalarGroupCount, lowerValueMap, tryCompileMapChild } from './group.ts';
import { lowerChooseOptions, lowerChooseOptionsScalar, lowerConcatScalar, lowerDateDiffScalar, lowerFormat, lowerFormatScalar, lowerMapScalar, lowerMath, lowerMathScalar, tryLowerFlatMap, tryLowerListChild, tryLowerLocalElement, tryLowerMapElement } from './mapscalar.ts';
import { elementOrderDrop, orderProductivityFilter } from './modulation.ts';
import { lowerPath } from './path.ts';
import { tryScalarChooseChild, tryScalarCoalesceChild, tryScalarFilterByChildExistence, tryScalarMapChild, tryScalarOptionalChild, tryScalarUnionChild, tryScalarVariantChoose, tryScalarVariantCoalesce, tryScalarVariantOptional, tryScalarVariantUnion } from './scalar-arm.ts';
import { lowerConstant, lowerScalarConstant, lowerScalarFilter, lowerScalarSack, lowerScalarSplit, scalarCollectionRetype, scalarMapRetype } from './scalar.ts';
import { compileSelectProject, lowerRecordSelectProject, lowerScalarProject, lowerSingleSelect, tryCompileRecordChild } from './select.ts';

// ---------- tail: projection + barriers + modifiers ----------
//
// After the prefix fold lands the id-relation, the tail applies an optional
// projection (values/id/label/…/select/project) plus order()/range()/limit() and
// terminal reducers. group()/groupCount()/properties() are barriers that consume
// the whole stream into one shape, so they short-circuit before the generic tail.

interface OrderClause { key: string | null; token?: string; dir: 'asc' | 'desc' | 'shuffle'; }

/** The tail modifiers accumulated left-to-right (a pure fold — no sibling peeking;
 *  by() modulators already live on their host step via strategies.absorbModulators). */
export interface TailAcc {
  projStep: IRStep | null;
  orders: OrderClause[];
  offset: number;
  limit: number | null;
  distinct: boolean;
  /** Did a ProductiveByStrategy-marked order() contribute these clauses? Drives the non-productive
   *  by(key) drop below (TinkerPop's DEFAULT is to DROP a traverser the modulator yields nothing
   *  for; the strategy opts into keeping it with a null). */
  productiveBy: boolean;
  reducer: 'fold' | 'sum' | 'min' | 'max' | 'mean' | null; // terminal element reducer (fold→List / count guard)
  isPreds: any[];                  // is(P) after count() (count().is(P))
}

/** A TailAcc with no modifiers — the bare scalar projection case (no preceding
 *  order/limit/dedup) routes through lowerScalarProjection with this. */
const EMPTY_TAIL_ACC: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, productiveBy: false, reducer: null, isPreds: [] };

/** This traversal's label regime, resolved once per compile on the Engine. */
const regime = (st: ElementStream) => engineOf(st).labelRegime;

const PROJECTION_NAMES = new Set(['values', 'id', 'label', 'labels', 'count', 'valueMap', 'elementMap', 'select', 'project', 'path']);
// Scalar-producing projections: one `v` value per row. foldTailAcc stops at one of these
// so the whole value tail (transforms/is/reducers/inject + framing) routes through the
// scalar pipeline (lowerScalarProjection → scalar.ts/barrier.ts), never this accumulator.
const SCALAR_PROJ = new Set(['values', 'id', 'label', 'labels']);
const isMapProj = (p: IRStep | null) => p?.name === 'select' || p?.name === 'project';
const isScopeLocalStep = (s: IRStep | undefined): boolean => !!s && isLocalScope(s);

/** A tail modifier: fold the step into the accumulator. `at` gives position so a
 *  terminal reducer (fold/sum) can reject anything following it. */
type ModFn = (s: IRStep, acc: TailAcc, at: { last: boolean; next?: string }) => void;

/** A re-enterable non-scalar projection (path/valueMap/elementMap) folds only these as
 *  its OWN tail modifiers; any other following step is a shape boundary routed to its
 *  compileFrom* arm. order() is deliberately absent — it defers. */
const REENTER_MODIFIERS = new Set(['dedup', 'limit', 'range', 'skip']);
const REENTERABLE_PROJ = new Set(['path', 'valueMap', 'elementMap']);

const MODIFIERS = new Map<string, ModFn>([
  ['order', (s, acc) => {
    // Each folded by() → one order clause; a bare order() sorts by identity.
    if ((s as any).productiveBy) acc.productiveBy = true;
    const bys = s.modulators ?? [];
    if (bys.length === 0) { acc.orders.push({ key: null, dir: 'asc' }); return; }
    for (const byArgs of bys) {
      // A traversal term is a different machine (lowerElementOrderByTraversal); reject it here
      // rather than let it fall through to key=null and silently sort by id. A `T` token is NOT
      // rejected any more — it is carried to `tailOrderTerm`, which resolves it through the one
      // token authority, so `order().by(T.label)` composes at this position like `by(key)`.
      const nestedArg = byArgs.find(isNested);
      if (nestedArg) throw new Error('by(traversal) modulator not yet supported');
      const token = byArgs.find(isTokenArg);
      const key = byArgs.find((a: any) => typeof a === 'string') ?? null;
      const ord = byArgs.find(isOrderArg);
      acc.orders.push({ key, token: token?.token, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
    }
  }],
  // The three slices share ONE decode (`sliceOf`), which is also what keeps the Scope.local token
  // out of the numbers. `acc.limit` stays `null` for "no LIMIT clause at all" — a distinct state
  // from `sliceOf`'s `null` ("no upper bound"), which only `range`/`skip` can produce and which
  // this accumulator has always rendered as `LIMIT -1`.
  ['range', (s, acc) => { const sl = sliceOf(s); acc.offset = sl.offset; acc.limit = sl.limit; }],
  ['skip', (s, acc) => { acc.offset = sliceOf(s).offset; }],
  ['limit', (s, acc) => { acc.limit = sliceOf(s).limit; }],
  ['dedup', (_s, acc) => { acc.distinct = true; }],
  ['is', (s, acc) => {
    // is() folds into the projection WHERE (before ORDER BY/LIMIT). Only correct
    // if no limit/range/skip preceded it — filtering commutes with order() but NOT
    // with a limit that already truncated the stream.
    if (acc.limit !== null || acc.offset > 0) throw new Error('is() after limit()/range()/skip() not yet supported');
    acc.isPreds.push(s.args[0]);
  }],
  ['fold', reducerMod('fold')],
  ['sum', reducerMod('sum')],
  ['min', reducerMod('min')],
  ['max', reducerMod('max')],
  ['mean', reducerMod('mean')],
  ['by', () => { throw new Error('by() is only supported as an order() or select()/project() modulator'); }],
]);

// The steps the value-tail accumulator (foldTailAcc) folds without a throw: every projection
// plus every value modifier, plus the unfold retype boundary. A plain order() FOLLOWED by a step
// OUTSIDE this set is not a value tail at all — it is an ordered element stream re-entering a
// movement/branch/re-source (item 5b), so tailOrder mints an encounter and re-enters rather than
// letting foldTailAcc throw `step not implemented`. Derived from the two vocabularies so it cannot
// drift from what foldTailAcc actually accepts.
const VALUE_TAIL_STEPS = new Set<string>([...PROJECTION_NAMES, ...MODIFIERS.keys(), 'unfold']);

function reducerMod(name: NonNullable<TailAcc['reducer']>): ModFn {
  return (_s, acc, at) => {
    // Scope.local (a per-list reduction) always arrives after fold()/aggregate()
    // in the suite, so the reducer-after-reducer / step-after-reducer guards below
    // already defer it — no separate Scope handling needed here.
    if (acc.reducer) throw new Error(`${name}() after ${acc.reducer}() not yet supported`);
    if (!at.last) throw new Error(`step not implemented after ${name}(): ${at.next}()`);
    acc.reducer = name;
  };
}

/** Fold the tail steps from `from` into a TailAcc: one optional projection step,
 *  scalar transforms, inject-appends, and the value-shape modifiers (MODIFIERS).
 *  Shared by compileTail (element-rooted) and compileInject (scalar-stream-rooted)
 *  so both consume one modifier vocabulary — add a value-tail step once, here. */
export function foldTailAcc(steps: IRStep[], from: number): { acc: TailAcc; stop: number } {
  const acc: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, productiveBy: false, reducer: null, isPreds: [] };
  let i = from;
  for (; i < steps.length; i++) {
    const s = steps[i];
    // Retype boundaries — the tail cannot fold past these; the caller builds the next
    // Stream (stream.ts) and yields back to lowerSteps (index.ts):
    //  · unfold — a list value → its element/scalar stream.
    //  · a NON-terminal fold — the stream → one list value (set-ops sit here later).
    //    A TERMINAL fold (last step) stays the current reducer below, unchanged.
    if (s.name === 'unfold') break;
    if (s.name === 'fold' && i !== steps.length - 1) break;
    // Scope.local on this ELEMENT tail (scalar tails run through lowerScalarRows): a
    // per-element reduce over a global element stream. sum/min/max/order/dedup(local) are
    // identity; anything else has no worked-out element form → fail closed.
    if ((s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local')) {
      if (s.name === 'sum' || s.name === 'min' || s.name === 'max' || s.name === 'order' || s.name === 'dedup') continue; // identity
      throw new Error(`${s.name}(Scope.local) requires a preceding list-producing step (e.g. fold())`);
    }
    // A re-enterable projection (path/valueMap/elementMap) consumes only its own tail
    // modifiers (dedup/limit/range/skip); any other following step (count/is/select/…) is
    // a shape boundary, so stop and let its compileFrom* arm handle it.
    if (acc.projStep && REENTERABLE_PROJ.has(acc.projStep.name) && !REENTER_MODIFIERS.has(s.name)) break;
    if (PROJECTION_NAMES.has(s.name)) {
      if (acc.projStep) break;
      acc.projStep = s;
      // A scalar projection (values/id/label) is a stream boundary: stop right after it
      // so the whole value tail routes through the scalar pipeline (lowerScalarProjection),
      // not this accumulator. Non-scalar projections (valueMap/elementMap/select/project/
      // path/count) stay terminal on buildProjection.
      if (SCALAR_PROJ.has(s.name)) { i++; break; }
      continue;
    }
    const mod = MODIFIERS.get(s.name);
    if (!mod) throw new Error(`step not implemented: ${s.name}()`);
    mod(s, acc, { last: i === steps.length - 1, next: steps[i + 1]?.name });
  }
  return { acc, stop: i };
}

/** is(typeOf(GType.MAP)) — the identity type-assert on a valueMap/map result. */
const isMapTypeOf = (step: IRStep): boolean => assertsGType(step, 'MAP');

const hasColumnArg = (step: IRStep): boolean =>
  (step.args ?? []).some((a: unknown) => isColumnArg(a) && (a.column === 'keys' || a.column === 'values'));

/** valueMap()/elementMap() followers. is(typeOf(MAP)) is identity (skip); count() counts
 *  the maps (one per element → count of elements); select(Column.*) re-types to the
 *  per-element MapStream that compileFromMap aggregates. Modifiers before the follower,
 *  and any other follower, defer. */
function lowerValueMapTail(st: ElementStream, proj: IRStep, acc: TailAcc, steps: IRStep[], at: number): LoweringResult {
  if (acc.orders.length || acc.reducer || acc.distinct || acc.offset || acc.limit !== null)
    throw new Error(`a modifier before a re-entered ${proj.name}() is not yet supported`);
  let i = at;
  while (i < steps.length && isMapTypeOf(steps[i])) i++; // is(typeOf(MAP)) = identity
  if (i >= steps.length) return continueLowering(buildProjection(st, acc), i); // terminal after identity is()
  const step = steps[i];
  if (step.name === 'count' && !isScopeLocalStep(step))
    return continueLowering(lowerGlobalCount(st), i + 1);
  // unfold() and select(Column.*) both consume valueMap AS a map value: retype to the
  // per-element whole-map MapStream and re-enter at the SAME step, which compileFromMap
  // then unfolds (→ Map.Entry stream) or aggregates (→ list value).
  if (step.name === 'unfold' || (step.name === 'select' && hasColumnArg(step)))
    return continueLowering(lowerValueMap(st, proj), i);
  // select(label)/select(Pop, label): a valueMap has no as()-label of its own, so an
  // UNBOUND label selects nothing → empty (TinkerPop). A label bound earlier by as()
  // would need the map to carry path history — defer that.
  if (step.name === 'select') {
    const labels = (step.args ?? []).filter((a: any) => typeof a === 'string') as string[];
    if (labels.length && labels.every((l) => !st.traverserLayout.aliases.has(l))) {
      const rel = st.q.cte(q`SELECT NULL AS v WHERE 0`, ['v']);
      return continueLowering(toScalarStream(dropLayoutAtBarrier(loweringStateOf(st)), rel, undefined), i + 1);
    }
    throw new Error('select(bound-label) after valueMap() not yet supported');
  }
  throw new Error(`${step.name}() cannot consume the ${proj.name} result shape`);
}

/** order() with AT LEAST ONE by(__.trav) term: sort elements by a composite key whose
 *  traversal terms are per-traverser scalars computed through the SAME generic scalar child
 *  seam dedup().by(traversal) uses (tryCompileScalarValueRows + pushChildScope) — NOT a
 *  bespoke reader. Each traversal term contributes a LEFT JOIN of its first-value-per-traverser
 *  column; each key/token term reads directly off the element table; the terms combine into one
 *  ORDER BY (round-robin over the bys, matching every other by()-host). A fresh encounter
 *  (ROW_NUMBER over the composite key) rides forward, so materialization / a following limit
 *  observe the order. Returns null when NO term is a traversal (the acc.orders key machinery
 *  handles the all-direct case) or a term is shuffle; throws for path/encounter-tracking
 *  streams (a fresh encounter would collide) and unsupported child shapes. */
function lowerElementOrderByTraversal(st: ElementStream, step: IRStep): ElementStream | null {
  const bys = step.modulators ?? [];
  if (!bys.length) return null;
  const classes = bys.map(classifyBy);
  if (!classes.some((c) => c.kind === 'nested')) return null; // all-direct → acc.orders machinery
  if (classes.some((c) => c.dir === 'shuffle')) return null;   // shuffle has no composite meaning
  if (st.traverserLayout.encounter || st.traverserLayout.path)
    throw new Error('order().by(traversal) while tracking a path/encounter not yet supported');

  // Compile ALL traversal terms against ONE shared parent domain through the proven
  // multi-modulator seam (tryCompileScalarModulations — the same substrate math()/format()/
  // choose() use): one pushed scope, each child reuses the frame, and the returned domain rel
  // exposes an `m{i}` value column per traversal term already joined back per traverser. Its
  // `id` column rejoins the element table for the direct (key/token/bare) terms. Optional
  // modulation (a non-productive traversal term → NULL) sorts NULLs first, matching TinkerPop's
  // "an element with no such value sorts before ones that have it" for a comparator key.
  const travSpecs = classes.flatMap((by): ScalarModulationSpec[] =>
    by.kind === 'nested' ? [{ nested: by.nested, contract: 'presence' }] : []);
  const mods = tryCompileScalarModulations(st, travSpecs);
  if (!mods) throw new Error('order().by(traversal) child shape not yet supported by generic child lowering');
  const d = mods.rel.as('d');
  const n = elemRel(st);
  let travIdx = 0;
  const orderExprs = classes.map((by: ByClass): Expression =>
    by.kind === 'nested'
      ? q`${d.c[mods.values[travIdx++].value]}${by.dir === 'desc' ? q` DESC` : q` ASC`}`
      : directOrderExpr(by, n, st));
  const orderKey = list([...orderExprs, q`${d.c.id}`], ', ');
  return appendCte(
    st,
    q`SELECT ${d.c.id} AS id${layoutProjection(st.traverserLayout, d)}, ROW_NUMBER() OVER (ORDER BY ${orderKey}) AS encounter FROM ${d} JOIN ${n} ON ${n.c.id}=${d.c.id}`,
    { encounter: 'encounter' },
  );
}

/** The ORDER BY term for a DIRECT (key/token/bare) by() over the current element (aliased `n`).
 *  The one place a direct order key is built — shared by lowerElementOrderByTraversal's non-nested
 *  terms and lowerElementOrderReenter, so the composite-key math stays identical across the two. */
function directOrderExpr(by: ByClass, n: Relation, st: ElementStream): Expression {
  const dirSql = by.dir === 'desc' ? q` DESC` : q` ASC`;
  if (by.kind === 'token') {
    const expr = tokenExpr(elemCtx(n, st.elem), by.token);
    if (!expr) throw new Error(`order().by(T.${by.token}) not yet supported`);
    return q`${expr}${dirSql}`;
  }
  if (by.kind === 'key') return q`${scalarPropSortKey(elemCtx(n, st.elem), by.key)}${dirSql}`;
  return q`${n.c.id}${dirSql}`; // bare by()
}

/** A plain (key/token/bare) order() FOLLOWED by a step that moves/branches/re-sources the element
 *  stream — a step OUTSIDE the value-tail vocabulary the acc machinery folds (VALUE_TAIL_STEPS).
 *  order() is a barrier: it re-establishes a total order, and that order must survive the follower.
 *  So retype back to an ElementStream (an ordered element stream is still elements — item 5b's
 *  TailAcc→ElementStream boundary) by minting a fresh emission `encounter` (ROW_NUMBER over the
 *  composite order key). The mint SUPERSEDES any encounter seeded by the demand pass, in its
 *  declared carried slot (layoutProjectionMinting), so a downstream limit/branch observes THIS order. The
 *  same encounter substrate then threads through movement (finishMove) and the branch merges. The
 *  caller re-enters generic lowering; final materialization sorts by the carried encounter.
 *  Returns null for a shuffle order (no stable re-mint) or a traversal term (that is
 *  lowerElementOrderByTraversal's job); defers a live path (a fresh encounter would collide with
 *  the path's positional ordering). */
function lowerElementOrderReenter(st: ElementStream, step: IRStep): ElementStream | null {
  const bys = step.modulators ?? [];
  const classes: ByClass[] = bys.length ? bys.map(classifyBy) : [{ kind: 'none' }];
  if (classes.some((c) => c.kind === 'nested')) return null; // → lowerElementOrderByTraversal
  if (classes.some((c) => c.dir === 'shuffle')) return null;  // shuffle has no stable encounter
  if (st.traverserLayout.path)
    throw new Error('order() before a movement/branch while tracking a path not yet supported');
  const n = elemRel(st);
  const p = st.rel.as('p');
  const orderKey = list([...classes.map((by) => directOrderExpr(by, n, st)), q`${p.c.id}`], ', ');
  const layout = patchLayout(st.traverserLayout, { encounter: 'encounter' });
  const mint = q`ROW_NUMBER() OVER (${partitionOver(layout, p, orderKey)})`;
  // Same non-productive by(key) drop as the acc projection, same policy function — this is the
  // order()-followed-by-a-movement route, so it needs it independently but must not restate it.
  const drop = elementOrderDrop(st, n, step);
  const body = q`SELECT ${p.c.id} AS id${layoutProjectionMinting(layout, p, 'encounter', mint)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}${drop ? q` WHERE ${drop}` : empty}`;
  return toElementStream(loweringStateOf(st, layout), st.q.cte(body, ['id', ...layoutCols(layout)]), st.elem);
}

// order().[barrier()].dedup().by(): lower both observations as one window policy so the
// representative is chosen by explicit encounter order. order().by(traversal) sorts via the
// generic scalar child seam. A plain key/bare order() (no dedup follower) returns null → the
// foldTailAcc fallback accumulates it.
const tailOrder: ShapeTailFn<ElementStream> = (st, step, steps, stop) => {
  const dedupAt = steps[stop + 1]?.name === 'barrier' ? stop + 2 : stop + 1;
  if (steps[dedupAt]?.name === 'dedup')
    return continueLowering(lowerElementDedup(st, steps[dedupAt], step), dedupAt + 1);
  const ordered = lowerElementOrderByTraversal(st, step);
  if (ordered) return continueLowering(ordered, stop + 1);
  // A plain order() whose FOLLOWER is a movement/branch/re-source (not a value-tail step the
  // acc machinery folds) retypes to an ordered element stream and re-enters — otherwise
  // foldTailAcc would throw `step not implemented` on that follower (item 5b).
  const next = steps[stop + 1];
  if (next && !VALUE_TAIL_STEPS.has(next.name)) {
    const reentered = lowerElementOrderReenter(st, step);
    if (reentered) return continueLowering(reentered, stop + 1);
  }
  return null;
};

// A direct global count is a stream transition even when terminal. Forms with preceding
// tail modifiers (order().limit().count()) fall to foldTailAcc (return null) until those
// operators migrate to stepwise lowering.
const tailCount: ShapeTailFn<ElementStream> = (st, step, _steps, stop) =>
  isScopeLocalStep(step) ? null : continueLowering(lowerGlobalCount(st), stop + 1);

// map(__.<scalar>) → a per-traverser scalar projection (out-degree, a property, a label).
// map(__.<scalar>) and a scalar-reduction local(__.<…count/sum/…>) are the same per-element
// scalar projector (local's element+barrier body compiles as a prefix step; only its
// scalar-reduction body reaches the tail here). Element-body map / select/fold bodies defer.
const tailMap: ShapeTailFn<ElementStream> = (st, step, steps, stop) => {
  const element = tryLowerMapElement(st, step);
  if (element) return continueLowering(element, stop + 1);
  const list = tryLowerListChild(st, step);
  if (list) return continueLowering(list, stop + 1);
  // map(__.valueMap()) / map(__.project(…)) — the body's FIRST value per parent (both are total,
  // so first == the one).
  const mapChild = tryCompileMapChild(st, step.args[0]?.nested, 'first');
  if (mapChild) return continueLowering(mapChild, stop + 1);
  const recordChild = tryCompileRecordChild(st, step.args[0]?.nested, 'first');
  if (recordChild) return continueLowering(recordChild, stop + 1);
  return continueLowering(lowerMapScalar(st, steps, stop), stop + 1);
};

const tailLocal: ShapeTailFn<ElementStream> = (st, step, steps, stop) => {
  const sideEffect = tryLowerLocalAggregate(st, step);
  if (sideEffect) return continueLowering(sideEffect, stop + 1);
  const list = tryLowerListChild(st, step);
  if (list) return continueLowering(list, stop + 1);
  const element = tryLowerLocalElement(st, step);
  if (element) return continueLowering(element, stop + 1);
  const nested = step.args[0]?.nested;
  if (nested && isScalarChild(nested, childCtx(st)))
    return continueLowering(lowerMapScalar(st, steps, stop), stop + 1);
  // A bare list-armed (union(out().fold(), in().fold())) or mixed-shape (union(out(), values('name')))
  // branch — local emits every arm's rows per input (all-cardinality).
  const branchAllCard = tryCompileBranchChildAllCard(st, nested);
  if (branchAllCard) return continueLowering(branchAllCard, stop + 1);
  // The NON-ELEMENT child shapes — a map body (`local(__.valueMap())`) or a record body
  // (`local(__.project("a").by("name"))`). Each is one row per parent, so `all` is already one
  // each. Both go through the same classify + shared cardinality rejoin as their siblings.
  const mapChild = tryCompileMapChild(st, nested, 'all');
  if (mapChild) return continueLowering(mapChild, stop + 1);
  const recordChild = tryCompileRecordChild(st, nested, 'all');
  if (recordChild) return continueLowering(recordChild, stop + 1);
  throw new Error('local() child shape not yet supported by generic child lowering');
};

// flatMap consumes ALL productive rows from the same generic child compiler used by
// map(first). It lives at the shape-aware dispatcher rather than PREFIX because a scalar
// child changes ElementStream → ScalarStream.
const tailFlatMap: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const generic = tryLowerFlatMap(st, step);
  if (generic) return continueLowering(generic, stop + 1);
  const mapChild = tryCompileMapChild(st, step.args[0]?.nested, 'all');
  if (mapChild) return continueLowering(mapChild, stop + 1);
  const recordChild = tryCompileRecordChild(st, step.args[0]?.nested, 'all');
  if (recordChild) return continueLowering(recordChild, stop + 1);
  return continueLowering(lowerElementFlatMap(step, st), stop + 1);
};

// A fold/count child is total per parent, so optional's identity-on-miss arm is statically
// unreachable. Non-total scalar children lower to the tagged scalar-or-original-element
// VariantStream. No match → null (the fallback foldTailAcc handles a plain element optional).
const tailOptional: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const nested = step.args[0]?.nested;
  const listPlan = classifyListChild(nested, childCtx(st));
  if (listPlan) {
    const lowered = tryCompileListChild(st, nested, ROOT_SCOPE, listPlan);
    if (lowered) return continueLowering(lowered, stop + 1);
  }
  const countPlan = classifyTotalScalarChild(nested, childCtx(st));
  if (countPlan) {
    const lowered = tryCompileCountChild(st, nested, ROOT_SCOPE, countPlan.body);
    if (lowered) return continueLowering(lowered, stop + 1);
  }
  const variant = tryLowerVariantOptional(step, st);
  return variant ? continueLowering(variant, stop + 1) : null;
};

// A union/choose/coalesce may change shape when its arms are scalar/list/mixed. The per-shape
// lowerers are registered here, ONE row per branch kind, and tried in BRANCH_SHAPE_ORDER
// (child-shape.ts) — the canonical fall-through sequence, declared once there rather than restated
// as three hand-written cascades. Each try* returns null to fall through; the ELEMENT lowerer is
// last and unconditional. That element lowerer is NOT legacy — it is the homogeneous-element
// compiler AND the fail-closed backstop, reached both from the PREFIX map (engine.ts, the hot
// path, when classifyBranchArms says every arm is an element) and here as the final fallback, and
// it is the only one that throws.
interface BranchLowerers {
  readonly list: (step: IRStep, st: ElementStream) => Stream | null;
  readonly scalar: (step: IRStep, st: ElementStream) => Stream | null;
  readonly variant: (step: IRStep, st: ElementStream) => Stream | null;
  readonly element: (step: IRStep, st: ElementStream) => Stream;
}

const BRANCH_LOWERERS = new Map<BranchKind, BranchLowerers>([
  ['union', { list: tryLowerListUnion, scalar: tryLowerScalarUnion, variant: tryLowerVariantUnion, element: lowerElementUnion }],
  ['choose', { list: tryLowerListChoose, scalar: tryLowerScalarChoose, variant: tryLowerVariantChoose, element: lowerElementChoose }],
  ['coalesce', { list: tryLowerListCoalesce, scalar: tryLowerScalarCoalesce, variant: tryLowerVariantCoalesce, element: lowerElementCoalesce }],
]);

/** Try each shape in BRANCH_SHAPE_ORDER; the element lowerer terminates the cascade. */
function lowerBranchByShape(kind: BranchKind, st: ElementStream, step: IRStep): Stream {
  const l = BRANCH_LOWERERS.get(kind)!;
  for (const shape of BRANCH_SHAPE_ORDER) {
    if (shape === 'element') return l.element(step, st);
    const lowered = l[shape](step, st);
    if (lowered) return lowered;
  }
  return l.element(step, st); // unreachable (BRANCH_SHAPE_ORDER ends in 'element')
}

const tailUnion: ShapeTailFn<ElementStream> = (st, step, _steps, stop) =>
  continueLowering(lowerBranchByShape('union', st, step), stop + 1);

// choose(): the option-map form (choose().option()…) is an ARM MERGE whose selection is an N-way
// lookup on a choice scalar. When every option body yields ONE scalar per input, that merge
// collapses to a single CASE over a correlated choice — lowerChooseOptions, tried first because it
// is one CTE with no per-arm gating. It DECLINES (null) for an element/list body or the
// no-Pick.none pass-through, and tryLowerOptionMapBranch then routes the arms through the ordinary
// triage + merge family. The predicate form takes the shape cascade.
const tailChoose: ShapeTailFn<ElementStream> = (st, step, steps, stop) => {
  if (!step.optionArms) return continueLowering(lowerBranchByShape('choose', st, step), stop + 1);
  const lowered = lowerChooseOptions(st, steps, stop) ?? tryLowerOptionMapBranch(st, step);
  if (!lowered) throw new Error('choose().option() not yet supported by generic lowering (an option body outside the element/scalar/list arm shapes, or a choice the correlated seam cannot compile)');
  return continueLowering(lowered, stop + 1);
};

const tailCoalesce: ShapeTailFn<ElementStream> = (st, step, _steps, stop) =>
  continueLowering(lowerBranchByShape('coalesce', st, step), stop + 1);

// group()/groupCount() always lowers to one rich GroupStream. Root materialization frames
// it directly; supported Column consumers derive a narrow MapStream.
const tailGroup: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const isCount = step.name === 'groupCount';
  const src = elementGroupSource(st, step.productiveBy);
  return continueLowering(lowerGroup(st, isCount, step.modulators ?? [], src), stop + 1);
};

// A one-label select emits the labelled traverser itself (or its by(key) scalar), not a
// Map (retype immediately so later steps use common dispatch). Multi-label select() and
// every project() produce a per-traverser RecordStream (shared framing/field selection).
const tailSelectProject: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  if (step.name === 'select'
    && step.args.filter((a) => typeof a === 'string').length === 1
    && !step.args.some(isNested)
    && !step.args.some((a) => a && typeof a === 'object' && 'column' in a))
    return continueLowering(lowerSingleSelect(st, step), stop + 1);
  return continueLowering(lowerRecordSelectProject(st, step), stop + 1);
};

// A bare scalar-producing projection (values/id/label with no preceding tail modifier)
// crosses immediately to the scalar value pipeline: lowerScalarProjection builds the
// ScalarStream and every following value op + all per-row framing then live in
// scalar.ts/barrier.ts, never renderProjection (consolidation P1, unify tail).
const tailScalarProj: ShapeTailFn<ElementStream> = (st, step, _steps, stop) =>
  continueLowering(lowerScalarProjection(st, step, EMPTY_TAIL_ACC), stop + 1);

const ELEMENT_DISPATCH = new Map<string, ShapeTailFn<ElementStream>>([
  ['order', tailOrder],
  ['count', tailCount],
  // properties() turns the traverser into a relational PropertyStream. Property-specific
  // followers dispatch there; key/value/element re-enter common streams.
  ['properties', (st, step, _steps, stop) => continueLowering(lowerProperties(st, step), stop + 1)],
  ['choose', tailChoose],
  ['map', tailMap],
  ['local', tailLocal],
  ['flatMap', tailFlatMap],
  ['optional', tailOptional],
  ['union', tailUnion],
  ['coalesce', tailCoalesce],
  // constant(x) rebinds every traverser to the literal x — element in, scalar out.
  // In a CHILD scope a literal has no emission order of its own, which is what the partitioned
  // `first` cardinality policy ranks on — so mint the per-origin encounter on the ELEMENT stream
  // first (one row per input, ordered by element id). That is exactly what the retired bespoke
  // child projector did inline, and doing it HERE is what lets constant() compose in a child
  // scope through the ordinary loop instead of through a second implementation.
  ['constant', (st, step, _steps, stop) => {
    const seed = st.traverserLayout.origins.length && !st.traverserLayout.encounter ? mintChildEncounter(st) : st;
    return continueLowering(lowerConstant(loweringStateOf(seed), seed.rel, step.args), stop + 1);
  }],
  // math("<formula>") → one SQL arithmetic scalar (always Double); its variables resolve
  // through the by() modulators folded onto it.
  ['math', (st, _step, steps, stop) => continueLowering(lowerMath(st, steps, stop), stop + 1)],
  // format("…%{token}…") → one `||`-concatenated SQL string (properties + by()s).
  ['format', (st, _step, steps, stop) => continueLowering(lowerFormat(st, steps, stop), stop + 1)],
  // bare sack() reads the carried per-traverser sack column; a trailing reducer/is/order
  // composes via the shared value tail.
  ['sack', (st, step, _steps, stop) => continueLowering(lowerSackRead(st, step), stop + 1)],
  // cap('x') emits a named side-effect collection registered earlier in the chain.
  ['cap', (st, _step, steps, stop) => compileCap(st, steps, stop)],
  ['group', tailGroup], ['groupCount', tailGroup],
  ['select', tailSelectProject], ['project', tailSelectProject],
  // call(service, …) mid-traversal: the service produces a per-parent Stream (e.g.
  // tinker.degree.centrality → a scalar per input). lowerCall pushes the child scope via
  // the service; the resulting stream re-enters the generic lowering loop.
  // lowerCall returns a LoweringResult directly: continueLowering for a 'stream' service (it
  // advances past the call), or a LoweringSuspension for a mid-traversal 'barrier' (federate) —
  // relayed unchanged up through lowerSteps to compileRead. The stop+1 advance lives inside
  // lowerCall now (it knows whether it consumed the step or suspended).
  ['call', (st, step, steps, stop) => lowerCall(step, st, ROOT_SCOPE, steps, stop)],
  ...[...SCALAR_PROJ].map((n): [string, ShapeTailFn<ElementStream>] => [n, tailScalarProj]),
]);

/** Compile the tail: `st` is the finished prefix state, `steps[stop]` the first step the
 *  prefix dispatch didn't consume. A recognized shape-changing step dispatches through
 *  ELEMENT_DISPATCH; everything else (projection + modifiers) folds through compileTailFold. */
export function compileTail(st: ElementStream, steps: IRStep[], stop: number): LoweringResult {
  return dispatchShapeTail(ELEMENT_DISPATCH, st, steps, stop, compileTailFold);
}

/** The projection tail: accumulate the projection + value modifiers into a TailAcc, then
 *  render terminally or cross a retype boundary (fold→list, unfold, valueMap→map). */
function compileTailFold(st: ElementStream, steps: IRStep[], stop: number): LoweringResult {
  // Tail fold: accumulate the projection + modifiers, stopping at a retype boundary
  // (unfold / a non-terminal fold) or at a scalar projection (values/id/label) — which
  // foldTailAcc leaves as projStep so the whole value tail routes through the scalar
  // pipeline below.
  const { acc, stop: at } = foldTailAcc(steps, stop);

  // A scalar projection reached with preceding element modifiers (order()/limit()/…):
  // hand off to the same scalar value pipeline, carrying the element order.
  if (acc.projStep && SCALAR_PROJ.has(acc.projStep.name))
    return continueLowering(lowerScalarProjection(st, acc.projStep, acc), at);

  // path() → a PathStream, whether terminal (loop returns it) or followed (the path arm
  // compileFromPath validates count/is(typeOf)/…). Its dedup/limit modifiers already
  // folded into acc; foldTailAcc stopped at any shape-boundary follower.
  if (acc.projStep?.name === 'path')
    return continueLowering(lowerPath(st, acc.projStep, acc), at);

  // valueMap()/elementMap() with a follower: re-enterable as a per-element MapStream
  // (select(Column)) or answered directly (count/is(typeOf(MAP))). Terminal keeps the
  // buildProjection ResultStream below (unchanged).
  if (acc.projStep && (acc.projStep.name === 'valueMap' || acc.projStep.name === 'elementMap') && at < steps.length)
    return lowerValueMapTail(st, acc.projStep, acc, steps, at);

  // Consumed the whole chain → render terminally, exactly as before.
  if (at === steps.length) {
    if (isMapProj(acc.projStep))
      return continueLowering(compileSelectProject(st, acc.projStep!, acc), at);
    return continueLowering(buildProjection(st, acc), at);
  }

  // A second projection is a shape boundary, not a global error. Finish the first
  // scalar projection (including any element-side order/range/dedup modifiers), turn
  // its SQL into a ScalarStream, and let the iterative dispatcher validate/compile
  // the follower against scalar input.
  if (acc.projStep && SCALAR_PROJ.has(acc.projStep.name) && PROJECTION_NAMES.has(steps[at].name)) {
    const result = buildProjection(st, acc);
    if (result.shape.kind !== 'value') throw new Error(`${acc.projStep.name}() did not produce a scalar stream`);
    const rel = st.q.cte(result.tail, ['v']);
    return continueLowering(toScalarStream(dropLayoutAtBarrier(loweringStateOf(st)), rel, undefined, { type: result.shape.type }), at);
  }
  if (PROJECTION_NAMES.has(steps[at].name))
    throw new Error(`${steps[at].name}() cannot consume the ${acc.projStep?.name ?? 'element'} result shape`);

  // Stopped at a retype boundary: steps[at] is `unfold` or a non-terminal `fold`.
  const boundary = steps[at].name;
  if (boundary === 'unfold') {
    // unfold() on an ELEMENT stream is identity (a vertex/edge is not a collection)
    // — continue from after it. Only the bare form (no projection/modifier consumed
    // first) is identity-safe; values().unfold() etc. defer.
    if (acc.projStep || acc.orders.length || acc.reducer || acc.isPreds.length || acc.distinct || acc.offset || acc.limit !== null)
      throw new Error('unfold() after a projection/modifier on an element stream not yet supported');
    return continueLowering(st, at + 1);
  }
  // A non-terminal fold → a single list value; continue from the ListStream.
  return continueLowering(compileFold(st, acc), at + 1);
}

/**
 * Turn a scalar projection (values/id/label) — with any preceding element modifiers
 * folded into `acc` (order/limit/skip/range, and an upstream carried encounter from an
 * ordered dedup) — into a ScalarStream. This is the ONE entry to the scalar value
 * pipeline: every following value op (transforms/is/reducers/inject/Scope.local) and all
 * per-row framing then live in scalar.ts/barrier.ts/materializeScalarRoot, never
 * renderProjection. Element order().by(key) becomes the carried encounter column, which
 * threads through the scalar pipeline and orders the final result; a child scope keeps
 * its per-origin physical encounter. Per-row stored vtype (values() of a typed prop)
 * rides alongside `v` for a following is(typeOf(X)) and typed framing.
 */
function lowerScalarProjection(st: ElementStream, projStep: IRStep, acc: TailAcc): ScalarStream {
  const n = elemRel(st);
  const p = st.rel.as('p');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projStep.name)!({ st, n, p, lbl: labelNameFor(n, st.elem), labelToken: labelTokenFor(n, st.elem, regime(st)), labelSet: regime(st) === 'set', extId, vJoin, projStep });
  const asTag = proj.shape.kind === 'value' ? staticTypeOf(proj.shape.type) : undefined;
  const vt = proj.vtypeExpr ? 'vtype' : undefined;
  const vtypeCol = proj.vtypeExpr ? q`, ${proj.vtypeExpr} AS vtype` : empty;
  // The non-productive by(key) drop rides in this projection's WHERE. TinkerPop's default by() is
  // NON-productive: `g.V().order().by('age')` returns four rows on the modern graph, not six, because
  // the two software vertices have no `age`. ONE policy (orderProductivityFilter) shared with
  // lowerElementOrderReenter, fed this site's own sort-key builder so the drop tests exactly the
  // expression the ORDER BY sorts on.
  const orderDrop = orderProductivityFilter(acc.orders, acc.productiveBy, nodePropOrderKey(st));
  const baseWhere = orderDrop
    ? (proj.baseWhere ? q`${proj.baseWhere} AND ${orderDrop}` : orderDrop)
    : proj.baseWhere;
  const where = baseWhere ? q` WHERE ${baseWhere}` : empty;
  const origin = st.traverserLayout.origins.at(-1);

  // Child scope: a physical per-origin encounter partitions downstream scalar row ops.
  // A re-sourced body discarded its input before reaching this projection, so its element
  // barriers are ordinary independent copies of the same global relation. Lower those barriers
  // with per-origin windows here, then hand their ranked encounter to the shared scalar child
  // cardinality policy. This is a provenance fact from lowerReSource, not a concat special case.
  if (origin) {
    if (st.reSourced && acc.distinct) {
      // Bare element dedup is keyed by the current element identity. Its input relation
      // already contains one cross-joined copy per child origin, so rank that identity
      // within the origin before continuing through the same order/slice/projection path.
      const d = st.rel.as('d');
      const rankOrder = st.traverserLayout.encounter ? d.c[st.traverserLayout.encounter] : d.c.id;
      const marked = st.q.cte(
        q`SELECT ${d.c.id} AS id${layoutProjection(st.traverserLayout, d)}, ROW_NUMBER() OVER (PARTITION BY ${d.c[origin]}, ${d.c.id} ORDER BY ${rankOrder}) AS drn FROM ${d}`,
        ['id', ...layoutCols(st.traverserLayout), 'drn'],
      );
      const m = marked.as('m');
      const deduped = st.q.cte(
        q`SELECT ${m.c.id} AS id${layoutProjection(st.traverserLayout, m)} FROM ${m} WHERE ${m.c.drn}=1`,
        ['id', ...layoutCols(st.traverserLayout)],
      );
      return lowerScalarProjection({ ...st, rel: deduped }, projStep, { ...acc, distinct: false });
    }
    if (st.reSourced) {
      const orderExprs = acc.orders.map((o) => tailOrderTerm(st, o, proj.scalarExpr ?? p.c.id));
      const layout = patchLayout(st.traverserLayout, { encounter: 'encounter' });
      const ranking = q`ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${list(orderExprs.length ? orderExprs : [proj.encounterKey ?? p.c.id], ', ')})`;
      const ranked = st.q.cte(
        q`SELECT ${proj.colsNode}${vtypeCol}${layoutProjectionMinting(layout, p, 'encounter', ranking)} FROM ${proj.fromNode}${where}`,
        ['v', ...(vt ? ['vtype'] : []), ...layoutCols(layout)],
      );
      if (acc.limit === null && acc.offset === 0)
        return toScalarStream(loweringStateOf(st, layout), ranked, asTag, { result: 'value', type: vt ? PER_ROW(vt) : undefined });
      const r = ranked.as('r');
      const stop = acc.limit === null ? null : acc.offset + acc.limit;
      const slice = st.q.cte(
        q`SELECT ${r.c.v} AS v${vt ? q`, ${r.c.vtype} AS vtype` : empty}${layoutProjection(layout, r)} FROM ${r} WHERE ${r.c.encounter} > ${value(acc.offset)}${stop === null ? empty : q` AND ${r.c.encounter} <= ${value(stop)}`}`,
        ['v', ...(vt ? ['vtype'] : []), ...layoutCols(layout)],
      );
      return toScalarStream(loweringStateOf(st, layout), slice, asTag, { result: 'value', type: vt ? PER_ROW(vt) : undefined });
    }
    if (acc.orders.length || acc.limit !== null || acc.offset > 0 || acc.distinct)
      throw new Error('order()/limit()/dedup() before a projection inside a child scope not yet supported');
    const layout = patchLayout(st.traverserLayout, { encounter: 'encounter' });
    const mint = q`ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${proj.encounterKey ?? p.c.id})`;
    const rel = st.q.cte(
      q`SELECT ${proj.colsNode}${vtypeCol}${layoutProjectionMinting(layout, p, 'encounter', mint)} FROM ${proj.fromNode}${where}`,
      ['v', ...(vt ? ['vtype'] : []), ...layoutCols(layout)],
    );
    return toScalarStream(loweringStateOf(st, layout), rel, asTag, { result: 'value', type: vt ? PER_ROW(vt) : undefined });
  }

  // Root scope. An explicit order().by(key) mints the carried encounter; LIMIT/OFFSET
  // apply in this projection CTE. Otherwise an upstream carried encounter (e.g.
  // order().dedup()) rides through unchanged via layoutProjection.
  if (acc.distinct) throw new Error('dedup() before a scalar projection not yet supported');
  const orderExprs = acc.orders.map((o) => tailOrderTerm(st, o, proj.scalarExpr ?? p.c.id));
  const hasNewEncounter = orderExprs.length > 0;
  // A pre-existing carried encounter (seeded by the emission-order demand pass) is SUPERSEDED
  // by order().by(key) — layoutProjectionMinting re-mints it in its declared slot below. Only a live path
  // still defers (order() before a projection while tracking a path is not yet supported).
  if (hasNewEncounter && st.traverserLayout.path)
    throw new Error('order() before a projection while tracking a path not yet supported');
  const hasLimit = acc.limit !== null || acc.offset > 0;
  // The ROW_NUMBER window already captures order (materializeScalarRoot sorts by the
  // encounter); an outer ORDER BY is only needed so LIMIT/OFFSET picks the right slice.
  const orderNode = hasNewEncounter && hasLimit ? q` ORDER BY ${list(orderExprs, ', ')}` : empty;
  const limitNode = hasLimit ? limitOffset({ scope: 'global', offset: acc.offset, limit: acc.limit }) : empty;
  if (hasNewEncounter) {
    // order().by(key) SUPERSEDES the carried encounter (fresh ROW_NUMBER) in its declared slot.
    const layout = patchLayout(st.traverserLayout, { encounter: 'encounter' });
    const mint = q`ROW_NUMBER() OVER (ORDER BY ${list(orderExprs, ', ')})`;
    const rel = st.q.cte(
      q`SELECT ${proj.colsNode}${vtypeCol}${layoutProjectionMinting(layout, p, 'encounter', mint)} FROM ${proj.fromNode}${where}${orderNode}${limitNode}`,
      ['v', ...(vt ? ['vtype'] : []), ...layoutCols(layout)],
    );
    return toScalarStream(loweringStateOf(st, layout), rel, asTag, { result: 'value', type: vt ? PER_ROW(vt) : undefined });
  }
  const rel = st.q.cte(
    q`SELECT ${proj.colsNode}${vtypeCol}${layoutProjection(st.traverserLayout, p)} FROM ${proj.fromNode}${where}${orderNode}${limitNode}`,
    ['v', ...(vt ? ['vtype'] : []), ...layoutCols(st.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(st), rel, asTag, { result: 'value', type: vt ? PER_ROW(vt) : undefined });
}

/**
 * A non-terminal fold(): collapse the element stream into ONE list value — a JSONB
 * array in a one-row relation (the list-value substrate; see stream.ts). An element
 * stream folds its bare rowids (rejoined on unfold/framing); a values/id/label
 * projection folds its scalar. Bare form only: an inner order()/dedup()/limit()/is()/
 * transform before the fold, a non-scalar projection (valueMap/select/path), or
 * aliases/path/origin riding through the retype all defer (clear throws). A TERMINAL
 * fold never reaches here — it stays the reducer path (unchanged). The wasteful
 * roundtrip in fold().unfold() (materialize then json_each) is deliberate — correct
 * beats a peephole nobody's query needs (see the plan's decision log).
 */
function compileFold(st: ElementStream, acc: TailAcc): ListStream {
  if (acc.reducer || acc.isPreds.length || acc.offset || acc.limit !== null)
    throw new Error('dedup()/limit()/range()/is() before a non-terminal fold() not yet supported');
  if (st.traverserLayout.aliases.size || st.traverserLayout.path || st.traverserLayout.origins.length)
    throw new Error('fold() carrying as()/path()/branch state into a list value not yet supported');
  // A global fold is a barrier: every traverser collapses into ONE list value, so carried
  // bulk (and any other per-traverser state) is consumed here — the list is a fresh bulk-1
  // traverser (an unfold later re-enumerates its members).
  const carry = dropLayoutAtBarrier(loweringStateOf(st));
  const projName = acc.projStep?.name;
  // A single bare order() before the fold sorts the folded elements by their projected
  // scalar value (values('x').order().fold() → a sorted list). Only the by-nothing /
  // direction-only form on a scalar projection is supported; order().by(key/traversal)
  // and element-stream order-before-fold defer.
  let orderDir: 'asc' | 'desc' | null = null;
  if (acc.orders.length) {
    if (acc.orders.length > 1 || acc.orders[0].key !== null || acc.orders[0].token || acc.orders[0].dir === 'shuffle')
      throw new Error('order().by(key/traversal) before a non-terminal fold() not yet supported');
    if (!projName) throw new Error('order() before a non-terminal fold() of an element stream not yet supported');
    orderDir = acc.orders[0].dir === 'desc' ? 'desc' : 'asc';
  }
  if (!projName) {
    // Element list: fold the bare rowids; unfold/framing rejoins nodes/edges.
    // Retyping at a non-terminal fold must consume every modifier already absorbed by the
    // value-tail accumulator. In particular, dedup() is a set barrier over the input
    // traversers, not a terminal-rendering detail — putting DISTINCT in the relation fed to
    // the aggregate keeps fold().unfold() multiset-faithful.
    const p = st.rel.as('p');
    const source = acc.distinct
      ? q`(SELECT DISTINCT ${p.c.id} AS id FROM ${p}) AS f`
      : q`${p}`;
    const member = acc.distinct ? q`f.id` : p.c.id;
    const rel = st.q.cte(q`SELECT ${jsonbGroupArray(member)} AS list FROM ${source}`, ['list']);
    return toListStream(carry, rel, { kind: 'elem', elem: st.elem });
  }
  if (projName === 'values' || projName === 'id' || projName === 'label' || projName === 'labels') {
    const n = elemRel(st);
    const p = st.rel.as('p');
    const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
    const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const proj = PROJECTORS.get(projName)!({ st, n, p, lbl: labelNameFor(n, st.elem), labelToken: labelTokenFor(n, st.elem, regime(st)), labelSet: regime(st) === 'set', extId, vJoin, projStep: acc.projStep });
    // values() drops missing-property elements (baseWhere = IS NOT NULL), matching
    // TinkerPop's fold-of-values. id/label have no baseWhere.
    const where = proj.baseWhere ? q` WHERE ${proj.baseWhere}` : empty;
    // As with element lists, dedup belongs to the rows entering fold, before their JSON
    // aggregation. A derived relation also composes with the existing order form without
    // relying on SQLite's DISTINCT aggregate syntax restrictions.
    const selected = acc.distinct
      ? q`SELECT DISTINCT ${proj.scalarExpr!} AS v FROM ${proj.fromNode}${where}`
      : q`SELECT ${proj.scalarExpr!} AS v FROM ${proj.fromNode}${where}`;
    const source = q`(${selected})`;
    const arr = orderDir
      ? q`jsonb(json_group_array(f.v ORDER BY f.v ${orderDir === 'desc' ? 'DESC' : 'ASC'}))`
      : jsonbGroupArray(q`f.v`);
    const rel = st.q.cte(q`SELECT ${arr} AS list FROM ${source} AS f`, ['list']);
    return toListStream(carry, rel, { kind: 'scalar' });
  }
  throw new Error(`fold() of a ${projName}() projection not yet supported`);
}

/**
 * The scalar-stream tail: a one-column `v` relation → foldTailAcc + the shared value
 * tail (renderProjection). Entered from unfold() of a scalar list (lowerSteps); the
 * same engine compileInject's tail runs, factored out so both consume one modifier
 * vocabulary. count() is the only projection valid on a scalar stream.
 */
// A list-collection step (set-op / conjoin / merge / all / any) requires a list/map traverser;
// reached on a scalar stream it raises TinkerPop's incoming-type error.
const SCALAR_LIST_ONLY = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product', 'conjoin', 'merge', 'all', 'any']);

// is(typeOf(LIST|SET|MAP)) RETYPES a scalar value stream into a ListStream / MapStream: the
// stored collection value becomes the `list` / `map` column, so unfold/count(Scope.local)/
// range/select(Column)/framing all reuse the collection substrate (List.feature / Map.feature).
// A stored non-matching row is filtered out; a computed scalar (no stored vtype) can't be a
// collection, so it falls through to the generic is() fold (which static-folds to empty).
const scalarIsCollectionRetype: ShapeTailFn<ScalarStream> = (s, step, _steps, at) => {
  const kind = collectionAssert(step);
  if (kind === 'list' || kind === 'set') {
    const listed = scalarCollectionRetype(s, kind);
    return listed ? continueLowering(listed, at + 1) : null;
  }
  if (kind === 'map') {
    const mapped = scalarMapRetype(s);
    return mapped ? continueLowering(mapped, at + 1) : null;
  }
  return null;
};

const scalarListOnly: ShapeTailFn<ScalarStream> = (s, step) => {
  if (s.literalNull) throw new Error(`Incoming traverser for ${step.name} step can't be null`);
  throw new Error(`${step.name} step can only take an array or an Iterable type for incoming traversers, encountered a scalar`);
};

// Filter family over a scalar current object: and/or/not/filter/where evaluate their child
// predicate against `v` and drop rows. A scalar traverser is first-class — these are the
// same steps as on an element, differing only in the current object.
// and/or/not/filter/where over a scalar: the inline predicate fast path, falling back to the
// generic child-existence gate when it declines (switch off, or a body beyond inline vocab).
const scalarFilter: ShapeTailFn<ScalarStream> = (s, step, _steps, at) => {
  const r = lowerScalarFilter(s, step) ?? tryScalarFilterByChildExistence(s, step);
  return r ? continueLowering(r, at + 1) : null;
};

// count()/numeric-reducer()/fold() are barriers → another ScalarStream transition, not a
// terminal rendering decision. Keeping them relational lets a following scalar
// filter/transform/reducer compile normally. Scope.local forms are NOT global barriers →
// return null so the fallback raises the "needs a preceding list" message.
const scalarCount: ShapeTailFn<ScalarStream> = (s, step, _steps, at) =>
  isScopeLocalStep(step) ? null : continueLowering(lowerGlobalCount(s), at + 1);
const scalarNumericReducer: ShapeTailFn<ScalarStream> = (s, step, _steps, at) =>
  isScopeLocalStep(step) ? null : continueLowering(lowerGlobalNumericReducer(s, step.name as NumericReducer), at + 1);
const scalarFold: ShapeTailFn<ScalarStream> = (s, step, _steps, at) =>
  isScopeLocalStep(step) ? null : continueLowering(lowerGlobalFold(s), at + 1);

// Bare groupCount() over a scalar stream → group by the value (Map{value:count}). A
// name-keyed side effect (groupCount('a')) or a by()/re-key defers to the fallback.
const scalarGroupCount: ShapeTailFn<ScalarStream> = (s, step, _steps, at) =>
  (step.args ?? []).length === 0 && !(step.modulators?.length) ? continueLowering(lowerScalarGroupCount(s), at + 1) : null;


/** Wrap a scalar-parent branch consumer (child.ts) as a ShapeTailFn: a produced stream
 *  continues lowering; a null (arm outside the scalar-arm vocabulary) falls through to the
 *  generic scalar deferral. */
const scalarBranch = (fn: (s: ScalarStream, step: IRStep) => ScalarStream | null): ShapeTailFn<ScalarStream> =>
  (s, step, _steps, at) => { const r = fn(s, step); return r ? continueLowering(r, at + 1) : null; };

const SCALAR_DISPATCH = new Map<string, ShapeTailFn<ScalarStream>>([
  ['is', scalarIsCollectionRetype],
  ['and', scalarFilter], ['or', scalarFilter], ['not', scalarFilter], ['filter', scalarFilter], ['where', scalarFilter],
  // constant(x) rebinds every traverser to the literal x — the scalar form preserves the
  // encounter/origins so it composes inside a child scope (option/project/modulation bodies).
  ['constant', (s, step, _steps, at) => continueLowering(lowerScalarConstant(s, step.args), at + 1)],
  // sack over a scalar: mutate (fold the current value into the carried sack) or bare read.
  ['sack', (s, step, _steps, at) => continueLowering(lowerScalarSack(s, step), at + 1)],
  ['count', scalarCount],
  ['fold', scalarFold],
  ['groupCount', scalarGroupCount],
  // aggregate('x') collects the values into a named bag (pass-through); cap('x') reads any
  // registered side-effect (shape-agnostic list/variant). Both compose over a scalar stream.
  ['aggregate', (s, step, _steps, at) => { const r = lowerScalarAggregate(s, step); return r ? continueLowering(r, at + 1) : null; }],
  ['cap', (s, _step, steps, at) => compileCap(s, steps, at)],
  // split(sep) retypes a scalar string → a List of substrings (recursive CTE). Throws
  // TinkerPop's error on a non-string separator (matches the spec).
  ['split', (s, step, _steps, at) => continueLowering(lowerScalarSplit(s, step), at + 1)],
  // concat(<traversal>…) — the `apply` child-value contract. Only the TRAVERSAL-argument form
  // reaches here: lowerScalarRows yields at one because each argument needs its own child scope
  // (a row boundary), while the string-only form stays fused in the row run. A miss returns null
  // → the generic deferral, so an unsupported child body still fails closed.
  ['concat', scalarBranch(lowerConcatScalar)],
  // dateDiff(__.traversal) follows DateDiffStep's TraversalUtil.apply contract. The
  // literal form stays in the fused scalar transform; only a child operand reaches here.
  ['dateDiff', scalarBranch(lowerDateDiffScalar)],
  // V()/E() after a scalar re-source the graph per traverser (a flatMap → ElementStream).
  ['V', (s, step, _steps, at) => { const r = lowerReSource(s, step); return r ? continueLowering(r, at + 1) : null; }],
  ['E', (s, step, _steps, at) => { const r = lowerReSource(s, step); return r ? continueLowering(r, at + 1) : null; }],
  // Branch/map over a scalar current object: each arm is a value sub-traversal lowered
  // through the same engine, gated + UNION-merged (child.ts tryScalar*Child). A miss
  // (arm outside the scalar-arm vocabulary) returns null → the clear generic deferral.
  // choose: predicate form → gated UNION arms; option-map form (choose(fn).option(k,body)…)
  // → a CASE over the value through the modulation seam.
  ['choose', (s, step, steps, at) => {
    const r = step.optionArms ? lowerChooseOptionsScalar(s, steps, at)
      : (tryScalarChooseChild(s, step) ?? tryScalarVariantChoose(s, step));
    return r ? continueLowering(r, at + 1) : null;
  }],
  // union over a scalar: homogeneous arms merge as a scalar UNION ALL (tryScalarUnionChild);
  // mixed-shape arms (scalar + re-source element + fold list) merge as a VariantStream — the
  // scalar→variant cascade, mirroring the element-parent tailUnion list→scalar→variant order.
  ['union', (s, step, _steps, at) => {
    const r = tryScalarUnionChild(s, step) ?? tryScalarVariantUnion(s, step);
    return r ? continueLowering(r, at + 1) : null;
  }],
  // map() is first-result-only → no fan-out arm (a re-source projection / nested union would
  // over-produce; it fails closed on those). flatMap/local emit all results.
  ['map', (s, step, _steps, at) => { const r = tryScalarMapChild(s, step, false); return r ? continueLowering(r, at + 1) : null; }],
  // local: a value body per traverser; local(__.aggregate('x')) is a per-value side-effect
  // register that passes the value through — equivalent to a bare aggregate at this position.
  ['local', (s, step, _steps, at) => {
    const nested = (step.args ?? [])[0];
    if (nested && typeof nested === 'object' && 'nested' in nested) {
      const body = childSteps(nested.nested, s.params);
      if (body.length === 1 && body[0].name === 'aggregate') {
        const r = lowerScalarAggregate(s, body[0]);
        return r ? continueLowering(r, at + 1) : null;
      }
    }
    const r = tryScalarMapChild(s, step);
    return r ? continueLowering(r, at + 1) : null;
  }],
  ['flatMap', scalarBranch(tryScalarMapChild)],
  // optional(t) over a scalar ≡ coalesce(t, identity): a scalar arm → scalar (miss restores the
  // value); an element/list arm → a VariantStream (arm rows where productive, else the value).
  ['optional', (s, step, _steps, at) => {
    const r = tryScalarOptionalChild(s, step) ?? tryScalarVariantOptional(s, step);
    return r ? continueLowering(r, at + 1) : null;
  }],
  // coalesce over a scalar: homogeneous arms → first-productive scalar (tryScalarCoalesceChild);
  // mixed-shape arms → a VariantStream, ordinal-gated first-productive (tryScalarVariantCoalesce).
  ['coalesce', (s, step, _steps, at) => {
    const r = tryScalarCoalesceChild(s, step) ?? tryScalarVariantCoalesce(s, step);
    return r ? continueLowering(r, at + 1) : null;
  }],
  // math("<formula>") over a scalar: `_` = the value `v`, one arithmetic Double. Named
  // vars / by()-modulated math defer (return null) to the generic message.
  ['math', scalarBranch(lowerMathScalar)],
  // format("…%{_}…") over a scalar: literals + by()-modulator tokens over the value.
  ['format', scalarBranch(lowerFormatScalar)],
  // project('a','b').by(…) over a scalar: each field's by() runs against the value → a
  // RecordStream of scalar fields (select.ts lowerScalarProject). A field needing element
  // output (movement) returns null → the "requires element input" deferral.
  ['project', (s, step, _steps, at) => { const r = lowerScalarProject(s, step); return r ? continueLowering(r, at + 1) : null; }],
  // unfold() on a scalar is identity (a scalar is not a collection) — continue past it,
  // exactly as unfold() on an element stream (lets cap().unfold() feed a following reducer).
  ['unfold', (s, _step, _steps, at) => continueLowering(s, at + 1)],
  // identity() is a universal no-op — pass the scalar stream through unchanged (also the
  // scalar-arm no-op body, e.g. choose(P, __.constant(x), __.identity())).
  ['identity', (s, _step, _steps, at) => continueLowering(s, at + 1)],
  ...[...NUMERIC_REDUCERS].map((n): [string, ShapeTailFn<ScalarStream>] => [n, scalarNumericReducer]),
  ...[...SCALAR_LIST_ONLY].map((n): [string, ShapeTailFn<ScalarStream>] => [n, scalarListOnly]),
]);

export function compileFromScalar(s: ScalarStream, steps: IRStep[], from: number): LoweringResult {
  // Every scalar row op (transforms/is/order/limit/skip/range/tail/dedup/inject) and every
  // Scope.local case is consumed by lowerScalarRows before we reach here, and SCALAR_DISPATCH
  // owns the barriers (count/reducers/fold/unfold/filter/constant/sack). So a miss is
  // unsupported — fail closed with a precise message (this is why the scalar tail no
  // longer needs foldTailAcc/renderProjection).
  return dispatchShapeTail(SCALAR_DISPATCH, s, steps, from, () => {
    const step = steps[from];
    if (isScopeLocalStep(step))
      throw new Error(`${step.name}(Scope.local) requires a preceding list-producing step (e.g. fold())`);
    if (PROJECTION_NAMES.has(step.name))
      throw new Error(`${step.name}() requires element input (a scalar stream has no ${step.name})`);
    throw new Error(`${step.name}() after a scalar stream not yet supported`);
  });
}

export interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

// ---------- projection resolution (values/id/label/valueMap/elementMap/element) ----------

interface ProjCtx {
  st: ElementStream; n: Relation; p: Relation; extId: Expression;
  /** The element's label NAME as a scalar — a vertex picks one of its set (never a join,
   *  which would multiply the row). Replaces the old `l: Relation` + `vlJoin`. */
  lbl: Expression;
  /** The `T.label` token for a MAP shape: `lbl` under the single-label regime, a JSON array of
   *  every label under the multi-label one. Only elementMap/valueMap(true) use it — `label()` and
   *  `by(T.label)` are scalar positions and stay on `lbl`. */
  labelToken: Expression;
  /** Whether `labelToken` is that JSON array, so the framer knows to emit a SET. */
  labelSet: boolean;
  vJoin: Expression;
  projStep: IRStep | null;
}
export interface ProjResult { shape: Shape; colsNode: Expression; fromNode: Expression; scalarExpr?: Expression | null; baseWhere?: Expression | null; encounterKey?: Expression; vtypeExpr?: Expression | null; }
type ProjFn = (c: ProjCtx) => ProjResult;

const PROJECTORS = new Map<string, ProjFn>([
  ['values', (c) => {
    const key = c.projStep!.args[0] as string;
    // values() is a genuine flatMap — JOIN the normalized properties table so a
    // multi-valued key yields one row PER value (the INNER JOIN also drops missing-key
    // elements, so no separate IS NOT NULL). Edges are single-valued (one row per key).
    if (c.st.elem === 'edge') {
      const ep = edgeProperties.as('ep');
      return {
        // A collection value → json() TEXT (so the framer JSON.parses the {t,v} tree);
        // a scalar stays raw. scalarExpr (order key) keeps the raw column (collections
        // as sort keys are degenerate either way).
        shape: { kind: 'value', type: PER_ROW('vtype') }, colsNode: q`${storedValueExpr(ep.c.value, ep.c.vtype)} AS v`,
        fromNode: q`${c.vJoin} JOIN ${ep} ON ${ep.c.edge}=${c.n.c.id} AND ${ep.c.key}=${value(key)}`,
        scalarExpr: ep.c.value, baseWhere: null, encounterKey: q`${c.p.c.id}, ${ep.c.id}`, vtypeExpr: ep.c.vtype,
      };
    }
    const vp = vertexProperties.as('vp');
    return {
      shape: { kind: 'value', type: PER_ROW('vtype') }, colsNode: q`${storedValueExpr(vp.c.value, vp.c.vtype)} AS v`,
      fromNode: q`${c.vJoin} JOIN ${vp} ON ${vp.c.node}=${c.n.c.id} AND ${vp.c.key}=${value(key)}`,
      scalarExpr: vp.c.value, baseWhere: null, encounterKey: q`${c.p.c.id}, ${vp.c.id}`, vtypeExpr: vp.c.vtype,
    };
  }],
  ['id', (c) => ({
    // Join the element table even though the id lives in `rel`, so a preceding
    // order().by(key) — which references n.props — has the alias in scope.
    shape: { kind: 'value', type: UNKNOWN }, colsNode: q`${c.extId} AS v`, fromNode: c.vJoin, scalarExpr: c.extId, encounterKey: c.p.c.id,
  })],
  ['label', (c) => ({
    shape: { kind: 'value', type: STATIC('string') }, colsNode: q`${c.lbl} AS v`, fromNode: c.vJoin, scalarExpr: c.lbl, encounterKey: c.p.c.id,
  })],
  // labels() is label()'s FLAT-MAP twin and THE ONLY reader allowed to join vertex_labels —
  // one row per label, exactly as values() is one row per property value. Every other label
  // reader is a scalar position and must pick (see the seam comment in plan.ts).
  // An EDGE carries exactly one label by spec, so there it is one row, read inline: LabelsStep
  // "for edges, the single label is emitted".
  ['labels', (c) => {
    if (c.st.elem === 'edge') return {
      shape: { kind: 'value', type: STATIC('string') } as Shape,
      colsNode: q`${c.lbl} AS v`, fromNode: c.vJoin, scalarExpr: c.lbl, encounterKey: c.p.c.id,
    };
    const vl = vertexLabels.as('vl');
    const l = labels.as('l');
    return {
      shape: { kind: 'value', type: STATIC('string') } as Shape,
      colsNode: q`${l.c.name} AS v`,
      // INNER JOIN, so a ZERO-label vertex contributes no rows — which is the specified answer
      // (`g.addV()` then `labels()` has a count of 0), not an accident of the join kind.
      fromNode: q`${c.vJoin} JOIN ${vl} ON ${vl.c.node}=${c.n.c.id} JOIN ${l} ON ${l.c.id}=${vl.c.label}`,
      scalarExpr: l.c.name, baseWhere: null, encounterKey: q`${c.p.c.id}, ${vl.c.label}`,
    };
  }],
  ['valueMap', (c) => {
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    // valueMap props are ALWAYS {key:[values]} (node: multi from the table; edge: each
    // flat value wrapped in a 1-list) so the handler frames both uniformly.
    return {
      shape: { kind: 'valueMap', keys: keys.length ? keys : null, tokens: c.projStep!.args.includes(true), labelSet: c.labelSet },
      colsNode: q`${c.extId} AS id, ${c.labelToken} AS label, ${valueMapProps(c.n, c.st.elem)} AS props`, fromNode: c.vJoin,
    };
  }],
  ['elementMap', (c) => {
    if (c.st.elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'elementMap', keys: keys.length ? keys : null, labelSet: c.labelSet },
      colsNode: q`${c.extId} AS id, ${c.labelToken} AS label, ${valueMapProps(c.n, c.st.elem)} AS props`, fromNode: c.vJoin,
    };
  }],
  ['__element', (c) => ({
    shape: { kind: c.st.elem },
    colsNode: elementPayload(elemCtx(c.n, c.st.elem), c.st.elem),
    fromNode: c.vJoin,
  })],
]);

/** An order().by(key) resolver over the current element (aliased `n`): node → the
 *  first-under-multi value from vertex_properties; edge → the single value from
 *  edge_properties. Uses the vtype-aware SORT KEY (compareKey) so a TEXT-stored big
 *  long/bigdecimal/duration orders numerically, not lexically. Shared by buildProjection
 *  and compileMath — both sort a value tail by an element prop. */
export const nodePropOrderKey = (st: ElementStream) => (key: string): Expression =>
  propSortKeyFor(raw('n.id'), st.elem, key);

/** ONE ORDER BY term for a folded tail-accumulator clause — the three sites that render `acc.orders`
 *  (child-scope re-source, root scalar projection, the non-scalar element projection) had the same
 *  four lines each, differing only in what a BARE by() falls back to. That `fallback` is the whole
 *  difference, so it is the parameter.
 *
 *  The element table is aliased `n` in every projection FROM this feeds — the same assumption
 *  `nodePropOrderKey` already encodes as `raw('n.id')`. */
const tailOrderTerm = (st: ElementStream, o: OrderClause, fallback: Expression): Expression => {
  if (o.dir === 'shuffle') return q`RANDOM()`;
  const dir = o.dir === 'desc' ? q` DESC` : q` ASC`;
  if (o.token !== undefined) {
    const expr = tokenExpr(elemCtx(elemRel(st), st.elem), o.token);
    if (!expr) throw new Error(`order().by(T.${o.token}) not yet supported`);
    return q`${expr}${dir}`;
  }
  return q`${o.key !== null ? nodePropOrderKey(st)(o.key) : fallback}${dir}`;
};

/** Render the NON-scalar element tail — __element (vertex/edge), valueMap, elementMap,
 *  count, and element fold() — with only its element-shape modifiers (order().by(key)
 *  / carried encounter, dedup, range/limit). Scalar value machinery (transforms/is on a
 *  value/inject-append/localMean/numeric reducers) lives ONLY in the scalar pipeline
 *  (lowerScalarProjection → scalar.ts/barrier.ts); a scalar projection never reaches
 *  here (foldTailAcc hands it to lowerScalarProjection). Any such op arriving on a
 *  non-scalar shape fails closed. */
function buildProjection(st: ElementStream, acc: TailAcc): ResultStream {
  const { distinct, offset, limit, isPreds, reducer } = acc;
  const projName = acc.projStep?.name ?? '__element';

  // is() on a non-scalar projection (only count() carries a value to test) fails closed;
  // scalar transforms/inject/mean(local) never reach here (foldTailAcc breaks at the
  // scalar projection, or MODIFIERS rejects an unknown step).
  if (isPreds.length && projName !== 'count') throw new Error('is() requires a scalar stream (values/label/id/count)');
  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    // The non-productive by(key) drop still applies even though count() discards the ORDER BY:
    // dropping the traversers whose modulator is unproductive CHANGES THE COUNT. This branch has no
    // `n` alias (it counts st.rel directly), so the key is built against the inner `id` column.
    // The key must be QUALIFIED: bare `id` inside the correlated property subquery binds to
    // vertex_properties' own column, not the counted relation's, and silently matched nothing.
    const cd = st.rel.as('cd');
    const countDrop = orderProductivityFilter(acc.orders, acc.productiveBy,
      (key) => propSortKeyFor(cd.c.id, st.elem, key));
    const inner = countDrop
      ? q`SELECT ${distinct ? 'DISTINCT ' : ''}${cd.c.id} AS id FROM ${cd} WHERE ${countDrop}`
      : q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${st.rel}`;
    const innerLim = (limit !== null || offset > 0) ? limitOffset({ scope: 'global', offset, limit }) : empty;
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(q`v`, pr)), ' AND ')}`;
    return toResultStream(st.q, countNode, { kind: 'value', type: STATIC('long') });
  }

  const n = elemRel(st);
  const p = st.rel.as('p');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projName)!({ st, n, p, lbl: labelNameFor(n, st.elem), labelToken: labelTokenFor(n, st.elem, regime(st)), labelSet: regime(st) === 'set', extId, vJoin, projStep: acc.projStep });

  // order().by(key) sorts by an element property; a bare order() by n.id; else an upstream
  // carried encounter (an ordered dedup) fixes the result order.
  // Same policy as the two scalar-side sites, fed this site's own sort-key builder.
  const elemDrop = orderProductivityFilter(acc.orders, acc.productiveBy, nodePropOrderKey(st));
  let keyNodes: Expression[] = [];
  if (acc.orders.length) {
    keyNodes = acc.orders.map((o) => tailOrderTerm(st, o, raw('n.id')));
  } else if (st.traverserLayout.encounter) keyNodes = [q`${p.c[st.traverserLayout.encounter]}`];
  const orderNode = keyNodes.length ? q` ORDER BY ${list(keyNodes, ', ')}` : empty;
  const limitNode = (limit !== null || offset > 0) ? limitOffset({ scope: 'global', offset, limit }) : empty;
  // Under movementCollapse a bare vertex/edge leaf carries the collapsed multiplicity out to
  // the wire: emit the carried `bulk` column so framing reads it as the per-value multiplicity
  // (framedResults picks up a `bulk` column wherever present — bulk is orthogonal to shape, not
  // a Shape variant). Only when collapse is active; else the projection is unchanged. The
  // bulkRepeatCount fast path reaches this leaf through a sub-engine with movementCollapse forced
  // on (its unrolled frontier IS a collapsed stream), so the SAME gate serves both producers with
  // no bulkRepeatCount coupling here — an uncollapsed compile's projection stays untouched.
  const wantBulk = !!engineOf(st).fastPaths.movementCollapse && !!st.traverserLayout.bulk && !reducer && !distinct
    && (proj.shape.kind === 'vertex' || proj.shape.kind === 'edge');

  // Bulk-aware limit/range: slicing a COLLAPSED leaf must count TRAVERSERS, not rows. A cumulative-
  // bulk window over the sort order gives each row the count of traversers preceding it (`pre`); the
  // row covers [pre, pre+bulk), clamped to the [offset, offset+limit) band, so the boundary rows'
  // multiplicity is trimmed and out-of-band rows drop. chainCollapseSafe only admits limit/range
  // AFTER an order, so keyNodes is populated. (order()-without-slice needs no window — the sorted
  // (v, N) rows already frame correctly, the client expanding each in place.)
  if (wantBulk && (limit !== null || offset > 0)) {
    const b = p.c[st.traverserLayout.bulk!];
    const lo = offset;
    const hi = limit !== null ? offset + limit : null; // exclusive upper traverser index (null = unbounded)
    const win = list(keyNodes.length ? keyNodes : [q`n.id`], ', ');
    const inner = q`SELECT ${proj.colsNode}, ${b} AS bulk, SUM(${b}) OVER (ORDER BY ${win} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - ${b} AS pre FROM ${proj.fromNode}${elemDrop ? q` WHERE ${elemDrop}` : empty}`;
    const upper = hi !== null ? q`MIN(pre + bulk, ${hi})` : q`(pre + bulk)`;
    const conds = [q`pre + bulk > ${lo}`];
    if (hi !== null) conds.push(q`pre < ${hi}`);
    const outCols = proj.shape.kind === 'edge' ? 'id, label, src, tgt, props' : 'id, label, props';
    const windowed = q`SELECT ${raw(outCols)}, (${upper} - MAX(pre, ${lo})) AS bulk FROM (${inner}) WHERE ${list(conds, ' AND ')} ORDER BY pre`;
    return toResultStream(st.q, windowed, proj.shape);
  }

  const bulkCol = wantBulk ? q`, ${p.c[st.traverserLayout.bulk!]} AS bulk` : empty;
  const tailNode = q`SELECT ${distinct ? 'DISTINCT ' : ''}${proj.colsNode}${bulkCol} FROM ${proj.fromNode}${elemDrop ? q` WHERE ${elemDrop}` : empty}${orderNode}${limitNode}`;

  // fold() collapses an element projection into ONE List of vertices/edges (the handler's
  // `list` case folds the projected rows). valueMap/elementMap fold defer.
  if (reducer === 'fold') {
    if (proj.shape.kind !== 'vertex' && proj.shape.kind !== 'edge')
      throw new Error(`fold() of ${proj.shape.kind} not yet supported`);
    return toResultStream(st.q, tailNode, { kind: 'list', elem: proj.shape.kind });
  }
  if (reducer) throw new Error(`${reducer}() of ${proj.shape.kind} not yet supported`);
  return toResultStream(st.q, tailNode, proj.shape);
}

/** bare sack() — read the carried per-traverser sack column (context.ts LoweringState.sack)
 *  as a scalar value, then run the shared value tail (a trailing sum()/dedup/order/is
 *  composes). The value's GraphBinary type is inferred (as:undefined → anySerializer),
 *  matching values(): sack holds whatever the withSack seed / sack(op) arithmetic
 *  produced (int age, double weight, string label). */
function lowerSackRead(st: ElementStream, step: IRStep): ScalarStream {
  if (!st.traverserLayout.sack) throw new Error('sack() requires withSack() or a preceding sack(Operator.x) step');
  if ((step.args ?? []).length) throw new Error('sack(argument) read form not supported (bare sack() only)');
  const p = st.rel.as('p');
  const rel = st.q.cte(
    q`SELECT ${p.c[st.traverserLayout.sack]} AS v${layoutProjection(st.traverserLayout, p)} FROM ${p}`,
    ['v', ...layoutCols(st.traverserLayout)],
  );
  return toScalarStream(loweringStateOf(st), rel);
}

/** cap('x') — emit a named side-effect collection. A list/variant aggregate is ONE
 *  collection traverser; only an explicit following unfold() emits its members. A group
 *  side-effect (group('a')/groupCount('a')) re-runs lowerGroup over its stashed
 *  source → one GroupStream (steps/group.ts). Deferred: multi-key cap('x','y'). */
// cap('x') reads a named side-effect. It only touches `sideEffects` + the shared carry, so it
// is shape-agnostic (a scalar stream that registered an aggregate reads it identically); only
// the group('a') re-emit needs the element parent that stashed it.
function compileCap(st: ElementStream | ScalarStream, steps: IRStep[], stop: number): LoweringResult {
  const names = (steps[stop].args ?? []).filter((a: any) => typeof a === 'string');
  if (names.length !== 1) throw new Error('cap() with multiple side-effect keys not yet supported');
  const def = st.sideEffects?.get(names[0]);
  if (!def) throw new Error(`cap('${names[0]}') references an undefined side-effect`);
  // cap() yields the accumulated side-effect COLLECTION as one fresh traverser — the
  // barrier-built list/variant rel carries no per-traverser bulk, so reset the carry.
  if (def.kind === 'list') {
    const ls = toListStream(dropLayoutAtBarrier(loweringStateOf(st)), def.rel, def.of);
    return continueLowering(ls, stop + 1);
  }
  if (def.kind === 'variant') {
    // The collection's own carried state is gone (a barrier result is a fresh traverser), but its
    // MEMBER order is not part of that: when the def carries an order column, declare it as the
    // stream's encounter so the wire emits the members in it (`rootOrder`, materialize.ts).
    const barrier = dropLayoutAtBarrier(loweringStateOf(st));
    const state = def.order
      ? { ...barrier, traverserLayout: patchLayout(barrier.traverserLayout, { encounter: def.order }) }
      : barrier;
    return continueLowering(toVariantStream(state, def.rel, { scalarAs: def.scalarAs, node: def.elem === 'vertex' || undefined, edge: def.elem === 'edge' || undefined }, 'list'), stop + 1);
  }
  // group('a')/groupCount('a') side-effect → re-emit the same rich GroupStream as an
  // inline group; terminal framing and Column consumers share its dispatch. The stashed
  // def.parent carries the element source, so the SAME elementGroupSource that built the
  // terminal group() tail rebuilds the source here — no re-derived from/ctx to drift.
  const src = elementGroupSource(def.parent, def.productiveBy);
  return continueLowering(lowerGroup(def.parent, def.isCount, def.modulators, src), stop + 1);
}
