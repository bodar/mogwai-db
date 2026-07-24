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

import type { Relation } from '../../sql/kernel/q.ts';
import { stepChain } from '../../gremlin/frontend.ts';
import type { Carried, ElementStream } from '../context/context.ts';
import type { PropertyStream, ScalarStream, Stream } from '../context/stream.ts';
import { normalize, type PStep } from '../../compiler/ir/strategies.ts';
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
export const isElementChildStep = (s: PStep): boolean => ELEMENT_CHILD_STEPS.has(s.name) || isSackMutate(s);
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

function elementRowParts(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain>; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => CHILD_ELEMENT_ROW_STEPS.has(s.name));
  const prefix = at < 0 ? body : body.slice(0, at);
  const suffix = at < 0 ? [] : body.slice(at);
  // A mutate sack(op) is element-preserving → allowed in the prefix (isElementChildStep), so
  // local(__.sack(op).by(...)) folds the sack per parent through the same lowerElementSteps engine.
  if (!prefix.length || prefix.some((s) => !isElementChildStep(s))) return null;
  if (suffix.some((s) => !CHILD_ELEMENT_ROW_STEPS.has(s.name))) return null;
  return { prefix, suffix };
}

/** PURE. A map-cardinality element child (used at use==='first' sites like single select):
 * an element-rows body, keeping a trailing order() as the ordering modulator. Returns the
 * parsed body so tryCompileElementChild reuses it. */
export function classifyElementChild(nested: any, params: Record<string, any>): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, params);
  return classifyElementChildRows(body, undefined, true) ? { body } : null;
}

export function isElementChild(nested: any, params: Record<string, any>): boolean {
  return classifyElementChild(nested, params) !== null;
}

/** Syntax-only preflight for shape-aware dispatch. Unlike the tryCompile functions,
 * this never appends CTEs, so the prefix fold can stop before a homogeneous scalar
 * union without speculatively mutating the Query. */
function scalarRowParts(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain>; projection: any; suffix: ReturnType<typeof stepChain> } | null {
  // A mutate sack(op) is element-preserving, not a scalar producer — skip it here so the
  // projection is the FIRST genuine scalar producer (a bare read sack(), values, …); a mutate
  // sack in the run before it is part of the element prefix (isElementChildStep admits it).
  const at = body.findIndex((s) => SCALAR_PRODUCER.has(s.name) && !isSackMutate(s));
  if (at < 0) return null;
  const prefix = body.slice(0, at);
  const projection = body[at];
  const suffix = body.slice(at + 1);
  if (prefix.some((s) => !isElementChildStep(s))) return null;
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
  const kids = (branch.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
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
    ? classifyCountChild(body) !== null
    : classifyScalarChildRows('element', body)?.kind === 'element'
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
export function classifyCountChild(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain> } | null {
  const terminal = body.at(-1);
  if (!terminal || terminal.name !== 'count' || terminal.args.length) return null;
  const prefix = body.slice(0, -1);
  return prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name)) ? null : { prefix };
}

/** PURE. The post-strip scalar-row shape decision shared by compileScalarChildRows and
 * every scalar/property-scalar predicate: a property parent lowers key/value/element().…
 * (propertyScalarBody), an element parent a values/id/label/constant projection
 * (scalarRowParts). Callers strip a terminal fold() before calling. */
export function classifyScalarChildRows(
  parentKind: 'element' | 'property',
  body: ReturnType<typeof stepChain>,
): { kind: 'property'; body: ReturnType<typeof stepChain> } | { kind: 'element'; parts: ScalarRowParts } | null {
  if (parentKind === 'property') return propertyScalarBody(body) ? { kind: 'property', body } : null;
  const parts = scalarRowParts(body);
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
): { body: ReturnType<typeof stepChain>; parts: ElementRowParts; orderStep?: PStep } | null {
  if (stripTerminal && fullBody.at(-1)?.name !== stripTerminal) return null;
  const orderStep = firstPolicy && fullBody.at(-1)?.name === 'order' ? fullBody.at(-1) : undefined;
  let body = stripTerminal || orderStep ? fullBody.slice(0, -1) : fullBody;
  if (!firstPolicy && body.at(-1)?.name === 'order' && !(body.at(-1) as PStep).bys) body = body.slice(0, -1);
  const parts = body.length ? elementRowParts(body) : stripTerminal ? { prefix: [], suffix: [] } : null;
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
  return classifyCountChild(body) ? { body } : null;
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
  return classifyScalarChildRows('element', before)?.kind === 'element' || before.every((step) => ELEMENT_CHILD_STEPS.has(step.name))
    ? { body } : null;
}

export function isListChild(nested: any, params: Record<string, any>): boolean {
  return classifyListChild(nested, params) !== null;
}

export function isScalarFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  const body = childSteps(nested, params);
  return body.at(-1)?.name === 'fold' && classifyScalarChildRows('element', body.slice(0, -1))?.kind === 'element';
}

export function isElementFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, params), 'fold', false) !== null;
}

/** An element traversal used as a group VALUE with no terminal reducer/fold. Per
 *  TinkerPop, an unreduced group value collects its results into a list, so this is an
 *  implicit fold — e.g. by(__.out()) ≡ by(__.out().fold()). A trailing bare order() is
 *  the fold's natural id order (accepted, stripped when compiled); order().by(key) is
 *  NOT (it would need key-ordered folding — deferred). */
export function isElementImplicitFoldChild(nested: any, params: Record<string, any>): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, params), undefined, false) !== null;
}
