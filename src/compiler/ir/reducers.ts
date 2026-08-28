// ---------- reducers: how a terminal reducer SPLITS into partial-remote + combine-local ----------
//
// A federate mid-traversal reduction (`V().call(federate,…,inj).count()`) can push its reducer to the
// sibling as a PARTIAL keyed by the injected map key, then COMBINE the partials locally per parent — the
// same answer, but only a `(key→partial)` map crosses the wire instead of every element. This is a
// TRANSPORT OPTIMIZATION over a path that already produces the right answer (element scatter + local
// reduce), so the combine must satisfy the SPLIT law
//
//     combine(partial(A), partial(B)) ≡ reduce(A ∪ B)
//
// which is exactly what makes "partial remote, combine local" correct. It is Calcite's
// `SqlSplittableAggFunction` (`vendor/calcite/core/.../sql/SqlSplittableAggFunction.java`): `split()` is
// the partial, `topSplit()` the combine. `CountSplitter` (`:107`) keeps COUNT on the subset and combines
// with **SUM0** (`SqlSplittableAggFunction.java:148`); `SelfSplitter` (`:202`) is MIN/MAX; `AVG` is not
// splittable directly and `AggregateReduceFunctionsRule` decomposes it to `SUM/COUNT` first.
//
// **These reducers are NOT all monoids — most are SEMIGROUPS, and that distinction is the whole reason
// for the empty-input asymmetry.** A monoid has an IDENTITY; a semigroup is only associative. TinkerPop
// models the family this way (`vendor/tinkerpop/gremlin-core/.../step/util/ReducingBarrierStep.java`):
//   - **`count` is the lone MONOID** — it installs an explicit `ConstantSupplier(0L)`, so its identity is
//     0 and `count` over an EMPTY stream is `0`. (0 is a type-independent identity: it counts occurrences,
//     not user values.)
//   - **`sum`/`min`/`max`/`mean` are SEMIGROUPS** — `ReducingBarrierStep` seeds from the FIRST traverser
//     (`generateSeedFromStarts`), and each overrides `processAllStarts` with `if (starts.hasNext())`, so
//     over an EMPTY stream they emit NOTHING (no identity to fall back on). `min`/`max` genuinely have no
//     finite identity over arbitrary comparables; `sum`/`mean` COULD seed 0 but TinkerPop chose family
//     consistency with min/max (TINKERPOP-1777, a deliberate `breaking` change in 3.4.0 — the old
//     behaviour returned `Integer.MIN_VALUE`/`NaN`; the sanctioned "I want 0" idiom is a user
//     `coalesce(…, constant(0))`, not an engine-supplied identity).
//
// So `empty` below is the per-reducer empty-input answer, NOT a monoid identity: `'zero'` = the monoid
// `count` (emit 0), `'nothing'` = a semigroup (emit no traverser).
//
// This module is the DECLARATION (data + a tiny classifier); the lowering that applies it lives in the
// federate resume. A leaf: it imports nothing but the reducer name set.

import { REDUCERS } from './step.ts';

/** What a reducer emits over an EMPTY input — the load-bearing monoid-vs-semigroup distinction:
 *   - `'zero'`: the MONOID `count` — its identity 0, emitted even over no input.
 *   - `'nothing'`: a SEMIGROUP (`sum`/`min`/`max`/`mean`) — no identity, so an empty input emits NO
 *     traverser (matching TinkerPop's `ReducingBarrierStep` guard). */
export type EmptyResult = 'zero' | 'nothing';

/** How a reducer SPLITS for pushdown: the step the SIBLING runs as the partial, the SQL aggregate that
 *  COMBINES partials locally, and what it emits over empty. `count`'s partial is a COUNT but its combine
 *  is SUM0 (Calcite `CountSplitter`) — you sum the sub-counts, you do not re-count. */
export interface Reducer {
  /** The reducer as the user wrote it (the local, un-optimized authority). */
  readonly name: string;
  /** The Gremlin reducer step the SIBLING runs per group to produce the partial — `count`'s is `count`,
   *  `sum`/`min`/`max`'s is itself. `null` = NOT a simple splittable partial (mean), handled by
   *  `reduceFirst` instead. */
  readonly partial: string | null;
  /** The SQL aggregate FN that combines partials locally: `count`/`sum` combine with `sum` (SUM0),
   *  `min`/`max` with themselves. `null` when `reduceFirst` is set. */
  readonly combine: 'sum' | 'min' | 'max' | null;
  /** What an EMPTY input emits (see `EmptyResult`) — `count` (monoid) emits 0, the semigroups emit nothing. */
  readonly empty: EmptyResult;
  /** For a reducer that does not split directly (`mean`): the splittable reducers it decomposes to,
   *  combined then recomposed locally (`mean = sum/count`). Calcite `AggregateReduceFunctionsRule`. */
  readonly reduceFirst?: readonly Reducer[];
}

/** `count`/`sum`: partial + SUM0 combine. `count` is the MONOID (empty → 0); `sum` is a SEMIGROUP
 *  (empty → nothing) that happens to combine additively. */
const additive = (name: string, partial: string, empty: EmptyResult): Reducer =>
  ({ name, partial, combine: 'sum', empty });
/** `min`/`max`: SEMIGROUPS — self-splitting (combine with the same extremal op), empty → nothing. */
const extremal = (name: string, ext: 'min' | 'max'): Reducer =>
  ({ name, partial: name, combine: ext, empty: 'nothing' });

const COUNT: Reducer = additive('count', 'count', 'zero');   // the lone MONOID: identity 0
const SUM: Reducer = additive('sum', 'sum', 'nothing');       // a semigroup, additive combine

/** The reducers, by name. `count` is the monoid; `sum`/`min`/`max`/`mean` are semigroups. Every member of
 *  `REDUCERS` has an entry — asserted by a test so the two cannot drift. A reducer with no entry does not
 *  push (falls back to the local element reduce). */
export const REDUCER_TABLE: ReadonlyMap<string, Reducer> = new Map<string, Reducer>([
  ['count', COUNT],
  ['sum', SUM],
  ['min', extremal('min', 'min')],
  ['max', extremal('max', 'max')],
  ['mean', { name: 'mean', partial: null, combine: null, empty: 'nothing', reduceFirst: [SUM, COUNT] }],
]);

/** The reducer split for a name, or `null` if it does not split (so the reduction stays local). */
export const reducerOf = (name: string): Reducer | null => REDUCER_TABLE.get(name) ?? null;

// A compile-time assertion that every REDUCERS member is covered — read by the drift-guard test.
export const UNCOVERED_REDUCERS: readonly string[] = [...REDUCERS].filter((r) => !REDUCER_TABLE.has(r));
