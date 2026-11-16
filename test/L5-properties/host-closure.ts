// The host-closure sweep — the engine behind `host-closure.test.ts` (and its re-record task).
//
// THE LAW (`docs/2026-11-15-compositional-coverage-plan.md` §3 Phase 0, cc0-host-law): for any body `b`
// that executes at the top level (`p.b` inline), every host `p.H(__.b)` should execute too — and agree
// with it semantically. The most direct measure of compositionality there is: a decline under a host of
// a body the root lowers is a SEAM gap by definition (cc1-classify's class (a)), not a missing step.
//
// Two halves, gated differently:
//   • CAPABILITY — does `p.H(b)` run? Telemetry plus a ONE-WAY ratchet on the closure rate per host and
//     nesting level (`host-closure-baseline.json`, at a FIXED seed so the rates are comparable run to run).
//     A decline is fail-closed and legal; only the rate is ratcheted. An INTERNAL error is never legal.
//   • SEMANTICS — where both forms run, the host must answer what the reference says it answers. Each law
//     below cites the step that defines it. A both-ran-and-disagreed is a WRONG ANSWER: it fails the run
//     unless diagnosed in `host-known.ts` (one entry per root cause, the `known.ts` discipline).
//
// This subsumes the typed-value-carrier plan's T8 law (`docs/2026-11-05-typed-value-carrier-plan.md`):
// `map(b) ≡ b` per traverser, `where(b)` keeps exactly the productive traversers, `project('x').by(b)`
// holds `x` exactly when `b` is productive with its first value — all three are laws here.
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import type { GraphStore } from '../../src/storage.ts';
import { DEFAULT_FAST_PATHS } from '../../src/compiler/options/fast-paths.ts';
import { isNondeterministic, orderIndeterminacy } from '../support/graph.ts';
import { describeThrow, failsClosed } from '../support/fail-closed.ts';
import { outcomeOf, type Outcome } from './oracle.ts';
import { hostCase, type Budget, type HostCase } from './generate.ts';
import { HOSTS, type Host } from './hosts.ts';
import { knownHostDivergence, knownHostInternal } from './host-known.ts';

/** The ratchet sample's budgets. Prefix and body are each a short chain with one level of child nesting
 *  of their own; the hosts add the levels being measured. */
export const PREFIX_BUDGET: Budget = { steps: 3, depth: 1 };
export const BODY_BUDGET: Budget = { steps: 3, depth: 1 };
/** Nested (level-2) host pairs drawn per case. All 13×13 would be ~150 queries a case; a few random
 *  pairs per case cover the product across the sample at a fraction of the cost. */
const NESTED_PER_CASE = 4;

type W = ReadonlyMap<string, bigint>;

export interface Tally { applicable: number; executed: number }
/** host name → level ('1' | '2') → tally. Level 2 is attributed to the OUTER host. */
export type ClosureTable = Record<string, Record<'1' | '2', Tally>>;

export interface SweepResult {
  readonly drawn: number;
  readonly cases: number;
  /** Hash of the drawn case list — the generator's identity, independent of what the compiler runs. */
  readonly fingerprint: string;
  readonly table: ClosureTable;
  /** Throws that are not a fail-closed decline. Never legal. */
  readonly internal: string[];
  /** Law violations not diagnosed in host-known.ts. */
  readonly divergences: string[];
  /** Diagnosed (known) law violations hit, by entry id. */
  readonly knownHits: Map<string, number>;
  /** Per law: evaluated / skipped-indeterminate. */
  readonly laws: Map<string, { evaluated: number; indeterminate: number }>;
}

const total = (w: W): bigint => [...w.values()].reduce((a, b) => a + b, 0n);
const plus = (a: W, b: W): W => {
  const m = new Map(a);
  for (const [k, v] of b) m.set(k, (m.get(k) ?? 0n) + v);
  return m;
};
const same = (a: W, b: W): boolean => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const preview = (w: W) => `${w.size} distinct, ${total(w)} traversers`;

/**
 * Does the body hold a GLOBAL barrier, positional window or reducer at any depth? Then running it per
 * traverser (`flatMap`/`local`) is a different question from running it over the whole stream, and the
 * per-traverser ≡ inline laws do not apply. Conservative (a `count()` nested in a `where()` is in fact
 * per-traverser already) — the cost is coverage, which the per-law counts report, never a false alarm.
 */
export const hasBarrier = (body: string): boolean =>
  /\b(?:count|sum|min|max|mean|fold|dedup|order|group|groupCount)\((?!local)|\b(?:limit|skip|range|tail)\(/.test(body);

/** mulberry32 — a tiny deterministic PRNG for the nested-pair draw, seeded per case. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function emptyTable(): ClosureTable {
  return Object.fromEntries(HOSTS.map((h) => [h.name, { 1: { applicable: 0, executed: 0 }, 2: { applicable: 0, executed: 0 } }]));
}

/** Draw `want` executable cases from `seed`. Over-draws, since many inline forms do not run. */
export function drawCases(store: GraphStore, seed: number, want: number, body: Budget = BODY_BUDGET): { drawn: number; cases: HostCase[]; fingerprint: string } {
  const pool = fc.sample(hostCase(PREFIX_BUDGET, body), { seed, numRuns: want * 4 });
  // The fingerprint hashes the WHOLE pool, never just the part consumed: how far down the pool `want`
  // executable cases reach depends on what the compiler runs, and the fingerprint must name the generator.
  const hash = createHash('sha1');
  for (const c of pool) hash.update(`${c.prefix}.${c.body}\n`);
  const seen = new Set<string>();
  const cases: HostCase[] = [];
  let drawn = 0;
  for (const c of pool) {
    if (cases.length >= want) break;
    drawn++;
    const inline = `${c.prefix}.${c.body}`;
    if (seen.has(inline) || isNondeterministic(inline)) continue;
    seen.add(inline);
    if (outcomeOf(store, inline, DEFAULT_FAST_PATHS).kind !== 'rows') continue;
    cases.push(c);
  }
  return { drawn, cases, fingerprint: hash.digest('hex').slice(0, 16) };
}

export function sweep(store: GraphStore, seed: number, want: number, body: Budget = BODY_BUDGET): SweepResult {
  const { drawn, cases, fingerprint } = drawCases(store, seed, want, body);
  const table = emptyTable();
  const internal: string[] = [];
  const divergences: string[] = [];
  const knownHits = new Map<string, number>();
  const laws = new Map<string, { evaluated: number; indeterminate: number }>();
  const run = (q: string): Outcome => {
    const o = outcomeOf(store, q, DEFAULT_FAST_PATHS);
    if (o.kind === 'threw' && !failsClosed(o.error)) {
      const known = knownHostInternal(q, o.message);
      if (known) knownHits.set(known, (knownHits.get(known) ?? 0) + 1);
      else internal.push(`${q}\n    ${describeThrow(o.error)}`);
    }
    return o;
  };

  cases.forEach((c, i) => {
    const inline = `${c.prefix}.${c.body}`;
    const anon = `__.${c.body}`;
    const hostQuery = (h: Host) => `${c.prefix}.${h.render(anon)}`;

    // ---- level 1
    const at = new Map<string, { q: string; o: Outcome }>();
    for (const h of HOSTS) {
      if (!h.applies(c.from, c.to)) continue;
      const q = hostQuery(h);
      const o = run(q);
      table[h.name]![1].applicable++;
      if (o.kind === 'rows') table[h.name]![1].executed++;
      at.set(h.name, { q, o });
    }

    // ---- level 2: H1(H2(b)), a few well-typed pairs per case
    const pairs: [Host, Host][] = [];
    for (const h2 of HOSTS) {
      if (!h2.applies(c.from, c.to)) continue;
      const mid = h2.out(c.from, c.to);
      for (const h1 of HOSTS) if (h1.applies(c.from, mid)) pairs.push([h1, h2]);
    }
    const r = rng(seed * 7919 + i);
    for (let k = 0; k < NESTED_PER_CASE && pairs.length; k++) {
      const [h1, h2] = pairs.splice(Math.floor(r() * pairs.length), 1)[0]!;
      const o = run(`${c.prefix}.${h1.render(`__.${h2.render(anon)}`)}`);
      table[h1.name]![2].applicable++;
      if (o.kind === 'rows') table[h1.name]![2].executed++;
    }

    // ---- semantics: the laws, over whichever forms ran
    const base = { q: c.prefix, o: run(c.prefix) };
    const self = { q: inline, o: run(inline) };
    const rows = (name: string) => {
      const f = at.get(name);
      return f && f.o.kind === 'rows' ? { q: f.q, w: f.o.weighed } : undefined;
    };
    const P = base.o.kind === 'rows' ? { q: base.q, w: base.o.weighed } : undefined;
    const B = self.o.kind === 'rows' ? { q: self.q, w: self.o.weighed } : undefined;
    const law = (name: string, why: string, sides: readonly ({ q: string; w: W } | undefined)[],
      lhs: (ws: W[]) => W | bigint, rhs: (ws: W[]) => W | bigint) => {
      if (sides.some((s) => s === undefined)) return;
      const ss = sides as { q: string; w: W }[];
      const tally = laws.get(name) ?? { evaluated: 0, indeterminate: 0 };
      laws.set(name, tally);
      const windows = ss.map((s) => orderIndeterminacy(s.q));
      if (windows.includes('cardinality')) { tally.indeterminate++; return; }
      tally.evaluated++;
      const ws = ss.map((s) => s.w);
      const [a, b] = [lhs(ws), rhs(ws)];
      // A positional window leaves WHICH members it took undetermined, never how many: compare totals.
      const onlyCount = windows.includes('members') || typeof a === 'bigint';
      const ok = onlyCount
        ? (typeof a === 'bigint' ? a : total(a)) === (typeof b === 'bigint' ? b : total(b))
        : same(a as W, b as W);
      if (ok) return;
      const detail = onlyCount
        ? `${typeof a === 'bigint' ? a : total(a)} vs ${typeof b === 'bigint' ? b : total(b)} traversers`
        : `${preview(a as W)} vs ${preview(b as W)}`;
      const known = knownHostDivergence(name, ss.map((s) => s.q));
      if (known) { knownHits.set(known, (knownHits.get(known) ?? 0) + 1); return; }
      divergences.push(`LAW ${name} — ${why}\n${ss.map((s) => `    ${s.q}`).join('\n')}\n    ${detail}`);
    };
    const barrierFree = !hasBarrier(c.body);
    const fm = rows('flatMap'), lo = rows('local'), wh = rows('where'), fi = rows('filter'), no = rows('not');
    const mp = rows('map'), op = rows('optional'), co = rows('coalesce'), un = rows('union'), pr = rows('project');

    // FlatMapStep.java:42-52 + TraversalFlatMapStep.flatMap → TraversalUtil.applyAll: every result of the
    // body, per traverser. Over a barrier-free body that is the chain's own answer.
    if (barrierFree) law('flatMap(b) ≡ b', 'per-traverser application of a barrier-free body is the chain (FlatMapStep.java:42-52)',
      [fm, B], ([x]) => x!, ([, y]) => y!);
    // LocalStep.java:60-88: the body over each start in turn (bulk split to 1) — barrier-free, the chain.
    if (barrierFree) law('local(b) ≡ b', 'local() over a barrier-free body is the chain (LocalStep.java:60-88)',
      [lo, B], ([x]) => x!, ([, y]) => y!);
    // GraphTraversal.where(Traversal) (GraphTraversal.java:2709-2713) builds a TraversalFilterStep when the
    // body binds no variables — the very step filter(b) builds.
    law('where(b) ≡ filter(b)', 'where(b) with no match variables IS TraversalFilterStep (GraphTraversal.java:2709-2713)',
      [wh, fi], ([x]) => x!, ([, y]) => y!);
    // TraversalFilterStep.filter (:62-63) keeps a traverser iff TraversalUtil.test = hasNext; NotStep.filter
    // (:45-46) keeps it iff NOT — so the two partition the input exactly.
    law('where(b) ⊎ not(b) ≡ p', 'TraversalFilterStep.java:62-63 and NotStep.java:45-46 are complements',
      [wh, no, P], ([x, y]) => plus(x!, y!), ([, , z]) => z!);
    // TraversalMapStep.java:49-53: the FIRST result of the body, or nothing — so map keeps exactly the
    // traversers where(b) keeps, one value each.
    law('|map(b)| = |where(b)|', 'map emits one value per productive traverser, else none (TraversalMapStep.java:49-53)',
      [mp, wh], ([x]) => total(x!), ([, y]) => total(y!));
    // ...and where the body is SINGLE-valued per traverser (|flatMap| = |where|: every productive traverser
    // yields exactly one), its first value IS its value: map(b) ≡ flatMap(b).
    if (fm && wh && total(fm.w) === total(wh.w))
      law('map(b) ≡ flatMap(b) when single-valued', 'the first of one value is that value (TraversalMapStep.java:49-53)',
        [mp, fm], ([x]) => x!, ([, y]) => y!);
    // OptionalStep.java:47-57: the body's results if it has any, else the traverser — exactly
    // CoalesceStep.java:52-61 over (b, identity()), and the multiset flatMap(b) ⊎ not(b).
    law('optional(b) ≡ coalesce(b, identity())', 'OptionalStep.java:47-57 ≡ CoalesceStep.java:52-61 with an identity() arm',
      [op, co], ([x]) => x!, ([, y]) => y!);
    law('optional(b) ≡ flatMap(b) ⊎ not(b)', 'body results where productive, else the traverser itself (OptionalStep.java:47-57)',
      [op, fm, no], ([x]) => x!, ([, y, z]) => plus(y!, z!));
    // UnionStep is a BranchStep whose arms are GLOBAL children fed every start (BranchStep.java:87-88 sets hasBarrier,
    // 143-147 then feeds every start before any arm drains): a barrier in an arm reduces the whole stream — Union.feature
    // g_VX1_2X_unionXoutE_count__inE_count__outE_weight_sumX answers 3 for marko+vadas, not 3 and 0.
    // EXCEPT over an EMPTY input: BranchStep.java:143-145 ends the step when no start arrives, so an arm's
    // seeded reducer (`count()` → 0) never emits — the union is empty, where the inline chain answers 0.
    // (Found by this law on its first deep run, as a false alarm; narrowed here rather than ledgered.)
    law('union(b, identity()) ≡ b ⊎ p', 'union arms are global children over the whole stream; none run over an empty one (BranchStep.java:87-88, 143-147)',
      [un, B, P], ([x]) => x!, ([, y, z]) => (total(z!) === 0n ? new Map() : plus(y!, z!)));
    // ProjectStep.java:62-68: one map per traverser; a key is put only when its by() is productive, with
    // TraversalUtil.produce's FIRST value.
    law('|project(x).by(b)| = |p|', 'project emits one map per traverser (ProjectStep.java:62-68)',
      [pr, P], ([x]) => total(x!), ([, y]) => total(y!));
    if (pr) {
      const sel = run(`${pr.q}.select('x')`);
      const S = sel.kind === 'rows' ? { q: `${pr.q}.select('x')`, w: sel.weighed } : undefined;
      law('|project(x).by(b).select(x)| = |where(b)|', 'x is present exactly when b is productive (ProjectStep.java:62-68)',
        [S, wh], ([x]) => total(x!), ([, y]) => total(y!));
      if (fm && wh && total(fm.w) === total(wh.w))
        law('project(x).by(b).select(x) ≡ flatMap(b) when single-valued', 'x holds the first (= only) value (ProjectStep.java:62-68)',
          [S, fm], ([x]) => x!, ([, y]) => y!);
    }
  });

  return { drawn, cases: cases.length, fingerprint, table, internal, divergences, knownHits, laws };
}

export const rate = (t: Tally): number => (t.applicable === 0 ? 1 : t.executed / t.applicable);

/** The closure table as aligned text: one row per host, a column per level, plus the overall row. */
export function renderTable(table: ClosureTable): string {
  const cell = (t: Tally) => `${(100 * rate(t)).toFixed(1).padStart(5)}% (${t.executed}/${t.applicable})`.padEnd(20);
  const sum = (lvl: '1' | '2') => Object.values(table).reduce((a, r) => ({
    applicable: a.applicable + r[lvl].applicable, executed: a.executed + r[lvl].executed,
  }), { applicable: 0, executed: 0 });
  const lines = [`  ${'host'.padEnd(10)}${'level 1'.padEnd(20)}level 2 (outer host)`];
  for (const h of HOSTS) lines.push(`  ${h.name.padEnd(10)}${cell(table[h.name]![1])}${cell(table[h.name]![2])}`);
  lines.push(`  ${'ALL'.padEnd(10)}${cell(sum('1'))}${cell(sum('2'))}`);
  return lines.join('\n');
}


