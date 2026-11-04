# mogwai-db — feature support matrix

A ✅ step works **anywhere in a traversal**, at any depth. **Notes list only what does not work**; no
note means the whole step works. Anything unsupported throws a clear error, never a wrong answer.
Where we answer under JS/SQLite semantics rather than Java's, §17 lists it.

**L3 conformance: <!-- L3:passing -->1,976<!-- /L3:passing -->/2,260 · corpus parse+chain: 2,395/2,395.**

| Mark | Meaning |
|---|:--|
| ✅ | Supported, at any depth. |
| 🟡 | Partial — the note says what is missing. |
| ❌ | Not yet. Throws `UnsupportedTraversal`. |
| 🚫 | Out of scope — we will not build it (§15 is the whole list). |

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | ❌ a mid-traversal `V()` after `path()`/`sack()`; a child body that re-sources (`V()`/`E()`) right after a value that may be missing on some rows (`optional(…as('a')).map(__.select('a').V()…)`) declines with an explanation — the value is discarded, so the answer would only reflect which rows bound it |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | |
| `otherV` | ✅ | ❌ `E().otherV()` (no entering vertex); a mixed vertex/edge branch (`union(outE(), out()).otherV()`) |
| `inject(…)` | ✅ | ❌ a list appended to a scalar stream |
| `call(service[, params])`, `.with(k,v)` | ✅ | |
| `io(path).read()` / `.write()` | ✅ | 🚫 GraphML, Gryo. CSV export refuses collection-valued and meta-properties, and writes `bigint`/`bigdecimal`/`uuid`/`char`/`duration` as `String` |

**Services** — the `call()` registry; `--list` enumerates it.

| Service | | Notes |
|---|:--:|---|
| `--list` | ✅ | |
| `tinker.degree.centrality` | ✅ | |
| `tinker.search` | ✅ | ❌ `type=VertexProperty`, terms under 3 chars, `regex` |
| `io` (service) | ✅ | what `io()` desugars to |
| `federate` | ✅ | cross-graph pushdown; `.with("subgraph", true)` returns a traversable subgraph. ❌ parameter/`null` movement labels, `order` over the bound stream, `path()`/`as()` across the call, local movement over a non-subgraph result |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label,…)` | ✅ | |
| `has(T.id,…)`, `hasId` | ✅ | |
| `hasKey`, `hasValue` | ✅ | |
| `is(P)` | ✅ | ❌ after `path()`; an operand with no scalar to read; a correlated operand at a scalar-parent host |
| `where(__.…)`, `not`, `filter(__.…)` | ✅ | |
| `where(P)` / `where('a',P)` | 🟡 | ❌ some `where(P.op)` forms; `by(key)` on an edge label; `where('a',P)` over scalar labels |
| `and`, `or` | ✅ | |
| `dedup()`, `dedup(labels)` | ✅ | ❌ bare `dedup()` after path tracking |
| `identity()`, `sample(n)` | ✅ | |
| `simplePath`, `cyclicPath` | ✅ | |
| `coin(p)` | ❌ | |
| `typeOf(GType)` over a stored property | ✅ | `LIST`/`SET`/`MAP` retype the stream to the collection; `NUMBER` covers every numeric type |
| `is(typeOf(GType))` over a map, record, path, element or property | ✅ | ❌ over a list (`fold()`, `cap()`): the list framing names no List/Set/BulkSet GType yet |

**Predicates (`P`)** — ✅ in every position a predicate is accepted.

| Predicate | | Notes |
|---|:--:|---|
| `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `within`, `without` | ✅ | |
| `between`, `inside`, `outside` | ✅ | |

**Text predicates (`TextP`)** — case-exact; a ≥3-char literal term uses the `property_fts` trigram index.

| Predicate | | Notes |
|---|:--:|---|
| `containing`, `startingWith`, `endingWith` + negations | ✅ | |
| `regex`, `notRegex` | 🟡 | `has(key, regex)` only (JavaScript `RegExp`, §17). ❌ in `is`/`where`/`match` |

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `label()`, `labels()`, `id()` | ✅ | |
| `valueMap()`, `valueMap(true)`, `elementMap()` | ✅ | ❌ token subsets (`with(tokens, ids)`) |
| `properties()`, `key()`, `value()`, `element()` | ✅ | ❌ meta-property reads (`properties().properties()`, `has(k,v)` on a VertexProperty) |
| `propertyMap()` | ❌ | |
| `project(k…).by(…)` | ✅ | |
| `select(label…)`, `select(Column.keys/values)` | ✅ | ❌ dynamic-shape `Pop.mixed`; an element read back out of a collapsed `project()` map (`fold().unfold().select(k)`); multi-key `select(k…).by(…)` over a field that may hold a null |
| `constant(v)` | ✅ | |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `count()`, `sum`, `min`, `max`, `mean`, `fold()`, `fold(seed, Operator.x)`, `unfold()` | ✅ | ❌ `fold(seed, Operator.assign)`; a list seed other than `[]`; `and`/`or` with no boolean type; a byte/short/float/BigInteger/BigDecimal seed or member; a non-finite double result |
| `group().by().by()`, `groupCount()` | ✅ | ❌ a value `by()` with steps after its first reducing barrier (`by(values(k).sum().fold())`); a seeded `fold(seed, Operator.x)` value |
| `barrier()` | ✅ | ❌ `barrier(Barrier.normSack)` |
| `order().by(…)`, `range`, `limit`, `tail`, `skip` | ✅ | ❌ a list/map/path-keyed `order()` inside a child body, in a writing chain, or over a federated element list. `order().by(Column.keys)` over a collection-valued key compares its JSON text |

## 5. Branching

| Step | | Notes |
|---|:--:|---|
| `union(a, b…)` | ✅ | ❌ a single arm that reduces or binds a label; a mixed map/scalar union; an alias through a collapsed arm |
| `choose(pred, a, b)`, `choose(P, a[, b])`, `choose(…).option(…)`, `choose(T.x).option(…)` | ✅ | |
| `coalesce` | ✅ | ❌ an unseeded reducer arm (`max`/`sum`); a `number`-reducer merged with a plain scalar; a member step (`unfold`, keyed `dedup`) over a variant stream |
| `optional` | ✅ | ❌ an element re-source arm (`optional(__.V())`) |
| `map(__.…)`, `flatMap(__.…)`, `local(__.…)` | ✅ | ❌ `map` over a fan-out body (`map(__.out())`) |
| `branch`, `sideEffect(__.…)` | ❌ | |

Heterogeneous arms merge into a **variant stream**: `count`, slices and bare `dedup` work over it; a
member step (`unfold`, a member transform, keyed `dedup`) does not.

## 6. Recursion (`repeat`)

| Form | | Notes |
|---|:--:|---|
| `repeat(body).times(n)` | ✅ | unrolled to n phases |
| `repeat(body).until(p)` / `.emit()` / `.emit(p)` | ✅ | recursive CTE, all modulator positions |
| `repeat()` with neither modulator | ✅ | |
| unbounded + a per-iteration barrier | ❌ | a recursive CTE cannot hold `DISTINCT` or an aggregate |

**No depth cap.** A cyclic body without `simplePath()` is infinite per the spec; the DO's request
limit is the backstop.

## 7. Path

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(…)` | ✅ | |
| `simplePath`, `cyclicPath` | ✅ | |
| `tree`, `subgraph` | ❌ | |

## 8. Pattern matching

`match(p1, p2, …)` 🟡 — compiled as a binding table, so a pattern body takes the full step vocabulary.
The GQL string form (`g.match("MATCH (a)-[:knows]->(b)")`) desugars to it.

| Feature | | Notes |
|---|:--:|---|
| binding pattern `as(x).<body>.as(y)` | ✅ | |
| any argument order | ✅ | |
| back edge (re-using a bound variable) | ✅ | |
| bindings map + downstream `select`/`select(…).by(…)` | ✅ | |
| no-end filter-only body | ✅ | |
| per-row scalar end | ✅ | |
| reducing end `count`/`sum`/`mean`/`min`/`max` | ✅ | |
| start variable bound before the match | ✅ | |
| `where(<body>)`/`not(<body>)` leg | ✅ | |
| `where('a', P.eq/neq('b'))` between element aliases | ✅ | |
| `or` groups | ❌ | |
| `where('a', P.op('b'))` other ops, or over scalar aliases | ❌ | |
| `fold()` end | ❌ | |
| moving no-end pattern | ❌ | |
| 0/1-variable bindings map | ❌ | |
| nested `match` | ❌ | |

`shortestPath`, `pageRank`, `peerPressure`, `connectedComponent` ✅ — see §16.

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()`, `unfold()`, `order(Scope.local)`, `dedup(Scope.local)`, `range(local)`, `all`/`any`/`none` | ✅ | ❌ map `order(Scope.local).by(<key>/<traversal>)`; `dedup(local)` with labels or `by()`; a list of properties; a federated element list |
| `combine`, `conjoin`, `difference`, `disjunct`, `intersect`, `product`, `merge` | ✅ | ❌ over a non-collection scalar. `merge(<map>)` over a Map/`project()` is a per-traverser putAll (the argument wins a shared key) ✅; ❌ a non-empty literal beside list- or element-valued sides (`valueMap().merge([k:v])`), an operand whose sides differ from the incoming map's |
| `index()` | ❌ | |

## 10. Types, math & strings

Every canonical type round-trips with its exact GraphBinary tag; the type rides per row, so a mixed
stream frames each value by its own tag.

| Category | Types |
|---|---|
| text / bool | `string`, `boolean`, `char`, `uuid` |
| integer | `byte`, `short`, `int`, `long`, `bigint` |
| real | `float`, `double`, `bigdecimal` |
| temporal | `datetime`, `duration` |
| collection | `list`, `set`, `map` |

| Step | | Notes |
|---|:--:|---|
| `math(formula)` | ✅ | full exp4j surface; always Double |
| `format(template)`, `concat`, `substring`, `length`, `toUpper`, `toLower`, `trim`/`lTrim`/`rTrim`, `replace` | ✅ | |
| `asBool`, `asDate`, `dateAdd`, `dateDiff` | ✅ | |
| `asString` | ✅ | a null raises `Can't parse null as String.` |
| `asNumber` | ✅ | |
| `reverse` | ✅ | ❌ scalar `reverse` inside a child body |
| `split` | 🟡 | ❌ `split(Scope.local, sep)`; a list-shaped input; reading a label bound before `split()` |

🔴 **Numeric limits (by design, not defects):**

| Limit | Detail |
|---|---|
| 128-bit arithmetic | declines |
| int64 overflow | raises |
| 32-bit float arithmetic | SQLite REAL is always a double (§17 Float) |
| `NaN` values | SQLite stores NaN as NULL, so a NaN literal in a value position (`inject`, `constant`, collection member, property) declines. A NaN predicate operand works; `±Infinity` works. A run-time NaN from `math()` or a sack raises; a NaN `sum()`/`mean()` is `null` (§17) |
| Map/set equality | a map or set is stored and compared as JSON text whose entry order is not canonical, so an equality operand (`has(k, [a:1])`, `is`, `eq`/`neq`, a `within`/`without` member) or a `mergeV`/`mergeE` match criterion (its own map, a `$m` parameter, or the maps an `inject(…)`/`inject(…).unfold()` drives it with) holding one declines from the query text, saying why, at any depth. A list operand works; an `onCreate`/`onMatch` map is written, not compared, and works. A run-time driver (`values('m').mergeV()`) is not checked (`uncomparableLiteral`) |

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV(label…)`, `addE(label)`, `from`/`to` | ✅ | a traversal-computed label resolves per traverser (`addV(__.values('name'))`, `addV(t1, t2)`). ❌ a single label body framed as a list; `addE` after `addE` |
| `property(k, v)`, `property(Cardinality, k, v)`, `property(k, __.trav)` | ✅ | a first result (an edge value, a folded parameter, a runtime key) is picked by plan order then value (§17 "Unordered slices"). A traversal value (or map-form entry) that resolves to null removes the key, as `property(k, null)` does. ❌ a traversal value that could read another traverser's write |
| `addLabel`, `dropLabel`, `dropLabels` | ✅ | `addLabel(<traversal>)` resolves per traverser. ❌ a single `addLabel` body framed as a list; a computed `dropLabel` name |
| `mergeV`, `mergeE`, `.option(onCreate/onMatch)` | 🟡 | `T.id` in the merge map ✅. onCreate may restate a merge key, never change it — a null (removal) against a held value included: checked STATICALLY for a constant merge map (`ir/write-args.ts` `validateNoOverrides`), per CREATING driver for an injected/computed map (`rel/write.ts` `onCreateOverrideGuards`) ✅. ❌ a map fed by `unfold`/`union`; a meta-property under an undeclared cardinality |
| `drop()` | ✅ | elements and properties |

A write chain is a sequence of statements, O(write steps), never O(rows).

## 12. Side-effect state

| Step | | Notes |
|---|:--:|---|
| `aggregate(k)`, `cap(k)`, `group(k)`, `groupCount(k)` | ✅ | |
| `withSideEffect(k, v)`, `withSideEffect(k, seed, Operator)` | ✅ | |
| `withSack(seed)`, `sack()`, `sack(op).by(…)` | ✅ | ❌ `withSack(seed, Operator.x)`; a BigInteger/BigDecimal sack or operand |
| `store(k)` | 🚫 | removed from the language upstream |

## 13. Traversal strategies

Every TinkerPop strategy has ONE handling; anything unlisted is **rejected**, so a semantic strategy is
never silently ignored. `withStrategies(X)` accepts inject/verify/no-op strategies. `withoutStrategies(X)`
is a no-op, except for an always-on strategy, which is rejected.

| Handling | What it does | Strategies |
|---|---|---|
| **Inject** ✅ | rewrites the chain | `SubgraphStrategy` (❌ `vertexProperties`; a mutating traversal), `PartitionStrategy` (❌ `mergeV`/`mergeE`; `includeMetaProperties`), `ProductiveByStrategy` (❌ a `by()` on an unsupported host) |
| **Verify** ✅ | throws the spec's message | `StandardVerificationStrategy` (always on), `ReadOnlyStrategy`, `EdgeLabelVerificationStrategy` and `ReservedKeysVerificationStrategy` (when `throwException:true`) |
| **No-op, work done** ⚙️ | the optimization is always performed; the answer is unchanged | `PathRetractionStrategy` (drops unread labels), `RepeatUnrollStrategy` (unrolls `times(n)`; disabling it changes nothing), `ConnectiveStrategy` (folds infix `.and()`/`.or()`; always on, so disabling it is rejected), `EarlyLimitStrategy` (moves a slice before a side effect; disabled, a slice after a side effect declines) |
| **No-op, inert** 💤 | accepted, changes nothing | `CountStrategy`, `IdentityRemovalStrategy`, `FilterRankingStrategy`, `LazyBarrierStrategy`, `OrderLimitStrategy`, `AdjacentToIncidentStrategy`, `IncidentToAdjacentStrategy`, `InlineFilterStrategy`, `PathProcessorStrategy`, `ByModulatorOptimizationStrategy`, `MatchAlgorithmStrategy`, `MatchPredicateStrategy`, `GValueReductionStrategy`, `ProviderGValueReductionStrategy`, `RequirementsStrategy`, `LambdaRestrictionStrategy`, `GraphFilterStrategy`, `ComputerFinalizationStrategy`, `MessagePassingReductionStrategy`, `ComputerVerificationStrategy`, `VertexProgramRestrictionStrategy`, `HaltedTraverserStrategy`, `VertexProgramStrategy`, `OptionsStrategy`, `ProfileStrategy`, `SeedStrategy` |
| **Reject** ❌ | would change results if ignored | anything unlisted, incl. `SackStrategy`, `SideEffectStrategy`, `EventStrategy`, `ElementIdStrategy`, `ReferenceElementStrategy` |

⚠️ `SeedStrategy` is inert: `sample()` is not reproducible under a seed. `ProfileStrategy` is inert
because `profile()` is not supported.

## 14. Element / property model

Vertices carry multiple labels (`addLabel`/`dropLabel`). Vertex properties are multi-valued with
meta-properties; edge properties are single-valued. Element ids are integer rowids, externally
`COALESCE(uid, id)`. Vertex-property ids are assigned by the graph, so a loaded file's vertex-property
ids are not kept (the corpus's `@UserSuppliedVertexPropertyIds`).

## 15. Locked non-goals (🚫)

| Non-goal | Why |
|---|---|
| `store(k)` | gone from the language upstream |
| Row-at-a-time interpretation | the failure mode this project exists to avoid |

## 16. OLAP / graph algorithms (`call()`)

Fourteen algorithms run as set-based SQL `call()` services, invoked `g.V().call("<name>")`. Four also
have a native TinkerPop step that desugars to the same service.

| Algorithm | `call()` name | Notes |
|---|---|---|
| [PageRank](https://en.wikipedia.org/wiki/PageRank) | `pageRank` | native `pageRank()` |
| [Weakly-connected components](https://en.wikipedia.org/wiki/Component_(graph_theory)) | `wcc` | native `connectedComponent()` |
| [Peer-pressure clustering](https://en.wikipedia.org/wiki/Label_propagation_algorithm) | `peerPressure` | native `peerPressure()` |
| [Shortest path](https://en.wikipedia.org/wiki/Shortest_path_problem) | `shortestPath` | native `shortestPath()` |
| [ArticleRank](https://neo4j.com/docs/graph-data-science/current/algorithms/article-rank/) | `articleRank` | |
| [Strongly-connected components](https://en.wikipedia.org/wiki/Strongly_connected_component) | `scc` | |
| [Betweenness centrality](https://en.wikipedia.org/wiki/Betweenness_centrality) | `betweenness` | |
| [Closeness centrality](https://en.wikipedia.org/wiki/Closeness_centrality) | `closeness` | |
| [Harmonic centrality](https://en.wikipedia.org/wiki/Centrality#Harmonic_centrality) | `harmonic` | |
| [HITS](https://en.wikipedia.org/wiki/HITS_algorithm) | `hits` | decorates hub + authority |
| [Triangle count](https://en.wikipedia.org/wiki/Clustering_coefficient) | `triangleCount` | |
| [Local clustering coefficient](https://en.wikipedia.org/wiki/Clustering_coefficient#Local_clustering_coefficient) | `localClusteringCoefficient` | |
| [k-core](https://en.wikipedia.org/wiki/Degeneracy_(graph_theory)#k-Cores) | `kcore` | decorates the core value |
| [Node similarity](https://en.wikipedia.org/wiki/Jaccard_index) | `nodeSimilarity` | yields `{node1, node2, similarity}` pairs |

A decorating algorithm (`pageRank`, `connectedComponent`, `peerPressure`, `hits`, `kcore`) puts its
score under a synthetic key that every property read (`has`, `values`, `order().by`, `project().by`,
`valueMap()`) can use.

## 17. Deliberate divergences

We return the semantically equivalent answer under JavaScript/SQLite semantics, not Java's exact
execution. Each line is an accepted difference — never a lost or duplicated row, a wrong count or a
wrong number class.

| Divergence | What you get |
|---|---|
| Regex dialect | JavaScript `RegExp`, not `java.util.regex` (`$` is end of input, `\s` includes Unicode spaces, no `\Q…\E`); a pattern JS cannot read raises |
| String order | code-point order, not UTF-16 code-unit order (differs only for astral vs U+E000–U+FFFF) |
| Case mapping | `toUpper`/`toLower` map ASCII only |
| String length and indices | `length()`/`substring()` count code points: `'😀'.length()` is 1 |
| NUL in string data | carried whole, but `length`/`substr`/`like`/`tinker.search` stop at it. A NUL in statement text declines |
| Lone surrogate in a parameter or JSON | becomes U+FFFD, the rest of the string kept (`'a\ud800b'` is `'a�b'`), whether it binds as a scalar or inside a list/set/map; in statement text it declines |
| Write visibility | a write step sees a snapshot of its input; later steps see all its writes (`g.V().not(out()).drop()` drops exactly the leaves) |
| Error timing | errors are eager: a type error may raise where Java's lazy pull would stop first (`limit(0)` still answers `[]` for a value computed per row). A CONSTANT name in the query text — a label or property key (`addLabel(constant(5))`, `dropLabel(constant(null))`, `mergeV([(T.label): 5])`, `property(constant(5), 1)`) — is judged at compile time, so it raises even over a stream that turns out empty (`V().limit(0).addLabel(constant(5))`) or a statically dead `choose` arm |
| Error vs filter order | a later filter may drop a row before its type error is evaluated (`inject(1).toUpper().is('x')` is `[]`) |
| Unread erroneous values | an error in a value nothing reads is not raised (`project('x').by(values('age').toUpper()).count()` answers) |
| Number equality | by value: `1`, `1L`, `1.0` are one value; `true`/`1` and a UUID/Char vs String stay distinct. A merged key frames as one of the merged classes (`inject(1, 1.0).groupCount()` is `{1.0: 2}`) |
| String vs integer element id | a String id is not the integer it spells: `V('1')`, `hasId('1')`, `E('11')` do not find rowid `1`/`11`. A user-supplied `T.id` may be a String or an integer and both may exist, so coercing would be ambiguous (TinkerGraph's id manager coerces) |
| `merge()` over a Map | entries keep insertion order — the incoming map's, then the argument's new keys (a shared key stays in place with the argument's value) — not `HashMap` order. A `null` argument raises `encountered null`, where Java throws a `NullPointerException` |
| `merge()` type-error text | a list `merge()` given a Map argument raises `merge step can only take an array or an Iterable as an argument, encountered map`, not Java's `step type mismatch: expected argument to be Iterable but got Map` |
| UUID vs String on an untyped value | a value with no type fact — an unfolded list member, an injected String — compares by its text, so a String spelling a UUID equals that UUID there (`inject(['<u>']).unfold().is(UUID('<u>'))` is 1); a stored or typed value keeps the two distinct |
| Signed zero | `-0.0` is `0.0` everywhere |
| Numeric predicate compare | by exact SQLite INTEGER/REAL value, no Java widening: `9007199254740993L > 9007199254740992d` holds; BigDecimal compares at double precision; bounds past int64 compare as REAL |
| Ties in `order()` | equal values (`1m`/`1.0d`) tie, regardless of class |
| Float | stored as the Double of its shortest float32 decimal; arithmetic runs in double (`0.1f` equals `0.1d`) |
| Extreme-magnitude Doubles | outside ~[1e-80, 1e116] a value may move by its last ulp (`1.5e-300d` → `1.4999999999999998e-300`) |
| Writes over a bulked slot | one element per traverser: `g.V().both().addV('x')` creates 12 vertices, not Java's 6 |
| Unordered slices and terminal streams | without `order()`, rows come in plan order and `limit(n)` keeps some n rows; `sample(n)` keeps a uniform n, not in the reservoir's draw order. A write that takes the FIRST result of a body — a runtime label (`addV`/`addE`/`addLabel(<traversal>)`), a runtime property key, an edge property value or a folded parameter — takes the first by the body's own order, then by value: never a refusal. Order is kept wherever the query reads it (`order()`, `tail()`, collected lists, `path()`, per-start branch arms) |
| Federated landed order | the sibling graph's emission order, unordered unless the pushed traversal orders it |
| `barrier()` | a pass-through, as is `barrier(n)`: `inject(1,2,1,3).barrier()` is `[1,2,1,3]` |
| Seeded fold over repeats | every traverser folds: `inject(1,1,2).fold(0, sum)` is `4` |
| Seeded fold per parent | a seeded fold in a child starts from a fresh seed per parent (Java aliases one seed) |
| `min`/`max` class | the winner keeps its own class: `inject(5, 2.0d).max()` is Int `5` |
| `sum`/`mean` arithmetic | adds in double and frames the common class (`0.1d+0.2d+5n` is `5.3`); `Infinity + -Infinity` is `null` |
| BigDecimal widening scale | a whole Double widened to BigDecimal has scale 0 (`100.0` → `100`); `1e7m` answers at scale 0 |
| Sack number class | a simple meet: floating if either side is, else Long if either side is or it exceeds 32 bits, else Integer (`withSack(127b)…sack(sum)` with `1b` is Integer 128) |
| Group value pools | a group value's slice or sort reads all of that key's members together |
| Per-start sorted bodies | `flatMap`/`local` keep each start's sorted run; a terminal `coalesce()`/`optional()` over a sorted arm is unordered |
| Branch emission order | each start's arms in written order; an arm's `order()` sorts only that start's output — put `order()` after the branch |
| Disabled strategies | `withoutStrategies` of `IdentityRemoval`/`LazyBarrier`/`PathRetraction`/`RepeatUnroll` answers as the default traversal |
| A null `by()` value | null is absent: `project()` omits the key, `select`/`order`/`dedup`/`where`/`sack` drop the row; `coalesce` is SQL `COALESCE` |
| An unbound `where`/`dedup` key | a `where(k,…)`/`where().by()`/`dedup(labels)` key unbound on a traverser drops that traverser, under `ProductiveByStrategy` too (Java raises `IllegalArgumentException` from `Scoping.getSafeScopeValue`) |
| A re-sourced body's null first value | a re-sourced body (`__.V()…`) whose first value is null is read as producing nothing — SQLite's scalar subquery cannot tell the two apart: `V().map(__.V().constant(null)).count()` is `0` (Java `6`), a `where()` over it drops the row, a `concat()` operand raises `does not map to a value` |
| A null-valued label in a child body | a label bound to `null` inside a branch arm reads as unbound there: `inject(0).union(constant(null).as('a'), constant(2)).map(select('a')).count()` is `0` (Java `1`) |
| Number spelling | `asString()`/`format()`/`conjoin()` use SQLite's text: 15 significant digits, a whole Double keeps `.0`, exponent below 1e-4 or from 1e15 (`1e-5` is `1.0e-05`), infinity `Inf`; a Float prints its written decimal (`0.1f` is `0.1`) |
| `format()` over a multi-valued property | uses the first value (Java throws) |
| A non-String text receiver | the error names the value (`encountered 1.`), not its Java class — a non-String computed label too (`Label traversal must produce a String, but got 29`); a list or map is named by its JSON, a datetime by its ISO text, a merge map's `T.label` by the value its `found: %s` names the class of |
| Untyped JSON map keys | one total spelling rule; colliding keys render as `[key, value]` entries so nothing is lost; NaN/Infinity as name strings |
| Untyped JSON result shapes | a path is `{labels, objects}` with empty labels; a VertexProperty `{id, key, value}`, an edge's Property `{key, value}`; an edge endpoint is its bare id |
| Read-only child message | a mutating step in a value child raises a `ValueParseError` naming our step, not Java's internal class |
| Map scope | `select(k)` (chain, child body, `where()`, a `math()`/`format()` variable) over a value stream that may hold stored Maps (`values('m')`) reads a `withSideEffect` constant, named collection or path label `k` where one exists — that scope WINS and no row is probed for a same-named key of a stored Map — else the row's own `k`, else drops the row; a merge follows the same rule in both spellings (`values('m').mergeV(__.select(k))` merges by the side effect exactly as `values('m').select(k).mergeV()`), while a `select(k)` merge argument or option arm over a stream of Maps (`inject([…]).mergeV().option(onCreate, __.select(k))`) reads the side effect where no Map can hold `k`, declines naming the collision where one MAY hold `k` beside a side effect `k`, and otherwise declines as an unsupported own-entry merge argument. Over a map (a `project()` record collapsed to one included): a key no row can hold is the named scope, and ANY key a row may hold beside a same-named side-effect constant or path label declines — even a key every row holds (a map literal's), since the key fact is a MAY set only — in every form (`select(k)`, `select(k, …)`, `by(select(k))`, `dedup(k)`, `math()`, `format()`) with the reason appended to the decline (`select('name') is ambiguous here: each Map may hold a key 'name' and a path label 'name' is also bound …`, one classifier `mapKeyCollision`), and beside a named collection keeps the entry and drops a row lacking it. `select(keys)` over a row that is no Map raises `does not have accessible keys` without the Java class; `values('m').unfold()` and `format()` over such a stream still decline |
| Side-effect reads | a side-effect read sees the completed collection (`local(aggregate('a')).select('a').count(local)` is `6` each time) |
| Path entries of a re-bound label | a label re-bound after a branch host may appear once more (or fewer) in `select(Pop.all, k)` than in Java |
