/**
 * A TAKEN SNAPSHOT SCANNED AS AN INNER LOOP — the O(N·M) shape `src/rel/emit.ts`'s `spools` exists to
 * remove, read off SQLite's own `EXPLAIN QUERY PLAN`.
 *
 * A retained binding reaches a statement as `json_each(?)`, a table-valued function SQLite can neither
 * index nor keep: wherever the planner runs it as anything but the OUTERMOST loop of its select — after
 * another loop of the same select, or anywhere inside a CORRELATED subquery — it is re-decoded once per
 * outer row. A spooled snapshot is a MATERIALIZED CTE instead, which the planner searches through an
 * automatic index; the one `json_each(?)` scan left is the CTE's own fill, the outer loop of its body.
 *
 * Only a BIND-FED `json_each` is a snapshot. A `json_each(<column>)` explodes one traverser's own list,
 * per row by construction, and is not counted. The plan is a property of the SQL and of SQLite's static
 * estimates, never of the data, so planning with empty snapshots (`'[]'`) gives the plan a full run gets.
 */
export interface PlanRow { readonly id: number; readonly parent: number; readonly detail: string; }

const LOOP = /^(SCAN|SEARCH) /;

export function nestedSnapshotScans(sql: string, plan: readonly PlanRow[]): readonly string[] {
  const snapshots = new Set([...sql.matchAll(/json_each\(\?\) ("?)([\w$]+)\1/g)].map((match) => match[2]!));
  if (!snapshots.size) return [];
  const byId = new Map(plan.map((row) => [row.id, row]));
  // A MATERIALIZE runs ONCE wherever the plan lists it — SQLite prints a CTE's fill under its first
  // reader, which may be a correlated subquery — so the walk up stops there.
  const correlated = (row: PlanRow): boolean => {
    for (let up = byId.get(row.parent); up; up = byId.get(up.parent)) {
      if (/^MATERIALIZE /.test(up.detail)) return false;
      if (/^CORRELATED /.test(up.detail)) return true;
    }
    return false;
  };
  // A SPOOLED snapshot's reads — `FROM <cte> <alias>` over an `AS MATERIALIZED` CTE whose body is a bind-fed
  // `json_each`. Scanned WITHOUT an index inside a correlated subquery it is the same O(N·M) one level up:
  // SQLite builds no automatic index there when the outer loop is a base table (measured, bun:sqlite 3.51).
  // A plain scan of it as a nested loop is NOT counted: a cross join is output-sized by construction.
  const spooled = new Set([...sql.matchAll(/("?)([\w$]+)\1 AS MATERIALIZED \(SELECT [^()]*(?:\([^()]*\)[^()]*)* FROM json_each\(\?\)/g)].map((match) => match[2]!));
  const spooledReads = new Set([...sql.matchAll(/(?:FROM|JOIN) ("?)([\w$]+)\1 ("?)([\w$]+)\3/g)]
    .filter((match) => spooled.has(match[2]!)).map((match) => match[4]!));
  const loopsSoFar = new Map<number, number>();
  const offenders: string[] = [];
  for (const row of plan) {
    if (!LOOP.test(row.detail)) continue;
    const before = loopsSoFar.get(row.parent) ?? 0;
    loopsSoFar.set(row.parent, before + 1);
    const scanned = row.detail.match(/^SCAN ("?)([\w$]+)\1 VIRTUAL TABLE/);
    if (scanned && snapshots.has(scanned[2]!) && (before > 0 || correlated(row))) offenders.push(scanned[2]!);
    const unindexed = row.detail.match(/^SCAN ("?)([\w$]+)\1$/);
    if (unindexed && spooledReads.has(unindexed[2]!) && correlated(row)) offenders.push(unindexed[2]!);
  }
  return offenders;
}
