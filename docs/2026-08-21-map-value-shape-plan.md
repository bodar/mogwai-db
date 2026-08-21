# The map-value shape carries the value's TRUE shape — substrate plan (2026-08-21)

**Status: read-side + the GROUP producer LANDED; the valueMap producer is the remaining step.** The
shared machinery (`sideList`/`mapSide`/`sideOf`/`framed` and the `select(<key>)`/entry callers) handles
a `{kind:'list', of}` value, and `groupMap`'s collecting arm now emits it — so `group().by().by(<fold>)`
and its `groupCollected` sibling compose `select(Column.values).unfold().order(Scope.local)`/`conjoin`
and `select(<key>).unfold()` correctly (census 0 changed / 0 crashed / 0 stopped, +6 newly executing
all reference-verified via L3 +6; pinned in `test/L4-addendum/map-value-list-shape.feature`). One
entry-framing fix was needed and is recorded below (`framed` collapses a list `valOf` to `scalar`,
because a Map.Entry column always holds a self-describing `{t,v}` node). **Still LEFT:
`elementValueMap`'s vertex value → `{kind:'list', of: TYPED_MEMBERS}`** so the `valueMap(k).select(values)
.unfold().order(local)`/`conjoin` family composes too — same read-side, one more producer flip.

This is substrate, not an L3 chase. The goal is a `MapOf` that
tells a CONSUMER the real shape of a map's value, so `select(Column.values)`, `select(<key>)`,
`unfold()` and every list op past them compose correctly at any depth — which they do not today.

## The symptom

`g.V().group().by().by(__.out().label().fold()).select(Column.values).unfold().order(Scope.local)`
(and `.conjoin(...)`, and the `valueMap(k).select(values).unfold().order(local)` family — 8+ corpus
traversals) all **defer** today. The naive "make `order(Scope.local)` identity over a scalar" fix
answers them WRONG and silently, because the stream reaching `order(Scope.local)` is framed
`{kind:'scalar', vtype:'list'}` — a scalar carrying a JSON list — when it is really a **list stream**.
The framing lies about the shape.

## Reference ground truth (cited at the pin)

### TinkerPop — the value at a `group()`/`valueMap()` key is a LIST, and it stays one

- `group().by(k).by(<valueTraversal>)`: the value type is whatever the value traversal's first
  non-local barrier yields. Default (no value `by()`) injects `__.fold()`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java:61`),
  a `by(k2)` single-value is rewritten to `__.map(k2).fold()`
  (`.../step/util/Grouping.java:92-101`), and an explicit `.fold()` is itself the barrier — so all
  three give a **`List`** value. A reducing barrier (`.sum()`/`.count()`) yields a **single scalar**
  (`GroupStep.java:123-128`). The backing map is a `HashMap` (unordered) — `GroupStep.java:64`.
- `valueMap()` on a **Vertex** builds an `ArrayList` per key **regardless of cardinality**
  (`.../step/map/PropertyMapStep.java:246-267`) — so the value is ALWAYS a `List`; on an Edge /
  VertexProperty it is the single raw value (`:263-264`). Map is a `LinkedHashMap` (`:82`).
- `select(Column.values)` → `new ArrayList<>(map.values())`
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Column.java:60-61`),
  so over a `Map<K,List>` it is a **`List<List>`** — a list whose members are the per-key value
  lists, never flattened. `Column.keys` → a `LinkedHashSet` (`:44-45`).
- `unfold()` peels exactly ONE level: over `List<List>` each emitted traverser holds an inner `List`
  (`.../step/flatMap/UnfoldStep.java:47-48`); over a `Map` it emits `Map.Entry` (`:49-50`).
- `order(Scope.local)` sorts a `Collection`/`Map` and returns a non-collection **unchanged**
  (`.../step/map/OrderLocalStep.java:73-90`). `conjoin` joins a `Collection` and **throws** on a
  scalar (`.../step/map/ConjoinStep.java` + `.../process/traversal/util/ListFunction.java:93-112`).

### Calcite — collection element types are recursively composable; UNNEST peels one layer

- `ArraySqlType`/`MultisetSqlType` hold a single `RelDataType elementType`; `MapSqlType` holds
  `keyType`/`valueType` — each a full `RelDataType`, freely nestable, with recursive identity via
  `deepEquals`/`deepHashCode`
  (`vendor/calcite/core/src/main/java/org/apache/calcite/sql/type/{ArraySqlType,MultisetSqlType,MapSqlType}.java`).
  So `ARRAY<ARRAY<V>>` and `MAP<K, ARRAY<V>>` are first-class. This is exactly our
  `ListOf.{kind:'list', of: ListOf}` and a `MapOf` whose value is itself a `ListOf`.
- `Uncollect.deriveRowType` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/Uncollect.java:217-291`)
  emits, for a MAP field, `(KEY, VALUE)` columns typed `keyType`/`valueType` **verbatim** — so if the
  value type is an ARRAY, the VALUE column is a collection-valued cell (`:244-256`); for an array it
  emits the component type (`:256,269-281`). **Unnest strips one layer; the inner collection survives
  as a full collection value.**
- The directive this yields: **do not flatten the map value to an opaque scalar; carry its true
  recursive shape, exactly as `MapSqlType.valueType` does**, so a later UNNEST over the value can peel
  the next layer.

## The current model and the precise divergence

`MapOf = {kind:'scalar'} | {kind:'elem', elem} | {kind:'list', of}` (`src/sql/kernel/render.ts:62`).
The `{kind:'scalar'}` arm is **overloaded**: it means "the value side is a self-describing `{t,v}`
node" — which is true for EVERY value (a list value is stored as a `{t:'list', v:[…]}` node), so the
map FRAMER is correct at any depth (it walks the node's own `t`). But every group/valueMap producer
sets `valOf: {kind:'scalar'}` unconditionally (`src/compiler/rel/map.ts:499, 696` and
`elementValueMap`'s `:1025`), so the descriptor never tells a consumer that a value is a list.

Consumers that need the true shape, and what they do with the wrong one:
- `sideList` (`map.ts:1175`) — `select(Column.values)`: returns `TYPED_MEMBERS` (scalar members) for
  a `{kind:'scalar'}` valOf, so a list-of-lists is described as a list-of-scalars. `unfold()` then
  routes to the SCALAR tail (`unfoldList`'s bare-list arm) instead of `unfoldNested`, so the member —
  a `{t:'list'}` node — reaches `order(Scope.local)`/`conjoin` framed as a scalar. **This is the bug.**
- `sideOf` (`map.ts:1266`) — `select(<key>)` / entry side: handles ONLY `{kind:'scalar'}` (unwraps
  `$.v`/`$.t` to a scalar stream). **A `{kind:'list'}` valOf makes it decline** — so this layer is
  NOT optional: flipping `valOf` without teaching `sideOf` the list arm regresses
  `group().by().by(__.fold()).select(<key>)` from executing to declining (census gate 2).

## The invariant that keeps this honest

**The value node encoding does not change.** Every map value stays a self-describing `{t,v}` node in
the blob; the MAP frames byte-identically (census: 0 changed answers on every existing group/valueMap
traversal, and on `select(Column.values)` alone, whose members already self-describe as lists). What
changes is only the `valOf` DESCRIPTOR and the CONSUMERS that branch on it — so previously-declining
chains (`…select(values).unfold().order(local)`, `…select(<key>)` on a list value once its arm lands)
begin to execute, and nothing that executed changes its answer.

A nested list member is a `{t,v}` node too (`{t:'list', v:[…]}`), self-describing exactly like a
scalar member.

### The encoding fork, resolved: collect at the ROOT encoding

There are TWO encodings of a `{kind:'list'}` member, and `select(Column.values)` sits on the seam:
- **root** — `listPayloadExpr`'s `of.kind==='list'` arm (`list.ts:1578-1582`) reads each member as a
  RAW inner array (`MEMBER.value`), and `unfoldNested` (`list.ts:1462`) reads the same. This is how a
  folded list-of-lists and `product()` pairs are stored.
- **in-map** — a list nested inside a map/record VALUE is stored as a `{t:'list', v:[…]}` node and
  framed by the tree framer (`listNodeExpr`); this is what `mapSide` collects from the value side.

Measured invariant to preserve: `g.V().group().by().by(__.out().label().fold()).select(Column.values)`
already frames **correctly** today — `[[["person","software","person"],[],[],["software","software"],
[],["software"]]]` — because it goes through `sideList`→`TYPED_MEMBERS` (scalar members) and the
scalar-member framer UNWRAPS each `{t:'list'}` node to a raw array. The bug is only that `unfold()`
then treats those members as scalars.

**Resolution — Option A (chosen): `mapSide` collects the value side at the ROOT encoding.** When
`valOf` is `{kind:'list', of}`, collect each value node's `$.v` (the inner array) rather than the whole
`{t:'list'}` node, so `select(Column.values)` is a standard root-encoded list-of-lists. Then the
EXISTING `{kind:'list'}` machinery serves everything unchanged — `listPayloadExpr`'s list arm frames
it, `unfoldNested`'s raw `MEMBER.value` peels one layer, and order-local/conjoin operate on the inner
scalar members. `unfoldNested` needs NO change. A scalar value keeps its `{t,v}` node
(`sideList`→`TYPED_MEMBERS`, unchanged); an `elem` value still declines. The wire output of
`select(Column.values)` must stay byte-identical (raw arrays either way) — verified before landing.
Option B (keep `{t,v}`-node members and teach every reader the object-unwrap) was rejected: it spreads
a conditional unwrap across `listPayloadExpr`, `listNodeExpr` and `unfoldNested`, where Option A keeps
the encoding uniform and touches only the collection point.

So `unfoldNested` must UNWRAP a typed-node member only if a producer other than `mapSide` ever emits
one; under Option A none does, so it stays as-is.

## The layered change (lands together — partial states regress)

1. **`MapOf`** — no new arm needed; `{kind:'list', of}` already exists. (If a map-VALUED map surfaces
   — `by(__.project())`/`by(valueMap())` — that is a separate `{kind:'map'}` arm, deferred; those keep
   `{kind:'scalar'}` and stay framed-correct-but-opaque until their own increment.)
2. **Producers set the true `valOf`** (`map.ts`): the collecting arm (`groupMap`), the pooled-fold arm
   (`groupCollected`), and `elementValueMap`'s vertex value → `{kind:'list', of: <member shape>}`; the
   reducing arm (`groupReduced`) and the child-assign single value stay `{kind:'scalar'}`;
   `elementValueMap`'s edge/flat value stays `{kind:'scalar'}`.
3. **`mapSide`** (`map.ts:1189`) + **`sideList`** (`map.ts:1175`): for a `{kind:'list', of}` valOf,
   collect each value node's `$.v` (root encoding, per the fork above) and return `of` as the result
   list's member shape (a `MapOf`→`ListOf` conversion: `{kind:'scalar'}`→`TYPED_MEMBERS`,
   `{kind:'elem',elem}`→`{kind:'elem',elem}`, `{kind:'list',of}`→`{kind:'list',of}`). So
   `select(Column.values)` is a root-encoded list-of-lists; `unfoldNested` and `listPayloadExpr` serve
   it unchanged.
4. **`sideOf`** (`map.ts:1266`) grows a `{kind:'list', of}` arm: extract the value node's `$.v` into
   LIST_COL, frame as `of` — so `select(<key>)` and the entry side yield a LIST stream, no regression
   (this is REQUIRED — without it, a list `valOf` makes `select(<key>)` decline where it executes today).
5. **Variant/merge checks** (`lower.ts:6260-6265, 6344`) — audit that a list `valOf` compares/merges
   correctly (they compare `valOf` structurally, so a richer `valOf` is fine, but the
   `valOf.kind === 'scalar'` gate at 6344 must be widened or confirmed harmless).

## Verification (the whole point)

- **census: 0 changed answers, 0 stopped executing.** The map framing and `select(Column.values)`
  framing must be byte-identical; only new chains execute. Every newly-executing row read and checked
  against the reference (the CLAUDE.md "ran rises → read the new rows" rule).
- Spot-check each unblocked shape against a hand-computed reference answer (sorted inner lists for
  `select(values).unfold().order(local)`; the join for `conjoin`).
- L3/L4 green; `test:perturbed` re-baselined (order-local over a real list is order-bearing).
- New L4 addendum feature pinning the shapes at depth.
