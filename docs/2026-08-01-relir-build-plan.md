# RelIR — the build plan

**Status: BUILDING.** RelIR is the missing middle: `Step[] → RelIR → SQL`, an inspectable, rewritable
relational algebra between the Gremlin front-end and the `q` SQL kernel. It replaces the legacy
compile-straight-to-SQL spine, whose `Query.ctes` is a private append-only array — the query never exists
as data, so every optimization had to happen *before* lowering or be hand-built around.

**Two counters run the migration, and both live in committed, `ci`-gated artifacts — never copied here**
(a number in prose goes stale): coverage is `test/census/goldens.tsv` (the `spine` column), the deletion
list is `scripts/deletion-ratchet.tsv`. Read them from a `ci` run. The blocker ranking is
`mise run rel-blockers` — re-run it every round, it moves.

**This document is DIRECTION + TRAPS, not history.** What landed and at which SHA is `git log`'s job. A
parallel, machine-checkable statement of the same rules is `docs/spec/relir-algebra.allium` and
`docs/spec/relir-migration.allium`.

---

## §1. The measured platform envelope — LAW, do not re-derive

Measured against SQLite 3.51.2 and re-confirmed on DO SQLite (workerd) via a throwaway Durable Object
(`test/cf-probe/`, `test/cf-constructs.test.ts`). These are facts about the platform, not preferences.

- **P1 — the recursive-term law.** The recursive reference appears **exactly once, at the top level of the
  recursive term's `FROM`**; wrapping it in a derived table fails `circular reference` even as the sole
  reference. The rule is POSITIONAL. No aggregates, no window functions in a recursive term. A correlated
  scalar subquery may reference the walk's alias. → `flatten` is required, and a `Materialize` fence may
  never sit between the term and its own self-reference.
- **P2 — legal-but-refused-today.** `NOT EXISTS`, joins against a derived `UNION`, `IN (SELECT …)`,
  correlated scalars, multi-hop join chains are all legal in a recursive term. → `expandRepeatBody` is a
  hand-written join-flattener, not a platform workaround; it dies with `flatten`.
- **P3 — no per-iteration barrier is expressible in a recursive term, in ANY lowering.** `DISTINCT` is inert
  (SQLite feeds the term one queue row at a time), `LIMIT`/`ORDER BY` are whole-CTE caps, `UNION` dedups the
  whole walk (violating the multiset rule). Do not re-propose re-lowering.
- **P4 — corpus ratio.** Of 125 `repeat()`s, 53 have a barrier body: **48 `times(n)`-bounded (max n=10), 5
  `until()`/`emit()`**. → `unroll` is the majority route; the wall is 5.
- **P5 — the write envelope.** Legal: CTE→`INSERT … SELECT … RETURNING`; multi-row `INSERT … RETURNING`;
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM (subquery)`; `DELETE … WHERE … IN (SELECT)`.
  Illegal: the Postgres-style data-modifying CTE. → a write chain is a SEQUENCE of statements, O(write
  steps) not O(rows).
- **P5b — RETURNING determinism.** Row order is undefined, but id assignment follows the source `SELECT`'s
  `ORDER BY`. → order the source and re-associate by carried key, never by RETURNING position.

---

## §2. The clean-room boundary — LAW

`src/rel/` imports NOTHING from `src/compiler/` or `src/gremlin/` — pure data plus total functions,
testable with no graph, store, or Gremlin. `mise run arch` gates it as a textual import scan.

**It is a VOCABULARY boundary.** RelIR needs exactly two things about carried state: which output columns
are channels and in what order, and per channel its merge and barrier policy. The neutral **channel core**
is `src/channels.ts` (`Channels = readonly {col, role}[]` + role-keyed policy tables). **A RelIR node
cannot know what a sack is, and shape never enters the node set** — if a `src/rel/` node acquires a
`kind: 'scalar' | 'element' | …` field, the layer has failed. `ChannelRole` is per-column carried-state
bookkeeping, never the stream's Gremlin type.

Gremlin-shape-aware payload construction lives in `src/compiler/rel/` (`list.ts`, `map.ts`, `element.ts`,
`path.ts`, …) — outside `src/rel/`, so it may know shape. Only `execute.ts`'s byte framers
(`(rows, Shape) → Buffer[]`, no SQL) are permanently legacy's.

---

## §3. The object model — complete and CLOSED

Two algebras — **expressions** (a value per row) and **relations** (rows) — plus **statements** for writes.
Every node is an immutable plain object with a `kind` discriminant; every list is `readonly`. Node kinds
and fields live in `src/rel/{expr,rel,stmt}.ts` — the code is the authority.

**Construction is branded.** A `Rel` is minted only by its named kind factory (validates local shape,
freezes); rewriters rebuild through a factory, never spread a node. `check` validates scope and whole-plan
laws. `SelfRef` has no public factory — only `recursive` supplies it. **The set is CLOSED**: a missing
construct is a derived form; adding a kind requires proving the seam cannot EXPRESS the shape (§7's bar).

### §3.0 The top of a plan is a PROGRAM, not a tree

```ts
type Plan    = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt; readonly snapshot?: boolean }
```

A `Ref { name }` resolves a relation computed earlier — one concept, not two machines:

- a `Rel` binding referenced more than once → a **CTE** (`name`'s decision, §4.6).
- a `Stmt` binding → a **statement boundary**: the executor (`src/program.ts`) runs it, retains its
  `RETURNING` rows, and a `Ref` resolves to them as ONE JSON bind exploded by `json_each`.
- a `Rel` binding marked **`snapshot`** → a **read boundary**, the same retention/transport. This makes
  "the value AT THIS POINT" expressible — Phase 2 needs it, because a CTE is recomputed by every statement
  that names it. `retained(binding)` is `isStmt(node) || snapshot`; `checkPlan` proves the discipline (a
  pure `Rel` binding read by more than one step, in a program with effects, is a throw).
- a write in a read position is a **hoist to a binding** — `union(__.addV(), __.V())` is plan composition.
  There is no driver anywhere. Effects are legal only at a binding, as a type-level fact.

### §3.1 Types

`RelType = { cols: ColMeta[] }`, `ColMeta = { name, type: SqlType, nullable }`,
`SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any'` — SQLite storage classes plus `json`. **Never
a Gremlin vocabulary** (no `vertex`/`edge`/`list`); Gremlin typing stays in `ScalarType`/`CanonicalType`.

### §3.2 / §3.3 The node set

15 expression kinds, 19 relational/statement kinds. Deliberately smaller than SQL, because SQL's redundancy
collapses (`HAVING` is `Filter` over `Aggregate`; distinct `UNION` is `Distinct` over `Union{all}`; etc.).
Points the type declaration cannot state:

- **`WindowSpec.partitionBy: Expr[]`** unifies the global / per-origin / per-origin-dedup families (`[]`,
  `origins`, `[...origins, value]`).
- **`Scan` is the only physical-schema node** — the storage seam.
- **`Values` refuses the EMPTY relation** (invalid SQL); the empty case is a `Filter(false)` over something.
- **`Project` is the only node that may DECLARE channel columns.**
- **`Distinct` is whole-row only** — a keyed dedup is `Window(row_number PARTITION BY key)` + `Filter(rn=1)`.
- **`Window` may only EXTEND its input**; the mint-then-project pair is two nodes, fused by the assembler.
- **`Join` emits its sides' columns POSITIONALLY** (left alone for semi/anti); sides must be DISTINCT
  relations; a side's outputs are addressed through the JOIN. **`Union` is n-ary.** **`Aggregate` emits
  group keys then aggregates.** **`Recursive.step` is a function**; `seed`/`step` channels identical.
- **`Agg` only inside `Aggregate.aggs`, `WindowExpr` only inside `Window.specs`** (checked). `Agg.orderBy`
  is what `fold()` needs; `Agg.filter` is SQL's `FILTER (WHERE …)`. `Scalar`/`Exists` may be correlated.
  `InList` is bounded by QUERY TEXT; a data-sized set is one JSON bind. `Delete` has no `using` — membership
  is an `InQuery`.

### §3.4 What is deliberately NOT a node

`With`/CTE (a binding is the only naming mechanism; within a binding the relation is a DAG); `Param` (a
parameter is `lit`'s `source: 'parameter'`, reduced to a value at the last responsible moment);
`Correlate`/lateral (correlation is an `Expr` referencing an outer `RelId` — P1 forbids the node);
shape/cardinality/productivity/bulk (all Gremlin-level, §2).

### §3.5 Channel obligations, per node — the LAW that keeps the largest defect class dead

**33% of this repo's diagnosed defects were a carried field dropped at a barrier, merge, or rejoin.** So
every node declares what it does to each channel and a total checker verifies it — `Record<RelKind,…>` in
`src/rel/obligations.ts`, so a new kind fails the build until declared. Roles: `Project` declares (subset of
outputs); `Union` merges per policy; `Filter`/`Sort`/`Limit`/`Distinct`/`Window`/`Explode` PRESERVE (pass
the input's channels through — never name a list); `Join{left}` widens the right side to nullable.

**The barrier obligation is TWO contracts.** A **barrier** emits a new traverser → no channel survives. A
**grouping by traverser identity** (dedup keeping first, movement coalescing convergent walks) emits one row
per surviving traverser → its channels must survive or a later reducer counts the collapse away. The node
declares which by WHICH CHANNELS IT CARRIES; `CHANNEL_GROUP_POLICY` says which roles have a defined N→1
answer (`bulk` adds, `encounter` earliest; alias/path/origin/sack belong to one member and refuse).

### §3.6 Two budgets the plan owns, not the emitter

- **Binds.** Query/store data render as binds (a user PARAMETER earns a `?`; a compiler-held constant is a
  typed literal). A plan carries `bindCount()` and **fails closed above the DO cap of 100**, checked against
  the RENDERED bind list (a fused block can spell one value twice). An over-budget row set lands as ONE JSON
  bind. This makes the cap a plan property `check` proves.
- **Statement text.** DO caps at 100 KB. `unroll` consults rendered size and declines above a ceiling,
  falling back to `Recursive` (which then refuses a barrier body per P3).

---

## §4. The passes — all `Rel → Rel`, total, order-declared

Structure is declared ONCE in `src/rel/walk.ts` (no `default` arm anywhere), so `noImplicitReturns` makes a
new kind a compile error. Rewriting is memoised, so the DAG stays a DAG.

- **`check`** — the fail-closed verifier (column resolution, `Agg`/`WindowExpr` placement, the §3.5
  obligations, both §3.6 budgets). Always on in dev/tests.
- **`name` (§4.6)** — named CTE vs inlined derived table for every shared node, honouring `Materialize`. The
  ONLY pass with a production caller (`lower.ts`).
- **`prune` (§4.5)** — column pruning (a node's need is the union over consumers); makes `unroll`'s replicas
  affordable. Phase 3 prerequisite.
- **`land` (§4.5b)** — the bind-budget lowering (an over-budget `Values` → one JSON bind).
- **`fuse` (§4.4)** — small semantic rewrites (adjacent `Filter`s conjoin, etc.). Ask which still buys
  anything the assembler doesn't before wiring it.
- **`flatten` (§4.2)** *(Phase 3)* — join flattening / subquery decorrelation into the P1 envelope. Deletes
  `expandRepeatBody`.
- **`unroll` (§4.3)** *(Phase 3)* — replicate a subplan n times for `times(n)`.
- **`recognize` (§4.7)** *(Phase 4.4)* — the fast paths as plan rewrites, so a fast-path decline can be
  lifted.

**Declared is not wired.** Only `name` has a production caller today; `fuse`/`prune`/`land`/`flatten`/
`unroll`/`recognize` are built-and-tested (or planned) but reachable from no route. There is no object that
orders them — the order above lives in this list.

---

## §5. The emitter — a SELECT block assembler

The IR is normalized (one operator per node); a SQL `SELECT` composes operators into fixed slots. The
emitter accumulates a block (`{select, from, joins, where, group, having, order, limit, distinct}`), opening
a nested SELECT only when a needed slot is occupied. Prior art: Calcite's `RelToSqlConverter` /
`needNewSubQuery` (`vendor/calcite/.../rel2sql/SqlImplementor.java`). **Total** — every kind has an arm, no
fallback; an unrenderable node is a compile error. Built on the `q` kernel ADDITIVELY only. This is what
deletes `TailAcc`. *Refused:* a `Select` mega-node from `fuse` (it puts the SQL surface back inside the IR).

Emission facts: a compound arm is a select-CORE, so an arm filling a tail slot needs its own derived table;
splicing a join side lifts its aliases, so two sides reading the same shared relation collide and the
colliding side stays in its own SELECT.

### §5a. The equivalence gate — results and access path, NEVER spelling

Byte-identical SQL is not a gate (unreachable, and it invites snapshotting the emitter against itself). The
two properties held over real `test/L2-sql/` traversals: **same results** and **same `EXPLAIN QUERY PLAN`**
(reduced to index decisions, object names and CTE-materialization lines dropped). Together they fail on a
plan that reads the same and executes differently, without pinning spelling.

---

## §6. The migration discipline

### §6·1 (was §10·4) — ONE SPINE. The dual spine is a harness with an end date.

Gremlin reaches RelIR through a SECOND lowering that grows step by step. A traversal whose every step is
covered routes RelIR end-to-end; anything else routes to legacy — **never mixed inside one traversal**, so no
opaque node ever exists and RelIR stays a real algebra. `RelIR on` vs `off` is a **differential switch**
(`mise run test:legacy-spine`), making the whole corpus + L5's generated traversals the oracle. It must pass
in BOTH positions.

- **No opaque escape node, ever** — not as a bridge, not behind a flag. A shape that genuinely cannot be
  expressed is a §3 node-set discussion under §7's bar, recorded here.
- **No permanent exceptions.** A traversal routes to legacy for exactly one reason: a step's lowering is
  not yet written. Not "hard", not "rare", not "fast enough". No allowlist.
- **Both counters ratchet** (coverage rises, the deletion list shrinks); a stalled countdown in a phase is
  the finding of the phase.
- **THE END DATE is deleting the legacy spine — a STEP OF THE PLAN.** Coverage at 100% with a non-empty
  deletion list is a FAILED migration. "We would lose the differential" is not a reason to keep legacy: at
  100% the compared-against thing is dead code, and what remains is L5's metamorphic oracle + the census +
  L1–L4.

### §6·2 (was §10·5) — a data-sized row set is a VALUE, not a control-flow loop

**A row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE — a single JSON bind
exploded by `json_each` — never N parameters, read or write.** Three reasons, none movable by a runtime
release: (1) a read cannot chunk — it needs the set as a RELATION inside one query; (2) a JSON bind is a
value the plan carries, and a chunked write cannot be the `Ref` a later step joins against — that
`Stmt`-binding-as-relation IS the pre-mutation snapshot; (3) the DO cap becomes O(plan size) by
construction, provable by `check`. Typing goes the same way: JSON is MORE deterministic than native binds
(an integer binds INTEGER on Bun, REAL on DO; `boolean`/`bigint` throw on DO), so `transportable()`
(`src/program.ts`) fails closed on what it cannot carry. Cost: a BLOB cannot travel, so a `RETURNING`
feeding a retained binding projects `json(x)`, never `jsonb`.

### §6·3 (was §10·9/§10·10) — a SHAPE is a VALUE plus a framing arm; the boundary is `Shape`

RelIR never hands a STEP to legacy. Growing a shape has three parts and no fourth: (1) RelIR builds the VALUE
with its own nodes; (2) a `RelFraming` arm says what the relation holds; (3) `execute.ts` frames the rows
from a `Shape`. The three layers: **row algebra** (RelIR), **payload projection** (element id → labels+bag,
list/map/record blob — RelIR's, in `src/compiler/rel/`), **byte framing** (`(rows, Shape) → Buffer[]` —
`execute.ts`, permanent). Calcite's decomposition is the model: a map is a TYPE plus an aggregate FUNCTION,
never a kind of stream (`Aggregate` yields a relation; `COLLECT`/`JSON_OBJECTAGG` build the value).

### §6·4 (was §10·7/§10·8) — the unit of work is the FAMILY; order by DELETION

Read the blocker table to find WHERE the fold gives up, then land the whole FAMILY that step belongs to —
never the step alone (a ragged edge re-derives the parse/projection/type-context the next increment needs).
Choose the increment by *which deletion-ratchet name it lets you delete*, with marginal coverage as the
tiebreak. Sweep for DUPLICATION every round: **share DATA and pure computation across spines; re-express only
the EMISSION** (a re-derived `JAVA_WHITESPACE` missing a code point is wrong in a way no test names).

### The instruments — run all of them, not the cheapest

Most are inside `ci` (`check`, `lint`, `arch`, `binds`, `deletion`, `rel-sweep`, `test` over L1–L5 + the
census, `build`). The per-increment loop is: `ci` → `test:legacy-spine` (the differential, every
coverage-moving change) → `test:cf-limits` (every new SQL) → commit → `mise run L5` at the commit (its seed
is HEAD-derived, so a pre-commit run does not prove the commit) → push. `test:perturbed` only when the change
touches ORDER. What each is blind to:

| instrument | blind to |
|---|---|
| census (`ms` digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value; a lost fast path (same rows) |
| row-for-row vs legacy | a MISSING throw; a wrong ORDER both spines share |
| L2 shape assertions | a wrong VALUE with the right shape |
| L3 conformance | anything the corpus doesn't exercise — but the ONLY thing that sees a required error message |
| `rel-sweep` | correctness — it asserts the lowering doesn't THROW and an admitted plan renders within the cap; it calls `lowerToRel`, so a decline at `spine.ts` is invisible to it (the census's `spine` column catches that) |
| `test:perturbed` | values — the only thing that sees an order right only by SQLite's scan luck |

---

## §7. Scope control — the node set is CLOSED

RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no
statistics, no join reordering — SQLite is the optimizer.** Adding a node kind requires showing the seam
cannot EXPRESS a shape, not that it has not been HANDED one. Before declaring a substrate missing, check
whether an existing one is merely not REACHED (`src/compiler/steps/CLAUDE.md`'s "cannot express" vs "cannot
be handed"). If Phase 2 ever grows an `ElementReadDriver` analogue, it has failed.

---

## §8. What this deletes — the EXIT CRITERION

`mise run deletion` gates the floors in `scripts/deletion-ratchet.tsv` (that file IS the list; editing prose
here changes nothing). The migration is over when every floor is 0. Non-zero today:

- **Phase 2.6 (write dispatcher):** `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`,
  `resolveEndpoint`, `materializeElementDrivers`, `WritePlan`.
- **Phase 3 (repeat):** `expandRepeatBody`, `REPEAT_BODY_OK`.
- **Phase 4.2 (block assembler):** `TailAcc`.
- **Phase 4.1 (row-algebraic):** `globalRowOps` — legacy-side only now (every step name routes through RelIR
  when the rest of the chain does).
- **Phase 4.4 (fast paths as rewrites):** `runFastPath`, `appliesWhen`, the five-copy `count` adapter, the
  four-copy `where` adapter.

---

## §9. Landed — the substrate to build on

Read coverage from the census; this is the qualitative map of what RelIR already lowers.

- **Reads:** element and scalar sources; source-scope filters; the `P`/`TextP` predicate vocabulary;
  movement (with bulk collapse); correlated `where`/`filter`/`not`; the `by()` modulator vocabulary;
  `dedup`/`identity`; the row-algebraic class (`limit`/`skip`/`range`/`tail`/`order`/`sample` as
  `Sort`/`Limit`/`Distinct`/`Window`); the scalar transform + reducer families; `has()`'s three argument
  shapes; the leading coercion prefix (`asNumber`/… folded at compile time, reusing legacy's parse).
- **Shapes:** the LIST shape (collection literal + `fold()`, member frame, set-ops, `unfold()`); the MAP
  shape (`group`/`groupCount`, value `by()`); the ALIAS channel (`as()`/`select(label)`); the PATH channel
  (one JSONB array, entry encoding shared with alias, `by()` per position); element payload; scalar/value
  payload. All payload projection is inside the algebra (`element.ts`/`list.ts`/`map.ts`/`path.ts`).
- **The `by(__.traversal)` CHILD SEAM:** an injected lowerer; the expression arm (flat value+transform), the
  reducer arm (`__.out().count()`), with the reference's productivity/seed rules cited.
- **Writes (Phase 2.1–2.5):** `drop()` → `Delete`; `property()` on an existing element (incl. collection
  values, FTS rows); `addV`/`addE` → `Insert … SELECT … RETURNING` (alias-through-a-creation, label
  cardinality from request-scope DI); `mergeV` (the branch is not control flow — two total statements each a
  no-op on its own arm). A write's statement count is O(plan size), not O(rows) — measured.
- **Reducers:** `min`/`max` compare in TYPE SPACE (argmin returning the original extremal row + its Gremlin
  vtype, via `storedCompareOn` — the same authority `order().by()` uses; the framer reads a Gremlin vtype);
  `sum`/`mean` over a `long`/`bigint` carried as decimal TEXT included exactly.
- **The framing contract:** the reducer/`result:'number'` framer reads a GREMLIN vtype when `vt` is one
  (disjoint from storage class), else a storage class — this is what lets a text-carried long frame as a
  `long`.
- **The L3 ratchet has TWO floors** (default + `legacySpine`), each gating and recording only its own
  section; the census records BOTH pinned spine positions. "RelIR is ahead" is a first-class state
  (`relirAhead`), the scenario-name set difference the migration metric.

---

## §10. What is LEFT to do

Ordered by the discipline (§6·4): each closes a family and lets a deletion-ratchet name fall.

1. **Phase 2.6 — delete the legacy write dispatcher.** The prerequisite (alias-through-a-creation) is met,
   but the gate is write coverage being COMPLETE. Remaining write declines (measure with `rel-blockers`):
   `property`'s residue, `addE`/`mergeV`/`mergeE`/`addV` tails, `mergeE` (needs a position-correlated
   `RETURNING`). **`property`'s residue is a substrate question, not an increment** — see Open Decisions.
2. **Phase 3 — the repeat wedge.** `flatten` (P1 legality in `check`; a body that cannot be made legal throws
   a clear deferral) → route `repeat()`'s body through ordinary lowering → `unroll` for `times(n)` (take
   `dedup` first, one barrier per commit with an L4 pin; `prune`'s remainder — pruning below
   Join/Union/Aggregate — is a precondition). The 5 `until()`/`emit()` barrier bodies throw the P3 wall.
3. **Phase 4.2–4.4 — finish the read migration + fast paths.** Block assembler replaces `TailAcc`;
   `ELEMENT_DISPATCH` joins the shared substrate; aggregate/count handlers become one `Aggregate`;
   `recognize` makes the fast paths plan rewrites (which lifts the FTS decline).
4. **The remaining families** (blocker ranking, re-measure — it moves): side effects (`aggregate`/`group`/
   `groupCount` with a string label — needs a named-collection substrate), the property shape
   (`properties`/`valueMap`), the map shape's mid-chain consumers, scalar-transform/branch/`sack`/`repeat`/
   `local`/`match`/`where`/`path` tails, and the by()-child matrix (`group`←reducer, `project` as a step,
   `select` multi-label, moving/collecting child bodies).
5. **Correctness follow-ups** (each cited, corpus-mostly-invisible, none a one-liner):
   - **The numeric-tower PROMOTION** (`inject(127b,1b).sum()` → `d[128].s`, 6 `Sum.feature` scenarios).
     Blocked on exact-type literal framing — see Open Decisions.
   - **The `set` framing marker** survives `range(local)`/`all`/`any`/`none` and is dropped only by
     `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop, both spines.
   - **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong Pop.mixed wire
     type today) — needs head-position tracking on the RelIR `AliasEntry`.
   - **Checker hardening (Phase 3 prereqs):** refuse `Distinct`/`Limit`/`Sort` inside a recursive term (P3);
     a whole-row `Distinct` may not carry a per-row-unique channel; an `aggs` entry may not reference an
     input column outside an `Agg`; `name` should walk expression subplans (a shared node in a
     `Scalar`/`Exists` body is inlined twice).
6. **The last step:** delete the legacy spine and the routing switch (§6·1).

---

## §11. Open design decisions — HUMAN input needed

1. **Exact-type literal framing (both spines).** Should a typed numeric literal frame with its exact Gremlin
   type — `127b` → Byte, not the magnitude-inferred Int we emit today? Yes unblocks the numeric-tower
   promotion (item 5), but it is a both-spine framing-vocabulary change with a census reap AND it regresses
   inject-after-typed-inject (`inject(1,3).inject(100,300)` starts declining). It is a dedicated increment,
   not a side effect.
2. **Phase 2.6's `property` residue.** A NESTED value, three `withSideEffect` constants, and a `T`-token key
   each need per-traverser evaluation of a sub-traversal — the row-at-a-time surface this migration exists to
   delete. Decide per case: a pre-lowering VERIFY refusal, a genuine per-traverser substrate, or a permanent
   documented exception. This is the question Phase 2.6 actually turns on (`refusal_belongs_to_legacy` in the
   migration spec).
3. **The numeric-tower PROMOTION rule**, when built: `getHighestCommonNumberInfo` keeps the narrowest common
   class and promotes on overflow; **integer overflow at ≥64 bits RAISES** (not a silent wrap, not auto-
   BigInteger) — so the reducer must raise there rather than widen into the int64-as-TEXT representation
   (`vendor/.../util/NumberHelper.java`).

---

## §12. Traps — each cost a real defect, none found by reading

**The decline contract.** `null` is the ONLY decline and must stay cheap and total — a partial lowering that
silently drops a filter is invisible to the differential (both spines are asked; only one asks right). A
module whose contract is `null` must not let a throw escape. **A fast path is never silently dropped**
(`has(k,containing(t))` routes the trigram index; it DECLINES until §4.7 — coverage measures whether the new
spine CAN express, never whether it is entitled to take a specialized lowering). **Fix a defect in BOTH
spines or decline in RelIR — never let them disagree on purpose** (that leaves `test:legacy-spine`
permanently red). **A decline is only right when the OTHER spine is right** (§13n's lesson): measure the
other spine first; four "answer where TinkerPop raises" findings were kept because legacy answered
identically wrongly and declining bought zero correctness.

**Wrong answers with the right arity** (the class no ladder level sees):

- A non-derivable fact must not be re-implemented (typed inject tags, the `JAVA_WHITESPACE` set — call the
  one authority). A second implementation is a second chance to get it wrong.
- A type ASSERT is not a predicate (`is(typeOf(LIST))` RETYPES; as a filter it returns right rows framed
  wrong). A parse that must RAISE cannot be a `CAST` (`asNumber('1,000')` must raise, not answer 1).
- A dedup must not distinguish rows by MULTIPLICITY; a survivor stands for itself (multiplicity resets).
- `count()` is not SQL — an `Agg` with no args means "over all rows"; `count(*)` is the emitter's spelling.
  A `Lit` cannot express a REAL literal whose value is integral (JS `1.0` IS `1` → integer division) — use
  an explicit `Cast`. `values(k…)` reads EVERY key, not `args[0]`.
- Comparison across type spaces (a range predicate, `min`/`max`) must gate on type-space agreement (Gremlin
  compares within one space); reducer eligibility/order goes through `storedCompareOn`, not SQLite storage
  class.

**Order and determinism.** Deterministic, not merely ordered — `ROW_NUMBER() OVER (ORDER BY encounter, id)`
needs the tie-break, and the tie-break is the caller's argument. Mint the emission order ONCE over a whole
fan-out, never per arm. A sort SUPERSEDES the arriving order, so re-MINT where a position is carried. A
correlated hop threads no order. Collapse and emission order are MUTUALLY EXCLUSIVE. A non-deterministic
ordering expression (`RANDOM()` for `sample`) must never sit in a slot the assembler can inline — rank in a
window and filter. Slice tests compare against legacy row-for-row UNSORTED and must pass under
`test:perturbed`.

**Structure and plumbing.** A chain-level requirement (path/encounter demand) must be computed over the
WHOLE chain, at the point the chain is identified — deriving it inside a routine that sees only a fragment is
the same class as naming a channel list. Pass the input's channels THROUGH; never name a list. A clause
reader (`WHERE`/`ORDER BY`) that reads a select alias needs a `Materialize` fence (only the FIRST reader; a
later one already sits over a fence). A window may not read a windowed column — the ASSEMBLER closes the
block (`case 'window'`/`case 'sort'`). A bind-budget overrun is a DECLINE at the routing seam, not a throw —
and the gate must RENDER (IR occurrence counts differ from the rendered bind list up to 2×). Relation ids
are minted PER LOWERING (a module-global counter makes two compiles emit different SQL); a replicated subplan
(`unroll`) must carry FRESH ids. WITHIN one compile the minter is shared/injected, or the emitter's scope
sees one id naming two relations. A `Project` over a whole-relation `Aggregate` (empty `groupBy`) that reads
none of its outputs ERASES the aggregation — the emitter blocks it (Calcite's `fieldsUsed.isEmpty()`).

**A non-derivable "reference says X" question goes to the vendored source, cited at the pin.** The `.feature`
corpus says WHAT; `gremlin-core` says WHY and covers cases no scenario names (a reducing barrier's zero-row
emission is per-step, decided by whether it supplies a seed — `group`/`fold` emit `{}`/`[]`, `sum`/`min`/
`max` emit nothing). When two comments in this repo cite one feature file for opposite behaviours, the
resolution is IN the file. Agreement between the two spines is not evidence of correctness — it is evidence
of a shared cause.
