// L5's oracle: the fast-path differential.
//
// `FastPathConfig` (src/compiler/options/fast-paths.ts) is six independently switchable optimized
// lowerings, and each one's doc comment states the same obligation — "Disabling routes through the
// generic path — result-equivalent". `FastPath.equivalentWhen` makes that obligation a REQUIRED
// field, and test/compiler/fast-paths.exec.test.ts enforces that the field is non-empty. Nothing,
// until now, checked the claim itself. This file is that check: run one traversal under two
// configs and compare the results.
//
// Why this is a real oracle and not a tautology: the generic path is the SEMANTIC AUTHORITY (that
// is the fast-path contract), so a disagreement is always a defect in the optimized lowering, and
// no reference implementation, no expected-value table and no JVM is needed to find it. That makes
// it the cheapest of the four oracle designs and the one that covers the riskiest code — the
// movement collapse, the bulk repeat-count, the two predicate inliners.
import type { GraphStore } from '../../src/storage.ts';
import { exec } from '../support/executor.ts';
import { isWrite, type StoreFactory } from '../support/graph.ts';
import { DEFAULT_FAST_PATHS, type FastPathConfig } from '../../src/compiler/options/fast-paths.ts';
import { weigh } from '../support/multiset.ts';

// `seeded`/`isWrite`/`StoreFactory` moved to test/support/graph.ts when the census became a second
// consumer — a shared helper living inside one of its consumers is how a third ends up
// hand-rolling a copy. Imported, never re-exported: one name, one import path.

/** Every fast path off — the generic lowering, i.e. the semantic authority to compare against. */
export const ALL_GENERIC: FastPathConfig = Object.freeze(
  Object.fromEntries(Object.keys(DEFAULT_FAST_PATHS).map((k) => [k, false])) as unknown as FastPathConfig,
);

export const FAST_PATH_NAMES = Object.keys(DEFAULT_FAST_PATHS) as (keyof FastPathConfig)[];

/** Default config with exactly one fast path disabled — isolates which switch a diff belongs to. */
export const onlyDisabled = (name: keyof FastPathConfig): FastPathConfig =>
  Object.freeze({ ...DEFAULT_FAST_PATHS, [name]: false });

/** The result of running one traversal under one config. A THROW is an outcome, not a crash: the
 *  project's fail-closed rule means an unsupported shape must throw a clear deferral, and whether
 *  the two configs AGREE on throwing is itself part of the equivalence. */
export type Outcome =
  | { readonly kind: 'rows'; readonly weighed: ReadonlyMap<string, bigint>; readonly ordered: readonly string[] }
  | { readonly kind: 'threw'; readonly message: string };

// `weigh` moved to `test/support/multiset.ts` — the census needs the same answer, and its own copy
// was subtly different in the one way that matters (see that module's header).

/** Run `q` against `store` under `fastPaths`, capturing a throw as an outcome. */
export function outcomeOf(store: GraphStore, q: string, fastPaths: FastPathConfig): Outcome {
  try {
    const framed = exec(store, undefined, fastPaths).framed(q, {});
    return { kind: 'rows', weighed: weigh(framed), ordered: framed.map((f) => f.buf.toString('hex')) };
  } catch (e) {
    return { kind: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}

/** How two outcomes differ. `order` is INFORMATIONAL — see `Divergence` below. */
export type Divergence =
  /** One config produced rows, the other threw. Always a defect: a fast path must not change
   *  whether a traversal is supported. */
  | { readonly kind: 'support'; readonly detail: string }
  /** Both produced rows, but the traverser multisets differ. The headline defect this oracle
   *  hunts — a fast path answering a different question than the generic path. */
  | { readonly kind: 'multiset'; readonly detail: string }
  /**
   * Same multiset, different emission ORDER. TELEMETRY ONLY — never gates. Reported because a
   * spurious order change is worth seeing, but not gated, and the reason is a real limit on this
   * oracle rather than laziness:
   *
   * TinkerPop constrains order only as far as the traversal establishes it. A bare traversal has no
   * guaranteed order at all, and — the case that matters here — `order().by(key)` establishes only a
   * PARTIAL order: where two traversers tie on `key`, their relative order is unspecified. So a diff
   * under `V().outE('knows').bothV().order().by('name')` (marko ties with himself across two edges)
   * is within spec, while a diff on a traversal sorting by a unique key would be a defect. Telling
   * those apart needs the projected sort KEYS, and this oracle compares encoded traverser values, so
   * it cannot. Gating on the coarse "does the source contain order(" test produced exactly one
   * false positive of the tie kind, which is why that test was withdrawn rather than kept and
   * ratcheted — a suite that reports known-good behaviour as a defect trains people to ignore it.
   */
  | { readonly kind: 'order'; readonly detail: string };

/** The divergence kinds that FAIL a run. `order` is excluded — see its comment above. */
export const GATING: ReadonlySet<Divergence['kind']> = new Set<Divergence['kind']>(['support', 'multiset']);

const preview = (m: ReadonlyMap<string, bigint>) => {
  const parts = [...m.entries()].slice(0, 4).map(([hex, bulk]) => `${hex.slice(0, 24)}…×${bulk}`);
  return `${m.size} distinct value(s): ${parts.join(', ')}${m.size > 4 ? ', …' : ''}`;
};

/** Compare two outcomes. `null` = equivalent (nothing to report). Pure in the two outcomes: it
 *  took a `store` only to hand to `preview`, which never read it. */
export function diverge(a: Outcome, b: Outcome): Divergence | null {
  // Both threw: agreement. The messages need not match — a fast path may decline earlier than the
  // generic path and word its deferral differently; what matters is that neither ANSWERED.
  if (a.kind === 'threw' && b.kind === 'threw') return null;
  if (a.kind === 'threw' || b.kind === 'threw') {
    const [threw, ran] = a.kind === 'threw' ? [a, b] : [b, a];
    const side = a.kind === 'threw' ? 'fast paths ON threw, generic ran' : 'generic threw, fast paths ON ran';
    return { kind: 'support', detail: `${side}: ${threw.kind === 'threw' ? threw.message : ''} · other side gave ${ran.kind === 'rows' ? preview(ran.weighed) : ''}` };
  }
  if (a.weighed.size !== b.weighed.size || [...a.weighed].some(([k, v]) => b.weighed.get(k) !== v)) {
    const missing = [...a.weighed].filter(([k, v]) => b.weighed.get(k) !== v);
    const extra = [...b.weighed].filter(([k, v]) => a.weighed.get(k) !== v);
    return {
      kind: 'multiset',
      detail: `fast=${preview(a.weighed)} · generic=${preview(b.weighed)}` +
        ` · ${missing.length} value(s) differ from fast side, ${extra.length} from generic side`,
    };
  }
  if (a.ordered.length !== b.ordered.length || a.ordered.some((h, i) => h !== b.ordered[i]))
    return { kind: 'order', detail: `same multiset (${a.weighed.size} distinct), different emission order` };
  return null;
}

/** The whole differential for one traversal: fast paths ON vs. `generic` (default: every fast path
 *  off). Returns EVERY divergence found, gating and telemetry alike — callers filter by `GATING`, so
 *  the telemetry stays visible in the run log instead of being dropped here.
 *
 *  `mint` supplies the baseline graph. A write gets a FRESH store per side; a read shares one, so
 *  the common case pays one seeding, not two. */
export function differential(mint: StoreFactory, q: string, generic: FastPathConfig = ALL_GENERIC): Divergence[] {
  const shared = isWrite(q) ? null : mint();
  const fast = outcomeOf(shared ?? mint(), q, DEFAULT_FAST_PATHS);
  const store = shared ?? mint();
  const slow = outcomeOf(store, q, generic);
  const d = diverge(fast, slow);
  return d ? [d] : [];
}

/** The divergences that fail a run — `differential` minus telemetry. */
export const gatingDivergences = (mint: StoreFactory, q: string, generic?: FastPathConfig): Divergence[] =>
  differential(mint, q, generic).filter((d) => GATING.has(d.kind));

/** Did this traversal even run? Used to report COVERAGE — a differential over traversals that all
 *  throw on both sides proves nothing, so the tests assert a floor on how many actually executed. */
export const ran = (store: GraphStore, q: string): boolean =>
  outcomeOf(store, q, DEFAULT_FAST_PATHS).kind === 'rows';
