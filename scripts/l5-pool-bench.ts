// L5 parallelism scaling bench — an INSTRUMENT, not a gate, and not part of any suite.
//
// WHY this exists. L5 is the biggest CI pole, and it is 100% SYNCHRONOUS CPU work
// (test/L5-properties/oracle.ts has no await): each traversal is compile → bun:sqlite → compare, on
// one JS thread. `bun test` is one process/one thread and does not parallelise across files, so the
// only lever is more OS threads/processes — and how far THIS workload scales on a given machine, and
// whether threads or processes win, is machine-specific and must be measured, not reasoned.
//
// WHAT it measures — three modes over one FIXED working set so every row does identical work:
//   THREADS — N worker_threads in one process (shared heap/GC), a static slice each.
//   PROCS   — N child `bun` processes (independent heaps), a static slice each; mirrors `test:shard`.
//   HYBRID  — a P×T grid: P child processes, each running T worker threads over its sub-slice.
// All three partition statically (one message per worker), so the wall is bounded by the slowest
// slice — the honest number for shard-style parallelism — and threads-vs-procs isolates exactly one
// variable: shared heap/GC vs independent heaps.
//
// Every row also reports PEAK RSS, because throughput between threads and procs is near-identical on a
// big box and memory is the tiebreaker: THREADS is one process (its peak RSS); PROCS/HYBRID is N
// processes (the SUM of their peak RSS — N copies of the compiler module graph). That sum is what makes
// processes cost more memory than threads for the same parallelism.
//
// Zero new dependencies (node:worker_threads/child_process/os/url). Runs to a clean process.exit(0) to
// dodge a bun teardown panic seen when tearing down many workers at once (fires after all data prints).
//
// Run:  bun scripts/l5-pool-bench.ts
//       WORKERS=1,2,4,8,16,24 WORKSET=1500 MODE=both  bun scripts/l5-pool-bench.ts
//       MODE=hybrid PROCS=1,2,4 TPP=1,2,4 WORKSET=1500 bun scripts/l5-pool-bench.ts
//   WORKERS  pool sizes to sweep for threads/procs (default: 1,2,4,8,… doubling up to core count)
//   WORKSET  leading corpus traversals per row (default 800)
//   MODE     threads | procs | both | hybrid   (default both)
//   PROCS/TPP  hybrid grid: process counts × threads-per-process (defaults 1,2,4 × 1,2,4)
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

type Tally = { executed: number; diverged: number };
type Timed = Tally & { ms: number; spawnMs: number };
type Msg = { ready?: true; done?: true; executed: number; diverged: number };

// Run a corpus slice in THIS thread/process. Mirrors differential.test.ts exactly: one shared store for
// the `ran` coverage check, and `differential`'s own fresh mint for the fast-on-vs-off comparison —
// replicating the real cost model, since a cheaper harness would measure a workload we don't run.
async function makeRunner(): Promise<(q: string) => Tally> {
  const { differential, ran } = await import('../test/L5-properties/oracle.ts');
  const { seeded, isNondeterministic } = await import('../test/support/graph.ts');
  const { MODERN_SEED } = await import('../test/fixtures/seed-modern.ts');
  const shared = seeded(MODERN_SEED);
  const mint = () => seeded(MODERN_SEED);
  return (q: string): Tally => {
    try {
      if (ran(shared, q) && !isNondeterministic(q))
        return { executed: 1, diverged: differential(mint, q).length };
    } catch { /* a throw is identical on both sides; it just doesn't count as executed */ }
    return { executed: 0, diverged: 0 };
  };
}

// A static-partition thread pool over corpus[off, off+count): spawn T workers, give each one contiguous
// sub-slice, collect one result each. ONE message per worker each way, deliberately — hundreds of
// sub-10ms round-trips tripped a bun quirk where a worker→main message failed to wake an idle main loop
// and the pool deadlocked. Used by BOTH the main THREADS sweep and each HYBRID child.
async function runThreadPool(off: number, count: number, T: number): Promise<Timed> {
  const onResult = new WeakMap<Worker, (m: Msg) => void>();
  const workers: Worker[] = [];
  const s0 = performance.now();
  await Promise.all(Array.from({ length: T }, () => {
    const w = new Worker(SELF);
    workers.push(w);
    return new Promise<void>((res) => w.on('message', (m: Msg) => {
      if (m.ready) res();
      else if (m.done) onResult.get(w)?.(m);
    }));
  }));
  const spawnMs = performance.now() - s0;
  const per = Math.ceil(count / T);
  const run = await new Promise<Tally & { ms: number }>((resolve) => {
    let remaining = T, executed = 0, diverged = 0;
    const t0 = performance.now();
    workers.forEach((w, i) => {
      onResult.set(w, (m) => {
        executed += m.executed; diverged += m.diverged;
        if (--remaining === 0) resolve({ executed, diverged, ms: performance.now() - t0 });
      });
      const o = off + i * per;
      w.postMessage({ off: o, count: Math.max(0, Math.min(per, off + count - o)) });
    });
  });
  await Promise.all(workers.map((w) => w.terminate()));
  return { ...run, spawnMs };
}

// Peak-RSS sampler for the CURRENT process (used for THREADS, where all workers share this heap).
const peakSampler = () => {
  let peak = process.memoryUsage().rss;
  const t = setInterval(() => { const r = process.memoryUsage().rss; if (r > peak) peak = r; }, 25);
  return () => { clearInterval(t); return peak; };
};

if (!isMainThread) {
  // ---------- worker (in ANY process): run one static slice per message, post one result ----------
  // Checked FIRST: a worker is a worker whether spawned by the top-level main or by a HYBRID child, and
  // it inherits the child's CHILD_SLICE env, so the child-process branch below must not catch it.
  const runOne = await makeRunner();
  const corpus = readCorpus();
  parentPort!.on('message', (msg: { off: number; count: number } | null) => {
    if (msg === null) { parentPort!.close(); return; }
    let executed = 0, diverged = 0;
    for (const q of corpus.slice(msg.off, msg.off + msg.count)) {
      const r = runOne(q); executed += r.executed; diverged += r.diverged;
    }
    parentPort!.postMessage({ done: true, executed, diverged });
  });
  parentPort!.postMessage({ ready: true });
} else if (process.env.CHILD_SLICE) {
  // ---------- child process: run "off:count", optionally across CHILD_THREADS threads; print JSON ----
  const [off, count] = process.env.CHILD_SLICE.split(':').map(Number);
  const T = Number(process.env.CHILD_THREADS ?? 1);
  let out: Tally & { ms: number };
  if (T <= 1) {
    const runOne = await makeRunner();
    const corpus = readCorpus();
    const t0 = performance.now();
    let executed = 0, diverged = 0;
    for (const q of corpus.slice(off, off + count)) { const r = runOne(q); executed += r.executed; diverged += r.diverged; }
    out = { executed, diverged, ms: performance.now() - t0 };
  } else {
    const r = await runThreadPool(off, count, T);
    out = { executed: r.executed, diverged: r.diverged, ms: r.ms + r.spawnMs };
  }
  // maxRSS is this process's PEAK resident set, in KB on Linux (node/bun getrusage). Summed by the parent.
  console.log(JSON.stringify({ ...out, rssKB: process.resourceUsage().maxRSS }));
} else {
  // ---------- MAIN: sweep, print scaling tables with memory ----------
  const cores = availableParallelism();
  const parseList = (s?: string) => s?.split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
  const ladder = () => { const a: number[] = []; for (let n = 1; n < cores; n *= 2) a.push(n); a.push(cores); return a; };
  const WORKERS = parseList(process.env.WORKERS) ?? ladder();
  const WORKSET = Number(process.env.WORKSET ?? 800);
  const MODE = (process.env.MODE ?? 'both').toLowerCase();
  const workset = readCorpus().slice(0, WORKSET);
  const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(2)}GB`;

  // PROCS/HYBRID: nProc child processes, tpp threads each, over a static partition of the workset.
  const runProcs = (nProc: number, tpp = 1): Promise<Timed & { rssBytes: number }> => {
    const per = Math.ceil(workset.length / nProc);
    const t0 = performance.now();
    const kids = Array.from({ length: nProc }, (_, i) => {
      const off = i * per, count = Math.min(per, workset.length - off);
      const child = spawn(process.execPath, [SELF], {
        env: { ...process.env, CHILD_SLICE: `${off}:${Math.max(0, count)}`, CHILD_THREADS: String(tpp), WORKERS: '', MODE: '' },
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let buf = '';
      child.stdout!.on('data', (d) => { buf += d; });
      return new Promise<Tally & { ms: number; rssKB: number }>((res) =>
        child.on('close', () => res(JSON.parse(buf.trim().split('\n').pop() || '{"executed":0,"diverged":0,"ms":0,"rssKB":0}'))));
    });
    return Promise.all(kids).then((rs) => ({
      executed: rs.reduce((a, r) => a + r.executed, 0),
      diverged: rs.reduce((a, r) => a + r.diverged, 0),
      ms: performance.now() - t0,                                  // wall = slowest child, startup included
      spawnMs: 0,
      rssBytes: rs.reduce((a, r) => a + (r.rssKB || 0) * 1024, 0), // SUM across processes — the real cost
    }));
  };

  const HEAD = 'label      spawn     wall    exec/s   speedup   peakRSS    (exec/div)';
  const printRow = (label: string, spawnMs: number, r: Timed & { rssBytes: number }, base: number) => {
    const rate = r.executed / (r.ms / 1000);
    console.log(
      `${label.padEnd(8)} ${(spawnMs / 1000).toFixed(1).padStart(6)}s  ${(r.ms / 1000).toFixed(1).padStart(6)}s  ` +
      `${rate.toFixed(1).padStart(7)}  ${(rate / (base || rate)).toFixed(2).padStart(6)}x  ${gb(r.rssBytes).padStart(8)}   (${r.executed}/${r.diverged})`);
    return rate;
  };

  console.log(`cores=${cores}  workset=${workset.length} traversals  mode=${MODE}`);

  if (MODE === 'threads' || MODE === 'both') {
    console.log(`\n=== THREADS (static partition across worker_threads, ONE shared heap) ===\n${HEAD}`);
    let base = 0;
    for (const n of WORKERS) {
      const stop = peakSampler();
      const r = await runThreadPool(0, workset.length, n);
      const rssBytes = stop();
      const rate = printRow(String(n), r.spawnMs, { ...r, rssBytes }, base);
      if (!base) base = rate;
    }
  }
  if (MODE === 'procs' || MODE === 'both') {
    console.log(`\n=== PROCS (static partition across child processes, N heaps — RSS summed) ===\n${HEAD}`);
    let base = 0;
    for (const n of WORKERS) {
      const r = await runProcs(n, 1);
      const rate = printRow(String(n), r.spawnMs, r, base);
      if (!base) base = rate;
    }
  }
  if (MODE === 'hybrid') {
    const PROCS = parseList(process.env.PROCS) ?? [1, 2, 4];
    const TPP = parseList(process.env.TPP) ?? [1, 2, 4];
    console.log(`\n=== HYBRID (P processes × T threads each — RSS summed across processes) ===\n${HEAD}`);
    let base = 0;
    for (const p of PROCS) for (const t of TPP) {
      const r = await runProcs(p, t);
      const rate = printRow(`${p}x${t}`, r.spawnMs, r, base);
      if (!base) base = rate;
    }
  }

  console.log('\nwall INCLUDES startup for every mode (spawn column is that startup, informational).');
  console.log('peakRSS: THREADS = the one process; PROCS/HYBRID = SUM of the child processes\' peaks.');
  console.log('THREADS shares one heap/GC; PROCS/HYBRID trade more memory for independent heaps.');
  process.exit(0);   // dodge a bun teardown panic tearing down many workers (fires after all data prints)
}
