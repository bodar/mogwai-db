import type { Rel } from './rel.ts';
import { isStmt, type Stmt } from './stmt.ts';

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
 * - a binding whose node is a `Rel` and which is marked `snapshot` → a **read boundary**: it runs as
 *   its own step, its rows are retained, and every later `Ref` reads the value it had THEN.
 *
 * Ordering IS this list — there is no `Sequence` node privately owning execution order — and
 * **effects are legal only at a binding**, which is what makes a write in a read position
 * (`union(__.addV(), __.V())`) plan composition instead of a driver.
 *
 * The executor lives OUTSIDE `src/rel/` (§10·2). RelIR supplies `Ref`, this shape, and the passes.
 */
export interface Binding {
  readonly name: string;
  readonly node: Rel | Stmt;
  /**
   * THE VALUE IS THE VALUE AT THIS POINT IN THE PROGRAM — a `Rel` binding whose rows are TAKEN and
   * RETAINED rather than re-derived by each reader.
   *
   * A CTE is re-evaluated in every statement that names it, which is correct in a read program and
   * a silent wrong answer in one with effects: a vertex-drop cascade whose target relation reads
   * `edges` would find a different set after the incident-edge delete, and would leave vertices
   * standing. Retention is what preserves the PRE-MUTATION snapshot, and marking the binding is
   * what makes that a property of the plan rather than a statement ORDER the caller got lucky with.
   *
   * A `Stmt` binding is always retained (its rows cannot be recomputed at all), so this field says
   * of a relation exactly what a statement says of itself. `checkPlan` proves the converse: in a
   * program with effects, a `Rel` binding read by more than one step MUST carry it.
   */
  readonly snapshot?: boolean;
}
export interface Plan { readonly bindings: readonly Binding[]; readonly result: Rel; }

/** IS THIS BINDING'S VALUE TAKEN ONCE, or re-derived by each reader — the one question that decides
 * both how a `Ref` to it renders and whether it is an execution step of its own. Asked by the
 * emitter's `Ref` arm, its step assembler and `checkPlan`'s snapshot rule, so it is one predicate
 * rather than three spellings of `isStmt(node) || snapshot`. */
export const retained = (binding: Binding): boolean => isStmt(binding.node) || binding.snapshot === true;

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
