# mogwai-db — feature support matrix

What you can rely on. Each step gets one mark based on how much of it works and how
freely it composes — a ✅ step works **anywhere in a traversal**, however deeply nested,
not just at the top. Notes call out **only the cases that don't work yet**; if a row has
no note, the whole step works. **L3 conformance: <!-- L3:passing -->1,263<!-- /L3:passing --> · corpus parse+chain: 2298/2298.**

| Mark | Meaning |
|---|---|
| ✅ | **Supported.** The forms you'd reach for work, and the step composes at any depth. A note, if present, lists narrow corner cases. |
| 🟡 | **Partial.** Either a real chunk of the step is missing, or it only works shallowly (near the top of a traversal, not deeply nested). The note says what's missing. |
| ❌ | **Not yet.** Throws a clear error — never mis-executes. |
| 🚫 | **Out of scope.** A deliberate non-goal. |

Grounded in the code: a deferred shape fails closed with a clear error, and this file says
so. Kept in sync in the commit that changes support.

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | `V(id)` resolves a numeric rowid or a string `uid`; mid-traversal `V()`/`E()` re-sources the graph per traverser. ❌ mid-`V`/`E` when the incoming scalar carries path / origins / sack |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | index-only covering-index hops; convergent walks auto-collapse so dense/deep traversals stay fast |
| `otherV` | ✅ | |
| `inject(…)` | ✅ | ❌ appending a list onto an existing scalar stream |
| `call(service[, params])`, `.with(k,v)` | ✅ | source (`g.call`) + mid-traversal (`V().call`); pure (`'stream'`) + async/federated (`'barrier'`) contributions. Services below. |

**Services** (the `call()` registry — a per-runtime DI seam; `--list` enumerates the live registry):

| Service | | Notes |
|---|:--:|---|
| `--list` | ✅ | enumerates registered services; `.with("service",…)` filter, `verbose` describe blob |
| `tinker.degree.centrality` | ✅ | per-vertex incident-edge count via the child-scope reducer seam; `direction` OUT/IN/BOTH (default IN); composes in `where(call(…).is(n))`, `group`/`order`/`project` by() |
| `tinker.search` | 🟡 | FTS5-trigram search over property values (`property_fts`); `.element()` walks to the owner. `type` Vertex (default) / Edge; **case-insensitive** (documented). ❌ `type=VertexProperty` (empty), `<3`-char term & `regex` (fail closed) |
| `mogwai.graph.federate` | 🟡 | cross-graph query pushdown (async barrier). Source form `g.call(federate,{graph,traversal})` runs a rooted sub-traversal on a sibling graph → detached refs. Mid-traversal `V().call(federate,…,__.values('k'))` injects each parent's scalar (`values`/`id`/`label`) via the GLV-native `T.value` marker, batched one hop, value-rejoined per parent (flatMap). ❌ local movement over a detached result (fail closed); `path()`/`as()` spanning the call (deferred); n-ary/map injection & traversable-subgraph return (future) |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label/T.id,…)` | ✅ | |
| `hasId(…)` | ✅ | |
| `is(P)` | ✅ | ❌ after `path()` |
| `where(__.…)` | ✅ | single- & multi-hop, edge-typed hops, `label()`/`not()`, alias-rooted `where(__.as('x')…)` |
| `where(P)` / `where('a',P)` | 🟡 | value-compare over a scalar stream works, as does alias-column compare; ❌ some `where(P.op)` forms, `by(key)` on an edge-typed label, `where('a',P)` over a scalar |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | incl. infix `.and()`/`.or()`. ❌ `filter(rawPredicate)` — use a traversal |
| `dedup()`, `dedup(labels)` | ✅ | bare, `dedup().by(key/T.id/T.label/scalar traversal)`, `dedup(labels)` by an `as()`-label tuple. ❌ bare `dedup()` after `as()`/path tracking; more than one `by()`; `dedup(labels).by(traversal)` |
| `identity()` | ✅ | |
| `typeOf(GType)` over a stored property | ✅ | `is(typeOf(X))` / `has('k',typeOf(X))` over every canonical type, incl. `bigdecimal`/`char`/`duration` |

**Predicates (`P`)** — every comparison predicate works, in every position a predicate is accepted:

| | eq | neq | lt | lte | gt | gte | within | without | between | inside | outside |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |

`between` is `[lo,hi)` (inclusive low), `inside` is `(lo,hi)` (exclusive both).

**Text predicates (`TextP`)** — bound, escaped `LIKE`; a ≥3-char positive substring over a stored
property is served by the `property_fts` trigram index (`ftsSubstringPredicate` fast path):

| | startingWith | endingWith | containing | notStartingWith | notEndingWith | notContaining | regex / notRegex |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🚫 |

Substring matching is **case-insensitive** (a documented divergence from TinkerPop's case-sensitive
`String.contains` — it is what lets the trigram index serve `LIKE`; reference graphs are single-case).
A ≥3-char positive `containing`/`startingWith`/`endingWith` over a *stored* property is index-served;
a `<3`-char term, a negated op (`not*`), or a substring over a computed scalar / injected list falls
back to a (correct, unindexed) `LIKE` scan — never fail-closed. `regex` is a platform wall: no SQLite
`regexp()` UDF, and Durable Objects block `create_function`/`load_extension`.

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `id()`, `label()`, `count()` | ✅ | ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | ✅ | each value framed by its stored type; re-enterable as a per-element map (`select(Column.keys/values)`, `count()`, `is(typeOf(MAP))`, and `valueMap().unfold()` → a per-entry Map.Entry stream, incl. `map(__.select(keys/values))`, compose). ❌ `elementMap().unfold()` re-entry; heterogeneous element-value maps |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | ✅ | full property stream with owner/key/value/meta, all re-enterable; `dedup()` keeps VertexProperty identity (`vpid`) and edge key/value identity; `dedup().by(value)` deduplicates property values; `order()` supports natural order, `by(T.key)`, `by(T.value)`, and direction-only `by(asc/desc)` with typed value sorting. ❌ nested property child order; `order()` after `as()`/path tracking; other `by()` modulators |
| `select('a')`, multi-`select`, `project(…)` | ✅ | single-label select → scalar/element/property/typed-list; property aliases re-enter through `select().value()`/`key()`/`element()` and project `T.id`/`T.key`/`T.value`; multi-`select`/`project` → per-traverser record whose fields each re-enter; `limit`/`range`/`skip`/`tail` with `Scope.local` slice fields; `project(…)` over a scalar parent. ❌ property `Pop.all`/mixed histories, property aliases in path tracking, and property aliases with arbitrary `by()` traversals |
| `select(Column.values/keys)` | ✅ | over a group, scalar record, or per-element valueMap/elementMap. ❌ heterogeneous element-value lists; raw Map params |
| chained projections (`values().count()`, `project().select()`, `valueMap().select()`) | ✅ | projections retype and re-enter one step at a time. ❌ heterogeneous structured values |
| `order()` [`.by(key[,dir]\|__.trav)`] | ✅ | `by(key)` and `by(__.traversal)`. ❌ after `path()`; `by(key)` on a scalar stream; a multi-term order mixing a traversal |
| `limit`, `range`, `skip`, `tail` | ✅ | mid-chain or tail; `Scope.local` slices record fields. After a fan-out they pick a DETERMINISTIC subset via the canonical emission order (a demand pre-pass seeds it; order-free chains stay order-free) |
| `by(…)` modulator | ✅ | on `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `group`, `groupCount` | ✅ | scalar/`T.id`/`T.label`/composite-`project` keys; scalar reducers, element values, unreduced value traversals, and nested-map values (`by(__.<movement>.group())`) all compose through the generic child seam; group-scoped `count/sum/min/max/mean`/`fold()`; scalar-stream `groupCount()`; `unfold()`/`select(Column.keys/values)`/`order(Scope.local).by(Column.keys/values[, Order])` re-enter the map (via the whole-map blob stream; the local order re-sorts the pairs array in place, type-correctly via `compareKey`, and composes with a following `unfold()`/`select`); a **terminal** `select(Column.values)` over an element-LIST value frames the full vertices/edges (the nested-element-list framing recurses through `listResult`/`frameListOf`, matching the `.unfold()` variants). ❌ more than two `by()`; non-scalar / element-valued inner keys; `order().by(key)` inside a value; `order(Scope.local)` over an element/list-valued map side; `select(Column)`/`unfold()` over a nested-map value |
| `fold()` | ✅ | scalar or element list, re-enterable; empty lists and element metadata preserved. After a fan-out the list is ordered by the canonical emission order (deterministic) |
| `sum`, `min`, `max`, `mean` | ✅ | `min`/`max` over any Comparable incl. Strings |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | see §12 |

## 5. Per-traverser branching

Across all four branch steps, mixed-shape arms (scalar + element + list) merge into one
**variant stream**. After that merge the shape-agnostic steps compose (`count`, `unfold`,
`limit`/`skip`/`range`, `dedup`); steps that must look inside a heterogeneous row
(movement, `order`, value filters) fail closed. ❌ across all: mixing element **kinds**
(node + edge) in one arm; a new `as()` inside an arm; path through a mixed-shape arm.

| Step | | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | ✅ | gated dispatch over element/scalar/list arms and over a scalar parent; mixed-shape then/else → a variant stream. ❌ a 2-arg scalar-`then` with an implicit identity-else |
| `coalesce(…)` | ✅ | first-productive over element/scalar/list arms (empty `fold()` counts as productive); nests in coalesce/optional; over a scalar parent too |
| `union(…)` | ✅ | element multi-hop/nested arms; scalar/list arms; over a scalar parent. ❌ full-`V()`/`E()` source-branch tails |
| `optional(…)` | ✅ | `optional(t)` ≡ `coalesce(t, identity)`; single- and multi-hop; over a scalar parent restores the value on a miss. ❌ an element-kind change on a miss; per-row-shape steps after a mixed-shape result |
| `flatMap(__.…)` | ✅ | movement/filter/scalar/`fold()` bodies; over a scalar parent incl. a `V()`/`E()` re-source. ❌ record/group/path bodies |
| `map(__.…)` | ✅ | 1-to-1, first-EMITTED result. Over a scalar parent it takes first even when the inner traversal **fans out** (`map(__.union(a,b))` → arm 0; `map(__.V().values('k'))` → element-id order) via the canonical emission-order substrate. `flatMap`/`local` emit all. 🚫 residual take-first (fail-closed): a fan-out arm at a `path().by()` position; ❌ alias/select/structured bodies |
| `choose(fn).option(k, body)…` | 🟡 | scalar option-map, including nested scalar-valued option maps inside `map`/`local`/`flatMap` child traversals. ❌ no `Pick.none` default; list/element/mixed-shape bodies; identity/discard/fail bodies; `Pick.unproductive`/`any`; a `T`-token choice over a scalar parent |
| `local(…)` | 🟡 | one-child `all` policy: movement, slices, `dedup`, scalar transforms/reducers, `fold()`; over a scalar parent. ❌ `order()`; nested-traversal/record/group/path/match/union bodies; sack |

## 6. Recursion (`repeat`)

| Step | | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | `WITH RECURSIVE`; convergent walks collapse so a dense/deep walk returns in ms; i64 overflow fails loud |
| `…times(n).count()` | ✅ | propagates through post-repeat labels/movement/`select(labels).count()`. ❌ `groupCount`/`by(count)`, `sum`, aliases live across the walk, unbounded `until`/`emit` |
| `emit` (before/after, bare) | ✅ | runs to the natural fixpoint |
| `until(<pred>)`, `loops().is(n)` | ✅ | do-while / while-do. ❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | JSONB array walk + `json_each` cycle guard |
| movement + `has()` / multi-hop bodies | 🟡 | `out()/in()/both()` chains with `has(k,v/P/TextP)`. ❌ `hasLabel`/3-arg/`T`-token `has`; a path with a multi-hop body |
| `emit(pred)`, `times(pred)`, `until`+`times`/`emit` | ❌ | predicate / combined exit forms |
| barrier / side-effect / edge-step bodies, nested `repeat`, on edges, after `as()`, `path().by()` on the walk | ❌ | can't live in a recursive term |

## 7. Path family

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(…)`, `path().from(l)/to(l)` | 🟡 | linear or recursive layout; `count()`/`is(typeOf(PATH))` re-enter; per-position `by('key')`/`by(T.label/T.id)`/`by(__.trav)` (value/transform/reducer, or a bare 1-to-1 `choose()`/`coalesce()`); `from(l)`/`to(l)` scope a linear path to a static label slice; collection ops compose over a `by(key)` path. ❌ a fan-out `by(__.union(…))` (a position holds one value) or a `by(traversal)` with a movement/filter prefix before a branch; an aggregate `by(traversal)`; `by()` / `from` / `to` through a branch or a recursive path; mixed element-kind at a position; a dynamic-length (`repeat`) arm; spanning more than one movement/repeat; over a `union()` source |
| `simplePath()`, `cyclicPath()` [`.from(l)/.to(l)`] | ✅ | all-pairs identity / `json_each` guard; `from(l)`/`to(l)` scope a static label range. ❌ `by(key/T)` scoping |
| other steps after `path()` | 🟡 | collection ops (set-ops/`merge`/`reverse`/`conjoin`/`unfold`) compose over a `by(key)` path. ❌ `order`/reducer/`inject`/`select(Column.keys)` — need label history |
| `tree()` | 🚫 | the JS GLV stubs it (0 conformance) |

## 8. Pattern matching

| Step | | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | conjunctive `as(start).<element traversal>.as(end)` patterns, dependency-ordered, over the shared movement/filter engine. ❌ scalar-terminal binds (`count`/`values`), edge-typed end var, `or`/`not`/nested-match, more than one or zero root vars, `dedup(label)` downstream, path tracking |

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()` / `inject([…])` as a list value | ✅ | JSONB list, re-enters the tail |
| `unfold()` | ✅ | explode → elements/scalar/nested-list; a stored typed list frames each element by its own type; a MAP (`group`/`groupCount`/`valueMap`/a stored `is(typeOf(MAP))` map) → a per-entry Map.Entry stream — each entry frames as a size-1 MAP (the v4 wire form) or feeds a per-entry `select(Column.keys/values)` / `map(__.select(…))`. ❌ after a projection/modifier on an element stream |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | per-list aggregate → scalar |
| `none(P)`/`all(P)`/`any(P)` | ✅ | collection filters, null-aware |
| `Scope.local` order/limit/range/skip/tail/dedup on a list | ✅ | per-list `json_each` rebuild; `reverse()`; per-element string transforms; `order(Scope.local).by(Column.keys/values)` over a **map** value (group/groupCount/valueMap/stored map — re-sorts the pairs blob). ❌ `order(Scope.local).by(key/traversal)` on a list |
| set-ops (`combine`/`intersect`/`difference`/`disjunct`/`product`/`merge`/`conjoin`) | ✅ | operand = a literal list, `constant(c).fold()`, or a standalone scalar-fold traversal. ❌ an element-fold operand |
| `is(typeOf(LIST))`, `is(typeOf(SET))`, `is(typeOf(MAP))` | ✅ | LIST/SET retype a stored collection to a typed list stream (SET frames as a GraphBinary Set); MAP retypes a stored map / group / valueMap to a whole-map blob stream, so `count(Scope.local)`/`select(Column.keys/values)`/`unfold()` (→ per-entry size-1 MAPs) compose. ❌ `where`/`fold`/list-ops after the MAP retype; the list-operation steps (`merge`/`split`/`index`/`order`/`project`) after the LIST retype; typed-element `Scope.local` transforms |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter) |

## 10. Types, math & dates

| Step | | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | typed-value carrier → GraphBinary framing |
| string transforms | ✅ | see the string-function table below; compose as `Scope.local` per-element after `fold()`. ❌ `split(Scope.local)` on a scalar (needs a preceding `fold()`); element/map `asString`; reading `project()`/`select()` columns |
| `math("<formula>")` | ✅ | see the math-function table below; `_` binds the value, named vars resolve through `by()`/`as()`. ❌ a var with no `by()`; `withSideEffect` vars; `project()`/`select()` columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` | ✅ | epoch-millis, UTC-only, ms precision; `typeOf(DATETIME)` over stored props. ❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ✅ | reducers carry the runtime type |
| `bigdecimal`, `char`, `duration` | ✅ | literals, exact-TEXT storage, framing, `typeOf`, numeric `order()`/range, `asNumber(GType.BIGDECIMAL)`. ❌ bigdecimal `math()`/`project` arithmetic; `min()`/`max()` over the TEXT-stored tail |
| exact `long`/`bigint` > 2^53 | ✅ | BigInt end-to-end, lossless |

**Math functions** — TinkerPop's `math()` compiles to one SQL scalar (always Double). Full exp4j surface:

| operators | functions |
|---|---|
| `+` `-` `*` `/` `%` `^` | `abs` `ceil` `floor` `round` `sqrt` `cbrt` `exp` `log` (natural) `log10` `log2` `sin` `cos` `tan` `asin` `acos` `atan` `sinh` `cosh` `tanh` `signum` |

All ✅.

**String functions** — one SQL scalar each, composable and `Scope.local`-able:

| | concat | length | toUpper | toLower | asString | substring | replace | trim | lTrim | rTrim | reverse | split | format |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

`trim`/`lTrim`/`rTrim` strip Java whitespace; `concat` skips nulls; `split(sep)` → a List (`""` → characters, `null` → whitespace runs); `format("…%{key}…%{_}…")` reads props / `by()` modulators.

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | user-supplied ids; inline property VALUES + nested-traversal LABEL + constant nested KEY. ❌ a live-read nested property KEY |
| `addE()`, `from`/`to` | 🟡 | endpoints via `as()` alias, `__.select(label)`, nested `__.V(…)` (incl. folded `repeat().times()`), or `__.addV(…)`; edge uid; inline property VALUES + constant nested KEY; multi-addE. ❌ a nested-traversal edge label; an endpoint read tail past a movement; a live-read nested property KEY; `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | id-aware upsert, onCreate/onMatch, start + mid-chain; map label/id/VALUES may be nested traversals; prop VALUES keep their type. ❌ whole-arg map-valued driver traversals; nested map KEYS; bare `mergeV()`/`mergeE()` |
| `property()` update | ✅ | vertex single/list/set + meta; edge UPSERT (single, no meta) |
| `property(Cardinality.list/set,…)` | ✅ | list appends, set dedups by value |
| `drop()` (vertices + edges) | ✅ | after movement/filter/`where`, cascades props. ❌ after `properties()` / `order()` |

## 12. Side-effect state

One home (`Carry`): a named registry (aggregate/cap/group('a')) and a carried column (sack),
each staying one SQL statement.

| Step | | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | pass-through barrier → list/variant relation; `by(key/scalar/ordered-element traversal)`; `local(aggregate(...))`; over a scalar stream too. ❌ a `by()`-modulated scalar aggregate; token modulators; general element ordering |
| `cap('x')` | 🟡 | emits one collection; group side-effect re-emits its group. ❌ multi-key `cap('x','y')` |
| `sack()` / `withSack(…)` | 🟡 | carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read, `withSack(init)` seed. ❌ inject-const numeric promotion; `repeat()`/`barrier`/`local`; split/merge-on-fork; `sack(BiFunction)` |
| `group('a')`/`groupCount('a')` | 🟡 | pass-through barrier, `cap('a')` re-runs the group. ❌ after `as()`/`path()` (inherits §4 limits) |
| `store('x')` | 🚫 | dropped in v4 — use `aggregate(Scope.local)` |
| `within('x')`/`without('x')` readback | ❌ | mid-chain side-effect read |

## 13. Traversal strategies

| Strategy | | Notes |
|---|:--:|---|
| optimization / OLAP-guard / planning strategies, `withoutStrategies(…)` | ✅ | no-ops (result-preserving on our OLTP SQL engine) |
| SubgraphStrategy (vertex **and** edge criteria) | ✅ | recursive `where(criterion)` injection; edge criterion explodes `out/in/both`→`…E.…V`; `checkAdjacentVertices`. ❌ vertexProperties criterion; mutating traversals |
| PartitionStrategy (read-filter + write-stamp) | ✅ | recursive `has(within)` + property stamp. ❌ `includeMetaProperties`; partition-aware `mergeV`/`mergeE` |
| ReadOnly / EdgeLabel / ReservedKeys verification | ✅ | throw TinkerPop's canonical messages |
| ProductiveByStrategy | ✅ | productive-NULL policy for every supported consumer |
| `withoutStrategies(ConnectiveStrategy)` | 🚫 | its infix `.and()/.or()` folding is unconditionally baked in |
| `with(…)` (OptionsStrategy sugar) | ❌ | not implemented (the `OptionsStrategy` class itself is a no-op) |
| SackStrategy / ElementId / SideEffect / Event / VertexProgram | 🚫 | reject fail-closed (would change results) |

## 14. Element / property model

| Feature | | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| User-supplied ids (string `uid`) | 🟡 | at `V('x')` seed, framing-out, `properties().element().id()`. ❌ a scalar id via `by(__.outV().id())`/`group().by(__.id())`; edge uid via `addE` in some paths |
| Multi-properties (list/set) | ✅ | normalized; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` |
| Meta-properties | ✅ | JSONB `meta` per VP row |
| Property types: primitives + list/map/set | ✅ | vertex + edge, correct order/range; collections round-trip each leaf's exact gremlin type through valueMap/vertex/edge/`properties()` and the write-response echo |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| Lambdas | v4-native stance |
| OLAP / GraphComputer | OLTP-only (small per-tenant graphs) |
| Multi-request `g.tx()` | needs DO session state (P5 stretch) |
| `tree()` | 0 conformance (JS GLV stubs it) |
| TextP regex | platform wall — no SQLite `regexp()` UDF, DO blocks extensions |
