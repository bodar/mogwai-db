# mogwai-db — feature support matrix

**A living, honest map of what the compiler supports.** Not a conformance gate, not
a roadmap — a scannable "can I use this step, and if only partly, where's the edge?"
reference. Grouped into tables by traversal concern.

**Last synced:** 2026-07-13 · **live L3 conformance:** 618 · **corpus parse+chain:**
2298/2298 (100%). Sourced from the actual dispatch maps (`src/steps/*.ts`) and the
`throw` sites in the compiler — if the code defers it, this file says so.

> **How to keep this true.** When a step's support changes, update its row here in the
> same commit. The deferral notes below are paraphrased from real `throw` messages —
> grep `src/` for `not yet supported` / `not supported` / `step not implemented` to
> find the authoritative text.

## Legend

| Mark | Meaning |
|---|---|
| ✅ | **Full** — supported across its normal forms |
| 🟡 | **Partial** — common forms work; specific shapes deferred (see note) |
| ❌ | **Deferred** — not yet compiled; throws a clear error (a named future bet) |
| 🚫 | **Out of scope** — a locked non-goal (lambdas / OLAP / multi-request tx) |

The throughline for every ❌: it **fails closed** with a clear message, never silently
under-executes. That honesty is the point of this table.

---

## 1. Sources & movement

| Step | Status | Notes |
|---|:--:|---|
| `V()`, `V(id…)` | ✅ | id resolves numeric rowid **or** string `uid` |
| `E()`, `E(id…)` | ✅ | |
| `inject(…)` | ✅ | value stream; all-array args → list stream (§9) |
| `out`/`in`/`both` | ✅ | covering-index hops, index-only, sub-ms at 1M edges |
| `outE`/`inE`/`bothE` | ✅ | flips the typed id-relation to edge |
| `outV`/`inV`/`bothV` | ✅ | flips back to node |

## 2. Filters & predicates

| Step | Status | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)` | ✅ | auto-builds a hot-property expression index on first filtered use |
| `has(label,k,v)`, `has(T.label/T.id, v/P)` | ✅ | the cucumber verification idiom |
| `hasId(…)` | ✅ | flattens list args |
| `is(P)` | 🟡 | folds onto the projected scalar; ❌ after `limit`/`range`/`skip`, after `path()` |
| `where(__.…)` | 🟡 | single- & multi-hop (`compileExistsChain`), `where(__.label()/not())`, alias-rooted `where(__.as('x')…)`. ❌ `both()` multi-hop, edge-typed hops |
| `where(P)` / `where('a',P)` | 🟡 | alias-column compare (P2a). ❌ some `where(P.op)` alias forms, `where().by(key)` on an edge-typed label |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | `filter(predicate)` (non-traversal) ❌ — use `filter(traversal)` |
| `P` predicates (eq/neq/lt/gt/within/without/between/inside/outside) | ✅ | `between` is `[lo,hi)` (two comparisons, not SQL `BETWEEN`) |
| **TextP** (startingWith/endingWith/containing + negations) | ✅ | bound `LIKE`/`NOT LIKE`, pattern escaped |
| **TextP regex** (`regex`/`notRegex`) | ❌ | DO SQLite has no regex UDF; would need post-SQL JS filter |
| `typeOf(GType)` over a **stored property** | ❌ | SQLite storage class can't distinguish bool/datetime/uuid from int/text — needs a storage type-tag scheme |
| `dedup()` | 🟡 | ❌ `dedup(label)`, `dedup()` after `as()` / with path tracking (path-distinct semantics) |
| `identity()` | ✅ | |

## 3. Projections & element data

| Step | Status | Notes |
|---|:--:|---|
| `values(k…)` | ✅ | |
| `id()`, `label()`, `count()` | ✅ | ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | ✅ | custom vertex/edge framing (client serializer hardcodes empty props) |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | 🟡 | ❌ `element()` of an **edge** property; ❌ most steps trailing `properties()`; ❌ `group().by()` on a property element |
| `select('a')`, multi-`select`, `project(…)` | 🟡 | column-threaded aliases. ❌ `select`/`project` of an **edge**-typed label; ❌ `select(Column.values/keys)` |
| `select(Column)` | ❌ | the group-values cluster (`group()…select(Column.values).unfold()`) — a list-substrate tail add |
| **chained projections** (`values().count()`, `valueMap().select()`) | ❌ | `only one projection step is supported per traversal` — element→scalar→scalar re-type; partly dissolved by §9, still open for this shape |
| `order()` [`.by(key[,dir])`] | 🟡 | tail modifier; ❌ `order()` after `path()`; ❌ `order().by(key)` on a scalar stream |
| `limit`, `range`, `skip` | ✅ | CTE mid-chain, tail-modifier after `order()` |
| `by(…)` modulator | ✅ | only as an `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` modulator |

## 4. Aggregation & barriers

| Step | Status | Notes |
|---|:--:|---|
| `group`, `groupCount` | 🟡 | scalar reducers → SQL `GROUP BY`; element values → ordered-stream + handler fold. ❌ >2 `by()` modulators, `by(T.x)` key, deep nested-`by()` chains |
| `fold()` | ✅ | terminal reducer **and** a real JSONB list value when followed (§9) |
| `sum`, `min`, `max`, `mean` | ✅ | Long/Double framing; also as `Scope.local` list reducers (§9) |
| `group('a')` (side-effecting) | ❌ | side-effect state — see §12 |

## 5. Per-traverser branching

| Step | Status | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | 🟡 | gated-seed dispatch. ❌ scalar/projection arm bodies, mixed-shape arms, after `as()`, path tracking through |
| `choose(fn).option(k, body)…` | 🟡 | scalar-CASE option-map. ❌ without a `Pick.none` default, element/discard/identity/fail bodies, `Pick.unproductive`/`any`, any trailing step |
| `coalesce(…)` | 🟡 | first-non-empty via the `St.origin` ordinal. ❌ scalar branches, mixed-shape, after `as()`, nested in coalesce/optional, path tracking |
| `union(…)` | 🟡 | multi-hop arms via `foldBody`. ❌ mixed-shape, source-branch tails/`as()`, path tracking |
| `optional(…)` | 🟡 | single-hop LEFT JOIN fast path + multi-hop. ❌ element-kind change on miss, after `as()`, path tracking |
| `flatMap(__.…)` | 🟡 | element body fan-out. ❌ after `as()`, path tracking |
| `map(__.<scalar>)` | 🟡 | correlated scalar (`map(__.out().count())` etc). ❌ **element**-body `map` (first-result — needs `ROW_NUMBER` over `St.origin`), alias/select/fold bodies, trailing steps |
| `local(…)` | ❌ | per-element scope — the hardest remaining branching piece (a future bet) |

## 6. Recursion (`repeat`)

| Step | Status | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | `WITH RECURSIVE walk`; both = two recursive terms |
| `emit` (before/after, bare) | ✅ | runs to natural fixpoint (no depth cap) |
| `until(<pred>)`, `loops().is(n)` | 🟡 | do-while/while-do. ❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | JSONB array walk + `json_each` cycle guard |
| `emit(pred)`, `times(pred)` | ❌ | predicate forms |
| `until` + `times`, `until` + `emit` | ❌ | combined exit conditions |
| complex/filtered/multi-hop repeat bodies | ❌ | `repeat(__.out().has(k,v))`, `repeat(__.out().out())` — extend the recursive term (a seam-reuse item) |
| `repeat()` on edges, after `as()` | ❌ | |
| `path().by()` on the recursive walk | ❌ | |

## 7. Path family

| Step | Status | Notes |
|---|:--:|---|
| `path()`, `path().by(key)` | 🟡 | linear label-carry + handler assembly. ❌ `path().by(traversal)`/`by(T.x)`, spanning >1 movement/repeat, over a `union()` source |
| `simplePath()`, `cyclicPath()` | ✅ | all-pairs identity (linear) / `json_each` guard (in repeat body) |
| steps after `path()` | ❌ | `order`/reducer/`is`/transform/`inject` after `path()` |
| `tree()` | 🚫 | JS GLV cucumber ignores all 13 tree scenarios + stubs `DataType.TREE` → 0 conformance. Build only if a non-JS consumer appears |

## 8. Pattern matching

| Step | Status | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | conjunctive pattern join on the alias seam; `as(start).<out/in>*[.has].as(end)` patterns, dependency-ordered. ❌ `both()`/edge/scalar-terminal patterns, `or`/`not`/nested-match, `>1`/`0` root vars, match-inside-where, select-then-movement, path tracking |

## 9. Lists & collections

| Step | Status | Notes |
|---|:--:|---|
| `fold()` as a re-usable list value | ✅ | JSONB list; re-enters the tail |
| `unfold()` | 🟡 | `json_each` explode → elements or scalar stream. ❌ after a projection/modifier on an element stream; Map-unfold |
| `inject([…])` as a list | ✅ | each bracket arg = one list value |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | per-list correlated aggregate; also degenerate scalar-local |
| `none(P)` collection filter | ✅ | keep lists where no element matches |
| `Scope.local` order/limit/range/tail/dedup on a list | ❌ | their scenarios chain `reverse()`/`skip(local)` — a list-substrate tail add |
| **set-ops** (`combine`/`intersect`/`conjoin`/`disjunct`/`product`/`difference`) | ❌ | ~64 scenarios; small adds now that fold-as-value exists |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter); fails closed |

## 10. Types, math & dates

| Step | Status | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | typed-value carrier (compile-time subtype tag → GraphBinary framing) |
| string transforms (`concat`/`length`/`toUpper`/`toLower`/`asString`/`substring`/`replace`) | ✅ | SQL scalar, text-in text-out |
| `math("<formula>")` | 🟡 | full exp4j operator/function set → one SQL scalar, always Double. ❌ a var with no `by()`, `withSideEffect` vars, reading `project()`/`select()` map columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` literals | 🟡 | epoch-millis rep + `'date'` tag (UTC-only, ms precision — parity with the JS reference client). ❌ `typeOf(GType.DATETIME)` over stored props, `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ❌ | subtype tag can't survive `wrapReducer` yet |
| bigdecimal | ❌ | no client GraphBinary serializer |
| `format()` | ❌ | template substitution — net-new (small, its own piece) |

## 11. Writes

| Step | Status | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | user-supplied ids (string→uid, int→rowid) |
| `addE()`, `from`/`to` | 🟡 | `as()` alias or nested `__.V(…)`; edge uid via `property(T.id)`; multi-addE graph initializers. ❌ nested-traversal `addE` label, endpoint traversal past a movement, `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | id-aware upsert, onCreate/onMatch, start + mid-chain. ❌ nested-traversal merge maps (`mergeV(__.select…)`), `option(…, __.traversal)`, bare `mergeV()`/`mergeE()` (incoming-as-map) |
| `property()` update | 🟡 | JS-merge, **single** cardinality. ❌ `Cardinality.list/set` (→ W4) |
| `drop()` (vertices + edges) | 🟡 | ❌ edge `drop()`, `drop()` after some steps |
| `property(Cardinality.list/set, …)` (multi-property) | ❌ | **W4** schema rework |

## 12. Side-effect state — ❌ the next big structural bet

| Step | Status | Notes |
|---|:--:|---|
| `aggregate('x')` / `store('x')` | ❌ | named collection that outlives the current id-relation — **a new execution notion** (~57 + 21 scenarios) |
| `cap('x')` | ❌ | emit a named side-effect (composes with §9: `cap` → a list → `unfold`) |
| `sack()` / `withSack(…)` | ❌ | per-traverser mutable scalar + merge fn (~29 scenarios); a carried column, not a named relation |
| `group('a')` (side-effecting) | ❌ | small extension of `group` once the substrate exists |

These are the **largest coherent block still deferred** (~110 scenarios direct, plus it
gates `ProductiveByStrategy` ~29 and ~25 deferred `cap().unfold()` scenarios). See the
standalone analysis for the SQL-native design (named side-effect CTEs threaded through
`Carry`, materialized at barriers, read at `cap`/`within`/`without`/`select`).

## 13. Traversal strategies

| Strategy | Status | Notes |
|---|:--:|---|
| 15 optimization strategies | ✅ | accepted as **no-ops** (result-preserving by TinkerPop's contract; our SQL does its own planning) |
| `withoutStrategies(…)` | ✅ | safe no-op (we apply no default) |
| **SubgraphStrategy** (vertex criterion) | 🟡 | `where`/`has` injection pass. ❌ edge/vertexProperty criteria, adjacency (`out()` expansion) |
| **PartitionStrategy** (read-filter + write-stamp) | 🟡 | `has(within)` + property stamp. ❌ `includeMetaProperties`, partition-aware merge |
| ReadOnly / EdgeLabel / ReservedKeys **verification** | ✅ | throw TinkerPop's canonical messages |
| ProductiveByStrategy | ❌ | gated on `aggregate`/`cap` (§12) |
| `with(…)` (OptionsStrategy sugar) | ❌ | `step not implemented: with()` |
| OLAP / GraphComputer / Seed / Event strategies | 🚫 | out of scope |

## 14. Element / property model

| Feature | Status | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| **User-supplied ids** (string `uid`) | 🟡 | resolved at `V('x')` seed + framing-out. ❌ scalar id via `by(__.outV().id())`/`group().by(__.id())`, edge's own uid via `addE` in some paths, `properties().element().id()` |
| **Multi-properties** (list cardinality) | ❌ | **W4** — props are a flat JSON object today |
| **Meta-properties** (properties-on-properties) | ❌ | **W4** — schema rework |
| Property types: primitives + list/map | ✅ | JSON text storage (JSONB migration is a measured opportunity, not done) |

## 15. Locked non-goals (🚫)

| Feature | Why |
|---|---|
| **Lambdas** | v4-native stance; gremlin-lang barely supports them |
| **OLAP / GraphComputer** | locked out — mogwai is OLTP (small per-tenant graphs) |
| **Multi-request `g.tx()`** | needs DO session state (a P5 stretch, not a non-goal forever) |
| `tree()` | 0 conformance (JS GLV stubs it) — build only for a non-JS consumer |

---

## Where this points (the remaining frontier)

Cheapest wins are long done. What's left, by structural weight:

1. **Side-effect state** (§12) — the one genuinely-new execution concept left, highest
   downstream unlock (~110 direct + gates ProductiveBy + cap-unfold). **The next big bet.**
2. **Multi/meta-properties (W4)** (§11, §14) — the committed target-profile schema rework;
   biggest storage blast radius, best done before more read features assume flat props.
3. **`local`** (§5) — per-element scope; the hardest remaining branching piece.
4. **Chained projections** (§3) — element→scalar→scalar re-type; partly dissolved by the
   list substrate, still open for this shape (~40).
5. **Collection-algebra tail** (§9) — set-ops / Map-unfold / `select(Column.values)` /
   rest of Scope.local; small adds on the list substrate.

Full analysis: `docs/2026-07-12-conformance-structural-bets.md` (the "remaining frontier").
