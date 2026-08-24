# mogwai-db — feature support matrix

What you can rely on. A ✅ step works **anywhere in a traversal**, however deeply nested — not just at
the top. **Notes list ONLY what does not work** (plus flagged divergences); no note means the whole
step works. Anything unsupported throws a clear error and never mis-executes.

**L3 conformance: <!-- L3:passing -->1,747<!-- /L3:passing -->/2,260 · corpus parse+chain: 2,395/2,395.**

| Mark | Meaning |
|---|:--|
| ✅ | Supported, at any depth. |
| 🟡 | Partial — the note says what is missing. |
| ❌ | Not yet. Throws `UnsupportedTraversal`. |
| 🚫 | Out of scope — we will not build it. **Not** a backlog item; §15 is the whole list, and §16 holds what is merely unbuilt. |

---

## 1. Sources & movement

| Step | | Notes |
|---|:--:|---|
| `V()`/`V(id…)`, `E()`/`E(id…)` | ✅ | a mid-traversal re-source (`…as('a').V()`) is ❌ after `path()`/`sack()`/`otherV()`; a fan-out `flatMap`/`local` child body still awaits the per-parent rejoin substrate |
| `out`/`in`/`both`, `outE`/`inE`/`bothE`, `outV`/`inV`/`bothV` | ✅ | |
| `otherV` | ❌ | |
| `inject(…)` | ✅ | ❌ appending a list onto an existing scalar stream |
| `call(service[, params])`, `.with(k,v)` | ✅ | |
| `io(path).read()` / `.write()` | ✅ | 🚫 GraphML, Gryo; a CSV export refuses a collection-valued property or a meta-property, and declares `bigint`/`bigdecimal`/`uuid`/`char`/`duration` as `String` |

**Services** — the `call()` registry, a per-runtime DI seam; `--list` enumerates it.

| Service | | Notes |
|---|:--:|---|
| `--list` | ✅ | |
| `tinker.degree.centrality` | ✅ | |
| `tinker.search` | ✅ | ❌ `type=VertexProperty`, `<3`-char term, `regex` |
| `mogwai.io` | ✅ | internal; what `io()` desugars to. Coverage as `io()` above |
| `mogwai.graph.federate` | ✅ | cross-graph pushdown (async barrier); `.with("subgraph", true)` brings back a traversable subgraph. ❌ `has(key, without/textP/composed)`, bound-parameter/`null` movement labels, `limit`/`order` over the bound stream, `path()`/`as()` spanning the call, and local movement over a NON-subgraph detached result |

## 2. Filters & predicates

| Step | | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)`, `has(label,k,v)`, `has(T.label,…)` | ✅ | |
| `has(T.id,…)`, `hasId` | ❌ | |
| `hasKey`, `hasValue` | ✅ | |
| `is(P)` | ✅ | ❌ after `path()`; an operand with no scalar to read; a correlated operand at a scalar-parent host |
| `where(__.…)`, `not`, `filter(__.…)` | ✅ | ❌ ordered children using traversal-valued `by()` |
| `where(P)` / `where('a',P)` | 🟡 | ❌ some `where(P.op)` forms, `by(key)` on an edge-typed label, `where('a',P)` over a scalar |
| `and`, `or` | ✅ | ❌ `filter(rawPredicate)` |
| `dedup()`, `dedup(labels)` | ✅ | ❌ bare `dedup()` after `as()`/path tracking; more than one `by()`; `dedup().by(value)` over a property |
| `identity()`, `sample(n)` | ✅ | |
| `coin(p)`, `simplePath`, `cyclicPath` | ❌ | |
| `typeOf(GType)` over a stored property | ✅ | |

**Predicates (`P`)** — all ✅ in every position a predicate is accepted, except as noted.

| Predicate | | Notes |
|---|:--:|---|
| `eq`, `neq`, `lt`, `lte`, `gt`, `gte`, `within`, `without` | ✅ | |
| `between`, `inside` | ✅ | |
| `outside` | ❌ | |

**Text predicates (`TextP`)** — case-insensitive under SQLite `LIKE`; a ≥3-char literal term uses the
`property_fts` trigram access path.

| Predicate | | Notes |
|---|:--:|---|
| `containing`, `startingWith`, `endingWith` + negations | ✅ | |
| `regex`, `notRegex` | ✅ | `has(key, regex)` ONLY (a batched barrier, JS `RegExp` semantics — divergence on Java-only constructs documented in `src/compiler/rel/regex.ts`). ❌ regex OUTSIDE `has(key, …)` (`is`/`where`/`match`) — a fail-closed deferral, `docs/2026-08-12-regex-as-a-barrier-research.md` |

## 3. Projections & element data

| Step | | Notes |
|---|:--:|---|
| `values(k…)`, `label()`, `labels()`, `id()` | ✅ | |
| `valueMap()`, `valueMap(true)`, `elementMap()` | ✅ | ❌ selective token subsets (`with(tokens, ids)`) |
| `properties()`, `key()`, `value()`, `element()` | ✅ | ❌ `id()`/`label()` off a property row; META-properties (`properties().properties()`, `has(k,v)` over a VertexProperty) |
| `propertyMap()` | ❌ | |
| `project(k…).by(…)` | ✅ | |
| `select(label…)`, `select(Column.keys/values)` | ✅ | ❌ dynamic-shape `Pop.mixed`; `select(label).by(key)` as a child body |
| `constant(v)` | ✅ | |

## 4. Aggregation & barriers

| Step | | Notes |
|---|:--:|---|
| `count()`, `sum`, `min`, `max`, `mean`, `fold()`, `unfold()` | ✅ | |
| `group().by().by()`, `groupCount()` | ✅ | ❌ a SCALAR host; a `dedup()` before the fold (it collapses the pool, and a global dedup is not a per-partition one) |
| `barrier()` | ✅ | ❌ `barrier(Barrier.normSack)` |
| `order().by(…)`, `range`, `limit`, `tail`, `skip` | ✅ | ❌ ELEMENT-list and `Column`-keyed order forms; `order().by(T.key/T.value)` over a property |

## 5. Branching

| Step | | Notes |
|---|:--:|---|
| `union(a, b…)` | 🟡 | ❌ a single-arm form whose one arm is a REDUCTION or binds a label; a MIXED variant with a MAP/record arm; an alias through a collapsed arm; a union whose emission order a downstream slice/collect READS (`union(…).limit(n)`, `.fold()`, `.cap()` — needs the arm-blocked fan-out order, not yet minted) |
| `choose(pred, a, b)`, `choose(P, a[, b])`, `choose(…).option(…)`, `choose(T.x).option(…)` | ✅ | ❌ where a downstream slice/collect READS the fan-out emission order; over a PROPERTY stream |
| `coalesce` | ✅ | ❌ a non-seeded reducer arm (`max`/`sum`); a `number`-reducer scalar merged with a plain scalar; a payload-MEMBER tail over a variant stream (`unfold`, a member transform, a keyed/`by()` dedup) |
| `optional` | ✅ | ❌ an element re-source arm (`optional(__.V())`) |
| `map(__.…)`, `flatMap(__.…)`, `local(__.…)` | 🟡 | ❌ `map` over a fan-out (movement) body (`map(__.out())`); `flatMap` over a pure scalar body (`flatMap(__.values('name'))`); `local` with a per-origin `order().by()`; `flatMap`/`local` under `path()`; a label bound inside the body that the outer chain reads (`local(__.out().as('b'))…select('b')`) |
| `branch`, `sideEffect(__.…)` | ❌ | |

Heterogeneous arms merge into a **variant stream**; after the merge the shape-agnostic steps
(`count`, the `limit`/`range`/`skip` slices, a bare `dedup`) compose over it, but a payload-MEMBER step
(`unfold`, a member transform, a keyed `dedup`) does not.

## 6. Recursion (`repeat`)

| Form | | Notes |
|---|:--:|---|
| `repeat(body).times(n)` | ✅ | a compile-time `times(n)` UNROLLS to n phases |
| `repeat(body).until(p)` / `.emit()` / `.emit(p)` | ✅ | unbounded, compiled as a recursive CTE, at all four modulator positions |
| `repeat()` with NEITHER modulator | ✅ | |
| unbounded + a per-iteration barrier | ❌ | refused — SQLite cannot express one in a recursive term (no `DISTINCT`, no aggregate) |

**No artificial depth cap.** A cyclic body without `simplePath()` is infinite per the spec; the DO's
per-request limit is the backstop.

## 7. Path

| Step | | Notes |
|---|:--:|---|
| `path()`, `path().by(…)` | ✅ | |
| `simplePath`, `cyclicPath`, `tree`, `subgraph` | ❌ | |

## 8. Pattern matching

`match(p1, p2, …)` 🟡 — a BINDING TABLE threaded through the ordinary fold, so a pattern body inherits
the whole step vocabulary at any depth (`src/compiler/rel/match.ts`,
`docs/2026-08-13-match-relir-lowering-plan.md`). The GQL match-STRING form
(`g.match("MATCH (a)-[:knows]->(b)")`) rides on this via its desugar (`src/gremlin/gql.ts`).

| Feature | | Notes |
|---|:--:|---|
| conjunctive BINDING pattern `as(x).<body>.as(y)` | ✅ | |
| readiness scheduling (argument ORDER unobservable) | ✅ | |
| BACK EDGE `as(y)` re-using a bound variable | ✅ | |
| terminal bindings MAP + downstream `select`/`select(…).by(…)` | ✅ | |
| NO-END constraint, filter-only body | ✅ | |
| per-row SCALAR end | ✅ | |
| REDUCING-barrier end `count`/`sum`/`mean`/`min`/`max` | ✅ | |
| start variable bound BEFORE the match | ✅ | |
| FILTER LEG `where(<body>)`/`not(<body>)` | ✅ | |
| inline `where('a', P.eq/neq('b'))` between two bound ELEMENT aliases | ✅ | |
| `and`/`or` connective GROUPS | ❌ | they BIND their nested ends |
| `where('a', P.op('b'))` non-`eq`/`neq`, or over a SCALAR alias | ❌ | |
| filter-AFTER-reduce end / `fold()` end | ❌ | `count().is(P.gt(10)).as('b')` |
| MOVING no-end pattern | ❌ | |
| 0/1-variable bindings map | ❌ | |
| nested `match` inside a pattern | ❌ | |
| `dedup(labels)` | ❌ | |
| `match()` on an edge stream | ❌ | |

Every ❌ fails closed, each a named next phase in `docs/2026-08-13-match-relir-lowering-plan.md`.

`shortestPath`, `pageRank`, `peerPressure`, `connectedComponent` ❌ — the OLAP family,
**not yet** rather than never: designed as `call()` services with the four step names as desugar
Passes (`docs/2026-07-24-graph-algorithms-plan.md`), so the compute stays set-based SQL.

## 9. Lists & collections

| Step | | Notes |
|---|:--:|---|
| `fold()`, `unfold()`, `order(Scope.local)`, `dedup(Scope.local)`, `range(local)`, `all`/`any`/`none` | ✅ | ❌ `dedup(local)` with a label tuple or a `by()` projection; PROPERTY-member and NESTED-list member lists |
| `combine`, `conjoin`, `difference`, `disjunct`, `intersect`, `product`, `merge` | ✅ | ❌ a set-op over an arm-merged (`union`) list, over an ELEMENT-member list, or a non-iterable SCALAR self |
| `index()` | ❌ | |

⚠️ A set-op does not yet keep its members' TYPES — `values('when').fold().merge(…)` returns raw millis.

## 10. Types, math & strings

Every canonical type round-trips with its exact GraphBinary tag; scalar type rides PER ROW, so a
heterogeneous stream frames each value by its own tag.

| Category | Types |
|---|---|
| text / bool | `string`, `boolean`, `char`, `uuid` |
| integer | `byte`, `short`, `int`, `long`, `bigint` |
| real | `float`, `double`, `bigdecimal` |
| temporal | `datetime`, `duration` |
| collection | `list`, `set`, `map` |

| Step | | Notes |
|---|:--:|---|
| `math(formula)` | ✅ | full exp4j surface, one SQL scalar (always Double — see 🔴 below) |
| `format(template)`, `concat`, `substring`, `length`, `toUpper`, `toLower`, `trim`/`lTrim`/`rTrim`, `replace` | ✅ | |
| `asString`, `asBool`, `asDate`, `dateAdd`, `dateDiff` | ✅ | |
| `asNumber` | 🟡 | ❌ over a stream of mixed numeric subtypes |
| `reverse` | ✅ | ❌ NESTED scalar reverse (in a child body, where a barrier cannot segment) — a fail-closed deferral |
| `split` | 🟡 | ❌ `split(Scope.local, sep)` over a folded list, and a LIST-shaped head — both fail-closed deferrals |

🔴 **Five documented deviations, not defects:**

| Deviation | Detail |
|---|---|
| host-language typing in Java/.NET | |
| 128-bit arithmetic declines | |
| int64 overflow raises natively | |
| 32-bit float arithmetic is not expressible | SQLite REAL is always a double |
| **`NaN` IS `null`** | SQLite has no NaN (stores one as `NULL` however it arrives), so mogwai folds a `NaN` literal to `null` at ingestion. Diverges from Java (`NaN ≠ null`): `inject(NaN).is(P.eq(null))` MATCHES for us (Java returns empty), `inject(NaN).is(P.neq(null))` is empty (Java returns `[NaN]`). `±Infinity` is unaffected (SQLite represents it via `9e999`/`-9e999`). Both fold at one seam (`compiler/rel/const.ts`), inlined as constants — never a bind |

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
| `aggregate(k)`, `cap(k)`, `group(k)`, `groupCount(k)` | ✅ | |
| `withSideEffect(k, v)`, `withSideEffect(k, seed, Operator)` | ✅ | |
| `withSack(seed)`, `sack()`, `sack(op).by(…)` | ✅ | ❌ `withSack(seed, Operator.x)` |
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

Short on purpose: a 🚫 means **we will not build this**, never "we have not got to it".

| Non-goal | Why |
|---|---|
| `store(k)` | gone from the language upstream |
| Row-at-a-time interpretation | the failure mode this project exists to avoid |

## 16. Not yet — INTENDED, unscheduled (❌)

Not a wall: it has a design doc, is unscheduled, and fails closed with a clear deferral until it
lands — so a query never gets a silently narrower answer in the meantime. (`regex` was here; it
LANDED as a barrier — see §2. Its `apply` shape and the barrier substrate it shares with OLAP are
`docs/2026-08-21-barrier-substrate-design.md`.)

| Item | Shape | Doc |
|---|---|---|
| OLAP / graph algorithms — `pageRank`, `peerPressure`, `connectedComponent`, `shortestPath` | `call()` services (the GDS-shaped superset) with the four native step names as thin desugar Passes to the same services — one implementation, compute stays set-based SQL, never a row-at-a-time interpreter | `docs/2026-07-24-graph-algorithms-plan.md`, substrate `docs/2026-08-21-barrier-substrate-design.md` |
