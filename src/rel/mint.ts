import type { Rel } from './rel.ts';
import { relId, type RelId } from './types.ts';
import { forEachRel } from './walk.ts';

/**
 * FRESH NAMES.
 *
 * Two relations may not share a `RelId` in one scope (every `Col` against it becomes ambiguous and
 * the last binding silently wins), and two FROM items may not share a SQL alias (`ambiguous column
 * name`). So any rewrite that introduces a relation — a `seek` probe — has to mint names nothing
 * else in the plan holds. It lives here rather than inside the one pass that uses it today because
 * the rule is the algebra's, not that pass's.
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
