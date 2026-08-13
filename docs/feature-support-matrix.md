# mogwai-db — feature support matrix

What you can rely on. A ✅ step works **anywhere in a traversal**, however deeply nested — not just at
the top. Notes list **only what does not work**; no note means the whole step works. Anything
unsupported throws a clear error and never mis-executes.

**L3 conformance: <!-- L3:passing -->1,445<!-- /L3:passing -->/2,260 · corpus parse+chain: 2,395/2,395.**

| Mark | Meaning |
|---|:--|
| ✅ | Supported, at any depth. |
| 🟡 | Partial — the note says what is missing. |
| ❌ | Not yet. Throws `UnsupportedTraversal`. |
| 🚫 | Out of scope — a deliberate non-goal. |

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | numeric rowid or string `uid`; a mid-traversal re-source (`…as('a').V()`) splits each incoming traverser over the selected graph elements, preserving aliases and one canonical encounter order. ❌ after `path()`/`sack()`/`otherV()`; a fan-out `flatMap`/`local` child body still awaits the per-parent rejoin substrate |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | index-only covering-index hops; convergent walks auto-collapse |
| `otherV` | ❌ | |
| `inject(…)` | ✅ | ❌ appending a list onto an existing scalar stream |
| `call(service[, params])`, `.with(k,v)` | ✅ | source and mid-traversal; pure (`rel`) and async (`barrier`) contributions |
| `io(path).read()` / `.write()` | 🟡 | desugars to `call("mogwai.io", …)`. Typed GraphSON (`.json`) both ways, lossless. Neptune/Neo4j CSV (`.csv`) for interop — reads either dialect, writes Neptune as a `<stem>-vertices`/`<stem>-edges` pair. Documents live behind `IoStore`: a rooted dir on Bun (`$MOGWAI_IO_DIR`), an R2 binding in a DO. ❌ GraphML, Gryo; a CSV export refuses a collection-valued property or a meta-property, and declares `bigint`/`bigdecimal`/`uuid`/`char`/`duration` as `String` |

**Services** — the `call()` registry, a per-runtime DI seam; `--list` enumerates it.

| Service | | Notes |
|---|:--:|---|
| `--list` | ✅ | `.with("service",…)` filter, `verbose` describe blob |
| `tinker.degree.centrality` | ✅ | `direction` OUT/IN/BOTH (default IN); composes in `where`/`group`/`order`/`project` |
| `tinker.search` | 🟡 | FTS5-trigram over property values; `.element()` walks to the owner. `type` Vertex/Edge, **case-insensitive**. ❌ `type=VertexProperty`, `<3`-char term, `regex` |
| `mogwai.io` | 🟡 | internal; what `io()` desugars to. Coverage as `io()` above |
| `mogwai.graph.federate` | 🟡 | cross-graph pushdown (async barrier). Source form runs a rooted sub-traversal on a sibling → detached refs; mid-traversal injects each parent's `values`/`id`/`label` via the `T.value` marker, batched one hop and value-rejoined per parent. A detached result supports `id`/`label`/`values` only. ❌ local movement over a detached result; `path()`/`as()` spanning the call |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label,…)` | ✅ | every arity, in every position including inside a predicate body |
| `has(T.id,…)`, `hasId` | ❌ | |
| `hasKey`, `hasValue` | ✅ | one `HasContainer` on `T.key`/`T.value`; single arg is `eq`, several a `within`, and a NULL member is inert (an all-null set matches nothing). The value compares through the row's own `vtype`, so an exact number carried as decimal TEXT compares numerically |
| `is(P)` | ✅ | a `constant()` operand folds to its literal; an operand TRAVERSAL compiles to a value compared against its FIRST result, re-sourced or correlated. An unproductive operand is SQL NULL — it drops the traverser for `eq` and contributes nothing to a `within` set. ❌ after `path()`; an operand with no scalar to read; a correlated operand at a scalar-parent host |
| `where(__.…)`, `not`, `filter(__.…)` | ✅ | single- and multi-hop, edge-typed hops, alias-rooted `where(__.as('x')…)`, label reads at any depth, per-parent `order().by(key)` before a slice. ❌ ordered children using traversal-valued `by()` |
| `where(P)` / `where('a',P)` | 🟡 | value-compare over a scalar stream and alias-column compare work. ❌ some `where(P.op)` forms, `by(key)` on an edge-typed label, `where('a',P)` over a scalar |
| `and`, `or` | ✅ | infix on STEPS and on PREDICATES (`P.gt(20).and(P.lt(30))`, `P.gt(30).negate()`), to any depth. ❌ `filter(rawPredicate)` |
| `dedup()`, `dedup(labels)` | ✅ | bare, `by(key/T.id/T.label/scalar traversal)`, label tuples; over a PROPERTY row the identity is per owner kind — a `VertexProperty` by id, an edge `Property` by key+value, so equal values collapse ACROSS their edges. ❌ bare `dedup()` after `as()`/path tracking; more than one `by()`; `dedup().by(value)` over a property |
| `identity()`, `sample(n)` | ✅ | |
| `coin(p)`, `simplePath`, `cyclicPath` | ❌ | |
| `typeOf(GType)` over a stored property | ✅ | every canonical type, incl. `bigdecimal`/`char`/`duration` |

**Predicates (`P`)** — `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `within`, `without`, `between`, `inside`
all ✅ in every position a predicate is accepted. ❌ `outside`. `between` is `[lo,hi)`, `inside` is
`(lo,hi)`.

**Text predicates (`TextP`)** — `containing`, `startingWith`, `endingWith`, and their negations ✅
wherever a predicate is accepted. Matching is case-insensitive under SQLite `LIKE`; a literal term of
three or more characters over a stored property uses the `property_fts` trigram access path, while the
generic typed/escaped predicate remains the semantic authority. `regex` is 🚫 — SQLite has no regex
operator and DO SQLite has no UDFs, so it fails closed rather than filtering in JS.

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `label()`, `labels()`, `id()` | ✅ | `values()` reads EVERY key; `values(null)` reads NONE — a null key never matches, so it is inert beside a real key and an all-null set is the empty result rather than "every" |
| `valueMap()`, `valueMap(true)`, `elementMap()` | ✅ | token rendering follows `with("multilabel")`/`with("singlelabel")`. ❌ selective token subsets (`with(tokens, ids)`) |
| `properties()`, `key()`, `value()`, `element()` | ✅ | ❌ `id()`/`label()` off a property row; META-properties (`properties().properties()`, `has(k,v)` over a VertexProperty) |
| `propertyMap()` | ❌ | |
| `project(k…).by(…)` | ✅ | an unproductive `by()` OMITS its key, as the reference does |
| `select(label…)`, `select(Column.keys/values)` | ✅ | `Pop.all` and a non-singleton linear `Pop.mixed` re-enter homogeneous scalar/element/nested-list histories as ordinary typed lists. ❌ dynamic-shape `Pop.mixed`; `select(label).by(key)` as a child body |
| `constant(v)` | ✅ | |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `count()`, `sum`, `min`, `max`, `mean`, `fold()`, `unfold()` | ✅ | a reducer over ZERO rows follows the reference per step: `fold`/`group` seed (`[]`/`{}`), `sum`/`min`/`max` emit nothing |
| `group().by().by()`, `groupCount()` | ✅ | ❌ a group-scoped `count()` with a non-empty body; a SCALAR host |
| `barrier()` | ✅ | ❌ `barrier(Barrier.normSack)` |
| `order().by(…)`, `range`, `limit`, `tail`, `skip` | ✅ | deterministic, not merely ordered, over ELEMENT, SCALAR, RECORD and PROPERTY rows through one engine. A property's own order is per owner kind — a `VertexProperty` by id, an edge `Property` by key then value — and `by(desc)` reverses every term. ❌ ELEMENT-list and `Column`-keyed order forms; `order().by(T.key/T.value)` over a property |

## 5. Branching

| Step | | Notes |
|---|:--:|---|
| `union(a, b…)` | 🟡 | two or more arms ✅. ❌ the SINGLE-arm form |
| `choose(pred, a, b)`, `choose(P, a[, b])`, `choose(…).option(…)` | ✅ | over ELEMENT and SCALAR streams alike — the condition's subject comes from the framing. A bare `P` is TinkerPop's own `choose(Predicate, …)` overload; a single-arm form passes unmatched traversers through. ❌ where an emission order is already carried (a merge re-mints it) |
| `coalesce` | ✅ | UNION WITH PRIORITY: arm k takes the traversers for which arms 1…k−1 produced nothing. A body that always produces (`constant`/`count`/`fold`) exhausts it. ❌ where an emission order is already carried |
| `optional`, `branch`, `map(__.…)`, `flatMap`, `sideEffect(__.…)` | ❌ | |
| `local(__.…)` | ❌ | |

Heterogeneous arms merge into a **variant stream**; after the merge the shape-agnostic steps
(`count`, `unfold`, slices) compose over it.

## 6. Recursion (`repeat`)

| Form | | Notes |
|---|:--:|---|
| `repeat(body).times(n)` | ✅ | a compile-time `times(n)` UNROLLS to n phases, which is the only lowering that can carry both a per-iteration barrier and the bulk collapse |
| `repeat(body).until(p)` / `.emit()` / `.emit(p)` | ✅ | unbounded, compiled as a recursive CTE, at all four modulator positions; a sack folds through it |
| `repeat()` with NEITHER modulator | ✅ | the specified EMPTY result |
| unbounded + a per-iteration barrier | ❌ | refused — SQLite cannot express one in a recursive term (no `DISTINCT`, no aggregate) |

**No artificial depth cap.** A cyclic body without `simplePath()` is infinite per the spec; the DO's
per-request limit is the backstop.

## 7. Path

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(…)` | ✅ | one JSONB array channel, positions rebuilt as a typed tree |
| `simplePath`, `cyclicPath`, `tree`, `subgraph` | ❌ | |

## 8. Pattern matching

`match(…)` ❌. `shortestPath`, `pageRank`, `peerPressure`, `connectedComponent` ❌ — the OLAP family.

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()`, `unfold()`, `order(Scope.local)`, `dedup(Scope.local)`, `range(local)`, `all`/`any`/`none` | ✅ | `order(local)` takes a comparator `by(asc/desc)`, and over an ELEMENT-member list any element projection (`by(k)`, `by(T.label)`, `by(<body>)`) — an unproductive one DROPS the member; `dedup(local)` keeps the FIRST occurrence per value and keys on the member's value AND its type tag, so a Byte(1) and an Integer(1) stay apart. Member admission is per ARM: the value-reading ops (string transforms, `all`/`any`/`none`) stay scalar-member only. ❌ `dedup(local)` with a label tuple or a `by()` projection; PROPERTY-member and NESTED-list member lists |
| `combine`, `conjoin`, `difference`, `disjunct`, `intersect`, `product`, `merge` | ✅ | ❌ a set-op over an arm-merged (`union`) list |
| `index()` | ❌ | |

⚠️ A set-op does not yet keep its members' TYPES — `values('when').fold().merge(…)` returns raw millis.

## 10. Types, math & strings

Every canonical type round-trips with its exact GraphBinary tag: `string`, `boolean`, `byte`, `short`,
`int`, `long`, `bigint`, `float`, `double`, `bigdecimal`, `char`, `uuid`, `datetime`, `duration`, plus
lists/sets/maps. Scalar type rides PER ROW, so a heterogeneous stream frames each value by its own tag.

| Step | | Notes |
|---|:--:|---|
| `math(formula)` | ✅ | full exp4j surface, one SQL scalar (always Double) |
| `format(template)`, `concat`, `substring`, `length`, `toUpper`, `toLower`, `trim`/`lTrim`/`rTrim`, `replace` | ✅ | |
| `asString`, `asBool`, `asDate`, `dateAdd`, `dateDiff` | ✅ | a literal that cannot parse RAISES the reference's message, at compile time |
| `asNumber` | 🟡 | ❌ over a stream of mixed numeric subtypes |
| `reverse` | ✅ | dispatches on the TRAVERSER's type, as `ReverseStep.map` does: a string reverses its characters, a LIST or a path reverses member ORDER (and stops being a `set`), and any other scalar is an identity |
| `split` | ❌ | |

🔴 Four documented deviations, not defects: host-language typing in Java/.NET; 128-bit arithmetic
declines; int64 overflow raises natively; 32-bit float arithmetic is not expressible (SQLite REAL is
always a double).

## 11. Writes

| Step | | Notes |
|---|:--:|---|
| `addV(label…)`, `addE(label)`, `from`/`to` | ✅ | ❌ a runtime/computed label; `addE` after `addE`; `addInE` |
| `property(k, v)`, `property(Cardinality, k, v)` | ✅ | ❌ `property(k, <traversal>)` |
| `addLabel`, `dropLabel`, `dropLabels` | ✅ | |
| `mergeV`, `mergeE`, `.option(onCreate/onMatch)` | 🟡 | ❌ `T.id` in the merge map; a map-valued `inject`/`union` feeding the merge; a meta-property under an undeclared cardinality |
| `drop()` | ✅ | elements and properties |

A write chain is a SEQUENCE of statements, O(write steps) and never O(rows).

## 12. Side-effect state

| Step | | Notes |
|---|:--:|---|
| `aggregate(k)`, `cap(k)`, `group(k)`, `groupCount(k)` | ✅ | N sites accumulate; a keyed site merges per key |
| `withSideEffect(k, v)`, `withSideEffect(k, seed, Operator)` | ✅ | the reducer form is a seeded LEFT FOLD |
| `withSack(seed)`, `sack()`, `sack(op).by(…)` | ✅ | folds through a `repeat()` walk. ❌ `withSack(seed, Operator.x)` |
| `store(k)` | 🚫 | removed from the language upstream |

## 13. Traversal strategies

`PartitionStrategy` ✅ (❌ with `mergeV`/`mergeE`), `SubgraphStrategy` ✅ (❌ the `vertexProperties`
criterion), `ProductiveByStrategy` ✅, `withoutStrategies` ✅. A semantic strategy we do not implement
is REJECTED, never silently ignored.

## 14. Element / property model

Vertices carry MULTIPLE labels (`addLabel`/`dropLabel`); TinkerPop's single-label rule is not enforced.
Vertex properties are multi-valued with meta-properties; edge properties are single-valued by schema.
Element ids are integer rowids, externally `COALESCE(uid, id)`.

## 15. Locked non-goals (🚫)

- **OLAP / `GraphComputer`** — `shortestPath`, `pageRank`, `peerPressure`, `connectedComponent`.
- **`regex`** — no SQLite operator, no UDFs on DO; filtering in JS would break "compile to SQL".
- **`store(k)`** — gone from the language upstream.
- **Row-at-a-time interpretation** — the failure mode this project exists to avoid.
