// The behavioural census — the refactor guard.
//
// Every other level asks "is this CORRECT?". The census asks the one question none of them can:
// "did anything CHANGE?". That gap is not theoretical. 873 of the 2,298 corpus traversals do not
// execute, and a behaviour-preserving refactor's success criterion is a number that does NOT move —
// which, with L1–L5 alone, is indistinguishable from a refactor that quietly turned twenty
// fail-closed deferrals into wrong answers. L5's differential cannot see it either: it compares the
// two LOWERINGS against each other, so a change that moves both is invisible by construction.
//
// So this file records, for all 2,298 corpus traversals, what the engine actually DOES — and the
// committed artifact is the baseline a later commit is diffed against.
//
// TWO THINGS IT DELIBERATELY DOES DIFFERENTLY FROM THE OTHER RATCHETS:
//
//   1. It does NOT auto-record. L3 rewrites `l3-state.json` on a clean local run, and that is safe
//      there because its artifact is a MONOTONE FLOOR — the regression gate runs first, so an
//      auto-record can only ever write an improvement. The census is a TWO-WAY baseline whose most
//      dangerous transition (still runs, now returns something different) would be laundered by an
//      auto-record. Regeneration is explicit: `mise run census-record`.
//
//   2. It runs traversals through the EXECUTOR, never through a bare `compile()`. `compile(q, {})`
//      resolves no service registry, so all 12 `call()` traversals throw "unknown service" and would
//      be committed as false deferrals. Executing also makes the compile census free: every compile
//      failure surfaces as a throw anyway, so one pass yields both halves.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Framed } from '../../src/execute.ts';
import { exec } from '../support/executor.ts';
import { isWrite, seeded } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';

/** What the engine did with one traversal.
 *
 *  `deferred` vs `crashed` is the fail-closed contract made observable. Root CLAUDE.md: an
 *  unsupported shape must "throw a clear deferral, never mis-execute". A raw `TypeError` or a
 *  SQLite syntax error is NOT a clear deferral — it is the compiler falling over, and three of them
 *  exist today. Splitting the two lets the gate hold "crashes must not increase" without pretending
 *  the current count is zero.
 *
 *  `unbound` is a HARNESS limit, not a product defect: 383 corpus traversals reference bound
 *  parameters (`vid1`, `xx1`, …) and nothing in-tree reproduces TinkerPop's binding table. We pass
 *  `{}` and record the honest "Unbound parameter" rather than binding null — binding null would
 *  silently answer a DIFFERENT question (`g.V(vid1)` becoming `g.V(null)`), which is precisely the
 *  mis-execution the project forbids. If a binding table ever lands, this bucket is the work item.
 *
 *  `nondet` = it ran, but its result is deliberately NOT digested. See NONDETERMINISTIC. */
export type Status = 'ran' | 'nondet' | 'deferred' | 'crashed' | 'unbound';

/** Statuses that mean "the engine produced an answer". Losing this is a support regression. */
export const EXECUTES: ReadonlySet<Status> = new Set<Status>(['ran', 'nondet']);

export interface Row {
  readonly query: string;
  readonly status: Status;
  /** Rows emitted, and distinct traverser values among them. Redundant with `ms` (equal multisets
   *  have equal counts) but kept so a diff is readable without decoding a hash. */
  readonly n?: number;
  readonly d?: number;
  /** GATES. The weighed traverser multiset — sorted, so JS Map insertion order cannot leak in. */
  readonly ms?: string;
  /** TELEMETRY, never gates. Emission order, isolated so it can be reported without failing a run:
   *  TinkerPop constrains order only as far as the traversal establishes it, so a bare traversal has
   *  no guaranteed order at all. 356 of these move under a planner perturbation; gating on it
   *  guarantees a suite that flaps on a Bun bump. Same rule oracle.ts already applies to
   *  `Divergence.kind === 'order'`, for the same reason. */
  readonly ord?: string;
  /** For a non-executing status: the normalized throw message. */
  readonly message?: string;
}

/**
 * Traversals whose RESULT is legitimately nondeterministic. They are still run and their
 * ran-vs-threw status still gates; only the digest is withheld.
 *
 * The guard goes in now, while it is free. 24 corpus lines match and 23 of them currently throw
 * (`sample()`/`coin()` are unimplemented) — so today this costs nothing. The day one of those steps
 * lands, 23 goldens would start flapping with no warning and no diagnosis. The sources:
 * `Order.shuffle` → SQL `RANDOM()` (5 sites: select.ts:522, modulation.ts:87, projection.ts:646
 * and :1034, scalar.ts:694), and a bare `datetime()` → `Date.now()` (frontend.ts:335). Both were
 * probe-confirmed to give four different answers in four runs.
 *
 * `datetime('2020-01-01')` is deterministic — only the ARGUMENT-LESS form is not, hence `\(\s*\)`.
 * TinkerPop's own answer to this (`withStrategies(SeedStrategy(seed: …))`) is unimplemented here,
 * so we cannot lean on it.
 */
const NONDETERMINISTIC = /\b(?:sample|coin)\s*\(|Order\.shuffle|\bshuffle\b|\b(?:datetime|DateTime)\s*\(\s*\)/;

/**
 * Throws that did NOT come from our own fail-closed deferral path.
 *
 * Two families, both probe-identified. A `TypeError`/`RangeError` is the compiler falling over.
 * The message patterns catch foreign engines — bun:sqlite's bind check and SQLite itself — which
 * matter twice over: they are fail-closed violations (we emitted invalid SQL, or bound something
 * unbindable), AND their wording is not ours to depend on, so it must never be part of a
 * cross-runtime assertion.
 */
const FOREIGN_ORIGIN: readonly RegExp[] = [
  /^Binding expected /,                                   // bun:sqlite bind check
  /\bsyntax error\b/i,                                    // SQLite parser — we emitted invalid SQL
  /\bconstraint failed\b/i,                               // SQLite integrity
  /\bno such (?:column|table)\b/i,                        // SQLite name resolution
];

/** Normalize a throw message to what is stable across refactors.
 *
 *  Two families churn without meaning anything: `elements stream column mismatch` renders the live
 *  alias-column list, which moves whenever alias numbering does; and an object stringified into a
 *  message renders as `[object Object]`. Both are deterministic — this is refactor-noise
 *  suppression, not a determinism fix. */
export function normalizeMessage(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/expected \[[^\]]*\], got \[[^\]]*\]/, 'expected [<cols>], got [<cols>]')
    .replace(/\[object Object\]/g, '<object>')
    .trim();
}

function classify(e: unknown): { status: Status; message: string } {
  const message = normalizeMessage(e instanceof Error ? e.message : String(e));
  if (/^Unbound parameter /.test(message)) return { status: 'unbound', message };
  const ctor = e instanceof Error ? e.constructor.name : 'unknown';
  if (ctor === 'TypeError' || ctor === 'RangeError' || FOREIGN_ORIGIN.some((r) => r.test(message)))
    return { status: 'crashed', message };
  return { status: 'deferred', message };
}

const h16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * The digest of an executed result.
 *
 * `ms` folds `bulk` in as a decimal string (never a raw bigint — JSON cannot hold one) and sorts,
 * so it denotes the traverser MULTISET, exactly what oracle.ts's `weigh()` compares.
 *
 * A CAVEAT that cost a probe to find and is easy to get wrong: sorting the outer multiset does NOT
 * make this order-immune. When `fold()`/`cap()`/`group()` collapses a stream into ONE traverser,
 * the member order lives INSIDE that traverser's GraphBinary buffer, so the buffer itself changes
 * and `ms` moves. 50 corpus traversals are order-sensitive this way. They are deterministic today
 * and are recorded normally; the point is that a legitimate lowering change can move them, and when
 * it does the re-record needs a written reason, not a shrug.
 */
function digest(framed: readonly Framed[]): Pick<Row, 'n' | 'd' | 'ms' | 'ord'> {
  const hex = framed.map((f) => f.buf.toString('hex'));
  return {
    n: framed.length,
    d: new Set(hex).size,
    ms: h16(framed.map((f, i) => `${hex[i]}*${f.bulk}`).sort().join('|')),
    ord: h16(hex.join('|')),
  };
}

/** Run the whole corpus. Reads share one store (probe-verified: no read mutates it, and
 *  fresh-per-traversal gives byte-identical results for twice the wall clock); each write gets its
 *  own, or it would see its predecessors' mutations. */
export function runCensus(corpus: readonly string[]): Row[] {
  const shared = seeded(MODERN_SEED);
  return corpus.map((query) => {
    try {
      const framed = exec(isWrite(query) ? seeded(MODERN_SEED) : shared).framed(query, {});
      return NONDETERMINISTIC.test(query)
        ? { query, status: 'nondet' as const, n: framed.length }
        : { query, status: 'ran' as const, ...digest(framed) };
    } catch (e) {
      return { query, ...classify(e) };
    }
  });
}

// ---------- the artifact ----------
//
// Two TSVs, split because they churn on different schedules: a step landing MOVES a row from
// deferrals to goldens, and that is the signal worth seeing in a diff. TSV rather than JSON because
// it diffs line-per-entry and sorts trivially; the query is repeated in full rather than implied by
// line number, because a file keyed positionally to corpus.txt is unreviewable and silently
// corrupts the moment the corpus is regenerated with a different line count.

const HEADER = [
  '# The behavioural census — the refactor guard. GENERATED; regenerate with `mise run census-record`.',
  '# Records what the engine DOES with every test/L1-corpus/corpus.txt traversal, so a later commit',
  '# can be diffed against it. `bun test` FAILS if a traversal stops executing, if an executing',
  '# traversal returns a DIFFERENT multiset, or if a clean deferral becomes a crash.',
  '# Never re-record to make a red build green without a written reason — that is the one thing',
  '# this file exists to prevent. See test/census/README.md.',
].join('\n');

const GOLDEN_COLS = 'status\tn\td\tms\tord\tquery';
const DEFERRAL_COLS = 'status\tmessage\tquery';

const byQuery = (a: Row, b: Row) => (a.query < b.query ? -1 : a.query > b.query ? 1 : 0);

export function serialize(rows: readonly Row[]): { goldens: string; deferrals: string } {
  const executed = rows.filter((r) => EXECUTES.has(r.status)).sort(byQuery);
  const threw = rows.filter((r) => !EXECUTES.has(r.status)).sort(byQuery);
  return {
    goldens: [HEADER, GOLDEN_COLS,
      ...executed.map((r) => [r.status, r.n ?? '', r.d ?? '', r.ms ?? '', r.ord ?? '', r.query].join('\t')),
    ].join('\n') + '\n',
    deferrals: [HEADER, DEFERRAL_COLS,
      ...threw.map((r) => [r.status, r.message ?? '', r.query].join('\t')),
    ].join('\n') + '\n',
  };
}

function parseTsv(text: string): Row[] {
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  const cols = lines.shift();
  const golden = cols === GOLDEN_COLS;
  return lines.map((line) => {
    const f = line.split('\t');
    return golden
      ? { status: f[0] as Status, n: f[1] ? Number(f[1]) : undefined, d: f[2] ? Number(f[2]) : undefined,
          ms: f[3] || undefined, ord: f[4] || undefined, query: f.slice(5).join('\t') }
      : { status: f[0] as Status, message: f[1], query: f.slice(2).join('\t') };
  });
}

export const GOLDENS = new URL('./goldens.tsv', import.meta.url).pathname;
export const DEFERRALS = new URL('./deferrals.tsv', import.meta.url).pathname;
export const CORPUS = new URL('../L1-corpus/corpus.txt', import.meta.url).pathname;

export const loadCorpus = (): string[] =>
  readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean);

/** The committed baseline, keyed by query. Empty when the artifact is absent (first record). */
export function readBaseline(): Map<string, Row> {
  const rows = [
    ...parseTsv(readFileSync(GOLDENS, 'utf8')),
    ...parseTsv(readFileSync(DEFERRALS, 'utf8')),
  ];
  return new Map(rows.map((r) => [r.query, r]));
}

export function writeCensus(rows: readonly Row[]): void {
  const { goldens, deferrals } = serialize(rows);
  writeFileSync(GOLDENS, goldens);
  writeFileSync(DEFERRALS, deferrals);
}
