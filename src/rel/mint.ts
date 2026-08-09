import type { Expr } from './expr.ts';
import type { Rel } from './rel.ts';
import { relId, type RelId } from './types.ts';
import { forEachRel, mapRelChildren, mapRelExprs, rewriteExpr } from './walk.ts';

/**
 * FRESH NAMES, AND THE COPY THAT NEEDS THEM.
 *
 * Two relations may not share a `RelId` in one scope (every `Col` against it becomes ambiguous and
 * the last binding silently wins), and two FROM items may not share a SQL alias (`ambiguous column
 * name`). So any rewrite that introduces a relation — a `seek` probe, an `unroll` replica — has to
 * mint names nothing else in the plan holds, and any rewrite that COPIES a subplan has to re-mint
 * every name inside the copy. Both live here rather than in either pass, because "a replica carries
 * its own ids" is one rule and two implementations of it is two chances to get it wrong (§12).
 */

export interface Minter {
  readonly id: (hint: string) => RelId;
  readonly alias: (hint: string) => string;
}

/**
 * Fresh relation ids and SQL aliases that cannot collide with anything already in the given plans.
 *
 * A `src/rel/` pass mints its own rather than taking the lowering's minter, because it may not reach
 * into `src/compiler/` — and because a pass must be runnable over any plan, including one a test
 * hand-built. Same technique as `name`'s generated binding names.
 *
 * ⚠️ **Seed it with the WHOLE plan, not the subtree being rewritten.** A name absent from the subtree
 * may still be taken by a sibling, and the collision that produces is a wrong ANSWER — the two
 * relations resolve to one.
 */
export function minter(...plans: readonly Rel[]): Minter {
  const ids = new Set<string>();
  const aliases = new Set<string>();
  for (const plan of plans) forEachRel(plan, (r) => { ids.add(r.id); if (r.kind === 'scan') aliases.add(r.alias); });
  const next = (taken: Set<string>, hint: string): string => {
    let n = 0;
    while (taken.has(`${hint}${n}`)) n++;
    taken.add(`${hint}${n}`);
    return `${hint}${n}`;
  };
  return { id: (hint) => relId(next(ids, hint)), alias: (hint) => next(aliases, hint) };
}

/**
 * A COPY OF A SUBPLAN THAT CARRIES ITS OWN NAMES — every relation id and every scan alias re-minted,
 * and every `Col` that named one rewritten to follow.
 *
 * `substitute` replaces a relation WHOLESALE rather than copying it, and `unroll` is why it exists:
 * a replica's self-reference becomes the previous level, and every `Col` naming the walk has to name
 * that level instead. Substitution wins over copying, and the substituted subtree is left alone —
 * it is already part of the plan.
 *
 * ⚠️ **Sharing is preserved.** A node reached twice in the DAG is copied ONCE and gets one new id;
 * copying per occurrence would turn a DAG into a tree, which is what `name`'s occurrence analysis
 * reads, and would multiply the statement text rather than sharing it (§3.6's other budget).
 *
 * ⚠️ **The id map is built over the WHOLE subtree first**, including correlated subplans, because a
 * `Col` inside a subplan may name a relation on the spine and vice versa — a rewrite that discovered
 * ids as it went would rewrite the reference before it knew the new name.
 */
export function refresh(plan: Rel, mint: Minter, substitute: ReadonlyMap<RelId, Rel> = new Map()): Rel {
  const ids = new Map<string, RelId>();
  const aliases = new Map<string, string>();
  forEachRel(plan, (r) => {
    const replacement = substitute.get(r.id as RelId);
    if (replacement) { ids.set(r.id, replacement.id as RelId); return; }
    if (!ids.has(r.id)) ids.set(r.id, mint.id(hint(r.id)));
    if (r.kind === 'scan' && !aliases.has(r.alias)) aliases.set(r.alias, mint.alias(hint(r.alias)));
  });

  const rename = (e: Expr): Expr => (e.kind === 'col' && ids.has(e.rel) ? { ...e, rel: ids.get(e.rel)! } : e);
  const memo = new Map<Rel, Rel>();
  const copy = (r: Rel): Rel => {
    const replacement = substitute.get(r.id as RelId);
    if (replacement) return replacement;
    const seen = memo.get(r);
    if (seen) return seen;
    const rebuilt = mapRelChildren(r, copy, { id: ids.get(r.id), alias: r.kind === 'scan' ? aliases.get(r.alias) : undefined });
    // Expressions second: the factory validated the node against its new children, and a `Col` is
    // rewritten by name regardless of where in the tree it sits — including inside a correlated
    // subplan, which `rewriteExpr`'s relation callback reaches.
    const out = mapRelExprs(rebuilt, (e) => rewriteExpr(e, rename, copy));
    memo.set(r, out);
    return out;
  };
  return copy(plan);
}

/** `r3` and `e2` are already minted names; a copy of one should read `r4`, not `r30`. */
const hint = (name: string): string => name.replace(/\d+$/, '') || 'r';
