import { fromTree, fusedInto } from './block.ts';
import type { Expr } from './expr.ts';
import type { Rel, RelKind } from './rel.ts';
import { containsSelfRef, exprChildren, exprRels, forEachRel, recursiveStep, relChildren, relExprs } from './walk.ts';

/**
 * WHY A `Recursive` NODE IS ILLEGAL — one answer, two callers, and the second caller is the reason
 * this is a module rather than four closures inside `check`.
 *
 * `check` asks it to THROW: a plan that violates one of these laws is a bug in whatever built it
 * (§11). A LOWERING asks the same question to DECLINE: `lowerToRel` must return `null` for a
 * traversal it cannot express, and "the body I would build puts a barrier in the recursive term" is
 * exactly that — coverage this route does not have, which legacy still answers. A lowering that
 * built the node anyway would turn a decline into a throw from the position where legacy answers,
 * which is the one failure the routing switch cannot absorb.
 *
 * So the rules cannot live in the checker: a second copy in the lowering would be a copy that
 * drifts, and the drift is silent in the dangerous direction — the lowering admits, the checker
 * throws, and `rel-sweep` reports a violation whose cause is a rule spelled twice.
 *
 * Every law below is SQLite's, measured at bun:sqlite 3.53.0, and none of them moves with effort —
 * see `docs/2026-08-09-repeat-two-regimes-plan.md` §6 for the measurements.
 */

/**
 * SQLite's recursive-term laws, and they have TWO different scopes — conflating them was a real
 * defect in both directions. Each row below is measured on bun:sqlite 3.53.0, not reasoned from
 * the docs (whose "must not appear anywhere else" is stricter than the engine, per P2).
 *
 * **The BARRIER laws apply to the recursive SELECT ITSELF and stop at EVERY nested SELECT.** A
 * nested SELECT is a different SELECT and the engine treats it as one — a correlated subquery and
 * a joined DERIVED TABLE alike:
 *
 * | in the recursive term proper | in a nested SELECT inside it |
 * |---|---|
 * | aggregate → `recursive aggregate queries not supported` | aggregate → **legal** |
 * | window → `cannot use window functions in recursive queries` | window → **legal** |
 * | `DISTINCT` → accepted and **INERT** (duplicates survive) | its own SELECT's, honoured |
 * | `LIMIT` → accepted as a **WHOLE-CTE cap** | its own SELECT's, honoured |
 * | `ORDER BY` → accepted, whole-CTE | its own SELECT's, honoured |
 *
 * ⚠️ **The right column is why this walk must NOT descend.** `flatten` (§4.2) decorrelates into
 * exactly these correlated scalars — P2 lists them as legal-but-refused-today — so a law that
 * fires inside one would refuse the shapes Phase 3 is built to produce. Refusing a legal input to
 * keep a check simple is the failure mode the root CLAUDE.md names by hand.
 *
 * ⚠️ **…and the boundary is not "an expression subplan" but "a nested SELECT", which is why this
 * asks `fusedInto` rather than walking node children.** All four barriers are legal in a derived
 * table joined into a recursive term (measured: an aggregate, a window function, a `DISTINCT` and
 * an `ORDER BY … LIMIT` each returned the right rows), and a node-children walk refused every one
 * of them — a `repeat()` body joining against any ranked, deduped or capped relation. Which nodes
 * end up in one SELECT is the EMITTER's fusion decision, so the analysis asks it.
 *
 * ⚠️ **`Distinct`/`Limit`/`Sort` are refused even though SQLite ACCEPTS them, and that is the
 * point** (P3). They are silently not what an author writing them means: a `repeat(…dedup())` body
 * reads as a per-iteration barrier and compiles to an inert keyword, and a `LIMIT` inside a body
 * caps the WHOLE walk rather than each step. No per-iteration barrier is expressible in a
 * recursive term in ANY lowering, so the only correct answer is a clear refusal — an accepted
 * wrong answer is the one outcome no instrument in this repo can see. It is also the whole reason
 * `repeat()` has TWO regimes: the bodies this table refuses are exactly the ones the IR UNROLL
 * takes (`docs/2026-08-09-repeat-two-regimes-plan.md` §1).
 *
 * The SELF-REFERENCE count keeps the descending walk, because P2 measured that a correlated scalar
 * subquery MAY reference the walk's alias — so a reference inside one is a real reference and must
 * count toward "exactly once".
 */
const BARRIER_IN_TERM: Partial<Record<RelKind, string>> = {
  aggregate: 'SQLite forbids aggregate queries in a recursive term',
  window: 'SQLite forbids window functions in a recursive term',
  distinct: 'SQLite ACCEPTS DISTINCT in a recursive term and silently ignores it — no per-iteration dedup exists (P3); dedup outside the walk',
  limit: 'SQLite ACCEPTS LIMIT in a recursive term and applies it to the WHOLE walk, not per iteration (P3); cap outside the walk',
  sort: 'SQLite ACCEPTS ORDER BY in a recursive term and applies it to the WHOLE walk, not per iteration (P3); order outside the walk',
};

const recursiveTerm = (term: Rel, name: string): { selfRefs: number; barrier?: string } => {
  let selfRefs = 0;
  let barrier: string | undefined;
  // The term's OWN `SELECT` — the nodes that FUSE into it, which stops at every nested SELECT: a
  // derived table and a correlated subquery alike (`fusedInto`, block.ts).
  // Node kinds only: an `Agg` is legal nowhere but `Aggregate.aggs` and a `WindowExpr` nowhere but
  // `Window.specs` (checked in `checkExpr`), so the two node kinds ARE the two expression forms and
  // scanning expressions here would be the same law spelled twice.
  for (const node of fusedInto(term)) barrier ??= BARRIER_IN_TERM[node.kind];
  /** Self-references, wherever they are — including inside a correlated subplan (P2). */
  const expression = (e: Expr): void => { exprRels(e).forEach(references); exprChildren(e).forEach(expression); };
  const references = (r: Rel): void => {
    if (r.kind === 'self-ref') { if (r.name === name) selfRefs++; return; }
    relExprs(r).forEach(expression);
    relChildren(r).forEach(references);
  };
  references(term);
  return { selfRefs, barrier };
};

/**
 * P1's law: the walk's reference lands in the recursive term's `FROM` join tree, UNWRAPPED.
 *
 * ⚠️ **This is a structural question, not a one-level shape match, and the difference is the most
 * common `repeat()` body there is.** SQL's `FROM` is a join TREE and everything in it is
 * top-level, however many algebra nodes sit above it — so `project(join(self, edges))`, refused by
 * the shape match this replaces, denotes the canonical recursive walk. Whether a node's input ends
 * up in the same `FROM` or behind a derived table is decided by the EMITTER's fusion rules, so
 * that is what `fromTree` asks (`block.ts`), rather than a second guess at them here.
 */
const topLevelSelf = (term: Rel, name: string): boolean =>
  fromTree(term).some((source) => source.kind === 'self-ref' && source.name === name);

/**
 * A `Materialize` over the walk's own reference. It is the one unary node the fusion analysis
 * above cannot answer for, because its boundary is not a derived table the emitter opens but a CTE
 * the `Name` pass makes — and a walk referenced from inside a CTE beside its own statement is
 * `circular reference`, even as the SOLE reference, because SQLite's rule is positional rather
 * than a count (P1). A fence belongs outside the recursive term, never between it and its walk.
 */
const fencedSelf = (term: Rel, name: string): boolean => {
  let fenced = false;
  forEachRel(term, (r) => { if (r.kind === 'materialize' && containsSelfRef(r, name)) fenced = true; });
  return fenced;
};

const sameColumns = (left: Rel['type']['cols'], right: Rel['type']['cols']): boolean =>
  left.length === right.length && left.every((column, i) => {
    const other = right[i];
    return other?.name === column.name && other.type === column.type && other.nullable === column.nullable;
  });

/**
 * WHY THIS `Recursive` IS ILLEGAL, or `undefined` when it is not — the message WITHOUT the `RelIR: `
 * prefix, so the caller decides whether it is a throw or a decline.
 *
 * The step is built once here (`recursiveStep` memoises through the factory), so asking this
 * question costs one construction whether the answer is used to throw or to fall back.
 */
export function recursiveViolation(node: Extract<Rel, { readonly kind: 'recursive' }>): string | undefined {
  const step = recursiveStep(node);
  /**
   * ⚠️ **A TERM IS A COMPOUND, so every law below is a question about an ARM.** SQLite reads
   * `seed UNION ALL arm₁ UNION ALL arm₂` as one recursive term PER ARM: each must reference the walk
   * exactly once, and the same two arms behind a derived table are `circular reference` (measured,
   * §6 of `docs/2026-08-09-repeat-two-regimes-plan.md`). Asking the questions of the whole step
   * instead is what refused every multi-arm body — `both()`/`bothE()`/`bothV()` are two `HOPS`
   * entries unioned, so a walk over one holds two references in what is really two terms.
   *
   * ⚠️ **Only a UNION ALL splits.** A compound `UNION` in a recursive term dedups across the WHOLE
   * walk rather than within an iteration, which is P3's category exactly: SQLite ACCEPTS it and
   * silently answers a set where the traverser multiset is the semantics. Refused by name.
   */
  if (step.kind === 'union' && !step.all)
    return `a compound UNION in a recursive term dedups the WHOLE walk rather than one iteration (P3), which SQLite accepts and answers as a set; a recursive term's arms must be UNION ALL`;
  const arms = step.kind === 'union' ? step.inputs : [step];
  for (const arm of arms) {
    const term = recursiveTerm(arm, node.name);
    if (term.selfRefs !== 1) return `Recursive step must reference '${node.name}' exactly once per compound arm (found ${term.selfRefs})`;
    if (term.barrier) return term.barrier;
    if (fencedSelf(arm, node.name))
      return `a Materialize over the '${node.name}' reference forces a CTE boundary, and SQLite reports 'circular reference' for a walk referenced from inside one; fence outside the walk`;
    if (!topLevelSelf(arm, node.name)) return `Recursive step must reference '${node.name}' at the top level of FROM; run flatten first`;
  }
  if (!sameColumns(node.seed.type.cols, step.type.cols)) return 'Recursive seed and step types must be identical';
  return undefined;
}
