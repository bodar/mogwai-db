// ---------- reducer monoids: how a terminal reducer SPLITS into partial-remote + combine-local ----------
//
// A federate mid-traversal reduction (`V().call(federate,…,inj).count()`) can push its reducer to the
// sibling as a PARTIAL keyed by the injected value, then COMBINE the partials locally per parent — the
// same answer, but only a `(key→partial)` map crosses the wire instead of every element. This is a
// TRANSPORT OPTIMIZATION over a path that already produces the right answer (element scatter + local
// reduce), so the combine must satisfy the monoid law
//
//     combine(partial(A), partial(B)) ≡ reduce(A ∪ B)
//
// which is exactly what makes "partial remote, combine local" correct. It is Calcite's
// `SqlSplittableAggFunction` (`vendor/calcite/core/.../sql/SqlSplittableAggFunction.java`): `split()` is
// the partial, `topSplit()` the combine. Each aggregate declares its own splitter — `CountSplitter`
// (`:107`) keeps COUNT on the subset and combines with **SUM0** (`SqlSplittableAggFunction.java:148` —
// SUM0 not SUM, so an empty combine yields 0 not null); `SelfSplitter` (`:202`) is MIN/MAX (idempotent —
// split into itself, combine with itself); `AVG` is not splittable directly and Calcite's
// `AggregateReduceFunctionsRule` decomposes it to `SUM/COUNT` first, each of which IS splittable.
//
// So each reducer is a MONOID `(partial, combine, identity)`:
//   count → (COUNT,  +,   0)          identity 0: a parent that matched nothing counts 0
//   sum   → (SUM,    +,   0)          identity 0
//   min   → (MIN,    MIN, +∞)         identity +∞, which manifests as "empty → no element" (drop)
//   max   → (MAX,    MAX, −∞)         identity −∞, likewise a drop on empty
//   mean  → NOT a monoid directly → reduce-first to (SUM, COUNT) then sum/count locally
//
// This module is the DECLARATION (data + a tiny classifier); the lowering that applies it lives in the
// federate resume. A leaf: it imports nothing but the reducer name set.

import { REDUCERS } from './step.ts';

/** How a reducer's identity behaves at an EMPTY combine — the load-bearing difference between the
 *  additive reducers and the extremal ones, straight from Calcite's splitter choice:
 *   - `'zero'`: SUM0 — an empty combine yields 0 (count/sum). A parent that matched nothing emits 0.
 *   - `'absorbing'`: no identity value survives to the wire — an empty combine yields NOTHING, so the
 *     parent DROPS (min/max over an empty set emits no traverser, matching TinkerPop). */
export type CombineIdentity = 'zero' | 'absorbing';

/** A splittable reducer's monoid: the step the SIBLING runs as the partial, the SQL aggregate that
 *  COMBINES partials locally, and how the identity behaves on an empty combine. `count`'s partial is a
 *  COUNT but its combine is SUM0 (Calcite `CountSplitter`) — you sum the sub-counts, you do not re-count. */
export interface ReducerMonoid {
  /** The reducer as the user wrote it (the local, un-optimized authority). */
  readonly name: string;
  /** The Gremlin reducer step the SIBLING runs per group to produce the partial — `count`'s is `count`,
   *  but SUM's/MIN's/MAX's partial is itself. `null` = NOT a simple splittable partial (mean), handled by
   *  `reduceFirst` instead. */
  readonly partial: string | null;
  /** The SQL aggregate FN that combines partials locally: `count`/`sum` combine with `sum` (SUM0),
   *  `min`/`max` with themselves. `null` when `reduceFirst` is set. */
  readonly combine: 'sum' | 'min' | 'max' | null;
  /** Empty-combine behaviour (see `CombineIdentity`). */
  readonly identity: CombineIdentity;
  /** For a reducer that is not a monoid directly (`mean`): the two splittable partials it decomposes to,
   *  combined then recomposed locally (`mean = sum/count`). Calcite `AggregateReduceFunctionsRule`. */
  readonly reduceFirst?: readonly ReducerMonoid[];
}

const SUM0 = (name: string, partial: string): ReducerMonoid =>
  ({ name, partial, combine: 'sum', identity: 'zero' });
const SELF = (name: string, ext: 'min' | 'max'): ReducerMonoid =>
  ({ name, partial: name, combine: ext, identity: 'absorbing' });

const COUNT: ReducerMonoid = SUM0('count', 'count');
const SUM: ReducerMonoid = SUM0('sum', 'sum');

/** The reducer monoids, by reducer name. count/sum are SUM0; min/max are self-splitting; mean reduces to
 *  (sum, count) first. Every member of `REDUCERS` has an entry — asserted by a test so the two cannot
 *  drift. A reducer with no monoid here simply does not push (falls back to the local element reduce). */
export const REDUCER_MONOIDS: ReadonlyMap<string, ReducerMonoid> = new Map<string, ReducerMonoid>([
  ['count', COUNT],
  ['sum', SUM],
  ['min', SELF('min', 'min')],
  ['max', SELF('max', 'max')],
  ['mean', { name: 'mean', partial: null, combine: null, identity: 'zero', reduceFirst: [SUM, COUNT] }],
]);

/** The monoid for a reducer name, or `null` if it does not split (so the reduction stays local). */
export const reducerMonoid = (name: string): ReducerMonoid | null => REDUCER_MONOIDS.get(name) ?? null;

// A compile-time assertion that every REDUCERS member is covered — read by the drift-guard test.
export const UNCOVERED_REDUCERS: readonly string[] = [...REDUCERS].filter((r) => !REDUCER_MONOIDS.has(r));
