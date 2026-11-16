#!/usr/bin/env bun
/**
 * SCALING PROBE — the plan-cost instrument for the scoped-relation connector
 * (`docs/2026-11-15-compositional-coverage-plan.md` §5 cost discipline, Phase 3 item (b)).
 *
 * Runs each probe shape over a synthetic graph at N vertices (~2.5 out-edges each) under the three
 * `correlatedChild` configurations and reports, per shape and N: the median execute time, the SQL bytes and
 * the JOIN count of the plan.
 *
 *   ON    — the shipping default: the ladder of correlated routes first, the connector its fallback;
 *   OFF   — the connector first, the ladder its fallback;
 *   CONN  — the connector ALONE (`MOGWAI_CONNECTOR_ONLY=1`): what the general path costs with no ladder.
 *
 * `MOGWAI_CONNECTOR_ONLY` is read once at module load, so each configuration is a CHILD process
 * (`--child <mode> <n>`) and this parent only tabulates. An INSTRUMENT, deliberately not in `ci`: its numbers
 * are wall-clock and need judgement.
 *
 *   bun scripts/scaling-probe.ts                  # 1k and 8k, every shape
 *   bun scripts/scaling-probe.ts --sizes 1000     # one size
 *   bun scripts/scaling-probe.ts --only nested    # shapes whose name contains the text
 *   bun scripts/scaling-probe.ts --sql <name>     # print the plan's SQL + EXPLAIN QUERY PLAN per mode (1k)
 */
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { compile } from '../src/compiler/compiler.ts';
import { loadBulk, type BulkEdge, type BulkVertex } from '../src/bulk.ts';

interface Shape { readonly name: string; readonly query: string }

/** §5's shapes, then the connector-only and nested ones the G2 measurement added. */
const SHAPES: readonly Shape[] = [
  { name: 'order.by(select)', query: "g.V().as('a').out().order().by(select('a').values('name')).values('name')" },
  { name: 'project.by(age)', query: "g.V().project('x').by('age')" },
  { name: 'map(values)', query: "g.V().map(values('age'))" },
  { name: 'where(count.is)', query: 'g.V().where(out().count().is(gt(1)))' },
  { name: 'dedup.by(name)', query: "g.V().dedup().by('name')" },
  { name: 'project.coalesce', query: "g.V().project('n','c').by('name').by(coalesce(values('age'),constant(0)))" },
  { name: 'map(out.values)', query: "g.V().map(out().values('name'))" },
  { name: 'project.by(in.fold)', query: "g.V().project('n','m').by('name').by(in('knows').values('name').fold())" },
  { name: 'where(simplePath)', query: 'g.V().where(out().simplePath())' },
  { name: 'nested where x3', query: "g.V().where(out().where(out().where(has('age',gt(40)))))" },
  { name: 'nested project', query: "g.V().project('a').by(project('b').by(out().count()))" },
  { name: 'not(out.has)', query: "g.V().not(out().has('age',gt(40)))" },
  { name: 'where(out.out)', query: "g.V().where(out('knows').out('knows'))" },
  { name: 'map(out.count)', query: 'g.V().map(out().count())' },
];

const MODES = { ON: {}, OFF: {}, CONN: { MOGWAI_CONNECTOR_ONLY: '1' } } as const;
type Mode = keyof typeof MODES;

/** Deterministic xorshift, so every child and every run sees one graph. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 0x100000000; };
}

function graph(n: number): GraphStore {
  const store = new GraphStore(new BunSqlite(':memory:'));
  const r = rng(7);
  const vertices: BulkVertex[] = [];
  for (let i = 1; i <= n; i++) {
    const software = i % 5 === 0;
    const properties = [{ key: 'name', value: `${software ? 's' : 'p'}${i}` }];
    if (!software && r() < 0.9) properties.push({ key: 'age', value: 18 + Math.floor(r() * 50) } as never);
    vertices.push({ id: i, labels: [software ? 'software' : 'person'], properties });
  }
  const edges: BulkEdge[] = [];
  for (let i = 1; i <= n; i++) {
    const k = Math.floor(r() * 6); // 0..5, mean 2.5
    for (let j = 0; j < k; j++) {
      const t = 1 + Math.floor(r() * n);
      edges.push({ label: t % 5 === 0 ? 'created' : 'knows', src: i, tgt: t, properties: [{ key: 'weight', value: r() }] });
    }
  }
  loadBulk(store, vertices, edges);
  return store;
}

interface Row { readonly name: string; readonly ms: number | null; readonly bytes: number; readonly joins: number; readonly rows: number; readonly error?: string }

function child(mode: Mode, n: number, only: string | undefined, sqlOf: string | undefined): void {
  const store = graph(n);
  const fastPaths = { correlatedChild: mode === 'ON' };
  const out: Row[] = [];
  for (const shape of SHAPES) {
    if (only && !shape.name.includes(only)) continue;
    if (sqlOf && shape.name !== sqlOf) continue;
    try {
      const plan = compile(shape.query, {}, { fastPaths });
      if (plan.kind !== 'read' || !plan.sql) { out.push({ name: shape.name, ms: null, bytes: 0, joins: 0, rows: 0, error: plan.kind }); continue; }
      if (sqlOf) {
        console.log(`---- ${mode} ----\n${plan.sql}\n`);
        for (const row of store.query('EXPLAIN QUERY PLAN ' + plan.sql, plan.binds)) console.log(`  ${row.id}/${row.parent} ${row.detail}`);
        continue;
      }
      let rows = 0;
      const times: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now();
        rows = store.query(plan.sql, plan.binds).length;
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      out.push({ name: shape.name, ms: times[0]!, bytes: plan.sql.length, joins: (plan.sql.match(/\bJOIN\b/g) ?? []).length, rows });
    } catch (error) {
      out.push({ name: shape.name, ms: null, bytes: 0, joins: 0, rows: 0, error: (error as Error).constructor.name });
    }
  }
  if (!sqlOf) console.log(JSON.stringify(out));
}

const argv = Bun.argv.slice(2);
const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined; };

if (argv[0] === '--child') {
  child(argv[1] as Mode, Number(argv[2]), flag('--only'), flag('--sql'));
} else {
  const sizes = (flag('--sizes') ?? '1000,8000').split(',').map(Number);
  const only = flag('--only'), sqlOf = flag('--sql');
  const run = (mode: Mode, n: number): string => {
    const extra = [...(only ? ['--only', only] : []), ...(sqlOf ? ['--sql', sqlOf] : [])];
    const proc = Bun.spawnSync(['bun', import.meta.path, '--child', mode, String(n), ...extra], { env: { ...process.env, ...MODES[mode] }, stderr: 'inherit' });
    return proc.stdout.toString();
  };
  if (sqlOf) {
    for (const mode of Object.keys(MODES) as Mode[]) console.log(run(mode, sizes[0]!));
  } else {
    const results = new Map<string, Map<string, Row>>(); // `${mode}@${n}` → shape → row
    for (const n of sizes) for (const mode of Object.keys(MODES) as Mode[]) {
      const rows = JSON.parse(run(mode, n).trim().split('\n').pop()!) as Row[];
      results.set(`${mode}@${n}`, new Map(rows.map((r) => [r.name, r])));
    }
    const cell = (r: Row | undefined): string => (!r ? '-' : r.ms === null ? `✗${r.error ?? ''}` : r.ms.toFixed(1));
    const header = ['shape', ...sizes.flatMap((n) => (Object.keys(MODES) as Mode[]).map((m) => `${m}@${n / 1000}k`)), 'CONN/ON', 'bytes ON/CONN', 'joins ON/CONN'];
    console.log(`| ${header.join(' | ')} |`);
    console.log(`|${header.map(() => '---').join('|')}|`);
    const last = sizes[sizes.length - 1]!;
    for (const shape of SHAPES) {
      if (only && !shape.name.includes(only)) continue;
      const at = (m: Mode, n: number) => results.get(`${m}@${n}`)?.get(shape.name);
      const on = at('ON', last), conn = at('CONN', last);
      const ratio = on?.ms && conn?.ms ? (conn.ms / on.ms).toFixed(2) : '-';
      console.log(`| ${[shape.name, ...sizes.flatMap((n) => (Object.keys(MODES) as Mode[]).map((m) => cell(at(m, n)))), ratio,
        `${on?.bytes ?? '-'}/${conn?.bytes ?? '-'}`, `${on?.joins ?? '-'}/${conn?.joins ?? '-'}`].join(' | ')} |`);
    }
  }
}
