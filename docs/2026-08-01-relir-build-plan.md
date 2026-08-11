# RelIR — the build plan

**Status: BUILDING.** `Step[] → RelIR → SQL`: an inspectable, rewritable relational algebra between the
Gremlin front-end and the `q` SQL kernel, replacing the legacy compile-straight-to-SQL spine — whose
`Query.ctes` is a private append-only array, so the query never exists as data and every optimization had to
happen *before* lowering or be hand-built around.

**The migration finishes when the IMPORT GRAPH is severed and `repeat()` works — NOT at 100% coverage**
(§8). Coverage ranks an increment; it is never the finish line.

**Numbers live in instruments, never in this prose** — coverage is `test/census/goldens.tsv` (`spine`
column), the name countdown is `scripts/deletion-ratchet.tsv`, the edge countdown is
`scripts/steps-edges.tsv`, the blocker ranking is `mise run rel-blockers` (re-run it every round; it moves).

**This document is WHAT IS LEFT plus the traps that each cost a real defect.** What landed, and at which SHA,
is `git log`'s job. A machine-checkable statement of the same rules: `docs/spec/relir-algebra.allium`,
`docs/spec/relir-migration.allium`.

**Legend:** ✅ landed · 🚧 left · ⚠️ trap, do not re-derive · 🔴 needs a human call.

**§-numbers cited from code, kept stable:** §10·4 → §6·1 · §10·5 → §6·2 · §10·9/§10·10 → §6·3 ·
§10·7/§10·8 → §6·4. Old work-unit names: 2.6 → Phase 1, 3 → Phase 3, 4.x → Phase 4.

---

## §1. The measured platform envelope — LAW, do not re-derive

SQLite 3.51.2, re-confirmed on DO SQLite (workerd) via `test/cf-probe/`, `test/cf-constructs.test.ts`. Facts
about the platform, not preferences.

- **P1 — the recursive-term law.** The recursive reference appears **exactly once, at the top level of the
  term's `FROM`** — POSITIONAL. A derived table around it is `circular reference` even as the sole reference.
  No aggregates, no window functions in the term. A correlated scalar MAY reference the walk's alias, and a
  `Materialize` fence may never sit between the term and its own self-reference. **"Top level" means the
  join TREE**, so `project(join(self, edges))` is legal; `src/rel/block.ts` is the one authority (it is also
  the emitter's fusion table, so the checker cannot admit a plan the emitter then wraps).
- **P2 — legal but unexploited.** `NOT EXISTS`, joins against a derived `UNION`, `IN (SELECT …)`, correlated
  scalars and multi-hop join chains are all legal in a recursive term. So `expandRepeatBody` is a
  hand-written join-flattener, not a platform workaround; it dies with `flatten`.
- **P3 — no per-iteration barrier is expressible in a recursive term, in ANY lowering.** `DISTINCT` is inert,
  `LIMIT`/`ORDER BY` cap the whole CTE, `UNION` dedups the whole walk (breaking the multiset rule). Nor can a
  term COLLAPSE, for the same reason: `GROUP BY id, SUM(bulk)` is an aggregate. Do not re-propose
  re-lowering. This is what forces `repeat()`'s two regimes (Phase 3).
- **P5 — the write envelope.** Legal: CTE→`INSERT … SELECT … RETURNING`; multi-row `INSERT … RETURNING`;
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM (subquery)`; `DELETE … WHERE … IN (SELECT)`.
  Illegal: the Postgres-style data-modifying CTE. So a write chain is a SEQUENCE of statements, O(write
  steps) and never O(rows).
- **P5b — `RETURNING` determinism.** Row order is undefined, but id assignment follows the source `SELECT`'s
  `ORDER BY`. Order the source and re-associate by a carried key, never by RETURNING position.

*(P4 was a corpus ratio for `repeat()`. It is SUPERSEDED — it counted what each route would cover if
reached. Phase 3 carries the measured routing instead.)*

---

## §2. The clean-room boundary — LAW

`src/rel/` imports NOTHING from `src/compiler/` or `src/gremlin/` — pure data plus total functions, testable
with no graph, store or Gremlin. `mise run arch` gates it.

**It is a VOCABULARY boundary.** RelIR needs exactly two things about carried state: which output columns are
channels and in what order, and per channel its merge and barrier policy. The neutral **channel core** is
`src/channels.ts`. **A RelIR node cannot know what a sack is, and shape never enters the node set** — if a
`src/rel/` node acquires a `kind: 'scalar' | 'element' | …` field, the layer has failed. `ChannelRole` is
per-column carried-state bookkeeping, never the stream's Gremlin type.

Gremlin-shape-aware payload construction lives in `src/compiler/rel/` (`list.ts`, `map.ts`, `element.ts`,
`path.ts`, `record.ts`, …), outside `src/rel/`, so it may know shape. Only `execute.ts`'s byte framers
(`(rows, Shape) → Buffer[]`, no SQL) are permanently legacy's.

---

## §3. The object model — complete and CLOSED

Two algebras — **expressions** (a value per row) and **relations** (rows) — plus **statements** for writes.
Immutable plain objects with a `kind` discriminant, every list `readonly`. Kinds and fields are in
`src/rel/{expr,rel,stmt}.ts` — **the code is the authority**; what follows is only what the declaration
cannot state.

**Construction is branded.** A `Rel` is minted only by its named kind factory (validates local shape,
freezes); a rewriter rebuilds through a factory and never spreads a node. `SelfRef` has no public factory —
only `recursive` supplies it. **The set is CLOSED**: a missing construct is a derived form, and adding a kind
requires proving the seam cannot EXPRESS the shape (§7).

### §3.0 The top of a plan is a PROGRAM, not a tree

```ts
type Plan    = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt; readonly snapshot?: boolean }
```

A `Ref { name }` resolves a relation computed earlier — one concept, not two machines: a multiply-referenced
`Rel` binding is a **CTE** (`name`'s decision, §4.6); a `Stmt` binding is a **statement boundary** (the
executor runs it, retains its `RETURNING` rows, and a `Ref` resolves to them as ONE JSON bind exploded by
`json_each`); a `Rel` binding marked **`snapshot`** is a **read boundary** with the same retention — "the
value AT THIS POINT", because a CTE is recomputed by every statement naming it. `retained(binding)` is
`isStmt(node) || snapshot`; `checkPlan` proves the discipline. **A write in a read position is a hoist to a
binding** — `union(__.addV(), __.V())` is plan composition, there is no driver anywhere, and effects are
legal only at a binding as a type-level fact.

### §3.1 Types

`RelType = { cols: ColMeta[] }`, `ColMeta = { name, type: SqlType, nullable }`, `SqlType = 'int' | 'real' |
'text' | 'blob' | 'json' | 'any'` — SQLite storage classes plus `json`. **Never a Gremlin vocabulary**;
Gremlin typing stays in `ScalarType`/`CanonicalType`.

### §3.2 / §3.3 The node set

15 expression kinds, 19 relational/statement kinds — deliberately smaller than SQL, whose redundancy
collapses (`HAVING` is `Filter` over `Aggregate`; distinct `UNION` is `Distinct` over `Union{all}`). The
constraints you would otherwise violate:

- **`Scan` is the only physical-schema node** — the storage seam. **`Project` is the only node that may
  DECLARE channel columns.** **`Values` refuses the EMPTY relation** (invalid SQL) — the empty case is a
  `Filter(false)`.
- **`Distinct` is whole-row only** (a keyed dedup is `Window(row_number PARTITION BY key)` + `Filter(rn=1)`);
  **`Window` may only EXTEND its input**; **`Join` emits its sides' columns POSITIONALLY** and its sides must
  be DISTINCT relations; **`Union` is n-ary**; **`Aggregate` emits group keys then aggregates**;
  **`Recursive.step` is a function** with seed/step channels identical.
- **`Agg` only inside `Aggregate.aggs`, `WindowExpr` only inside `Window.specs`** (checked). `Scalar`/`Exists`
  may be correlated. `InList` is bounded by QUERY TEXT — a data-sized set is one JSON bind (§6·2). `Delete`
  has no `using`; membership is an `InQuery`.
- **`WindowSpec.partitionBy: Expr[]`** unifies global / per-origin / per-origin-dedup (`[]`, `origins`,
  `[...origins, value]`).

### §3.4 What is deliberately NOT a node

`With`/CTE (a binding is the only naming mechanism) · `Param` (a parameter is `lit`'s `source: 'parameter'`)
· `Correlate`/lateral (correlation is an `Expr` referencing an outer `RelId`; P1 forbids the node) ·
shape/cardinality/productivity/bulk (all Gremlin-level, §2).

### §3.5 Channel obligations, per node — the LAW that keeps the largest defect class dead

⚠️ **33% of this repo's diagnosed defects were a carried field dropped at a barrier, merge or rejoin.** Every
node declares what it does to each channel and a total checker verifies it (`Record<RelKind,…>` in
`src/rel/obligations.ts`, so a new kind fails the build until declared). `Project` declares (a subset of its
outputs); `Union` merges per policy; `Filter`/`Sort`/`Limit`/`Distinct`/`Window`/`Explode` PRESERVE — pass
the input's channels through and **never name a list**; `Join{left}` widens the right side to nullable.

**The barrier obligation is TWO contracts.** A **barrier** emits a new traverser, so no channel survives. A
**grouping by traverser identity** (a dedup keeping first, a movement coalescing convergent walks) emits one
row per surviving traverser, so its channels must survive or a later reducer counts the collapse away. The
node declares which by WHICH CHANNELS IT CARRIES, and `CHANNEL_GROUP_POLICY` says which roles have a defined
N→1 answer (`bulk` adds, `encounter` takes earliest; alias/path/origin/sack/loops belong to one member and
refuse).

### §3.6 Two budgets the plan owns, not the emitter

- **Binds.** A user PARAMETER earns a `?`; a compiler-held constant is a typed literal. A plan carries
  `bindCount()` and **fails closed above the DO cap of 100**, checked against the RENDERED bind list — a
  fused block can spell one value twice, and IR occurrence counts differ from the rendered list up to 2×. An
  over-budget row set lands as ONE JSON bind.
- **Statement text.** DO caps at 100 KB, enforced by `cfLimitViolation` at the end of the spine. The producer
  that can exceed it is the `times(n)` unroll, which runs ABOVE the IR, so the ceiling belongs to that pass.

---

## §4. The passes — all `Rel → Rel`, total, order-declared

Structure is declared ONCE in `src/rel/walk.ts` (no `default` arm anywhere), so `noImplicitReturns` makes a
new kind a compile error. Rewriting is memoised, so the DAG stays a DAG.

⚠️ **Call this tier `rewrite`, not `Pass`** (§6·5). `Pass` names the `Step[]→Step[]` pipeline in
`ir/passes.ts`, which runs ABOVE the routing switch; these run below it. Load-bearing: a refusal raised here
would be a throw out of a lowering whose contract is `null`, and legacy would never see the traversal.

| pass | state |
|---|---|
| **`check`** | ✅ the fail-closed verifier — column resolution, `Agg`/`WindowExpr` placement, §3.5 obligations, both §3.6 budgets, and the recursive-term laws via `src/rel/block.ts`. Always on in dev/tests |
| **`name` (§4.6)** | ✅ named CTE vs inlined derived table per shared node, honouring `Materialize`. **The only pass with a production caller** (`lower.ts`) |
| **`prune` (§4.5)** | ✅ column pruning — a walk carries only what its body and its consumer read |
| **`fuse` (§4.4)** | 🚧 small semantic rewrites. Ask what still buys anything the assembler doesn't before wiring it |
| **`flatten` (§4.2)** | 🚧 *(Phase 3)* join flattening / decorrelation into the P1 envelope; deletes `expandRepeatBody`. Most of it dissolved into `block.ts`'s legality analysis |
| **`recognize` (§4.7)** | 🚧 *(Phase 4)* the fast paths as plan rewrites, so a fast-path decline can be lifted |
| **`land` (§4.5b)** | ⛔ WITHDRAWN — there was no over-budget case to lower, and converting a text-sized set would MANUFACTURE a bind for a constant. ⚠️ **Legacy's `SET_BIND_LIMIT` STAYS until the spine dies**: on the RelIR path a bound-param collection reaches `jsonEachSet` unconditionally, but on the legacy path that threshold IS the mechanism — deleting it took `within(<300-element param>)` from 1 bind to 301 |
| **`unroll` (§4.3)** | ⛔ WITHDRAWN (restore point `9e0e307`) — the IR-level unroll produces a FLAT chain, so the whole lowering handles it uniformly and every future step family is inherited free |

**Declared is not wired.** Only `name` has a production caller; there is no object that orders them — the
order above is the order.

---

## §5. The emitter — a SELECT block assembler

The IR is normalized (one operator per node) and a SQL `SELECT` composes operators into fixed slots. The
emitter accumulates a block (`{select, from, joins, where, group, having, order, limit, distinct}`), opening a
nested SELECT only when a needed slot is occupied. Prior art: Calcite's `RelToSqlConverter` /
`needNewSubQuery`. **Total** — every kind has an arm, no fallback; built on the `q` kernel ADDITIVELY. This is
what deletes `TailAcc`. *Refused:* a `Select` mega-node from `fuse`.

⚠️ A compound arm is a select-CORE, so an arm filling a tail slot needs its own derived table; splicing a join
side lifts its aliases, so two sides reading the same shared relation collide and the colliding side stays in
its own SELECT.

### §5a. The equivalence gate — results and access path, NEVER spelling

Byte-identical SQL is not a gate (unreachable, and it invites snapshotting the emitter against itself). Two
properties over real `test/L2-sql/` traversals: **same results** and **same `EXPLAIN QUERY PLAN`** (reduced to
index decisions). Together they fail a plan that reads the same and executes differently, without pinning
spelling.

---

## §6. The migration discipline

### §6·1 — ONE SPINE. The dual spine is a harness with an end date.

A traversal whose every step is covered routes RelIR end-to-end; anything else routes to legacy — **never
mixed inside one traversal**, so no opaque node exists and RelIR stays a real algebra.

**THE FLOOR IS THE UNION OF THE TWO SPINES, NEVER EITHER ONE — legacy may lose what RelIR holds.** Gaining
five and losing five is progress; "legacy would have to support it too" is not a cost of a RelIR increment.
Three gates say so mechanically: the L3 floors gate ASYMMETRICALLY (the `legacySpine` floor may shed only names
the RelIR floor holds, and the union may not shrink); the census's legacy gate accepts a shed shape RelIR
answers; and an assertion about a RelIR-only capability SAYS SO (`{spine:'rel'}` for a plan claim,
`relirAhead` for an ANSWER claim).

⚠️ **Where both spines ANSWER, they must agree** (census gate 3, row-for-row) — a disagreement there is never a
shed capability, it is the wrong-answer-with-right-arity class, usually shared substrate (§6·4) breaking. Read
a legacy failure by DIRECTION: legacy declines where RelIR answers = the migration; legacy answers DIFFERENTLY
= a bug in shared code.

⚠️ **The two default positions measure the DIFFERENTIAL, never the CUT, and there is no proxy** — both may fall
back, so the `legacySpine` floor proves only *routed ≥ all-legacy*. `MOGWAI_RELIR=only` (`mise run
L3:rel-only`) is the one that can: a decline FAILS instead of falling back. Not in `ci` — gating pins a number
meant to fall to zero, and recording would overwrite the routed floor and silently lower the ratchet.

- **No opaque escape node, ever** — not as a bridge, not behind a flag.
- **No permanent exceptions.** A traversal routes to legacy for exactly one reason: its lowering is not yet
  written. Not "hard", not "rare", not "fast enough". No allowlist.
- **The differential is cut PER PHASE, with the code it compares.** "We would lose the differential" is not a
  reason to keep a route whose code is already deleted.

### §6·2 — a data-sized row set is a VALUE, not a control-flow loop

**A row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE — a single JSON bind
exploded by `json_each` — never N parameters, read or write.** Three reasons, none movable by a runtime
release: a read cannot chunk (it needs the set as a RELATION inside one query); a chunked write cannot be the
`Ref` a later step joins against, and that `Stmt`-binding-as-relation IS the pre-mutation snapshot; and the DO
cap becomes O(plan size) by construction, provable by `check`. JSON is also MORE deterministic than native
binds (an integer binds INTEGER on Bun, REAL on DO; `boolean`/`bigint` throw on DO), so `transportable()`
(`src/program.ts`) fails closed. ⚠️ Cost: a BLOB cannot travel, so a `RETURNING` feeding a retained binding
projects `json(x)`, never `jsonb`.

### §6·3 — a SHAPE is a VALUE plus a framing arm; the boundary is `Shape`

RelIR never hands a STEP to legacy. Growing a shape has three parts and no fourth: RelIR builds the VALUE with
its own nodes; a `RelFraming` arm says what the relation holds; `execute.ts` frames the rows from a `Shape`.
Three layers — **row algebra** (RelIR), **payload projection** (`src/compiler/rel/`), **byte framing**
(`execute.ts`, permanent). Calcite's decomposition is the model: a map is a TYPE plus an aggregate FUNCTION,
never a kind of stream.

### §6·4 — split every file at the KERNEL/EMISSION line; the unit of work is the FAMILY

**Share DATA and pure computation across spines; re-express only the EMISSION** — a re-derived
`JAVA_WHITESPACE` missing a code point is wrong in a way no test names. **EXTRACT THE KERNEL BEFORE DELETING
THE FILE**: a kernel trapped inside `steps/` turns a deletion into a re-derivation.

⚠️ **The split is one line further in than "call the same kernel with a different resolver".** Measured on
`math`: every arm of `mathToSql` CONSTRUCTS a q-kernel `Expression`, so the file is a kernel with an emission
tail FUSED to it. The answer is an **ops record** (`compileMath<T>(formula, ops)`), not a shared AST — three
of twenty entries are non-derivable SQL facts (exp4j's `log` is NATURAL log → `LN` while SQLite's `log()` is
log10; `cbrt` splits on sign because `POW` domain-errors on a negative base; `signum` is a three-way `CASE`),
and an AST makes each spine re-derive them.

Then the ordinary rule: read the blocker table for WHERE the fold gives up and land the whole FAMILY that step
belongs to, never the step alone. Rank by which import EDGE it cuts, then by which deletion-ratchet name it
lets you delete, with marginal coverage as the tiebreak.

### §6·5 — TWO reasons wear one `null`, and conflating them corrupts the ranking signal

§12's "`null` is the only decline" stays true, but two FACTS spell it: **"not learned yet"** (temporary) and
**"the answer is an ERROR"** (permanent — never a capability). ⚠️ Banking the second as a gap makes a finished
family look unfinished and misranks the next increment.

- **A refusal on the traversal's own TEXT belongs to the IR `Pass` tier, above both spines.** ⚠️ It needs a
  distinguishable THROW, not a message match: `Deferral` for "not learned yet", a plain `Error` otherwise. The
  question is WHO OWES THE ANSWER, never severity.
- ⚠️ **A verifier must never narrow what the lowerings may attempt.** Legacy refuses a read tail after a
  merge; slicing the same way in the Pass would have refused `mergeV(…).values('name')`, which RelIR
  continues past.
- ⚠️ **A refusal about the STREAM, not the arguments, must fail open where it cannot type the prefix.**
  `elementKindAt` (`ir/step.ts`) answers `vertex`/`edge`/**cannot-say**, and the third answer is the
  load-bearing one — a branch or child host is left to the lowerings rather than raised on.
- **A GRAPH-dependent refusal becomes a guard binding**: `Binding.guard = { message, raiseWhen: 'rows' |
  'empty' }`, a binding whose relation the executor runs and whose ROW COUNT it tests — O(plan size), one
  statement, inside P5. **The message is the reference's verbatim.** Both directions are real: `'rows'` is a
  COLLISION (`assertAvailableElementId`), `'empty'` a MISSING referent (`mergeE`'s *"Vertex does not exist"*).

### §6·6 — ONE child seam: a child body has THREE total answers

`src/compiler/rel/child.ts` declares it and `childSeam(ctx, fresh)` builds it: correlated **scalar**,
correlated **predicate**, **rooted** relation, plus a `rows` arm (the whole owners relation at once, carrying
the owner key via the `origin` channel) and the `body()` normalizer they share.

**The rule the seam exists to hold: a child body works wherever a child body is LEGAL, not wherever a host was
taught one.** `rooted` is deliberately POLICY-FREE — a consumer's admission rule is the consumer's, or the seam
becomes the union of its callers' requirements. `body()` is part of the DECLINE contract, not a convenience:
normalizing re-runs the Pass pipeline and can legitimately raise.

⚠️ **THE GENERALIZED LESSON, six witnesses so far: coverage must measure what the algebra can EXPRESS, never
what the router remembered to ask.** A gate at the routing switch reads identically to a missing lowering in
every counter the migration owns — route gates on `sideEffects.size`/`sackInit`, `servicesNamedBy` scanning
only the top-level chain, `rootedRead` dropping settled values, `rel-blockers` calling `lowerToRel` without
the registry. **Its mirror is worse because nothing is even asking: a fact the FRONT END drops**, so a
lowering cannot decline on a policy it cannot SEE. **Whenever a seam re-enters the fold, check what it HANDS
OVER before concluding what the algebra cannot express.**

### §6·7 — a scalar row's TYPE rides PER ROW; a static tag is an OPTIMIZATION, never the carrier

**THE RULE: what arrives on the wire is CARRIED until something naturally changes it** — never re-derived,
never re-guessed, never DISCARDED because modelling its carriage looked like work. Guessing from a JS value
cannot tell a UUID from a string, a datetime from a long, or a big long from either. Carrying costs one column
and helps every type at once.

**The lattice** (one authority, all sites landed): `static ∧ static(same) → static` · `static ∧ static(differ)
→ perRow` (each side projects its tag as a literal `vt`) · `perRow ∧ x → perRow` · `unknown ∧ x → a NULL tag`.
⚠️ That last case is NOT `→ unknown`, which would discard an arm's `datetime` because its SIBLING could not
say; a null `vtype` IS "infer from the value" everywhere in the channel.

⚠️ **EVERY SHAPE DESCRIPTOR IS TOTAL — keep it that way.** Optionals were the defect generator, so omitting a
field is now a type error rather than a code review: an omission reads as "no opinion" rather than "framed
wrong", which is why a convention could never be the protection.

**PASS-THROUGH is exact; ARITHMETIC is SQLite's** — the narrowest tag in the Number family that holds the
result **without narrowing**. ⚠️ Two hard edges: **never narrow** (`frameValue`'s `case 'byte'` calls a strict
serializer, so tagging 128 a Byte is a crash) and **never leave the Number family gratuitously** (BigInteger/
BigDecimal decode to BigInt/BigDecimal and `1123n !== 1123`). Widening INSIDE the family changes no answer
Gremlin can be asked — cited, not assumed: `GremlinValueComparator` treats every `Number` subclass as ONE type.

- 🚧 the **variant payload** has no `vtype` column, so an arm declares a STATIC tag or `UNKNOWN`; carrying
  `perRow` there needs the framer to read it, i.e. a wire change.
- 🔴 **Four documented deviations, not defects:** host-language typing in Java/.NET (`Short s = …sum().next()`
  is a CCE); 128-bit arithmetic DECLINES (no arbitrary precision, no UDFs — do NOT raise, since `!fp && bits ≥
  64` is Long's rule); int64 overflow raises natively at upstream's own rethrow point; 32-bit float arithmetic
  is not expressible (SQLite REAL is always a double, and nothing observes it).

### The instruments — run all of them, not the cheapest

Per-increment loop: `ci` → `test:legacy-spine` (every coverage-moving change) → `test:cf-limits` (every new
SQL) → commit → `mise run L5` at the commit (its seed is HEAD-derived) → push. `test:perturbed` only when the
change touches ORDER.

| instrument | blind to |
|---|---|
| census (`ms` digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value; a lost fast path. ⚠️ `n`/`ord` legitimately move under a collapse and are NOT gated |
| row-for-row vs legacy | a MISSING throw; a wrong ORDER both spines share; anything outside the INTERSECTION |
| L2 shape assertions | a wrong VALUE with the right shape |
| L3 conformance | anything the corpus doesn't exercise — but the ONLY thing that sees a required error message |
| `rel-sweep` | correctness — it asserts the lowering doesn't THROW and renders within the cap; a decline at `spine.ts` is invisible to it |
| `test:perturbed` | values — the only thing that sees an order right only by SQLite's scan luck |
| `L3:rel-only` | the same corpus blindness as L3 — and it measures the ROUTE, so a shape the algebra EXPRESSES but nothing HANDS it (§6·6) reads exactly like a missing lowering |

⚠️ **A FIXTURE-CORRUPTING bug HANGS instead of failing, and no instrument above reports it.** The census
shares ONE store across every non-write traversal, so a write MISCLASSIFIED as a read mutates the fixture —
measured: `isWrite()` asked the AMBIENT spine and swallowed the throw as "read", a `mergeE` created six
self-loops, and the corpus `repeat()`s then walked a cyclic graph. Two rules, both encoded: **a
spine-sensitive CLASSIFIER must ask both spines**, and **a throw is not evidence of readness.** When a suite
hangs after a coverage increment, suspect the shared fixture first.

---

## §7. Scope control — the node set is CLOSED

RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no
statistics, no join reordering — SQLite is the optimizer.** Adding a node kind requires showing the seam
cannot EXPRESS a shape, not that it has not been HANDED one (§6·6).

---

## §8. What this deletes — the EXIT CRITERION

**COVERAGE GATES THE ROUTE. THE IMPORT GRAPH GATES THE CODE.** The exit criterion: **the import graph is
severed and `repeat()` works.**

✅ Phase 0 is over — `mise run edges` prints "PHASE 0 IS OVER", and the exempt trio (`engine/engine.ts`,
`engine/deps.ts`, `compiler.ts`) are the only files reaching into `src/compiler/steps/`.

`mise run deletion` gates the floors in `scripts/deletion-ratchet.tsv` — **that file IS the list; editing
prose here changes nothing.** Non-zero today, by phase: **Phase 1** `runWriteChainFull`, `parseEdgeCluster`,
`parseVertexSpec`, `resolveEndpoint`, `materializeElementDrivers`, `WritePlan` · **Phase 3**
`expandRepeatBody`, `REPEAT_BODY_OK` · **Phase 4** `TailAcc`, `globalRowOps`, `runFastPath`, `appliesWhen`,
the five-copy `count` adapter, the four-copy `where` adapter.

---

## §9. ✅ Landed — the substrate to build on

**The census is the authority; there is no list here on purpose.** `test/census/goldens.tsv`'s `spine`
column says what routes, `mise run rel-blockers` says where the fold gives up, and both are re-run rather
than transcribed. Broadly: every read source and filter, movement with the bulk collapse, the row-algebraic
and reducer families, all six shapes (LIST/MAP/PROPERTY/RECORD/VARIANT plus the ALIAS and PATH channels) with
payload projection inside the algebra, the write vocabulary including label mutation, `sack` and the
named-collection substrate, `call()`, `math`/`format`, and both `repeat()` regimes.

⚠️ The two-floor L3 ratchet, the census's dual pinned positions and `relirAhead` are all **HARNESS** — cut
per phase with the code they compare, gone by Phase 4. Do not build on them.

---

## §10. The phases

**Ordering principle: FOCUS before volume, volume before capability.**

### ✅ Phase 0 — extract the kernels, sever the import graph — DONE

⚠️ Two rules that outlive the phase. **The `edges` exemption bar is narrow and that narrowness is the
value:** reached ONLY by legacy AND does not exist after Phase 4 — "legacy still needs it" admits anything.
And **the pre-flight every capability migration needs: compile the traversals that USE the thing BEFORE moving
it** — `degree.centrality` was built, measured working and reverted, because all six corpus traversals using
it went through `project()`, which was not yet on the spine, so migrating it would have fixed zero and broken
six.

### 🚧 Phase 1 — writes: the residue, then the first cut

**The cut:** delete the write route, `steps/write/write.ts`, and the write half of the differential. NOT on
the critical path — Phase 3 is the gate.

⚠️ **MEASURE BY TURNING THE ROUTE OFF, NEVER BY READING THE CODE, every round.** Longest lowering PREFIX per
traversal, blame the step AFTER it, and never break at the first decline — a write step absorbs a cluster and
declines as a bare prefix. The first run refuted the prose it replaced: `labels()`, a READ, was holding the
entire label-write family.

🚧 **Re-measured 2026-08-11: 27 of 246 corpus WRITE traversals blocked**, grouped by CAUSE rather than step
name, because that lesson keeps recurring:

| cause | n | blocked on |
|---|---|---|
| **`property(k, <traversal>)`** | 3 | Nothing. **Two have a provably ONE-ROW value** (`property('k', __.…sum())`) — the natural first increment. ⚠️ The reference collects with `applyAll`, so a multi-row value is a SEPARATE case: 0 results → NO mutation (never a NULL write); >1 under `single` → *"Single-cardinality property requires exactly one value, but traversal produced N results"* (a guard binding); >1 under `list`/`set` → each written; the single-argument MAP form is a third case (`AddPropertyStep.java:105-199`). The seam EXISTS (`ChildSeam.rows` + `origin`); what is left is the CONSUMER — an `Insert … SELECT`, the cardinality rules, the guard. **Compounds** into Phase 4's `local`/`properties` |
| a map-valued `inject`/`union` feeding `mergeV`/`mergeE` | 7 | ⚠️ blocked at the SOURCE — the MAP SHAPE, a READ. **Not write work**, the `labels()` lesson again |
| **runtime / computed LABEL** | ~6 | Nothing. `ElementHelper.validateLabel` is three PURE predicates, so all are a GUARD BINDING, not a decline. ⚠️ **The message set depends on ARITY** — `addV(single)` gives three `Label can not be …` messages while `addV(a, b)` IS a Collection and `AddVertexStep.resolveLabelCollection` raises FOUR others BEFORE `validateLabel` runs. **Compounds**: the same generalization serves a computed property KEY and edge label |
| `T.id` on `mergeV`/`mergeE` | 5 | `elementIdGuard` exists; the `Insert` column plumbing does not |
| a meta-property under an UNDECLARED cardinality | 2 | the `set` arm PATCHES rather than inserts — an `UPDATE` this route does not emit |
| `with()` on a write · singletons (`addE` after `addE`, `addInE`) | ~10 | one reason each |

⚠️ **Where a refusal is arithmetic over the INPUT's row count, a host that cannot count statically needs a
GUARD, not a decline.** `addV` proves single-row at COMPILE time (its one-row case is a literal `Values`); an
`addE` mid-chain input is a traverser relation and nothing static separates `g.V(1)` from `g.V()`.

🔴 **One question has THREE answers today** and the computed-label work must settle it, not add a fourth:
`mergeV([(T.label): x])` coerces on BOTH spines, `g.addV(x)` declines on RelIR and coerces on legacy,
`addLabel(x)` coerces. All reachable, since `stringArgument : stringLiteral | variable` admits a parameter
bound to a non-string. `validateLabel` is TYPED upstream and coerces (`String(label)`), so the gap is a
missing guard at the CALL SITES and the raise is per-site — nine messages. ✅ Decided: the `- found: %s` tail
names a GREMLIN type (`CanonicalType`), not a Java class, and the tail only.

### 🚧 Phase 2 — the extracted families; what is LEFT

Rank off `mise run rel-blockers`, which splits `blocked` into `answered` (some route answers it, so lowering
closes the CUT) / `open` (nobody answers it, an outright L3 gain) / `unscored`, with an `L3` column. Re-derive
it rather than trusting a printed ranking — it has rotted once (`blame()` read a wrapper and reported the
LARGEST family as absent) — and read a decline's REASON, not its date. ⚠️ **Rank
off the CUT filtered on "the route answers" — asking whether legacy COMPILES a traversal is a different
question and cost a whole measurement**: legacy compiles every multi-site `aggregate` and silently
mis-answers nine of them.

Current leaders: the scalar-transform tail (heterogeneous — mostly literal-typed casts and error-raising
forms rather than one lowering), branch (`choose`/`union`), row ops (`order`/`dedup`, the ELEMENT-list and
`Column`-keyed forms), aliases (`select`, dominated by `Pop.all`/`Pop.mixed` history reads), the rest of the
map shape, side effects, then `local`, `match`, `where`, the `path` tails.

Named gaps, each with its blocker so it is not re-derived:

| | gap | blocked on |
|---|---|---|
| 1 | **Set-op keeps its members' types** — `values('when').fold().merge(…)` returns raw millis | The lossy test must span BOTH sides; `withLossyFlag` asks it of one relation. ⚠️ Gating on the compile-time `typed` flag is NOT the same question and was measured wrong (6 differentials): `values('name').fold()` is `typed` while every member is bare at run time |
| 2 | **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what `path().by(<transform>)` writes), where a null tag means "infer from the value" everywhere else | Nothing — inert until tags join a comparison, which is how it was found |
| 3 | **Map family residue** — selective token subsets (`with(tokens, ids)`), the `by(__.unfold())` that pairs with them, `order(Scope.local)` over map entries | Needs a list whose members may be ELEMENTS |
| 4 | **Group-scoped reducer: `count()` with a non-empty body, and a SCALAR host** | The empty pool is PER-REDUCER and decides INNER vs LEFT join (`CountGlobalStep` seeds 0 and keeps its key; `SumGlobalStep` does not). A scalar host needs `origin` to name a parent with no rowid — channels-core |
| 5 | **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy for the role, channels-core) and `barrier(Barrier.normSack)` (its own step) | Both honest |
| 6 | **The `set` framing marker** survives `range(local)`/`all`/`any`/`none`, dropped only by `order(local)`/`unfold()` | A state-threading change through the list tail's follower loop, duplicated across spines. Land it in RelIR and let legacy shed |
| 7 | **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire type today) | Head-position tracking on the RelIR `AliasEntry` |
| 8 | **Carry an inexact REAL into JSON exactly** — SQLite's JSON *writer* uses 15 significant digits and cannot round-trip a binary64; the parser is exact | Nothing, but ⚠️ four traps below |
| 9 | **L4 sweep** — two committed expectations encoded legacy's bug | Nobody has swept the rest. An addendum written against one implementation records that implementation, not the reference |
| 10 | **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself | Nothing; one commit. Bytes, not an answer, but in the hottest key expression there is |

⚠️ **The exact-REAL fix (gap 8) was attempted and reverted; each trap cost a cycle.** The shape that works
applies ONLY where precision is actually lost: `CASE WHEN CAST(printf('%.15g',v) AS REAL) = v THEN v ELSE
json(printf('%!.17g',v)) END`. (1) It is a **JSON-ENTRY rule, not a stored-value rule** — in `storedValueOn`
it corrupts the ROW path, so `values('weight')` becomes JSON text and a later `fold()` quotes it. (2) **Gate
on the VTYPE, not `typeof(value)`** — the value can be a whole correlated subquery and the guard splices it
three times (69 statement families moved). (3) **`%.17g` drops real-ness** (`1.0` prints `1`), while `%!.17g`
always writes 17 digits so `0.2` becomes `0.20000000000000001` — hence the lossy-only guard. (4) SQLite's
JSON subtype does not survive some `CASE` shapes; it does survive when `json()` is the aggregate's direct
argument.

✅ **RelIR follows the REFERENCE; legacy's disagreements are not decisions.** RelIR is checked against
`gremlin-test`/`gremlin-core`; legacy is a route with an end date. So a disagreement is legacy's, it is
expected, and it earns no work — a framed-answer difference in `sql-hygiene` is TELEMETRY, and the count
still prints so a NEW divergence stays visible.

⚠️ **Invariants earned here — re-breaking these costs a wrong answer.** (The rest are recorded at their
call sites, which is where they belong.)

- **A NULL never WINS a min/max and must never be FILTERED.** `NumberHelper.max/min` return the non-null
  side; over an all-null input they reduce to null and the barrier has seen starts, so ONE null traverser is
  emitted. Nulls sort LAST, with an explicit `IS NULL` term (SQLite orders NULLs first ascending).
- **A map is a SCOPE, consulted BEFORE the path labels** (`Scoping.java:119-135`), and `containsKey` is
  presence (an `EXISTS`), not "the value is not null". An unresolvable `select()` key is the EMPTY RESULT, not
  a decline (`Select.feature:578-596`).
- **`ChildValue.present` carries productivity beside the value** — `Pick.none` and `Pick.unproductive` are
  distinguishable no other way, and a body that cannot report it DECLINES.

### 🚧 Phase 3 — `repeat()` — THE GATE

The one family whose absence disqualifies the server, so deletion waits on it and nothing else. **This
section is the live index for anything `repeat()`-shaped**; the plan that decided the split is archived at
`docs/archive/2026-08-09-repeat-two-regimes-plan.md`, kept for its MEASURED facts (its §7.2's chain-global
collapse relaxation is **REFUTED** — do not retry).

**The decision:** `Recursive` wherever the walk is unbounded; the IR-level unroll (`unrollFixedRepeat`) for a
bounded `times(n)`; a clear refusal for unbounded-AND-barrier. **Neither regime alone is sufficient and
neither insufficiency shrinks with effort** — unroll cannot express an unbounded walk, and P3 says a term can
express neither a per-iteration barrier nor the collapse.

✅ **Both regimes are on trunk**, along with the checker hardening, `prune`, the `block.ts` legality analysis,
the walk (`until`/`emit`/`emit(pred)` at all four modulator positions, a sack folded through it, and
`repeat()` with NEITHER modulator as the specified EMPTY result), and ONE positional collapse authority.

🚧 **Status: the substrate is landed, the COVERAGE is not — and the gap is not what it looks like.** Measured
2026-08-11: **135 corpus `repeat` traversals, 33 answered by RelIR, 102 declining.**

- ⚠️ **79 of those declines are BOUNDED, which reads like the unroll's admitted-body gate is the blocker. It
  is not.** Relaxing `unrollableBodyStep` to a deny-list moves routing **33 → 43 only**; the other 69 are
  blocked by steps the SPLICED chain still cannot lower (`select`, `local`, `group`, the map shape). **Most of
  the repeat gap is the ordinary Phase 2 coverage gap wearing a `repeat` costume** — work Phase 2's families.
- 🚧 **The deny-list conversion — +10, and NOT blocked on anything.** The transformation's validity is a
  property of `repeat`, not of the body's step names, so the allow-list is the accidental model; the end state
  is a deny-list of exactly `loops()`, a named `repeat('a',…)`, `emit()`, `until()`.
  ⚠️ **This item carried a stale blocker for two days and the correction is the lesson.** It said the
  SIDE-EFFECT subset needed "an argument about accumulation ACROSS phases" from
  `docs/2026-08-09-named-collections-are-bindings-plan.md`. That argument is multi-site accumulation, which
  LANDED in that plan's Phase 2 — an unrolled body simply IS N sites. Verified by admitting `aggregate` and
  running it: `g.V().repeat(__.aggregate("a")).times(2).cap("a").unfold()` returns each of six vertices twice,
  which is `Aggregate.feature:743-763` exactly. The +10 measurement already admitted side-effect bodies, so
  the number stands. *Read a decline's REASON, not its date.*
- 🚧 **A parameterised `times($x)` should PREFER the walk**, where it stays a bind. Unrolling forces the one
  early parameter reduction the root `CLAUDE.md` names, so the unroll should claim it only when no other
  regime can express the body.
- 🚧 **An unbounded body whose UNION is not the TOP node.** `repeat(__.bothE().inV())` declines on shape: the
  term is `project(join(union(arm₁, arm₂), …))` and a projection over a compound takes a derived table.
  `repeat(__.outE().inV())` already walks because it has ONE arm. The fix is the same distribution one level
  further — through a JOIN (Calcite's `JoinUnionTransposeRule`). ⚠️ **It must NOT be shortcut with a
  disjunctive single-arm join** `ON (e.src = w.id OR e.tgt = w.id)`: that matches a SELF-LOOP once where
  `both()` must yield the vertex twice, and it fails SILENTLY (a plausible row set, short one row per
  self-loop) where the derived table fails loudly. ⚠️ **~0 corpus reach** — real capability, no number.
- 🚧 **The UNORDERED bulked slice.** A collapse is refused in front of an unordered slice because `bulkSlice`
  has no position to accumulate along, so `g.V().both().both().limit(2)` enumerates a fan-out it could trim.
  Minting a deterministic window order fixes it, at the cost of choosing WHICH traversers an unordered `limit`
  returns — legal (TinkerPop specifies only membership) but it moves an answer digest, so it needs the census
  re-recorded with that argument. **Last, because it is the only item here that trades a pinned answer.**
- 🚧 **`mise run L3:rel-only` cannot REPORT yet** — upstream's graph-snapshot reads (`world.js:147-180`) take
  the legacy route, so the position raises inside `BeforeAll` and cucumber runs zero scenarios. ⚠️ **Its first
  run READ THAT AS "deleting legacy costs 0 scenarios"** — the worst answer a measurement can give,
  indistinguishable from success and pointing the wrong way. A zero-scenario run is now a hard failure naming
  the cause.

Phase 4's read-side work rides along where it is a prerequisite: the block assembler replaces `TailAcc`,
`ELEMENT_DISPATCH` joins the shared substrate, aggregate/count handlers become one `Aggregate`, and
`recognize` (§4.7) makes the fast paths plan rewrites, which lifts the FTS decline.

### 🚧 Phase 4 — `rm -rf src/compiler/steps/`

Phase 0 severed the graph and Phase 3 clears the gate, so this is a deletion, not a migration. Sweep
SYMBOL-level, not file-level (`bun scripts/refs.ts`, `mise run orphans`) — a file-level closure over-counts.
Everything legacy still answered on the day becomes a clear deferral, NOT a blocker. The routing switch,
`options/spine.ts`, `MOGWAI_RELIR`, `test:legacy-spine`, the `legacySpine` L3 floor, the census's legacy
pinned position, `relirAhead` and the per-test `{spine}` pins all go with it.

### 🚧 Phase 5 — the docs sweep

Most of `docs/` was written against a two-spine world and will be lying by here. **Archive** every plan that
only describes the old pipeline (move, do not edit in place — a plan whose subject no longer exists is
history). **Edit** every plan that partly survives down to what still applies, deleting the superseded half
rather than annotating it — **this file included**. **Sweep the citations**, since code comments and
`deletion-ratchet.tsv` notes cite §-numbers and old phase names. **Then, and only then**, refresh
`docs/feature-support-matrix.md` and `docs/outstanding-work.md`.

---

## §11. Open design decisions

**Live ones are listed per PHASE, beside the work they gate** — Phase 1's three-answer label coercion and
Phase 3's unbounded-plus-barrier wall. Keeping a decision next to the increment it blocks is what stops it
being read as general policy. Phase 2 has none: RelIR follows the REFERENCE, so legacy disagreeing is expected
rather than a question.

Closed and recorded as law: exact-type literal framing and the numeric-tower PROMOTION rule both resolved into
§6·7 — the second by NOT building it, since reproducing `NumberHelper.getHighestCommonNumberInfo` changes no
answer Gremlin can be asked while costing a sort plus an O(N) sorter on every sum narrower than 64 bits.
Re-open one only with evidence, not a preference.

---

## §12. ⚠️ Traps — each cost a real defect, none found by reading

**The decline contract.** `null` is the ONLY decline, cheap and total — a partial lowering that silently
drops a filter is invisible to the differential, and a module whose contract is `null` must not let a throw
escape. **A fast path is never silently dropped** (`has(k,containing(t))` routes the trigram index and
DECLINES until §4.7). **A decline is only right when the OTHER spine is right** — four "answer where TinkerPop
raises" findings were kept because legacy answered identically wrongly, so declining bought zero correctness.

**Before reproducing a reference distinction, ask what a client can SEE.** Three bands: it changes the VALUE →
build it; it changes the decoded CLASS across a boundary every GLV has (Number ↔ BigInt/BigDecimal/Date/UUID/
string, scalar ↔ Array/Set/Map) → build it; it changes only the GraphBinary TAG inside a band every GLV
collapses → do not build it, document the deviation. Band 3 is never a reason to DISCARD upstream (§6·7 —
carriage is cheap), only a reason not to build machinery to RECONSTRUCT what nothing can observe.

**Wrong answers with the right arity** — the class no ladder level sees:

- A non-derivable fact must not be re-implemented (typed inject tags, `JAVA_WHITESPACE`) — call the one
  authority. A second implementation is a second chance to get it wrong.
- A type ASSERT is not a predicate (`is(typeOf(LIST))` RETYPES; as a filter it returns right rows framed
  wrong). A parse that must RAISE cannot be a `CAST` (`asNumber('1,000')` must raise, not answer 1).
- A dedup must not distinguish rows by MULTIPLICITY; a survivor stands for itself.
- `count()` is not SQL — an `Agg` with no args means "over all rows". A `Lit` cannot express a REAL literal
  whose value is integral (JS `1.0` IS `1` → integer division); use an explicit `Cast`. `values(k…)` reads
  EVERY key, not `args[0]`.
- Comparison across type spaces (a range predicate, `min`/`max`) must gate on type-space agreement; reducer
  eligibility and order go through `storedCompareOn`, never SQLite's storage class.
- **Only the `elements` framing arm carries `bulk` to the wire.** Every other arm drops it, so a collapse in
  front of a chain that retypes and then ENDS answers N traversers as one row. A collapse is legal only where
  the carried channels survive a merge (`CHANNEL_GROUP_POLICY`) AND the suffix reads the multiplicity
  (`ir/bulk.ts`); a BODY's end is not the wire, and `bulked` goes STALE at a barrier that drops the channel.

**Order and determinism.** Deterministic, not merely ordered — `ROW_NUMBER() OVER (ORDER BY encounter, id)`
needs the tie-break, and the tie-break is the caller's argument. Mint the emission order ONCE over a whole
fan-out, never per arm. A sort SUPERSEDES the arriving order, so re-MINT where a position is carried. A
correlated hop threads no order. **Collapse and emission order are MUTUALLY EXCLUSIVE.** A non-deterministic
ordering expression (`RANDOM()` for `sample`) must never sit in a slot the assembler can inline — rank in a
window and filter. Slice tests compare against legacy row-for-row UNSORTED and must pass under
`test:perturbed`.

**Structure and plumbing.** A chain-level requirement (path/encounter demand) is computed over the WHOLE
chain, at the point the chain is identified. A clause reader (`WHERE`/`ORDER BY`) that reads a select alias
needs a `Materialize` fence — the FIRST reader only. A window may not read a windowed column; the ASSEMBLER
closes the block. Relation ids are minted PER LOWERING (a module-global counter makes two compiles emit
different SQL) and a replicated subplan carries FRESH ids. A `Project` over a whole-relation `Aggregate` that
reads none of its outputs ERASES the aggregation — the emitter blocks it (Calcite's `fieldsUsed.isEmpty()`).

**Consulting the reference is the root `CLAUDE.md`'s rule, not repeated here.** The one addition this
migration owns: **agreement between the two spines is not evidence of correctness — it is evidence of a shared
substrate.**
