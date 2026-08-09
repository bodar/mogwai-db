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
  `until()`/`emit()`**. → the IR-level `times(n)` unroll is the majority route; the wall is 5.
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
- **Statement text.** DO caps at 100 KB, enforced by `cfLimitViolation` at the end of the RelIR spine. The
  producer that can exceed it is the `times(n)` UNROLL, which now happens above the IR (Phase 3 step 4), so
  the ceiling belongs to that pass rather than to a Rel one.

---

## §4. The passes — all `Rel → Rel`, total, order-declared

Structure is declared ONCE in `src/rel/walk.ts` (no `default` arm anywhere), so `noImplicitReturns` makes a
new kind a compile error. Rewriting is memoised, so the DAG stays a DAG.

⚠️ **Call this tier `rewrite`, not `Pass` (§6·5).** `Pass` names the `Step[]→Step[]` pipeline in
`ir/passes.ts`, which runs ABOVE the routing switch; these run below it. Load-bearing: a refusal raised here
would be a throw out of a lowering whose contract is `null`, and legacy would never see the traversal.

- **`check`** — the fail-closed verifier (column resolution, `Agg`/`WindowExpr` placement, §3.5 obligations,
  both §3.6 budgets). Always on in dev/tests. Its SQLite laws about "this SELECT" are answered by the shared
  block analysis (`src/rel/block.ts`), which is also the emitter's own fusion rule table — one definition, so
  the checker cannot admit a plan the emitter then wraps.
- **`name` (§4.6)** — named CTE vs inlined derived table for every shared node, honouring `Materialize`. The
  ONLY pass with a production caller (`lower.ts`).
- **`prune` (§4.5)** — column pruning. Phase 3 prerequisite: a walk carries only what its body and its
  consumer read.
- **`land` (§4.5b)** — the bind-budget lowering (an over-budget `Values` → one JSON bind).
- **`fuse` (§4.4)** — small semantic rewrites. Ask which still buys anything the assembler doesn't before
  wiring it.
- 🚧 **`flatten` (§4.2)** *(Phase 3)* — join flattening / decorrelation into the P1 envelope. Deletes
  `expandRepeatBody`. Most of it dissolved into the legality ANALYSIS (Phase 3 step 2a).
- ⛔ **`unroll` (§4.3)** — **WITHDRAWN**, restore point `9e0e307`. `repeat()` is a two-regime family;
  `docs/2026-08-09-repeat-two-regimes-plan.md` is its plan. `src/rel/mint.ts` keeps `minter` alone, for `seek`.
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

⚠️ **Those two positions measure the DIFFERENTIAL, never the CUT, and the distinction has no proxy.** Both
runs may fall back to legacy, so the `legacySpine` floor proves only *routed ≥ all-legacy* — it cannot say what
deleting legacy costs. The third position (a RelIR decline FAILS rather than falls back) is the one that can,
and it is Phase 3's leading item for that reason.

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
- ✅ the **ALIAS channel** — `AliasScalarType` is gone. It was the last place a scalar type was
  described in its own words, invented because a history entry has no relation COLUMN to name; the
  `envelope` carrier is what that actually is, so the union absorbed it. **§6·7's site list is now
  empty.**

**THE OPTIONALS THEMSELVES WERE THE DEFECT GENERATOR, and the fix is totality rather than a fifth
guard.** Three times a descriptor lost a field on a re-shape and three times the answer was a new
bespoke preserving rebuild (`rebuildScalar`, then `withMemberType`, then `typeCarriedBy` + a local
`numeric`). A CONVENTION cannot be the protection when the failure mode is forgetting. Every
descriptor field is now REQUIRED — `ListOf`/`RelFraming`/`GroupKey`/`MapEntry`/`PathPos`/`Shape`, and
`ScalarType.static.text` — so omitting one is a type error rather than a code review. 89 sites had to
state what they had been leaving unsaid, and the test assertions are the half worth having: a shape
assertion that omits a field stops witnessing it. Two silent gaps fell out immediately (below).
- 🚧 the **variant payload** has no `vtype` column, so a variant arm declares a STATIC tag or `UNKNOWN`.
  Carrying `perRow` there needs the framer to read it, i.e. a wire change.

✅ **The first defect totality surfaced was legacy's GROUP KEY**, and it is the argument in one case.
`groupCount().by('when')` keyed on raw MILLIS and `by('uuid')` on a String — the arm emitted `gk`
alone, so the property's stored `vtype` had nowhere to ride and the key framed by JS inference, with
the VALUES and the entry COUNT both right. `GroupKey.scalar.type` had been OPTIONAL and the producer
simply omitted it; an omission reads as "no opinion" rather than "framed wrong", so nothing could
tell them apart. §6·1 would say SHED, and that is not available here (see the group-value gap below),
so the tag is carried — `gkt`, the column RelIR's own barrier already picks.

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
| legacy-OFF L3 + census (Phase 3) | the same corpus blindness as L3 — and it measures the ROUTE, so a shape the algebra EXPRESSES but nothing HANDS it (§6·6) reads exactly like a missing lowering |

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

**The cut:** delete the write route, `steps/write/write.ts`, and the write half of the differential.
Phase 1 is NOT on the critical path — Phase 3 (`repeat()`) is the gate — so rank the residue by cost
per scenario, not by fear of the cut.

⚠️ **MEASURE BY TURNING THE ROUTE OFF, NEVER BY READING THE CODE, and do it every round.** Stub
`routeWrite` to `null` behind a local env switch, run L3, replay each blocked traversal through
`lowerToRel` prefix by prefix: every one names the step it stops at. The first run's ranking disagreed
with the prose — `labels()`, a READ, was holding the entire label-write family, and no amount of
reading the write module could show it.

✅ **Landed:** `MODERN_SEED` and 127 of 131 corpus initializers compile whole (the corpus LOADS without
legacy writes) · `labels()` · `dropLabel`/`dropLabels` · writes over a SCALAR stream · endpoint-less
`mergeE` · a `T.label` on `mergeV`'s `onMatch` · the merge-map key rule and the write-argument parse
moved into a `verify` Pass · `inject()` left the dispatcher (it is not a write; it was 543 of the
route's 944 traversals). Two of these were WRONG ANSWERS rather than gaps and both spines agreed about
one of them (§12).

🚧 **WHAT IS LEFT — 30 scenarios, measured 2026-08-08 with the route off**, ranked by cost per
scenario. (The doc previously said 47; the landings above plus multi-label-only moved it.)

| n | Item | Size | Compounds |
|---|---|---|---|
| 3 | **Label mutation on an EDGE** — `addLabel`/`dropLabel`/`dropLabels` on `g.E()`. A pure SYNTACTIC refusal: TinkerPop fixes edge label cardinality at exactly one, so unlike the immutable-graph cases this needs NO `LabelCardinality` in the Pass tier. Straight into `verify` with no new input. | XS | no |
| 10 | **`property(k, <traversal>)` with a possibly-multi-row VALUE.** Rules off `AddPropertyStep` (`.../sideEffect/AddPropertyStep.java:105-199`), none guessable: 0 results → NO mutation (never a NULL write); >1 under `single` → *"Single-cardinality property requires exactly one value, but traversal produced N results"* (a GUARD BINDING); >1 under `list`/`set` → each written. The single-argument MAP form is a third case (`mapForm`). | M | **yes** |
| 5 | **`T.id` on `mergeV`/`mergeE`** — the onCreate-inheritance scenarios. `elementIdGuard` exists; the `Insert` column plumbing does not. | S | no |
| 5 | **Runtime / computed LABEL** — `addV(constant(…))`, `addV(__.select('a').label())`, and the `addLabel`/`dropLabel` collection forms. `ElementHelper.validateLabel` is three PURE predicates, so all three are a GUARD BINDING and not a decline: one statement instead of O(rows) round-trips. ⚠️ **The message set depends on ARITY** — `addV(single)` gives the three `Label can not be …` messages; `addV(a, b)` IS a Collection and `AddVertexStep.resolveLabelCollection` (`.../map/AddVertexStep.java:165-182`) raises FOUR others BEFORE `validateLabel` runs. Build: `internLabels` from `string[]` to EXPRESSIONS, a rooted single-row label through the seam, an ALIAS-read label, and the arity-chosen guards. | M | **yes** — the same generalization serves a computed property KEY and edge label |
| 2 | **A meta-property under an UNDECLARED cardinality** — the `set` arm PATCHES rather than inserts, an `UPDATE` this route does not emit. | S | no |
| 5 | **Singletons** — `addE` after `addE` in one chain, `addInE`, `property(null)`, `property(set, null)`. | S each | no |

⚠️ **`property(k, __.trav)` IS NO LONGER "NEW SUBSTRATE" — the seam it wanted EXISTS.** It needs the
child body applied to the whole owners relation at once carrying the owner key, which is
`ChildSeam.rows` (§6·6's fourth answer) plus the `origin` channel, both built in Phase 2 for the
group-scoped reducer. What is left is the CONSUMER: an `Insert … SELECT` over those rows, the
cardinality rules, and the multi-row-under-`single` guard. It is also Phase 4's `local`/`properties`
shape, which is why it is the one item here that compounds forward.
⚠️ **The reference is ASYMMETRIC and that decides the shape of the work**: a nested KEY or LABEL
resolves through `TraversalUtil.apply` = `.next()` = the FIRST result, which is the seam's existing
`scalar` arm and needs nothing new. Only a possibly-multi-row VALUE wants the rows.

⚠️ **Where a refusal is arithmetic over the INPUT's row count, a host that cannot count statically
needs a GUARD, not a decline.** `addV` proves single-row at COMPILE time (its one-row case is a literal
`Values`); an `addE` mid-chain input is a traverser relation and nothing static separates `g.V(1)`
from `g.V()`.

🚧 **The label TYPE refusal — inside the computed-label row above, never before or after it.**
`validateLabel` takes `unknown` and coerces (`String(label)`), so a label of `5` is written `"5"`.
⚠️ **The reference does not raise there either** — `validateLabel(final String label)`
(`gremlin-core/.../structure/util/ElementHelper.java:64-71`) is TYPED and its three checks are
exactly ours, so the gap is a missing guard at the CALL SITES and the raise is per-site — NINE
messages (`MergeElementStep.java:259-305`, `AddVertexStep.java:165-182`, `ElementHelper.java:258-283`).
Strictness therefore leaves the `labelNames` waist for the sites, which already carry `step`/`sole`.
⚠️ One question has THREE answers today: `mergeV([(T.label): x])` coerces on BOTH spines,
`g.addV(x)` declines on RelIR (`rel/write.ts:1229`) and coerces on legacy, `addLabel(x)` coerces
(`:631`). All reachable — `stringArgument : stringLiteral | variable`, so a PARAMETER bound to a
non-string is grammatical. That decline is §6·5's conflation, and guards beside a surviving coercion
would answer one question two ways depending on whether the value was static.

✅ **DECIDED — the `- found: %s` tail names a GREMLIN type (`CanonicalType`), not a Java class**, and
the tail ONLY (the prefix is fixed prose; the tail is the one place upstream reflects a live Java
object). Measured: the corpus asserts on none of these messages, so nothing is paid for it. The guard
arm settles the vocabulary — it can name the offending value only by its per-row `vtype`, which IS
`CanonicalType` (§6·7), so one name serves both arms.


### Phase 2 — ✅ the extracted families; what is LEFT

✅ Landed: `sack` · `math` · `format` · the ELEMENT-membered list · the NAMED-COLLECTION substrate ·
`union()` in SOURCE position · the VARIANT · the OPTION-MAP `choose` · the MAP LOOP ·
`valueMap()`/`elementMap()` · the group barrier at all three hosts · the GROUP-SCOPED REDUCER (and the
`origin` channel) · `order`/`dedup(Scope.local)` · **both GROUP-VALUE shapes** (a group-scoped
`count()`, `by(__.tail())`) · **the MEMBER TYPE CHANNEL** (§6·7's list arm, and with it the total
descriptors below).

⚠️ **RELIR HOLDS BOTH GROUP-VALUE SHAPES NOW** — the two the type-channel work measured as pinning
legacy's group key (34 tests, an L3 scenario, a conformance-host gate), so that key is shed-able on
the evidence that made it un-sheddable. A group-scoped `count()` KEEPS its key where every other
reducer loses it (`CountGlobalStep` seeds 0 while `SumGlobalStep` leaves `NON_EMITTING_SEED`), and a
LEFT join is neither available — the fold's movements are inner joins by construction — nor needed:
one SEED ROW per parent at weight ZERO is the same answer under the same `GROUP BY`. `by(__.tail())`
is the collecting arm plus one `$[#-1]`, because `TailGlobalStep(1)` keeps the last traverser to
arrive and the members' encounter order is what that aggregate already states.
🔴 **`by(__.tail())`'s lowering landed inside `a5bc7f3`, whose message reads as tests-only.** Its
measurements are accurate (tail is exercised by our own tests and the conformance-host gate, not by
the corpus or L3, so neither number moved) but the feature is not named there. Recorded here rather
than rewritten, because trunk is shared.

#### 🚧 What is left, ranked

`mise run rel-blockers` once the map family closed — the scalar-transform tail (53, heterogeneous:
mostly literal-typed casts and error-raising forms rather than one lowering), branch (41 — `choose` 20,
`union` 14), row ops (41 — `order` 20, `dedup` 12, now the ELEMENT-list and `Column`-keyed forms),
aliases (32 — `select` 27, dominated by `Pop.all`/`Pop.mixed` history reads), the rest of the map shape
(24), side effects (21), then `local`, `match`, `where`, the `path` tails.

⚠️ **RANK OFF THE CUT, AND FILTER IT ON "THE ROUTE ANSWERS" — `rel-blockers` counts three populations
as one (§6·5) and the filtered ranking is a different list.** A ~40-line throwaway that reruns the
prefix scan and asks `compilePlan(q, {}, {spine:'legacy'})` whether legacy compiles it at all splits
the 811 blocked corpus traversals into 436 REAL GAPS and 375 that no route answers (our deferrals plus
TinkerPop's own refusals). Measured 2026-08-09: the plain counter led with the scalar transforms at 53;
the filtered one leads with `match` 47 · `local` 46 · row ops 30 · `is` 26 · branch 22 · `has` 20, and
it surfaced a cluster the per-step table hides entirely — the FILTER FAMILY over a value stream
(`and` 10 · `or` 10 · `filter` 9 · `not` 5 · `where` 8), which was 42 gaps of one lowering. All of it
was element-only for a SIGNATURE reason rather than an algebraic one (`Subject` carried an `Elem`
beside it), so `Subject` became a total union over the traverser shape exactly as `ChildHost` already
was, `is(P)` joined `sourceFilter` beside the connectives, and `where(P)`/`filter(P)` with no body
became `is(P)` guarded by the live alias map. Landed alongside it: an IR Pass stating that a
per-traverser host over a STREAM-IDENTITY body IS that body (`local(__.aggregate('a'))` is
`aggregate('a')`, and so are the `map`/`flatMap` spellings), and a wrong ANSWER the new position
exposed — `ordered()` took the bound's VALUE and not its declared type, so a `datetime`/`duration`
bound tested the plain numeric vtypes and answered FALSE for a comparison the reference performs.
Session total: the CUT 558 → 502, census coverage 1026 → 1120 (48.7%).

✅ **THE OVERRIDE IS SPENT — gap 4's element-keyed side reads LANDED, and `mise run L3:rel-only` now
reports: 1130/2260 against the default position's 1761.** Every ranking below can finally be read off
the cut itself rather than off a proxy. What the blocker column said (`MapOf`'s `elem` tag declines)
was not what stopped them, and that is §6·6's lesson at a sixth witness: a group KEY never needed an
`elem` side at all. A `project()` key is the RECORD shape collapsed to a map VALUE — the boundary
`record.ts`'s own header already named — so it is one `{t:'map', v:[[k,node],…]}` column and the
ordinary `mapValue` shape. Nothing entered the node set. Three shapes became first-class instead: a
correlated `recordNode` sharing its field loop with `recordOf`; a PROPERTY `ChildHost`, addressed by
its rowid exactly as an element is, so `group()` over a property stream needs no property-specific
reader; and a HOST RE-ROOTING for the steps that yield exactly one traverser by the schema
(`outV`/`inV` off an edge, `element()` off a property), which is what lets
`by(__.outV().values('name'))` be a correlated value where the generic movement arm must refuse a
non-reducing tail. A property also joined vertex and edge in the typed tree (`{t:'property'}`), one
arm over the tuple `framePropertyRow` already read.

Named gaps inside those, each with its blocker stated so it is not re-derived:

| | Gap | Blocked on |
|---|---|---|
| 1 | **Group VALUE forms** — `group().by(k).by(__.out().count())`, `by(__.tail())` | Nothing. Legacy-only today, and they are what stops legacy shedding its group KEY (34 tests, an L3 scenario, a conformance gate) |
| 2 | **Set-op keeps its members' types** — `values('when').fold().merge(…)` returns raw millis | The lossy test must span BOTH sides; `withLossyFlag` asks it of one relation. ⚠️ Gating on the compile-time `typed` flag is NOT the same question and was measured wrong (6 differentials) |
| 3 | **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what `path().by(<transform>)` writes), where a null tag means "infer from the value" everywhere else | Nothing — inert until tags join a comparison, which is how it was found |
| 4 | **Map family residue** — selective token subsets (`with(tokens, ids)`), the `by(__.unfold())` that pairs with them, `order(Scope.local)` over map entries. ✅ **element-keyed side reads LANDED** (above) | The stated blocker for the side reads was wrong and cost nothing to find: they never needed an `elem` map side. What is left needs a list whose members may be ELEMENTS |
| 5 | **Group-scoped reducer: `count()` with a non-empty body, and a SCALAR host** | The empty pool is PER-REDUCER and decides INNER vs LEFT join (`CountGlobalStep` seeds 0 and keeps its key; `SumGlobalStep` does not). A scalar host needs `origin` to name a parent without a rowid — channels-core |
| 6 | **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy for the role, channels-core) and `barrier(Barrier.normSack)` (its own step) | Both honest |
| 7 | **L4 sweep** — two committed expectations encoded legacy's bug. An addendum written against one implementation records that implementation, not the reference | Nobody has swept the rest |
| 8 | **Carry an inexact REAL into JSON exactly** — SQLite's JSON *writer* uses 15 significant digits and cannot round-trip a binary64 (`1/3` returns a different double); the *parser* is exact, so `json(printf(…))` at the JSON entry points is the whole fix | Nothing, but see below |
| 9 | **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself (`typedNode` re-applies `storedValueOn`). Bytes, not an answer, but in the hottest key expression there is | Nothing; one commit |

#### ⚠️ The exact-REAL fix — attempted, reverted, four traps found

Worth doing, and each of these cost a cycle. The shape that works: apply ONLY where precision is
actually lost — `CASE WHEN CAST(printf('%.15g',v) AS REAL) = v THEN v ELSE json(printf('%!.17g',v)) END`
— so every value that already round-trips keeps its exact current text and only the lossy ones change.

1. **It is a JSON-ENTRY rule, not a stored-value rule.** Putting it in `storedValueOn` corrupts the ROW
   path: `values('weight')` becomes JSON text and a later `fold()` quotes it (`["0.5", 1, …]`). It
   belongs in `typedNode`/`collectedArray` and nowhere else.
2. **Gate on the VTYPE, not on `typeof(value)`.** The value can be a whole correlated subquery and the
   guard splices it three times — measured, 69 statement families moved.
3. **`%.17g` drops real-ness**: `1.0` prints `1`, so `1f` came back an `int`. `%!.17g` keeps the decimal
   point but always writes 17 digits, so `0.2` becomes `0.20000000000000001` — same double, different
   text, and every existing REAL's bytes change. Hence the lossy-only guard above.
4. **SQLite's JSON subtype does not survive some `CASE` shapes** — it does survive when the `json()` call
   is the aggregate's direct argument, which is what any fix must rely on.

#### ✅ RelIR follows the REFERENCE; legacy's disagreements are not decisions

There is nothing to decide here, and the list that used to sit in this slot was an artefact of when
both spines were candidates for being right. They are not. **RelIR is checked against
`gremlin-test`/`gremlin-core`; legacy is a route with an end date.** So a disagreement is legacy's,
it is expected, and it earns no work — the previously "standing divergences" (a `by()`-less
`math()`, an empty `fold()`, `fold().unfold().values()` order, the retyping two-arg `choose`, mixed
element kinds in a variant) and the three cited `RELIR_AHEAD` contradictions (a global `count()`
after `group()` is 1; a non-matching `is(typeOf(…))` over a map is the EMPTY RESULT; slicing ONE
traverser yields it) are all the same statement.

The instruments say so too: a framed-answer difference in `sql-hygiene` is TELEMETRY rather than a
failure, alongside the emission-order line it sits next to. The count still prints, so a NEW
divergence stays visible; what is gone is the obligation to make legacy agree.

#### ⚠️ Invariants earned here — re-breaking these costs a wrong answer

- **Every shape DESCRIPTOR is total.** Three times a field was dropped on a re-shape and three times
  the answer was another bespoke preserving rebuild; a convention cannot be the protection when the
  failure mode is forgetting. Omitting a field is now a type error. The first defect it surfaced was
  legacy's group key, which had left `GroupKey.type` unset — an omission reads as "no opinion" rather
  than "framed wrong".
- **A NULL never WINS a min/max and must never be FILTERED.** `NumberHelper.max/min` return the
  non-null side; over an all-null input they reduce to null and the barrier has seen starts, so ONE
  null traverser is emitted. Nulls sort LAST, with an explicit `IS NULL` term (SQLite orders NULLs
  first ascending).
- **An UNTAGGED member is its own compare key** — proved, not assumed: its inferred type cannot
  disagree with its storage order, so the cast folds away.
- **COMPUTE ONCE.** `v` and `vt` are two fields of one winning member; a correlated subquery each
  emits the whole sort twice (1,250 → 4,108 bytes for `max`). On RelIR that needs a FENCE, or the
  assembler re-inlines the pick at both reads.
- **Members stay ROWIDS for their whole life inside the algebra** — only `listPayload` expands them, at
  the ROOT, once per SURVIVING member.
- **The fold happens AT the `aggregate`, not at the `cap`.**
- **Never name a channel list** — derive the aggregates from the channels the input carries.
- **A map is a SCOPE, consulted BEFORE the path labels** (`Scoping.java:119-135`), and `containsKey` is
  presence (an `EXISTS`), not "the value is not null". An unresolvable `select()` key is the EMPTY
  RESULT, not a decline (`Select.feature:578-596`).
- **`ChildValue.present` carries productivity beside the value** — `Pick.none` and `Pick.unproductive`
  are distinguishable no other way. A body that cannot report it DECLINES.
- **Which arm a row takes is ONE COLUMN** — the option-map ordinal `CASE` (18.7 KB inlined → 1.9 KB),
  and it gives FIRST-MATCH-WINS free (`ChooseStep` overrides `pickBranches` with `subList(0, 1)`).
- **The ranking instrument can rot** — `rel-blockers`' `blame()` read a wrapper and reported the
  LARGEST family as absent. Re-derive a ranking before trusting it.
- **Read a decline's REASON, not its date** — two group-barrier declines had stopped being true before
  anyone removed them.

### 🔴 Phase 3 — `repeat()` — THE GATE

The one family whose absence disqualifies the server, so deletion waits on it and on nothing else.

**0. ✅ Checker hardening — PREREQS, not follow-ups — DONE.** ⚠️ These sat in §10·6 under "orthogonal to the
phases" *while being labelled Phase 3 prereqs* — a prereq of the gate is not orthogonal to the gate, and filing
it as one is how it gets ranked against the work it blocks.

⚠️ **All four guard ONE failure mode, and naming it is worth more than the list: SQLite ACCEPTS the
construct and returns a wrong answer.** Not a throw, not a crash, not a plan-shape change — right arity, right
shape, wrong rows. No instrument in this repo sees that, which is why the checker is the only place it can be
caught, and why each refusal's MESSAGE says what SQLite actually does rather than "unsupported".

- **`Distinct`/`Limit`/`Sort` in a recursive term** (P3). Measured: `DISTINCT` is inert (duplicates survive,
  byte-identical to the same walk without it) and `LIMIT 2` caps the WHOLE walk, not each iteration. So a
  `repeat(…dedup())` body compiled to an inert keyword — and `topLevelSelf` had listed all three as legal
  unary wrappers on the self-reference.
- ⚠️ **…and the same walk was TOO STRICT the other way, which would have blocked step 2.** It descended
  through `exprRels`, so the aggregate/window laws fired inside correlated subplans. Measured LEGAL: an
  aggregate in a correlated scalar inside a recursive term, a window function, and a self-reference (P2's own
  finding). `flatten` decorrelates into exactly those shapes. The barrier laws now follow the term's own
  relational spine and stop at every subquery boundary; the self-reference COUNT keeps descending.
- **A whole-row `Distinct` may not carry a ROW-UNIQUE channel** — every row differs there, so it collapses
  nothing. Needed a policy rather than a pattern-match, so it is the channel core's **fourth total table**,
  `CHANNEL_ROW_UNIQUE`. ⚠️ `bulk` is deliberately NOT row-unique: the landed unordered `dedup()` projects
  `bulk = 1` (a LITERAL) and dedups over `(id, 1)`, which is correct — a blanket "a Distinct may carry no
  channels" would have refused shipped code, and a rule relaxed the first time it meets real code was never
  the rule.
- **An `aggs` entry may not reference a bare input column.** SQLite accepts `SELECT k, x … GROUP BY k` and
  returns `x` from an ARBITRARY row of each group; every other engine rejects it. `test:perturbed` is the only
  instrument that could ever see the result, and only by luck.
- **`name` walks expression subplans**, so a node shared between the spine and a `Scalar`/`Exists` body is
  bound once instead of inlined at both. ⚠️ **A CORRELATED subtree may not be bound** — a binding is a CTE
  beside the statement, and a subtree whose `Col`s resolve outside it stops resolving there, silently captured
  by a same-named relation rather than failing. The admission rule is therefore a free-reference test, not the
  occurrence count. Two pieces of shared substrate fell out, both of which step 2 needs: **`freeRelIds`**
  (what `flatten` must DECORRELATE is the same fact) and **`rewriteRels`** beside `rewrite`. ⚠️ Keeping those
  two rewrites separate is load-bearing — `prune`'s analysis is keyed on the relational SPINE, so a `rewrite`
  that descended into subplans would prune every projection inside a correlated subquery down to its channels.

**1. ✅ `prune`'s remainder — DONE** (`Join`/`Union`/`Aggregate`/`Recursive`/`Values`). What keeps a walk's
header down to what its body and its consumer actually read.

⚠️ **It was never "add three cases", and the reason generalizes.** A `Project` is the only node that removes a
column at SOURCE; every other kind's output is a function of its input's. So pruning below a `Join` does not
prune the join — it **RETYPES** it, and every node between there and the root with it, because `check` requires
the unary chain to declare exactly its input's columns. That also refuted the obvious implementation: pass 2
**cannot be a `rewrite` callback**, since a factory validates its declared type against the children it was
given, so the join throws INSIDE the rebuild and the callback that would have retyped it never runs.
`mapRelChildren` grew a `retype` override so the node is constructed with its new type in one step.

Three laws the per-kind rules keep, each a wrong ANSWER rather than an error if broken: a **`groupBy` key is
never dropped** (removing one makes the grouping COARSER); an **`Aggregate` keeps at least one output** (§12 —
a `Project` reading none of a whole-relation aggregate's outputs ERASES it, one row becomes N); a **channel is
never pruned**. The safety property is a test: pruning nothing changes the SQL not at all.

⚠️ **`Values` is the OTHER node that removes a column at SOURCE, and only `Project` was doing so.** A walk's
seed is typically a `Values`, so a `Recursive` whose header pruned left the seed wider than the step. It would
have been the first thing a walk over a pruned header hit.

⚠️ **A `Recursive`'s header, seed and step are ONE decision**, and its keep set is consumer-need + what the
BODY reads back off the walk + channels — the second term knowable only by instantiating the step. **The
self-ref substitution must happen INSIDE the rebuild pass**: `recursive`'s factory memoises `step`, so the
original closure cannot be re-run against a new `self`, and substituting into the body up front leaves nodes
declaring their old widths over a narrower child with nothing left to trigger a retype. Done inside the pass
the self-ref shrinks like any other child and every downstream retype works unchanged.

⚠️ **A recursive test body must be a single TERMINATING `Filter` over the `SelfRef`, and that shape is forced
from both sides** — P1 puts the walk at the top level of the term's `FROM` so the body is one unary node, and
step 0's P3 refusal removes `Limit` as the lazy way to stop. An unbounded body hangs the suite, which is
`repeat()` behaving exactly as specified.

**2. 🚧 `flatten`** — join flattening / decorrelation into the P1 envelope, P1 legality enforced in `check`, a
body that cannot be made legal throwing a clear deferral. Deletes `expandRepeatBody`, and `REPEAT_BODY_OK`'s
row-local vocabulary gate dissolves with it.

**2a. ✅ The structural legality analysis — DONE** (`src/rel/block.ts`). ⚠️ **MEASURED BEFORE DESIGNING, and
it moved most of the weight out of the rewrite: `check`'s `topLevelSelf` was a ONE-LEVEL shape match, and what
it refused included the most common `repeat()` body there is.** It admitted a unary node whose `input` IS the
self-reference, or a `Join` with the self-reference as a DIRECT side — and nothing deeper. So a one-hop
movement, `project(join(self, edges))`, was refused with `run flatten first` for a shape needing no rewrite at
all.

**SQL's `FROM` is a join TREE and everything in it is top-level**; P1's law is that the reference is not
wrapped in a DERIVED TABLE, which is a different question from how many nodes sit above it. Measured,
bun:sqlite 3.53.0, 3-edge chain, every one returning `1,2,3,4`: `FROM w INNER JOIN edges e`, the same with the
sides swapped, EITHER side of a `LEFT JOIN`, a cross join, nested joins, and a `w`-correlated `EXISTS`. Both
refusals are `circular reference: w` — the walk behind a derived table, and the walk referenced ONLY from a
correlated scalar. So the legality question is exactly *is the reference a FROM item of the term's outermost
block*, and **what decides that is the EMITTER's fusion rules**, not a second guess at them.

⚠️ **So the rules moved rather than being copied.** `block.ts` holds them once, over STRUCTURE alone —
`Slots` (which of a block's slots are filled), `NEEDS_SUBQUERY` (§5's `needNewSubQuery`, TOTAL over `RelKind`
so a new kind must declare its rule), `spliceable`, and `shapeOf`/`fromTree`: the assembler's own walk minus
every rendered expression. `emit.ts`'s `Block` IS a `Slots` and its arms read the shared table. A
checker-local copy would drift into admitting a plan the emitter then wraps — `circular reference`, or wrong
rows where SQLite accepts it, which is the class step 0 exists to keep dead.

Two defects fell out of stating it properly, each a wrong ANSWER rather than an error:

- A **`Materialize` over the walk's reference** is refused BY NAME now. It is the one unary node the fusion
  analysis cannot answer for, because its boundary is a CTE the `Name` pass makes rather than a derived table
  the emitter opens.
- ⚠️ **`name` was free to hoist a subtree holding a self-reference, and `freeRelIds` does not forbid it** — a
  `SelfRef` names its walk POSITIONALLY rather than by a `Col`, so such a subtree is free-reference-clean and
  looked bindable. `check` refuses the `Materialize` route outright; the new arm in `binds` is what keeps the
  other route — a node the recursive term shares with itself — correct.

**2b. ✅ The barrier laws follow the SELECT, not the node children — DONE.** ⚠️ **Step 0 relaxed the boundary
from "any subplan" to "a subquery"; it is really A NESTED SELECT, and a joined DERIVED TABLE is one.** The
laws walked `relChildren` from the term root, so a `repeat()` body joining against any deduped, ranked or
capped relation was refused. Measured on the same 3-edge chain, all returning `1,2,3,4`: an aggregate, a
window function, a `DISTINCT` and an `ORDER BY … LIMIT`, each inside a derived table joined into the recursive
term — against the controls `recursive aggregate queries not supported` and `cannot use window functions in
recursive queries` for the same two FUSED into the term. `block.ts` answers which nodes those are
(`fusedInto`, one more field on the shape the same walk already computes), and `check` folds the law table
over it. **This is the compounding half: the FIRST consumer of the block analysis beyond the question it was
built for, and both questions are now one walk.**

Only the bodies that genuinely cannot land in that FROM need the REWRITE, and those are what `flatten` proper
is for. This is the plan's own wording ("P1 legality enforced in `check`") taken seriously rather than a
change of direction.

⚠️ Two facts already banked that step 2 depends on, both from step 0: the barrier laws now stop at a subquery
boundary, so the correlated scalars `flatten` produces are admitted rather than refused; and `freeRelIds`
(`walk.ts`) already answers "is this subtree self-contained", which is the same fact decorrelation needs.
⚠️ And the fallback is NOT nothing: `src/compiler/steps/tail/keyed.ts`'s keyed child relation exists precisely
because SQLite has no `LATERAL`, so a fan-out body inside a recursive term cannot be correlated at all. Read
its header before concluding a body is inexpressible.

**3. Route `repeat()`'s body through ordinary lowering** — the step ITSELF, and the majority route. Per P4, 72
of the 125 corpus `repeat()`s have a NON-barrier body and need nothing beyond `Recursive`, already in the closed
node set (`Recursive.step` is a function; seed/step channels identical, §3.3).

**4. ➡️ MOVED — `repeat()` is a TWO-REGIME family, and the plan for it is
`docs/2026-08-09-repeat-two-regimes-plan.md`.** That doc is APPROVED and supersedes this section; read it
first for anything `repeat()`-shaped.

The decision in one line: `Recursive` wherever the walk is unbounded or its body holds no per-iteration
barrier; the IR-level unroll (`unrollFixedRepeat`, `ir/strategies.ts`) for a bounded `times(n)` whose body
holds one; a clear refusal for unbounded-AND-barrier, which is not expressible in single-pass SQL.
**Neither regime alone is sufficient and neither insufficiency shrinks with effort** — unroll cannot express
an unbounded walk, and SQLite's recursive term cannot express a per-iteration barrier. §4.3's Rel-level
`unroll` is WITHDRAWN (restore point `9e0e307`): the IR unroll produces a FLAT chain, so the whole lowering
handles it uniformly and every future step family is inherited free.

Landed so far: the body is normalized before splicing, `UNROLLABLE_BARRIERS` covers `dedup` + the slice
family + `order`, and a text ceiling is in place. L3 1763 → 1775 (RelIR) and 1681 → 1692 (legacy). What is
left, in order: the `Recursive` regime (step 3 — the gate), the differential over the cell where both
regimes are legal, and one more barrier name at a time.

🔴 **The 5 `until()`/`emit()` barrier bodies hit the P3 wall and are not expressible in ANY lowering.** That
deviation needs accepting, not engineering. The three routes partition the family: **125 = 72 `Recursive` + 48
IR-level unroll + 5 wall.**

**THE MEASUREMENT — a THIRD switch position. It gates the CUT, not this phase, so build it FIRST.**
`MOGWAI_RELIR` has two positions (`src/compiler/options/spine.ts`) and NEITHER answers *what does deleting
legacy cost*: the default run's L3 `passed` set contains legacy-ROUTED traversals, so the `legacySpine` floor
only proves routed ≥ all-legacy, and the census `spine` column — the closest thing available — is a corpus
count, not a conformance one. Add the position where **a RelIR decline is a FAILURE rather than a fallback**,
and run L3 + the census against it every round; that, not this document, is the countdown to Phase 4.
⚠️ It is Phase 1's rule generalized from `routeWrite` to the whole legacy route — **"MEASURE BY TURNING THE
ROUTE OFF, NEVER BY READING THE CODE"** — whose first run refuted the prose it replaced (`labels()`, a READ,
was holding the entire label-write family). Without it, "what is left before we can delete" is an opinion.
⚠️ Read its output through §6·6: it measures the ROUTE, so a shape the algebra EXPRESSES but no route hands it
reads identically to a missing lowering.

✅ **Built** — `MOGWAI_RELIR=only`, `mise run L3:rel-only`, `src/compiler/options/spine.ts`. `SpinePosition` is a
THIRD value beside `Spine` rather than a widening of it: `Spine` names which lowering PRODUCED a compile, and a
plan is never produced "by rel-only" — it is produced by RelIR or the compile raised. Not in `ci`; L3 under this
position reports and neither gates nor records (gating pins a number meant to fall to zero; recording would
overwrite the routed floor with the un-fallen-back one and silently lower the ratchet).

🚧 **It cannot REPORT yet, and the reason is Phase 2 gap 4.** Upstream's graph-snapshot reads (`world.js:147-180`,
cited above) take the legacy route, so this position raises inside `BeforeAll` and cucumber runs zero scenarios.
⚠️ **The instrument's first run READ THAT AS "deleting legacy costs 0 scenarios"** — the worst answer a
measurement can give, indistinguishable from success and pointing the wrong way. A zero-scenario run is now a
hard failure naming the cause. Whatever else is true of gap 4, this is why it goes first.

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

- **RelIR does not hold the group VALUE forms** — `group().by(k).by(__.out().count())` (a reducing
  child value) and `by(__.tail())`. Measured by trying to shed the legacy group KEY: declining costs 34
  tests, an L3 scenario and a conformance-host gate, all of them these two shapes. Until they land,
  every `group()` chain that uses them is legacy-only.
- **A set-op over TWO self-describing sides loses the member types**, so `values('when').fold().merge(…)`
  comes back a list of raw millis. Normalizing both sides to the TYPED encoding is the fix and is
  information-preserving (a bare member's tag is what `inferredVtype` reads off its storage class —
  what the wire would infer anyway). ⚠️ **It must be gated on the RUNTIME lossy test, not the
  compile-time `typed` flag** — measured: `values('name').fold()` is `typed` while every member is bare
  at run time, so a compile-time gate wrapped members needing no envelope, changed the common case's
  bytes and broke uniform-only-when-needed (6 differentials). The missing piece is that the test must
  span BOTH sides; `withLossyFlag` asks it of one relation. A latent defect in `memberTypeTag` fell out
  of the attempt and is recorded at the site: a wrapped member whose `t` is NULL (what
  `path().by(<transform>)` writes) has its tag returned unresolved, where a null tag means "infer from
  the value" everywhere else in the channel.
- **The `set` framing marker** survives `range(local)`/`all`/`any`/`none` and is dropped only by
  `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop, which is
  duplicated (`rel/list.ts`'s `ListOf.set` vs legacy's `ListStream.set`). Land it in RelIR and let legacy shed.
- **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type today) — needs head-position tracking on the RelIR `AliasEntry`.
- *(The checker hardening that used to sit here has moved to **Phase 3 step 0**, where it belongs: it was
  labelled a Phase 3 prereq inside a section headed "orthogonal to the phases".)*

---

## §11. Open design decisions

**The live ones are listed per PHASE, beside the work they gate** — Phase 3's `until()`/`emit()`
barrier wall is the only one. Keeping a decision next to the increment it blocks is what stops it
being read as general policy. Phase 2 has none: RelIR follows the REFERENCE, so legacy disagreeing
with it is expected rather than a question.

What follows is CLOSED, recorded as law; the section stays so the §-numbering (code comments cite §12)
does not move. Re-open one only with evidence, not with a preference.

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
different SQL); a replicated subplan must carry FRESH ids, and WITHIN one compile the minter is
shared/injected. A `Project` over a whole-relation `Aggregate` (empty `groupBy`) that reads none of its
outputs ERASES the aggregation — the emitter blocks it (Calcite's `fieldsUsed.isEmpty()`).

**A non-derivable "reference says X" question goes to the vendored source, cited at the pin.** The `.feature`
corpus says WHAT; `gremlin-core` says WHY and covers cases no scenario names (a reducing barrier's zero-row
emission is per-step, decided by whether it supplies a seed — `group`/`fold` emit `{}`/`[]`, `sum`/`min`/`max`
emit nothing). When two comments in this repo cite one feature file for opposite behaviours, the resolution is
IN the file. **Agreement between the two spines is not evidence of correctness — it is evidence of a shared
cause.**
