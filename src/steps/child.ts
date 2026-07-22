import { derived, empty, list, paren, q, value, type Expression, type Relation } from '../q.ts';
import { stepChain } from '../frontend.ts';
import { edges, labels, nodes, vertexProperties, edgeProperties } from '../schema.ts';
import { advance, carriedWith, carryFrag, carryFragMint, carriedCols, type Carried, type ElementStream } from './context.ts';
import { aliasId } from './alias.ts';
import { carryOf, toListStream, toScalarStream, toVariantStream, PROPERTY_PAYLOAD, type ListStream, type PropertyStream, type ScalarStream, type Stream, type VariantStream } from './stream.ts';
import { variantArmsMeta, variantArmSelect, variantCols, type VariantArm } from './variant.ts';
import { lowerElementSteps, lowerStepsStrict, tryLowerElementSteps } from './index.ts';
import { lowerScalarRows, gateScalar, tryInlineScalarPredicate, unionScalarStreams, SCALAR_TRANSFORMS } from './scalar.ts';
import { lowerScalarVE } from './projection.ts';
import { normalize, type PStep } from '../strategies.ts';
import { lowerScopedElementFold, lowerScopedScalarFold, lowerScopedScalarReducer, type ScalarReducer } from './barrier.ts';
import { predicateSql, rangeToOffsetLimit } from '../plan.ts';
import { elementOrderSql } from './modulation.ts';

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

const isPropertyParent = (p: ChildParent): p is PropertyStream => p.kind === 'property';
const isScalarParent = (p: ChildParent): p is ScalarStream => p.kind === 'scalar';

/** Child chains cross the same normalization seam as the root. In particular,
 * order().by() must arrive as one PStep before shape-aware scalar lowering. */
export const childSteps = (nested: any, params: Record<string, any>) => {
  const rawSteps = stepChain(nested, params);
  const normalized = normalize(rawSteps);
  return normalized.discard ? [...normalized.steps, rawSteps.at(-1)!] : normalized.steps;
};

/** Give every parent traverser a multiset-safe identity and seed a correlated child.
 * Equal element ids deliberately get different ordinals. The domain is preserved in
 * the returned frame even when later child lowering produces no rows. */
export function pushChildScope<P extends ChildParent>(
  parent: P,
  scope: CompileScope = ROOT_SCOPE,
): { scope: ChildScope; frame: ChildFrame; seed: P } {
  if (scope.kind === 'child' && scope.reuseFrame) {
    const ordinal = scope.reuseFrame.ordinal;
    if (parent.carried.origins.at(-1) !== ordinal)
      throw new Error(`reused child scope mismatch: expected innermost ${ordinal}, got ${parent.carried.origins.at(-1) ?? 'none'}`);
    const frame: ChildFrame = { ordinal, domain: parent.rel, parent, reused: true, carried: parent.carried };
    const frames = [...scope.frames.slice(0, -1), frame];
    return { scope: { kind: 'child', frames }, frame, seed: parent };
  }
  const p = parent.rel.as('p');
  const ordinal = `o${parent.carried.origins.length}`;
  // A SCALAR parent needs a CARRIED encounter (the per-origin order marker the scoped
  // reducer/fold and the `first` cardinality policy key productivity on). Reuse the parent's
  // if it already carries one; otherwise mint a constant (a scalar traverser never fans out
  // into its own child scope — each ordinal has exactly one value). Element/property parents
  // add no encounter here.
  const needEnc = isScalarParent(parent) && !parent.carried.encounter;
  // The seed carries the parent's schema PLUS the pushed ordinal (+ a minted scalar encounter
  // when needed). Build the domain's carried columns in carriedCols ORDER — the ordinal in its
  // origins slot, NOT appended physically last — so the seed's declared schema equals its
  // physical layout. Otherwise, whenever the outer chain also tracks a path (or fromV/encounter,
  // which carriedCols sorts AFTER origins), the ordinal-last domain desyncs from the
  // ordinal-in-origins schema and any child body lowered via lowerSteps (assertStreamColumns)
  // trips a column mismatch. Minted columns (ordinal by ROW_NUMBER, a new encounter by a
  // constant) are computed fresh; every other carried column is projected from `p` by name.
  const base = carriedWith(parent.carried, { origins: [...parent.carried.origins, ordinal] });
  const seedCarried = needEnc ? carriedWith(base, { encounter: 'encounter' }) : base;
  const seedCols = carriedCols(seedCarried);
  const carriedSelect = list(
    seedCols.map((c) =>
      c === ordinal ? q`ROW_NUMBER() OVER () AS ${ordinal}`
        : (needEnc && c === 'encounter') ? q`1 AS ${c}`
        : q`${p.c[c]}`),
    ', ',
  );
  // A SCALAR parent re-projects its value payload `v` (+ vt/vtype) so the child body reads
  // `_` = the value. streamColumns order is [v, vt?, vtype?, ...carried] so the projection
  // matches the seed's declared schema (the encounter now rides in the carried tail).
  if (isScalarParent(parent)) {
    const head = ['v', ...(parent.result === 'number' ? ['vt'] : [])];
    const vtypeCols = parent.vtype ? [parent.vtype] : [];
    const payload = list([
      ...head.map((c) => q`${p.c[c]} AS ${c}`),
      ...vtypeCols.map((c) => q`${p.c[c]} AS ${c}`),
    ], ', ');
    const domain = parent.q.cte(
      q`SELECT ${payload}, ${carriedSelect} FROM ${p}`,
      [...head, ...vtypeCols, ...seedCols],
    );
    const seed = { ...parent, rel: domain, carried: seedCarried } as P;
    const frame: ChildFrame = { ordinal, domain, parent, carried: seedCarried };
    const frames = scope.kind === 'child' ? [...scope.frames, frame] : [frame];
    return { scope: { kind: 'child', frames }, frame, seed };
  }
  // The domain re-projects the parent's identity payload + a multiset-safe ordinal. An
  // element parent carries a single `id`; a property parent carries the full property
  // payload so the child body's compileFromProperty can read key/value/owner from it.
  const payloadCols = isPropertyParent(parent) ? [...PROPERTY_PAYLOAD] : ['id'];
  const payload = isPropertyParent(parent)
    ? list(payloadCols.map((c) => q`${p.c[c]} AS ${c}`), ', ')
    : q`${p.c.id} AS id`;
  const domain = parent.q.cte(
    q`SELECT ${payload}, ${carriedSelect} FROM ${p}`,
    [...payloadCols, ...seedCols],
  );
  const seed = { ...parent, rel: domain, carried: seedCarried } as P;
  const frame: ChildFrame = { ordinal, domain, parent, carried: seedCarried };
  const frames = scope.kind === 'child' ? [...scope.frames, frame] : [frame];
  return { scope: { kind: 'child', frames }, frame, seed };
}

/** Remove exactly the innermost child identity after a child consumer has restored
 * parent cardinality. Outer origins remain live for nested children. */
export function popChildScope(child: ElementStream, frame: ChildFrame): ElementStream {
  const origins = child.carried.origins;
  if (origins[origins.length - 1] !== frame.ordinal)
    throw new Error(`child scope mismatch: expected innermost ${frame.ordinal}, got ${origins.at(-1) ?? 'none'}`);
  const nextOrigins = origins.slice(0, -1);
  const carried = carriedWith(child.carried, { origins: nextOrigins });
  const p = child.rel.as('p');
  return advance(child, q`SELECT ${p.c.id} AS id${carryFrag(carried, p)} FROM ${p}`, { origins: nextOrigins });
}

/** Prefix steps whose implementations physically preserve child origins. This first
 * generic-child slice is deliberately smaller than PREFIX: global barriers/windows,
 * forks, as(), repeat, sack and path-sensitive steps need their explicit child policy. */
const ELEMENT_CHILD_STEPS = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV',
  'has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or', 'identity',
]);
/** The scalar-producing projection vocabulary the element-parent classifier recognizes:
 *  a step that, over an element prefix, lowers to one scalar per input. `values`/`id`/`label`
 *  read the element; `constant` rebinds it; `call`/`math`/`sack`/`format` are the generalized
 *  producers (a service, a formula, sack read, a string template) — each already lowers to a
 *  ScalarStream at root via its own TAIL StepFn, so recognizing it here lets the generic emit
 *  path (pushChildScope → lowerSteps) run it per parent WITHOUT a bespoke child reader.
 *  Kept in lockstep with the scalar-producing TAIL entries in projection.ts (SCALAR_PROJ +
 *  call/math/sack/format); count() is a reducer/barrier with its own classifyCountChild path. */
const SCALAR_PRODUCER = new Set(['values', 'id', 'label', 'constant', 'call', 'math', 'sack', 'format']);
const CHILD_SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup',
  'count', 'sum', 'min', 'max', 'mean',
]);
const CHILD_SCALAR_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);
const CHILD_ELEMENT_ROW_STEPS = new Set(['limit', 'skip', 'range', 'dedup']);
const SHARED_SCALAR_CHILD_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup',
]);

function elementRowParts(body: ReturnType<typeof stepChain>): { prefix: ReturnType<typeof stepChain>; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => CHILD_ELEMENT_ROW_STEPS.has(s.name));
  const prefix = at < 0 ? body : body.slice(0, at);
  const suffix = at < 0 ? [] : body.slice(at);
  if (!prefix.length || prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;
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
  const at = body.findIndex((s) => SCALAR_PRODUCER.has(s.name));
  if (at < 0) return null;
  const prefix = body.slice(0, at);
  const projection = body[at];
  const suffix = body.slice(at + 1);
  if (prefix.some((s) => !ELEMENT_CHILD_STEPS.has(s.name))) return null;
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
type ScalarRowParts = NonNullable<ReturnType<typeof scalarRowParts>>;
type ElementRowParts = NonNullable<ReturnType<typeof elementRowParts>>;

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

/** Child scalar forms proven to emit exactly one row per parent. They make
 * optional(child) equivalent to child because the identity fallback is unreachable. */
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

/** Compile a terminal child count as a true scope-aware barrier. The preserved
 * parent domain is the left side of the aggregate, so an unproductive child still
 * emits one Long zero for that parent. Grouping by the child ordinal (rather than
 * element id) keeps equal/duplicate parent traversers multiset-distinct. */
export function tryCompileCountChild(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): ScalarStream | null {
  if (!nested || isPropertyParent(parent) || isScalarParent(parent)) return null;
  const counted = classifyCountChild(preParsed ?? childSteps(nested, parent.params));
  if (!counted) return null;
  const { prefix } = counted;

  const pushed = pushChildScope(parent, scope);
  const { stream: end, next: stop } = lowerElementSteps(prefix, pushed.seed);
  if (stop !== prefix.length) return null;

  const d = pushed.frame.domain.as('d');
  const c = end.rel.as('c');
  const rel = parent.q.cte(
    q`SELECT COUNT(${c.c.id}) AS v${carryFrag(parent.carried, d)} FROM ${d} LEFT JOIN ${c} ON ${c.c[pushed.frame.ordinal]}=${d.c[pushed.frame.ordinal]} GROUP BY ${d.c[pushed.frame.ordinal]}`,
    ['v', ...carriedCols(parent.carried)],
  );
  return toScalarStream(carryOf(parent), rel, 'long');
}

/** Count child with the origin retained for a consumer-owned by()/barrier policy.
 * Unlike tryCompileCountChild this does not pop the frame: one total row (including
 * zero) remains associated with each multiset-distinct parent. */
function tryCompileCountValueRows(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  if (!nested || isPropertyParent(parent) || isScalarParent(parent)) return null;
  const body = preParsed ?? childSteps(nested, parent.params);
  // A trailing is() run is a filter on the count value — `out().count().is(gt(1))`.
  // It composes as a HAVING on the aggregate: the row (one per parent, incl. the
  // LEFT-JOIN zero) survives only when the count satisfies every predicate, so an
  // existence consumer reads row-present ⟺ the count comparison holds. This is the
  // bare-movement counterpart to the values-based reducer path (compileScalarChildRows
  // continueScalar already applies a trailing is), so `<move>.count().is(P)` lowers
  // through the generic reducer machinery instead of a hand-rolled correlated aggregate.
  let cut = body.length;
  const isPreds: any[] = [];
  while (cut > 0 && body[cut - 1].name === 'is') { isPreds.unshift(body[cut - 1].args[0]); cut--; }
  const counted = classifyCountChild(body.slice(0, cut));
  if (!counted) return null;
  const { prefix } = counted;
  const pushed = pushChildScope(parent, scope);
  const { stream: end, next: stop } = lowerElementSteps(prefix, pushed.seed);
  if (stop !== prefix.length) return null;
  const d = pushed.frame.domain.as('d');
  const c = end.rel.as('c');
  const count = q`COUNT(${c.c.id})`;
  const having = isPreds.length
    ? q` HAVING ${list(isPreds.map((p) => predicateSql(count, p)), ' AND ')}`
    : empty;
  // One count row per origin — mint a constant encounter into its carried slot.
  const outCarried = carriedWith(pushed.seed.carried, { encounter: 'encounter' });
  const rel = parent.q.cte(
    q`SELECT ${count} AS v${carryFragMint(outCarried, d, 'encounter', q`1`)} FROM ${d} LEFT JOIN ${c} ON ${c.c[pushed.frame.ordinal]}=${d.c[pushed.frame.ordinal]} GROUP BY ${d.c[pushed.frame.ordinal]}${having}`,
    ['v', ...carriedCols(outCarried)],
  );
  return { stream: toScalarStream({ ...carryOf(pushed.seed), carried: outCarried }, rel, 'long', { result: 'value' }), frame: pushed.frame };
}

/** Compile a scalar-producing child as rows, so productivity is represented by row
 * existence rather than SQL NULL. Movement/filter uses the ordinary element fold;
 * projection adds an explicit provider encounter key; the shared scalar pipeline
 * applies transforms and origin-partitioned row operators; only then does the
 * consumer apply its `first` or `all` cardinality policy. */
function applyScalarChildCardinality(
  parent: ChildParent,
  pushed: ReturnType<typeof pushChildScope>,
  lowered: ScalarStream,
  use: ChildUse,
  retainChildScope: boolean,
): { stream: ScalarStream; frame: ChildFrame } {
  if (retainChildScope) return { stream: lowered, frame: pushed.frame };
  const r = lowered.rel.as('r');
  const parentCols = carriedCols(parent.carried);
  const typeCol = lowered.result === 'number' ? q`, ${r.c.vt} AS vt` : empty;
  const resultCols = lowered.result === 'number' ? ['v', 'vt'] : ['v'];
  if (use === 'all') {
    const rel = derived(q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)} FROM ${r}`, [...resultCols, ...parentCols], 'all_rows');
    return { stream: toScalarStream(carryOf(parent), rel, lowered.as, { result: lowered.result }), frame: pushed.frame };
  }
  if (!lowered.carried.encounter) throw new Error('child first cardinality requires explicit encounter order');
  const loweredEnc = lowered.carried.encounter;
  const first = derived(
    q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)}, ROW_NUMBER() OVER (PARTITION BY ${r.c[pushed.frame.ordinal]} ORDER BY ${r.c[loweredEnc]}) AS rn FROM ${r}`,
    [...resultCols, ...parentCols, 'rn'],
    'f',
  );
  const firstTypeCol = lowered.result === 'number' ? q`, ${first.c.vt} AS vt` : empty;
  const rel = derived(
    q`SELECT ${first.c.v} AS v${firstTypeCol}${carryFrag(parent.carried, first)} FROM ${first} WHERE ${first.c.rn}=1`,
    [...resultCols, ...parentCols],
    'first_row',
  );
  return { stream: toScalarStream(carryOf(parent), rel, lowered.as, { result: lowered.result }), frame: pushed.frame };
}

/** PURE. A scalar child body that RE-SOURCES the graph: a `V()`/`E()` head (with no
 *  nested-traversal id argument, which is a different shape) over which the pushed scalar seed
 *  CROSS JOINs per value. The head discards the value and re-enters element space — the one
 *  way a scalar arm reaches movement/adjacency. */
function isResourceHead(rest: PStep[]): boolean {
  const head = rest[0];
  return !!head && (head.name === 'V' || head.name === 'E')
    && !(head.args ?? []).some((a: any) => a && typeof a === 'object' && 'nested' in a);
}

/** Re-source a scalar seed (`V()`/`E()`) then fold the element movement/filter remainder,
 *  returning the ElementStream — or null if the remainder isn't fully element-lowerable.
 *  Shared by the re-source reducer path (compileScalarChildRows) and the mixed-shape variant
 *  element arm (tryScalarResourceElement); the value is discarded by the re-source (a flatMap
 *  CROSS JOIN), and a pushed ordinal rides through it unchanged. */
function resourceElement(seed: ScalarStream, head: PStep, after: PStep[]): ElementStream | null {
  const el = lowerScalarVE(seed, head);
  if (!el) return null;
  const { stream, next } = lowerElementSteps(after, el);
  return next === after.length ? stream : null;
}

/** Count the element rows of a re-sourced child per parent origin. Each row is marked with a
 *  per-origin encounter, then the SHARED scoped count barrier (LEFT JOIN domain → 0 for an
 *  empty child, bulk-weighted) reduces it — no bespoke aggregate, the same path an element
 *  count arm uses (tryCompileRowsBeforeReducer's count branch). */
/** GENERIC child-seam primitive: the per-parent neighbour count in a direction, bulk-aware —
 *  pushChildScope → one movement over the pushed seed → scopedElementCount (LEFT JOIN domain,
 *  so a parent with no such edges scores 0). Not service-specific: it is "scoped movement
 *  count", the substrate a bare `both().count()` child also is. tinker.degree.centrality is
 *  its first caller; it composes this from the service, keeping child-seam internals here. */
export function scopedMovementCount(parent: ElementStream, scope: CompileScope, direction: 'out' | 'in' | 'both'): ScalarStream {
  if (parent.elem !== 'node') throw new Error(`${direction}() degree expects a vertex input`);
  const pushed = pushChildScope(parent, scope);
  // A synthetic movement step — the StepFn reads only name/args, never .ctx.
  const moveStep = { name: direction, args: [], ctx: null as any } as PStep;
  const { stream: moved, next } = lowerElementSteps([moveStep], pushed.seed);
  if (next !== 1) throw new Error(`could not lower ${direction}()`);
  return scopedElementCount(moved, pushed);
}

function scopedElementCount(el: ElementStream, pushed: ReturnType<typeof pushChildScope>): ScalarStream {
  const c = el.rel.as('c');
  const ord = pushed.frame.ordinal;
  const mc = carriedWith(el.carried, { encounter: 'encounter' });
  const mint = q`ROW_NUMBER() OVER (PARTITION BY ${c.c[ord]} ORDER BY ${c.c.id})`;
  const marked = toScalarStream(
    { ...carryOf(el), carried: mc },
    el.q.cte(
      q`SELECT 1 AS v${carryFragMint(mc, c, 'encounter', mint)} FROM ${c}`,
      ['v', ...carriedCols(mc)],
    ),
    undefined, { result: 'value' },
  );
  return lowerScopedScalarReducer(marked, 'count', pushed.scope);
}

function compileScalarChildRows(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: CompileScope = ROOT_SCOPE,
  retainChildScope = false,
  stripTerminal?: string,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  if (!nested) return null;
  const fullBody = preParsed ?? childSteps(nested, parent.params);
  if (stripTerminal && fullBody.at(-1)?.name !== stripTerminal) return null;
  const body = stripTerminal ? fullBody.slice(0, -1) : fullBody;

  // ONE classification (shared with the is*Child preflight peeks — no divergent second
  // parse). Property parent: the child body (key/value/element().…) lowers through the SAME
  // generic dispatcher as a root traversal (lowerSteps → compileFromProperty), so a property
  // group has no private inline reader; the scalar projection in a child scope mints the
  // per-origin encounter the cardinality policy needs. Non-scalar bodies fall through to the
  // caller's clear deferral. (The isPropertyParent guard also narrows `parent` below.)
  if (isPropertyParent(parent)) {
    if (!classifyScalarChildRows('property', body)) return null;
    const pushed = pushChildScope(parent, scope);
    const stream = lowerStepsStrict(pushed.seed, body, 0);
    // classify proved a scalar shape; a non-scalar here is an internal classify↔lowerSteps
    // contradiction, not a fallback — fail loud (a silent null would orphan the CTEs above).
    if (stream.kind !== 'scalar') throw new Error('property scalar child classified scalar but lowered to ' + stream.kind);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  // Nested scalar-armed branch (choose/coalesce/union) as the WHOLE body: parent-agnostic —
  // lowerSteps re-dispatches the branch step to the branch compilers, which recurse back here
  // per arm. Lowered over a pushed scope, the branch merge (unionScalarStreams) mints the
  // per-origin emission encounter, so the 'first' cardinality policy can take the first emitted
  // result (map(__.union(...)) / by(__.choose(...))). Checked before the scalar-parent families
  // below (a bare branch body is neither a value-op nor a re-source). elementScalarBranchArm is
  // precise (all arms scalar), so a non-scalar result is a contradiction.
  if (elementScalarBranchArm(body, parent.params)) {
    const pushed = pushChildScope(parent, scope);
    const stream = lowerStepsStrict(pushed.seed, body, 0);
    if (stream.kind !== 'scalar') throw new Error('scalar-branch child classified scalar but lowered to ' + stream.kind);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  // Scalar parent: the child body starts from the value `_` = v. Two families, each recognized
  // by a pure inline check BEFORE pushChildScope (so a miss returns null with no orphaned CTE):
  //   (a) a value-op body (transforms/is/order/slice — the pushed seed carries the minted
  //       encounter) that stays scalar, plus an optional terminal scoped reducer; and
  //   (b) a RE-SOURCE body (`V()`/`E()` then element movement/filter, optional projection):
  //       the pushed scalar seed CROSS JOINs the graph per value (lowerScalarVE carries the
  //       ordinal through), so a following scoped reducer/projection reduces per input.
  // fold() is stripped by the caller (stripTerminal), so it never appears here.
  if (isScalarParent(parent)) {
    const last = body.at(-1);
    const reducer = last && CHILD_SCALAR_REDUCERS.has(last.name) ? last.name as ScalarReducer : undefined;
    const rest = reducer ? body.slice(0, -1) : body;
    if (!body.length) return null;

    // (b) re-source body: V()/E() head (no nested-traversal id arg) then an element remainder.
    if (isResourceHead(rest)) {
      const after = rest.slice(1);
      const elementOnly = after.length === 0 || after.every((s) => ELEMENT_CHILD_STEPS.has(s.name));
      if (elementOnly) {
        // A movement-only re-source ends in element space; only count() reduces it back to a
        // scalar per input (sum/min/max/mean need a value → the arm would project one first,
        // taking the projection path below). No reducer → element-ending mixed shape (slice 3).
        if (reducer !== 'count') return null;
        const pushed = pushChildScope(parent, scope);
        const moved = resourceElement(pushed.seed, rest[0], after);
        if (!moved) return null;
        return applyScalarChildCardinality(parent, pushed, scopedElementCount(moved, pushed), use, retainChildScope);
      }
      // ends in a projection (values/id/label) → scalar; lowerSteps folds V→element→projection.
      if (classifyScalarChildRows('element', after)?.kind !== 'element') return null;
      const pushed = pushChildScope(parent, scope);
      const lowered = lowerStepsStrict(pushed.seed, rest, 0);
      if (lowered.kind !== 'scalar') return null;
      const stream = reducer ? lowerScopedScalarReducer(lowered, reducer, pushed.scope) : lowered;
      return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
    }

    // (a) value-op body: lower through the FULL scalar dispatch (identity/unfold/transforms/
    // math/is/order/slice all route over the pushed seed), staying scalar; then reduce per origin.
    if (!rest.every(scalarChildPrefixOk)) return null;
    const pushed = pushChildScope(parent, scope);
    let stream: ScalarStream = pushed.seed;
    if (rest.length) {
      const lowered = lowerStepsStrict(pushed.seed, rest, 0);
      if (lowered.kind !== 'scalar') return null;
      stream = lowered;
    }
    if (reducer) stream = lowerScopedScalarReducer(stream, reducer, pushed.scope);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  const shape = classifyScalarChildRows('element', body);
  if (!shape || shape.kind !== 'element') return null;
  const { prefix, projection: terminal, suffix } = shape.parts;

  // The ordinary row pipeline now uses the exact same iterative lowering loop as a
  // root traversal. Scoped reducers/folds retain their explicit per-origin policies
  // below; constant() still needs its child-only projector.
  if (terminal.name !== 'constant' && suffix.every((step) => SHARED_SCALAR_CHILD_STEPS.has(step.name))) {
    const pushed = pushChildScope(parent, scope);
    const stream = lowerStepsStrict(pushed.seed, body, 0);
    // As above: classify proved scalar, so a non-scalar is a contradiction — fail loud.
    if (stream.kind !== 'scalar') throw new Error('scalar child classified scalar but lowered to ' + stream.kind);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  // The bespoke element-projection SQL builder below reads the element directly
  // (values/id/label) or emits the literal (constant). The generalized producers
  // (call/math/sack/format) have no element-projection SQL here — they only ever lower
  // through the generic path above; a suffix that failed the generic gate (e.g. a terminal
  // scoped reducer) defers cleanly so the caller's clear deferral stays authoritative,
  // rather than mis-routing through the label branch of the builder.
  if (!['values', 'id', 'label', 'constant'].includes(terminal.name)) return null;

  const pushed = pushChildScope(parent, scope);
  const { stream: end, next: stop } = lowerElementSteps(prefix, pushed.seed);
  if (stop !== prefix.length) return null;

  const c = end.rel.as('c');
  let scalar: Expression;
  let from: Expression;
  let order: Expression;
  if (terminal.name === 'constant') {
    scalar = value(terminal.args[0]);
    from = q`${c}`;
    order = c.c.id;
  } else {
    const elem = (end.elem === 'edge' ? edges : nodes).as('e');
    if (terminal.name === 'values') {
      const key = terminal.args[0];
      if (end.elem === 'node') {
        const vp = vertexProperties.as('vp');
        scalar = vp.c.value;
        from = q`${c} JOIN ${vp} ON ${vp.c.node}=${c.c.id} AND ${vp.c.key}=${value(key)}`;
        order = q`${c.c.id}, ${vp.c.id}`;
      } else {
        const ep = edgeProperties.as('ep');
        scalar = ep.c.value;
        from = q`${c} JOIN ${ep} ON ${ep.c.edge}=${c.c.id} AND ${ep.c.key}=${value(key)}`;
        order = c.c.id;
      }
    } else if (terminal.name === 'id') {
      scalar = q`COALESCE(${elem.c.uid}, ${elem.c.id})`;
      from = q`${c} JOIN ${elem} ON ${elem.c.id}=${c.c.id}`;
      order = c.c.id;
    } else {
      const l = labels.as('l');
      scalar = l.c.name;
      from = q`${c} JOIN ${elem} ON ${elem.c.id}=${c.c.id} JOIN ${l} ON ${l.c.id}=${elem.c.label}`;
      order = c.c.id;
    }
  }

  // Mint the per-origin encounter into the child's carried slot (superseding none — end is an
  // element child with no encounter yet).
  const outCarried = carriedWith(end.carried, { encounter: 'encounter' });
  const continueScalar = (base: ScalarStream): ScalarStream => {
    let stream = base;
    let at = 0;
    while (at < suffix.length) {
      const lowered = lowerScalarRows(stream, suffix, at);
      stream = lowered.stream;
      at = lowered.stop;
      if (at === suffix.length) break;
      const reducer = suffix[at].name;
      if (!CHILD_SCALAR_REDUCERS.has(reducer))
        throw new Error(`scalar child continuation ${reducer}() not yet supported`);

      stream = lowerScopedScalarReducer(stream, reducer as ScalarReducer, pushed.scope);
      at++;
    }
    return stream;
  };
  const encMint = q`ROW_NUMBER() OVER (PARTITION BY ${c.c[pushed.frame.ordinal]} ORDER BY ${order})`;
  const rows = parent.q.cte(
    q`SELECT ${scalar} AS v${carryFragMint(outCarried, c, 'encounter', encMint)} FROM ${from}`,
    ['v', ...carriedCols(outCarried)],
  );
  const lowered = continueScalar(toScalarStream({ ...carryOf(end), carried: outCarried }, rows, undefined, { result: 'value' }));
  return applyScalarChildCardinality(parent, pushed, lowered, use, retainChildScope);
}

export function tryCompileScalarChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): ScalarStream | null {
  return compileScalarChildRows(parent, nested, use, scope, false, undefined, preParsed)?.stream ?? null;
}

/** One public scalar-valued child entry point. Consumers must not know whether a
 * scalar came from projected rows or a total scope-aware count barrier. */
export function tryCompileScalarValueChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): ScalarStream | null {
  return tryCompileCountChild(parent, nested, scope, preParsed)
    ?? tryCompileScalarChild(parent, nested, use, scope, preParsed);
}

export interface ScalarModulationSpec {
  readonly nested: any;
  /** Re-root the child on a carried as()-label while retaining the outer row. */
  readonly rootCol?: string;
  readonly rootElem?: ElementStream['elem'];
  /** Required = ordinary productive modulation; optional = expose row presence. */
  readonly required?: boolean;
}

export interface ScalarModulationDomain {
  readonly rel: Relation;
  readonly values: readonly { value: string; present: string }[];
  /** The parent-identity column the rejoined rel projects: `id` for an element parent (the
   *  consumer rejoins nodes/edges on it), `v` for a scalar parent (the value IS the current
   *  object — no element table to join). Lets math/format/choose-option be parent-polymorphic. */
  readonly idCol: 'id' | 'v';
}

/** Compile independent scalar traversal modulators against ONE multiset-safe parent
 * domain. Every child gets its own nested scope, then rejoins on the shared outer
 * ordinal. Optional children expose an explicit presence column, so productive NULL
 * is never confused with an unproductive child. This is the common relational seam
 * for multi-input consumers such as math(), format(), and option-map choose(). */
export function tryCompileScalarModulations(
  parent: ChildParent,
  specs: readonly ScalarModulationSpec[],
): ScalarModulationDomain | null {
  if (!specs.length || isPropertyParent(parent)) return null;
  const scalarParent = isScalarParent(parent);
  const outer = pushChildScope(parent);
  const children = specs.map((spec, i) => {
    let seed: ElementStream | ScalarStream = outer.seed;
    // as()-label re-root is an element concern (the label holds element ids); a scalar parent
    // fields every by() against its value directly, so a rootCol over a scalar defers.
    if (spec.rootCol && scalarParent) return null;
    if (spec.rootCol && !scalarParent) {
      const es = outer.seed as ElementStream;
      const p = es.rel.as(`mr${i}`);
      // rootCol is an as()-label column: a JSONB history array. Re-root on its last id.
      const rel = parent.q.cte(
        q`SELECT ${aliasId(p.c[spec.rootCol], 'last')} AS id${carryFrag(es.carried, p)} FROM ${p}`,
        ['id', ...carriedCols(es.carried)],
      );
      seed = { ...es, rel, elem: spec.rootElem ?? es.elem };
    }
    const stream = tryCompileScalarValueChild(seed, spec.nested, 'first', reuseCurrentFrame(outer.scope, outer.frame));
    return stream ? { stream, required: spec.required !== false } : null;
  });
  if (children.some((x) => !x)) return null;

  const d = outer.frame.domain.as('md');
  const aliases = children.map((child, i) => ({ child: child!, rel: child!.stream.rel.as(`ms${i}`) }));
  const values = aliases.map((_, i) => ({ value: `m${i}`, present: `m${i}_present` }));
  const joins = aliases.map(({ child, rel }) =>
    q`${child.required ? q` JOIN ` : q` LEFT JOIN `}${rel} ON ${rel.c[outer.frame.ordinal]}=${d.c[outer.frame.ordinal]}`,
  );
  const payload = aliases.flatMap(({ rel }, i) => [
    q`${rel.c.v} AS ${values[i].value}`,
    q`CASE WHEN ${rel.c[outer.frame.ordinal]} IS NOT NULL THEN 1 END AS ${values[i].present}`,
  ]);
  // The rejoined rel projects the parent identity: an element parent's `id` (consumers rejoin
  // nodes/edges on it) or a scalar parent's value `v` (the current object itself).
  const idCol = scalarParent ? 'v' : 'id';
  const rel = parent.q.cte(
    q`SELECT ${d.c[idCol]} AS ${idCol}${carryFrag(parent.carried, d)}, ${list(payload, ', ')} FROM ${d}${list(joins, '')}`,
    [idCol, ...carriedCols(parent.carried), ...values.flatMap((x) => [x.value, x.present])],
  );
  return { rel, values, idCol };
}

/** Productive scalar rows with the child origin still live. Barrier/side-effect
 * consumers use this form when THEY own first/all/productive-null cardinality;
 * keeping that decision out of the child parser is the central consumer-policy seam. */
export function tryCompileScalarValueRows(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  return tryCompileCountValueRows(parent, nested, scope, preParsed)
    ?? compileScalarChildRows(parent, nested, 'all', scope, true, undefined, preParsed);
}

/** Scalar rows followed by fold() become one ListStream per parent. This is a true
 * child barrier: empty children emit [], productive NULL remains [null], and only
 * the innermost origin is removed at the consumer boundary. */
export function tryCompileListChild(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): ListStream | null {
  const scoped = compileScalarChildRows(parent, nested, 'all', scope, true, 'fold', preParsed);
  if (scoped) {
    const folded = lowerScopedScalarFold(scoped.stream, { kind: 'child', frames: [scoped.frame] });
    const l = folded.rel.as('l');
    const rel = parent.q.cte(
      q`SELECT ${l.c.list} AS list${carryFrag(parent.carried, l)} FROM ${l}`,
      ['list', ...carriedCols(parent.carried)],
    );
    return toListStream(carryOf(parent), rel, folded.of);
  }

  const element = compileElementChildRows(parent, nested, scope, 'fold', false, preParsed);
  if (!element) return null;
  const folded = lowerScopedElementFold(element.stream, { kind: 'child', frames: [element.frame] });
  const l = folded.rel.as('l');
  const rel = parent.q.cte(
    q`SELECT ${l.c.list} AS list${carryFrag(parent.carried, l)} FROM ${l}`,
    ['list', ...carriedCols(parent.carried)],
  );
  return toListStream(carryOf(parent), rel, folded.of);
}

/** Productive scalar rows immediately before fold(). Group-like consumers use
 * this when the fold belongs to their final key domain rather than to each parent
 * independently. The child origin and encounter marker deliberately remain live. */
export function tryCompileScalarRowsBeforeFold(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  return compileScalarChildRows(parent, nested, 'all', scope, true, 'fold', preParsed);
}

/** Productive element rows immediately before fold(), retaining the child origin so
 * a group consumer can fold them over its final key rather than once per parent. */
export function tryCompileElementRowsBeforeFold(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; frame: ChildFrame } | null {
  return compileElementChildRows(parent, nested, scope, 'fold', false, preParsed);
}

/** Element rows for an implicit-fold group value (no terminal fold — the whole body is
 * collected into a list). Same origin-retaining shape as tryCompileElementRowsBeforeFold;
 * a trailing bare order() is stripped inside compileElementChildRows. */
export function tryCompileElementImplicitFoldRows(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; frame: ChildFrame } | null {
  return compileElementChildRows(parent, nested, scope, undefined, false, preParsed);
}

/** Productive element rows with the child origin retained. Existence consumers use
 * the row marker only; optional/group-like consumers may inspect the typed element. */
export function tryCompileElementValueRows(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): { stream: ElementStream; frame: ChildFrame } | null {
  return compileElementChildRows(parent, nested, scope);
}

/** Generic traversal-filter fallback. The fast correlated predicate forms live in
 * steps/predicate.ts; when they decline a body, any typed child row is existence and no
 * row is non-existence. The preserved domain ordinal keeps duplicate parents distinct. */
export function tryFilterByChildExistence(
  parent: ElementStream,
  nested: any,
  negate = false,
  scope: CompileScope = ROOT_SCOPE,
): ElementStream | null {
  return childExistenceGate(parent, nested, scope)?.(negate) ?? null;
}

/** Split a parent stream into (child-exists, child-absent) gated seeds — the
 * choose()/predicate analogue of tryFilterByChildExistence's single filtered stream.
 * Both seeds share the one child CTE. Returns null when no generic child compiles,
 * so the caller keeps its inline-predicate fast path authoritative. */
export function tryGateByChildExistence(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): { then: ElementStream; else: ElementStream } | null {
  const gate = childExistenceGate(parent, nested, scope);
  return gate ? { then: gate(false), else: gate(true) } : null;
}

/** Generic boolean form of the existence gate for and()/or(): compile N predicate
 * branches against ONE shared parent domain (a single pushed ordinal, reused per
 * branch), then filter the domain on the branches' correlated EXISTS combined with
 * AND/OR. This is the child-lowering counterpart to predicate.ts combineBranchPreds's
 * inline correlated form, so andOr falls through here instead of defining language
 * support when a branch is beyond the inline compiler. Returns null when any branch has
 * no generic child compilation. */
export function tryCombineByChildExistence(
  parent: ElementStream,
  branches: readonly any[],
  op: 'AND' | 'OR',
  negate = false,
): ElementStream | null {
  if (!branches.length) return null;
  const { scope, frame, seed } = pushChildScope(parent);
  const d = frame.domain.as('d');
  const terms: Expression[] = [];
  for (const nested of branches) {
    const reuse = reuseCurrentFrame(scope, frame);
    const child = tryCompileElementValueRows(seed, nested, reuse)
      ?? tryCompileScalarValueRows(seed, nested, reuse);
    if (!child) return null;
    const c = child.stream.rel.as('c');
    terms.push(q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[frame.ordinal]}=${d.c[frame.ordinal]})`);
  }
  const combined = paren(list(terms.map(paren), ` ${op} `));
  return advance(parent,
    q`SELECT ${d.c.id} AS id${carryFrag(parent.carried, d)} FROM ${d} WHERE ${negate ? q`NOT (${combined})` : combined}`,
  );
}

/** The shared correlated-existence core: compile the child once, then return a
 * builder that projects the preserved parent domain filtered on child row existence
 * (or absence). The domain ordinal keeps duplicate parents distinct. */
function childExistenceGate(
  parent: ElementStream,
  nested: any,
  scope: CompileScope,
): ((negate: boolean) => ElementStream) | null {
  const child = tryCompileElementValueRows(parent, nested, scope)
    ?? tryCompileScalarValueRows(parent, nested, scope);
  if (!child) return null;
  return (negate: boolean) => {
    const d = child.frame.domain.as('d');
    const c = child.stream.rel.as('c');
    const exists = q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[child.frame.ordinal]}=${d.c[child.frame.ordinal]})`;
    return advance(parent,
      q`SELECT ${d.c.id} AS id${carryFrag(parent.carried, d)} FROM ${d} WHERE ${negate ? q`NOT (${exists})` : exists}`,
    );
  };
}

/** Compile an element-valued child through the SAME StepFns as the root prefix, then
 * apply the consumer's cardinality policy. `first` implements map(): zero child rows
 * are unproductive; otherwise exactly one row survives per multiset-distinct parent.
 * Returns null when the body needs a not-yet-generic tail/barrier so scalar fast paths
 * and clear existing deferrals remain authoritative. */
function compileElementChildRows(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  stripTerminal?: string,
  firstPolicy = false,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; frame: ChildFrame } | null {
  // Element-valued children are element-parent-only: a property has no adjacency, and an
  // `element()` head that re-roots on the owner is a SCALAR-child concern (compileScalar
  // ChildRows). Property parents fail closed here; the group falls back to its deferral.
  // Element-parent-only + no sack/fromV are emit-time PARENT-state guards (not shape):
  // kept here, distinct from the shared shape classification below.
  if (isPropertyParent(parent) || isScalarParent(parent)) return null;
  if (!nested || parent.carried.sack || parent.carried.fromV) return null;
  // ONE shape classification (the same classifyElementChildRows the element preflight peeks
  // use) — the bare-order strip, firstPolicy order modulator, and empty-before handling all
  // live in the shared helper, so preflight and compiler cannot diverge.
  const shape = classifyElementChildRows(preParsed ?? childSteps(nested, parent.params), stripTerminal, firstPolicy);
  if (!shape) return null;
  const { parts, orderStep } = shape;
  const pushed = pushChildScope(parent, scope);
  // (trackFromV for an exploded otherV() body is derived inside lowerElementSteps, the single
  // fold every scope passes through — see the note there.)
  const { stream: prefixed, next: stop } = lowerElementSteps(parts.prefix, pushed.seed);
  if (stop !== parts.prefix.length) return null;

  let end = prefixed;
  for (const step of parts.suffix) {
    const p = end.rel.as('p');
    if (step.name === 'dedup') {
      end = advance(end, q`SELECT DISTINCT ${p.c.id} AS id${carryFrag(end.carried, p)} FROM ${p}`);
      continue;
    }
    const slice = step.name === 'range' ? rangeToOffsetLimit(step.args)
      : step.name === 'skip' ? { offset: Number(step.args[0]), limit: -1 }
      : { offset: 0, limit: Number(step.args[0]) };
    const cols = carriedCols(end.carried);
    const r = derived(
      q`SELECT ${p.c.id} AS id${carryFrag(end.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[pushed.frame.ordinal]} ORDER BY ${p.c.id}) AS rn FROM ${p}`,
      ['id', ...cols, 'rn'],
      'r',
    );
    const hi = slice.limit < 0 ? null : slice.offset + slice.limit;
    const upper = hi === null ? empty : q` AND ${r.c.rn} <= ${hi}`;
    end = advance(end, q`SELECT ${r.c.id} AS id${carryFrag(end.carried, r)} FROM ${r} WHERE ${r.c.rn} > ${slice.offset}${upper}`);
  }
  if (firstPolicy) {
    const p = end.rel.as('p');
    const n = (end.elem === 'edge' ? edges : nodes).as('n');
    const orderExpr = elementOrderSql(end, n, orderStep as PStep | undefined);
    const cols = carriedCols(end.carried);
    const r = derived(
      q`SELECT ${p.c.id} AS id${carryFrag(end.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[pushed.frame.ordinal]} ORDER BY ${orderExpr}, ${p.c.id}) AS rn FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`,
      ['id', ...cols, 'rn'],
      'r',
    );
    end = advance(end, q`SELECT ${r.c.id} AS id${carryFrag(end.carried, r)} FROM ${r} WHERE ${r.c.rn}=1`);
  }
  return { stream: end, frame: pushed.frame };
}

/** Map-style element modulation: retain the first row per parent after an optional
 * terminal order(). The origin remains live so ProductiveBy consumers can restore
 * missing parents as explicit nulls. */
export function tryCompileFirstElementValueRows(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): { stream: ElementStream; frame: ChildFrame } | null {
  return compileElementChildRows(parent, nested, scope, undefined, true);
}

/** Expose the productive child rows immediately BEFORE a terminal group-scoped
 * reducer. Scalar bodies retain their value; element-only count bodies become one
 * marker row per element. The child origin remains live so the group consumer can
 * join these rows to its shared parent domain before reducing by group key. */
export function tryCompileRowsBeforeReducer(
  parent: ChildParent,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame; reducer: ScalarReducer } | null {
  if (!nested) return null;
  const body = preParsed ?? childSteps(nested, parent.params);
  const reducer = body.at(-1)?.name as ScalarReducer | undefined;
  if (!reducer || !CHILD_SCALAR_REDUCERS.has(reducer)) return null;

  const scalar = compileScalarChildRows(parent, nested, 'all', scope, true, reducer, body);
  if (scalar) return { ...scalar, reducer };
  if (reducer !== 'count') return null;

  const element = compileElementChildRows(parent, nested, scope, reducer, false, body);
  if (!element) return null;
  const e = element.stream.rel.as('er');
  const outCarried = carriedWith(element.stream.carried, { encounter: 'encounter' });
  const encMint = q`ROW_NUMBER() OVER (PARTITION BY ${e.c[element.frame.ordinal]} ORDER BY ${e.c.id})`;
  const rel = parent.q.cte(
    q`SELECT 1 AS v${carryFragMint(outCarried, e, 'encounter', encMint)} FROM ${e}`,
    ['v', ...carriedCols(outCarried)],
  );
  return {
    stream: toScalarStream({ ...carryOf(element.stream), carried: outCarried }, rel, undefined, { result: 'value' }),
    frame: element.frame,
    reducer,
  };
}

export function tryCompileElementChild(
  parent: ElementStream,
  nested: any,
  use: ChildUse,
  scope: CompileScope = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; scope: CompileScope } | null {
  const lowered = compileElementChildRows(parent, nested, scope, undefined, use === 'first', preParsed);
  if (!lowered) return null;
  const { stream: end, frame } = lowered;

  if (frame.reused) return { stream: end, scope };
  if (use === 'all') return { stream: popChildScope(end, frame), scope };
  return { stream: popChildScope(end, frame), scope };
}

/** Lower any currently-supported element-valued child without crossing a root
 * materialization boundary. Ordinary row-scoped children use the child-frame
 * engine; branch/path compositions fall through to the complete StepFn lowerer.
 * repeat() remains excluded under a live child origin because its recursive CTE
 * intentionally carries only walk state, not arbitrary parent columns. */
export function tryCompileElementTraversal(
  parent: ElementStream,
  nested: any,
  scope: CompileScope = ROOT_SCOPE,
): ElementStream | null {
  const scoped = tryCompileElementChild(parent, nested, 'all', scope);
  if (scoped) return scoped.stream;
  if (!nested) return null;
  const body = childSteps(nested, parent.params);
  if (parent.carried.origins.length && body.some((step) => step.name === 'repeat'))
    throw new Error('repeat() inside a correlated element child not yet supported (recursive walk does not carry the parent ordinal)');
  return tryLowerElementSteps(body, parent);
}

// ---------- scalar-PARENT branch consumers (map/local/flatMap/choose/union/coalesce) ----------
//
// When the CURRENT stream is a scalar (values()/count()/a projected value…), a child
// sub-traversal starts from that value — its current object is `_` = the value `v`. Over a
// scalar there is no adjacency/properties, so an arm is a cardinality-preserving VALUE
// sub-traversal: scalar transforms, is()/and/or/not/filter/where predicates, and
// constant(). Each arm lowers through the SAME lowerSteps → compileFromScalar engine (not a
// private reader); the branch consumers gate the value rows and UNION ALL the arm outputs,
// reusing tryInlineScalarPredicate as the per-row productivity oracle. This is the scalar twin of
// branch.ts's element-parent choose/union/coalesce — the missing half is consuming a scalar
// AS the parent. (Element re-entry V()/E(), reducer-bodied maps, and modulator consumers
// math()/format()/project().by() need the pushChildScope substrate and land in later stages.)

/** The Stage-1 scalar-arm vocabulary: value transforms, scalar row operators, and the
 *  filter family (whose nested traversals must recursively be scalar-arm bodies). A body
 *  outside this set (movement/properties, a nested branch, a shape-changing barrier) is
 *  rejected so the consumer returns null and the existing clear deferral stays authoritative
 *  — never a throw that would break the fall-through contract. */
// Transforms proven to lower over a scalar WITHOUT throwing: the scalarTx string/value
// family + the typed date coercions. Deliberately NOT the whole SCALAR_TRANSFORMS spread —
// `asBool` has no scalarTx case (throws) and a bare `asNumber()` throws on a non-date value,
// so both must DEFER as an arm body, never throw mid-lowering. `asNumber` is admitted below
// only when it carries a type arg.
const SCALAR_ARM_TX = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'trim', 'lTrim', 'rTrim',
  'reverse', 'replace', 'substring', 'asDate', 'dateAdd', 'dateDiff',
]);
// Row ops with a throw-free non-origin (root-scope) path. `tail`/`dedup` are excluded on
// purpose: tail() requires an encounter column (throws at root) and dedup() clears the
// carried schema (withoutCarried), which would desync the union/choose merge that projects
// the outer carried columns off every arm — both defer cleanly as an arm instead.
const SCALAR_ARM_ROW = new Set(['is', 'constant', 'identity', 'order', 'limit', 'skip', 'range', 'unfold']);
const SCALAR_ARM_FILTER = new Set(['and', 'or', 'not', 'filter', 'where']);
// Nested per-traverser branches whose own arms are recursively scalar-arm bodies: a value
// branch inside a value arm lowers through lowerSteps→the same tryScalar*Child consumer, so
// choose(P,__.union(__.constant('a'),__.constant('b')),…) composes. The option-map choose
// form (step.options) carries its arm bodies off step.options, not step.args, so it is NOT
// recursed here (defers cleanly rather than being under-checked).
const SCALAR_ARM_BRANCH = new Set(['choose', 'union', 'coalesce', 'map', 'flatMap', 'local']);

/** A single scalar-arm leaf step the engine lowers without throwing. Kept in lockstep with
 *  what lowerScalarRows/SCALAR_TAIL actually support so the recognizer never accepts a body
 *  that would throw mid-lowering (breaking the return-null fall-through contract). */
const scalarArmLeafOk = (s: PStep): boolean =>
  SCALAR_ARM_TX.has(s.name) || SCALAR_ARM_ROW.has(s.name)
  || (s.name === 'asNumber' && (s.args ?? []).length > 0);

/** A value-op step allowed in the PREFIX of a scalar-parent CHILD body (before an optional
 *  terminal reducer). Unlike the root-scope arm set, the pushed scalar seed carries an
 *  encounter column, so the partitioned order/slice/tail/dedup paths are safe here; constant()
 *  is excluded (it defers inside a child scope) and asBool has no scalarTx impl. */
const SCALAR_CHILD_PREFIX = new Set([...SCALAR_ARM_TX, 'is', 'and', 'or', 'not', 'filter', 'where', 'constant', 'identity', 'unfold', 'math', 'order', 'limit', 'skip', 'range', 'tail', 'dedup']);
const scalarChildPrefixOk = (s: PStep): boolean =>
  SCALAR_CHILD_PREFIX.has(s.name) || (s.name === 'asNumber' && (s.args ?? []).length > 0);

function scalarBranchArm(body: PStep[], params: Record<string, any>): boolean {
  return body.length > 0 && body.every((s) => {
    const kids = (s.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
    // The filter family lowers via lowerScalarFilter, which requires a nested traversal —
    // the predicate-P form (where(gt(5))) throws, so require kids and recurse into each so
    // an unsupported nested body defers here rather than throwing mid-lowering.
    if (SCALAR_ARM_FILTER.has(s.name)) return kids.length > 0 && kids.every((a: any) => scalarBranchArm(childSteps(a.nested, params), params));
    // A nested value-branch: every arm must itself be a scalar value arm so the whole thing
    // stays scalar and never throws mid-lowering. Option-map choose (s.options) is excluded.
    if (SCALAR_ARM_BRANCH.has(s.name) && !(s as any).options)
      return kids.length > 0 && kids.every((a: any) => scalarBranchArm(childSteps(a.nested, params), params));
    return scalarArmLeafOk(s) && kids.length === 0;
  });
}

/** PURE. A terminal scoped reducer (count/sum/min/max/mean) over a value-op prefix — the
 *  child-scoped scalar arm that tryCompileScalarValueChild lowers per value. This is the
 *  reducer half of scalarArmClassifies: scalarBranchArm covers value/nested-branch arms at
 *  root scope, this covers the per-value reduction that needs the pushed child scope. */
function scalarReducerArm(body: PStep[]): boolean {
  const last = body.at(-1);
  if (!last || !CHILD_SCALAR_REDUCERS.has(last.name)) return false;
  return body.slice(0, -1).every(scalarChildPrefixOk);
}

/** PURE. A re-source arm (`V()`/`E()` head then an element remainder) that reduces/projects
 *  back to a scalar — the classify twin of compileScalarChildRows' re-source branch. A
 *  movement-only re-source needs a terminal count(); a projecting one (values/id/label) needs
 *  a valid element-child tail. Kept in lockstep with that branch so the recognizer never
 *  accepts a body the child compiler would decline. */
function scalarResourceArm(body: PStep[]): boolean {
  const last = body.at(-1);
  const reducer = last && CHILD_SCALAR_REDUCERS.has(last.name) ? last.name : undefined;
  const rest = reducer ? body.slice(0, -1) : body;
  if (!isResourceHead(rest)) return false;
  const after = rest.slice(1);
  return after.length === 0 || after.every((s) => ELEMENT_CHILD_STEPS.has(s.name))
    ? reducer === 'count'
    : classifyScalarChildRows('element', after)?.kind === 'element';
}

/** PURE. Predicts tryCompileScalarArm success without appending CTEs — the classify half of
 *  the gated consumers (choose/coalesce build a gate before lowering arms, so they must know
 *  every arm lowers before committing CTEs, matching the element-parent classify-then-emit). */
function scalarArmClassifies(body: PStep[], params: Record<string, any>): boolean {
  return scalarBranchArm(body, params) || scalarReducerArm(body) || scalarResourceArm(body);
}

/** Lower one branch/map arm body over a scalar (gated) parent → a ScalarStream, or null to
 *  defer. The scalar twin of tryCompileElementTraversal: a cardinality-preserving value body
 *  lowers at root scope (lowerScalarArm — transforms/is/filter/nested value-branch); a body
 *  whose terminal reduces per value (count/sum/min/max/mean) needs the pushed scalar child
 *  scope (tryCompileScalarValueChild). Shared by map/flatMap/local AND union/choose/coalesce. */
export function tryCompileScalarArm(parent: ScalarStream, nested: any, scope: CompileScope = ROOT_SCOPE): ScalarStream | null {
  return lowerScalarArm(parent, childSteps(nested, parent.params))
    ?? tryCompileScalarValueChild(parent, nested, 'all', scope);
}

/** Lower one scalar arm body over the scalar parent, returning null (defer) if it falls
 *  outside the Stage-1 vocabulary or does not stay scalar (e.g. a fold() → list). */
function lowerScalarArm(s: ScalarStream, body: PStep[]): ScalarStream | null {
  if (!scalarBranchArm(body, s.params)) return null;
  const end = lowerStepsStrict(s, body, 0);
  return end.kind === 'scalar' ? end : null;
}

/** PURE. Does this scalar arm body emit MORE than one value per input? A terminal reducer or
 *  fold() collapses to one; a `V()`/`E()` re-source (bare or projecting) or a nested `union`
 *  fans out; a nested choose/coalesce fans out only if a reachable arm does. Used to gate
 *  `map()` (first-result-only) — it fails closed on a fan-out body it would otherwise
 *  over-produce, rather than returning the wrong count. */
function armFansOut(body: PStep[], params: Record<string, any>): boolean {
  const last = body.at(-1);
  if (last && (CHILD_SCALAR_REDUCERS.has(last.name) || last.name === 'fold')) return false;
  if (isResourceHead(body)) return true;
  return body.some((s) => {
    if (s.name === 'union') return true;
    const kids = (s.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
    return SCALAR_ARM_BRANCH.has(s.name) && kids.some((a: any) => armFansOut(childSteps(a.nested, params), params));
  });
}

/** map()/local()/flatMap() over a scalar: apply the arm body per value. `flatMap`/`local` emit
 *  every result (`allowFanout`); `map` is first-result-only. A fan-out body (a nested `union`/
 *  fan-out `choose`/`coalesce`) takes the FIRST emitted result per input — a pushed child scope
 *  + the 'first' cardinality policy, keyed on the branch merge's synthesized emission encounter
 *  (unionScalarStreams). A bare re-source (V()/E()) fan-out carries no encounter yet (Stage B),
 *  so it still fails closed inside the 'first' policy. A ≤1 body (transform/filter/choose/
 *  coalesce/reducer) is identical under map/flatMap/local. */
export function tryScalarMapChild(s: ScalarStream, step: PStep, allowFanout = true): ScalarStream | null {
  const arg = step.args?.[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  if (!allowFanout && armFansOut(childSteps(arg.nested, s.params), s.params))
    return tryCompileScalarValueChild(s, arg.nested, 'first');
  return tryCompileScalarArm(s, arg.nested);
}

// ---------- scalar choose/coalesce gate: inline fast path ⟷ generic child-existence ----------
//
// choose/coalesce over a scalar partition the value rows by a predicate (choose) or per-arm
// productivity (coalesce). The boolean per predicate is computed one of two RESULT-EQUIVALENT
// ways, mirroring the scalar filter predicate fast path (scalar.ts lowerScalarFilter /
// tryScalarFilterByChildExistence):
//   - inline (fast): a WHERE over the value `v` (tryInlineScalarPredicate / predicateSql).
//   - generic: each traversal predicate compiles over ONE pushed scalar child scope; its boolean
//     is a correlated EXISTS keyed on the shared ordinal, and the seed filters the pushed domain.
// scalarPredicateInlining:false forces the generic path, so DISABLING the switch compiles the
// same traversal generically (the fast-path law — enabled≡disabled, proven in the equivalence
// test). A traversal predicate with no scalar compilation → null (clean defer, never a throw).

type ScalarGateSpec = { readonly p: any } | { readonly nested: any };

/** Partitions a scalar parent's rows by one or more predicate specs. `seed(combine)` returns
 *  the parent scalar stream keeping the rows for which `combine` (built from the per-spec
 *  booleans) holds — the scalar shape/tag/encounter/carried schema is preserved, only rows drop. */
interface ScalarGate {
  seed(combine: (bools: readonly Expression[]) => Expression): ScalarStream;
}

/** Inline gate: every spec's boolean is a WHERE over the value. Declines (null) if a traversal
 *  spec is outside the inline scalar-predicate vocabulary → the caller falls to the generic gate. */
function inlineScalarGate(s: ScalarStream, specs: readonly ScalarGateSpec[]): ScalarGate | null {
  const bodies = specs.map((sp) => 'nested' in sp ? childSteps(sp.nested, s.params) : null);
  // Probe inlineability independent of the concrete value; a non-inline body → use the generic gate.
  if (bodies.some((b) => b && tryInlineScalarPredicate(b, value(0), s.params) === null)) return null;
  return {
    seed: (combine) => gateScalar(s, (v, vt) =>
      combine(specs.map((sp, i) => 'p' in sp
        ? predicateSql(v, sp.p, vt ? { vtypeExpr: vt } : undefined)
        : tryInlineScalarPredicate(bodies[i]!, v, s.params, vt)!))),
  };
}

/** Generic gate: ONE pushed scalar child scope. A traversal spec's boolean is a correlated
 *  EXISTS over its child rows (keyed on the shared ordinal); a P spec's boolean is a predicate
 *  over the domain value. seed() filters the domain and restores the parent's exact scalar
 *  payload (dropping the pushed ordinal). Null if a traversal spec has no scalar compilation. */
function genericScalarGate(s: ScalarStream, specs: readonly ScalarGateSpec[]): ScalarGate | null {
  const { scope, frame, seed: pushed } = pushChildScope(s);
  const d = frame.domain.as('d');
  const vt = s.vtype ? d.c[s.vtype] : undefined;
  const bools: Expression[] = [];
  for (const sp of specs) {
    if ('p' in sp) { bools.push(predicateSql(d.c.v, sp.p, vt ? { vtypeExpr: vt } : undefined)); continue; }
    const child = tryCompileScalarValueRows(pushed, sp.nested, reuseCurrentFrame(scope, frame));
    if (!child) return null;
    const c = child.stream.rel.as('c');
    bools.push(q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[frame.ordinal]}=${d.c[frame.ordinal]})`);
  }
  // encounter now rides in carried (carryFrag), so it's NOT listed in the payload — the
  // transient pushed frame's ordinal is dropped; the parent's carried (incl. its encounter)
  // is restored verbatim from the domain.
  const payloadCols = ['v', ...(s.result === 'number' ? ['vt'] : []), ...(s.vtype ? [s.vtype] : [])];
  return {
    seed: (combine) => {
      const proj = payloadCols.map((col) => q`${d.c[col]} AS ${col}`);
      const rel = s.q.cte(
        q`SELECT ${list(proj, ', ')}${carryFrag(s.carried, d)} FROM ${d} WHERE ${combine(bools)}`,
        [...payloadCols, ...carriedCols(s.carried)],
      );
      return toScalarStream(carryOf(s), rel, s.as, { result: s.result, productiveNull: s.productiveNull, vtype: s.vtype });
    },
  };
}

/** Pick the inline fast path unless scalarPredicateInlining is off, or a traversal predicate is
 *  beyond the inline vocabulary; then use the generic child-existence gate. Result-equivalent. */
function buildScalarGate(s: ScalarStream, specs: readonly ScalarGateSpec[]): ScalarGate | null {
  if (s.fastPaths?.scalarPredicateInlining !== false) {
    const inline = inlineScalarGate(s, specs);
    if (inline) return inline;
  }
  return genericScalarGate(s, specs);
}

/** choose(pred, then[, else]) over a scalar. The predicate is a P (applied to `v` via
 *  predicateSql) or a nested traversal (buildScalarGate: inline over `v`, or a correlated
 *  EXISTS when the switch is off / the body is beyond the inline vocabulary). It gates the
 *  value rows into disjoint then/else seeds, each arm lowers over its seed, and the two merge
 *  with UNION ALL. else absent → the value passes through unchanged (identity). */
export function tryScalarChooseChild(s: ScalarStream, step: PStep): ScalarStream | null {
  if (step.options) return null; // option-map form is a later stage (modulator consumer)
  const args = step.args ?? [];
  const nested = args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  const predIsTraversal = args[0] && typeof args[0] === 'object' && 'nested' in args[0];
  const [thenArg, elseArg] = predIsTraversal ? nested.slice(1) : nested;
  if (!thenArg) return null;
  // Classify-then-emit: prove both arms lower (value, reducer, or nested-branch) BEFORE the
  // gate appends its CTEs, so a deferring arm never orphans gate SQL (mirrors branch.ts).
  const thenBody = childSteps(thenArg.nested, s.params);
  if (!scalarArmClassifies(thenBody, s.params)) return null;
  const elseBody = elseArg ? childSteps(elseArg.nested, s.params) : null;
  if (elseBody && !scalarArmClassifies(elseBody, s.params)) return null;

  const gate = buildScalarGate(s, [predIsTraversal ? { nested: args[0].nested } : { p: args[0] }]);
  if (!gate) return null;
  const thenEnd = tryCompileScalarArm(gate.seed((b) => b[0]), thenArg.nested);
  if (!thenEnd) return null;
  const elseSeed = gate.seed((b) => q`NOT COALESCE((${b[0]}), 0)`);
  const elseEnd = elseArg ? tryCompileScalarArm(elseSeed, elseArg.nested) : elseSeed; // no else → identity value
  if (!elseEnd) return null;
  return unionScalarStreams(s, [thenEnd, elseEnd]);
}

/** union(a, b, …) over a scalar: every arm consumes the whole value stream; UNION ALL
 *  concatenates their productive rows (multiset-faithful, so a value can appear per arm). */
export function tryScalarUnionChild(s: ScalarStream, step: PStep): ScalarStream | null {
  const branches = (step.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) return null;
  const arms: ScalarStream[] = [];
  for (const b of branches) {
    const end = tryCompileScalarArm(s, b.nested);
    if (!end) return null;
    arms.push(end);
  }
  return unionScalarStreams(s, arms);
}

/** coalesce(a, b, …) over a scalar: the first arm that PRODUCES a value, per input row. Arm k is
 *  gated by "still unclaimed by every earlier arm AND this arm produces"; productivity is each
 *  arm body's gate boolean (buildScalarGate — inline over `v`, or a correlated EXISTS when the
 *  switch is off / the body is beyond the inline vocabulary). All arms share ONE gate/scope. */
export function tryScalarCoalesceChild(s: ScalarStream, step: PStep): ScalarStream | null {
  const branches = (step.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 1) return null;
  const bodies = branches.map((b: any) => childSteps(b.nested, s.params));
  // Classify-then-emit: every arm must lower before the shared gate commits its CTEs.
  if (bodies.some((body: PStep[]) => !scalarArmClassifies(body, s.params))) return null;
  const gate = buildScalarGate(s, branches.map((b: any) => ({ nested: b.nested })));
  if (!gate) return null;
  const arms: ScalarStream[] = [];
  for (let k = 0; k < bodies.length; k++) {
    const seed = gate.seed((bools) => {
      const prior = bools.slice(0, k).map((b) => q`NOT COALESCE((${b}), 0)`);
      return list([...prior, paren(bools[k])], ' AND ');
    });
    const end = tryCompileScalarArm(seed, branches[k].nested);
    if (!end) return null;
    arms.push(end);
  }
  return unionScalarStreams(s, arms);
}

// ---------- scalar-PARENT mixed-shape arms → a VariantStream ----------
//
// When a scalar parent's branch arms disagree on shape — a scalar value arm next to a
// re-source element arm (`__.V()`) or a fold list arm — no homogeneous merge applies
// (unionScalarStreams assumes every arm has a `v`). They merge into the SAME VariantStream
// the element parent produces: each arm compiles to its natural shape and the rows carry a
// `vk` tag (1 scalar / 2 node / 3 edge / 4 list). The merge builders (variantArmSelect/
// variantArmsMeta/variantCols) are parent-agnostic (Carry-typed, branch.ts) so this reuses
// them verbatim; only the per-arm compiler differs (a scalar re-sources rather than walks).

/** An element arm over a scalar: a re-source (`V()`/`E()`) then element movement/filter,
 *  ending in element space. No gating (union), so it lowers over the parent value rows
 *  directly — lowerScalarVE CROSS JOINs the graph per value, movement folds on top. */
function tryScalarResourceElement(seed: ScalarStream, nested: any): ElementStream | null {
  const body = childSteps(nested, seed.params);
  if (!isResourceHead(body)) return null;
  const after = body.slice(1);
  if (!after.every((s) => ELEMENT_CHILD_STEPS.has(s.name))) return null;
  return resourceElement(seed, body[0], after);
}

/** PURE. A fold list arm over a scalar: a value-op body OR a re-source projection, then
 *  fold(). The classify twin of tryCompileListChild's scalar path. */
function scalarListArm(body: PStep[]): boolean {
  if (body.at(-1)?.name !== 'fold') return false;
  const before = body.slice(0, -1);
  if (before.length > 0 && before.every(scalarChildPrefixOk)) return true;
  if (isResourceHead(before)) {
    const after = before.slice(1);
    return after.length > 0 && classifyScalarChildRows('element', after)?.kind === 'element';
  }
  return false;
}

/** PURE. The natural shape of one scalar-parent arm: list (fold), scalar (value/reducer/
 *  re-source-count/re-source-projection), or element (a movement-only re-source). Null =
 *  unclassifiable → the caller defers. The scalar twin of branch.ts's armShape. */
function scalarArmShape(nested: any, params: Record<string, any>): 'element' | 'scalar' | 'list' | null {
  const body = childSteps(nested, params);
  if (scalarListArm(body)) return 'list';
  if (scalarArmClassifies(body, params)) return 'scalar';
  if (isResourceHead(body) && body.slice(1).every((s) => ELEMENT_CHILD_STEPS.has(s.name))) return 'element';
  return null;
}

/** Compile ONE scalar-parent arm to its natural variant shape (scalar/list/element). The
 *  arms are shape-classified up front (scalarArmShape), so a classified arm always compiles;
 *  the throw is an internal-contradiction guard, never the defer path. */
function compileScalarVariantArm(seed: ScalarStream, nested: any): VariantArm {
  const scalar = tryCompileScalarArm(seed, nested);
  if (scalar) return { rel: scalar.rel, vk: 1, as: scalar.as };
  const listArm = tryCompileListChild(seed, nested);
  if (listArm) return { rel: listArm.rel, vk: 4, listOf: listArm.of };
  const el = tryScalarResourceElement(seed, nested);
  if (el) return { rel: el.rel, vk: el.elem === 'edge' ? 3 : 2 };
  throw new Error('scalar variant arm classified but did not compile (internal contradiction)');
}

/** union(a, b, …) over a scalar with MIXED-shape arms → a VariantStream (plain UNION ALL, no
 *  gating). Declines (null) when the arms are homogeneous (tryScalarUnionChild owns those) or
 *  any arm is unclassifiable, or under carried path/sack/fromV (fork/merge unworked). */
export function tryScalarVariantUnion(s: ScalarStream, step: PStep): VariantStream | null {
  if (s.carried.path || s.carried.sack || s.carried.fromV) return null;
  const branches = (step.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (branches.length < 2) return null;
  const shapes = branches.map((b: any) => scalarArmShape(b.nested, s.params));
  if (shapes.some((x) => x === null) || shapes.every((x) => x === shapes[0])) return null;
  const arms = branches.map((b: any) => compileScalarVariantArm(s, b.nested));
  const meta = variantArmsMeta(arms);
  const hasList = !!meta.listOf;
  const rel = s.q.cte(list(arms.map((a) => variantArmSelect(a, s, hasList)), ' UNION ALL '), variantCols(s, hasList));
  return toVariantStream(carryOf(s), rel, meta);
}

/** choose(pred, then, else) over a scalar with MIXED-shape then/else → a VariantStream. The
 *  gate partitions the value rows (pred / NOT pred) into disjoint then/else seeds — exactly
 *  tryScalarChooseChild's gate — and each arm compiles to its natural variant shape over its
 *  seed. Declines when the arms are the same shape (tryScalarChooseChild owns those), the 2-arg
 *  identity-else form, or any arm is unclassifiable. */
export function tryScalarVariantChoose(s: ScalarStream, step: PStep): VariantStream | null {
  if (step.options) return null; // option-map form is the modulation seam
  if (s.carried.path || s.carried.sack || s.carried.fromV) return null;
  const args = step.args ?? [];
  const nested = args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  const predIsTraversal = args[0] && typeof args[0] === 'object' && 'nested' in args[0];
  const [thenArg, elseArg] = predIsTraversal ? nested.slice(1) : nested;
  if (!thenArg || !elseArg) return null; // 2-arg (identity else) is not a mixed pair here
  const thenShape = scalarArmShape(thenArg.nested, s.params);
  const elseShape = scalarArmShape(elseArg.nested, s.params);
  if (!thenShape || !elseShape || thenShape === elseShape) return null;
  const gate = buildScalarGate(s, [predIsTraversal ? { nested: args[0].nested } : { p: args[0] }]);
  if (!gate) return null;
  const arms = [
    compileScalarVariantArm(gate.seed((b) => b[0]), thenArg.nested),
    compileScalarVariantArm(gate.seed((b) => q`NOT COALESCE((${b[0]}), 0)`), elseArg.nested),
  ];
  const meta = variantArmsMeta(arms);
  const hasList = !!meta.listOf;
  const rel = s.q.cte(list(arms.map((a) => variantArmSelect(a, s, hasList)), ' UNION ALL '), variantCols(s, hasList));
  return toVariantStream(carryOf(s), rel, meta);
}

/** coalesce(a, b, …) over a scalar with MIXED-shape arms → a VariantStream. One pushed
 *  ordinal-tagged seed feeds every arm (compiled to its natural variant shape); arm k emits
 *  only for inputs no earlier arm produced a row for (`ord NOT IN prior`) — the first-productive
 *  rule, exactly branch.ts's tryLowerVariantCoalesce, over a scalar seed. Declines for
 *  homogeneous arms (tryScalarCoalesceChild owns those) or an unclassifiable arm. */
export function tryScalarVariantCoalesce(s: ScalarStream, step: PStep): VariantStream | null {
  if (s.carried.path || s.carried.sack || s.carried.fromV) return null;
  const branches = (step.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (!branches.length) return null;
  const shapes = branches.map((b: any) => scalarArmShape(b.nested, s.params));
  if (shapes.some((x) => x === null) || shapes.every((x) => x === shapes[0])) return null;
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arms = branches.map((b: any) => compileScalarVariantArm(seed, b.nested));
  const meta = variantArmsMeta(arms);
  const hasList = !!meta.listOf;
  const parts = arms.map((arm, k) => variantArmSelect(arm, s, hasList, k === 0 ? undefined
    : (a) => list(arms.slice(0, k).map((pr) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND ')));
  const rel = s.q.cte(list(parts, ' UNION ALL '), variantCols(s, hasList));
  return toVariantStream(carryOf(s), rel, meta);
}

/** optional(t) over a scalar with a SCALAR arm ≡ coalesce(t, identity): the arm's value where
 *  it produces, else the input value restored (a filter arm that drops a value → the original
 *  passes through). Homogeneous → a scalar stream; an element/list arm takes the variant path. */
export function tryScalarOptionalChild(s: ScalarStream, step: PStep): ScalarStream | null {
  if (s.carried.sack || s.carried.fromV) return null;
  const arg = step.args?.[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  if (!scalarArmClassifies(childSteps(arg.nested, s.params), s.params)) return null;
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arm = tryCompileScalarArm(seed, arg.nested);
  if (!arm) return null;
  const numeric = arm.result === 'number';
  const cols = ['v', ...(numeric ? ['vt'] : []), ...carriedCols(s.carried)];
  const a = arm.rel.as('a');
  const d = frame.domain.as('d');
  const am = arm.rel.as('am');
  const hit = q`SELECT ${a.c.v} AS v${numeric ? q`, ${a.c.vt} AS vt` : empty}${carryFrag(s.carried, a)} FROM ${a}`;
  const miss = q`SELECT ${d.c.v} AS v${numeric ? q`, NULL AS vt` : empty}${carryFrag(s.carried, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${am} WHERE ${am.c[ord]}=${d.c[ord]})`;
  const rel = s.q.cte(list([hit, miss], ' UNION ALL '), cols);
  return toScalarStream(carryOf(s), rel, arm.as, { result: numeric ? 'number' : 'value' });
}

/** optional(t) over a scalar with an ELEMENT/LIST arm → a VariantStream: the arm's rows where it
 *  produces (vk 2/3/4), else the input VALUE restored (vk 1). The scalar twin of branch.ts's
 *  tryLowerVariantOptional (flipped: there the miss is an element, here the miss is the value). */
export function tryScalarVariantOptional(s: ScalarStream, step: PStep): VariantStream | null {
  if (s.carried.path || s.carried.sack || s.carried.fromV) return null;
  const arg = step.args?.[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) return null;
  const shape = scalarArmShape(arg.nested, s.params);
  if (shape === null || shape === 'scalar') return null; // scalar arm → tryScalarOptionalChild
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arm = compileScalarVariantArm(seed, arg.nested);
  const hasList = arm.vk === 4;
  const d = frame.domain.as('d');
  const am = arm.rel.as('am');
  const listNull = hasList ? q`, NULL AS list` : empty;
  const hit = variantArmSelect(arm, s, hasList);
  const miss = q`SELECT 1 AS vk, ${d.c.v} AS v, NULL AS rid${listNull}${carryFrag(s.carried, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${am} WHERE ${am.c[ord]}=${d.c[ord]})`;
  const rel = s.q.cte(list([hit, miss], ' UNION ALL '), variantCols(s, hasList));
  return toVariantStream(carryOf(s), rel, { ...variantArmsMeta([arm]), scalarAs: s.as });
}

/**
 * Generic child-existence gate for and/or/not/filter/where over a SCALAR stream — the
 * disable-safe fallback when the inline predicate (lowerScalarFilter) declines (switch off, or
 * a body beyond the inline vocabulary, e.g. a reducer arm). Each traversal arm compiles over ONE
 * pushed scalar child scope; the parent value rows are filtered on the arms' correlated EXISTS
 * (combined AND/OR, negated for not). The value schema is restored exactly from the pushed
 * domain (only rows drop). Returns null if an arm has no generic scalar compilation, or for the
 * predicate-P form (which has no traversal child — that path is inline-only).
 */
export function tryScalarFilterByChildExistence(s: ScalarStream, step: PStep): ScalarStream | null {
  const nested = (step.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (!nested.length) return null;
  const { scope, frame, seed } = pushChildScope(s);
  const d = frame.domain.as('d');
  const terms: Expression[] = [];
  for (const arm of nested) {
    const child = tryCompileScalarValueRows(seed, arm.nested, reuseCurrentFrame(scope, frame));
    if (!child) return null;
    const c = child.stream.rel.as('c');
    terms.push(q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[frame.ordinal]}=${d.c[frame.ordinal]})`);
  }
  const combined = paren(list(terms.map(paren), step.name === 'or' ? ' OR ' : ' AND '));
  const cond = step.name === 'not' ? q`NOT (${combined})` : combined;
  // Restore the parent's exact scalar payload from the pushed domain (drop the pushed ordinal).
  // encounter rides in carried (carryFrag), so it is NOT listed in the payload.
  const payloadCols = ['v', ...(s.result === 'number' ? ['vt'] : []), ...(s.vtype ? [s.vtype] : [])];
  const proj = payloadCols.map((col) => q`${d.c[col]} AS ${col}`);
  const rel = s.q.cte(
    q`SELECT ${list(proj, ', ')}${carryFrag(s.carried, d)} FROM ${d} WHERE ${cond}`,
    [...payloadCols, ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, s.as, { result: s.result, productiveNull: s.productiveNull, vtype: s.vtype });
}
