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
 * Only a `SCAN` of a base table is a finding — a `SEARCH` is index-served by definition. Each base SCAN is
 * classified by its POSITION in the EQP tree (`id`/`parent`), and the three classes are not alike:
 *
 *   ROOT — the outermost loop of an uncorrelated block: the first loop under its parent. A root `g.V()` /
 *     `g.E()` reads every element BY MEANING, so this is reported, never gated: gating it would force a
 *     decline or an index that serves nothing.
 *   NESTED — an inner loop (a base SCAN after a sibling loop under the same parent), or any base SCAN under
 *     a `CORRELATED … SUBQUERY` node, which re-runs per outer row. This is the N² signature — but not
 *     proof of it (`g.V(1).V()`'s outer loop is one row), so it is a RATCHET needing judgement: each query's
 *     nested count is held to `scripts/sql-plan-baseline.json`, and a query that GAINS one fails. A query
 *     that loses one fails too, so the baseline is re-recorded and stays tight (`--record`; say why in the
 *     commit — a corpus pin bump that adds queries re-records and says so).
 *   UNCONSTRAINED VIRTUAL — a scan of the `property_fts` virtual table whose idxStr carries NO constraint
 *     (a bare `INDEX 0:`): the whole full-text index read per query. The one STRUCTURAL class (nothing a
 *     query means needs it — the probe always has a pattern to hand FTS5), so it is a hard gate at zero.
 *     A `0:=` rowid seek or a `0:L…`/`0:M…` constraint is index-served and not flagged.
 *
 * TEMP B-TREE (a sort/group without an index) is reported, never gated: a GROUP BY over a computed value
 * has no index to use.
 *
 * Plans single-statement reads only; a `program` (writes) or a segment plan (a barrier `call()`) has no one
 * plan and is skipped. `call()` reads compile against the standard service registry, so `tinker.search`
 * — the second user of `property_fts` — is planned and covered by the hard gate.
 *
 *   bun scripts/sql-plan.ts            # summary; exit 1 on an unconstrained virtual scan or a nested-baseline move
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

/** What the classifier needs from the schema: which names are base tables (and which of those are
 *  virtual), and which table each named index belongs to. */
export interface SchemaFacts { readonly tables: ReadonlySet<string>; readonly virtual: ReadonlySet<string>; readonly indexTable: ReadonlyMap<string, string> }

export type ScanClass = 'root' | 'nested' | 'unconstrained-virtual';
export interface BaseScan { readonly cls: ScanClass; readonly table: string; readonly alias: string; readonly detail: string }

export function schemaFacts(store: GraphStore): SchemaFacts {
  const rows = store.query(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index')`, []) as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const tables = new Set<string>(), virtual = new Set<string>(), indexTable = new Map<string, string>();
  for (const r of rows) {
    if (r.type === 'index') { indexTable.set(r.name, r.tbl_name); continue; }
    tables.add(r.name);
    if (/^CREATE VIRTUAL TABLE/i.test(r.sql ?? '')) virtual.add(r.name);
  }
  return { tables, virtual, indexTable };
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

/** Classify every base-table SCAN in one plan by its EQP-tree position. */
export function classify(plan: readonly PlanRow[], sql: string, facts: SchemaFacts): BaseScan[] {
  const aliases = aliasTables(sql, facts);
  const byId = new Map(plan.map((row) => [row.id, row]));
  const correlatedAncestor = (row: PlanRow): boolean => {
    for (let p = byId.get(row.parent); p; p = byId.get(p.parent)) if (/^CORRELATED /.test(p.detail)) return true;
    return false;
  };
  const out: BaseScan[] = [];
  for (const row of plan) {
    const m = row.detail.match(LOOP);
    if (!m) continue;
    const table = aliases.get(m[2]!) ?? (facts.tables.has(m[2]!) ? m[2]! : undefined);
    const index = row.detail.match(/USING (?:COVERING )?INDEX (\S+)/)?.[1];
    const owner = index === undefined ? undefined : facts.indexTable.get(index);
    if (table !== undefined && owner !== undefined && owner !== table)
      throw new Error(`sql-plan: ${m[2]} resolved to ${table} but loops over index ${index} of ${owner}`);
    if (m[1] !== 'SCAN' || table === undefined) continue;     // a SEARCH is index-served; a derived relation is not a base read
    if (facts.virtual.has(table)) {
      if (/VIRTUAL TABLE INDEX \d+:$/.test(row.detail)) out.push({ cls: 'unconstrained-virtual', table, alias: m[2]!, detail: row.detail });
      continue;                                               // a constrained virtual scan (`0:=`, `0:L4`) is index-served
    }
    const innerLoop = plan.some((s) => s.parent === row.parent && s.id < row.id && LOOP.test(s.detail));
    out.push({ cls: innerLoop || correlatedAncestor(row) ? 'nested' : 'root', table, alias: m[2]!, detail: row.detail });
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
  const offenders: Record<ScanClass, string[]> = { root: [], nested: [], 'unconstrained-virtual': [] };
  const tempOffenders: string[] = [];
  const nested: Record<string, number> = {};

  for (const q of corpus) {
    const got = planOf(store, q);
    if (!got) continue;
    planned++;
    const scans = classify(got.plan, got.sql, facts);
    for (const cls of ['root', 'nested', 'unconstrained-virtual'] as const) {
      const n = scans.filter((s) => s.cls === cls).length;
      if (n) offenders[cls].push(q);
      if (cls === 'nested' && n) nested[q] = n;
    }
    if (got.plan.some((row) => /USE TEMP B-TREE/.test(row.detail))) { withTempBtree++; tempOffenders.push(q); }
  }

  console.log(`sql-plan: ${planned} corpus reads planned via EXPLAIN QUERY PLAN`);
  console.log(`  root base scans (a read of every element by meaning) : ${offenders.root.length}  (reported, not gated)`);
  console.log(`  nested base scans (inner loop / under CORRELATED)    : ${offenders.nested.length}  (ratcheted against sql-plan-baseline.json)`);
  console.log(`  unconstrained virtual scans (property_fts, no probe) : ${offenders['unconstrained-virtual'].length}  (gate at zero)`);
  console.log(`  temp b-tree (sort/group without index)               : ${withTempBtree}  (reported, not gated)`);
  if (verbose) {
    for (const cls of ['unconstrained-virtual', 'nested', 'root'] as const) {
      console.log(`\n${cls} offenders (${offenders[cls].length}):`);
      for (const q of offenders[cls]) console.log(`  ${q}`);
    }
    console.log(`\ntemp-b-tree offenders (first 20 of ${tempOffenders.length}):`);
    for (const q of tempOffenders.slice(0, 20)) console.log(`  ${q}`);
  }

  const failures: string[] = [];
  for (const q of offenders['unconstrained-virtual']) failures.push(`unconstrained property_fts scan (the whole full-text index per query): ${q}`);
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
  console.log('\nOK: no unconstrained virtual scan; nested base scans match the baseline.');
}

if (import.meta.main) await main();
