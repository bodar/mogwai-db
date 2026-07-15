import { q, value, list, empty, raw, Relation, Query, type Expression } from '../q.ts';
import { labels, vertexProperties } from '../schema.ts';
import {
  propExtract, predicateSql, rangeToOffsetLimit, elemCtx, scalarTx, extIdOf, jsonbGroupArray,
  nodePropScalar, framedProps, valueMapProps,
} from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, elemRel, type ElementStream } from './context.ts';
import { carryOf, continueLowering, toListStream, toScalarStream, toVariantStream, type ListStream, type LoweringResult, type ScalarStream } from './stream.ts';
import { tryLowerLocalAggregate } from './sideeffect.ts';
import {
  type Compiled, type Shape, type ElemShape,
} from '../render.ts';
import { materializeRoot, materializeScalarRoot } from './materialize.ts';
import { lowerGlobalCount, lowerGlobalFold, lowerGlobalNumericReducer, type NumericReducer } from './barrier.ts';
import { SCALAR_ROW_STEPS } from './scalar.ts';
import { numericSpec, asNumberSql, asDateSql, dtFactor, dateDiffOtherMs } from './coerce.ts';
import { compileSelectProject, lowerPath, lowerRecordSelectProject, lowerSingleSelect } from './select.ts';
import { lowerMapScalar, lowerMath, lowerFormat, lowerChooseOptions, tryLowerFlatMap, tryLowerListChild, tryLowerLocalElement, tryLowerMapElement } from './mapscalar.ts';
import { choose as lowerLegacyChoose, coalesce as lowerLegacyCoalesce, flatMap as lowerLegacyFlatMap, tryLowerListChoose, tryLowerListCoalesce, tryLowerListUnion, tryLowerScalarChoose, tryLowerScalarCoalesce, tryLowerScalarUnion, tryLowerVariantOptional, union as lowerLegacyUnion } from './branch.ts';
import { lowerGroup, lowerProperties, type GroupSource } from './group.ts';
import { isScalarChild, isListChild, isTotalScalarChild, tryCompileCountChild, tryCompileListChild } from './child.ts';
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
  reducer: 'fold' | 'sum' | 'min' | 'max' | 'mean' | null; // terminal stream reducer applied after the projection
  isPreds: any[];                  // is(P) filters on the projected scalar (AND'd)
  transforms: PStep[];             // scalar string/cast transforms wrapping the projected scalar, in order
  injects: any[];                  // constants appended to the value stream (values(k).inject(c))
  localMean: boolean;              // mean(Scope.local) on a scalar stream → coerce each value to Double
}

const PROJECTION_NAMES = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project', 'path']);
// Scalar-producing projections: one `v` value per row. A chain that continues past one
// of these (e.g. into count()) retypes to a ScalarStream and re-enters (compileTail).
const SCALAR_PROJ = new Set(['values', 'id', 'label']);
// Per-value transform steps gathered into acc.transforms. Most are SQL scalar
// expressions (scalarTx). `asBool` is a typed cast: compileInject resolves it over
// inject constants (see asBoolConst); on a V/E-rooted stream it falls through to
// scalarTx → undefined → a clean "not supported" defer (needs local()/sack()).
const SCALAR_TX_NAMES = new Set(['concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace', 'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);
const isMapProj = (p: PStep | null) => p?.name === 'select' || p?.name === 'project';
const isScopeLocalStep = (s: PStep | undefined): boolean =>
  !!s && (s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');
const NUMERIC_REDUCERS = new Set<NumericReducer>(['sum', 'min', 'max', 'mean']);

/** A tail modifier: fold the step into the accumulator. `at` gives position so a
 *  terminal reducer (fold/sum) can reject anything following it. */
type ModFn = (s: PStep, acc: TailAcc, at: { last: boolean; next?: string }) => void;

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
  const acc: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, reducer: null, isPreds: [], transforms: [], injects: [], localMean: false };
  let i = from;
  for (; i < steps.length; i++) {
    const s = steps[i];
    // Retype boundaries — the tail cannot fold past these; the caller builds the next
    // Stream (stream.ts) and yields back to lowerSteps (index.ts):
    //  · unfold — a list value → its element/scalar stream.
    //  · a NON-terminal fold — the stream → one list value (set-ops sit here later).
    //    A TERMINAL fold (last step) stays the current reducer below, byte-identical.
    if (s.name === 'unfold') break;
    if (s.name === 'fold' && i !== steps.length - 1) break;
    // Scope.local means "per-element WITHIN a list". Reached HERE (element/scalar
    // tail, NOT the list phase), each traverser is a scalar — a degenerate one-element
    // list — so the local reduce operates on that single value, correct BY DESIGN
    // (not the global form, which would differ for a multi-element stream). A scalar's
    // local sum/min/max/order/dedup is the value itself (identity → skip the step);
    // mean coerces to Double (mean is always Double, even of one value). Scalar
    // TRANSFORMS (concat/length/toLower/…) already treat Scope.local as a no-op — the
    // project relies on this (see the inject().length(Scope.local) test), so they fall
    // through to their own handler. Ops whose scalar-local form isn't yet worked out
    // (count→1, limit/range/tail/skip) fail closed rather than run the global form.
    if (!SCALAR_TX_NAMES.has(s.name) && (s.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local')) {
      if (s.name === 'sum' || s.name === 'min' || s.name === 'max' || s.name === 'order' || s.name === 'dedup') continue; // identity
      if (s.name === 'mean') { acc.localMean = true; continue; }
      throw new Error(`${s.name}(Scope.local) requires a preceding list-producing step (e.g. fold())`);
    }
    if (PROJECTION_NAMES.has(s.name)) {
      if (acc.projStep) throw new Error('only one projection step is supported per traversal');
      acc.projStep = s;
      continue;
    }
    // inject(c…) after a value projection appends constants to the value stream.
    if (s.name === 'inject') { acc.injects.push(...s.args); continue; }
    // A scalar string/cast transform (concat/length/…) wraps the projected scalar.
    if (SCALAR_TX_NAMES.has(s.name)) { acc.transforms.push(s); continue; }
    const mod = MODIFIERS.get(s.name);
    if (!mod) throw new Error(`step not implemented: ${s.name}()`);
    mod(s, acc, { last: i === steps.length - 1, next: steps[i + 1]?.name });
  }
  return { acc, stop: i };
}

/** Compile the tail: `st` is the finished prefix state, `steps[stop]` the first
 *  step the prefix dispatch didn't consume. */
export function compileTail(st: ElementStream, steps: PStep[], stop: number): LoweringResult {

  // order().[barrier()].dedup().by(): lower both observations as one window
  // policy so the representative is chosen by explicit encounter order.
  if (steps[stop]?.name === 'order') {
    const dedupAt = steps[stop + 1]?.name === 'barrier' ? stop + 2 : stop + 1;
    if (steps[dedupAt]?.name === 'dedup')
      return continueLowering(lowerElementDedup(st, steps[dedupAt], steps[stop]), dedupAt + 1);
  }

  // A direct global count is a stream transition even when terminal. Forms with
  // preceding tail modifiers (order().limit().count()) still use the compatibility
  // accumulator until those operators migrate to stepwise lowering.
  if (steps[stop]?.name === 'count' && !isScopeLocalStep(steps[stop])) {
    const out = lowerGlobalCount(st);
    if (stop + 1 < steps.length) return continueLowering(out, stop + 1);
    return materializeScalarRoot(out);
  }

  // properties() turns the traverser into a relational PropertyStream. Property-
  // specific followers dispatch there; key/value/element re-enter common streams.
  if (steps[stop]?.name === 'properties')
    return continueLowering(lowerProperties(st, steps[stop]), stop + 1);

  // option-map choose (choose().option()…) → a CASE over a correlated choice scalar.
  if (steps[stop]?.name === 'choose' && steps[stop].options)
    return continueLowering(lowerChooseOptions(st, steps, stop), stop + 1);

  // map(__.<scalar>) → a per-traverser scalar projection (out-degree, a property, a
  // label). Element-body map (first-result-only) and select/fold bodies defer.
  // map(__.<scalar>) and a scalar-reduction local(__.<…count/sum/…>) are the same
  // per-element scalar projector (local's element+barrier body compiles as a prefix
  // step; only its scalar-reduction body reaches the tail here).
  if (steps[stop]?.name === 'map') {
    const element = tryLowerMapElement(st, steps[stop]);
    if (element) return continueLowering(element, stop + 1);
    const list = tryLowerListChild(st, steps[stop]);
    if (list) return continueLowering(list, stop + 1);
    return continueLowering(lowerMapScalar(st, steps, stop), stop + 1);
  }
  if (steps[stop]?.name === 'local') {
    const sideEffect = tryLowerLocalAggregate(st, steps[stop]);
    if (sideEffect) return continueLowering(sideEffect, stop + 1);
    const list = tryLowerListChild(st, steps[stop]);
    if (list) return continueLowering(list, stop + 1);
    const element = tryLowerLocalElement(st, steps[stop]);
    if (element) return continueLowering(element, stop + 1);
    const nested = steps[stop].args[0]?.nested;
    if (nested && isScalarChild(nested, st.params))
      return continueLowering(lowerMapScalar(st, steps, stop), stop + 1);
    throw new Error('local() child shape not yet supported by generic child lowering');
  }

  // flatMap consumes ALL productive rows from the same generic child compiler used
  // by map(first). It lives at the shape-aware dispatcher rather than PREFIX because
  // a scalar child changes ElementStream → ScalarStream.
  if (steps[stop]?.name === 'flatMap') {
    const generic = tryLowerFlatMap(st, steps[stop]);
    if (generic) return continueLowering(generic, stop + 1);
    return continueLowering(lowerLegacyFlatMap(steps[stop], st), stop + 1);
  }

  // A fold/count child is total per parent, so optional's identity-on-miss arm is
  // statically unreachable. Non-total scalar children lower to the tagged
  // scalar-or-original-element VariantStream.
  if (steps[stop]?.name === 'optional') {
    const nested = steps[stop].args[0]?.nested;
    if (nested && isListChild(nested, st.params))
      return continueLowering(tryCompileListChild(st, nested)!, stop + 1);
    if (nested && isTotalScalarChild(nested, st.params))
      return continueLowering(tryCompileCountChild(st, nested)!, stop + 1);
    const variant = tryLowerVariantOptional(steps[stop], st);
    if (variant) return continueLowering(variant, stop + 1);
  }

  // A union may change shape when every arm is scalar. Homogeneous scalar arms
  // concatenate as ScalarStream rows; otherwise the established element-only union
  // remains authoritative and rejects mixed shapes.
  if (steps[stop]?.name === 'union') {
    const list = tryLowerListUnion(steps[stop], st);
    if (list) return continueLowering(list, stop + 1);
    const scalar = tryLowerScalarUnion(steps[stop], st);
    if (scalar) return continueLowering(scalar, stop + 1);
    return continueLowering(lowerLegacyUnion(steps[stop], st), stop + 1);
  }

  if (steps[stop]?.name === 'choose' && !steps[stop].options) {
    const list = tryLowerListChoose(steps[stop], st);
    if (list) return continueLowering(list, stop + 1);
    const scalar = tryLowerScalarChoose(steps[stop], st);
    if (scalar) return continueLowering(scalar, stop + 1);
    return continueLowering(lowerLegacyChoose(steps[stop], st), stop + 1);
  }

  if (steps[stop]?.name === 'coalesce') {
    const list = tryLowerListCoalesce(steps[stop], st);
    if (list) return continueLowering(list, stop + 1);
    const scalar = tryLowerScalarCoalesce(steps[stop], st);
    if (scalar) return continueLowering(scalar, stop + 1);
    return continueLowering(lowerLegacyCoalesce(steps[stop], st), stop + 1);
  }

  // math("<formula>") → one SQL arithmetic scalar (always Double). Its variables
  // (`_` / as()-bound names) resolve through the by() modulators folded onto it.
  if (steps[stop]?.name === 'math')
    return continueLowering(lowerMath(st, steps, stop), stop + 1);

  // format("…%{token}…") → one `||`-concatenated SQL string (properties + by()s).
  if (steps[stop]?.name === 'format')
    return continueLowering(lowerFormat(st, steps, stop), stop + 1);

  // bare sack() reads the carried per-traverser sack column as a scalar value; a
  // trailing reducer (sum/…)/is/order composes via the shared value tail.
  if (steps[stop]?.name === 'sack')
    return continueLowering(lowerSackRead(st, steps[stop]), stop + 1);

  // cap('x') emits a named side-effect collection registered earlier in the chain.
  if (steps[stop]?.name === 'cap')
    return compileCap(st, steps, stop);

  // group()/groupCount() always lowers to one rich GroupStream. Root materialization
  // frames it directly; supported Column consumers derive a narrow MapStream.
  if (steps[stop]?.name === 'group' || steps[stop]?.name === 'groupCount') {
    const isCount = steps[stop].name === 'groupCount';
    const tbl = st.elem === 'edge' ? 'edges' : 'nodes';
    const ctx = elemCtx(elemRel(st), st.elem);
    const src: GroupSource = { from: `${tbl} n JOIN ${st.rel.name} p ON n.id=p.id`, ctx, elem: st.elem === 'edge' ? 'edge' : 'vertex', parent: st, productiveBy: steps[stop].productiveBy };
    return continueLowering(lowerGroup(st, isCount, steps[stop].bys ?? [], src), stop + 1);
  }

  // A one-label select emits the labelled traverser itself (or its by(key) scalar),
  // not a Map. Retype immediately so every later step uses common dispatch.
  if (steps[stop]?.name === 'select' &&
      steps[stop].args.filter((a) => typeof a === 'string').length === 1 &&
      !steps[stop].args.some((a) => a && typeof a === 'object' && 'column' in a))
    return continueLowering(lowerSingleSelect(st, steps[stop]), stop + 1);

  // Multi-label select() and every project() produce a per-traverser RecordStream.
  // Terminal framing and later field selection/counting now share this same lowering.
  if (steps[stop]?.name === 'select' || steps[stop]?.name === 'project')
    return continueLowering(lowerRecordSelectProject(st, steps[stop]), stop + 1);

  // A scalar-producing projection is always a real stream transition when another
  // step follows. The next step dispatches against ScalarStream, so composition no
  // longer depends on a terminal-tail special case (values().count().is(),
  // values().groupCount(), and future scalar consumers all cross the same seam).
  const scalarRest = steps.slice(stop + 1);
  const needsScalarBoundary = scalarRest.length > 0 && scalarRest.every((s) =>
    SCALAR_ROW_STEPS.has(s.name) && !isScopeLocalStep(s));
  if (SCALAR_PROJ.has(steps[stop]?.name) && needsScalarBoundary) {
    const n = elemRel(st);
    const l = labels.as('l');
    const p = st.rel.as('p');
    const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
    const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
    const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const proj = PROJECTORS.get(steps[stop].name)!({ st, n, l, extId, vJoin, vlJoin, projStep: steps[stop] });
    const where = proj.baseWhere ? q` WHERE ${proj.baseWhere}` : empty;
    const rel = st.q.cte(
      q`SELECT ${proj.colsNode}${carryFrag(st.carried, p)} FROM ${proj.fromNode}${where}`,
      ['v', ...carriedCols(st.carried)],
    );
    const asTag = proj.shape.kind === 'value' ? proj.shape.as : undefined;
    return continueLowering(toScalarStream(carryOf(st), rel, asTag), stop + 1);
  }

  // Tail fold: accumulate the projection + modifiers, stopping at a retype boundary
  // (unfold / a non-terminal fold).
  const { acc, stop: at } = foldTailAcc(steps, stop);

  // Consumed the whole chain → render terminally, exactly as before.
  if (at === steps.length) {
    if (acc.projStep?.name === 'path')
      return continueLowering(lowerPath(st, acc.projStep, acc), at);
    if (isMapProj(acc.projStep))
      return compileSelectProject(st, acc.projStep!, acc);
    return buildProjection(st, acc);
  }

  // Stopped at a retype boundary: steps[at] is `unfold` or a non-terminal `fold`.
  const boundary = steps[at].name;
  if (boundary === 'unfold') {
    // unfold() on an ELEMENT stream is identity (a vertex/edge is not a collection)
    // — continue from after it. Only the bare form (no projection/modifier consumed
    // first) is identity-safe; values().unfold() etc. defer.
    if (acc.projStep || acc.orders.length || acc.reducer || acc.isPreds.length || acc.transforms.length || acc.injects.length || acc.distinct || acc.offset || acc.limit !== null)
      throw new Error('unfold() after a projection/modifier on an element stream not yet supported');
    return continueLowering(st, at + 1);
  }
  // A non-terminal fold → a single list value; continue from the ListStream.
  return continueLowering(compileFold(st, acc), at + 1);
}

/**
 * A non-terminal fold(): collapse the element stream into ONE list value — a JSONB
 * array in a one-row relation (the list-value substrate; see stream.ts). An element
 * stream folds its bare rowids (rejoined on unfold/framing); a values/id/label
 * projection folds its scalar. Bare form only: an inner order()/dedup()/limit()/is()/
 * transform before the fold, a non-scalar projection (valueMap/select/path), or
 * aliases/path/origin riding through the retype all defer (clear throws). A TERMINAL
 * fold never reaches here — it stays the reducer path (byte-identical). The wasteful
 * roundtrip in fold().unfold() (materialize then json_each) is deliberate — correct
 * beats a peephole nobody's query needs (see the plan's decision log).
 */
function compileFold(st: ElementStream, acc: TailAcc): ListStream {
  if (acc.reducer || acc.isPreds.length || acc.transforms.length || acc.injects.length || acc.distinct || acc.offset || acc.limit !== null)
    throw new Error('dedup()/limit()/range()/is()/transform before a non-terminal fold() not yet supported');
  if (st.carried.aliases.size || st.carried.path || st.carried.origins.length)
    throw new Error('fold() carrying as()/path()/branch state into a list value not yet supported');
  const carry = carryOf(st);
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
    const proj = PROJECTORS.get(projName)!({ st, n, l, extId, vJoin, vlJoin, projStep: acc.projStep });
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
export function compileFromScalar(s: ScalarStream, steps: PStep[], from: number): LoweringResult {
  // A list-collection step (set-op / conjoin / all / any) requires a list traverser;
  // reached on a scalar stream it raises TinkerPop's incoming-type error.
  const LIST_ONLY = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product', 'conjoin', 'all', 'any']);
  if (LIST_ONLY.has(steps[from]?.name))
    throw new Error(`${steps[from].name} step can only take an array or an Iterable type for incoming traversers, encountered a scalar`);
  // count() is a barrier and therefore another ScalarStream transition, not a
  // terminal rendering decision. Keeping it relational lets any following scalar
  // filter/transform/reducer compile normally. The barrier drops row-associated
  // carried state because no single input row owns the global result.
  if (steps[from]?.name === 'count' && !isScopeLocalStep(steps[from])) {
    const out = lowerGlobalCount(s);
    if (from + 1 < steps.length) return continueLowering(out, from + 1);
    return materializeScalarRoot(out);
  }
  if (NUMERIC_REDUCERS.has(steps[from]?.name as NumericReducer) && !isScopeLocalStep(steps[from])) {
    const out = lowerGlobalNumericReducer(s, steps[from].name as NumericReducer);
    if (from + 1 < steps.length) return continueLowering(out, from + 1);
    return materializeScalarRoot(out);
  }
  if (steps[from]?.name === 'fold' && !isScopeLocalStep(steps[from]))
    return continueLowering(lowerGlobalFold(s), from + 1);
  // unfold() on a scalar is identity (a scalar is not a collection) — continue past it,
  // exactly as unfold() on an element stream. Lets aggregate('a').by(k).cap('a').unfold()
  // (an explicit cap().unfold() turns a by-key bag into a scalar stream) feed a following reducer.
  if (steps[from]?.name === 'unfold') return continueLowering(s, from + 1);
  const { acc, stop } = foldTailAcc(steps, from);
  if (stop !== steps.length) throw new Error(`${steps[stop].name}() after a scalar stream not yet supported`);
  if (s.result === 'count' && acc.reducer)
    throw new Error(`${acc.reducer}() after count() not yet supported`);
  if (acc.projStep) {
    if (acc.projStep.name !== 'count') throw new Error(`${acc.projStep.name}() requires element input (a scalar stream has no ${acc.projStep.name})`);
    const dist = acc.distinct ? 'DISTINCT ' : '';
    const whereNode = acc.isPreds.length ? q` WHERE ${list(acc.isPreds.map((p) => predicateSql(q`v`, p)), ' AND ')}` : empty;
    const limitNode = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
    return materializeRoot(s.q, q`SELECT COUNT(*) AS v FROM (SELECT ${dist}v FROM ${s.rel}${whereNode}${limitNode})`, { kind: 'count' });
  }
  // Row-preserving operators keep reducer semantics on the stream. In particular,
  // count().is(P) is still a Long count result rather than becoming an untyped value
  // merely because the predicate happened to be terminal.
  if (s.result !== 'value' && acc.transforms.length === 0 && acc.injects.length === 0) {
    const p = s.rel.as('p');
    const whereNode = acc.isPreds.length
      ? q` WHERE ${list(acc.isPreds.map((pr) => predicateSql(p.c.v, pr)), ' AND ')}`
      : empty;
    const orderNode = acc.orders.length ? q` ORDER BY ${p.c.v}` : empty;
    const limitNode = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
    const typeCol = s.result === 'number' ? q`, ${p.c.vt} AS vt` : empty;
    const rel = s.q.cte(
      q`SELECT ${acc.distinct ? 'DISTINCT ' : ''}${p.c.v} AS v${typeCol}${carryFrag(s.carried, p)} FROM ${p}${whereNode}${orderNode}${limitNode}`,
      [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...carriedCols(s.carried)],
    );
    return materializeScalarRoot(toScalarStream(carryOf(s), rel, s.as, s.result));
  }
  const proj: ProjResult = { shape: { kind: 'value', as: s.as }, colsNode: q`v AS v`, fromNode: s.rel, scalarExpr: q`v`, baseWhere: null };
  const orderKey = (): Expression => { throw new Error('order().by(key) on a scalar stream not supported (no properties)'); };
  return renderProjection(s.q, proj, acc, orderKey);
}

export interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

// ---------- projection resolution (values/id/label/valueMap/elementMap/element) ----------

interface ProjCtx {
  st: ElementStream; n: Relation; l: Relation; extId: Expression;
  vJoin: Expression; vlJoin: Expression;
  projStep: PStep | null;
}
export interface ProjResult { shape: Shape; colsNode: Expression; fromNode: Expression; scalarExpr?: Expression | null; baseWhere?: Expression | null; }
type ProjFn = (c: ProjCtx) => ProjResult;

const PROJECTORS = new Map<string, ProjFn>([
  ['values', (c) => {
    const key = c.projStep!.args[0] as string;
    // Node: values() is a genuine flatMap — JOIN vertex_properties so a multi-valued
    // key yields one row PER value (the INNER JOIN also drops missing-key vertices, so
    // no separate IS NOT NULL). Edge: json_extract the flat blob (single-valued).
    if (c.st.elem === 'edge') {
      const pe = propExtract(c.n.c.props, key).expr;
      return { shape: { kind: 'value' }, colsNode: q`${pe} AS v`, fromNode: c.vJoin, scalarExpr: pe, baseWhere: predicateSql(pe, undefined) };
    }
    const vp = vertexProperties.as('vp');
    return {
      shape: { kind: 'value' }, colsNode: q`${vp.c.value} AS v`,
      fromNode: q`${c.vJoin} JOIN ${vp} ON ${vp.c.node}=${c.n.c.id} AND ${vp.c.key}=${value(key)}`,
      scalarExpr: vp.c.value, baseWhere: null,
    };
  }],
  ['id', (c) => ({
    // Join the element table even though the id lives in `rel`, so a preceding
    // order().by(key) — which references n.props — has the alias in scope.
    shape: { kind: 'value' }, colsNode: q`${c.extId} AS v`, fromNode: c.vJoin, scalarExpr: c.extId,
  })],
  ['label', (c) => ({
    shape: { kind: 'value' }, colsNode: q`${c.l.c.name} AS v`, fromNode: c.vlJoin, scalarExpr: c.l.c.name,
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
 *  first-under-multi value from vertex_properties; edge → json_extract of the flat blob.
 *  Shared by buildProjection and compileMath — both sort a value tail by an element prop. */
export const nodePropOrderKey = (st: ElementStream) => (key: string): Expression =>
  st.elem === 'edge' ? propExtract('n.props', key).expr : nodePropScalar(raw('n.id'), key);

function buildProjection(st: ElementStream, acc: TailAcc): Compiled {
  const { distinct, offset, limit, isPreds, reducer } = acc;
  const projName = acc.projStep?.name ?? '__element';

  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    const inner = q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${st.rel}`;
    const innerLim = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(q`v`, pr)), ' AND ')}`;
    return materializeRoot(st.q, countNode, { kind: 'count' });
  }

  const n = elemRel(st);
  const p = st.rel.as('p');
  const l = labels.as('l');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projName)!({ st, n, l, extId, vJoin, vlJoin, projStep: acc.projStep });

  // order().by(key) sorts by a property expression (element context) — auto-index it.
  const encounter = st.carried.encounter ? p.c[st.carried.encounter] : undefined;
  return renderProjection(st.q, proj, acc, nodePropOrderKey(st), encounter);
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
function compileCap(st: ElementStream, steps: PStep[], stop: number): LoweringResult {
  const names = (steps[stop].args ?? []).filter((a: any) => typeof a === 'string');
  if (names.length !== 1) throw new Error('cap() with multiple side-effect keys not yet supported');
  const def = st.sideEffects?.get(names[0]);
  if (!def) throw new Error(`cap('${names[0]}') references an undefined side-effect`);
  if (def.kind === 'list') {
    const ls = toListStream(carryOf(st), def.rel, def.of);
    return continueLowering(ls, stop + 1);
  }
  if (def.kind === 'variant')
    return continueLowering(toVariantStream(carryOf(st), def.rel, def.scalarAs, def.elem, 'list'), stop + 1);
  // group('a')/groupCount('a') side-effect → re-emit the same rich GroupStream as an
  // inline group; terminal framing and Column consumers share its dispatch.
  const src: GroupSource = { from: def.from, ctx: def.ctx, elem: def.elem, parent: def.parent, productiveBy: def.productiveBy };
  return continueLowering(lowerGroup(st, def.isCount, def.bys, src), stop + 1);
}

/** Render a resolved projection + the value-shape tail (scalar transforms, is()
 *  filter, dedup, order, range/limit, inject-append, terminal reducer) into a
 *  Compiled. The single tail renderer shared by element projections (buildProjection)
 *  and the inject scalar stream (compileInject) — so a new value-tail behaviour is
 *  written once. `orderKey(key)` resolves an order().by(key) to a SQL expression in
 *  the caller's context (a property lookup for elements; a throw for a scalar stream
 *  that has no properties). Identity order uses `v` (value shape) or `n.id`. */
export function renderProjection(
  Q: Query, proj: ProjResult, acc: TailAcc,
  orderKey: (key: string) => Expression,
  fallbackOrder?: Expression,
): Compiled {
  const { orders, distinct, offset, limit, isPreds, reducer, injects } = acc;
  let { shape, colsNode, scalarExpr } = proj;

  // Scalar string/cast transforms (values('name').concat('X').toUpper()) wrap the
  // projected scalar; is()/order() then see the transformed value. Only a scalar
  // stream (values/id/label/inject) has a scalarExpr to transform. asNumber(GType.X)
  // is a typed cast: it wraps the scalar in a SQL CAST and tags the value shape so the
  // handler frames the right numeric subtype (a runtime value, e.g. values('float');
  // inject constants resolve in compileInject with overflow checks instead).
  if (acc.transforms.length) {
    if (!scalarExpr) throw new Error(`${acc.transforms[0].name}() requires a scalar stream (values/id/label)`);
    for (let i = 0; i < acc.transforms.length; i++) {
      const s = acc.transforms[i];
      if (s.name === 'asNumber') {
        const spec = numericSpec(s.args[0]); // throws on a non-numeric GType; null = bare
        if (spec) { scalarExpr = asNumberSql(spec, scalarExpr); shape = { kind: 'value', as: spec.as }; continue; }
        // bare asNumber() over a runtime scalar. A date → its epoch-millis (Long,
        // identity). Otherwise only valid as the ms-value leg of a date round-trip —
        // i.e. immediately feeding an asDate() (which overwrites the tag), where a
        // CAST to INTEGER is right. A standalone bare asNumber() over a runtime value
        // can't recover its subtype (fractional vs integral), so fail closed.
        if (shape.kind === 'value' && shape.as === 'date') { shape = { kind: 'value', as: 'long' }; continue; }
        if (acc.transforms[i + 1]?.name === 'asDate') { scalarExpr = q`CAST(${scalarExpr} AS INTEGER)`; shape = { kind: 'value', as: 'long' }; continue; }
        throw new Error('bare asNumber() over a non-date runtime value not yet supported');
      }
      if (s.name === 'asDate') { scalarExpr = asDateSql(scalarExpr); shape = { kind: 'value', as: 'date' }; continue; }
      if (s.name === 'dateAdd') { scalarExpr = q`(${scalarExpr} + ${value(Number(s.args[1]) * dtFactor(s.args[0]))})`; shape = { kind: 'value', as: 'date' }; continue; }
      if (s.name === 'dateDiff') { scalarExpr = q`(${scalarExpr} - ${value(dateDiffOtherMs(s.args[0], {}))})`; shape = { kind: 'value', as: 'long' }; continue; }
      scalarExpr = scalarTx(s.name, s.args, scalarExpr) ?? (() => { throw new Error(`scalar transform ${s.name}() not supported`); })();
    }
    colsNode = q`${scalarExpr} AS v`;
  }
  // mean(Scope.local) on a scalar stream: each value is a one-element list whose mean
  // is the value AS A DOUBLE (mean is always Double, even of one element — d[29.0].d).
  if (acc.localMean) {
    if (!scalarExpr) throw new Error('mean(Scope.local) requires a scalar stream');
    scalarExpr = q`CAST(${scalarExpr} AS REAL)`;
    shape = { kind: 'value', as: 'double' };
    colsNode = q`${scalarExpr} AS v`;
  }
  // WHERE: the values() existence check + any is(P) on the projected scalar, AND'd.
  const whereParts: Expression[] = [];
  if (proj.baseWhere) whereParts.push(proj.baseWhere);
  if (isPreds.length) {
    if (!scalarExpr) throw new Error('is() requires a scalar stream (values/label/id/count)');
    for (const pr of isPreds) whereParts.push(predicateSql(scalarExpr, pr));
  }
  const whereNode: Expression = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;

  let orderNode: Expression = empty;
  if (orders.length) {
    const keyNodes = orders.map((o) => {
      if (o.dir === 'shuffle') return q`RANDOM()`;
      const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
      if (o.key !== null) return q`${orderKey(o.key)}${dir}`;
      return q`${shape.kind === 'value' ? 'v' : 'n.id'}${dir}`;
    });
    orderNode = q` ORDER BY ${list(keyNodes, ', ')}`;
  } else if (fallbackOrder) orderNode = q` ORDER BY ${fallbackOrder}`;
  const limitNode: Expression = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;

  let tailNode: Expression = q`SELECT ${distinct ? 'DISTINCT ' : ''}${colsNode} FROM ${proj.fromNode}${whereNode}${orderNode}${limitNode}`;

  // values(k).inject(c…): append the constants as extra value rows before any
  // reducer. Only meaningful on a scalar stream (the injected value shares `v`).
  if (injects.length) {
    if (shape.kind !== 'value') throw new Error('inject() after a non-scalar projection not yet supported');
    tailNode = q`SELECT v FROM (${tailNode}) UNION ALL ${list(injects.map((c) => q`SELECT ${value(c)} AS v`), ' UNION ALL ')}`;
  }

  // Terminal reducers wrap the projected select.
  if (reducer) ({ tailNode, shape } = wrapReducer(tailNode, reducer, shape));

  return materializeRoot(Q, tailNode, shape);
}

/** Wrap a `v`-projecting select in a terminal reducer (fold/sum/min/max/mean),
 *  returning the new node + result shape. Shared by the element tail here and the
 *  inject value stream (write.ts) so both reduce identically. fold() keeps the
 *  stream as a List (element or scalar); sum/min/max/mean collapse to one scalar
 *  (min/max/mean over numeric values only → empty stream on non-numeric input). */
export function wrapReducer(
  tailNode: Expression, reducer: NonNullable<TailAcc['reducer']>, shape: Shape,
): { tailNode: Expression; shape: Shape } {
  if (reducer === 'fold') {
    const fe: ElemShape | 'scalar' =
      shape.kind === 'vertex' ? 'vertex' : shape.kind === 'edge' ? 'edge' :
      shape.kind === 'value' ? 'scalar' : (() => { throw new Error(`fold() of ${shape.kind} not yet supported`); })();
    const as = shape.kind === 'value' ? shape.as : undefined;
    return { tailNode, shape: as ? { kind: 'list', elem: fe, as } : { kind: 'list', elem: fe } };
  }
  if (shape.kind !== 'value') throw new Error(`${reducer}() of ${shape.kind} not yet supported`);
  if (reducer === 'sum')
    // typeof(SUM) is 'integer' or 'real' → handler frames Int/Long vs Double.
    return { tailNode: q`SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (${tailNode})`, shape: { kind: 'scalar' } };
  // mean reduces over NUMERIC values only (always a Double); an empty/non-numeric
  // stream → NULL → dropped. min/max are over any Comparable — TinkerPop 4 made
  // Strings comparable, so min/max also range over text (SQLite orders numbers < text,
  // matching a uniform stream; a mixed stream is unreachable in the corpus). They keep
  // the winner's storage class via typeof() so the handler frames Int/Double/String.
  if (reducer === 'mean') {
    const nums = q`SELECT v FROM (${tailNode}) WHERE typeof(v) in ('integer', 'real')`;
    return { tailNode: q`SELECT AVG(v) AS v, 'real' AS vt FROM (${nums})`, shape: { kind: 'scalar' } };
  }
  const vals = q`SELECT v FROM (${tailNode}) WHERE typeof(v) in ('integer', 'real', 'text')`;
  const node = q`SELECT ${reducer === 'min' ? 'MIN' : 'MAX'}(v) AS v, typeof(${reducer === 'min' ? 'MIN' : 'MAX'}(v)) AS vt FROM (${vals})`;
  return { tailNode: node, shape: { kind: 'scalar' } };
}
