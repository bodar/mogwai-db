# Correlated merge search — build plan

**Status: increment 1 (mergeV computed VALUES) LANDED on trunk (2026-09-05); increments 2–4 remain.**
The property-VALUE family and the merge WRITE arms (onMatch/onCreate/tail) of the correlated write-arg
resolver were LANDED earlier (see "Already landed" below). This doc is the merge **SEARCH** correlated
per driver — a computed criterion in the merge argument (`mergeV(__.project(...))` etc.). Written so a
fresh session can execute it without re-deriving. All citations are at the pinned submodules.

**What landed (increment 1, `mergeVComputed`, `src/compiler/rel/write.ts`):** `mergeV(__.project('k')
.by(__.body))` — the SEARCH map, correlated per driver. A leading `project` merge arg parses to
driver-rooted keyed bodies (`MergeSpec.computed`, `write-args.ts`); the constant criteria stay
input-independent through `matching` while the computed ones are carried (one `(present, value, vtype)`
triple per key, via `child.scalar` at the driver) and joined by a correlated EXISTS over the candidate's
stored property, compared by `typedValueEq` (`predicate.ts` — `Compare.eq`, numeric-cross-class else
same-tag). A miss creates one vertex per DISTINCT computed map (`Map.equals`, keyed by a JSON tuple),
written from the carrier columns; `crossed(correlate=true)` carries the found/created id back per driver.
An unproductive by-body DROPS its key (`ProjectStep.ifProductive`), never a raise — a bare `project`
always emits a map, so increment-1 has no 0-result guard. **Composing steps now land too** (combinatorial
completeness): a `property()` TAIL over a computed search (an ordinary AddPropertyStep over the merge
output), CONSTANT `option(onMatch)` / `option(onCreate)` arms (props + labels, over the matched /
created vertices), multi-key projects, and the `by('key')` string shorthand. **Deferred (clean declines,
correct until built):** a RUNTIME `option()` arm value (resolves at the DRIVER — over a multi-driver
computed search where drivers match different vertices, needs a per-driver ord-correlated write, the next
increment); the map LITERAL `[k: __.trav]` (candidate-rooted `P.eq`, stays declined by design); a
non-`project` map-producing traversal (needs the general map-valued-driver substrate). Tests:
`test/L4-addendum/merge-search-computed.feature`, `test/merge-search-computed.test.ts`. Two premise-corrections the build confirmed against the reference:
`key` on `hasPropertyPredicate` is a compile-time string not an `Expr` (so **computed keys, increment 3,
are a real signature gap** — not the free slot §design step 2 implied); and a bare `make.join`'s declared
`type` maps POSITIONALLY onto `left.cols ++ right.cols`, not by name.

## The problem

`elementMergeV`/`elementMergeE` (`src/compiler/rel/write.ts`) build the merge search with `matching`
/`edgeCriteria`, which synthesize `V().hasLabel(l).has(k, v)` as **rooted steps** and lower them via
`child.rooted` — **input-independent**: one search relation for every driver, which is why mergeV
CROSS-joins the driver stream with the results (`crossed`). A computed criterion breaks that: the search
must vary per driver.

Today a computed criterion **declines** (fail-closed): `elementMergeV` returns null when
`Object.values(match.props).some(isNested)` or `isNested(match.label/id)` or any `propKeys` is nested
(`src/compiler/rel/write.ts`, the `for (const spec of [match, onCreate, onMatch])` guard + the
`match.props` guard just after). That decline is CORRECT until this is built.

## Reference findings (verified 2026-09-05 — do not re-derive)

**TinkerPop resolves the WHOLE map per driver, then searches on concrete values.**
- The computed criterion is a whole **map-producing traversal**: `mergeV(__.project(...).by(...))` /
  `mergeV(__.select(dynMap))` — the `mergeV(Traversal)` overload
  (`vendor/tinkerpop/gremlin-core/.../dsl/graph/GraphTraversal.java:1593`; grammar
  `vendor/tinkerpop/gremlin-language/src/main/antlr4/Gremlin.g4:715-718`, `mergeV_Map` vs
  `mergeV_Traversal`).
- `MergeElementStep.materializeMap` runs `TraversalUtil.apply(traverser, mergeTraversal)` ONCE per
  driver (`.../step/map/MergeElementStep.java:339-340`), driven from `MergeVertexStep.flatMap:81` /
  `MergeEdgeStep.flatMap:256`. The map's values are then CONCRETE, and the search is a literal has-chain:
  `t.has((String)k, e.getValue())` (`MergeElementStep.java:401`, `MergeEdgeStep.java:218`).
- **0/multi rule** (`TraversalUtil.apply` = `next()`): 0 results → **throw**
  `"The provided traverser does not map to a value"` (`TraversalUtil.java:45-48`); >1 → silently take
  the **first**, discard the rest (`:49-52`). So a whole-map merge traversal unproductive for a driver
  is a RAISE (a guard binding), not a no-match.

**The map-LITERAL `mergeV([k: __.trav])` is a different, degenerate thing — keep declining it.** The
grammar admits it (`genericLiteral` includes `nestedTraversal`, `Gremlin.g4:1701`; `mapEntry`, `:1727`).
But TinkerPop wraps the literal in `ConstantTraversal`, so `e.getValue()` stays a raw traversal, and
`has(key, traversal)` = `HasContainer(key, P.eq(traversal))`
(`GraphTraversal.java:2807-2812`) — a `P.eq` whose traversal is resolved against the **current
traverser**, which in the search's `HasStep` is the **candidate** being filtered
(`P.prepareChildTraversal` splits the current traverser, `P.java:381-390`). I.e. `mergeV([name:
__.values('x')])` means "find `v` where `v.name == v.values('x')`" — a candidate self-comparison. No
corpus, degenerate. Reading it as driver-rooted would be a considered DIVERGENCE, not a bug fix — so it
stays declined.

**Calcite's canonical form for "search inner by a value computed per outer row" is
decorrelate-to-equi-join** (what SQLite needs — no LATERAL). `RelDecorrelator.decorrelateRel(Correlate)`
turns `Correlate(outer, Filter(inner, inner.key = $cor.expr))` into a plain
`outer JOIN inner ON inner.key = <expr over outer>` (`vendor/calcite/core/.../sql2rel/RelDecorrelator.java:1894-2004`,
condition built `:1953-1963`); decorrelation is on by default (`SqlToRelConverter.java:4292-4296`).
`Correlate.getCondition()` is always `true` — correlation lives in a Filter inside the right subtree
(`.../rel/core/Correlate.java`). Takeaway: build the driver's computed value as a **projected column**,
then **JOIN candidates on it** — do NOT emit a correlated subquery or LATERAL.

## The design (option a — route through `has()`)

Unify mergeV's search with mergeE's EXISTING per-driver correlation (it already does this for
endpoints):

1. **Correlation carrier — the `mergeE` `pairs` pattern.** Build a relation over the driver stream
   carrying `(ord, cv1, cv2, …)`, each `cv` a correlated `child.scalar` value of a computed criterion
   (`resolveRuntimeValue` already resolves a body over a driver relation; the scalar arm gives one value
   per driver). Constant criteria are NOT carried — they stay input-independent through the existing
   `matching` (synthesized steps → fold → `hasPropertyPredicate`), so they keep inheriting everything
   `has()` learns.
2. **Correlated join — route the computed value through `has()`'s comparison seam.**
   `hasPropertyPredicate(kind, id, key, valuePred, fresh)` (`src/compiler/rel/source.ts:352`) already
   parameterizes the comparison via `valuePred: (value, vtype) => Expr` (`:92`), the vtype-aware
   stored-value compare (`storedCompareOn`, `src/compiler/rel/predicate.ts:229`). For a computed
   criterion, build a `valuePred` that compares the candidate's stored property against the driver's
   `pairs` column. Because the `pairs` value is a plain column of the join's left side, this is Calcite's
   decorrelated equi-join, and it INHERITS the vtype-aware compare (and FTS eligibility). `key` is also an
   `Expr` on that seam, so a computed KEY slots in the same way (later).
3. **Result + create correlation — mergeE's existing machinery.** The join comes back as
   `(ord, matched_id)` (mergeE's `pairedWith`, `write.ts`). The create inserts one element per DISTINCT
   computed-criterion tuple that found nothing (`Distinct`), and `crossed(incoming, emitted, …,
   correlate=true)` equi-joins by `ord` instead of cross-joining — all already built for mergeE.
4. **The 0-result guard.** A whole-map merge traversal that produces nothing for a driver is a raise
   (`TraversalUtil.apply`), so the resolved-map relation carries a productivity signal and an empty one
   is a guard binding (`raiseWhen: 'rows'`), message from the reference.

## Seams to reuse (already built — do not rebuild)

- `hasPropertyPredicate` / `valuePred` — `src/compiler/rel/source.ts:352,92`. The comparison seam.
- `storedCompareOn` — `src/compiler/rel/predicate.ts:229`. vtype-aware compare.
- `resolveRuntimeValue` — `src/compiler/rel/write.ts`. Resolves a body over a driver relation to
  `{rel, origin, mayBeMulti}` (rows arm) or a scalar; the correlation carrier reuses its scalar path.
- mergeE's `pairs` / `pairedWith` / `edgeCriteria` / `crossed(…, correlate=true)` — `write.ts`,
  `elementMergeE`. The per-driver correlation + create + result machinery, verbatim in shape.
- `matching` / `edgeCriteria` — `write.ts`. Keep for the CONSTANT criteria; extend so the COMPUTED ones
  join through `hasPropertyPredicate` correlated to `pairs`.

## Build order (increments, trunk-based)

1. ✅ **LANDED — Computed VALUES via the map-producing traversal** — `mergeV(__.project(k).by(__.trav))`
   where values vary per driver (`mergeVComputed`). Keys/labels compile-time. The correlated-search core
   is built (carrier + decorrelated has-join + create-per-distinct-map + `crossed(correlate=true)`). NOT
   in this increment: `mergeV(__.select(dynMap))` — a runtime side-effect map needs the map-valued-driver
   substrate `resolveMergeArg` flags as unbuilt (a `withSideEffect` CONSTANT map already worked); and
   `option()`/`property()` over a computed search (decline). No 0-result guard was needed — a bare
   `project` always emits a map (the whole-map raise is the general-traversal case, increment 4).
2. **`mergeE` computed values** — the same, over `edgeCriteria`/`pairedWith` (which already correlate).
   The compounding move is to lift `mergeVComputed`'s carrier + `typedValueEq` join into a shared
   correlated-search engine both hosts use; now that a third instance (mergeV-computed) is green beside
   mergeV-constant and mergeE, that unification is the safe next step.
3. **Computed KEYS / LABELS** — a correlated `key`/label `Expr`. ⚠️ Increment 1 confirmed this is a REAL
   signature gap: `hasPropertyPredicate`'s `key` is a compile-time `string` (`compilerText`), not an
   `Expr`. Needs a new seam (a correlated key/label into the property/label scan), not a free slot.
4. **no-arg `mergeV()`/`mergeE()`** (traverser-as-map) and the general map-producing traversal (a
   `project` not at the head, `select(dynMap)`) — the map-valued-driver substrate + the whole-map
   0-result raise (`TraversalUtil.apply`).

Each increment lands with L4 `.feature` scenarios (there are none yet — write them) and its own tests.
No L3 movement expected (the corpus has no computed-merge scenarios) — this is ceiling work, validated by
our own tests. Keep the map-LITERAL `[k: __.trav]` DECLINED throughout (it's TinkerPop's candidate-rooted
`P.eq`, above).

## Already landed (context so a fresh session doesn't redo it)

The correlated write-arg resolver's property + merge-WRITE families are on trunk (this session,
2026-09-05):
- `property(k, __.trav)` values: `resolveRuntimeValue` (rows arm for multi-value, scalar arm for a
  reducer like `count()`), `runtimePropertyStatements`; 0→skip / >1-single→raise / list-set→each; FTS via
  `refreshFts` (`src/refresh.ts`) from the stored `{t,v}` tree. Property MAP form + `addV`/`mergeV` tails.
- `mergeV` onMatch/onCreate computed values: `mergeArmValueWrite` (`src/compiler/rel/write.ts`),
  DRIVER-rooted per `materializeMap(traverser)` (`MergeVertexStep.java:103`/`:153`), resolved as a rooted
  scalar over the driver relation.
- Tests: `test/property-traversal-value.test.ts`, `test/L4-addendum/property-traversal-multivalue.feature`,
  `property-map-form.feature`, `merge-property-tail.feature`. Drove L3 +5.

Declined (correct, fail-closed): the map-LITERAL computed criterion (candidate-rooted P.eq); a runtime
EDGE property value (`AddPropertyStep.java:172-199` take-first, no cardinality); runtime property META.
