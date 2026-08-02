import { ref } from '../factory.ts';
import { plan, type Binding, type Plan } from '../plan.ts';
import type { Rel } from '../rel.ts';
import { relChildren, rewrite } from '../walk.ts';

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
  const binds = (rel: Rel): boolean => rel !== root && ((counts.get(rel) ?? 0) > 1 || rel.kind === 'materialize');

  const bindings: Binding[] = [];
  // Bottom-up and memoised, so a binding is pushed after every binding it depends on, and the
  // second occurrence of a shared node gets the SAME `Ref` — the ordering `checkPlan` then proves.
  const result = rewrite(root, (mapped, original) => {
    if (!binds(original)) return mapped;
    const bound = original.kind === 'materialize' && original.name ? original.name : generate();
    bindings.push({ name: bound, node: mapped });
    return ref({ id: original.id, name: bound, layout: mapped.layout, type: mapped.type });
  });
  return plan({ bindings, result });
}
