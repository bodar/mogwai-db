# mogwai-db — feature support matrix

**A living, honest map of what the compiler supports.** Not a conformance gate, not
a roadmap — a scannable "can I use this step, and if only partly, where's the edge?"
reference. Grouped into tables by traversal concern.

**Last synced:** 2026-07-13 · **live L3 conformance:** 634 · **corpus parse+chain:**
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

**Notes convention.** Within a Notes cell, each line is one clause: a ✅ bullet is a
**supported** form, a ❌ bullet is a **deferred** shape (fails closed). Rows that are
wholly ❌/🚫 give the deferral reason as a single plain line.

---

## 1. Sources & movement

| Step | Status | Notes |
|---|:--:|---|
| `V()`, `V(id…)` | ✅ | ✅ id resolves numeric rowid **or** string `uid` |
| `E()`, `E(id…)` | ✅ | |
| `inject(…)` | ✅ | ✅ value stream<br>✅ all-array args → list stream (§9) |
| `out`/`in`/`both` | ✅ | ✅ covering-index hops, index-only, sub-ms at 1M edges |
| `outE`/`inE`/`bothE` | ✅ | ✅ flips the typed id-relation to edge |
| `outV`/`inV`/`bothV` | ✅ | ✅ flips back to node |

## 2. Filters & predicates

| Step | Status | Notes |
|---|:--:|---|
| `hasLabel`, `has(k)`, `has(k,v)`, `has(k,P)` | ✅ | ✅ auto-builds a hot-property expression index on first filtered use |
| `has(label,k,v)`, `has(T.label/T.id, v/P)` | ✅ | ✅ the cucumber verification idiom |
| `hasId(…)` | ✅ | ✅ flattens list args |
| `is(P)` | 🟡 | ✅ folds onto the projected scalar<br>❌ after `limit`/`range`/`skip`<br>❌ after `path()` |
| `where(__.…)` | 🟡 | ✅ single- & multi-hop (`compileExistsChain`)<br>✅ `where(__.label()/not())`<br>✅ alias-rooted `where(__.as('x')…)`<br>❌ `both()` multi-hop<br>❌ edge-typed hops |
| `where(P)` / `where('a',P)` | 🟡 | ✅ alias-column compare (P2a)<br>❌ some `where(P.op)` alias forms<br>❌ `where().by(key)` on an edge-typed label |
| `and`, `or`, `not`, `filter(__.…)` | ✅ | ✅ `and`/`or`/`not`, `filter(traversal)`<br>❌ `filter(predicate)` (non-traversal) — use `filter(traversal)` |
| `P` predicates (eq/neq/lt/gt/within/without/between/inside/outside) | ✅ | ✅ `between` is `[lo,hi)` (two comparisons, not SQL `BETWEEN`) |
| **TextP** (startingWith/endingWith/containing + negations) | ✅ | ✅ bound `LIKE`/`NOT LIKE`, pattern escaped |
| **TextP regex** (`regex`/`notRegex`) | ❌ | DO SQLite has no regex UDF; would need post-SQL JS filter |
| `typeOf(GType)` over a **stored property** | ❌ | SQLite storage class can't distinguish bool/datetime/uuid from int/text — needs a storage type-tag scheme |
| `dedup()` | 🟡 | ✅ bare `dedup()`<br>❌ `dedup(label)`<br>❌ `dedup()` after `as()` / with path tracking (path-distinct semantics) |
| `identity()` | ✅ | |

## 3. Projections & element data

| Step | Status | Notes |
|---|:--:|---|
| `values(k…)` | ✅ | |
| `id()`, `label()`, `count()` | ✅ | ✅ ids frame as `COALESCE(uid,id)` |
| `valueMap`, `elementMap` | ✅ | ✅ custom vertex/edge framing (client serializer hardcodes empty props) |
| `properties(k…)` [`.key`/`.value`/`.element`/`.id`/`.label`/`.count`] | ✅ | ✅ `.key`/`.value`/`.element`/`.id`/`.label`/`.count`; real VP id + meta framed (W4)<br>✅ `has(metaKey)`/`hasKey`/`hasValue`/`.properties()`(meta)/`valueMap`(metaMap)<br>❌ `element()` of an **edge** property<br>❌ `properties().dedup()` |
| `select('a')`, multi-`select`, `project(…)` | 🟡 | ✅ column-threaded aliases<br>❌ `select`/`project` of an **edge**-typed label<br>❌ `select(Column.values/keys)` |
| `select(Column)` | ❌ | the group-values cluster (`group()…select(Column.values).unfold()`) — a list-substrate tail add |
| **chained projections** (`values().count()`, `valueMap().select()`) | ❌ | `only one projection step is supported per traversal` — element→scalar→scalar re-type; partly dissolved by §9, still open for this shape |
| `order()` [`.by(key[,dir])`] | 🟡 | ✅ tail modifier<br>❌ `order()` after `path()`<br>❌ `order().by(key)` on a scalar stream |
| `limit`, `range`, `skip` | ✅ | ✅ CTE mid-chain, tail-modifier after `order()` |
| `by(…)` modulator | ✅ | ✅ only as an `order`/`select`/`project`/`group`/`groupCount`/`path`/`math` modulator |

## 4. Aggregation & barriers

| Step | Status | Notes |
|---|:--:|---|
| `group`, `groupCount` | 🟡 | ✅ scalar reducers → SQL `GROUP BY`<br>✅ element values → ordered-stream + handler fold<br>❌ >2 `by()` modulators<br>❌ `by(T.x)` key<br>❌ deep nested-`by()` chains |
| `fold()` | ✅ | ✅ terminal reducer **and** a real JSONB list value when followed (§9) |
| `sum`, `min`, `max`, `mean` | ✅ | ✅ Long/Double framing<br>✅ also as `Scope.local` list reducers (§9) |
| `group('a')`/`groupCount('a')` (side-effecting) | 🟡 | pass-through barrier: stashes the group-spec, `cap('a')` re-emits it (§12). ❌ after `as()`/`path()`, `cap('a')` then more steps |

## 5. Per-traverser branching

| Step | Status | Notes |
|---|:--:|---|
| `choose(pred, then[, else])` | 🟡 | ✅ gated-seed dispatch<br>❌ scalar/projection arm bodies<br>❌ mixed-shape arms<br>❌ after `as()`<br>❌ path tracking through |
| `choose(fn).option(k, body)…` | 🟡 | ✅ scalar-CASE option-map<br>❌ without a `Pick.none` default<br>❌ element/discard/identity/fail bodies<br>❌ `Pick.unproductive`/`any`<br>❌ any trailing step |
| `coalesce(…)` | 🟡 | ✅ first-non-empty via the `St.origin` ordinal<br>❌ scalar branches<br>❌ mixed-shape<br>❌ after `as()`<br>❌ nested in coalesce/optional<br>❌ path tracking |
| `union(…)` | 🟡 | ✅ multi-hop arms via `foldBody`<br>❌ mixed-shape<br>❌ source-branch tails/`as()`<br>❌ path tracking |
| `optional(…)` | 🟡 | ✅ single-hop LEFT JOIN fast path + multi-hop<br>❌ element-kind change on miss<br>❌ after `as()`<br>❌ path tracking |
| `flatMap(__.…)` | 🟡 | ✅ element body fan-out<br>❌ after `as()`<br>❌ path tracking |
| `map(__.<scalar>)` | 🟡 | ✅ correlated scalar (`map(__.out().count())` etc)<br>❌ **element**-body `map` (first-result — needs `ROW_NUMBER` over `St.origin`)<br>❌ alias/select/fold bodies<br>❌ trailing steps |
| `local(…)` | ❌ | per-element scope — the hardest remaining branching piece (a future bet) |

## 6. Recursion (`repeat`)

| Step | Status | Notes |
|---|:--:|---|
| `repeat(__.<out/in/both>).times(n)` | ✅ | ✅ `WITH RECURSIVE walk`<br>✅ both = two recursive terms |
| `emit` (before/after, bare) | ✅ | ✅ runs to natural fixpoint (no depth cap) |
| `until(<pred>)`, `loops().is(n)` | 🟡 | ✅ do-while/while-do<br>❌ `until(__.loops()…)` beyond `loops().is(P)` |
| `repeat().path()`, `simplePath()` in body | ✅ | ✅ JSONB array walk + `json_each` cycle guard |
| `emit(pred)`, `times(pred)` | ❌ | predicate forms |
| `until` + `times`, `until` + `emit` | ❌ | combined exit conditions |
| complex/filtered/multi-hop repeat bodies | ❌ | `repeat(__.out().has(k,v))`, `repeat(__.out().out())` — extend the recursive term (a seam-reuse item) |
| `repeat()` on edges, after `as()` | ❌ | |
| `path().by()` on the recursive walk | ❌ | |

## 7. Path family

| Step | Status | Notes |
|---|:--:|---|
| `path()`, `path().by(key)` | 🟡 | ✅ linear label-carry + handler assembly<br>❌ `path().by(traversal)`/`by(T.x)`<br>❌ spanning >1 movement/repeat<br>❌ over a `union()` source |
| `simplePath()`, `cyclicPath()` | ✅ | ✅ all-pairs identity (linear) / `json_each` guard (in repeat body) |
| steps after `path()` | ❌ | `order`/reducer/`is`/transform/`inject` after `path()` |
| `tree()` | 🚫 | JS GLV cucumber ignores all 13 tree scenarios + stubs `DataType.TREE` → 0 conformance. Build only if a non-JS consumer appears |

## 8. Pattern matching

| Step | Status | Notes |
|---|:--:|---|
| `match(p1, p2, …)` | 🟡 | ✅ conjunctive pattern join on the alias seam<br>✅ `as(start).<out/in>*[.has].as(end)` patterns, dependency-ordered<br>❌ `both()`/edge/scalar-terminal patterns<br>❌ `or`/`not`/nested-match<br>❌ `>1`/`0` root vars<br>❌ match-inside-where<br>❌ select-then-movement<br>❌ path tracking |

## 9. Lists & collections

| Step | Status | Notes |
|---|:--:|---|
| `fold()` as a re-usable list value | ✅ | ✅ JSONB list<br>✅ re-enters the tail |
| `unfold()` | 🟡 | ✅ `json_each` explode → elements or scalar stream<br>❌ after a projection/modifier on an element stream<br>❌ Map-unfold |
| `inject([…])` as a list | ✅ | ✅ each bracket arg = one list value |
| `Scope.local` reducers (count/sum/min/max/mean) | ✅ | ✅ per-list correlated aggregate<br>✅ also degenerate scalar-local |
| `none(P)` collection filter | ✅ | ✅ keep lists where no element matches |
| `Scope.local` order/limit/range/tail/dedup on a list | ❌ | their scenarios chain `reverse()`/`skip(local)` — a list-substrate tail add |
| **set-ops** (`combine`/`intersect`/`conjoin`/`disjunct`/`product`/`difference`) | ❌ | ~64 scenarios; small adds now that fold-as-value exists |
| scalar-stream `none(P)` barrier | ❌ | whole-stream barrier (distinct from the per-list filter); fails closed |

## 10. Types, math & dates

| Step | Status | Notes |
|---|:--:|---|
| `asBool`, `asNumber(GType.X)`, bare `asNumber()` | ✅ | ✅ typed-value carrier (compile-time subtype tag → GraphBinary framing) |
| string transforms (`concat`/`length`/`toUpper`/`toLower`/`asString`/`substring`/`replace`) | ✅ | ✅ SQL scalar, text-in text-out |
| `math("<formula>")` | 🟡 | ✅ full exp4j operator/function set → one SQL scalar, always Double<br>❌ a var with no `by()`<br>❌ `withSideEffect` vars<br>❌ reading `project()`/`select()` map columns |
| `asDate`, `dateAdd`, `dateDiff`, `datetime()`/`DateTime()` literals | 🟡 | ✅ epoch-millis rep + `'date'` tag (UTC-only, ms precision — parity with the JS reference client)<br>❌ `typeOf(GType.DATETIME)` over stored props<br>❌ `inject([…]).asDate()` |
| `asNumber` + reducer (`fold`/`sum`) | ❌ | subtype tag can't survive `wrapReducer` yet |
| bigdecimal | ❌ | no client GraphBinary serializer |
| `format()` | ❌ | template substitution — net-new (small, its own piece) |

## 11. Writes

| Step | Status | Notes |
|---|:--:|---|
| `addV()`, `.property(k,v)`, `property(T.id/T.label)` | ✅ | ✅ user-supplied ids (string→uid, int→rowid) |
| `addE()`, `from`/`to` | 🟡 | ✅ `as()` alias or nested `__.V(…)`<br>✅ edge uid via `property(T.id)`<br>✅ multi-addE graph initializers<br>❌ nested-traversal `addE` label<br>❌ endpoint traversal past a movement<br>❌ `addE` after some prefixes |
| `mergeV`, `mergeE` | 🟡 | ✅ id-aware upsert, onCreate/onMatch, start + mid-chain<br>❌ nested-traversal merge maps (`mergeV(__.select…)`)<br>❌ `option(…, __.traversal)`<br>❌ bare `mergeV()`/`mergeE()` (incoming-as-map) |
| `property()` update | ✅ | ✅ vertex: normalized rows, single/list/set + meta (W4); edge: JSON-merge blob |
| `drop()` (vertices + edges) | 🟡 | ✅ vertex `drop()`<br>❌ edge `drop()`<br>❌ `drop()` after some steps |
| `property(Cardinality.list/set, …)` (multi-property) | ✅ | list appends, set dedups by value (W4 normalized table) |

## 12. Side-effect state (🟡 — the registry + carried-column substrate landed)

Design + decision log: `docs/2026-07-13-side-effect-state-plan.md`. Two mechanisms, one
home (`Carry`): a **named side-effect registry** (aggregate/cap/group('a')) and a
**carried per-traverser column** (sack) — both stay one SQL statement (no interpreter).

| Step | Status | Notes |
|---|:--:|---|
| `aggregate('x')` | 🟡 | ✅ pass-through barrier → a JSONB-list side-effect CTE; `aggregate('x').by(key)` scalar bag (by-miss drops)<br>❌ on a scalar stream (`values(k).aggregate(x)`), `by(<nested/token>)`, `local(aggregate(...))` |
| `store('x')` | 🚫 | dropped in TinkerPop 4 (no grammar rule); `aggregate(Scope.local)` replaces it |
| `cap('x')` | 🟡 | ✅ a list side-effect UNROLLS to individual results (no BulkSet wire type); a group side-effect re-emits one Map<br>❌ multi-key `cap('x','y')`, `cap('x')` then more steps (except a list-cap's tail) |
| `sack()` / `withSack(…)` | 🟡 | ✅ carried column: `sack(Operator.x).by(key/T.label/nested)` mutate, bare `sack()` read, `withSack(init)` seed, trailing reducer<br>❌ inject-const numeric promotion (NumberHelper byte→short bump), `repeat()`/`barrier`/`local`, split/merge-on-fork, `sack(BiFunction)` |
| `group('a')` / `groupCount('a')` (side-effecting) | 🟡 | ✅ pass-through barrier → stashed group-spec, `cap('a')` re-runs `compileGroup`<br>❌ nested value-`by()` with movement+order, `by(__.select…)`, after `as()`/`path()` (inherits `compileGroup`'s §4 limits) |
| `within('x')` / `without('x')` readback | ❌ | mid-chain read of a side-effect (the aggregate-dedup idiom) — where eager/lazy diverge; fails closed |

Landed L3 618→634 (sack +4, aggregate/cap +8, group('a')/cap +4). Still gates
`ProductiveByStrategy` (needs `local()` too) and the `group('a')…cap('a').select(Column.values).unfold()`
cluster (needs `select(Column.values)`, §9).

## 13. Traversal strategies

| Strategy | Status | Notes |
|---|:--:|---|
| 15 optimization strategies | ✅ | ✅ accepted as **no-ops** (result-preserving by TinkerPop's contract; our SQL does its own planning) |
| `withoutStrategies(…)` | ✅ | ✅ safe no-op (we apply no default) |
| **SubgraphStrategy** (vertex criterion) | 🟡 | ✅ `where`/`has` injection pass<br>❌ edge/vertexProperty criteria<br>❌ adjacency (`out()` expansion) |
| **PartitionStrategy** (read-filter + write-stamp) | 🟡 | ✅ `has(within)` + property stamp<br>❌ `includeMetaProperties`<br>❌ partition-aware merge |
| ReadOnly / EdgeLabel / ReservedKeys **verification** | ✅ | ✅ throw TinkerPop's canonical messages |
| ProductiveByStrategy | ❌ | `aggregate`/`cap` now exist (§12), but its scenarios also need `local()` |
| `with(…)` (OptionsStrategy sugar) | ❌ | `step not implemented: with()` |
| OLAP / GraphComputer / Seed / Event strategies | 🚫 | out of scope |

## 14. Element / property model

| Feature | Status | Notes |
|---|:--:|---|
| Integer rowid ids | ✅ | |
| **User-supplied ids** (string `uid`) | 🟡 | ✅ resolved at `V('x')` seed + framing-out<br>❌ scalar id via `by(__.outV().id())`/`group().by(__.id())`<br>❌ edge's own uid via `addE` in some paths<br>❌ `properties().element().id()` |
| **Multi-properties** (list/set cardinality) | ✅ | normalized `vertex_properties` table; `values()` flatMaps, `has()` ANY-matches, `valueMap` `{k:[…]}` (W4) |
| **Meta-properties** (properties-on-properties) | ✅ | JSONB `meta` per VP row; write `property(k,v,mk,mv)`, read `properties().has(mk)`/`.properties()`/`valueMap` (W4) |
| Property types: primitives + list/map | ✅ | ✅ JSON text storage (JSONB migration is a measured opportunity, not done) |

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

1. ~~**Side-effect state** (§12)~~ — **substrate LANDED** (618→634): the registry
   (aggregate/cap/group('a')) + carried column (sack). Remaining tails: `within/without`
   readback, sack numeric-promotion, the `group('a')…select(Column.values)` cluster.
2. **Multi/meta-properties (W4)** (§11, §14) — the committed target-profile schema rework;
   biggest storage blast radius, best done before more read features assume flat props.
3. **`local`** (§5) — per-element scope; the hardest remaining branching piece (also
   unblocks `local(aggregate(...))` + ProductiveByStrategy).
4. **Chained projections** (§3) — element→scalar→scalar re-type; partly dissolved by the
   list substrate, still open for this shape (~40).
5. **Collection-algebra tail** (§9) — set-ops / Map-unfold / `select(Column.values)` /
   rest of Scope.local; small adds on the list substrate (also unblocks the group('a')
   select(Column.values) cap cluster).

Full analysis: `docs/2026-07-12-conformance-structural-bets.md` (the "remaining frontier").
