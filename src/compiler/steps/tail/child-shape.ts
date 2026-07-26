// ---------- child-shape: the pure classify half of the child seam (a dependency-free leaf) ----------
//
// The child seam (child.ts) has two layers with a sharp boundary. This module is the LOWER one:
// the PURE shape vocabulary + classifiers. It answers, at DISPATCH time, "what shape is this `__.…`
// child body?" — element / scalar / list / count / fold / property-scalar — WITHOUT touching the
// Query, the engine, or any SQL. Every function here is a syntax-only peek over a parsed step chain
// (`stepChain` → `normalize`), so the prefix fold (engine.ts) and the branch/filter/sideeffect
// dispatchers can decide how to lower a child before speculatively mutating anything.
//
// The UPPER layer (child.ts, the ChildCompiler-bearing compilers) consumes these same parsed
// bodies to emit CTEs. Keeping classify pure and physically separate is what makes the
// classify/emit lockstep impossible to break (the compilers reuse the exact parsed body a
// classifier returned) — and lets the ~40 external classifier importers (engine.ts, branch.ts,
// filter.ts, sack.ts, sideeffect.ts, services/spi) depend on this leaf, not the 1200-line compiler.
//
// This file imports ONLY pure leaves (q types, stream/context TYPES, strategies, scalar's
// SCALAR_TRANSFORMS set). It must never grow an `engineOf`, a `.cte(`, or a `q\`\`` — those belong
// in child.ts.

import type { Relation } from '../../../sql/kernel/q.ts';
import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import type { Carried, ElementStream } from '../context/context.ts';
import type { PropertyStream, ScalarStream, Stream } from '../context/stream.ts';
import { type PStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { SCALAR_TRANSFORMS } from './scalar.ts';

/** Root/child compilation context. A child frame retains the complete parent domain,
 * not merely an ordinal on productive child rows: reducers need that domain to
 * distinguish an empty child from a child which produced SQL NULL. */
export interface RootScope { readonly kind: 'root' }
export interface ChildFrame {
  readonly ordinal: string;
  readonly domain: Relation;
  readonly parent: Stream;
  readonly reused?: boolean;
  /** The DOMAIN's carried schema (the parent's carried + this frame's ordinal). A scoped
   *  reduce barrier (fold/reducer) emits one row per origin and MUST carry THIS — not the
   *  child body's carried, which may have grown a path position / alias from movement inside
   *  the child. The child's internal additions collapse at the barrier, by definition. */
  readonly carried: Carried;
}
export interface ChildScope {
  readonly kind: 'child';
  readonly frames: readonly ChildFrame[];
  /** One-shot proof that the next child seed is still one row per current frame. */
  readonly reuseFrame?: ChildFrame;
}
export type CompileScope = RootScope | ChildScope;

export const ROOT_SCOPE: RootScope = { kind: 'root' };

/** Let one child reuse an already-pushed multiset identity. Callers must request
 * this independently for each sibling; pushChildScope consumes the marker. */
export const reuseCurrentFrame = (scope: ChildScope, frame: ChildFrame): ChildScope =>
  ({ ...scope, reuseFrame: frame });

export type ChildUse = 'all' | 'first';

/** A correlated-child PARENT traverser. The child seam is parent-shape-agnostic: it
 * gives each parent traverser a multiset-safe ordinal and lowers a per-parent child
 * sub-traversal that rejoins on it. Both node/edge ELEMENTS and PROPERTIES (from
 * `properties()`) can be parents — a property child body (`key()`/`value()`/`element()…`)
 * lowers through the generic dispatcher (compileFromProperty), never a private reader. */
export type ChildParent = ElementStream | PropertyStream | ScalarStream;

/** Child chains cross the same normalization seam as the root. In particular,
 * order().by() must arrive as one PStep before shape-aware scalar lowering. */
export const childSteps = (nested: any, params: Record<string, any>) => {
  const rawSteps = stepChain(nested, params);
  const normalized = normalize(rawSteps);
  return normalized.discard ? [...normalized.steps, rawSteps.at(-1)!] : normalized.steps;
};

/** Prefix steps whose implementations physically preserve child origins. This first
 * generic-child slice is deliberately smaller than PREFIX: global barriers/windows,
 * forks, as(), repeat, sack and path-sensitive steps need their explicit child policy. */
export const ELEMENT_CHILD_STEPS = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV',
  'has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or', 'identity',
]);
/** An element-PRESERVING child step: the ELEMENT_CHILD_STEPS movement/filter vocabulary PLUS a
 *  mutate sack(op) (element→element, folds the carried sack). Both lower through the SAME
 *  lowerElementSteps engine per parent, so a scoped sack (local(__.sack(op).by(...))) reuses the
 *  root sack StepFn — no bespoke child reader. Bare read sack() is NOT here (it's a scalar producer). */
export const isElementChildStep = (s: PStep, params?: Record<string, any>): boolean =>
  ELEMENT_CHILD_STEPS.has(s.name) || isSackMutate(s)
  || (params !== undefined && isUniformElementBranch(s, params));

/** PURE. A branch step (union/choose/coalesce/optional, NOT the option-map choose form) whose arms
 *  are UNIFORMLY element — so it folds through lowerElementSteps' prefix as an element→element step,
 *  exactly like a movement. This is what admits an element-valued branch child (`map(__.union(out(),
 *  in()))`, `by(__.coalesce(out(),in()))`): the branch belongs in the element-preserving prefix, and
 *  the emit path (compileElementChildRows → lowerElementSteps) already keeps a uniform-element branch
 *  in the fold. Gated by the ONE canonical arm triage (classifyBranchArms) so a scalar/list-armed
 *  branch stays on ITS path. Requires all arms classified element (not merely merge==='element',
 *  which also covers optional's unclassified-arm fallback) — an unclassifiable arm defers cleanly to
 *  the caller's deferral rather than admitting a body compile would throw on. Needs params to
 *  classify the arms; a params-free caller conservatively rejects (backward-compatible). */
export function isUniformElementBranch(s: PStep, params: Record<string, any>): boolean {
  const kind = asBranchKind(s.name);
  if (!kind || (s as any).options) return false;
  const { shapes } = classifyBranchArms(kind, s, params);
  return shapes.length > 0 && shapes.every((sh) => sh === 'element');
}
/** The scalar-producing projection vocabulary the element-parent classifier recognizes:
 *  a step that, over an element prefix, lowers to one scalar per input. `values`/`id`/`label`
 *  read the element; `constant` rebinds it; `call`/`math`/`sack`/`format` are the generalized
 *  producers (a service, a formula, sack read, a string template) — each already lowers to a
 *  ScalarStream at root via its own TAIL StepFn, so recognizing it here lets the generic emit
 *  path (pushChildScope → lowerSteps) run it per parent WITHOUT a bespoke child reader.
 *  Kept in lockstep with the scalar-producing TAIL entries in projection.ts (SCALAR_PROJ +
 *  call/math/sack/format); count() is a reducer/barrier with its own classifyCountChild path. */
const SCALAR_PRODUCER = new Set(['values', 'id', 'label', 'constant', 'call', 'math', 'sack', 'format']);

/** A sack step in its MUTATE form (`sack(Operator.x)` — carries an operator arg). This is
 *  element-PRESERVING (element→element, folds the carried sack), so it belongs in an element
 *  prefix, NOT as a scalar producer. Only the BARE read form `sack()` produces a scalar. Mirror
 *  of engine.ts isSackMutate, kept here so this pure leaf has no engine dependency. */
export const isSackMutate = (s: PStep): boolean =>
  s.name === 'sack' && (s.args ?? []).some((a: any) => a && typeof a === 'object' && 'operator' in a);
/** A bare read `sack()` — the scalar-producing form (rebinds the value to the carried sack). */
const isSackRead = (s: PStep): boolean => s.name === 'sack' && !isSackMutate(s);
const CHILD_SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup',
  'count', 'sum', 'min', 'max', 'mean',
]);
// Row operators that can be scoped to one parent. `order()` is included here so
// an existence consumer can observe the same ordered/sliced child rows as a
// normal child cardinality consumer; the emitter mints the per-parent encounter
// before applying the following slice.
const CHILD_ELEMENT_ROW_STEPS = new Set(['order', 'limit', 'skip', 'range', 'dedup', 'local']);

// The scalar VALUE-transform vocabulary a scalar arm/child may carry without throwing (the
// scalarTx string/value family + typed date coercions). Deliberately NOT the whole
// SCALAR_TRANSFORMS spread — `asBool` has no scalarTx case and a bare `asNumber()` throws on a
// non-date value, so both DEFER as an arm body rather than throw mid-lowering (`asNumber` is
// admitted by scalarChildPrefixOk only when it carries a type arg). Shared classify vocabulary:
// scalar-arm.ts (root-scope arm leaves) and child.ts (compileScalarChildRows' pushed prefix).
export const SCALAR_ARM_TX = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'trim', 'lTrim', 'rTrim',
  'reverse', 'replace', 'substring', 'asDate', 'dateAdd', 'dateDiff',
]);

/** A value-op step allowed in the PREFIX of a scalar-parent CHILD body (before an optional
 *  terminal reducer). The pushed scalar seed carries an encounter column, so the partitioned
 *  order/slice/tail/dedup paths are safe here; constant() defers inside a child scope and asBool
 *  has no scalarTx impl. PURE — shared by compileScalarChildRows (child.ts) + the scalar
 *  reducer/list arm recognizers (scalar-arm.ts). */
const SCALAR_CHILD_PREFIX = new Set([...SCALAR_ARM_TX, 'is', 'and', 'or', 'not', 'filter', 'where', 'constant', 'identity', 'unfold', 'math', 'order', 'limit', 'skip', 'range', 'tail', 'dedup']);
export const scalarChildPrefixOk = (s: PStep): boolean =>
  SCALAR_CHILD_PREFIX.has(s.name) || (s.name === 'asNumber' && (s.args ?? []).length > 0);

function elementRowParts(body: ReturnType<typeof stepChain>, params?: Record<string, any>): { prefix: ReturnType<typeof stepChain>; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => CHILD_ELEMENT_ROW_STEPS.has(s.name));
  const prefix = at < 0 ? body : body.slice(0, at);
  const suffix = at < 0 ? [] : body.slice(at);
  // A mutate sack(op) is element-preserving → allowed in the prefix (isElementChildStep), so
  // local(__.sack(op).by(...)) folds the sack per parent through the same lowerElementSteps engine.
  // With params, a uniform-element branch (union(out(),in())) is likewise element-preserving and
  // rides the prefix fold — so an element-valued branch child composes at every position.
  if (!prefix.length || prefix.some((s) => !isElementChildStep(s, params))) return null;
  if (suffix.some((s) => !CHILD_ELEMENT_ROW_STEPS.has(s.name))) return null;
  return { prefix, suffix };
}

/** PURE. A map-cardinality element child (used at use==='first' sites like single select):
 * an element-rows body, keeping a trailing order() as the ordering modulator. Returns the
 * parsed body so tryCompileElementChild reuses it. */
export function classifyElementChild(nested: any, params: Record<string, any>): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, params);
  return classifyElementChildRows(body, undefined, true, params) ? { body } : null;
}

export function isElementChild(nested: any, params: Record<string, any>): boolean {
  return classifyElementChild(nested, params) !== null;
}

/** Syntax-only preflight for shape-aware dispatch. Unlike the tryCompile functions,
 * this never appends CTEs, so the prefix fold can stop before a homogeneous scalar
 * union without speculatively mutating the Query. */
function scalarRowParts(body: ReturnType<typeof stepChain>, params?: Record<string, any>): { prefix: ReturnType<typeof stepChain>; projection: any; suffix: ReturnType<typeof stepChain> } | null {
  // A mutate sack(op) is element-preserving, not a scalar producer — skip it here so the
  // projection is the FIRST genuine scalar producer (a bare read sack(), values, …); a mutate
  // sack in the run before it is part of the element prefix (isElementChildStep admits it).
  const at = body.findIndex((s) => SCALAR_PRODUCER.has(s.name) && !isSackMutate(s));
  if (at < 0) return null;
  const prefix = body.slice(0, at);
  const projection = body[at];
  const suffix = body.slice(at + 1);
  // A uniform-element branch before the projection is element-preserving too (params-gated), so
  // union(out(),in()).values('name') lowers as a scalar child — the branch folds elements, then
  // the projection reads them.
  if (prefix.some((s) => !isElementChildStep(s, params))) return null;
  if (suffix.some((s) => !CHILD_SCALAR_ROW_STEPS.has(s.name))) return null;
  // Per-projection arg shape for the bespoke values/id/label/constant SQL builder. The
  // generalized producers (call/math/sack/format) carry their own args and route through the
  // generic emit path (lowerSteps), so their arg validation lives in their own StepFns — here
  // they only need the element-prefix + scalar-suffix shape above.
  if (projection.name === 'values' && (projection.args.length !== 1 || typeof projection.args[0] !== 'string')) return null;
  if ((projection.name === 'id' || projection.name === 'label') && projection.args.length) return null;
  if (projection.name === 'constant' && projection.args.length !== 1) return null;
  return { prefix, projection, suffix };
}

/** Nested per-traverser branches whose own arms are recursively element-parent scalar children:
 * a value branch inside a value arm lowers through lowerSteps → the same tryLowerScalar* consumer
 * (which recurses back here per arm), so `choose(P, __.union(__.constant('a'), __.constant('b')),
 * __.values('x'))` composes. The scalar-parent SCALAR_ARM_BRANCH move, one shape up. map/flatMap/
 * local are element steps here (not scalar-producing directly) and stay out. */
const ELEMENT_ARM_BRANCH = new Set(['choose', 'coalesce', 'union']);

/** PURE. The option-map form of choose() is scalar-valued when its choice and every
 * option body can be compiled by the existing scalar-child seam. The emitter already
 * owns this form (lowerChooseOptions); this recognizer only keeps the classify/emit
 * contract intact when the choose lives inside map()/local()/flatMap(). */
function elementOptionMapScalarBranch(branch: PStep, params: Record<string, any>): boolean {
  if (branch.name !== 'choose' || !branch.options) return false;

  const choice = branch.args[0];
  const choiceIsScalar = choice && typeof choice === 'object' && 'nested' in choice
    ? classifyScalarChild(choice.nested, params) !== null
    : choice && typeof choice === 'object' && 'token' in choice
      && (choice.token === 'label' || choice.token === 'id');
  if (!choiceIsScalar) return false;

  let keyed = false;
  let fallback = false;
  for (const option of branch.options) {
    const body = option.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
    if (!body || !classifyScalarChild(body.nested, params)) return false;
    const key = option.args.find((x: any) => x !== body);
    if (key === undefined || (key && typeof key === 'object' && 'pick' in key)) {
      const pick = key && typeof key === 'object' && 'pick' in key ? key.pick : 'none';
      if (pick !== 'none') return false;
      fallback = true;
    } else {
      keyed = true;
    }
  }
  return keyed && fallback;
}

/** PURE. An element-parent scalar child whose value comes from a nested branch step — the
 * recursive extension of classifyScalarChild. Grammar: an ELEMENT_CHILD_STEPS prefix, a branch
 * step (choose/coalesce/union, predicate-form choose only) whose VALUE arms are each recursively
 * classifyScalarChild-compatible, then a scalar-row suffix. When true, lowerSteps re-dispatches
 * the branch to the element-parent branch compilers, which recurse per arm — so the emitter needs
 * no bespoke reader. Precise (all arms scalar) so it never claims a list/variant-armed branch. */
export function elementScalarBranchArm(body: ReturnType<typeof stepChain>, params: Record<string, any>): boolean {
  const at = body.findIndex((s) => ELEMENT_ARM_BRANCH.has(s.name)
    && (!(s as PStep).options || elementOptionMapScalarBranch(s as PStep, params)));
  if (at < 0) return false;
  const prefix = body.slice(0, at);
  const branch = body[at];
  const suffix = body.slice(at + 1);
  if (prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return false;
  if (suffix.some((s) => !CHILD_SCALAR_ROW_STEPS.has(s.name))) return false;
  if (branch.name === 'choose' && (branch as PStep).options)
    return elementOptionMapScalarBranch(branch as PStep, params);
  const kids = (branch.args ?? []).filter(isNested);
  if (branch.name === 'choose') {
    // predicate-form choose(pred, then, else): only the two value arms must be scalar (the
    // predicate is a gate). Other arities defer to tryLowerScalarChoose's own decline.
    if (kids.length !== 3) return false;
    return classifyScalarChild(kids[1].nested, params) !== null && classifyScalarChild(kids[2].nested, params) !== null;
  }
  const min = branch.name === 'union' ? 2 : 1; // union needs ≥2 arms; coalesce ≥1
  return kids.length >= min && kids.every((a: any) => classifyScalarChild(a.nested, params) !== null);
}

/** PURE. An element-parent scalar child (the strict isScalarChild shape): a movement-only
 * total count(), a values/id/label/constant projection with a scalar-row tail, or a nested
 * scalar-armed branch (elementScalarBranchArm). Returns the parsed body so the emitter reuses
 * it — one parse per arm, classify-then-emit. */
export function classifyScalarChild(nested: any, params: Record<string, any>): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, params);
  const terminal = body.at(-1);
  if (!terminal) return null;
  const ok = terminal.name === 'count'
    ? classifyCountChild(body, params) !== null
    : classifyScalarChildRows('element', body, params)?.kind === 'element'
      || elementScalarBranchArm(body, params);
  return ok ? { body } : null;
}

export function isScalarChild(nested: any, params: Record<string, any>): boolean {
  return classifyScalarChild(nested, params) !== null;
}

/** Syntax-only recognizer for a PROPERTY-parent scalar child. A property traverser's
 * scalar sub-traversals are `key()`/`value()` (the property's own key/value), a bare
 * `constant(x)`, or `element()` re-rooted on the owner followed by an ordinary element
 * scalar child (values/id/label + transforms/reducers). The head is consumed by
 * compileFromProperty; the element tail delegates to scalarRowParts. Returns the parsed
 * body when it qualifies so the caller can lower it via the generic dispatcher. */
export function propertyScalarBody(body: ReturnType<typeof stepChain>): ReturnType<typeof stepChain> | null {
  const head = body[0]?.name;
  if (!head) return null;
  // key()/value() ARE the scalar projection; any following steps must be a valid scalar
  // continuation (transforms/is/order/limit/reducers) — so value().sum(), key().toUpper()
  // lower like an element values('x').<continuation>. The terminal reducer/fold is stripped
  // by the group consumer before this gate; the rest are checked here.
  if (head === 'key' || head === 'value')
    return body.slice(1).every((s) => CHILD_SCALAR_ROW_STEPS.has(s.name)) ? body : null;
  // element() re-roots on the owner; the tail is an ordinary element scalar child. constant()
  // is excluded: lowerConstant defers inside a child scope (it loses the per-origin
  // encounter), so a constant projection defers cleanly instead of failing the preflight.
  if (head === 'element') {
    const parts = scalarRowParts(body.slice(1));
    return parts && parts.projection.name !== 'constant' ? body : null;
  }
  return null;
}

/** The pure shape parts a child body classifies into (no CTE, no pushChildScope). These
 * are the classify half of the classify/emit split: `is*Child` peeks decide dispatch
 * without polluting the Query, and the compile functions consume the SAME result so the
 * old preflight/compiler lockstep (and its dead-code mismatch throws) cannot diverge. */
export type ScalarRowParts = NonNullable<ReturnType<typeof scalarRowParts>>;
export type ElementRowParts = NonNullable<ReturnType<typeof elementRowParts>>;

/** PURE. A terminal bare count() over a movement-only prefix — the total-count child
 * (tryCompileCountChild) and the isTotalScalarChild/count arm of isScalarChild. */
export function classifyCountChild(body: ReturnType<typeof stepChain>, params?: Record<string, any>): { prefix: ReturnType<typeof stepChain> } | null {
  const terminal = body.at(-1);
  if (!terminal || terminal.name !== 'count' || terminal.args.length) return null;
  const prefix = body.slice(0, -1);
  // A uniform-element branch counts too (params-gated): union(out(),in()).count() folds elements
  // through the prefix, then the scoped count barrier reduces them.
  return prefix.some((s) => !isElementChildStep(s, params)) ? null : { prefix };
}

/** PURE. The post-strip scalar-row shape decision shared by compileScalarChildRows and
 * every scalar/property-scalar predicate: a property parent lowers key/value/element().…
 * (propertyScalarBody), an element parent a values/id/label/constant projection
 * (scalarRowParts). Callers strip a terminal fold() before calling. */
export function classifyScalarChildRows(
  parentKind: 'element' | 'property',
  body: ReturnType<typeof stepChain>,
  params?: Record<string, any>,
): { kind: 'property'; body: ReturnType<typeof stepChain> } | { kind: 'element'; parts: ScalarRowParts } | null {
  if (parentKind === 'property') return propertyScalarBody(body) ? { kind: 'property', body } : null;
  const parts = scalarRowParts(body, params);
  return parts ? { kind: 'element', parts } : null;
}

/** PURE. The element-row shape decision shared by compileElementChildRows and the three
 * element predicates. `firstPolicy` keeps a trailing order() as an explicit ordering
 * modulator (map cardinality); otherwise a trailing BARE order() is stripped as redundant
 * with the fold's natural id order. `stripTerminal` requires+drops a terminal step (fold)
 * and lets an empty before-body qualify. Mirrors compileElementChildRows' L724-733 exactly,
 * minus the emit-time parent-state guard (sack/fromV/property parent). */
export function classifyElementChildRows(
  fullBody: ReturnType<typeof stepChain>,
  stripTerminal: string | undefined,
  firstPolicy: boolean,
  params?: Record<string, any>,
): { body: ReturnType<typeof stepChain>; parts: ElementRowParts; orderStep?: PStep } | null {
  if (stripTerminal && fullBody.at(-1)?.name !== stripTerminal) return null;
  const orderStep = firstPolicy && fullBody.at(-1)?.name === 'order' ? fullBody.at(-1) : undefined;
  let body = stripTerminal || orderStep ? fullBody.slice(0, -1) : fullBody;
  if (!firstPolicy && body.at(-1)?.name === 'order' && !(body.at(-1) as PStep).bys) body = body.slice(0, -1);
  const parts = body.length ? elementRowParts(body, params) : stripTerminal ? { prefix: [], suffix: [] } : null;
  return parts ? { body, parts, orderStep: orderStep as PStep | undefined } : null;
}

export function isPropertyScalarChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  return classifyScalarChildRows('property', childSteps(nested, params)) !== null;
}

/** A property scalar child terminated by fold() — the group-value list form. */
export function isPropertyScalarFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  return body.at(-1)?.name === 'fold' && classifyScalarChildRows('property', body.slice(0, -1)) !== null;
}

/** PURE. A total scope-aware count() child (movement-only prefix): optional(child) ≡ child
 * because the identity fallback is unreachable. Returns the parsed body for reuse. */
export function classifyTotalScalarChild(nested: any, params: Record<string, any>): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, params);
  return classifyCountChild(body, params) ? { body } : null;
}

export function isTotalScalarChild(nested: any, params: Record<string, any>): boolean {
  return classifyTotalScalarChild(nested, params) !== null;
}

/** PURE. A fold()-terminated list child (element parent): the strict shape the branch/list
 * consumers gate on. Returns the parsed body so the emitter (tryCompileListChild) reuses it
 * instead of re-parsing — one parse per arm, classify-all-then-emit-all. Deliberately
 * stricter than compileElementChildRows' fold path (routing control): a scalar-rows-before-
 * fold OR a pure-movement before-fold; a strict body always emits, so no lockstep throw. */
export function classifyListChild(nested: any, params: Record<string, any>): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, params);
  if (body.at(-1)?.name !== 'fold') return null;
  const before = body.slice(0, -1);
  return classifyScalarChildRows('element', before, params)?.kind === 'element'
    || before.every((step) => isElementChildStep(step, params))
    ? { body } : null;
}

/** PURE. A bare branch step whose merge is LIST (uniform `…fold()` arms) or VARIANT (genuinely
 *  mixed arms) — the shapes that lowerStepsStrict resolves to a List/VariantStream over a pushed
 *  child scope (finishListMerge / mergeVariantArms are parent-agnostic). Element-armed and
 *  scalar-armed branches are excluded here — they have their own cardinality-aware child paths.
 *  Deliberately NOT wired into classifyListChild/the branch-arm triage: consumed ONLY by the
 *  all-cardinality child consumers (local/flatMap), so a branch-of-lists / mixed branch composes
 *  there while map (first-of-a-multi-output body) stays fail-closed and the triage is untouched. */
export function isBareBranchChildAllCard(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  if (body.length !== 1) return false;
  const kind = asBranchKind(body[0].name);
  if (!kind || (body[0] as any).options) return false;
  const merge = classifyBranchArms(kind, body[0], params).merge;
  return merge === 'list' || merge === 'variant';
}

export function isListChild(nested: any, params: Record<string, any>): boolean {
  return classifyListChild(nested, params) !== null;
}

export function isScalarFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  return body.at(-1)?.name === 'fold' && classifyScalarChildRows('element', body.slice(0, -1), params)?.kind === 'element';
}

export function isElementFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, params), 'fold', false, params) !== null;
}

/** An element traversal used as a group VALUE with no terminal reducer/fold. Per
 *  TinkerPop, an unreduced group value collects its results into a list, so this is an
 *  implicit fold — e.g. by(__.out()) ≡ by(__.out().fold()). A trailing bare order() is
 *  the fold's natural id order (accepted, stripped when compiled); order().by(key) is
 *  NOT (it would need key-ordered folding — deferred). */
export function isElementImplicitFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, params), undefined, false, params) !== null;
}

// ---------- branch-family arm triage (the ONE canonical shape decision) ----------
//
// union/choose/coalesce/optional all ask the same question — "what SHAPE are this branch's
// arms?" — and the answer picks the merge: all-element → the element StepFn (branch.ts, inside
// the prefix fold); all-scalar → unionScalarStreams; all-list → finishListMerge; genuinely mixed
// → mergeVariantArms. That decision used to be computed THREE times per branch step, in three
// files, each with its own encoding of the fall-through order: ten ad-hoc booleans in
// engine.ts's prefix fold (to decide whether to `break`), a hardcoded list→scalar→variant→element
// cascade in projection.ts's tail dispatchers, and a third re-classification inside each
// tryLower*. Nothing was canonical, so the three could drift.
//
// `classifyBranchArms` is now that single source of truth. It is PURE (syntax-only, like every
// classifier in this leaf — no Query, no CTE), so the prefix fold can consult it before
// speculatively mutating anything, and the tail dispatchers + arm compilers read the SAME answer.
// The MERGE order (which shape wins when a body could satisfy two classifiers) lives in
// BRANCH_SHAPE_ORDER below — written down once, not restated per call site.

/** The four steps that fork a traverser into arms and merge the results. */
export type BranchKind = 'union' | 'choose' | 'coalesce' | 'optional';

/** One arm's shape class. `null` = unclassifiable by any of the three child classifiers. */
export type BranchArmShape = 'element' | 'scalar' | 'list' | null;

/** THE canonical fall-through order: the shape a branch is tried as, first match wins. Read by
 *  projection.ts's tail cascades so the sequence is declared here, not restated there. `element`
 *  is LAST because its lowerer is also the fail-closed backstop (it throws rather than
 *  returning null). */
export const BRANCH_SHAPE_ORDER = ['list', 'scalar', 'variant', 'element'] as const;
export type BranchMerge = typeof BRANCH_SHAPE_ORDER[number];

export interface BranchArms {
  readonly kind: BranchKind;
  /** Each VALUE arm's shape, in argument order. For choose() the leading predicate arg is
   *  excluded (it is a gate, not an arm); for optional() there is exactly one (the implicit
   *  identity/self arm is never classified — it is the parent's own shape by construction). */
  readonly shapes: readonly BranchArmShape[];
  /** The nested arg objects the shapes were read from, so the caller reuses them rather than
   *  re-filtering `step.args` (that filter had ~31 copies across three files). */
  readonly args: readonly any[];
  /** Which merge this branch routes to — the first entry of BRANCH_SHAPE_ORDER that fits.
   *  'element' doubles as "no shape-changing merge applies" (the prefix-fold hot path). */
  readonly merge: BranchMerge;
}

/** PURE. ONE arm body's shape class — the single per-arm probe. `classifyBranchArms` folds it over
 *  a branch's arms, and the mixed-shape lowerers (branch.ts `armShape`) call it directly for one
 *  arm, so a single arm and a whole branch can never classify differently. The ORDER is
 *  significant: element first, so a homogeneous element branch stays on the prefix-fold hot path
 *  even though an element body can also satisfy the scalar/list classifiers. */
export function classifyArmShape(nested: any, params: Record<string, any>): BranchArmShape {
  return isElementChild(nested, params) ? 'element'
    : isScalarChild(nested, params) ? 'scalar'
    : isListChild(nested, params) ? 'list'
    : null;
}

/** The arity a branch kind needs before any shape talk: union ≥2 arms, coalesce ≥1, choose
 *  exactly 3 args (pred, then, else — the 2-arg form's else is an element identity, so it stays
 *  with the element lowerer), optional exactly 1. `null` = "no shape question to ask", which
 *  classifyBranchArms reports as merge 'element' so the element lowerer owns the arity/option-map
 *  error message (fail closed, one authority). */
function branchValueArgs(kind: BranchKind, step: PStep): readonly any[] | null {
  if (kind === 'choose' && (step as any).options) return null; // option-map form: a tail CASE projector
  const nested = (step.args ?? []).filter(isNested);
  if (kind === 'union') return nested.length >= 2 ? nested : null;
  if (kind === 'coalesce') return nested.length >= 1 ? nested : null;
  if (kind === 'choose') return nested.length === 3 ? nested.slice(1) : null; // drop the predicate
  return nested.length >= 1 ? nested.slice(0, 1) : null; // optional: the single body
}

/** PURE. Classify a branch step's arms once. `merge` folds the whole decision: every arm the
 *  same shape → that shape's homogeneous merge; every arm classifiable but NOT all the same →
 *  'variant'; anything else (an unclassifiable arm, wrong arity, the option-map choose form) →
 *  'element', where the element lowerer either handles it or throws the authoritative error. */
export function classifyBranchArms(kind: BranchKind, step: PStep, params: Record<string, any>): BranchArms {
  const args = branchValueArgs(kind, step);
  if (!args) return { kind, shapes: [], args: [], merge: 'element' };
  const shapes: BranchArmShape[] = args.map((a: any) => classifyArmShape(a.nested, params));
  // An element arm can ALSO satisfy the scalar/list classifiers in principle; the order above
  // (element first) is why a homogeneous element branch stays on the prefix-fold hot path.
  //
  // Only all-element keeps the prefix fold; a homogeneous scalar/list set routes to that shape's
  // merge, and a genuinely MIXED (but fully classified) set to the variant merge.
  //
  // An UNCLASSIFIABLE arm splits by kind, and the asymmetry is load-bearing:
  //   · optional() — one arm, and its miss arm is the parent element itself, so an unclassified
  //     body (e.g. a NESTED optional/coalesce: `optional(out().optional(out()))`) is still an
  //     ELEMENT branch and MUST stay in the prefix fold, where the optional StepFn's originSeed
  //     path compiles it. Routing it to the tail would strand it — nothing there claims it and
  //     the error would name optional() as unimplemented.
  //   · union/choose/coalesce — a multi-arm merge cannot know an unclassified arm's shape, so it
  //     routes to the tail cascade: each tryLower* declines in turn and the element lowerer
  //     throws the authoritative deferral naming the offending arm body.
  const unclassified = shapes.some((s) => s === null);
  const merge: BranchMerge =
    shapes.every((s) => s === 'element') ? 'element'
    : unclassified ? (kind === 'optional' ? 'element' : 'variant')
    : shapes.every((s) => s === 'list') ? 'list'
    : shapes.every((s) => s === 'scalar') ? 'scalar'
    : 'variant';
  return { kind, shapes, args, merge };
}

/** PURE. The prefix fold's ONLY question: must this branch leave the element StepFn path so the
 *  tail dispatch can pick a shape-changing merge? True iff the arms are not uniformly element.
 *  Derived from classifyBranchArms, so the fold's `break` and the tail's cascade cannot disagree
 *  — the drift the ten ad-hoc booleans invited. */
export function branchNeedsShapeDispatch(kind: BranchKind, step: PStep, params: Record<string, any>): boolean {
  return classifyBranchArms(kind, step, params).merge !== 'element';
}

export const BRANCH_KINDS = new Set<string>(['union', 'choose', 'coalesce', 'optional']);
export const asBranchKind = (name: string): BranchKind | null =>
  BRANCH_KINDS.has(name) ? name as BranchKind : null;

// ---------- by() modulator argument triage (the pure shell every host shares) ----------
//
// A `by(...)` modulator's argument group is one of a small closed set of shapes: a nested
// traversal `{nested}`, a property-key string, a T-token `{token}`, a direction `{order}`,
// or empty (bare `by()`). Every consumer (group/select/project/path/math/format/order/dedup/
// aggregate) previously re-derived this triage inline with copy-pasted `byArgs.find(...)`
// scans, then drifted. This is the ONE syntax-only classifier they now share; the leaf SQL
// builders (scalarProp/scalarPropSortKey in plan.ts) and the child seam (tryCompile*) stay
// the emit half — this only names the shape. A direction (`order`) can ride alongside any of
// the value shapes (`order().by('age', desc)`), so it is a sibling field, not a variant.

export type ByDirection = 'asc' | 'desc' | 'shuffle';

export type ByClass =
  | { readonly kind: 'nested'; readonly nested: any; readonly dir?: ByDirection }
  | { readonly kind: 'key'; readonly key: string; readonly dir?: ByDirection }
  | { readonly kind: 'token'; readonly token: string; readonly dir?: ByDirection }
  | { readonly kind: 'none'; readonly dir?: ByDirection };

/** PURE. Classify ONE `by(...)` argument group into its closed-set shape. The value shape
 *  (nested/key/token/none) and an optional direction are read independently, so a
 *  `by('age', desc)` yields `{kind:'key', key:'age', dir:'desc'}`. This is the single
 *  triage every by()-consuming host shares — no host should re-scan `byArgs` inline. */
export function classifyBy(byArgs: readonly any[] | undefined): ByClass {
  const dir = byArgs?.find((a: any) => a && typeof a === 'object' && 'order' in a)?.order as ByDirection | undefined;
  const nested = byArgs?.find(isNested);
  if (nested) return { kind: 'nested', nested: nested.nested, dir };
  const token = byArgs?.find((a: any) => a && typeof a === 'object' && 'token' in a);
  if (token) return { kind: 'token', token: token.token, dir };
  const key = byArgs?.find((a: any) => typeof a === 'string');
  if (key !== undefined) return { kind: 'key', key, dir };
  return { kind: 'none', dir };
}

/** PURE. The round-robin `by()` accessor: modulators cycle positionally in first-seen
 *  order, so a single by() feeds every position and N by()s feed N positions (project()/
 *  math()/format()/select() all share this). Returns undefined when there are no bys. */
export const byAt = (bys: readonly any[][] | undefined, i: number): any[] | undefined =>
  bys && bys.length ? bys[i % bys.length] : undefined;

/** PURE. Classify the i-th round-robin by() group — the common `classifyBy(byAt(...))`. */
export const classifyByAt = (bys: readonly any[][] | undefined, i: number): ByClass =>
  classifyBy(byAt(bys, i));
