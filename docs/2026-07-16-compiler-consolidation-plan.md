# Compiler consolidation — the strategic map (2026-07-16)

**Status:** research + plan. Telemetry harness LANDED (this commit); architecture
bets scoped, not yet built. **Baseline at authorship:** L3 956, corpus 2298/2298.

**What this is.** A principled, code-grounded map of where the compiler carries
duplication / locally-optimized mini-compilers, where it defers language and why,
and the *bold* structural moves that make the engine more correct and more
malleable — independent of whether each one moves the conformance number. The
conformance ratchet is our safety net, not the target: a refactor that unlocks
future query translations and removes duplication is a win even at +0 scenarios.

Sourced from a full read of `src/steps/*`, `src/plan.ts`, `src/strategies.ts`,
`docs/feature-support-matrix.md`, the deferral `throw` sites, and the
2026-07-15 unified-lowering + 2026-07-16 labels-as-path-history docs.

---

## 0. The one meta-finding

The compiler has a clean generic spine: `lowerSteps → lowerStream →
lowerElementSteps` (`src/steps/index.ts`) over a `Stream` union, with `child.ts`
as the correlated-child engine. Every recent win was a **lift onto that spine**,
not a new feature: scalar, list, variant, and (2026-07-16) `as()`-labels were all
moved there. The labels work is the exemplar — it replaced "three copy-pasted
`pop !== 'last'` guards" with one path-history model dispatched once
(`dispatchAlias`, `index.ts:253`).

**The remaining duplication and the remaining deferred language are the same gap
from two sides.** Three things never got lifted:

1. **Three shapes stayed terminal islands** — `map` / `group` / `path`. They
   materialize at the root and cannot collapse into a carried value or re-enter
   the tail. This gates the path-tail, Map-unfold, `valueMap().select()`,
   element-value group maps, mixed `select(Column)`, and labels follow-up #3.
2. **The element tail** never moved onto the stepwise engine → a whole
   **duplicate value-tail compiler** (`foldTailAcc`/`renderProjection`/
   `wrapReducer`) shadows `lowerScalarRows` + `barrier.ts`.
3. **Predicate lowering** got a generic fallback in one caller (`where`) but not
   the others (`choose`/`coalesce`/`until`), so those three *define* support
   (throw) instead of falling through.

Everything below hangs off those three observations.

---

## 1. Duplication audit — real debt vs. justified

### Real, load-bearing debt (remove-to-unlock)

| # | Debt | Nature | Blocks |
|---|---|---|---|
| D1 | **Dual value-tail engine** — `foldTailAcc`/`renderProjection`/`wrapReducer`/`MODIFIERS` (`projection.ts`) vs `lowerScalarRows`+`barrier.ts` (`scalar.ts`/`barrier.ts`) | the element accumulator **defines** support (`step not implemented: X()` throw at `projection.ts:150`) | element-tail modifiers *before* a barrier (`order().limit().count()`); this is the single largest internal duplication |
| D2 | **`tryInlinePredicate`/`compileInlinePredicate`** (`plan.ts:433-605`) | true fast-path in `where` (falls through to `tryFilterByChildExistence`); **support-definer** in `choose`/`coalesce`/`until` (throws — `branch.ts:44,565,597`) | complex predicates across the whole branch + repeat families |
| D3 | **`tryInlineScalar`/`requireInlineScalar`** (`plan.ts:332-413`, `group.ts:22-26`) | support-definer — engages *only because* property-group / `cap('a')` group sources have **no live `ElementStream` parent** (`group.ts:136` returns null → forced onto the inline path) | property-group keys/values, group-over-`properties()`, `cap('a')` group |

Concrete duplication evidence for D1: the scalar transform ladder is written
twice, near-identically — `renderProjection` (`projection.ts:646-668`) and
`scalarTransform` (`scalar.ts:34-53`) both branch asNumber/asDate/dateAdd/
dateDiff/else-scalarTx; the transform-name set is duplicated (`SCALAR_TX_NAMES`
`projection.ts:54` ≡ `SCALAR_TRANSFORMS` `scalar.ts:9`); reducer logic exists in
**three** places — `wrapReducer` (`projection.ts:718`), `barrier.ts`
`lowerGlobalNumericReducer` (the stepwise authority), and `scalar.ts`
`lowerListReducer` (Scope.local).

### Maintainability-only (not feature-blocking)

- **`child.ts` double-parse.** Each child shape is parsed twice — six
  `is*Child` preflights (`child.ts:118-182`) decide *which* dispatch branch runs,
  then the `compile*ChildRows` re-parse (`childSteps` + `scalarRowParts`/
  `elementRowParts`). They must stay in lockstep; the "preflight/compiler
  mismatch" throws (`branch.ts:219,318,336`; `group.ts:183,192`) are dead-code
  invariants asserting the two parses agree. Also a **third** `values/id/label`
  projector is hand-rolled in `compileScalarChildRows` (`child.ts:310-337`)
  instead of reusing the `PROJECTORS`.
- **Switch-vs-Map inconsistency.** The prefix uses a `PREFIX` Map and the tail
  render uses `MODIFIERS`/`PROJECTORS` Maps, but every *shape dispatcher* is a
  long `if (steps[at].name === …)` chain: `compileTail`, `compileFromScalar`,
  `compileFromProperty`, `compileFromList`, `compileFromRecord`.

### Justified — NOT removable (do not "simplify" these)

- **`bulk.ts`** — a sanctioned fast path per the CLAUDE.md law (switch
  `fastPaths.bulkRepeatCount`, returns null to fall through, equivalence test).
  Its sibling-peeking / index arithmetic is the whole point.
- **`match.ts`** — a declarative sub-language; SQLite offers no generic
  join-planner seam to route it through. Isolated to the match family.
- **repeat-body parser** (`expandRepeatBody`, `branch.ts:369-530`) — forced by
  SQLite's "recursive table appears once in FROM" constraint. Cannot be StepFns.
- **`write.ts` interpreters** — a deliberately separate imperative seam
  (`WRITE_RULES` table). Not read-path debt.
- Legacy branch element compilers are **no longer** mini-compilers: element arms
  already route through `tryCompileElementTraversal` → the generic engine. What
  remains in `branch.ts` is branch-specific merge/gate logic, which is correct.

---

## 2. Deferral map — platform walls vs. gaps we own

### Platform walls — correctly closed, do NOT chase

Each fails closed with a clear message; none is an architectural gap.

| Wall | Deferred | Why truly impossible |
|---|---|---|
| No SQLite `regexp` UDF | TextP `regex`/`notRegex` | DO blocks `create_function`/`load_extension`; JS filter violates locked #3 |
| Storage class carries no type tag | `typeOf(GType)` over stored props | `typeof()` can't tell a stored datetime/bool/uuid from int/text (a schema-change away, but chosen not to) |
| JS client `Date` = bare UTC-ms instant | datetime offset-label + sub-second | reference client serializes offset=0/ms; comparator checks instants — zero gain, breaks locked #4 |
| No client serializer | `bigdecimal` | not in the reused `gremlin` package |
| JS GLV stub | `tree()` | 0 conformance (13 scenarios ignored + `DataType.TREE` stubbed) |
| Locked non-goals | lambdas, OLAP, multi-request tx, `store()` (dropped in v4), BulkSet wire | design stance / removed from v4 / needs DO session state |

### Gaps we own — the strategic targets, by leverage

1. **Dynamic-tag VariantStream (widest).** `VariantStream` is deliberately narrow
   (`null | scalar | one element-kind`). No general wide tagged row that root
   materialization can frame by a runtime tag. One substrate — a gated wide
   tagged row + tag-framing at `materializeRoot` — unblocks: mixed arms in *all
   four* branch steps, record `fold`/`order`, element-value group maps, mixed
   `select(Column.values)`, mixed element-kind path positions, static
   `Pop.mixed`. Named blocker in matrix §3/§4/§5/§7/§9 — the broadest recurrence.
2. **Path as a re-enterable stream (cleanest).** `PathStream` materializes
   terminally. The proven template is `fold`/`unfold` (the list substrate).
   Unblocks the entire "steps after `path()`" tail, set-ops-after-path,
   `path().by()` through branches, `as()`-on-path. High ratio, self-contained.
3. **Route write arguments through `lowerSteps` (Cluster 7).** The write chain is
   a separate `WritePlan` interpreter that doesn't feed args through the read
   child compiler. Unblocks nested merge maps, `addE` endpoint traversals,
   `option(…, __.trav)`, traversal-valued `property()`.

### Deliberately parked (largest raw counts, lowest value/effort)

- **within/without readback** — eager-vs-lazy divergence; our set-at-a-time model
  computes the whole aggregate before the join, so incremental visibility can't
  be expressed without a row-ordered execution (fights locked #3).
- **comparability / NaN / mixed-type ordering** — fail-closed by policy
  (`correct-by-design` memory: fail closed over number-chasing).

---

## 3. The bold pieces, in build order

Each is a **lift onto the existing spine**, not a rewrite. Marked with whether it
primarily moves conformance or is a malleability/debt-removal win.

**P0 — Telemetry.** *(LANDED this commit.)* A pass-through logging
`GraphManager` decorator in the test-only conformance host writes NDJSON
`{g, gremlin, ok, error, steps}` (reusing the L1 corpus parse machinery); the L3
test joins it with the cucumber report and prints a deferral-bucket view. Gated
on `MOGWAI_L3_TELEMETRY`; default `bun test` is byte-identical → zero ratchet
risk. This turns every bet below from a guess into a measurement. See §4.

**P1 — Unify the tail** *(debt removal; small feature unlock).* Migrate the
element tail off `foldTailAcc` onto the stepwise `lowerScalarRows` + `barrier`
engine; delete `wrapReducer`/`renderProjection`/the duplicate transform ladder
and name-set. Highest-value refactor: the duplicate tail is what forces every new
tail feature to be written twice. Unlocks element-tail modifiers before a barrier
(`order().limit().count()`). *This is the archetypal "malleability win that barely
moves the number" — and it should be done first among the code bets.*

**P2 — One predicate seam** *(broad feature unlock; small diff).* Give
`choose`/`coalesce`/`until` the same `tryFilterByChildExistence` fallback that
`where` already has (D2). Three support-definers become fast-paths over a generic
floor. Unblocks complex predicates across the branch + repeat families.

**P3 — Lift `map`/`group`/`path` to first-class re-enterable streams** *(the big
substrate).* Do **path first** (clean; `fold`/`unfold` is the template), then the
map-valued carried entry + group collapse (subsumes labels follow-up #3,
Map-unfold, `valueMap().select()`, element-value group maps). Naturally retires
the `child.ts` double-parse by unifying the shape model.

**P4 — Dynamic-tag VariantStream** *(widest gate; pairs with P3).* Teach root
materialization to frame by a runtime row tag. Unblocks mixed arms everywhere.

**P5 — Give group sources a live parent stream** *(debt removal).* So
property-groups / `cap('a')` reach the generic child engine, retiring
`tryInlineScalar` (D3).

P1, P2, P5 are debt-removal that unlock features as a side effect. P3, P4 are new
substrate. Sequencing rationale: clear the duplication (P1) and the predicate
asymmetry (P2) first so the substrate work (P3/P4) is written once, on a clean
spine, not forked across the accumulator and the stepwise engine.

---

## 4. Telemetry — how to use it

```
MOGWAI_L3_TELEMETRY=1 bun test test/conformance/l3.test.ts
```

Prints an `L3 TELEMETRY` block (deferral buckets ranked by frequency, failing-step
frequency, scenario tallies) and writes `test/conformance/l3-telemetry.summary.json`
+ the raw `l3-telemetry.ndjson`. Both are gitignored.

- **Deferral buckets** = the systematic-gap view: quoted tokens and digits are
  masked (`limit(5)`→`limit(N)`) so N one-off failures collapse into the FEW walls.
  The bucket ranking is the empirical version of §2/§3 — it says which deferral
  *message* costs the most scenarios, so P1-vs-P3 prioritization is measured, not
  guessed.
- **ok:true but scenario failed** = a wrong-answer (compiled fine, wrong result),
  distinct from a compile/exec throw. Worth a separate look — a different class of
  bug from a deferral.
- Follow-up (not built): structured deferral codes (`DEFER[union-in-repeat]: …`)
  once the buckets show which messages dominate — makes aggregation exact instead
  of substring-masked. Deferred deliberately: it touches production throw sites and
  a few `raise an error with message` scenarios assert on message substrings, so
  do it *targeted* after the data, not shotgun.

---

## 4a. First empirical run — the buckets (2026-07-16, L3 956/2041)

`MOGWAI_L3_TELEMETRY=1 bun test test/conformance/l3.test.ts` on the authorship
commit: 3805 queries, 2127 unique, **885 unique failed** (compile/exec throw).
Ratchet held at 956 exactly — proof the decorator is behaviour-neutral. Top
deferral buckets (unique failing queries), grouped by the root cause they map to:

**A. Scalar-rooted / scalar-tail can't re-enter filter/branch — ~110+ scenarios,
the single biggest addressable lever.** Every one is a step that IS supported at
root, failing because `compileFromScalar` doesn't route back through the generic
element/predicate machinery:
`and()` 9 · `or()` 9 · `filter()` 9 · `where()` 7 · `choose()` 7 · `merge()` 7 ·
`constant()` 9 · `sack()` 19 · `groupCount()` 18 · `math()` 12 · mid-chain `V()`
12 (e.g. `g.inject(1).and(__.is(eq(1)),__.is(gt(0)))`, `g.inject(0).V().both()…`).
**This is exactly P1 (unify the tail) + P2 (predicate seam).** The data promotes
them from "cleanup" to the highest-count target and pins the concrete sub-goal:
a scalar/inject/`call`-rooted stream must re-enter `lowerElementSteps` +
`tryFilterByChildExistence` for filter/branch/and/or, not throw
`step not implemented`.

**B. Strategy tails — 54 (bigger than the a-priori ranking).**
`SubgraphStrategy(edges)` 39 + `withStrategies` unknown/semantic 15 (the latter
includes correctly-closed OLAP-ish ones like `ComputerFinalizationStrategy`). The
edge-criterion Subgraph injection (Cluster 9) is worth its own pass.

**C. Write args through `lowerSteps` (Cluster 7 / P3-writes) — 26.**
`merge with a traversal argument` (`mergeE(…).option(Merge.onCreate, __.select…)`).

**D. Child-shape coverage in the generic child engine — ~38.**
`local() child shape` 22 + `map() child` 8 + `choose().option() traversal` 8 —
mostly `choose().option(between(…), __.…fold())` element/predicate-keyed bodies.

**E. Terminal-island shapes (P3) — ~30.** `valueMap().select(Column.*)` 18 +
`element group value` / `group().by(__.properties().groupCount()…)` 11.

**F. `by(traversal)` / `by()` modulator generality — ~14.**
`by(__.coalesce(...))` and `by('age')` on non-modulator hosts.

**G. Isolated / non-architectural:**
- list-valued property **bind** coercion 22 (`property('list',['a','b','c'])` →
  `Binding expected string…`) — a write/bind bug, cheap and self-contained, NOT
  architecture. Likely a quick win.
- `unsupported source step: call` 14 — the v4 `call()` service step, entirely
  unimplemented as a source (scope question, not on the current map).
- `asNumber(GType.BIGDECIMAL)` ~12 — platform wall (no client serializer),
  correctly closed.

**Revised leverage order given the data:** P1+P2 first (they cash out cluster A,
the largest, and are debt removal) → then the list-property bind quick win (G) →
then choose between C (writes-through-lowerSteps, 26, self-contained) and the
Subgraph-edges pass (B, 39, self-contained) by appetite → then P3/P4 for the
terminal-island + mixed-shape families (D/E). The a-priori "widest = VariantStream"
still holds for *breadth of step families*, but by *raw scenario count today* the
scalar-tail re-entry (A) is the biggest single unlock, and it's the cheapest
because it's removing duplication we already own.

## 4b. Milestone B1 landed — value streams first-class for filter/branch (L3 956→1002, +46)

Made the filter family (`and`/`or`/`not`/`filter`/`where`) and `constant()`
shape-agnostic over a scalar current object (`scalar.ts` `scalarChildProduces` +
`lowerScalarFilter` + `lowerConstant`, dispatched from `compileFromScalar` and
`compileTail`). Reuses the predicate leaf (`predicateSql`) + transform ladder
(`scalarTx`), NOT a forked engine; element-only bodies fail closed. Additive — every
affected form previously threw. Committed `98169dc`, CI green.

**Refreshed telemetry (post-B1, 845 unique failed).** The B1 buckets are cleared.
New top single levers:
- `SubgraphStrategy(edges)` 39 — strategy adjacency (Cluster 9 / P-strategy).
- merge family ~40 — `merge` traversal-arg 26 + merge-on-list 14 (Cluster 7 / P3
  writes-through-`lowerSteps`; the reusable traversal-valued-argument substrate).
- `local()` child-shape 22 — generic child-engine coverage (choose/option element bodies).
- **list-valued `property('list',[…])` bind 22 — a BUG, not a missing feature**
  (a JS array bound as a SQLite value throws). Cheap, isolated, high-value.
- `select()` on a valueMap shape 18 — terminal-island (Cluster 8 / P3 map/group/path).
- value-streams-theme continuation for other families: `sack`/`groupCount`/`math`
  over a scalar ~49 combined (each a distinct sub-problem).

B2 (choose/coalesce over a scalar) is now only ~7 and needs a heavy child-engine
generalization → deprioritized. Next bold target chosen from the refreshed data,
not the pre-B1 ranking.

## 4c. Value-streams-first-class continued — sack over scalar (L3 1002→1021, +19)

`withSack()` was silently dropped for `inject`-rooted chains (inject compiles via
`routeWrite`, which never received `sackInit`); threaded it through
`routeWrite → compileInject`, seeding the carried `sk` column on the VALUES relation
like `seedSource`. sack mutate/read over a `ScalarStream` (`scalar.ts`
`lowerScalarSack`) folds the current value into the sack (no by() — the scalar IS the
value) / rebinds to the sack value. `combineSack`+`SACK_OPS` moved to `scalar.ts`; the
element sack StepFn reuses them (one implementation). Committed, CI green.

**Value-streams-first-class is now substantially DONE as a coherent abstraction.** A
scalar traverser supports: is / transforms / order / limit / dedup / reducers / fold /
unfold (pre-existing) + and/or/not/filter/where/constant (B1) + sack (this). Total for
the theme: +65 (956→1021), two commits, both CI green.

**The one true remnant** is `choose`/`coalesce` over a scalar parent (~7): its arms are
barriers over gated subsets (`inject(1).choose(__.is(1), __.constant(10).fold(),
__.fold())`), which needs a gated-scalar-arm engine — disproportionate for 7 scenarios,
and genuinely separate BRANCH-family work, not a dangling half of the value-stream
abstraction. Deferred as scoped follow-up. `math`/`groupCount` over scalar are red
herrings (blocked by the BIGDECIMAL platform wall and by choose-options/property-group
deferrals respectively) — not value-stream gaps.

## 5. What NOT to do

- Do not chase the platform walls (§2) — they are correctly closed.
- Do not "simplify" `bulk.ts`/`match.ts`/`expandRepeatBody`/`write.ts` — they are
  architecturally forced, not debt.
- Do not add a new mini-compiler or a private child-traversal parser to unblock a
  single scenario (the CLAUDE.md extension law). If a shape needs support, lift it
  onto the spine.
- Do not build P3/P4 while the dual tail (P1) still exists — you'd fork the new
  substrate across both engines.
