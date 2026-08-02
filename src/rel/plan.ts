import type { Rel } from './rel.ts';
import type { Stmt } from './stmt.ts';

/**
 * THE TOP OF A PLAN IS A PROGRAM, NOT A TREE (§3.0 of the RelIR build plan).
 *
 * A named CTE and a prior statement's result are the SAME CONCEPT — a reference to a relation
 * computed earlier — and the build had two mechanisms for it: a `Naming` side-table for reads and
 * `PriorResult{step}` for writes. That duplication is why the write path read as a second machine.
 * One concept, one node:
 *
 * - a binding whose node is a `Rel`, referenced more than once → a **CTE**. That is the `name`
 *   pass's decision (§4.6), now a property OF THE PLAN rather than a map carried beside it.
 * - a binding whose node is a `Stmt` → a **statement boundary**. The executor runs it, retains its
 *   `RETURNING` rows, and the same `Ref` resolves to them.
 *
 * Ordering IS this list — there is no `Sequence` node privately owning execution order — and
 * **effects are legal only at a binding**, which is what makes a write in a read position
 * (`union(__.addV(), __.V())`) plan composition instead of a driver.
 *
 * The executor lives OUTSIDE `src/rel/` (§10·2). RelIR supplies `Ref`, this shape, and the passes.
 */
export interface Binding { readonly name: string; readonly node: Rel | Stmt; }
export interface Plan { readonly bindings: readonly Binding[]; readonly result: Rel; }

/** A plan with no bindings — the common read case, and what a bare relation means. */
export const planOf = (result: Rel): Plan => plan({ bindings: [], result });

export function plan(init: Plan): Plan {
  const seen = new Set<string>();
  for (const binding of init.bindings) {
    if (!binding.name) throw new Error('RelIR: a Plan binding must be named');
    if (seen.has(binding.name)) throw new Error(`RelIR: duplicate Plan binding '${binding.name}'`);
    seen.add(binding.name);
  }
  return Object.freeze({ bindings: Object.freeze([...init.bindings]), result: init.result });
}
