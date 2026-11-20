# mogwai-db — feature support

This page lists the Gremlin steps that mogwai-db supports. It is a reference: look up a step, read
its status.

- A supported step works **anywhere in a traversal**, at any depth of nesting.
- A few rare combinations are not supported yet. They fail with a clear `UnsupportedTraversal` error.
  They never give a wrong answer. [limitations.md](limitations.md) lists them by area.
- Some answers follow JavaScript and SQLite rules, not Java rules. The result is the same; the detail
  can differ (for example number formatting). [limitations.md](limitations.md) lists these
  differences too.

**Conformance:** <!-- L3:passing -->2,058<!-- /L3:passing -->/2,260 TinkerPop scenarios pass.
All 2,395 corpus traversals parse.

| Mark | Meaning |
|:--:|:--|
| ✅ | Supported. |
| 🟡 | Partly supported. The note says what is missing. |
| ❌ | Not supported yet. The query fails with a clear error. |
| 🚫 | Out of scope. We will not build it. |

**Contents**

1. [Start and move](#1-start-and-move)
2. [Filter](#2-filter)
3. [Read element data](#3-read-element-data)
4. [Count, aggregate and order](#4-count-aggregate-and-order)
5. [Write](#5-write)
6. [Branch and nest](#6-branch-and-nest)
7. [Repeat](#7-repeat)
8. [Paths and labels](#8-paths-and-labels)
9. [Lists and maps](#9-lists-and-maps)
10. [Strings, numbers and dates](#10-strings-numbers-and-dates)
11. [Side effects and sacks](#11-side-effects-and-sacks)
12. [Pattern matching (`match`)](#12-pattern-matching-match)
13. [Graph algorithms and services (`call`)](#13-graph-algorithms-and-services-call)
14. [Import and export (`io`)](#14-import-and-export-io)
15. [Traversal strategies](#15-traversal-strategies)
16. [Data model](#16-data-model)
17. [Out of scope](#17-out-of-scope)

---

## 1. Start and move

| Step | | Notes |
|---|:--:|---|
| `V()`, `V(id…)`, `E()`, `E(id…)` | ✅ | Also mid-traversal. |
| `out`, `in`, `both` | ✅ | |
| `outE`, `inE`, `bothE` | ✅ | |
| `outV`, `inV`, `bothV`, `otherV` | ✅ | |
| `inject(…)` | ✅ | |
| `to(Direction, …)`, `toE(Direction, …)` | ❌ | |

## 2. Filter

| Step | | Notes |
|---|:--:|---|
| `has(k)`, `has(k, v)`, `has(k, P)`, `has(label, k, v)`, `hasLabel` | ✅ | |
| `hasId`, `has(T.id, …)`, `hasKey`, `hasValue` | ✅ | |
| `where(<traversal>)`, `not`, `filter`, `and`, `or` | ✅ | |
| `where(P)`, `where('a', P)` | 🟡 | Works between element labels and over `aggregate` collections (`P.within('x')`). Some forms over value labels and side effects are missing. |
| `is(P)` | ✅ | |
| `dedup()`, `dedup(labels)` | ✅ | |
| `simplePath`, `cyclicPath` | ✅ | |
| `range`, `limit`, `tail`, `skip`, `sample(n)` | ✅ | |
| `identity()` | ✅ | |
| `typeOf(GType)` | ✅ | `NUMBER` matches every number type. |
| `is(typeOf(GType))` | 🟡 | Missing over a list (the output of `fold()` or `cap()`). |
| `coin(p)` | ❌ | |

**Predicates (`P`)** — all supported, in every position that takes a predicate:
`eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `within`, `without`, `between`, `inside`, `outside`.

**Text predicates (`TextP`)** — case-sensitive. A literal of 3 or more characters uses the trigram
full-text index.

| Predicate | | Notes |
|---|:--:|---|
| `containing`, `startingWith`, `endingWith` and their negations | ✅ | |
| `regex`, `notRegex` | 🟡 | Only in `has(key, regex)`. Uses JavaScript regex syntax. |

## 3. Read element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `id()`, `label()`, `labels()` | ✅ | |
| `valueMap()`, `valueMap(true)`, `elementMap()` | ✅ | `with(WithOptions.tokens, …)` is missing. |
| `properties()`, `key()`, `value()`, `element()` | ✅ | |
| Meta-properties | 🟡 | Write and filter (`has`) work. Reading them (`properties().properties()`) is missing. |
| `propertyMap()` | ❌ | |
| `project(k…).by(…)` | ✅ | |
| `select(label…)`, `select(keys)`, `select(values)` | ✅ | |
| `constant(v)` | ✅ | |

## 4. Count, aggregate and order

| Step | | Notes |
|---|:--:|---|
| `count()`, `sum()`, `min()`, `max()`, `mean()` | ✅ | |
| `fold()`, `unfold()` | ✅ | |
| `fold(seed, Operator)` | 🟡 | `Operator.assign` and some seed types are missing. |
| `group().by().by()`, `groupCount()` | ✅ | |
| `order().by(…)` | ✅ | |
| `barrier()` | ✅ | `barrier(Barrier.normSack)` — see [limitations](limitations.md). |

## 5. Write

All writes in one query run as a fixed number of SQL statements. The number depends on the query,
not on the number of rows.

| Step | | Notes |
|---|:--:|---|
| `addV(label)`, `addE(label)`, `from`, `to` | ✅ | The label can be a traversal (`addV(__.values('name'))`). |
| `property(k, v)`, `property(Cardinality, k, v)`, `property(k, <traversal>)` | ✅ | A value of `null` removes the key. |
| `addLabel`, `dropLabel`, `dropLabels` | ✅ | Vertices can have more than one label. |
| `mergeV`, `mergeE`, `option(onCreate)`, `option(onMatch)` | ✅ | `T.id` in the merge map works. |
| `drop()` | ✅ | Elements and properties. |

## 6. Branch and nest

A child traversal (the `__.…` argument) can use every supported step, at any depth.

| Step | | Notes |
|---|:--:|---|
| `union(a, b, …)` | ✅ | |
| `choose(…)`, `choose(…).option(…)` | ✅ | All forms: predicate, traversal, `P`, `T` keys. |
| `branch(<traversal>).option(…)` | ✅ | Includes `Pick.any`. |
| `coalesce(…)` | ✅ | |
| `optional(…)` | ✅ | |
| `map`, `flatMap`, `local` | ✅ | |
| `sideEffect(…)` | 🟡 | A body that reads or collects works. A body that only writes (`sideEffect(addV(…))`) is missing. |

## 7. Repeat

| Form | | Notes |
|---|:--:|---|
| `repeat(…).times(n)` | ✅ | |
| `repeat(…).until(…)`, `.emit()`, `.emit(…)` | ✅ | All modulator positions. |
| `repeat(…)` with no modulator | ✅ | |
| `repeat(…).until(…)` with `dedup()`, an aggregate or a side effect in the body | ❌ | Works with `times(n)`. |

There is **no depth limit**. A loop over a cycle without `simplePath()` runs until the request limit
stops it. This is the Gremlin specification.

## 8. Paths and labels

| Step | | Notes |
|---|:--:|---|
| `as(label)`, `select(label)` | ✅ | |
| `path()`, `path().by(…)` | ✅ | |
| `tree()`, `tree().by(…)` | ✅ | `tree('k')` (side-effect form) is missing. |
| `subgraph('k')` | ❌ | |

## 9. Lists and maps

| Step | | Notes |
|---|:--:|---|
| `fold()`, `unfold()` | ✅ | |
| `order(local)`, `dedup(local)`, `range(local)`, `limit(local)`, `tail(local)`, `count(local)` | ✅ | |
| `all`, `any`, `none` | ✅ | |
| `combine`, `conjoin`, `difference`, `disjunct`, `intersect`, `product` | ✅ | |
| `merge` | ✅ | On maps, the argument wins a shared key. |
| `index()` | ❌ | |

## 10. Strings, numbers and dates

Every standard type keeps its exact type on the wire. A stream with mixed types sends each value with
its own type.

| Kind | Types |
|---|---|
| text and boolean | `string`, `boolean`, `char`, `uuid` |
| integer | `byte`, `short`, `int`, `long`, `bigint` |
| decimal | `float`, `double`, `bigdecimal` |
| time | `datetime`, `duration` |
| collection | `list`, `set`, `map` |

| Step | | Notes |
|---|:--:|---|
| `concat`, `substring`, `length`, `toUpper`, `toLower`, `trim`, `lTrim`, `rTrim`, `replace`, `format` | ✅ | |
| `split` | 🟡 | Works on a string stream. Missing: `split(Scope.local, …)`, a list input, and use inside a child traversal. |
| `reverse` | ✅ | |
| `asString`, `asNumber`, `asBool`, `asDate` | ✅ | |
| `dateAdd`, `dateDiff` | ✅ | |
| `math(formula)` | ✅ | Full exp4j syntax. The result is always a Double. |

## 11. Side effects and sacks

| Step | | Notes |
|---|:--:|---|
| `aggregate(k)`, `cap(k)` | ✅ | Also inside child traversals. |
| `group(k)`, `groupCount(k)` | ✅ | |
| `withSideEffect(k, v)`, `withSideEffect(k, seed, Operator)` | ✅ | |
| `withSack(seed)`, `sack()`, `sack(Operator).by(…)` | ✅ | |
| `withSack(seed, Operator)` | ❌ | |

## 12. Pattern matching (`match`)

`match()` builds a table of variable bindings. A pattern can use every supported step. The GQL string
form (`g.match("MATCH (a)-[:knows]->(b)")`) is also supported.

| Feature | | Notes |
|---|:--:|---|
| Patterns `as('a').….as('b')`, in any order | ✅ | |
| Reuse of a bound variable | ✅ | |
| A variable bound before `match()` | ✅ | |
| `select(…)` of the bindings, with `by(…)` | ✅ | |
| Filter-only patterns, `where(…)`, `not(…)`, `or(…)` | ✅ | |
| `where('a', P.eq('b'))`, `where('a', P.neq('b'))` | ✅ | |
| Reducing patterns (`count`, `sum`, `mean`, `min`, `max`) | ✅ | |
| `where('a', P.gt('b'))` and other comparisons | ❌ | |
| A pattern that ends in `fold()` | ❌ | |
| A pattern that moves but binds no end variable | ❌ | |
| A match with only one variable | ❌ | |
| A `match()` inside a `match()` | ❌ | |

## 13. Graph algorithms and services (`call`)

`call(name)` runs a service. `call('--list')` lists them. Every algorithm runs as set-based SQL.

| Algorithm | `call()` name | Notes |
|---|---|---|
| [PageRank](https://en.wikipedia.org/wiki/PageRank) | `pageRank` | Also `pageRank()` |
| [Weakly-connected components](https://en.wikipedia.org/wiki/Component_(graph_theory)) | `wcc` | Also `connectedComponent()` |
| [Peer-pressure clustering](https://en.wikipedia.org/wiki/Label_propagation_algorithm) | `peerPressure` | Also `peerPressure()` |
| [Shortest path](https://en.wikipedia.org/wiki/Shortest_path_problem) | `shortestPath` | Also `shortestPath()` |
| [ArticleRank](https://neo4j.com/docs/graph-data-science/current/algorithms/article-rank/) | `articleRank` | |
| [Strongly-connected components](https://en.wikipedia.org/wiki/Strongly_connected_component) | `scc` | |
| [Betweenness centrality](https://en.wikipedia.org/wiki/Betweenness_centrality) | `betweenness` | |
| [Closeness centrality](https://en.wikipedia.org/wiki/Closeness_centrality) | `closeness` | |
| [Harmonic centrality](https://en.wikipedia.org/wiki/Centrality#Harmonic_centrality) | `harmonic` | |
| [Degree centrality](https://en.wikipedia.org/wiki/Degree_(graph_theory)) | `tinker.degree.centrality` | |
| [HITS](https://en.wikipedia.org/wiki/HITS_algorithm) | `hits` | Adds hub and authority scores |
| [Triangle count](https://en.wikipedia.org/wiki/Clustering_coefficient) | `triangleCount` | |
| [Local clustering coefficient](https://en.wikipedia.org/wiki/Clustering_coefficient#Local_clustering_coefficient) | `localClusteringCoefficient` | |
| [k-core](https://en.wikipedia.org/wiki/Degeneracy_(graph_theory)#k-Cores) | `kcore` | Adds the core value |
| [Node similarity](https://en.wikipedia.org/wiki/Jaccard_index) | `nodeSimilarity` | Returns `{node1, node2, similarity}` |

Some algorithms add a score to each vertex: `pageRank`, `connectedComponent`, `peerPressure`, `hits`,
`kcore`. Every property step can read that score (`has`, `values`, `order().by`, `project().by`,
`valueMap()`).

**Other services**

| Service | | Notes |
|---|:--:|---|
| `tinker.search` | 🟡 | Full-text search of vertex and edge properties. Case-insensitive. Needs a term of 3 or more characters. `regex` is missing. `type: 'VertexProperty'` always returns nothing. |
| `federate` | ✅ | Runs part of a query on another graph. `.with('subgraph', true)` returns a subgraph you can traverse. |
| `io` | ✅ | What `io()` uses (§14). |

## 14. Import and export (`io`)

| Format | | Notes |
|---|:--:|---|
| GraphSON (typed, adjacency) | ✅ | Lossless. Use it for backup and seeding. |
| CSV | 🟡 | For exchange with other tools. It cannot hold list, set or map values, or meta-properties. |
| GraphML, Gryo | 🚫 | |

Import and export stream the data, so a graph can be larger than memory.

## 15. Traversal strategies

Every TinkerPop strategy has exactly one behaviour here. A strategy that would change the answer is
never ignored silently: if we do not apply it, the query fails.

| Behaviour | Strategies |
|---|---|
| **Applied** ✅ | `SubgraphStrategy`, `PartitionStrategy`, `ProductiveByStrategy` |
| **Checked** ✅ (raises the TinkerPop error) | `StandardVerificationStrategy` (always on), `ReadOnlyStrategy`, `EdgeLabelVerificationStrategy`, `ReservedKeysVerificationStrategy` |
| **Always on** ✅ (the work is always done) | `PathRetractionStrategy`, `RepeatUnrollStrategy`, `ConnectiveStrategy`, `EarlyLimitStrategy` |
| **Accepted, no effect** | `CountStrategy`, `IdentityRemovalStrategy`, `FilterRankingStrategy`, `LazyBarrierStrategy`, `OrderLimitStrategy`, `AdjacentToIncidentStrategy`, `IncidentToAdjacentStrategy`, `InlineFilterStrategy`, `PathProcessorStrategy`, `ByModulatorOptimizationStrategy`, `MatchAlgorithmStrategy`, `MatchPredicateStrategy`, `GValueReductionStrategy`, `ProviderGValueReductionStrategy`, `RequirementsStrategy`, `LambdaRestrictionStrategy`, `GraphFilterStrategy`, `ComputerFinalizationStrategy`, `MessagePassingReductionStrategy`, `ComputerVerificationStrategy`, `VertexProgramRestrictionStrategy`, `HaltedTraverserStrategy`, `VertexProgramStrategy`, `OptionsStrategy`, `ProfileStrategy`, `SeedStrategy` |
| **Rejected** ❌ | Every other strategy, for example `SackStrategy`, `SideEffectStrategy`, `EventStrategy`, `ElementIdStrategy`, `ReferenceElementStrategy` |

`withoutStrategies(X)` has no effect: the answer stays the same. Two strategies cannot be turned off:
disabling `StandardVerificationStrategy` or disabling `ConnectiveStrategy` is rejected.

## 16. Data model

- A vertex can have more than one label.
- A vertex property can have many values, and each value can have meta-properties.
- An edge property has one value.
- An element id is an integer, or the id you supplied. Vertex-property ids are made by the graph, so
  an import does not keep them.

## 17. Out of scope

| | Why |
|---|---|
| `store(k)` | Removed from the Gremlin language. Use `aggregate(k)`. |
| Row-at-a-time interpretation | Every query compiles to SQL. This is the purpose of the project. |
| GraphML, Gryo | See §14. |
