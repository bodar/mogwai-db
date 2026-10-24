# mogwai-db — feature support matrix

A ✅ step works **anywhere in a traversal**, at any depth. **Notes list only what does not work**; no
note means the whole step works. Anything unsupported throws a clear error, never a wrong answer.
Where we answer under JS/SQLite semantics rather than Java's, §17 lists it.

**L3 conformance: <!-- L3:passing -->1,878<!-- /L3:passing -->/2,260 · corpus parse+chain: 2,395/2,395.**

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
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | ❌ a mid-traversal `V()` after `path()`/`sack()` |
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
| `typeOf(GType)` over a stored property | ✅ | |

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
| `combine`, `conjoin`, `difference`, `disjunct`, `intersect`, `product`, `merge` | ✅ | ❌ over a non-collection scalar |
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
| host-language typing in Java/.NET | |
| 128-bit arithmetic | declines |
| int64 overflow | raises |
| 32-bit float arithmetic | SQLite REAL is always a double (§17 Float) |
| `NaN` values | SQLite stores NaN as NULL, so a NaN literal in a value position (`inject`, `constant`, collection member, property) declines. A NaN predicate operand works; `±Infinity` works. A run-time NaN from `math()` or a sack raises; a NaN `sum()`/`mean()` is `null` (§17) |

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV(label…)`, `addE(label)`, `from`/`to` | ✅ | ❌ a traversal-computed label (`addV(__.values('name'))`); `addE` after `addE` |
| `property(k, v)`, `property(Cardinality, k, v)`, `property(k, __.trav)` | ✅ | ❌ a traversal value that is null, needs an unordered "first" pick, or could read another traverser's write |
| `addLabel`, `dropLabel`, `dropLabels` | ✅ | |
| `mergeV`, `mergeE`, `.option(onCreate/onMatch)` | 🟡 | `T.id` in the merge map ✅. ❌ a map fed by `unfold`/`union`; a meta-property under an undeclared cardinality |
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
`COALESCE(uid, id)`.

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
| Lone surrogate in a parameter or JSON | reaches SQLite as `''` or U+FFFD (in statement text it declines) |
| Write visibility | a write step sees a snapshot of its input; later steps see all its writes (`g.V().not(out()).drop()` drops exactly the leaves) |
| Error timing | errors are eager: a type error may raise where Java's lazy pull would stop first (`limit(0)` still answers `[]`) |
| Error vs filter order | a later filter may drop a row before its type error is evaluated (`inject(1).toUpper().is('x')` is `[]`) |
| Unread erroneous values | an error in a value nothing reads is not raised (`project('x').by(values('age').toUpper()).count()` answers) |
| Number equality | by value: `1`, `1L`, `1.0` are one value; `true`/`1` and a UUID/Char vs String stay distinct. A merged key frames as one of the merged classes (`inject(1, 1.0).groupCount()` is `{1.0: 2}`) |
| Signed zero | `-0.0` is `0.0` everywhere |
| Numeric predicate compare | by exact SQLite INTEGER/REAL value, no Java widening: `9007199254740993L > 9007199254740992d` holds; BigDecimal compares at double precision; bounds past int64 compare as REAL |
| Ties in `order()` | equal values (`1m`/`1.0d`) tie, regardless of class |
| Float | stored as the Double of its shortest float32 decimal; arithmetic runs in double (`0.1f` equals `0.1d`) |
| Extreme-magnitude Doubles | outside ~[1e-80, 1e116] a value may move by its last ulp (`1.5e-300d` → `1.4999999999999998e-300`) |
| Writes over a bulked slot | one element per traverser: `g.V().both().addV('x')` creates 12 vertices, not Java's 6 |
| Unordered slices and terminal streams | without `order()`, rows come in plan order and `limit(n)` keeps some n rows. Order is kept wherever the query reads it (`order()`, `tail()`, collected lists, `path()`, per-start branch arms) |
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
| A null `by()` value | null is absent: `project()` omits the key, `select`/`order`/`dedup`/`where` drop the row; `coalesce` is SQL `COALESCE` |
| Number spelling | `asString()`/`format()`/`conjoin()` use SQLite's text: 15 significant digits, a whole Double keeps `.0`, exponent below 1e-4 or from 1e15 (`1e-5` is `1.0e-05`), infinity `Inf`; a Float prints its written decimal (`0.1f` is `0.1`) |
| `format()` over a multi-valued property | uses the first value (Java throws) |
| A non-String text receiver | the error names the value (`encountered 1.`), not its Java class |
| Untyped JSON map keys | one total spelling rule; colliding keys render as `[key, value]` entries so nothing is lost; NaN/Infinity as name strings |
| Untyped JSON result shapes | a path is `{labels, objects}` with empty labels; a VertexProperty `{id, key, value}`; an edge endpoint is its bare id |
| Read-only child message | a mutating step in a value child raises a `ValueParseError` naming our step, not Java's internal class |
| Map scope | a key the traverser's own map holds wins; a key it lacks drops the row (Java falls through to a side effect or path label) |
| Side-effect reads | a side-effect read sees the completed collection (`local(aggregate('a')).select('a').count(local)` is `6` each time) |
| Path entries of a re-bound label | a label re-bound after a branch host may appear once more (or fewer) in `select(Pop.all, k)` than in Java |
