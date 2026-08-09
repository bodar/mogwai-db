import { refresh, type Minter } from '../mint.ts';
import type { Rel } from '../rel.ts';
import type { RelId } from '../types.ts';
import { recursiveStep } from '../walk.ts';

/**
 * `unroll` (§4.3) — A BOUNDED WALK AS ITS LEVELS, each a plain relation.
 *
 * A `Recursive` is the fixpoint: SQLite runs the step until it adds nothing, and no per-iteration
 * BARRIER is expressible inside a recursive term in any lowering (P3 — SQLite accepts `DISTINCT`,
 * `LIMIT` and `ORDER BY` there and silently means something else by each). A bounded `repeat()` has
 * a second lowering that has none of those limits: apply the step a fixed number of times, as
 * ordinary relations. 48 of the corpus's 53 barrier bodies are bounded that way.
 *
 * ⚠️ **IT RETURNS THE LEVELS, NOT A RESULT, AND THAT IS §2'S BOUNDARY.** Which levels a traversal
 * emits is a GREMLIN question — `times(n)` alone yields the last, `emit()` adds the ones it selects,
 * `until()` chooses per row — and answering it here would put Gremlin's vocabulary in a `Rel → Rel`
 * pass. Level 0 is the seed; level i is the step applied to level i-1. A caller takes the last, or
 * unions a set of them, and says so in its own words.
 *
 * ⚠️ **Every replica carries its OWN relation ids and scan aliases** (`refresh`): two relations
 * sharing a `RelId` in one scope make every `Col` against it ambiguous, and two FROM items sharing
 * an alias are `ambiguous column name` — and a chain of levels puts all of them in one scope. §12
 * names this trap; `check` catches the join case and nothing catches the rest.
 *
 * ⚠️ **The step body is instantiated ONCE.** `recursive`'s factory memoises `step`, so it cannot be
 * re-run against a new input — the substitution has to happen on the instantiated body, which is
 * exactly what `refresh`'s `substitute` map does: the self-reference becomes the previous level, and
 * every `Col` that named the walk is rewritten to name that level.
 *
 * The STATEMENT-TEXT budget is not decided here (§3.6 gives it to the plan): n replicas of a body
 * are n times the SQL, and what a Durable Object refuses is measured on the rendered statement by
 * `cfLimitViolation`. A caller that cannot afford the copies keeps the `Recursive` — which then
 * refuses a barrier body, per P3, rather than answering it wrongly.
 */
export function unroll(node: Extract<Rel, { readonly kind: 'recursive' }>, times: number, mint: Minter): readonly Rel[] {
  if (!Number.isInteger(times) || times < 0) throw new Error(`RelIR: unroll needs a non-negative whole number of iterations; got ${times}`);
  const body = recursiveStep(node);
  const levels: Rel[] = [node.seed];
  for (let i = 0; i < times; i++) {
    const previous = levels[i]!;
    levels.push(refresh(body, mint, new Map<RelId, Rel>([[node.id as RelId, previous]])));
  }
  return levels;
}
