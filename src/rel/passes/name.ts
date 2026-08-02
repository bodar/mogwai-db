import type { Rel } from '../rel.ts';
import { relChildren } from '../walk.ts';

export interface NamedRel { readonly name: string; readonly rel: Rel; }
export interface Naming { readonly root: Rel; readonly named: readonly NamedRel[]; }

/**
 * Decide which DAG vertices deserve a named boundary. This is deliberately an analysis result,
 * not a Rel node: CTE spelling is an emitter policy and the algebra stays SQL-surface-neutral.
 *
 * A node reached more than once is shared, which is only true if the passes upstream preserved
 * sharing — a rewrite that rebuilds per parent occurrence makes every count 1 and silently turns
 * this analysis off.
 */
export function name(root: Rel): Naming {
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
  const named: NamedRel[] = [];
  for (const [rel, count] of counts) {
    if (rel === root || (count < 2 && rel.kind !== 'materialize')) continue;
    named.push({ name: rel.kind === 'materialize' && rel.name ? rel.name : generate(), rel });
  }
  return { root, named };
}
