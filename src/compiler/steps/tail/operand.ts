import { q, type Expression } from '../../../sql/kernel/q.ts';
import { isNested } from '../../../gremlin/frontend.ts';
import { childSteps } from './child-shape.ts';
import { embedSql } from './list.ts';
import { engineOf } from '../../engine/deps.ts';
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
//   · TRAVERSER-DEPENDENT (`__.values("k")`, `__.out()…`) — needs a value correlated to the
//     current row. Left untouched here, so predicateSql's operandSql reports the clear deferral.
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

/** Replace every resolvable traversal operand in `pred` with its subquery Expression, leaving
 *  everything else exactly as it was. Handles the bare-operand form (`is(__.V(…)…)`) and operands
 *  nested inside a P, recursively (`P.not(P.gt(…))`). Returns `pred` unchanged when nothing
 *  resolved, so a caller can stay on its existing path. */
export function resolveTraversalOperands(pred: any, carry: Carry): any {
  if (isNested(pred)) return operandSubquery(pred.nested, carry) ?? pred;
  if (!pred || typeof pred !== 'object' || !('op' in pred) || !Array.isArray((pred as any).values)) return pred;
  let changed = false;
  const values = (pred as any).values.map((v: any) => {
    const out = resolveTraversalOperands(v, carry);
    if (out !== v) changed = true;
    return out;
  });
  return changed ? { ...pred, values } : pred;
}
