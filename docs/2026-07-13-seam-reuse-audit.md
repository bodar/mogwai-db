# Seam-reuse audit — rewriting pre-seam compilers onto the new primitives

**Date:** 2026-07-13
**Status:** proposal / backlog (nothing here is done yet)
**Premise:** the last few days landed unifying seams — the `q` kernel + typed
`Relation` handles (`src/q.ts`), the `StepFn` prefix fold + `foldBody`
(`src/steps/index.ts`, `context.ts`), the `scalarTx` scalar-transform table and the
`compileNestedScalar` / `compileFilterPredicate` / `compileExistsChain` correlated
engines (`src/plan.ts`), `originSeed`/`St.origin` input-ordinal threading and the
`aliasCtx`/`resolveAlias` re-rooting (`src/steps/branch.ts`, `plan.ts`). Most step
compilers already route through these. A handful predate or *duplicate* them, and —
usefully — the conformance blockers cluster on exactly those spots. This doc records
which older code can be rewritten onto a newer seam, for **simplicity** (less code,
fewer parallel folds) and/or **capability** (unlock deferred L3 scenarios).

This is an audit + plan. It does **not** change behaviour. Pick items off it
individually; each lands with SQL snapshots + an execution test + an L3 re-check,
per the build discipline in `CLAUDE.md`.

## Method — ranked by real impact, not guesswork

Bucketed every deferral the L3 suite hits (2041 scenarios, baseline 473) by the
error message the compiler throws, most-frequent first.

> **Freshness:** the table below is a snapshot at **baseline 473 (2026-07-13)**.
> `match()` and a whitelist of result-preserving strategies landed on trunk right
> after (baseline → 495), so the `match()` / `withStrategies` / `withoutStrategies`
> rows are now partly stale. The seam-reuse findings below (#1 inject, #2 scalarTx,
> #3 map) are **unaffected** — they target unrelated buckets. Re-run the bucketing
> (see the one-liner at the end) before acting if the numbers matter.

| count | deferral |
|------:|----------|
| 166 | `withStrategies(...)` rejected (fail-closed; net-new feature) |
| 64  | `local()` (net-new, Scope) |
| 44  | `aggregate()` (net-new, side-effect state) |
| 42  | `withoutStrategies(...)` rejected (fail-closed) |
| 40  | `only one projection step is supported per traversal` |
| 35  | `asNumber()` (scalar transform) |
| 34  | `match()` (net-new; planned on aliasCtx) |
| 29  | `merge` with a traversal argument (net-new, write-side) |
| 27  | `inject() with subsequent step asNumber()` |
| 21  | `as()` in the tail |
| 19  | `inject() with subsequent step sack()` |
| 17  | `tail()` / `after group(): cap()` |
| 13  | `math()`, `inject()…asBool()` |
| 11  | `where()` (residual forms), `Cardinality.list`, stray `by()` |
| ~100 (cumulative) | `inject() with subsequent step <X>` across `and`/`or`/`filter`/`unfold`/`asNumber`/`asBool`/`asDate`/`any`/`all`/`sack` |

The two kinds of win we care about sit at rows `asNumber` (a seam that's trivially
extensible) and the whole `inject() with subsequent step` cluster (a compiler that
duplicates the shared tail).

## The seams available for reuse

- **`foldBody(steps, seedSt, from)`** (`src/steps/index.ts`): folds the PREFIX
  dispatch over any step slice from a seeded `St`. Multi-hop element bodies work.
  Already the body engine for `union`/`optional`/`coalesce`/`choose`/`flatMap`.
- **`scalarTx(name, args, v)`** (`src/plan.ts`): per-element scalar string/cast
  transform table → a SQLite scalar expression. Called by *both* the read tail
  (`projection.ts` `SCALAR_TX_NAMES`) and the inject path (`write.ts`).
- **`originSeed(st)` / `St.origin`** (`src/steps/branch.ts`): tags each input
  traverser with a unique ordinal (`ROW_NUMBER`) so a branch body's results stay
  tied to their input row. Backs `coalesce`/`optional`.
- **`compileNestedScalar` / `compileFilterPredicate` / `compileExistsChain`**
  (`src/plan.ts`): the correlated-scalar / boolean-predicate / multi-hop-EXISTS
  engines shared by `by()` and `where()`.
- **the value tail** (`projection.ts` `buildProjection` + `MODIFIERS`): the
  `order`/`range`/`skip`/`limit`/`dedup`/`is`/`inject`/reducer fold over a scalar
  (`v`) stream.

## Findings, ranked

### 1. `compileInject` duplicates the value tail — unify it (simplicity + capability)

`compileInject` (`src/steps/write.ts:84`) hand-rolls its own fold over
`dedup`/`order`/`is`/`limit`/`range`/`skip`/`scalarTx`/reducer — the *same* modifier
logic `compileTail`/`buildProjection` (`src/steps/projection.ts`) already implements,
as a second parallel copy. It also lives in `write.ts` despite producing a **read**
shape (it's classed as a write only because it's `inject`-rooted, i.e. has no `V/E`
source).

- **Rewrite:** treat `inject(...)` as a **scalar-stream source seed** — a `VALUES`
  CTE producing a `v` column — that flows into the *shared* value tail, deleting
  `compileInject`'s duplicated modifier fold. Mechanically: add an `inject` source
  case alongside `V`/`E`/`union` in `buildPrefix` (or a dedicated scalar-seed entry
  into `compileTail`), and let `buildProjection`'s existing fold handle the tail.
- **Capability:** the `inject() with subsequent step <X> not yet supported` reject
  (`write.ts:118`) is the largest cumulative blocker (**~100 scenarios**). Unifying
  does not unlock all of them — some subsequent steps (`unfold`, `sack`, `and`/`or`
  on a scalar stream) are genuinely unimplemented — but it converts them from "blocked
  by inject's narrow private fold" to "works as soon as the step exists in the shared
  tail." It also removes a whole duplicated fold.
- **Effort/risk:** medium. The wrinkle: `inject` seeds a *scalar* stream (`v`), not an
  `id` element-relation, so it feeds the value tail, not the movement prefix (you
  can't `out()` a constant). Keep that boundary explicit.

### 2. Extend `scalarTx` with `asNumber` / `asBool` — the clean easy win

`scalarTx` (`src/plan.ts:54`) is a tidy, closed table (`concat`/`length`/`toUpper`/
`asString`/`substring`/`replace`). `asNumber()` and `asBool()` are just more scalar
transforms (`CAST(... AS REAL/INTEGER)`, a truthiness test) that plug straight in.
Because both the read tail (`projection.ts` `SCALAR_TX_NAMES`) and `compileInject`
call `scalarTx`, adding them unlocks **both** paths at once.

- **Rewrite:** add cases to `scalarTx`; add the names to `SCALAR_TX_NAMES`
  (`projection.ts:43`). No new machinery.
- **Capability:** `asNumber()` = **35** direct + a slice of the inject-`asNumber`
  (**27**); `asBool` adds more. Realistically ~40–50 scenarios.
- **Scope discipline:** stop at `asNumber`/`asBool`. `asDate` (needs a datetime
  representation), `format()` (template substitution), and `math()` (needs a formula
  parser over a variable expression) are **not** easy and must not be lumped in — they
  are separate, larger pieces.
- **Effort/risk:** low/low. Best first pick.

### 3. `map(__.<element>)` first-result via `foldBody` + `originSeed` (capability)

Element-body `map` is deferred (only scalar `map` landed — `compileMapScalar`).
`flatMap` already folds an element body through `branchArm`, and `originSeed` already
mints a per-input ordinal `o`. `map(body)` = `flatMap(body)` + "keep the first result
per input" = `ROW_NUMBER() OVER (PARTITION BY o ORDER BY …) = 1`. The machinery exists;
only the first-per-origin selection is new.

- **Effort/risk:** medium. Moderate scenario count. A genuine reuse of two existing
  seams.

### 4. Two `union` implementations + the `optional` fast path (simplicity, low priority)

`seedUnion` (`src/steps/index.ts:73`, source-position union) and `union`
(`src/steps/branch.ts:76`, mid-chain) are separate code. `optional` (`branch.ts:94`)
keeps a pre-`originSeed` single-hop LEFT JOIN fast path alongside its general
`originSeed` path. These are dedup/cleanup only — **no** conformance unlock.

- **Recommendation:** low priority, and *keep* the `optional` fast path — it's a
  deliberate index-only optimisation (no window function) for the common
  `optional(out())` case. Only worth touching if a future change forces the two union
  seeds to diverge in behaviour.

### 5. `repeat()` bodies — the last hand-rolled branch body (capability, constrained)

Every other branch step folds its body through `foldBody`; `repeat()`'s recursive
term (`branch.ts`, the `recursiveCte` callback) still hand-rolls a single
`out/in/both`. You **cannot** drop `foldBody` in — a SQL recursive CTE's recursive
term can't contain nested CTEs that reference the CTE itself. What *is* tractable is
extending the recursive term directly:

- **filtered body** `repeat(__.out().has(k,v))` → add a `WHERE` to the recursive term
  (reuse `predicateSql`/`propExtract`).
- **linear multi-hop body** `repeat(__.out().out())` → a multi-join recursive term.

Not in the top blocker buckets, so lower priority than 1–3, but the filtered-body form
is the valuable, self-contained subset when it comes up.

## What NOT to chase (here)

- **`only one projection step` (40)** — a real tail-architecture limit
  (`projection.ts:128`), but chained projections change the traverser *type*; it is
  genuinely hard, not a seam-reuse.
- **`local` / `aggregate` / `withStrategies`** — the biggest raw buckets, but net-new
  features (Scope, side-effect state, strategy application), not rewrites. (`match`
  **has since landed** on trunk — `src/steps/match.ts` — built on `aliasCtx`/
  `resolveAlias`, exactly the "use a new seam" pattern; it's done, not a to-do.)

## Recommended sequence

1. **#2 `scalarTx` casts (`asNumber`/`asBool`)** — easy win, low risk, existing seam,
   ~40+ scenarios, unblocks both the read tail and the inject path.
2. **#1 inject unification** — higher-effort structural cleanup that removes a
   duplicated fold and compounds with #2 (the widened scalar stream flows through one
   tail).
3. **#3 element-body `map`** — reuses `foldBody`/`originSeed` for a real capability
   bump once 1–2 are in.

Each item: SQL snapshot tests + an execution test + `bun test test/conformance/l3.test.ts`
to confirm the baseline moves (auto-bumps locally, per `CLAUDE.md`), corpus stays 100%.

## Re-bucketing the deferrals (refresh the table)

```sh
bun test test/conformance/l3.test.ts 2>&1 \
  | grep -oE "ERR  \[.*" | sed -E 's/ERR  \[.*\] //' \
  | sort | uniq -c | sort -rn | head -40
```

