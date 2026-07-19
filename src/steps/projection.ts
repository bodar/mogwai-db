import { q, value, list, empty, raw, Relation, Query, type Expression } from '../q.ts';
import { nodes, edges, labels, vertexProperties, edgeProperties } from '../schema.ts';
import { flattenListArgs } from '../frontend.ts';
import {
  predicateSql, rangeToOffsetLimit, elemCtx, extIdOf, jsonbGroupArray,
  nodePropScalar, edgePropScalar, nodePropSortKey, edgePropSortKey, framedProps, valueMapProps, storedValueExpr,
} from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { advance, carryFrag, carryFragMint, carriedCols, carriedWith, elemRel, withoutCarried, type ElementStream } from './context.ts';
import { carryOf, continueLowering, dispatchShapeTail, toListStream, toResultStream, toScalarStream, toVariantStream, type ListStream, type LoweringResult, type ResultStream, type ScalarStream, type ShapeTailFn } from './stream.ts';
import { tryLowerLocalAggregate, lowerScalarAggregate } from './sideeffect.ts';
import { type Shape } from '../render.ts';
import { lowerGlobalCount, lowerGlobalFold, lowerGlobalNumericReducer, type NumericReducer } from './barrier.ts';
import { lowerScalarFilter, lowerConstant, lowerScalarConstant, lowerScalarSack, lowerScalarSplit, collectionTypeOf, scalarCollectionRetype } from './scalar.ts';
import { compileSelectProject, lowerPath, lowerRecordSelectProject, lowerScalarProject, lowerSingleSelect } from './select.ts';
import { lowerMapScalar, lowerMath, lowerMathScalar, lowerFormat, lowerFormatScalar, lowerChooseOptions, lowerChooseOptionsScalar, tryLowerFlatMap, tryLowerListChild, tryLowerLocalElement, tryLowerMapElement } from './mapscalar.ts';
import { choose as lowerLegacyChoose, coalesce as lowerLegacyCoalesce, flatMap as lowerLegacyFlatMap, tryLowerListChoose, tryLowerListCoalesce, tryLowerListUnion, tryLowerScalarChoose, tryLowerScalarCoalesce, tryLowerScalarUnion, tryLowerVariantChoose, tryLowerVariantCoalesce, tryLowerVariantOptional, tryLowerVariantUnion, union as lowerLegacyUnion } from './branch.ts';
import { lowerGroup, lowerProperties, lowerValueMap, lowerScalarGroupCount, type GroupSource } from './group.ts';
import { childSteps, classifyListChild, classifyTotalScalarChild, isScalarChild, isListChild, isTotalScalarChild, ROOT_SCOPE, tryCompileCountChild, tryCompileListChild, tryCompileScalarValueRows, tryScalarChooseChild, tryScalarCoalesceChild, tryScalarFilterByChildExistence, tryScalarMapChild, tryScalarOptionalChild, tryScalarUnionChild, tryScalarVariantChoose, tryScalarVariantCoalesce, tryScalarVariantOptional, tryScalarVariantUnion } from './child.ts';
import { lowerElementDedup } from './filter.ts';

// ---------- tail: projection + barriers + modifiers ----------
//
// After the prefix fold lands the id-relation, the tail applies an optional
// projection (values/id/label/…/select/project) plus order()/range()/limit() and
// terminal reducers. group()/groupCount()/properties() are barriers that consume
// the whole stream into one shape, so they short-circuit before the generic tail.

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

/** The tail modifiers accumulated left-to-right (a pure fold — no sibling peeking;
 *  by() modulators already live on their host step via strategies.foldByModulators). */
export interface TailAcc {
  projStep: PStep | null;
  orders: OrderClause[];
  offset: number;
  limit: number | null;
  distinct: boolean;
  reducer: 'fold' | 'sum' | 'min' | 'max' | 'mean' | null; // terminal element reducer (fold→List / count guard)
  isPreds: any[];                  // is(P) after count() (count().is(P))
}

/** A TailAcc with no modifiers — the bare scalar projection case (no preceding
 *  order/limit/dedup) routes through lowerScalarProjection with this. */
const EMPTY_TAIL_ACC: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, reducer: null, isPreds: [] };

const PROJECTION_NAMES = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project', 'path']);
// Scalar-producing projections: one `v` value per row. foldTailAcc stops at one of these
// so the whole value tail (transforms/is/reducers/inject + framing) routes through the
// scalar pipeline (lowerScalarProjection → scalar.ts/barrier.ts), never this accumulator.
const SCALAR_PROJ = new Set(['values', 'id', 'label']);
const isMapProj = (p: PStep | null) => p?.name === 'select' || p?.name === 'project';
const isScopeLocalStep = (s: PStep | undefined): boolean =>
  !!s && (s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');
const NUMERIC_REDUCERS = new Set<NumericReducer>(['sum', 'min', 'max', 'mean']);

/** A tail modifier: fold the step into the accumulator. `at` gives position so a
 *  terminal reducer (fold/sum) can reject anything following it. */
type ModFn = (s: PStep, acc: TailAcc, at: { last: boolean; next?: string }) => void;

/** A re-enterable non-scalar projection (path/valueMap/elementMap) folds only these as
 *  its OWN tail modifiers; any other following step is a shape boundary routed to its
 *  compileFrom* arm. order() is deliberately absent — it defers. */
const REENTER_MODIFIERS = new Set(['dedup', 'limit', 'range', 'skip']);
const REENTERABLE_PROJ = new Set(['path', 'valueMap', 'elementMap']);

const MODIFIERS = new Map<string, ModFn>([
  ['order', (s, acc) => {
    // Each folded by() → one order clause; a bare order() sorts by identity.
    const bys = s.bys ?? [];
    if (bys.length === 0) { acc.orders.push({ key: null, dir: 'asc' }); return; }
    for (const byArgs of bys) {
      // Reject deferred modulators rather than let a {token}/{nested} arg fall
      // through to key=null and silently sort by id.
      const bad = byArgs.find((a: any) => a && typeof a === 'object' && ('token' in a || 'nested' in a));
      if (bad) throw new Error('token' in bad ? `by(T.${bad.token}) modulator not yet supported` : 'by(traversal) modulator not yet supported');
      const key = byArgs.find((a: any) => typeof a === 'string') ?? null;
      const ord = byArgs.find((a: any) => a && typeof a === 'object' && 'order' in a);
      acc.orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
    }
  }],
  ['range', (s, acc) => { ({ offset: acc.offset, limit: acc.limit } = rangeToOffsetLimit(s.args)); }],
  ['skip', (s, acc) => { acc.offset = Number(s.args[0]); }],
  ['limit', (s, acc) => { acc.limit = Number(s.args[0]); }],
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
export function foldTailAcc(steps: PStep[], from: number): { acc: TailAcc; stop: number } {
  const acc: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, reducer: null, isPreds: [] };
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
function isMapTypeOf(step: PStep): boolean {
  if (step.name !== 'is') return false;
  const pred = (step.args ?? [])[0];
  if (!pred || typeof pred !== 'object' || pred.op !== 'typeOf') return false;
  const arg = pred.values?.[0];
  const name = (arg && typeof arg === 'object' && 'gtype' in arg) ? String(arg.gtype) : typeof arg === 'string' ? arg : null;
  return !!name && name.toUpperCase() === 'MAP';
}

const hasColumnArg = (step: PStep): boolean =>
  (step.args ?? []).some((a: any) => a && typeof a === 'object' && (a.column === 'keys' || a.column === 'values'));

/** valueMap()/elementMap() followers. is(typeOf(MAP)) is identity (skip); count() counts
 *  the maps (one per element → count of elements); select(Column.*) re-types to the
 *  per-element MapStream that compileFromMap aggregates. Modifiers before the follower,
 *  and any other follower, defer. */
function lowerValueMapTail(st: ElementStream, proj: PStep, acc: TailAcc, steps: PStep[], at: number): LoweringResult {
  if (acc.orders.length || acc.reducer || acc.distinct || acc.offset || acc.limit !== null)
    throw new Error(`a modifier before a re-entered ${proj.name}() is not yet supported`);
  let i = at;
  while (i < steps.length && isMapTypeOf(steps[i])) i++; // is(typeOf(MAP)) = identity
  if (i >= steps.length) return continueLowering(buildProjection(st, acc), i); // terminal after identity is()
  const step = steps[i];
  if (step.name === 'count' && !isScopeLocalStep(step))
    return continueLowering(lowerGlobalCount(st), i + 1);
  if (step.name === 'select' && hasColumnArg(step))
    return continueLowering(lowerValueMap(st, proj), i);
  // select(label)/select(Pop, label): a valueMap has no as()-label of its own, so an
  // UNBOUND label selects nothing → empty (TinkerPop). A label bound earlier by as()
  // would need the map to carry path history — defer that.
  if (step.name === 'select') {
    const labels = (step.args ?? []).filter((a: any) => typeof a === 'string') as string[];
    if (labels.length && labels.every((l) => !st.carried.aliases.has(l))) {
      const rel = st.q.cte(q`SELECT NULL AS v WHERE 0`, ['v']);
      return continueLowering(toScalarStream(withoutCarried(carryOf(st)), rel, undefined), i + 1);
    }
    throw new Error('select(bound-label) after valueMap() not yet supported');
  }
  throw new Error(`${step.name}() cannot consume the ${proj.name} result shape`);
}

/** order().by(__.trav): sort elements by a per-traverser scalar computed through the SAME
 *  generic scalar child seam dedup().by(traversal) uses (tryCompileScalarValueRows +
 *  pushChildScope) — NOT a bespoke reader. The child's first value per traverser becomes the
 *  sort key; a fresh encounter (ROW_NUMBER over that key) rides forward, so materialization /
 *  a following limit observe the order. Single by(traversal) term; mixed/multi-term and
 *  path/encounter-tracking streams fall through to the key machinery (return null → defer). */
function lowerElementOrderByTraversal(st: ElementStream, step: PStep): ElementStream | null {
  const bys = step.bys ?? [];
  if (bys.length !== 1) return null;
  const nested = bys[0].find((a: any) => a && typeof a === 'object' && 'nested' in a)?.nested;
  if (!nested) return null; // a key/bare/token order — the acc.orders machinery handles it
  const dir = bys[0].find((a: any) => a && typeof a === 'object' && 'order' in a)?.order;
  if (dir === 'shuffle') return null;
  if (st.carried.encounter || st.carried.path)
    throw new Error('order().by(traversal) while tracking a path/encounter not yet supported');
  const rows = tryCompileScalarValueRows(st, nested);
  if (!rows?.stream.carried.encounter) throw new Error('order().by(traversal) requires a scalar child with encounter order');
  const c = rows.stream.rel.as('c');
  const ord = rows.frame.ordinal;
  // First child value per traverser (child cardinality >1 → the first by child encounter).
  const firstVal = st.q.cte(
    q`SELECT ${c.c[ord]} AS ord, ${c.c.v} AS k, ROW_NUMBER() OVER (PARTITION BY ${c.c[ord]} ORDER BY ${c.c[rows.stream.carried.encounter]}) AS rn FROM ${c}`,
    ['ord', 'k', 'rn'],
  );
  const d = rows.frame.domain.as('d');
  const f = firstVal.as('f');
  const dirSql = dir === 'desc' ? 'DESC' : 'ASC';
  return advance(
    st,
    q`SELECT ${d.c.id} AS id${carryFrag(st.carried, d)}, ROW_NUMBER() OVER (ORDER BY ${f.c.k} ${raw(dirSql)}, ${d.c.id}) AS encounter FROM ${d} LEFT JOIN ${f} ON ${f.c.ord}=${d.c[ord]} AND ${f.c.rn}=1`,
    { encounter: 'encounter' },
  );
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
  if (nested && isScalarChild(nested, st.params))
    return continueLowering(lowerMapScalar(st, steps, stop), stop + 1);
  throw new Error('local() child shape not yet supported by generic child lowering');
};

// flatMap consumes ALL productive rows from the same generic child compiler used by
// map(first). It lives at the shape-aware dispatcher rather than PREFIX because a scalar
// child changes ElementStream → ScalarStream.
const tailFlatMap: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const generic = tryLowerFlatMap(st, step);
  if (generic) return continueLowering(generic, stop + 1);
  return continueLowering(lowerLegacyFlatMap(step, st), stop + 1);
};

// A fold/count child is total per parent, so optional's identity-on-miss arm is statically
// unreachable. Non-total scalar children lower to the tagged scalar-or-original-element
// VariantStream. No match → null (the fallback foldTailAcc handles a plain element optional).
const tailOptional: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const nested = step.args[0]?.nested;
  const listPlan = classifyListChild(nested, st.params);
  if (listPlan) {
    const lowered = tryCompileListChild(st, nested, ROOT_SCOPE, listPlan.body);
    if (lowered) return continueLowering(lowered, stop + 1);
  }
  const countPlan = classifyTotalScalarChild(nested, st.params);
  if (countPlan) {
    const lowered = tryCompileCountChild(st, nested, ROOT_SCOPE, countPlan.body);
    if (lowered) return continueLowering(lowered, stop + 1);
  }
  const variant = tryLowerVariantOptional(step, st);
  return variant ? continueLowering(variant, stop + 1) : null;
};

// A union/choose/coalesce may change shape when arms are scalar/list/mixed. Homogeneous
// scalar arms concatenate as ScalarStream rows; otherwise the established element-only
// legacy lowerer remains authoritative and rejects mixed shapes.
const tailUnion: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const list = tryLowerListUnion(step, st);
  if (list) return continueLowering(list, stop + 1);
  const scalar = tryLowerScalarUnion(step, st);
  if (scalar) return continueLowering(scalar, stop + 1);
  const variant = tryLowerVariantUnion(step, st);
  if (variant) return continueLowering(variant, stop + 1);
  return continueLowering(lowerLegacyUnion(step, st), stop + 1);
};

// choose(): option-map form (choose().option()…) → a CASE over a correlated choice scalar;
// predicate form → the list/scalar/variant/legacy branch merge.
const tailChoose: ShapeTailFn<ElementStream> = (st, step, steps, stop) => {
  if (step.options) return continueLowering(lowerChooseOptions(st, steps, stop), stop + 1);
  const list = tryLowerListChoose(step, st);
  if (list) return continueLowering(list, stop + 1);
  const scalar = tryLowerScalarChoose(step, st);
  if (scalar) return continueLowering(scalar, stop + 1);
  const variant = tryLowerVariantChoose(step, st);
  if (variant) return continueLowering(variant, stop + 1);
  return continueLowering(lowerLegacyChoose(step, st), stop + 1);
};

const tailCoalesce: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const list = tryLowerListCoalesce(step, st);
  if (list) return continueLowering(list, stop + 1);
  const scalar = tryLowerScalarCoalesce(step, st);
  if (scalar) return continueLowering(scalar, stop + 1);
  const variant = tryLowerVariantCoalesce(step, st);
  if (variant) return continueLowering(variant, stop + 1);
  return continueLowering(lowerLegacyCoalesce(step, st), stop + 1);
};

// group()/groupCount() always lowers to one rich GroupStream. Root materialization frames
// it directly; supported Column consumers derive a narrow MapStream.
const tailGroup: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  const isCount = step.name === 'groupCount';
  const tbl = st.elem === 'edge' ? 'edges' : 'nodes';
  const ctx = elemCtx(elemRel(st), st.elem);
  const src: GroupSource = { from: `${tbl} n JOIN ${st.rel.name} p ON n.id=p.id`, ctx, elem: st.elem === 'edge' ? 'edge' : 'vertex', parent: st, productiveBy: step.productiveBy, bulk: st.carried.bulk ? st.rel.as('p').c[st.carried.bulk] : undefined };
  return continueLowering(lowerGroup(st, isCount, step.bys ?? [], src), stop + 1);
};

// A one-label select emits the labelled traverser itself (or its by(key) scalar), not a
// Map (retype immediately so later steps use common dispatch). Multi-label select() and
// every project() produce a per-traverser RecordStream (shared framing/field selection).
const tailSelectProject: ShapeTailFn<ElementStream> = (st, step, _steps, stop) => {
  if (step.name === 'select'
    && step.args.filter((a) => typeof a === 'string').length === 1
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

const TAIL = new Map<string, ShapeTailFn<ElementStream>>([
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
  ['constant', (st, step, _steps, stop) => continueLowering(lowerConstant(carryOf(st), st.rel, step.args), stop + 1)],
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
  ...[...SCALAR_PROJ].map((n): [string, ShapeTailFn<ElementStream>] => [n, tailScalarProj]),
]);

/** Compile the tail: `st` is the finished prefix state, `steps[stop]` the first step the
 *  prefix dispatch didn't consume. A recognized shape-changing step dispatches through
 *  TAIL; everything else (projection + modifiers) folds through compileTailFold. */
export function compileTail(st: ElementStream, steps: PStep[], stop: number): LoweringResult {
  return dispatchShapeTail(TAIL, st, steps, stop, compileTailFold);
}

/** The projection tail: accumulate the projection + value modifiers into a TailAcc, then
 *  render terminally or cross a retype boundary (fold→list, unfold, valueMap→map). */
function compileTailFold(st: ElementStream, steps: PStep[], stop: number): LoweringResult {
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
    return continueLowering(toScalarStream(withoutCarried(carryOf(st)), rel, result.shape.as), at);
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
function lowerScalarProjection(st: ElementStream, projStep: PStep, acc: TailAcc): ScalarStream {
  const n = elemRel(st);
  const l = labels.as('l');
  const p = st.rel.as('p');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projStep.name)!({ st, n, p, l, extId, vJoin, vlJoin, projStep });
  const asTag = proj.shape.kind === 'value' ? proj.shape.as : undefined;
  const vt = proj.vtypeExpr ? 'vtype' : undefined;
  const vtypeCol = proj.vtypeExpr ? q`, ${proj.vtypeExpr} AS vtype` : empty;
  const where = proj.baseWhere ? q` WHERE ${proj.baseWhere}` : empty;
  const origin = st.carried.origins.at(-1);

  // Child scope: a physical per-origin encounter partitions downstream scalar row ops.
  // Preceding element order/limit/dedup at a child scope defer (unreached in practice).
  if (origin) {
    if (acc.orders.length || acc.limit !== null || acc.offset > 0 || acc.distinct)
      throw new Error('order()/limit()/dedup() before a projection inside a child scope not yet supported');
    const carried = carriedWith(st.carried, { encounter: 'encounter' });
    const mint = q`ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${proj.encounterKey ?? p.c.id})`;
    const rel = st.q.cte(
      q`SELECT ${proj.colsNode}${vtypeCol}${carryFragMint(carried, p, 'encounter', mint)} FROM ${proj.fromNode}${where}`,
      ['v', ...(vt ? ['vtype'] : []), ...carriedCols(carried)],
    );
    return toScalarStream({ ...carryOf(st), carried }, rel, asTag, { result: 'value', vtype: vt });
  }

  // Root scope. An explicit order().by(key) mints the carried encounter; LIMIT/OFFSET
  // apply in this projection CTE. Otherwise an upstream carried encounter (e.g.
  // order().dedup()) rides through unchanged via carryFrag.
  if (acc.distinct) throw new Error('dedup() before a scalar projection not yet supported');
  const orderExprs = acc.orders.map((o) => {
    if (o.dir === 'shuffle') return q`RANDOM()`;
    const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
    if (o.key !== null) return q`${nodePropOrderKey(st)(o.key)}${dir}`;
    return q`${proj.scalarExpr ?? p.c.id}${dir}`;
  });
  const hasNewEncounter = orderExprs.length > 0;
  // A pre-existing carried encounter (seeded by the emission-order demand pass) is SUPERSEDED
  // by order().by(key) — carryFragMint re-mints it in its declared slot below. Only a live path
  // still defers (order() before a projection while tracking a path is not yet supported).
  if (hasNewEncounter && st.carried.path)
    throw new Error('order() before a projection while tracking a path not yet supported');
  const hasLimit = acc.limit !== null || acc.offset > 0;
  // The ROW_NUMBER window already captures order (materializeScalarRoot sorts by the
  // encounter); an outer ORDER BY is only needed so LIMIT/OFFSET picks the right slice.
  const orderNode = hasNewEncounter && hasLimit ? q` ORDER BY ${list(orderExprs, ', ')}` : empty;
  const limitNode = hasLimit ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  if (hasNewEncounter) {
    // order().by(key) SUPERSEDES the carried encounter (fresh ROW_NUMBER) in its declared slot.
    const carried = carriedWith(st.carried, { encounter: 'encounter' });
    const mint = q`ROW_NUMBER() OVER (ORDER BY ${list(orderExprs, ', ')})`;
    const rel = st.q.cte(
      q`SELECT ${proj.colsNode}${vtypeCol}${carryFragMint(carried, p, 'encounter', mint)} FROM ${proj.fromNode}${where}${orderNode}${limitNode}`,
      ['v', ...(vt ? ['vtype'] : []), ...carriedCols(carried)],
    );
    return toScalarStream({ ...carryOf(st), carried }, rel, asTag, { result: 'value', vtype: vt });
  }
  const rel = st.q.cte(
    q`SELECT ${proj.colsNode}${vtypeCol}${carryFrag(st.carried, p)} FROM ${proj.fromNode}${where}${orderNode}${limitNode}`,
    ['v', ...(vt ? ['vtype'] : []), ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel, asTag, { result: 'value', vtype: vt });
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
  if (acc.reducer || acc.isPreds.length || acc.distinct || acc.offset || acc.limit !== null)
    throw new Error('dedup()/limit()/range()/is() before a non-terminal fold() not yet supported');
  if (st.carried.aliases.size || st.carried.path || st.carried.origins.length)
    throw new Error('fold() carrying as()/path()/branch state into a list value not yet supported');
  // A global fold is a barrier: every traverser collapses into ONE list value, so carried
  // bulk (and any other per-traverser state) is consumed here — the list is a fresh bulk-1
  // traverser (an unfold later re-enumerates its members).
  const carry = withoutCarried(carryOf(st));
  const projName = acc.projStep?.name;
  // A single bare order() before the fold sorts the folded elements by their projected
  // scalar value (values('x').order().fold() → a sorted list). Only the by-nothing /
  // direction-only form on a scalar projection is supported; order().by(key/traversal)
  // and element-stream order-before-fold defer.
  let orderDir: 'asc' | 'desc' | null = null;
  if (acc.orders.length) {
    if (acc.orders.length > 1 || acc.orders[0].key !== null || acc.orders[0].dir === 'shuffle')
      throw new Error('order().by(key/traversal) before a non-terminal fold() not yet supported');
    if (!projName) throw new Error('order() before a non-terminal fold() of an element stream not yet supported');
    orderDir = acc.orders[0].dir === 'desc' ? 'desc' : 'asc';
  }
  if (!projName) {
    // Element list: fold the bare rowids; unfold/framing rejoins nodes/edges.
    const rel = st.q.cte(q`SELECT ${jsonbGroupArray(q`p.id`)} AS list FROM ${st.rel.as('p')}`, ['list']);
    return toListStream(carry, rel, { kind: 'elem', elem: st.elem });
  }
  if (projName === 'values' || projName === 'id' || projName === 'label') {
    const n = elemRel(st);
    const p = st.rel.as('p');
    const l = labels.as('l');
    const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
    const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
    const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const proj = PROJECTORS.get(projName)!({ st, n, p, l, extId, vJoin, vlJoin, projStep: acc.projStep });
    // values() drops missing-property elements (baseWhere = IS NOT NULL), matching
    // TinkerPop's fold-of-values. id/label have no baseWhere.
    const where = proj.baseWhere ? q` WHERE ${proj.baseWhere}` : empty;
    const arr = orderDir
      ? q`jsonb(json_group_array(${proj.scalarExpr!} ORDER BY ${proj.scalarExpr!} ${orderDir === 'desc' ? 'DESC' : 'ASC'}))`
      : jsonbGroupArray(proj.scalarExpr!);
    const rel = st.q.cte(q`SELECT ${arr} AS list FROM ${proj.fromNode}${where}`, ['list']);
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
// A list-collection step (set-op / conjoin / all / any) requires a list traverser;
// reached on a scalar stream it raises TinkerPop's incoming-type error.
const SCALAR_LIST_ONLY = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product', 'conjoin', 'all', 'any']);

// is(typeOf(LIST|SET)) RETYPES a scalar value stream into a ListStream: the stored
// collection value becomes the `list` column, so unfold/count(Scope.local)/range/project
// all reuse the list substrate (List.feature). A stored non-matching row is filtered out; a
// computed scalar (no stored vtype) can't be a collection, so it falls through to the
// generic is() fold. MAP is NOT retyped (no MapStream unfold yet) → returns null so is()
// stays a scalar vtype filter; a bare map value still frames whole via case 'value'.
const scalarIsListRetype: ShapeTailFn<ScalarStream> = (s, step, _steps, at) => {
  const kind = collectionTypeOf(step);
  if (kind !== 'list' && kind !== 'set') return null;
  const listed = scalarCollectionRetype(s, kind);
  return listed ? continueLowering(listed, at + 1) : null;
};

const scalarListOnly: ShapeTailFn<ScalarStream> = (_s, step) => {
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
  (step.args ?? []).length === 0 && !(step.bys?.length) ? continueLowering(lowerScalarGroupCount(s), at + 1) : null;

/**
 * V()/E() after a SCALAR: a mid-traversal graph source. TinkerPop's GraphStep(isStart=false)
 * discards the incoming value and re-sources the graph per traverser — V() all vertices, V(id…)
 * the id-matched ones — so it is a flatMap (CROSS JOIN the scalar rows with the target table).
 * The carried schema (as()-labels) rides forward on the join, so `inject(1).as('a').V()…` keeps
 * its label. A pushed child ordinal (origins) rides through the CROSS JOIN unchanged via
 * carryFrag — so re-sourcing INSIDE a scalar child scope (a branch/map arm `__.V().count()`)
 * is fine: the re-sourced elements carry the parent ordinal and a following scoped reducer/fold
 * groups by it. Defers (null) only for path/sack/fromV, whose fork/merge through a re-source is
 * not worked out.
 */
export function lowerScalarVE(s: ScalarStream, step: PStep): ElementStream | null {
  if (s.carried.path || s.carried.sack || s.carried.fromV) return null;
  const elem: 'node' | 'edge' = step.name === 'E' ? 'edge' : 'node';
  const n = (elem === 'edge' ? edges : nodes).as('n');
  const p = s.rel.as('p');
  const cols = carriedCols(s.carried);
  const rawIds = flattenListArgs(step.args ?? []);
  let where: Expression = empty;
  if (rawIds.length) {
    const nums = rawIds.filter((a) => typeof a === 'number');
    const strs = rawIds.filter((a) => typeof a === 'string');
    const clauses: Expression[] = [];
    if (nums.length) clauses.push(q`${n.c.id} IN (${list(nums.map(value), ',')})`);
    if (strs.length) clauses.push(q`${n.c.uid} IN (${list(strs.map(value), ',')})`);
    where = clauses.length ? q` WHERE ${list(clauses, ' OR ')}` : q` WHERE 0`; // only-null ids → no match
  }
  const rel = s.q.cte(
    q`SELECT ${n.c.id} AS id${carryFrag(s.carried, p)} FROM ${p} CROSS JOIN ${n}${where}`,
    ['id', ...cols],
  );
  return { ...carryOf(s), kind: 'elements', rel, elem };
}

/** Wrap a scalar-parent branch consumer (child.ts) as a ShapeTailFn: a produced stream
 *  continues lowering; a null (arm outside the scalar-arm vocabulary) falls through to the
 *  generic scalar deferral. */
const scalarBranch = (fn: (s: ScalarStream, step: PStep) => ScalarStream | null): ShapeTailFn<ScalarStream> =>
  (s, step, _steps, at) => { const r = fn(s, step); return r ? continueLowering(r, at + 1) : null; };

const SCALAR_TAIL = new Map<string, ShapeTailFn<ScalarStream>>([
  ['is', scalarIsListRetype],
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
  // V()/E() after a scalar re-source the graph per traverser (a flatMap → ElementStream).
  ['V', (s, step, _steps, at) => { const r = lowerScalarVE(s, step); return r ? continueLowering(r, at + 1) : null; }],
  ['E', (s, step, _steps, at) => { const r = lowerScalarVE(s, step); return r ? continueLowering(r, at + 1) : null; }],
  // Branch/map over a scalar current object: each arm is a value sub-traversal lowered
  // through the same engine, gated + UNION-merged (child.ts tryScalar*Child). A miss
  // (arm outside the scalar-arm vocabulary) returns null → the clear generic deferral.
  // choose: predicate form → gated UNION arms; option-map form (choose(fn).option(k,body)…)
  // → a CASE over the value through the modulation seam.
  ['choose', (s, step, steps, at) => {
    const r = step.options ? lowerChooseOptionsScalar(s, steps, at)
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

export function compileFromScalar(s: ScalarStream, steps: PStep[], from: number): LoweringResult {
  // Every scalar row op (transforms/is/order/limit/skip/range/tail/dedup/inject) and every
  // Scope.local case is consumed by lowerScalarRows before we reach here, and SCALAR_TAIL
  // owns the barriers (count/reducers/fold/unfold/filter/constant/sack). So a miss is
  // unsupported — fail closed with a precise message (this is why the scalar tail no
  // longer needs foldTailAcc/renderProjection).
  return dispatchShapeTail(SCALAR_TAIL, s, steps, from, () => {
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
  st: ElementStream; n: Relation; p: Relation; l: Relation; extId: Expression;
  vJoin: Expression; vlJoin: Expression;
  projStep: PStep | null;
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
        shape: { kind: 'value' }, colsNode: q`${storedValueExpr(ep.c.value, ep.c.vtype)} AS v`,
        fromNode: q`${c.vJoin} JOIN ${ep} ON ${ep.c.edge}=${c.n.c.id} AND ${ep.c.key}=${value(key)}`,
        scalarExpr: ep.c.value, baseWhere: null, encounterKey: q`${c.p.c.id}, ${ep.c.id}`, vtypeExpr: ep.c.vtype,
      };
    }
    const vp = vertexProperties.as('vp');
    return {
      shape: { kind: 'value' }, colsNode: q`${storedValueExpr(vp.c.value, vp.c.vtype)} AS v`,
      fromNode: q`${c.vJoin} JOIN ${vp} ON ${vp.c.node}=${c.n.c.id} AND ${vp.c.key}=${value(key)}`,
      scalarExpr: vp.c.value, baseWhere: null, encounterKey: q`${c.p.c.id}, ${vp.c.id}`, vtypeExpr: vp.c.vtype,
    };
  }],
  ['id', (c) => ({
    // Join the element table even though the id lives in `rel`, so a preceding
    // order().by(key) — which references n.props — has the alias in scope.
    shape: { kind: 'value' }, colsNode: q`${c.extId} AS v`, fromNode: c.vJoin, scalarExpr: c.extId, encounterKey: c.p.c.id,
  })],
  ['label', (c) => ({
    shape: { kind: 'value' }, colsNode: q`${c.l.c.name} AS v`, fromNode: c.vlJoin, scalarExpr: c.l.c.name, encounterKey: c.p.c.id,
  })],
  ['valueMap', (c) => {
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    // valueMap props are ALWAYS {key:[values]} (node: multi from the table; edge: each
    // flat value wrapped in a 1-list) so the handler frames both uniformly.
    return {
      shape: { kind: 'valueMap', keys: keys.length ? keys : null, tokens: c.projStep!.args.includes(true) },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${valueMapProps(c.n, c.st.elem)} AS props`, fromNode: c.vlJoin,
    };
  }],
  ['elementMap', (c) => {
    if (c.st.elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'elementMap', keys: keys.length ? keys : null },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${valueMapProps(c.n, c.st.elem)} AS props`, fromNode: c.vlJoin,
    };
  }],
  ['__element', (c) => c.st.elem === 'edge'
    // Endpoints resolve to external ids (COALESCE(uid,id)) so a materialized edge
    // reports the SAME src/tgt as the write path — not the raw rowid.
    ? { shape: { kind: 'edge' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${extIdOf(c.n.c.src)} AS src, ${extIdOf(c.n.c.tgt)} AS tgt, ${framedProps(c.n, 'edge')} AS props`, fromNode: c.vlJoin }
    : { shape: { kind: 'vertex' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${framedProps(c.n, 'node')} AS props`, fromNode: c.vlJoin }],
]);

/** An order().by(key) resolver over the current element (aliased `n`): node → the
 *  first-under-multi value from vertex_properties; edge → the single value from
 *  edge_properties. Uses the vtype-aware SORT KEY (compareKey) so a TEXT-stored big
 *  long/bigdecimal/duration orders numerically, not lexically. Shared by buildProjection
 *  and compileMath — both sort a value tail by an element prop. */
export const nodePropOrderKey = (st: ElementStream) => (key: string): Expression =>
  st.elem === 'edge' ? edgePropSortKey(raw('n.id'), key) : nodePropSortKey(raw('n.id'), key);

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
    const inner = q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${st.rel}`;
    const innerLim = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(q`v`, pr)), ' AND ')}`;
    return toResultStream(st.q, countNode, { kind: 'count' });
  }

  const n = elemRel(st);
  const p = st.rel.as('p');
  const l = labels.as('l');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projName)!({ st, n, p, l, extId, vJoin, vlJoin, projStep: acc.projStep });

  // order().by(key) sorts by an element property; a bare order() by n.id; else an upstream
  // carried encounter (an ordered dedup) fixes the result order.
  let keyNodes: Expression[] = [];
  if (acc.orders.length) {
    keyNodes = acc.orders.map((o) => {
      if (o.dir === 'shuffle') return q`RANDOM()`;
      const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
      return o.key !== null ? q`${nodePropOrderKey(st)(o.key)}${dir}` : q`n.id${dir}`;
    });
  } else if (st.carried.encounter) keyNodes = [q`${p.c[st.carried.encounter]}`];
  const orderNode = keyNodes.length ? q` ORDER BY ${list(keyNodes, ', ')}` : empty;
  const limitNode = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;
  // Under movementCollapse a bare vertex/edge leaf carries the collapsed multiplicity out to
  // the wire: emit the carried `bulk` column so framing reads it as the per-value multiplicity
  // (framedResults picks up a `bulk` column wherever present — bulk is orthogonal to shape, not
  // a Shape variant). Only when collapse is active; else the projection is unchanged.
  const wantBulk = !!st.fastPaths?.movementCollapse && !!st.carried.bulk && !reducer && !distinct
    && (proj.shape.kind === 'vertex' || proj.shape.kind === 'edge');

  // Bulk-aware limit/range: slicing a COLLAPSED leaf must count TRAVERSERS, not rows. A cumulative-
  // bulk window over the sort order gives each row the count of traversers preceding it (`pre`); the
  // row covers [pre, pre+bulk), clamped to the [offset, offset+limit) band, so the boundary rows'
  // multiplicity is trimmed and out-of-band rows drop. chainCollapseSafe only admits limit/range
  // AFTER an order, so keyNodes is populated. (order()-without-slice needs no window — the sorted
  // (v, N) rows already frame correctly, the client expanding each in place.)
  if (wantBulk && (limit !== null || offset > 0)) {
    const b = p.c[st.carried.bulk!];
    const lo = offset;
    const hi = limit !== null ? offset + limit : null; // exclusive upper traverser index (null = unbounded)
    const win = list(keyNodes.length ? keyNodes : [q`n.id`], ', ');
    const inner = q`SELECT ${proj.colsNode}, ${b} AS bulk, SUM(${b}) OVER (ORDER BY ${win} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) - ${b} AS pre FROM ${proj.fromNode}`;
    const upper = hi !== null ? q`MIN(pre + bulk, ${hi})` : q`(pre + bulk)`;
    const conds = [q`pre + bulk > ${lo}`];
    if (hi !== null) conds.push(q`pre < ${hi}`);
    const outCols = proj.shape.kind === 'edge' ? 'id, label, src, tgt, props' : 'id, label, props';
    const windowed = q`SELECT ${raw(outCols)}, (${upper} - MAX(pre, ${lo})) AS bulk FROM (${inner}) WHERE ${list(conds, ' AND ')} ORDER BY pre`;
    return toResultStream(st.q, windowed, proj.shape);
  }

  const bulkCol = wantBulk ? q`, ${p.c[st.carried.bulk!]} AS bulk` : empty;
  const tailNode = q`SELECT ${distinct ? 'DISTINCT ' : ''}${proj.colsNode}${bulkCol} FROM ${proj.fromNode}${orderNode}${limitNode}`;

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

/** bare sack() — read the carried per-traverser sack column (context.ts Carry.sack)
 *  as a scalar value, then run the shared value tail (a trailing sum()/dedup/order/is
 *  composes). The value's GraphBinary type is inferred (as:undefined → anySerializer),
 *  matching values(): sack holds whatever the withSack seed / sack(op) arithmetic
 *  produced (int age, double weight, string label). */
function lowerSackRead(st: ElementStream, step: PStep): ScalarStream {
  if (!st.carried.sack) throw new Error('sack() requires withSack() or a preceding sack(Operator.x) step');
  if ((step.args ?? []).length) throw new Error('sack(argument) read form not supported (bare sack() only)');
  const p = st.rel.as('p');
  const rel = st.q.cte(
    q`SELECT ${p.c[st.carried.sack]} AS v${carryFrag(st.carried, p)} FROM ${p}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
}

/** cap('x') — emit a named side-effect collection. A list/variant aggregate is ONE
 *  collection traverser; only an explicit following unfold() emits its members. A group
 *  side-effect (group('a')/groupCount('a')) re-runs lowerGroup over its stashed
 *  source → one GroupStream (steps/group.ts). Deferred: multi-key cap('x','y'). */
// cap('x') reads a named side-effect. It only touches `sideEffects` + the shared carry, so it
// is shape-agnostic (a scalar stream that registered an aggregate reads it identically); only
// the group('a') re-emit needs the element parent that stashed it.
function compileCap(st: ElementStream | ScalarStream, steps: PStep[], stop: number): LoweringResult {
  const names = (steps[stop].args ?? []).filter((a: any) => typeof a === 'string');
  if (names.length !== 1) throw new Error('cap() with multiple side-effect keys not yet supported');
  const def = st.sideEffects?.get(names[0]);
  if (!def) throw new Error(`cap('${names[0]}') references an undefined side-effect`);
  // cap() yields the accumulated side-effect COLLECTION as one fresh traverser — the
  // barrier-built list/variant rel carries no per-traverser bulk, so reset the carry.
  if (def.kind === 'list') {
    const ls = toListStream(withoutCarried(carryOf(st)), def.rel, def.of);
    return continueLowering(ls, stop + 1);
  }
  if (def.kind === 'variant')
    return continueLowering(toVariantStream(withoutCarried(carryOf(st)), def.rel, { scalarAs: def.scalarAs, node: def.elem === 'node' || undefined, edge: def.elem === 'edge' || undefined }, 'list'), stop + 1);
  // group('a')/groupCount('a') side-effect → re-emit the same rich GroupStream as an
  // inline group; terminal framing and Column consumers share its dispatch. The stashed
  // def.parent carries the element source, so a scalar-stream cap of a group re-runs correctly.
  const src: GroupSource = { from: def.from, ctx: def.ctx, elem: def.elem, parent: def.parent, productiveBy: def.productiveBy, bulk: def.parent.carried.bulk ? def.parent.rel.as('p').c[def.parent.carried.bulk] : undefined };
  return continueLowering(lowerGroup(def.parent, def.isCount, def.bys, src), stop + 1);
}
