# Seam-reuse audit — rewriting pre-seam compilers onto the new primitives

**Date:** 2026-07-13 (original), **revised 2026-07-13** to record what actually landed.
**Status:** most of this shipped. Baseline **473 → 608** since the original audit. This
doc is now a *record* of what landed + what the build actually discovered, plus the
handful of seam-reuse items still open.
**Premise (unchanged):** recent work landed unifying seams — the `q` kernel + typed
`Relation` handles (`src/q.ts`), the `StepFn` prefix fold + `foldBody`
(`src/steps/index.ts`, `context.ts`), the `scalarTx` scalar-transform table and the
`compileNestedScalar` / `compileFilterPredicate` / `compileExistsChain` correlated
engines (`src/plan.ts`), `originSeed`/`St.origin` input-ordinal threading and the
`aliasCtx`/`resolveAlias` re-rooting (`src/steps/branch.ts`, `plan.ts`). A handful of
compilers predated or *duplicated* them, and the conformance blockers clustered on
exactly those spots.

## Scoreboard (what landed, 473 → 608)

| finding | status | L3 | notes |
|---|---|---:|---|
| #1 inject unification | ✅ done | 495→496 | `compileInject` moved into `projection.ts`, shares `foldTailAcc`+`renderProjection`; `write.ts` −50 lines; fixed the zero-CTE `g.inject()` render bug |
| #2 scalar casts (asBool/asNumber) | ✅ done | 496→534 | **NOT via `scalarTx` — the audit mis-sized this (see below).** Needed a typed-value carrier first |
| — math() | ✅ done | 583→589 | separate piece as #2 predicted; formula parser `src/math.ts` |
| — asDate/dateAdd/dateDiff + `datetime()` | ✅ done | 589→608 | separate piece; epoch-millis rep + `'date'` tag |
| #3 element-body `map` first-result | ⬜ open | — | still deferred (`map(__.out())` → defer) |
| #4 two `union`s / `optional` fast path | ⬜ won't-do | — | cleanup only, no unlock; keep the `optional` fast path |
| #5 filtered / multi-hop `repeat()` bodies | ⬜ open | — | `repeat(__.out().has(k,v))`, `repeat(__.out().out())` still defer |
| match() | ✅ done | 473→474 | `src/steps/match.ts`, built on `aliasCtx`/`resolveAlias` — the exact "use a new seam" pattern |
| withStrategies (optimization whitelist + semantic Subgraph/Partition) | ✅ done | 473→495→582 | net-new, not a rewrite |

Adjacent regions that also landed in the same window (not original findings):
per-traverser branching (choose/coalesce/union/optional/flatMap/map-scalar, 455→473),
alias threading (aliasCtx/resolveAlias), the whole **type/value region** carrier.

## The one big discovery — typed casts are NOT `scalarTx` entries

The audit's finding #2 billed `asNumber`/`asBool` as "just more scalar transforms that
plug straight into `scalarTx` — no new machinery, low/low, best first pick." **That was
wrong, and the reason is worth keeping.**

`scalarTx(name, args, v)` returns **only a SQL `Expression`** — no type information. That
is fine for the string transforms (`concat`/`length`/`toUpper`/`asString`/`substring`/
`replace`): they return text and never change the traverser's GraphBinary type. But a
typed cast has to set a compile-time **GraphBinary subtype tag** that SQLite's storage
class cannot recover:

- SQLite `typeof()` yields only `null`/`integer`/`real`/`text`/`blob`. A stored boolean
  is `integer` (indistinguishable from an int); byte/short/int/long all collapse to
  `integer`; float/double to `real`; a datetime is `integer`/`text` like any number/string.
- GraphBinary needs the exact subtype (`.b`/`.s`/`.i`/`.l`/`.n`/`.f`/`.d`, Boolean,
  DATETIME) — so the subtype must be carried as **compile-time metadata from the producing
  step**, not derived from the value.

So the real work was building a substrate that didn't exist: the **typed-value carrier** —
`Shape`'s value variant gained `as?: ValueType` (`src/render.ts`), and the handler's
`frameValue(v, as)` (`src/handler.ts`) frames `v` with the serializer the tag names. Only
then could the casts land, and they land by **branching in `renderProjection` /
`compileInject`** (which own `shape`), NOT in the `scalarTx` table (which can't express a
tag). `asDate`/`dateAdd`/`dateDiff` sit in `SCALAR_TX_NAMES` for the same reason — gathered
as tail transforms, but handled in `renderProjection` because they set `as`.

Lesson for future audits: "it's just another entry in table X" is only true if table X
carries everything the new thing needs. A cast carries a *type*; a string transform
doesn't. The string-transform half of #2 was the easy win; the typed-cast half was ~3
structural batches (carrier → per-subtype framing → frontend subtype recovery for bare
`asNumber` via `Step.argTypes`) and is now the substrate `math()` and the date family both
ride on.

## The seams available for reuse (current)

- **`foldBody(steps, seedSt, from)`** (`src/steps/index.ts`): folds the PREFIX dispatch
  over any step slice from a seeded `St`. Body engine for `union`/`optional`/`coalesce`/
  `choose`/`flatMap`.
- **the value tail** — `foldTailAcc(steps, from)` + `renderProjection(Q, proj, acc,
  indexKeys, orderKey)` (`src/steps/projection.ts`): the one shared scalar/element tail
  (transforms/is/dedup/order/range/inject-append/reducer). Fed by both `buildProjection`
  (element/values stream) and `compileInject` (a `VALUES` `v`-stream). **Add a value-tail
  step once, here, and it serves both.**
- **the typed-value carrier** — `Shape {kind:'value', as?: ValueType}` (`render.ts`) +
  `frameValue(v, as)` (`handler.ts`): a step tags its scalar with a GraphBinary subtype;
  the handler frames it. The seam every cast (`asBool`/`asNumber`/`asDate`) uses.
- **`scalarTx(name, args, v)`** (`src/plan.ts`): per-element scalar **string** transform
  table (text in → text out, no tag). For casts, branch in `renderProjection` instead.
- **`originSeed(st)` / `St.origin`** (`src/steps/branch.ts`): per-input ordinal
  (`ROW_NUMBER`) so a branch body's results stay tied to their input row. Backs
  `coalesce`/`optional`; the missing piece for element-body `map` (#3).
- **`compileNestedScalar` / `compileFilterPredicate` / `compileExistsChain`**
  (`src/plan.ts`): correlated-scalar / boolean-predicate / multi-hop-EXISTS engines shared
  by `by()`/`where()`; also the variable resolver for `math()`.
- **`aliasCtx` / `resolveAlias`** (`plan.ts`, `filter.ts`): re-root a correlated read onto
  an `as()`-bound rowid column. Backs alias-`where`, `match()`, and `math()` alias vars.

## Remaining seam-reuse backlog

### #3 element-body `map(__.<element>)` first-result via `foldBody` + `originSeed`
Still open — only scalar-body `map` landed (`compileMapScalar`). `flatMap` already folds an
element body through `branchArm`, and `originSeed` mints a per-input ordinal. `map(body)` =
`flatMap(body)` + "keep the first result per input" = `ROW_NUMBER() OVER (PARTITION BY o
ORDER BY …) = 1`. Machinery exists; only first-per-origin selection is new. Medium effort.

### #5 filtered / linear-multi-hop `repeat()` bodies
Still open (`repeat(__.out().has(k,v))`, `repeat(__.out().out())` defer). You **cannot**
drop `foldBody` into a recursive CTE's recursive term (it can't reference nested CTEs of
itself), but the term is extensible directly:
- **filtered body** → add a `WHERE` to the recursive term (reuse `predicateSql`/`propExtract`).
- **linear multi-hop body** → a multi-join recursive term.
Self-contained; lower priority than #3 (not a top bucket).

### #4 two `union`s + the `optional` fast path — won't-do
`seedUnion` (source-position) and `union` (mid-chain) are separate; `optional` keeps a
pre-`originSeed` single-hop LEFT JOIN fast path. Dedup/cleanup only, **no** unlock — and
**keep** the `optional` fast path (deliberate index-only optimisation, no window function).
Only touch if a future change forces the two union seeds to diverge.

## What NOT to chase here (net-new features, not rewrites)

- **`only one projection step` (~40)** — `values().count()`, `valueMap().select()` etc.
  still defer. A real tail-architecture limit; chained projections change the traverser
  *type*. Genuinely hard, not a seam-reuse.
- **`local` (~64)** — per-element Scope; net-new.
- **`aggregate`/`cap`/`sack` (~44+19)** — side-effect state; a new execution notion
  (named collections that outlive the current id-relation).
- **`format()`** — template substitution; net-new (small, but its own piece — the sibling
  the #2 scope-discipline note correctly set aside).

## Re-bucketing the deferrals (refresh the numbers)

The counts in this doc are historical (baseline 473 for the original table; scoreboard
current at 608). Re-run before acting if numbers matter:

```sh
bun test test/conformance/l3.test.ts 2>&1 \
  | grep -oE "ERR  \[.*" | sed -E 's/ERR  \[.*\] //' \
  | sort | uniq -c | sort -rn | head -40
```

Each item lands with SQL snapshot tests + an execution test + `bun test
test/conformance/l3.test.ts` (baseline auto-bumps locally, per `CLAUDE.md`), corpus 100%.
