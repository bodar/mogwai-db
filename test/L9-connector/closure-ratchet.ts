// The comparison behind L9's connector-only closure ratchet (`connector-closure.test.ts`), split out so it is a
// pure function a unit test can drive (`closure-ratchet.test.ts`).
//
// A cell's RATE alone is not the ratchet: one body newly declined while another is newly answered holds the rate
// level, and the connector has still stopped closing over a body it closed over before (root CLAUDE.md decision
// 6). So the ratchet is per QUERY: every cell lists the queries that decline now and did not when recorded
// (`fresh`), whatever its rate did, and any fresh decline fails — printed with the newly answered query it was
// swapped for, when there is one. An INTENDED new decline (a query text that should be refused) is a re-record
// (`mise run connector-record`) with its reason in the commit.
import { createHash } from 'node:crypto';
import { HOSTS } from '../L5-properties/hosts.ts';
import { LEVELS, rate, type ClosureTable } from '../L5-properties/host-closure.ts';

export interface ClosureBaseline {
  readonly seed: number;
  readonly cases: number;
  readonly fingerprint: string;
  readonly table: ClosureTable;
  /** `host@level` → short hashes of the queries that did not run when recorded. */
  readonly declined: Record<string, string[]>;
}

/** What one sweep supplies: its table, the queries each cell did not run, and every query it ran. */
export interface ClosureNow {
  readonly table: ClosureTable;
  readonly unrun: Record<string, readonly string[]>;
  readonly queries: Iterable<string>;
}

export const hash = (q: string): string => createHash('sha1').update(q).digest('hex').slice(0, 12);

/** How many queries a failing cell lists. */
const SHOW = 8;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const list = (qs: readonly string[]) =>
  `${qs.slice(0, SHOW).map((q) => `      ${q}`).join('\n')}${qs.length > SHOW ? `\n      … ${qs.length - SHOW} more` : ''}`;

/**
 * Compare a sweep against its baseline. `failed` holds one line per cell that has a fresh decline or whose rate
 * fell; `rose` one per cell whose rate rose (or that is new) — the re-record hint.
 */
export function compareClosure(baseline: ClosureBaseline, now: ClosureNow): { failed: string[]; rose: string[] } {
  const byHash = new Map<string, string>();
  for (const q of now.queries) byHash.set(hash(q), q);
  const failed: string[] = [];
  const rose: string[] = [];
  for (const h of HOSTS) for (const lvl of LEVELS) {
    const cell = `${h.name}@${lvl}`;
    const t = now.table[h.name]?.[lvl];
    const was = baseline.table[h.name]?.[lvl];
    if (!t) continue;
    if (!was) { rose.push(`${cell} (new)`); continue; }
    const [a, b] = [rate(t), rate(was)];
    if (a > b + 1e-9) rose.push(`${cell}: ${pct(b)} → ${pct(a)}`);
    const known = new Set(baseline.declined[cell] ?? []);
    const unrun = [...new Set(now.unrun[cell] ?? [])];
    const fresh = unrun.filter((q) => !known.has(hash(q)));
    if (!fresh.length && a >= b - 1e-9) continue;
    const declinedNow = new Set(unrun.map(hash));
    const answered = [...known].filter((x) => !declinedNow.has(x)).map((x) => byHash.get(x) ?? `(query ${x}, not in this sweep)`);
    const head = `${cell}: ${pct(b)} → ${pct(a)} (${was.executed}/${was.applicable} → ${t.executed}/${t.applicable})`;
    const swap = a >= b - 1e-9 && answered.length ? ' — a SWAP at the same rate' : '';
    failed.push(`${head}${swap}`
      + (fresh.length ? `; newly declined (${fresh.length}):\n${list(fresh)}` : '')
      + (answered.length ? `\n    newly answered (${answered.length}):\n${list(answered)}` : ''));
  }
  return { failed, rose };
}
