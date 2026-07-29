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

import { ALWAYS_PRODUCTIVE_TERMINAL } from '../../ir/productivity.ts';
import type { Relation } from '../../../sql/kernel/q.ts';
import { isColumnArg, isOperatorArg, isOrderArg, isPickArg, isScopeArg, isTokenArg, isNested, stepChain } from '../../../gremlin/frontend.ts';
import type { AliasMap, TraverserLayout, ElementStream } from '../context/context.ts';
import type { PropertyStream, ScalarStream, Stream } from '../context/stream.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { normalize } from '../../ir/passes.ts';
import { SCALAR_TRANSFORMS } from './coerce.ts';

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
  readonly traverserLayout: TraverserLayout;
}
export interface ChildScope {
  readonly kind: 'child';
  readonly frames: readonly ChildFrame[];
  /** One-shot proof that the next child seed is still one row per current frame. */
  readonly reuseFrame?: ChildFrame;
}
export type ChildFrameStack = RootScope | ChildScope;

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
 * order().by() must arrive as one IRStep before shape-aware scalar lowering. */
export const childSteps = (nested: any, params: Record<string, any>) => {
  const rawSteps = stepChain(nested, params);
  const normalized = normalize(rawSteps);
  return normalized.discard ? [...normalized.steps, rawSteps.at(-1)!] : normalized.steps;
};

// ---------- the classify CONTEXT: bound params + the labels visible here ----------
//
// Every classifier below is a syntax-only peek — with ONE unavoidable exception: a body's shape
// can depend on what an as()-LABEL holds. `select("a")` re-types the stream to the label's
// contents (an element, a value, a list), and that fact lives on the enclosing traverser's
// carried alias map, not in the body's text. So the classifiers take a `ChildCtx`: the query's
// bound params (needed to parse a nested body) PLUS a `LabelEnv` — label → the child-shape it
// holds at THIS position.
//
// The env is what makes labels compose at DEPTH. It is seeded from the parent stream's carried
// aliases (so a label bound anywhere up the chain is visible inside a child body, at any nesting
// level — pushChildScope already projects those columns into every frame), and it is EXTENDED as
// a body is scanned, so an as() earlier in the body types a select() later in it, and a nested
// arm/child classifies against the labels visible where IT sits. One rule, applied at every
// recursion, instead of a per-position vocabulary patch.
//
// A ctx-free caller (the few sites with no parent stream to hand) behaves exactly as the old
// params-free callers did: conservatively reject anything that needs context.

/** The three shapes a child body can carry. The `BranchArmShape` vocabulary minus its `null`. */
export type ChildShape = 'element' | 'scalar' | 'list';

/** label → the child-shape it holds. `null` = bound, but to a shape the child seam cannot
 *  re-type (a mixed-shape history, a map, a property) — distinct from ABSENT, which means no
 *  binding is visible at all. The distinction is load-bearing: an absent label is TinkerPop's
 *  drop-every-traverser case (an empty element stream, exactly what selectOneFromAlias emits at
 *  root), while a bound-but-unmappable one must DEFER, never be answered as empty. */
export type LabelEnv = ReadonlyMap<string, ChildShape | null>;

export interface ChildCtx {
  readonly params: Record<string, any>;
  readonly labels: LabelEnv;
}

const NO_LABELS: LabelEnv = new Map();

/** The child-shape one alias entry's history can be re-typed to (see LabelEnv). */
function entryShape(shapes: ReadonlySet<string>): ChildShape | null {
  if (shapes.size !== 1) return null; // a heterogeneous history has no single re-entry shape
  const [s] = shapes;
  return s === 'vertex' || s === 'edge' ? 'element' : s === 'value' ? 'scalar' : s === 'list' ? 'list' : null;
}

// Memoized per alias Map: classifiers run in tight cascades (every branch arm, every by()), and
// the env is a pure function of the carried alias map, which is itself immutable per hop.
const ENV_CACHE = new WeakMap<AliasMap, LabelEnv>();

/** The labels a carried alias map makes visible to a child body. */
export function labelEnvOf(aliases: AliasMap): LabelEnv {
  if (!aliases.size) return NO_LABELS;
  const hit = ENV_CACHE.get(aliases);
  if (hit) return hit;
  const env = new Map<string, ChildShape | null>();
  for (const [label, entry] of aliases) env.set(label, entryShape(entry.shapes));
  ENV_CACHE.set(aliases, env);
  return env;
}

/** The classify context of a parent stream. Any Stream satisfies the structural shape, so call
 *  sites pass the parent itself rather than picking `.params` off it. */
export const childCtx = (s: { params: Record<string, any>; traverserLayout: TraverserLayout }): ChildCtx =>
  ({ params: s.params, labels: labelEnvOf(s.traverserLayout.aliases) });

/** A ctx whose visible labels are `ctx`'s plus the ones `s` binds, when `s` is an as(). Called
 *  as a body is walked, so a label is visible to exactly the steps that FOLLOW its binding. */
function bindLabels(ctx: ChildCtx | undefined, s: IRStep, shape: ChildShape): ChildCtx | undefined {
  if (!ctx || s.name !== 'as') return ctx;
  const labels = (s.args ?? []).filter((a: any): a is string => typeof a === 'string');
  if (!labels.length) return ctx;
  const next = new Map(ctx.labels);
  for (const l of labels) next.set(l, shape);
  return { params: ctx.params, labels: next };
}

/** PURE. The single-label path-history read `select("a")` / `select(Pop.first, "a")` — as
 *  opposed to select(Column.*), a multi-label select (a Record) or a by()-modulated one. Those
 *  have their own consumers; only this form re-types the stream to a label's contents. */
export function labelSelectOf(step: IRStep): string | null {
  if (step.name !== 'select' || step.modulators?.length) return null;
  const args = step.args ?? [];
  if (args.some(isColumnArg)) return null;
  const uniq = [...new Set(args.filter((a: any): a is string => typeof a === 'string'))];
  return uniq.length === 1 ? uniq[0] : null;
}

/** Steps that resolve a path-history LABEL out of the carried alias columns: as() binds one,
 *  select("a")/where("a",…)/dedup("a") read one. Recognized by carrying a STRING argument —
 *  select(Column.keys), where(P), dedup() take none. */
const LABEL_STEPS = new Set(['as', 'select', 'where', 'dedup']);

/** PURE. Does this body mention a path-history label anywhere, at any nesting depth?
 *
 *  The one consumer is the INLINE CORRELATED renderer (correlated.ts): it seeds a bare
 *  `SELECT <outer id> AS id` with no carried columns, so alias columns are physically absent
 *  inside it — and an absent alias column is INDISTINGUISHABLE from a never-bound label, which
 *  select() answers as "drop every traverser". That would be a silently wrong answer, so the
 *  inline path declines any body that mentions a label and the caller falls through to the
 *  materialized generic gate, which carries the full schema. Exactly the fast-path contract:
 *  recognition-failure falls through, never mis-executes. */
export function mentionsLabel(steps: readonly IRStep[], params: Record<string, any>): boolean {
  return labelsMentioned(steps, params).size > 0;
}

/** PURE. WHICH labels a body mentions, at any nesting depth — the set behind `mentionsLabel`.
 *
 *  The second consumer is match()'s scheduler (prefix/match.ts): a FILTER argument is ready to
 *  apply once every variable it reads is bound, so it needs the names, not just whether there are
 *  any. One scanner answers both questions — the boolean is this set being non-empty — so the two
 *  can never disagree about what counts as mentioning a label. */
export function labelsMentioned(steps: readonly IRStep[], params: Record<string, any>): Set<string> {
  const out = new Set<string>();
  for (const s of steps) {
    if (LABEL_STEPS.has(s.name)) {
      for (const a of s.args ?? []) {
        if (typeof a === 'string') out.add(a);
        // `where("a", P.neq("c"))` compares two LABELS, and the second one rides inside the
        // predicate rather than as a bare arg (filter.ts resolves it via aliasIdExpr, the same as
        // the first). A scanner that read only bare args would miss it — which for match()'s
        // scheduler means running the filter before "c" is bound.
        else if (a && typeof a === 'object' && 'op' in a)
          for (const v of ((a as any).values ?? [])) if (typeof v === 'string') out.add(v);
      }
    }
    for (const a of (s.args ?? []).filter(isNested))
      for (const l of labelsMentioned(childSteps((a as any).nested, params), params)) out.add(l);
  }
  return out;
}

/** PURE. The shape a `select(label)` yields here, or undefined when the child seam must decline
 *  (no context to resolve against, or a bound-but-unmappable label — see LabelEnv). */
function selectShape(step: IRStep, ctx: ChildCtx | undefined): ChildShape | undefined {
  const label = labelSelectOf(step);
  if (label === null || !ctx) return undefined;
  const held = ctx.labels.get(label);
  // Absent: no binding visible → every traverser drops. That is an EMPTY ELEMENT stream, the
  // same answer selectOneFromAlias gives at root, so the body stays element-shaped.
  return held === undefined ? 'element' : held ?? undefined;
}

/** Prefix steps whose implementations physically preserve child origins. This first
 * generic-child slice is deliberately smaller than PREFIX: global barriers/windows,
 * forks, repeat, sack and path-sensitive steps need their explicit child policy.
 *
 * `as()` IS here: it is shape-preserving at every shape (element→element via the prefix StepFn,
 * every other shape via asOnStream), so it composes wherever the shape it wraps composes — one
 * fact, rather than a per-position admission. Whether the binding ESCAPES the child is decided
 * by the consumer's boundary, not here, and the existing boundaries already get it right: a
 * MAPPING consumer pops the child stream (popChildScope carries the child's own carried, so the
 * label rides out — TinkerPop's map/local/flatMap/branch-arm semantics), while a FILTER or by()
 * consumer re-projects the parent domain (layoutProjection(parent.carried, …), so the label is confined
 * to the child — equally TinkerPop's). */
// `otherV` belongs with the other eight movements and its absence here was the last gate on an
// exploded-edge body: it is purely row-local (it reads the current edge's endpoint that ISN'T the
// carried `fv`), and the emit side was already ready — `lowerElementSteps` derives `trackFromV`
// per-scope, which the child compiler's own note points at. So a `bothE().otherV()` body composes
// wherever any other movement does (`local`, `repeat`, a branch arm), rather than one position at a
// time.
// `repeat` (with its folded emit/times/until cluster) is here because a recursive walk IS row-local
// — each traverser walks independently — and the walk now carries its origin column through, which
// was the only thing missing. That admits it at every child position (`local`/`map`/`where`/`group`/
// `order` over a walk) AND inside another repeat's body, which are the same capability seen from two
// sides. Its own guards still fail closed for the parts that are not row-local (a live alias, a
// path spanning the walk).
export const ELEMENT_CHILD_STEPS = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV', 'otherV',
  'has', 'hasLabel', 'hasId', 'where', 'filter', 'not', 'and', 'or', 'identity', 'as',
  'repeat', 'emit', 'times', 'until',
]);
/** An element-PRESERVING child step: the ELEMENT_CHILD_STEPS movement/filter/as() vocabulary,
 *  PLUS a mutate sack(op) (element→element, folds the carried sack), a `select(label)` that
 *  re-roots on an ELEMENT-shaped label, and a uniform-element branch. All lower through the SAME
 *  engine per parent, so a scoped sack (local(__.sack(op).by(...))) reuses the root sack StepFn
 *  and a label re-root reuses the root select — no bespoke child reader. Bare read sack() is NOT
 *  here (it's a scalar producer). A ctx-free caller conservatively rejects the two context-
 *  dependent forms. */
export const isElementChildStep = (s: IRStep, ctx?: ChildCtx): boolean =>
  ELEMENT_CHILD_STEPS.has(s.name) || isSackMutate(s)
  || selectShape(s, ctx) === 'element'
  || (ctx !== undefined && isUniformElementBranch(s, ctx));

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
export function isUniformElementBranch(s: IRStep, ctx: ChildCtx): boolean {
  const kind = asBranchKind(s.name);
  if (!kind || (s as IRStep).optionArms) return false;
  const { shapes } = classifyBranchArms(kind, s, ctx);
  return shapes.length > 0 && shapes.every((sh) => sh === 'element');
}
/** The scalar-producing projection vocabulary the element-parent classifier recognizes:
 *  a step that, over an element prefix, lowers to one scalar per input. `values`/`id`/`label`
 *  read the element; `constant` rebinds it; `call`/`math`/`sack`/`format` are the generalized
 *  producers (a service, a formula, sack read, a string template) — each already lowers to a
 *  ScalarStream at root via its own tail StepFn, so recognizing it here lets the generic emit
 *  path (pushChildScope → lowerSteps) run it per parent WITHOUT a bespoke child reader.
 *  Kept in lockstep with the scalar-producing tail entries in projection.ts (SCALAR_PROJ +
 *  call/math/sack/format); count() is a reducer/barrier with its own classifyCountChild path. */
const SCALAR_PRODUCER = new Set(['values', 'id', 'label', 'constant', 'call', 'math', 'sack', 'format']);

/** A step that turns the current element into ONE scalar per input: the SCALAR_PRODUCER
 *  vocabulary, or a `select(label)` reading a VALUE-shaped label (the label's contents are the
 *  scalar — the read-a-label twin of read-a-property). A mutate sack(op) is element-preserving,
 *  never a producer. */
const isScalarProducer = (s: IRStep, ctx: ChildCtx | undefined): boolean =>
  (SCALAR_PRODUCER.has(s.name) && !isSackMutate(s)) || selectShape(s, ctx) === 'scalar';

/** A sack step in its MUTATE form (`sack(Operator.x)` — carries an operator arg). This is
 *  element-PRESERVING (element→element, folds the carried sack), so it belongs in an element
 *  prefix, NOT as a scalar producer. Only the BARE read form `sack()` produces a scalar. Mirror
 *  of engine.ts isSackMutate, kept here so this pure leaf has no engine dependency. */
export const isSackMutate = (s: IRStep): boolean =>
  s.name === 'sack' && (s.args ?? []).some(isOperatorArg);
/** A bare read `sack()` — the scalar-producing form (rebinds the value to the carried sack). */
const isSackRead = (s: IRStep): boolean => s.name === 'sack' && !isSackMutate(s);
/** The projections compileScalarChildRows reads with its own element-projection SQL builder (and
 *  so can continue through any scalar row tail). Every other producer lowers via lowerSteps. */
const BESPOKE_PROJECTIONS = new Set(['values', 'id', 'label', 'constant']);
/** The terminal barrier vocabulary a scalar child row-run may reduce through. Defined in this
 *  pure leaf and re-exported by child.ts (the compiler half) so the classify and emit sides read
 *  ONE set — they used to declare it twice. */
export const CHILD_SCALAR_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);
const CHILD_SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup',
  ...CHILD_SCALAR_REDUCERS, 'as',
]);

/** Walk a run of SCALAR-row steps, threading the label env (an `as()` here binds the label to
 *  the row's VALUE, and a following select() of a value label stays on the scalar row). Returns
 *  the extended ctx, or null when a step is outside the vocabulary. `{ctx: undefined}` is the
 *  ctx-free caller's answer — the run is still valid, just unable to resolve labels. */
function scalarRowRun(steps: readonly IRStep[], ctx: ChildCtx | undefined): { ctx: ChildCtx | undefined } | null {
  let cur = ctx;
  for (const s of steps) {
    if (CHILD_SCALAR_ROW_STEPS.has(s.name)) { cur = bindLabels(cur, s, 'scalar'); continue; }
    if (selectShape(s, cur) === 'scalar') continue;
    return null;
  }
  return { ctx: cur };
}

/** Walk a run of ELEMENT-preserving steps, threading the label env (an `as()` here binds the
 *  label to the current ELEMENT). Returns the extended ctx, or null on the first step outside
 *  the element-preserving vocabulary. This is the single place a child body's prefix is
 *  validated, so label visibility is derived identically wherever a prefix is scanned. */
function elementRun(steps: readonly IRStep[], ctx: ChildCtx | undefined): { ctx: ChildCtx | undefined } | null {
  let cur = ctx;
  for (const s of steps) {
    if (!isElementChildStep(s, cur)) return null;
    cur = bindLabels(cur, s, 'element');
  }
  return { ctx: cur };
}
// Row operators that can be scoped to one parent. `order()` is included here so
// an existence consumer can observe the same ordered/sliced child rows as a
// normal child cardinality consumer; the emitter mints the per-parent encounter
// before applying the following slice.
/** PURE. A step that observes the WHOLE stream at once, so it cannot be evaluated per-row
 *  without answering a different question. The canonical example is the one that made this
 *  shared: a global `dedup()` drops a value two origins both reach, a per-origin one keeps
 *  both. Two sites need exactly this fact and must not drift apart —
 *  `repeat()`'s body (a barrier there observes the whole FRONTIER at one iteration) and a
 *  `match()` pattern body (a barrier there reduces over the whole BINDING TABLE, not per
 *  binding). Both defer on it rather than mis-execute. */
export const GLOBAL_BARRIER_STEPS = new Set([
  'dedup', 'order', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier',
  'group', 'groupCount', 'aggregate', 'local', 'fold', 'count', 'sum', 'min', 'max', 'mean',
]);
export const isGlobalBarrier = (s: IRStep): boolean => GLOBAL_BARRIER_STEPS.has(s.name);

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
export const scalarChildPrefixOk = (s: IRStep): boolean =>
  SCALAR_CHILD_PREFIX.has(s.name) || (s.name === 'asNumber' && (s.args ?? []).length > 0);

function elementRowParts(body: ReturnType<typeof stepChain>, ctx?: ChildCtx): { prefix: ReturnType<typeof stepChain>; suffix: ReturnType<typeof stepChain> } | null {
  const at = body.findIndex((s) => CHILD_ELEMENT_ROW_STEPS.has(s.name));
  const prefix = at < 0 ? body : body.slice(0, at);
  const suffix = at < 0 ? [] : body.slice(at);
  // A mutate sack(op) is element-preserving → allowed in the prefix (isElementChildStep), so
  // local(__.sack(op).by(...)) folds the sack per parent through the same lowerElementSteps engine.
  // With a ctx, a uniform-element branch (union(out(),in())) is likewise element-preserving and
  // rides the prefix fold — as is an as() bind and a select() re-root onto an element label,
  // which elementRun threads the env across (a bind types the selects that follow it).
  if (!prefix.length || !elementRun(prefix, ctx)) return null;
  // The suffix's `local` is emitted by recursing into tryCompileElementChild, which needs an
  // ELEMENT-shaped body — so classify has to ask the same question. Without this the classifier
  // over-claims (`by(__.out().local(__.values('name')).fold())`), the emitter returns null, and
  // the caller's non-null assertion turns a clean deferral into a null-deref crash. Keeping the
  // two in lockstep is this leaf's whole point. A ctx-free caller can't classify the inner body,
  // so it conservatively rejects a local suffix.
  const localBodyOk = (s: IRStep) => ctx !== undefined && isElementChild((s.args ?? [])[0]?.nested, ctx);
  if (suffix.some((s) => !CHILD_ELEMENT_ROW_STEPS.has(s.name) || (s.name === 'local' && !localBodyOk(s)))) return null;
  return { prefix, suffix };
}

/** PURE. A map-cardinality element child (used at use==='first' sites like single select):
 * an element-rows body, keeping a trailing order() as the ordering modulator. Returns the
 * parsed body so tryCompileElementChild reuses it. */
export function classifyElementChild(nested: any, ctx: ChildCtx): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, ctx.params);
  return classifyElementChildRows(body, undefined, true, ctx) ? { body } : null;
}

export function isElementChild(nested: any, ctx: ChildCtx): boolean {
  return classifyElementChild(nested, ctx) !== null;
}

/** Syntax-only preflight for shape-aware dispatch. Unlike the tryCompile functions,
 * this never appends CTEs, so the prefix fold can stop before a homogeneous scalar
 * union without speculatively mutating the Query. */
function scalarRowParts(body: ReturnType<typeof stepChain>, ctx?: ChildCtx): { prefix: ReturnType<typeof stepChain>; projection: any; suffix: ReturnType<typeof stepChain> } | null {
  // Walk to the FIRST genuine scalar producer, threading the label env across the element
  // prefix (so `out().as('a').select('a').values('name')` types its select from its own bind).
  // A mutate sack(op) is element-preserving, not a producer, so it stays in the prefix; a
  // uniform-element branch does too (ctx-gated), so union(out(),in()).values('name') lowers as
  // a scalar child — the branch folds elements, then the projection reads them.
  let cur = ctx;
  let at = -1;
  for (let i = 0; i < body.length; i++) {
    if (isScalarProducer(body[i], cur)) { at = i; break; }
    if (!isElementChildStep(body[i], cur)) return null;
    cur = bindLabels(cur, body[i], 'element');
  }
  if (at < 0) return null;
  const prefix = body.slice(0, at);
  const projection = body[at];
  const suffix = body.slice(at + 1);
  if (!scalarRowRun(suffix, cur)) return null;
  // Per-projection arg shape for the bespoke values/id/label/constant SQL builder. The
  // generalized producers (call/math/sack/format) carry their own args and route through the
  // generic emit path (lowerSteps), so their arg validation lives in their own StepFns — here
  // they only need the element-prefix + scalar-suffix shape above.
  if (projection.name === 'values' && (projection.args.length !== 1 || typeof projection.args[0] !== 'string')) return null;
  if ((projection.name === 'id' || projection.name === 'label') && projection.args.length) return null;
  if (projection.name === 'constant' && projection.args.length !== 1) return null;
  // …and a REDUCER in the row tail needs a projection the bespoke builder can read. Only that
  // builder continues a row-run through a scoped reducer (compileScalarChildRows' continueScalar);
  // a generalized producer's body goes through lowerSteps, which absorbs the shared row vocabulary
  // but not a scoped barrier. Rejecting it HERE — rather than letting the emitter decline it later
  // — is what keeps classify and emit admitting the same set, and consumers ASSERT on this
  // classification (a path/select/branch arm's `!`), so a mismatch is a crash, not a deferral.
  if (!BESPOKE_PROJECTIONS.has(projection.name) && suffix.some((s) => CHILD_SCALAR_REDUCERS.has(s.name)))
    return null;
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
function elementOptionMapScalarBranch(branch: IRStep, ctx: ChildCtx): boolean {
  if (branch.name !== 'choose' || !branch.optionArms) return false;

  const choice = branch.args[0];
  const choiceIsScalar = isNested(choice)
    ? classifyScalarChild(choice.nested, ctx) !== null
    : isTokenArg(choice)
      && (choice.token === 'label' || choice.token === 'id');
  if (!choiceIsScalar) return false;
  // The shape question goes through the ONE option-map triage. Asking it per option body (which
  // this used to do) misses the arms that have no body: an unclaimed input emits the ELEMENT, so
  // a body whose options are all scalar can still merge to a VARIANT. The emitter follows the
  // triage, so a private answer here is a lockstep break — and it was one: the classifier claimed
  // 'scalar' and compileScalarChild's non-null assertion then tripped on a variant.
  return optionMapMerge(branch, ctx) === 'scalar';
}

/** PURE. An element-parent scalar child whose value comes from a nested branch step — the
 * recursive extension of classifyScalarChild. Grammar: an ELEMENT_CHILD_STEPS prefix, a branch
 * step (choose/coalesce/union, predicate-form choose only) whose VALUE arms are each recursively
 * classifyScalarChild-compatible, then a scalar-row suffix. When true, lowerSteps re-dispatches
 * the branch to the element-parent branch compilers, which recurse per arm — so the emitter needs
 * no bespoke reader. Precise (all arms scalar) so it never claims a list/variant-armed branch. */
export function elementScalarBranchArm(body: ReturnType<typeof stepChain>, ctx: ChildCtx): boolean {
  const at = body.findIndex((s) => ELEMENT_ARM_BRANCH.has(s.name)
    && (!(s as IRStep).optionArms || elementOptionMapScalarBranch(s as IRStep, ctx)));
  if (at < 0) return false;
  const prefix = body.slice(0, at);
  const branch = body[at];
  const suffix = body.slice(at + 1);
  // The prefix is element-preserving, so it threads the label env into the ARMS: a label bound
  // before the branch (or up the chain) is visible inside every arm body, at any depth.
  const scoped = elementRun(prefix, ctx);
  if (!scoped) return false;
  const armCtx = scoped.ctx ?? ctx;
  if (!scalarRowRun(suffix, armCtx)) return false;
  if (branch.name === 'choose' && (branch as IRStep).optionArms)
    return elementOptionMapScalarBranch(branch as IRStep, armCtx);
  const kids = (branch.args ?? []).filter(isNested);
  if (branch.name === 'choose') {
    // predicate-form choose(pred, then, else): only the two value arms must be scalar (the
    // predicate is a gate). Other arities defer to tryLowerScalarChoose's own decline.
    if (kids.length !== 3) return false;
    return classifyScalarChild(kids[1].nested, armCtx) !== null && classifyScalarChild(kids[2].nested, armCtx) !== null;
  }
  const min = branch.name === 'union' ? 2 : 1; // union needs ≥2 arms; coalesce ≥1
  return kids.length >= min && kids.every((a: any) => classifyScalarChild(a.nested, armCtx) !== null);
}

/** PURE. An element-parent scalar child (the strict isScalarChild shape): a movement-only
 * total count(), a values/id/label/constant projection with a scalar-row tail, or a nested
 * scalar-armed branch (elementScalarBranchArm). Returns the parsed body so the emitter reuses
 * it — one parse per arm, classify-then-emit.
 *
 * The three readings are a UNION, not a cascade keyed on the terminal step, and they are mutually
 * exclusive anyway: the count arm needs an element-PRESERVING prefix, and a scalar producer never
 * is one. Discriminating on `terminal.name === 'count'` instead made this classifier STRICTER than
 * the emitter it gates (tryCompileScalarValueChild, which tries both arms): `values('age').count()`
 * is a projection with a reducer tail, so the count arm declined it and the scalar arm was never
 * asked — and `longestClassifying` cannot recover that, since splitting `count()` into the suffix
 * is exactly what its barrier gate forbids. `map()` compiled that body (it calls the emitter
 * directly) while `choose()`/`coalesce()`/`local()`, which gate on this, failed closed on it. */
export function classifyScalarChild(nested: any, ctx: ChildCtx): ChildPlan | null {
  if (!nested) return null;
  return longestClassifying(childSteps(nested, ctx.params), (body) =>
    classifyCountChild(body, ctx) !== null
    || classifyScalarChildRows('element', body, ctx)?.kind === 'element'
    || elementScalarBranchArm(body, ctx));
}

/**
 * A classified child body: the PREFIX that determines the shape, plus whatever trailed it.
 *
 * The suffix is not a vocabulary — it is whatever the shape-determining prefix did not need, and
 * the emitter lowers it through `Engine.lowerStepsStrict`, the same generic loop the root uses.
 * That is why `as()` needs no plumbing here: it already works on a list/scalar stream at root, and
 * so does everything else in SCALAR_DISPATCH/LIST_DISPATCH. Peeling one step name into a side-channel
 * instead would support exactly that step and nothing else.
 */
export interface ChildPlan { body: IRStep[]; suffix: IRStep[] }

/**
 * The LONGEST prefix that classifies, and the rest as a suffix. Longest-first, so a body that
 * classifies whole keeps its existing single-shot behaviour and an empty suffix.
 *
 * The suffix must be BARRIER-FREE, and that is a contract rather than a taste: the emitter lowers
 * it via `Engine.lowerStepsStrict`, which `engine/deps.ts` defines as "lowerSteps for a scope that
 * structurally cannot host a barrier (child / nested sub-compile)". Handing it one does not throw —
 * it emits malformed SQL. Measured: without this gate,
 * `union(__.out().values("name").fold().count(Scope.local), …)` classifies `values("name")` as the
 * scalar prefix, lowers `fold().count(local)` as the suffix, and SQLite rejects the result with
 * `near "FROM": syntax error`. A body whose tail contains a barrier therefore does not split; it
 * either classifies whole or defers, exactly as before.
 */
function longestClassifying(full: IRStep[], ok: (body: IRStep[]) => boolean): ChildPlan | null {
  // Scope.local narrows a would-be barrier to one list VALUE, so `order(Scope.local)` is a
  // row-local transform and rides the suffix fine; bare `order()`/`fold()` do not.
  const barriers = (steps: IRStep[]) => steps.some((s) =>
    isGlobalBarrier(s) && !s.args.some((a: unknown) => isScopeArg(a) && a.scope === 'local'));
  for (let end = full.length; end > 0; end--) {
    if (barriers(full.slice(end))) continue;
    const body = full.slice(0, end);
    if (ok(body)) return { body, suffix: full.slice(end) };
  }
  return null;
}

export function isScalarChild(nested: any, ctx: ChildCtx): boolean {
  return classifyScalarChild(nested, ctx) !== null;
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
export function classifyCountChild(body: ReturnType<typeof stepChain>, ctx?: ChildCtx): { prefix: ReturnType<typeof stepChain> } | null {
  const terminal = body.at(-1);
  if (!terminal || terminal.name !== 'count' || terminal.args.length) return null;
  const prefix = body.slice(0, -1);
  // A uniform-element branch counts too (ctx-gated): union(out(),in()).count() folds elements
  // through the prefix, then the scoped count barrier reduces them — as do an as() bind and a
  // select() re-root, which elementRun threads the env across.
  return elementRun(prefix, ctx) ? { prefix } : null;
}

/** PURE. The post-strip scalar-row shape decision shared by compileScalarChildRows and
 * every scalar/property-scalar predicate: a property parent lowers key/value/element().…
 * (propertyScalarBody), an element parent a values/id/label/constant projection
 * (scalarRowParts). Callers strip a terminal fold() before calling. */
export function classifyScalarChildRows(
  parentKind: 'element' | 'property',
  body: ReturnType<typeof stepChain>,
  ctx?: ChildCtx,
): { kind: 'property'; body: ReturnType<typeof stepChain> } | { kind: 'element'; parts: ScalarRowParts } | null {
  if (parentKind === 'property') return propertyScalarBody(body) ? { kind: 'property', body } : null;
  const parts = scalarRowParts(body, ctx);
  return parts ? { kind: 'element', parts } : null;
}

/** PURE. A body that is `<element movement/filter prefix>.<one terminal projection>` — the shape
 *  EVERY non-element child provider needs, parameterized only by which projection it accepts.
 *  Map (valueMap) and record (project/select) share it verbatim; the projection-specific rules stay
 *  in `accepts`, which is where they belong.
 *
 *  Lives here with its siblings (classifyScalarChildRows / classifyElementChildRows /
 *  classifyCountChild) so the classify/emit split holds for every shape: classify is a syntax-only
 *  peek with no Query, no engine and no SQL, and the emit half consumes exactly these parts. */
export function classifyProjectionChildRows(
  body: ReturnType<typeof stepChain>,
  accepts: (proj: IRStep) => boolean,
  ctx?: ChildCtx,
): { prefix: IRStep[]; proj: IRStep } | null {
  if (!body.length) return null;
  const proj = body[body.length - 1];
  if (!accepts(proj)) return null;
  const prefix = body.slice(0, -1);
  return prefix.every((c) => isElementChildStep(c, ctx)) ? { prefix, proj } : null;
}

/** A MAP-producing child body. `valueMap(true)`/`elementMap` are excluded: neither has a relational
 *  MapStream form (the builder's own deferral — their token keys frame as T ENUMS mixed with string
 *  property keys, which the `{t,v}` blob vocabulary cannot represent), so the terminal root path
 *  still answers them.
 *
 *  NOTE this deliberately does NOT widen `ChildShape`. That union is `BranchArmShape` minus its
 *  null, so admitting 'map' there would tell the branch triage a map arm is mergeable — and no
 *  merge covers a map shape. A map body composes at the MAPPING positions; a map ARM stays
 *  unclassifiable (and so fails closed) until a merge exists. */
export const classifyMapChildRows = (body: ReturnType<typeof stepChain>, ctx?: ChildCtx) =>
  classifyProjectionChildRows(body, (p) => p.name === 'valueMap' && !p.args.includes(true), ctx);

/** A RECORD-producing child body: `project(k…)` / a multi-label `select(k…)`. The record builder
 *  (select.ts lowerRecordSelectProject) already threads its carried columns, so — unlike the map
 *  builder — it needed no change to work in a child scope; the classifier WAS the only gate. A
 *  single-label select() is not a record (it re-types to whatever the label holds) and a
 *  select(Column) has its own consumer, so both are excluded. */
export const classifyRecordChildRows = (body: ReturnType<typeof stepChain>, ctx?: ChildCtx) =>
  classifyProjectionChildRows(body, (p) =>
    (p.name === 'project' || (p.name === 'select' && p.args.filter((a: any) => typeof a === 'string').length > 1))
    && !p.args.some((a: any) => a && typeof a === 'object' && 'column' in a), ctx);

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
  ctx?: ChildCtx,
): { body: ReturnType<typeof stepChain>; parts: ElementRowParts; orderStep?: IRStep } | null {
  if (stripTerminal && fullBody.at(-1)?.name !== stripTerminal) return null;
  const orderStep = firstPolicy && fullBody.at(-1)?.name === 'order' ? fullBody.at(-1) : undefined;
  let body = stripTerminal || orderStep ? fullBody.slice(0, -1) : fullBody;
  if (!firstPolicy && body.at(-1)?.name === 'order' && !(body.at(-1) as IRStep).modulators) body = body.slice(0, -1);
  const parts = body.length ? elementRowParts(body, ctx) : stripTerminal ? { prefix: [], suffix: [] } : null;
  return parts ? { body, parts, orderStep: orderStep as IRStep | undefined } : null;
}

export function isPropertyScalarChild(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  return classifyScalarChildRows('property', childSteps(nested, ctx.params)) !== null;
}

/** A property scalar child terminated by fold() — the group-value list form. */
export function isPropertyScalarFoldChild(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  const body = childSteps(nested, ctx.params);
  return body.at(-1)?.name === 'fold' && classifyScalarChildRows('property', body.slice(0, -1)) !== null;
}

/** PURE. A total scope-aware count() child (movement-only prefix): optional(child) ≡ child
 * because the identity fallback is unreachable. Returns the parsed body for reuse. */
export function classifyTotalScalarChild(nested: any, ctx: ChildCtx): { body: ReturnType<typeof stepChain> } | null {
  if (!nested) return null;
  const body = childSteps(nested, ctx.params);
  return classifyCountChild(body, ctx) ? { body } : null;
}

export function isTotalScalarChild(nested: any, ctx: ChildCtx): boolean {
  return classifyTotalScalarChild(nested, ctx) !== null;
}

/** PURE. A fold()-terminated list child (element parent): the strict shape the branch/list
 * consumers gate on. Returns the parsed body so the emitter (tryCompileListChild) reuses it
 * instead of re-parsing — one parse per arm, classify-all-then-emit-all. Deliberately
 * stricter than compileElementChildRows' fold path (routing control): a scalar-rows-before-
 * fold OR a pure-movement before-fold; a strict body always emits, so no lockstep throw. */
export function classifyListChild(nested: any, ctx: ChildCtx): ChildPlan | null {
  if (!nested) return null;
  return longestClassifying(childSteps(nested, ctx.params), (body) => {
    if (body.at(-1)?.name !== 'fold') return false;
    const before = body.slice(0, -1);
    return classifyScalarChildRows('element', before, ctx)?.kind === 'element' || !!elementRun(before, ctx);
  });
}

/** PURE. A bare branch step whose merge is LIST (uniform `…fold()` arms) or VARIANT (genuinely
 *  mixed arms) — the shapes that lowerStepsStrict resolves to a List/VariantStream over a pushed
 *  child scope (finishListMerge / mergeVariantArms are parent-agnostic). Element-armed and
 *  scalar-armed branches are excluded here — they have their own cardinality-aware child paths.
 *  Deliberately NOT wired into classifyListChild/the branch-arm triage: consumed ONLY by the
 *  all-cardinality child consumers (local/flatMap), so a branch-of-lists / mixed branch composes
 *  there while map (first-of-a-multi-output body) stays fail-closed and the triage is untouched. */
export function isBareBranchChildAllCard(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  const body = childSteps(nested, ctx.params);
  if (body.length !== 1) return false;
  const kind = asBranchKind(body[0].name);
  if (!kind) return false;
  // The option-map choose() reads its arms off `step.optionArms`, so it has its own triage — same
  // role, same vocabulary (optionMapMerge, below). It reaches the identical List/Variant merges,
  // so a `local(__.choose(..).option(k, __.values('n').fold())..)` composes here like any other
  // branch-of-lists; excluding it was the last thing keeping those bodies out.
  const merge = (body[0] as IRStep).optionArms
    ? optionMapMerge(body[0], ctx)
    : classifyBranchArms(kind, body[0], ctx).merge;
  return merge === 'list' || merge === 'variant';
}

export function isListChild(nested: any, ctx: ChildCtx): boolean {
  return classifyListChild(nested, ctx) !== null;
}

export function isScalarFoldChild(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  const body = childSteps(nested, ctx.params);
  return body.at(-1)?.name === 'fold' && classifyScalarChildRows('element', body.slice(0, -1), ctx)?.kind === 'element';
}

export function isElementFoldChild(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, ctx.params), 'fold', false, ctx) !== null;
}

/** An element traversal used as a group VALUE with no terminal reducer/fold. Per
 *  TinkerPop, an unreduced group value collects its results into a list, so this is an
 *  implicit fold — e.g. by(__.out()) ≡ by(__.out().fold()). A trailing bare order() is
 *  the fold's natural id order (accepted, stripped when compiled); order().by(key) is
 *  NOT (it would need key-ordered folding — deferred). */
export function isElementImplicitFoldChild(nested: any, ctx: ChildCtx): boolean {
  if (!nested) return false;
  return classifyElementChildRows(childSteps(nested, ctx.params), undefined, false, ctx) !== null;
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
export function classifyArmShape(nested: any, ctx: ChildCtx): BranchArmShape {
  return isElementChild(nested, ctx) ? 'element'
    : isScalarChild(nested, ctx) ? 'scalar'
    : isListChild(nested, ctx) ? 'list'
    : null;
}

/** The arity a branch kind needs before any shape talk: union ≥2 arms, coalesce ≥1, choose
 *  exactly 3 args (pred, then, else — the 2-arg form's else is an element identity, so it stays
 *  with the element lowerer), optional exactly 1. `null` = "no shape question to ask", which
 *  classifyBranchArms reports as merge 'element' so the element lowerer owns the arity/option-map
 *  error message (fail closed, one authority). */
function branchValueArgs(kind: BranchKind, step: IRStep): readonly any[] | null {
  if (kind === 'choose' && (step as IRStep).optionArms) return null; // option-map form: a tail CASE projector
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
export function classifyBranchArms(kind: BranchKind, step: IRStep, ctx: ChildCtx): BranchArms {
  const args = branchValueArgs(kind, step);
  if (!args) return { kind, shapes: [], args: [], merge: 'element' };
  const shapes: BranchArmShape[] = args.map((a: any) => classifyArmShape(a.nested, ctx));
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
export function branchNeedsShapeDispatch(kind: BranchKind, step: IRStep, ctx: ChildCtx): boolean {
  return classifyBranchArms(kind, step, ctx).merge !== 'element';
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
  const dir = byArgs?.find(isOrderArg)?.order as ByDirection | undefined;
  const nested = byArgs?.find(isNested);
  if (nested) return { kind: 'nested', nested: nested.nested, dir };
  const token = byArgs?.find(isTokenArg);
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

// ---------- the option-map choose() arm triage ----------
//
// `choose(fn).option(k, body)…` picks its arm by an N-way lookup on a choice scalar rather than by
// position, so its arms hang off `step.optionArms`, not `step.args` — which is exactly why
// `branchValueArgs` returns null for it and `classifyBranchArms` cannot describe it. This is that
// form's triage: the SAME role, different arm extraction, and read by BOTH the child-body
// classifier (`isBareBranchChildAllCard`) and the emitter (`tryLowerOptionMapBranch`, branch.ts) so
// classify and emit cannot drift. The second deliberate exception to "one arm triage", alongside
// scalar-arm.ts's `scalarArmShape`; like it, it shares the `BranchArmShape`/`BranchMerge`
// vocabulary so the parallel — and the difference — are visible.
//
// Two arms are IMPLICIT and have no body to classify, which is the whole reason this cannot be
// folded into `branchValueArgs` (a `readonly any[]` of nested args):
//   · no `Pick.none` at all → an unmatched input passes through as the ELEMENT itself (TinkerPop),
//     so there is an element arm nobody wrote;
//   · a `__.discard()` body drops its rows, so it contributes NO arm even though one is written.

/** Which arm an `option()` key selects. `none` = the choice produced a value that matched no key;
 *  `unproductive` = the choice traversal produced NOTHING (`__.values('age')` on a vertex with no
 *  age). TinkerPop keeps those distinct, and the correlated choice already computes the signal
 *  that separates them (its modulation `present` column). */
export type OptionPick = 'key' | 'none' | 'unproductive';

export interface ChooseOptionArm {
  readonly key: any;            // undefined for the Pick arms
  readonly nested: any;
  readonly pick: OptionPick;
  /** A `__.discard()` body: those rows are dropped, so this option contributes no merge arm. */
  readonly discard: boolean;
}

const isDiscardBody = (nested: any, params: Record<string, any>): boolean => {
  const body = childSteps(nested, params);
  return body.length === 1 && body[0].name === 'discard';
};

/** PURE. Read an option-map choose's arms in declaration order, or null for a form outside the
 *  vocabulary (`Pick.any`, a bodyless option, no keyed option at all). FIRST WINS per Pick token:
 *  TinkerPop takes the first `Pick.none`/`Pick.unproductive` and ignores later duplicates, which is
 *  what makes the corpus's trailing `option(Pick.none, __.fail())` unreachable rather than a wall. */
export function readOptionMapArms(step: IRStep, params: Record<string, any>): ChooseOptionArm[] | null {
  const out: ChooseOptionArm[] = [];
  const seen = new Set<OptionPick>();
  for (const opt of step.optionArms ?? []) {
    const bodyArg = (opt.args ?? []).find(isNested);
    if (!bodyArg) return null;
    const keyArg = (opt.args ?? []).find((x: any) => x !== bodyArg);
    const token = isPickArg(keyArg) ? keyArg.pick : undefined;
    if (token !== undefined && token !== 'none' && token !== 'unproductive') return null; // Pick.any
    const pick: OptionPick = keyArg === undefined ? 'none' : token ?? 'key';
    if (pick !== 'key') {
      if (seen.has(pick)) continue; // first wins
      seen.add(pick);
    }
    out.push({ key: pick === 'key' ? keyArg : undefined, nested: bodyArg.nested, pick, discard: isDiscardBody(bodyArg.nested, params) });
  }
  return out.some((o) => o.pick === 'key') ? out : null;
}

/** PURE. Does this option map carry the implicit ELEMENT pass-through arm — an input that emits
 *  the element itself because no written option claims it?
 *
 *  BOTH tokens must be written to cover every input. `Pick.none` claims a productive choice that
 *  matched no key; `Pick.unproductive` claims a choice that produced nothing. Writing only one
 *  leaves the other case to TinkerPop's pass-through, which the corpus pins directly:
 *  `option(between(26,30), name).option(Pick.none, name)` over the modern graph yields
 *  `v[lop]`/`v[ripple]` — the age-less vertices, unclaimed and emitted whole.
 *
 *  Shared by the triage and the emitter (branch.ts) precisely because getting it wrong is
 *  invisible: the classifier would call a list-bodied option map a homogeneous LIST merge while
 *  the emitter handed it an element arm. */
export const optionMapNeedsPassthrough = (step: IRStep, arms: readonly ChooseOptionArm[], params: Record<string, any>): boolean =>
  !arms.some((o) => o.pick === 'none')
  || (!arms.some((o) => o.pick === 'unproductive') && choiceCanBeUnproductive(step.args?.[0], params));

/** PURE. Can this CHOICE yield nothing for some input? Only then is an unclaimed
 *  `Pick.unproductive` case reachable — and being precise here is load-bearing in both
 *  directions. Too coarse and a `choose(T.label)` gains an element arm it can never emit, widening
 *  its result to a variant and fail-closing an `is()` that used to compose; too loose and an
 *  unproductive input is silently answered with the `Pick.none` body.
 *
 *  Always productive: a `T` token (every element has a label/id), plus any terminal in
 *  `ALWAYS_PRODUCTIVE_TERMINAL` — which now lives in `ir/productivity.ts` as the SHARED authority,
 *  because the always-productive-filter Pass asks the identical question and two copies of this
 *  reasoning would drift. The rationale for which terminals qualify is documented there.
 *  Anything else (a property read, a movement) can be empty. */
function choiceCanBeUnproductive(a0: any, params: Record<string, any>): boolean {
  if (isTokenArg(a0)) return false;
  if (!isNested(a0)) return true; // no recognizable choice — assume the worst, the emitter defers anyway
  const body = childSteps(a0.nested, params);
  const last = body.at(-1);
  return !last || !ALWAYS_PRODUCTIVE_TERMINAL.has(last.name);
}

/** PURE. The merge an option-map choose routes to, or null when an arm is unclassifiable (the
 *  caller then defers). Folds `classifyArmShape` over the written arms exactly as
 *  `classifyBranchArms` does, plus the implicit element pass-through when one is live. */
export function optionMapMerge(step: IRStep, ctx: ChildCtx): BranchMerge | null {
  const arms = readOptionMapArms(step, ctx.params);
  if (!arms) return null;
  const bodies: BranchArmShape[] = arms.filter((o) => !o.discard).map((o) => classifyArmShape(o.nested, ctx));
  if (bodies.some((s) => s === null)) return null;
  // The dispatch tries the scalar CASE projector FIRST, and it collapses every option body into
  // one value column. So a map this classifier would otherwise widen never reaches the merge at
  // all — and must not be predicted as if it had. Modelling the route rather than just the shapes
  // is what keeps classify and emit in lockstep here.
  if (optionMapIsCase(arms) && bodies.every((s) => s === 'scalar')) return 'scalar';
  const shapes = [...bodies];
  if (optionMapNeedsPassthrough(step, arms, ctx.params)) shapes.push('element');
  if (!shapes.length) return null;
  return shapes.every((s) => s === shapes[0]) ? shapes[0] as BranchMerge : 'variant';
}

/** PURE. Does the scalar CASE projector serve this option map? It needs exactly one fallthrough —
 *  a `Pick.none`, and no `Pick.unproductive` (a second one, keyed off the choice's PRESENCE) — and
 *  every option must contribute a value for its CASE branch, which a `__.discard()` body does not
 *  (it drops its rows; only the merge can express that, by omitting the arm).
 *  Shared with `lowerChooseOptions`, which uses it as its own precondition — so the classifier's
 *  prediction and the projector's own gate are one statement, not two that can drift. */
export const optionMapIsCase = (arms: readonly ChooseOptionArm[]): boolean =>
  arms.some((o) => o.pick === 'none') && !arms.some((o) => o.pick === 'unproductive')
  && !arms.some((o) => o.discard);
