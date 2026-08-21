#!/usr/bin/env bun
/**
 * SQL PLAN — EXPLAIN QUERY PLAN over every compiled corpus read, to catch a generated query that
 * cannot use an index. This is the PRODUCTION-relevant companion to profiling: CPU-profiling the
 * suite measures the COMPILER (parse/lower), because the fixtures are six vertices and SQLite
 * execution is ~1% of the run — so it says nothing about query cost at scale. Plan SHAPE does: a
 * base-table access that SCANs rather than SEARCHes an index is slow on a real graph however cheap it
 * is on six rows.
 *
 * Two kinds of finding, and they are NOT the same:
 *   BASE-TABLE SCAN — a full scan of a real table (nodes/edges/*_properties/labels/…). This is the
 *     hard signal: base tables are reached through COVERING indexes (e_out(src,label,tgt),
 *     e_in(tgt,label,src), the property indexes), which SQLite's planner prefers at ANY size, so a
 *     base-table scan means the emitted SQL structurally cannot use one. Zero today; a nonzero count
 *     EXITS 1 (this half is a gate) so a compiler change that drops an index path fails loudly.
 *   TEMP B-TREE / CTE SCAN — a sort/group without an index, or a scan of an intermediate CTE result.
 *     Reported, never gated: scanning a pipeline stage is inherent to a CTE-chain compiler, and a
 *     GROUP BY over a computed value has no index to use. These need judgement, and the join-order the
 *     planner picks for them is the one thing the six-vertex fixture does NOT predict at scale.
 *
 * Seeds MODERN_SEED for schema + realistic label/key ids; that suffices for the scan metric per the
 * covering-index argument above. For planner-accurate ORDERING analysis, run against a large synthetic
 * graph instead — a separate exercise this instrument deliberately does not bake in.
 *
 *   bun scripts/sql-plan.ts            # summary + exit 1 iff any base-table scan
 *   bun scripts/sql-plan.ts --verbose  # also list the temp-b-tree offenders
 */
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { compile } from '../src/compiler/compiler.ts';
import { runSteps } from '../src/program.ts';
import { MODERN_SEED } from '../test/fixtures/seed-modern.ts';

const BASE = new Set(['labels', 'nodes', 'vertex_labels', 'vertex_properties', 'edges', 'edge_properties', 'vertex_property_cardinality', 'property_fts']);
const verbose = Bun.argv.includes('--verbose');

const corpus = (await Bun.file(new URL('../test/L1-corpus/corpus.txt', import.meta.url)).text())
  .split('\n').filter(Boolean);

// Seed the reference graph through the ordinary compile+run path (write traversals → a `program`).
const store = new GraphStore(new BunSqlite(':memory:'));
for (const q of MODERN_SEED) {
  const p = compile(q, {}, undefined);
  if (p.kind === 'program') { for (const _ of runSteps(store, p)) { /* drain */ } }
  else store.query(p.sql, p.binds);
}

let planned = 0, withBaseScan = 0, withTempBtree = 0;
const baseScans: Record<string, number> = {};
const baseOffenders: string[] = [];
const tempOffenders: string[] = [];

for (const q of corpus) {
  let p: ReturnType<typeof compile>;
  try { p = compile(q, {}, undefined); } catch { continue; }      // a decline is not a plan-quality question
  if (p.kind !== 'read' || !p.sql) continue;                        // only single-statement reads have one plan
  let plan: { detail: string }[];
  try { plan = store.query('EXPLAIN QUERY PLAN ' + p.sql, p.binds); } catch { continue; }
  planned++;
  let baseHit = false, tempHit = false;
  for (const row of plan) {
    const d = String(row.detail);
    const scan = d.match(/^SCAN (\w+)/);
    if (scan && BASE.has(scan[1])) { baseHit = true; baseScans[scan[1]] = (baseScans[scan[1]] ?? 0) + 1; }
    if (/USE TEMP B-TREE/.test(d)) tempHit = true;
  }
  if (baseHit) { withBaseScan++; baseOffenders.push(q); }
  if (tempHit) { withTempBtree++; tempOffenders.push(q); }
}

console.log(`sql-plan: ${planned} corpus reads planned via EXPLAIN QUERY PLAN`);
console.log(`  base-table full scans : ${withBaseScan}${withBaseScan ? ' — ' + JSON.stringify(baseScans) : '  (all base access is index-served)'}`);
console.log(`  temp b-tree (sort/group without index): ${withTempBtree}  (reported, not gated)`);

if (withBaseScan && verbose) {
  console.log('\nbase-table SCAN offenders:');
  for (const q of baseOffenders.slice(0, 40)) console.log(`  ${q}`);
}
if (verbose) {
  console.log(`\ntemp-b-tree offenders (first 20 of ${tempOffenders.length}):`);
  for (const q of tempOffenders.slice(0, 20)) console.log(`  ${q}`);
}

if (withBaseScan) {
  console.error(`\nFAIL: ${withBaseScan} query(ies) full-scan a base table — a dropped index path. Run with --verbose.`);
  process.exit(1);
}
console.log('\nOK: no base-table scan — every base access is index-served.');
