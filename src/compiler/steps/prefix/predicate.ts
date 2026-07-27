import { q, list, paren, value, raw, type Expression } from '../../../sql/kernel/q.ts';
import { isNested, stepChain, type Step } from '../../../gremlin/frontend.ts';
import { edgeProperties } from '../../../sql/schema.ts';
import {
  predicateSql, labelIn, hasProp, idPredFromArgs, labelNameSub, aliasCtx,
  type ScalarCtx,
} from '../../plan/plan.ts';
import { compileCorrelatedChild } from '../tail/correlated.ts';
import { resolveTraversalOperands } from '../tail/operand.ts';
import { labelCtx, labelIsBound, type LabelScope } from '../context/context.ts';
import type { Engine } from '../../engine/deps.ts';
import type { FastPath } from '../../options/fast-paths.ts';

// ---------- where()/not()/filter(__.…) → a boolean filter predicate ----------
//
// The correlated predicate fast path. A where()/filter()/and()/or()/choose()/until()
// nested traversal compiles to a boolean SQL predicate correlated on the current
// traverser. The CURRENT-ELEMENT leaves (has/hasLabel/hasId/label/values, the boolean
// combinators) build directly from the ScalarCtx + the bind-safe leaf builders in
// plan.ts; a MOVEMENT chain (out/in/both/…E) or a count/aggregate REDUCTION renders
// through compileCorrelatedChild — the GENERIC movement/filter StepFns lowered in
// inline-correlated mode (correlated.ts). So there is no second, hand-rolled movement /
// alias / EXISTS scheme: the fast middle and the CTE movement forms are the same StepFns.
//
// This module lives in the steps/ layer (not plan.ts) precisely so the movement branch
// can reach lowerElementSteps via compileCorrelatedChild — plan.ts, the SQL-node layer
// below steps/, cannot. filter.ts / branch.ts already call this from steps/.
//
// It is an index-only fast path (no domain materialization or ROW_NUMBER window, unlike
// the generic child-existence gate — see the EXPLAIN comparison in test/compiler.test.ts).
// where()/filter()/choose() fall through to that gate when this declines; until()'s
// recursive-CTE predicate has NO generic equivalent (a CTE cannot reference the recursive
// term's outer row) and correlates through compileCorrelatedChild directly.
//
// Supported:
//   __.<move>.count().is(P)   → correlated COUNT compared
//   __.values(k)[.is(P)]      → current-property predicate (bare → IS NOT NULL)
//   __.has(k[,v]) / hasLabel  → current-element predicate
//   __.<move>([label])[.terminal] → EXISTS over the correlated movement child
//   __.and(t…) / __.or(t…)    → the branch predicates combined with AND / OR
//   __.as(l) / __.select(l)   → a whole-body label leaf (bind / bound-test)
// Unsupported shapes throw a "not yet supported" deferral (tryInlinePredicate returns
// null) so a caller falls back to generic child-existence lowering; never mis-executes.
//
// LABELS. Every path-history label form rides ONE input: the `LabelScope` a call site passes
// (the outer alias map + the relation holding the histories there). From it this module derives
// the leading-as()/select() re-root, the whole-body label leaf below, and — by handing the scope
// straight to compileCorrelatedChild — the alias columns a correlated movement child seeds, which
// is what makes a label compose at any DEPTH inside a predicate body. A site with no such
// relation in scope (until()/emit(), on a recursive term's walk row) passes nothing and every
// label form there keeps failing closed.

/** Vertex→edge/neighbour movement steps that seed a correlated movement child. */
const MOVES = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);

/** SQL aggregate for a terminal reducer over a correlated stream. */
const AGG_FN: Record<string, string> = { count: 'COUNT', sum: 'SUM', min: 'MIN', max: 'MAX', mean: 'AVG' };

/**
 * A movement reduction seeded from `ctx.idExpr`: `<move-chain>.count()` →
 * `(SELECT COUNT(*) FROM <correlated movement child>)`, or (E-forms only)
 * `<moveE>.values(k).<sum|min|max|mean>()` → a correlated edge-property aggregate. The
 * movement is compiled by the real StepFns (compileCorrelatedChild), so this is not a
 * second hand-rolled aggregate over the edge tables. COUNT over the movement child is
 * multiset-faithful (a both() self-loop counts twice, matching movement semantics) and
 * equivalent to the generic reducer gate. Returns null for shapes it can't render
 * (non-node ctx, an unrenderable movement) so the caller falls through to the generic
 * reducer child.
 */
export function correlatedReduce(engine: Engine, body: Step[], ctx: ScalarCtx, params: Record<string, any>, labels?: LabelScope): Expression | null {
  if (ctx.elem !== 'node') return null; // movement reduces from a vertex
  const mv = body[0];
  if (!mv || !MOVES.has(mv.name)) return null;

  // <movement chain>.count(): COUNT(*) over the correlated movement child.
  if (body.at(-1)?.name === 'count' && body.at(-1)!.args.length === 0 && body.length >= 2) {
    const child = compileCorrelatedChild(engine, ctx.idExpr, body.slice(0, -1), params, labels);
    if (!child) return null;
    return q`(SELECT COUNT(*) FROM ${child.rel.as('c')})`;
  }

  // …values(k).<reducer>() aggregates an edge property. E-forms only: on a bare
  // out()/in()/both() the value would come from the NEIGHBOUR vertex (a join),
  // a separate, unimplemented shape.
  if (mv.name.endsWith('E') && body[1]?.name === 'values' && body.length === 3
      && body[2].name in AGG_FN && body[2].name !== 'count') {
    const child = compileCorrelatedChild(engine, ctx.idExpr, [mv], params, labels);
    if (!child) return null;
    const c = child.rel.as('c');
    const ep = edgeProperties.as('xep');
    return q`(SELECT ${raw(AGG_FN[body[2].name])}(${ep.c.value}) FROM ${ep} JOIN ${c} ON ${ep.c.edge}=${c.c.id} WHERE ${ep.c.key}=${value(body[1].args[0])})`;
  }
  return null;
}

/**
 * A movement chain (+ an optional current-element terminal filter) rendered as a
 * correlated EXISTS over the nested-derived movement child (compileCorrelatedChild),
 * seeded from `fromId`. has()/hasLabel() terminals are current-element filters the child
 * fold consumes itself (so they need no special-casing); a trailing values(k)[.is(P)] is
 * a property-existence on the REACHED element (values() is a projection, so the child
 * stops before it — the property is tested via an aliasCtx over the child's leaf id).
 * Returns null for shapes compileCorrelatedChild can't lower / a stray trailing is().
 */
function correlatedExists(engine: Engine, body: Step[], fromId: Expression, isPred: any, hasIs: boolean, params: Record<string, any>, labels?: LabelScope): Expression | null {
  let prefix = body;
  let valuesKey: string | undefined;
  if (body.at(-1)?.name === 'values') {
    const v = body.at(-1)!;
    if (typeof v.args[0] !== 'string') return null;
    valuesKey = v.args[0];
    prefix = body.slice(0, -1);
  } else if (hasIs) {
    // a trailing is() on a movement terminal that isn't values/count/sum — unsupported.
    return null;
  }
  const child = compileCorrelatedChild(engine, fromId, prefix, params, labels);
  if (!child) return null;
  const c = child.rel.as('c');
  if (valuesKey === undefined) return q`EXISTS(SELECT 1 FROM ${c})`;
  return q`EXISTS(SELECT 1 FROM ${c} WHERE ${hasProp(aliasCtx(c.c.id, child.elem), valuesKey, hasIs ? isPred : undefined)})`;
}

/** The predicateInlining fast path. Its recognizer VARIES by call site — where()/filter()/until()/
 *  emit()/choose() inline via tryInlinePredicate, and()/or() via combineBranchPreds — so tryLower
 *  takes the site's recognizer as a thunk and the FastPath contributes the uniform flag gate + the
 *  contract declaration. appliesWhen is the flag alone; the shape recognition stays inside each
 *  thunk (a two-stage recognizer that returns null when the body is beyond inline lowering, so a
 *  consumer falls back to the generic child-existence gate — the semantic authority).
 *
 *  NB two of the five call sites do NOT gate on the flag, by design: choose()'s predicate DOES gate
 *  (it has a generic fallback, tryGateByChildExistence); until()/emit() do NOT (a recursive-CTE term
 *  can't correlate to its outer row, so there is no generic fallback — disabling inlining there
 *  would have nothing to fall back to). Those two sites call tryInlinePredicate directly rather than
 *  through this FastPath's appliesWhen — see branch.ts walkPredicate. */
export const PredicateInliningFastPath: FastPath<[() => Expression | null], Expression> = {
  name: 'predicateInlining',
  equivalentWhen: 'every disable-safe fast path is result-equivalent to generic lowering',
  appliesWhen: (ctx) => ctx.enabled.predicateInlining,
  tryLower: (_ctx, recognize) => recognize(),
};

/** "This fast path does not recognize the body" — the DECLINE signal, as a type rather than a
 *  message prefix. The FastPath contract (options/fast-paths.ts) is explicit that recognition
 *  failure is ALWAYS null and never a throw; the recognizer is recursive, so it needs to unwind,
 *  and it used to do that by throwing a message `tryInlinePredicate` then sniffed for
 *  (`includes('not yet supported')` AND `startsWith('where'|'filter')`). That sniff was a support
 *  boundary defined by string shape: `empty where()/filter() traversal` matched neither clause, so
 *  `g.V().filter(__.is(0))` escaped as a hard error instead of reaching the generic gate. A marker
 *  class states the intent instead, and each site below now says which of the two it means. */
class InlineDecline extends Error {}

/** Unwind the recursive recognizer with "not recognized" — `tryInlinePredicate` turns this into
 *  `null` so the caller falls through to the generic path (the semantic authority). `msg` is for
 *  debugging only; no consumer reads it, because the caller's own deferral names the real gap. */
const decline: (msg: string) => never = (msg) => { throw new InlineDecline(msg); };

/** Optional correlated predicate optimization. Unsupported shapes return null so an
 * element consumer can fall back to generic child-existence lowering. A genuine ILLEGALITY
 * (movement off an edge, a malformed connective) is a real Error and still propagates — that
 * distinction is the whole point of the marker class. */
export function tryInlinePredicate(
  engine: Engine, nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  labels?: LabelScope,
): Expression | null {
  try { return compileInlinePredicate(engine, nested, ctx, params, labels); }
  catch (error) {
    if (error instanceof InlineDecline) return null;
    throw error;
  }
}

function compileInlinePredicate(
  engine: Engine, nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  labels?: LabelScope,
): Expression {
  const h0 = nested[0];
  const soleLabel = h0 && h0.args.length === 1 && typeof h0.args[0] === 'string' ? h0.args[0] : null;
  // A body that is ONLY a label step is a predicate LEAF, not a re-root — there is no
  // continuation to re-root onto. select('x') yields the label's contents — one object when
  // bound, nothing when not — so as a filter it is exactly "is x bound", which is also
  // TinkerPop's drop-never-error rule for an unbound label. (A whole-body as('x') is NOT the
  // mirror of this: it is a label on the last step, caught by the end-label rule below.)
  if (soleLabel !== null && nested.length === 1 && h0.name === 'select' && labels)
    return labelIsBound(labels, soleLabel);
  // A LABEL ON THE LAST STEP is not a bind. TinkerPop routes where(traversal) by variable
  // location (GraphTraversal.where → TraversalHelper.getVariableLocations): a label on the FIRST
  // step is a WhereStartStep (the re-root below), one on the LAST step is a WhereEndStep — an
  // EQUALITY CONSTRAINT that the object reached must be the one the label already holds, not a
  // rebind. `where(__.as("a").out("knows").as("b"))` therefore means "a knows b", and compiling
  // its trailing as() as an (inert, filter-confined) bind would answer the much weaker "a knows
  // somebody". We do not implement the end constraint, so defer and let the generic gate keep the
  // body — never inline a different question. A label in the MIDDLE of the body has neither
  // location and IS an ordinary confined bind, which the correlated child renders inline.
  const hLast = nested[nested.length - 1];
  if (hLast.name === 'as' && (hLast.args ?? []).some((a: any) => typeof a === 'string'))
    decline('a trailing as(label) is an end-label constraint (WhereEndStep), not a bind');
  // A leading as('x')/select('x') re-roots the predicate on the aliased traverser:
  // where(__.as('b').out('created').has('name','ripple')) correlates on b's column.
  if (labels && soleLabel !== null && nested.length > 1 && (h0.name === 'as' || h0.name === 'select'))
    return compileInlinePredicate(engine, nested.slice(1), labelCtx(labels, soleLabel), params, labels);

  // NB there is no infix `.and()`/`.or()` handling here any more. That fold is
  // ConnectiveStrategy (a `fold` Pass, ir/strategies.ts foldConnectives), so by the time a body
  // reaches this fast path the connectives are already the step form handled below — which is
  // what makes this path genuinely disable-safe. It lived here until 2026-07-27, where it was
  // reachable only in a child body and only while `predicateInlining` was on.

  let body = nested;
  let isPred: any = undefined, hasIs = false;
  if (body[body.length - 1]?.name === 'is') { isPred = body[body.length - 1].args[0]; hasIs = true; body = body.slice(0, -1); }
  // A traversal OPERAND resolves to an Expression before any of the branches below render it —
  // the same resolver the has()/is() StepFns use, reached here through the engine+params bag
  // rather than a Stream (this compiler never sees one). `ctx` is the current element, so the
  // correlated form is available too. Anything it cannot resolve is left alone and the render
  // reports the clear deferral.
  const deps = { engine, params };
  if (hasIs) isPred = resolveTraversalOperands(isPred, deps, { ctx, labels });

  const head = body[0]?.name;
  if (!head) decline('empty where()/filter() traversal');

  // and(t…)/or(t…) step-form: combine each branch's predicate. (The infix connector
  // form .and()/.or() was already split above by splitInfixConnectors.)
  if ((head === 'and' || head === 'or') && body.length === 1) {
    const combined = combineBranchPreds(engine, body[0], ctx, params, head === 'and' ? 'AND' : 'OR', labels);
    if (!combined) decline(`connective branch beyond inline lowering: __.${body.map((s) => s.name + '()').join('.')}`);
    return combined;
  }

  const term = body[body.length - 1]?.name;

  // A reducing scalar (count/sum) compared by is(P). Bare (no is) always yields one value
  // → the traverser always passes, so it's a no-op filter. The compared form is an
  // index-only fast path: correlatedReduce renders the reduction as a correlated subquery
  // (no materialized child). A shape it can't render returns null → the caller falls
  // through to the generic reducer child (childExistenceGate over <move>.count().is),
  // which is result-equivalent.
  if (term === 'count' || term === 'sum') {
    if (!hasIs) return q`1`;
    const reduced = correlatedReduce(engine, body, ctx, params, labels);
    if (!reduced) decline(`reduction beyond inline lowering: __.${body.map((s) => s.name + '()').join('.')}`);
    return predicateSql(reduced, isPred);
  }

  // Current-element predicates (no movement). ANY-match EXISTS over the element's
  // normalized properties table — vertex_properties / edge_properties (hasProp dispatches).
  if (head === 'values' && body.length === 1) {
    // bare where(__.values(k)) → the key exists at all; .is(P) → any value matches P.
    return hasProp(ctx, body[0].args[0], hasIs ? isPred : undefined);
  }
  if (head === 'has' && body.length === 1) {
    const [key, val] = body[0].args;
    // has(T.label|T.id, v|P): predicate over the label name / external id (mirrors
    // filter.ts has()'s token branch, so choose(__.has(T.label,'person')) etc work).
    if (key && typeof key === 'object' && 'token' in key) {
      const expr: Expression = key.token === 'label' ? labelNameSub(ctx.labelIdExpr)
        : key.token === 'id' ? ctx.extIdExpr!
        : decline(`has(T.${key.token}) has no inline form`);
      return predicateSql(expr, val);
    }
    if (typeof key === 'string') {
      return hasProp(ctx, key, resolveTraversalOperands(val, deps, { ctx, labels }));
    }
  }
  if (head === 'hasLabel' && body.length === 1)
    return labelIn(ctx.labelIdExpr, body[0].args);
  if (head === 'hasId' && body.length === 1)
    return predicateSql(ctx.extIdExpr!, idPredFromArgs(body[0].args));

  // where(__.label()[.is(P)]) — predicate on the current element's label name.
  if (head === 'label' && body.length === 1)
    return predicateSql(labelNameSub(ctx.labelIdExpr), hasIs ? isPred : undefined);

  // until(__.loops().is(P)) — the repeat-loop counter compared. loops() is only
  // meaningful inside an until() predicate (ctx.loopsExpr = the walk depth); elsewhere
  // it defers. It composes with element predicates through the infix/and/or split above,
  // so until(__.has('name','x').or().loops().is(3)) lowers as one boolean.
  if (head === 'loops' && body.length === 1) {
    if (body[0].args.length) decline('loops(label) named-loop form');
    if (!ctx.loopsExpr || !hasIs) decline('__.loops() requires until() context and .is(P)');
    return predicateSql(ctx.loopsExpr, isPred);
  }

  // where(__.not(t)) — negate an inner predicate; a NULL (missing) is kept (NOT COALESCE).
  if (head === 'not' && body.length === 1) {
    const arg = body[0].args.find(isNested);
    if (!arg) decline('not() without a traversal arg');
    const inner = compileInlinePredicate(engine, stepChain(arg.nested, params), ctx, params, labels);
    return q`NOT COALESCE((${inner}), 0)`;
  }

  if (MOVES.has(head)) {
    // A movement chain → a correlated EXISTS over the path. Movement is only valid on a
    // vertex; on an edge the outer traverser can't out()/in() (a hard error, NOT a
    // fallthrough). count/sum terminals are handled above.
    if (ctx.elem !== 'node') throw new Error(`where(__.${head}()) expects a vertex, not an ${ctx.elem}`);
    const exists = correlatedExists(engine, body, ctx.idExpr, isPred, hasIs, params, labels);
    if (!exists) decline(`movement beyond inline lowering: __.${body.map((s) => s.name + '()').join('.')}`);
    return exists;
  }
  return decline(`no inline form for __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate node, joined by AND/OR
 *  (`((p0) AND (p1))`). Used both as a top-level filter step and inside where(__.and/or).
 *  Returns null when ANY branch is beyond the inline predicate compiler, so the caller
 *  can fall through to generic child-existence lowering (tryCombineByChildExistence). */
export function combineBranchPreds(
  engine: Engine, step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR',
  labels?: LabelScope,
): Expression | null {
  const branches = step.args.filter(isNested);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const parts: Expression[] = [];
  for (const b of branches) {
    const p = tryInlinePredicate(engine, stepChain(b.nested, params), ctx, params, labels);
    if (!p) return null;
    parts.push(paren(p));
  }
  return paren(list(parts, ` ${op} `));
}
