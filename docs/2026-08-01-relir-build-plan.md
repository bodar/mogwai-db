# RelIR — the build plan

**Status: BUILDING.** RelIR is the missing middle: `Step[] → RelIR → SQL`, an inspectable, rewritable
relational algebra between the Gremlin front-end and the `q` SQL kernel. It replaces the legacy
compile-straight-to-SQL spine, whose `Query.ctes` is a private append-only array — the query never exists
as data, so every optimization had to happen *before* lowering or be hand-built around.

**The migration finishes when the IMPORT GRAPH is severed and `repeat()` works — not when coverage reaches
100%** (§8). Coverage is a SIGNAL for ranking an increment, never the finish line.

**Three instruments run it, all `ci`-gated, never copied here** (a number in prose goes stale): coverage is
`test/census/goldens.tsv` (`spine` column), the name countdown is `scripts/deletion-ratchet.tsv`, the edge
countdown is `scripts/steps-edges.tsv` (`mise run edges`). The blocker ranking is `mise run rel-blockers` —
re-run it every round, it moves.

**This document is DIRECTION + TRAPS, not history.** What landed and at which SHA is `git log`'s job. A
parallel machine-checkable statement of the same rules is `docs/spec/relir-algebra.allium` and
`docs/spec/relir-migration.allium`.

**Legend:** ✅ landed · 🚧 remaining work · ⚠️ trap — cost a real defect, do not re-derive ·
🔴 **needs a human call** — a deviation, a divergence, or a wall someone must accept or fund.

---

## §1. The measured platform envelope — LAW, do not re-derive

Measured against SQLite 3.51.2, re-confirmed on DO SQLite (workerd) via `test/cf-probe/`,
`test/cf-constructs.test.ts`. Facts about the platform, not preferences.

- **P1 — the recursive-term law.** The recursive reference appears **exactly once, at the top level of the
  recursive term's `FROM`**; wrapping it in a derived table fails `circular reference` even as the sole
  reference. POSITIONAL. No aggregates, no window functions in a recursive term. A correlated scalar
  subquery may reference the walk's alias. → `flatten` is required; a `Materialize` fence may never sit
  between the term and its own self-reference.
- **P2 — legal-but-refused-today.** `NOT EXISTS`, joins against a derived `UNION`, `IN (SELECT …)`,
  correlated scalars, multi-hop join chains are all legal in a recursive term. → `expandRepeatBody` is a
  hand-written join-flattener, not a platform workaround; it dies with `flatten`.
- **P3 — no per-iteration barrier is expressible in a recursive term, in ANY lowering.** `DISTINCT` is inert,
  `LIMIT`/`ORDER BY` are whole-CTE caps, `UNION` dedups the whole walk (violating the multiset rule). Do not
  re-propose re-lowering.
- **P4 — corpus ratio.** Of 125 `repeat()`s, 53 have a barrier body: **48 `times(n)`-bounded (max n=10), 5
  `until()`/`emit()`**. → `unroll` is the majority route; the wall is 5.
- **P5 — the write envelope.** Legal: CTE→`INSERT … SELECT … RETURNING`; multi-row `INSERT … RETURNING`;
  `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM (subquery)`; `DELETE … WHERE … IN (SELECT)`.
  Illegal: the Postgres-style data-modifying CTE. → a write chain is a SEQUENCE of statements, O(write steps)
  not O(rows).
- **P5b — RETURNING determinism.** Row order is undefined, but id assignment follows the source `SELECT`'s
  `ORDER BY`. → order the source and re-associate by carried key, never by RETURNING position.

---

## §2. The clean-room boundary — LAW

`src/rel/` imports NOTHING from `src/compiler/` or `src/gremlin/` — pure data plus total functions, testable
with no graph, store, or Gremlin. `mise run arch` gates it.

**It is a VOCABULARY boundary.** RelIR needs exactly two things about carried state: which output columns are
channels and in what order, and per channel its merge and barrier policy. The neutral **channel core** is
`src/channels.ts`. **A RelIR node cannot know what a sack is, and shape never enters the node set** — if a
`src/rel/` node acquires a `kind: 'scalar' | 'element' | …` field, the layer has failed. `ChannelRole` is
per-column carried-state bookkeeping, never the stream's Gremlin type.

Gremlin-shape-aware payload construction lives in `src/compiler/rel/` (`list.ts`, `map.ts`, `element.ts`,
`path.ts`, `record.ts`, …) — outside `src/rel/`, so it may know shape. Only `execute.ts`'s byte framers
(`(rows, Shape) → Buffer[]`, no SQL) are permanently legacy's.

---

## §3. The object model — complete and CLOSED

Two algebras — **expressions** (a value per row) and **relations** (rows) — plus **statements** for writes.
Every node is an immutable plain object with a `kind` discriminant; every list is `readonly`. Node kinds and
fields live in `src/rel/{expr,rel,stmt}.ts` — the code is the authority.

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
- a `Rel` binding marked **`snapshot`** → a **read boundary**, same retention/transport. "The value AT THIS
  POINT" — a CTE is recomputed by every statement that names it. `retained(binding)` is
  `isStmt(node) || snapshot`; `checkPlan` proves the discipline.
- a write in a read position is a **hoist to a binding** — `union(__.addV(), __.V())` is plan composition.
  There is no driver anywhere. Effects are legal only at a binding, as a type-level fact.

### §3.1 Types

`RelType = { cols: ColMeta[] }`, `ColMeta = { name, type: SqlType, nullable }`,
`SqlType = 'int' | 'real' | 'text' | 'blob' | 'json' | 'any'` — SQLite storage classes plus `json`. **Never a
Gremlin vocabulary**; Gremlin typing stays in `ScalarType`/`CanonicalType`.

### §3.2 / §3.3 The node set

15 expression kinds, 19 relational/statement kinds. Deliberately smaller than SQL, because SQL's redundancy
collapses (`HAVING` is `Filter` over `Aggregate`; distinct `UNION` is `Distinct` over `Union{all}`). Points
the type declaration cannot state:

- **`WindowSpec.partitionBy: Expr[]`** unifies global / per-origin / per-origin-dedup (`[]`, `origins`,
  `[...origins, value]`).
- **`Scan` is the only physical-schema node** — the storage seam.
- **`Values` refuses the EMPTY relation** (invalid SQL); the empty case is a `Filter(false)` over something.
- **`Project` is the only node that may DECLARE channel columns.**
- **`Distinct` is whole-row only** — a keyed dedup is `Window(row_number PARTITION BY key)` + `Filter(rn=1)`.
- **`Window` may only EXTEND its input**; mint-then-project is two nodes, fused by the assembler.
- **`Join` emits its sides' columns POSITIONALLY** (left alone for semi/anti); sides must be DISTINCT
  relations. **`Union` is n-ary.** **`Aggregate` emits group keys then aggregates.** **`Recursive.step` is a
  function**; `seed`/`step` channels identical.
- **`Agg` only inside `Aggregate.aggs`, `WindowExpr` only inside `Window.specs`** (checked). `Agg.orderBy` is
  what `fold()` needs; `Agg.filter` is SQL's `FILTER (WHERE …)`. `Scalar`/`Exists` may be correlated.
  `InList` is bounded by QUERY TEXT; a data-sized set is one JSON bind. `Delete` has no `using` — membership
  is an `InQuery`.

### §3.4 What is deliberately NOT a node

`With`/CTE (a binding is the only naming mechanism); `Param` (a parameter is `lit`'s `source: 'parameter'`);
`Correlate`/lateral (correlation is an `Expr` referencing an outer `RelId` — P1 forbids the node);
shape/cardinality/productivity/bulk (all Gremlin-level, §2).

### §3.5 Channel obligations, per node — the LAW that keeps the largest defect class dead

⚠️ **33% of this repo's diagnosed defects were a carried field dropped at a barrier, merge, or rejoin.** Every
node declares what it does to each channel and a total checker verifies it — `Record<RelKind,…>` in
`src/rel/obligations.ts`, so a new kind fails the build until declared. `Project` declares (subset of
outputs); `Union` merges per policy; `Filter`/`Sort`/`Limit`/`Distinct`/`Window`/`Explode` PRESERVE (pass the
input's channels through — **never name a list**); `Join{left}` widens the right side to nullable.

**The barrier obligation is TWO contracts.** A **barrier** emits a new traverser → no channel survives. A
**grouping by traverser identity** (dedup keeping first, movement coalescing convergent walks) emits one row
per surviving traverser → its channels must survive or a later reducer counts the collapse away. The node
declares which by WHICH CHANNELS IT CARRIES; `CHANNEL_GROUP_POLICY` says which roles have a defined N→1
answer (`bulk` adds, `encounter` earliest; alias/path/origin/sack belong to one member and refuse).

### §3.6 Two budgets the plan owns, not the emitter

- **Binds.** A user PARAMETER earns a `?`; a compiler-held constant is a typed literal. A plan carries
  `bindCount()` and **fails closed above the DO cap of 100**, checked against the RENDERED bind list (a fused
  block can spell one value twice). An over-budget row set lands as ONE JSON bind.
- **Statement text.** DO caps at 100 KB. `unroll` consults rendered size and declines above a ceiling,
  falling back to `Recursive` (which then refuses a barrier body per P3).

---

## §4. The passes — all `Rel → Rel`, total, order-declared

Structure is declared ONCE in `src/rel/walk.ts` (no `default` arm anywhere), so `noImplicitReturns` makes a
new kind a compile error. Rewriting is memoised, so the DAG stays a DAG.

⚠️ **Call this tier `rewrite`, not `Pass` (§6·5).** `Pass` names the `Step[]→Step[]` pipeline in
`ir/passes.ts`, which runs ABOVE the routing switch; these run below it. Load-bearing: a refusal raised here
would be a throw out of a lowering whose contract is `null`, and legacy would never see the traversal.

- **`check`** — the fail-closed verifier (column resolution, `Agg`/`WindowExpr` placement, §3.5 obligations,
  both §3.6 budgets). Always on in dev/tests.
- **`name` (§4.6)** — named CTE vs inlined derived table for every shared node, honouring `Materialize`. The
  ONLY pass with a production caller (`lower.ts`).
- **`prune` (§4.5)** — column pruning; makes `unroll`'s replicas affordable. Phase 3 prerequisite.
- **`land` (§4.5b)** — the bind-budget lowering (an over-budget `Values` → one JSON bind).
- **`fuse` (§4.4)** — small semantic rewrites. Ask which still buys anything the assembler doesn't before
  wiring it.
- 🚧 **`flatten` (§4.2)** *(Phase 3)* — join flattening / decorrelation into the P1 envelope. Deletes
  `expandRepeatBody`.
- 🚧 **`unroll` (§4.3)** *(Phase 3)* — replicate a subplan n times for `times(n)`.
- 🚧 **`recognize` (§4.7)** *(Phase 4)* — the fast paths as plan rewrites, so a fast-path decline can be lifted.

**Declared is not wired.** Only `name` has a production caller today; the rest are built-and-tested (or
planned) but reachable from no route. There is no object that orders them — the order above lives in this list.

---

## §5. The emitter — a SELECT block assembler

The IR is normalized (one operator per node); a SQL `SELECT` composes operators into fixed slots. The emitter
accumulates a block (`{select, from, joins, where, group, having, order, limit, distinct}`), opening a nested
SELECT only when a needed slot is occupied. Prior art: Calcite's `RelToSqlConverter` / `needNewSubQuery`
(`vendor/calcite/.../rel2sql/SqlImplementor.java`). **Total** — every kind has an arm, no fallback. Built on
the `q` kernel ADDITIVELY only. This is what deletes `TailAcc`. *Refused:* a `Select` mega-node from `fuse`.

⚠️ Emission facts: a compound arm is a select-CORE, so an arm filling a tail slot needs its own derived table;
splicing a join side lifts its aliases, so two sides reading the same shared relation collide and the
colliding side stays in its own SELECT.

### §5a. The equivalence gate — results and access path, NEVER spelling

Byte-identical SQL is not a gate (unreachable, and it invites snapshotting the emitter against itself). Two
properties held over real `test/L2-sql/` traversals: **same results** and **same `EXPLAIN QUERY PLAN`**
(reduced to index decisions). Together they fail on a plan that reads the same and executes differently,
without pinning spelling.

---

## §6. The migration discipline

### §6·1 (was §10·4) — ONE SPINE. The dual spine is a harness with an end date.

A traversal whose every step is covered routes RelIR end-to-end; anything else routes to legacy — **never
mixed inside one traversal**, so no opaque node ever exists and RelIR stays a real algebra. `RelIR on`/`off`
is a **differential switch** (`mise run test:legacy-spine`), making the whole corpus + L5 the oracle.

**THE FLOOR IS THE UNION OF THE TWO SPINES, NEVER EITHER ONE — legacy may lose what RelIR holds.** Gaining
five and losing five is progress; "legacy would have to support it too" is not a cost of a RelIR increment.
Three gates say so mechanically: the L3 floors gate ASYMMETRICALLY (the `legacySpine` floor may only shed
names the RelIR floor holds, and the union of the two `passed` sets may not shrink); the census's legacy gate
accepts a shed shape RelIR answers; and an assertion about a RelIR-only capability SAYS SO (`{spine:'rel'}`
for a plan/SQL claim, `relirAhead` for an ANSWER claim).

⚠️ **Where both spines ANSWER, they must agree** (census gate 3, row-for-row). A disagreement there is never a
shed capability — it is the wrong-answer-with-right-arity class, usually a shared substrate (§6·4) breaking.
Read a legacy failure by direction: legacy DECLINES where RelIR answers = the migration; legacy ANSWERS
DIFFERENTLY = a bug in shared code.

- **No opaque escape node, ever** — not as a bridge, not behind a flag.
- **No permanent exceptions.** A traversal routes to legacy for exactly one reason: a step's lowering is not
  yet written. Not "hard", not "rare", not "fast enough". No allowlist.
- **THE EXIT CRITERION IS NOT COVERAGE** — it is **the import graph severed, and `repeat()` working**.
  Everything else legacy still answers on the day of deletion becomes a clear deferral.
- **The differential is cut PER PHASE, with the code it compares.** "We would lose the differential" is not a
  reason to keep a route whose code is already deleted.

### §6·2 (was §10·5) — a data-sized row set is a VALUE, not a control-flow loop

**A row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE — a single JSON bind exploded
by `json_each` — never N parameters, read or write.** Three reasons, none movable by a runtime release: (1) a
read cannot chunk — it needs the set as a RELATION inside one query; (2) a chunked write cannot be the `Ref` a
later step joins against — that `Stmt`-binding-as-relation IS the pre-mutation snapshot; (3) the DO cap
becomes O(plan size) by construction, provable by `check`. JSON is MORE deterministic than native binds (an
integer binds INTEGER on Bun, REAL on DO; `boolean`/`bigint` throw on DO), so `transportable()`
(`src/program.ts`) fails closed. ⚠️ Cost: a BLOB cannot travel, so a `RETURNING` feeding a retained binding
projects `json(x)`, never `jsonb`.

### §6·3 (was §10·9/§10·10) — a SHAPE is a VALUE plus a framing arm; the boundary is `Shape`

RelIR never hands a STEP to legacy. Growing a shape has three parts and no fourth: (1) RelIR builds the VALUE
with its own nodes; (2) a `RelFraming` arm says what the relation holds; (3) `execute.ts` frames the rows from
a `Shape`. Three layers: **row algebra** (RelIR), **payload projection** (`src/compiler/rel/`), **byte
framing** (`execute.ts`, permanent). Calcite's decomposition is the model: a map is a TYPE plus an aggregate
FUNCTION, never a kind of stream.

### §6·4 (was §10·7/§10·8) — split every file at the KERNEL/EMISSION line; the unit of work is the FAMILY

**Share DATA and pure computation across spines; re-express only the EMISSION** (a re-derived
`JAVA_WHITESPACE` missing a code point is wrong in a way no test names). **EXTRACT THE KERNEL BEFORE DELETING
THE FILE** — a kernel trapped inside `steps/` is what turns a deletion into a re-derivation.

⚠️ **The split is one line further in than "call the same kernel with a different resolver".** Measured on
`math`: every arm of `mathToSql` CONSTRUCTS a q-kernel `Expression`, so the file is a kernel with an EMISSION
TAIL fused to it. The answer is an **ops record** (`compileMath<T>(formula, ops)`), not a shared AST — three
of twenty entries are non-derivable SQL facts (`log` is exp4j's NATURAL log → `LN` while SQLite's `log()` is
log10; `cbrt` splits on sign because `POW` domain-errors on a negative base; `signum` is a three-way `CASE`),
and an AST makes each spine re-derive them.

Then the ordinary rule: read the blocker table to find WHERE the fold gives up, and land the whole FAMILY that
step belongs to — never the step alone. Rank by **which import EDGE it cuts**, then by which deletion-ratchet
name it lets you delete, with marginal coverage as the tiebreak.

### §6·5 — TWO reasons wear one `null`, and conflating them corrupts the ranking signal

§12's "`null` is the only decline" stays true, but two FACTS spell it: **"not learned yet"** (temporary) and
**"the answer is an ERROR"** (permanent — never a capability). ⚠️ Banking the second as a gap makes a finished
family look unfinished and misranks the next increment.

✅ **A refusal on the traversal's own TEXT belongs to the IR `Pass` tier, above both spines** — built
(`writeArguments` verify Pass, sharing `src/compiler/ir/write-args.ts`). Three facts that each cost a wrong
turn:

- ⚠️ **the parse had to MOVE first** — it lived inside the legacy interpreter, which imports `normalize` from
  the Pass tier, so a Pass importing it was a cycle. A symbol on the deletion ratchet does NOT move with it.
- ⚠️ **the split needs a distinguishable throw**, not a message match: `Deferral` for "not learned yet", a
  plain `Error` for everything else. The question is WHO OWES THE ANSWER, not severity.
- ⚠️ **a verifier must never narrow what the lowerings may attempt.** Legacy refuses a read tail after a
  merge; slicing the same way in the Pass would have refused `mergeV(…).values('name')`, which RelIR
  continues past. The Pass slices the `option()`/`property()` RUN.

✅ **A GRAPH-dependent refusal becomes a guard binding**: `Binding.guard = { message, raiseWhen:
'rows' | 'empty' }` — a binding whose relation the executor runs and whose ROW COUNT it tests. O(plan size),
one statement, inside P5. **The message is the reference's verbatim.** Both directions are real: `'rows'` is a
COLLISION (`assertAvailableElementId`), `'empty'` is a MISSING referent (`mergeE`'s *"Vertex does not
exist"*). ⚠️ Label MUTATION is NOT this mechanism: `labelCardinality.mutable` is request-scope DI settled
before a compile starts, so it is a COMPILE-TIME refusal with the value threaded.

### §6·6 — ONE child seam: a child body has THREE total answers

`src/compiler/rel/child.ts` declares it and `childSeam(ctx, fresh)` builds it: correlated **scalar**,
correlated **predicate**, **rooted** relation, plus the `body()` normalizer all three share.

**The rule the seam exists to hold: a child body works wherever a child body is LEGAL, not wherever a host was
taught one.** `rooted` is deliberately POLICY-FREE — a consumer's admission rule is the consumer's, or the
seam becomes the union of its callers' requirements. `body()` is part of the DECLINE contract, not a
convenience: normalizing re-runs the Pass pipeline and can legitimately raise.

⚠️ **THE GENERALIZED LESSON, and it has now cost five separate defects: coverage must measure what the algebra
can EXPRESS, never what the router remembered to ask.** A gate at the routing switch reads identically to a
missing lowering in every counter the migration owns. Witnesses: `rel-blockers` calling `lowerToRel` without
the service registry; `compiler.ts`'s `sideEffects.size === 0` and `!sackInit` route gates; `servicesNamedBy`
scanning only the TOP-LEVEL chain (so `where(__.call(dc))` was never handed the service); `rootedRead`
re-entering `lowerChain` with three of five settled values dropped. **Its mirror is worse because nothing is
even asking: a fact the FRONT END drops** — `extractSideEffects` skipped `withSideEffect(k, v, Operator.max)`,
so a lowering could not decline on a policy it could not SEE. **Whenever a seam re-enters the fold, check what
it HANDS OVER before concluding what the algebra cannot express.**

### §6·7 — a scalar row's TYPE rides PER ROW; a static tag is an OPTIMIZATION, never the carrier

**THE RULE: what arrives on the wire is CARRIED until something naturally changes it.** Never re-derived,
never re-guessed, never DISCARDED because modelling its carriage looked like work. Guessing from a JS value
cannot tell a UUID from a string, a datetime from a long, or a big long from either. Carrying costs one column
and helps EVERY type at once.

**The lattice** (one authority, three call sites): `static ∧ static(same) → static` (agreement costs no
column) · `static ∧ static(differ) → perRow` (each side projects its tag as a literal `vt`) · `perRow ∧ x →
perRow` · `unknown ∧ x → a NULL tag` (a null `vtype` IS "infer from the value"; ⚠️ the plan originally said
`→ unknown`, which would discard an arm's `datetime` because its SIBLING could not say — the same bug one
layer along).

- ✅ the **inject source** (`injectValueTypes`, `gremlin/coerce.ts`; `bareInjectTag` deleted).
- ✅ the **arm merge** (`sameFraming` no longer declines on a tag disagreement).
- ✅ the **child seam's `scalar` arm** returns `{expr, framing, vtype?}`.
- ✅ the **LIST MEMBER** — `ListOf` carries the same `ScalarType`, and the `perRow` case grew a total
  `TypeCarrier` (`column` | `envelope`) so the encoding is a NAMED choice rather than prose. This is the
  arm the plan did not have a slot for, and its absence is why a member's type was spelled in a second,
  lossier vocabulary for as long as it was — see "THE MEMBER TYPE CHANNEL" under Phase 2. The reducer
  site landed with it (a local `min`/`max` is the argmin/argmax, reading the winner's own tag).
- 🚧 `AliasScalarType`/`aliasScalarTypeOf` (`steps/context/context.ts`) — a lossy coarsening invented for
  the same missing carrier, and now the LAST one. Same treatment: one total union, coarse views derived.
- 🚧 the **variant payload** has no `vtype` column, so a variant arm declares a STATIC tag or `UNKNOWN`.
  Carrying `perRow` there needs the framer to read it, i.e. a wire change.

**PASS-THROUGH is exact; ARITHMETIC is SQLite's** — the narrowest tag in the Number family that holds the
result **without narrowing**. ⚠️ Two hard edges: **never narrow** (`frameValue`'s `case 'byte'` calls a strict
serializer; tagging 128 a Byte is a crash), and **never leave the Number family gratuitously**
(BigInteger/BigDecimal decode to BigInt/BigDecimal objects and `1123n !== 1123`).

**Widening INSIDE the family changes no answer Gremlin can be asked** — cited, not assumed:
`gremlin-core/.../util/GremlinValueComparator.java` treats every `Number` subclass as ONE type and states it
(*"does not provide a stable order for numerics because of type promotion equivalence semantics"*). 🔴 The
honest residual is host-language typing in Java/.NET (`Short s = …sum().next()` is a CCE) — a documented
deviation, not a defect.

🔴 **Three platform walls, beside P1–P5 rather than in a coverage counter:** 128-bit arithmetic DECLINES (no
arbitrary precision, no UDFs — do NOT raise, since `!fp && bits ≥ 64` is Long's rule); int64 overflow raises
natively at upstream's own rethrow point; 32-bit float arithmetic is not expressible (SQLite REAL is always a
double — nothing observes it).

### The instruments — run all of them, not the cheapest

Most are inside `ci`. The per-increment loop: `ci` → `test:legacy-spine` (every coverage-moving change) →
`test:cf-limits` (every new SQL) → commit → `mise run L5` at the commit (its seed is HEAD-derived) → push.
`test:perturbed` only when the change touches ORDER.

| instrument | blind to |
|---|---|
| census (`ms` digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value; a lost fast path |
| row-for-row vs legacy | a MISSING throw; a wrong ORDER both spines share; anything outside the INTERSECTION |
| L2 shape assertions | a wrong VALUE with the right shape |
| L3 conformance | anything the corpus doesn't exercise — but the ONLY thing that sees a required error message |
| `rel-sweep` | correctness — it asserts the lowering doesn't THROW and renders within the cap; a decline at `spine.ts` is invisible to it |
| `test:perturbed` | values — the only thing that sees an order right only by SQLite's scan luck |

⚠️ **A FIXTURE-CORRUPTING bug HANGS instead of failing, and no instrument above reports it.** The census
shares ONE store across every non-write traversal, so a write MISCLASSIFIED as a read mutates the fixture.
Measured: `isWrite()` asked the AMBIENT spine and swallowed the throw as "read", so a `mergeE` shape created
six SELF-LOOPS and the 86 corpus `repeat()`s then walked a cyclic graph — infinite per the spec. Two rules,
both now encoded: **a spine-sensitive CLASSIFIER must ask both spines**, and **a throw is not evidence of
readness.** When a suite hangs after a coverage increment, suspect the shared fixture first.

---

## §7. Scope control — the node set is CLOSED

RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no
statistics, no join reordering — SQLite is the optimizer.** Adding a node kind requires showing the seam
cannot EXPRESS a shape, not that it has not been HANDED one (§6·6). If Phase 2 ever grows an
`ElementReadDriver` analogue, it has failed.

---

## §8. What this deletes — the EXIT CRITERION

**COVERAGE GATES THE ROUTE. THE IMPORT GRAPH GATES THE CODE.** Original measurement: all 39 files in
`src/compiler/steps/` were transitively reachable from non-legacy code, pinned by **14 direct import edges**;
deleting the legacy route alone freed 14% of the lines.

✅ **Phase 0 is over — `mise run edges` prints "PHASE 0 IS OVER".** The exempt trio (`engine/engine.ts`,
`engine/deps.ts`, `compiler.ts`) are the only files reaching into `src/compiler/steps/`, which is the
criterion the phase was written against. The live count is `scripts/steps-edges.tsv`, floors re-recordable
DOWNWARD only.

⚠️ Two findings from severing it, both durable: **every edge that fell was a table or a total function** — no
edge fell because a capability moved; and **the right neutral module was almost never a new file** (seven of
eight kernels had an existing home that already owned their concern). Where each landed is `git log` and the
files themselves.

**The exit criterion, restated: the import graph is severed and `repeat()` works.** `mise run deletion` gates
the floors in `scripts/deletion-ratchet.tsv` (that file IS the list; editing prose here changes nothing).
🚧 Non-zero today:

- **Phase 1 (write dispatcher):** `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`,
  `resolveEndpoint`, `materializeElementDrivers`, `WritePlan`.
- **Phase 3 (repeat):** `expandRepeatBody`, `REPEAT_BODY_OK`.
- **Phase 4 (block assembler / row-algebraic / fast paths):** `TailAcc`; `globalRowOps` (legacy-side only
  now); `runFastPath`, `appliesWhen`, the five-copy `count` adapter, the four-copy `where` adapter.

---

## §9. ✅ Landed — the substrate to build on

Read coverage from the census; this is the qualitative map of what RelIR already lowers.

- **Reads:** element and scalar sources; source-scope filters; the `P`/`TextP` vocabulary; movement (with bulk
  collapse); correlated `where`/`filter`/`not`; the `by()` modulator vocabulary; `dedup`/`identity`; the
  row-algebraic class (`limit`/`skip`/`range`/`tail`/`order`/`sample`); the scalar transform + reducer
  families; `has()`'s three argument shapes; the leading coercion prefix; `labels()`.
- **Shapes:** LIST (collection literal + `fold()`, member frame, set-ops, `unfold()`, ELEMENT members);
  MAP (`group`/`groupCount`, value `by()`, labelled forms); PROPERTY (`properties()` + `key()`/`value()`/
  `element()`/`count()`); RECORD (`project()`); VARIANT (per-row tagged union of mixed-shape arms); ALIAS
  channel; PATH channel (one JSONB array, `by()` per position); element and scalar payloads. All payload
  projection is inside the algebra (`element.ts`/`list.ts`/`map.ts`/`path.ts`/`record.ts`).
- **The CHILD SEAM (§6·6):** three total answers — scalar (expression + reducer forms, plus `valuePredicate`
  for a body that projects then tests), predicate (filter-conjunction / correlated `EXISTS`), rooted.
- **Writes (Phase 1):** `drop()`; `property()` on an existing element; `addV`/`addE` (incl. implicit
  endpoints, `T.id`/`T.label` tokens, multi-label, `addLabel`/`dropLabel`/`dropLabels`); `mergeV`; `mergeE`
  (both endpoint kinds, `option(Merge.outV/inV)`); creations and merges over a SCALAR stream. `MODERN_SEED`
  compiles WHOLE on RelIR, byte-identical to legacy's.
- **Side effects / collections:** `sack` (`src/compiler/rel/sack.ts`); the named-collection substrate
  (`aggregate`/`store`/`cap`, `group("a")`/`groupCount("a")`) — a collection IS the relation at that point and
  the `name` pass's CTE sharing is the whole mechanism.
- **Services (§10 Phase 0 residue):** `call()` as a source and mid-traversal step; `directory`,
  `tinker.search`, `degree.centrality` all `rel`; legacy's stream call route deleted.
- **Small languages:** `math()` and `format()` as ONE family (`compiler/rel/projector.ts`), at all four
  positions (element, VALUE, RECORD, child body).
- **Reducers:** `min`/`max` compare in TYPE SPACE via `storedCompareOn`; `sum`/`mean` over a `long`/`bigint`
  carried as decimal TEXT included exactly.
- **The framing contract:** the reducer/`result:'number'` framer reads a GREMLIN vtype when `vt` is one, else
  a storage class — this is what lets a text-carried long frame as a `long`.
- **The L3 ratchet has TWO floors** (default + `legacySpine`); the census records BOTH pinned spine positions;
  `relirAhead` is a first-class state. ⚠️ **All of this is HARNESS** — cut per phase with the code it
  compares, gone entirely by Phase 4. Do not build on it.

---

## §10. The phases

**Ordering principle: FOCUS before volume, volume before capability.**

**Naming.** Old work-unit names (`Phase 2.6` = the write dispatcher, `3` = repeat, `4.x`) survive in
`scripts/deletion-ratchet.tsv` notes and code comments. Mapping: 2.6 → Phase 1, 3 → Phase 3, 4.x → Phase 4.

### ✅ Phase 0 — extract the kernels, sever the import graph — DONE

Gate: `mise run edges` (`scripts/edges-check.ts`), floors in `scripts/steps-edges.tsv`, DOWNWARD-only. A
RATCHET rather than a zero-gate because some importers ARE legacy and keep their edges until Phase 4.
⚠️ **The bar for an exemption is narrow and that narrowness is the whole value of the gate:** reached ONLY by
legacy AND does not exist after Phase 4. "Legacy still needs it" is NOT the bar — it admits anything.
Deliberately DIRECT edges only; the transitive closure moves when an unrelated file three hops away changes
an import.

⚠️ **`call()` was mis-filed as a retype and was a CAPABILITY MIGRATION** — the SPI was typed on legacy's
`Stream` because that was the only lowered form there was. **One SERVICE may never have two implementations,
but that does not make the PHASE indivisible** — each service migrates all at once, riding `Contribution`'s
discriminant, with the transitional `stream` arm carrying an end date. Two lessons, neither caught by CI:
migrating a service makes legacy REFUSE it, so **(a)** a service's own validation THROW must propagate rather
than be caught as a decline (§6·5), and **(b)** a shape the service used to answer EMPTY must still answer
empty rather than declining. ⚠️ **The pre-flight check every service migration needs: compile the traversals
that USE a service BEFORE moving it.** `degree.centrality` was built, measured working, and reverted — all six
corpus traversals using it went through `project()`, which was not on the spine, so migrating it would have
fixed zero and broken six.

⚠️ **`project()` is the RECORD shape, not "a step"**: a record is a map whose KEYS ARE KNOWN AT COMPILE TIME,
so its fields stay addressable columns and a following `select(key)` re-roots to that field's own shape.
Collapsing to a map value happens once, at the wire. Three reusable pieces fell out: `payloadCols(framing)`,
`byField()` (the by() vocabulary's third question, beside `byExpr`/`byNode`), and the seam's typed scalar
return.

### Phase 1 — writes: the residue, then the first cut

✅ **Measured: `MODERN_SEED` and 127 of 131 distinct corpus initializers compile WHOLE on the RelIR write
path.** The corpus LOADS without legacy writes.

⚠️ **THE GAP TO THE CUT IS MEASURED BY TURNING THE ROUTE OFF, NOT BY READING THE CODE.** Stub `routeWrite` to
`null` behind a local env switch, run L3, replay each blocked traversal through `lowerToRel` prefix by prefix:
every one names the step it stops at. Do this every round — the ranking it produces disagreed with the prose
in the first entry (**`labels()`, a READ, was holding the entire label-write family**: every
`addLabel`/`dropLabel` scenario ends in `.labels()`, and no amount of reading the write module could show it).

✅ **Landed since that measurement, and the count it moved:** `labels()` (the read that was holding the
label-write family) · `dropLabel`/`dropLabels` · **writes over a SCALAR stream** · the `mergeE` search reading
the MERGE map alone (a wrong ANSWER, not a gap) · a `T.label` on `mergeV`'s `onMatch` arm · the merge-map key
rule moved into the verify Pass. **78 blocked scenarios → 47**, L3 1748 → 1755, census 937 → 950.

⚠️ **TWO OF THOSE WERE WRONG ANSWERS RATHER THAN GAPS, and both were found by reading the reference while
building something else.** A `mergeE` search was narrowed by `option(onCreate)`'s endpoints, where
`searchEdges` is handed the MATCH map alone — so a `knows` edge existing anywhere made the traversal create a
duplicate. And `null` from the label-name resolver ("decline") was read as `null` names ("every label"), so a
mixed-collection `dropLabel` dropped everything. **Both spines agreed about the first, so neither the corpus
nor the differential could see it** — §12's rule, twice in one phase.

🚧 **What is left, measured 2026-08-08 with the route off:**

- **`property(k, __.trav)` with a possibly-multi-row VALUE** (~13 scenarios) — the only item needing new
  substrate. Rules read off `AddPropertyStep` (`.../step/sideEffect/AddPropertyStep.java:105-199`), none
  guessable: **0 results → NO mutation** (never a NULL write, which is what a scalar subquery would produce);
  **>1 under `single`** → *"Single-cardinality property requires exactly one value, but traversal produced N
  results"* (a GUARD BINDING — graph-dependent); **>1 under `list`/`set`** → each written. The
  single-argument `property(traversal)` MAP form is a third case, flagged by `mapForm`.
  ⚠️ **The reference is ASYMMETRIC and that decides the shape of the work**: a nested **KEY** or **LABEL**
  resolves through `TraversalUtil.apply` = `.next()` = the FIRST result, which is exactly the seam's existing
  `scalar` arm and needs nothing new. Only a possibly-multi-row VALUE wants the **HOST-KEYED relation** — the
  child body applied to the whole owners relation at once, carrying the owner key. Not a lateral and not a new
  node; it is also Phase 4's `local`/`properties` shape, so it is the one honest candidate for a FOURTH seam
  answer (§6·6 says three, deliberately).
- **A RUNTIME LABEL is where RelIR can beat legacy outright.** `ElementHelper.validateLabel` is three PURE
  PREDICATES (null, empty, hidden `~`) with no graph access, so all three are a GUARD BINDING, not a decline:
  one statement instead of O(rows) round-trips, the whole set checked before anything is written, the
  reference's message verbatim. ⚠️ **The message set depends on ARITY** — `addV(single)` gives the three
  `Label can not be …` messages; `addV(a, b)` IS a Collection and takes `AddVertexStep.resolveLabelCollection`
  (`.../map/AddVertexStep.java:165-182`), which raises FOUR distinct messages BEFORE `validateLabel` runs.
  Build: `internLabels` generalized from `string[]` to EXPRESSIONS, a rooted single-row label through the
  seam, an ALIAS-read label (a column already on the row), and the arity-chosen guards.
- ✅ **Endpoint-less `mergeE`** (`g.mergeE([:])`) — LANDED, and the guard is `raiseWhen: 'rows'` over the
  UNMATCHED rows rather than `'empty'` over the matched ones, which is the sharper statement of the same
  rule: the reference's check runs per traverser, so "some row found nothing" is the condition and "the whole
  search was empty" is only its one-row case.
- 🚧 **THE REFUSALS LEGACY STILL OWNS — ~16 scenarios, and they are ONE piece of work.** An immutable graph
  (`addLabel`/`dropLabel`/`dropLabels`/`mergeV` on `single_label_graph`), a label mutation on an EDGE, a
  mixed `Collection` argument, `addV(constant(["a","b"]), constant("c"))`. Every one is an ERROR whichever
  spine runs it, so every one belongs in a `verify` Pass (§6·5) — and the reason none of them is there yet is
  a real gap in the Pass tier rather than an oversight: **a Pass cannot see the graph's
  `LabelCardinality`**. `runPasses` takes `(steps, strategies, params, sideEffects)`, and the cardinality is
  request-scope DI. Threading it is the increment; the merge-map KEY rule just landed the same way and needed
  no new input, which is why it went first.
- **`mergeV`/`mergeE` with a `T.id`** (~5) — the onCreate-inheritance scenarios and
  `mergeE_with_eid_specified_and_inheritance`. The guard mechanism exists (`elementIdGuard`); the `Insert`
  column plumbing does not.
- **A meta-property under an UNDECLARED cardinality** (the `set` arm PATCHES rather than inserts — an `UPDATE`
  this route does not emit yet); **`PartitionStrategy` on a merge**; **`addE` after `addV` in one chain**.

🔴 **`gremlin/validate.ts`'s `validateLabel` COERCES where the reference RAISES** (`String(label)`), so a
runtime label of `5` becomes `"5"` on BOTH spines today. A pre-existing divergence in shared code, invisible
to the corpus (no scenario asserts these messages) — needs a call on whether to fix it into conformance.

✅ **`inject()` LEFT the write dispatcher** — it is not a write and never was, and it was the dispatcher's
largest tenant by a wide margin: of 944 distinct traversals `routeWrite` answered, 591 (63%) contain no
mutating step at all, 543 of them `g.inject(…)` reads. Kept because the SIZE of that is the reason a route's
tenancy is not evidence of what it is for.

⚠️ **Where a refusal is arithmetic over the INPUT's row count, a host that cannot count statically needs a
GUARD, not a decline.** `addV` proves single-row at COMPILE time (its one-row case is a literal `Values`); an
`addE` mid-chain input is a traverser relation and nothing static separates `g.V(1)` from `g.V()`.

**The cut:** delete the write route, `steps/write/write.ts`, and the write half of the differential.

### Phase 2 — ✅ sack, ✅ the extracted families, then the rest

✅ Landed: `sack` · `math` · `format` · the ELEMENT-membered list · the NAMED-COLLECTION substrate ·
§6·7's lattice at the arm merge · `union()` in SOURCE position · the VARIANT · the OPTION-MAP `choose` ·
**the MAP LOOP** · **`valueMap()`/`elementMap()`** · **the MEMBER TYPE CHANNEL**. The durable findings
from them:

- 🔴 **THE MEMBER TYPE CHANNEL — §6·7 one layer down, and it had grown a SECOND VOCABULARY unnoticed.**
  `ListOf`'s scalar arm was `as?: ValueType` + `typed?: boolean` plus an implicit third case: exactly the
  two-optionals-plus-implicit-third trap `ScalarType` exists to end, spelled differently enough that nobody
  recognized it. It is now `{ type: ScalarType; productiveNull? }` — the same union, cases and accessors a
  ROW's type uses — which is step 3 of the build order recorded in
  `docs/archive/2026-07-25-type-channel-unification.md`. **The carrier is now NAMED too**
  (`TypeCarrier = column | envelope`): both are the same compile-time fact and only the READ differs, and
  leaving the encoding to prose is precisely what let the second vocabulary grow for it.
- 🔴 **What the second vocabulary cost, measured — three wrong answers and a decline, all one shape.**
  `TYPED_LIST` was a CONSTANT, so re-tagging a list REPLACED it and dropped `as` and `productiveNull`;
  `unifyLists` compared only the arms' static tags, so a lone self-describing arm unified to an UNTAGGED
  list and a uuid member framed as a String; `foldScalars`/`foldMember` took a `vtype?`/`staticTag?` PAIR
  and so could not carry `static`'s `text` flag — the fact that a big long rides as decimal TEXT — which is
  why `max(Scope.local)` compared lexicographically and answered the SMALLER value on BOTH spines while the
  GLOBAL `max()` was already right. **One step name, two engines, only one of them ever fixed.**
- 🔴 **A NULL never WINS a min/max, but it must not be FILTERED.** `NumberHelper.max/min` return the
  non-null side; over an all-null input they reduce to null, and `ReducingBarrierStep` has seen starts, so
  `MaxGlobalStep` emits ONE null traverser (`MaxLocalStep.processNextStart` splits on the same null and
  skips only an EMPTY collection). Filtering answered EMPTY for exactly that case. Both spines now sort
  nulls LAST — with an explicit `IS NULL` term, because SQLite orders NULLs first ascending.
- 🔴 **FOUR SITES DROPPED A FIELD ON A RE-SHAPE, and they are one defect shape.** A collection projection
  declared `v` alone (ask `framingCols` what the framing OWES); `aggregate().by(traversal)`'s per-input
  window narrowed to `(v, ordinal, rn)`; `unfold()` of a typed list rebuilt the scalar stream without
  `productiveNull` and with `UNKNOWN` instead of the member's own static type; the three global-reducer arms
  each rebuilt the framing without `productiveNull`. **The countermeasure is a named preserving rebuild**
  (`withMemberType`, `typeCarriedBy`, one `numeric` above all three reducer arms) — the same answer
  `rebuildScalar` already is for the row channel.
- ⚠️ **A COMPUTE-ONCE RULE the statement budget makes non-negotiable.** `v` and `vt` are two fields of one
  winning member, and a correlated subquery each emits the whole sort twice: 1,250 → 4,108 bytes for the
  `max` family against a 100 KB cap. Both spines project a `{v,t}` pair as ONE value and read its fields —
  and on RelIR that needs a FENCE, because the block assembler otherwise fuses the two projections and
  re-inlines the pick at both reads (3,024 fused, 1,915 fenced). The same rule retired `sum`'s
  double-aggregate and the member decode spliced into its own eligibility guard.
- ⚠️ **An UNTAGGED member is its own compare key, and that is PROVED rather than assumed** — its type is
  inferred from its storage class, and that inference cannot disagree with the storage order (TEXT infers
  `string`, no cast; INTEGER infers int/long, a CAST to INTEGER is the identity; REAL infers double). So the
  cast folds away for a bare list, and `inferVtypeSql` stays out of a self-describing list's ORDERING key
  entirely: only the WRAPPED members can carry a type their storage class does not determine.

- ⚠️ **THE MEMBERS STAY ROWIDS FOR THE WHOLE OF THEIR LIFE INSIDE THE ALGEBRA.** `foldElements` collects ids,
  `unfoldList` hands them back as an element relation, and only `listPayload` expands them — at the ROOT, once
  per SURVIVING member. The round trip is LOSSLESS and a discarded member is free
  (`fold().range(local,0,2)` computes two property bags, not six).
- ⚠️ **The fold happens AT the `aggregate`, not at the `cap`** — that is what "the value at this point" means;
  deferring it re-derives which relation was current N steps earlier, the problem the migration exists to end.
- ⚠️ **WHICH ARM A ROW TAKES IS ONE COLUMN.** Naive option-map gating is O(n²) in the EXPENSIVE term:
  measured 18.7 KB of statement text with the choice inlined, 7.5 KB projected to a column, **1.9 KB** with
  the tests projected into one ordinal `CASE`. The ordinal gives FIRST-MATCH-WINS free — and that rule cost a
  wrong answer first: `BranchStep.pickBranches` collects EVERY match and `ChooseStep` OVERRIDES it with
  `branches.subList(0, 1)` (`.../ChooseStep.java:139-142`).
- ⚠️ **`ChildValue.present` carries productivity beside the value** — `Pick.none` (a productive choice
  matching no key) and `Pick.unproductive` are distinguishable no other way, since `TraversalProduct` calls a
  productive null a value. A body that cannot report it DECLINES.
- ⚠️ **The ranking instrument can rot.** `rel-blockers`' `blame()` told a named collection from an unkeyed
  barrier by `typeof step.args[0] === 'string'`; an `Arg` has been `{value, type, name}` since a parameter
  became a first-class IR fact, so the test had been permanently false and the LARGEST family (95 side
  effects) was reported as absent while the third was reported as first.
- ⚠️ **A fail-closed VIOLATION: never name a channel list.** The ordered `dedup()` hardcoded
  `aggs: [['bulk',…],['encounter',…]]` while deriving its declared TYPE from the input's channels — fine until
  `fold().unfold()`, the first relation carrying a position and no multiplicity. The factory caught it as a
  THROW out of a lowering whose contract is `null`.
- ⚠️ **Refuted, twice, by one grep each:** an AST split of `math` (three of twenty FN entries are
  non-derivable SQL facts, §6·4); and "a non-reducing value traversal collects" — `Grouping.convertValueTraversal`
  appends `fold()` for a `ValueTraversal`/`TokenTraversal`/`IdentityTraversal`/`ColumnTraversal` ONLY
  (`.../step/Grouping.java:92-101`), so `group().by(k).by(__.constant(1))` is `{j:1}`.
- ⚠️ **A map is a VALUE, so re-entering one is `json_each` and nothing more exotic.** The pairs array
  `[[keyNode, valNode], …]` was chosen so a key could be non-string and the entry order could be OURS to
  state; it paid a second dividend when the tail landed, because both sides are addressable BY POSITION.
  One wall wearing four names fell at once — `select(Column.keys|values)`, `unfold()`, `count(Scope.local)`
  and every global row op.
- ⚠️ **`Column` is ONE token with TWO hosts, which is why there are two loops.** Over a Map, `Column.keys`
  is a `LinkedHashSet` and `Column.values` an `ArrayList` (`gremlin-core/.../structure/Column.java:22-47`),
  so the KEY side frames as a SET (`data/Set.feature:47-56` pins `s[name,age]`); over a `Map.Entry` the same
  token is the SIDE ITSELF (`Column.java:26-29`). A `mapEntry` framing arm is its own arm because there the
  two sides are their own COLUMNS — which is the WIRE's own distinction too (`MapEntrySerializer`,
  TINKERPOP-3104), so this taught the algebra to produce rows the framer already read (§6·3).
- ⚠️ **The two map PRODUCERS differ by superclass, never by shape.** `GroupStep extends
  ReducingBarrierStep<S, Map<K,V>>` against `PropertyMapStep extends ScalarMapStep<Element, Map<K,E>>`, both
  carrying `Map<K,V>` — so `valueMap()` needed no new shape and no new framing arm, only a second caller of
  the pairs encoding. A VERTEX key is MULTI-VALUED (its value is a LIST) and an EDGE key's is the value
  itself (`PropertyMapStep.addElementProperties`), the asymmetry `vertexProps`/`edgeProps` already carry.
- ⚠️ **EVERY value side is a self-describing `{t,v}` node, TOKENS INCLUDED** — that is what keeps `valOf` at
  ONE `MapOf` arm instead of needing a "mixed" one, and therefore what makes `select(Column.values)` after a
  `valueMap()` describe what is actually there. `T` is a WIRE TYPE, not a string: `FrameNode` grew a `T` arm
  (one line in `frameTypedNode`, the same shape as its `vertex`/`edge` arms), deliberately NOT a
  `CanonicalType` — a token is never a stored property VALUE, so it belongs to the READ vocabulary only.
- ⚠️ **THE GROUP BARRIER HAS THREE HOSTS AND ONE LOWERING.** A scalar stream needed only a CALLER
  (`byNode`'s scalar arm already tagged the value); a bare `group()`/`groupCount()` keys by the ELEMENT
  with the ROWID as the `GROUP BY` and `elementNode` building the entry off it — once per SURVIVING
  group, so SQLite hashes an integer rather than a JSON document per row. Both declines had stopped
  being true before they were removed: one said the caller did not exist, the other was written before
  an element could be a MEMBER of the typed tree. **Read a decline's REASON, not its date.**
- 🔴 **A STATIC TYPE MUST RIDE ON THE SCALAR HOST — leaving it off was a wrong ANSWER.** A static tag
  is a per-row `vtype` constant-folded, so an untagged group key made
  `inject(777).asNumber(GType.BIGINT).groupCount()` frame an Int: untagged means "infer from the JS
  value", which cannot tell a BigInt from an Int, a BigDecimal from an Int or a datetime from a long.
  Three corpus traversals framed the wrong TYPE with the right value, and only `sql-hygiene`'s
  byte-level comparison saw it. §6·7 at one more carrier.
- ⚠️ **A SHAPE THAT FRAMES CORRECTLY AT THE WIRE CAN STILL BE WRONG TO RE-ENTER**, and that is now
  twice in this family. An element-keyed map's blob holds `{t:'vertex', v:{…}}`, which the typed framer
  walks at any depth — but `select(Column.keys).unfold()` decodes it into the SCALAR vocabulary, whose
  framer emitted the payload as a JSON STRING. `MapOf`'s `elem` arm on the key is what turns that into
  a DECLINE; the wire still sees `scalar`, because the two vocabularies answer two questions.
- ⚠️ **`valueMap` and `elementMap` are ONE producer with THREE facts different**, which is the
  `group()`/`groupCount()` relationship again: the tokens (optional against unconditional), the value
  arity (a LIST per vertex key against FLAT, and `map.put` overwriting means the flat form keeps the
  key's LAST value), and an edge `elementMap`'s `Direction.IN`/`OUT` endpoint maps
  (`ElementMapStep.getVertexStructure`). `Direction` joined `T` as a `FrameNode` arm; the nested
  endpoint map needed nothing new, because the tree is self-describing at every depth.
- 🔴 **AN EDGE `valueMap()` VALUE IS THE VALUE, NOT A LIST — and both spines had it wrong.**
  `PropertyMapStep.addElementProperties` collects into a list only `if (isVertex)`. The corpus pins it
  decisively though indirectly: `integrated/SubgraphStrategy.feature:713-724` asserts
  `outE().valueMap().select(Column.values).unfold()` yields `d[5].i`, which it could not if the value
  side were `[5]`. §12's rule with a sharpened witness — one of the two agreeing implementations was
  a RelIR expectation written two hours earlier in the same session, which made it no better evidence.
- ⚠️ **A ZERO-LABEL VERTEX HAS NO `T.label` ENTRY under the single regime**, which is a filter on the
  token ROW rather than a null inside it (`addIncludedOptions` puts the label only
  `if (!label.isEmpty())`; the multilabel twin pins `s[]`, present and empty). Our `label()` answers
  `DEFAULT_VERTEX_LABEL` there, which is right for the scalar step and the wrong ENTRY here — one
  value answering two questions.
- ⚠️ **The LABEL REGIME is a settled value the lowering must be HANDED (§6·6 again).** It is not derivable
  from `labelCardinality` inside the algebra — `with("multilabel")`/`with("singlelabel")` overrides the graph
  default — so a lowering that re-derived it would render one name where a vertex holds a set.
- ⚠️ **A shared `format` bug both spines agreed on.** The reference's pattern is `(?<!%)%\{(.*?)\}` and **the
  lookbehind is an ESCAPE**; each spine carried `%\{([^}]*)\}` and read `%%{name}` as a reference — a wrong
  answer with the right arity that neither the differential nor the census could see. Only the reference is
  not blind.

🔴 **Divergences left standing deliberately** (recorded, not reconciled — each is a human call if it ever
matters): a `by()`-less `math("a + b")` over labelled values ANSWERS on RelIR where legacy throws; an EMPTY
`fold()` frames as one empty list; `fold().unfold().values("name")` keeps traverser order where legacy answers
alphabetically; the retyping two-arg `choose` and MIXED ELEMENT KINDS in a variant.

✅ **One of those "divergences" was a DROPPED FIELD, and the way it read as a semantics question is the
lesson.** It stood here as *a projected collection folds BARE rather than typed — a TYPED list of nulls
emits nothing where a BARE one emits null, a question about `MaxLocalStep`, not about collections.* Both
halves were wrong. `typed` was a CONSTANT `ListOf`, so claiming the type REPLACED the descriptor and took
`productiveNull` with it — the flag saying a NULL member is a real value; the observed behaviour change was
that field falling out, and nothing about `MaxLocalStep`. And the reference answers the question outright:
`Operator.max` over an all-null input reduces to null (`NumberHelper.max` returns the non-null side, null
when both are null) and `ReducingBarrierStep` has seen starts, so `MaxGlobalStep` emits ONE null traverser;
`MaxLocalStep.processNextStart` splits on the same null and skips only an EMPTY collection. **A recorded
divergence whose justification is a question we did not ask the reference is not a divergence — it is an
unread citation** (§12's rule, with the twist that the blind spot was a vocabulary rather than an argument:
a list member's type was spelled in a second, lossier channel than a row's, so nobody thought to ask). The
whole family landed once `ListOf` took the same `ScalarType` a row carries: see "the MEMBER TYPE CHANNEL"
below.

🔴 **A BARRIER EMITS ONE TRAVERSER, and legacy contradicts ITSELF one shape over.** A global `count()`
after `group()` is 1; only `count(Scope.local)` is the map's SIZE (`GroupStep extends
ReducingBarrierStep`, `gremlin-core/.../step/map/GroupStep.java:51`). Legacy answers the LOCAL reading
under the GLOBAL name — making the two spellings indistinguishable — while both spines already answer 1 for
`fold().count()`. Recorded as `RELIR_AHEAD`. Two more of the same class, both now pinned per-spine: a
non-matching `is(typeOf(…))` over a map is the EMPTY RESULT rather than a refusal
(`data/Set.feature:38-43`), and slicing ONE traverser yields it (`group().by(k).limit(2)`).

🔴 **THREE MORE COMMITTED ASSERTIONS HAD ROTTED IN THE LEGACY POSITION**, found by the map loop routing —
the same class the option-map increment named. When a family starts routing, every assertion about it was
written while ONE spine owned it: pin the claim AT the spine it is about, or re-derive it.

🔴 **TWO COMMITTED L4 EXPECTATIONS ENCODED LEGACY'S BUG** (an unproductive choice takes `Pick.unproductive`,
the traverser itself — not `Pick.none`; the official corpus pins the pattern at `Choose.feature:371-387`).
**An addendum written against one implementation records that implementation, not the reference** — every L4
scenario in a family the migration touches is worth re-deriving from `gremlin-test`/`gremlin-core` rather than
trusted. Nobody has swept the rest.

🚧 Two `sack` declines remain, both honest: `withSack(seed, Operator.x)` names a MERGE operator (a third
policy answer for the role — a channels-core change, not a step lowering), and `barrier(Barrier.normSack)` is
its own step.

- ⚠️ **A MAP IS A SCOPE, consulted BEFORE the path labels** (`gremlin-core/.../step/Scoping.java:119-135`
  — `object instanceof Map && containsKey(key)` is the FIRST test, then side effects, then labels). So
  `select(<key>)` is the map loop's answer, and `containsKey` is not "the value is not null": presence
  is an `EXISTS` and the value its own extract, which is the `present`-beside-the-value split the
  option-map `choose` needed, at a third seam.
- ⚠️ **AN UNRESOLVABLE `select()` KEY IS THE EMPTY RESULT, NOT A DECLINE** (`Select.feature:578-596`),
  and the guard is where being empty would be WRONG: `getScopeValue` tries the traverser's SIDE EFFECTS
  before the labels, so a `withSideEffect` constant or a named collection resolves with no `as()`
  behind it. The chain context answers that, because the record builder holds the alias map and nothing
  else.

🚧 **A PLAN-SIZE WART worth one commit, spotted while reading the emitted SQL:** `byNode`'s property arm
builds `typedNode(storedValue(…), vtype)` and `typedNode` applies `storedValueOn` AGAIN, so every
property-keyed group emits the collection CASE nested inside itself. `json(json(x))` is idempotent, so it
is bytes and not an answer — but it is bytes in the hottest key expression there is.

- ⚠️ **THE GROUP-SCOPED REDUCER IS A POOL, AND IT MAY NOT BE A DECOMPOSITION TABLE.** `GroupStep` applies
  the value traversal's PRE-BARRIER part per traverser and lets the BARRIER reduce what EVERY member of a
  key contributed (`Grouping.determineBarrierStep`). `sum`/`min`/`max` happen to agree with
  per-parent-then-outer-reduce and `mean` does not, and a rule right for three reducers and wrong for the
  fourth is the defect class the decline contract exists to prevent.
- ⚠️ **THE `origin` CHANNEL IS MINTED, and it is the mechanism** — `src/channels.ts` had modelled the role
  since the channel core landed and nothing built it (`sack`'s position one increment earlier). A JOIN keeps
  CHANNELS and drops payload (§3.5), so one `int` naming the parent rides through every hop with NO
  per-step change and the key is re-read off it. A correlated relation could not serve: SQLite has no
  `LATERAL`, so the correlation becomes the join's `ON` — which the ordinary fold's movements already build.
  `ChildSeam`'s FOURTH answer (`rows`) is what an `order().by(<reducer>)`, a collection's value reducer and
  the per-origin reducer after a branch all want too.
- 🔴 **TWO CORRECT RULES MADE A WRONG ANSWER, and only the byte differential saw it.** The sub-fold was
  handed `NO_ALIASES`, so a body reading a label found none — and since an unresolvable `select()` had just
  become the EMPTY RESULT, it pooled ZERO rows and answered an empty map instead of declining. §6·6's "check
  what a seam HANDS OVER" at its sharpest: neither rule was wrong, and their composition was.
- 🔴 **SQLite WRITES A REAL INTO JSON WITH 15 SIGNIFICANT DIGITS**, so every JSONB-carried collection loses
  an inexact double — `Mean.feature:70` wants `d[0.3333333333333333].d` and a blob carries
  `0.333333333333333`. **BOTH SPINES ALREADY HAVE THIS** (`g.inject(1).math("1/3").fold()` is lossy on
  each), which is why it went unseen; it becomes a DIVERGENCE only where one spine computes in a ROW and the
  other into the blob, which is why the group-scoped `mean` declines. The fix is to carry an inexact real as
  decimal TEXT under its tag — the carriage the exact tail already has for a big long — and it is worth
  doing for its own sake, not for the group.
- 🚧 **The empty pool is PER-REDUCER and decides INNER versus LEFT join**, which is why `count()` with a
  non-empty body still declines: `CountGlobalStep` seeds 0 so a member whose body produced nothing must
  still count 0 and keep its key, where `SumGlobalStep` leaves `NON_EMITTING_SEED` and the key goes with the
  traverser. A SCALAR host also stays out of reach — `origin` is typed `int` and a value stream has no rowid
  to name its parent by, which is a channels-core change.

🚧 **What else the MAP family owes:** the SELECTIVE token subsets (`with(tokens, ids)`, which
`absorbValueMapWith` deliberately leaves in place to fail closed) and the `by(__.unfold())` that pairs with
them (a `by()` on a `valueMap` projects each map VALUE and removes an unproductive key —
`applyTraversalRingToMap`); `order(Scope.local)` over a map's entries; and the element-keyed side reads,
which need a list whose members may be ELEMENTS (today `MapOf`'s `elem` tag makes them decline).

🚧 **Then the rest of Phase 2:** the scalar-transform tail (49, but heterogeneous — mostly literal-typed
casts and error-raising forms rather than one lowering), the rest of the property shape (`properties()`
re-entry), branch, aliases, `local`, `match`, `where`, `path` tails, and the by()-child matrix
(`group`←reducer, `select` multi-label — `byField()`'s next callers).

### 🔴 Phase 3 — `repeat()` — THE GATE

The one family whose absence disqualifies the server, so deletion waits on it and on nothing else.
`flatten` (P1 legality in `check`; a body that cannot be made legal throws a clear deferral) → route
`repeat()`'s body through ordinary lowering → `unroll` for `times(n)` (take `dedup` first, one barrier per
commit with an L4 pin; `prune`'s remainder — pruning below Join/Union/Aggregate — is a precondition).

🔴 Per P4 that covers the 48 `times(n)`-bounded majority; **the 5 `until()`/`emit()` barrier bodies hit the P3
wall and are not expressible in any lowering.** That deviation needs accepting, not engineering.

Phase 4's read-side work rides along where it is a prerequisite: the block assembler replaces `TailAcc`,
`ELEMENT_DISPATCH` joins the shared substrate, aggregate/count handlers become one `Aggregate`, and
`recognize` (§4.7) makes the fast paths plan rewrites, which lifts the FTS decline.

### Phase 4 — `rm -rf src/compiler/steps/`

Phase 0 severed the graph and Phase 3 clears the gate, so this is a deletion, not a migration. Sweep
SYMBOL-level, not file-level (`bun scripts/refs.ts`, `mise run orphans`) — a file-level closure over-counts.
Everything legacy still answered on the day becomes a clear deferral, NOT a blocker. The routing switch,
`options/spine.ts`, `MOGWAI_RELIR`, `test:legacy-spine`, the `legacySpine` L3 floor with
`unionPassing`/`partitionLegacyRegressions`/`spineGap`, the census's legacy pinned position, `relirAhead` and
the per-test `{spine}` pins all go with it.

### Phase 5 — the docs sweep

Most of `docs/` was written against a two-spine world and will be lying by here.

1. **Archive every plan that only describes the old pipeline** — move to `docs/archive/`, do not edit in
   place. A plan whose subject no longer exists is history, not a stale plan.
2. **Edit every plan that PARTLY survives down to what still applies.** Delete the superseded half rather than
   annotating it. This file included.
3. **Sweep the citations** — code comments and `scripts/deletion-ratchet.tsv` notes cite `§`-numbers and old
   phase names; a deleted section must not leave a dangling reference.
4. **Then, and only then, refresh `docs/feature-support-matrix.md` and `docs/outstanding-work.md`.** Doing
   these before the sweep records a world that is about to change.

### §10·6 🚧 Correctness follow-ups — orthogonal to the phases

Each cited, corpus-mostly-invisible, none a one-liner. Rank them against phase work, do not queue them behind
it.

- **The per-row scalar type channel's LAST site (§6·7)** — `AliasScalarType`/`aliasScalarTypeOf`. The
  reducer and the list MEMBER both landed; this is the only coarsening left, and the `ListOf` cutover is
  the worked example to copy (one total union, coarse views derived, a NAMED preserving rebuild so a
  re-tag cannot drop the fields the tag is not).
- **The `set` framing marker** survives `range(local)`/`all`/`any`/`none` and is dropped only by
  `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop, which is
  duplicated (`rel/list.ts`'s `ListOf.set` vs legacy's `ListStream.set`). Land it in RelIR and let legacy shed.
- **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type today) — needs head-position tracking on the RelIR `AliasEntry`.
- **Checker hardening (Phase 3 prereqs):** refuse `Distinct`/`Limit`/`Sort` inside a recursive term (P3); a
  whole-row `Distinct` may not carry a per-row-unique channel; an `aggs` entry may not reference an input
  column outside an `Agg`; `name` should walk expression subplans (a shared node in a `Scalar`/`Exists` body
  is inlined twice).

---

## §11. Open design decisions — NONE OPEN

Decided and recorded as laws; the section stays so the §-numbering (code comments cite §12) does not move.
Re-open one only with evidence, not with a preference.

1. ~~Exact-type literal framing~~ → **§6·7**. The tag table was the wrong lever; the missing per-row carrier
   was the defect.
2. ~~Phase 1's `property` residue~~ → **§6·5** + **§6·6**: a text-level refusal, a constant not handed over, a
   correlated scalar the seam already builds, and a graph-dependent refusal that becomes a guard binding.
3. ~~The numeric-tower PROMOTION rule~~ → **§6·7**, resolved by NOT building it. The rule is real
   (`NumberHelper.getHighestCommonNumberInfo`) and reproducing it changes no answer Gremlin can be asked while
   costing a sort plus an O(N) sorter on every sum narrower than 64 bits. Preserve the wire type through
   pass-through; let SQLite's storage class govern arithmetic; never narrow; never leave the Number family.

---

## §12. ⚠️ Traps — each cost a real defect, none found by reading

**The decline contract.** `null` is the ONLY decline and must stay cheap and total — a partial lowering that
silently drops a filter is invisible to the differential. A module whose contract is `null` must not let a
throw escape. **A fast path is never silently dropped** (`has(k,containing(t))` routes the trigram index; it
DECLINES until §4.7). **Never let the two spines answer the same traversal DIFFERENTLY on purpose** — not the
same demand as parity: RelIR answering where legacy declines is legal, recorded, expected. **A decline is only
right when the OTHER spine is right**: four "answer where TinkerPop raises" findings were kept because legacy
answered identically wrongly and declining bought zero correctness.

**Before reproducing a reference distinction, ask what a client can SEE.** Three bands: it changes the VALUE →
build it; it changes the decoded CLASS across a boundary every GLV has (Number ↔ BigInt/BigDecimal/Date/UUID/
string, scalar ↔ Array/Set/Map) → build it; it changes only the GraphBinary TAG inside a band every GLV
collapses → do not build it, document the deviation. Band 3 is never a reason to DISCARD upstream (§6·7 —
carriage is cheap); only a reason not to build machinery downstream to RECONSTRUCT what nothing can observe.

**Wrong answers with the right arity** (the class no ladder level sees):

- A non-derivable fact must not be re-implemented (typed inject tags, `JAVA_WHITESPACE`) — call the one
  authority. A second implementation is a second chance to get it wrong.
- A type ASSERT is not a predicate (`is(typeOf(LIST))` RETYPES; as a filter it returns right rows framed
  wrong). A parse that must RAISE cannot be a `CAST` (`asNumber('1,000')` must raise, not answer 1).
- A dedup must not distinguish rows by MULTIPLICITY; a survivor stands for itself.
- `count()` is not SQL — an `Agg` with no args means "over all rows". A `Lit` cannot express a REAL literal
  whose value is integral (JS `1.0` IS `1` → integer division) — use an explicit `Cast`. `values(k…)` reads
  EVERY key, not `args[0]`.
- Comparison across type spaces (a range predicate, `min`/`max`) must gate on type-space agreement; reducer
  eligibility/order goes through `storedCompareOn`, not SQLite storage class.

**Order and determinism.** Deterministic, not merely ordered — `ROW_NUMBER() OVER (ORDER BY encounter, id)`
needs the tie-break, and the tie-break is the caller's argument. Mint the emission order ONCE over a whole
fan-out, never per arm. A sort SUPERSEDES the arriving order, so re-MINT where a position is carried. A
correlated hop threads no order. Collapse and emission order are MUTUALLY EXCLUSIVE. A non-deterministic
ordering expression (`RANDOM()` for `sample`) must never sit in a slot the assembler can inline — rank in a
window and filter. Slice tests compare against legacy row-for-row UNSORTED and must pass under
`test:perturbed`.

**Structure and plumbing.** A chain-level requirement (path/encounter demand) must be computed over the WHOLE
chain, at the point the chain is identified. Pass the input's channels THROUGH; never name a list. A clause
reader (`WHERE`/`ORDER BY`) that reads a select alias needs a `Materialize` fence (only the FIRST reader). A
window may not read a windowed column — the ASSEMBLER closes the block. A bind-budget overrun is a DECLINE at
the routing seam, not a throw — and the gate must RENDER (IR occurrence counts differ from the rendered bind
list up to 2×). Relation ids are minted PER LOWERING (a module-global counter makes two compiles emit
different SQL); a replicated subplan (`unroll`) must carry FRESH ids, and WITHIN one compile the minter is
shared/injected. A `Project` over a whole-relation `Aggregate` (empty `groupBy`) that reads none of its
outputs ERASES the aggregation — the emitter blocks it (Calcite's `fieldsUsed.isEmpty()`).

**A non-derivable "reference says X" question goes to the vendored source, cited at the pin.** The `.feature`
corpus says WHAT; `gremlin-core` says WHY and covers cases no scenario names (a reducing barrier's zero-row
emission is per-step, decided by whether it supplies a seed — `group`/`fold` emit `{}`/`[]`, `sum`/`min`/`max`
emit nothing). When two comments in this repo cite one feature file for opposite behaviours, the resolution is
IN the file. **Agreement between the two spines is not evidence of correctness — it is evidence of a shared
cause.**
