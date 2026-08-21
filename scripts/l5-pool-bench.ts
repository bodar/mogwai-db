// L5 parallelism scaling bench — an INSTRUMENT, not a gate, and not part of any suite.
//
// WHY this exists. L5 is the single biggest CI pole (~380s of the ~640s `test` task, measured
// 2026-08-21), and it is 100% SYNCHRONOUS CPU work: `test/L5-properties/oracle.ts` has no `await`
// anywhere — each traversal is compile → bun:sqlite → compare, on one JS thread. `bun test` is one
// process/one thread and does not parallelise across files, so nothing inside a single run overlaps.
// The only lever that touches synchronous CPU work is more OS threads/processes — which raises the
// question this script answers on a GIVEN machine: how far does each flavour of parallelism actually
// scale THIS workload, and where does it plateau?
//
// The answer is machine-specific and counterintuitive, which is the whole reason it must be measured
// rather than reasoned. Measured on the 4-core web-session container:
//   * a pure-CPU busy loop scaled ~linearly (4× on 4 cores) — the box is not throttled;
//   * this workload only reached ~2.4× across separate PROCESSES and ~1.7× across worker THREADS.
// The gap is allocation: every read traversal MINTS AND RE-SEEDS a fresh in-memory SQLite store
// (`seeded(MODERN_SEED)`), and that churn — not the CPU — is the ceiling. THREADS share one process
// heap and one GC, so they contend on the same allocator and scale WORSE than processes, each of which
// owns its heap. A 24-core box will therefore NOT give 24×; where it plateaus, and whether threads or
// processes win there, is exactly what decides which architecture (if any) is worth building.
//
// WHAT it measures. Two modes over one FIXED working set so every row does identical work:
//   THREADS — a persistent, WORK-STEALING pool of N `node:worker_threads` (stealing because a static
//             split suffers load imbalance: the first measurement had one slice 2× heavier per
//             traversal). Only query STRINGS cross the boundary; the graph/store never leaves a worker.
//   PROCS   — N child `bun` processes over a STATIC partition of the same set (this mirrors the repo's
//             existing `test:shard` mechanism; static, so its wall is bounded by the unluckiest slice —
//             the honest number for shard-style parallelism, imbalance included).
// Pool/spawn cost is timed SEPARATELY and excluded from throughput — a long-lived pool pays it once, so
// folding it into per-traversal time would slander the steady state. It is reported on its own line.
//
// Zero new dependencies: `node:worker_threads`, `node:child_process`, `node:os` are all built in.
//
// Run:  bun scripts/l5-pool-bench.ts
//       WORKERS=1,2,4,8,12,16,24 WORKSET=1500 MODE=both bun scripts/l5-pool-bench.ts
//   WORKERS  comma list of pool sizes to sweep (default: 1,2,4,8,… doubling up to core count)
//   WORKSET  leading corpus traversals to run per row (default 800)
//   MODE     threads | procs | both   (default both)
import { isMainThread, Worker, parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

// This file's own filesystem path. `import.meta.url` is a file:// URL — fine for `new Worker(url)`,
// but `bun <arg>` needs a real path (a file:// arg reads as an unresolvable module specifier).
const SELF = fileURLToPath(import.meta.url);

const CORPUS_URL = new URL('../test/L1-corpus/corpus.txt', import.meta.url);
const readCorpus = () => readFileSync(CORPUS_URL, 'utf8').split('\n').filter(Boolean);

// ---- shared leaf: run a slice of the corpus in THIS thread/process, return {executed, diverged} ----
// Mirrors differential.test.ts EXACTLY: one shared store for the `ran` coverage check across the whole
// slice, and `differential`'s own fresh mint for the actual fast-on-vs-off comparison. Replicating the
// real test's cost model is the point — a cheaper harness would measure a workload we don't run.
async function makeRunner() {
  const { differential, ran } = await import('../test/L5-properties/oracle.ts');
  const { seeded, isNondeterministic } = await import('../test/support/graph.ts');
  const { MODERN_SEED } = await import('../test/fixtures/seed-modern.ts');
  const shared = seeded(MODERN_SEED);
  const mint = () => seeded(MODERN_SEED);
  return (q: string): { executed: number; diverged: number } => {
    try {
      if (ran(shared, q) && !isNondeterministic(q))
        return { executed: 1, diverged: differential(mint, q).length };
    } catch { /* a throw is identical on both sides; it just doesn't count as executed */ }
    return { executed: 0, diverged: 0 };
  };
}

if (process.env.CHILD_SLICE) {
  // ---------- PROC-mode child: run one static slice "offset:count", print a JSON timing line ----------
  const [off, count] = process.env.CHILD_SLICE.split(':').map(Number);
  const slice = readCorpus().slice(off, off + count);
  const runOne = await makeRunner();
  const t0 = performance.now();
  let executed = 0, diverged = 0;
  for (const q of slice) { const r = runOne(q); executed += r.executed; diverged += r.diverged; }
  console.log(JSON.stringify({ executed, diverged, ms: performance.now() - t0 }));
} else if (!isMainThread) {
  // ---------- THREADS-mode worker: serve one query per message from the work-stealing pool ----------
  const runOne = await makeRunner();
  parentPort!.on('message', (q: string | null) => {
    if (q === null) { parentPort!.close(); return; }
    const r = runOne(q);
    parentPort!.postMessage({ done: true, ...r });
  });
  parentPort!.postMessage({ ready: true });
} else {
  // ---------- MAIN: sweep worker counts, print scaling tables ----------
  const cores = availableParallelism();
  const parseList = (s?: string) => s?.split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
  const ladder = () => { const a: number[] = []; for (let n = 1; n < cores; n *= 2) a.push(n); a.push(cores); return a; };
  const WORKERS = parseList(process.env.WORKERS) ?? ladder();
  const WORKSET = Number(process.env.WORKSET ?? 800);
  const MODE = (process.env.MODE ?? 'both').toLowerCase();
  const workset = readCorpus().slice(0, WORKSET);

  // THREADS: spawn N workers, then hand each the next query the instant it returns (work stealing).
  const spawnThreads = (n: number): Promise<Worker[]> => {
    const ws = Array.from({ length: n }, () => new Worker(import.meta.url));
    return Promise.all(ws.map((w) => new Promise<Worker>((res) => w.once('message', () => res(w)))));
  };
  const runThreads = (workers: Worker[]) => new Promise<{ executed: number; diverged: number; ms: number }>((resolve) => {
    let next = 0, outstanding = 0, executed = 0, diverged = 0;
    const t0 = performance.now();
    const feed = (w: Worker) => { if (next < workset.length) { outstanding++; w.postMessage(workset[next++]); } };
    for (const w of workers) {
      w.on('message', (m: { done?: true; executed: number; diverged: number }) => {
        if (!m.done) return;
        outstanding--; executed += m.executed; diverged += m.diverged;
        if (next < workset.length) feed(w);
        else if (outstanding === 0) resolve({ executed, diverged, ms: performance.now() - t0 });
      });
      feed(w);
    }
  });

  // PROCS: N child `bun` processes over a static, contiguous partition of the same workset.
  const runProcs = (n: number): Promise<{ executed: number; diverged: number; ms: number; spawnMs: number }> => {
    const per = Math.ceil(workset.length / n);
    const s0 = performance.now();
    const kids = Array.from({ length: n }, (_, i) => {
      const off = i * per, count = Math.min(per, workset.length - off);
      const child = spawn(process.execPath, [SELF], {
        env: { ...process.env, CHILD_SLICE: `${off}:${Math.max(0, count)}`, WORKERS: '', MODE: '' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let out = '';
      child.stdout!.on('data', (d) => { out += d; });
      return new Promise<{ executed: number; diverged: number; ms: number }>((res) =>
        child.on('close', () => res(JSON.parse(out.trim().split('\n').pop() || '{"executed":0,"diverged":0,"ms":0}'))));
    });
    const t0 = performance.now();
    return Promise.all(kids).then((rs) => ({
      executed: rs.reduce((a, r) => a + r.executed, 0),
      diverged: rs.reduce((a, r) => a + r.diverged, 0),
      ms: performance.now() - t0,            // wall = slowest child (static split, imbalance included)
      spawnMs: t0 - s0,
    }));
  };

  const header = (label: string) => {
    console.log(`\n=== ${label} ===`);
    console.log('workers   spawn     wall    exec/s   speedup   (executed/diverged)');
  };
  const row = (n: number, spawnMs: number, r: { executed: number; diverged: number; ms: number }, base: number) => {
    const rate = r.executed / (r.ms / 1000);
    console.log(
      `${String(n).padStart(4)}   ${(spawnMs / 1000).toFixed(1).padStart(6)}s  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${rate.toFixed(1).padStart(7)}  ${(rate / (base || rate)).toFixed(2).padStart(6)}x   (${r.executed}/${r.diverged})`);
    return rate;
  };

  console.log(`cores=${cores}  workset=${workset.length} traversals  mode=${MODE}  sweeping workers=[${WORKERS.join(', ')}]`);

  if (MODE === 'threads' || MODE === 'both') {
    header('THREADS (work-stealing worker_threads pool, shared process heap)');
    let base = 0;
    for (const n of WORKERS) {
      const s0 = performance.now();
      const pool = await spawnThreads(n);
      const spawnMs = performance.now() - s0;
      const r = await runThreads(pool);
      await Promise.all(pool.map((w) => w.terminate()));
      const rate = row(n, spawnMs, r, base);
      if (!base) base = rate;
    }
  }
  if (MODE === 'procs' || MODE === 'both') {
    header('PROCS (static partition across child bun processes, independent heaps)');
    let base = 0;
    for (const n of WORKERS) {
      const r = await runProcs(n);
      const rate = row(n, r.spawnMs, r, base);
      if (!base) base = rate;
    }
  }
  console.log('\nspeedup is vs each table\'s first row.');
  console.log('THREADS exec/s is steady-state (pool spawn excluded, shown separately). PROCS wall');
  console.log('INCLUDES per-shard startup+import — inherent to shard parallelism, so its exec/s bakes');
  console.log('that in. THREADS shares one heap/GC; PROCS gives each shard its own — compare plateaus.');
}
