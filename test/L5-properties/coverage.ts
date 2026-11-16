// THE DEPTH CURVE — execute rate by child-traversal nesting depth (cc0-curve,
// docs/2026-11-15-compositional-coverage-plan.md §3 Phase 0).
//
// A compositional compiler answers a body at depth k whenever it answers it at the top level, so its curve
// is FLAT; a compiler built from a ladder of per-combination routes falls off a cliff as depth grows. This
// module measures that curve over two FIXED-seed profiles (so a re-run is the same sample and the ratchet
// is exact, unlike the HEAD-rotating L5 seed):
//
//   - `lattice`   — the L5 shape-lattice generator (`generate.ts`): type-correct, semantically arbitrary.
//   - `realistic` — `realistic.ts`: app idioms over the `modern` schema, the curve the owner cares about.
//
// Depth is NOT paren depth (that counts predicate and argument parens); it is the deepest chain of nested
// CHILD TRAVERSALS, read from the IR through the one walker (`ir/walk.ts` `eachChildChain`): `g.V().out()`
// is 0, `where(out())` is 1, `where(out().where(in()))` is 2.
import fc from 'fast-check';
import { parseGremlin, stepChain, type Step } from '../../src/gremlin/frontend.ts';
import { eachChildChain, rawBodies } from '../../src/compiler/ir/walk.ts';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { anyParams } from '../support/any-params.ts';
import { seeded, isWrite } from '../support/graph.ts';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { failsClosed } from '../support/fail-closed.ts';
import { outcomeOf, ALL_GENERIC } from './oracle.ts';
import { traversal } from './generate.ts';
import { realisticTraversal } from './realistic.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../../src/compiler/options/fast-paths.ts';

export type Verdict = 'rows' | 'decline' | 'error' | 'internal';

/** The deepest nesting of child traversals in `query`'s IR (0 = no child traversal). */
export function childDepth(query: string): number {
  const read = rawBodies(anyParams());
  const deepest = (chain: readonly Step[]): number => {
    let max = 0;
    for (const s of chain) eachChildChain(s, read, (child) => { max = Math.max(max, 1 + deepest(child)); });
    return max;
  };
  return deepest(stepChain(parseGremlin(query), anyParams()));
}

/** Run once and classify: an answer, a DECLINE (`UnsupportedTraversal` — our coverage gap), a reference
 *  error the query itself asks for (not a gap), or an INTERNAL error (a defect, never acceptable). */
export function verdictOf(query: string, generic = false, fastPaths: FastPathConfig = DEFAULT_FAST_PATHS): Verdict {
  const store = seeded(MODERN_SEED);
  const outcome = outcomeOf(store, query, generic ? ALL_GENERIC : fastPaths);
  if (outcome.kind === 'rows') return 'rows';
  if (outcome.error instanceof UnsupportedTraversal) return 'decline';
  return failsClosed(outcome.error) ? 'error' : 'internal';
}

export interface Bucket { n: number; rows: number; decline: number; error: number; internal: number }
export interface Curve {
  readonly profile: string;
  /** Per child-nesting depth. `executeRate` is rows / (rows + decline): a query the reference itself
   *  errors on is neither coverage nor a gap, so it is left out of the rate. */
  readonly byDepth: Record<string, Bucket & { executeRate: number }>;
  readonly internal: readonly string[];
}

export const PROFILES = {
  lattice: { seeds: [101, 202, 303], sample: (seed: number, n: number) =>
    fc.sample(traversal({ steps: 6, depth: 3 }), { seed, numRuns: n }).map((g) => g.query) },
  realistic: { seeds: [11, 22, 33], sample: (seed: number, n: number) =>
    fc.sample(realisticTraversal(3), { seed, numRuns: n }).map((g) => g.query) },
} as const;
export type Profile = keyof typeof PROFILES;

/** Depths beyond this are pooled into one `N+` bucket — they are sparse, and a ratchet over a bucket of
 *  three queries would be noise. */
const POOL_FROM = 4;
const depthKey = (d: number): string => (d >= POOL_FROM ? `${POOL_FROM}+` : String(d));

export function measure(profile: Profile, perSeed: number, fastPaths: FastPathConfig = DEFAULT_FAST_PATHS): Curve {
  const buckets: Record<string, Bucket> = {};
  const internal: string[] = [];
  for (const seed of PROFILES[profile].seeds) {
    for (const query of PROFILES[profile].sample(seed, perSeed)) {
      if (isWrite(query)) continue; // a write mutates the graph; the curve is about read composition
      const key = depthKey(childDepth(query));
      const b = buckets[key] ??= { n: 0, rows: 0, decline: 0, error: 0, internal: 0 };
      const v = verdictOf(query, false, fastPaths);
      b.n++; b[v]++;
      if (v === 'internal') internal.push(query);
    }
  }
  const byDepth = Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b)).map(([k, b]) =>
    [k, { ...b, executeRate: b.rows + b.decline === 0 ? 1 : round(b.rows / (b.rows + b.decline)) }]));
  return { profile, byDepth, internal };
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

/** A fixed-width table for logs and commit messages. */
export function render(curve: Curve): string {
  const lines = [`${curve.profile}: depth   n    rows decline error  execute%`];
  for (const [d, b] of Object.entries(curve.byDepth))
    lines.push(`${' '.repeat(curve.profile.length)}  ${d.padStart(5)} ${String(b.n).padStart(4)} ${String(b.rows).padStart(7)} ${String(b.decline).padStart(7)} ${String(b.error).padStart(5)}  ${(b.executeRate * 100).toFixed(1).padStart(7)}`);
  return lines.join('\n');
}

/** Per-seed sample size the CI ratchet runs at. The recorder uses the same, so the baseline is exact. */
export const CI_PER_SEED = Number(process.env.COVERAGE_PER_SEED ?? 400);
