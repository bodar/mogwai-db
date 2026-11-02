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
  const reads = [...sql.matchAll(/(?:FROM|JOIN) ("?)([\w$]+)\1 ("?)([\w$]+)\3/g)].map((match) => ({ table: match[2]!, alias: match[4]! }));
  // alias → the spooled CTE it reads, and the aliases of BASE tables (a stored relation, not a CTE).
  const spooledReads = new Map(reads.filter((read) => spooled.has(read.table)).map((read) => [read.alias, read.table] as const));
  const baseReads = new Set(reads.filter((read) => BASE_TABLES.has(read.table)).map((read) => read.alias));
  const loopsSoFar = new Map<number, number>();
  // Per select (the plan rows sharing a parent): the snapshots its EARLIER loops read — a json_each alias
  // or the spooled CTE an alias reads — so a later loop knows it runs once per snapshot row.
  const snapshotLoops = new Map<number, Set<string>>();
  const offenders: string[] = [];
  for (const row of plan) {
    if (!LOOP.test(row.detail)) continue;
    const before = loopsSoFar.get(row.parent) ?? 0;
    loopsSoFar.set(row.parent, before + 1);
    const outer = snapshotLoops.get(row.parent) ?? new Set<string>();
    const alias = row.detail.match(/^(?:SCAN|SEARCH) ("?)([\w$]+)\1/)?.[2];
    const scanned = row.detail.match(/^SCAN ("?)([\w$]+)\1 VIRTUAL TABLE/);
    if (scanned && snapshots.has(scanned[2]!) && (before > 0 || correlated(row))) offenders.push(scanned[2]!);
    const unindexed = row.detail.match(/^SCAN ("?)([\w$]+)\1$/);
    if (unindexed && spooledReads.has(unindexed[2]!) && correlated(row)) offenders.push(unindexed[2]!);
    // A SNAPSHOT SELF-JOIN WITH NO EQUI KEY: the same spooled relation read again, unindexed, once per row
    // of an earlier read of it — every pair of its rows, whatever the predicate keeps (a cross join of two
    // DIFFERENT relations stays uncounted: it is output-sized by construction).
    if (unindexed && spooledReads.has(unindexed[2]!) && outer.has(spooledReads.get(unindexed[2]!)!))
      offenders.push(`${unindexed[2]!} (a snapshot self-join with no equi key)`);
    // A BASE TABLE SCANNED IN FULL once per snapshot row — a search per traverser that reads the whole
    // graph (a covering-index scan is still every row).
    const full = row.detail.match(/^SCAN ("?)([\w$]+)\1(?: USING (?:COVERING )?INDEX [\w$]+)?$/);
    if (full && baseReads.has(full[2]!) && outer.size) offenders.push(`${full[2]!} (a base table scanned per snapshot row)`);
    if (alias && (snapshots.has(alias) || spooledReads.has(alias))) {
      outer.add(spooledReads.get(alias) ?? alias);
      snapshotLoops.set(row.parent, outer);
    }
  }
  return offenders;
}

/** The stored relations — a full scan of one is a read of the graph, not of the query's own rows. */
const BASE_TABLES = new Set(['nodes', 'edges', 'labels', 'vertex_labels', 'vertex_properties', 'edge_properties', 'property_fts']);
