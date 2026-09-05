# Correlated merge search — build plan

**Status: DESIGNED, reference-confirmed, NOT built.** The property-VALUE family and the merge WRITE
arms (onMatch/onCreate/tail) of the correlated write-arg resolver are LANDED (see "Already landed"
below). This doc is the remaining piece: the merge **SEARCH** correlated per driver — a computed
criterion in the merge argument (`mergeV(__.project(...))` etc.). Written so a fresh session can execute
it without re-deriving. All citations are at the pinned submodules.

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

1. **Computed VALUES via the map-producing traversal** — `mergeV(__.project(k).by(__.trav))` and
   `mergeV(__.select(withSideEffectMap))` where values vary per driver. The 80% case; keys/labels stay
   compile-time. This is the correlated-search core (pairs + decorrelated has-join + the 0-result guard).
2. **`mergeE` computed values** — the same, over `edgeCriteria`/`pairedWith` (which already correlate).
3. **Computed KEYS / LABELS** — a correlated `key`/label `Expr` into the same `hasPropertyPredicate`
   / `hasLabelPredicate` seam.
4. **no-arg `mergeV()`/`mergeE()`** (traverser-as-map) — same resolution, the driver IS the map value.

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
