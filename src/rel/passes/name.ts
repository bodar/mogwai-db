import { ref } from '../factory.ts';
import { plan, type Binding, type Plan } from '../plan.ts';
import type { Rel } from '../rel.ts';
import { containsSelfRef, exprRels, forEachExpr, freeRelIds, relChildren, relExprs, rewriteRels } from '../walk.ts';

/**
 * Decide which DAG vertices deserve a named boundary, and REWRITE them into `Plan` bindings.
 *
 * This is §4.6, and a binding is now the only naming mechanism: the pass used to return a side
 * table the emitter consulted, which meant "is this node a CTE?" was a question asked of a map
 * carried beside the plan rather than of the plan. A binding plus a `Ref` says the same thing IN
 * the algebra, and says it identically for a relation and for a statement's retained rows (§3.0).
 *
 * A node reached more than once is shared, which is only true if the passes upstream preserved
 * sharing — a rewrite that rebuilds per parent occurrence makes every count 1 and silently turns
 * this analysis off.
 */
export function name(root: Rel): Plan {
  const counts = new Map<Rel, number>();
  const visit = (rel: Rel): void => {
    const seen = (counts.get(rel) ?? 0) + 1;
    counts.set(rel, seen);
    if (seen > 1) return;
    // ⚠️ THE COUNT MUST INCLUDE CORRELATED SUBPLANS, or a node shared between the spine and a
    // `Scalar`/`Exists` body counts once and is INLINED at both — the emitter spells the whole
    // subtree twice, and it is spelled again for every further occurrence. Nothing is wrong with the
    // answer, which is why this survived: it is bytes, and §3.6's statement-text budget is measured
    // in bytes. `COMPUTE ONCE` (§Phase 2's invariants) measured the same shape at 1,250 → 4,108 for
    // a single `max`.
    relExprs(rel).forEach((e) => forEachExpr(e, (node) => exprRels(node).forEach(visit)));
    relChildren(rel).forEach(visit);
  };
  visit(root);

  // An explicit Materialize name is the caller's, so generated names must not collide with one.
  const taken = new Set([...counts.keys()].flatMap((rel) => (rel.kind === 'materialize' && rel.name ? [rel.name] : [])));
  let n = 0;
  const generate = (): string => {
    let candidate = `r${n++}`;
    while (taken.has(candidate)) candidate = `r${n++}`;
    taken.add(candidate);
    return candidate;
  };
  /**
   * ⚠️ **A CORRELATED subtree may not be bound, and this is the whole risk of reaching into
   * subplans.** A binding is a CTE beside the statement; a subtree whose `Col`s resolve against a
   * relation OUTSIDE it stops resolving the moment it moves there — and it does not necessarily
   * fail, because a same-named relation elsewhere in the statement would silently capture it. So the
   * admission rule is the free-reference test, not the occurrence count.
   *
   * That is also why the test lives in `walk.ts`: `flatten` (§4.2) decides what it must DECORRELATE
   * with exactly this fact, and two implementations of "is this subtree self-contained" is two
   * chances to get it wrong.
   *
   * ⚠️ **A subtree holding a walk's own reference may not be bound either, and `freeRelIds` does not
   * say so** — a `SelfRef` names its walk POSITIONALLY rather than by a `Col`, so such a subtree is
   * free-reference-clean and looked bindable. Hoisting it puts the reference in a CTE beside its own
   * recursive statement, which SQLite answers with `circular reference`. It is reachable two ways —
   * a `Materialize` inside a recursive term (always), and any node the term shares with itself — and
   * `check` refuses the first outright, so what this arm keeps correct is the second. */
  const binds = (rel: Rel): boolean =>
    rel !== root && ((counts.get(rel) ?? 0) > 1 || rel.kind === 'materialize')
    && freeRelIds(rel).size === 0 && !containsSelfRef(rel);

  const bindings: Binding[] = [];
  // Bottom-up and memoised, so a binding is pushed after every binding it depends on, and the
  // second occurrence of a shared node gets the SAME `Ref` — the ordering `checkPlan` then proves.
  const result = rewriteRels(root, (mapped, original) => {
    if (!binds(original)) return mapped;
    const bound = original.kind === 'materialize' && original.name ? original.name : generate();
    bindings.push({ name: bound, node: mapped });
    return ref({ id: original.id, name: bound, channels: mapped.channels, type: mapped.type });
  });
  return plan({ bindings, result });
}
