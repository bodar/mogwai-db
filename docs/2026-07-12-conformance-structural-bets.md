# Conformance structural bets — where the big unlocks are

Synthesis (2026-07-12) after taking live L3 conformance 204 → 445 by grinding the
clean, incremental wins. Everything cheap is now done; what remains clusters into a
few **structural areas** we sidestepped precisely because each is a bigger change.
This doc groups them, sizes them, and weighs them by *what mogwai's actual users
would use* — not raw scenario count. It is a map for choosing the next big
investment, not a loop backlog.

> **Status (2026-07-14).** Bets #1 (path), #2 (per-traverser branching +
> `local`), #3 (side-effect state — `aggregate`/`cap`/`sack`/`group('a')`), #4 (types +
> dates + `math`), #5 (match), #6 (the full collection-algebra tail — list substrate,
> MapStream, string transforms, set-ops/list-algebra, `format`), and #7 (semantic
> strategies) have ALL landed since this was written. The remaining frontier is now
> design-heavy: **traverser bulking** (blocks the grateful graph), path-rooted collection
> ops, broader `select`/`match`/`repeat`, and mixed-type comparability — see
> [feature-support-matrix.md](feature-support-matrix.md) "Where this points".

Counts are approximate scenario totals in the relevant feature files (some we
already partially pass). "Real-world" is judged for mogwai's target: many small
**OLTP** graphs — agent memory, per-tenant/per-user knowledge graphs, personal
projects. Not analytics-at-scale (that's explicitly out of scope: OLAP/lambdas/
multi-request-tx, see `2026-07-11-phased-roadmap-plan.md`).

## The one architectural observation

Our engine compiles the **whole** traversal to **one SQL statement**, set-at-a-time
(locked decision #3 — never row-at-a-time interpret). That model is a perfect fit
for movement / filter / projection / aggregation, and it's why those are done.

The features we've structurally avoided are the ones that **don't** fit
one-flat-query, in three shapes:

1. **Per-traverser sub-traversal** — run an arbitrary child traversal *for each*
   current traverser and fold its result back (`local`, `map`, `choose`,
   `flatMap`, complex `where`, non-trivial `repeat` bodies, `match`).
2. **Accumulated history** — carry the *path* of where each traverser has been
   (`path`, `simplePath`, `cyclicPath`, `tree`).
3. **Accumulated side-effect state** — named collections that persist across the
   traversal and are read back later (`aggregate`/`store`/`cap`, `sack`,
   `group('a')`).

The important point: **all three can stay true to "compile to SQL, never
interpret."** The tools are correlated subqueries, `LATERAL` joins, recursive CTEs
carrying an array column, `CASE`/`UNION`, and window functions. We already have the
seed of #1 in `compileNestedScalar` (correlated *scalar* subqueries for `by()`/
`where()`); the bets below are mostly "grow that engine," not "add an interpreter."

## The bets, ranked by (real-world value × unlock)

### 1. Path tracking — `path` / `simplePath` / `cyclicPath` / `tree`  (~48)
**✅ MOSTLY DONE (2026-07-12/13).** `path`/`simplePath`/`cyclicPath` + `path().by()`,
recursive `repeat().path()`, `simplePath()` in a repeat body, and `repeat().until()`
all landed. `tree()` intentionally skipped (0 L3 — the JS GLV stubs `DataType.TREE`).
Still open: `path().by()` on the recursive walk, `from`/`to` subpath, labels-on-path.
**The approach below was the original sketch and was OVERTURNED** — see the
prior-art scan note at the end of this bet for what actually shipped.
**Real-world: VERY HIGH.** "How is A connected to B", provenance, "show the route"
— this is a *primary* reason people reach for a graph DB at all, and it's a glaring
hole. `simplePath`/`cyclicPath` also make `repeat()` genuinely useful (cycle
avoidance in unbounded walks).
**Structural: self-contained, medium-large.** *(Original sketch, superseded:)* Thread a
JSON path-array column through the movement/filter fold — every `advance()` appends the
current id; `path()` frames the array, `path().by(k)` projects each element, `simplePath`
adds a `NOT array-contains` guard in the recursive walk. Doesn't touch the other areas.
**Why first:** highest user value, cleanest boundary, and it upgrades the `repeat`
work already done. Best ratio of the lot.
**Prior-art scan (2026-07-12): `2026-07-12-path-tracking-prior-art.md`.** Sqlg
(local, `~/Projects/sqlg`) already solved Gremlin-path-in-SQL and splits it two
ways — revise the "thread a path column through the fold" plan above: only the
recursive-`repeat` regime accumulates a SQL path (JSONB `jsonb_insert`/`json_each`
in the one `branch.ts` CTE — JSONB available: DO SQLite 3.47.0, Bun 3.53.0); linear
`path()`/`tree()` force-label every element
and assemble in `handler.ts` (reuse the `as()` column-carry rails), never a path
column through movement. Governed by the `PATH` vs `LABELED_PATH` requirement
split; path presence kills bulking (walk-cardinality). Don't build a CSR operator.

### 2. Per-traverser sub-traversal engine — `local` / `map` / `choose` / `flatMap` / complex `where`  (~90–100)
**✅ LARGELY DONE (2026-07-13, live L3 455 → 473).** See
`docs/archive/2026-07-13-per-traverser-branching.md`. Landed: `choose` (predicate + option-map
scalar CASE), `coalesce`, multi-hop `union`/`optional`, `flatMap`, scalar `map`,
multi-hop `where` (correlated EXISTS chain) + `where(label/not)`, and the
alias-threading foundation (`aliasCtx`/`resolveAlias`). The engine split into **two
correlation regimes**: inline correlated subquery (where/by/scalar-map/option-choose)
vs seeded shared-`WITH` relation (`foldBody` — element branch arms). Still open on this
bet: `local` (per-element scope — hardest), element-body `map` (first-result), scalar
branch bodies, alias-in-predicate beyond re-root, and **`match`** (the next deliberate
batch — builds directly on `aliasCtx`/`resolveAlias`).
**Real-world: HIGH.** `choose` (if/then/else) is everyday branching logic;
`local` ("for each vertex, its top-3 …") and `map` (per-element transform) are
common idioms. This is the **biggest single area we structurally ignored.**
**Structural: large, foundational.** Generalise `compileNestedScalar` from "one
scalar per row" to "a full sub-relation per row" via `LATERAL`/correlated
subqueries: `choose(pred, a, b)` → `CASE`/`UNION ALL` of branch selects gated by the
predicate; `local(t)` → apply `t` per current row with a lateral join;
`map(t)` → 1:1 lateral. Once this engine exists it also unblocks pieces of
`where`, `match`, and richer `repeat` bodies — it's the highest-leverage substrate.
**Why second:** unlocks the most downstream, but wants the path/CTE plumbing and a
clear design pass first.

### 3. Side-effect state — `aggregate`/`store` + `cap`, `group('a')`, `sack`  (~100)
**Real-world: MEDIUM-HIGH.** Collecting results across a traversal
(`…aggregate('x')…cap('x')`) and running accumulators (`sack`) show up in real
reporting/rollup queries, though less than path/choose.
**Structural: medium-large, a new concept.** Named side-effect collections that
outlive the current step and are materialised on `cap`. Fits SQL as
extra CTEs/temp relations captured by name and joined at `cap`, but it's a genuinely
new execution notion (state that isn't the current id-relation). `group('a')` is a
small extension of existing `group`.

### 4. Type system — `asNumber` / `asBool` / `asDate` / `math` / `format`  (~72)
**Real-world: MEDIUM.** Data hygiene and computed values. Useful, not load-bearing.
**Structural: medium.** The blocker is we don't track numeric **subtypes**
(byte/short/int/long/float/double) or bool/date through the value pipeline — JSON
storage flattens them, and GraphBinary framing needs the exact type (`d[5].b` vs
`.i` vs `.l`). Needs a small typed-value carrier + framing rules. `math()` also needs
a tiny expression parser. Mechanical once the type carrier exists.
**✅ CARRIER + `asBool` LANDED (2026-07-13, L3 496→508).** The typed-value carrier is
in: `Shape`'s value variant carries an optional **compile-time** type tag
(`{kind:'value', as?: ValueType}`, `render.ts`) and the handler's `frameValue`
(`handler.ts`) frames `v` with the matching GraphBinary serializer. Key insight that
makes it correct-by-design: **the output subtype is compile-time metadata** (from the
typed literal or the cast's target arg), NOT the SQLite storage class — so no storage
change, just a tag + framing rule. `asBool` is the first cast: it resolves inject
constants at compile time (`asBoolConst`, since its per-value parse errors can't be
raised from SQL and reachable inputs are all literals) and tags `as:'bool'`. **✅ `asNumber(GType.X)` LANDED (2026-07-13, L3 508→525).** The numeric subtype ladder
(byte/short/int/long/bigint/float/double) is in `ValueType` + `frameValue`. Target comes
from the **explicit GType arg** (`numericSpec`), so no frontend work: `inject(const)`
resolves at compile time with overflow/parse errors (`asNumberConst`); a runtime value
(`values(x)`) gets a SQL `CAST` + the tag (`asNumberSql`). `typeOf` stayed as-is — the
storage-class check suffices because `asNumber(GType.X).is(typeOf(X))` streams are
uniformly one type (no precision change needed, verified). **Deferred: bare `asNumber()`**
— the frontend flattens numeric-literal suffixes (`5b`/`5l`/`5.0` → plain `5` in
`frontend.ts:78-79`), so the input subtype is unrecoverable without a parser change
(preserve the suffix as a typed token). asNumber+reducer defers (tag can't survive
`wrapReducer`). bigdecimal defers (no client serializer). **✅ bare `asNumber()` LANDED (2026-07-13, L3 525→534).** The frontend now records each
numeric literal's declared subtype (grammar context + suffix) in a parallel
`Step.argTypes` array — `args` stays plain numbers, so no consumer ripple (has/limit/V/
property/binds untouched); only bare asNumber() reads `argTypes` to recover the input
subtype (`asNumberBare`, uniform-subtype required).

#### `math()` — ✅ LANDED (2026-07-13, L3 583→589)
Pure formula parser `src/math.ts` (tokenizer + recursive-descent, full exp4j operator +
function set) → ONE SQL scalar; `compileMath` in `steps/projection.ts` resolves `_`
(current, `elemCtx`) and `as()`-alias variables (`aliasCtx`) through their `by()`
modulators (`compileNestedScalar`), always Double, routed through the shared
`renderProjection` tail (composes with trailing `asNumber`/`is`/`order`/`limit`).
Leaf-REAL coercion makes `/` real division; `^`→POW, `%`→MOD, `log`→LN. `'math'` added to
BY_HOSTS. Deferred: no-by() bare-incoming, `withSideEffect` vars, project/select map-column
reads. See CLAUDE.md "`math()` — LANDED". Original scoping notes retained below.

#### `math()` — SCOPED + DE-RISKED (2026-07-13, historical scoping)
Explored before building. **Size corrected: ~22 scenarios that actually call `.math()`**
(Math.feature=11 + scattered in data/asNumber/Select; PageRank=3 is OLAP-excluded), **NOT
194** — that earlier number wrongly counted whole files × all their scenarios. Realistic
reachable **~10–15** (some gated on `by()`/`select` var-threading or `asDate`). Real-world
**MEDIUM** (computed/derived values, scoring; not core to point/k-hop OLTP).

**Fully SQL-mappable — the appeal.** `math('<formula>')` is a scalar expression: `_` =
current value, named vars (`a`,`b`) = `as()`/`by()` values. Maps straight onto SQLite
arithmetic + math functions (no per-row JS — honours locked #3). `math('ceil(_ * 100)')`
→ `CEIL(v * 100.0)`.
- **DO math functions VERIFIED present** (2026-07-13, probed real workerd SQLite 3.47 via
  `wrangler dev`): `ceil/floor/abs/sqrt/sin/cos/pow/exp/ln` all work; `round`, `%`, `/`
  too. This was the only real risk — cleared. (Bun 3.53 also has them.)
- **Three semantic fixups** (found while probing): SQLite `/` is INTEGER division
  (`7/2=3`) but TinkerPop math is floating → coerce operands to REAL (`7.0/2`); SQLite
  `log()` is log10 → TinkerPop `log` is natural → map to `ln()`; no `^` operator → `pow()`.
- **Sqlg has NO math support** (does traversal-joins, punts on scalar expr) — we'd lead,
  as with coalesce/map.

**Effort MEDIUM — the work is a small formula parser**, not the SQL. Tokenize +
precedence for `_ * 2` / `a + b` / `ceil(_ * 100)` / `sin _` (function-by-juxtaposition!)
/ `0-_` / `_+_` → a SQL expression with variable substitution; wire variable resolution
into the existing `by()`/`select` column threading (P2a). Tested operator surface is tiny
(`+ - * /`, funcs `ceil`,`sin`) — implement TinkerPop's full function set (~19 trig/log/
rounding, all in SQLite) for robustness. Lands on the value-tail carrier; `math` is a
scalar transform like `asNumber`, tagged (result of a float expr is Double). **Follow-up:
a small CF contract test** (one math query through `wrangler dev`) once it lands, to lock
Bun/DO parity permanently (cheaper than full L3-on-CF; see below).

**✅ `asDate`/`dateAdd`/`dateDiff` + `datetime()` literals LANDED (2026-07-13, L3 589→608).**
Internal rep = epoch-millis INTEGER + a `'date'` ValueType tag (frames via the client's
DateTimeSerializer, GraphBinary DATETIME 0x04). Fixed-width sec/min/hour/day → date arithmetic
is pure integer (no SQL date fns for literals; runtime ISO-string asDate() uses `unixepoch()`).
Const-fold in compileInject + runtime SQL in renderProjection, sibling to asBool/asNumber. See
CLAUDE.md "asDate/dateAdd/dateDiff … LANDED". **Deferred (structural wall):** `typeOf(GType.
DATETIME)` over a STORED property (DateTime.feature) — same SQLite-storage-class wall as
bool/uuid typeOf; needs a storage type-tag scheme.

**Deferred type-family tail** (opportunistic, not the frontier — the list substrate
landed next instead): asNumber+reducer (fold/sum — thread the subtype tag through
`wrapReducer`), bigdecimal (no client serializer), the JS-GLV upstream give-back
(TINKERPOP-3044/3043 — client-side, our server unaffected).

**Aside — running L3 against deployed CF (workerd), feasible, medium effort:** the L3 host
(`conformance-server.ts`) is a Bun server fronting named graphs by the request `g` field;
to run the full suite on workerd needs (1) a ~10-line conformance-only worker entry that
routes by `g` to named DOs (dev-only shim), (2) per-DO seeding of `gmodern`, (3) pointing
the GLV runner (hardcoded `:45940`) at `wrangler dev`. Value: exercises the REAL DO SQLite
against all scenarios (catches Bun/DO divergences — bind types, fn availability). Cost:
slow (wrangler boot + cucumber) → a periodic high-fidelity gate, not every-CI. For
de-risking ONE runtime-specific feature, a targeted probe (as done for math) beats it.

### 5. `match()`  (~35)
**✅ DONE (2026-07-13, Phase H — `src/steps/match.ts`, L3 473→474).** A conjunctive
pattern join built directly on #2's alias-threading foundation (`aliasCtx`/
`resolveAlias`): each `as(start).<out/in>*[.has].as(end)` pattern folds in dependency
order, binding or constraining vars as alias columns; downstream select/count/dedup
consume them through the existing rails. See `docs/archive/2026-07-13-per-traverser-branching.md`
Phase H. **Deferred, fail-closed:** `both()`/edge/scalar-terminal patterns, `or`/`not`/
nested-`match`, `>1`/`0` root vars, `match`-inside-`where`, select-then-movement.
**Real-world: MEDIUM-LOW.** Powerful declarative pattern matching, but many users
write explicit traversals instead — which is why the deferred tail is low-priority.

### 6. Collection algebra — `unfold` + `combine`/`product`/`intersect`/`difference`/`disjunct`/`conjoin`, `Scope.local` reductions  (~100+)
**✅ SUBSTRATE DONE (2026-07-13, L3 608→618).** The core bet — "make a list a
first-class traverser value" — landed as the list-value substrate + re-enterable tail
(`docs/archive/2026-07-13-list-value-substrate-plan.md`, Approach A): `fold()` as a real JSONB
list value, `unfold()` re-entering the tail, `Scope.local` reducers (count/sum/min/max/
mean), inject-as-list, and the scalar-local semantics — all SQL-native (`json_each`/
JSONB), no interpreter. This also structurally dissolved the "only one projection per
traversal" ceiling.
**Still open (small adds on the substrate):** the set-ops themselves (`combine`/
`intersect`/`product`/…), Map-unfold, `select(Column.values/keys)`, and the rest of
Scope.local on lists (`order/limit/range/tail/dedup(Scope.local)`).
**Real-world: LOW-MEDIUM for OLTP.** List set-ops and local reductions are more
analytical than the point/'k-hop' queries mogwai targets — the substrate was worth
building (it dissolved several walls at once); the remaining set-op tail is opportunistic.

### 7. Traversal strategies — `withStrategies(PartitionStrategy/SubgraphStrategy)` (+ `withoutStrategies`)  (~86)
**Partial win landed 2026-07-13 (L3 473→495).** `compiler.ts` now splits strategies:
result-preserving **optimization** strategies (Count/IdentityRemoval/FilterRanking/
LazyBarrier/EarlyLimit/OrderLimit/Adjacent↔Incident/InlineFilter/PathRetraction/
PathProcessor/ByModulatorOptimization/RepeatUnroll/Match{Algorithm,Predicate}) are
accepted as **no-ops** — by TinkerPop's contract they can't change the result set
(the suite proves it: each strategy's `withStrategies(X)`/`withoutStrategies(X)`
scenarios expect identical rows), and our SQL does its own planning, so not applying
them is exactly correct (correct-by-design, not a test-chase). Semantic strategies
(Subgraph/Partition/ProductiveBy/Connective/Options/verification/OLAP) and any mixed
or unknown list still fail closed. Also added `identity()` as a no-op step. What
remains below is the *semantic* strategy work.

**SEMANTIC SUPPORT LANDED 2026-07-13 (L3 495→543).** SubgraphStrategy (vertex
criterion), PartitionStrategy (read-filter + write-stamp), and ReadOnly/EdgeLabel/
ReservedKeys verification now compile as `applyStrategies` injection passes
(`src/strategies.ts`). Deferred tails (Subgraph edges/adjacency, Partition meta/merge,
ProductiveBy, nested bodies) fail closed. See
`docs/2026-07-13-with-strategies-exploration.md`.

**Real-world: the "DO covers it" framing below was a category error — corrected.**
`PartitionStrategy` = sub-partitioning *within one graph* (cross-partition reads,
overlapping visibility); the DO is the *tenant* boundary. They're complementary levels,
not substitutes — a tenant may still want to sub-partition inside its DO. (Original,
now-superseded reasoning:) `PartitionStrategy` was thought covered because mogwai
isolates tenants as one Durable Object per graph. `SubgraphStrategy` (filtered views)
is the other semantic piece — also landed.
**Structural: medium, invasive.** Must apply the strategy's implied filter to every
read *and* write. `withoutStrategies` is **coupled** — once strategies apply, it must
actively suppress them (today both fail closed on purpose; see
`correct-by-design`). Also the raw count overstates the unlock: the strategy is just
the *first* rejection, so the net gain is only scenarios whose rest is already
supported. Lowest priority.

## Recommended sequence

**Status refresh (2026-07-14).** Every item in this sequence has landed
(side-effect state, `local`, the whole collection-algebra tail incl. set-ops/`format`).
The real remaining frontier is now traverser bulking + the design-heavy subsystems — see
[feature-support-matrix.md](feature-support-matrix.md) "Where this points".

1. ~~**Path** (#1)~~ — **DONE (2026-07-12/13)**, see bet #1 above.
2. ~~**Per-traverser sub-traversal engine** (#2)~~ — **LARGELY DONE (2026-07-13, L3
   455→473)**, see bet #2 above + `docs/archive/2026-07-13-per-traverser-branching.md`. `local`
   (per-element scope) is the one structural piece of #2 still open.
3. ~~**`match`** (#5)~~ — **DONE (2026-07-13, Phase H, L3 473→474)**, see bet #5 above.
4. ~~**types** (#4) + **collection-algebra substrate** (#6 core)~~ — **DONE**: the
   typed-value carrier + asBool/asNumber/asDate/math (L3 496→608), and the list-value
   substrate + re-enterable tail + Scope.local reducers + unfold (L3 608→618, see
   `docs/archive/2026-07-13-list-value-substrate-plan.md`).
5. **Strategies** (#7) — **semantic support DONE** (Subgraph/Partition/verification,
   L3 495→582). Deferred tails only.

### The remaining frontier (what is actually still open, 2026-07-13)

- **Side-effect state (#3)** — `aggregate`/`store`/`cap`, `sack`, `group('a')`. The one
  genuinely NEW execution notion left (named collections that outlive the current
  id-relation). ~63 scenarios. **The next big structural bet** — see the standalone
  analysis being written.
- **`local` (rest of #2)** — per-element scope; the hardest remaining branching piece.
- **Chained projections** (`values().count()`, `valueMap().select()`, ~40) — a tail
  re-type the substrate partly addressed but the element→scalar→scalar case still defers.
- **Collection-algebra tail (#6)** — set-ops (`combine`/`intersect`/…), Map-unfold,
  `select(Column.values/keys)`, the rest of Scope.local on lists. Small adds now that
  the list substrate exists.
- **Multi/meta-properties (W4)** — the deferred schema rework; unlocks its own scenario
  cluster + `Cardinality.list/set` writes.

The throughline: **grow the SQL compiler (correlated/lateral/recursive), don't add
an interpreter.** Every bet above has a SQL-native shape; that's what keeps mogwai's
core promise (index-only, in-process, correct-by-design) intact as coverage grows.
