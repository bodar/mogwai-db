import type { Rel } from '../rel.ts';
import { recursiveSelf } from '../factory.ts';

export interface NamedRel { readonly name: string; readonly rel: Rel; }
export interface Naming { readonly root: Rel; readonly named: readonly NamedRel[]; }

/**
 * Decide which DAG vertices deserve a named boundary. This is deliberately an analysis result,
 * not a Rel node: CTE spelling is an emitter policy and the algebra stays SQL-surface-neutral.
 */
export function name(root: Rel): Naming {
  const counts = new Map<Rel, number>();
  const seenRecursive = new Set<Rel>();
  const visit = (rel: Rel): void => {
    counts.set(rel, (counts.get(rel) ?? 0) + 1);
    if ((counts.get(rel) ?? 0) > 1) return;
    switch (rel.kind) {
      case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit': case 'distinct': case 'window': case 'explode': case 'materialize': visit(rel.input); break;
      case 'join': visit(rel.left); visit(rel.right); break;
      case 'union': rel.inputs.forEach(visit); break;
      case 'recursive':
        visit(rel.seed);
        if (!seenRecursive.has(rel)) {
          seenRecursive.add(rel);
          visit(rel.step(recursiveSelf(rel)));
        }
        break;
      default: break;
    }
  };
  visit(root);
  let n = 0;
  const named: NamedRel[] = [];
  for (const [rel, count] of counts) {
    if (rel === root || (count < 2 && rel.kind !== 'materialize')) continue;
    named.push({ name: rel.kind === 'materialize' && rel.name ? rel.name : `r${n++}`, rel });
  }
  return { root, named };
}
