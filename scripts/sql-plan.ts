#!/usr/bin/env bun
/**
 * SQL PLAN — EXPLAIN QUERY PLAN over every compiled corpus read (and every planned `call()` read), to
 * catch a generated query whose LOOP SHAPE is wrong. This is the production-relevant companion to
 * profiling: CPU-profiling the suite measures the COMPILER (the fixtures are six vertices, SQLite
 * execution is ~1% of the run), so it says nothing about query cost at scale. Plan SHAPE does, and
 * without `sqlite_stat1` SQLite plans with its default size estimates, so the six-vertex fixture
 * predicts shape adequately (though never timing — the scaling probe stays the measurement).
 *
 * READING A PLAN. EXPLAIN QUERY PLAN names each loop by its FROM-item ALIAS (`SCAN rn`, `SEARCH rme3`),
 * not its table, so every alias is resolved through ONE mechanism: the emitted SQL's FROM items, which
 * the RelIR emitter always spells `<table> <alias>` (`FROM nodes rn`, `CROSS JOIN edges rme3`). A base
 * alias that resolves to two different tables fails loudly (the map would be lying), and a named index is
 * cross-checked against `sqlite_schema.tbl_name`. An alias that resolves to no base table is a derived
 * relation (a CTE, a co-routine, `json_each`) and is not a finding.
 *
 * Each base-table loop is classified by its POSITION in the EQP tree (`id`/`parent`) — ROOT is the first
 * loop under its parent in an uncorrelated block; NESTED is an inner loop (after a sibling loop under the
 * same parent) or any loop under a `CORRELATED … SUBQUERY` node, which re-runs per outer row — and by how
 * it is served. The classes are not alike:
 *
 *   ROOT (element) — a root SCAN of `nodes`/`edges`. A root `g.V()` / `g.E()` reads every element BY
 *     MEANING, so this is reported, never gated: gating it would force a decline or an index that serves
 *     nothing.
 *   ROOT (non-element) — a root SCAN of ANY other base table. No query means "every property row" or
 *     "every label row"; this is the signature of a lost index (drop `vp_key_value` and
 *     `g.V().has('name','marko')` scans `vertex_properties`). Gate at zero.
 *   NESTED — a nested base SCAN. This is the N² signature — but not proof of it (`g.V(1).V()`'s outer loop
 *     is one row), so it is a RATCHET needing judgement: each query's nested count is held to
 *     `scripts/sql-plan-baseline.json`, and a query that GAINS one fails. A query that loses one fails too,
 *     so the baseline is re-recorded and stays tight (`--record`; say why in the commit — a corpus pin bump
 *     that adds queries re-records and says so). Of its 27 entries, 26 are a `V()`/`E()` mid-traversal
 *     (`V().out().V()`, `V().E(null)`, `inject(1).as(…).V()`) or inside a correlated set-operation argument
 *     (`fold().difference(__.V()…fold())`); the 27th is neither — `groupCount('a')…where(__.select('a')…)`
 *     re-derives the side effect per traverser, a known super-linear defect (`docs/outstanding-work.md`).
 *   UNCONSTRAINED VIRTUAL — a scan of the `property_fts` virtual table whose idxStr carries NO constraint
 *     (a bare `INDEX 0:`): the whole full-text index read per query. Nothing a query means needs it — the
 *     probe always has a pattern to hand FTS5 — so it is a hard gate at zero. A `0:=` rowid seek or a
 *     `0:L…`/`0:M…` constraint is index-served and not flagged.
 *
 * A `SEARCH` is index-served — except in two disguises, both gated at zero:
 *
 *   AUTOMATIC INDEX — a base-table `SEARCH … USING AUTOMATIC [PARTIAL] [COVERING] INDEX`: SQLite builds it
 *     by scanning the whole table, on every run. (On a derived relation — a CTE — it is the planner's
 *     ordinary hash-join substitute, and not a finding.)
 *   WEAK PREFIX — a NESTED `SEARCH` whose constrained columns (parsed from the EQP line's `(col=? AND …)`)
 *     are ALL vocabulary columns (`VOCABULARY_COLUMNS`: `label`, `key`): a slice proportional to the graph,
 *     re-read per outer row (drop `e_out`/`e_pair` and `g.V(1).out('knows')` probes `e_label (label=?)`).
 *     Each index's columns and uniqueness come from SQLite's own `pragma_index_list`/`pragma_index_info`,
 *     so no index name is listed here; a unique index fully constrained is a point lookup and not flagged.
 *     A ROOT vocabulary probe — `g.E().hasLabel('x')` seeking `e_label` once — is the query's meaning.
 *
 * TEMP B-TREE (a sort/group without an index) is reported, never gated: a GROUP BY over a computed value
 * has no index to use.
 *
 * Plans single-statement reads only; a `program` (writes) or a segment plan (a barrier `call()`) has no one
 * plan and is skipped. `call()` reads compile against the standard service registry, so `tinker.search`
 * — the second user of `property_fts` — is planned and covered by the hard gate.
 *
 *   bun scripts/sql-plan.ts            # summary; exit 1 on any gated class or a nested-baseline move
 *   bun scripts/sql-plan.ts --verbose  # also list every offender per class + the temp-b-tree offenders
 *   bun scripts/sql-plan.ts --record   # bank the NESTED baseline (the hard gate still applies)
 */
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { compile } from '../src/compiler/compiler.ts';
import { runSteps } from '../src/program.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from '../test/fixtures/seed-modern.ts';

/** One EXPLAIN QUERY PLAN row. */
export interface PlanRow { readonly id: number; readonly parent: number; readonly detail: string }

/** One index, read from SQLite's own metadata (`pragma_index_list` / `pragma_index_info`), never restated. */
export interface IndexFacts { readonly table: string; readonly columns: readonly string[]; readonly unique: boolean }

/** What the classifier needs from the schema: which names are base tables (and which of those are
 *  virtual), and each named index's table, columns and uniqueness. */
export interface SchemaFacts { readonly tables: ReadonlySet<string>; readonly virtual: ReadonlySet<string>; readonly indexes: ReadonlyMap<string, IndexFacts> }

/** The VOCABULARY columns: an interned label id, a property key name. Each has a handful of distinct values
 *  over a whole graph, so an index probe constrained by these ALONE reads a slice proportional to the
 *  graph, not to the outer row — and at a nested position, once per outer row. The one judgement this gate
 *  makes, and it is a SCHEMA fact (src/storage.ts), not a per-query or per-index list: a new index whose
 *  leading column is one of these is covered without an edit. */
export const VOCABULARY_COLUMNS: ReadonlySet<string> = new Set(['label', 'key']);

/** The tables a root loop may read whole BY MEANING: a root `g.V()` / `g.E()` is every element. */
export const ELEMENT_TABLES: ReadonlySet<string> = new Set(['nodes', 'edges']);

export type LoopClass = 'root' | 'root-non-element' | 'nested' | 'unconstrained-virtual' | 'automatic-index' | 'weak-prefix';
/** A loop worth naming: a base-table SCAN, or a SEARCH that is a scan in disguise. */
export interface LoopFinding { readonly cls: LoopClass; readonly table: string; readonly alias: string; readonly detail: string }

export function schemaFacts(store: GraphStore): SchemaFacts {
  const rows = store.query(`SELECT name, sql FROM sqlite_schema WHERE type = 'table'`, []) as { name: string; sql: string | null }[];
  const tables = new Set<string>(), virtual = new Set<string>();
  for (const r of rows) {
    tables.add(r.name);
    if (/^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')) virtual.add(r.name);
  }
  const indexRows = store.query(
    `SELECT m.name AS tbl, il.name AS idx, il."unique" AS uniq,
            (SELECT json_group_array(ii.name) FROM (SELECT name FROM pragma_index_info(il.name) ORDER BY seqno) ii) AS cols
       FROM sqlite_schema m, pragma_index_list(m.name) il WHERE m.type = 'table'`, []) as { tbl: string; idx: string; uniq: number; cols: string }[];
  const indexes = new Map<string, IndexFacts>();
  for (const r of indexRows) indexes.set(r.idx, { table: r.tbl, columns: JSON.parse(r.cols) as string[], unique: r.uniq === 1 });
  return { tables, virtual, indexes };
}

/** Blank every string literal (keeping its length irrelevant) so a literal spelling `from nodes x` is not
 *  read as a FROM item. SQL escapes a quote by doubling it, which this regex consumes as one literal. */
const stripLiterals = (sql: string): string => sql.replace(/'(?:[^']|'')*'/g, "''");
const unquote = (name: string): string => name.replace(/^"(.*)"$/, '$1').replace(/""/g, '"');
const IDENT = String.raw`("(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const FROM_ITEM = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${IDENT}\s+(?:AS\s+)?${IDENT}`, 'gi');

/** Alias → base table, from the emitted SQL's FROM items. A FROM item whose first name is not a base table
 *  (a CTE reference) is not entered; a derived `(SELECT …) a` or `json_each(…) a` never matches. One alias
 *  naming two tables throws — every resolution downstream would be a guess. */
export function aliasTables(sql: string, facts: SchemaFacts): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of stripLiterals(sql).matchAll(FROM_ITEM)) {
    const table = unquote(m[1]!), alias = unquote(m[2]!);
    if (!facts.tables.has(table) || /^(ON|WHERE|CROSS|LEFT|INNER|JOIN|GROUP|ORDER|LIMIT|UNION|WINDOW|USING)$/i.test(alias)) continue;
    const prior = map.get(alias);
    if (prior !== undefined && prior !== table) throw new Error(`sql-plan: alias ${alias} names both ${prior} and ${table} in one statement — alias resolution would be a guess`);
    map.set(alias, table);
  }
  return map;
}

const LOOP = /^(SCAN|SEARCH) (\S+)/;

/** The columns an index probe constrains, from the EQP line's trailing `(col=? AND col>? …)`. */
export function constrainedColumns(detail: string): string[] {
  const list = detail.match(/\(([^()]*)\)$/)?.[1];
  if (list === undefined) return [];
  return list.split(' AND ').map((term) => term.match(/^(\w+)/)?.[1]).filter((c): c is string => c !== undefined);
}

/** Classify every base-table loop in one plan by its EQP-tree position and how it is served. */
export function classify(plan: readonly PlanRow[], sql: string, facts: SchemaFacts): LoopFinding[] {
  const aliases = aliasTables(sql, facts);
  const byId = new Map(plan.map((row) => [row.id, row]));
  const correlatedAncestor = (row: PlanRow): boolean => {
    for (let p = byId.get(row.parent); p; p = byId.get(p.parent)) if (/^CORRELATED /.test(p.detail)) return true;
    return false;
  };
  // An inner loop (after a sibling loop under the same parent), or any loop under a correlated subquery,
  // runs once per outer row.
  const nestedAt = (row: PlanRow): boolean =>
    plan.some((s) => s.parent === row.parent && s.id < row.id && LOOP.test(s.detail)) || correlatedAncestor(row);
  const out: LoopFinding[] = [];
  for (const row of plan) {
    const m = row.detail.match(LOOP);
    if (!m) continue;
    const alias = m[2]!;
    const table = aliases.get(alias) ?? (facts.tables.has(alias) ? alias : undefined);
    const index = row.detail.match(/USING (?:COVERING )?INDEX (\S+)/)?.[1];
    const idx = index === undefined ? undefined : facts.indexes.get(index);
    if (table !== undefined && idx !== undefined && idx.table !== table)
      throw new Error(`sql-plan: ${alias} resolved to ${table} but loops over index ${index} of ${idx.table}`);
    if (table === undefined) continue;                        // a derived relation (CTE, co-routine, json_each) is not a base read
    const finding = (cls: LoopClass): void => { out.push({ cls, table, alias, detail: row.detail }); };
    if (m[1] === 'SEARCH') {
      // An AUTOMATIC index is built by scanning the whole table at run time, every statement: a disguised scan.
      if (/USING AUTOMATIC (?:PARTIAL )?(?:COVERING )?INDEX/.test(row.detail)) { finding('automatic-index'); continue; }
      if (!nestedAt(row)) continue;                           // a root probe reads its slice once (`g.E().hasLabel(x)`)
      const cols = constrainedColumns(row.detail);
      if (idx !== undefined) {
        const stray = cols.filter((c) => !idx.columns.includes(c));
        if (stray.length) throw new Error(`sql-plan: ${alias} constrains ${stray.join(', ')}, not columns of index ${index} (${idx.columns.join(', ')})`);
        if (idx.unique && idx.columns.every((c) => cols.includes(c))) continue; // a unique point lookup reads one row
      }
      if (cols.length && cols.every((c) => VOCABULARY_COLUMNS.has(c))) finding('weak-prefix');
      continue;
    }
    if (facts.virtual.has(table)) {
      if (/VIRTUAL TABLE INDEX \d+:$/.test(row.detail)) finding('unconstrained-virtual');
      continue;                                               // a constrained virtual scan (`0:=`, `0:L4`) is index-served
    }
    if (nestedAt(row)) finding('nested');
    else finding(ELEMENT_TABLES.has(table) ? 'root' : 'root-non-element');
  }
  return out;
}

/** Seed MODERN_SEED (schema + realistic label/key ids) through the ordinary compile+run path. */
export function seededPlanStore(): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const q of MODERN_SEED) {
    const p = compile(q, {}, undefined);
    if (p.kind === 'program') { for (const _ of runSteps(store, p)) { /* drain */ } }
    else store.query(p.sql, p.binds);
  }
  return store;
}

/** Compile + EXPLAIN one traversal; undefined when it has no single plan (a decline, a program, a segment). */
export function planOf(store: GraphStore, q: string): { sql: string; plan: PlanRow[] } | undefined {
  let p: ReturnType<typeof compile>;
  try { p = compile(q, {}, { registry: standardRegistry }); } catch { return undefined; } // a decline is not a plan-quality question
  if (p.kind !== 'read' || !p.sql) return undefined;
  try { return { sql: p.sql, plan: store.query('EXPLAIN QUERY PLAN ' + p.sql, p.binds) as PlanRow[] }; } catch { return undefined; }
}

async function main(): Promise<void> {
  const verbose = Bun.argv.includes('--verbose');
  const record = Bun.argv.includes('--record');
  const baselinePath = new URL('./sql-plan-baseline.json', import.meta.url);
  const expected = JSON.parse(await Bun.file(baselinePath).text()) as Record<string, number>;
  const corpus = [...new Set((await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text()).split('\n').filter(Boolean))];

  const store = seededPlanStore();
  const facts = schemaFacts(store);
  let planned = 0, withTempBtree = 0;
  const offenders: Record<LoopClass, string[]> = { root: [], 'root-non-element': [], nested: [], 'unconstrained-virtual': [], 'automatic-index': [], 'weak-prefix': [] };
  const tempOffenders: string[] = [];
  const nested: Record<string, number> = {};

  for (const q of corpus) {
    const got = planOf(store, q);
    if (!got) continue;
    planned++;
    const loops = classify(got.plan, got.sql, facts);
    for (const cls of Object.keys(offenders) as LoopClass[]) {
      const n = loops.filter((s) => s.cls === cls).length;
      if (n) offenders[cls].push(q);
      if (cls === 'nested' && n) nested[q] = n;
    }
    if (got.plan.some((row) => /USE TEMP B-TREE/.test(row.detail))) { withTempBtree++; tempOffenders.push(q); }
  }

  console.log(`sql-plan: ${planned} corpus reads planned via EXPLAIN QUERY PLAN`);
  console.log(`  root element scans (every vertex/edge, by meaning)   : ${offenders.root.length}  (reported, not gated)`);
  console.log(`  root scans of any other base table                   : ${offenders['root-non-element'].length}  (gate at zero)`);
  console.log(`  nested base scans (inner loop / under CORRELATED)    : ${offenders.nested.length}  (ratcheted against sql-plan-baseline.json)`);
  console.log(`  unconstrained virtual scans (property_fts, no probe) : ${offenders['unconstrained-virtual'].length}  (gate at zero)`);
  console.log(`  automatic indexes on a base table (a disguised scan) : ${offenders['automatic-index'].length}  (gate at zero)`);
  console.log(`  nested probes on vocabulary columns only (label/key) : ${offenders['weak-prefix'].length}  (gate at zero)`);
  console.log(`  temp b-tree (sort/group without index)               : ${withTempBtree}  (reported, not gated)`);
  if (verbose) {
    for (const cls of GATED) {
      console.log(`\n${cls} offenders (${offenders[cls].length}):`);
      for (const q of offenders[cls]) console.log(`  ${q}`);
    }
    for (const cls of ['nested', 'root'] as const) {
      console.log(`\n${cls} offenders (${offenders[cls].length}):`);
      for (const q of offenders[cls]) console.log(`  ${q}`);
    }
    console.log(`\ntemp-b-tree offenders (first 20 of ${tempOffenders.length}):`);
    for (const q of tempOffenders.slice(0, 20)) console.log(`  ${q}`);
  }

  const failures: string[] = [];
  for (const cls of GATED) for (const q of offenders[cls]) failures.push(`${GATE_REASON[cls]}: ${q}`);
  const sorted = Object.fromEntries(Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)));
  if (record) {
    await Bun.write(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(`\nsql-plan --record: banked ${Object.keys(sorted).length} query/queries with a nested base scan — put the reason in the commit message`);
  } else {
    for (const [q, n] of Object.entries(sorted)) {
      const was = expected[q] ?? 0;
      if (n > was) failures.push(`nested base scans ${was} → ${n} (a new inner-loop/correlated full scan — check it scales, then --record): ${q}`);
    }
    for (const [q, was] of Object.entries(expected)) {
      const n = sorted[q] ?? 0;
      if (n < was) failures.push(`nested base scans ${was} → ${n} (improved or no longer planned — re-record to keep the ratchet tight): ${q}`);
    }
  }
  if (failures.length) {
    console.error(`\nFAIL: ${failures.length} plan-shape finding(s):`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log('\nOK: every gated class is empty; nested base scans match the baseline.');
}

/** The classes gated at zero: nothing a query MEANS needs any of them. */
const GATED = ['unconstrained-virtual', 'root-non-element', 'automatic-index', 'weak-prefix'] as const;
const GATE_REASON: Record<(typeof GATED)[number], string> = {
  'unconstrained-virtual': 'unconstrained property_fts scan (the whole full-text index per query)',
  'root-non-element': 'root scan of a non-element table (only a root V()/E() reads a whole table by meaning — a missing index?)',
  'automatic-index': 'automatic index on a base table (SQLite scans the whole table to build it, every run — a missing index?)',
  'weak-prefix': 'nested probe constrained by vocabulary columns only (label/key: a graph-sized slice re-read per outer row — a missing index?)',
};

if (import.meta.main) await main();
