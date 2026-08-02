# RelIR — the build plan

**Status: BUILDING, started 2026-08-01.** The analysis that argued for it is
[codebase-analytics](./2026-08-01-codebase-analytics-and-blue-sky-restructure.md) §6/§6a; this
doc is the construction, and it does not re-argue the direction. Every constraint below was measured
this session against SQLite 3.51.2, not assumed — the five probes are recorded in §1 because each one
kills or shapes a design choice, and a reader who skips them will re-derive a dead idea.

**The one-line statement of the problem.** `Query.ctes` (`sql/kernel/q.ts:153`) is a private
append-only array. Nothing reads a CTE back, rewrites one, reorders them, or fuses two. The query
never exists as data. Every optimization must therefore happen *before* lowering (the fast-path
layer) or *during* it (the `TailAcc` accumulator), and every construct SQLite will not accept in
position must be hand-built to avoid it (`expandRepeatBody`, `runWriteChainFull`). RelIR is the
missing middle: `Step[] → RelIR → SQL`, where RelIR is inspectable, rewritable relational algebra.

---

## 1. The measured envelope — five probes, each of which decides something

Do not re-derive these. Each was run directly.

**P1 — the recursive-term law.** The recursive reference must appear **exactly once, at the top level
of the recursive term's `FROM`**. Wrapping it in a derived table fails `circular reference` *even as
the sole reference*, so the rule is positional, not a count. Once it is there, a **correlated scalar
subquery may reference its alias freely**. No aggregates (`recursive aggregate queries not
supported`), no window functions (`cannot use window functions in recursive queries`).
→ *Decides: the `Recursive` node's legality predicate, and that `Flatten` is a required pass.*

**P2 — what is legal in a recursive term that we currently refuse.** `NOT EXISTS` (anti-join), a join
against a derived `UNION`, `IN (SELECT …)`, `LEFT JOIN` with the walk on the left, correlated scalar
subqueries, multi-hop join chains — **all legal**, all outside `REPEAT_BODY_OK`.
→ *Decides: `expandRepeatBody` is a hand-written join-flattener, not a platform workaround. It dies.*

**P3 — barrier semantics in a recursive term.** `DISTINCT` is legal but **inert** (SQLite feeds the
term one queue row at a time, so it never sees two frontier rows together — on a diamond it returns
`[1,2,3,4,4]`, identical to `UNION ALL`). `LIMIT` and `ORDER BY`+`LIMIT` are **global caps on the
whole CTE**, not per-iteration barriers. `UNION` dedups whole-walk on the entire row tuple, violating
the multiset rule.
→ *Decides: **no per-iteration barrier is expressible in a recursive term in any lowering.** Recorded
as a permanent wall. Do not re-propose re-lowering.*

**P4 — the corpus ratio.** Of 125 corpus traversals mentioning `repeat()`, 53 have a barrier in the
body: **48 are `times(n)`-bounded, 5 are `until()`/`emit()`**. Corpus `times(n)` is 83× `times(2)`,
16× `times(1)`, 9× `times(3)`, 8× `times(5)`, one each of 8 and 10 — **max 10**.
→ *Decides: `Unroll` is the majority route, not a bet. The permanent wall is 5 traversals.*

**P5 — the write envelope.** All legal: `WITH cte AS (…) INSERT … SELECT FROM cte RETURNING`;
multi-row `INSERT … RETURNING`; `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM
(subquery)`; `DELETE … WHERE … IN (SELECT …)`. **Not legal: the Postgres-style data-modifying CTE**
(`WITH x AS (INSERT … RETURNING) SELECT …` → syntax error).
→ *Decides: `Sequence` is a real node. A write chain is O(write steps) statements — not one, and not
O(rows) as today.*

**P5b — RETURNING and determinism.** SQLite documents RETURNING's row order as undefined. Measured:
**id assignment follows the source `SELECT`'s `ORDER BY`** (`INSERT … SELECT … ORDER BY ord DESC`
assigned id 1 to the last-ordered row), and **RETURNING can project an inserted column**, so a
correlation key carried into the insert comes back out.
→ *Decides: emission-order determinism (`04b5080`) survives set-based writes — order the source, and
re-associate by carried key, never by RETURNING position.*

**Gate before Phase 2 ships:** re-run P5/P5b under DO SQLite via `test:cf-limits`. `RETURNING` and
`ON CONFLICT` are the exact species of "passes on Bun, wall in production" that seam exists for.

---

## 2. The clean-room boundary — and the one thing that is not clean-room

Build the algebra clean-room. `src/rel/` imports **nothing** from `src/compiler/steps/` and nothing
from `src/gremlin/`. It is pure data plus total functions over it, testable with no graph, no store,
and no Gremlin. That is the whole point: the reason the current SQL layer cannot be rewritten is that
it is entangled with lowering, and reproducing that entanglement in a new layer buys nothing.

**The exception, and it is deliberate: `TraverserLayout` and its two policy tables are imported
verbatim, not redesigned.** `LAYOUT_ROLE_POLICY` and `BARRIER_ROLE_POLICY`
(`steps/context/context.ts:295-368`) are `Record<keyof TraverserLayout, …>` — type-enforced total, so
a new role fails the build until its merge policy and its barrier policy are declared — and they
encode the largest measured defect category in this repo's history (**33% of diagnosed defects: a
carried field dropped at a barrier, merge or rejoin**). A clean-room redesign of that contract would
be re-buying twelve bugs. Import the types, the tables, `mergeLayouts`, `patchLayout`, `layoutCols`,
`dropLayoutAtBarrier`, and the `assertStreamColumns` discipline. Clean-room the *algebra* around them.

**Shape does not enter RelIR at all.** RelIR sits downstream of lowering, so Gremlin shape is already
resolved and rides to the wire as `Compiled.shape`, untouched. The anchor rule — *a Pass may CONSULT
shape, never CONSTRUCT it* — is unaffected because no Pass ever sees a RelIR node. This is what makes
RelIR categorically different from the refuted typed-core-IR, and the distinction must stay true: if
a RelIR node ever acquires a `kind: 'scalar' | 'element' | …` field, the layer has failed and should
be reverted.

---

## 3. The object model — complete

Two algebras: **expressions** (scalar, produce a value per row) and **relations** (produce rows).
Plus **statements** for writes. Nothing else. Every node is an immutable plain object with a `kind`
discriminant, and every list is `readonly`.

The node set is deliberately **smaller than the SQL surface**, because SQL's redundancy collapses:
`HAVING` is `Filter` over `Aggregate`; `UNION` (distinct) is `Distinct` over `Union{all:true}`;
`SELECT DISTINCT` is `Distinct`; `NATURAL`/`USING` joins are `Join` with an explicit `on`;
`group_concat`/`json_group_array` are aggregate *functions*, not nodes. Each of those collapses is a
place the current code has a separate path.

**Construction is not object-literal syntax.** Runtime nodes remain immutable plain records, but a
module-private brand means a `Rel` can be minted only by its named, stateless kind factory:
`scan({ id, table, alias, layout, type })`, `project({ id, input, exprs, layout, type })`, and so
on. Factories take named objects rather than positional argument lists, validate their local shape,
and freeze the result; `check` validates scope and whole-plan laws. `SelfRef` has no public factory:
only `recursive` supplies it to its callback. Rewriters must rebuild through the appropriate kind
factory, never spread a node — a spread can retain an obsolete field or lose the construction brand.
There is deliberately no `src/rel/index.ts` barrel while this internal API is changing; imports name
the specific RelIR module they use.

### 3.1 Types

```ts
type RelType = { readonly cols: readonly ColMeta[] }
type ColMeta = { readonly name: string; readonly type: SqlType; readonly nullable: boolean }
type SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any'
```

`SqlType` is SQLite storage classes plus `json`, and is **not** a Gremlin type vocabulary — it must
never grow `vertex`/`edge`/`list`. Gremlin typing stays in `ScalarType`/`CanonicalType` where it is.

### 3.2 Expressions — every one

| kind | fields | notes |
|---|---|---|
| `Col` | `rel: RelId, name: string` | resolves against the node's input scope; **fails closed on an undeclared column**, mirroring the kernel's `rel.c` Proxy |
| `Lit` | `value, type: SqlType` | rendered as a **bind**, never inlined — the bind budget is a plan property (§3.6) |
| `Param` | `name` | a bound query parameter |
| `Unary` | `op: 'not'\|'neg', arg` | |
| `Binary` | `op, left, right` | arithmetic, comparison, `like`, `glob`, `is`, `is not`, `and`, `or`, `\|\|` |
| `Case` | `whens: [cond, then][], else?` | |
| `Cast` | `arg, to: SqlType` | |
| `Call` | `fn: string, args, distinct?: boolean` | scalar SQL functions: `coalesce`, `json_extract`, `abs`, … |
| `Agg` | `fn: 'count'\|'sum'\|'min'\|'max'\|'avg'\|'total'\|'group_concat'\|'json_group_array'\|'jsonb_group_array', args, distinct?, orderBy?` | **legal only inside `Aggregate.aggs`** — the checker enforces it |
| `WindowExpr` | `fn: 'row_number'\|'rank'\|'dense_rank'\|'count'\|'sum'\|'min'\|'max'\|'lag'\|'lead', args, spec: WindowSpec` | **legal only inside `Window.specs`** |
| `JsonObject` | `entries: [key, value][], binary: boolean` | `json_object` / `jsonb_object` |
| `JsonArray` | `items, binary: boolean` | |
| `Scalar` | `plan: Rel` | a scalar subquery; **may be correlated** — P1 says this is legal even inside a recursive term |
| `Exists` | `plan: Rel, negated: boolean` | `EXISTS` / `NOT EXISTS` |
| `InList` | `expr, values: readonly Expr[]` | bounded by query text |
| `InQuery` | `expr, plan: Rel, negated: boolean` | `IN (SELECT …)` |

```ts
type WindowSpec = {
  readonly partitionBy: readonly Expr[]
  readonly orderBy: readonly SortTerm[]
  readonly frame?: { start: FrameBound; end: FrameBound; mode: 'rows' | 'range' }
}
type SortTerm = { readonly expr: Expr; readonly dir: 'asc' | 'desc'; readonly nulls?: 'first' | 'last' }
```

**`partitionBy: readonly Expr[]` is the single most important field in this document.** It is the
parameter whose absence today forces `globalRowOps` and `rankedRows` to be two families: global is
`partitionBy: []`, per-origin is `partitionBy: origins.map(Col)`, and per-origin-dedup is
`[...origins, valueExpr]`. `rankedRows` (`tail/barrier.ts:131`, landed `f9597ca`) already had to take
its window as a **callback** because "that authority does not exist" — an `Expr` *is* that authority.

### 3.3 Relations — every one

Every node carries `layout: TraverserLayout` (its output layout) and derives `type: RelType`.

**Sources (leaves)**

| kind | fields | notes |
|---|---|---|
| `Scan` | `table: 'nodes'\|'edges'\|'vertex_properties'\|'edge_properties'\|'property_fts'\|'labels', alias` | the only physical-schema node; the storage seam |
| `Values` | `rows: readonly (readonly Expr[])[], cols` | `g.inject()`; the one construct measured emitting `VALUES` |
| `SelfRef` | `name` | the recursive CTE's self reference. **Constructible only by `Recursive`'s builder** and legal only in its `step`; the checker rejects it anywhere else |
| `PriorResult` | `step: number, cols` | reads a previous `Sequence` step's `RETURNING` rows. Exists because P5 says data-modifying CTEs do not. Rendered as a chunked bound `VALUES` list via `RowBatch` |

**Unary**

| kind | fields | notes |
|---|---|---|
| `Project` | `input, exprs: readonly (readonly [string, Expr])[]` | the SELECT list; where layout columns are physically declared |
| `Filter` | `input, pred: Expr` | |
| `Aggregate` | `input, groupBy: readonly Expr[], aggs: readonly [string, Expr][], having?: Expr` | `groupBy: []` is a whole-relation aggregate |
| `Sort` | `input, terms: readonly SortTerm[]` | |
| `Limit` | `input, count?: Expr, offset?: Expr` | both optional; `count` absent = offset-only |
| `Distinct` | `input, on?: readonly Expr[]` | `on` absent = whole row |
| `Window` | `input, specs: readonly [string, WindowExpr][]` | adds named window columns; input rows preserved |
| `Explode` | `input, expr: Expr, as: { key?, value, ord? }` | `json_each` — the one table-valued function. Produces one row per member |
| `Materialize` | `input, name?: string` | a **boundary hint**: force a named CTE here. Not semantic — the `Name` pass may add these, and a human may pin one where the planner needs a fence |

**N-ary**

| kind | fields | notes |
|---|---|---|
| `Join` | `left, right, kind: 'inner'\|'left'\|'cross'\|'semi'\|'anti', on?: Expr` | `semi`/`anti` add no columns and render as `EXISTS`/`NOT EXISTS` or as a join+distinct, whichever the emitter picks |
| `Union` | `inputs: readonly Rel[], all: boolean` | n-ary, not binary — `union(a,b,c)` is one node, and the arm-merge `encounter` is minted once |

**Recursion**

| kind | fields | notes |
|---|---|---|
| `Recursive` | `name, cols, seed: Rel, step: (self: SelfRef) => Rel` | `step` is a **function**, so the self-reference cannot leak. Subject to the P1 legality predicate |

**Statements (write)**

| kind | fields | notes |
|---|---|---|
| `Insert` | `table, cols, source: Rel, onConflict?: { target, set }, returning: readonly [string, Expr][]` | `onConflict` is `mergeV`/`mergeE`'s upsert, one statement (P5) |
| `Update` | `table, set: readonly [string, Expr][], from?: Rel, where?: Expr, returning` | |
| `Delete` | `table, where?: Expr, using?: Rel, returning` | |
| `Sequence` | `steps: readonly Stmt[]` | ordered; step *n* may contain `PriorResult{step: m}` for `m < n`. **The only node with execution order semantics** |

**That is 20 relational/statement kinds and 18 expression kinds.** Nothing is elided. If a construct
is missing from this table it is because it is a derived form (§3, opening) — and if a real one is
found missing during Phase 1, add it there, not in a step compiler.

### 3.4 What is deliberately NOT a node

- **`With` / CTE definition.** The plan is a **DAG**; a node referenced twice is shared. Whether a
  shared node becomes a named CTE or is inlined twice is the `Name` pass's decision (§4.6), which is
  exactly the choice `src/sql/CLAUDE.md` says must belong to the Query and never to a per-site
  caller. `Materialize` is the override, not the mechanism.
- **`Correlate` / lateral.** Correlation is a property of an `Expr` referencing an outer `RelId`
  (`Scalar`, `Exists`), not a node. P1 is why: SQLite's lateral rule is positional, and modelling
  correlation as a node would invite constructing the one position it forbids.
- **Shape, cardinality, productivity, bulk semantics.** All Gremlin-level. §2.

### 3.5 Layout obligations, per node

The rule that keeps the 33% defect category dead: **every node declares what it does to each carried
role, and a total checker verifies it.** Not prose — a `Record<keyof TraverserLayout, …>` per node
class, exactly as the two existing tables do.

- `Project` — the only node that may *declare* layout columns; `layoutCols(layout)` must be a subset
  of its output names, checked.
- `Union` — merges arm layouts through `mergeLayouts`; `LAYOUT_ROLE_POLICY` decides per role
  (`union` for aliases, `pad` for path, `identical` for the rigid roles).
- `Aggregate` with `groupBy: []`, and any reducing form — a **barrier**: applies
  `dropLayoutAtBarrier`, which consumes aliases into `consumedAliases` and empties `origins`.
- `Join{kind:'left'}` — the right side's layout columns become nullable; a rigid role arriving
  nullable is an error, not a coercion.
- `Window`, `Sort`, `Limit`, `Filter`, `Distinct`, `Explode` — layout-preserving, and the checker
  asserts they did not drop a column.
- `Recursive` — `seed` and `step` layouts must be **identical**, including column order; this is the
  CTE header requirement and the check that catches a body that forgot a carried column (the exact
  shape of `4cefade`, `repeat()` emitting `1 AS bulk` without declaring it).

### 3.6 Two budgets the plan owns, not the emitter

- **Binds.** `Lit` renders as a bind. A plan carries `bindCount()`, and the emitter **fails closed**
  above the DO cap of 100 rather than emitting SQL that only fails in production. A `PriorResult` or
  a large `Values` chunks through `RowBatch`. This makes `mise run binds` a *plan* property instead
  of a grep for an idiom.
- **Statement text.** DO caps at 100 KB. `Unroll` (§4.3) multiplies plan size, so the unroll pass
  consults the rendered size and declines above a ceiling, falling back to `Recursive` — which then
  refuses a barrier body as a clean deferral. P4 says the corpus max is `times(10)`, so this ceiling
  is never hit in practice and exists so a hand-written `times(1000)` degrades honestly.

---

## 4. The passes

All are `Rel → Rel`, total, and order-declared, mirroring the existing `Pass` pipeline's discipline
(categories, explicit ordering, no switch growth).

**4.1 `check`** — the fail-closed verifier, and the first thing built. Column resolution, `Agg` only
in `Aggregate`, `WindowExpr` only in `Window`, `SelfRef` only inside its `Recursive.step`, layout
obligations per §3.5, bind and text budgets. Runs in dev and in tests always; it is the equivalent of
`assertStreamColumns` for the whole plan.

**4.2 `flatten`** — join flattening / subquery decorrelation. Rewrites a plan into the **P1 envelope**:
the `SelfRef` exactly once at top level of the term's `FROM`, everything else as joins beside it.
**This pass is what deletes `expandRepeatBody`** (its 51 lines of hand-built direction combos, edge
aliases and private `has()` handling, `prefix/branch.ts:710`), and P2 is the evidence that the
vocabulary it refuses is legal once flattened.

**4.3 `unroll`** — replicate a subplan *n* times and chain it. The `times(n)` route from P4, covering
**48 of 53** barrier bodies. With no `Recursive` node in the output there is no recursive term, so
every P1/P3 prohibition evaporates and a barrier is an ordinary `Aggregate`/`Window` over an ordinary
relation. This is item 3's own argument — *"our phases are set-at-a-time by construction, so 'the
whole frontier at iteration k' IS phase k's relation"* — finally cheap, because subplan replication
against a DAG is trivial and against an append-only builder is impossible.

**4.4 `fuse`** — operator fusion. `Sort` + `Limit` → one SELECT with `ORDER BY … LIMIT`; adjacent
`Filter`s conjoin; `Project` over `Project` composes. **This pass deletes `TailAcc`**
(`tail/projection.ts:153`), whose whole reason for existing is that `order()`+`limit()` must be fused
*before* either is emitted, and which is the sole reason `ELEMENT_DISPATCH` is not on the shared
dispatch substrate.

**4.5 `prune`** — column pruning. Drop projected columns no consumer reads. Load-bearing rather than
cosmetic: it is what makes `Unroll`'s replicated subplans affordable, and it removes carried columns
a barrier already consumed.

**4.6 `name`** — decide named CTE versus inlined derived table for every shared node, honouring
`Materialize`. This is where `src/sql/CLAUDE.md`'s "prefer `q.derived` over a named CTE" preference
becomes a policy applied once with the whole plan visible, instead of a judgement call at 163
`q.cte` sites.

**4.7 `recognize`** *(Phase 4 only)* — the fast paths, re-expressed as plan rewrites. Each keeps its
`equivalentWhen` committed test; the difference is that a plan rewrite can be checked for
equivalence structurally, and recognition failure is simply "no rewrite fired" rather than a separate
recognition-vs-support code path.

---

## 5. The emitter

`emit(plan: Rel) → { sql, binds }`, built on the **unchanged `q` kernel**. The kernel keeps its
fail-closed properties (undefined hole throws, absent column throws) and both rendering modes; the
emitter is the only new caller. It is a fold over the DAG with a memo for shared nodes, and it is
**total** — every node kind has an arm, and there is no fallback branch. A node the emitter cannot
render is a missing arm and a compile error, not a runtime throw.

Golden SQL tests compare emitter output to the current `test/L2-sql/` snapshots during migration.
**Byte-identical is the Phase-2/3 gate for anything not deliberately changed** — the same stricter
gate §6 of the naming doc used for vocabulary sets, and for the same reason: it distinguishes "same
semantics" from "same query", and only the second proves nothing moved.

---

## 6. Phases

Each phase ends green on `mise run ci` including the census. The census is not a formality here — it
is the only instrument that distinguishes "behaviour preserved" from "twenty deferrals quietly became
wrong answers", and every phase below will show L3 delta ≈ 0 for most of its work.

### Phase 0 — clear the deck (no RelIR code)

Prerequisites from the analysis doc, worth doing first because each shrinks the surface Phase 2+
migrates or removes a hazard that a large migration would amplify.

- **0.1 — `globalRowOps` into `ELEMENT_DISPATCH` and `SCALAR_DISPATCH`** (analytics §9·1). 45 of 94
  dispatch entries. Compose with `firstOf`; never spread over an owned key.
- **0.2 — the 61 `'<tag>' in ` sites → the 15 existing guards** (analytics §7a/§9·2). This is a
  **rename-safety prerequisite, not tidying**: `'nested' in a` survives a field rename silently, and
  Phase 2 moves a great deal of code. Token by token, `isNested` (~27) then `isTokenArg` (~20).
- **0.3 — split item 3 into three index entries** (§1 P3/P4 above): a dissolvable row-local vocabulary
  gate, a `times(n)` barrier majority, and a 5-traversal platform wall. Docs only; it is what stops
  the 41 reading as one prize.
- **0.4 — sweep `outstanding-work` item 16**, which still asserts a defect closed on 2026-08-01.

### Phase 1 — the clean-room core (no integration, nothing wired)

`src/rel/` — `types.ts`, `expr.ts`, `rel.ts`, `stmt.ts`, `check.ts`, `emit.ts`, `passes/*.ts`.
Zero imports from `steps/` or `gremlin/`; the only import from the existing tree is the layout
contract (§2).

Deliverables: the full §3 object model; `check` (§4.1); `emit` (§5); `fuse`, `prune`, `name`.
Tests are pure — build a plan by hand, assert the SQL, run it against an in-memory SQLite, assert the
rows. **No Gremlin is involved in any Phase-1 test.**

**Exit criterion:** hand-built plans reproduce, byte-identical, the **relational core** of ten
representative traversal families taken from `test/L2-sql/`. Result framing and Gremlin shape stay
outside `src/rel/`, so full legacy SQL strings are not this algebra's output contract. If the emitter
cannot reproduce those cores byte-for-byte, the object model is wrong and Phase 1 is not finished —
this is the cheapest possible falsification and it comes before any integration.

**Progress — 2026-08-01:** the clean-room foundation landed in `773c63a`: full read/write data
unions, checker (column, expression-placement, recursive-self-reference, layout and bind-budget
contracts), kernel-backed emitter, `fuse`/`prune`/`name`, and pure SQLite tests. The naming analysis
now drives CTE emission. The ten byte-identical L2 representatives remain the Phase-1 exit gate;
no compiler integration has started.

**Progress — 2026-08-02:** relation construction is now the named, branded factory surface rather
than raw object literals. `Project` and `Window` reject locally knowable output-schema mismatches at
construction; `check` remains the scope-aware whole-plan backstop. The emitter resolves lexical
`RelId`s to scan aliases, so relation identity is no longer accidentally SQL spelling.
The checker now also proves `Union`'s output layout is the declared peer merge and that a
whole-relation `Aggregate` applies the barrier layout policy; both are tested with carried-state
counterexamples.
`test/rel-core-sql.test.ts` now pins ten byte-exact relational cores (values, projection, filter,
aggregate, sort, limit, distinct, join, union and recursion); result framing is deliberately not
part of that gate.

### Phase 2 — the write wedge

The write path is the right first integration because it is bounded, it has a plan
([write-path](./2026-08-01-write-path-plan.md)), its execution model is the thing being replaced
rather than something being disturbed, and **the whole of it is `Insert`/`Update`/`Delete`/`Sequence`
over read plans that already work.**

- **2.1** `Insert`/`Update`/`Delete`/`Sequence`/`PriorResult` + their emitter arms and checks.
- **2.2** `drop()` → `Delete{using: <read plan>}`. The smallest possible first cut, one statement.
- **2.3** `property()` → `Update{from: <read plan>}` / `Insert … ON CONFLICT`. This is where the
  cardinality bug class lived; expressing `Cardinality.list` as an `Insert` of N rows rather than a
  JS overwrite is a structural fix, not a patch.
- **2.4** `addV`/`addE` → `Insert … SELECT … RETURNING`, with the correlation key from P5b and an
  `ORDER BY` on the source so id assignment stays emission-ordered (`04b5080` preserved by
  construction).
- **2.5** `mergeV`/`mergeE` → `Insert … ON CONFLICT DO UPDATE … RETURNING`, one statement.
- **2.6** **Delete `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`, `parseMergeOptions`,
  `resolveEndpoint`, `materializeElementDrivers`, and `WritePlan`.** The phase is not done while a
  second step dispatcher exists.

**Progress — 2026-08-02:** 2.1's construction/checking half is landed (`9f5d800`). Statements now
use the same named, branded factory boundary as relations; insert source arity, duplicate SQL names,
the complete statement bind budget, and `Delete.using`'s required `id` key are enforced before
execution. `Delete.using` deliberately means physical `table.id` membership — the narrow invariant
needed by `drop()`, not a new join/driver vocabulary. Emission, `PriorResult` materialization, and
execution sequencing remain open; this is not yet a write-path migration.

**Progress — 2026-08-02 (continued):** `8efb07e` makes that membership contract executable:
`Delete{using}` emits SQLite's portable `DELETE … WHERE id IN (SELECT id FROM (<read plan>))` form,
with the read plan's binds retained in order. The test both pins its SQL and executes it against
SQLite. Target-scoped `Update`/`RETURNING` expressions remain deliberately un-emitted until their
lexical target relation is represented in the statement contract.

**Progress — 2026-08-02 (continued):** `d8cf39a` supplies that contract: every mutation target is
a typed `Scan`, rather than a duplicate bare table name. `check` now validates assignments,
predicates and `RETURNING` expressions against the target's declared columns (and an `Update`'s
optional source relation). This keeps the physical schema at `Scan` — the sole storage node — and
unblocks shared expression emission without stringly target columns.

**Progress — 2026-08-02 (continued):** `da3e982` extracts the shared relational expression/
relation renderer, and `c2ee365` uses it for executable `Insert`, `Update` and `Delete` SQL.
Their target-column expressions, source relations, `WHERE`, `ON CONFLICT` assignments and
`RETURNING` projections are all kernel-rendered in one tree; no statement arm reimplements
expression SQL or bind ordering. SQLite execution tests cover insert, update and delete, and the
checker rejects undeclared assignment/insert target columns.

**Phase 2 supersedes [write-path](./2026-08-01-write-path-plan.md), and inherits its requirements.**
That plan's agent was stopped 2026-08-01; the plan is not discarded, it is re-pointed. Precisely:

- **W1 and W4 are LANDED and must not regress.** Five silent wrong answers closed (L3 1679 → 1689,
  four new L4 `.feature` pins) and driver input consumed in emission order (perturbed census 4 → 1).
  P5b is why the second survives set-based writes by construction; the first is guarded by the L4
  pins, which Phase 2 must keep green rather than re-derive.
- **W2 §3 and W3 §4 are the acceptance criteria for this phase** — the best requirements spec that
  exists for it, and they should be re-measured at the start of Phase 2 per that document's own
  closing instruction. What is superseded is only their *approach* (widen the driver contract).
- **W2/W3's two declared blockers dissolve by construction rather than being solved.** W2's
  `mergeE option(Merge.outV)` blocker is *"merge drivers are bare rowids while every other write
  driver carries the traverser's aliases"* — under RelIR `Insert.source` **is** a read plan carrying
  the layout, so there is no driver to widen. W2's map-valued driver is a source relation whose rows
  are maps. W3's unreachable positions (`union(__.addV())`, `optional(__.addV())`,
  `repeat(__.addV())`) are plan composition. **Do not build a driver abstraction to satisfy them.**
- **W3 derived Phase 2's answer independently, before RelIR existed**, and it is the same convergence
  §5a of the analytics doc records for `rankedRows`: its global-barrier-in-the-tail entry reads
  *"Closing it properly means landing all drivers in ONE relation … after which the guard deletes
  itself."* Two routes, one conclusion.
- **write-path §6 (deliberately not in this plan) and §7 (the traps) carry over UNCHANGED and are
  binding here.** Especially trap 3 — *check whether a refusal is the reference's answer before
  removing it*, since a third of the write messages in L3 telemetry belong to scenarios that PASS by
  asserting the throw — and trap 5, that a moved census row needs a written reason.

**Exit criteria:** every write L3 scenario at least as good as before, and W2/W3's ~41 + ~15
candidates measurably moved; W1's four L4 pins green; census identical or better with every moved row
explained; `store.*` call sites in the write path reduced from 44 to O(write steps); `test:perturbed`
still free of write rows; `mise run test:cf-limits` green including `RETURNING`/`ON CONFLICT`.

### Phase 3 — the repeat wedge

- **3.1** `Recursive` + the P1 legality predicate in `check`. A body that cannot be made legal
  **throws a clear deferral naming why** — never silently mis-executes.
- **3.2** `flatten` (§4.2), then route `repeat()`'s body through the ordinary lowering into a plan and
  flatten it into the term. **`expandRepeatBody` is deleted.** The P2 vocabulary — `not`, `where`,
  `union` arms, `optional`, `IN` — arrives as a consequence, not as step work.
- **3.3** `unroll` (§4.3) for `times(n)` bodies, with the §3.6 text ceiling. Take **`dedup` first** —
  4 queries, and item 3 already identifies it as the easiest equivalence to state — with an L4 pin
  per barrier before the next one. One barrier per commit; do not cash in all 48 at once.
- **3.4** Split `repeat`'s admission control from its lowering (analytics §9·4) — with `flatten` and
  `unroll` carrying the vocabulary, the 296-line function's ~20 admission booleans mostly evaporate,
  so do this *after* 3.2/3.3 and let the deletion be the measurement.

**Exit criteria:** `REPEAT_BODY_OK` deleted; the row-local gate's 8 queries pass; `dedup`-in-`repeat`
pinned in L4; the 5 `until()`/`emit()` barrier traversals throw a deferral naming the platform wall.

### Phase 4 — the read migration

Shape-by-shape, behind byte-identical SQL, in this order:

- **4.1** The row-algebraic class — `limit`/`skip`/`range`/`tail`/`order`/`dedup`/`sample` across all
  11 dispatch tables collapse to `Sort`/`Limit`/`Distinct`/`Window` with a `partitionBy` (§3.2). This
  is where the 11-table dispatch surface actually shrinks.
- **4.2** `fuse` replaces `TailAcc`; `ELEMENT_DISPATCH` joins the shared substrate. This is item 17's
  declared remainder.
- **4.3** Aggregates and `count` — the ten handlers become one `Aggregate` reading row→traverser
  cardinality off the plan instead of ten handlers knowing it privately.
- **4.4** `recognize` (§4.7): fast paths become plan rewrites.

The shape-interpreting class (materialization, framing, JSON construction) stays per-shape forever
and correctly so; Phase 4 is finished when the row-algebraic class is gone from the shape tables, not
when the shape tables are gone.

---

## 7. Risks, named, with the response

| Risk | Response |
|---|---|
| **Re-encoding, not simplification** — 11 shape tables become 11 shape-aware plan builders | Phase 1's byte-identical exit criterion catches an inadequate model before integration; Phase 4.1 is measured by *dispatch entries deleted*, and if that number is not falling the phase is failing |
| **SQLite is the optimizer** — a mid-end that costs plans duplicates its work | RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no statistics, no join reordering.** A cost-based rewrite is out of scope permanently, not merely for now |
| **L3 delta ≈ 0 makes regressions invisible** | The census is the gate on every phase, and byte-identical SQL is the gate within Phases 2–3 |
| **The layout contract erodes during migration** | §3.5's per-node obligations are `Record<keyof TraverserLayout, …>`, so a new node or role fails the build until declared — the same enforcement the two existing tables already have |
| **Scope creep into a general query engine** | The node set in §3 is closed. Adding a kind requires the same bar as a new substrate today: show the seam cannot EXPRESS it, not that it cannot be HANDED it |
| **DO-only walls (`RETURNING`, `ON CONFLICT`)** | `test:cf-limits` gate before Phase 2 ships (§1) |
| **Losing W1/W4's landed gains in the rewrite** | W1's four L4 pins and the perturbed census are Phase 2 exit criteria, not afterthoughts; P5b makes emission-ordered id assignment structural rather than incidental |
| **Rebuilding the driver abstraction inside RelIR** | W2/W3's blockers are listed as *dissolving*, with an explicit "do not build a driver abstraction" (§6 Phase 2). If Phase 2 grows an `ElementReadDriver` analogue, it has failed |

---

## 8. What this deletes

The measure of success, stated up front so it can be checked rather than claimed:

`expandRepeatBody` · `REPEAT_BODY_OK` · `runWriteChainFull` · `parseEdgeCluster` · `parseVertexSpec` ·
`parseMergeOptions` · `resolveEndpoint` · `materializeElementDrivers` · `WritePlan` · `TailAcc` ·
the five-copy `count` adapter and the four-copy `where` adapter · the row-algebraic half of 11
dispatch tables · the recognition-vs-support split in the fast-path layer.

Two second implementations of the traversal machine, one accumulator that exists only because
fusion had nowhere to happen, and the majority of a 11,201-line directory.
