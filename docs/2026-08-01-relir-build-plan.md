# RelIR — the build plan

**Status: BUILDING.** The two counters this migration runs on — spine coverage and the deletion ratchet —
are NOT copied here. They live in `test/census/goldens.tsv` and `scripts/deletion-ratchet.tsv`, both gated
in `ci` (§10·4), and a number in prose is a second authority that goes stale between commits (it did: the
header carried 563/110 while the artifacts said 775/98). Read them from the artifacts, or from a `ci` run.
The direction was argued in
[codebase-analytics](./2026-08-01-codebase-analytics-and-blue-sky-restructure.md) §6/§6a and is not
re-argued here.

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
- **`Param`.** ~~The front-end resolves wire parameters into `Step.args` before the IR exists, so
  nothing downstream could construct one.~~ **SUPERSEDED — this was the bug, not a constraint.** The
  front-end flattening a `$x` into a bare value at `frontend.ts:415` is exactly why a compiler-held
  constant is indistinguishable from a user parameter, so every value defaults to a bind and pollutes
  the 100-bind budget. A parameter is a first-class product concept and gets a representation at every
  layer (wire → IR → a RelIR `Param`, spelled `lit`'s `source: 'parameter'`), with reduction to a
  concrete value deferred to the last responsible moment (only `unrollFixedRepeat` needs it). Rationale
  and phased plan: `docs/2026-08-05-parameters-are-the-only-binds.md`. This matches TinkerPop 4's
  `GValue`/placeholder design.
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

The node DECLARES which it is by WHICH CHANNELS IT CARRIES — none is the barrier contract, its input's is
the per-traverser reduction — and the table checks it is allowed to. (This sentence used to name
`isReEncoding`, a narrower predicate that pattern-matched the one `SUM(bulk)` shape it had seen; it was
deleted for the reason `src/channels.ts` records at `CHANNEL_GROUP_POLICY`, and the policy table is the
replacement.) `CHANNEL_GROUP_POLICY` is the third total table: which roles have a defined answer when N
rows become one — `bulk` combines (adds), `encounter` combines (earliest); an alias, path, origin or
sack belong to ONE member, and a grouping would take whichever row SQLite reached first.

### 3.6 Two budgets the plan owns, not the emitter

- **Binds.** Query and store data render as binds; compiler-authored SQL vocabulary may render as a
  safely escaped literal. A plan carries `bindCount()` and **fails closed above the DO cap of 100**
  rather than emitting SQL that only fails in production. The cap is also checked against the RENDERED
  bind list, because a fused block can spell one data value more than once. An over-budget `Values`
  or a statement's retained rows land as ONE JSON bind exploded by `json_each` — done by the `land`
  pass (§4.5b), so `emit` never learns about chunking. This makes the DO cap a *plan property* `check`
  can prove instead of an idiom `mise run binds` greps for.
- **Statement text.** DO caps at 100 KB. `unroll` multiplies plan size, so it consults the rendered size
  and declines above a ceiling, falling back to `Recursive` — which then refuses a barrier body as a
  clean deferral. P4 says the corpus max is `times(10)`, so the ceiling exists to make a hand-written
  `times(1000)` degrade honestly.

---

## 4. The passes

**The pipeline is one ordered list applied by a FOLD — Calcite's `SequenceProgram` shape, and NONE of
its planners.** `Programs.sequence` runs each sub-program once, output→input
(`vendor/calcite/core/src/main/java/org/apache/calcite/tools/Programs.java`, `SequenceProgram` at
`:394`), which is a fold of TOTAL functions — exactly our passes. We do NOT want `HepPlanner` (fixpoint
rule-firing) or `VolcanoPlanner` (cost-based search): a rewrite here fires once, deterministically. We
also deliberately DECLINE TinkerPop's ordering machinery — `TraversalStrategies` topologically sorts
strategies by per-item `applyPrior`/`applyPost` inside category bands
(`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/TraversalStrategies.java`,
`sortStrategies`). A fixed linear list is simpler and sufficient; the order below is short and
hand-declarable, so a t-sort would only add a cycle-detection failure mode for nothing. **Do not
"upgrade" the list to a category-sort.**

**Two element types, one lift.** Most passes are **`RelPass = (Rel) => Rel`** — total, memoised so the
DAG stays a DAG (§3.4), structure declared ONCE in `src/rel/walk.ts` with no `default` arm so a new node
kind is a compile error not a skipped case. Two are **`PlanPass = (Plan) => Plan`**: `name` (mints
bindings) and `check` (verifies the whole program). A `RelPass` is LIFTED to a `PlanPass` by **`perRel`**
— map it over `{bindings, result}`, a `Stmt` binding untouched — which is the generic form of today's
hand-rolled `landPlan`. **`prune` is the one `RelPass` whose lift is NOT a naive map**: each binding's
required columns are the UNION over its `Ref` consumers, so its lift reads the whole program — which is
why Calcite makes field-trimming a whole-tree transformer (`RelFieldTrimmer.trim`,
`vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/RelFieldTrimmer.java:173`) and NOT a
node-local rule ("each `RelNode` needs to return a different set of fields after trimming").

**`RelPass`, NOT `Pass` — the name is load-bearing.** `Pass` is TAKEN: the LEGACY `Step[] → Step[]`
system (`src/compiler/ir/pass.ts`, categories `extract < decoration < canonicalize < simplify < verify`,
`src/compiler/CLAUDE.md`). A `RelPass` rewrites the RELATIONAL tree, a different layer, so it takes a
different name and lives in `src/rel/passes/`. An agent adding a step-chain rewrite grows the legacy
`Pass` pipeline; one adding a relational rewrite grows THIS one. The `arch-check` gate governs the legacy
`Pass` only — a `RelPass` is unrelated to it.

**Order is RUN-order, and it differs from the build-order numbers below.** `check` is numbered 4.1
because it was built first and is always-on in dev/tests — but it RUNS LAST: a terminal verifier over the
fully-rewritten plan that analyses and throws, exactly as TinkerPop's `VerificationStrategy` is the
terminal category (`.../traversal/TraversalStrategy.java`, "analyze the traversal and throw… no more
behavioral tweaking") and exactly as `checkPlan` runs inside `emit` today. Run-order:
**`flatten → unroll → fuse → prune → land → name → (recognize, Phase 4) → check`.**

- **4.1 `check`** — the fail-closed verifier and the first thing built: column resolution, `Agg` only in
  `Aggregate`, `WindowExpr` only in `Window`, `SelfRef` only in its `Recursive.step`, the §3.5
  obligations, both §3.6 budgets. Always on in dev and tests.
- **4.2 `flatten`** — join flattening / subquery decorrelation into the P1 envelope. **This is what
  deletes `expandRepeatBody`**; P2 is the evidence its refused vocabulary is legal once flattened.
- **4.3 `unroll`** — replicate a subplan *n* times and chain it: P4's `times(n)` route, 48 of 53 barrier
  bodies. With no `Recursive` in the output there is no recursive term, so every P1/P3 prohibition
  evaporates and a barrier is an ordinary `Aggregate`/`Window`.
- **4.4 `fuse`** — the reserved home for SEMANTIC algebraic rewrites, and **wire it as a NO-OP** (identity)
  with the contract written into `fuse.ts`'s own header, so an agent who reads the FILE and not this plan
  sees the emptiness is intentional, not forgotten. The header must say both halves:
  - **Belongs here** (unbuilt, add when a case is shown to buy something the assembler cannot):
    `Distinct(Distinct x)` collapses, `Limit` over `Limit` composes, a `Sort` dead before a barrier goes —
    same-semantics collapses across ADJACENT nodes.
  - **Does NOT belong here, and each has a home:** adjacent `Filter`s conjoin — the ASSEMBLER already does
    this (`src/rel/emit.ts`, `conjoin(b.where, pred)`), so `fuse` must not (this was its one historical
    rewrite; drop it when wiring); `Sort`+`Limit` is one SELECT's slots (§5, the assembler); collapsing a
    run into a `Select` mega-node is REFUSED outright — it puts the SQL surface inside the IR (§5, §7). The
    assembler, not `fuse`, is what deletes `TailAcc`. So `fuse` stays a no-op until a rewrite from the
    "belongs here" list earns its place.
- **4.5 `prune`** — column pruning; a node's need is the UNION over its consumers (Calcite's "trim unused
  fields", `RelFieldTrimmer`). Load-bearing rather than cosmetic: it is what makes `unroll`'s replicas
  affordable. **Two facts gate it, both Phase-3 work, not follow-up:** today it prunes NOTHING below a
  `Join`/`Union`/`Aggregate`/`Recursive` (its own declared remainder) — and a flattened `repeat` body is
  MOSTLY joins, so on exactly the plans `unroll` produces the current `prune` is a no-op; and it carries a
  latent correctness bug — it collects column refs only inside the `project` arm, so a non-`Project` parent
  that itself reads a column can have it pruned from under it. Closing the remainder AND fixing that
  reference-collection are prerequisites to `unroll`.
- **4.5b `land`** — the bind-budget lowering (§3.6). Declines a row holding anything but a `Lit`, and the
  budget then fails closed on it. **WIRED today, ad-hoc, via `landPlan` (`compiler/rel/lower.ts`)** — which
  IS the `perRel` lift written by hand (map over `{bindings, result}`, `Stmt` untouched). When the pipeline
  object lands, `landPlan` dissolves into `perRel(land)` at its declared position; Calcite models this same
  late, over-budget-only rewrite as a trailing "physical tweaks" phase + `ConditionalProgram`
  (`Programs.java` `:351`, `:415`).
- **4.6 `name`** — named CTE versus inlined derived table for every shared node, honouring
  `Materialize`. One policy applied with the whole plan visible, instead of a judgement call at 163
  `q.cte` sites.
- **4.7 `recognize`** *(Phase 4 only)* — the fast paths as plan rewrites, so equivalence is structural
  and recognition failure is "no rewrite fired" rather than a separate code path.

**DECLARED, PARTLY WIRED — and the pipeline OBJECT is deferred to Phase 3 ON PURPOSE, not by neglect.**
`check` (inside `emit`), `name`, and now `land` (ad-hoc `landPlan`) have production callers; `fuse` and
`prune` do not, and no object yet applies the run-order above — it lives in this list. Building that object
NOW would mean an ordered container with one real occupant, which is the same organic-growth-in-the-
easiest-place this section exists to prevent. The three unbuilt passes that give the pipeline its weight —
`flatten` (§4.2), `unroll` (§4.3), and `prune`'s closed remainder (§4.5) — are ONE COUPLED Phase-3 body:
`unroll` replicates a flattened, join-heavy body; `prune` is what makes the replicas affordable; the
pipeline object is what orders `flatten → unroll → prune → land → name`. And `unroll` is itself downstream
of Phase 3.1 (a `Recursive` node — no production caller today, so every `repeat()` still declines to
legacy). **So the design is FIXED here — the `RelPass`/`PlanPass` split, the `perRel` lift, the fold, the
run-order, `RelPass` vs the legacy `Pass`, `fuse` as a documented no-op — so that Phase 3 drops those
passes into a named home instead of inventing one.** Until then `land`'s ad-hoc wire is correct, and
`fuse`/`prune` stay unwired by design.

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

- **`RelLowering` is `{plan, shape}`** (it was `{plan, framing}`, and `{plan, framing, aliases}` before
  §10·10 moved the payload projection in). Its `cols` and `channels` were properties of `plan.result`
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
- **The alias role was the ONE `LAYOUT_FIELD` entry whose framing form is a NAME MAP** (`named`), not a
  column: a Gremlin label name is not something a `Channel` may know (§2), so it cannot live on the
  relation. While the seam existed the lowering handed the map over beside the plan and `spine.ts` PROVED
  its columns were the result relation's alias channels, throwing rather than declining because a map
  naming a column the relation does not emit is a silent empty result. **§10·10 retired all of that**:
  `LAYOUT_FIELD` is deleted, nothing crosses, and the map is read only by the `as()`/`select()`
  vocabulary that builds it. The channel-core rule it illustrated still holds; the seam it described
  does not.
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
`externalAliases`/`bareColumns` back channels · `sameLayout`-by-`JSON.stringify` ·
`LAYOUT_FIELD`/`layoutOf`, the `Channels`→`TraverserLayout` bridge §10·10 retired.

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

**FIRST: most of them are ALREADY INSIDE `mise run ci`, so "run all of them" is not "invoke all of
them".** `ci` depends on `check`, `lint`, `arch`, `binds`, `deletion`, `rel-sweep`, `test` and `build`,
and `test` is a bare `bun test` over all 71 files — which includes **L1–L5 and the census**. Invoking
`mise run rel-sweep` / `census` / `lint` / `arch` / `binds` / `deletion` beside `ci` re-runs work `ci`
just did, and each one re-pays its `depends` (submodule, install, `check`) on top. Measured on the
§10·10 session: ~8–10 minutes of pure repeat across the increments, which is comparable to the cost of
an increment.

**What `ci` genuinely does NOT cover, and why** — all three are an ENV switch, so they are a different
RUN of the same suite and cannot be folded in:

| beside `ci` | switch | when |
|---|---|---|
| `test:legacy-spine` | `MOGWAI_RELIR=0` | every increment that moves coverage — it IS the differential |
| `test:cf-limits` | `MOGWAI_CF_LIMITS=1` | every increment that emits new SQL |
| `test:perturbed` | `MOGWAI_REVERSE_UNORDERED=1` | only when the change touches ORDER — an aggregate's member order, an `ORDER BY`, a window, a barrier. Not otherwise: it is an instrument at a known 4, and re-running it on a change with no ordering surface tells you nothing |
| `mise run L5` | none — the SEED derives from `HEAD` | AFTER the commit, always (see below) |
| `orphans`, `census-record` | — | on demand: the first needs judgement, the second is a WRITE |

So the per-increment loop is `ci` → `test:legacy-spine` → `test:cf-limits` → commit → `L5` at the
commit → push → confirm the Actions run. Four runs, not ten.

| instrument | blind to |
|---|---|
| the **census** (`ms` multiset digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value (a throw records as a deferral, so answering looks like coverage); a lost fast path (same rows, same digest) |
| the **row-for-row probe** vs legacy | a MISSING throw; a wrong ORDER where both spines share the defect |
| the **L2 shape assertions** | a wrong VALUE with the right shape |
| **L3 conformance** | anything the official corpus does not exercise — but it is the ONLY thing that sees a required error message |
| **`rel-sweep`** | asserts the lowering does not THROW, and that a plan it ADMITS renders within the platform's bind cap — both the opposite property to "does not answer wrong". **It calls `lowerToRel`, so everything `spine.ts` decides is invisible to it** — a decline (or a throw) at the seam is the census's `spine` column to catch, not this. Measured: three traversals were declining at `spine.ts`'s post-framing platform check with `rel-sweep` at zero |
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

- **"That arm is unreachable because X declines it" is a claim about SCOPE, and the scope is usually
  narrower than it reads.** Building `scalarPayload` (§10·10) I read `lower.ts`'s
  `if (tail.framing.kind === 'scalar' && tail.framing.result === 'number') return null` as making the
  numeric-reducer arm unreachable at the root, and declined it. That decline is inside the CORRELATED
  CHILD path — a `where()` body whose reducer over an empty child would answer "true" where TinkerPop
  emits no traverser — and the root arm is minted 1,100 lines away. 28 tests failed at once, all of them
  the reducer family, which is the cheap version of learning this. **Before declining an arm on the
  grounds that something else already declines it, ask `refs.ts` who the other decline's CALLER is** —
  the answer is a position, not a predicate, and the two are easy to confuse when both are spelled as a
  guard on the same field.
- **A DEMAND DERIVED PER SLICE IS NOT THE CHAIN'S DEMAND.** Legacy's `lowerElementSteps` reads
  `trackFromV` off the steps it is HANDED, which is right at the root (one call, the whole chain) and
  wrong for a child body a barrier SPLITS: `outE()` lands in the prefix, `otherV()` in the suffix, the
  prefix call sees no reader and mints no entering vertex, and the suffix throws. `range`/`limit`/`skip`/
  `dedup` before an `otherV()` therefore threw on the materialized gate while the inlined predicate
  answered — a `predicateInlining` disable-safety hole — and `order()` threw on BOTH, which no
  differential can see. Found by L5's rotating seed, fixed by taking the demand from the whole body
  before the split (`82a3aaf`), promoted to L4. The general form: **a chain-level requirement must be
  computed over the whole chain, at the point the chain is identified** — deriving it inside a routine
  that only ever sees a fragment is the same class as naming a channel list instead of passing it through.
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

**RelIR never hands a STEP back to the legacy lowering, and the one call it made into the legacy layer
passed `steps.length` precisely so that it could not.** `spine.ts` was the whole seam:
`materializeRootStream(engine.lowerStepsStrict(stream, steps, steps.length))` — zero steps remain, so
legacy turned a finished RelIR relation into the root payload and did nothing else.
**§10·10 removed the call entirely** (`e4dc296`), so the rule below no longer needs a guard to enforce it:
there is nowhere to delegate a step TO. Kept because the temptation it describes is about how a SHAPE gets
built, and that is unchanged — a shape is a value plus a framing arm, and the arm is now a projection this
side of the boundary.

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
`{kind: 'map'}` rode the existing `materializeRootStream` call exactly as `{kind: 'list'}` did (both are
`mapPayload`/`listPayload` since §10·10), and no step is delegated. `src/compiler/rel/map.ts` is the eighth vocabulary module; `byNode` joins `byExpr` in
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

**LANDED — `group()`, the family's second arm** (+3, 32.3%; `group*` 41 → 35, the map shape 60 → 54). And
the prediction above was WRONG in the useful direction, so it is corrected in place rather than deleted:
the value side is indeed a list of elements per key, but `valOf` did NOT become `{kind: 'list', of: 'elem'}`
and nothing expands per pair. **The obstacle was never the SQL — it was the WIRE VOCABULARY.**

`materialize.ts:191`'s throw existed because the framer's self-describing tree had no arm for an element,
so an element inside a collection needed a descriptor threaded to every position (`ListOf.elem`,
`MapOf.elem`) and expansion SQL written per position. That is the fourteen-hand-rolled-payloads shape one
layer up. The fix is to name the arm ONCE, at the tree: `FrameNode` gains `{t: 'vertex' | 'edge'; v:
<payload>}`, `frameTypedNode` routes it to the same `rowVertex`/`rowEdge` the top-level element shapes use,
and `elementNode` (`element.ts`) is its SQL half — the tuple `elementPayload` builds as columns, built
instead as that node, correlated on a rowid. A list of elements, a map whose value is a list of elements
and a map whose KEY is an element are then ONE rule at three depths, and `mapPayload` needs no element arm.

Two things fall out that are worth keeping:

- **`FrameNode` is a SUPERSET of `ValueNode`, not a widened one.** `ValueNode` is the STORED vocabulary, so
  `graphsonNode` and the write path stay closed over exactly what a property value can hold; an element
  cannot be stored. Widening would have handed those walkers an arm they can never receive and could not
  encode — `tsc` said so on the first attempt, which is the cheap version of learning it.
- **A group's MEMBER ORDER is stated, not inherited.** The members ride inside one collected traverser's
  buffer, so their order is fully observable, and `json_group_array` takes rows in scan order. Emission
  position where the chain carries one, element id otherwise. That is why the traverser column and the
  encounter channel are carried into the group's scope for `group()` and NOT for `groupCount()`: state
  nothing reads is what the channel obligations exist to prevent, one layer down.

**LANDED — the VALUE `by()`** (+3, 32.4%). The projection needed nothing: `byNode`'s second slot already
yields a self-describing node. What it needed was a node FIELD, and the reason is the one thing worth
carrying out of this arm.

**A `by()`'s productivity applies to THREE different things, and they are distinguishable.** For
`g.V().group().by("name").by("age")`, where `ripple` and `lop` have no `age`:

| where the drop applies | answer |
|---|---|
| the ROW, before the aggregate | those two KEYS vanish |
| nowhere — collect the NULL | `{"lop": [null]}`, indistinguishable from a productive null |
| the MEMBER, group kept | `{"lop": []}` — **`sideEffect/Group.feature`'s own answer** |

So the reference is QUOTED here rather than reasoned from, because two of the three are plausible.
Legacy reaches the same wire answer by collecting the SQL null and having the `scalarList` framer strip
it — correct, but only because that Shape's framer knows to; the typed tree has no per-position
strip-nulls instruction and must not grow one.

**`Agg.filter` — SQL's `FILTER (WHERE …)` — is therefore a node field, and it MEETS §3.2's bar.** Neither
existing node expresses "the rows this aggregate does not take, with the GROUP still decided by all of
them": `Aggregate.groupBy` derives the groups from its input's rows, and a `Filter` before it removes a row
from the group as well as from the aggregate. That is the seam being unable to EXPRESS the shape rather
than not having been handed it, which is the distinction §7's bar is about. (SQLite ≥ 3.30; the DO's is
3.47, and `test:cf-limits` is green.)

**A checker gap it exposed:** `check.ts` was not walking an `Agg`'s `orderBy` terms AT ALL, so a `Col`
naming a relation out of scope inside one reached the emitter unchecked. `walk.ts`'s `exprChildren` had
always included them — the two disagreed, and the fix is the checker agreeing with the walk. A reminder
that "a total table per node KIND" does not make the per-FIELD coverage total.

**And the first place RelIR answers what legacy does not:** `group().by(k).by(T.label)` throws
`unsupported group().by() value modulator` on the legacy route.

**What remains of the family:** `group()`'s remaining blockers are the side-effect label form (`group('a')`,
which needs the side-effect substrate) and the two value-`by()` forms this arm declines —
`by(<reducer>)`, a scalar value that lands with the reducer vocabulary, and `by(<traversal>)`, which needs
the child seam. Then the mid-chain consumers (`unfold()` to entries, `select(Column.keys/values)`), which is
what makes the map arm re-enterable and what `valueMap`'s 28 mid-chain cases need.

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

**THE ARGUMENT IS NOT PURITY — the current line is already binding, in three measured ways.** All three
are now RESOLVED; each is annotated in place rather than struck out, because the reason is what the
section is for.

- **`LAYOUT_FIELD` declares `null` for `path`, `origin` and `branchOrder`, and THROWS.** RelIR is blocked
  from carrying a path by the TRANSLATION, not by the algebra. The channel core can hold it; the seam
  cannot express it.
  **DELETED (`e4dc296`)** — with every arm's payload inside the algebra there is no seam to translate at,
  so `layoutOf`/`LAYOUT_FIELD` and the alias map that was its only other reader are gone (ratchet rows in
  `scripts/deletion-ratchet.tsv`, floor 0). **The path channel's wall is a wall no longer.**
- **`materializeRootStream` throws for an `ElementStream`.** So for every covered element traversal —
  most of today's 32% — legacy's `lowerSteps` builds the payload SQL after RelIR's relation. **RelIR does
  not currently produce the whole query**, which is not what §5a's equivalence gate reads as.
  **LANDED (2026-08-04, `debf46f`)** — `src/compiler/rel/element.ts`. For an element result the plan IS
  the whole query and `spine.ts` never reaches the framing layer.
- **`materialize.ts:191` throws `'a terminal map with an element key or value not yet supported'`.** The
  next arm of the map family — `group()`, 41 blockers — is blocked by a throw in the code §8 deletes. To
  advance RelIR one would have to edit legacy's tail. **That is the migration running backwards**, and it
  is the same trap §10·9 was written to close, arriving from the other side.
  **RESOLVED (`e4dc296`)** — `mapPayload` (`map.ts`) owns the map root now, and an element side is a
  DECLINE there rather than a throw in legacy. So the element-valued map is built by adding an arm on this
  side of the boundary, which is what `group()` was waiting for.

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
| scalar / value | `SELECT v[, vt]` | `Project` | **LANDED** `e4dc296` — `scalarPayload` (`lower.ts`, beside the scalar vocabulary). `result` is the total three-way, and the `'number'` arm IS reachable — see the trap below |
| list | `SELECT json(list)` | `Aggregate` + `json_group_array` | **LANDED** `e4dc296` — `listPayload` (`list.ts`). Scalar-membered (bare/typed/set) and NESTED, the latter rebuilt a level at a time through the module's own correlated member frame. An ELEMENT leaf declines only because nothing PRODUCES one yet (`fold()` over elements); the member encoding itself exists — `elementNode`, `53853e3` — so that arm is one `of.kind` case, not a substrate |
| map | `SELECT json(map)` | as above | **LANDED** `e4dc296` — `mapPayload` (`map.ts`). An ELEMENT side declines and never needed an arm: since `53853e3` an element is a MEMBER of the typed tree, so a map holding one is `json(map)` like any other (§10·9's `group()` record) |
| property | `vpid/owner/pk/pv/pvtype/pmeta` | `Scan` + `Project` | needs the property shape anyway |
| record | one wide row, heterogeneous fields | `Project` + child joins | needs `project()`/`select()` |
| mapEntry | `mk`/`mv` per row | `Explode` | arrives with map re-entry |
| path | positions, or grouped rows | `Explode` + `Aggregate` + `elementNode` — the LIST arm's, reused whole | **LANDED** (§10·11) — and NEITHER of the two forms this row predicted: a path is the list value, framed by a `jsonbPath` arm |
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

**IT DID EXACTLY THAT, WITHIN ONE SESSION (`e4dc296`), so the type is gone and this is its record.**
`RelLowering` carries a `Shape`. `spine.ts` is ~100 lines of router: lower, emit, render, hand over a
`Shape`. Worth keeping the design note because the SHAPE of the device is the reusable part — a
transitional union whose deletion criterion is "no inhabitants" costs one `Exclude` and cannot be
forgotten, where a boolean or an optional `shape?` would have needed a reviewer to notice.

`RelFraming` is unaffected and stays the fold's INTERNAL vocabulary: an arm merge and a retype need to
know what a relation HOLDS, which is a different and larger question than which `Shape` frames it.

**One instrument blind spot it exposed, worth stating because the census caught what `rel-sweep`
structurally cannot.** Moving the payload in took census coverage 736 → 739 with IDENTICAL answer hashes,
i.e. three traversals whose route changed and nothing else. They had been declining at `spine.ts`'s
post-framing platform check — and `rel-sweep` calls `lowerToRel`, so anything `spine.ts` decided was
invisible to it. With the payload inside, that check is measured on the plan's own render, which is the
number `lowerToRel` already had. The general lesson: **a gate over the lowering is not a gate over the
seam**, and the census's per-query `spine` column is what covers the difference.

**A note on the bind budget, since it was the predicted risk.** The element payload adds three `Lit`s per
projection — `storedValueOn`'s `IN ('list','map','set')`, which legacy inlines as literal text. Census
after: **736/2298 (32.0%), unchanged**, and `rel-sweep` still renders all 53,020 admitted plans inside the
100-bind cap. So the constant-inlining question §11 raises for the compare key's ~27 binds is real but is
NOT this arm's blocker, and it stays a separate increment rather than a prerequisite.

### 10·11 — the PATH CHANNEL: a path is a LIST VALUE, and the two legacy regimes collapse into one

The reap of §10·10, and it landed as something neither §6's shape table nor the path prior art
(`docs/2026-07-18-path-history-substrate.md`) predicted. Both assumed RelIR would reproduce legacy's
representation — "positions, or grouped rows". It reproduces neither.

**ONE JSONB array channel, not a column per position.** Legacy carries a linear path as `p0…pN` (static
length) and a recursive one as a JSONB array, with a documented wall between them (`movement after
recursive repeat().path() not yet supported`) and two `by()` projectors. This route carries one array of
tagged entries, and three separate pieces of machinery evaporate:

- **a branch arm's shorter path is DATA.** Legacy pads to the longest arm, so a position is nullable, an
  element position needs a `LEFT JOIN`, and a `by()` over one needs a sibling presence column (`_at`) to
  distinguish "this arm never got here" from "the property is missing". With an array a two-hop arm's
  path has two entries. **`union`/`choose` needed no path-specific code at all** — the channel merge
  already handles one column whose arrays differ in length, and `CHANNEL_MERGE_POLICY.path = 'pad'` turns
  out to describe a padding that now happens in the data.
- **`repeat()`'s dynamic length is the same shape**, so Phase 3 inherits the encoding rather than adding
  the second regime back.
- **`CHANNEL_COL` is keyed by ROLE**, so a role gets ONE column type: per-position rowids want `int` and
  an array wants `json`, and the table cannot say both. The encoding was always going to be single; the
  array is the one that serves both regimes. (That declaration was written before there was a producer,
  and it called this correctly.)

**The ENTRY encoding is the alias channel's, extracted rather than copied** (`src/compiler/rel/history.ts`).
`as('a')` appends the current object to a LABEL's history; a tracked path appends it to THE traverser's
history — TinkerPop says this outright, since a label history IS a `Path`. So both channels write the same
tagged `{k,v[,t]}` entry with the same `SHAPE_K` tags, which buys two things: a position can hold anything
a label can (vertex, edge, value, folded list — a heterogeneous path is not a special case), and the READ
is ONE `case` over the tag however long the path is, where a per-position `elem` recorded at compile time
needs an arm per position and cannot survive a dynamic length.

**A PATH IS A LIST VALUE plus a framing arm, and the corpus is what settles that** — not a convenience.
`path().by('name').combine(['dave'])` answers `l[marko,josh,dave]`: TinkerPop re-enters a Path as an
ordinary collection. So `path()` produces the LIST shape (one `list` column of typed-tree members, built by
the list vocabulary's own member frame plus `elementNode`), and the only thing making it a Path is which
framer reads it — `jsonbPath` wraps the identical per-member buffers `jsonbList` does, via the `framePath`
that already existed. That is the standing `set` already has one level up. Consequence worth stating: the
whole set-op / `reverse()` / `unfold()` / local-reducer vocabulary composes over a path with **no
path-specific lowering**, the moment the retype into the list loop lands.

**Fail closed, because an unappended position is a wrong path with the right arity.** Every step producing
a NEW traverser object owes the path a position; one that carries the column through without appending
reports a path missing a hop — plausible elements, and a defect the census structurally cannot see. So the
fold's rule is DENY: `movement` appends (once over the whole fan-out, at the new `id`), the
position-preserving steps carry it, and every other branch declines while the channel is live. Movement
COLLAPSE needed no new rule at all: `CHANNEL_GROUP_POLICY.path` is `'undefined'`, so `groupableChannels`
already refuses to merge convergent walks that have different histories.

**One real defect found in review, and it is a general trap for any carried column this route appends to.**
The append was first spelled as legacy spells it — `CASE WHEN prev IS NULL THEN jsonb_array(entry) ELSE
jsonb_insert(prev, '$[#]', entry) END` — which references `prev` TWICE. The assembler fuses a run of
`Project`s into one `SELECT`, so each hop's expression is re-inlined into the next: **two references per
level doubles the statement text and the bind list per hop**, measured at 2× on a two-hop path and 2^N in
general. Legacy never sees this because its per-hop CTE materializes the column. The fix is one reference:
`jsonb_insert(COALESCE(prev, jsonb_array()), '$[#]', entry)` — total on NULL, bind-free empty array
(`jsonb_array()` over a `Lit '[]'`, §3.6), and it fixes the ALIAS channel's identical latent blowup on a
repeated rebind. **The rule: an expression a fused chain re-inlines must reference its input once.**

**Two boundaries needed a fence, both `list.ts`'s rule one node earlier.** `json_each` reads from the FROM
clause, where SQL cannot name a select alias, so the member frame over the path column must sit behind a
`Materialize` or it re-inlines the whole append chain into a table-valued function argument.

**Measured.** Census 745 → 746 (32.5%), one traversal legacy→rel with IDENTICAL answer hashes — the ideal
signature. `path` blockers 38 → 29, and the nine that left mostly moved to the step AFTER `path()` (`is`
+2, `order` +4, `select` +1, `as` +1), which is exactly what "a path is terminal here" means and where the
next increments are: `path().by()` per position (round-robin over `po % nBys`, with productivity as ONE
`NOT EXISTS` over the rebuilt list rather than a clause per position), the retype into the list loop
(which unlocks the ~17 set-op traversals), `from()`/`to()` as a static slice, and a VALUE position (which
this encoding already holds — the fold simply does not append one yet, and it is the `g_VX1X_name_path`
scenario legacy FAILS).

**Two L2 tests and one exec test were pinning the ROUTE, not the semantics**, and the treatments differ.
The L2 SQL snapshots legitimately describe legacy's spelling, so they take `{ spine: 'legacy' }` (§10·4 —
a test that pins a spine's spelling pins both) and the RelIR spelling gets its own pin beside them. The
EXEC test was reading legacy's raw `x0_id`/`x1_id` columns to assert a WALK; that one is rewritten to
assert the decoded `Path` objects, which is spine-neutral and is the `written()` lesson from
`test/support/harness.ts` applied to reads.

### 10·11·1 — `path()` composes: the tail, `by()` per position, and the boundary a review caught

The two increments after §10·11, and the reap the channel was for: **census 746 → 762 (33.2%), `path`
blockers 29 → 13**, all sixteen route changes carrying IDENTICAL answer hashes.

**`pathTail` is tiny on purpose, and that is the §10·9 shape paying off.** A path is the list shape wearing
a different framer, so what belongs in its own loop is only what a Path answers *differently* from a List:
`is(typeOf(GType.PATH))` (identity — and any other `typeOf` is the empty relation, spelled `Filter(false)`
per §3.3), `count()` (paths, not positions — the element tail's `countTail`, now shared so the two cannot
disagree about `SUM(bulk)` versus `COUNT(*)`), and the slices. Everything else is handed to `listTail` over
**the same relation** — the retype costs no node at all, because the relation already IS a list relation and
only the framing arm changes. That is what makes the ~17 set-op traversals land with no path-specific
lowering.

`PATH_LIST_OPS` is now EXPORTED from the legacy tail and read by both spines, for `SHAPE_K`'s reason: it is
DATA, and a second copy is a second chance to drift.

**The delegation is a WHITELIST and must not become a fall-through** — the failure would be a wrong ANSWER,
not a missing one: `as()` in `listTail` binds the collection tagged `list`, so `path().as('a').select('a')`
would re-enter as a List and frame as one.

**`by()` per position: the round-robin is `po % N`, which is where the array encoding pays again.** Legacy
cycles modulators across STATIC position columns and refuses more than one `by()` in its recursive regime
("multiple modulators over a recursive repeat().path() not yet supported") precisely because the length is
unknown there. Over an exploded array the arm selector is an expression on the member's own ordinal, so N
modulators over a path of ANY length — including a future recursive one — is one `case`. Each arm is
`byNode` (not `byExpr`): the self-describing `{t,v}` node with the property's own `vtype`, which is what
keeps a stored uuid/long/datetime position framing exactly and is already the members' encoding. The host's
`elem` is a RUNTIME fact on a path that interleaves vertices and edges, so each arm is itself a `case` on the
entry tag.

**Productivity is ONE clause, however many positions.** TinkerPop's default drops the WHOLE path when any
position's `by()` yields nothing; legacy spells that as an `IS NOT NULL` per position. Asked of the REBUILT
list it is a single `NOT EXISTS (… json_each(list) … value IS NULL)`, because a missing projection lands as a
JSON null member. A bare `by()` position cannot be unproductive (it is the element), which is why the guard
is keyed on there being a non-identity projection at all.

**THE BOUNDARY A REVIEW CAUGHT, and it is the decline contract's exact failure mode.** With the retype in
place, `path().unfold()` over ELEMENT positions answered where legacy defers — and answered WRONGLY, framing
each vertex's payload object as a plain value (`"{\"id\":1,\"label\":[\"person\"],…}"`). The cause is not in
the path module: a list member op decodes a member's `$.v` into the SCALAR stream, and that stream has no
element arm — §10·10's remaining list arm, the one nothing PRODUCES yet. Two lessons:

- **`TYPED_LIST` is the right encoding for framing a path and not sufficient for re-entering one.** An
  element position and a `by()`-projected position are both members of the self-describing tree, so the
  member encoding cannot distinguish them — correct for `framePath`, wrong for a member op. The fact a
  consumer needs is therefore REPORTED (`pathPositions`' `scalars`, a required field on the framing arm, and
  compared by `sameFraming` because two arms can disagree about it) rather than re-derived from `of`.
- **the boundary is legacy's own, restated in this route's vocabulary.** `linearScalarList` coerces a path to
  a list only when every position is a value; `scalars` is that predicate. Mirroring it keeps the two spines
  agreeing, and it lifts when a list can hold an element member — not before.

A test had already PINNED the wrong behaviour (`shape.kind === 'value'`) in the same change that introduced
it, which is the reminder worth keeping: **a new test written beside a new lowering is not evidence the
lowering is right.** What caught it was running the traversal on both spines and comparing the decoded
values — the differential, by hand, on a shape no corpus traversal reaches.

### 10·12 — the `by(__.traversal)` CHILD SEAM, and two reference facts that look like a contradiction

**Measured before starting, which is why this was next and not the path residue:** 99 corpus traversals
block exactly at a `by()` host whose modulator is a nested traversal — `group` 48, `project` 15, `select`
12, `path` 7, `aggregate` 4, `order` 3, `groupCount` 2, `sack` 2, `dedup` 1. That is larger than side
effects (95) or the property shape (90), it is ONE concept, and `modulator.ts` had already named the
shape of the answer: "a sub-traversal projection … belongs to whichever seam grows the correlated child".

**The seam is an INJECTED lowerer, for `ListCtx.subRead`'s reason.** Lowering a body needs the fold, the
fold lives in `lower.ts`, and `modulator.ts` sits below it in the module DAG — so `ByKey` gains a `child`
arm carrying the decoded body and `byExpr`/`byNode` take a `ByChild` callback. Every by() HOST therefore
gains the child at once (path, group/groupCount, order, dedup today), which is the whole argument for
building the seam before any arm.

Two details in the seam earned their place:

- **`by(__.identity())` normalises to `{kind:'identity'}` in `modulations`.** It IS a bare `by()` — both
  project the element — and it appears 7 times in the measured corpus. Recording it as a child would make
  every consumer re-derive that.
- **`byNode` keeps SQL NULL OUTSIDE the `{t,v}` envelope for a child.** `typedNode(NULL, NULL)` is a
  non-null JSON object, so a productivity filter downstream could never see that the child yielded
  nothing. The node is therefore wrapped in a `CASE … IS NULL` — which is also the one place this arm
  spells its subquery twice, bounded and measured inside the bind cap.

**THE FIRST ARM IS AN EXPRESSION, NOT A CORRELATION**, and that is why it is first: a flat value-and-
transform body (`__.values('name')`, `__.values('name').toUpper()`, `__.label()`, `__.constant(1)`) is
`byExpr`'s own property/token projection with `transformExpr` folded over it. No relation, no correlation,
no fence. The movement/reducer arm (`__.out().count()`, ~30 occurrences) and the collecting arm
(`__.out().label().fold()`, ~19) are the next two increments and DECLINE here.

**A guard with a witness, found in review:** without requiring a leading value-producer, a
transform-only body falls through with the subject still the element's ROWID, so
`g.V().order().by(__.toUpper())` lowered to `upper(<rowid>)` — a plausible answer to a traversal TinkerPop
REJECTS (`The toUpper() step can only take string as argument`). A transform needs a value in front of it
and an element is not one.

**THE TWO REFERENCE FACTS, because they read as a contradiction and cost a wrong correction.** An
unproductive value `by()` behaves differently depending on whether it is a KEY or a TRAVERSAL:

- `g.V().group().by("name").by("age")` → `ripple`/`lop` map to **`[]`**: the key SURVIVES. That is
  `Agg.filter`'s whole reason for existing (`FILTER (WHERE …)` drops the member, not the row).
- `g.V().has("person","name",within("vadas","peter")).group().by().by(__.out().order())` → only
  `v[peter]`: the key **VANISHES**, and the feature file's own comment above it says "validates that a
  collecting barrier produces a filtering effect if it is unproductive". Same for
  `g.V().group().by(values("name")).by(values("age").fold().unfold())`, where `lop`/`ripple` are ABSENT
  rather than empty — a `values()` inside a TRAVERSAL filters where the bare key does not.

So a child value `by()` needs a pre-aggregate DOMAIN filter *and* the member `Agg.filter`, and the two are
not redundant. This was reviewed as an inconsistency and "fixed" by deleting the domain filter on the
reasoning that `by('age')` is sugar for `by(__.values('age'))`; the second scenario above is what refutes
that, and the fix was reverted with both citations written down. **The lesson is the general one: when two
comments in this repo cite the same feature file for opposite behaviours, the resolution is in the feature
file, not in the reasoning.**

**One divergence RelIR is AHEAD on, pinned in both directions rather than hidden.** A wholly unproductive
child filters every traverser, and the two spines then disagree about what a reducing barrier over zero
rows emits: RelIR emits the seed (one empty map), legacy emits no traverser. RelIR is right —
`ReducingBarrierStep` emits its seed, which is what `fold()` and `count()` already do here — and the
divergence is NOT the seam's: `g.V().hasLabel("nope").group().by("name")` produces the same two answers
and involves no `by()` traversal at all. The legacy assertion is pinned with `{spine:'legacy'}` so it
deletes itself when the group family fixes the empty barrier.

**`grouped` in the harness was incomplete and this found it:** a legacy group's list-valued `gv` arrives as
JSON TEXT while a RelIR map's value side is already parsed, so "the same Map either way" was only true for
the numeric `groupCount` callers. It now reads a collection back by SHAPE (a leading `[` or `{`), which
keeps a genuinely string-valued group a string.

**Measured.** Census 762 → 772 (33.6%), ten route changes with identical answer hashes, `0 changed answer`.
Seven of the ten are the path family's `by(values("name").toUpper())` set-ops, so the seam closed most of
what §10·11·1 left. `rel-sweep` 0 violations. `test:perturbed` unchanged at its known 4.

### 10·12·1 — what a reducing barrier emits over ZERO rows is PER STEP, and `gremlin-core` says which

§10·12 left the empty-barrier divergence resolved by inference ("a reducing barrier emits its seed"). The
implementation settles it exactly, and the mechanism is worth recording because every reducer arm will need
it: **`ReducingBarrierStep` decides emit-versus-nothing by whether the step supplies a SEED.**

`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ReducingBarrierStep.java`:
`processNextStart()` throws `FastNoSuchElementException` when `seed == NON_EMITTING_SEED`, and
`processAllStarts()` replaces that sentinel with `getSeedSupplier().get()` — which is
`generateSeedFromStarts()` unless the step set a supplier. So:

| step | seed | over ZERO rows |
|---|---|---|
| `group()`, `groupCount()` | `setSeedSupplier(HashMapSupplier.instance())` (`GroupStep.java:64`, `GroupCountStep.java:50`) | **emits `{}`** — one traverser |
| `fold()` | `setSeedSupplier(seed)` (`FoldStep.java:53`) | **emits `[]`** |
| `sum()` (and `min`/`max`/`mean`) | none — and `SumGlobalStep` OVERRIDES `processAllStarts` to `if (this.starts.hasNext()) super.processAllStarts();` | **emits NOTHING** — the sentinel survives |

Two things follow, one confirming and one for free:

- **RelIR is right about the empty group and legacy is wrong**, with a citation instead of an argument:
  `GroupStep.java:64` sets an empty-`HashMap` seed, so `g.V().hasLabel("nope").group().by("name")` is one
  empty map. §10·12's pinned divergence stands, and the `{spine:'legacy'}` line above it is now known to be
  pinning a defect rather than a preference.
- **The movement+reducer child arm's semantics arrive settled.** `by(__.out().values("weight").sum())` over
  a vertex with no out-edges: the child's `sum()` emits NO traverser, so the `by()` is unproductive, so the
  TRAVERSER is dropped and the key VANISHES (§10·12's second reference fact). SQL agrees for free — `sum`
  over zero rows is NULL — so the existing domain filter fires with no new machinery. That is also why
  `correlatedExists` declines a numeric reducer body today: an `EXISTS` over the child would answer "true"
  where the reference emits nothing, and the honest test is the aggregate's own NULL-ness.

**The process rule this is an instance of:** the `.feature` corpus says WHAT; `gremlin-core` says WHY and
covers the cases no scenario names. When a semantics question is in doubt — or when two comments in this
repo cite one feature file for opposite behaviours — read the vendored implementation and cite the path at
the pin. Same standing `vendor/calcite` has for the algebra questions (§5's `needNewSubQuery`, §10·9's
`Aggregate`-versus-`COLLECT` decomposition).

### 10·12·2 — the child seam's REDUCER arm, and two productivity facts only the implementation names

The second arm of §10·12's seam: a body that MOVES then REDUCES (`__.out().count()`,
`__.outE().values('weight').sum()`, ~30 of the 118 measured body occurrences). Census 772 → 776 (33.8%),
four route changes, identical answer hashes, `0 changed answer`.

**It is `correlatedExists` minus the EXISTS**, and that is the whole implementation: `movement` already
roots a first hop at a correlated outer expression with no seed node, `continueAs` already folds the rest
of the body through the ordinary loop, and this arm reads the tail's `v` instead of testing for rows. Three
declines keep it honest — a non-scalar tail, a tail that is not REDUCING (a per-row value would emit many
rows and a scalar subquery would silently take SQLite's first), and any `Materialize` anywhere below (the
subplan is correlated, and a fence forces a named CTE that cannot reference the outer row —
`correlatedExists` states this and it applies unchanged).

**`count()` and `sum()` differ in exactly one observable way, and it is not a spelling.** Its seed:
`CountGlobalStep` seeds `0L`, so an empty child counts to zero and the traverser SURVIVES;
`SumGlobalStep` overrides `processAllStarts` so the `NON_EMITTING_SEED` sentinel survives and no traverser
is emitted (§10·12·1). SQL agrees for free — `COALESCE(sum(bulk), 0)` is never NULL, a bare `sum` over zero
rows is — so `countExpr` and `reducerAggregate` already produce the right thing and a COALESCE that made
them uniform would be a bug.

**TWO PRODUCTIVITY FACTS THE SEAM MADE REACHABLE, both found by reading the reference rather than by
testing.** The corpus cannot see either — no scenario names them — and both are wrong answers with the
right arity:

- **`order()` drops an unproductive by() for ANY by(), not just a property key.** `orderProductivity` read
  "only a property KEY can be unproductive", which was TRUE only because no other projection could yield
  nothing; a reducing child can. `OrderGlobalStep.processAllStarts()` is
  `createProjectedTraverser(starts.next()).ifPresent(traverserSet::add)` under TinkerPop's own comment
  *"only add the traverser if the comparator traversal was productive"*
  (`vendor/tinkerpop/gremlin-core/.../step/map/OrderGlobalStep.java:82`). Measured before the fix:
  `g.V().order().by(__.outE().values('weight').sum()).values('name')` returned all SIX names with the
  three edgeless vertices sorted first, where the reference returns THREE. The `child` arm was added to
  `orderProductivity`, and `count()` bodies are unaffected by construction because their key cannot be NULL.
- **A reducing child VALUE on a `group()` reduces over the WHOLE GROUP, not per traverser** — so the
  generic per-parent expression would produce `[1,2]` where the reference produces `3`. That declines in
  `groupBarrier` (a reducing terminal in a child value body), while a reducing child KEY is admitted
  because a key by() genuinely IS per traverser. `g.V().groupCount().by(__.out().count())` is therefore
  covered and `g.V().group().by('name').by(__.out().count())` is not, which looks arbitrary and is exactly
  the reference's distinction.

**One residual inefficiency, recorded rather than fixed:** the new `order()` productivity filter is a
tautology for a `count()` child (its key is never NULL), and it re-inlines the child subquery a second
time to say so. The honest fix is for `ByChild` to REPORT whether its body can be unproductive — the fact
is known where it is decided — and that belongs with the third arm (`fold` bodies, which likewise never
are). `rel-sweep` renders every admitted plan inside the 100-bind cap today, so it is a cost and not a wall.

**Four test assertions were pinning the ROUTE again**, and the split is now routine: an L2 SQL spelling
takes `{spine:'legacy'}` plus a RelIR pin beside it; a group row read off `gk`/`gv` goes through the
harness's `grouped`; and `rel-spine.test.ts`'s covered list gained the by()-child shapes while
`g.V().dedup().by(__.out().count())` left `DECLINED`. Two of my own additions to those lists were wrong and
the suite caught them: a GROUP traversal cannot join the covered list (it compares RAW ROWS, and the two
spines spell a group row differently by design), and a traversal BOTH spines refuse cannot join `DECLINED`
(which means "RelIR declines, legacy answers").

### 10·12·3 — the remaining by()-child work, measured per HOST × BODY KIND, and how `group` reduces

§10·12 ranked the by()-traversal family by host and §10·12·2 landed its reducer arm. Re-measured after
both, the residue is not one queue but a MATRIX, and reading it that way changes what comes next:

| host ← body kind | count | what it needs |
|---|---|---|
| `group` ← reducer | **20** | the group-scoped reduction below — declined today |
| `project` ← per-row | 18 | `project()` as a STEP first |
| `group` ← collecting (`fold`) | 17 | a list-valued child |
| `group` ← per-row, MOVING | 14 | the child as a JOINED RELATION (one row per member), not a scalar |
| `project` ← reducer | 8 | `project()` first |
| `select` ← collecting | 8 | multi-label `select()` first |
| `aggregate`/`select`/`format`/`sack` ← per-row | 14 | their own hosts |

Two readings worth keeping. **26 of these are `project()`'s** and are blocked by the host rather than by the
child, so they do not belong in the child seam's queue at all — the earlier flat count of 99 overstated the
seam's remaining reap by that much. And **`group` ← per-row-MOVING is a different arm from `group` ←
per-row-FLAT**: a flat body is one value (an expression), while a moving body is MANY values per member and
the group collects them all (`group().by('name').by(__.out().values('name'))` gives marko
`['josh','lop','vadas']`), so it needs the child as a relation joined per member — which is what legacy's
`o0` ordinal join is.

**HOW A REDUCING CHILD VALUE REDUCES, from `GroupStep` rather than from the answer shape.** This was
recorded in §10·12·2 as "reduces over the whole GROUP, not per traverser", which is the right decline and
the wrong mechanism. `GroupStep.projectTraverser` builds a **one-entry map per traverser** — the value
traversal is `addStart`ed with THAT traverser and `barrierStep.nextBarrier()` pops its contribution — and
`GroupBiOperator` then merges those maps with **the barrier step's own memory reducer**
(`setReducingBiOperator(new GroupBiOperator<>(… this.barrierStep.getMemoryComputeKey().getReducer()))`,
`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java:63`).

So it is **reduce per traverser, then COMBINE across the group with that reducer's own combiner** — which is
a table, not a new engine:

| child body ends in | per-member | cross-group combiner |
|---|---|---|
| `count()` | count of the child's rows | `SUM` |
| `sum()` | sum | `SUM` |
| `min()` / `max()` | min / max | `MIN` / `MAX` |
| `mean()` | (sum, count) | `SUM(sum) / SUM(count)` — never an average of averages |
| `fold()` | the member's list | concatenation |

Verified against the current legacy answers on the modern graph, which are correct on both counts:
`g.V().group().by(T.label).by(__.out().count())` → `{person: 6, software: 0}` (3+0+2+1 for the four people,
not four separate counts), and `g.V().group().by(T.label).by(__.outE().values("weight").sum())` →
`{person: 3.5}` with **`software` ABSENT** — every software member's `sum()` is unproductive, so each member
drops and the key never forms (§10·12's second reference fact, and §10·12·1's seed rule, composing).

**What that makes the next increment.** The per-member expression the reducer arm already builds IS the
member; the only new thing is the combiner, chosen by the body's terminal reducer. So `group` ← reducer (20
traversals, the largest cell) is an addition to `groupBarrier`'s value arm rather than a new seam — and
`mean` is the one entry that cannot use the naive form, which is exactly why the table is written down
before the code.

**The `ByChild` signature refinement §10·12·2 deferred belongs with it**: a `count()` body and a `fold()`
body can never be unproductive while a numeric reducer can, and three call sites now want that fact (the
`order()` productivity filter, `groupBarrier`'s domain filter, and this combiner arm). `ByChild` returning
the expression plus "can this body yield nothing" states it where it is decided instead of at each reader.

## 13. THE REFERENCE AUDIT (2026-08-04) — what `gremlin-core` says we get wrong

Three read-only audits cross-checked the landed RelIR surface against the vendored reference. This section
is the WORKLIST that came out; it is deliberately in the plan doc rather than a dated note, because these
are work items and this file is the index.

**Read this first: most of these are NOT RelIR regressions.** The majority are shared with the legacy
spine, several are already-failing L3 scenarios that now have a diagnosed root cause and a citation, and
the most valuable ones are invisible to the entire corpus. The audit's own framing is the one to keep:
**a wrong answer with the right arity is the class no ladder level can see.**

Every finding below that I marked VERIFIED I re-ran myself rather than taking on trust.

### 13a. Comparison and negation — one root cause, six arms `DEFECT`

**A negated predicate over a NULL subject must be TRUE and we drop the row.** `NOT p` / `x != v` is NULL in
SQL when the subject is NULL, so the traverser is filtered; TinkerPop's `test` is two-valued and negation is
plain boolean negation — `Text.notContaining` is `!containing.test(...)` where `containing` returns `false`
for a null, and `Contains.without` is `!within.test(...)`, and `Compare.neq` is `!eq.test(...)` where `eq`
returns false across type boundaries including null. Affects `not`, `neq`, `without`,
`notStartingWith`/`notEndingWith`/`notContaining` (`src/compiler/rel/predicate.ts`), and surfaces again
inside the member frame (`list.ts`'s `memberPredicate`, whose `IS NOT 1` counts a NULL member as a failure).
**VERIFIED:** `g.inject([null]).any(TextP.notContaining("z"))` → `[]`, reference TRUE;
`g.inject(["bcd",null]).all(P.neq("abc"))` → `[]`, reference TRUE. Fix once, in negation: emit
`<p> IS NOT 1` rather than `NOT (<p>)`, and `memberPredicate` then needs no change. Corpus: invisible.

**A cross-type range comparison must be FALSE, and we return SQLite's storage-class order — the exact
inverse.** `GremlinValueComparator` — "*Comparability is limited to a single type space: compare(type1,
type2) = ERROR*" — and `Compare.gt` opens with
`if (!COMPARABILITY.comparable(first, second)) return false;`. **VERIFIED and worse than reported:**
`g.V().has("name", P.gt(27)).values("name")` matches **all six** names (TEXT sorts after numerals), so
`g.V().not(__.has("name", P.gt(27))).values("name")` returns NOTHING where the reference returns all six.
`between`/`inside` share the path. Corpus: **visible** — `filter/Not.feature:47`, currently in
`l3-state.json`'s failed set, so this is a diagnosed conformance gap rather than a new one. Fix: gate the
ordering comparison on type-space agreement; the bound's type is known at compile time, so it is one guard
per site.

### 13b. The transform family answers where TinkerPop RAISES `DEFECT`

Same shape five times, and the module header already promises not to do it. Each reference step opens with
an `IllegalArgumentException` on a wrong-typed subject:

| ours | reference | VERIFIED symptom |
|---|---|---|
| `toUpper`/`toLower`/`length`/`trim*`/`replace`/`substring`/`concat` over a non-string | `ToUpperGlobalStep`: "*can only take string as argument*" | `g.V().values("age").toUpper()` → `["27","29","32","35"]` |
| `asString` over NULL | `AsStringGlobalStep`: `throw … "Can't parse null as String."` | `g.inject(1,null).asString()` → `["1",null]` |
| `asNumber(GType.X)` over a runtime string or an overflowing value | `AsNumberStep.parseNumber`/`castNumber` | the literal arm declines; the COLUMN arm does not |
| `dateAdd`/`dateDiff` over a non-date | `DateAddStep`: "*accept only OffsetDateTime or Date*" | unguarded (the arithmetic itself is verified correct) |
| a local string transform over non-string MEMBERS | `StringLocalStep`: "*or list of strings, encountered %s in list*" | `values("age").fold().toUpper(Scope.local)` |

`asString` is also a **`DOC`** finding: `transform.ts`'s "*NULL propagates through every one of them … so none
needs a guard*" is a false generalisation over its own table — right for `toUpper` ("*we will pass null
values to next step*"), wrong for `asString`. Corpus: `asString`-over-null and the five `substring` index
scenarios are visible and already failing; the rest are invisible.

**`substring` computes a different substring for negative or reversed indices** — SQLite's `substr` counts a
negative Y from the RIGHT and a negative Z BACKWARDS, while `SubstringGlobalStep.processStringIndex`
resolves a negative index to a positive offset and returns `""` when `newEnd <= newStart`. **VERIFIED:**
`substring(-3)` on `marko` → `ko` (reference `rko`); `substring(1,0)` → `m` (reference `""`). Both spines —
`plan.ts` carries the identical formula. Corpus: **visible**, five failing `map/Substring.feature` scenarios.

### 13c. Shape and channel findings `RISK` / `DOC`

- **`CHANNEL_MERGE_POLICY.path = 'pad'` documents the encoding we retired**, and `path.ts` says the opposite
  of it in prose. The tail is a real `RISK`: `pad` ≠ `identical` makes `path` FORKABLE, so `mergeChannels`
  does not require arms to agree on it (`prefixOf([], [path])` succeeds) — an arm lacking the column would
  merge into a relation claiming it, and `historyAppend`'s `COALESCE(prev, jsonb_array())` would then read a
  NULL path as an EMPTY one, silently omitting every hop of that arm. Unreachable only because the seed is
  at the source. **Consider making `path` rigid so a divergent arm fails closed.**
- **`pathPositions`' element `case` treats every non-edge tag as a VERTEX rowid** — a value or list entry
  (both expressible by `history.ts`) would read as an unrelated vertex. Guarded today by an ABSENCE (the fold
  appends no value positions) rather than by the code; make the `else` a third arm that fails closed.
- **`Path.labels()` is a second channel we do not carry at all.** `Path.java` — "*any Path implementation
  maintains two lists: a list of sets of labels and a list of objects*" — and `as()` extends the labels of
  the EXISTING head rather than adding a position. `execute.ts` says "labels-on-path deferred"; `path.ts`,
  which owns the model, omits it from both the model and its list of absences.
- **`AliasEntry.binds` is a compile-time count that can disagree with the reference both ways.**
  `as('a').filter(…).as('a')` binds ONCE in the reference (`addLabels` extends a new position only when the
  head changed; `ImmutablePath.extend` is a no-op for labels it already has) and twice here — costing only
  coverage. The other direction is a wrong answer and arrives with `repeat`: one textual `as('a')` in a loop
  body binds N times at run time while `binds` stays 1, and `Pop.mixed` then answers a singleton where a
  list is owed. Make it `1 | 'many' | 'unknown'` before the repeat arm lands.
- **The set-op `set` framing marker is cleared by ANY follower**, but the reference converts a Set to a List
  only at some: `OrderLocalStep` really does `Collectors.toList()`, while `RangeLocalStep` documents "*Set
  becomes Set (order-preserving)*" and `all`/`any`/`none` are `FilterStep`s that never touch the object. So
  a set-op followed by a local slice frames as a List where a Set is owed — right members, wrong wire type.
- **`list.ts`'s `all` comment attributes a SQL fact to TinkerPop.** `AllStep` is a two-valued
  `if (!test(...)) return false;` — so there "no member fails" and "every member passes" are the same
  statement. The `IS NOT 1` spelling is right; its stated reason is not.

### 13d. Two findings outside the audited partition, both tied to a reference

- **`all`/`any`/`none` over a NON-collection traverser must be FALSE for all three** — including `none`,
  which each step spells as a bare `return false;` outside its `instanceof Iterable` branch. Already visible:
  `g_V_valuesXageX_allXgtX32XX`, `g_injectX7X_noneXeqX7XX`, `g_injectXnullX_allXeqXnullXX` are failing.
- **`select()` resolves map scope → side-effect scope → path scope, in that order** (`Scoping.getScopeValue`)
  and only then throws; `alias.ts` reads the path history unconditionally. Not reachable today (no map tail,
  and side-effect steps decline) but it is a wrong answer the moment either arm lands. Confirmed correct
  alongside it: an UNBOUND label drops the traverser rather than erroring
  (`SelectOneStep` catches `KeyNotFoundException` → `EmptyTraverser`), while a bound label holding NULL does
  NOT drop (`if (null == o) return traverser.split(null, this)`).

### 13e. Confirmed correct, worth not re-litigating

`path().by()`'s ring cycles by POSITION (`TraversalRing` `% size`, `PathStep` resets per traverser, and
`json_each.key` is 0-based — the three agree exactly), and its unproductive-`by()` filter drops the whole
traverser exactly as `PathStep` does. The set-op RESULT TYPES match the reference signatures one for one
(`Intersect`/`Difference`/`Disjunct`/`Merge` → `Set`, `Combine` → `List`, `Product` → `List<List>`).
`combine`/`product` multiplicity, ordering and null-tolerant membership match `CombineStep.map`'s
`addAll`, `ProductStep`'s nested loop and `DifferenceStep`'s `HashSet.contains`. `conjoin`'s three cases
(empty → `""`, nulls skipped, all-null → `""`) match `ConjoinStep`. And a vertex's `{label}` payload really
is a LIST on the wire — the client's `VertexSerializer` serializes `labels` as a list and derives `.label`
from it.

### 13f. The modulator / grouping / reduction audit — TWO RelIR-ONLY defects, both silent

The second audit's headline is different in kind from §13a–13e: those are mostly shared with legacy, but
these two are **RelIR-only regressions**, i.e. the routing switch made a correct answer wrong.

**1. A PRODUCTIVE NULL from a `by()` child drops every traverser. `DEFECT`, and it is MINE — the child
seam introduced it.** VERIFIED row counts:

| traversal | RelIR | legacy (= reference) |
|---|---|---|
| `g.V().order().by(__.constant(null)).values("name")` | **0** | 6 |
| `g.V().dedup().by(__.constant(null)).values("name")` | **0** | 1 |
| `g.V().group().by("name").by(__.constant(null))` | `{}` | 6 keys |

The cause is a conflation I approved without questioning. `byNode`'s child arm keeps SQL NULL outside the
`{t,v}` envelope so a productivity filter can see it — which I praised as the right instinct — and
§10·12·2 then widened `orderProductivity` to test it. But **productivity is whether the child EMITTED a
traverser, never whether its value is null**:
`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalProduct.java`
carries the line `this.o = null; // null is valid technically but productive=false trumps it`, and
`TraversalUtil.produce` returns a PRODUCTIVE product whenever `traversal.hasNext()`. Our route expresses
NULLNESS and calls it emission. The two coincide for every body except one that produces a null on purpose
— which is exactly why no corpus scenario catches it (nothing puts `constant(null)` inside a `by()`).
Fixed by DECLINING that body; the general fix is the `ByChild` emission bit already queued in §10·12·3.

**2. `sample(n)` returns the wrong and nondeterministic number of rows. `DEFECT`, RelIR-only.** VERIFIED
over six runs each: `g.V().sample(3).values("name")` → `[2,2,4,2,4,4]` where legacy is `[3,3,3,3,3,3]`, and
`g.V().both().sample(3)` → `[3,4,4,5,3,1]`. The count can EXCEED n, which is the tell: the arm lowers to
`Sort(RANDOM()) → Limit(n)`, the assembler fuses the block, and SQLite re-evaluates `RANDOM()` per
candidate row so the chosen set is re-rolled for every outer row. `SampleGlobalStep` is a barrier emitting
exactly n (`if (traverserSet.bulkSize() <= this.amountToSample) return;`).

**Why `order().by(Order.shuffle)` is correct and this is not — the general lesson.** Shuffle goes through
`renumber`, i.e. `row_number() OVER (ORDER BY RANDOM())`, and a WINDOW function is computed once per row
over the materialized frame; a bare `ORDER BY RANDOM()` in a fusable block is not. So the fix is to RANK in
a window and FILTER, never to sort and limit — which also makes the sample come out in the INPUT's order,
as `CollectingBarrierStep` does when it drains its `TraverserSet` in insertion order (the arm's comment
claimed "the root still sorts by the carried position", which is false for these chains since `sample` is
not in `POSITIONAL_CONSUMERS`). **A non-deterministic ordering expression must never sit in a slot the
assembler can inline.** `limit`/`range`/`tail` are unaffected because their sort key is a column.

### 13g. Grouping and reduction — corpus-VISIBLE defects, shared with legacy

- **A CHILD value `by()` on `group()` collects a LIST where the reference assigns a single VALUE.**
  `Grouping.convertValueTraversal` rewrites a `ValueTraversal`/`TokenTraversal`/`IdentityTraversal`
  (`by('age')`, `by(T.label)`, `by()`) into `__.map(v).fold()` — hence a list — but leaves an ANONYMOUS
  traversal unwrapped, so `GroupStep` takes `map.put(p, valueTraversal.next())`: one bare value, duplicates
  merging under `Operator.assign`. Ours collects both into `json_group_array`. Corpus: **visible** —
  `sideEffect/Group.feature:122` `g_V_group_byXvaluesXnameX_substringX1XX_byXconstantX1XX`, which RelIR
  fully covers. The discriminator is already in hand (`map.ts` conditions on `key.kind === 'child'`).
- **The reducer's result TYPE is a SQLite storage class, so Gremlin's numeric tower collapses.**
  `typeof(<agg>)` yields only integer/real/text/null, while `NumberHelper.getHighestCommonNumberInfo`
  keeps the NARROWEST common Gremlin class and promotes only on overflow. So `sum()` of bytes must be a
  byte and of floats a float, and `127b+1b` must promote to short. Corpus: **visible**, six `Sum.feature`
  scenarios (`d[6].b`, `d[6].s`, `d[6].f`, `d[128].s`, `d[1123].n`). The common cases
  (`values("age").sum()` → `d[123].i`, `mean()` → `d[30.75].d`) are correct, so only the narrow/float/big
  arms are wrong.
- **The reducer eligibility guard drops TEXT-carried exact int64, and `min`/`max` compare storage classes.**
  This project deliberately carries an int64 above 2^53 as decimal TEXT, so a legal Gremlin `long` has
  `typeof = 'text'`: `sum`/`mean` then contribute NOTHING for it (`g.inject(9007199254740993l, 1l).sum()`
  → **1**), while `min`/`max` admit it and compare under SQLite's INTEGER-before-TEXT order
  (`g.inject(10l, -9007199254740993l).min()` → **10**). The fix is the authority we already have —
  `storedCompareOn(vtype)`, which casts a TEXT-carried int to a 64-bit-exact INTEGER — so it makes the
  `arithmetic` class correct rather than widening a list. Corpus: invisible.
- **`min`/`max` over a mixed number+string stream answers where the reference RAISES.** `NumberHelper`
  falls through to `a.compareTo(b)` for non-Numbers, so `Integer.compareTo(String)` throws;
  `g.inject(1,"a").min()` gives `1` here. `RISK`, and the auditor flagged the right open question: whether
  TinkerPop 4 intends `Orderability`'s total order in this position instead. Settle that from
  `semantics/Orderability.feature` before choosing between fail-closed and a total order.

### 13h. Order-of-members findings — a spine divergence no instrument sees

- **`group()`'s member order is the element ROWID, not the emission order its comment claims.** The chain
  never carries a position for `group()`, because `COLLECTING_CONSUMERS` in `analyze.ts` is
  `{fold, aggregate, cap}` and omits `group` — so `ORD_COL` always falls back to `'id'`. Measured on
  `g.V().both().group().by(T.label)`, the `person` members come out rowid-grouped on RelIR
  (`marko,marko,marko,vadas,josh,josh,josh,peter`) and arrival-ordered on legacy
  (`vadas,josh,marko,marko,josh,peter,marko,josh`) — the same multiset in a different order, which the
  census's digest cannot see and `test:perturbed` cannot move (rowid order is stable under scan reversal).
  `FoldStep` collects in ARRIVAL order and a group's value list is that list. **Fix: add `group`/`groupCount`
  to `COLLECTING_CONSUMERS`**, which makes the emission position exist by construction and the `'id'`
  fallback unreachable — and `analyze.ts`'s own docblock already states the argument for why they belong.
- **`elementOrder`'s tie-break is the element id where the reference is a STABLE sort.** `List.sort` is a
  stable merge sort, so ties keep arrival order; we tie-break on id, and the two spines disagree
  (`g.V().both().order().by(T.label)`). Same root cause as above: a position after a fan-out.
  **This bullet is CORRECTED by §13h·1 — "stable sort" is right and "ties keep ARRIVAL order" is not,
  because the set the sort runs over has already coalesced duplicates. Do not implement it as written.**
- **A bulked `group()` would not repeat members by `bulk`** (`FoldStep` does
  `for (i < traverser.bulk()) list.add(...)`). `RISK` only — `computeCollapseSafe` provably excludes a
  `group` in the prefix, so `bulked` is false wherever the collecting arm runs. Worth making that coupling
  a type error rather than a proof if collapse gating ever widens.

### 13h·1. Bulking is OBSERVABLE in the reference's DEFAULT configuration — so half of §13h is a bulk defect, and the two arms split

Verifying §13h before delegating it refuted one of its two arms and strengthened the other. The pivot is a
fact neither the audit nor this plan had established: **TinkerPop bulks by default, and bulking changes the
ORDER OF MEMBERS, not just a count.** Three reference facts, at the pin:

- `traverser/util/DefaultTraverserGeneratorFactory.java` — with `ONE_BULK` absent from the requirements
  (the ordinary case) the `else` branch selects `B_O_TraverserGenerator`, i.e. a **B**ulked traverser.
- `traverser/util/TraverserSet.java:88-97` — `add` is `existing.merge(traverser)` over a `LinkedHashMap`.
  So any step that parks traversers in a `TraverserSet` coalesces duplicates into ONE entry carrying a
  bulk, held at the position of the **first** arrival, and `:152` sorts that list with `Collections.sort`.
- `strategy/optimization/LazyBarrierStrategy.java:96` inserts `NoOpBarrierStep(2500)` after every
  `FlatMapStep` whose successor is neither the last step nor a `Barrier`, and it is in the DEFAULT global
  strategy list (`traversal/TraversalStrategies.java:287`). Its own javadoc: "*NoOpBarrierSteps allow
  traversers to be bulked*". `NoOpBarrierStep.java:74` is `this.barrier.add(traverser)` — the merging `add`.

**The discriminator between the two arms is which barrier KIND the step is**, and it is decidable per step:

| step | reference superclass | parks in a `TraverserSet`? | member order the reference produces |
|---|---|---|---|
| `order()` | `CollectingBarrierStep` | **yes** (`OrderGlobalStep.java:78` sorts `traverserSet`) | distinct traversers by FIRST arrival, duplicates ADJACENT |
| `group()` | `ReducingBarrierStep` | **no** — one start at a time | ARRIVAL order, duplicates wherever they arrived |

`group()` is itself a `Barrier`, so `LazyBarrierStrategy` inserts nothing DIRECTLY before it. **So §13h's
`group` arm is CONFIRMED and its justification is now stronger than the audit's**: arrival order is not
merely `FoldStep`'s habit, it is what `group` gets on an ADJACENT fan-out because nothing on that path can
coalesce. `order()` is the opposite, and "ties keep arrival order" is false there.

**One qualifier, and it rehabilitates §13h's third bullet from `RISK` to a real latent divergence.** "The
traversers reaching a `group()` have bulk 1" holds only when the fan-out is ADJACENT to it, as in the
measured `g.V().both().group()`. Put any barrier-eligible step between them — `g.V().both().values("name").group()`
— and `LazyBarrierStrategy` DOES insert a coalescing barrier after `both()` (its successor is now `values`,
neither the last step nor a `Barrier`), and bulk SURVIVES the intervening flatMap:
`traverser/util/AbstractTraverser.java:57` `split(r, step)` clones the traverser and replaces only the
value, so a bulked parent yields bulked children. `FoldStep` then repeats each member `bulk` times,
adjacently. So §13h's "a bulked `group()` would not repeat members by `bulk`" is REACHABLE, not merely
hypothetical — its stated reason for being safe (`computeCollapseSafe` excludes a `group` from the prefix)
is about OUR collapse gating and says nothing about the reference's bulking.

**This does not change the increment.** Arrival order is the right answer for the unbulked shape, which is
what the `group` arm fixes; the bulked shape needs the bulk column exactly as `order()` does, and lands with
it. What it changes is the SIZE of the bulking increment's payoff: it is not one step's tie-break but the
member order of every collecting barrier reached through a non-adjacent fan-out.

**`groupCount` is NOT part of the fix, and §13h naming it is a third error the code refutes.** Its value is
a count and its map is a `HashMap` (`GroupStep.java:64` `HashMapSupplier`, and the corpus compares maps
order-insensitively), so nothing about a `groupCount` answer is an order. `map.ts` already knows this — its
encounter lookup is gated on `collecting`, i.e. `step.name === 'group'`, under a comment saying a
`groupCount` never carries the member column. Adding `groupCount` to `COLLECTING_CONSUMERS` would demand a
channel no arm reads. **The set gains `group` alone.**

Measured on the modern graph (`g.V().both()`, arrival `2,3,4,1,1,4,6,1,3,5,4,3` — both spines agree, and
`fold()` proves the encounter column is what makes it right):

| | `group().by(T.label)` members | `order().by(T.label)` |
|---|---|---|
| RelIR | `1,1,1,2,4,4,4,6` ✗ | `1,1,1,2,4,4,4,6,3,3,3,5` ✗ |
| legacy | `2,4,1,1,4,6,1,4` ✓ | `2,4,1,1,4,6,1,4,3,3,3,5` ✗ |
| reference | `2,4,1,1,4,6,1,4` | `2,4,4,4,1,1,1,6,3,3,3,5` |

**And legacy's ✓ is an ACCIDENT, which is the argument for fixing the `group` arm in `analyze.ts` rather
than in either spine.** Under `MOGWAI_REVERSE_UNORDERED=1` legacy's members come out
`josh,vadas,josh,marko,peter,josh,marko,marko` — a different order, because with no encounter column the
answer is whatever scan SQLite chose; RelIR's is stable under reversal and wrong. So the two spines are not
"one right, one wrong": one is pinned to the wrong column and the other is pinned to nothing. Adding
`group`/`groupCount` to `COLLECTING_CONSUMERS` fixes BOTH at once — RelIR stops falling back to `'id'`, and
legacy's arrival order stops being SQLite's choice — which is the standing rule that a member order must be
pinned by the SQL we emit (`test/CLAUDE.md`, the perturbation instrument).

**One prediction here was WRONG and the correction is the useful part.** This paragraph originally said the
fix "predicts a new `test:perturbed` gain". It did not: the instrument sat at 4 before and after, and the
four are the ones `test/CLAUDE.md` already names — a `group().by(T.id)` KEYING defect (a different bug), two
child-scope per-origin reducer assertions, and the census's own answer gate. The reason is the point:
**no test asserted a group's member order at all**, so the fragility was invisible to the instrument as well
as to the corpus, and a fix cannot show up as a gain in a suite that never made the claim. What the
instrument CAN do is confirm the fix, once an assertion exists — the new
`test/L4-addendum/group-member-order.feature` passes under `MOGWAI_REVERSE_UNORDERED=1` on BOTH spines,
which is the real evidence, and is why `test/CLAUDE.md`'s rule about only adding an `ordered` L4 assertion
that survives perturbation cuts both ways: it is also how a perturbation fix gets a witness.

Read the `order()` column carefully: **RelIR is closer to the reference than legacy is** — it already puts
duplicates adjacent, and only the group ORDER is wrong (rowid, where the reference is first arrival). So
implementing §13h's second bullet as written would have made RelIR match legacy and move it AWAY from the
reference. That is §13n's lesson in the other direction and worth stating as a rule:
**agreement between the two spines is not evidence of correctness — it is evidence of a shared cause.**

**Consequence for the ordering criterion.** The `order()` arm is not an `elementOrder` tie-break fix at all;
"distinct by first arrival, duplicates adjacent" is `GROUP BY row, SUM(bulk), MIN(encounter)` — which is
exactly a **bulk column**. So this arm is BLOCKED ON BULKING and must not be attempted before it; the
`group` arm is independent and lands on its own. Bulking's case was previously architectural (memory,
`outstanding-work`); this makes it a CORRECTNESS argument with citations, and widens its blast radius past
reducers — any `<fan-out>` followed by a `TraverserSet`-parking barrier has a member order we get wrong.

**And bulking is far cheaper than "the biggest structural gap" implies, because the plumbing is already
there and merely UNFED.** `bulk` is a `ChannelRole` (`src/channels.ts:25`), `CHANNEL_GROUP_POLICY` already
admits it and `encounter` under a grouping (the two roles for which N-rows-into-one has a defined answer),
`groupCount` already consumes it as `SUM(bulk)` and `element.ts:264` already projects it — but **every
producer in the tree is `lit(1, 'int')`**, so nothing ever carries a multiplicity ≠ 1. Better still, the
coalescing node itself is already written: ordered `dedup()` is
`Aggregate { groupBy: [id], aggs: [bulk = 1, encounter = MIN(encounter)] }` (`src/compiler/rel/lower.ts:880-884`),
where `bulk = 1` is deliberate and cited (`dedup` RESETS multiplicity). A bulking barrier is that node with
`SUM(bulk)` in place of the reset. So the increment is a PRODUCER plus the insertion rule — where the
reference's `LazyBarrierStrategy` puts one — not a new channel and not a new algebra node.

Corpus status: **invisible, and provably so rather than by assumption.** No `.feature` expectation in the
corpus contains a list with a repeated vertex member (checked over every feature file), and both fan-out
`Order.feature` scenarios (`:103`, `:219`) key on `age`, which is unique per person — so the corpus cannot
discriminate any of these three columns. Silence, per §10·8, not permission.

### 13i. Doc corrections from the audit

- `modulator.ts` cites `OrderGlobalStep.java:82` for the productivity quote; `:82` is the method signature
  and the deciding line is `:85`. The claim is right, the line is off by three.
- `modulator.ts`'s `by(T.label)` comment says "insertion order names the first", but it orders by
  `vertex_labels.label` — a FK into the `labels` dictionary — which is the order the label NAME was first
  interned graph-wide, not this vertex's insertion order. (The property arm beside it orders by a rowid and
  IS insertion order, exactly as its comment says.) Note TinkerPop says nothing here: `Element.label()` is
  single-valued upstream, so multi-label tie-breaking is our own extension.
- **Confirmed correct and not to be re-litigated:** the `count`-seeds-0 versus reducers-emit-nothing
  contract and its citation (exact); `dedupBy`'s `setBulk(1L)` citation (literally that line) and its
  unobservability today; `group`/`groupCount` over zero traversers being one empty-map traverser
  (verified to the GraphBinary bytes on both spines); `sortTerms`' per-key CONJOINED productivity being the
  reference's rule (`OrderGlobalStep` breaks out of its comparator loop and requires
  `projections.size() == comparators.size()`); `map.ts`'s "two rules, one slot" claim about the value
  `by()`, whose two cited scenarios do say what it says; `bulkSlice`'s band trimming against
  `RangeGlobalStep`'s `toSkip`/`toTrim`/`setBulk`; `mean`'s forced REAL against `MeanNumber.getFinal`; and
  the whole bulk-weighting rule across the reducer family (`sum` multiplies by bulk, `min`/`max` are
  bulk-invariant, `groupCount` weights).

### 13j. THE WORST ONE — a `Project` over a whole-relation `Aggregate` DELETES the aggregation `DEFECT`

Third audit, against Calcite. **Calcite has the exact guard we are missing, with a comment naming this
case**, so this is not a subtle disagreement — it is a known hazard of the block assembler that we did not
copy. VERIFIED, RelIR-only, shipping:

| traversal | RelIR | legacy (correct) |
|---|---|---|
| `g.V().count().constant(1)` | **6 rows of 1** | `[1]` |
| `g.E().count().constant(7)` | **6 rows of 7** | `[7]` |
| `g.V().values("age").max().constant(0)` | **4 rows of 0** | `[0]` |
| `g.V().count().constant(1).count()` | **6** | `1` |
| `g.V().count().constant(1).is(P.gt(0))` | **`HAVING clause on a non-aggregate query`** | `[1]` |

`emit.ts`'s `project` arm opens a nested SELECT only when `input.distinct`; it never consults whether the
block is GROUPED. A whole-relation `Aggregate` has `groupBy: []`, so `renderBlock` emits no `GROUP BY`
clause at all — and a projection that references none of the aggregate's outputs therefore erases it,
leaving `SELECT ? AS v FROM nodes rn`. The fourth row is the tell that this is a wrong NUMBER and not just
a wrong arity, and the fifth is invalid SQL (the block still carries `groupBy: []`, so the `filter` arm
routes to `HAVING` while the select list no longer aggregates).

Calcite: `vendor/calcite/core/src/main/java/org/apache/calcite/rel/rel2sql/SqlImplementor.java:2223-2241`
— `if (hasAggregate && fieldsUsed.isEmpty()) return true;` under the comment *"Cannot merge because
\"select 1 from t\" is different from \"select 1 from (select count(1) from t)\""*. That is this defect,
named, in the file §5 already cites as the prior art for our slot-occupied test.

**Reached by `constant()` after a reducer**, because that projection emits `[['v', literal], …channels]`
and a reducer leaves no channels — so it references nothing. **Nothing can see it:** `rel-sweep` never
executes SQL, and the census only runs the L1 corpus, which contains no `<reducer>().constant(…)`.
`test:legacy-spine` is the right instrument and no test names one of these traversals.

**Fix:** block the `project` arm when the block is grouped and the projection reads none of its select
names (Calcite's `fieldsUsed.isEmpty()`); the safe superset is to block on any `grouped(b)` with an empty
`groupBy`. Then add the family to an L4 `.feature`, because it is a shape the corpus does not carry.

### 13k. The verifier proves less than the plan doc claims `DEFECT` (laws claimed, not enforced)

Four findings, all of the same kind — a rule stated in §3/§4 that nothing checks:

- **`prune` drops columns a non-`Project` parent's own expressions read.** It collects references only in
  its `project` arm, so a `Filter.pred`, `Sort.terms`, `Window.specs` or `Explode.expr` reading a column no
  consumer above needs has that column pruned from under it — measured, the result then fails `check` with
  `relation p has no declared column 'name'`. Latent (the pass has no production caller) but §4.5 calls it
  "Phase 3's prerequisite", and `test/rel.test.ts` covers only the shape where the required column is the
  one the `Project` emits. Fix: add each node's own `relExprs` references into its children's need.
- **The clean-room import boundary is claimed to be gated and is not.** §2 says "`mise run arch` gates it
  as a textual import scan"; `scripts/arch-check.ts` checks only the compiler Pass-role rules and the
  string `src/rel` does not appear in it. The boundary DOES hold today (verified: `src/rel/**` imports only
  `./*`, `../channels.ts`, `../sql/kernel/q.ts`) — but a breach would land green. Add the scan or delete
  the claim.
- **`check` never verifies that a pass-through node's declared type matches its input's.**
  `filter`/`sort`/`limit`/`distinct`/`materialize` have no type law: a `Filter` declaring `[id,name]` over
  a `Project` emitting `[id]` passes `check` and fails later in the EMITTER — which `rel-sweep` treats as a
  support regression. The same hole makes §3.5's left-join law unenforceable (the obligation checks rigid
  channels, never that the right side's `nullable` flags were widened). Fix: `preserving` asserts
  `sameColumns`, and the left-join arm asserts nullability.
- **The rendered-bind cap is bypassable and `checkPlan` never applies `planBindCount`.** §3.6 calls the DO
  cap "a plan property `check` can prove"; in fact the cap is applied to one node in `check`, and the
  RENDERED check lives in `renderStep`, which `emitRelational` does not go through — both current callers
  re-render and re-check by hand. A third caller would not. Move the assertion into `emitRelational`.

### 13l. Structural risks worth fixing before the arms that reach them `RISK`

- **`Distinct` collapses N rows into one and gets the PRESERVING contract**, so `CHANNEL_GROUP_POLICY`
  never applies to it — a `Distinct` carrying `encounter`/`alias`/`path` would pass the checker while the
  dedup is silently inert (the channel makes every row unique). Correct today only because the lowering
  projects `bulk` as a constant and routes the ordered case through an `Aggregate`. Apply
  `groupableChannels` to `distinct` too: a whole-row dedup IS a grouping by the whole row. Related and
  worse: `check` does not require an `aggs` entry to CONTAIN an `Agg`, so `aggs: [['x', col(input,'x')]]`
  is admitted and SQLite silently picks an arbitrary member.
- **`check` admits `Distinct`/`Limit`/`Sort` inside a recursive term**, which P3 measured as inert or
  whole-CTE rather than per-iteration. Latent until `repeat()` migrates, and exactly the shape that would
  silently answer a different question — refuse them by name, as the aggregate and window arms already do.
- **`name` is blind to correlated subplans.** It walks `relChildren` only, so a node shared between the
  main tree and a `Scalar`/`Exists` body is inlined twice, and a `Materialize` INSIDE a correlated subplan
  is silently inert. No reachable wrong answer found; the fix is to walk expression subplans, which
  `fuse.ts` already demonstrates.
- **`bindCount` re-derives a statement's shape** instead of using `stmtChildren`/`stmtExprs` — the exact
  thing `walk.ts` says it exists to prevent ("an analysis that walked a statement by re-deriving its shape
  is one a new statement field would silently skip"). No divergence today; the budget is the DO wall, and
  under-reporting only shows up in production.
- **A set op takes an unnecessary derived table for a tail slot.** Calcite's `Clause` order puts `SET_OP`
  before `ORDER_BY`/`FETCH`, so `(…) UNION ALL (…) ORDER BY x LIMIT n` is ONE statement there and two
  here. Not wrong, just fatter — and worth noting the inverse: our conjoining of adjacent `Filter`s into
  one `WHERE` is BETTER than Calcite, which wraps.
- **`Values` refusing the empty relation has nowhere to land.** Calcite's empty `Values` IS its canonical
  empty relation, lowered to exactly the spelling our factory tells callers to build by hand
  (`SELECT NULL AS c0 … WHERE FALSE`) — and that spelling is not constructible here, because `Block.from`
  is required so the emitter cannot produce a FROM-less SELECT. So "a `Filter(false)` over something" must
  drag in a real table scan. Unreachable today; the first lowering that needs a statically empty relation
  pays for it.

### 13m. Plan-doc corrections the code refutes

The doc invites this and the code duly refutes it in seven places: the header's coverage (563) and deletion
(110) counters have both moved (775 and 98 — better replaced by a pointer to the two artifacts, which are
the authority) — **both now FIXED: the header cites the two artifacts instead of copying their numbers,
and §3.5 names the carried-channels rule.** A `lower.ts` comment still cites `isReEncoding`, deleted and
replaced by `CHANNEL_GROUP_POLICY`; §3.3 calls `Materialize` a planner HINT while `list.ts` calls it a legality WALL
and both are partly right (no `MATERIALIZED` keyword is emitted, so a named CTE is not a planner fence —
the bind-duplication and the table-valued-function legality are what it buys; and Calcite DOES have this
node, `Spool`, where it is semantics); §3 says `HAVING`-as-`Filter` and distinct-`UNION`-as-`Distinct`
COLLAPSE, but `Aggregate.having` and `Union.all` are still live fields that nothing ever constructs — dead
surface in a set the doc calls CLOSED; §3.6 credits `unroll` with a statement-text ceiling that does not
exist (the 100 KB cap is enforced only at the router) and §§4.2/4.3/4.7 describe `flatten`/`unroll`/
`recognize` in the present tense while `src/rel/passes/` holds only `fuse`/`land`/`name`/`prune` — worse,
`check.ts` throws a message instructing the reader to "run flatten first", a pass that cannot be run; §3.0's
three write-in-read-position examples (`union(__.addV(), __.V())`, `optional(__.addV())`,
`repeat(__.addV())`) all THROW on both spines, so they are the model's intent rather than behaviour; and
§3.6 credits the `land` pass with the retained-rows JSON transport, which is the EMITTER's (`land` only
rewrites `Values`).

**Confirmed exact, and not to be re-litigated:** §3.2's node counts (15 expression kinds, 19
relational/statement kinds); both Calcite anchors resolve at the pin; filter-after-aggregate → `HAVING`
matches Calcite's clause set and SQLite accepts it; the `Sort`/`Limit` SPLIT against Calcite's single
`Sort` is coherent in both directions (`Sort(Limit(x))` nests, `Limit(Sort(x))` fuses);
DISTINCT-with-ORDER-BY-on-a-non-selected-column and a window-in-WHERE are unreachable BY CONSTRUCTION; and
a `Join`'s positional output, no-duplicate-name rule and "addressed through the JOIN, never through the
side" all hold, the last as a `check` throw.

### 13n. WHAT THE AUDIT ASKED FOR AND WE REFUSED — a decline is only right when the OTHER spine is right

§13b listed five places where we answer and TinkerPop RAISES, and the suggested remedy in each was to
DECLINE so legacy raises the message it owns. Four of the five were then refused, and the reason
generalises past this family:

    g.V().values("age").toUpper()                     rel ["27","29","32","35"]   legacy ["27","29","32","35"]
    g.inject(1,null).asString()                       rel ["1",null]              legacy ["1",null]
    g.V().values("name").asNumber(GType.INT)          rel [0,0,0,0,0,0]           legacy [0,0,0,0,0,0]
    g.V().values("age").fold().toUpper(Scope.local)   rel [null]                  legacy [null]

**Legacy answers identically wrongly in every one.** So the decline buys ZERO correctness — it routes the
traversal to a spine that produces the same wrong value — and costs real RelIR coverage.
**A decline is only ever the right remedy when the other spine answers CORRECTLY**, which is the
assumption §13b's suggestions carried and which is false here. That is now a standing test to apply to any
"decline to legacy" proposal: measure the other spine first.

What the honest fix would need, and why it is not an increment yet: TinkerPop raises **per traverser**
(`ToUpperGlobalStep` tests `item instanceof String` for each), and NEITHER spine can raise from SQL. The
two candidate routes are (a) compile-time property typing, which would decide it statically — and does not
exist, because a property's type is per-row data in this schema; or (b) a runtime guard, which cannot
raise and so could only answer a DIFFERENT question (a `CASE` that skipped non-strings) or abort the whole
statement with a message that is not TinkerPop's. Neither is better than the documented divergence.

**The narrow discriminator that made `substring` different, and worth naming:** its defect was pure
ARITHMETIC — no type knowledge, no raise, no decline. That is why it was implementable in both spines at
once and closed five scenarios, while its four neighbours in the same file are parked. When triaging an
"answers where the reference raises" finding, ask first whether the fix needs a TYPE or only a FORMULA.

**A process note worth keeping.** The expected values in my own brief for two `substring` cases were
WRONG (I computed `mark`/`ma` where the reference gives `ark`/`a`), and the delegate pushed back with the
arithmetic rather than bending the code to match them. The corpus then settled it —
`Substring.feature` pins `o`/`ippl` and `lo`/`""` on the software names, which is what both spines now
produce. **A brief's expected values are a hypothesis, not an oracle; the corpus is the oracle.**

## 14. THE L3 RATCHET MUST EXPRESS "RelIR IS AHEAD" — the next increment, specified

**Decision (Dan, 2026-08-04): do NOT port the comparability and negation fixes to legacy.** Legacy is what
§8 deletes; spending on it is waste. The problem to fix is that **the L3 ratchet cannot express a spine
being ahead**, so `mise run test:legacy-spine` now fails on a floor it structurally cannot meet.

**The state today.** `l3-state.json` holds ONE floor (`passing: 1726`, plus `passed[]`/`failed[]`) and the
gate is "no regression, and not below the count". With RelIR ON that is 1726. With `MOGWAI_RELIR=0` it is
**1719** — the 7 comparability/negation scenarios are RelIR-only, because those fixes landed in
`src/compiler/rel/predicate.ts` and legacy keeps both defects. RelIR being ahead is explicitly ALLOWED
(§10·4; the harness has `relirAhead` for the per-test case), but a single global floor cannot say it.

### The design — TWO floors, one per configuration, each ratcheting upward alone

`l3-state.json` gains a second recorded section for the legacy-spine configuration:

```
{ "passing": 1726, "passed": [...], "failed": [...],          // the DEFAULT config (RelIR on)
  "legacySpine": { "passing": 1719, "passed": [...], "failed": [...] } }
```

- a DEFAULT run gates on the top-level floor, exactly as now;
- a run with `MOGWAI_RELIR=0` gates on `legacySpine` instead;
- both ratchet UPWARD only, and both refuse a named regression.

**The one load-bearing rule: a legacy-spine run must write ONLY its own section.** L3 rewrites its state on
a clean run, so a legacy run that touched the top-level `passed[]` would silently LOWER the real floor —
turning the instrument into a way to erase the gate. Read the env switch once, pick the section, and never
cross.

**`passing - legacySpine.passing` is then a migration metric worth having** — the number of official
scenarios only the new spine answers. It should GROW as RelIR gains ground, and it is the honest measure of
"what would be lost by turning the switch off", which no counter reports today. Print it in the L3
telemetry line.

**Why not the alternatives.** Skipping the ratchet entirely under `MOGWAI_RELIR=0` would leave that
instrument with no conformance signal at all, so a genuine legacy regression would land green. A
hand-curated list of RelIR-only scenario NAMES (the `known.ts` shape) would work but needs a staleness
check and manual upkeep, where two recorded counts need neither — the scenario sets are already recorded,
so the difference is derivable rather than maintained.

**Scope.** `test/L3-conformance/l3.test.ts` (the gate + the record), `telemetry.ts` if the summary line
moves, and `test/CLAUDE.md`'s L3 paragraph, which currently describes one floor. Nothing in `src/`.

**Definition of done.** `mise run ci` green; `mise run test:legacy-spine` green with the legacy floor
recorded at 1719; deliberately breaking a legacy-only scenario fails the legacy run; deliberately breaking
a RelIR-only scenario fails the default run; and neither run can lower the other's floor.

### 14·1. §14 LANDED (95d932a) — and its definition of done exposed the SAME defect in the census

The L3 half is done: two floors, default 1726 and `legacySpine` 1719, each gating and recording only its
own section, the isolation rule covered by `test/L3-conformance/l3-state.test.ts` rather than by a comment,
and `ambientSpine()` now the single reader of `MOGWAI_RELIR`. One refinement on §14 as written: the
migration metric is the scenario-name **set** difference, not the subtraction of the two counts. Both sets
are recorded so the difference is derivable, and a subtraction reads small while the sets diverge in both
directions. It currently names exactly the seven — 7 RelIR-only, 0 legacy-only.

**What §14 did not know: `mise run test:legacy-spine` fails a SECOND test, and for the same structural
reason.** `test/census/census.test.ts`'s "no executing traversal changes its answer" fails, because the
census EXECUTES under the AMBIENT spine while `goldens.tsv` records ONE digest per traversal — and it was
recorded with RelIR on, after `bd993be` landed the RelIR-only comparability/negation fixes. One baseline, two
configurations: §14's problem in a second instrument. Not a regression, and not visible in `ci`, which runs
only the default position.

**The divergence is NINE rows, and they are exactly §13a's two arms** — `is(P.gt/gte/lt/lte)` across a type
boundary and `is(P.neq(...))` over `null`/`NaN`:
`g.inject("foo").is(P.gt(1.0d))`, `…gte…`, `g.inject(1.0d).is(P.lt("foo"))`, `…lte…`,
`g.inject(1.0d).is(P.neq(NaN))`, `g.inject(NaN).is(P.neq(1.0d))`, `g.inject(NaN).is(P.neq(NaN))`,
`g.inject(null).is(P.neq(1.0d))`, `g.inject(null).is(P.neq(NaN))`. The same root cause as L3's seven
RelIR-only scenarios, counted over the corpus instead of the corpus of scenarios.
**(Nine — the commit message of 95d932a says "47 rows" and that is wrong: 47 was bun's DIFF-LINE count, and
each row formats as three lines plus separators. Correcting it here because a count in a commit message is
not editable and this one would read as a much larger divergence than exists.)**

**The fix is not a second baseline file.** The census already pins a spine for one question — `spineOf`
compiles with `{ spine: 'rel' }` so its coverage column measures the MIGRATION rather than the switch — and
the increment is to extend that principle from COMPILATION to EXECUTION: run each traversal in BOTH pinned
positions and record both, so the artifact is identical in either configuration and the census stops reading
the ambient switch for its answer gate at all. Goldens gains `lstatus` + `lms`; the answer gate covers both
positions; a new two-way gate holds the legacy position's status; and the divergence count
(`ms !== lms || status !== lstatus`) is PRINTED, never gated, because it grows legitimately as RelIR gains
ground — the per-row gates already catch every individual change.

**Two columns and not one, which is the detail the design turns on:** the positions can differ in whether
the traversal RUNS, not merely in what it answers, because RelIR is allowed to be ahead (§10·4 — that is
what `relirAhead` exists for). A single digest column would read a legacy DEFERRAL as an empty answer.

**Why this is worth more than making one red test green.** The spine equivalence obligation of §10·4 is
today declared and checkable only by an ENV-switched run of the whole suite — exactly the position the
FAST-PATH equivalence obligation was in before `Executor` learned to take a `fastPaths` override, which its
own comment records as having left the obligation "declared … but unprovable through the real data plane".
The same override for `spine` puts the differential inside `ci` for all 2,298 corpus traversals, one always-on
committed artifact, and it costs one extra execute per traversal. `test:legacy-spine` remains the instrument
for everything the corpus does NOT cover.

### 13g·1. The group child-value arm, settled — and it DEPENDS on the `group` arm above

§13g's first bullet (a child value `by()` on `group()` collects a LIST where the reference assigns a single
VALUE) is CONFIRMED against `gremlin-core`, with three details the audit did not carry — two of which change
what the fix has to do.

**The wrapped set is FIVE kinds, not three.**
`gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:92-101` wraps
into `__.map(v).fold()` — hence a list — for `ValueTraversal`, `TokenTraversal`, `IdentityTraversal`,
**`ColumnTraversal`** and **a start step that is a `LambdaMapStep` whose function is a `FunctionTraverser`**.
So `by(Column.values)` folds to a list too, which §13g's "`by('age')`, `by(T.label)`, `by()`" omits. Anything
else — a genuine anonymous traversal — is returned unwrapped.

**The unwrapped arm takes the FIRST value the child produces, not "the value".**
`.../step/map/GroupStep.java:111-138`: `projectTraverser` does `this.valueTraversal.reset()`, adds the one
traverser as a start, and under `if (null == this.barrierStep)` does
`if (this.valueTraversal.hasNext()) map.put((K) p, (V) this.valueTraversal.next())`. A child emitting several
values contributes only its first; the rest are discarded, never appended.

**And across traversers sharing a key, the LAST one wins.** `GroupStep.java:63` sets the reducing operator to
`new GroupBiOperator<>(null == this.barrierStep ? Operator.assign : …)`, and
`.../traversal/Operator.java:112-116` is `assign { apply(a, b) { return b; } }` — the new incoming value,
returned unchanged. So the group's value for a key is the LAST arriving traverser's first child value.

**Therefore this arm is BLOCKED ON the `group` arm of §13h, and that is a real ordering constraint rather
than a preference:** "last arriving" is not expressible while the chain carries no emission position for a
`group()` — with `ORD_COL` falling back to the rowid, "last" would mean "highest rowid", which is a different
question and the same class of wrong answer §13h·1 documents for the member list. Land `group` in
`COLLECTING_CONSUMERS` first, then this arm is `LAST_VALUE`/`MAX(encounter)` over the group rather than a
`json_group_array`. Corpus: **visible** — `sideEffect/Group.feature:122`
`g_V_group_byXvaluesXnameX_substringX1XX_byXconstantX1XX`, which RelIR fully covers.

### 13g·2. The `child`/non-`child` split IS the reference's wrapped/unwrapped split — with ONE lossy normalization

Checking §13g·1's discriminator against `modulator.ts` before delegating it: the mapping is exact, which is
worth recording because it means the group value arm needs no new vocabulary.

| our `ByKey.kind` (`modulations`) | the `by()` written | upstream class | wrapped into `map(v).fold()`? |
|---|---|---|---|
| `property` | `by('age')` | `ValueTraversal` | yes → LIST |
| `token` | `by(T.label)` | `TokenTraversal` | yes → LIST |
| `identity` | bare `by()` | `IdentityTraversal` | yes → LIST |
| `child` | `by(__.…)` | a plain anonymous traversal | **no** → single VALUE |
| — declines — | `by(Column.values)` | `ColumnTraversal` | (unreachable here) |

`Column` is not a hazard for this arm after all: `modulations` REFUSES a `Column`/`Operator`/`GType` in a
`by()` outright (`src/compiler/rel/modulator.ts:144`), so it never reaches `groupBarrier` to be
misclassified. So `kind === 'child'` is exactly the reference's unwrapped set, and the split is sound.

**The one real gap is `by(__.identity())`, and it is a lossy NORMALIZATION rather than a missing arm.**
`modulator.ts:136-138` rewrites `by(__.identity())` to `{ kind: 'identity' }` under the comment that "both
project the element itself. Normalizing it here keeps every host from having to re-derive that semantic
identity". That is true of the PROJECTION and false of the question `convertValueTraversal` asks, which is
not about projection at all but about which CLASS the modulator produced:

- `IdentityTraversal` is constructed in exactly one place — `step/ByModulating.java:68`, the NO-ARG
  `modulateBy()`, i.e. a bare `by()`. An explicit `__.identity()` is an ordinary anonymous traversal.
- so `convertValueTraversal`'s `instanceof IdentityTraversal` is FALSE for `by(__.identity())` → unwrapped →
  `GroupStep` takes `valueTraversal.next()` → a single element, the LAST arriving traverser's.
- and `IdentityRemovalStrategy` (also in the default list, `TraversalStrategies.java:275`) does not rescue
  the distinction: it strips the `IdentityStep`, leaving an empty traversal that is still not an
  `IdentityTraversal`.

So `g.V().group().by(T.label).by()` is a LIST and `g.V().group().by(T.label).by(__.identity())` is a single
ELEMENT, and we answer a list for both. **Deliberately NOT folded into the §13g arm**: that arm is about the
`child` kind, while this is a normalization that is CORRECT at every other host (`order().by(__.identity())`
really is `order().by()`) and lossy at exactly one. Fixing it means the group-value host distinguishing the
two, not deleting the normalization — a separate, smaller increment, and the comment claiming the
normalization is host-independent should be corrected when it lands. Corpus: invisible.

### 13g·3. `min`/`max` over a MIXED stream: the reference RAISES — settled, so fail closed

§13g's fourth bullet left this open and named the right question: whether TinkerPop 4 intends
`Orderability`'s total order in this position rather than a raise. **The code says no, and there is no
Orderability path in `min`/`max` at all.** `MinGlobalStep`/`MaxGlobalStep` set their reducing operator to
`Operator.min`/`Operator.max` (`MinGlobalStep.java:39`), those delegate to
`NumberHelper.min`/`max` (`Operator.java:88-104`), and `NumberHelper.java:582-596` / `:639-653` end with

```java
if (a instanceof Number && b instanceof Number) { … getHighestCommonNumberClass … }
else { return a.compareTo(b) < 0 ? a : b; }
```

so a mixed pair reaches `Integer.compareTo(String)` and throws `ClassCastException`. `GremlinValueComparator`
is never consulted. **Decision: fail closed** on a `min`/`max` whose stream is not within one type space —
the same rule §13a already landed for range PREDICATES (`Compare.gt` opening with
`if (!COMPARABILITY.comparable(first, second)) return false;`), so the type-space authority already exists in
`src/compiler/rel/predicate.ts` and this is a second consumer rather than new machinery. Today
`g.inject(1,"a").min()` answers `1`, which is a wrong answer with the right arity.

**Two facts in the same functions that the audit did not record, and that no scenario need name:**

- **NULL is SKIPPED, not propagated:** `if (a == null || b == null) return a == null ? b : a;` — so
  `min` over `[null, 5]` is `5`, and over `[null, null]` is `null`. SQL's `MIN` ignores NULL, so we agree
  here by accident of the same rule.
- **NaN is SKIPPED unless EVERY value is NaN:** `if (eitherAreNaN(a, b)) return isNaN(a) ? b : a;` (the
  comment says "propagate NaN if both"). This we do NOT agree with: SQLite stores NaN as NULL, so an
  all-NaN stream gives us `null` where the reference gives `NaN`. Narrow, and worth fixing in the same
  increment since it is the same two functions.

### 13g·4. The numeric tower's PROMOTION rule, precisely — for whoever builds §13g's reducer-type arm

§13g's second bullet is right that the reducer's result type must be a Gremlin class rather than a SQLite
storage class. The mechanism, so the arm does not have to be re-derived:
`NumberHelper.mathOperationWithPromote` (`gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:401-428`)
starts at `getHighestCommonNumberInfo(a, b)` — a (bits, isFloatingPoint) pair, the NARROWEST class holding
both — and on an `ArithmeticException` calls `numberInfo.promoteBits()` and RETRIES in a loop. So:

- `127b + 1b` overflows byte and promotes 8 → 16 bits: the result is a **short**, exactly as §13g says.
- **integer overflow at ≥ 64 bits THROWS** (`if (!fp && bits >= 64) throw exception;`) — `sum()` over longs
  that overflows is an ERROR, not a silent wrap and not an automatic `BigInteger`. Worth flagging against
  this project's "carry an int64 above 2^53 as decimal TEXT" decision: the reducer arm must raise there
  rather than widening into the exact-decimal representation, or it answers where the reference refuses.
- **floating point at ≥ 64 bits does NOT throw** — it returns the infinite result (`if (fp && bits >= 64)
  return result;`), and the javadoc states it: `±Double.POSITIVE_INFINITY` rather than an exception.
- a `BigInteger`/`BigDecimal` result short-circuits out of the loop before the overflow checks.
- `if (null == a || null == b) return a;` — a null operand is skipped, consistent with `min`/`max` (§13g·3).

### 13d·1. `all`/`any`/`none` over a NON-COLLECTION: we RAISE where the reference FILTERS

§13d's first bullet is confirmed and its shape is worth stating exactly, because it is the MIRROR of §13b's
family and so the §13n caution does not apply: there we answer where TinkerPop raises; here we RAISE where
TinkerPop returns `false`. A fix is unambiguously a fix.

`step/filter/AllStep.java:49-68` — `filter` tests `item instanceof Iterable || item instanceof Iterator ||
((item != null) && item.getClass().isArray())`, and **ends `return false;`** with no throw. `NoneStep` and
`AnyStep` are the same shape at the same lines (`AnyStep` differs only in returning `true` from inside the
loop). Two consequences:

- a NON-COLLECTION traverser makes all three FALSE — including `none`, which is the counter-intuitive one and
  is spelled as that same bare `return false;` rather than a vacuous truth;
- a NULL traverser is likewise FALSE, not an error: `item` is null, the `item != null` guard makes the array
  test false, and control reaches the same `return false`. The only throw in the file is in the CONSTRUCTOR,
  for a null PREDICATE (`AllStep.java:42-44`).

Measured today, all three raise instead:

    g.V().values("age").all(P.gt(32))   → throws "all step can only take an array or an Iterable type for
                                          incoming traversers, encountered a …"
    g.inject(7).any(P.gt(1))            → the same message for `any`
    g.inject(null).all(P.eq(null))      → throws "Incoming traverser for all step can't be null"
    g.inject(7).none(P.eq(7))           → throws "none() after a scalar stream not yet supported"

**CORRECTION to my own first draft of this paragraph, which said those messages "have no counterpart in
`origin/master` and should simply go". Two of them ARE upstream's, verbatim** —
`util/ListFunction.java:106` is `"%s step can only take an array or an Iterable type for incoming
traversers, encountered %s"`. What is wrong is not the wording but WHICH STEPS reach it:

- `ListFunction` is implemented by exactly eight steps — `Combine`, `Intersect`, `Difference`,
  `Disjunct`, `Product`, `Merge`, `Conjoin` and `Reverse` — and `convertTraverserToCollection` raising that
  message for a non-collection traverser is correct for all of them.
- `AllStep`/`AnyStep`/`NoneStep` extend `FilterStep` and implement `ReadOnlyTraversalParent`. They do **not**
  implement `ListFunction`, never call `convertTraverserToCollection`, and do their own inline
  `instanceof Iterable` test ending in `return false`.

So the fix is narrow and must NOT touch the set-ops: `SCALAR_LIST_ONLY` in
`src/compiler/steps/tail/projection.ts:840` is right for the seven collection steps in it and wrong for the
two filters — `all` and `any` come OUT of that set and become filters that drop every row, and `none` (which
is not in the set at all, hence its separate "not yet supported" message) gets the same treatment. The
`literalNull` throw beside it goes for those three too: a null traverser is `false`, not an error.

The `none()`-over-a-scalar case is additionally a MISSING HOST ARM, not just a wrong message, so that
scenario needs the arm as well as the rule. Corpus: **visible**, and §13d already names the three failing
scenarios — `g_V_valuesXageX_allXgtX32XX`, `g_injectX7X_noneXeqX7XX`, `g_injectXnullX_allXeqXnullXX`.

### A PROCESS NOTE, since it cost work: never edit a file a running delegate was told not to touch

The paragraph above had to be written twice. A delegate running under "do NOT edit
`docs/2026-08-01-relir-build-plan.md`" reverted that file — reasonably, to honour the instruction — and took
an UNCOMMITTED append of mine with it. The instruction was right and the loss was mine. **Commit
architect-side doc work BEFORE delegating**, or keep it out of the worktree until the delegate is done; a
"don't touch X" instruction makes X a file the delegate may restore, not merely one it will leave alone.

### 13k·1. Finding #2 is REFUTED — the clean-room gate exists, and §2's claim is true

§13k says "**The clean-room import boundary is claimed to be gated and is not** … `scripts/arch-check.ts`
checks only the compiler Pass-role rules and the string `src/rel` does not appear in it". **That is wrong.**
`scripts/arch-check.ts:150-168` holds the scan, spelled

```ts
const CLEANROOM = { dir: 'src/rel', forbidden: ['src/compiler/', 'src/gremlin/'] };
```

— it walks `src/rel/**/*.ts`, resolves every relative `from '…'` specifier against the file, and reports any
that lands under a forbidden prefix; `leaks.length` joins `violations`/`unresolved` in the exit code, and the
success line names the rule. It is not a late addition either: it landed in `25e0b5f` ("a neutral channel
core, so the RelIR clean room is actually clean") on **2026-08-02**, two days BEFORE the audit, and
`git merge-base --is-ancestor` confirms it is an ancestor of the audit commit. So §2's "`mise run arch` gates
it as a textual import scan" is ACCURATE and needs no change.

**Acting on the finding would have been actively harmful in both directions** — either adding a second,
duplicate scan, or deleting a claim that is true. That is the §13n pattern in a new place: a remedy is only
right once the premise is checked, and an audit's "X does not exist" is a claim about absence, which is the
easiest kind to get wrong.

**And a near-miss of my own, worth recording because the tooling caused it.** I first "confirmed" the finding
from a `grep -n "src/rel" scripts/arch-check.ts` that printed NOTHING while exiting 0 — a contradiction
(grep exits 0 only on a match), which I did not read. The wrapper had swallowed the output. **An empty
output with a success exit code is not evidence of absence; it is evidence the command did not report.**
The repo already has the right instrument for this class — `bun scripts/refs.ts` for a symbol, and for a
plain string a `grep` whose output you have actually seen.

**Consequence for the rest of §13k: verify each of the other three before building anything.** They are
`prune` dropping columns a non-`Project` parent's own expressions read, `check` having no pass-through type
law, and the rendered-bind cap being bypassable — all plausible, none yet re-derived, and this section's
hit rate is now 3-of-4 at best.

**Re-derivation tally for §13k, running.** #2 REFUTED above. **#1 CONFIRMED**, and precisely:
`src/rel/passes/prune.ts:42` calls `refs(...)` ONLY inside the `project` arm, while the generic branch at
`:46-47` gives each child either its FULL column list (safe, for a non-`preserves` node) or the narrowed
`need ∪ channelCols(child.channels)` — for the seven `preserves` kinds
(`filter`/`sort`/`limit`/`distinct`/`window`/`explode`/`materialize`), whose OWN expressions are never walked
for references. So a column read only by a `Filter.pred`, `Sort.terms`, `Window.specs` or `Explode.expr`, and
needed by nothing above, is pruned out from under its reader — §13k's measured
`relation p has no declared column 'name'`.

The proposed fix ("add each node's own `relExprs` references into its children's need") is well founded:
`relExprs` already exists in `src/rel/walk.ts:34` and is TOTAL over the node kinds, returning exactly the
per-kind expression list (`filter` → `[pred]`, `sort` → the term exprs, `window` → the spec exprs, `explode`
→ `[expr]`, and so on). It is also the function `walk.ts` exists to make callers use instead of re-deriving a
node's shape — the same argument §13l makes against `bindCount`. So the fix is one call in the generic
branch, not new machinery. Still latent (the pass has no production caller), and §4.5 calls it Phase 3's
prerequisite, so it should land before the repeat wedge rather than with it. #3 and #4 remain unverified.

**Tally COMPLETE: §13k is 3-of-4 — #1, #3, #4 confirmed, #2 refuted.**

**#3 CONFIRMED.** `sameColumns` already exists (`src/rel/check.ts:51`) and compares name, type AND
`nullable` positionally — but it is applied at only three sites: a `Ref` against its binding (`:197`), the
set-op inputs (`:228`), and a recursive seed against its step (`:239`). There is no `case 'filter'` type law
anywhere; the pass-through kinds appear in `check.ts` only at `:129-130`, which is a recursive-term LEGALITY
test, not a type one. So a `Filter` declaring `[id,name]` over a `Project` emitting `[id]` passes `check` and
fails later in the emitter. The fix applies an existing predicate rather than writing one. Note §13k's list
is precisely right about WHICH kinds: `filter`/`sort`/`limit`/`distinct`/`materialize` preserve the type,
while `window` and `explode` legitimately change it (`window` declares its spec outputs, `explode` its
exploded column), so they must NOT be held to `sameColumns` even though `prune`'s `preserves` set includes
them. Two different questions over overlapping sets — worth not conflating when the law is added.

**#4 CONFIRMED, both halves.** `planBindCount` exists (`check.ts:94`, summing every binding plus the result)
and `checkPlan` (`:325`) never calls it — it calls `check` per binding and once for the result, and `check`
applies the cap per NODE at `:317`. So the plan-WIDE total is unproven, which is exactly what §3.6 claims
`check` proves. And the RENDERED cap lives in `renderStep` (`emit.ts:533`), which `emitRelational` (`:574`)
does not reach: it returns `result` as an un-rendered `Expression`, so its caller renders and re-checks by
hand. Both current callers do; a third would not have to.

So the process rule stands vindicated in both directions: re-deriving §13k cost little and turned one
"missing gate" into "the gate has been there since 2026-08-02", while confirming the other three precisely
enough that each fix is now a known one-liner against an existing total function or predicate
(`relExprs`, `sameColumns`, `planBindCount`) rather than new machinery. **None of the three is new
machinery — that is the headline for whoever picks them up.**

### 13k·2. Finding #4's REMEDY does not work as written — and my own "all three are one-liners" was wrong

§13k·1 closed with "all three fixes apply an existing TOTAL function or predicate … rather than adding
machinery". That is true of #1 and #3 and **false of #4**, whose two halves each break on inspection. The
FINDING stands; the remedy does not.

**Half one — "`checkPlan` never applies `planBindCount`" — is real, but applying it as a flat sum would
REJECT VALID PLANS.** `planBindCount`'s own docblock (`src/rel/check.ts:86-93`) already states the
distinction the remedy skips: `check` applies the cap per BINDING, "which is the right question for a `Stmt`
boundary (each is its own statement)", while "a read plan's bindings are CTEs of ONE statement, so its budget
is the SUM". So the sum is the correct budget only when every binding is a `Rel`. A program that mixes write
statements — the normal shape once Phase 2 lands — has several statement boundaries, and summing across them
over-counts. `bindCount`'s comment says over-reporting "merely fails closed", which is true of a per-statement
count and NOT true here: failing closed on a legal plan is rejecting a valid input, which the root
`CLAUDE.md` forbids outright. The real fix therefore needs the statement-boundary PARTITION — group each
`Rel` binding with the statement whose CTE it is, then cap per group — and a prior question the partition
depends on: whether a `Rel` binding referenced by two statements contributes its binds once or once per
referencing statement. Neither is a one-liner, and getting it wrong turns a proof into a false rejection.

**Half two — "move the assertion into `emitRelational`" — cannot be done literally.** `emitRelational`
(`src/rel/emit.ts:574`) returns an un-rendered `Expression` for its caller to COMPOSE into a larger query.
The rendered bind count is not final at that point, so there is nothing there to assert; rendering it to
check would render twice and still not bound what the caller finally emits. The honest shapes are either a
shared render-and-check helper that both current callers go through (so a third inherits it), or an explicit
contract at the seam saying the caller owns the check. That is a design decision, not a move.

**So #4 comes OFF the ready list** and stays a `RISK` with a named prerequisite. #1 (`prune` + `relExprs`)
and #3 (`sameColumns` for the five type-preserving kinds) remain genuinely small.

**One correction to #3's own scope while I am here: its left-join half is HALF DONE already.**
`src/rel/obligations.ts:121-128` does enforce the CHANNEL law — "An unmatched left-join row has the right
side entirely NULL … a rigid role is per-traverser physical state", throwing on a rigid channel carried from
the nullable right side. What is genuinely missing is the TYPE law beside it: a `left` join's declared output
columns that came from the RIGHT side must be `nullable: true`. Since a Join's output is POSITIONAL and
§13m confirms that holds, the law is exactly "for `join === 'left'`, every column at an index ≥
`left.type.cols.length` is nullable" — checkable, and distinct from `sameColumns`.

### 13g·5. The REDUCER COMPARISON cluster, measured — six wrong answers, two root causes, one existing authority

§13g's third and fourth bullets and §13g·3 are the same increment: `min`/`max`/`sum`/`mean` decide
eligibility and ordering by SQLite STORAGE CLASS where Gremlin decides by TYPE SPACE. All six measured today
(modern graph, RelIR spine); every one is a wrong answer with the right arity, so no ladder level sees it.

| traversal | ours | the reference |
|---|---|---|
| `g.inject(9007199254740993L, 1L).sum()` | `1` (integer) | `9007199254740994` |
| `g.inject(9007199254740993L, 1L).mean()` | `1` (real) | `4503599627370497` |
| `g.inject(10L, -9007199254740993L).min()` | `10` | `-9007199254740993` |
| `g.inject(10L, -9007199254740993L).max()` | `"-9007199254740993"` **as TEXT** | `10` |
| `g.inject(1, "a").min()` | `1` | RAISES (§13g·3) |
| `g.inject(1, "a").max()` | `"a"` | RAISES (§13g·3) |

**The `max` rows are new — §13g named only `min`.** And the fourth row is the worst of the six: `max` does not
merely pick the wrong element, it returns a Gremlin `long` to the wire **as a string**, because it takes
SQLite's max over mixed storage classes and hands back that value with its own `vtype = 'text'`.

**Root cause A — the eligibility guard.** This project deliberately carries an int64 above 2^53 as decimal
TEXT (root `CLAUDE.md`; `docs/…do-sqlite-bind-precision`), so a legal Gremlin `long` has `typeof = 'text'`
and `sum`/`mean` exclude it entirely — it contributes NOTHING rather than being cast.

**Root cause B — the comparison.** `min`/`max` admit it and then compare under SQLite's storage-class order
(INTEGER before TEXT), which is why `min` returns the larger number and `max` returns the string.

**The authority already exists and we already use it ONE LAYER UP, which is the argument.**
`storedCompareOn(vtype)` (`src/compiler/rel/predicate.ts:139`) is a `CASE` on the vtype casting to `int` for
the int-carrying types and `real` for the real-carrying ones, else the subject unchanged — and
`src/compiler/rel/modulator.ts:184,244` already applies it to ORDERING keys. So `order().by(…)` compares a
TEXT-carried long exactly while `min`/`max` do not: an inconsistency inside our own code, not a gap against
upstream. Reusing it makes the `arithmetic` class correct rather than widening a list, exactly as §13g said.

**Scope, and what is deliberately NOT in it.** Three things:

1. `sum`/`mean` cast the subject through `storedCompareOn` instead of excluding a TEXT-carried numeric.
2. `min`/`max` compare through `storedCompareOn` **and return the ORIGINAL row's value plus its own vtype** —
   selecting the row, never the raw storage extremum, which is what row four gets wrong.
3. a mixed type space FAILS CLOSED (§13g·3 — `NumberHelper` ends in `a.compareTo(b)`, so
   `Integer.compareTo(String)` throws and `GremlinValueComparator` is never consulted), reusing §13a's
   type-space authority in `predicate.ts` rather than building a second one.

**NOT in it, and each for a stated reason:** the numeric TOWER (§13g·4 — the result CLASS: `sum` of bytes is a
byte, `127b+1b` promotes to short) is a different question from comparison and carries six visible
`Sum.feature` scenarios of its own, so it is its own increment; integer overflow past 2^63, which the
reference RAISES on (§13g·4) and which this increment makes newly REACHABLE by admitting the big values —
worth a deferral rather than a silent wrap, and worth noting that admitting them is what makes it reachable;
and the all-NaN case, where the reference propagates `NaN` and SQLite stores it as NULL so we answer `null`
(§13g·3) — narrow, same two functions, fold it in if it is free and defer it loudly if not.

### 13c·1. The `set` framing marker — CONFIRMED, and the rule is PER FOLLOWER, not a blanket

§13c's fifth bullet is right and the citations resolve exactly, so the fix is a small table rather than a
judgement call. Our `set` framing marker is cleared by ANY follower; the reference converts a Set to a List at
some followers and preserves it at others:

| follower | reference | so the `set` marker must |
|---|---|---|
| `order(Scope.local)` | `map/OrderLocalStep.java:76,86` — `…collect(Collectors.toList())` | be CLEARED (we are right today) |
| `range(Scope.local)` | `map/RangeLocalStep.java:118` — `iterable instanceof Set ? new LinkedHashSet() : new LinkedList()`, and the javadoc at `:74-80` states it: "Map becomes Map (order-preserving) / **Set becomes Set (order-preserving)** / Other Collection types become List" | SURVIVE |
| `all`/`any`/`none` | `FilterStep`s — verified in §13d·1, they test the item and return a boolean, never touching the object | SURVIVE |

So a set op followed by a local SLICE frames as a List where a Set is owed: the right members with the wrong
wire type, which is the class no `.feature` catches because Gherkin's `s[…]`/`l[…]` distinction is only
asserted where a scenario writes it. Clearing on `order(Scope.local)` is correct and must be KEPT — the fix is
to stop clearing on the other two, not to stop clearing.

Worth pairing with §13e's confirmed list, which already pins the set-op RESULT types one for one
(`Intersect`/`Difference`/`Disjunct`/`Merge` → `Set`, `Combine` → `List`, `Product` → `List<List>`): those are
what PRODUCES the marker, and this is what must not lose it. Corpus: invisible for the surviving cases.

### 13c·2. `AliasEntry.binds` — the FIRST half is a LIVE WRONG ANSWER, not a coverage cost; the second half is genuinely a pre-condition

§13c's fourth bullet splits into two halves and mis-grades both. Measured, RelIR spine:

    g.V(1).as("a").filter(__.identity()).as("a").select(Pop.mixed, "a")
      ours       a LIST containing marko
      reference  the bare vertex v[marko]

**§13c calls this "costing only coverage". It is a wrong answer with the wrong wire type.** The reference
binds `a` ONCE: `ImmutablePath.extend(Set<String> labels)`
(`gremlin-core/.../traversal/step/util/…/ImmutablePath.java:93-102`) opens
`if (labels.isEmpty() || this.currentLabels.containsAll(labels)) return this;` — a NO-OP for a label the
current head already carries. `filter` does not move the traverser, so the second `as('a')` lands on the same
head and adds no path position. Then `Pop.mixed` is `this.get(label)` (`:141-143`), which yields the bare
object for a label occupying one position. We count binds TEXTUALLY (`src/compiler/rel/alias.ts:140`,
`binds: (existing?.binds ?? 0) + 1`), reach 2, and `:255`'s
`pop === 'mixed' && entry.binds !== 1` then routes to the LIST arm.

**So the actionable fix is not the proposed vocabulary at all: a rebind at the SAME path position must not
increment.** `AliasEntry` already carries the position (`context.ts` — "Linear path position index this label
attached to … A rebind overwrites with the latest"), so the discriminator is in hand: increment only when the
head has moved since the previous bind. That is independent of `repeat` and can land now.

**The second half IS the pre-condition §13c says it is, and it is not reachable today.** Measured: both spines
DEFER `g.V(1).repeat(__.out().as("a")).times(2).select(Pop.mixed, "a")` with
`repeat(__.out().as()) not yet supported (body must be row-local: …)` — `as()` inside a repeat body is not
supported at all, so "binds stays 1 while the runtime binds N" cannot arise yet.

**And the proposed `1 | 'many' | 'unknown'` vocabulary is largely already there.** `binds?: number` documents
`undefined` as "dynamic depth (bound inside repeat()/a branch arm), where the count is only known at runtime
and Pop must resolve via SQL", the branch-merge arm (`context.ts:256`) already sets it undefined when arms
disagree, and `alias.ts:255`'s `!== 1` test makes `undefined` decline the static fast path — fail-closed
already. What the repeat arm must do is ensure a repeat-bound label reaches that `undefined`, not introduce a
third state. Worth restating the field's doc in those terms when it lands, rather than widening the type.
