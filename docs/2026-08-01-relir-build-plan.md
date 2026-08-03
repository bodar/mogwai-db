# RelIR — the build plan

**Status: BUILDING.** Coverage **424 / 2,298** corpus traversals on the RelIR spine; deletion counter
**110** references left across the 15 legacy rows. Both are ratchets in `ci` (§10·4). The direction was
argued in [codebase-analytics](./2026-08-01-codebase-analytics-and-blue-sky-restructure.md) §6/§6a and
is not re-argued here.

**Section numbers are an API.** ~96 comments in `src/`, `scripts/` and `test/` cite `§3.5`, `§5a`,
`§10·4`, `§10·5` and friends. Renumbering breaks them; content under a number may be rewritten freely.

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

**Gate before Phase 2 ships:** re-run P5/P5b under DO SQLite via `mise run test:cf-limits`. `RETURNING`
and `ON CONFLICT` are the exact species of "passes on Bun, walls in production" that seam exists for.

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

**Shape does not enter RelIR at all.** RelIR sits downstream of lowering, so Gremlin shape is already
resolved and rides to the wire as `Compiled.shape`. **If a RelIR node ever acquires a
`kind: 'scalar' | 'element' | …` field, the layer has failed and should be reverted.** `ChannelRole` is
not that field: a role is per-COLUMN carried-state bookkeeping, never the stream's Gremlin type.

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
type Binding = { readonly name: string; readonly node: Rel | Stmt }
// plus one source node:  Ref { name }
```

A `PriorResult` and a named-CTE reference are the SAME concept — a reference to a relation computed
earlier — and having two mechanisms for it is why the write path reads as a second machine. One concept:

- a `Rel` binding referenced more than once → a **CTE**; that is `name`'s decision (§4.6), a property OF
  THE PLAN rather than a map carried beside it.
- a `Stmt` binding → a **statement boundary**. The executor (`src/program.ts`, outside `src/rel/`) runs
  it, retains its `RETURNING` rows, and the same `Ref` resolves to them as ONE JSON bind exploded by
  `json_each` — never a row-count-sized placeholder list.
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
  factory. Subject to P1.
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

---

## 5. The emitter — a SELECT block assembler

Built on the `q` kernel **additively only** (it gained `identifier()`; nothing in the kernel may be
reshaped to suit RelIR). **Total** — every kind has an arm, no fallback, so an unrenderable node is a
compile error, not a runtime throw.

**The IR is normalized (one operator per node); SQL's `SELECT` is a COMPOSITION of operators with fixed
slots. Converting between those shapes is the emitter's whole job.** So it accumulates a block —
`{select, from, joins, where, group, having, order, limit, distinct}` — walking down from a node and
opening a nested `SELECT` only when the slot it needs is occupied. Prior art: Calcite's
`RelToSqlConverter`. This is why `Project(Filter(Join))` is one statement, and it is what deletes
`TailAcc`.

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

**What remains of the family, in order:**

1. **`fold()` — 109 traversals, and every one of the remaining list blockers.** The obstacle is the
   MEMBER ENCODING, not the barrier: `fold()` over a stored-property stream emits `{t,v}` typed nodes,
   decided by a correlated `EXISTS` over the same relation (`vtype NOT IN ('string','double','int')`),
   and every member READER then needs the `CASE WHEN je.type='object'` decode. `isBareList` is the gate
   that keeps today's ops honest until that lands.
2. **The SET-OP family — 35 traversals, newly visible in the residue** (`combine`/`difference`/
   `intersect`/`merge`/`product`/`disjunct`, 5–6 each). One lowering: a list OPERAND plus a set
   expression over two `json_each`es. Ranked second because it is a family with one frame, and the
   frame is the one just built.
3. `order(Scope.local)`/`dedup(Scope.local)`, which need the member compare key and the
   first-occurrence rule respectively.

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

**The rest of the corpus ranking** (`mise run rel-blockers`, 424 routed — re-run it every round, it
MOVES): writes 187 (`addV` 146 · `mergeV` 25) · side effects 160 (`aggregate` 59 · `group` 51 ·
`sack` 25 · `groupCount` 25) · aliases 145 (`as` 134) · the list shape 109 (all at `fold`) · scalar
transforms 92 · the property shape 89 (`properties` 46 · `valueMap` 37) · branch 68 (`choose` 39 ·
`union` 22) · row ops 6. In no family: `repeat` 78 · `has` 59 · `local` 56 · `where` 43 · `is` 43 ·
`match` 36 · the SET-OP family 35 (`combine`/`difference`/`intersect`/`merge`/`product` 6 each,
`disjunct` 5) · `path` 28 · `inject` 20 · `call` 20. **The residue is where the next family gets
recognized** — `inject` sat in it for two rounds before being spotted as the largest prize on the
board, and the set ops appeared in it the moment the list frame landed.

**Also 4.1's, and unfinished:** the ALIAS channel (`as`/`select`, 144) needs a name→column map, which is
one of the four roles `spine.ts`'s layout translation declares ABSENT rather than leaving to be
forgotten (with path, origin and branchOrder).

### Phase 2 — the write wedge

`Insert`/`Update`/`Delete` bindings over read plans. 2.1 (§3.0 down to a program running against
SQLite, including the executor) is COMPLETE; what is not built is the way in, which is why 4.1 comes
first.

- **2.2** `drop()` → `Delete` with an `InQuery` membership predicate.
- **2.3** `property()` → `Update{from}` / `Insert … ON CONFLICT`. Expressing `Cardinality.list` as an
  `Insert` of N rows rather than a JS overwrite is a structural fix for the cardinality bug class.
- **2.4** `addV`/`addE` → `Insert … SELECT … RETURNING`, with P5b's correlation key and an `ORDER BY`
  on the source so id assignment stays emission-ordered.
- **2.5** `mergeV`/`mergeE` → `Insert … ON CONFLICT DO UPDATE … RETURNING`, one statement.
- **2.6** **Delete `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`, `parseMergeOptions`,
  `resolveEndpoint`, `materializeElementDrivers`, `WritePlan`.** The phase is not done while a second
  step dispatcher exists.

**Phase 2 supersedes [write-path](./2026-08-01-write-path-plan.md) and inherits its requirements.**
W1/W4 are landed and must not regress (four L4 pins + the perturbed census); W2 §3 and W3 §4 are this
phase's acceptance criteria and should be re-measured at its start. **W2/W3's two declared blockers
dissolve by construction — do NOT build a driver abstraction to satisfy them:** `Insert.source` IS a
read plan carrying the channels, so there is no driver to widen, and W3's unreachable positions are plan
composition. write-path §6 and §7 (the traps) carry over unchanged — especially trap 3, *check whether a
refusal is the reference's answer before removing it* (a third of the write messages in L3 telemetry
belong to scenarios that PASS by asserting the throw).

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

**The shape-interpreting class (materialization, framing, JSON construction) stays per-shape forever and
correctly so.** Phase 4 is finished when the ROW-ALGEBRAIC class is gone from the shape tables — not
when the shape tables are gone.

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
`parseMergeOptions` · `resolveEndpoint` · `materializeElementDrivers` · `WritePlan` · `TailAcc` ·
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

### 10·5 — BY MEASUREMENT: one value, never N parameters

§3.6 said a large row set lands as one JSON bind; the root `CLAUDE.md` said a WRITE chunks through
`src/rowbatch.ts`. Measured on both runtimes — Bun via `bun:sqlite`, Cloudflare via a throwaway DO under
`wrangler dev`. Median of 7, 20,000 rows × 3 columns:

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
now cross the host boundary and cost more.

**The rule: a row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE, never as N
parameters — read or write, nothing to choose.** Choosing the other form because the DEV runtime prefers
it is precisely what `src/cf-limits.ts` exists to prevent. It collapses `bindChunks`/`placeholders`/
`jsonbArrayBind`/`RowsBind` into one concept and turns the DO cap from an idiom `mise run binds` greps
for into a structural property `check` proves. `RowBatch` shrinks to whatever JSON cannot carry (a blob).

*Caveats:* workerd clamps timer resolution inside a DO, so read that column as ratios (the Bun column,
opposite direction, same harness, is what rules out noise). The DO run also reconfirmed the cap — a
2,000-row insert was refused with `too many SQL variables`. **Method worth reusing: a throwaway
`wrangler dev` worker with its own DO measures production SQLite for real in about a minute. Any future
"X is faster" claim about storage goes there before it becomes a rule.**

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
| **`rel-sweep`** | asserts the lowering does not THROW — the opposite property to "does not answer wrong" |
| **`test:perturbed`** | nothing about values; it is the only thing that sees an order that was right by SQLite's scan luck |
| **`test:cf-limits`** | anything that is not a DO wall |

Corollary, learned the hard way: **a coverage increment is validated by the SHAPE assertions, not by the
census** — the census answers "did anything change", and a wrong shape over an empty result changes
nothing it measures. And L5 derives its seed from `HEAD`, so **a local green `mise run ci` before a
commit does not prove the commit itself green.**

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
  routing seam, where it turns a traversal legacy answers into a compile error. `lowerToRel` asks
  `planBindCount` before handing the plan over and declines above the cap. It bites at a knowable
  place: RelIR renders the vtype-aware compare key's class lists as BINDS where legacy inlines them as
  literals, so one element `order().by(key)` is ~27 binds against legacy's 2 and three in one chain
  would exceed the cap. Making the key cheaper is a separate increment; making the wall a decline is
  what keeps it out of production.
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
  differential being green in both positions is what says which happened.
- **Relation ids are minted PER LOWERING.** A module-global counter made two compiles of one query emit
  different SQL depending on compile order — breaking every snapshot and any text-keyed cache, but only
  under a particular ordering.
- **A replicated subplan — what `unroll` produces — must carry FRESH relation ids**, or it trips §3.3's
  distinct-sides rule at `check` rather than in SQLite. Two columns sharing a name in one declared type
  shadow each other in the emitter's scope map, so a joined side's `id` needs another name.
