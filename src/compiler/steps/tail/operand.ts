import { q, type Expression } from '../../../sql/kernel/q.ts';
import { isNested } from '../../../gremlin/frontend.ts';
import { childSteps } from './child-shape.ts';
import { embedSql } from './list.ts';
import { engineOf } from '../../engine/deps.ts';
import { aliasCtx, labelNameSub, scalarProp, type ScalarCtx } from '../../plan/plan.ts';
import { compileCorrelatedChild } from './correlated.ts';
import { correlatedReduce } from '../prefix/predicate.ts';
import type { PStep } from '../../ir/strategies.ts';
import type { Carry } from '../context/context.ts';

// ---------- predicate operands that are TRAVERSALS ----------
//
// TinkerPop lets a predicate's right-hand operand be a traversal, compared against its FIRST
// result: `has("name", __.V(vid).values("name"))`, `has("age", P.gt(__.V(vid).values("age")))`,
// `is(__.V(vid).out("knows").values("age"))`.
//
// A bare `constant(x)` operand is already gone by the time we get here — the
// foldConstantPredicateOperands Pass turned it into a literal in the IR. What is left is a real
// traversal, and it splits in two:
//
//   · RE-SOURCED (`V()`/`E()` head) — it re-roots the graph and never reads the current
//     traverser, so it is a standalone read. Compile it as its own sub-read and embed the result
//     as a scalar subquery, exactly as within()/all() already do for a folded list operand
//     (list.ts). No correlation needed, so it composes at any depth and over any parent shape.
//   · TRAVERSER-DEPENDENT (`__.values("k")`, `__.out().values("k")`) — needs a value correlated
//     to the current row, so it renders as a CORRELATED scalar subquery over the same inline
//     child machinery the predicate fast path already uses (correlated.ts). Available only where
//     the host can supply a ScalarCtx for the current element; elsewhere it still defers.
//
// Resolution happens in the STEP layer, not in plan.ts: building a sub-read needs the Engine,
// which the pure SQL layer cannot reach. plan.ts already accepts an Expression operand (value()
// forwards nodes untouched), so substituting one here is all it takes.

/** Is this body a re-source — a `V()`/`E()` head with no nested id argument? Such a traversal is
 *  independent of the incoming traverser, which is exactly what makes it a plain subquery. */
const isReSourced = (body: readonly any[]): boolean => {
  const head = body[0];
  return !!head && (head.name === 'V' || head.name === 'E') && !(head.args ?? []).some(isNested);
};

/** One traversal operand → `(SELECT v FROM (<sub-read>) LIMIT 1)`, or null when it is not a
 *  standalone re-sourced read this can build. LIMIT 1 is TinkerPop's rule: a multi-result operand
 *  compares against its FIRST result (Has.feature pins `__.V(vid).out("knows").values("name")
 *  .order()` → the first of the ordered pair). */
function operandSubquery(nested: any, carry: Carry): Expression | null {
  const body = childSteps(nested, carry.params);
  if (!body.length || !isReSourced(body)) return null;
  const sub = engineOf(carry).compileReadCompiled(body as any, carry.params);
  // Only a VALUE-shaped read has a `v` column to compare against; an element/list/map read is a
  // different comparison entirely, so it declines rather than inventing one.
  if (sub.shape.kind !== 'value') return null;
  return q`(SELECT v FROM (${embedSql(sub)}) LIMIT 1)`;
}

/** The scalar an operand's TERMINAL step reads off the element it lands on. These are the same
 *  leaves the predicate fast path already builds from (plan.ts), so a correlated operand and a
 *  correlated filter agree by construction rather than by parallel implementations. */
const OPERAND_PROJECTORS: Record<string, (ctx: ScalarCtx, s: PStep) => Expression | undefined> = {
  values: (ctx, s) => (typeof s.args?.[0] === 'string' ? scalarProp(ctx, s.args[0]) : undefined),
  id: (ctx) => ctx.extIdExpr,
  label: (ctx) => labelNameSub(ctx.labelIdExpr),
};

/** A TRAVERSER-DEPENDENT operand → a correlated scalar Expression, or null when this shape is not
 *  one we can build (the caller then keeps its clear deferral).
 *
 *  Grammar: `<element movement/filter prefix>.<scalar projection>` — the same split the child seam
 *  uses everywhere. The prefix compiles through `compileCorrelatedChild`, the SAME inline renderer
 *  where()/filter() use, so movement inside an operand is not a second implementation; the
 *  projection then reads the reached element via `aliasCtx`, exactly as correlatedExists does for
 *  its trailing property test. An EMPTY prefix is not a special case but the degenerate one: the
 *  element it lands on IS the current traverser, so the projector reads the caller's own ctx and
 *  no subquery is needed.
 *
 *  An unproductive operand yields SQL NULL, which is already the right answer at both hosts
 *  TinkerPop pins: `eq(NULL)` is falsy so the traverser drops, and a NULL member of a within()
 *  set contributes nothing while a sibling constant can still match. */
function correlatedOperand(nested: any, carry: Carry, ctx: ScalarCtx): Expression | null {
  const body = childSteps(nested, carry.params) as PStep[];
  if (!body.length) return null;
  const engine = engineOf(carry);
  // A terminal reducer over a movement (`__.out().count()`) is already a correlated subquery
  // builder — reuse it rather than growing a second aggregate path.
  const reduced = correlatedReduce(engine, body as any, ctx, carry.params);
  if (reduced) return reduced;

  const proj = body[body.length - 1];
  const projector = OPERAND_PROJECTORS[proj.name];
  if (!projector) return null;
  const prefix = body.slice(0, -1);
  if (!prefix.length) return projector(ctx, proj) ?? null;
  const child = compileCorrelatedChild(engine, ctx.idExpr, prefix as any, carry.params);
  if (!child) return null;
  const c = child.rel.as('opc');
  const scalar = projector(aliasCtx(c.c.id, child.elem), proj);
  // LIMIT 1 — TinkerPop compares against the operand's FIRST result.
  return scalar ? q`(SELECT ${scalar} FROM ${c} LIMIT 1)` : null;
}

/** Replace every resolvable traversal operand in `pred` with its subquery Expression, leaving
 *  everything else exactly as it was. Handles the bare-operand form (`is(__.V(…)…)`) and operands
 *  nested inside a P, recursively (`P.not(P.gt(…))`). Returns `pred` unchanged when nothing
 *  resolved, so a caller can stay on its existing path. */
export function resolveTraversalOperands(pred: any, carry: Carry, ctx?: ScalarCtx): any {
  if (isNested(pred)) {
    // Re-sourced first: it needs no correlation, so it stays a plain subquery even at a host that
    // could correlate. Then the correlated form, where the host gave us the current element.
    return operandSubquery(pred.nested, carry)
      ?? (ctx ? correlatedOperand(pred.nested, carry, ctx) : null)
      ?? pred;
  }
  if (!pred || typeof pred !== 'object' || !('op' in pred) || !Array.isArray((pred as any).values)) return pred;
  let changed = false;
  const values = (pred as any).values.map((v: any) => {
    const out = resolveTraversalOperands(v, carry, ctx);
    if (out !== v) changed = true;
    return out;
  });
  return changed ? { ...pred, values } : pred;
}
