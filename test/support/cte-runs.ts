import type { PlanRow } from './snapshot-scans.ts';

/**
 * A NAMED CTE IS EVALUATED ONCE PER STATEMENT — read off SQLite's own `EXPLAIN QUERY PLAN`.
 *
 * A shared CTE SQLite FLATTENS into its readers (a row-wise top over a barrier or a walk) re-runs everything
 * beneath that top once per reader, and the plan lists each run as its own `CO-ROUTINE <name>` or
 * `MATERIALIZE <name>` row: `repeat(out('knows')).emit(in('knows').has('age', gt(40)))` listed
 * `CO-ROUTINE wk_w3` twice, its walk run twice. The cure is the fence (`name`'s `fenced`,
 * `src/rel/passes/name.ts`, deciding by `copyRerunsBarrier`, `src/rel/copies.ts`); this checks it from SQLite's
 * side. A `MATERIALIZE` listed again is the same defect: a materialized CTE is listed once, under its first
 * reader, however many read it. Only a CTE's name counts — a name a `WITH` list defines — not an anonymous
 * derived table (`(subquery-N)`) nor a derived table's alias.
 *
 * `scripts/sql-hygiene.ts` gates the corpus on it; the fence's own tests assert it of their witnesses.
 */
export function reevaluatedCtes(sql: string, plan: readonly PlanRow[]): readonly string[] {
  const ctes = new Set([...sql.matchAll(/(?:WITH(?: RECURSIVE)?|,) ("?)([\w$]+)\1(?:\([^()]*\))? AS (?:MATERIALIZED )?\(/g)].map((match) => match[2]!));
  const runs = new Map<string, number>();
  for (const row of plan) {
    const named = String(row.detail).match(/^(?:CO-ROUTINE|MATERIALIZE) ("?)([\w$]+)\1$/);
    if (!named || !ctes.has(named[2]!)) continue;
    runs.set(named[2]!, (runs.get(named[2]!) ?? 0) + 1);
  }
  return [...runs].filter(([, n]) => n > 1).map(([name, n]) => `CTE ${name} is evaluated ${n} times — fence it`);
}
