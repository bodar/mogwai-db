# Compiler consolidation — the strategic map (2026-07-16)

**Status:** research + plan. Telemetry harness LANDED; architecture bets scoped.
Corpus parse+chain 2298/2298. Live L3 count: see `README.md` / `baseline.json`
(auto-synced by the ratchet). The +124 spree this doc tracks ran 956→1080.

> **Progress update (2026-07-17).** The refactoring spree since authorship went
> *further* than this doc planned: it wasn't just P1/P2, it was a sustained migration
> of special-case mini-compilers onto the generic spine. **LANDED since authorship:**
> P1 (tail) · P2 (predicate seam + infix connectors) · **P3 (map/group/path are now
> re-enterable streams, not terminal islands)** · **P4 (dynamic-tag VariantStream +
> mixed-shape arms in all four branch steps)** · **nested-MAP-valued groups** (two-level
> aggregation — the "recommended next bet" from §3, already shipped) · **first slices of
> writes-through-the-read-spine** (`property(k, __.trav)` correlated values +
> withSideEffect-const merge maps). **P5 now FULL (2026-07-17):** the child seam is
> parent-shape-polymorphic (`ChildParent`), so `properties().group()` lowers its
> by()-children through the generic dispatcher; `tryPropertyGroupScalar` DELETED.
> **STILL STANDING:** the `child.ts` double-parse (maintainability-only; P3 did not
> retire it), the switch-vs-Map dispatch inconsistency, general merge/addE traversal
> args, `until`'s inline-only predicate (structural wall, by design).
> Per-section deltas are inline below; the surviving open work is collected in §6.

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
from two sides.** Three things never got lifted — **as of 2026-07-17, two of the
three are lifted:**

1. ~~**Three shapes stayed terminal islands** — `map` / `group` / `path`. They
   materialize at the root and cannot collapse into a carried value or re-enter
   the tail.~~ **— LIFTED (P3, 2026-07-16).** `PathStream`/`MapStream`/`GroupStream`
   are first-class re-enterable streams: `compileFromPath` (`select.ts`),
   `compileFromMap` (`list.ts`), `compileFromGroup` (`group.ts` — derives a narrow
   `(mk,mv)` MapStream via `deriveGroupEntries`) all re-enter the tail. Unblocked the
   path-tail, Map-unfold, `valueMap().select()`, element-value group maps. Nested-MAP
   group values (`GroupVal {kind:'nestedMap'}`, two-level aggregation) landed on top.
2. ~~**The element tail** never moved onto the stepwise engine → a whole
   **duplicate value-tail compiler**~~ **— LIFTED (P1, 2026-07-16).** `renderProjection`
   + `wrapReducer` + the duplicate transform ladder are DELETED; `foldTailAcc` now only
   feeds the NON-scalar element tail (`buildProjection`). Every value tail routes through
   `lowerScalarProjection` → `scalar.ts`/`barrier.ts`.
3. ~~**Predicate lowering** got a generic fallback in one caller (`where`) but not
   the others (`choose`/`coalesce`/`until`), so those three *define* support
   (throw) instead of falling through.~~ **— RESOLVED (P2, 2026-07-16).** `choose`
   routes through the shared lazy `chooseGate` → `tryGateByChildExistence` (the same
   generic child-existence engine `where`/`filter` use); `coalesce` takes traversal arms,
   not a predicate. `until` alone stays inline-bound — a genuine structural wall (runs
   inside `WITH RECURSIVE`, no materialized parent domain), not plumbing debt.

Those three observations drove the whole spree; §6 collects what survives them.

---

## 1. Duplication audit — real debt vs. justified

### Real, load-bearing debt (remove-to-unlock)

| # | Debt | Nature | Blocks |
|---|---|---|---|
| ~~D1~~ | ~~**Dual value-tail engine**~~ **— RESOLVED (P1, 2026-07-16)** | `renderProjection`/`wrapReducer`/the duplicate transform ladder + `SCALAR_TX_NAMES` DELETED; `buildProjection` renders only the non-scalar element tail; every value tail routes through `lowerScalarProjection` → `scalar.ts`/`barrier.ts` | (unblocked `order().by(k).limit(n).values().count()`) |
| ~~D2~~ | ~~**`tryInlinePredicate`/`compileInlinePredicate`** support-definer in `choose`/`coalesce`/`until`~~ **— RESOLVED (P2, 2026-07-16).** Relocated `plan.ts`→`src/steps/predicate.ts`; `choose` falls through to `tryGateByChildExistence`, `coalesce` takes traversal arms, `+ splitInfixConnectors` for infix `.and()`/`.or()`. Only `until` stays inline-bound (structural wall). | (resolved) |
| ~~D3~~ | ~~**`tryPropertyGroupScalar`/`requireInlineScalar`**~~ **— RESOLVED (P5-full, 2026-07-17).** The child seam is now parent-shape-polymorphic (`ChildParent = ElementStream \| PropertyStream`; `pushChildScope<P>`): a `properties().group()` gives its by()-children a live PROPERTY parent, so `key()`/`value()`/`element().…` lower through the SAME `lowerSteps → compileFromProperty` dispatcher as any child. `tryPropertyGroupScalar`/`compilePropertyGroupScalar`/`requireInlineScalar` DELETED; L3 held at 1086 (+0, pure debt removal), corpus 100%, `by(__.value().fold())`-style value modulators unlocked. | (resolved) | (resolved) |

~~Concrete duplication evidence for D1~~ **(historical — D1 is resolved).** The scalar
transform ladder was written twice (`renderProjection` vs `scalar.ts scalarTransform`),
the transform-name set was duplicated (`SCALAR_TX_NAMES` ≡ `SCALAR_TRANSFORMS`), and
reducer logic lived in three places (`wrapReducer` + `barrier.ts` + `scalar.ts`). P1
deleted the `renderProjection`/`wrapReducer`/`SCALAR_TX_NAMES` copies; the stepwise
`scalar.ts`/`barrier.ts` are now the sole authority (`scalar.ts lowerListReducer` for
Scope.local stays, a genuinely distinct per-list aggregate).

### Maintainability-only (not feature-blocking)

> **STILL STANDING (2026-07-17).** Both survived the spree. P3 was expected to retire the
> `child.ts` double-parse by unifying the shape model; the substrate landed but the
> double-parse did not go with it. These are the surviving maintainability debt — see §6.

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

1. ~~**Dynamic-tag VariantStream (widest).**~~ **— LANDED (P4, 2026-07-16).**
   `VariantStream` widened to a per-row payload-shape tag `vk` (null/scalar/node/edge/
   list); `materializeVariantRoot` fans out to gated dual LEFT JOINs, CASE-framing per
   row. Mixed-shape arms merge as a VariantStream in **all four** branch steps
   (`union`/`choose`/`coalesce`, `+ tryLowerVariant*`). Remaining variant consumers
   (record `fold`/`order`, mixed `select(Column.values)`, mixed path positions) were NOT
   forced — they cash ~0–1 scenarios today and forcing them would be fake-case tuple-lists.
2. ~~**Path as a re-enterable stream (cleanest).**~~ **— LANDED (P3, 2026-07-16).**
   `PathStream` re-enters via `compileFromPath` (`select.ts`); `count()`/`is(typeOf(PATH))`
   work. The `fold`/`unfold` template held as predicted.
3. **Route write arguments through `lowerSteps` (Cluster 7) — PARTIALLY LANDED
   (2026-07-16).** `write.ts` now compiles nested traversal write-args against the read
   spine (`property(k, __.trav)` correlated values; withSideEffect-const merge maps).
   **Still deferred (throws):** general merge traversal-args (`write.ts:519`), full `addE`
   endpoint traversals past certain steps (`write.ts:476,482`). The `WRITE_RULES` imperative
   interpreter remains (correctly — it is a deliberate write-path seam, not read debt).

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

**P1 — Unify the tail** *(debt removal; small feature unlock).* **LANDED 2026-07-16
(L3 1026→1040).** Three green stages: (A) every values/id/label projection routes
through one `lowerScalarProjection` → `ScalarStream` (an element `order().by(k)` before
it becomes the carried encounter column, a ROW_NUMBER window); (B) `lowerScalarRows`
handles `Scope.local` directly (identity sum/min/max/order/dedup, `localMeanScalar`→
Double, transforms fuse, others fail closed); (C) DELETED `renderProjection`,
`wrapReducer`, the duplicate transform ladder, `SCALAR_TX_NAMES`, and the dead
`TailAcc.transforms/injects/localMean` fields. `buildProjection` now renders ONLY the
non-scalar element tail (vertex/edge/valueMap/elementMap/count/element-fold). Net −132
lines; the scalar value tail + all per-row framing live in exactly one place. Bonus
unlock: `order().by(k).limit(n).values().count()`. Done BEFORE P3b (typed-property
framing) as planned — the "so P3b isn't written twice" prerequisite.

**P2 — One predicate seam** *(debt removal + small feature unlock).* **LANDED
2026-07-16 (L3 1040→1046).** `choose` (element/scalar/list arms) now falls through to
the same `tryFilterByChildExistence` engine `where`/`filter` use, via a shared lazy
`chooseGate` factory (`tryGateByChildExistence` in `child.ts`). Support-definer (D2)
removed. `until` left as-is — its predicate runs inside `WITH RECURSIVE` where there is
no materialized parent domain for the child engine, and its failing cases are
nested-repeat bodies the child engine can't compile either (genuine structural wall, not
plumbing). The predicate-seam unification alone cashed +0 — the remaining choose
predicates hit a *different, shared* wall: infix `.and()`/`.or()` connectors. See §4e.

**P3 — Lift `map`/`group`/`path` to first-class re-enterable streams** *(the big
substrate).* **LANDED 2026-07-16 (staged A→C, L3 →1066; + element-value fold →1067,
nested-MAP group →1069).** Path first (clean; `fold`/`unfold` template held), then
map-valued carried entry + group collapse — subsumed labels follow-up #3, Map-unfold,
`valueMap().select()`, element-value group maps. `PathStream`/`MapStream`/`GroupStream`
are first-class (`stream.ts`); `compileFromPath`/`compileFromMap`/`compileFromGroup`
re-enter the tail; `deriveGroupEntries` gives the narrow `(mk,mv)` entry MapStream.
**Caveat:** it did NOT retire the `child.ts` double-parse (the shape model was unified at
the *stream* level, not the *child-parse* level) — that stays open (§6).

**P4 — Dynamic-tag VariantStream** *(widest gate; pairs with P3).* Teach root
materialization to frame by a runtime row tag. Unblocks mixed arms everywhere.
**LANDED 2026-07-16 (substrate + branch consumers), L3 1066** — `vk` widened to a
per-row payload-shape tag (null/scalar/node/edge/list); `materializeVariantRoot` fans
out to gated dual LEFT JOINs; handler + `labelselect` dispatch per-row by `vk`;
`union`/`choose`/`coalesce` **mixed-shape arms** now merge as a VariantStream instead of
throwing. See `docs/2026-07-16-p4-dynamic-variant-plan.md`. **Scope correction (§4 of that
doc):** the "P3 Map defers" P4 was meant to pair with are dominated by **nested-MAP-valued
groups** (`group().by().by(__.…groupCount())`, 11 scenarios) — a separate nested-aggregation
feature (`GroupVal {kind:'map'}` + two-level aggregation), NOT the variant row. The genuine
variant/list Map consumers cash ~0–1 scenarios today, so they were correctly not forced
(no fake-case tuple-lists). Nested-map-valued groups = the recommended next dedicated bet.

**P5 — Give group sources a live parent stream** *(debt removal).* **FULLY LANDED
(2026-07-17).** `tryLowerGroupChildSource` (`group.ts`) gives element-backed groups a
live-parent generic child seam; element groups reject the old inline path. The **2026-07-17
follow-through** made the child seam parent-shape-polymorphic (`ChildParent = ElementStream
| PropertyStream`, `pushChildScope<P>` seeds a PropertyStream domain), so a
`properties().group()` sets `parent: <PropertyStream>` and its `key()`/`value()`/
`element().…` by()-children lower through the SAME `lowerSteps → compileFromProperty`
dispatcher — no inline reader. `tryPropertyGroupScalar`/`compilePropertyGroupScalar`/
`requireInlineScalar` DELETED. +0 L3 (pure debt removal, held at 1086), corpus 100%; the
`by(__.value().fold())` value-modulator family is a bonus unlock. Only the element-only
child cores (movement/count) fail closed for property parents — a property has no adjacency.

Sequencing rationale (kept for the record): clear the duplication (P1) and the predicate
asymmetry (P2) first so the substrate (P3/P4) is written once on a clean spine, not
forked. **All of P1–P4 are done; P5 is partial; the remaining work is in §6.**

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

## 4d. P1 — unify the tail LANDED (L3 1026→1040, +14)

The value-tail duplication (D1) is gone. Three green stages, each CI-green:
1. **One scalar-projection entry.** Every `values`/`id`/`label` projection routes
   through `lowerScalarProjection` → a `ScalarStream`, re-entering the stepwise loop. An
   element `order().by(k)` before the projection becomes the carried encounter column (a
   `ROW_NUMBER` window) so ordering threads through the scalar pipeline.
2. **`Scope.local` on the scalar spine.** `lowerScalarRows` handles it directly (identity
   sum/min/max/order/dedup, `localMeanScalar`→Double, transforms fuse ignoring scope,
   count/limit/range/tail/skip fail closed) — `compileFromScalar` no longer needs
   `foldTailAcc`/`renderProjection`.
3. **Delete the second engine.** `renderProjection` + `wrapReducer` + the duplicate
   transform ladder + `SCALAR_TX_NAMES` name-set + the dead `TailAcc.transforms/injects/
   localMean` fields are gone. `buildProjection` renders ONLY the non-scalar element tail
   (vertex/edge/valueMap/elementMap/count/element-fold). Net −132 lines.

The scalar value tail + all per-row framing now live in exactly one place
(`scalar.ts`/`barrier.ts`/`materializeScalarRoot`) — the "so P3b isn't written twice"
prerequisite. Bonus unlock: `order().by(k).limit(n).values().count()`. P3b (typed
property framing + `is(typeOf(LIST))→ListStream`) then landed on top, 1037→1040. See
memory `typed-property-values` + `docs/2026-07-16-typed-property-values-plan.md`.

**Refreshed remaining bets:** P2 (one predicate seam), P3 (map/group/path re-enterable),
P4 (dynamic-tag VariantStream), P5 (group live parent) — all still open, now on a
single-spine tail.

## 4e. P2 LANDED — predicate-seam unification + infix connectors (L3 1040→1046, +6)

Two changes, one commit, CI green:
1. **D2 removed (+0 alone).** `choose` no longer *defines support by throwing* at the
   predicate — all three arm sites (element/scalar/list) route through a shared lazy
   `chooseGate(st, predNested)` factory: inline predicate → `gate()`; else the SAME
   `tryFilterByChildExistence` generic child engine `where`/`filter` use (new
   `tryGateByChildExistence`, refactored to share the correlated-existence core with
   `tryFilterByChildExistence`). **Lazy on purpose** — the inline predicate Expression
   re-emits its binds at each interpolation, so building both gated seeds eagerly reorders
   binds vs the arm SQL (caught by a snapshot regression); the caller must build the
   then-seed + compile its arm before the else-seed. `until` untouched (structural wall
   above).
2. **The actual +6: infix `.and()`/`.or()` connectors.** The remaining choose predicates
   (and a few `where`) all used zero-arg infix connectors — `hasLabel('person').and()
   .out('created')`, `values('age').is(gt(29)).and().values('age').is(lt(35))` — which
   `compileInlinePredicate` explicitly punted. New `splitInfixConnectors` splits the body
   on bare `and`/`or` steps (OR looser than AND, split on OR first, each segment recurses),
   BEFORE the trailing-`is` strip (so `.is()` stays attached to its own conjunct). **Shared
   by where/filter/choose/until** — all route through `compileInlinePredicate`.

**Lesson for the map:** P2-as-scoped (predicate-seam fallback) was the *right debt removal*
but the wrong *conformance model* — the choose/coalesce/until "predicate not supported"
buckets were dominated by (a) arm-shape gaps (scalar/union/local/`values` arm bodies →
P3/P4, not the predicate) and (b) the infix-connector gap, which is a `compileInlinePredicate`
extension orthogonal to the child-existence fallback. Telemetry masked both under one
message. choose-predicate throws: 4+ → 1 (last is `select`-as-predicate + `as()` arms).

**Next (unchanged order, refreshed counts):** the top self-contained levers are still
writes-through-`lowerSteps` (~46: merge trav-arg + merge-on-list + mergeE endpoint) and
Subgraph-edges (~45). The bold/compounding pick is writes-through-`lowerSteps` (§2 gap #3
— reusable traversal-valued-argument seam). P3/P4 (terminal islands + mixed-arm
VariantStream) remain the substrate for the choose/local/map arm-shape families (~38+29).

## 4f. P3 + P4 + follow-ons LANDED — the substrate spree (L3 1046→1080, +34)

The big substrate bets both shipped, plus two follow-ons the doc named as "next", plus
the first writes-through-the-read-spine slices. Chronologically (see `git log`):

- **P3 — map/group/path re-enterable (→1066).** Staged A→C: `PathStream` re-entry
  (`compileFromPath`), `valueMap()`→`MapStream` (`compileFromMap`), scalar-groupCount over
  the spine, `GroupStream` collapse (`compileFromGroup` + `deriveGroupEntries` narrow
  `(mk,mv)` entry). Terminal islands #1 from §0 — gone. Root materialization:
  `materializeGroupRoot`/`materializePathRoot`; MapStream is internal-only (cannot
  materialize).
- **P4 — dynamic-tag VariantStream (→1066).** `vk` per-row payload-shape tag +
  `materializeVariantRoot` gated dual LEFT JOINs; `tryLowerVariant{Union,Choose,Coalesce}`
  merge mixed-shape arms instead of throwing. See `docs/2026-07-16-p4-dynamic-variant-plan.md`.
- **Element-value implicit fold (→1067)** and **nested-MAP-valued groups (→1069)** —
  `tryLowerNestedMapGroup` → `GroupVal {kind:'nestedMap'}` two-level aggregation. This was
  §3/§4's "recommended next dedicated bet"; already done.
- **Writes-through-the-read-spine, first slices (→1069, →1079).** `property(k, __.trav)`
  correlated values run against the read spine; withSideEffect-const merge maps +
  `__.select(k)` constants resolve. General merge/addE traversal-args still deferred.
- **Correlated fast-path fell out of the generic child pipeline** — the predicate/correlated
  work landed as a generic-substrate lift (`compileCorrelatedChild`), NOT a new fast-path
  switch. `fast-paths.ts` is unchanged (3 switches).

**Meta-lesson confirmed:** every point of the +124 (956→1080) was a lift onto the generic
spine or a mini-compiler deletion — never a new island. The bold/structural reading of
each bet paid off; no minimal-slice version was needed.

## 5. What NOT to do

- Do not chase the platform walls (§2) — they are correctly closed.
- Do not "simplify" `bulk.ts`/`match.ts`/`expandRepeatBody`/`write.ts` — they are
  architecturally forced, not debt.
- Do not add a new mini-compiler or a private child-traversal parser to unblock a
  single scenario (the CLAUDE.md extension law). If a shape needs support, lift it
  onto the spine.
- ~~Do not build P3/P4 while the dual tail (P1) still exists~~ — **P1 is done**
  (2026-07-16), so the dual tail is gone; P3/P4 substrate work now lands on the single
  spine without forking.

## 6. Surviving open work (as of 2026-07-17)

P1–P4 landed; P5 partial. What the spree did NOT close, ranked by leverage/appetite:

1. **Writes-through-the-read-spine, remainder (§2 gap #3, ~46 scenarios).** The first
   slices landed (`property(k, __.trav)`, withSideEffect-const merge maps). Still deferred:
   general merge traversal-args (`write.ts:519`), full `addE` endpoint traversals past
   certain steps (`write.ts:476,482`). The reusable traversal-valued-argument seam is the
   compounding pick — same read spine, more write-arg call sites route through it.
2. **SubgraphStrategy(edges) / strategy adjacency (~45, self-contained).** The
   edge-criterion Subgraph injection (Cluster 9) — its own pass, untouched by the spree.
3. ~~**P5 residue — synthetic parent for stashed group sources.**~~ **DONE (2026-07-17).**
   The child seam is parent-shape-polymorphic (`ChildParent`; `pushChildScope<P>` seeds a
   PropertyStream domain). `properties().group()` sets `parent: <PropertyStream>` so its
   by()-children lower through `tryLowerGroupChildSource` → `lowerSteps → compileFromProperty`.
   `tryPropertyGroupScalar`/`requireInlineScalar` deleted; +0 L3 (debt removal), corpus 100%.
   (cap() group sources already carried an `ElementStream` parent — the doc's "parentless
   cap()" was stale; property groups were the sole residue.)
4. **`child.ts` double-parse + third `values/id/label` projector (maintainability).** Six
   `is*Child` preflights + `compile*ChildRows` re-parse still run in lockstep, guarded by
   dead-code mismatch invariants. P3 unified the shape model at the *stream* level, not the
   *child-parse* level — this is the natural next unification. Not feature-blocking.
5. **Switch-vs-Map dispatch inconsistency (maintainability).** `compileTail`/
   `compileFromScalar`/`compileFromList`/`compileFromRecord` are still long
   `if (steps[at].name === …)` chains while the prefix/tail-render use Maps. Convert to Map
   dispatch (the CLAUDE.md "register in a Map, don't grow a switch" law applies).
6. **`until`'s inline-only predicate — NOT debt, do not chase.** Runs inside
   `WITH RECURSIVE` with no materialized parent domain; the same
   `compileCorrelatedChild` correlated path where()/choose() use. Structural wall, faithful.

**Doc-hygiene (done 2026-07-17):** `docs/feature-support-matrix.md` now carries the count
inside the same `<!-- L3:passing -->…<!-- /L3:passing -->` markers as README, and the L3
ratchet auto-syncs both (`SYNC_FILES` in `l3.test.ts`) — no more manual drift.
