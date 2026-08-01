// ---------- scalar-arm: the scalar-PARENT branch/map/filter compilers ----------
//
// A cohesive sub-concern lifted out of child.ts: compiling a child body when the PARENT
// traverser is a SCALAR (values()/count()/a projected value). Over a scalar there is no
// adjacency, so an arm is a cardinality-preserving VALUE sub-traversal (transforms, predicates,
// a reducer, a nested value-branch) or a re-source (`V()`/`E()`) back into element space. These
// are the scalar twins of branch.ts's element-parent choose/union/coalesce/map + filter.
//
// Every function here is called from exactly ONE place — projection.ts's compileFromScalar
// dispatch (tryScalarMapChild/tryScalar{Choose,Union,Coalesce}Child, the tryScalarVariant*
// mixed-shape merges, tryScalarOptionalChild, tryScalarFilterByChildExistence). Splitting them
// off drops child.ts by ~500 lines and puts the whole scalar-arm concern in one file whose
// surface a reader can hold at once.
//
// Dependencies flow ONE way: scalar-arm.ts imports the scope substrate + a few scalar-value
// compilers from child.ts (pushChildScope / tryCompileScalar{Value,}Child / tryCompileListChild /
// resourceElement / isResourceHead / CHILD_SCALAR_REDUCERS), the pure classifiers from
// child-shape.ts, and the scalar/variant merge builders from their leaves. child.ts does NOT
// import back from here; projection.ts (the sole caller) imports the arm functions from here.
// The child.ts <-> projection.ts <-> scalar-arm.ts cycle is the same lazy-function ESM cycle
// child.ts <-> projection.ts already is (every reference is inside a function body, never at
// module top level), so it is resolution-safe.

import { isNested } from '../../../gremlin/frontend.ts';
import { UNKNOWN, staticTypeOf, perRowColumnOf, perRowCols } from '../../../sql/kernel/render.ts';
import { empty, list, paren, q, value, type Expression } from '../../../sql/kernel/q.ts';
import { collapsedArmAdmissible, layoutCols, patchLayout, layoutProjection, type ElementStream } from '../context/context.ts';
import { loweringStateOf, rebuildScalar, toScalarStream, type ScalarStream, type VariantStream } from '../context/stream.ts';
import { mergeVariantArms, mergeVariantParts, variantArmsMeta, type VariantArm } from './variant.ts';
import { engineOf, fastPathContextOf } from '../../engine/deps.ts';
import { runFastPath, type FastPath } from '../../options/fast-paths.ts';
import { enterBranch, gateArmOnNonEmptyInput } from './barrier.ts';
import { gateScalar, tryInlineScalarPredicate, unionScalarStreams } from './scalar.ts';
import { predicateSql, TYPE_PER_ROW, TYPE_UNKNOWN } from '../../plan/plan.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { armBatches } from '../../ir/step.ts';
import {
    CHILD_SCALAR_REDUCERS, isResourceHead, pushChildScope, resourceElement,
    tryCompileListChild, tryCompileScalarValueChild, tryCompileScalarValueRows,
} from './child.ts';
import {
    childSteps, classifyScalarChildRows, ELEMENT_CHILD_STEPS, reuseCurrentFrame, ROOT_SCOPE,
    SCALAR_ARM_TX, scalarChildPrefixOk, type BranchArmShape, type ChildFrameStack,
} from './child-shape.ts';

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
// Row ops with a throw-free non-origin (root-scope) path. `tail`/`dedup` are excluded on
// purpose: tail() requires an encounter column (throws at root) and dedup() clears the
// carried schema (dropLayoutAtBarrier), which would desync the union/choose merge that projects
// the outer carried columns off every arm — both defer cleanly as an arm instead.
const SCALAR_ARM_ROW = new Set(['as', 'is', 'constant', 'identity', 'order', 'limit', 'skip', 'range', 'unfold']);
const SCALAR_ARM_FILTER = new Set(['and', 'or', 'not', 'filter', 'where']);
// Nested per-traverser branches whose own arms are recursively scalar-arm bodies: a value
// branch inside a value arm lowers through lowerSteps→the same tryScalar*Child consumer, so
// choose(P,__.union(__.constant('a'),__.constant('b')),…) composes. The option-map choose
// form (step.optionArms) carries its arm bodies off step.optionArms, not step.args, so it is NOT
// recursed here (defers cleanly rather than being under-checked).
const SCALAR_ARM_BRANCH = new Set(['choose', 'union', 'coalesce', 'map', 'flatMap', 'local']);

/** A single scalar-arm leaf step the engine lowers without throwing. Kept in lockstep with
 *  what lowerScalarRows/SCALAR_DISPATCH actually support so the recognizer never accepts a body
 *  that would throw mid-lowering (breaking the return-null fall-through contract). */
const scalarArmLeafOk = (s: IRStep): boolean =>
  SCALAR_ARM_TX.has(s.name) || SCALAR_ARM_ROW.has(s.name)
  || (s.name === 'asNumber' && (s.args ?? []).length > 0);

function scalarBranchArm(body: IRStep[], params: Record<string, any>): boolean {
  return body.length > 0 && body.every((s) => {
    const kids = (s.args ?? []).filter(isNested);
    // The filter family lowers via lowerScalarFilter, which requires a nested traversal —
    // the predicate-P form (where(gt(5))) throws, so require kids and recurse into each so
    // an unsupported nested body defers here rather than throwing mid-lowering.
    if (SCALAR_ARM_FILTER.has(s.name)) return kids.length > 0 && kids.every((a: any) => scalarBranchArm(childSteps(a.nested, params), params));
    // A nested value-branch: every arm must itself be a scalar value arm so the whole thing
    // stays scalar and never throws mid-lowering. Option-map choose (s.optionArms) is excluded.
    if (SCALAR_ARM_BRANCH.has(s.name) && !(s as IRStep).optionArms)
      return kids.length > 0 && kids.every((a: any) => scalarBranchArm(childSteps(a.nested, params), params));
    return scalarArmLeafOk(s) && kids.length === 0;
  });
}

/** PURE. A terminal scoped reducer (count/sum/min/max/mean) over a value-op prefix — the
 *  child-scoped scalar arm that tryCompileScalarValueChild lowers per value. This is the
 *  reducer half of scalarArmClassifies: scalarBranchArm covers value/nested-branch arms at
 *  root scope, this covers the per-value reduction that needs the pushed child scope. */
function scalarReducerArm(body: IRStep[]): boolean {
  const last = body.at(-1);
  if (!last || !CHILD_SCALAR_REDUCERS.has(last.name)) return false;
  return body.slice(0, -1).every(scalarChildPrefixOk);
}

/** PURE. A re-source arm (`V()`/`E()` head then an element remainder) that reduces/projects
 *  back to a scalar — the classify twin of compileScalarChildRows' re-source branch. A
 *  movement-only re-source needs a terminal count(); a projecting one (values/id/label) needs
 *  a valid element-child tail. Kept in lockstep with that branch so the recognizer never
 *  accepts a body the child compiler would decline. */
function scalarResourceArm(body: IRStep[]): boolean {
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
function scalarArmClassifies(body: IRStep[], params: Record<string, any>): boolean {
  return scalarBranchArm(body, params) || scalarReducerArm(body) || scalarResourceArm(body);
}

/** Lower one branch/map arm body over a scalar (gated) parent → a ScalarStream, or null to
 *  defer. The scalar twin of tryCompileElementTraversal: a cardinality-preserving value body
 *  lowers at root scope (lowerScalarArm — transforms/is/filter/nested value-branch); a body
 *  whose terminal reduces per value (count/sum/min/max/mean) needs the pushed scalar child
 *  scope (tryCompileScalarValueChild). Shared by map/flatMap/local AND union/choose/coalesce. */
export function tryCompileScalarArm(parent: ScalarStream, nested: any, scope: ChildFrameStack = ROOT_SCOPE): ScalarStream | null {
  return lowerScalarArm(parent, childSteps(nested, parent.params))
    ?? tryCompileScalarValueChild(parent, nested, 'all', scope);
}

/** Lower one scalar arm body over the scalar parent, returning null (defer) if it falls
 *  outside the Stage-1 vocabulary or does not stay scalar (e.g. a fold() → list). */
function lowerScalarArm(s: ScalarStream, body: IRStep[]): ScalarStream | null {
  if (!scalarBranchArm(body, s.params)) return null;
  const end = engineOf(s).lowerStepsStrict(s, body, 0);
  return end.kind === 'scalar' ? end : null;
}

/** PURE. Does this scalar arm body emit MORE than one value per input? A terminal reducer or
 *  fold() collapses to one; a `V()`/`E()` re-source (bare or projecting) or a nested `union`
 *  fans out; a nested choose/coalesce fans out only if a reachable arm does. Used to gate
 *  `map()` (first-result-only) — it fails closed on a fan-out body it would otherwise
 *  over-produce, rather than returning the wrong count. */
function armFansOut(body: IRStep[], params: Record<string, any>): boolean {
  const last = body.at(-1);
  if (last && (CHILD_SCALAR_REDUCERS.has(last.name) || last.name === 'fold')) return false;
  if (isResourceHead(body)) return true;
  return body.some((s) => {
    if (s.name === 'union') return true;
    const kids = (s.args ?? []).filter(isNested);
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
export function tryScalarMapChild(s: ScalarStream, step: IRStep, allowFanout = true): ScalarStream | null {
  const arg = step.args?.[0];
  if (!isNested(arg)) return null;
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
  const bodies = specs.map((sp) => isNested(sp) ? childSteps(sp.nested, s.params) : null);
  // Probe inlineability independent of the concrete value; a non-inline body → use the generic gate.
  if (bodies.some((b) => b && tryInlineScalarPredicate(b, value(0), s.params) === null)) return null;
  return {
    seed: (combine) => gateScalar(s, (v, vt) =>
      combine(specs.map((sp, i) => 'p' in sp
        ? predicateSql(v, sp.p, vt ? TYPE_PER_ROW(vt) : TYPE_UNKNOWN)
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
  const sPerRow = perRowColumnOf(s.type);
  const vt = sPerRow ? d.c[sPerRow] : undefined;
  const bools: Expression[] = [];
  for (const sp of specs) {
    if ('p' in sp) { bools.push(predicateSql(d.c.v, sp.p, vt ? TYPE_PER_ROW(vt) : TYPE_UNKNOWN)); continue; }
    const child = tryCompileScalarValueRows(pushed, sp.nested, reuseCurrentFrame(scope, frame));
    if (!child) return null;
    const c = child.stream.rel.as('c');
    bools.push(q`EXISTS (SELECT 1 FROM ${c} WHERE ${c.c[frame.ordinal]}=${d.c[frame.ordinal]})`);
  }
  // encounter now rides in carried (layoutProjection), so it's NOT listed in the payload — the
  // transient pushed frame's ordinal is dropped; the parent's carried (incl. its encounter)
  // is restored verbatim from the domain.
  const payloadCols = ['v', ...(s.result === 'number' ? ['vt'] : []), ...perRowCols(s.type)];
  return {
    seed: (combine) => {
      const proj = payloadCols.map((col) => q`${d.c[col]} AS ${col}`);
      const rel = s.q.cte(
        q`SELECT ${list(proj, ', ')}${layoutProjection(s.traverserLayout, d)} FROM ${d} WHERE ${combine(bools)}`,
        [...payloadCols, ...layoutCols(s.traverserLayout)],
      );
      return rebuildScalar(s, rel);
    },
  };
}

/** The scalarPredicateInlining fast path: inline a scalar predicate body as one WHERE over the
 *  value, vs the generic correlated child-existence gate. appliesWhen is the flag; tryLower runs
 *  inlineScalarGate (null when the body is beyond the inline vocabulary → generic fallback). Both
 *  scalar-parent predicate sites (buildScalarGate here, filterScalar in scalar.ts) share it. */
export const ScalarPredicateInliningFastPath: FastPath<[ScalarStream, readonly ScalarGateSpec[]], ScalarGate> = {
  name: 'scalarPredicateInlining',
  equivalentWhen: 'test/L5-properties/differential.test.ts — the fast-path differential (this switch off vs. on, over the L1 corpus + generated traversals)',
  appliesWhen: (ctx) => ctx.enabled.scalarPredicateInlining,
  tryLower: (_ctx, s, specs) => inlineScalarGate(s, specs),
};

/** Pick the inline fast path unless scalarPredicateInlining is off, or a traversal predicate is
 *  beyond the inline vocabulary; then use the generic child-existence gate. Result-equivalent. */
function buildScalarGate(s: ScalarStream, specs: readonly ScalarGateSpec[]): ScalarGate | null {
  return runFastPath(ScalarPredicateInliningFastPath, fastPathContextOf(s), s, specs)
    ?? genericScalarGate(s, specs);
}

/** choose(pred, then[, else]) over a scalar. The predicate is a P (applied to `v` via
 *  predicateSql) or a nested traversal (buildScalarGate: inline over `v`, or a correlated
 *  EXISTS when the switch is off / the body is beyond the inline vocabulary). It gates the
 *  value rows into disjoint then/else seeds, each arm lowers over its seed, and the two merge
 *  with UNION ALL. else absent → the value passes through unchanged (identity). */
export function tryScalarChooseChild(s: ScalarStream, step: IRStep): ScalarStream | null {
  if (step.optionArms) return null; // option-map form is a later stage (modulator consumer)
  const args = step.args ?? [];
  const nested = args.filter(isNested);
  const predIsTraversal = isNested(args[0]);
  const [thenArg, elseArg] = predIsTraversal ? nested.slice(1) : nested;
  if (!thenArg) return null;
  // Classify-then-emit: prove both arms lower (value, reducer, or nested-branch) BEFORE the
  // gate appends its CTEs, so a deferring arm never orphans gate SQL (mirrors branch.ts).
  const thenBody = childSteps(thenArg.nested, s.params);
  if (!scalarArmClassifies(thenBody, s.params)) return null;
  const elseBody = elseArg ? childSteps(elseArg.nested, s.params) : null;
  if (elseBody && !scalarArmClassifies(elseBody, s.params)) return null;

  // Freeze the input's emission order for the merge to lead with (traverser-major, arm-minor —
  // see enterBranch). After the classify gate above, so a declining arm never orphans its CTE.
  const { seed: forked } = enterBranch(s, 'choose', elseBody ? [thenBody, elseBody] : [thenBody]);
  const gate = buildScalarGate(forked, [predIsTraversal ? { nested: args[0].nested } : { p: args[0] }]);
  if (!gate) return null;
  // A collapsing arm reduces over the traversers ROUTED TO IT, not over the branch's whole input:
  // `hasBarrier` changes how many starts `ChooseStep` injects, not which option each start picks.
  // So the batched lowering runs over the GATED seed — the same relation, one arm's share of it.
  const thenSeed = gate.seed((b) => b[0]);
  const thenEnd = tryCompileBatchedScalarArm(thenSeed, thenArg.nested) ?? tryCompileScalarArm(thenSeed, thenArg.nested);
  if (!thenEnd) return null;
  const elseSeed = gate.seed((b) => q`NOT COALESCE((${b[0]}), 0)`);
  const elseEnd = elseArg
    ? (tryCompileBatchedScalarArm(elseSeed, elseArg.nested) ?? tryCompileScalarArm(elseSeed, elseArg.nested))
    : elseSeed; // no else → identity value
  if (!elseEnd) return null;
  return unionScalarStreams(s, [thenEnd, elseEnd]);
}

/** union(a, b, …) over a scalar: every arm consumes the whole value stream; UNION ALL
 *  concatenates their productive rows (multiset-faithful, so a value can appear per arm). */
export function tryScalarUnionChild(s: ScalarStream, step: IRStep): ScalarStream | null {
  const branches = (step.args ?? []).filter(isNested);
  if (branches.length < 2) return null;
  const { seed } = enterBranch(s, 'union', branches.map((b: any) => childSteps(b.nested, s.params)));
  const arms: ScalarStream[] = [];
  for (const b of branches) {
    const end = tryCompileBatchedScalarArm(seed, b.nested) ?? tryCompileScalarArm(seed, b.nested);
    if (!end) return null;
    arms.push(end);
  }
  return unionScalarStreams(s, arms);
}

/**
 * A COLLAPSING arm of a BATCHING branch, lowered over the branch's whole input.
 *
 * `BranchStep.standardAlgorithm` injects every start at once when any option contains a `Barrier`
 * (`hasBarrier`), so `values('age').union(__.min(), __.max())` reduces each arm over the WHOLE
 * scalar stream and yields `[27, 35]`. Routing that arm through `tryCompileScalarArm` instead
 * pushes a child scope and reduces per value, which returned all four ages twice — a wrong
 * cardinality, not a wrong order (docs/2026-08-01-branch-arm-barrier-scope-plan.md T1).
 *
 * It needs no new substrate and that is the point: the arm is lowered by the ORDINARY engine over
 * the parent stream, exactly as the same steps would lower as a main-chain suffix. `lowerSteps`'
 * scalar tail already routes a bare reducer to `lowerGlobalNumericReducer`/`lowerGlobalCount`,
 * which are already total over a `ScalarStream` and already consult `cardinalityOf`. This is the
 * "cannot be HANDED this" case from `steps/CLAUDE.md`, not the "cannot EXPRESS this" case.
 *
 * Declines (rather than defers) on three fronts, each leaving today's answer in place:
 *  - a carried `path`/`sack`/`fromV`/origin, because a collapsed arm has no honest value for those
 *    roles (`collapsedArmAdmissible`) — and a decline has to happen before any CTE is appended;
 *  - a prefix outside the root-scope scalar-arm vocabulary, so the recognizer never accepts a body
 *    the engine would throw partway through;
 *  - a body that does not stay scalar, which is T2's mixed-shape ground.
 */
function tryCompileBatchedScalarArm(parent: ScalarStream, nested: any): ScalarStream | null {
  if (!collapsedArmAdmissible(parent.traverserLayout)) return null;
  const body = childSteps(nested, parent.params);
  if (!armBatches(body) || !scalarArmClassifies(body, parent.params)) return null;
  const end = engineOf(parent).lowerStepsStrict(parent, body, 0);
  return end.kind === 'scalar' ? gateArmOnNonEmptyInput(end, parent.rel) : null;
}

/** coalesce(a, b, …) over a scalar: the first arm that PRODUCES a value, per input row. Arm k is
 *  gated by "still unclaimed by every earlier arm AND this arm produces"; productivity is each
 *  arm body's gate boolean (buildScalarGate — inline over `v`, or a correlated EXISTS when the
 *  switch is off / the body is beyond the inline vocabulary). All arms share ONE gate/scope. */
export function tryScalarCoalesceChild(s: ScalarStream, step: IRStep): ScalarStream | null {
  const branches = (step.args ?? []).filter(isNested);
  if (branches.length < 1) return null;
  const bodies = branches.map((b: any) => childSteps(b.nested, s.params));
  // Classify-then-emit: every arm must lower before the shared gate commits its CTEs.
  if (bodies.some((body: IRStep[]) => !scalarArmClassifies(body, s.params))) return null;
  const { seed: forked } = enterBranch(s, 'coalesce', bodies);
  const gate = buildScalarGate(forked, branches.map((b: any) => ({ nested: b.nested })));
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
// `vk` tag (1 scalar / 2 node / 3 edge / 4 list). The merge builders (mergeVariantArms/
// mergeVariantParts/variantArmsMeta, variant.ts) are parent-agnostic (LoweringState-typed) so this reuses
// them verbatim — including the arm-merge encounter mint; only the per-arm compiler differs (a
// scalar re-sources rather than walks).

/** An element arm over a scalar: a re-source (`V()`/`E()`) then element movement/filter,
 *  ending in element space. No gating (union), so it lowers over the parent value rows
 *  directly — lowerReSource CROSS JOINs the graph per value, movement folds on top. */
function tryScalarResourceElement(seed: ScalarStream, nested: any): ElementStream | null {
  const body = childSteps(nested, seed.params);
  if (!isResourceHead(body)) return null;
  const after = body.slice(1);
  if (!after.every((s) => ELEMENT_CHILD_STEPS.has(s.name))) return null;
  return resourceElement(seed, body[0], after);
}

/** PURE. A fold list arm over a scalar: a value-op body OR a re-source projection, then
 *  fold(). The classify twin of tryCompileListChild's scalar path. */
function scalarListArm(body: IRStep[]): boolean {
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
 *  unclassifiable → the caller defers.
 *
 *  The scalar twin of `classifyArmShape` (child-shape.ts), and deliberately NOT a call to it:
 *  over a scalar parent there is no adjacency, so "element arm" means a `V()`/`E()` RE-SOURCE
 *  (isResourceHead) rather than a movement body, and the priority differs too (list is probed
 *  FIRST here — a `…fold()` body would otherwise be claimed by the scalar classifier). Same
 *  return type on purpose, so the two are visibly parallel and a reader can see the difference is
 *  the predicates, not the protocol. */
function scalarArmShape(nested: any, params: Record<string, any>): BranchArmShape {
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
  if (scalar) return { rel: scalar.rel, vk: 1, as: staticTypeOf(scalar.type) };
  const listArm = tryCompileListChild(seed, nested);
  if (listArm) return { rel: listArm.rel, vk: 4, listOf: listArm.of };
  const el = tryScalarResourceElement(seed, nested);
  if (el) return { rel: el.rel, vk: el.elem === 'edge' ? 3 : 2 };
  throw new Error('scalar variant arm classified but did not compile (internal contradiction)');
}

/** union(a, b, …) over a scalar with MIXED-shape arms → a VariantStream (plain UNION ALL, no
 *  gating). Declines (null) when the arms are homogeneous (tryScalarUnionChild owns those) or
 *  any arm is unclassifiable, or under carried path/sack/fromV (fork/merge unworked). */
export function tryScalarVariantUnion(s: ScalarStream, step: IRStep): VariantStream | null {
  if (s.traverserLayout.path || s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const branches = (step.args ?? []).filter(isNested);
  if (branches.length < 2) return null;
  const shapes = branches.map((b: any) => scalarArmShape(b.nested, s.params));
  if (shapes.some((x) => x === null) || shapes.every((x) => x === shapes[0])) return null;
  const arms = branches.map((b: any) => compileScalarVariantArm(s, b.nested));
  return mergeVariantArms(s, arms, variantArmsMeta(arms));
}

/** choose(pred, then, else) over a scalar with MIXED-shape then/else → a VariantStream. The
 *  gate partitions the value rows (pred / NOT pred) into disjoint then/else seeds — exactly
 *  tryScalarChooseChild's gate — and each arm compiles to its natural variant shape over its
 *  seed. Declines when the arms are the same shape (tryScalarChooseChild owns those), the 2-arg
 *  identity-else form, or any arm is unclassifiable. */
export function tryScalarVariantChoose(s: ScalarStream, step: IRStep): VariantStream | null {
  if (step.optionArms) return null; // option-map form is the modulation seam
  if (s.traverserLayout.path || s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const args = step.args ?? [];
  const nested = args.filter(isNested);
  const predIsTraversal = isNested(args[0]);
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
  return mergeVariantArms(s, arms, variantArmsMeta(arms));
}

/** coalesce(a, b, …) over a scalar with MIXED-shape arms → a VariantStream. One pushed
 *  ordinal-tagged seed feeds every arm (compiled to its natural variant shape); arm k emits
 *  only for inputs no earlier arm produced a row for (`ord NOT IN prior`) — the first-productive
 *  rule, exactly branch.ts's tryLowerVariantCoalesce, over a scalar seed. Declines for
 *  homogeneous arms (tryScalarCoalesceChild owns those) or an unclassifiable arm. */
export function tryScalarVariantCoalesce(s: ScalarStream, step: IRStep): VariantStream | null {
  if (s.traverserLayout.path || s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const branches = (step.args ?? []).filter(isNested);
  if (!branches.length) return null;
  const shapes = branches.map((b: any) => scalarArmShape(b.nested, s.params));
  if (shapes.some((x) => x === null) || shapes.every((x) => x === shapes[0])) return null;
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arms = branches.map((b: any) => compileScalarVariantArm(seed, b.nested));
  return mergeVariantArms(s, arms, variantArmsMeta(arms), (a, k) => k === 0 ? undefined
    : list(arms.slice(0, k).map((pr) => q`${a.c[ord]} NOT IN (SELECT ${ord} FROM ${pr.rel})`), ' AND '));
}

/** optional(t) over a scalar with a SCALAR arm ≡ coalesce(t, identity): the arm's value where
 *  it produces, else the input value restored (a filter arm that drops a value → the original
 *  passes through). Homogeneous → a scalar stream; an element/list arm takes the variant path. */
export function tryScalarOptionalChild(s: ScalarStream, step: IRStep): ScalarStream | null {
  if (s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const arg = step.args?.[0];
  if (!isNested(arg)) return null;
  if (!scalarArmClassifies(childSteps(arg.nested, s.params), s.params)) return null;
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arm = tryCompileScalarArm(seed, arg.nested);
  if (!arm) return null;
  const numeric = arm.result === 'number';
  const cols = ['v', ...(numeric ? ['vt'] : []), ...layoutCols(s.traverserLayout)];
  const a = arm.rel.as('a');
  const d = frame.domain.as('d');
  const am = arm.rel.as('am');
  const hit = q`SELECT ${a.c.v} AS v${numeric ? q`, ${a.c.vt} AS vt` : empty}${layoutProjection(s.traverserLayout, a)} FROM ${a}`;
  const miss = q`SELECT ${d.c.v} AS v${numeric ? q`, NULL AS vt` : empty}${layoutProjection(s.traverserLayout, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${am} WHERE ${am.c[ord]}=${d.c[ord]})`;
  const rel = s.q.cte(list([hit, miss], ' UNION ALL '), cols);
  // The merged projection is (v[, vt]) + carried — no vtype column — and the miss arm's
  // values come from the parent anyway, so a per-row arm type cannot survive: degrade to
  // `unknown` (inferred at the wire) rather than claim a column the relation lacks.
  const merged = arm.type.kind === 'perRow' ? UNKNOWN : arm.type;
  return toScalarStream(loweringStateOf(s), rel, undefined, { type: merged, result: numeric ? 'number' : 'value' });
}

/** optional(t) over a scalar with an ELEMENT/LIST arm → a VariantStream: the arm's rows where it
 *  produces (vk 2/3/4), else the input VALUE restored (vk 1). The scalar twin of branch.ts's
 *  tryLowerVariantOptional (flipped: there the miss is an element, here the miss is the value). */
export function tryScalarVariantOptional(s: ScalarStream, step: IRStep): VariantStream | null {
  if (s.traverserLayout.path || s.traverserLayout.sack || s.traverserLayout.fromV) return null;
  const arg = step.args?.[0];
  if (!isNested(arg)) return null;
  const shape = scalarArmShape(arg.nested, s.params);
  if (shape === null || shape === 'scalar') return null; // scalar arm → tryScalarOptionalChild
  const { frame, seed } = pushChildScope(s);
  const ord = frame.ordinal;
  const arm = compileScalarVariantArm(seed, arg.nested);
  const hasList = arm.vk === 4;
  const meta = { ...variantArmsMeta([arm]), scalarAs: staticTypeOf(s.type) };
  const d = frame.domain.as('d');
  const am = arm.rel.as('am');
  const listNull = hasList ? q`, NULL AS list` : empty;
  // Two ragged arms: the HIT (the arm's own rows) and the MISS (the input value restored from
  // the pushed domain). When emission order is live both must carry the arm tags so
  // mergeVariantParts can re-mint the canonical encounter — hit before miss, matching
  // coalesce(t, identity), which is what optional() IS.
  const enc = s.traverserLayout.encounter;
  const baseNoEnc = enc ? patchLayout(s.traverserLayout, { encounter: null }) : s.traverserLayout;
  const armTag = (k: number, r: typeof d) => enc ? q`, ${k} AS arm_idx, ${r.c[enc]} AS arm_encounter` : empty;
  const a = arm.rel.as('a');
  const hitCols: Expression[] = [
    q`${arm.vk} AS vk`,
    q`${arm.vk === 1 ? a.c.v : q`NULL`} AS v`,
    q`${arm.vk === 2 || arm.vk === 3 ? a.c.id : q`NULL`} AS rid`,
  ];
  if (hasList) hitCols.push(q`${arm.vk === 4 ? a.c.list : q`NULL`} AS list`);
  const hit = q`SELECT ${list(hitCols, ', ')}${armTag(0, a)}${layoutProjection(baseNoEnc, a)} FROM ${a}`;
  const miss = q`SELECT 1 AS vk, ${d.c.v} AS v, NULL AS rid${listNull}${armTag(1, d)}${layoutProjection(baseNoEnc, d)} FROM ${d} WHERE NOT EXISTS (SELECT 1 FROM ${am} WHERE ${am.c[ord]}=${d.c[ord]})`;
  return mergeVariantParts(s, [hit, miss], meta);
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
export function tryScalarFilterByChildExistence(s: ScalarStream, step: IRStep): ScalarStream | null {
  const nested = (step.args ?? []).filter(isNested);
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
  // encounter rides in carried (layoutProjection), so it is NOT listed in the payload.
  const payloadCols = ['v', ...(s.result === 'number' ? ['vt'] : []), ...perRowCols(s.type)];
  const proj = payloadCols.map((col) => q`${d.c[col]} AS ${col}`);
  const rel = s.q.cte(
    q`SELECT ${list(proj, ', ')}${layoutProjection(s.traverserLayout, d)} FROM ${d} WHERE ${cond}`,
    [...payloadCols, ...layoutCols(s.traverserLayout)],
  );
  return rebuildScalar(s, rel);
}
