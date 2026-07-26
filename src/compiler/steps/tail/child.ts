import { derived, empty, list, paren, q, value, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { perRowColumnOf, perRowCols } from '../../../sql/kernel/render.ts';
import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import { edges, labels, nodes, vertexProperties, edgeProperties } from '../../../sql/schema.ts';
import { advance, carriedWith, carryFrag, carryFragMint, carriedCols, partitionOver, type Carried, type ElementStream } from '../context/context.ts';
import { aliasId } from '../context/alias.ts';
import { carryOf, toListStream, toScalarStream, PROPERTY_PAYLOAD, type ListStream, type PropertyStream, type ScalarStream } from '../context/stream.ts';
import { engineOf } from '../../engine/deps.ts';
import { lowerScalarRows, unionScalarStreams, SCALAR_TRANSFORMS } from './scalar.ts';
import { lowerScalarVE } from './projection.ts';
import { type PStep } from '../../ir/strategies.ts';
import { lowerScopedElementFold, lowerScopedScalarFold, lowerScopedScalarReducer, type ScalarReducer } from './barrier.ts';
import { predicateSql, rangeToOffsetLimit } from '../../plan/plan.ts';
import { elementOrderSql } from './modulation.ts';
import {
  childSteps, classifyCountChild, classifyElementChildRows, classifyScalarChildRows, elementScalarBranchArm,
  ELEMENT_CHILD_STEPS, reuseCurrentFrame, ROOT_SCOPE, scalarChildPrefixOk,
  type ChildFrame, type ChildParent, type ChildScope, type ChildUse, type CompileScope,
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
    const vtypeCols = perRowCols(parent.type);
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

/** Child scalar reducers (compiler-side: the terminal barrier vocabulary the row compilers
 *  weight/aggregate on). The classify half of this vocabulary lives in child-shape.ts.
 *  Exported for the scalar-arm consumers (scalar-arm.ts). */
export const CHILD_SCALAR_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);
/** The scalar continuation a property/element scalar child may carry after its projection
 *  (compiler-side; the classify twin is CHILD_SCALAR_ROW_STEPS in child-shape.ts). */
const SHARED_SCALAR_CHILD_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'order', 'limit', 'skip', 'range', 'tail', 'dedup',
]);

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
  const counted = classifyCountChild(preParsed ?? childSteps(nested, parent.params), parent.params);
  if (!counted) return null;
  const { prefix } = counted;

  const pushed = pushChildScope(parent, scope);
  const { stream: end, next: stop } = engineOf(pushed.seed).lowerElementSteps(prefix, pushed.seed);
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
  const counted = classifyCountChild(body.slice(0, cut), parent.params);
  if (!counted) return null;
  const { prefix } = counted;
  const pushed = pushChildScope(parent, scope);
  const { stream: end, next: stop } = engineOf(pushed.seed).lowerElementSteps(prefix, pushed.seed);
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
  // Carry the child's per-row type column through the re-projection so a child body over a
  // stored property (out().values('when')) keeps each value's exact type instead of
  // collapsing to its storage class at the child boundary.
  const perRow = perRowColumnOf(lowered.type);
  const typeCol = lowered.result === 'number' ? q`, ${r.c.vt} AS vt` : perRow ? q`, ${r.c[perRow]} AS ${perRow}` : empty;
  const resultCols = lowered.result === 'number' ? ['v', 'vt'] : ['v', ...perRowCols(lowered.type)];
  if (use === 'all') {
    const rel = derived(q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)} FROM ${r}`, [...resultCols, ...parentCols], 'all_rows');
    return { stream: toScalarStream(carryOf(parent), rel, undefined, { type: lowered.type, result: lowered.result }), frame: pushed.frame };
  }
  if (!lowered.carried.encounter) throw new Error('child first cardinality requires explicit encounter order');
  const loweredEnc = lowered.carried.encounter;
  const first = derived(
    q`SELECT ${r.c.v} AS v${typeCol}${carryFrag(parent.carried, r)}, ROW_NUMBER() OVER (PARTITION BY ${r.c[pushed.frame.ordinal]} ORDER BY ${r.c[loweredEnc]}) AS rn FROM ${r}`,
    [...resultCols, ...parentCols, 'rn'],
    'f',
  );
  const firstTypeCol = lowered.result === 'number' ? q`, ${first.c.vt} AS vt` : perRow ? q`, ${first.c[perRow]} AS ${perRow}` : empty;
  const rel = derived(
    q`SELECT ${first.c.v} AS v${firstTypeCol}${carryFrag(parent.carried, first)} FROM ${first} WHERE ${first.c.rn}=1`,
    [...resultCols, ...parentCols],
    'first_row',
  );
  return { stream: toScalarStream(carryOf(parent), rel, undefined, { type: lowered.type, result: lowered.result }), frame: pushed.frame };
}

/** PURE. A scalar child body that RE-SOURCES the graph: a `V()`/`E()` head (with no
 *  nested-traversal id argument, which is a different shape) over which the pushed scalar seed
 *  CROSS JOINs per value. The head discards the value and re-enters element space — the one
 *  way a scalar arm reaches movement/adjacency. */
export function isResourceHead(rest: PStep[]): boolean {
  const head = rest[0];
  return !!head && (head.name === 'V' || head.name === 'E')
    && !(head.args ?? []).some(isNested);
}

/** Re-source a scalar seed (`V()`/`E()`) then fold the element movement/filter remainder,
 *  returning the ElementStream — or null if the remainder isn't fully element-lowerable.
 *  Shared by the re-source reducer path (compileScalarChildRows) and the mixed-shape variant
 *  element arm (tryScalarResourceElement); the value is discarded by the re-source (a flatMap
 *  CROSS JOIN), and a pushed ordinal rides through it unchanged. */
export function resourceElement(seed: ScalarStream, head: PStep, after: PStep[]): ElementStream | null {
  const el = lowerScalarVE(seed, head);
  if (!el) return null;
  const { stream, next } = engineOf(el).lowerElementSteps(after, el);
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
  const { stream: moved, next } = engineOf(pushed.seed).lowerElementSteps([moveStep], pushed.seed);
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
  if (elementScalarBranchArm(body, parent.params)) {
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
      if (classifyScalarChildRows('element', after, parent.params)?.kind !== 'element') return null;
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

  const shape = classifyScalarChildRows('element', body, parent.params);
  if (!shape || shape.kind !== 'element') return null;
  const { prefix, projection: terminal, suffix } = shape.parts;

  // The ordinary row pipeline now uses the exact same iterative lowering loop as a
  // root traversal. Scoped reducers/folds retain their explicit per-origin policies
  // below; constant() still needs its child-only projector.
  if (terminal.name !== 'constant' && suffix.every((step) => SHARED_SCALAR_CHILD_STEPS.has(step.name))) {
    const pushed = pushChildScope(parent, scope);
    const stream = engineOf(pushed.seed).lowerStepsStrict(pushed.seed, body, 0);
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
  const { stream: end, next: stop } = engineOf(pushed.seed).lowerElementSteps(prefix, pushed.seed);
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
  // A parent sack rides through the child scope unchanged — pushChildScope projects the full
  // carriedCols (sack included) into the domain, and lowerElementSteps threads it — so a scoped
  // sack fold (local(__.sack(op).by(...))) folds per parent correctly. fromV stays gated (an
  // edge's entering-vertex is undefined inside a child scope that may move off the edge).
  if (!nested || parent.carried.fromV) return null;
  // ONE shape classification (the same classifyElementChildRows the element preflight peeks
  // use) — the bare-order strip, firstPolicy order modulator, and empty-before handling all
  // live in the shared helper, so preflight and compiler cannot diverge.
  const shape = classifyElementChildRows(preParsed ?? childSteps(nested, parent.params), stripTerminal, firstPolicy, parent.params);
  if (!shape) return null;
  const { parts, orderStep } = shape;
  const pushed = pushChildScope(parent, scope);
  // (trackFromV for an exploded otherV() body is derived inside lowerElementSteps, the single
  // fold every scope passes through — see the note there.)
  const { stream: prefixed, next: stop } = engineOf(pushed.seed).lowerElementSteps(parts.prefix, pushed.seed);
  if (stop !== parts.prefix.length) return null;

  // Rank rows per parent traverser: order/slice/first all window over the child's origin
  // stack (partitionOver — equivalent to the innermost ordinal, which is globally unique,
  // and robust to nesting). One shared window builder so the three sites can't drift.
  const rankPerParent = (carried: Carried, p: Relation, orderKey: Expression): Expression =>
    q`ROW_NUMBER() OVER (${partitionOver(carried, p, orderKey)})`;

  let end = prefixed;
  for (const step of parts.suffix) {
    const p = end.rel.as('p');
    if (step.name === 'local') {
      const nested = step.args[0]?.nested;
      const lowered = nested ? tryCompileElementChild(end, nested, 'all') : null;
      if (!lowered) return null;
      end = lowered.stream;
      continue;
    }
    if (step.name === 'order') {
      const n = (end.elem === 'edge' ? edges : nodes).as('n');
      const ordered = carriedWith(end.carried, { encounter: 'encounter' });
      const orderExpr = elementOrderSql(end, n, step);
      const rank = rankPerParent(end.carried, p, q`${orderExpr}, ${p.c.id}`);
      end = advance(end,
        q`SELECT ${p.c.id} AS id${carryFragMint(ordered, p, 'encounter', rank)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`,
        { encounter: 'encounter' },
      );
      continue;
    }
    if (step.name === 'dedup') {
      // A preceding order() mints a per-row-unique encounter into carried; keeping it in the
      // DISTINCT projection would defeat the collapse (every row stays distinct). dedup()
      // re-establishes set semantics and legitimately discards the prior emission order, so
      // drop encounter here — a following slice then falls back to ORDER BY id (the ternary
      // below already handles the cleared case).
      const deduped = carriedWith(end.carried, { encounter: null });
      end = advance(end, q`SELECT DISTINCT ${p.c.id} AS id${carryFrag(deduped, p)} FROM ${p}`, { encounter: null });
      continue;
    }
    const slice = step.name === 'range' ? rangeToOffsetLimit(step.args)
      : step.name === 'skip' ? { offset: Number(step.args[0]), limit: -1 }
      : { offset: 0, limit: Number(step.args[0]) };
    const cols = carriedCols(end.carried);
    const r = derived(
      q`SELECT ${p.c.id} AS id${carryFrag(end.carried, p)}, ${rankPerParent(end.carried, p, end.carried.encounter ? p.c[end.carried.encounter] : p.c.id)} AS rn FROM ${p}`,
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
      q`SELECT ${p.c.id} AS id${carryFrag(end.carried, p)}, ${rankPerParent(end.carried, p, q`${orderExpr}, ${p.c.id}`)} AS rn FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`,
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
  return engineOf(parent).tryLowerElementSteps(body, parent);
}

