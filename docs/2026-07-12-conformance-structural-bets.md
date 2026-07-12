# Conformance structural bets — where the big unlocks are

Synthesis (2026-07-12) after taking live L3 conformance 204 → 445 by grinding the
clean, incremental wins. Everything cheap is now done; what remains clusters into a
few **structural areas** we sidestepped precisely because each is a bigger change.
This doc groups them, sizes them, and weighs them by *what mogwai's actual users
would use* — not raw scenario count. It is a map for choosing the next big
investment, not a loop backlog.

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
**Real-world: VERY HIGH.** "How is A connected to B", provenance, "show the route"
— this is a *primary* reason people reach for a graph DB at all, and it's a glaring
hole. `simplePath`/`cyclicPath` also make `repeat()` genuinely useful (cycle
avoidance in unbounded walks).
**Structural: self-contained, medium-large.** Thread a JSON path-array column
through the movement/filter fold — every `advance()` appends the current id; `path()`
frames the array, `path().by(k)` projects each element, `simplePath` adds a
`NOT array-contains` guard in the recursive walk. Doesn't touch the other areas.
**Why first:** highest user value, cleanest boundary, and it upgrades the `repeat`
work already done. Best ratio of the lot.
**Prior-art scan (2026-07-12): `2026-07-12-path-tracking-prior-art.md`.** Sqlg
(local, `~/Projects/sqlg`) already solved Gremlin-path-in-SQL and splits it two
ways — revise the "thread a path column through the fold" plan above: only the
recursive-`repeat` regime accumulates a SQL path (JSON1 `json_insert`/`json_each`
in the one `branch.ts` CTE); linear `path()`/`tree()` force-label every element
and assemble in `handler.ts` (reuse the `as()` column-carry rails), never a path
column through movement. Governed by the `PATH` vs `LABELED_PATH` requirement
split; path presence kills bulking (walk-cardinality). Don't build a CSR operator.

### 2. Per-traverser sub-traversal engine — `local` / `map` / `choose` / `flatMap` / complex `where`  (~90–100)
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

### 5. `match()`  (~35)
**Real-world: MEDIUM-LOW.** Powerful declarative pattern matching, but many users
write explicit traversals instead.
**Structural: medium, mostly a rewrite.** TinkerPop itself lowers `match` onto
`where`/`select`/`and` — so this largely rides on the per-traverser engine (#2) plus
alias threading (done). Do it *after* #2.

### 6. Collection algebra — `unfold` + `combine`/`product`/`intersect`/`difference`/`disjunct`/`conjoin`, `Scope.local` reductions  (~100+)
**Real-world: LOW-MEDIUM for OLTP.** List set-ops and local reductions are more
analytical than the point/'k-hop' queries mogwai targets. High raw count, low
priority.
**Structural: medium.** Make a **list/collection** a first-class traverser value
(fold produces it; unfold expands it; set-ops and `Scope.local` min/max/tail operate
on it). Also finally makes `Scope.local` correct everywhere. Worth it for
completeness, not for the target users.

### 7. Traversal strategies — `withStrategies(PartitionStrategy/SubgraphStrategy)` (+ `withoutStrategies`)  (~86)
**Real-world: LOW-MEDIUM for us.** `PartitionStrategy` = multi-tenancy *within one
graph* — but mogwai already isolates tenants as **one Durable Object per graph**, so
the main use case is covered structurally elsewhere. `SubgraphStrategy` (filtered
views) is the more interesting bit.
**Structural: medium, invasive.** Must apply the strategy's implied filter to every
read *and* write. `withoutStrategies` is **coupled** — once strategies apply, it must
actively suppress them (today both fail closed on purpose; see
`correct-by-design`). Also the raw count overstates the unlock: the strategy is just
the *first* rejection, so the net gain is only scenarios whose rest is already
supported. Lowest priority.

## Recommended sequence

1. **Path** (#1) — highest value, clean, self-contained, upgrades `repeat`.
2. **Per-traverser sub-traversal engine** (#2) — the big substrate; unlocks
   `choose`/`local`/`map` and feeds `match` + `where` + `repeat` bodies.
3. **Side-effect state** (#3) — `aggregate`/`cap`/`sack`.
4. Then opportunistically: **types** (#4), **match** (#5, rides on #2), and
   **collection algebra** (#6) for completeness.
5. **Strategies** (#7) only when in-graph partitioning is an actual ask — the
   DO-per-tenant model already covers isolation.

The throughline: **grow the SQL compiler (correlated/lateral/recursive), don't add
an interpreter.** Every bet above has a SQL-native shape; that's what keeps mogwai's
core promise (index-only, in-process, correct-by-design) intact as coverage grows.
