import { q, list, paren, value, raw, type Expression } from '../../../sql/kernel/q.ts';
import { isNested, stepChain, type Step } from '../../../gremlin/frontend.ts';
import { edgeProperties } from '../../../sql/schema.ts';
import {
  predicateSql, labelIn, hasProp, idPredFromArgs, labelNameSub, aliasCtx,
  type ScalarCtx,
} from '../../plan/plan.ts';
import { compileCorrelatedChild } from '../tail/correlated.ts';
import { resolveTraversalOperands } from '../tail/operand.ts';
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
// Unsupported shapes throw a "not yet supported" deferral (tryInlinePredicate returns
// null) so a caller falls back to generic child-existence lowering; never mis-executes.

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
export function correlatedReduce(engine: Engine, body: Step[], ctx: ScalarCtx, params: Record<string, any>): Expression | null {
  if (ctx.elem !== 'node') return null; // movement reduces from a vertex
  const mv = body[0];
  if (!mv || !MOVES.has(mv.name)) return null;

  // <movement chain>.count(): COUNT(*) over the correlated movement child.
  if (body.at(-1)?.name === 'count' && body.at(-1)!.args.length === 0 && body.length >= 2) {
    const child = compileCorrelatedChild(engine, ctx.idExpr, body.slice(0, -1), params);
    if (!child) return null;
    return q`(SELECT COUNT(*) FROM ${child.rel.as('c')})`;
  }

  // …values(k).<reducer>() aggregates an edge property. E-forms only: on a bare
  // out()/in()/both() the value would come from the NEIGHBOUR vertex (a join),
  // a separate, unimplemented shape.
  if (mv.name.endsWith('E') && body[1]?.name === 'values' && body.length === 3
      && body[2].name in AGG_FN && body[2].name !== 'count') {
    const child = compileCorrelatedChild(engine, ctx.idExpr, [mv], params);
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
function correlatedExists(engine: Engine, body: Step[], fromId: Expression, isPred: any, hasIs: boolean, params: Record<string, any>): Expression | null {
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
  const child = compileCorrelatedChild(engine, fromId, prefix, params);
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

/** Optional correlated predicate optimization. Unsupported shapes return null so an
 * element consumer can fall back to generic child-existence lowering. */
export function tryInlinePredicate(
  engine: Engine, nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  resolveAlias?: (label: string) => ScalarCtx,
): Expression | null {
  try { return compileInlinePredicate(engine, nested, ctx, params, resolveAlias); }
  catch (error) {
    if (error instanceof Error
        && error.message.includes('not yet supported')
        && (error.message.startsWith('where') || error.message.startsWith('filter'))) return null;
    throw error;
  }
}

/** Split a predicate body on infix .and()/.or() connectors (zero-arg `and`/`or`
 *  steps). Returns the lower-precedence operator present (OR looser than AND) and the
 *  segments between its connectors; each segment is recompiled and may still contain
 *  higher-precedence connectors. Null when the body has no infix connector. */
function splitInfixConnectors(steps: Step[]): { op: 'AND' | 'OR'; segments: Step[][] } | null {
  const isConn = (s: Step, n: string) => s.name === n
    && !s.args.some(isNested);
  const op: 'AND' | 'OR' = steps.some((s) => isConn(s, 'or')) ? 'OR'
    : steps.some((s) => isConn(s, 'and')) ? 'AND' : (null as any);
  if (op === null) return null;
  const conn = op === 'OR' ? 'or' : 'and';
  const segments: Step[][] = [[]];
  for (const s of steps) {
    if (isConn(s, conn)) segments.push([]);
    else segments[segments.length - 1].push(s);
  }
  if (segments.some((seg) => seg.length === 0))
    throw new Error('malformed infix .and()/.or() connector (empty operand)');
  return { op, segments };
}

function compileInlinePredicate(
  engine: Engine, nested: Step[], ctx: ScalarCtx, params: Record<string, any> = {},
  resolveAlias?: (label: string) => ScalarCtx,
): Expression {
  // A leading as('x')/select('x') re-roots the predicate on the aliased traverser:
  // where(__.as('b').out('created').has('name','ripple')) correlates on b's column.
  const h0 = nested[0];
  if (resolveAlias && nested.length > 1 && (h0.name === 'as' || h0.name === 'select')
      && h0.args.length === 1 && typeof h0.args[0] === 'string')
    return compileInlinePredicate(engine, nested.slice(1), resolveAlias(h0.args[0]), params, resolveAlias);

  // Infix .and()/.or() connectors — zero-arg `and`/`or` steps splitting the body into
  // conjuncts/disjuncts (has('a').and().out('b'), values('x').is(P).or().values('y').is(Q)).
  // OR binds looser than AND, so split on OR first; each segment recurses (inner AND, or
  // a plain leaf). Distinct from the step-form and(t…)/or(t…) below, which carries nested
  // traversal args and is one step. Shared by where/filter/choose/until (all route here).
  const infix = splitInfixConnectors(nested);
  if (infix) {
    const parts = infix.segments.map((seg) => paren(compileInlinePredicate(engine, seg, ctx, params, resolveAlias)));
    return paren(list(parts, ` ${infix.op} `));
  }

  let body = nested;
  let isPred: any = undefined, hasIs = false;
  if (body[body.length - 1]?.name === 'is') { isPred = body[body.length - 1].args[0]; hasIs = true; body = body.slice(0, -1); }
  // A traversal OPERAND resolves to an Expression before any of the branches below render it —
  // the same resolver the has()/is() StepFns use, reached here through the engine+params bag
  // rather than a Stream (this compiler never sees one). `ctx` is the current element, so the
  // correlated form is available too. Anything it cannot resolve is left alone and the render
  // reports the clear deferral.
  const deps = { engine, params };
  if (hasIs) isPred = resolveTraversalOperands(isPred, deps, { ctx });

  const head = body[0]?.name;
  if (!head) throw new Error('empty where()/filter() traversal');

  // and(t…)/or(t…) step-form: combine each branch's predicate. (The infix connector
  // form .and()/.or() was already split above by splitInfixConnectors.)
  if ((head === 'and' || head === 'or') && body.length === 1) {
    const combined = combineBranchPreds(engine, body[0], ctx, params, head === 'and' ? 'AND' : 'OR', resolveAlias);
    if (!combined) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
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
    const reduced = correlatedReduce(engine, body, ctx, params);
    if (!reduced) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
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
        : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
      return predicateSql(expr, val);
    }
    if (typeof key === 'string') {
      return hasProp(ctx, key, resolveTraversalOperands(val, deps, { ctx }));
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
    if (body[0].args.length) throw new Error('where()/filter() form not yet supported: loops(label) named-loop form');
    if (!ctx.loopsExpr || !hasIs) throw new Error('where()/filter() form not yet supported: __.loops() requires until() context and .is(P)');
    return predicateSql(ctx.loopsExpr, isPred);
  }

  // where(__.not(t)) — negate an inner predicate; a NULL (missing) is kept (NOT COALESCE).
  if (head === 'not' && body.length === 1) {
    const arg = body[0].args.find(isNested);
    if (!arg) throw new Error('not() requires a traversal');
    const inner = compileInlinePredicate(engine, stepChain(arg.nested, params), ctx, params, resolveAlias);
    return q`NOT COALESCE((${inner}), 0)`;
  }

  if (MOVES.has(head)) {
    // A movement chain → a correlated EXISTS over the path. Movement is only valid on a
    // vertex; on an edge the outer traverser can't out()/in() (a hard error, NOT a
    // fallthrough). count/sum terminals are handled above.
    if (ctx.elem !== 'node') throw new Error(`where(__.${head}()) expects a vertex, not an ${ctx.elem}`);
    const exists = correlatedExists(engine, body, ctx.idExpr, isPred, hasIs, params);
    if (!exists) throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
    return exists;
  }
  throw new Error(`where()/filter() form not yet supported: __.${body.map((s) => s.name + '()').join('.')}`);
}

/** and(t…)/or(t…): each branch → a filter predicate node, joined by AND/OR
 *  (`((p0) AND (p1))`). Used both as a top-level filter step and inside where(__.and/or).
 *  Returns null when ANY branch is beyond the inline predicate compiler, so the caller
 *  can fall through to generic child-existence lowering (tryCombineByChildExistence). */
export function combineBranchPreds(
  engine: Engine, step: Step, ctx: ScalarCtx, params: Record<string, any>, op: 'AND' | 'OR',
  resolveAlias?: (label: string) => ScalarCtx,
): Expression | null {
  const branches = step.args.filter(isNested);
  if (branches.length < 2) throw new Error(`${step.name}() needs at least two traversal branches`);
  const parts: Expression[] = [];
  for (const b of branches) {
    const p = tryInlinePredicate(engine, stepChain(b.nested, params), ctx, params, resolveAlias);
    if (!p) return null;
    parts.push(paren(p));
  }
  return paren(list(parts, ` ${op} `));
}
