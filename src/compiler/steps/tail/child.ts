import { derived, empty, list, paren, q, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { perRowCols } from '../../../sql/kernel/render.ts';
import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import { appendCte, patchLayout, layoutProjection, layoutProjectionMinting, layoutCols, partitionOver, prevRel, withLayout, type TraverserLayout, type ElementStream } from '../context/context.ts';
import { aliasId } from '../context/alias.ts';
import { asOnStream, selectOneFromAlias } from './labelselect.ts';
import { loweringStateOf, streamPayloadCols, toScalarStream, withRelationAndLayout, PROPERTY_PAYLOAD, type ListStream, type PropertyStream, type ScalarStream, type Stream, type VariantStream, type RelationalStream } from '../context/stream.ts';
import { engineOf } from '../../engine/deps.ts';
import { lowerScalarRows } from './scalar.ts';
import { SCALAR_TRANSFORMS } from './coerce.ts';
import { lowerReSource } from '../graph-source.ts';
import { someStepDeep, type IRStep } from '../../ir/strategies.ts';
import { lowerScopedElementFold, lowerScopedScalarFold, lowerScopedScalarReducer, type ScalarReducer } from './barrier.ts';
import { predicateSql, elemTable } from '../../plan/plan.ts';
import { sliceOf } from '../../ir/step.ts';
import { elementOrderDrop, elementOrderSql } from './modulation.ts';
import {
    childCtx, childSteps, classifyCountChild, isOneRowProjection, classifyElementChildRows, classifyScalarChildRows, elementScalarBranchArm, labelSelectOf,
    CHILD_SCALAR_REDUCERS,
    ELEMENT_CHILD_STEPS, isBareBranchChildAllCard,
    reuseCurrentFrame, ROOT_SCOPE, scalarChildPrefixOk,
    type ChildCtx, type ChildFrame, type ChildParent, type ChildPlan, type ChildScope, type ChildUse, type ChildFrameStack
} from './child-shape.ts';
// The scope-construction trio (pushChildScope/popChildScope below + reuseCurrentFrame) is the
// compiler's public scope vocabulary; re-export reuseCurrentFrame (defined as a pure spread in the
// shape leaf) so callers reach the whole trio from one place.
export { reuseCurrentFrame };

const isPropertyParent = (p: ChildParent): p is PropertyStream => p.kind === 'property';
const isScalarParent = (p: ChildParent): p is ScalarStream => p.kind === 'scalar';

/** Give every parent traverser a multiset-safe identity and seed a correlated child.
 * Equal element ids deliberately get different ordinals. The domain is preserved in
 * the returned frame even when later child lowering produces no rows. */
export function pushChildScope<P extends ChildParent>(
  parent: P,
  scope: ChildFrameStack = ROOT_SCOPE,
): { scope: ChildScope; frame: ChildFrame; seed: P } {
  if (scope.kind === 'child' && scope.reuseFrame) {
    const ordinal = scope.reuseFrame.ordinal;
    if (parent.traverserLayout.origins.at(-1) !== ordinal)
      throw new Error(`reused child scope mismatch: expected innermost ${ordinal}, got ${parent.traverserLayout.origins.at(-1) ?? 'none'}`);
    const frame: ChildFrame = { ordinal, domain: parent.rel, parent, reused: true, traverserLayout: parent.traverserLayout };
    const frames = [...scope.frames.slice(0, -1), frame];
    return { scope: { kind: 'child', frames }, frame, seed: parent };
  }
  const p = parent.rel.as('p');
  const ordinal = `o${parent.traverserLayout.origins.length}`;
  // A SCALAR parent needs a CARRIED encounter (the per-origin order marker the scoped
  // reducer/fold and the `first` cardinality policy key productivity on). Reuse the parent's
  // if it already carries one; otherwise mint a constant (a scalar traverser never fans out
  // into its own child scope — each ordinal has exactly one value). Element/property parents
  // add no encounter here.
  const needEnc = isScalarParent(parent) && !parent.traverserLayout.encounter;
  // The seed carries the parent's schema PLUS the pushed ordinal (+ a minted scalar encounter
  // when needed). Build the domain's carried columns in layoutCols ORDER — the ordinal in its
  // origins slot, NOT appended physically last — so the seed's declared schema equals its
  // physical layout. Otherwise, whenever the outer chain also tracks a path (or fromV/encounter,
  // which layoutCols sorts AFTER origins), the ordinal-last domain desyncs from the
  // ordinal-in-origins schema and any child body lowered via lowerSteps (assertStreamColumns)
  // trips a column mismatch. Minted columns (ordinal by ROW_NUMBER, a new encounter by a
  // constant) are computed fresh; every other carried column is projected from `p` by name.
  const base = patchLayout(parent.traverserLayout, { origins: [...parent.traverserLayout.origins, ordinal] });
  const seedCarried = needEnc ? patchLayout(base, { encounter: 'encounter' }) : base;
  const seedCols = layoutCols(seedCarried);
  // The ordinal identifies a parent traverser, and when the parent also carries an emission ORDER
  // it costs nothing to make it order-bearing: `ROW_NUMBER() OVER (ORDER BY <encounter>)` is still
  // unique per parent row — all the identity contract asks — and is now monotone in the parent's
  // own order.
  //
  // That is what makes a child stream's emission order expressible at all. Inside the scope it is
  // the per-origin `encounter`; ACROSS parents it is the PAIR (ordinal, encounter), and the pair is
  // only meaningful if the first element orders. Without this the ordinal is `ROW_NUMBER() OVER ()`
  // and every parent's first child row ties, which is how a branch arm's rows fell to SQLite's scan
  // order (outstanding-work item 20). The encounter itself stays per-origin on purpose — a scoped
  // slice reads it as `encounter > offset AND encounter <= stop` (projection.ts), which is a
  // per-parent window and would be a different question globally.
  const parentOrder = parent.traverserLayout.encounter;
  const ordinalMint = parentOrder ? q`ROW_NUMBER() OVER (ORDER BY ${p.c[parentOrder]}) AS ${ordinal}` : q`ROW_NUMBER() OVER () AS ${ordinal}`;
  const carriedSelect = list(
    seedCols.map((c) =>
      c === ordinal ? ordinalMint
        : (needEnc && c === 'encounter') ? q`1 AS ${c}`
        : q`${p.c[c]}`),
    ', ',
  );
  // A SCALAR parent re-projects its value payload `v` (+ vt/vtype) so the child body reads
  // `_` = the value. streamColumns order is [v, vt?, vtype?, ...carried] so the projection
  // matches the seed's declared schema (the encounter now rides in the carried tail).
  if (isScalarParent(parent)) {
    const head = ['v', ...(parent.result === 'number' ? ['vt'] : [])];
    const vtypeCols = perRowCols(parent.type);
    const payload = list([
      ...head.map((c) => q`${p.c[c]} AS ${c}`),
      ...vtypeCols.map((c) => q`${p.c[c]} AS ${c}`),
    ], ', ');
    const domain = parent.q.cte(
      q`SELECT ${payload}, ${carriedSelect} FROM ${p}`,
      [...head, ...vtypeCols, ...seedCols],
    );
    const seed = withRelationAndLayout(parent, seedCarried, domain) as P;
    const frame: ChildFrame = { ordinal, domain, parent, traverserLayout: seedCarried };
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
  const seed = withRelationAndLayout(parent, seedCarried, domain) as P;
  const frame: ChildFrame = { ordinal, domain, parent, traverserLayout: seedCarried };
  const frames = scope.kind === 'child' ? [...scope.frames, frame] : [frame];
  return { scope: { kind: 'child', frames }, frame, seed };
}

/** Remove exactly the innermost child identity after a child consumer has restored
 * parent cardinality. Outer origins remain live for nested children. */
export function popChildScope(child: ElementStream, frame: ChildFrame): ElementStream {
  const origins = child.traverserLayout.origins;
  if (origins[origins.length - 1] !== frame.ordinal)
    throw new Error(`child scope mismatch: expected innermost ${frame.ordinal}, got ${origins.at(-1) ?? 'none'}`);
  const nextOrigins = origins.slice(0, -1);
  const layout = patchLayout(child.traverserLayout, { origins: nextOrigins });
  const p = child.rel.as('p');
  return appendCte(child, q`SELECT ${p.c.id} AS id${layoutProjection(layout, p)} FROM ${p}`, { origins: nextOrigins });
}

// The terminal barrier vocabulary the row compilers aggregate on is ONE set, defined in the pure
// classify leaf (child-shape.ts) and re-exported here for the scalar-arm consumers — the two halves
// declared it separately before, which is one edit away from a classify/emit disagreement.
export { CHILD_SCALAR_REDUCERS };
/** The scalar continuation a property/element scalar child may carry after its projection
 *  (compiler-side; the classify twin is CHILD_SCALAR_ROW_STEPS in child-shape.ts). */
const SHARED_SCALAR_CHILD_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup', 'as',
]);
/** A scalar continuation the GENERIC path (lowerStepsStrict) can lower: the shared vocabulary
 *  plus a single-label select(), which re-types the row to the label's contents and is owned by
 *  the engine's one alias dispatch. Kept a predicate rather than a name in the Set because
 *  select(Column.*) / a multi-label select are different steps with different consumers. */
const isSharedScalarChildStep = (s: IRStep): boolean =>
  SHARED_SCALAR_CHILD_STEPS.has(s.name) || labelSelectOf(s) !== null;

// ---------- the scoped element-row count: ONE aggregate ----------
//
// "How many rows did this child body produce for each parent traverser?" has three consumers — a
// terminal count child (tryCompileCountChild), the origin-retaining form an existence/by()
// consumer drives (tryCompileCountValueRows), and a bare movement count (scopedMovementCount,
// which the degree-centrality service composes). They were three aggregates.
//
// It is deliberately NOT lowerScopedScalarReducer with a `1 AS v` marker CTE in front (which is
// what the third one did): element rows have no value to reduce, so the marker relation and the
// per-origin encounter it minted existed only to satisfy that function's SCALAR contract, while
// COUNT over the domain join is the whole operation. The scalar barrier stays the authority for
// reducing child VALUES; this is the row-algebraic twin, and the two are not a duplication —
// counting rows never needs an expression denoting the traverser's value.
//
// BULK is unweighted here, which is the same rule the scalar barrier now follows and NOT a
// difference between them — see the bulk axis documented on lowerScopedScalarReducer (barrier.ts).

/** N child rows per parent origin → one Long per origin. The preserved parent domain is the
 *  aggregate's left side, so an unproductive child still emits a zero for that parent, and
 *  grouping by the child ORDINAL (not element id) keeps equal/duplicate parents multiset-distinct.
 *  `having` filters the aggregate itself — `out().count().is(gt(1))` — so an existence consumer
 *  reads row-present ⟺ the count comparison holds. The origin stays live; the caller decides
 *  whether to rejoin at parent cardinality. */
function scopedElementRowCount(
  el: ElementStream,
  pushed: ReturnType<typeof pushChildScope>,
  having: readonly any[] = [],
): { stream: ScalarStream; frame: ChildFrame } {
  const ord = pushed.frame.ordinal;
  const d = pushed.frame.domain.as('d');
  const c = el.rel.as('c');
  const count = q`COUNT(${c.c.id})`;
  const filter = having.length
    ? q` HAVING ${list(having.map((p) => predicateSql(count, p)), ' AND ')}`
    : empty;
  // One count row per origin — mint a constant encounter into its carried slot as the per-origin
  // order marker a following scoped slice/reducer or cardinality policy reads.
  const outCarried = patchLayout(pushed.frame.traverserLayout, { encounter: 'encounter' });
  const rel = el.q.cte(
    q`SELECT ${count} AS v${layoutProjectionMinting(outCarried, d, 'encounter', q`1`)} FROM ${d} LEFT JOIN ${c} ON ${c.c[ord]}=${d.c[ord]} GROUP BY ${d.c[ord]}${filter}`,
    ['v', ...layoutCols(outCarried)],
  );
  return {
    stream: toScalarStream(loweringStateOf(el, outCarried), rel, 'long', { result: 'count' }),
    frame: pushed.frame,
  };
}

/** Classify + lower a count-shaped child body, then count its rows. `trailingIs` is the
 *  consumer-policy switch: an existence consumer owns `<move>.count().is(P)` and takes the
 *  predicates as a HAVING; a value consumer does not admit them at all (its classify sees the
 *  whole body and declines), so the two entry points differ ONLY in that flag. */
function compileCountChildRows(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack,
  preParsed: ReturnType<typeof stepChain> | undefined,
  trailingIs: boolean,
): { stream: ScalarStream; frame: ChildFrame } | null {
  if ((!nested && !preParsed) || isPropertyParent(parent) || isScalarParent(parent)) return null;
  const body = preParsed ?? childSteps(nested, parent.params);
  let cut = body.length;
  const isPreds: any[] = [];
  if (trailingIs)
    while (cut > 0 && body[cut - 1].name === 'is') { isPreds.unshift(body[cut - 1].args[0]); cut--; }
  const counted = classifyCountChild(cut === body.length ? body : body.slice(0, cut), childCtx(parent));
  if (!counted) return null;
  const pushed = pushChildScope(parent, scope);
  const end = lowerElementBody(pushed.seed, counted.prefix);
  if (!end) return null;
  return scopedElementRowCount(end, pushed, isPreds);
}

/** Compile a terminal child count as a true scope-aware barrier, at PARENT cardinality: the
 * count row per origin, rejoined by the one shape-agnostic rejoin (which drops the child
 * ordinal and the per-origin encounter with it). */
/**
 * Lower a child body's SUFFIX over the already-rejoined arm stream, through the SAME generic loop
 * the root uses (`Engine.lowerStepsStrict` — deps.ts documents it as the child/nested sub-compile
 * entry). This is why `as()` needed no plumbing: it already works on a list or scalar stream at
 * root, and so does everything else in SCALAR_DISPATCH/LIST_DISPATCH. Threading one step name through
 * every emitter instead would have supported exactly that step.
 *
 * Fail-closed: the arm was CLASSIFIED on its prefix, so if the suffix retypes the stream that
 * classification is no longer true and the merge would be handed a shape it never agreed to.
 * Decline instead — the caller then falls through to its existing deferral.
 */
/**
 * A pre-parsed child body, optionally with the suffix its classifier split off. ONE parameter, so a
 * caller physically cannot hand an emitter the body and forget the suffix — which is exactly what
 * happened when they were two: six of twelve call sites passed `plan.body` alone, and the dropped
 * `order(Scope.local)` turned a clean deferral into a silently unsorted list.
 */
export type ChildBody = IRStep[] | ChildPlan;
const bodyOf = (b?: ChildBody): IRStep[] | undefined => Array.isArray(b) ? b : b?.body;
const suffixOf = (b?: ChildBody): readonly IRStep[] => Array.isArray(b) || !b ? [] : b.suffix;

function applySuffix<S extends RelationalStream>(s: S | null, suffix: readonly IRStep[]): S | null {
  if (!s || !suffix.length) return s;
  const out = engineOf(s).lowerStepsStrict(s, [...suffix], 0);
  return out.kind === s.kind ? out as S : null;
}

export function tryCompileCountChild(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
  body?: ChildBody,
): ScalarStream | null {
  const rows = compileCountChildRows(parent, nested, scope, bodyOf(body), false);
  if (!rows) return null;
  return applySuffix(applyChildCardinality(parent, rows.frame, rows.stream, 'all').stream as ScalarStream, suffixOf(body));
}

/** Count child with the origin retained for a consumer-owned by()/barrier policy.
 * Unlike tryCompileCountChild this does not pop the frame: one total row (including
 * zero) remains associated with each multiset-distinct parent. */
function tryCompileCountValueRows(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  return compileCountChildRows(parent, nested, scope, preParsed, true);
}

// ---------- the cardinality rejoin: ONE operation, every shape ----------
//
// Restoring PARENT cardinality from child rows does not depend on the child's shape. `all` keeps
// every child row; `first` ranks per origin by the child's encounter and takes rn=1 — the same
// window either way. What used to differ per shape was only "which columns are the payload" and
// "how do I rebuild the stream", and neither needs to be written by hand:
//   • `streamPayloadCols` (stream.ts) is already the single authority on a kind's own columns.
//   • a stream IS `{kind, rel, ...metadata}`, so re-homing it on a new relation under the PARENT's
//     carry is a spread — the metadata (type/result, keyOf/valOf, elem, of, fields, layout) rides
//     along untouched, which is exactly what a re-projection must preserve.
// So there is one rejoin, and adding a shape to the child seam adds nothing here.

/** Re-project child rows at parent cardinality, preserving the child's shape.
 *
 * Takes the FRAME, not the whole `pushChildScope` result: the rejoin needs only the ordinal to
 * rank/partition on, and demanding the pushed triple is what kept the post-barrier callers (a
 * child fold/branch, which hold a frame handed back by a row compiler and no longer have the
 * pushed object) out of this seam — so they hand-rolled the projection instead. */
export function applyChildCardinality<S extends Exclude<Stream, { kind: 'result' }>>(
  parent: ChildParent,
  frame: ChildFrame,
  lowered: S,
  use: ChildUse,
): { stream: S; frame: ChildFrame } {
  const payload = streamPayloadCols(lowered);
  const parentCols = layoutCols(parent.traverserLayout);
  const cols = [...payload, ...parentCols];
  const project = (r: Relation) => list(payload.map((c) => q`${r.c[c]} AS ${c}`), ', ');
  const rehome = (rel: Relation): S => ({ ...lowered, ...loweringStateOf(parent), rel });

  const r = lowered.rel.as('r');
  if (use === 'all')
    return {
      stream: rehome(derived(q`SELECT ${project(r)}${layoutProjection(parent.traverserLayout, r)} FROM ${r}`, cols, 'all_rows')),
      frame,
    };
  if (!lowered.traverserLayout.encounter) throw new Error('child first cardinality requires explicit encounter order');
  const first = derived(
    q`SELECT ${project(r)}${layoutProjection(parent.traverserLayout, r)}, ROW_NUMBER() OVER (PARTITION BY ${r.c[frame.ordinal]} ORDER BY ${r.c[lowered.traverserLayout.encounter]}) AS rn FROM ${r}`,
    [...cols, 'rn'], 'f');
  return {
    stream: rehome(derived(q`SELECT ${project(first)}${layoutProjection(parent.traverserLayout, first)} FROM ${first} WHERE ${first.c.rn}=1`, cols, 'first_row')),
    frame,
  };
}

/** Mint a per-origin `encounter` on an element child stream that carries none — the order the
 *  `first` cardinality policy ranks on. Factored out because it is the same three lines every
 *  child provider needs and the expression nests badly inline. */
export function mintChildEncounter(end: ElementStream): ElementStream {
  const pe = prevRel(end, 'pe');
  const layout = withLayout(end, { encounter: 'encounter' }).traverserLayout;
  const mint = q`ROW_NUMBER() OVER (${partitionOver(layout, pe, pe.c.id)})`;
  return appendCte(end, q`SELECT ${pe.c.id} AS id${layoutProjectionMinting(layout, pe, 'encounter', mint)} FROM ${pe}`,
    { encounter: 'encounter' });
}

/** Give a provably ONE-ROW-PER-INPUT scalar child the trivial `encounter` that `first` cardinality
 *  ranks on. A no-op for any other body.
 *
 *  `applyChildCardinality` demands an encounter for `use === 'first'`, and that guard is
 *  load-bearing: without an emission order, "first" over a fan-out body picks an ARBITRARY row —
 *  the silent-arbitrary-answer the canonical-emission-order work exists to prevent. A fanning body
 *  mints its own key (`values()` carries `encounterKey` through the projector, since a multi-valued
 *  property genuinely yields several rows).
 *
 *  Which terminals qualify — and WHY each one cannot fan out — is `isOneRowProjection`
 *  (tail/child-shape.ts), so the proof lives beside the classifier that decides the same shapes.
 *  Gated on that proof rather than on "the stream happens to have no encounter", which is the
 *  condition the guard is meant to catch. */
function oneRowEncounter(stream: ScalarStream, terminal: IRStep, ctx?: ChildCtx): ScalarStream {
  if (stream.traverserLayout.encounter || !isOneRowProjection(terminal, ctx)) return stream;
  const p = stream.rel.as('oe');
  const layout = patchLayout(stream.traverserLayout, { encounter: 'encounter' });
  const payload = streamPayloadCols(stream);
  const rel = stream.q.cte(
    q`SELECT ${list(payload.map((c) => q`${p.c[c]} AS ${c}`), ', ')}${layoutProjectionMinting(layout, p, 'encounter', q`1`)} FROM ${p}`,
    [...payload, ...layoutCols(layout)],
  );
  return withRelationAndLayout(stream, layout, rel);
}

/** Compile a scalar-producing child as rows, so productivity is represented by row
 * existence rather than SQL NULL. Movement/filter uses the ordinary element fold;
 * projection adds an explicit provider encounter key; the shared scalar pipeline
 * applies transforms and origin-partitioned row operators; only then does the
 * consumer apply its `first` or `all` cardinality policy.
 *
 * The cardinality step itself is NOT scalar-specific — it is `applyChildCardinality`, shared with
 * every other shape. This wrapper exists only for `retainChildScope`, which is a scalar-consumer
 * concern (a caller that keeps the child frame to join more columns onto it later). */
function applyScalarChildCardinality(
  parent: ChildParent,
  pushed: ReturnType<typeof pushChildScope>,
  lowered: ScalarStream,
  use: ChildUse,
  retainChildScope: boolean,
): { stream: ScalarStream; frame: ChildFrame } {
  if (retainChildScope) return { stream: lowered, frame: pushed.frame };
  return applyChildCardinality(parent, pushed.frame, lowered, use);
}

/** Fold an ELEMENT-preserving child body — the engine's ONE whole-body fold, which crosses a
 *  `select(label)` re-root (see Engine.tryLowerElementSteps). Named here purely so the child
 *  seam's five seeds read as one operation; it adds nothing of its own. The correlated inline
 *  child (correlated.ts) reaches the SAME method, so a label re-root composes identically
 *  whether the body materializes or renders as a nested correlated subquery. */
export const lowerElementBody = (seed: ElementStream, steps: IRStep[]): ElementStream | null =>
  engineOf(seed).tryLowerElementSteps(steps, seed);

/** The Pop mode of a select(Pop, label) — default last, matching the root dispatch. */
const popOf = (step: IRStep): string =>
  (step.args.find((a: any) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined)?.pop ?? 'last';

/** PURE. A scalar child body that RE-SOURCES the graph: a `V()`/`E()` head (with no
 *  nested-traversal id argument, which is a different shape) over which the pushed scalar seed
 *  CROSS JOINs per value. The head discards the value and re-enters element space — the one
 *  way a scalar arm reaches movement/adjacency. */
export function isResourceHead(rest: IRStep[]): boolean {
  const head = rest[0];
  return !!head && (head.name === 'V' || head.name === 'E')
    && !(head.args ?? []).some(isNested);
}

/** Re-source a scalar seed (`V()`/`E()`) then fold the element movement/filter remainder,
 *  returning the ElementStream — or null if the remainder isn't fully element-lowerable.
 *  Shared by the re-source reducer path (compileScalarChildRows) and the mixed-shape variant
 *  element arm (tryScalarResourceElement); the value is discarded by the re-source (a flatMap
 *  CROSS JOIN), and a pushed ordinal rides through it unchanged. */
export function resourceElement(seed: ScalarStream, head: IRStep, after: IRStep[]): ElementStream | null {
  const el = lowerReSource(seed, head);
  if (!el) return null;
  return lowerElementBody(el, after);
}

/** GENERIC child-seam primitive: the per-parent neighbour count in a direction —
 *  pushChildScope → one movement over the pushed seed → scopedElementRowCount (LEFT JOIN domain,
 *  so a parent with no such edges scores 0). Not service-specific: it is "scoped movement
 *  count", the substrate a bare `both().count()` child also is. tinker.degree.centrality is
 *  its first caller; it composes this from the service, keeping child-seam internals here. */
export function scopedMovementCount(parent: ElementStream, scope: ChildFrameStack, direction: 'out' | 'in' | 'both'): ScalarStream {
  if (parent.elem !== 'vertex') throw new Error(`${direction}() degree expects a vertex input`);
  const pushed = pushChildScope(parent, scope);
  // A synthetic movement step — the StepFn reads only name/args, never .ctx.
  const moveStep = { name: direction, args: [], ctx: null as any } as IRStep;
  const { stream: moved, next } = engineOf(pushed.seed).lowerElementSteps([moveStep], pushed.seed);
  if (next !== 1) throw new Error(`could not lower ${direction}()`);
  // The pushed ordinal deliberately stays live (the call() seam's contract — an existence
  // consumer correlates on it); only the count's own encounter is minted on top.
  return scopedElementRowCount(moved, pushed).stream;
}

function compileScalarChildRows(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: ChildFrameStack = ROOT_SCOPE,
  retainChildScope = false,
  stripTerminal?: string,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  // `nested` is the parse tree to read the body FROM; `preParsed` is that body already in hand.
  // Requiring the tree even when the body was supplied is what kept callers whose body is a
  // Step[] SLICE — a match() pattern between its as() wrappers — out of this seam entirely.
  if (!nested && !preParsed) return null;
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
    const stream = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, body, 0);
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
  if (elementScalarBranchArm(body, childCtx(parent))) {
    const pushed = pushChildScope(parent, scope);
    const stream = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, body, 0);
    if (stream.kind !== 'scalar') throw new Error('scalar-branch child classified scalar but lowered to ' + stream.kind);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  // Scalar parent: the child body starts from the value `_` = v. Two families, each recognized
  // by a pure inline check BEFORE pushChildScope (so a miss returns null with no orphaned CTE):
  //   (a) a value-op body (transforms/is/order/slice — the pushed seed carries the minted
  //       encounter) that stays scalar, plus an optional terminal scoped reducer; and
  //   (b) a RE-SOURCE body (`V()`/`E()` then element movement/filter, optional projection):
  //       the pushed scalar seed CROSS JOINs the graph per value (lowerReSource carries the
  //       ordinal through), so a following scoped reducer/projection reduces per input.
  // fold() is stripped by the caller (stripTerminal), so it never appears here.
  if (isScalarParent(parent)) {
    const last = body.at(-1);
    const reducer = last && CHILD_SCALAR_REDUCERS.has(last.name) ? last.name as ScalarReducer : undefined;
    const rest = reducer ? body.slice(0, -1) : body;
    // A canonicalization pass may erase every step from a nested body. An empty
    // traversal is identity, so it remains productive once per pushed parent row.
    // Keep that semantic rule at the shared child seam rather than making each
    // existence consumer recognize the particular body a pass erased.
    if (!body.length) {
      const pushed = pushChildScope(parent, scope);
      return applyScalarChildCardinality(parent, pushed, pushed.seed, use, retainChildScope);
    }

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
        return applyScalarChildCardinality(parent, pushed, scopedElementRowCount(moved, pushed).stream, use, retainChildScope);
      }
      // Ends in a projection (values/id/label) → scalar. A re-source is the one
      // input-independent element body, so it may carry the ordinary root element
      // barriers before that projection; lowerSteps is their single lowering authority.
      // The syntax guard keeps this preflight pure (no speculative CTEs): only the
      // root-tail barrier vocabulary is admitted between the re-source and projection.
      const projectionAt = after.findIndex((s) => ['values', 'id', 'label'].includes(s.name));
      if (projectionAt < 0
        || !after.slice(0, projectionAt).every((s) => ELEMENT_CHILD_STEPS.has(s.name)
          || ['order', 'limit', 'skip', 'range', 'dedup'].includes(s.name))) return null;
      const pushed = pushChildScope(parent, scope);
      const lowered = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, rest, 0);
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
      const lowered = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, rest, 0);
      if (lowered.kind !== 'scalar') return null;
      stream = lowered;
    }
    if (reducer) stream = lowerScopedScalarReducer(stream, reducer, pushed.scope);
    return applyScalarChildCardinality(parent, pushed, stream, use, retainChildScope);
  }

  const shape = classifyScalarChildRows('element', body, childCtx(parent));
  if (!shape || shape.kind !== 'element') return null;
  const { prefix, projection: terminal, suffix } = shape.parts;

  // The ordinary row pipeline now uses the exact same iterative lowering loop as a
  // root traversal. Scoped reducers/folds retain their explicit per-origin policies
  // below; constant() still needs its child-only projector.
  if (terminal.name !== 'constant' && suffix.every(isSharedScalarChildStep)) {
    const pushed = pushChildScope(parent, scope);
    const stream = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, body, 0);
    // As above: classify proved scalar, so a non-scalar is a contradiction — fail loud.
    if (stream.kind !== 'scalar') throw new Error('scalar child classified scalar but lowered to ' + stream.kind);
    return applyScalarChildCardinality(parent, pushed, oneRowEncounter(stream, terminal, childCtx(parent)), use, retainChildScope);
  }

  // A scoped reducer / a `constant()` terminal in the row tail is the ONE thing the generic
  // loop above cannot absorb — those barriers are per-ORIGIN here and global there. Everything
  // BEFORE the tail is ordinary: the element prefix and its scalar projection lower through
  // `lowerStepsStrict`, exactly as the loop above does, and only the tail is continued by hand.
  //
  // This used to be a bespoke element-projection SQL builder — its own values/id/label/constant
  // switch against the generic `PROJECTORS` table's seven — and it answered DIFFERENTLY, because
  // it read `vp.value` raw where the projector reads `storedValueExpr(value, vtype)` and tags the
  // scalar `PER_ROW('vtype')`. Measured: with a list-valued property,
  // `g.V().values("nums").max()` yields the list at root and `map(__.values("nums").max())`
  // yielded NOTHING — a silent wrong answer, not a deferral. Splitting projection from
  // continuation removes the second implementation and the divergence with it.
  const pushed = pushChildScope(parent, scope);
  const head = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, [...prefix, terminal], 0);
  // classify proved the head scalar, so a non-scalar is a classify↔lowerSteps contradiction.
  if (head.kind !== 'scalar') throw new Error('scalar child projection classified scalar but lowered to ' + head.kind);

  const continueScalar = (base: ScalarStream): ScalarStream => {
    let stream = base;
    let at = 0;
    while (at < suffix.length) {
      const lowered = lowerScalarRows(stream, suffix, at);
      stream = lowered.stream;
      at = lowered.stop;
      if (at === suffix.length) break;
      const reducer = suffix[at].name;
      // A scalar row-run deliberately stops at an as(): binding a label is shape-agnostic, so at
      // root the engine's alias dispatch owns it. There is no engine loop here, so apply the ONE
      // implementation it would have used (asOnStream) and keep going — the same reuse the
      // element-body fold makes for select(). Without it the classifier (which admits as() in the
      // scalar row vocabulary) would claim a body this builder then threw on, mid-CTE.
      if (reducer === 'as') {
        const bound = asOnStream(stream, suffix[at]);
        if (bound.kind !== 'scalar') throw new Error('as() over a scalar child row did not stay scalar');
        stream = bound;
        at++;
        continue;
      }
      const label = labelSelectOf(suffix[at]);
      if (label !== null) {
        const selected = selectOneFromAlias(stream, suffix[at], label, popOf(suffix[at]));
        if (selected.kind !== 'scalar')
          throw new Error(`select("${label}") in a scalar child continuation must hold a value`);
        stream = selected;
        at++;
        continue;
      }
      if (!CHILD_SCALAR_REDUCERS.has(reducer))
        throw new Error(`scalar child continuation ${reducer}() not yet supported`);

      stream = lowerScopedScalarReducer(stream, reducer as ScalarReducer, pushed.scope);
      at++;
    }
    return stream;
  };
  const lowered = continueScalar(oneRowEncounter(head, terminal, childCtx(parent)));
  return applyScalarChildCardinality(parent, pushed, lowered, use, retainChildScope);
}

export function tryCompileScalarChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: ChildFrameStack = ROOT_SCOPE,
  body?: ChildBody,
): ScalarStream | null {
  return applySuffix(compileScalarChildRows(parent, nested, use, scope, false, undefined, bodyOf(body))?.stream ?? null, suffixOf(body));
}

/** One public scalar-valued child entry point. Consumers must not know whether a scalar came from
 * projected rows or a total scope-aware count barrier.
 *
 * The `??` is a UNION, not a precedence: the two arms are disjoint by classification — the count
 * arm needs an element-PRESERVING prefix before a bare `count()`, and a scalar producer
 * (values/id/label/constant/call/math/sack/format, a value-shaped select) never is one. So no body
 * can be claimed by both, and the order cannot change an answer. Its classify twin is
 * `classifyScalarChild`, which must admit the same union — and did not, keying on the terminal
 * step instead (see the note there).
 *
 * `use` reaches only the scalar arm. A count child is one row per parent BY CONSTRUCTION (the
 * barrier groups the preserved domain by ordinal), so `first` and `all` are the same stream. */
export function tryCompileScalarValueChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: ChildFrameStack = ROOT_SCOPE,
  body?: ChildBody,
): ScalarStream | null {
  return tryCompileCountChild(parent, nested, scope, body)
    ?? tryCompileScalarChild(parent, nested, use, scope, body);
}

/** Which of TinkerPop's TWO child-value contracts a consumer is enacting. Named for the
 *  `TraversalUtil` method each corresponds to, because the difference is a SEMANTIC contract
 *  the caller owns, not a join shape — the join is DERIVED from it (`joinsInner` below).
 *
 *   · `'produce'` — `TraversalUtil.produce` (the `MapStep` family: `format()`). Returns a
 *     `TraversalProduct` carrying `isProductive()`, and the consumer FILTERS the traverser when
 *     the child is unproductive (`FormatStep` returns `EmptyTraverser.instance()`). → INNER JOIN.
 *   · `'apply'` — `TraversalUtil.apply` (the `ScalarMapStep` family: `concat()`). Returns the
 *     value directly and THROWS on an unproductive child, so it can never filter:
 *     `ScalarMapStep.processNextStart` is `traverser.split(map(traverser), this)`, strictly
 *     1-in-1-out, and `prepare()` sets `setBulk(1L)` so the child cannot multiply the parent's
 *     multiplicity either. → LEFT JOIN, and the value is read as an ordinary (possibly-NULL)
 *     column. We diverge from TinkerPop only in that an unproductive child yields NULL where
 *     TinkerPop raises — erring toward a null/empty answer rather than a value it would reject.
 *   · `'presence'` — no TinkerPop method: the consumer reads the `present` column itself and
 *     routes on it (`choose()` → `Pick.none`/`Pick.unproductive`; `order().by()` → NULLs-first).
 *     Mechanically a LEFT JOIN like `'apply'`, but kept distinct because the consumer's obligation
 *     differs: it MUST read `present`, where an `'apply'` consumer must NOT need to.
 *
 *  `math()` uses `'produce'`: a non-numeric/absent variable drops the traverser. */
export type ModulationContract = 'produce' | 'apply' | 'presence';

/** Does this contract rejoin with an INNER join? The one place the join shape is decided, so a
 *  consumer states its CONTRACT and never spells out a join. */
const joinsInner = (c: ModulationContract): boolean => c === 'produce';

export interface ScalarModulationSpec {
  readonly nested: any;
  /** Re-root the child on a carried as()-label while retaining the outer row. */
  readonly rootCol?: string;
  readonly rootElem?: ElementStream['elem'];
  /** Which child-value contract this modulator enacts. Defaults to `'produce'` (filter on an
   *  unproductive child) — the behaviour every pre-existing caller had. */
  readonly contract?: ModulationContract;
}

/** A caller-supplied compiler for one modulator body, tried when the shared scalar-child route
 *  declines. It exists because the SCALAR-parent child vocabulary lives downstream of this file
 *  (`scalar-arm.ts` imports `child.ts`, never the reverse), so a scalar-parent consumer injects
 *  its own reach rather than this module growing an upward import. The seam still owns
 *  provisioning: the fallback is handed the pushed SEED and the reused frame's scope. It returns
 *  RAW child rows; this seam owns the first-row policy before the common rejoin, so a fallback
 *  cannot accidentally turn a scalar modulation into a fan-out. */
export type ModulationFallback = (
  seed: ElementStream | ScalarStream,
  nested: any,
  scope: ChildFrameStack,
) => ScalarStream | null;

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
 * ordinal. Every child exposes an explicit presence column, so productive NULL
 * is never confused with an unproductive child. This is the common relational seam
 * for multi-input consumers such as math(), format(), concat(), and option-map choose().
 *
 * PROVISIONING is fixed here (the PARENT STREAM route — `pushChildScope` + a rejoin on the
 * shared ordinal); what varies per spec is only the child-value CONTRACT
 * (`ModulationContract`), which the consumer owns and this function merely enacts. That split
 * is why a new consumer needs no new substrate: `concat()` differs from `format()` by one
 * declared contract, not by a second child pipeline. */
export function tryCompileScalarModulations(
  parent: ChildParent,
  specs: readonly ScalarModulationSpec[],
  fallback?: ModulationFallback,
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
        q`SELECT ${aliasId(p.c[spec.rootCol], 'last')} AS id${layoutProjection(es.traverserLayout, p)} FROM ${p}`,
        ['id', ...layoutCols(es.traverserLayout)],
      );
      seed = { ...es, rel, elem: spec.rootElem ?? es.elem };
    }
    const childScope = reuseCurrentFrame(outer.scope, outer.frame);
    const direct = tryCompileScalarValueChild(seed, spec.nested, 'first', childScope);
    const rawFallback = direct ? null : fallback?.(seed, spec.nested, childScope) ?? null;
    // The ordinary scalar child compiler already applies its use policy. A fallback
    // extends only the lowering vocabulary, so apply the SAME policy here at the seam.
    const stream = direct ?? (rawFallback
      // The fallback runs over `outer.seed`, not the caller's pre-push parent. Its raw rows
      // therefore carry this frame's ordinal; cardinality must retain that same layout so the
      // common modulation rejoin below can correlate on it. Re-homing on `parent` drops the
      // ordinal (and rendered an empty column reference for scalar parents).
      ? applyChildCardinality(outer.seed, outer.frame, rawFallback, 'first').stream as ScalarStream
      : null);
    return stream ? { stream, contract: spec.contract ?? 'produce' } : null;
  });
  if (children.some((x) => !x)) return null;

  const d = outer.frame.domain.as('md');
  const aliases = children.map((child, i) => ({ child: child!, rel: child!.stream.rel.as(`ms${i}`) }));
  const values = aliases.map((_, i) => ({ value: `m${i}`, present: `m${i}_present` }));
  const joins = aliases.map(({ child, rel }) =>
    q`${joinsInner(child.contract) ? q` JOIN ` : q` LEFT JOIN `}${rel} ON ${rel.c[outer.frame.ordinal]}=${d.c[outer.frame.ordinal]}`,
  );
  const payload = aliases.flatMap(({ rel }, i) => [
    q`${rel.c.v} AS ${values[i].value}`,
    q`CASE WHEN ${rel.c[outer.frame.ordinal]} IS NOT NULL THEN 1 END AS ${values[i].present}`,
  ]);
  // The rejoined rel projects the parent identity: an element parent's `id` (consumers rejoin
  // nodes/edges on it) or a scalar parent's value `v` (the current object itself).
  const idCol = scalarParent ? 'v' : 'id';
  const rel = parent.q.cte(
    q`SELECT ${d.c[idCol]} AS ${idCol}${layoutProjection(parent.traverserLayout, d)}, ${list(payload, ', ')} FROM ${d}${list(joins, '')}`,
    [idCol, ...layoutCols(parent.traverserLayout), ...values.flatMap((x) => [x.value, x.present])],
  );
  return { rel, values, idCol };
}

/** Productive scalar rows with the child origin still live. Barrier/side-effect
 * consumers use this form when THEY own first/all/productive-null cardinality;
 * keeping that decision out of the child parser is the central consumer-policy seam. */
export function tryCompileScalarValueRows(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  return tryCompileCountValueRows(parent, nested, scope, preParsed)
    ?? compileScalarChildRows(parent, nested, 'all', scope, true, undefined, preParsed);
}

/** A bare branch (union/coalesce/choose) whose arms are uniformly LIST or genuinely MIXED
 *  (variant) as an ALL-cardinality child body (local/flatMap). It lowers to a ListStream/
 *  VariantStream through lowerStepsStrict over a pushed child scope — the branch's list/variant
 *  merge is parent-agnostic and rides the pushed ordinal — then the payload rows are re-projected
 *  to the parent's carried schema, dropping the child ordinal. A branch has ≥2 productive arm rows,
 *  so it emits several payload rows per parent (multiset-faithful, as UNION ALL); local/flatMap emit
 *  them all. map() (first-of-a-multi-output body) is deliberately NOT a caller — it falls through to
 *  its clear deferral rather than silently returning one arm's value. Element/scalar-armed branch
 *  children keep their own cardinality-aware paths (compileElementChildRows / compileScalarChildRows);
 *  this covers only the two arm shapes those don't. */
export function tryCompileBranchChildAllCard(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
): ListStream | VariantStream | null {
  if (!nested || isPropertyParent(parent) || isScalarParent(parent)) return null;
  if (!isBareBranchChildAllCard(nested, childCtx(parent))) return null;
  const body = childSteps(nested, parent.params);
  const pushed = pushChildScope(parent, scope);
  const lowered = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, body, 0);
  if (lowered.kind !== 'list' && lowered.kind !== 'variant') return null;
  // The ONE rejoin: `all` keeps every arm row, and the payload (a list's `list`; a variant's
  // vk/v/rid + list when a list arm is present) comes from streamPayloadCols, so neither shape
  // is spelled out here. Projecting only the parent's carried is what drops the pushed ordinal.
  return applyChildCardinality(parent, pushed.frame, lowered, 'all').stream;
}

/** Scalar rows followed by fold() become one ListStream per parent. This is a true
 * child barrier: empty children emit [], productive NULL remains [null], and only
 * the innermost origin is removed at the consumer boundary. */
export function tryCompileListChild(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
  body?: ChildBody,
): ListStream | null {
  // Both arms are the same three operations — generic rows (the engine, via the shared row
  // compilers) ▸ the scope-aware fold barrier ▸ the ONE cardinality rejoin. Only the middle one
  // differs by shape, because the value being aggregated does (a scalar `v` vs a rowid), so the
  // shape-specific part is a function reference, not a second copy of the plumbing. The fold
  // cannot come from the engine's own fold(): that one is GLOBAL (one list for the whole
  // stream), and the per-parent form needs the frame's domain relation for its empty-child `[]`,
  // which is child-seam state and deliberately not reachable from a Stream.
  const scoped = compileScalarChildRows(parent, nested, 'all', scope, true, 'fold', bodyOf(body));
  const rows = scoped
    ? { ...scoped, fold: () => lowerScopedScalarFold(scoped.stream, { kind: 'child', frames: [scoped.frame] }) }
    : (() => {
      const element = compileElementChildRows(parent, nested, scope, 'fold', false, bodyOf(body));
      return element && { ...element, fold: () => lowerScopedElementFold(element.stream, { kind: 'child', frames: [element.frame] }) };
    })();
  if (!rows) return null;
  return applySuffix(applyChildCardinality(parent, rows.frame, rows.fold(), 'all').stream as ListStream, suffixOf(body));
}

/** Productive scalar rows immediately before fold(). Group-like consumers use
 * this when the fold belongs to their final key domain rather than to each parent
 * independently. The child origin and encounter marker deliberately remain live. */
export function tryCompileScalarRowsBeforeFold(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ScalarStream; frame: ChildFrame } | null {
  return compileScalarChildRows(parent, nested, 'all', scope, true, 'fold', preParsed);
}

/** Productive element rows immediately before fold(), retaining the child origin so
 * a group consumer can fold them over its final key rather than once per parent. */
export function tryCompileElementRowsBeforeFold(
  parent: ChildParent,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
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
  scope: ChildFrameStack = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; frame: ChildFrame } | null {
  return compileElementChildRows(parent, nested, scope, undefined, false, preParsed);
}

/** Productive element rows with the child origin retained. Existence consumers use
 * the row marker only; optional/group-like consumers may inspect the typed element. */
export function tryCompileElementValueRows(
  parent: ElementStream,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
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
  scope: ChildFrameStack = ROOT_SCOPE,
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
  scope: ChildFrameStack = ROOT_SCOPE,
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
  return appendCte(parent,
    q`SELECT ${d.c.id} AS id${layoutProjection(parent.traverserLayout, d)} FROM ${d} WHERE ${negate ? q`NOT (${combined})` : combined}`,
  );
}

/** The shared correlated-existence core: compile the child once, then return a
 * builder that projects the preserved parent domain filtered on child row existence
 * (or absence). The domain ordinal keeps duplicate parents distinct. */
function childExistenceGate(
  parent: ElementStream,
  nested: any,
  scope: ChildFrameStack,
): ((negate: boolean) => ElementStream) | null {
  const child = tryCompileElementValueRows(parent, nested, scope)
    ?? tryCompileScalarValueRows(parent, nested, scope);
  if (!child) return null;
  return (negate: boolean) => {
    const d = child.frame.domain.as('d');
    const c = child.stream.rel.as('c');
    const exists = q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[child.frame.ordinal]}=${d.c[child.frame.ordinal]})`;
    return appendCte(parent,
      q`SELECT ${d.c.id} AS id${layoutProjection(parent.traverserLayout, d)} FROM ${d} WHERE ${negate ? q`NOT (${exists})` : exists}`,
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
  scope: ChildFrameStack = ROOT_SCOPE,
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
  // A parent sack rides through the child scope unchanged — pushChildScope projects the full
  // layoutCols (sack included) into the domain, and lowerElementSteps threads it — so a scoped
  // sack fold (local(__.sack(op).by(...))) folds per parent correctly. fromV stays gated (an
  // edge's entering-vertex is undefined inside a child scope that may move off the edge).
  if (!nested && !preParsed) return null;
  // See the scalar counterpart above. This must precede shape classification:
  // identity has the parent's element shape and requires no prefix StepFn.
  const body = preParsed ?? childSteps(nested, parent.params);
  if (!body.length) {
    const pushed = pushChildScope(parent, scope);
    return { stream: pushed.seed, frame: pushed.frame };
  }
  // An edge's entering-vertex context is only MEANINGFUL to a body that reads it, and `otherV()`
  // is the sole reader (`prefix/movement.ts`). A body that reads it inside a child scope would get
  // the PARENT's entering vertex — which is undefined once the body moves — so that stays declined.
  // A body that never mentions it (a plain filter, the common case) carries the column through
  // unread and is perfectly compilable.
  //
  // The blanket form of this guard was a fast-path DISABLE-SAFETY hole, found by L5's rotating
  // seed: `g.V().outE().where(__.has('weight', P.gt(1))).otherV()` puts a trailing otherV() on the
  // chain, which turns trackFromV on for the whole prefix, so outE() carries fromV and this
  // declined a where() body containing nothing but a property filter. The inline predicate answered
  // it and the generic path threw, so the two disagreed with fast paths off.
  if (parent.traverserLayout.fromV && someStepDeep(body, parent.params, (s) => s.name === 'otherV')) return null;
  // ONE shape classification (the same classifyElementChildRows the element preflight peeks
  // use) — the bare-order strip, firstPolicy order modulator, and empty-before handling all
  // live in the shared helper, so preflight and compiler cannot diverge.
  const shape = classifyElementChildRows(body, stripTerminal, firstPolicy, childCtx(parent));
  if (!shape) return null;
  const { parts, orderStep } = shape;
  const pushed = pushChildScope(parent, scope);
  // (trackFromV for an exploded otherV() body is derived inside lowerElementSteps, the single
  // fold every scope passes through — see the note there.)
  const prefixed = lowerElementBody(pushed.seed, parts.prefix);
  if (!prefixed) return null;

  // Rank rows per parent traverser: order/slice/first all window over the child's origin
  // stack (partitionOver — equivalent to the innermost ordinal, which is globally unique,
  // and robust to nesting). One shared window builder so the three sites can't drift.
  const rankPerParent = (layout: TraverserLayout, p: Relation, orderKey: Expression): Expression =>
    q`ROW_NUMBER() OVER (${partitionOver(layout, p, orderKey)})`;

  let end = prefixed;
  for (const step of parts.suffix) {
    const p = end.rel.as('p');
    // A scoped row barrier preserves an ElementStream, so the next phase can use the
    // same element StepFns as the prefix. The classifier has already established that
    // every non-barrier suffix step is element-preserving; keep the emitter on that
    // one generic fold instead of giving each barrier a private follower vocabulary.
    if (!['local', 'order', 'dedup', 'range', 'skip', 'limit'].includes(step.name)) {
      const reentered = lowerElementBody(end, [step]);
      if (!reentered) return null;
      end = reentered;
      continue;
    }
    if (step.name === 'local') {
      const nested = step.args[0]?.nested;
      const lowered = nested ? tryCompileElementChild(end, nested, 'all') : null;
      if (!lowered) return null;
      end = lowered.stream;
      continue;
    }
    if (step.name === 'order') {
      const n = elemTable(end.elem).as('n');
      const ordered = patchLayout(end.traverserLayout, { encounter: 'encounter' });
      const orderExpr = elementOrderSql(end, n, step);
      // The non-productive by(key) drop applies inside a child body exactly as at the root — same
      // policy function, so `local(__.order().by('age'))` and `order().by('age')` cannot disagree.
      const drop = elementOrderDrop(end, n, step);
      const rank = rankPerParent(end.traverserLayout, p, q`${orderExpr}, ${p.c.id}`);
      end = appendCte(end,
        q`SELECT ${p.c.id} AS id${layoutProjectionMinting(ordered, p, 'encounter', rank)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}${drop ? q` WHERE ${drop}` : empty}`,
        { encounter: 'encounter' },
      );
      continue;
    }
    if (step.name === 'dedup') {
      // The child-scope twin of the root dedup (prefix/filter.ts), and the same reference rule:
      // the survivor is the FIRST occurrence, so an ordered body keeps its order through the
      // collapse. A per-row-unique encounter cannot ride through DISTINCT, so where one is live
      // this is a GROUP BY with MIN(encounter); with none it stays the plain DISTINCT.
      const enc = end.traverserLayout.encounter;
      if (!enc) {
        end = appendCte(end, q`SELECT DISTINCT ${p.c.id} AS id${layoutProjection(end.traverserLayout, p)} FROM ${p}`);
        continue;
      }
      const cols = layoutCols(end.traverserLayout).map((c) => c === enc ? q`MIN(${p.c[c]}) AS ${c}` : q`${p.c[c]}`);
      const groupBy = [q`${p.c.id}`, ...layoutCols(end.traverserLayout).filter((c) => c !== enc).map((c) => q`${p.c[c]}`)];
      end = appendCte(end, q`SELECT ${p.c.id} AS id, ${list(cols, ', ')} FROM ${p} GROUP BY ${list(groupBy, ', ')}`);
      continue;
    }
    const slice = sliceOf(step);
    const cols = layoutCols(end.traverserLayout);
    const r = derived(
      q`SELECT ${p.c.id} AS id${layoutProjection(end.traverserLayout, p)}, ${rankPerParent(end.traverserLayout, p, end.traverserLayout.encounter ? p.c[end.traverserLayout.encounter] : p.c.id)} AS rn FROM ${p}`,
      ['id', ...cols, 'rn'],
      'r',
    );
    const hi = slice.limit === null ? null : slice.offset + slice.limit;
    const upper = hi === null ? empty : q` AND ${r.c.rn} <= ${hi}`;
    end = appendCte(end, q`SELECT ${r.c.id} AS id${layoutProjection(end.traverserLayout, r)} FROM ${r} WHERE ${r.c.rn} > ${slice.offset}${upper}`);
  }
  if (firstPolicy) {
    const p = end.rel.as('p');
    const n = elemTable(end.elem).as('n');
    const orderExpr = elementOrderSql(end, n, orderStep as IRStep | undefined);
    const cols = layoutCols(end.traverserLayout);
    const r = derived(
      q`SELECT ${p.c.id} AS id${layoutProjection(end.traverserLayout, p)}, ${rankPerParent(end.traverserLayout, p, q`${orderExpr}, ${p.c.id}`)} AS rn FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`,
      ['id', ...cols, 'rn'],
      'r',
    );
    end = appendCte(end, q`SELECT ${r.c.id} AS id${layoutProjection(end.traverserLayout, r)} FROM ${r} WHERE ${r.c.rn}=1`);
  }
  return { stream: end, frame: pushed.frame };
}

/** Map-style element modulation: retain the first row per parent after an optional
 * terminal order(). The origin remains live so ProductiveBy consumers can restore
 * missing parents as explicit nulls. */
export function tryCompileFirstElementValueRows(
  parent: ElementStream,
  nested: any,
  scope: ChildFrameStack = ROOT_SCOPE,
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
  scope: ChildFrameStack = ROOT_SCOPE,
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
  const outCarried = patchLayout(element.stream.traverserLayout, { encounter: 'encounter' });
  const encMint = q`ROW_NUMBER() OVER (PARTITION BY ${e.c[element.frame.ordinal]} ORDER BY ${e.c.id})`;
  const rel = parent.q.cte(
    q`SELECT 1 AS v${layoutProjectionMinting(outCarried, e, 'encounter', encMint)} FROM ${e}`,
    ['v', ...layoutCols(outCarried)],
  );
  return {
    stream: toScalarStream(loweringStateOf(element.stream, outCarried), rel, undefined, { result: 'value' }),
    frame: element.frame,
    reducer,
  };
}

export function tryCompileElementChild(
  parent: ElementStream,
  nested: any,
  use: ChildUse,
  scope: ChildFrameStack = ROOT_SCOPE,
  preParsed?: ReturnType<typeof stepChain>,
): { stream: ElementStream; scope: ChildFrameStack } | null {
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
  scope: ChildFrameStack = ROOT_SCOPE,
): ElementStream | null {
  const scoped = tryCompileElementChild(parent, nested, 'all', scope);
  if (scoped) return scoped.stream;
  if (!nested) return null;
  const body = childSteps(nested, parent.params);
  if (parent.traverserLayout.origins.length && body.some((step) => step.name === 'repeat'))
    throw new Error('repeat() inside a correlated element child not yet supported (recursive walk does not carry the parent ordinal)');
  return engineOf(parent).tryLowerElementSteps(body, parent);
}
