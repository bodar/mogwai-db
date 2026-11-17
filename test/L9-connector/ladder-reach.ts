// LADDER REACH — what does the ladder of correlated child routes still answer that the connector alone does not?
//
// The engine behind the L9 ratchet (`ladder-reach.test.ts`) and the instrument (`scripts/ladder-reach.ts`,
// `mise run ladder-reach`). `docs/2026-11-16-ladder-retirement-plan.md` R0: every later retirement step is
// measured by two numbers, and this computes both, per query pool and per ladder FAMILY:
//
//   • LADDER-ONLY — a traversal the shipping default answers and `FastPathConfig.connectorOnly` (the connector
//     ALONE: no ladder at any site, no whole-compile retry) declines. The ladder's remaining reach. R7's
//     precondition is 0.
//   • RESCUED — a traversal the shipping default answers and `FastPathConfig.childOrderRetry: false` declines:
//     only `bothChildOrders`' (`src/compiler/rel/spine.ts`) second child order answered it. R2 is done at 0.
//     Every rescue is ladder-only (where the connector alone answers, the first order builds the same plan and
//     answers), so it is measured over the ladder-only set — no third compile of the whole pool.
//   • FIRES — a traversal whose first child order alone declines with `CopiedDraw`, the plan decline
//     `bothChildOrders` retries in the other order (`spine.ts`): whatever the default then did (rescued, or the
//     specific reason rethrown), the retry arm ran for it. Counted over the WHOLE pool — N7 deletes that arm, so
//     its precondition is 0. A `CopiedDraw` needs a random draw in the plan, and every draw a traversal can spell
//     (`sample`, `coin`, `shuffle`) is `isNondeterministic`, so the third compile runs only over draws (and the
//     ladder-only set, for RESCUED).
//
// And one HARD invariant: where both modes answer, they answer the SAME MULTISET (`differ`). A different
// emission order of an unordered stream is not a difference (`docs/feature-support-matrix.md` §17), and a
// positional window over an unordered stream fixes only how many members it took, not which — the comparison
// L5's host laws make (`orderIndeterminacy`, `test/support/graph.ts`). A DRAW (`isNondeterministic`, the one
// authority the census and L5 already share) is outside that invariant: two runs of it differ whatever the
// modes do. It still counts in its pool (and can still be ladder-only), but its answers are not compared — it
// goes to `random`, never to `differ`. A draw whose OUTCOME is deterministic is checked by value instead.
import { readFileSync } from 'node:fs';
import type { GraphStore } from '../../src/storage.ts';
import { CONNECTOR_HOSTS } from '../../src/compiler/ir/analyze.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { parseGremlin, stepChain, isNested, type Step } from '../../src/gremlin/frontend.ts';
import { NO_PARAMS } from '../../src/gremlin/param-env.ts';
import { valueNodes } from '../../src/compiler/ir/walk.ts';
import { isNondeterministic, isWrite, orderIndeterminacy, seeded } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { outcomeOf, type Outcome } from '../L5-properties/oracle.ts';
import { CORPUS } from '../L6-workload/corpus.ts';
import { CopiedDraw } from '../../src/sql/kernel/budget.ts';
import { DEFERRED_HOSTS } from './deferred-hosts.ts';
import { MINT } from '../L6-workload/workload.ts';
import type { GraphName } from '../L6-workload/corpus.ts';

/** The connector ALONE (L9's configuration). */
export const CONNECTOR_ONLY: FastPathConfig = { ...DEFAULT_FAST_PATHS, correlatedChild: false, connectorOnly: true };
/** The shipping default without `bothChildOrders`' second order. */
export const NO_RETRY: FastPathConfig = { ...DEFAULT_FAST_PATHS, childOrderRetry: false };

/**
 * The ladder FAMILIES — the kept routes of `docs/2026-11-16-ladder-retirement-plan.md` (R3 existence, R4
 * per-traverser, R5 group), each retired by its own step, so each gets its own count. `other` is a ladder-only
 * answer with no family host in it (a ladderless host under a framing or step form the connector row does not
 * claim, a deferred host, a whole-compile retry over no family site).
 */
export const FAMILIES = ['existence', 'per-traverser', 'group', 'other'] as const;
export type Family = typeof FAMILIES[number];
const FAMILY_OF: Readonly<Record<string, Family>> = {
  where: 'existence', filter: 'existence', not: 'existence', and: 'existence', or: 'existence',
  map: 'per-traverser', flatMap: 'per-traverser', local: 'per-traverser',
  group: 'group', groupCount: 'group',
};
const MODULATORS = new Set(['by', 'with', 'option']);

/**
 * Does the host's own lowering own this child position (`DEFERRED_HOSTS` scope `host-owned`, the one authority
 * for it)? Keyed as `deferred-hosts.ts` keys it: a step's argument by its name, a `by()`/`with()` modulator as
 * `<host>.<modulator>`; `option()` is keyed by its own name whatever it modulates.
 */
const hostOwned = (step: string, host: string): boolean =>
  (DEFERRED_HOSTS[step !== host ? `${host}.${step}` : step] ?? DEFERRED_HOSTS[step])?.scope === 'host-owned';

/**
 * The family a ladder-only answer is charged to: the family of its DEEPEST family host holding a child (a
 * decline happens where a body fails to lower, and the deepest body is the one an enclosing host hands the
 * rest of the query to); the first in pre-order breaks a tie. A HOST-OWNED position (`DEFERRED_HOSTS` scope
 * `host-owned`) is a site too, charging `other` for everything beneath it: it outranks a family host above it (the
 * enclosing route handed it the body) but not one beside it at its own depth (a sibling, not its body). A static
 * rule over the query text, so the attribution is the same in every run and on every machine.
 */
export function familyOf(q: string): Family {
  // rank = 2·depth, +1 for a family host: a family host beats a host-owned site at the same depth.
  let best: { family: Family; rank: number } | undefined;
  const site = (family: Family, rank: number) => { if (!best || rank > best.rank) best = { family, rank }; };
  const walk = (chain: readonly Step[], depth: number): void => chain.forEach((s, i) => {
    for (const arg of s.args ?? []) for (const n of valueNodes(arg.value)) {
      if (!isNested(n)) continue;
      let host = s.name;
      if (MODULATORS.has(s.name)) {
        let j = i - 1;
        while (j >= 0 && MODULATORS.has(chain[j]!.name)) j--;
        host = j >= 0 ? chain[j]!.name : s.name;
      }
      // A position its host's own lowering owns (`deferred-hosts.ts` scope `host-owned`: a `Recursive` term, a
      // write plan, match()'s patterns, a service, an option map) is no ladder route, so everything beneath it
      // charges `other`, and the walk does not descend into it.
      if (hostOwned(s.name, host)) { site('other', 2 * depth); continue; }
      const family = CONNECTOR_HOSTS.has(host) ? FAMILY_OF[host] : undefined;
      if (family) site(family, 2 * depth + 1);
      try { walk(stepChain(n.nested, NO_PARAMS), depth + 1); } catch { /* an unparameterized body — skip */ }
    }
  });
  try { walk(stepChain(parseGremlin(q), NO_PARAMS), 0); } catch { /* unparsable — `other` */ }
  return best?.family ?? 'other';
}

/** One traversal of a pool and the store it runs against: a READ shares one store; a traversal that is not a
 *  read (`isWrite` — the compiler's own answer, so `dropLabels()` and a keyed side effect are caught where no
 *  regex over step names would be) gets a FRESH store per mode, so no mode sees another's mutations. */
export interface PoolQuery { readonly pool: string; readonly q: string; readonly store: GraphStore | (() => GraphStore) }
const storeOf = (p: PoolQuery): GraphStore => (typeof p.store === 'function' ? p.store() : p.store);
const placed = (q: string, shared: GraphStore, mint: () => GraphStore): GraphStore | (() => GraphStore) => (isWrite(q) ? mint : shared);

/** The L1 corpus (TinkerPop's `.feature` traversals), each over `modern` — a coverage question, which the graph a
 *  scenario names does not change. A DRAW is in the pool — counted, possibly ladder-only, a possible retry FIRE —
 *  only its answers go uncompared (`random`); whether it compiles is a property of its text, so its counts are as
 *  stable as any other's. */
export function l1Pool(): PoolQuery[] {
  const mint = () => seeded(MODERN_SEED);
  const shared = mint();
  const corpus = readFileSync(new URL('../L1-corpus/corpus.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
  return corpus.map((q) => ({ pool: 'L1', q, store: placed(q, shared, mint) }));
}

/** The L6 workload corpus, each over its own graph (one shared store per graph, as L6 runs it); draws included. */
export function l6Pool(): PoolQuery[] {
  const stores = new Map<GraphName, GraphStore>();
  return CORPUS.map((e) => {
    if (!stores.has(e.graph)) stores.set(e.graph, MINT[e.graph]());
    return { pool: 'L6', q: e.query, store: placed(e.query, stores.get(e.graph)!, MINT[e.graph]) };
  });
}

export interface LadderOnly { readonly pool: string; readonly q: string; readonly family: Family; readonly rescued: boolean; readonly declined: string }

export interface ReachResult {
  /** Per pool: queries run, answered by default, answered by the connector alone. */
  readonly pools: Record<string, { queries: number; byDefault: number; connectorOnly: number }>;
  readonly ladderOnly: LadderOnly[];
  /** Both answered, different multisets — a WRONG ANSWER in one of the two. Never legal. */
  readonly differ: string[];
  /** Both answered a DRAW (`isNondeterministic`): counted in its pool, its answers not compared. */
  readonly random: string[];
  /** `pool\tq` whose first child order declined with `CopiedDraw`: the retry arm fired (FIRES above). */
  readonly fires: string[];
  /** The connector alone answered and the default did not — the fallback LOST an answer. Never legal. */
  readonly connectorOnlyAnswers: string[];
}

type W = ReadonlyMap<string, bigint>;
const total = (w: W): bigint => [...w.values()].reduce((a, b) => a + b, 0n);
const sameMultiset = (q: string, a: W, b: W): boolean => {
  const window = orderIndeterminacy(q);
  if (window === 'cardinality') return true;
  if (window === 'members') return total(a) === total(b);
  return a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
};

/**
 * Compare the default against the connector alone over `queries`. `known` supplies an already computed
 * connector-only outcome (L9's closure sweep runs that mode itself), so a query is compiled in that mode once.
 */
export function reach(queries: readonly PoolQuery[], known?: ReadonlyMap<string, Outcome>): ReachResult {
  const pools: ReachResult['pools'] = {};
  const ladderOnly: LadderOnly[] = [];
  const differ: string[] = [];
  const random: string[] = [];
  const connectorOnlyAnswers: string[] = [];
  const fires: string[] = [];
  const seen = new Set<string>();
  for (const p of queries) {
    const { pool, q } = p;
    const key = `${pool}\t${q}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = (pools[pool] ??= { queries: 0, byDefault: 0, connectorOnly: 0 });
    t.queries++;
    const d = outcomeOf(storeOf(p), q, DEFAULT_FAST_PATHS);
    const c = known?.get(q) ?? outcomeOf(storeOf(p), q, CONNECTOR_ONLY);
    if (d.kind === 'rows') t.byDefault++;
    if (c.kind === 'rows') t.connectorOnly++;
    const isLadderOnly = d.kind === 'rows' && c.kind !== 'rows';
    // The first child order alone (`NO_RETRY`): for a ladder-only answer (is it a rescue?) and for a draw (did the
    // retry arm fire?) — every other traversal cannot fire it (FIRES above), so it pays no third compile.
    const first = isLadderOnly || isNondeterministic(q) ? outcomeOf(storeOf(p), q, NO_RETRY) : undefined;
    if (first?.kind === 'threw' && first.error instanceof CopiedDraw) fires.push(key);
    if (d.kind === 'rows' && c.kind === 'rows') {
      if (isNondeterministic(q)) random.push(key);
      else if (!sameMultiset(q, d.weighed, c.weighed)) differ.push(key);
    } else if (isLadderOnly) {
      ladderOnly.push({ pool, q, family: familyOf(q), rescued: first!.kind !== 'rows', declined: c.kind === 'threw' ? c.message : '' });
    } else if (c.kind === 'rows') connectorOnlyAnswers.push(key);
  }
  return { pools, ladderOnly, differ, random, fires, connectorOnlyAnswers };
}

/** `pool → family → count`, and the rescue count — the numbers the ratchet holds. */
export interface ReachCounts {
  readonly ladderOnly: Record<string, Record<Family, number>>;
  readonly rescued: number;
  /** Traversals whose first child order declined with `CopiedDraw` (FIRES above). N7's precondition is 0. */
  readonly fires: number;
}

export function counts(r: ReachResult): ReachCounts {
  const ladderOnly: Record<string, Record<Family, number>> = {};
  for (const pool of Object.keys(r.pools)) ladderOnly[pool] = Object.fromEntries(FAMILIES.map((f) => [f, 0])) as Record<Family, number>;
  for (const x of r.ladderOnly) ladderOnly[x.pool]![x.family]++;
  return { ladderOnly, rescued: r.ladderOnly.filter((x) => x.rescued).length, fires: r.fires.length };
}

/** The counts as aligned text: a row per pool, a column per family, plus the totals. */
export function renderCounts(c: ReachCounts): string {
  const pools = Object.keys(c.ladderOnly);
  const col = (s: string | number) => String(s).padStart(15);
  const lines = [`  ${'pool'.padEnd(6)}${FAMILIES.map(col).join('')}${col('total')}`];
  const sum = (f: Family) => pools.reduce((a, p) => a + c.ladderOnly[p]![f], 0);
  for (const p of pools) {
    const row = FAMILIES.map((f) => c.ladderOnly[p]![f]);
    lines.push(`  ${p.padEnd(6)}${row.map(col).join('')}${col(row.reduce((a, b) => a + b, 0))}`);
  }
  lines.push(`  ${'ALL'.padEnd(6)}${FAMILIES.map((f) => col(sum(f))).join('')}${col(FAMILIES.reduce((a, f) => a + sum(f), 0))}`);
  lines.push(`  rescued by bothChildOrders: ${c.rescued}; CopiedDraw retry fires: ${c.fires}`);
  return lines.join('\n');
}
