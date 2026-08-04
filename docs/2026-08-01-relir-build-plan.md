# RelIR — the build plan

**Status: BUILDING.** Coverage **563 / 2,298** corpus traversals on the RelIR spine; deletion counter
**110** references left across the 15 legacy rows. Both are ratchets in `ci` (§10·4). The direction was
argued in [codebase-analytics](./2026-08-01-codebase-analytics-and-blue-sky-restructure.md) §6/§6a and
is not re-argued here.

**Section numbers are an API.** ~96 comments in `src/`, `scripts/` and `test/` cite `§3.5`, `§5a`,
`§10·4`, `§10·5` and friends. Renumbering breaks them; content under a number may be rewritten freely.

**The behavioural contract is also written down as a SPEC** — `docs/spec/relir-algebra.allium` (the
algebra: construction, the checker's laws, the passes, the two budgets, the executor's row transport)
and `docs/spec/relir-migration.allium` (routing, the decline contract, the two ratchets, the phase
gates). It is a second reading of the same rules in a form a checker can hold, and it is where a rule
this document states in prose becomes a named invariant; four of the findings below came out of writing
it. Not a substitute for either the code or this doc: it carries no mechanism.

**This document is DIRECTION + TRAPS, not history.** What landed, when, and at which SHA is `git log`'s
job. What stays here: the model, the rules that must not be relitigated, the remaining work, and §11 —
the traps, each of which cost a real defect to learn.

**The one-line problem.** `Query.ctes` (`sql/kernel/q.ts`) is a private append-only array. Nothing reads
a CTE back, rewrites, reorders or fuses one — the query never exists as data. So every optimization
must happen *before* lowering (the fast-path layer) or *during* it (`TailAcc`), and every construct
SQLite will not accept in position must be hand-built around (`expandRepeatBody`, `runWriteChainFull`).
RelIR is the missing middle: `Step[] → RelIR → SQL`, inspectable rewritable relational algebra.

---

## 1. The measured envelope — five probes, each decides something

Measured against SQLite 3.51.2. **Do not re-derive.**

- **P1 — the recursive-term law.** The recursive reference must appear **exactly once, at the top level
  of the recursive term's `FROM`**. Wrapping it in a derived table fails `circular reference` even as the
  sole reference — the rule is POSITIONAL, not a count. Its alias may then be referenced freely from a
  correlated scalar subquery. No aggregates, no window functions.
  → *the `Recursive` legality predicate; `flatten` (§4.2) is required, not optional.*
- **P2 — legal in a recursive term but refused today.** `NOT EXISTS`, a join against a derived `UNION`,
  `IN (SELECT …)`, `LEFT JOIN` with the walk on the left, correlated scalar subqueries, multi-hop join
  chains — all legal, all outside `REPEAT_BODY_OK`.
  → *`expandRepeatBody` is a hand-written join-flattener, not a platform workaround. It dies.*
- **P3 — barriers in a recursive term: a PERMANENT WALL.** `DISTINCT` is legal but inert (SQLite feeds
  the term one queue row at a time, so it never sees two frontier rows together). `LIMIT`/`ORDER BY`+
  `LIMIT` are global caps on the whole CTE, not per-iteration barriers. `UNION` dedups whole-walk on the
  row tuple, violating the multiset rule. **No per-iteration barrier is expressible in a recursive term
  in ANY lowering.** Do not re-propose re-lowering.
- **P4 — the corpus ratio.** Of 125 `repeat()` traversals, 53 have a barrier body: **48 `times(n)`-
  bounded, 5 `until()`/`emit()`**. Corpus `times(n)` maxes at 10.
  → *`unroll` is the majority route; the wall is 5 traversals.*
- **P5 — the write envelope.** Legal: `WITH cte AS (…) INSERT … SELECT FROM cte RETURNING`; multi-row
  `INSERT … RETURNING`; `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM (subquery)`;
  `DELETE … WHERE … IN (SELECT …)`. **Illegal: the Postgres-style data-modifying CTE.**
  → *a write chain is a SEQUENCE of statements — O(write steps), not O(rows); ordering is `Plan.bindings`.*
- **P5b — RETURNING determinism.** Row order is undefined per the docs, but **id assignment follows the
  source `SELECT`'s `ORDER BY`**, and RETURNING can project an inserted column.
  → *order the source and re-associate by carried key — NEVER by RETURNING position.*

**Gate before Phase 2 ships — BUILT AND GREEN** (`test/cf-constructs.test.ts`, in the ordinary
suite so `ci` covers it). P5/P5b are re-measured on DO SQLite through a THROWAWAY worker with its own
Durable Object (`test/cf-probe/`, §10·5's own method), because whether a CONSTRUCT is accepted is not
countable from Bun — `src/cf-limits.ts` sees a SIZE wall and this sees a VOCABULARY wall, and neither
sees the other's. Every P5 shape is accepted on the platform and the one prohibition is refused there
too, so **the write envelope holds where we ship and Phase 2 rests on measurement rather than on the
dev runtime's agreement.** Confirmed: CTE→`INSERT … SELECT … RETURNING`, multi-row
`INSERT … RETURNING`, `INSERT … ON CONFLICT DO UPDATE … RETURNING`, `UPDATE … FROM (subquery)`,
`DELETE … WHERE … IN (SELECT …)`, the data-modifying CTE REFUSED, P5b's id-follows-`ORDER BY`, and the
100-parameter cap refused past it.

**Two findings came from the probe's own plumbing, and both are the AUTHORIZER rather than the
dialect:** `PRAGMA writable_schema` is refused outright (`not authorized: SQLITE_AUTH`), and so is
dropping a DO's own bookkeeping table — whose name also differs between local dev
(`__miniflare_do_name`) and production (`_cf_*`). Nothing in the algebra wants either, but a wipe that
filtered by name would have been brittle in exactly the direction this seam exists to catch, so the
probe uses a FRESH DO per run and needs no privileged operation at all.

---

## 2. The clean-room boundary

`src/rel/` imports **nothing** from `src/compiler/` or `src/gremlin/` — pure data plus total functions,
testable with no graph, no store, no Gremlin. `mise run arch` gates it as a textual import scan, because
a clean-room breach is a dependency edge and is visible in the import statement itself.

**The boundary is a VOCABULARY boundary, not a file boundary.** RelIR needs exactly two things about
carried state: which output columns are channels and in what order, and per channel its merge and
barrier policy. It needs nothing of alias shape histories or path element types. So the neutral **channel
core** is `src/channels.ts` — `Channels = readonly { col, role: ChannelRole }[]` plus role-keyed policy
tables — and `TraverserLayout` is that core plus the role-specific detail the framing layer owns. **A
RelIR node cannot know what a sack is.**

Three properties of the core that must not be lost:

- **The policy tables are `Record<role, …>`, type-enforced total.** A new role fails the build until its
  merge and barrier policies are declared. They encode the largest measured defect category in this
  repo's history — **33% of diagnosed defects: a carried field dropped at a barrier, merge or rejoin.**
- **The framing layer READS its role policies off the core**, so there is one authority, not two tables
  to keep in step. Only the two METADATA roles are declared locally — never physical columns, so not
  channels at all.
- **The channel merge is deliberately WEAKER than the layout merge.** Arms fork from a common seed, so
  at the column level a forkable role can only be extended. Which label sits at which column is the
  framing layer's business; reproducing that algebra in the core would be the Gremlin leak the module
  exists to prevent. `test/channel-contracts.test.ts` ties the two.

**Shape does not enter the NODE SET.** **If a `src/rel/` node ever acquires a
`kind: 'scalar' | 'element' | …` field, the layer has failed and should be reverted.** `ChannelRole` is
not that field: a role is per-COLUMN carried-state bookkeeping, never the stream's Gremlin type.

**This is a claim about `src/rel/`, not about who builds the payload projection.** The LOWERING
(`src/compiler/rel/`) both knows Gremlin shape and says so — `RelFraming` is declared there, and `list.ts`
and `map.ts` build shape-specific SQL out of shape-free nodes. That is the intended arrangement, and it is
why §10·10 can move the payload projection into `src/compiler/rel/` without touching this boundary: both
the old home and the new one are outside `src/rel/`.

---

## 3. The object model — complete and CLOSED

Two algebras: **expressions** (a value per row) and **relations** (rows), plus **statements** for
writes. Every node is an immutable plain object with a `kind` discriminant; every list is `readonly`.

The node set is deliberately **smaller than the SQL surface**, because SQL's redundancy collapses:
`HAVING` is `Filter` over `Aggregate`; distinct `UNION` is `Distinct` over `Union{all:true}`;
`SELECT DISTINCT` is `Distinct` over `Project`; `NATURAL`/`USING` are `Join` with an explicit `on`;
`group_concat`/`json_group_array` are aggregate *functions*. Each collapse is a place the legacy code
has a separate path.

**Construction is not object-literal syntax.** A module-private brand means a `Rel` can be minted only
by its named stateless kind factory, which validates local shape and freezes. `check` validates scope
and whole-plan laws. `SelfRef` has no public factory — only `recursive` supplies it to its callback.
**Rewriters must rebuild through a factory, never spread a node**: a spread can retain an obsolete field
or lose the brand. No `src/rel/index.ts` barrel while the internal API moves.

### 3.0 The top of a plan is a PROGRAM, not a tree

```ts
type Plan    = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt; readonly snapshot?: boolean }
// plus one source node:  Ref { name }
```

A `PriorResult` and a named-CTE reference are the SAME concept — a reference to a relation computed
earlier — and having two mechanisms for it is why the write path reads as a second machine. One concept:

- a `Rel` binding referenced more than once → a **CTE**; that is `name`'s decision (§4.6), a property OF
  THE PLAN rather than a map carried beside it.
- a `Stmt` binding → a **statement boundary**. The executor (`src/program.ts`, outside `src/rel/`) runs
  it, retains its `RETURNING` rows, and the same `Ref` resolves to them as ONE JSON bind exploded by
  `json_each` — never a row-count-sized placeholder list.
- a `Rel` binding marked **`snapshot`** → a **read boundary**: the same step shape, the same retention,
  the same transport. **It is what makes "the value AT THIS POINT" expressible**, and Phase 2 does not
  work without it: a CTE is recomputed by every statement that names it, so a drop cascade whose target
  relation reads `edges` would ask a DIFFERENT question after the incident-edge delete and leave
  vertices standing. `retained(binding)` (`isStmt(node) || snapshot`) is the one predicate; the emitter
  cannot tell the two apart and neither can a `Ref`. **`checkPlan` proves the discipline rather than
  trusting statement order**: in a program with effects, a plain `Rel` binding read by more than one
  step is a THROW naming it. Reached through ONE step a CTE is still exactly right, so the rule names
  the hazard and nothing wider.
- a write in a read position is a **hoist to a binding**, so `union(__.addV(), __.V())`,
  `optional(__.addV())` and `repeat(__.addV())` are plan composition. **There is no driver anywhere.**
- **Effects are legal only at a binding.** `Rel` positions stay pure — a `Stmt` cannot be a `Join`
  input, as a type-level fact rather than a checker rule. `Stmt` and `Rel` share `RelBase`, so a
  statement's result is a relation like any other.

### 3.1 Types

```ts
type RelType = { readonly cols: readonly ColMeta[] }
type ColMeta = { readonly name: string; readonly type: SqlType; readonly nullable: boolean }
type SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any'
```

`SqlType` is SQLite storage classes plus `json`, and is **not** a Gremlin type vocabulary — it must never
grow `vertex`/`edge`/`list`. Gremlin typing stays in `ScalarType`/`CanonicalType`.

### 3.2 / 3.3 The node set — 15 expression kinds, 19 relational/statement kinds

**The kinds and their fields live in `src/rel/expr.ts`, `rel.ts` and `stmt.ts`** — the code is the
authority and a table here would only drift from it. What belongs in a doc is the part the type
declaration cannot say:

- **`partitionBy: readonly Expr[]` on `WindowSpec` is the single most important field in this design.**
  Its absence is what forces `globalRowOps` and `rankedRows` to be two families: global is
  `partitionBy: []`, per-origin is `partitionBy: origins.map(Col)`, per-origin-dedup is
  `[...origins, valueExpr]`. `rankedRows` already had to take its window as a CALLBACK because "that
  authority does not exist" — an `Expr` *is* it.
- **`Scan` is the ONLY physical-schema node** — the storage seam. An absent table is an absent
  capability, not an inconvenience.
- **`Values` refuses to express the EMPTY relation.** `Values([])` rendered invalid SQL that failed only
  at the database, so the empty case is a `Filter(false)` over something.
- **`Project` is the only node that may DECLARE channel columns.**
- **`Distinct` is whole-row, and only whole row.** A keyed dedup is `Window(row_number PARTITION BY key)`
  + `Filter(rn = 1)`. A `Distinct.on` field emitted a projection of the keys while the declared type
  still promised the full row — a consumer of a dropped column then failed at execution with the
  checker's blessing.
- **`Window` may only EXTEND its input**, never replace a column; the mint-then-project pair is two
  nodes, and the assembler fuses them back into one `SELECT` (§5).
- **`Materialize` is a boundary HINT, not semantics** — force a named CTE where the planner needs a
  fence (§11's bind wall).
- **A `Join` emits its sides' columns POSITIONALLY** (the left alone for `semi`/`anti`), so its declared
  type must have that width and no duplicate name, and **a joined side's outputs are addressed through
  the JOIN, never through the side**. Its sides must also be DISTINCT relations, because `Col{rel}`
  cannot say which occurrence it means.
- **`Union` is n-ary, not binary**, so an arm-merge mints its channels once.
- **`Aggregate` emits its group keys then its aggregates**, so the declared type names the keys rather
  than leaving SQLite to infer them.
- **`Recursive.step` is a FUNCTION** so the self-reference cannot leak, and `SelfRef` has no public
  factory. Subject to P1 — and P1 being POSITIONAL is why a `Materialize` may not sit between the term
  and its own self reference: a fence forces the named-CTE boundary that P1 measured as fatal even as
  the sole reference, so `check` admits a `Filter`/`Project`/`Sort` there and refuses a fence.
- **`Agg` is legal only inside `Aggregate.aggs`** and `WindowExpr` only inside `Window.specs`, checked.
  `Agg.orderBy` is what `fold()` needs. An `Agg` with no arguments means "over all rows" — `count(*)`
  is the emitter's spelling of that, never a node field (§11).
- **`Scalar`/`Exists` may be CORRELATED**, which is legal even inside a recursive term (P1). `InList` is
  bounded by QUERY TEXT only; a set sized by DATA is one JSON bind (§3.6).
- **`Delete` has no `using`** — membership is an `InQuery` in `where` (§10·6).

**The set is CLOSED.** A construct missing from it is a derived form; adding a kind takes §7's bar —
prove the seam cannot EXPRESS the shape, not that it has not been handed one.

### 3.4 What is deliberately NOT a node

- **`With`/CTE definition.** A `Plan` binding is the only naming mechanism, and CTE-versus-inline is
  `name`'s decision (§4.6). Within a binding the relation is a **DAG** — a node referenced twice is
  shared. `Materialize` is the override, not the mechanism.
- **`Param`.** The front-end resolves wire parameters into `Step.args` before the IR exists, so nothing
  downstream could construct one.
- **`Correlate`/lateral.** Correlation is a property of an `Expr` referencing an outer `RelId`. P1 is
  why: SQLite's rule is positional, and a node would invite constructing the one position it forbids.
- **Shape, cardinality, productivity, bulk semantics.** All Gremlin-level (§2).

### 3.5 Channel obligations, per node

The rule that keeps the 33% defect category dead: **every node declares what it does to each carried
channel, and a total checker verifies it** — `Record<RelKind, …>` in `src/rel/obligations.ts`, so a new
node kind fails the build until its obligation is declared.

- `Project` — the only node that may DECLARE channel columns; the channel set must be a subset of its
  outputs.
- `Union` — merges arm channels per the role policy.
- `Window`/`Sort`/`Limit`/`Filter`/`Distinct`/`Explode` — channel-PRESERVING, and the checker asserts
  they did not drop one. Passing the input's channels through beats naming a list (§11).
- `Join{kind:'left'}` — the right side's columns become nullable; a rigid role arriving nullable is an
  error, not a coercion.
- `Recursive` — `seed` and `step` channels must be IDENTICAL including column order.
- Every node — a channel it CLAIMS must be a column it actually emits.

**The barrier obligation is TWO contracts, not one**, and conflating them cost a real defect:

- a **BARRIER** emits a NEW traverser, so no channel survives.
- a **grouping by the traverser's own IDENTITY** emits one row per SURVIVING traverser, so its channels
  must come out the other side or a later reducer counts the collapse away. Movement's bulk coalescing
  (`SELECT id, SUM(bulk) … GROUP BY id`) and `dedup` under an emission order (`MIN(encounter)`) are both
  this. What makes a barrier is that the output row is a new traverser — **not** that the SQL groups.

The node DECLARES which it is under (`isReEncoding`, decidable from the node alone); the table checks it
is allowed to. `CHANNEL_GROUP_POLICY` is the third total table: which roles have a defined answer when N
rows become one — `bulk` combines (adds), `encounter` combines (earliest); an alias, path, origin or
sack belong to ONE member, and a grouping would take whichever row SQLite reached first.

### 3.6 Two budgets the plan owns, not the emitter

- **Binds.** `Lit` renders as a bind; a plan carries `bindCount()` and **fails closed above the DO cap
  of 100** rather than emitting SQL that only fails in production. The cap is also checked against the
  RENDERED bind list, because a fused block can spell one `Lit` more than once. An over-budget `Values`
  or a statement's retained rows land as ONE JSON bind exploded by `json_each` — done by the `land`
  pass (§4.5b), so `emit` never learns about chunking. This makes the DO cap a *plan property* `check`
  can prove instead of an idiom `mise run binds` greps for.
- **Statement text.** DO caps at 100 KB. `unroll` multiplies plan size, so it consults the rendered size
  and declines above a ceiling, falling back to `Recursive` — which then refuses a barrier body as a
  clean deferral. P4 says the corpus max is `times(10)`, so the ceiling exists to make a hand-written
  `times(1000)` degrade honestly.

---

## 4. The passes

All `Rel → Rel`, total, order-declared. **Structure is declared ONCE** in `src/rel/walk.ts` with no
`default` arm anywhere, so `noImplicitReturns` makes a new node kind a compile error rather than a
silently skipped case. Rewriting is memoised, so the DAG stays a DAG (§3.4).

- **4.1 `check`** — the fail-closed verifier and the first thing built: column resolution, `Agg` only in
  `Aggregate`, `WindowExpr` only in `Window`, `SelfRef` only in its `Recursive.step`, the §3.5
  obligations, both §3.6 budgets. Always on in dev and tests.
- **4.2 `flatten`** — join flattening / subquery decorrelation into the P1 envelope. **This is what
  deletes `expandRepeatBody`**; P2 is the evidence its refused vocabulary is legal once flattened.
- **4.3 `unroll`** — replicate a subplan *n* times and chain it: P4's `times(n)` route, 48 of 53 barrier
  bodies. With no `Recursive` in the output there is no recursive term, so every P1/P3 prohibition
  evaporates and a barrier is an ordinary `Aggregate`/`Window`.
- **4.4 `fuse`** — SEMANTIC rewrites only, deliberately small: adjacent `Filter`s conjoin,
  `Distinct(Distinct x)` collapses, `Limit` over `Limit` composes, a `Sort` dead before a barrier goes.
  **`Sort`+`Limit` is NOT this pass's job** — that is one SELECT's slots, and it belongs to the assembler
  (§5). The assembler, not `fuse`, is what deletes `TailAcc`.
- **4.5 `prune`** — column pruning; a node's need is the UNION over its consumers. Load-bearing rather
  than cosmetic: it is what makes `unroll`'s replicas affordable.
- **4.5b `land`** — the bind-budget lowering (§3.6). Declines a row holding anything but a `Lit`, and the
  budget then fails closed on it.
- **4.6 `name`** — named CTE versus inlined derived table for every shared node, honouring
  `Materialize`. One policy applied with the whole plan visible, instead of a judgement call at 163
  `q.cte` sites.
- **4.7 `recognize`** *(Phase 4 only)* — the fast paths as plan rewrites, so equivalence is structural
  and recognition failure is "no rewrite fired" rather than a separate code path.

**DECLARED IS NOT WIRED, and the gap is worth stating because "order-declared" above implies a pipeline
that does not exist.** Only `name` has a production caller (`lower.ts`). `fuse`, `prune` and `land` are
built and tested and reachable from no route, and there is no object anywhere that orders them — the
order above lives in this list. Two consequences, one per pass, and they pull different ways:
`land` is the declared remedy for a row set sized by DATA, so while it is unwired that whole class
DECLINES instead (§11's bind wall) — a capability parked on the spine this plan deletes. `fuse` is the
opposite question: the assembler already fuses a run into one `SELECT`, so before wiring it, ask which
of its four rewrites still buys anything the assembler does not (only one of the four is even
implemented — adjacent filters). `prune` is Phase 3's prerequisite, below.

---

## 5. The emitter — a SELECT block assembler

Built on the `q` kernel **additively only** (it gained `identifier()`; nothing in the kernel may be
reshaped to suit RelIR). **Total** — every kind has an arm, no fallback, so an unrenderable node is a
compile error, not a runtime throw.

**The IR is normalized (one operator per node); SQL's `SELECT` is a COMPOSITION of operators with fixed
slots. Converting between those shapes is the emitter's whole job.** So it accumulates a block —
`{select, from, joins, where, group, having, order, limit, distinct}` — walking down from a node and
opening a nested `SELECT` only when the slot it needs is occupied. Prior art: Calcite's
`RelToSqlConverter` — the slot-occupied test itself is
`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rel2sql/SqlImplementor.java:2167`
(`needNewSubQuery`, over a `Set<Clause>` where we carry a block), and the per-node visitors that fill
the slots are `…/rel/rel2sql/RelToSqlConverter.java:135`. This is why `Project(Filter(Join))` is one
statement, and it is what deletes `TailAcc`.

**Refused:** letting `fuse` collapse a run into a `Select` mega-node. That puts the SQL surface inside
the IR, re-opens the closed node set (§7), and gives every pass two forms of one thing.

Emission facts worth not rediscovering: a compound arm is a select-CORE, so `(SELECT …) UNION ALL
(SELECT …)` is a SQLite syntax error and an arm that fills a tail slot needs a derived table of its own;
splicing a join side lifts ITS aliases into the join's `FROM`, so two sides reading the same shared
relation collide (`ambiguous column name`) and the colliding side stays in its own `SELECT`.

### 5a. The equivalence gate — results and access path, NEVER spelling

**Byte-identical SQL is not a gate here.** `test/CLAUDE.md` already rules the other way, and an
unreachable gate invites being satisfied by a snapshot of the emitter against itself — which happened.
The two properties actually worth holding, both mechanically checkable against real `test/L2-sql/`
traversals with nothing hand-transcribed:

1. **Same results** on the reference fixture.
2. **Same `EXPLAIN QUERY PLAN`.** This is the real content of §7's "SQLite is the optimizer": it catches
   a rewrite that changed the ACCESS PATH, which string equality catches only by accident and
   result-equivalence misses entirely.

Together they are a STRONGER falsification than byte-identity — they fail on a plan that reads the same
and executes differently — and they do not pin spelling, so an emitter improvement is not a churn event.
Phase 1's exit gate is this over eleven L2 traversal families (`test/rel-l2-equivalence.test.ts`), each
reduced mechanically: the relational CORE by structure, the EQP to its index DECISIONS with object names
and CTE-materialization lines dropped (an alias is spelling; CTE-versus-inline is `name`'s decision).

---

## 6. Phases — what remains

Order is `0 → 1 → 4.1 → 2 → 3 → 4.2–4.4` (§10·4). **Writes consume reads, so reads go first**: a
write's prefix arrives as `renderDriverRows(st)` — opaque `{sql, binds}` from the legacy spine — so
there is no `Rel` to hand `Insert.source` until the read lowering exists.

**Phase 0 and Phase 1 are DONE.** Phase 0's item 0.1 (`globalRowOps` into the dispatch tables) is
**WITHDRAWN as obsolete, and the reason generalizes**: its premise counted a table's ABSENCE of an entry
as duplication, when in both large tables the absence is a FUSION (`TailAcc` for elements,
`lowerScalarRows` for scalars). Spreading `globalRowOps` over them would replace fusion with an
op-per-`reprojectRows` — a SQL-shape regression. The finding underneath survives as 4.1's: those two
accumulators and `globalRowOps` are three spellings of `Sort`/`Limit`/`Distinct`/`Window`-with-a-
`partitionBy`.

### Phase 4.1 — the row-algebraic class (IN PROGRESS)

`limit`/`skip`/`range`/`tail`/`order`/`dedup`/`sample` collapse to `Sort`/`Limit`/`Distinct`/`Window`
with a `partitionBy`. Covered so far: the element and scalar sources, source-scope filters, the
`P`/`TextP` predicate vocabulary, movement, correlated `where`/`filter`/`not` bodies, the `by()`
modulator vocabulary, `dedup`/`identity`, slices, scalar `order()`, the 18-name scalar transform family
and the four-name reducer family. `src/compiler/rel/` is `build ◂ {predicate, modulator, transform,
reducer} ◂ lower ◂ spine` — a DAG, and each vocabulary module serves every host at once (§10·8).

**The MODEL change is DONE, and it is the shape every later row op inherits.** The emission-order
channel is a property of each RELATION, not a chain-global boolean: `elementCols(channels)` derives the
declared columns from the channel list, every producer reads `input.channels`, and `withChannel`
(`src/channels.ts`) is the MINT — insert in `ROLE_ORDER`, fail closed on a duplicate column. Two
consequences worth not undoing:

- **`RelLowering` is `{plan, framing}`.** Its `cols` and `channels` were properties of `plan.result`
  carried beside it, and `scalarTail` shadowed them in two accumulators. Read them off the relation.
- **The collapse law is read off the RELATION too.** "Collapse and an emission order are mutually
  exclusive" cannot be decided from `demandsEncounter` alone once a step MINTS a position, so the
  Phase-2 loop asks `encounterOf(moved.rel.channels)` per movement.

**Element `order()` LANDED on it** (+21 coverage, L3 +2), and it needed no new machinery: the element
materialization already emits `ORDER BY p.encounter` whenever that channel is live, so `order()` is
`renumber(rel, [<by-key>, <id tie-break>], …)` — the same function the fan-out re-mint and scalar
`order()` share. Three things it turned up, each now structural rather than remembered:

- **A slice after it must count TRAVERSERS.** Under `movementCollapse` a row is an (element, N) pair,
  so `bulkSlice` is a cumulative-`SUM(bulk)` window plus a boundary trim — legacy hand-rolls the same
  shape inside the framing projection, where it can only happen once and only at the end. The lowering
  carries ONE fact beside `rel` for it (`bulked`), because "is the multiplicity provably 1" is not
  something a channel can say.
- **`dedup().by(k)` ranks by the POSITION, not the id.** The survivor is the first in emission order;
  ranking by id was right only while nothing could mint one. The census caught it (a different member
  of each group — a different multiset), which is what that instrument is for.
- **A window may not read a WINDOWED column** — `OVER (…)` cannot contain a window function, so the
  emitter closes the block (`case 'window'`, and `case 'sort'` for §11's fence reason). Stating it in
  the assembler is what stops it being a `Materialize` fence remembered at N sites.

**Do NOT `Sort` the core relation and frame on top — a JOIN's output order is unspecified**, so the
framing join may return sorted rows in any order (and on a six-vertex fixture will reliably return the
flattering one). No assertion in the ladder would catch it; minting the channel is what makes the order
survive the join.

**`tail()` and `sample()` LANDED with it**, which closes `globalRowOps`' whole vocabulary on the RelIR
side: `tail(n)` is the DIRECTION flag on the shared slice (accumulate backwards and the band `[0, n)`
is the last n), and `sample(n)` is `ORDER BY RANDOM() LIMIT n` needing no position at all. Both are
+3 coverage together and that is the wrong number to read them by (§10·7): what they remove is two
blanket declines and the last reason the class was not a vocabulary. What still fails closed is the
one case that is a SAFETY property rather than a gap — `tail` over a relation whose position a barrier
has consumed (`g.V().count().tail(1)`), because "the last n" is a question about an order that is no
longer there, and a weighted `sample().by()`, whose weight is a per-shape expression.

**A sort MINTS the position on BOTH hosts, and `order()` takes EVERY slot.** Two residual gaps in the
same space, both closed by making the vocabulary total rather than by adding a step: a SCALAR `order()`
used to leave its order in a clause, which meant a following `tail()` had nothing to read backwards
(legacy's answer there is `ROW_NUMBER() OVER ()` + `COUNT(*) OVER ()` over a CTE's incidental scan
order — right only while SQLite preserves it); and `sortTerms` took ONE `by()`, so
`by('performances',desc).by('name')` sorted by the wrong thing wherever the first key tied. `SortTerm[]`
was always a list, so multi-key is the same lowering with the productivity drops conjoined. `shuffle`
mixed with a real key declines — it is the whole order or none of it.

**Deleting `globalRowOps` (floor 10) is now a LEGACY-side question, not a coverage one** — every one
of its five step names routes through RelIR when the rest of the chain does. Same for `TailAcc` (13):
element `order()` no longer needs it, so what is left there is the framing folds for shapes RelIR does
not yet produce.

### The LIST SHAPE — the member frame LANDED; `fold()` is what is left

The collection-LITERAL half of the `jsonbList` arm is covered (`+46`, 378→424, the largest single
jump so far), and with it the frame every list op plugs into. `src/compiler/rel/list.ts` is the fifth
vocabulary module.

**The frame is the whole idea, and it is a CORRELATED SCALAR SUBQUERY.** A list is ONE traverser, so
exploding it at relation level would multiply the stream's rows and then need re-grouping by a row
identity the algebra does not carry. `Explode` with no `input` is exactly `FROM json_each(<outer
expr>)` — which is why that field is now optional, and it is the shape legacy uses at all four of its
hand-written member subqueries. What plugs in is already written: `transform.ts` per member,
`predicate.ts` over a member, `reducer.ts` over a member. `unfold()` is the ONE relation-level explode
and the contrast is the point — it makes each member a traverser, so multiplying rows is the answer.

Covered: the collection literal, member transforms (`Scope.local`), `all`/`any`/`none`, `conjoin`,
the local reducers, `count(Scope.local)`, the local slices, `unfold()` into the scalar tail.

**`fold()` LANDED too** (+35, 424→459 — the spine is now a fifth of the corpus), and the barrier was
never the work: it is one `Aggregate` with an `orderBy`. The MEMBER ENCODING was.

- **A per-row `vtype` makes the encoding a RUNTIME question about the whole list.** Members become
  self-describing `{t,v}` nodes iff SOME member's recorded type is lossy under its storage class, asked
  ONCE so a list is wholly typed or wholly bare — mixing encodings inside one list is the corruption
  this shape exists to avoid.
- **That question is a WINDOW here, not legacy's second alias.** `MAX(<is this row lossy>) OVER ()`.
  Legacy notes a window "cannot nest inside the json_group_array aggregate" and reaches for an `EXISTS`
  over a second alias; true of ONE SELECT, and not a constraint on a normalized IR — the window is its
  own node, so the aggregate reads a COLUMN and the assembler opens the nested SELECT. **The `Exists`
  form is what the algebra actually refuses, and it is worth recording why: `name` does not walk
  EXPRESSION subplans, so a subplan sharing the outer tree becomes a `Ref` in one place and stays
  itself in the other.** `check` fails closed on it ("names two different relations in one scope").
  Making `name` walk expression subplans is the general fix if a second case ever wants it.
- **`memberPayload`/`memberNode` are the two reads, and every op goes through one.** Which one is
  decided by what the op DOES: anything that compares, filters or aggregates reads the payload
  (ordering a raw `{"t":"int","v":5}` would sort JSON text); anything that writes members BACK reads the
  node, so a subset or a reorder keeps each member's exact type. That is what lets a typed list flow
  through the same code as a bare one instead of failing closed — the frame did not change at all.
- **`unfold()` over a typed list frames PER ROW**, off a `vtype` column built from each member's own
  tag (inferred from the storage class where a member is bare). Same channel and same column name as
  `values()`, so the scalar tail's `carries('vtype')` picks it up and a following `is(P.gt(…))` gets the
  vtype-aware compare key for free.
- **A member op needs a FENCE, and this one is a legality wall.** `json_each(<list>)` is a FROM-clause
  reader, so fused into the block that COMPUTES the list it re-inlines the expression — and where that
  expression is `json_group_array(…)` SQLite refuses outright (`misuse of aggregate function`). The
  block model already tracks the symmetric fact for windows; fencing lands legacy's CTE-per-list-op
  shape.

**The SET-OP family LANDED** (+15): six semantics over one frame, each a relational statement rather
than a hand-written subquery — a UNION for concatenation (with a segment column, because a UNION ALL
has no order of its own), a correlated `EXISTS` for membership, a `Distinct` for the deduped results, a
cross join for the product (the second `json_each` takes the first as its INPUT). The operand crosses
the seam as ONE bind, which is the root rule about a set sized by DATA. A TRAVERSAL operand is a child
read and declines.

**It also turned up a determinism defect in BOTH spines, now fixed in both.** A Set has no member
order, so the order is ours to choose — and left unchosen it was a DEDUP IMPLEMENTATION DETAIL:
`UNION` (merge/disjunct) sorts, so those came out in storage-class order; `SELECT DISTINCT`
(intersect/difference) leaves it to a temp b-tree, so those came out in something like source order.
Two different accidents for one concept. Both spines now say `ORDER BY value`, which states the
property AND makes the two agree by construction — reproducing either accident in RelIR would have
been reproducing luck.

**Two more arms closed with it** (+13): `unfold()` over a NESTED list (a `product()`'s pair-lists)
stays in the list vocabulary — one LIST traverser per member, the same explode with a different payload
column — and **`is(P.typeOf(LIST|SET))` is now EXPRESSED rather than declined.** That one is §11's own
trap resolved: a type ASSERT retypes the stream, so lowering it as a predicate returns the right rows
framed as the wrong shape. It was only a decline because RelIR had no list shape; with one, the retype
is a `Filter(vtype = 'list')` plus a projection, and `collectionAssert` — legacy's ONE `typeOfAssert`
decode — is what recognises it. A MAP assert still declines: that needs the map shape, not a decode.

**What remains of the family, in order:**

1. `order(Scope.local)`/`dedup(Scope.local)`, which need the member compare key and the
   first-occurrence rule respectively.
2. The ELEMENT list (`fold()` over elements, whose members are rowids) — its members need expansion
   rather than a decode, which is why `isBareList` names the scalar encodings only.
3. The SUB-READ operand is DONE, and it is the seam `within`/`where`/`match` will reuse — see below.

**Then: THE LIST SHAPE — 194 blocked traversals, the largest family, and it splits by FRAMING ARM
rather than by step** (measured at 349 routed, by asking what shape legacy frames each blocked traversal
as, because that names the arm RelIR must grow):

| arm | from `fold` | from a collection source | total |
|---|---|---|---|
| **`jsonbList`** | 27 | 45 | **72** |
| `jsonbSet` | 14 | 15 | 29 |
| a SCALAR result (`fold().max(Scope.local)`) | 14 | — | 14 |
| a VALUE result (`fold().conjoin(';')`, `fold().unfold()`) | 7 | 11 | 18 |
| `jsonbElementList` (`g.V().fold()`) | 2 | — | 2 |
| legacy THROWS too (`merge`/`combine`/`difference` with a traversal operand, `order(local).by(key)`) | ~15 | — | ~15 |

Four facts to have before starting it:

1. **`jsonbList` is 72 on its own**, and both halves of it — a `fold()` barrier and a collection LITERAL
   — frame identically, so one arm serves both.
2. **The traversals operate ON the list**, which is where the 72 cash out: `inject(["a","b"])
   .lTrim(Scope.local)` needs a `json_each` explode, a per-member transform, and a re-aggregate. The
   compounding insight is that the transform is **`transform.ts` applied to a member** — exactly as
   legacy's `list.ts` calls `scalarTx` per member. The table is written; what is missing is the frame.
3. **`fold()` needs the ENCOUNTER order** (`json_group_array(… ORDER BY s.encounter)`), and `Agg`
   already carries `orderBy`, so no node-set question.
4. **~15 of the 194 are not coverage at all** — legacy throws for them too. Read a family's headline net
   of those.

**The arms are NOT one increment.** `jsonbSet` differs by set semantics, the ELEMENT list is the element
projection with an `ORDER BY` rather than a JSON aggregate, and `fold().max(Scope.local)` reaches the
LOCAL reducers (`reducer.ts` over a member, not over a row). `jsonbList` plus the member-transform frame
is the increment; the rest follow it.

**The rest of the corpus ranking** (`mise run rel-blockers`, 729 routed — re-run it every round, it
MOVES, and 732 routed as of the last measurement): side effects 95 (`aggregate` 65 · `group` 22 ·
`groupCount` 8) · the property shape 90 (`properties` 46 · `valueMap` 37) · **the map shape 64**
(`group*` 41 · `groupCount*` 23) · scalar transforms 64 (`math` 15 · `asNumber` 12) · branch 63
(`choose` 36 · `union` 20) · aliases 53 (all at `select`) · **writes down to 32** (`property` 12 ·
`mergeV` 6 · `mergeE` 6 · `addE` 5 · `addV` 3) · the list shape 30 (all at `fold`) · `sack` 25 ·
row ops 15.

**"Side effects 184, the largest family by a wide margin" was a MIS-ATTRIBUTION, and the correction is
the more useful fact.** `group`/`groupCount` WITH a string label fills a named collection a later
`cap()` reads back — a side effect. WITHOUT one it is an ordinary barrier whose RESULT is a map. The two
need completely different things (a named-collection substrate versus the map traverser shape) and no
part of one serves the other, so `blame()` now splits them and `sack` — a carried CHANNEL, neither a
collection nor a shape — is its own family. 64 blockers moved out of the top family into a shape that is
the third largest thing on the board. **Three families are now within 6 of each other at the top**, so
the choice between them is a design question rather than a number: side effects 95, the property shape
90, the map shape 64. In no family: `repeat` 86 · `local` 61 · `match` 57 ·
`where` 51 · `path` 38 · `is` 31 · `has` 26 · `call` 23 · `inject` 20 · `or` 17 · `project` 16 ·
`filter` 15 · `and` 15 · `shortestPath` 15 · `V` 12. **The residue is where the next
family gets recognized** — `inject` sat in it for two rounds before being spotted as the largest prize
on the board, and the set ops appeared in it the moment the list frame landed. Note `where`, `match`
and `path` all ROSE as aliases fell: they are alias CONSUMERS, so closing `as`/`select` moved their
blockers forward into them rather than clearing them — which is what a family boundary looks like from
the inside.

### The ALIAS CHANNEL — landed, and it made the shape boundary TWO-WAY

`as()` writes a JSONB path HISTORY and `select(label)` re-enters it (+8; `as` is gone from the blocker
table entirely, `select` 149 → 52). `src/compiler/rel/alias.ts` is the sixth vocabulary module. Three
facts are the substrate, not the step:

- **`elementTail` is a FUNCTION.** `terminal()` already took an element stream to a value one;
  `select(label)` on a label holding a vertex goes the OTHER way, and with the loop inline there was
  nowhere for it to land — a re-rooting step would have had to grow its own movement/filter/row-op
  vocabulary, which is the second implementation `steps/CLAUDE.md` forbids. It is now re-entered from
  three places, so `as`/`select` serve the element, scalar AND list hosts off one lowering and a step
  learned there is learned at every position it can occupy. **This is the seam a mid-chain `V()`/`E()`
  re-source and every later retype-back-to-elements arrives through — do not add a second.**
- **The alias role is the ONE `LAYOUT_FIELD` entry whose framing form is a NAME MAP** (`named`), not a
  column: a Gremlin label name is not something a `Channel` may know (§2), so it cannot live on the
  relation and the lowering hands it over beside the plan. `spine.ts` PROVES the map's columns are the
  result relation's alias channels — a map naming a column the relation does not emit is a silent
  empty result, so it THROWS rather than declines. `path`/`origin`/`branchOrder` are still absent.
- **`liveAliases` DERIVES the label set from the relation** instead of clearing it at each barrier. A
  barrier consumes every channel, so the map would otherwise name columns that are gone; asking the
  relation means there is no per-barrier clear to forget. Same discipline as reading the collapse law
  off the relation rather than off `demandsEncounter`.

**What is left of the family, and it is `select`'s remaining 52:** a MULTI-label `select` is the
map/record shape (which is the property shape's arm, not this one), `Pop.all`/`mixed` is the history as
a LIST value (the member frame over an alias column — a further arm of the same module), a modulated
`select(label).by(k)` reads the SELECTED element's properties, and an UNBOUND label's empty-result
answer needs the empty relation `Values` refuses to express (§3.3). Also still declined: a bare
`dedup()` under a live alias channel, which is a GROUPING by traverser identity and so refused by
`CHANNEL_GROUP_POLICY` — legacy refuses the same shape for the same reason, and the honest lowering
(a ranked window over the identity partition, `dedupBy`'s shape with the id as its key) is one
increment that has to land in BOTH spines.

### The LEADING COERCION PREFIX — folded, by legacy's own function

`asNumber`/`asBool`/`asDate`/`dateAdd`/`dateDiff` at the head of an `inject()` are folded at COMPILE
TIME on both spines, and RelIR REUSES `foldConstantCoercions` rather than re-expressing it (+30). The
reason is §11's, sharpened: **the fold IS the parse, and the parse RAISES** TinkerPop's exact messages
(`Can't parse string '1,000' as number.`) which SQL cannot raise at all. A `CAST` answers `1` for
`'1,000'` and epoch 0 for an invalid date — a required error becoming a plausible value. So a second
implementation would be a second chance to get an overflow boundary or a date format wrong; the shared
function mutates the value array and hands back the first ordinary step plus the framing tag, and a
value that does not parse THROWS from inside it, which this module catches and declines so legacy
raises the message it owns.

Note this SUPERSEDES `transform.ts`'s reasoning about `dateAdd`/`dateDiff` ("their fold is an
OPTIMIZATION, not a semantic requirement"): that is still true of the COLUMN form, and irrelevant at
the source, where they ride the same literal prefix legacy already folds. Both spines now emit one bind
for `inject(datetime(…)).dateAdd(hour, 2)`.

A MIXED `inject([1,2], 3)` still declines. Legacy FLATTENS it — its own comment calls that the
historical representation, held until a scalar stream gains a per-row shape discriminant — and
reproducing an approximation is not the same as reproducing an answer.

### The SUB-READ SEAM — a rooted chain lowered INSIDE another one

A set-op operand whose members are only known at run time (`merge(__.V().values('name').fold())`) is a
RELATION, and the outer plan reads it through a `Scalar` expression (+22). **No opaque escape node is
involved and none is needed** (§10·4): the sub-read is lowered by the SAME fold into the same algebra
and spliced in as an ordinary relation, so if the inner chain is not covered the decline propagates
outward — the contract, one level down.

Two things make it work, and both are worth not rediscovering:

- **The MINTER is injected.** `lowerToRel` split into `lowerChain` (the fold, unnamed, minter-passed)
  plus the budget check and `name`. §11's "relation ids are minted PER LOWERING" is about not sharing a
  module-global counter between COMPILES; WITHIN one compile the opposite is required, because two
  `minter()`s both start at 0 and the emitter's scope would see one id naming two relations.
- **Naming happens ONCE, at the top**, so the outer `name` pass sees the whole DAG. (A sub-read whose
  own graph shares a node internally is not bound today — `name` does not walk expression subplans — so
  it renders inlined twice rather than as a CTE. Making the pass walk them is the general fix when a
  case needs it; the same gap is why `fold()`'s lossy probe is a window and not an `EXISTS`.)
- **BOTH sides are projected to payloads.** A typed list's members may be `{t,v}` envelopes and an
  envelope never equals a bare value, so either side that might carry one is re-emitted through the
  member frame first. Legacy only does this to the SELF side, which happens to work because its operand
  sub-reads are all storage-class-determined on the reference graph.

**And it exposed a legacy gap that read like a shape refusal:** `operandList` parsed its nested body
with a bare `stepChain` instead of `childSteps`, so the body never went through the normalization that
ABSORBS a modulator onto its host — `merge(__.V().values('age').order().by(desc).fold())` handed the
inner compile a free-standing `by` step and it failed closed with `by() after a scalar stream not yet
supported`. One authority, both spines: +2 traversals neither could answer, and L3 1710 → 1712.

### `has()`'s three ARGUMENT SHAPES — one step, and the residue is where it was found

`has(key[, value])` was covered; `has(label, key, value)` and a `T`-TOKEN key were two separate
declines worth ~31 blocked traversals between them, and both are COMPOSITIONS of clauses already
built (+9 fully-covered chains; the rest of the 31 contain other uncovered steps). The 3-arg form is
the label constraint AND the property one, exactly as `HasStep` composes them, so extracting
`hasLabelClause`/`hasPropertyClause` from the existing arms was most of the work.

**`T.label` is ANY label, not the first**, and that is why it cannot reuse `modulator.ts`'s token
projection: a `by(T.label)` takes the FIRST label (insertion order names it), so a `has` built on it
would drop a multi-label vertex whose match is not first. It is an `EXISTS` over the element's label
rows with the predicate on the NAME. `T.id` is the EXTERNAL id (`COALESCE(uid, id)`), read through a
correlated scan so the clause is identical at the source and after a movement.

Found by asking the residue what SHAPE its `has` blockers were, not by reading the step list — 23 of
them were the same three-argument form. The instrument keeps its job with a different question
(§10·7).

### Phase 2 — the write wedge

`Insert`/`Update`/`Delete` bindings over read plans. 2.1 (§3.0 down to a program running against
SQLite, including the executor) is COMPLETE, and **2.2 and 2.3 LANDED, 2.2 with the WAY IN** (+3, and the number is
the wrong thing to read it by — §10·7): a covered chain ending in `drop()` lowers to a PROGRAM, and
what that opened is the substrate every later write step inherits.

- **`Binding.snapshot`** (§3.0) — the pre-mutation snapshot, with `checkPlan` proving it. Without it
  the cascade is correct only by an ORDER OF STATEMENTS somebody got right, which is exactly the class
  of reasoning §11 exists to delete.
- **`Program`** joins `Compiled` and `WritePlan` in the compile-output contract (`Executable` is the
  union), and `Shape` frames its rows exactly as it frames a read's — so the wire layer needs no write
  vocabulary at all. It is what REPLACES `WritePlan` (§8): data the algebra produced and one executor
  runs, versus a JS closure that reads its targets into JS and walks them, calling the store per row.
- **`BindBudgetExceeded`** — the one emitter/checker failure a caller may answer by choosing the other
  route. Every other violation must escape (§11), so a `catch` that could not tell them apart would
  turn the failure `rel-sweep` exists to see into a silent decline.
- **`RelFraming` gains `discard`** — "there is nothing here" has to be something the lowering can SAY,
  because `spine.ts` switches totally. A `drop()` program's result is its last statement with an empty
  `RETURNING`, which is also why nothing had to build the empty relation `Values` refuses to express.
- **Every statement's binds are O(plan size)**, because the retained id set crosses as ONE JSON value
  (§10·5). The cascade therefore needs no chunking at all, and `test/cf-limits.test.ts`'s 250-vertex
  and 250-edge drops pass through the new route unchanged. This is the first place the structural
  argument in §10·5 pays a write rather than a read.

**Two instruments caught what review would not have, and both found the same class of thing — a
question asked of the OLD union of artifacts.** `rel-sweep`'s budget probe went through
`emitRelational`, which refuses a program, so it had to ask per STEP (six decline-contract violations,
all of them this). And the census's `isWrite` asked `kind === 'write'`, so a `drop()` compiled to a
`program` shared the READ store and emptied it for every traversal after it — the question that probe
is really asking is whether a shared store SURVIVES, and only `kind === 'read'` answers yes.

**FRAMING over a program LANDED with 2.3, and it is both answers at once.** `emitProgram` splits a
plan into the steps that RUN and the relation that is LEFT; `spine.ts` frames that relation through the
SAME element projection a pure read reaches, and the composed query rides as `Program.tail` — so shape
needs no write vocabulary in the wire layer at all (§10·10 moves WHERE that projection is built, and
changes nothing about a write reaching the same one as a read). A `drop()` has no
relation left (its result IS its last statement), which is the `discard` arm.

**AND THE THING THE PHASE IS FOR, MEASURED.** A write's statement count is a function of the PLAN,
not of the row count: `g.V().hasLabel('person').property(single,'seen',1)` runs **7 statements over
ten elements and 7 over a hundred**, where the legacy path runs 81 and 801 — eight store calls per
element, because `materializeElementDrivers` reads its targets into JS and walks them. The elements
are an `Insert.source`; the only rows that cross into JS are a `snapshot`'s, as ONE JSON value.
`test/compiler/writes.exec.test.ts` asserts the two counts are IDENTICAL rather than merely small,
which is the only form of the assertion that says the right thing. **Nothing in `src/compiler/rel/`
is called a driver** — the word names the mechanism §8 deletes, and reusing it for the relation that
replaces it cost a reader exactly that confusion once. The new thing is the INPUT: the incoming
traversers, as a relation. `input`/`incoming` is its only spelling, in code and in prose.

- **2.2** `drop()` → `Delete` with an `InQuery` membership predicate. **DONE.** What still declines is
  a PROPERTY drop (`g.V().properties().drop()`), which needs the property stream RelIR does not have —
  the property shape's 90 blockers, not this phase's.
- **2.3** `property()` on an element that already exists. **DONE (+2).** The cardinality is a
  PER-ELEMENT question and stays one: an explicit `property(Cardinality.x, …)` declares and is constant
  thereafter, and absent one it is `COALESCE(<this element's declaration>, list)` — an expression each
  statement is GUARDED by, because two elements in one stream take different arms. The FTS rows are an
  `INSERT … SELECT` over the property insert's own `RETURNING` (the text is a compile-time constant,
  the pid is not, so they meet as a cross join over a `Values`), and the walk that produces the text is
  SHARED with legacy — a re-derived index is a silent divergence. Declines: a traversal value, `null`
  (the removal rule), a meta-property, a `T` key, and cardinality/meta on an edge.

  **A COLLECTION value LANDED (+19, 30.7% → 31.5%, `property`'s blockers 37 → 18)** and it was neither
  the "different bind shape and different index walk" this list predicted nor a further increment: both
  shared waists already did the work. `propertyValueBind` returns the typed `{t,v}` tree's JSON TEXT for
  a collection and `propertyFtsEntries` already walks it per nested LEAF, so what was missing was
  carrying the one bit that says which bind form to use — `PropertyWrite.collection`, plus `storedExpr`
  wrapping `jsonb(<text>)`. **Written ONCE because the value appears twice in one statement set**: the
  row inserted, and the `set`-cardinality "is it already present" comparison. A form that differed
  between them appends a duplicate instead of matching, which is why that is the sharpest of the L4
  pins. §10·5 is unaffected — the blob goes INTO the table and the `RETURNING` projects ids only.

  **A read-path gap found while pinning it and not fixed:** `has(key, <collection>)` THROWS on both
  spines — the collection reaches the bind layer raw and SQLite refuses, so it fails with a bind error
  rather than a clear deferral (the class §11 exists to keep out). The pins read the value back through
  `values()` instead. Its own increment, and probably one of the census's 17 `crashed` rows.

  **Two algebra gaps it closed, both of which any later write would have hit.** `EXCLUDED` — a reserved
  relation identity for SQLite's `excluded`, in scope for an `ON CONFLICT` clause alone, without which
  an upsert can only assign constants; and a statement's target columns are now TABLE-QUALIFIED, because
  a correlated subquery over a table with a same-named column CAPTURES a bare one. `node = node` read as
  the inner relation's column, was trivially true, and deleted every element's rows because one of them
  carried a `single` declaration — legal SQL, both names resolve, invisible to the checker, and found by
  an L4 pin.

  **One L4 pin MOVED, and the rule it illustrates is write-path trap 3 read the other way round.**
  `g_V_property_count_over_many` recorded OUR refusal ("cannot observe the whole stream"), not
  TinkerPop's answer — so when a barrier after a write became the barrier that was already built, the
  pin had to move to the count. Check whether a refusal is the REFERENCE's answer before removing it;
  check equally whether it is only ever ours before keeping it.
- **2.4** `addV`/`addE` → `Insert … SELECT … RETURNING`. **DONE (+80, 25.0% → 28.7%, the largest
  single jump the spine has taken), and it cost almost no new machinery**: the
  trailing initializer run is `property()`'s statements over the ids the node insert RETURNED, so a
  creation is a label resolution, a row, and then a vocabulary that already existed. **`addE` is DONE
  too, and it did NOT need P5b's correlation key.**
  - The INPUT relation decides how many, so `g.addV(…)` (a one-row `Values`) and `g.V().addV(…)`
    (the traverser stream) are one lowering.
  - The label name→id indirection is the `labels` UPSERT `GraphStore.labelId` already spells;
    `DO NOTHING` is wrong there because it returns no row on the existing case.
  - **The new ids ARE the emission order** — SQLite assigns rowids in the insert's output order, so a
    fresh vertex's `encounter` is its own id rather than a window over rows whose order is only
    conventionally the array's. `ordered` rides `ChainCtx` now, because a step that MINTS a traverser
    seeds the position channel exactly where the source would have.
  - A mid-chain input is SNAPSHOTTED for an INTRA-statement reason: `INSERT INTO nodes … SELECT …
    FROM nodes` reads the table it writes, which SQLite does not promise to evaluate first.
  - ~~**A bare `addV()` DECLINES, and the reason generalizes:**~~ **CORRECTED — it lowers now (+7), and
    the correction is the more useful lesson.** The original reasoning: under `LabelCardinality.ZERO_OR_MORE`
    a bare `addV()` creates a vertex with no labels and under `ONE` it takes the graph default, which is
    a property of the STORE and not of the chain — so "a compile-time answer to a runtime configuration
    question is a decline, not a default". Writing the default unconditionally really is a wrong answer
    on a multi-label graph, and an L4 pin really did catch it costing three L3 scenarios.

    **The premise was true and the conclusion was wrong by one step: the cardinality is not a RUNTIME
    question.** It is request-scope DI (`src/scopes.ts`, `engine.labelCardinality`), settled before a
    compile begins — what was actually missing is that this seam had never been handed it. So the rule
    to carry forward is the DIAGNOSTIC, not the verdict: **when a decline's stated cause is "that is a
    property of the store", ask WHEN the store decides it.** Configuration fixed before the compile is
    compile-time data; only a value that depends on the graph's CONTENTS is a genuine wall.
    `Lowering.labelCardinality` threads it (defaulting to `ONE`, `createAppScope`'s own default, so an
    instrument that lowers without an engine measures the default graph); `creationLabels` is the ONE
    reduction of a creation's labels, shared with `mergeV`, and it **declines a label COUNT the
    cardinality forbids** rather than throwing — `assertLabelCount`'s message is the reference's own
    answer, so the spine that owns it must raise it (trap 3, again). `addVertex` takes a label LIST:
    zero labels emit neither the intern nor the pairing, N are one `Values` plus a cross join, so a
    multi-label creation is not a new statement shape and its bind count stays O(plan size).

    Measured: `addV`'s own blockers 19 → 3, and the rest moved FORWARD into the steps that follow it,
    which is what closing a step looks like from the instrument. Pinned in L4 from BOTH regimes,
    because a route that hardcoded either one still passes the other half.
  - **`addE`'s endpoints are two EXPRESSIONS in the INPUT's scope**, which is the whole of what makes
    it `addV` with one more idea: `from("a")` is an alias column the input carries, `to(__.V(2))` a
    scalar subquery over a sub-read, an omitted side the incoming traverser itself — one lowering, not
    three. At the source the input is a one-row `Values` and both ends must then be explicit (`rel-sweep` caught
    the throw where an implicit end asked the seed for an `id` it has not got).
  - **No correlation key was needed for the ENDPOINTS, and that is a fact about their FORMS**, not
    luck: every one of them is decidable against the INCOMING ROW. ~~The form that WOULD need one — an
    alias bound to a vertex `addV()` created earlier in the same chain — declines… That is the one
    piece `runWriteChainFull` still owns, and it is 2.6's remaining prerequisite.~~ **DONE, and it was
    two asymmetries with `addV` rather than the missing substrate this predicted** (+13, 29.5% → 30.7%,
    `addE`'s blockers 19 → 6). The correlation key that carries an alias through a creation had already
    landed for `addV`; `addE` simply did not use it, and the fold then re-entered its tail with
    `NO_ALIASES` — so the relation physically carried the alias columns while the fold had forgotten
    the labels that name them. And the edge-stream refusal was checked at the TOP (`elem !== 'vertex'`)
    when the element kind only matters where an END IS IMPLICIT: an implicit end IS the incoming
    traverser, so an edge stream is one for neither side, while with both ends named the input is only
    a multiplier and its kind is irrelevant — which the function's own comment already said. Together
    they declined every SECOND `addE` in a chain, self-edges included, i.e. **the corpus's dominant
    write shape**: every standard-graph seeder is N `addV`s binding `as()` then N `addE`s reading them.
    The modern reference graph's own initializer now routes through RelIR and builds a graph identical
    to legacy's, verified row-for-row on both spines and pinned in L4 as a TRAVERSAL rather than
    trusted as setup (when a seeder is wrong, the scenario using it fails for a reason naming the
    traversal under test, never the seeder).

    **The general lesson is the one this doc keeps re-learning: before declaring a substrate missing,
    check whether an existing one is merely not REACHED** (`src/compiler/steps/CLAUDE.md`'s
    "cannot EXPRESS this" versus "cannot be HANDED this"). Predicted here as a retained-rows transport
    carrying each row's position; delivered as two call-site fixes to a join that already existed.
  - `SubReads` hands the read fold to the write vocabulary as two functions, which keeps the import
    graph a DAG and the decline contract intact one level down. An endpoint's body is ROOTED, so it
    goes through `normalize(stepChain(…))` and not `childSteps` — the latter strips a source and
    answers the EMPTY chain, i.e. an endpoint that silently matched nothing.

  **What the write route exposed in the READ path, and it is the general form worth keeping:** an
  edge's property bag had no `ORDER BY`, so it came out in the `UNIQUE(edge, key)` index's order while
  the vertex bag beside it states `GROUP BY key ORDER BY MIN(id)` and the write response read
  `ORDER BY id` — two answers for one element, differing by which path reached it. Both are
  insertion-ordered now. **A write that frames through the READ projection turns every read-path
  order-by-accident into an observable disagreement**, which is a better instrument than the
  perturbation sweep because it does not have to guess where to look.

  **`@RelIR` is a new L4 tag** — this scenario's ANSWER needs the RelIR spine and legacy refuses it,
  so `test:legacy-spine` is told which way round the two routes diverge rather than reading a
  deliberate improvement as a regression. It disappears with `runWriteChainFull`. Adding it found a
  latent parser bug: scenario-level tags were silently dropped for every scenario but a file's first
  (the per-scenario inner loop consumed the tag lines), invisible while `@gap:` was documentation and
  `@MultiLabel` was a FEATURE tag.
- **2.5** `mergeV` **is DONE (+19, 29.3% → 30.2%); `mergeE` is what is left.** The sketch above —
  "`ON CONFLICT DO UPDATE`, one statement" — was wrong about the mechanism and the reason it was wrong
  generalizes: **`ON CONFLICT` fires on a UNIQUE INDEX, and a merge map's criteria are an arbitrary
  predicate over labels and property rows.** There is no constraint for SQLite to conflict against.

  - **THE BRANCH IS NOT CONTROL FLOW, and that is the whole design.** Read as upstream writes it,
    `mergeV` needs a row COUNT before its next statement can be chosen ("did the search find
    anything"), which §3.0's program cannot ask for. Read RELATIONALLY it needs nothing: the `onMatch`
    writes run over the MATCH relation, which is empty on the create path and therefore writes nothing;
    the create runs over a source guarded by `NOT EXISTS <the match>`, which is empty on the match path
    and therefore inserts nothing. Two TOTAL statements, no branch taken anywhere — and it is the same
    property that lets an input of N rows need no loop. **This is the shape to reach for whenever a step
    looks like it needs an `if`**: ask what predicate makes each arm's own statement a no-op.
  - **THE SEARCH IS `V().hasLabel(l)….has(k, v)…`, SPELLED AS THOSE STEPS.** A merge map's criteria
    are a `has()` chain and nothing else — `T.label` is `hasLabel` per name (one step listing them all
    is ANY, and a merge needs ALL), a property entry is the ANY-value `EXISTS` `has` already means, and
    `T.id` is `V(id)`. `SubReads.matching` therefore hands those steps BACK to the read fold instead of
    building a second predicate vocabulary. Legacy's `commonMergeConds` is the same three clauses
    written a second time; not making that copy is what makes the merge's search inherit whatever
    `has()` learns next (the vtype-aware compare it has, the FTS arm §4.7 lifts) and makes a divergence
    between "what mergeV searches for" and "what has() finds" inexpressible.
  - **THE INPUT CONTRIBUTES A COUNT, and the correlation is a CROSS JOIN.** A constant map poses the
    same search for every incoming traverser, so the result is the input crossed with the merged
    element(s) — upstream's per-traverser loop, stated once. `crossed()` is the general form for **any
    step whose output does not correspond row-for-row with its input**: `addV` JOINS on the position
    because each input row made exactly one output row, and a merge emits what the SEARCH found, which
    no input row produced. `g.V().mergeV([:])` over two vertices is four traversers for exactly that
    reason.
  - **The result is the SNAPSHOT union the created ids, never the search re-run.** Re-reading the
    search after the writes looks equivalent and is not: `option(onMatch, [name: 'allen'])` under a
    `single` cardinality changes the very property the search asked about, so the re-read returns
    nothing and the traversal emits no traverser at all. A corpus scenario does exactly this, and it
    asserts a count of 1.
  - **A READ TAIL AFTER A MERGE comes free, and legacy refuses it outright** — it parses everything
    after `mergeV()` as the merge's own cluster. So `g.V().mergeV([:]).limit(2).values('name')` is
    `@RelIR`, pinned in both positions.
  - Declines, each because the answer is not a compile-time one: a NESTED label/key/value (a per-traverser
    read, `resolveMergeSpec`'s row-at-a-time surface); **`T.id`**, because a numeric id is written as
    the ROWID after `assertAvailableElementId` asks whether it is still free — a runtime refusal an
    `Insert` cannot state, and declining the pair is what stops a create silently colliding; and
    `option(onMatch, [(T.label): …])`, which is label MUTATION. The scalar-input position
    (`g.inject(0).mergeV(…)`, 3 traversals) is a `scalarTail` dispatch away and is the residue.
  - **Three reuse moves landed with it, and each removes a copy rather than adding a caller:**
    `mergeMaps` is now legacy's ONE merge parse, shared (§10·8 — five validation rules plus a
    per-argument type channel, and one of them had already drifted between two copies inside that
    file); `writeOf` is the ONE `PropSpec` → emission reduction, so a merge arm and a `property()` step
    cannot admit different values; and `renumber` moved to `build.ts`, which is that file's own stated
    rule — a second module has to agree about what renumbering means.
  - **A test that asserts one spine's write ECHO is asserting the ROUTE.** Two did, and both failed the
    day the step migrated, having found no defect: the legacy closure returns `{vertex: {…}}` while a
    program frames its rows through the read element projection (§2), and the wire serializes the two
    identically. `written()` (`test/support/harness.ts`) reads either. Prefer it to deleting the
    assertion — what those tests mean is "this is what got written".

  **`mergeE` is the remaining half and its wall is named:** an endpoint that does not exist is
  `resolveMergeEndpoint`'s THROW ("Vertex does not exist for mergeE"), a runtime refusal on a
  per-traverser value. Guarding the insert with `EXISTS` would answer a different question (a silent
  no-op where the reference raises), so the honest forms are the ones whose endpoints are provably
  present — which is where the alias-bound pair (`mergeV(…).as('outV')….mergeE(…)`) sits, and that
  needs 2.6's position-correlated `RETURNING`. Measure before building: it is 6 blockers.

  **`mergeV` with no `T.label` creates on `addV`'s rule, which is why the bare-`addV` fix is listed
  here as its prerequisite** — see the `LabelCardinality` note under 2.4.
- **2.6** **Delete `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`, `resolveEndpoint`,
  `materializeElementDrivers`, `WritePlan`.** The phase is not done while a second step dispatcher
  exists. **Its declared PREREQUISITE is now met** — 2.4's alias-through-a-creation form was the last
  piece `runWriteChainFull` owned, and it landed with `addE`'s carry above.

  **But the prerequisite is not the gate: 58 write traversals still DECLINE** (`property` 37 ·
  `addE` 6 · `mergeV` 6 · `mergeE` 6 · `addV` 3), so the legacy write path is still the answer for
  every one of them and deleting its dispatcher would turn each into a hard error. **2.6 is gated on
  write coverage being COMPLETE, not on the prerequisite** — which is worth stating because the
  prerequisite is the exciting-looking half and it is done. The remaining order is therefore
  `property`'s remaining 12, then the three sixes.

  **`property`'s residue is now the HARD part and it may not be closable inside this phase**, which
  matters because 2.6 is gated on it: a NESTED value (~4) and three `withSideEffect` constants both need
  per-traverser evaluation of a sub-traversal — the row-at-a-time surface this migration exists to
  DELETE — and a `T`-token key (3) writes an element's id or label on an existing element, which legacy
  refuses with a message it owns. So the honest statement is that Phase 2 closes to within ~10
  traversals of complete and the last ones are a substrate question, not an increment. **Deciding
  whether those become a pre-lowering VERIFY refusal, a genuine per-traverser substrate, or a permanent
  documented exception is the open question 2.6 actually turns on** — and it is the same question the
  migration spec's `refusal_belongs_to_legacy` records (`docs/spec/relir-migration.allium`).

  **`parseMergeOptions` is DELETED — absorbed into `mergeMaps` (0 references, floor banked).** It came
  off this list rather than down it, and the reason generalizes to any target a migration makes SHARED:
  once the RelIR route parses a merge map through the same function, what 2.6 deletes is the imperative
  closure AROUND the parse and never the parse itself, so the name could not honestly reach zero while
  it named something that has to outlive the spine. A ratchet row nothing can remove is a row that
  stops being read. Absorbing it puts the surviving code under a name that describes what it IS.

**Phase 2 supersedes [write-path](./2026-08-01-write-path-plan.md) and inherits its requirements.**
W1/W4 are landed and must not regress (four L4 pins + the perturbed census); W2 §3 and W3 §4 are this
phase's acceptance criteria and should be re-measured at its start. **W2/W3's two declared blockers
dissolve by construction — do NOT build a driver abstraction to satisfy them:** `Insert.source` IS a
read plan carrying the channels, so there is nothing to widen, and W3's unreachable positions are plan
composition. write-path §6 and §7 (the traps) carry over unchanged — especially trap 3, *check whether a
refusal is the reference's answer before removing it* (a third of the write messages in L3 telemetry
belong to scenarios that PASS by asserting the throw).

**The `RETURNING`/`ON CONFLICT` gate is BUILT AND GREEN** — `test/cf-constructs.test.ts`, see §1.
It was a prerequisite rather than an exit criterion (the algebra already emitted both constructs and
`runProgram` already executed them, so the two whose platform behaviour had never been measured were
the two already shipping), and it is now measured on workerd rather than asserted. **This phase no
longer has an unbuilt prerequisite**; what remains of its gate list is the WRITE side —
`test:cf-limits` green including the two constructs in real emitted plans, and W1's four L4 pins.

**Exit criteria:** every write L3 scenario at least as good as before; W2/W3's ~41 + ~15 candidates
measurably moved; W1's four L4 pins green; census identical or better with every moved row explained;
`store.*` call sites in the write path from 44 to O(write steps); `test:perturbed` still free of write
rows; `test:cf-limits` green including `RETURNING`/`ON CONFLICT`.

### Phase 3 — the repeat wedge

- **3.1** `Recursive` + the P1 legality predicate in `check`. A body that cannot be made legal **throws
  a clear deferral naming why** — never silently mis-executes.
- **3.2** `flatten`, then route `repeat()`'s body through the ordinary lowering and flatten it into the
  term. **`expandRepeatBody` is deleted.** P2's vocabulary arrives as a consequence, not as step work.
- **3.3** `unroll` for `times(n)`, with the §3.6 text ceiling. Take **`dedup` first** (4 queries, the
  easiest equivalence to state), one barrier per commit with an L4 pin each — do not cash in all 48.
  **`prune` is a PRECONDITION here, and today it prunes nothing below a `Join`/`Union`/`Aggregate`/
  `Recursive`** — its own declared remainder. §4.5 calls it what makes replicas affordable, and a
  replicated repeat body is mostly joins, so the remainder has to close before or with this, not after.
- **3.4** Split `repeat`'s admission control from its lowering, AFTER 3.2/3.3, and let the deletion of
  its ~20 admission booleans be the measurement.

**Exit criteria:** `REPEAT_BODY_OK` deleted; the row-local gate's 8 queries pass; `dedup`-in-`repeat`
pinned in L4; the 5 `until()`/`emit()` barrier traversals throw a deferral naming the P3 wall.

### Phase 4.2–4.4 — finishing the read migration

- **4.2** The block assembler replaces `TailAcc`; `ELEMENT_DISPATCH` joins the shared substrate. This is
  where element `order()`/`tail()` stop being framing concerns.
- **4.3** Aggregates and `count` — ten handlers become one `Aggregate` reading row→traverser cardinality
  off the plan. (The reducer family already landed early; what remains is the legacy side.)
- **4.4** `recognize` (§4.7): fast paths become plan rewrites, which is what lets the FTS decline in §7
  be lifted.

**Only BYTE FRAMING stays legacy's per-shape and forever — `(rows, Shape) → Buffer[]`, which contains no
SQL.** An earlier version of this line said "materialization, framing, JSON construction" and that
conflation was wrong: `materialize.ts` composes a `q` SELECT, so it is a query producer and therefore
RelIR's. **§10·10 corrects it and is the authority.** Phase 4 is finished when the ROW-ALGEBRAIC class is
gone from the shape tables — not when the shape tables are gone.

---

## 7. Risks, named, with the response

| Risk | Response |
|---|---|
| **Re-encoding, not simplification** — 11 shape tables become 11 shape-aware plan builders | §5a's gate over real L2 traversals catches an inadequate model before integration; 4.1 is measured by *dispatch entries deleted*, and if that number is not falling the phase is failing |
| **SQLite is the optimizer** — a mid-end that costs plans duplicates its work | RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no statistics, no join reordering** — out of scope permanently, not merely for now |
| **L3 delta ≈ 0 makes regressions invisible** | The census gates every phase, and §5a gates within a phase |
| **The channel contract erodes during migration** | §3.5's obligations are total `Record`s, so a new node or role fails the build until declared |
| **Scope creep into a general query engine** | The §3 node set is CLOSED. Adding a kind requires showing the seam cannot EXPRESS the shape, not that it cannot be HANDED it |
| **DO-only walls (`RETURNING`, `ON CONFLICT`)** | `test:cf-limits` before Phase 2 ships |
| **A fast path silently dropped by the new route** — same rows, same status, same census digest, and the coverage counter reports it as PROGRESS | **The covered shape DECLINES until §4.7 makes that fast path a plan rewrite.** See §11 for the rule and the one legitimate exception |
| **Losing W1/W4's landed gains** | W1's four L4 pins and the perturbed census are Phase 2 exit criteria, not afterthoughts |
| **Rebuilding the driver abstraction inside RelIR** | If Phase 2 grows an `ElementReadDriver` analogue, it has failed |
| **THE BIG ONE — the dual spine goes permanent.** Coverage reaches 80–90%, the remainder are the awkward traversals, the legacy route still works, and the migration quietly becomes an architecture with two engines in it forever | §10·4 makes that outcome legible rather than comfortable: two ratcheted counters, a deletion list that IS the exit, and a stalled countdown reported as a defect with a name. **The pressure runs the right way and must be kept that way** — at 100% coverage the legacy path's only value is being the differential's off position, so there is no engineering reason to keep it and no honest way to claim there is |

---

## 8. What this deletes — the EXIT CRITERION

This is §10·4's second counter, checked by **`mise run deletion`** against the committed floor in
`scripts/deletion-ratchet.tsv` (which IS this list, machine-readable). **Editing this prose without
editing that file changes nothing** — the file is the gate, this section is its rationale. The migration
is over when every floor is 0, and not before.

`expandRepeatBody` · `REPEAT_BODY_OK` · `runWriteChainFull` · `parseEdgeCluster` · `parseVertexSpec` ·
`resolveEndpoint` · `materializeElementDrivers` · `WritePlan` · `TailAcc` ·
`globalRowOps` · `runFastPath` · `appliesWhen` · the five-copy `count` adapter and the four-copy `where`
adapter.

Two second implementations of the traversal machine, one accumulator that exists only because fusion had
nowhere to happen, and the majority of an 11,201-line directory.

**A second list, of RelIR's OWN deleted spellings**, because a new layer accreting duplicate spellings is
the same failure one layer in — all at 0, so the ratchet now keeps them dead: `Sequence` ·
`PriorResult` · `Param` · `returningType` · `Distinct.on` · `Delete.using` · `Membership` · the `Naming`
side-table · `emitStmt`/`emitSequence` as separate entry points · the statement-only
`externalAliases`/`bareColumns` back channels · `sameLayout`-by-`JSON.stringify`.

---

## 9. Constraint audit — the process rule that came out of it

Ten constraints were measured against the build mid-flight; all are now closed or fixed, and the detail
is in `git log`. **The rule worth keeping is the one that generalizes: a constraint that cannot be kept
is a design discussion (§10), never a quiet substitution.** Two of the ten had been substituted rather
than raised — and two did not survive the discussion at all: byte-identical SQL and "never redesign the
layout contract" were both cost-avoidance, and both are gone. **A constraint is kept because it is
right, not because it is written down.**

One altitude finding, still unaddressed and still worth doing: **declare-and-verify where the project's
own pattern says derive.** `Project.type` vs `exprs`, `Window.type` vs `input + specs`, `Recursive.cols`
vs `type` — each checked in its factory AND re-checked in `check`. Names and arity are fully derivable;
only `SqlType`/nullability are not, which argues for a `typeOf(expr, scope)` rather than a hand-passed
`type` (`docs/2026-07-28-scalartype-refactoring-pattern.md` is the template).

---

## 10. Decisions of record

One principle governs all of them: **take the cleanest solution for each thing, and treat a constraint
that only exists to avoid cost as a candidate for deletion.** The suite is the safety net (L1–L5 + the
census + the perturbation instrument) and there are no users, so the bar is *cleanest*, not *smallest
diff*.

**Settled and landed** — the reasoning is above where it still binds; `git log` has the rest:

- **10·1** the emitter assembles a SELECT block (§5), and byte-identical SQL is gone in favour of §5a.
  *Refused:* a `Select` mega-node produced by `fuse` — it puts the SQL surface inside the IR.
- **10·2** the top of a plan is a program (§3.0), so `Sequence`/`PriorResult`/`Naming`-as-a-side-table/
  `returningType` were four spellings of two concepts. *Refused:* an executor inside `src/rel/` that
  special-cases statement sequences — it rebuilds write as a special case in a new layer.
- **10·3** `TraverserLayout` is DECOMPOSED, not imported (§2). *Refused:* making every node generic in an
  opaque layout type `L`, and simply accepting the import (which keeps `src/rel/` untestable alone).
- **10·6** `Delete.using` is deleted; membership is an `InQuery` predicate — a worked example of applying
  10·4's discipline inward. There is no longer any place in a statement for a physical column name.

### 10·4 — ONE SPINE. The dual spine is a harness with an end date.

Gremlin reaches RelIR through a SECOND lowering that grows step by step. A traversal whose every step is
covered routes RelIR end-to-end; anything else routes to legacy. **Never mixed inside one traversal**, so
no opaque node ever exists and RelIR stays a real algebra rather than a wrapper. `RelIR on` versus `off`
is therefore a **differential switch** (`mise run test:legacy-spine`), which makes the whole
2,298-traversal corpus plus L5's generated ones the oracle for every increment — strictly stronger than
§5a's eleven hand-built families. It must pass in BOTH positions, so a test that pins a spine's spelling
pins both.

**Refused, with the reason each fails:**

- *An opaque escape node* wrapping the legacy spine's `{sql, binds}`. §7's bar is exactly right: the seam
  CAN express these relations, we simply have not written the lowering. A node kind added because the
  work is unfinished never gets removed. **No opaque node, ever — not as a bridge, not "temporarily",
  not behind a flag.**
- *Retargeting the existing spine in one movement.* The cleanest END STATE by a distance — `Query.ctes`
  already IS `Plan.bindings` with the data thrown away — refused **not on principle but because it is
  un-instrumentable**: 163 `q.cte` sites convert at once, there is no "off" position, no differential can
  catch a mistake, and no intermediate state is green. That is what this codebase's method depends on.

**THE DUAL SPINE IS A HARNESS, NOT AN ARCHITECTURE.** The end date is the moment the legacy spine is
deleted, and that deletion is a STEP OF THE PLAN. The routing switch goes with it. **Leaving the legacy
route in place is the failure mode, not the fallback** — it arrives as a series of individually
reasonable decisions, and a year later the project has two engines and every change costs double.
**Stopping at 90% does not bank 90% of the value; it banks a liability.**

1. **No permanent exceptions.** A traversal routes to legacy for exactly one reason: the RelIR lowering
   does not yet cover a step in it. Not "this one is hard", not "rare", not "fast enough already". No
   allowlist, no committed exception file. A shape that genuinely cannot be expressed is a §3 node-set
   discussion under §7's bar, recorded here — never a quiet second route left running.
2. **Both counters ratchet.** Coverage only rises (the census `spine` column, measured with the RelIR
   route FORCED ON, never the ambient switch); the §8 list only shrinks.
3. **A stalled countdown is a defect with a name.** If coverage has not moved in a phase, that is the
   finding of the phase.
4. **Coverage at 100% with a non-empty §8 list is a FAILED migration.** The new spine working is not the
   same fact as the old one being gone, and only the second ends this.
5. **The last step costs something, accepted in advance.** Deleting the legacy spine deletes the
   differential's off position. That is a one-time trade at the point where the compared-against thing is
   dead code; what remains is L5's METAMORPHIC oracle (which never needed two implementations), the
   census and the L1–L4 ladder. **Nobody may use "we would lose the differential" as a reason to keep
   the legacy spine alive.**

### 10·5 — a data-sized row set is a VALUE, not a control-flow loop

**The rule: a row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE — a single
JSON bind exploded by `json_each` — never as N parameters, read or write.** §3.6 said that; the root
`CLAUDE.md` said a WRITE chunks through `src/rowbatch.ts`. The conflict was never a performance
question, and this section is ORDERED so that stays legible: three reasons that each decide it with
the benchmark deleted, and the benchmark last. A Bun-versus-workerd ratio can move on any release of
either runtime, and a rule justified by one would read as newly wrong when nothing had changed.

1. **A read cannot chunk, so "one mechanism" already forces it.** Chunking is host-language control
   flow, a loop issuing N statements; a read needs the set as a RELATION INSIDE ONE QUERY — joined
   against, correlated, nested mid-CTE-chain — and a compiled plan is one statement by construction.
2. **RelIR is an algebra and chunking is a hole in it.** A JSON bind is a VALUE the plan carries, so
   transport is one `map` over a marker in `src/program.ts` and `emit` never learns it. Under chunking
   the emitter learns batching, and — load-bearing — a chunked write cannot be a `Ref` a later step
   joins against. That `Stmt`-binding-as-relation IS the pre-mutation snapshot a vertex-drop cascade
   requires. Chunking has no worse version of it; it has none.
3. **The DO cap becomes provable rather than grepped.** One concept replaces `bindChunks`/
   `placeholders`/`jsonbArrayBind`/`RowsBind`, and a plan's bind count is O(plan size) BY
   CONSTRUCTION — something `check` proves. `binds-check.ts` is deletable once the last hand-rolled
   placeholder site is gone.

**Typing goes the OTHER way — JSON is more deterministic than native binds, not less.**
`transportable()` (`src/program.ts`) fails closed naming the binding and column, and on what it does
carry the runtimes AGREE where native binds do not: an integer binds INTEGER on Bun and **REAL on DO**
(the divergence that made CAST-AS-TEXT the int64 read escape), and `boolean`/`bigint` THROW on DO. The
storage class of `1.0` collapsing to INTEGER is unobservable — our type authority is the `vtype`
column, never SQLite's `typeof`.

*What it genuinely costs.* A BLOB cannot travel and `RETURNING` is an arbitrary `Expr` list, so **a
`RETURNING` feeding a retained binding projects `json(x)`, never `jsonb`** (lossless — props are JSON
anyway). Two UNMEASURED ceilings: `json_each` is a virtual table with no statistics, so join order
against a large one can go wrong where an IN-list would not; and the whole set is stringified in JS,
one full copy against a 128 MB isolate, tested only to 20,000 rows.

**Only then, performance — and it agrees.** Median of 7, 20,000 rows × 3 columns, both runtimes — Bun
via `bun:sqlite`, Cloudflare via a throwaway DO under `wrangler dev`:

| | statements | Bun | **DO (workerd)** |
|---|---|---|---|
| INSERT, chunked at `floor(100/3)` | 607 | **12 ms** | 42 ms |
| INSERT, one JSON bind + `json_each` | 1 | 20 ms | **20 ms** |
| DELETE by id set, chunked at 100 | 200 | **20 ms** | 13 ms |
| DELETE by id set, one JSON bind | 1 | 21 ms | **8 ms** |

**The direction REVERSES between the dev runtime and the production one** — chunking wins ~1.7× on Bun,
the JSON form wins ~2× on DO — and the mechanism explains it rather than merely reporting it: on Bun
statement count is not the cost (607 statements and 10 statements are 10.6 ms and 9.9 ms), so what
chunking saves is the per-row JSON extraction; on DO that saving is still there, but 607 `sql.exec` calls
now cross the host boundary and cost more. So the JSON form is also faster where we ship, and choosing
the other because the DEV runtime prefers it is what `src/cf-limits.ts` exists to prevent. **But if a
workerd release erased that gap, none of reasons 1–3 would move.**

*Caveats:* workerd clamps timer resolution inside a DO, so read that column as ratios (the Bun column,
opposite direction, same harness, is what rules out noise). The DO run also reconfirmed the cap — a
2,000-row insert was refused with `too many SQL variables`. **Method worth reusing: a throwaway
`wrangler dev` worker with its own DO measures production SQLite for real in about a minute. Any future
"X is faster" claim about storage goes there before it becomes a rule — and, per the ordering above,
does not become the top line of the rule it supports.**

### 10·7 — the ordering criterion is DELETION, not marginal coverage

An increment is chosen by *which §8 name does this let me delete*, with marginal corpus coverage as the
tiebreak. It was the other way round for the first ten increments and that was correct then: marginal
value is what found `is` at **+53** and `inject` at **+81**, two of the three largest jumps, both
invisible to a fixed worklist — and `is` had read *worth zero alone* one round earlier. That argument
holds only while 30–50-chain wins exist, and they no longer do: what is left is writes, the alias
channel, `repeat` and a long tail of one-host steps. Ranking by coverage from here optimizes a number
that is no longer the binding constraint.

**A small coverage delta is not a failed increment.** The modulator seam was +2 and removed six blanket
declines of one concept. **The blocker instrument keeps its job with a different question** — "where does
the fold give up" still ranks the work, it just no longer decides the order alone.

### 10·8 — the corpus is an INDICATOR; the unit of work is the FAMILY

10·7 changed what to rank by; this changes what an increment IS, and they compose: **read the blocker
table to find WHERE the fold gives up, then expand to the whole FAMILY that step belongs to. Never land
the step alone.** A family closes; a step leaves a ragged edge, and the ragged edge is what makes the
next increment expensive — it re-derives the parse, the projection, the type context or the productivity
rule the first one solved locally. Landing the vocabulary is barely more work than landing its largest
member, because the members ARE one lowering. Evidence, in increasing order of clarity: scalar `order()`
one step one host **+2**; the modulator seam one VOCABULARY **+2 and six declines gone**; `P.typeOf` one
arm of an existing MODULE, every predicate position at once, **+47** — which in a `predicateSql`-style
switch would have been four copies.

**And sweep for DUPLICATION or DEFERRAL GROUPS every round** — not a separate task, it is where the
leverage is, and every round has produced one: a table private to legacy's `plan.ts` that both spines
need (`STORAGE_CLASS`, `REDUCER_CLASSES`, `numericSpec`, `dtFactor`, `JAVA_WHITESPACE` — all now shared,
with legacy reading them too); two optionals describing one fact that should be a total union
(`SubjectType`); one policy with two spellings (`storedCompare` → `storedCompareOn`, with the
relation-column form DERIVED). **Share DATA and pure computation; re-express only the EMISSION.** The
sharp case is `JAVA_WHITESPACE`: Gremlin's `trim()` trims JAVA's 24 code points, not SQLite's space, and
a re-derived list missing U+1680 would be wrong in a way no test would name.

---

## 11. Traps — each one cost a defect

**Every entry here was a SILENT WRONG ANSWER or a fail-closed violation found by an instrument, never by
reading the code.** They are grouped by what they teach.

### Which instrument can see what — run all of them, not the cheapest

| instrument | blind to |
|---|---|
| the **census** (`ms` multiset digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value (a throw records as a deferral, so answering looks like coverage); a lost fast path (same rows, same digest) |
| the **row-for-row probe** vs legacy | a MISSING throw; a wrong ORDER where both spines share the defect |
| the **L2 shape assertions** | a wrong VALUE with the right shape |
| **L3 conformance** | anything the official corpus does not exercise — but it is the ONLY thing that sees a required error message |
| **`rel-sweep`** | asserts the lowering does not THROW, and that a plan it ADMITS renders within the platform's bind cap — both the opposite property to "does not answer wrong" |
| **`test:perturbed`** | nothing about values; it is the only thing that sees an order that was right by SQLite's scan luck |
| **`test:cf-limits`** | anything that is not a DO wall |
| **`rel-blockers`** | everything about correctness; it counts where the fold gives up and nothing else |

**`rel-blockers --step <name>` names the traversals, and the count alone picks the wrong increment.**
A family total is the RANKING; the increment is a question about POSITION and ARGUMENT FORM that the
number cannot answer. `mergeV`'s 26 are 18 at the source, 5 over an element stream and 3 over a scalar
one — three different inputs, and only the first two share a lowering. That split was worth knowing
before writing any of it, and it used to be re-derived by a throwaway script each round.

Corollary, learned the hard way: **a coverage increment is validated by the SHAPE assertions, not by the
census** — the census answers "did anything change", and a wrong shape over an empty result changes
nothing it measures. And L5 derives its seed from `HEAD`, so **a local green `mise run ci` before a
commit does not prove the commit itself green.** The remedy is mechanical and worth using: COMMIT
first, then run `mise run L5` at that commit — that IS the seed CI will use — and only then push.
Measured 2026-08-03: `ci` was green before the set-op commit and CI was RED on it, for a defect the
next commit's local run then found (a legacy `order().by(k).dedup()` losing the order's productivity
drop). One extra `L5` is cheaper than a red trunk.

### The decline contract

- **`null` is the ONLY decline, and it must stay cheap and total.** A step not learned yet is coverage
  not written, not an error. What the lowering must NEVER do is answer a DIFFERENT question — a partial
  lowering that silently drops a filter is invisible to the differential, because both spines are asked
  and only one asked correctly.
- **A module whose contract is `null` must not let a throw escape** — `sliceOf` throws on `range(2,1)`
  and is right to, so the caller catches and declines, handing the traversal to the spine that owns the
  message. Found by sweeping every prefix under all four switch combinations.
- **A FAST PATH IS NEVER SILENTLY DROPPED.** `has(k, containing(t))` routes through the `property_fts`
  trigram index; expressing it as a base-table LIKE scan is a performance regression the census CANNOT
  see while the counter reports progress. So it DECLINES until §4.7. **Coverage measures whether the new
  spine can EXPRESS a traversal, never whether it is entitled to take it from a specialized lowering.**
  The decline reads the CHAIN only, never the `fastPaths` config, so spine choice and fast-path choice
  stay independent.
- **The exception that proves the rule.** `movementCollapse` is EXPRESSED, not declined, because the
  collapse is a plan REWRITE the algebra states exactly (a grouped `SUM(bulk)`) rather than a different
  physical ACCESS PATH. Expressing it keeps the optimization AND keeps the switch meaningful — declining
  would leave L5's differential comparing legacy against legacy. Same for `predicateInlining`, which
  names two STRATEGIES rather than an access path: RelIR implements the correlated `EXISTS` side and
  covers the traversal there. **The distinction is what the flag NAMES.**
- **Fail closed on the CHAIN FACT, not on a list of step names**, which drifts from it. A chain that
  demands an emission order and reaches a step this route cannot thread it through declines WHOLE:
  omitting the channel would not defer, it would pick a DIFFERENT WINDOW from the same multiset — right
  arity, plausible rows, and a census that structurally cannot see it.
- **Fix a defect the migration exposes in BOTH spines, or decline in RelIR — never let the two disagree
  on purpose.** Landing the correct answer only in RelIR puts `test:legacy-spine` permanently red
  against a defect instead of closing it, and the differential is only worth having while it can be
  green.

### Wrong answers with the right arity

- **A non-derivable fact must not be re-implemented.** Typed inject literals (`char`, `uuid`,
  `datetime`, a long past 2^53) all arrive as ordinary JS strings and numbers, so framing by inference
  reframes them with the wrong GraphBinary type. `bareInjectTag` is the one authority and is CALLED.
  **A second implementation of a non-derivable fact is a second chance to get it wrong.**
- **A type ASSERT is not a predicate.** `is(typeOf(LIST|SET|MAP))` RETYPES the stream scalar → list or
  map; lowered as a filter it returns the right ROWS framed as the wrong SHAPE. Reuse legacy's ONE decode
  (`typeOfAssert` → `collectionAssert`), because five arms had already drifted decoding it inline.
- **A dedup must not distinguish rows by their MULTIPLICITY.** Keeping `bulk` in a `DISTINCT` key makes
  the same value at bulk 1 and bulk 3 survive twice, and a following `count()` SUMs the duplicates it
  just removed — invisible on a fixture where bulk is always 1. And a survivor STANDS FOR ITSELF, so the
  multiplicity resets rather than carrying.
- **A parse that must RAISE cannot be a `CAST`.** Over an `inject` literal, `asNumber`/`asDate`/`asBool`
  are parses with TinkerPop's exact messages (`Can't parse string '1,000' as number.`), which SQL cannot
  raise — which is why legacy folds them at compile time. As a `CAST` they answered `1` for `'1,000'` and
  epoch 0 for an invalid date: **a required error became a plausible value.** Generalizes: **a family
  whose members RAISE needs its error cases enumerated as tests, because no differential covers them.**
- **`count()` is not SQL.** SQLite accepts it; the runtime we ship to is unproven. An `Agg` with no
  arguments MEANS "over all rows", and `count(*)` is SQL's spelling — so the star belongs in the emitter,
  not as a node field.
- **A `Lit` cannot express a REAL literal whose value is integral.** A JS `1.0` IS `1`, so legacy's
  `* 1.0` bound as an INTEGER and SQLite did integer division: `mean` answered 30 where the reference is
  30.75. **Say what is meant with an explicit `Cast` to REAL** — reach for `Cast`, never for a `Lit` that
  changes a value's type.
- **`values(k…)` reads EVERY key, not `args[0]`.** Both spines had this: `g.V().values('name','age')`
  returned only names and `g.V().values()` returned nothing. Right arity, plausible rows, no test
  failing, and the census compared it against a baseline recorded from the same defect.
- **A child scope is a different chain.** `withoutFromV`/`withoutPath`: clearing the carried COLUMN
  alone leaves the demand flag set, so the body's first edge step mints it again. And the distinction is
  NOT "does the body mention `otherV()`" — it is whether the child's rows BECOME the traverser
  (`resultEscapes`), because `g.V().local(__.bothE('created').limit(1)).otherV()` names no `otherV()` in
  its body yet reads the `fv` that body has to mint. Only an existence gate may drop the context.
- **`NOT EXISTS`, never `NOT COALESCE(EXISTS(…), 0)`** — an `EXISTS` is never NULL.
- **`likePattern` crashed on `P.not(…)`** (`op.startsWith('not')` with no fourth character to
  lower-case) — latent and unreachable in legacy because every other op is handled first. **Re-expressing
  a function in a context that calls it more generally is itself a defect instrument**; four defects were
  found this way.

### Order and determinism

- **Deterministic, not merely ordered.** `ROW_NUMBER() OVER (ORDER BY encounter, id)` — without the
  tie-break, rows sharing an incoming position are numbered in whatever order SQLite produced them.
  Right multiset, arbitrary window, and no assertion in the ladder can see it. The tie-break is the
  CALLER's argument because only the caller knows what makes its order total.
- **Mint the emission order ONCE over a whole fan-out, never per arm** — `both()` is two joins under one
  `UNION ALL`, and two arms each numbering from 1 would interleave.
- **A sort SUPERSEDES the arriving order**, so where a position is carried it must be RE-MINTED, not
  merely re-sorted: a later slice reads the channel, and taking its window from the stale seed returns
  the right multiset from the wrong place.
- **A correlated hop threads no order at all** — an `EXISTS` asks whether a row is there, never in what
  order — and that falls out of reading the frontier's channels rather than a second parameter.
- **Collapse and emission order are MUTUALLY EXCLUSIVE**, and the lowering says so itself rather than
  trusting its caller: a collapse merges convergent walks by discarding which one arrived, which is
  exactly the per-row identity an order IS.
- **Slice tests compare against legacy row-for-row UNSORTED**, because a slice is the one place the wrong
  ORDER is the wrong ANSWER and the census's multiset digest cannot see it. They must also pass under
  `MOGWAI_REVERSE_UNORDERED=1`.

### Structure and plumbing

- **Pass the input's channels THROUGH; never name a list.** Naming `BULK` on a channel-preserving node
  dropped the position its own input declared, and RelIR then THREW where legacy answers — a fail-closed
  VIOLATION, the one failure mode the routing switch cannot absorb. Found by L5 on a generated
  `E().limit(1).has(…).where(…)`; no corpus traversal has that prefix.
- **Reach for a total `Record` over a predicate.** Three increments produced three total tables
  (`LAYOUT_FIELD`, the barrier policy, `CHANNEL_GROUP_POLICY`) after `isReEncoding` pattern-matched
  exactly one expression and a second legitimate grouping had to WIDEN it rather than consult it.
  Widening a check per case is how a carried field gets dropped at a seam.
- **A CLAUSE READER needs a `Materialize` fence.** Neither `WHERE` nor `ORDER BY` can name a select
  alias, so a `Filter` or `Sort` fused into the block that computes its subject RE-INLINES the whole
  projection: measured **25 / 45 / 65 binds** for one, two and three range predicates (legacy 2 / 3 / 4),
  and **24 for one `order()`** against legacy's 1 — a fourth predicate would exceed the DO cap and fail
  closed where legacy answers. The fence lands legacy's CTE-then-read shape (16 / 38 / 50, linear).
  **Only the FIRST reader needs the hint**, structurally: a later one already sits over a
  `Limit`/`Distinct`/`Sort`/fence the assembler refuses to fuse into.
- **A BIND BUDGET OVERRUN IS A DECLINE, NOT A THROW.** §3.6 makes the DO 100-parameter cap a plan
  property `check` proves, and `check` proves it by THROWING — correct inside the algebra, wrong at the
  routing seam, where it turns a traversal legacy answers into a compile error. So `lowerToRel` asks the
  budget before handing the plan over and declines above the cap. It bites at a knowable
  place: RelIR renders the vtype-aware compare key's class lists as BINDS where legacy inlines them as
  literals, so one element `order().by(key)` is ~26 binds against legacy's 2 and four in one chain
  exceed the cap. Making the key cheaper is a separate increment; making the wall a decline is
  what keeps it out of production. **And a bind spent on a CONSTANT is the cheapest version of this
  wall to remove:** a json object's KEYS are compile-time strings in the node rather than `Expr`s, and
  rendering them with `value()` spent one of the 100 parameters per key — two per `{t,v}` member node,
  two per `as()`, where legacy always inlined them. `textLiteral` (the kernel's spelling for
  compiler-chosen text) is the fix, and the rule it instances generalizes past json: **only DATA is a
  bind.** Inlining data would be the opposite error — the statement TEXT would become a function of the
  data, defeating the cache and the 100 KB budget.
- **AND THE NUMBER IT ASKS FOR MUST BE THE NUMBER THE WALL MEASURES.** The decline above first read
  `planBindCount`, which counts IR OCCURRENCES, while the platform counts the RENDERED bind list — and
  the two differ whenever the assembler spells one `Lit` twice, which is what fusing a clause reader
  into the block computing its subject does. In the algebra the gap reaches **2×** (91 counted, 181
  rendered); swept over every corpus prefix, **50 distinct prefixes rendered more binds than were
  counted, the widest 42 against 31**. None crossed 100 on today's corpus, so the cheap count looked
  correct and would have kept looking correct until one did — at which point the refusal lands at
  EMISSION, past the point where the seam could still have chosen the other route. `lowerToRel` now
  RENDERS once (via `emitRelational` + the kernel's `render`, not `emitQuery`, whose own refusal would
  have to be caught — and the same `catch` would swallow a checker violation, which is the one thing
  `rel-sweep` exists to see). `rel-sweep` gained the property: **a plan the seam ADMITS renders within
  the cap**, checked over all ~38k admitted prefixes. Generalizes past this budget: *a gate that admits
  on a cheaper proxy than the wall enforces is not a gate, and the corpus will hide it for as long as
  the proxy happens to agree.*
- **A WINDOW may not read a WINDOWED column, and that is the ASSEMBLER's rule to know.** SQLite refuses
  a window function inside another window's `OVER (…)` outright (`misuse of window function
  row_number()`), which is the exact shape a minted emission order produces under any later ranking
  (`dedup().by(k)` after `order()`, the cumulative-bulk slice). The alternative was a `Materialize`
  fence at each site — i.e. remembering the rule N times, and it was already forgotten twice in one
  increment. `case 'sort'` closes a windowed block for §11's fence reason instead: an `ORDER BY` cannot
  name a select alias, so fusing re-inlines a whole `ROW_NUMBER()` over a correlated compare key.
- **A capability RelIR gains that legacy lacks puts `test:legacy-spine` red — so fix legacy.** Element
  `order()` reached `order().by(k).limit(n).out(…)`, which legacy threw `step not implemented: out()`
  for: its re-entry gate looked at the IMMEDIATE follower, and a slice hid the movement behind it.
  Widening that gate to the whole remainder gave BOTH spines the shape (+3 corpus traversals, L3 +2 on
  each). The rule this instances is already here — fix it in both spines or decline in RelIR — and the
  differential being green in both positions is what says which happened. **It has now happened twice
  in the same shape, so read the pattern rather than the case:** the alias channel reached
  `select('e').order().by(k).select('v').values(k)`, which legacy failed closed on (`values() cannot
  consume the select result shape`) while the SAME chain without the `order()` worked. Both times the
  gate read a step NAME where the answer depends on the step's ARGUMENTS — a one-label `select` is a
  RE-ROOT, not a value-tail step, so folding it into the tail accumulator swallowed a stream that
  belongs to whatever the label held. `foldableTailStep` is now the predicate and `isSingleLabelSelect`
  is named ONCE, shared with the dispatcher that already routed on it. +1 corpus traversal, L3 +1 on
  both spines, census delta exactly that row with zero changed answers.
- **Relation ids are minted PER LOWERING.** A module-global counter made two compiles of one query emit
  different SQL depending on compile order — breaking every snapshot and any text-keyed cache, but only
  under a particular ordering.
- **A replicated subplan — what `unroll` produces — must carry FRESH relation ids**, or it trips §3.3's
  distinct-sides rule at `check` rather than in SQLite. Two columns sharing a name in one declared type
  shadow each other in the emitter's scope map, so a joined side's `id` needs another name.

### 10·9 — a SHAPE is a VALUE plus a framing arm, NEVER a delegated step

**RelIR never hands a STEP back to the legacy lowering, and the one call it makes into the legacy layer
passes `steps.length` precisely so that it cannot.** `spine.ts` is the whole seam:
`materializeRootStream(engine.lowerStepsStrict(stream, steps, steps.length))` — zero steps remain, so
legacy turns a finished RelIR relation into the root payload and does nothing else.

This came up as a live temptation and it is worth writing down because the cheap-looking version is
wrong. `lowerStepsStrict` accepts an `at < steps.length`, so a terminal `group()` COULD be delegated: let
RelIR lower the element prefix and hand `group()` to legacy's `group.ts`. That reads as "reusing the
framing layer" and is not — `group.ts` holds the barrier, the `by()` key computation and the reduce, all
of which are the ROW-ALGEBRAIC class §8 deletes. **New coverage would be taking a dependency on code
whose removal is the exit criterion**, which is the migration running backwards.

**The boundary is `steps.length`, and that half of this decision stands.** No step is ever delegated, and
that is what the parameter enforces. What this section ALSO claimed — that the materializer staying
legacy's is the settled other half — is **CORRECTED BY §10·10**: `materialize.ts` builds SQL, so it is
RelIR's, and only `execute.ts`'s byte framers are permanently legacy's. Read the two together; where they
disagree, §10·10 wins. So growing a shape has exactly three parts and no fourth:

1. RelIR builds the VALUE with its own nodes;
2. a new `RelFraming` arm SAYS what the relation holds;
3. the arm is turned into `(sql, binds, Shape)` and `execute.ts` frames the rows. Today `spine.ts`
   translates it into a legacy `Stream` and legacy's materializer builds that SQL — an INTERIM
   arrangement §10·10 replaces, not the target.

**The LIST shape is this pattern already done, and it is the template.** `{kind: 'list'; of: ListOf}` is
the arm, `list.ts` builds `jsonb(COALESCE(json_group_array(<member> ORDER BY …), '[]'))`, and legacy's
list materialization frames a RelIR-built value with no legacy step run. It was the largest single
coverage jump so far (+46).

**Prior art agrees, and Calcite agrees more usefully than TinkerPop.** TinkerPop separates the two
producers by SUPERCLASS — `GroupStep extends ReducingBarrierStep<S, Map<K,V>>` (a barrier emitting one
Map) versus `PropertyMapStep extends ScalarMapStep<Element, Map<K,E>>` (one Map per element) — while the
VALUE type is the same `Map<K,V>` in both, which is why unifying them in one shape is faithful rather
than a shortcut. Calcite goes further and has **no map stream at all**: `Aggregate` (GROUP BY) yields an
ordinary relation (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/Aggregate.java:80`,
`extends SingleRel`), and a collection VALUE is an aggregate FUNCTION over a group
(`…/sql/fun/SqlStdOperatorTable.java:2494` `COLLECT`, typed by `…/sql/type/ReturnTypes.java:847`
`TO_MULTISET`; `…/sql/fun/SqlStdOperatorTable.java:1662` `JSON_OBJECTAGG`) or a constructor expression
(`…:2374` `MAP_VALUE_CONSTRUCTOR`), with MAP a first-class type via
`…/rel/type/RelDataTypeFactory.java:134` `createMapType`. A map is a type plus a function, never a
kind of stream. That is the decomposition to copy.

**Decision, locked: the MAP SHAPE is the next family, built this way.** `g.V().group().by(k)` is two
ordinary `Aggregate` nodes — `Aggregate(groupBy: [key], aggs: [<value>])` for the grouped relation, then
`Aggregate(groupBy: [], aggs: [<pairs array>])` for the one map value — and `Aggregate.groupBy` is
already in the node set, unused for this. Chosen for DEPENDENCY, not for size: `stream.ts` states that
*"every producer (group/groupCount/valueMap/is(typeOf(MAP))) builds this one shape"*, so `valueMap`'s
mid-chain cases, all 30 keyed `group`/`groupCount` cases and the `is(P.typeOf(MAP))` decline are behind
it. Picking either other family means building it later anyway, under pressure.

**LANDED — `groupCount()`, the family's first arm** (+4, 32.0%, and L3 1713 → 1714). It cost about what
the list shape cost and confirmed the decomposition: `Aggregate.groupBy` needed nothing built,
`{kind: 'map'}` rides the existing `materializeRootStream` call exactly as `{kind: 'list'}` does, and no
step is delegated. `src/compiler/rel/map.ts` is the eighth vocabulary module; `byNode` joins `byExpr` in
the `by()` vocabulary because a map key is a TYPED value and one subquery must yield the value and its
`vtype` together.

**Four defects on the way, each caught by a DIFFERENT instrument — the clearest evidence yet for §11's
"run all of them, not the cheapest":**

- **Double encoding.** `json_group_array` re-encodes a `{t,v}` envelope as a JSON STRING, so the framer
  saw the text `{"t":"int","v":27}` where a tagged 27 belonged. `json()` around each side is
  load-bearing, and `list.ts` documents the identical trap. **Only a byte-level diff sees this** — the
  entry count and the values were already correct.
- **`ProductiveByStrategy`.** Hardcoding `IS NOT NULL` instead of asking `productivityFilter` changed the
  answer for `withStrategies(ProductiveByStrategy).V().groupCount().by('age')`. **Only the CENSUS saw
  it**, and it could not have been seen by comparing spines: both were being asked the wrong question
  identically until one stopped.
- **The key inlined 3–4 times.** Grouping directly BY a correlated subquery repeats it in the SELECT, the
  GROUP BY and (once the productivity filter became a HAVING) twice more. **An L2 assertion caught it**,
  at four copies. Projecting the key to a column and FENCING that projection — the emitter fuses a plain
  `Project` straight back in — takes it to 1 against legacy's 1, and 2 against legacy's 4 for a label key.
- **A relation out of scope.** A `Col` names a node's DIRECT child and the filter sits between the
  projection and the aggregate. **`check` caught it.**

**`hasNot(key)` was missing from BOTH spines** and was found by writing a graph-check for these pins. It
is now the exact negation of a bare `has(key)` through the same `hasProp`/`hasPropertyClause` waist, so
the two cannot disagree about what carrying a property means — and it is the L3 +1.

**Six more tests were asserting a ROUTE**, all six failing on migration having found no defect, so
`grouped()` joins `written()` in the harness. Two L2 SQL snapshots are now pinned to `{spine: 'legacy'}`
because their subject IS that lowering; the bulk-weighting test asserts the PROPERTY rather than either
spelling, which exposed that RelIR emits `COUNT(*)` where legacy emits `SUM(bulk)` under
`movementCollapse: false` — equivalent, because bulk is 1 there. **Name both routes explicitly in a test
that compares them**: reading the ambient default made one assertion mean "whatever this run is
configured for", and the differential failed it immediately.

**What remains of the family:** `group()` (41), whose value side with no `by()` is a LIST OF ELEMENTS per
key — so `valOf` is `{kind: 'list', of: 'elem'}` and the materializer expands each pair. Then
`group().by(k).by(<reducer>)`, which is a scalar value and lands with the reducer vocabulary. Then the
mid-chain consumers (`unfold()` to entries, `select(Column.keys/values)`), which is what makes the map
arm re-enterable and what `valueMap`'s 28 mid-chain cases need.

**The cost estimate that lost this its "cheap" label, recorded so it is not re-made:** 43 of the map
shape's 64 blockers are terminal, and that was briefly read as "43 cases behind a framing seam". It is
not — under this decision the grouping is RelIR's own work, so the increment is list.ts-scale. The three
candidate families are therefore closer in cost than the terminal/mid-chain split suggests, and
dependency is what separates them.

### 10·10 — the boundary is `Shape`, not the materializer. CORRECTS §6 and §10·9.

**§6's closing line and §10·9 both drew the line in the wrong place, and this supersedes them.** They said
the shape-interpreting class — "materialization, framing, JSON construction" — stays legacy's per-shape
forever. Two of those three do. The middle one does not, and lumping them together was the error.

**`materialize.ts` BUILDS SQL.** `materializeRoot` is `readCompiled(query, tail, shape)`: every
`materialize*Root` composes a `q` SELECT and picks a `Shape`. That is a query producer, and by decision #3
a query producer is RelIR's. What is genuinely permanent and genuinely not RelIR's business is the layer
AFTER it: `execute.ts`'s framers, which take ROWS plus a `Shape` and yield GraphBinary with no SQL
anywhere. **`Shape` is the real boundary, and it already exists.**

So the three layers, named apart:

| layer | what it does | whose |
|---|---|---|
| row algebra | movement, filter, aggregate, join | RelIR — decided |
| **payload projection** | element id → labels JSON + property bag; the list/map/record blob assembly | **legacy today; RelIR's by this decision** |
| byte framing | `(rows, Shape) → Buffer[]` | `execute.ts` — permanent, per-shape, correctly so |

**§2 is UNAFFECTED and must not be weakened to accommodate this.** Its claim is about the NODE SET: a
`src/rel/` node may never carry a `kind: 'scalar' | 'element' | …` field, and `src/rel/` may import
nothing from `src/compiler/`. Both stay. The payload projection would be built in `src/compiler/rel/`,
which already owns `RelFraming` and already knows Gremlin shape — the same side of the clean-room line as
`list.ts` and `map.ts`, emitting the same shape-free nodes. Moving SQL construction between two modules
that are both outside `src/rel/` is not a clean-room question at all.

**THE ARGUMENT IS NOT PURITY — the current line is already binding, in three measured ways:**

- **`LAYOUT_FIELD` declares `null` for `path`, `origin` and `branchOrder`, and THROWS.** RelIR is blocked
  from carrying a path by the TRANSLATION, not by the algebra. The channel core can hold it; the seam
  cannot express it.
- **`materializeRootStream` throws for an `ElementStream`.** So for every covered element traversal —
  most of today's 32% — legacy's `lowerSteps` builds the payload SQL after RelIR's relation. **RelIR does
  not currently produce the whole query**, which is not what §5a's equivalence gate reads as.
  **LANDED (2026-08-04, `debf46f`)** — `src/compiler/rel/element.ts`. For an element result the plan IS
  the whole query and `spine.ts` never reaches the framing layer.
- **`materialize.ts:191` throws `'a terminal map with an element key or value not yet supported'`.** The
  next arm of the map family — `group()`, 41 blockers — is blocked by a throw in the code §8 deletes. To
  advance RelIR one would have to edit legacy's tail. **That is the migration running backwards**, and it
  is the same trap §10·9 was written to close, arriving from the other side.

**Shape by shape, with what each needs.** The whole of `materialize.ts` is 294 lines and the eleven
per-shape builders are ~250 of it, so the file is not the work — the ELEMENT payload is, and it is the
keystone because it is what every element-returning traversal already depends on.

**CORRECTION — three rows below said "done" and were wrong, in the direction this section was written to
catch.** What existed for scalar, list and map was the RELATION: a `v`/`vt` pair, a JSONB `list` column, a
JSONB `map` column, all built by RelIR nodes. The PAYLOAD PROJECTION — the root `SELECT` over that
relation and the `Shape` choice beside it — was still `materialize.ts`'s, reached through `spine.ts`'s
`Stream`, and for a list whose leaf is an element or another list `elementListResult`/`nestedListResult` are
real payload SQL rather than a wrapper. So the honest count at the time of writing was **zero of eleven**,
not four. This is the same error §10·10 opens by naming, arriving inverted: there a substrate was declared
MISSING when it was merely not reached; here three were declared DONE because what they need was
partly present. The state column below now says which HALF exists.

| shape | payload projection | RelIR nodes | state |
|---|---|---|---|
| **element** | id + labels JSON aggregate + ordered property bag | `Aggregate`, `json-object`, `json-array`, correlated `Scalar` — all in the node set | **LANDED** `debf46f` — `element.ts`. `AggFn` gained `json_group_object`; the bag's entry order is now the aggregate's own `ORDER BY` rather than a subquery's, which legacy relies on surviving a boundary it does not |
| scalar / value | `SELECT v[, vt]` | `Project` | relation done; the ROOT projection is still legacy's. A `Project` over the encounter `Sort` — the smallest arm left |
| list | `SELECT json(list)` | `Aggregate` + `json_group_array` | relation done (`list.ts`). Bare/typed/set roots are `json(list)`; a NESTED leaf needs `Explode` + `Aggregate` (legacy's `nestedListResult`), an ELEMENT leaf needs the element payload as a member (`elementListResult`) — which `element.ts` now makes reachable |
| map | `SELECT json(map)` | as above | relation done (`map.ts`). The scalar/scalar and scalar/list roots are `json(map)`; an ELEMENT side is the `materialize.ts:191` throw below |
| property | `vpid/owner/pk/pv/pvtype/pmeta` | `Scan` + `Project` | needs the property shape anyway |
| record | one wide row, heterogeneous fields | `Project` + child joins | needs `project()`/`select()` |
| mapEntry | `mk`/`mv` per row | `Explode` | arrives with map re-entry |
| path | positions, or grouped rows | needs the path CHANNEL first | Phase 3-adjacent |
| variant | dynamic-tag union | `Union` + tag column | the variant arm exists in legacy only |
| group (rows form) | — | — | **DIES.** The map value replaces it |
| foreign | landed `VALUES` columns | federation-specific | out of scope here |

**Sizing, honestly: comparable to the write wedge, not to an increment.** `group`'s rows form is deleted
rather than ported, and three shapes (property, record, mapEntry) arrive with families that are queued
anyway. What this decision commits to FIRST is the **element payload** — not optional, because it is the
shape 32% of the corpus already routes through.

**What it buys, and why it is worth a phase of its own:** `path` becomes carryable (the channel exists and
has nowhere to go), the element-valued map stops being blocked on the wrong side of the line, `spine.ts`
shrinks to a router with an end date, and "edit legacy to advance RelIR" stops recurring. It also makes
§5a's gate mean what it says — that RelIR produced the query being compared.

**Ordering: this comes BEFORE `group()`**, because `group()` is the first increment that would otherwise
require editing legacy's materializer.

### 10·10·1 — `RelResult` is the ratchet, and the deletion criterion is a TYPE

The migration needed a way to say "this arm's payload is in the plan; that arm's is not" that a later
increment could not quietly undo. A boolean or an optional `shape?` would have been exactly the
two-optionals-plus-implicit-third trap `ScalarType` and `ListOf` were both cleaned up out of. So
`RelLowering` carries a union (`lower.ts`):

```ts
export type RelResult =
  | { readonly kind: 'wire'; readonly shape: Shape }
  | { readonly kind: 'stream'; readonly framing: Exclude<RelFraming, { readonly kind: 'elements' | 'discard' }> };
```

Three properties fall out, all wanted:

- **An arm that migrates is removed from `stream`'s `Exclude`**, so routing it back through legacy's
  materializer is a compile error rather than a review question.
- **`spine.ts`'s remaining legacy call is reachable from ONE arm**, and the `unreachable(framing)` at the
  end of its cascade is now proved by the type instead of asserted by a comment.
- **The deletion criterion is the union going uninhabited.** When the last arm migrates, `stream` has no
  inhabitants, the arm deletes itself, `RelResult` collapses to a `Shape`, and with it go `layoutOf`,
  `LAYOUT_FIELD` and `RelLowering.aliases` — which is what unblocks the path channel (first bullet above).

`RelFraming` is unaffected and stays the fold's INTERNAL vocabulary: an arm merge and a retype need to
know what a relation HOLDS, which is a different and larger question than which `Shape` frames it.

**A note on the bind budget, since it was the predicted risk.** The element payload adds three `Lit`s per
projection — `storedValueOn`'s `IN ('list','map','set')`, which legacy inlines as literal text. Census
after: **736/2298 (32.0%), unchanged**, and `rel-sweep` still renders all 53,020 admitted plans inside the
100-bind cap. So the constant-inlining question §11 raises for the compare key's ~27 binds is real but is
NOT this arm's blocker, and it stays a separate increment rather than a prerequisite.
