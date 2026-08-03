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
→ *Decides: a write chain is a SEQUENCE of statements — O(write steps), not one, and not O(rows) as
today. The ordering lives in `Plan.bindings` (§3.0); there is no `Sequence` node.*

**P5b — RETURNING and determinism.** SQLite documents RETURNING's row order as undefined. Measured:
**id assignment follows the source `SELECT`'s `ORDER BY`** (`INSERT … SELECT … ORDER BY ord DESC`
assigned id 1 to the last-ordered row), and **RETURNING can project an inserted column**, so a
correlation key carried into the insert comes back out.
→ *Decides: emission-order determinism (`04b5080`) survives set-based writes — order the source, and
re-associate by carried key, never by RETURNING position.*

**Gate before Phase 2 ships:** re-run P5/P5b under DO SQLite via `test:cf-limits`. `RETURNING` and
`ON CONFLICT` are the exact species of "passes on Bun, wall in production" that seam exists for.

---

## 2. The clean-room boundary

Build the algebra clean-room. `src/rel/` imports **nothing** from `src/compiler/` and nothing from
`src/gremlin/`. It is pure data plus total functions over it, testable with no graph, no store, and no
Gremlin. That is the whole point: the reason the current SQL layer cannot be rewritten is that it is
entangled with lowering, and reproducing that entanglement in a new layer buys nothing.

**`TraverserLayout` IS in scope, and is being decomposed** (decided 2026-08-02; this doc previously
declared it off-limits, and that rule was cost-avoidance rather than design). What must be preserved is
the *guarantee*, not the struct: `LAYOUT_ROLE_POLICY` and `BARRIER_ROLE_POLICY` are
`Record<keyof TraverserLayout, …>` — type-enforced total, so a new role fails the build until its merge
and barrier policies are declared — and they encode the largest measured defect category in this repo's
history (**33% of diagnosed defects: a carried field dropped at a barrier, merge or rejoin**). Keep the
tables and their totality; that is what a redesign must not lose.

**The boundary is a VOCABULARY boundary, not a file boundary.** Measured, RelIR needs exactly two
things about carried state: which output columns are channels and in what order, and per channel its
merge policy and its barrier policy. It does not need alias shape histories or path element types —
`.shapes` is read only by `match`/`filter`/`labelselect`/`select`/`child-shape`, and `PathState`'s
`Elem` only by `branch`/`movement`. So:

- a neutral **channel core**: `Channels = readonly { col: string; role: ChannelRole }[]`, the two
  policy tables keyed by role, and merge/barrier as total functions over it. **No Gremlin words in it.**
- `TraverserLayout` becomes that core plus the role-specific detail the framing layer owns (alias
  shape sets, the path's element list).
- RelIR carries `Channels`; its obligations (§3.5) talk about roles and policies. A RelIR node cannot
  know what a sack is.

The tell that this decomposition is the right one: `sameLayout` compared two layouts by
`JSON.stringify`, and touched `shapes` for no reason other than that they are in the struct. Over
`Channels` the comparison is a list equality.

**LANDED 2026-08-02 (`25e0b5f`)** as `src/channels.ts`, with three things worth recording:

- the framing layer's `LAYOUT_ROLE_POLICY`/`BARRIER_ROLE_POLICY` now READ their channel-role
  policies off the core, so there is one authority rather than two tables to keep in step; only the
  two METADATA roles are declared locally, because they are never physical columns and therefore
  are not channels at all.
- **at the channel level a barrier keeps NOTHING.** `consumed`/`empty`/`drop` is framing-layer
  bookkeeping about what to REMEMBER, not about which column survives, so `barrierChannels` is a
  filter over the table that is empty today and carries a surviving role the moment one is declared.
- **the channel merge is deliberately weaker than the layout merge.** Arms fork from a common seed,
  so at the column level a forkable role can only be extended: every arm's alias columns are a
  prefix of the merged result's. Which LABEL sits at which column is the framing layer's business —
  `mergeAliasMaps` may give an arm-minted label a different canonical column than the arm used —
  and reproducing that algebra here would be the Gremlin leak the module exists to prevent.
  `test/channel-contracts.test.ts` ties the two: same columns, same rigid set, same failure on the
  same divergence.

**Shape does not enter RelIR at all.** RelIR sits downstream of lowering, so Gremlin shape is already
resolved and rides to the wire as `Compiled.shape`, untouched. The anchor rule — *a Pass may CONSULT
shape, never CONSTRUCT it* — is unaffected because no Pass ever sees a RelIR node. This is what makes
RelIR categorically different from the refuted typed-core-IR, and the distinction must stay true: if
a RelIR node ever acquires a `kind: 'scalar' | 'element' | …` field, the layer has failed and should
be reverted. `ChannelRole` is not that field: a role is per-COLUMN carried-state bookkeeping, never
the stream's Gremlin type.

---

## 3. The object model — complete

Two algebras: **expressions** (scalar, produce a value per row) and **relations** (produce rows).
Plus **statements** for writes. Nothing else. Every node is an immutable plain object with a `kind`
discriminant, and every list is `readonly`.

### 3.0 The top of a plan is a PROGRAM, not a tree

```ts
type Plan    = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt }
// and one new source node:  Ref { name }   — a reference to a binding
```

Decided 2026-08-02, and it is the change that makes write stop being a special case. **A `PriorResult`
and a named-CTE reference are the same concept** — a reference to a relation computed earlier — and the
build had two mechanisms for it: a `Naming` side-table for reads and `PriorResult{step: number}` for
writes. That duplication *is* why the write path reads as a second machine. One concept, one node:

- a binding whose node is a `Rel`, referenced more than once → a **CTE**. That is the `Name` pass's
  decision (§4.6), now a property OF THE PLAN rather than a map carried beside it.
- a binding whose node is a `Stmt` → a **statement boundary**. The executor runs it, retains its
  `RETURNING` rows, and the same `Ref` resolves to them — landed as ONE JSON bind exploded by
  `json_each`, never a row-count-sized placeholder list. CTE-versus-materialize becomes one question
  asked once, of one concept.
- a write in a read position is a **hoist to a binding**, so `union(__.addV(), __.V())`,
  `optional(__.addV())` and `repeat(__.addV())` are plan composition exactly as W3 predicted — and
  there is no driver anywhere in it.
- **Effects are legal only at a binding.** `Rel` positions stay pure: a `Stmt` cannot be a `Join`
  input, and that is a type-level fact rather than a checker rule. `Stmt` and `Rel` stay separate
  unions and share `RelBase`, so a statement's result is a relation like any other — which deletes
  `returningType` (it is just `type`) and with it `PriorResult`'s duplicate-schema check.
- `emit` is total again: there is no `PriorResult` arm left to throw from.

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
| `Ref` | `name` | a reference to a `Plan` binding (§3.0) — a named CTE when the binding is a `Rel`, an earlier statement's materialized `RETURNING` rows when it is a `Stmt`. **Replaces `PriorResult`**, which was the same concept spelled a second way for writes |

**Unary**

| kind | fields | notes |
|---|---|---|
| `Project` | `input, exprs: readonly (readonly [string, Expr])[]` | the SELECT list; where layout columns are physically declared |
| `Filter` | `input, pred: Expr` | |
| `Aggregate` | `input, groupBy: readonly Expr[], aggs: readonly [string, Expr][], having?: Expr` | `groupBy: []` is a whole-relation aggregate |
| `Sort` | `input, terms: readonly SortTerm[]` | |
| `Limit` | `input, count?: Expr, offset?: Expr` | both optional; `count` absent = offset-only |
| `Distinct` | `input` | whole row, and **only** whole row. `on` was removed 2026-08-02 (§9): it emitted a projection of the keys while the node's declared type still promised the full row, so a consumer of a dropped column failed at execution with the checker's blessing. A KEYED dedup is `Window(row_number PARTITION BY key)` + `Filter(rn = 1)` — the job §3.2 gives `partitionBy` — and `SELECT DISTINCT a, b` is `Distinct` over `Project`, one of §3's declared collapses |
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
| `Delete` | `table, where?: Expr, returning` | membership in another relation is `InQuery` in `where` — there is no `using`, and §10·6 records why a dedicated field was the thing that put a physical `'id'` in the emitter |

`Sequence` is gone with `PriorResult`: ordering IS the `Plan.bindings` list (§3.0), so there is no node
that privately owns execution order. Statements carry `RelBase`, so `returningType` is just `type`.

**That is 19 relational/statement kinds and 15 expression kinds.** Nothing is elided. If a construct
is missing from this table it is because it is a derived form (§3, opening) — and if a real one is
found missing during Phase 1, add it there, not in a step compiler.

### 3.4 What is deliberately NOT a node

- **`With` / CTE definition.** A `Plan` binding (§3.0) is the only naming mechanism, and whether a
  binding becomes a named CTE or is inlined at its uses is the `Name` pass's decision (§4.6) — exactly
  the choice `src/sql/CLAUDE.md` says must belong to the Query and never to a per-site caller. Within
  a binding the relation is still a **DAG**, and a node referenced twice is shared. `Materialize` is
  the override, not the mechanism.
- **`Param`.** Deleted 2026-08-02: the front-end resolves wire parameters into `Step.args` before the
  IR exists (`stepChain(tree, params)`), and no other layer has a parameter concept — so nothing
  downstream could ever construct one. It existed only to throw at emission.
- **`Correlate` / lateral.** Correlation is a property of an `Expr` referencing an outer `RelId`
  (`Scalar`, `Exists`), not a node. P1 is why: SQLite's lateral rule is positional, and modelling
  correlation as a node would invite constructing the one position it forbids.
- **Shape, cardinality, productivity, bulk semantics.** All Gremlin-level. §2.

### 3.5 Channel obligations, per node

The rule that keeps the 33% defect category dead: **every node declares what it does to each carried
channel, and a total checker verifies it.** Not prose — `Record<RelKind, …>`, so a new node kind fails
the build until its obligation is declared, exactly as the two role-policy tables do for a new role.
Landed 2026-08-02 in `src/rel/layout.ts`; it will speak in `ChannelRole` once §2's decomposition lands.

- `Project` — the only node that may *declare* layout columns; `layoutCols(layout)` must be a subset
  of its output names, checked.
- `Union` — merges arm layouts through `mergeLayouts`; `LAYOUT_ROLE_POLICY` decides per role
  (`union` for aliases, `pad` for path, `identical` for the rigid roles).
- `Aggregate` — ANY reducing form, grouped or whole-relation, is a **barrier**: applies
  `barrierLayout`, which consumes aliases into `consumedAliases` and empties `origins`.
- `Join{kind:'left'}` — the right side's layout columns become nullable; a rigid role arriving
  nullable is an error, not a coercion.
- `Window`, `Sort`, `Limit`, `Filter`, `Distinct`, `Explode` — layout-preserving, and the checker
  asserts they did not drop a column.
- `Recursive` — `seed` and `step` layouts must be **identical**, including column order; this is the
  CTE header requirement and the check that catches a body that forgot a carried column (the exact
  shape of `4cefade`, `repeat()` emitting `1 AS bulk` without declaring it).
- Every node — a channel it CLAIMS must be a column it actually emits. A source has no input, so this
  subset rule is the whole of its obligation.

### 3.6 Two budgets the plan owns, not the emitter

- **Binds.** `Lit` renders as a bind. A plan carries `bindCount()`, and the emitter **fails closed**
  above the DO cap of 100 rather than emitting SQL that only fails in production. A statement binding's
  materialized rows (§3.0) or a large `Values` lands as ONE JSON bind exploded by `json_each` — the
  lowering is a pass, so `emit` never learns about chunking. This makes `mise run binds` a *plan* property instead
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
relation. This is item 3b's own argument — *"our phases are set-at-a-time by construction, so 'the
whole frontier at iteration k' IS phase k's relation"* — finally cheap, because subplan replication
against a DAG is trivial and against an append-only builder is impossible.

**4.4 `fuse`** — SEMANTIC rewrites only, and deliberately small: adjacent `Filter`s conjoin,
`Distinct(Distinct x)` collapses, `Limit` over `Limit` composes, a `Sort` dead before a barrier goes.
**`Sort` + `Limit` is NOT this pass's job** — that is one SELECT's `ORDER BY … LIMIT`, a slot-filling
fact, and it belongs to the emitter's block assembler (§5). This doc previously claimed `fuse` is what
deletes `TailAcc` (`tail/projection.ts:153`); **the assembler is**, and the distinction matters because
it decides whether the IR stays normalized.

**4.5 `prune`** — column pruning. Drop projected columns no consumer reads. Load-bearing rather than
cosmetic: it is what makes `Unroll`'s replicated subplans affordable, and it removes carried columns
a barrier already consumed.

**4.5b `land`** — the bind-budget lowering (§3.6). An over-budget `Values` becomes one JSON `Lit`
exploded by `json_each` and re-projected positionally, so a row set sized by ROW COUNT never becomes
a bind list. A pass rather than an emitter behaviour, which is what keeps `emit` free of chunking
and leaves the rewritten plan an ordinary plan `check` verifies like any other. It declines a row
holding anything but a `Lit` — no compile-time JSON — and the budget then fails closed on it.

**4.6 `name`** — decide named CTE versus inlined derived table for every shared node, honouring
`Materialize`. This is where `src/sql/CLAUDE.md`'s "prefer `q.derived` over a named CTE" preference
becomes a policy applied once with the whole plan visible, instead of a judgement call at 163
`q.cte` sites.

**4.7 `recognize`** *(Phase 4 only)* — the fast paths, re-expressed as plan rewrites. Each keeps its
`equivalentWhen` committed test; the difference is that a plan rewrite can be checked for
equivalence structurally, and recognition failure is simply "no rewrite fired" rather than a separate
recognition-vs-support code path.

---

## 5. The emitter — a SELECT block assembler

Built on the `q` kernel — **additively only**: the kernel gained `identifier()` (one
identifier-spelling authority, so no caller concatenates a name), and that is the only permitted class
of change. Nothing in the kernel may be reshaped to suit RelIR. The kernel keeps its fail-closed
properties (undefined hole throws, absent column throws) and both rendering modes; the emitter is the
only new caller. It is **total** — every node kind has an arm, no fallback branch, so a node it cannot
render is a compile error rather than a runtime throw.

**The IR is normalized (one operator per node); SQL's `SELECT` is a COMPOSITION of operators with
fixed slots. Converting between those two shapes is the emitter's whole job.** So the emitter does not
render a node at a time — it accumulates a block:

```
SelectBlock = { select, from, joins, where, group, having, order, limit, distinct }
```

Walk down from a node filling slots, and open a nested `SELECT` only when the slot you need is already
occupied (a second `WHERE` after a `GROUP BY`; a `LIMIT` under a `LIMIT`). Prior art is Calcite's
`RelToSqlConverter`, which is the same algorithm and the same reason. This is why `Project(Filter(Join))`
is one statement and not three, and it is what deletes `TailAcc` — not `fuse` (§4.4).

The alternative was considered and **refused**: letting `fuse` collapse a run into a `Select`
mega-node would put the SQL surface inside the IR, re-open the closed node set (§7), and force every
downstream pass to handle two forms of the same thing.

### 5a. The equivalence gate — results and access path, never spelling

**Byte-identical SQL is NOT a gate here, and the earlier version of this plan was wrong to make it
one** (removed 2026-08-02). `test/CLAUDE.md` already rules the other way — *"SQL snapshots assert
semantic equivalence, NOT byte-identity … a refactor that moves the SQL string but means the same
thing (same result set + plan shape) is fine"* — so the plan had invented a stricter gate than the
repo's own policy, and it was then satisfied by a snapshot of the emitter against itself (§9·1). A
gate that cannot be met invites exactly that substitution.

The replacement is the two properties actually worth holding, and both are mechanically checkable
against real `test/L2-sql/` traversals with nothing hand-transcribed:

1. **Same results** on the reference fixture, for the traversal the plan came from.
2. **Same `EXPLAIN QUERY PLAN`.** This is the real content of §7's *"SQLite is the optimizer"*: it
   catches a rewrite that changed the access path, which string equality catches only by accident and
   which result-equivalence misses entirely.

Together they are a STRONGER falsification than byte-identity, because they fail on a plan that reads
the same and executes differently — and they do not pin spelling, so an emitter improvement is not a
test-churn event.

---

## 6. Phases

Each phase ends green on `mise run ci` including the census. The census is not a formality here — it
is the only instrument that distinguishes "behaviour preserved" from "twenty deferrals quietly became
wrong answers", and every phase below will show L3 delta ≈ 0 for most of its work.

**RE-ORDERED 2026-08-02 to `0 → 1 → 4.1 → 2 → 3 → 4.2–4.4`, and the reason is measured, not
aesthetic.** Phase 2's premise was *"the whole of it is `Insert`/`Update`/`Delete` bindings over read
plans that already work"* — which assumed the existing read plans are usable as RelIR INPUTS. They
are not: a write's prefix arrives as `renderDriverRows(st)`, opaque `{sql, binds}` from the legacy
spine, so `Delete{using: <read plan>}` has no `Rel` to be handed. **Writes consume reads, so reads
go first.** §10·4 records the decision and the migration contract that governs all of it; read that
before starting any phase below.

### Phase 0 — clear the deck (no RelIR code)

Prerequisites from the analysis doc, worth doing first because each shrinks the surface Phase 2+
migrates or removes a hazard that a large migration would amplify.

- **0.1 — `globalRowOps` into `ELEMENT_DISPATCH` and `SCALAR_DISPATCH`** (analytics §9·1). 45 of 94
  dispatch entries. Compose with `firstOf`; never spread over an owned key.
  **Measured 2026-08-02 and the premise is wrong for the ELEMENT half**, so this is not the cheap
  deck-clearing it reads as: the element pipeline's `limit`/`skip`/`range`/`dedup`/`order` are not
  MISSING from `ELEMENT_DISPATCH`, they are in `TailAcc` (`tail/projection.ts:85-114`), which folds
  them into ONE projection's `ORDER BY`/`LIMIT`/`DISTINCT`. Spreading `globalRowOps` over them would
  replace that fusion with a `reprojectRows` per op — a SQL-shape regression, and against the very
  thing `TailAcc` exists for. The element half is therefore **Phase 4.2's**, after the block
  assembler can fuse the run instead; the scalar half stands on its own merits.
- **0.2 — the 61 `'<tag>' in ` sites → the 15 existing guards** (analytics §7a/§9·2). This is a
  **rename-safety prerequisite, not tidying**: `'nested' in a` survives a field rename silently, and
  Phase 2 moves a great deal of code. Token by token, `isNested` (~27) then `isTokenArg` (~20).
- **0.3 — split item 3 into three index entries** (§1 P3/P4 above): a dissolvable row-local vocabulary
  gate, a `times(n)` barrier majority, and a 5-traversal platform wall. Docs only; it is what stops
  the 41 reading as one prize. **DONE 2026-08-02** — `outstanding-work` items 3 / 3b / 3c, each
  pointing at the phase that owns it.
- **0.4 — sweep `outstanding-work` item 16**, which still asserts a defect closed on 2026-08-01.
  **Already done** — re-read 2026-08-02: the item now opens by recording the W4 defect as closed and
  scopes itself to the meta-property VALUE typing that genuinely remains.

### Phase 1 — the clean-room core (no integration, nothing wired)

`src/rel/` — `types.ts`, `expr.ts`, `rel.ts`, `stmt.ts`, `check.ts`, `emit.ts`, `passes/*.ts`.
Zero imports from `steps/` or `gremlin/`; the only import from the existing tree is the layout
contract (§2).

Deliverables: the full §3 object model; `check` (§4.1); `emit` (§5); `fuse`, `prune`, `name`.
Tests are pure — build a plan by hand, assert the SQL, run it against an in-memory SQLite, assert the
rows. **No Gremlin is involved in any Phase-1 test** — with one deliberate exception, the exit gate
below, which compiles Gremlin only to obtain the legacy SQL it compares against. That is a property
of the COMPARISON, not of `src/rel/`: the clean-room rule is about what the algebra imports.

**Exit criterion (restated 2026-08-02):** for ten representative traversal families taken from
`test/L2-sql/`, a hand-built plan must be **equivalent to the legacy SQL under §5a** — same results on
the reference fixture, same `EXPLAIN QUERY PLAN`. Result framing and Gremlin shape stay outside
`src/rel/`, so a full legacy SQL string is not this algebra's output contract; the access path is.
If the emitter cannot match those cores, the object model is wrong and Phase 1 is not finished — this
is the cheapest possible falsification and it comes before any integration.

**The gate is MET as of `38a58ba`** — `test/rel-l2-equivalence.test.ts`, eleven families, each
asserting identical rows on the reference fixture and an identical `EXPLAIN QUERY PLAN` access
path. Both sides are mechanical: `test/support/sql-core.ts` takes a compiled plan's relational
CORE by structure (its CTE chain, with the framing `SELECT` replaced by `SELECT * FROM <last cte>`,
because RelIR sits below framing) and reduces an EQP to its index DECISIONS, dropping object names
(an alias is spelling) and CTE-materialization lines (CTE-versus-inline is `name`'s decision,
§4.6). The families: element source · source-by-id · movement with bulk coalescing · the label
filter · the property filter as a correlated `EXISTS` · value projection with its storage-class
`CASE` · the reducing barrier · `Sort`+`Limit` · whole-row dedup · the branch `UNION` · `inject`'s
`VALUES`. The interesting ones are three and four index decisions deep, so an access-path change
fails rather than passing on a coincidence.

**What the gate found on its first run — both invisible to every other test:**

- **`Union` emitted a SQLite SYNTAX ERROR.** `(SELECT …) UNION ALL (SELECT …)` is `near "(":
  syntax error` — a compound arm is a select-CORE, not a parenthesised select. No test had ever
  EXECUTED a union; the pins only compared its string. An arm that fills a tail slot now takes a
  derived table of its own, since `ORDER BY`/`LIMIT` belong to the compound and not to an arm.
- **`Table` had no `vertex_labels`**, so `hasLabel()` was a shape the algebra could not express at
  all. `Scan` is the one physical-schema node (§3.3), which makes an absent table an absent
  capability rather than an inconvenience. `vertex_property_cardinality` was missing for the same
  reason and lands with it.

One expressiveness note the gate surfaced and did NOT resolve: movement's bulk coalescing
(`SELECT id, SUM(bulk) … GROUP BY id`) is a grouped `Aggregate` that must KEEP carrying `bulk`,
while §3.5's obligation makes every reducing aggregate a barrier and `BARRIER_ROLE_POLICY` drops
`bulk`. **ANSWERED 2026-08-02 (`5bb86db`), and the guess recorded here — that it would have to be
a `recognize` rewrite (§4.7) firing outside the algebra — was wrong, because the PREMISE was
wrong.** What makes a barrier is that the output row is a NEW traverser, not that the SQL groups.
Summing the MULTIPLICITY channel under a grouping by traverser identity emits the SAME traverser
multiset, run-length encoded: it reduces ROWS, not TRAVERSERS. So it is a clause of the obligation
like any other (`isReEncoding`, decidable from the node alone) and the table stays total. Every
clause is load-bearing — non-empty grouping, the sole aggregate exactly `SUM(bulk)` back into
bulk's own column, and **bulk as the ONLY channel**, which is `collapseSafe`'s "no
path/as/sack/branch/order" falling out of the channel list rather than a second vocabulary to keep
in step.

**The superseded record** (audit, §9·1) — `test/rel-core-sql.test.ts` is not the gate. That file pins ten
NODE KINDS against hand-written transcriptions of the emitter's own output; no `test/L2-sql/`
expectation is referenced, no traversal family appears, and nothing in it fails if the object model is
wrong. The original wording asked for byte-identity, which was (a) against `test/CLAUDE.md`'s own
rule and (b) unreachable for a per-node renderer — a genuine L2 core is ONE flat SELECT with carried
columns (`SELECT e.tgt AS id, p.bulk, p.o0 FROM edges e JOIN c2 p ON e.src=p.id AND …`,
`test/L2-sql/branch.sql.test.ts:78`). Both halves are now fixed: §5 makes the emitter a block
assembler, and §5a makes the gate the property worth holding.

**Progress — 2026-08-01:** the clean-room foundation landed in `773c63a`: full read/write data
unions, checker (column, expression-placement, recursive-self-reference, layout and bind-budget
contracts), kernel-backed emitter, `fuse`/`prune`/`name`, and pure SQLite tests. The naming analysis
now drives CTE emission. The ten L2 representatives remain the Phase-1 exit gate; no compiler
integration has started.

**Progress — 2026-08-02:** relation construction is now the named, branded factory surface rather
than raw object literals. `Project` and `Window` reject locally knowable output-schema mismatches at
construction; `check` remains the scope-aware whole-plan backstop. The emitter resolves lexical
`RelId`s to scan aliases, so relation identity is no longer accidentally SQL spelling.
The checker now also proves `Union`'s output layout is the declared peer merge and that a
whole-relation `Aggregate` applies the barrier layout policy; both are tested with carried-state
counterexamples.
`test/rel-core-sql.test.ts` pins ten exact SQL strings, one per node kind (values, projection,
filter, aggregate, sort, limit, distinct, join, union and recursion). **It was recorded here as the
Phase-1 exit gate and it is not** — the gate is ten L2 traversal FAMILIES, and this file references no
L2 expectation. It survives only as an emitter snapshot; the gate stays open (§9·1).

**Progress — 2026-08-02, decision 10·1 landed (`b199a5f`):** the emitter is the SELECT block
assembler. Slots are filled walking down from a node and a nested `SELECT` opens only where the
slot is already occupied, so `Project(Filter(Join))` is ONE statement and `Filter` over `Aggregate`
is `HAVING`. A named CTE is now a direct FROM item, which is what makes the genuine L2 core shape
(`… FROM edges e INNER JOIN c2 p ON …`) reachable at all; the select list is always explicit, so a
`Values` source binds its declared names straight to SQLite's `column1…columnN`; and the statement
arms lost their private `externalAliases`/`bareColumns` back channels — a statement is a scope whose
target spells its columns bare.

Two node contracts had to become truthful for the assembler to name an output column at all, and
each was a silent wrong answer waiting: **a `Join` emits its sides' columns POSITIONALLY** (the left
alone for `semi`/`anti`), so its declared type must have that width and no duplicate name — else
`Col{join, 'id'}` resolves to whichever side was written last, the same species as `c4bce7f`; and
**an `Aggregate` emits its group keys then its aggregates**, so the declared type names the keys
rather than leaving SQLite to infer them from a bare column reference. One new emission fact,
measured: splicing a join side lifts ITS aliases into the join's `FROM`, and two sides reading the
same shared relation lift the same alias twice (`FROM r0 shared INNER JOIN r0 shared` →
`ambiguous column name`). That is not an error — the sides are different relations — so a collision
keeps that side in its own `SELECT`, where its aliases are private again. Finally the bind cap is
checked against the RENDERED bind list too, because a fused block can spell one `Lit` more than once
and `check`'s count is over IR occurrences.

### Phase 2 — the write wedge

The write path is the right first integration because it is bounded, it has a plan
([write-path](./2026-08-01-write-path-plan.md)), its execution model is the thing being replaced
rather than something being disturbed, and **the whole of it is `Insert`/`Update`/`Delete` bindings
over read plans that already work.**

- **2.1** `Insert`/`Update`/`Delete` + `Plan`/`Binding`/`Ref` (§3.0) + their emitter arms and checks.
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

**Progress — 2026-08-02 (continued):** `1155d2d` gives `Sequence` its SQLite-true emission
surface: a readonly ordered list of individually rendered statements, executed in order rather
than concatenated into an invalid data-modifying CTE. Nested sequences are rejected. `PriorResult`
materialization is the remaining part of this seam; it must preserve the pre-mutation snapshot for
vertex-drop cascades rather than re-evaluating the source after an earlier delete.

**Progress — 2026-08-02 (continued):** result typing is now explicit (`6ee500f`): each DML node
declares `returningType`, exactly matching its `RETURNING` names. A `PriorResult` is legal only in
an ordered `Sequence`, only for an earlier step, and only when its full column type/nullability
matches that step's result schema. This is the type-preserving contract the runtime JSON transfer
will carry, not a second inferred expression-type system.

**Progress — 2026-08-02, decision 10·2 landed (`3057e89`).** `Plan`/`Binding`/`Ref` exist;
`Sequence`, `PriorResult`, `Param`, `returningType` and the `Naming` side-table are deleted.
Statements share `RelBase`, so a statement's result is a relation like any other. `emit` is ONE
entry point over a program returning its executable steps in order — the three it replaced
(`emit`/`emitStmt`/`emitSequence`, with statement-only `externalAliases`/`bareColumns` back
channels) are gone, and a statement is now a scope whose target spells its columns bare, sharing
the whole renderer. `name` rewrites shared nodes into bindings; `checkPlan` walks them in order, so
a forward or self reference fails closed. A `Ref` to a statement binding renders as `json_each(?)`
over one JSON bind carried in `Emitted.binds` as a `RowsBind` marker, so `emit` never learns about
chunking and the executor never parses SQL to find the slot; a plan whose result IS a statement's
rows emits no extra step.

**The executor landed in `aa9a9ee`** — `src/program.ts`, `runProgram(store, plan)`. It walks the
bindings in order, retains each statement's `RETURNING` rows, and substitutes them for the matching
`RowsBind`; the retention IS the pre-mutation snapshot a vertex-drop cascade requires, and the test
pins that case directly (an upsert that rewrites the rows its own predicate selected on, followed
by a delete of what it returned). Rows travel positionally with the binding's declared `type` as
the authority; a value JSON cannot carry losslessly fails closed naming the column.

**2.1 is therefore complete.** Everything from §3.0 down to a program running against SQLite is
built and tested. What is NOT built is the way in.

**RE-ORDERED — 2026-08-02, decided in §10·4 and §10·5.** 2.2 reads as "the smallest possible first
cut, one statement", and it is not reachable as written. Two findings, measured against `compileDrop`
(`steps/write/write.ts:186`):

- **`Delete{using: <read plan>}` needs the read plan to BE a `Rel`, and nothing produces one.**
  Phase 2's premise — *"the whole of it is `Insert`/`Update`/`Delete` bindings over read plans that
  already work"* — assumed the existing read plans are usable as RelIR inputs. They are not: the
  prefix arrives as `renderDriverRows(st)`, opaque `{sql, binds}` from the legacy spine. Making
  `drop()` a RelIR statement therefore requires a `Step[] → Rel` lowering for the element source and
  its filters, which is **Phase 4's** work. The alternatives are both bad: an escape node wrapping
  opaque SQL re-opens the closed node set for a reason §7 explicitly refuses (the seam CAN express
  it; we just have not written the lowering), and a lowering that handles `g.V()` and defers
  everything else is a second dispatcher of exactly the kind 2.6 says must not exist.
- **The cascade is expressible, and doing it would contradict a measured decision.** The rest of
  `compileDrop` — eight statements over a snapshot of the target ids — IS pure RelIR, and expressing
  it would delete `deleteWhereIn`, `deleteFtsForOwners` and the hand-rolled `bindChunks`/
  `placeholders`. But §3.6's remedy for a row-count-sized bind list is ONE JSON bind, and the root
  `CLAUDE.md` records the opposite answer for a WRITE: *"a WRITE chunks through `src/rowbatch.ts`
  (`bindChunks` at `floor(100 / binds-per-row)`, FIXED shape so the prepared-statement cache hits —
  **measured 4.6× faster** than inlining literals to dodge the cap)"*. A read cannot chunk because a
  compiled plan is one statement; a write can, and measurably should. So RelIR's bind remedy is
  READ-shaped, and applying it to a write cascade is a performance regression against a measured,
  locked decision.

**How both were answered.** The first: **§10·4** — reads go first, through a second lowering grown
step by step behind a differential switch, with the phase order becoming `4.1 → 2 → 3 → 4.2–4.4` and
a two-counter contract that the migration finishes. The second: **§10·5** — the apparent conflict was
not one. Measured on both runtimes, the JSON bind is ~2× FASTER on DO (and slower on Bun), so there
is one rule rather than a trade-off to split.

**Superseded handoff — 2026-08-02, RESTATED against §3.0.** Phase 2's remaining 2.1 seam is the
**binding executor**, and it is no longer statement-shaped: walk `Plan.bindings` in order; a `Rel`
binding is a CTE or is inlined per the `Name` pass; a `Stmt` binding is executed and its `RETURNING`
rows retained, so that every later `Ref` to it renders from ONE JSON bind exploded by `json_each`
(never a row-count-sized placeholder list). It must work at arbitrary relation nesting, not only at
the top level, and must preserve the pre-mutation snapshot a vertex-drop cascade requires. The
transfer keeps the standard typed `{t,v}` envelope where values need JSON transport, with the
binding's declared `type` as the authority for every column's full type/nullability; no type
inference and no `as Rel` escape hatch. The executor lives OUTSIDE `src/rel/` (§10·2) — RelIR
supplies `Ref` and the pass that resolves it.

Superseded by that restatement: the earlier handoff's `Sequence`-executor framing, and the work
already landed on `Sequence`/`PriorResult`/`returningType` (`1155d2d`, `6ee500f`) — those nodes are
deleted by §3.0, so their emission and checking code goes with them rather than being extended.

The incidental CI regression discovered while landing this work is fixed in `514e95b`: a `limit()`
before `repeat()` had consumed its input encounter, but repeat's output layout still declared that
column after the walk stopped emitting it, causing SQLite's “table cN has 2 values for 3 columns”.
Repeat now explicitly drops the consumed encounter, and the generic (bulk fast path disabled)
regression test plus the exact failed L5 seed pass. `mise run ci` was green on this state before the
commit; the code commit is pushed to `trunk`. The preceding documentation commit `4fe7224` is local
at this point and the next push should include this handoff update.

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
  4 queries, and item 3b already identifies it as the easiest equivalence to state — with an L4 pin
  per barrier before the next one. One barrier per commit; do not cash in all 48 at once.
- **3.4** Split `repeat`'s admission control from its lowering (analytics §9·4) — with `flatten` and
  `unroll` carrying the vocabulary, the 296-line function's ~20 admission booleans mostly evaporate,
  so do this *after* 3.2/3.3 and let the deletion be the measurement.

**Exit criteria:** `REPEAT_BODY_OK` deleted; the row-local gate's 8 queries pass; `dedup`-in-`repeat`
pinned in L4; the 5 `until()`/`emit()` barrier traversals throw a deferral naming the platform wall.

### Phase 4 — the read migration (4.1 runs BEFORE Phase 2; see §10·4)

Shape-by-shape, behind the §5a equivalence gate (results + `EXPLAIN QUERY PLAN`) **and the RelIR
differential switch (§10·4)**, in this order:

- **4.1** The row-algebraic class — `limit`/`skip`/`range`/`tail`/`order`/`dedup`/`sample` across all
  11 dispatch tables collapse to `Sort`/`Limit`/`Distinct`/`Window` with a `partitionBy` (§3.2). This
  is where the 11-table dispatch surface actually shrinks.
- **4.2** The block assembler (§5) replaces `TailAcc`; `ELEMENT_DISPATCH` joins the shared substrate.
  This is item 17's declared remainder.
- **4.3** Aggregates and `count` — the ten handlers become one `Aggregate` reading row→traverser
  cardinality off the plan instead of ten handlers knowing it privately.
- **4.4** `recognize` (§4.7): fast paths become plan rewrites.

The shape-interpreting class (materialization, framing, JSON construction) stays per-shape forever
and correctly so; Phase 4 is finished when the row-algebraic class is gone from the shape tables, not
when the shape tables are gone.

**Entry criteria for 4.1 — the two counters, and they are GATES, not reports (§10·4).**

| Counter | What it counts | Instrument | Rule |
|---|---|---|---|
| **Coverage** | corpus traversals routed to the RelIR spine, of 2,298 | a `spine` column on the committed census artifact | a **RATCHET**: the floor can only rise, exactly as L3's does. A number that is merely printed drifts |
| **Deletion** | §8 names still present in the tree | `mise run deletion` — **BUILT, and in `ci`** | a ratchet DOWNWARD; must reach **zero**. Coverage says the new spine works; deletion says the old one is GONE |

**The deletion counter LANDED (`1d8c939`).** `scripts/deletion-check.ts` + the committed floor
`scripts/deletion-ratchet.tsv`, a `ci` dependency. Four things about it are worth recording because
they were decisions, not mechanics:

- **`orphans` was the wrong instrument** and this plan named it by reflex. `orphans` reports an
  export nothing imports, which is a QUESTION — a DI leaf, a registry-resolved service and a
  `.feature` step name all look dead to it, which is exactly why it is not a gate. "Is the thing the
  plan promised to delete still here?" has a right answer, so it can be one.
- **A ratchet, not a zero gate**, unlike `arch`/`lint`/`binds` — it is a countdown and cannot be at
  zero today. Auto-`--record` is safe here for L3's reason and NOT the census's: the counter only
  goes down, so recording can bank an improvement but cannot launder a regression, and a rise is
  refused rather than written.
- **Two measurement kinds**, because §8's list is not uniformly symbols. `symbol` is
  `textDocument/references` including the declaration (0 means the declaration itself is gone, which
  is what deleted means); `pattern` is a regex over `src/`, for the entries that name a SHAPE — "the
  five-copy `count` adapter" is five copies of one expression whose shared callee is staying. That
  row measures **7**, not 5: the analytics doc counted 5 and noted 2 added since.
- **It is generic.** A row is `plan · kind · key · floor · note`; nothing about RelIR is in the
  script. The next migration adds rows.

Opening measurement, 2026-08-02: **110 remaining references across the 15 legacy rows** — `WritePlan`
24, `runFastPath` 14, `TailAcc` 13, `globalRowOps` 10, `appliesWhen` 9, the two adapter patterns 7
and 4, the seven write-path parsers 2–6 each. **The nine rows for RelIR's OWN deleted spellings
(§8's second list) all read 0**, which converts that list from a claim in this doc into a stays-dead
gate: reintroducing `PriorResult` or `Sequence` now fails the build.

Coverage is necessary and deletion is the point. They fail differently, and the second is the one
that stalls while the first looks finished — a traversal can route to RelIR while `write.ts` stays
alive because some other entry point still reaches it. **Coverage at 100% with a non-empty §8 list
is a FAILED migration, not a finished one.**

**BOTH COUNTERS EXIST AND BOTH GATE. The spine landed 2026-08-02 (`fda7e3a`).** Entry criteria for
4.1 are therefore met, and the numbers to beat are **coverage 38/2,298 (1.7%)** and **deletion 110**.

- `src/compiler/rel/lower.ts` is the second lowering: `Step[] → Plan | null`, where `null` is the
  only decline and must stay cheap and total. Coverage today is the element source (`V`/`E`, with
  or without an id list). Small on purpose — the value is the instrument, so every later increment
  is a measured delta rather than a leap.
- `src/compiler/rel/spine.ts` is the routing seam. **The RelIR plan is ONE RELATION to the framing
  layer**: `emitRelational` returns the whole program as a kernel `Expression` and `derived()`
  makes it a `Relation` the existing element projection selects from exactly as it selects from the
  legacy `c0`. Three consequences, all of them the reason to do it this way rather than
  re-encoding framing in RelIR (§7's named risk): binds stay in ONE `render`, so no second
  bind-ordering authority exists; CTE-versus-inline stays the `name` pass's decision (§4.6) instead
  of leaking into the framing `Query`'s `c0…cN` namespace, where two naming schemes would have to
  agree; and no framing code is duplicated, because the payload projection and its `Shape` are
  reached through the ordinary lowering loop with zero steps left — **the two routes frame
  identically BY CONSTRUCTION rather than by comparison.** This is not an opaque escape node and
  does not become one: the traffic is one-way, a finished RelIR relation consumed by framing, and
  nothing legacy ever enters a `Rel`.
- `mise run test:legacy-spine` is the differential — the whole suite with `MOGWAI_RELIR=0` — and it
  is **green**, so the two spines agree on the L1–L5 ladder, the census multisets and the L2
  contract. An ENV switch for `test:perturbed`'s reason: the suite must not be able to see which
  position it is in. **It must pass in BOTH positions**, which is why the one L2 test that pins a
  spine's spelling now pins both, each against the spine that produces it — a differential that
  cannot run green is not one.
- The census `spine` column is the coverage ratchet, with two assertions that fail differently: no
  traversal moves `rel → legacy` (names WHICH shape stopped routing), and the total may not fall.
  **Measured with the RelIR route FORCED ON**, never the ambient switch — otherwise a re-record
  under the differential's off position would rewrite the artifact as all-legacy and the ratchet
  would be measuring the switch instead of the migration.

**Coverage 38 → 51 (`eb71bac`): source-scope filters, and the first place the algebra PAYS.** The
increment was chosen by measurement rather than by convenience — sweeping the corpus for what each
candidate vocabulary would fully cover put `hasLabel`+`has` six times ahead of movement (+54 chains
against +9). The structural finding is not the two steps but where the predicate goes:

- legacy gives every filter its own CTE that re-joins the element table to reach a column its
  predecessor projected away (`c2 as (SELECT n.id, p.bulk FROM nodes n JOIN c1 p ON n.id=p.id WHERE
  EXISTS(…))`), so `has(a).has(b)` is three CTEs and two redundant self-joins;
- RelIR conjoins the run into ONE `WHERE` over one scan, because the plan is DATA and a filter
  changes neither cardinality nor a channel. **Measured on the reference fixture: identical index
  decisions, with one `SEARCH nodes USING INTEGER PRIMARY KEY` step per filter simply absent.**

That is the first evidence that this migration produces better SQL rather than the same SQL spelled
differently — and it is the block assembler (§5) plus a rewritable plan doing it, not a new
optimization. `has(key, P…)` is the next single largest win (72 corpus occurrences) and is its own
increment, because it needs the `P` vocabulary as RelIR expressions — which then serves
`where`/`is`/`filter` too.

**Coverage 51 → 62 (`3f6c2e4`): the `P`/`TextP` vocabulary as RelIR expressions**, in
`src/compiler/rel/predicate.ts`. A module of its own because a predicate is the most reused thing
in the language — `has`, `where`, `is`, `filter`, `not`, an edge criterion and a `by()`-modulated
comparison are one question asked of different subjects — so growing it grows all of them at once.
It is a MIGRATION of `plan.ts`'s `predicateSql`, not a duplicate: that one is deleted with the spine
it serves. Two rules it holds:

- **It never throws.** An op it cannot express declines. `predicateSql` throws and is right to,
  because a throw is the only answer available at that point; here a throw would turn "not learned
  yet" into a support regression.
- **It never answers a DIFFERENT question.** The subtle arm is ordering: a property value stored as
  TEXT because it does not fit a numeric storage class (a long past 2^53, a bigint, a bigdecimal, a
  duration) orders LEXICALLY under a plain `>`, and after every numeric row. The four range ops go
  through the vtype-aware `compareKey`, passed in as a `compare` parameter because only the caller
  knows where the `vtype` column lives.

**A FAST PATH IS NEVER SILENTLY DROPPED — the general rule this increment establishes, and it
belongs in §7's risk table as much as here.** `has(k, containing(t))` routes through the
`property_fts` trigram index. Expressing it in RelIR as a base-table LIKE scan would be a
performance regression **the census cannot see** — same rows, same status, same digest — while the
coverage counter reported it as progress. So a substring `TextP` over a stored property DECLINES,
costing 7 of the 18 traversals this increment would otherwise have banked, until §4.7 makes the
fast paths plan rewrites. Two corollaries worth keeping: coverage measures whether the new spine can
EXPRESS a traversal, never whether it should take it from a specialized lowering; and the decline is
a function of the CHAIN alone, never of the `fastPaths` config, because spine choice and fast-path
choice must stay independent.

One defect found by the port and worth recording as a class: `likePattern` crashes on `P.not(…)`
(`op.startsWith('not')` with no fourth character to lower-case). It is latent in `plan.ts`'s copy
and unreachable there because every other op is handled first — so re-expressing a function in a
context that calls it more generally is itself an instrument.

**Coverage 76 → 86 (`de5172a`): `is(P)` past the shape boundary, and a measured bind wall closed
with it.** Re-measured from the new base, `is` had jumped to **+53** — the largest single win left,
because `count().is(…)` and `values().is(…)` only become reachable once the terminal they follow is
covered. Two increments earlier the same step was worth ZERO, which is the whole argument for
re-measuring every round rather than working down a fixed list. The step is a `Filter` over the
scalar relation using the SAME predicate module the source filters use — the payoff for building
`P`/`TextP` as a module rather than a `has`-shaped helper.

**The wall, and why it is worth recording rather than working around.** Fusing a `Filter` into its
input's block means the input's outputs are spelled as the EXPRESSIONS that compute them (§5) — SQL
leaves no choice, since a `WHERE` cannot name a select alias — so each `is` re-inlined the whole
projection. With the vtype-aware ordering `CASE` in play that is ~20 binds apiece: measured **25 /
45 / 65** for one, two and three range predicates against legacy's 2 / 3 / 4, and a fourth would
have exceeded the DO 100-parameter cap and **failed closed where legacy answers**. Not a wrong
answer — a support regression, which is the class this repo gates for. `Materialize` is the declared
remedy (§3.3, *"a boundary hint … where the planner needs a fence"*) and lands the same
CTE-then-filter shape legacy emits: **16 / 38 / 50**, linear, and shorter SQL than legacy in every
case. Pinned as a test, because the failure mode is a plan that stops executing rather than one that
answers wrong.

What remains is **~13 binds per ordering predicate** — `compareKey`'s fixed type vocabulary, which
the legacy emitter splices as SQL TEXT and RelIR cannot, because `Lit` renders as a bind by
construction (§3.2). That is exactly the trade the rule was made for: a `check` that can PROVE the
DO cap, paid for in binds a hand-written emitter would have inlined. It is linear and bounded, and
the first thing to revisit if a real traversal ever approaches the cap.

**Coverage 86 → 112 (`5bb86db`): MOVEMENT.** The nine adjacency steps as one direction table —
which edge column matches the incoming id, which one the outgoing id comes from. `both`/`bothE`/
`bothV` get no special case beyond being two entries, `UNION ALL` because traversers are a
multiset. `otherV` declines: it reads the entering vertex a preceding edge step retained, which is
carried state this route does not model, and a movement that quietly forgot which end it came from
is a wrong answer. It also carried §3.5's open question to its answer — see the note in Phase 1
above.

**`movementCollapse` is the ONE fast path this route EXPRESSES rather than declines, and the
difference from the FTS case is the whole rule, not an exception to it.** Routing a substring
predicate through a base-table scan would LOSE an index seek the legacy spine performs — a
different physical access path, which RelIR cannot state. The collapse is a plan REWRITE the
algebra states exactly (a grouped `SUM(bulk)`), so expressing it keeps the optimization AND keeps
the switch meaningful: L5's differential still has two positions to compare on a RelIR-routed
traversal, where declining would have left it comparing legacy against legacy. Two details worth
keeping:

- **The flag arrives already CHAIN-GATED** (`collapseSafeFastPaths` runs before the engine is
  built), so the route inherits legacy's safety analysis for free rather than re-deriving it. That
  is why every collapse-unsafe chain agrees on the first run rather than after a round of fixes.
- **Reading the flag does not make spine CHOICE depend on it.** Coverage is identical either way;
  what the chosen spine emits is what changes, which is what a fast-path flag is for.

**Coverage 112 → 117 (`3a8a2dd`): `where`/`filter`/`not` over a traversal body — the correlated
child seam.** The body folds through the SAME movement and filter vocabulary as the outer chain,
which is why movement had to land first and why this cost so little once it had: `sourceFilter`
already returns an `Expr`, so an existence test slots in beside `has` and `hasLabel` at every
position they work at.

**No seed node, and that was the design question.** Legacy writes `(SELECT n.id AS id) p` — a
projection with no input, which RelIR has no node for. §7's bar says a missing kind needs proof the
seam cannot EXPRESS the shape, and it can: compare the edge column to the outer id directly. One
derived table FEWER than the form it replaces, and it costs one parameter on the movement builder —
a hop starts from an id-RELATION (joined) or a correlated id EXPRESSION (compared), both producing
the same `(id, bulk)` shape, so every hop after the first is the ordinary one and there is no second
movement implementation. `not()` is `NOT EXISTS`, not legacy's `NOT COALESCE(EXISTS(…), 0)`: an
EXISTS is never NULL.

**A REFINEMENT of the fast-path rule, which reads like its opposite and is not.**
`predicateInlining` selects between two LOWERINGS of a `where()` body: the correlated `EXISTS`, and
a materialized child-existence gate (pushed ordinal, `LEFT JOIN`, rejoin). RelIR implements the
first, so with the switch off it declines — exactly as it declines an unlearned step. The FTS rule
said spine choice must not read the flag; the distinction is *what the flag names*. There it named a
physical ACCESS PATH RelIR cannot state at all, so reading it would have been using the spine switch
to dodge an optimization. Here it names two STRATEGIES and RelIR covers the side it implements,
which is ordinary coverage — both positions stay live and L5 still compares two forms.
`movementCollapse` is the other side of the same coin: RelIR states BOTH forms, so it covers the
traversal either way and the flag only changes what it emits.

+5, well under the +38 the sweep predicted, because most corpus `where` bodies also use
`as()`/`select()` or an alias comparison — carried state this route does not model yet. The
structure is the deliverable, not the number.

**NEXT, measured from base 259** (`V`/`E`/`hasLabel`/`has`/`count`/`values`/`is`/movement/`where`):
**the row-algebraic class is +50 and it is literally Phase 4.1's named deliverable** — `order` 20 ·
`dedup` 11 · `limit`/`range`/`skip` 2 · `identity` 2, and together with `tail`/`sample` fifty. The
only comparable is `as` + `select` at +49, which needs the alias channel. Two things known about
4.1 before it starts: on an ELEMENT stream these steps are fused into the framing projection by
`TailAcc`, so a `Sort`/`Limit` on the CORE relation is a different plan (the framing join is 1:1 on
`id`, so it is equivalent — but that is an argument to verify, not to assume); and `order` needs the
`encounter` channel, which is the first carried role beyond `bulk` this route will model.

**Coverage growth, measured over the 2,298-traversal corpus.** Cumulative chains fully covered as
each step name is admitted, so an increment can be chosen by what it BUYS rather than by what looks
next: `V`/`E` 41 · `+hasLabel` 51 · `+has` 95 · all six movement steps + `inV`/`outV`/`otherV` 104 ·
`+count` 118 · `+values` 150 · `+dedup` 163 · `+order` 187 · `+select` 233 · `+where` 272 · `+is` 351
· `+filter` 366. (Measured with no bound parameters, so it excludes the 381 `unbound` rows; the
census column is the real number.)

**MARGINAL value is the number to choose the next increment by, and it MOVES — re-measure every
round.** From `V`/`E`/`hasLabel`/`has` it read: `+values` 19 · `+where` 16 · `+movement` 9 ·
`+count` 9 · `+valueMap` 7 · `+order` 5 · `+hasId` 3 · `+limit`/`range`/`skip` 2 · `+fold` 1, with
everything else — `id`, `label`, `dedup`, `identity`, **`is`**, `not` — worth **zero alone**. Two
increments later, from `V`/`E`/`hasLabel`/`has`/`count`/`values`, `is` was worth **53**: it had been
gated behind the terminals it follows. So a step worth nothing is not a step worth nothing NEXT
round, and a fixed worklist would have missed the largest win twice over.

**Current marginal values, from base 123** (`V`/`E`/`hasLabel`/`has`/`count`/`values`/`is`):
`+where` 38 · `+movement` 27 · `+order` 11 · `+valueMap` 7 · `+hasId` 5 · `+limit`/`range`/`skip` 2 ·
`+dedup` 1 · `+fold` 2 · `id`/`label`/`identity` 0. **`movement` + the row-algebraic class together
is 66** — and movement is the one that unblocks `where`, since most `where` bodies are movements.

**LANDED (`986b056`): the shape boundary, coverage 62 → 75.** A lowering now returns a
`RelFraming` — a UNION, not a widened record, because an element stream has no scalar type and a
scalar stream has no element kind, and pretending otherwise is how a shape vocabulary starts leaking
into the algebra. `spine.ts` switches on it TOTALLY, so a stream kind the lowering learns to produce
is a compile error at the seam until it knows how to frame it; the channel → `TraverserLayout`
translation likewise fails closed on a role it cannot express rather than dropping one. `count()` is
`SUM(bulk)` read off the carried channel (not `COUNT(*)`, which is only equal while bulk is 1
everywhere) and is a barrier, so no channel survives it — `barrierChannels` says that already. A
`values(k)` is a JOIN and not an `EXISTS`, because it emits one traverser per matching property:
multiplying the row is the answer here and the bug in a filter. A new test asserts `Compiled.shape`
agrees across spines at the boundary — rows agreeing is NOT enough there, since right values under
the wrong shape round-trip as the wrong GraphBinary type with every row assertion still passing.

**A LIVE SILENT WRONG ANSWER, found by porting `values` — and CLOSED in `514e5ce`, L3 1696 → 1701.**
Both spines read only `args[0]`, so `g.V().values('name','age')` returned just the names and
`g.V().values()` bound `null` and returned nothing at all. Right arity, plausible rows, no test
failing — the census recorded them as `ran` and compared them against a baseline recorded from the
same defect, which is exactly the blind spot its README documents. Four census rows changed answer,
every one from wrong to right:

| traversal | was | now |
|---|---|---|
| `g.V().values("name","age").is(P.typeOf(GType.INT)).math("_ + 1")` | 0 rows | 4 |
| `g.V().values("name","age",null)` | 6 rows (names only) | 10 |
| `g.V().values().order()` | 0 rows | 12 |
| `g.withoutStrategies(…).addV(…).property(…).property(…).values()` | 0 rows | 2 |

**Fixed in BOTH spines in one commit, deliberately.** Landing the correct answer only in RelIR would
have put `mise run test:legacy-spine` permanently red against a defect instead of closing it, and
the differential is only worth having while it can be green. That is the general rule for a defect
the migration exposes: **fix both sides, or decline in RelIR — never let the two disagree on
purpose.**

The mechanism is worth more than the defect: **re-expressing a lowering in a second algebra is
itself a defect instrument.** Three so far, none reachable by any test in the suite —
`likePattern` crashing on `P.not`, `values(k…)` reading `args[0]`, and (below) a child scope
inheriting the parent's `fromV`.

**That L5 finding is now FIXED (`d4fbf0d`), and the fix is the fourth defect this migration
surfaced.** `withoutFromV` — the `withoutPath` of the entering-vertex context, written next to it
for the same reason: `trackFromV` is a demand of the chain THAT ASKED, and a child scope is a
different chain. Two things the attempt got wrong first, both worth keeping:

- **Both halves must go together.** Clearing the `fv` COLUMN alone leaves `trackFromV` set, so the
  first edge step in the body mints it again and the refusal returns one step later.
- **The distinction is NOT "does the body mention `otherV()`" — it is whether the child's rows
  BECOME the traverser.** `g.V().local(__.bothE('created').limit(1)).otherV()` names no `otherV()`
  in its body, yet its rows are handed on and the outer chain reads the `fv` that body's own edge
  step has to mint. Getting it backwards cost four L3 scenarios, which is how it was caught. Only an
  existence gate may drop the context, because nothing of the child survives the `EXISTS` — so the
  flag is `resultEscapes`, false at `tryCompileElementValueRows`, measured to be the sole entry both
  `where`/`not` gates use.

Two L4 scenarios pin it, one per side of that distinction (`child-scope-entering-vertex.feature`).

**The original filing, kept because the diagnosis is the method (`known.ts`, `514e5ce`).** With `predicateInlining` off, a
`where()` child containing `union()` THROWS `otherV() context through union() not yet supported`
where the inlined route answers — the worst shape the switch can find, since the generic path is the
semantic authority and cannot compile what its accelerator can. Diagnosed: the outer chain's
trailing `.outE().otherV()` sets `trackFromV` at the source, `pushChildScope` projects the parent's
carried columns verbatim, and `assertForkSafe` then refuses the child's own `union()` for state
belonging to a traverser the child is not part of. `withoutPath` — one line away in the same file,
and written for exactly this reason about the path — is the precedent for the fix. It is not a
one-liner (`childExistenceGate` projects the parent layout back off `child.frame.domain`, so the
column must stay in the DOMAIN while the child SEED stops claiming it) and it is in the machinery
owning the 33% defect category, so it is recorded with its diagnosis. **Reached by a NEW SEED**: L5
derives its seed from `HEAD`, so every commit draws a different generated corpus — which means a
local `mise run ci` green before a commit does not prove the commit itself green, and is the
strongest argument yet for item 0d's rotating seed gated by witness ratchets.

**The superseded next-step note (kept because the reasoning is the method):** `values` and `count` are worth
28 together and 28 apart is impossible, because both cross element → scalar: the framing bridge in
`src/compiler/rel/spine.ts` builds an `ElementStream` and nothing else. Making it carry the
lowering's output STREAM KIND is the substrate, and it is what every scalar-shaped terminal then
rides on. Two things already known about that increment:

- `count` is `Aggregate` with `SUM(bulk)` over the source, which is where §3.5's recorded open
  question first bites — a reducing aggregate is a barrier and `BARRIER_ROLE_POLICY` drops `bulk`,
  yet movement's bulk coalescing must KEEP carrying it. `count` consumes bulk rather than carrying
  it, so it does not need the answer; movement will.
- `movementCollapse` is a `FastPath` and fires on a collapse-safe chain (reducer-terminal, pure
  movement/filter). Under the rule above, movement declines on exactly those chains until §4.7 —
  which means `g.V().out().count()` stays legacy even once both halves are covered.

Two smaller facts worth not re-deriving. `Compiled` gained a `spine` field: it is a compile FACT,
not instrumentation, and `readCompiled`'s default of `'legacy'` is a statement about who calls it
rather than an unknown. And relation ids are minted PER LOWERING — a module-global counter made two
compiles of one query emit different SQL depending on compile order, which would have broken every
snapshot and any text-keyed cache, only under a particular ordering.

---

## 7. Risks, named, with the response

| Risk | Response |
|---|---|
| **Re-encoding, not simplification** — 11 shape tables become 11 shape-aware plan builders | Phase 1's exit criterion (§5a, over real L2 traversals) catches an inadequate model before integration; Phase 4.1 is measured by *dispatch entries deleted*, and if that number is not falling the phase is failing |
| **SQLite is the optimizer** — a mid-end that costs plans duplicates its work | RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no statistics, no join reordering.** A cost-based rewrite is out of scope permanently, not merely for now |
| **L3 delta ≈ 0 makes regressions invisible** | The census is the gate on every phase, and §5a (same results + same `EXPLAIN QUERY PLAN`) is the gate within Phases 2–3 |
| **The layout contract erodes during migration** | §3.5's per-node obligations are `Record<keyof TraverserLayout, …>`, so a new node or role fails the build until declared — the same enforcement the two existing tables already have |
| **Scope creep into a general query engine** | The node set in §3 is closed. Adding a kind requires the same bar as a new substrate today: show the seam cannot EXPRESS it, not that it cannot be HANDED it |
| **DO-only walls (`RETURNING`, `ON CONFLICT`)** | `test:cf-limits` gate before Phase 2 ships (§1) |
| **A fast path silently dropped by the new route.** A RelIR lowering that expresses a shape a `FastPath` already specializes is a PERFORMANCE regression no gate here can see — same rows, same status, same census digest — and the coverage counter reports it as progress. Found live: `has(k, containing(t))` routes through the `property_fts` trigram index, and the RelIR predicate vocabulary can express it as a base-table LIKE scan | **The covered shape DECLINES until §4.7 makes that fast path a plan rewrite.** Coverage measures whether the new spine can EXPRESS a traversal, never whether it is entitled to take it from a specialized lowering. The decline reads the CHAIN only — never `fastPaths` — so spine choice and fast-path choice stay independent, and it is pinned by name in `test/rel-spine.test.ts` rather than left to be noticed |
| **Losing W1/W4's landed gains in the rewrite** | W1's four L4 pins and the perturbed census are Phase 2 exit criteria, not afterthoughts; P5b makes emission-ordered id assignment structural rather than incidental |
| **Rebuilding the driver abstraction inside RelIR** | W2/W3's blockers are listed as *dissolving*, with an explicit "do not build a driver abstraction" (§6 Phase 2). If Phase 2 grows an `ElementReadDriver` analogue, it has failed |
| **THE BIG ONE — the dual spine goes permanent.** Coverage reaches 80–90%, the remaining traversals are the awkward ones, the legacy route still works, and the migration quietly becomes an architecture with two engines in it forever | §10·4 is written to make that outcome legible rather than comfortable: two ratcheted counters, a deletion list that IS the exit, and an explicit statement that a stalled countdown is a failure with a name. **The pressure runs the right way and must be kept that way** — the legacy path's only remaining value at 100% coverage is being the differential's off position, so there is no engineering reason to keep it and no honest way to claim there is |

---

## 8. What this deletes

**This list is the EXIT CRITERION, not a wish list.** It is the second of §10·4's two counters, it is
checked by **`mise run deletion`** against the committed floor in `scripts/deletion-ratchet.tsv`
(which IS this list, machine-readable), and the migration is over when every floor is 0 and not
before. Every name below is a promise the plan has made; leaving one alive is the plan failing,
however good the coverage number looks beside it. **Editing this prose without editing the ratchet
file changes nothing** — the file is the gate, this section is its rationale.

The measure of success, stated up front so it can be checked rather than claimed:

`expandRepeatBody` · `REPEAT_BODY_OK` · `runWriteChainFull` · `parseEdgeCluster` · `parseVertexSpec` ·
`parseMergeOptions` · `resolveEndpoint` · `materializeElementDrivers` · `WritePlan` · `TailAcc` ·
the five-copy `count` adapter and the four-copy `where` adapter · the row-algebraic half of 11
dispatch tables · the recognition-vs-support split in the fast-path layer.

Two second implementations of the traversal machine, one accumulator that exists only because
fusion had nowhere to happen, and the majority of a 11,201-line directory.

**And a second list, of RelIR's own — the parts of it that the 2026-08-02 decisions delete** (§10),
because a new layer accreting duplicate spellings is the same failure one layer in:
`Sequence` · `PriorResult` · `Param` · `returningType` · `Distinct.on` · `Delete.using` · the `Naming` side-table ·
`emitStmt`/`emitSequence` as separate entry points · the statement-only `externalAliases`/`bareColumns`
back channels · fifteen hand-written walkers (done, `5fd7c10`) · `sameLayout`-by-`JSON.stringify`.

---

## 9. Constraint audit — 2026-08-02

The plan changed under construction, which is fine; the **architectural constraints did not**, and
several were broken silently while the Progress entries above read as green. Every row was measured
against `HEAD` (877 lines of `src/rel/`, 27 passing tests, `check`/`lint`/`arch`/`binds` all clean),
so this is a record of where the build diverged from its own rules — not a re-litigation of RelIR.

**A constraint that cannot be kept is a design discussion (§10), never a quiet substitution.** Two of
the rows below were substituted rather than raised, and that is the process defect this section exists
to close. §10 now records the resolutions — and two of the constraints did not survive the discussion:
byte-identical SQL and "never redesign the layout contract" were both cost-avoidance, and both are
gone. A constraint is kept because it is right, not because it is written down.

| # | Constraint | What landed | Status |
|---|---|---|---|
| 9·1 | Phase 1's equivalence gate over ten L2 traversal **families** | ten node kinds pinned against the emitter's own output; no L2 expectation referenced | **CLOSED** (`38a58ba`): `test/rel-l2-equivalence.test.ts`, eleven families, mechanical on both sides. It found a `Union` emitting invalid SQLite and a missing `vertex_labels` table on its first run |
| 9·2 | §5 "the emitter is total — an unrenderable node is a compile error, not a runtime throw" | `Param` and `PriorResult` are constructible and `throw` at emission | **CLOSED** (`3057e89`): `Param` is deleted, `PriorResult` is `Ref`, and every `Ref` renders — a `Rel` binding as a CTE name, a `Stmt` binding as `json_each` over one JSON bind. No relational arm throws |
| 9·3 | §3.4 "the plan is a **DAG**; a node referenced twice is shared" | `fuse`/`prune` rebuilt per parent occurrence with no memo — measured: `left === right` true before `fuse`, false after, and `name` then named the wrong node | **FIXED** (`0ca0cd8`): one memoised `rewrite` in `walk.ts`; `prune` is now two-pass, taking each node's need as the UNION over consumers |
| 9·4 | §4 "total, order-declared, mirroring the existing `Pass` pipeline's discipline — no switch growth" | 15 hand-written walkers (7 over `Expr`, 8 over `Rel`); 13 carried a `default:` arm, so a new node kind was silently skipped by the bind budget, recursive-term legality, pruning and sharing | **FIXED** (`5fd7c10`): `src/rel/walk.ts` declares the structure ONCE, with no `default` anywhere, so `noImplicitReturns` makes a new kind a compile error. It also closed two live holes the old walkers shared: an `Agg`'s `orderBy` and a `WindowExpr`'s `partitionBy`/`orderBy`/frame bounds were reached by NO analysis, so a `Lit` in a partition key was not counted against the bind budget |
| 9·5 | §3.5 per-node layout obligations as a `Record`, "so a new node or role fails the build until declared" | no such table existed; `Join` had NO layout check at all, nor did grouped `Aggregate`, `Values`, `Scan`, or `Explode`'s output schema | **FIXED** (`80e8cd3`): `src/rel/layout.ts` — `Record<RelKind, LayoutObligation>`, executable and run by `check`. Includes §3.5's left-join rule (a rigid channel may not arrive from the nullable side) and extends the barrier contract to any reducing `Aggregate`, not just `groupBy: []`. `check` gained a second total table for expression PLACEMENT, with an arity assertion so a kind cannot forget one |
| 9·6 | §2 `src/rel/` imports nothing from `src/compiler/` | the layout imports were concentrated in `src/rel/layout.ts` plus `passes/prune.ts` | **CLOSED** (`25e0b5f`): decomposed into the neutral channel core `src/channels.ts`, and **`mise run arch` now gates the boundary** — a textual import scan, because a clean-room breach is a dependency edge and is visible in the import statement itself |
| 9·7 | §3.3 `Scan` is the only physical-schema node | `'id'` was hardcoded in the emitter's delete membership and in `check`'s `Delete.using` rule | **CLOSED** (`bedf49e`): `using` is `{ rel, key }` — the factory rejects a source that does not emit the key, `check` rejects a target that does not declare it. The `Table` union was also incomplete (no `vertex_labels`), which §9·1's gate found and `38a58ba` fixed |
| 9·8 | §3.6 the bind budget is a plan property with `RowBatch`/`json_each` as the remedy | `check` failed closed above 100 binds with no JSON-bind form, so a legitimate large `Values` was refused rather than lowered | **CLOSED** (`3057e89`, `bedf49e`): a statement's retained rows land as ONE JSON bind (`RowsBind`), and `passes/land.ts` lowers an over-budget `Values` the same way. A row holding anything but a `Lit` has no compile-time JSON, so the pass declines it and the budget still fails closed |
| 9·9 | Phase 0 "clear the deck… worth doing first" | 0.1 not done (`globalRowOps` still has 5 refs; `ELEMENT_DISPATCH`/`SCALAR_DISPATCH` do not use it); 0.2 partly done (61 → 21 sites) | **0.1 is now WITHDRAWN as obsolete** and 0.2's remainder is a different family — see the two paragraphs below the table |
| 9·10 | §5 "the **unchanged** `q` kernel" | kernel gained `identifier()` | **amended** in §5: additive-only is the rule, and this addition qualifies. The block assembler needed nothing further from the kernel |

**9·9 resolved, 2026-08-02 — 0.1 is withdrawn, and the reason generalizes.** The §6 Phase-0 entry
already records that the element half of 0.1 is wrong: `limit`/`skip`/`range`/`dedup`/`order` are not
missing from `ELEMENT_DISPATCH`, they are in `TailAcc`, which FUSES them into one projection.
Re-measured for the scalar half and it is the same fact with a different mechanism: `SCALAR_DISPATCH`
does not carry them because `lowerScalarRows` consumes the whole row run first
(`tail/scalar.ts:74` — `SCALAR_TRANSFORMS + is/limit/skip/range/tail/order/dedup`), and it carries
BOTH the root form and the correlated per-origin form (`partitionedSlice`, `partitionedOrder`,
`partitionedTail`, `rankedRows`). So spreading `globalRowOps` over either of the two largest tables
would replace a fusion with an op-per-`reprojectRows`, in both cases. **0.1's whole premise — "45 of
94 dispatch entries are un-shared duplication" — counts a table's ABSENCE of an entry as duplication,
when in both tables the absence is a fusion.** The genuine finding underneath it survives and is
Phase 4.1's: those two fused accumulators and `globalRowOps` are three spellings of `Sort`/`Limit`/
`Distinct`/`Window`-with-a-`partitionBy`, and the scalar half's `partitionedOrder` is the clearest
existing evidence that `partitionBy` (§3.2) is the missing parameter. Phase 0 no longer blocks
anything; `globalRowOps` stays on the §8 list, where it was already.

**0.2's remainder is a DIFFERENT family and is not a rename-safety risk.** 61 → 21 closed the tagged
-argument family the item names (`isNested` ~27, `isTokenArg` ~20) and the 15 guards in
`gremlin/frontend.ts` cover it. Of the 21 left, 11 are `'op' in x` — the `P` predicate structural
test, which has no declared type and so no guard to reach for — and the other 10 are one-off shape
probes (`'items'`, `'entries'`, `'injVal'`, `'p'`, `'vertex'`). Neither set is a field a rename would
move silently under a `TaggedArg` union, which is what 0.2 was protecting. An `isPredicate` guard
over the 11 is worth having on its own merits; it is not a prerequisite for anything here.

Four defects the checker was supposed to make impossible, each found with a measured failing case and
each now fixed with that case pinned as a test:

- **`Distinct{on}` conflated a dedup key with a projection** — `distinct({type:(id,name), on:[name]})`
  emitted `SELECT DISTINCT n.name`, one column where two were declared, and a consumer of `id` failed
  at runtime with `no such column`. **`on` is removed** (`e3f3a8a`); see the §3.3 row.
- **A derived relation is aliased by its `RelId`, so a self-join emitted one alias twice** —
  `… INNER JOIN (SELECT * FROM r0) m ON (m.id = m.id)` → `ambiguous column name`. Fixed as a
  CONSTRUCTION error rather than by auto-aliasing (`c4bce7f`): a `Join`'s sides must be distinct
  relations, because `Col{rel}` cannot say WHICH occurrence it means. A replicated subplan — what
  `unroll` produces — must carry fresh ids, and now finds that out at `check` rather than in SQLite.
- **`RelId` uniqueness was an unstated invariant** — `check`'s scope was last-write-wins, so two
  same-id relations misattributed a column rejection and, with matching column sets, would have
  resolved silently. Binding two different relations to one id in a scope now fails closed.
- **`name` could mint a colliding CTE name**: generated `r0…rN` did not reserve explicit `Materialize`
  names (measured `["r0","r0","r1"]`). Fixed in `0ca0cd8`.

One altitude finding, not a constraint breach: **declare-and-verify where the project's own pattern
says derive.** `Project.type` vs `exprs`, `Window.type` vs `input + specs`, `Recursive.cols` vs `type`,
`returningType` vs `returning`, `PriorResult.type` vs the prior step's — each checked in its factory
AND re-checked in `check`. Names and arity are fully derivable; only `SqlType`/nullability are not,
which argues for a `typeOf(expr, scope)` rather than a hand-passed `type`
(`docs/2026-07-28-scalartype-refactoring-pattern.md` is the template).

---

## 10. Decisions of record — 2026-08-02

One stated principle governs all of these: **take the cleanest solution for each thing, and treat a
constraint that only exists to avoid cost as a candidate for deletion.** The suite is the safety net
(L1–L5 + the census + the perturbation instrument) and there are no users, so the bar is *cleanest*,
not *smallest diff*.

10·1–10·3 settled the audit's three open questions, and two of those three "constraints" turned out
to be pure cost-avoidance. **10·4 is the one that governs everything after them** — how Gremlin
reaches RelIR, and the contract that the migration finishes. 10·5 settles the row-transport rule by
measuring it on the runtime we ship to. 10·6 applies 10·4's discipline inward, to RelIR's own
duplication.

### 10·1 — DECIDED and LANDED (`b199a5f`): the emitter assembles a SELECT block (§5)

The IR stays normalized, one operator per node, and the emitter converts to SQL's clause-slotted
`SELECT`. Refused: a `Select` mega-node produced by `fuse`, which would put the SQL surface inside the
IR, re-open the closed node set, and give every pass two forms of the same thing to handle.
Consequences already written into the plan: §5 (the assembler), §4.4 (`fuse` shrinks to semantic
rewrites), §4.2 in Phase 4 (the assembler, not `fuse`, deletes `TailAcc`).

**And the gate went with it.** Byte-identical SQL is deleted from this plan, everywhere, in favour of
§5a — same results plus same `EXPLAIN QUERY PLAN`. It was against `test/CLAUDE.md`'s own rule, it was
unreachable for the emitter as built, and an unreachable gate is what invited 9·1's substitution.

### 10·2 — DECIDED and LANDED (`3057e89`): the top of a plan is a program (§3.0)

`Plan { bindings, result }`, `Binding { name, node: Rel | Stmt }`, and one `Ref` node. `Sequence`,
`PriorResult`, `Naming`-as-a-side-table and `returningType` are all deleted: they were four spellings
of two concepts. `Param` is deleted outright — the front-end resolves wire parameters into `Step.args`
before the IR exists, so nothing downstream could construct one.

The load-bearing rule that comes out of it: **effects are legal only at a binding.** `Rel` positions
stay pure, so a `Stmt` cannot be a `Join` input — a type-level fact rather than a checker rule. This is
what makes `union(__.addV(), __.V())` plan composition instead of a driver, and it closes the paused
2.1 handoff, 9·2 (emitter totality) and 9·8 (the bind remedy) together.

Refused: an executor inside `src/rel/` that special-cases statement sequences. That is what the
three-entry-point emitter (`emit`/`emitStmt`/`emitSequence`, with statement-only `externalAliases` and
`bareColumns` back channels) was drifting toward, and it rebuilds write as a special case in a new
layer. The executor lives outside `src/rel/`; RelIR supplies the passes.

### 10·3 — DECIDED and LANDED (`25e0b5f`): `TraverserLayout` is decomposed, not imported (§2)

The plan's "import it verbatim, never redesign it" rule is withdrawn — it was cost-avoidance, and the
thing worth protecting is the *guarantee* (two total `Record<role, policy>` tables encoding the 33%
defect category), not the struct. Measured, RelIR needs only which columns are channels and each
channel's merge and barrier policy; it needs nothing of `AliasShape` or `PathState`'s `Elem`, which are
read only by `match`/`filter`/`labelselect`/`select`/`child-shape` and `branch`/`movement`
respectively. So the boundary is a vocabulary boundary: a neutral **channel core** both sides import,
with the Gremlin-specific detail staying in the framing layer. Full statement in §2.

Refused: making every RelIR node generic in an opaque layout type `L` (a large type-level cost on every
node, factory and pass, for a dependency that is a vocabulary rather than a behaviour), and simply
accepting the import (which would keep `src/rel/` untestable without the compiler).

### 10·4 — DECIDED 2026-08-02: ONE SPINE. The dual spine is a harness with an end date.

**The decision.** Gremlin reaches RelIR through a SECOND lowering that grows step by step. A
traversal whose every step is covered routes RelIR end-to-end; anything else routes to the legacy
spine. Never mixed inside one traversal, so no opaque node ever exists and RelIR stays a real
algebra rather than a wrapper. `RelIR on` versus `RelIR off` becomes a **differential switch**, which
makes the whole 2,298-traversal corpus plus L5's generated ones the oracle for every increment —
strictly stronger than §5a's eleven hand-built families, and the instrument already exists.

**Refused, with the reason each fails.**

- *An opaque escape node* wrapping the legacy spine's `{sql, binds}` as a RelIR leaf. §7's bar is
  exactly right: the seam CAN express these relations, we simply have not written the lowering yet.
  A node kind added because the work is unfinished never gets removed. **No opaque node, ever — not
  as a bridge, not "temporarily", not behind a flag.**
- *Retargeting the existing spine in one movement* — `Query` becomes a `Plan` builder, `Relation`
  becomes a `Ref`, every StepFn returns `Rel` nodes. This is the cleanest END STATE by a distance,
  and the honest observation behind it is that `Query.ctes` already IS `Plan.bindings` with the data
  thrown away. Refused **not on principle but because it is un-instrumentable**: 163 `q.cte` sites
  convert at once, there is no "off" position, so no differential can catch a mistake and no
  intermediate state is green. That is the one thing this codebase's method depends on.

---

**THE DUAL SPINE IS A HARNESS, NOT AN ARCHITECTURE. IT HAS AN END DATE.**

The end date is the moment the legacy spine is deleted, and that deletion is a STEP OF THE PLAN, not
an afterthought someone gets to later. The routing switch is deleted with it. Everything in §8 goes.

**Leaving the legacy route in place is the failure mode, not the fallback.** It will not announce
itself. It arrives as a series of individually reasonable decisions: coverage reaches 85%, the
remainder are the awkward traversals, the legacy path still works, nothing is broken, and the next
piece of work is more interesting than the last 15%. A year later the project has two engines, twice
the surface, and every future change costs double — which is precisely the condition
[codebase-analytics](./2026-08-01-codebase-analytics-and-blue-sky-restructure.md) §6 diagnosed and
this whole plan exists to end. **Stopping at 90% does not bank 90% of the value. It banks a
liability.** The one thing worse than not starting this migration is starting it and not finishing.

So, explicitly:

1. **No permanent exceptions.** A traversal may be routed to legacy for exactly one reason: the
   RelIR lowering does not yet cover a step in it. Not "this one is hard", not "this one is rare",
   not "this one is fast enough already". There is no allowlist and no committed exception file. If
   a shape genuinely cannot be expressed, that is a §3 node-set discussion under §7's bar, recorded
   in this section — never a quiet second route left running.
2. **Both counters ratchet.** Coverage can only rise; the §8 deletion list can only shrink. A ratchet
   is what stops a report from drifting, and it is why L3 and L5 are ratcheted rather than printed.
3. **A stalled countdown is a defect with a name**, reported like any other — not an ambient
   condition. If coverage has not moved in a phase, that is the finding of the phase.
4. **Coverage at 100% with a non-empty §8 list is a FAILED migration.** The new spine working is not
   the same fact as the old one being gone, and only the second one ends this.
5. **The last step costs something, and it is accepted here in advance.** Deleting the legacy spine
   deletes the differential's off position, so the RelIR differential dies with it. That is a
   one-time, deliberate trade at the point where the thing being compared against is dead code; what
   remains is L5's METAMORPHIC oracle — which never needed two implementations — plus the census and
   the L1–L4 ladder. Nobody may use "but we would lose the differential" as a reason to keep the
   legacy spine alive. The differential is scaffolding for the migration, not a load-bearing test.

**Order.** Reads first, because writes consume them (§6's re-order): `4.1` → `2` → `3` → `4.2–4.4`.
Phase 2's W2/W3 acceptance criteria are unaffected; they simply happen later.

### 10·5 — DECIDED 2026-08-02 BY MEASUREMENT: one value, never N parameters

`§3.6` said a large row set lands as one JSON bind exploded by `json_each`; the root `CLAUDE.md`
said a WRITE chunks through `src/rowbatch.ts`. **Measured, and the answer depends on which runtime
you ask — which is the whole point.**

The comparison `rowbatch.ts` cites is chunked binds against **INLINED LITERALS** (4.6×, 38 ms vs
176 ms for 20,000 rows). That comparison still holds and inlining is still wrong. The comparison
that had never been run is chunked binds against **ONE JSON BIND**, and it was run on both runtimes
— Bun via `bun:sqlite`, Cloudflare via a throwaway DO under `wrangler dev` (local workerd), the same
harness `test/cloudflare.test.ts` already uses. Median of 7, 20,000 rows of 3 columns:

| | statements | Bun | **DO (workerd)** |
|---|---|---|---|
| INSERT, chunked at `floor(100/3)` | 607 | **12 ms** | 42 ms |
| INSERT, one JSON bind + `json_each` | 1 | 20 ms | **20 ms** |
| DELETE by id set, chunked at 100 | 200 | **20 ms** | 13 ms |
| DELETE by id set, one JSON bind | 1 | 21 ms | **8 ms** |

**The direction REVERSES between the dev runtime and the production one.** On Bun the chunked form
wins by ~1.7× on insert; on DO the JSON form wins by ~2× on insert and ~1.6× on delete, and the same
holds at 1,000 rows (3 ms → 1 ms insert, 1 ms → 0 ms delete).

The mechanism is measured too, and it explains the reversal rather than merely reporting it. On Bun,
**statement count is not the cost**: the same 20,000 rows in 607 statements and in 10 statements are
10.6 ms and 9.9 ms, so what the chunked form saves is the per-row JSON extraction, which is real and
intrinsic. On DO that same per-row saving is still there — but 607 `sql.exec` calls now cross the
host boundary, and that cost is larger. Nothing about the JSON payload got cheaper; the statement
count got expensive.

**So the rule is: a row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE,
never as N parameters — read or write, nothing to choose.** It is the faster form on the runtime we
ship to, and choosing the other one because the DEV runtime prefers it is precisely the class of
error `src/cf-limits.ts` exists to prevent. That one rule collapses `bindChunks`/`placeholders`/
`jsonbArrayBind`/`RowsBind` into a single concept, and it turns the DO cap from an IDIOM
`mise run binds` greps for into a STRUCTURAL property `check` can prove: a RelIR plan's bind count
is O(plan size) by construction. `RowBatch` shrinks to whatever JSON genuinely cannot carry (a blob),
and `binds-check.ts` becomes deletable once the last hand-rolled placeholder site is gone.

**Two caveats, recorded so nobody re-derives them.** workerd clamps timer resolution inside a DO, so
read the DO column as ratios and orders of magnitude rather than exact milliseconds — the ratio is
consistent across two sizes and two statement shapes, and the Bun column (opposite direction, same
harness) is what rules out the numbers being noise. And the DO run also independently reconfirmed
the cap: a deliberately wide 2,000-row insert was refused with `too many SQL variables`.

**Method, worth reusing:** a throwaway `wrangler dev` worker with its own DO measures production
SQLite for real, in about a minute. Any future claim of the form "X is faster" about storage should
be taken there before it is written down as a rule.

### 10·6 — DECIDED and LANDED 2026-08-02: `Delete.using` is deleted; membership is a predicate

A worked example of §10·4's discipline applied inward. `using` was a second spelling of
something the algebra already says: `Delete{ target, where: InQuery(Col(target,'id'), <rel>) }`
emits identical SQL and executes identically — verified before the decision, not after. So the
field, the `Membership` interface, the emitter arm and the two key-agreement checks all go, and
9·7 closes BY CONSTRUCTION rather than by naming the key: there is no longer any place for a physical
column name, because the caller writes the predicate and `check` validates it against the scope like
any other expression. `Insert.source` and `Update.from` keep their places — a source relation and
SQLite's `UPDATE … FROM` have no predicate spelling — and `using` never had one.

**Sequencing: 10·1 → 10·2 → 10·3 — all three landed (`b199a5f`, `3057e89`, `25e0b5f`).** 10·4 is
the decision that governs everything after them; 10·5 is settled by measurement; 10·6 is small and ready. The assembler rewrites every emitter arm while the `Plan` wrapper
changes emit's *entry*, so the assembler goes first to avoid rebasing it; the layout decomposition
changes no plan structure, so it goes last, when the §3.5 obligation table is the only RelIR consumer
left to update. 10·2 first is acceptable if the write wedge needs to move sooner — the cost is small.
