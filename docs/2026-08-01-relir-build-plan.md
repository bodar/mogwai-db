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

**Call this tier `rewrite`, not `Pass` (§6·5).** `Pass` names the `Step[]→Step[]` pipeline in
`ir/passes.ts`, which runs ABOVE the routing switch; these run below it. The distinction is load-bearing,
not cosmetic — a refusal raised here would be a throw out of a lowering whose contract is `null`, and
legacy would never see the traversal. No `Pass` TYPE exists in `src/rel/`, so this is a prose+comment fix.

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
in BOTH positions — over the INTERSECTION, which is the next rule.

**THE FLOOR IS THE UNION OF THE TWO SPINES, NEVER EITHER ONE — legacy may lose what RelIR holds.**
Legacy is a route with an end date, so it is not held to RelIR's bar: gaining five and losing five is
progress, and "legacy would have to support it too" is not a cost of a RelIR increment. Three gates say so
mechanically, because a rule only in prose is one an instrument will overrule:

- the L3 floors gate ASYMMETRICALLY — the RelIR floor is a hard ratchet, the `legacySpine` floor may only
  shed names the RelIR floor holds, and the union of the two `passed` sets may not shrink (`l3.test.ts`,
  `unionPassing`/`partitionLegacyRegressions`).
- the census's legacy gate accepts a shed shape RelIR answers. Losing the LAST spine still fails, at gate 2,
  and only because the census's RelIR position carries the legacy FALLBACK — `status` means "some spine
  answered this", so the union floor was already there (`test/census/README.md` gate 4).
- an assertion about a capability only RelIR expresses SAYS SO, so one deliberate asymmetry cannot cost the
  differential its whole signal: `{ spine: 'rel' }` for a plan/SQL claim (the constant-inlining spellings are
  all of these), `relirAhead` for an ANSWER claim — which proves legacy refuses instead of skipping. Eight
  sites were silently relying on the ambient switch, which is why the off position was red on trunk.

What stays HARD, and it is the whole reason the differential is worth having: **where both spines ANSWER,
they must agree** (census gate 3, both positions, row-for-row). A disagreement there is never a shed
capability — it is the wrong-answer-with-right-arity class, and its usual cause is a shared substrate
(§6·4) breaking under a change that only looked local. So read a legacy failure by direction: legacy now
DECLINES where RelIR answers is the migration; legacy now ANSWERS DIFFERENTLY is a bug in shared code.
Fixing legacy is still right when it is cheap AND the defect is real — twice it was one predicate reading a
step NAME where the answer depends on the step's ARGUMENTS, worth +2 L3 on each spine. That is a
cost/benefit call per case, not an obligation.

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

### §6·5 — TWO reasons wear one `null`, and conflating them makes the exit criterion unreachable

§12's "`null` is the only decline" stays true, but two FACTS spell it: **"not learned yet"** (temporary,
ratchets to zero) and **"the answer is an ERROR"** (permanent — never a capability). Both are
`catch { return null }` inside the lowering today, and the second lies to the census: a REFUSED traversal
counts as an uncovered gap forever, so coverage cannot reach 100% and §6·1's end date is unreachable **by
construction**. A whole-migration blocker that merely surfaced in the write family.

**A refusal on the traversal's own TEXT belongs to the IR `Pass` tier, above both spines** — done. The
`writeArguments` verify Pass calls the shared parse and re-raises: one authority, one message, above the
routing switch. Three facts about how it had to be built, each of which cost a wrong turn:

- **the parse had to MOVE first.** It lived inside the legacy interpreter, which imports `normalize`
  from the Pass tier — so a Pass importing it was a cycle. `src/compiler/ir/write-args.ts` is what
  SURVIVES legacy's deletion (Phase 2.6 removes the imperative closure around the parse, never the
  parse); pure, no `Engine`/`GraphStore`/SQL. **A symbol on the deletion ratchet does NOT move with
  it** — `parseVertexSpec` is legacy's own, and the ratchet said so (6 → 7 references).
- **the split needs a distinguishable throw**, not a message match: `Deferral` for "not learned yet",
  a plain `Error` for everything else. The Pass swallows the first and re-raises the second. The
  question is WHO OWES THE ANSWER, not severity.
- **a verifier must never narrow what the lowerings may attempt.** Legacy hands `mergeMaps` the whole
  chain after the merge and lets it refuse a read tail; slicing the same way in the Pass would have
  raised legacy's own deferral for `mergeV(…).values('name')`, which the RelIR fold continues past.
  The Pass slices the `option()`/`property()` RUN.

It also has to be handed the compile's constant environments — `params` and the `withSideEffect`
registry now travel with a body through `runPasses`/`normalize`/`childSteps`, and `compilePlan`
extracts the registry BEFORE the passes. Closes `refusal_belongs_to_legacy`
(`docs/spec/relir-migration.allium`) by MOVING the check — that spec's own proposed resolution.

**A GRAPH-dependent refusal cannot move there**, so it becomes a **guard binding** — built:
`Binding.guard = { message, raiseWhen: 'rows' | 'empty' }`, a binding whose relation the executor runs
and whose ROW COUNT it tests, raising the message. O(plan size), one statement, inside P5. **The
message is the reference's verbatim**, because a decline already hands the traversal to a spine that
raises that same string: what a guard buys is the string WITHOUT the decline, and therefore without
the census counting a traversal this algebra expressed as vocabulary it cannot.

`raiseWhen` has both directions because both are real: `'rows'` is a COLLISION (the check finds the
row it hoped was absent — `assertAvailableElementId`), `'empty'` is a MISSING referent
(`mergeE`'s *"Vertex does not exist"*, unbuilt, and the reason the field is not just "raise if
non-empty"). The `single`-cardinality-above-one throw of a multi-row `property(k, __.trav)` is a
third consumer.

First consumer landed: `elementAddV`'s `T` tokens — `property(T.id, x)` supplies the public id behind
an availability guard, `property(T.label, l)` replaces the labels. **Label MUTATION is NOT this
mechanism** and the plan used to say it was: `labelCardinality.mutable` is request-scope DI, settled
before a compile starts, so `addLabel` under an immutable graph is a COMPILE-TIME refusal that needs
the value threaded (as `Lowering.labelCardinality` already is) rather than a query.

**Naming:** `Pass` names two tiers on opposite sides of the routing switch. Load-bearing, not cosmetic — a
refusal raised in a RelIR rewrite is a throw out of a lowering whose contract is `null`, and legacy never
sees the traversal. §4's tier is `rewrite`; `Pass` means the pre-lowering chain tier only.

### §6·6 — ONE child seam: a child body has THREE total answers

`src/compiler/rel/child.ts` declares it and `childSeam(ctx, fresh)` (`lower.ts`) builds it: correlated
**scalar**, correlated **predicate**, **rooted** relation, plus the `body()` normalizer all three share.
It replaced four spellings of one question — `ByChild` (`modulator.ts`), `SubReads.body`/`rooted`/
`matching` (`write.ts`), `ListCtx.subRead`, `FilterCtx.correlatedChildren` → `correlatedExists`.

**The rule the seam exists to hold: a child body works wherever a child body is LEGAL, not wherever a
host was taught one.** That split is why the write vocabulary LOOKS like it needs a per-traverser
substrate and does not — `property`'s nested value and `mergeV`/`mergeE`'s nested label/key/value need
the SCALAR arm, which was built, injected and serving the whole `by()` vocabulary while the write seam
held only the ROOTED one. P2 says a correlated scalar is legal; nothing row-at-a-time is involved.

`rooted` is deliberately POLICY-FREE — a consumer's admission rule (a vertex stream for an `addE`
endpoint, a list framing for a set-op operand, no effects for either) is the consumer's, or the seam
becomes the union of its callers' requirements, which is the shape it collapsed. `body()` is part of
the DECLINE contract and not a convenience: normalizing re-runs the Pass pipeline and can legitimately
raise, and two of the four spellings called `childSteps` bare.

Phase 2.6's third piece was smaller still and is done: the `withSideEffect` constants ride on the seam
beside `params`, and the route-level `sideEffects.size === 0` refusal in `compiler.ts` is gone. **The
lesson generalizes past this case — coverage must measure what the algebra can EXPRESS, never what the
router remembered to ask.** A gate at the routing switch reads identically to a missing lowering in
every counter the migration owns, and `rel-blockers` was measuring the same gap it caused (it called
`lowerToRel` without the registry). When a family looks uncovered, check what it was HANDED before
concluding what it cannot express — §7's rule, one layer up.

### §6·7 — a scalar row's TYPE rides PER ROW; a static tag is an OPTIMIZATION, never the carrier

**THE RULE: what arrives on the wire is CARRIED until something naturally changes it.** Never re-derived,
never re-guessed, and never DISCARDED because modelling its carriage through a layer looked like work. That
discard is the failure being replaced: the declared type was dropped at the source and the framer guessed it
back from a JS value — which cannot tell a UUID from a string, a datetime from a long, or a big long from
either. Carrying costs one column and helps EVERY type at once; guessing is per-type and lossy. The payoff
is not only at the wire: a step that DOES change a value's type decides with the type still in hand.

`ScalarType` (`src/sql/kernel/render.ts`) is already the total union — `static | perRow | unknown` — so the
vocabulary was never the problem. The carrier was: only a stored-vtype read may use `perRow`, so every other
producer must prove a *uniform* compile-time tag or give up. One missing carrier, four symptoms, one bug —
`bareInjectTag`'s whitelist + uniformity test (`steps/write/inject.ts`, a shared non-derivable-fact
authority that exists only because the channel is missing); `injectSource` falling back to `UNKNOWN` for a
mixed inject, discarding four declared types because it could not carry two; `mergeArms`'s `sameFraming`
equality test, which DECLINES two scalar arms whose tags differ, so the whole branch family cares what its
arms' tags are; and `UNKNOWN` meaning both "the JS client genuinely cannot say" and "our source cannot carry
mixed". Legacy already got the merge half right (`steps/tail/scalar.ts`: *a PER-ROW type survives because
the column now crosses the merge*) — proof this is carriage, not semantics.

**The mechanism.** A producer that knows its per-value types states them per row; `static` survives as the
degenerate agreeing case, because it costs no column. One lattice where two scalar streams meet —
`static ∧ static(same) → static` · `static ∧ static(differ) → perRow` (each side projecting its tag as a
literal `vt`) · `perRow ∧ x → perRow` · `unknown ∧ x → unknown` — called by the inject source, the arm merge
and the reducer, the three places that spell it differently today.

**What it buys, in descending order of worth** — the order matters, because leading with the last is how
someone talks themselves into building tag machinery downstream: (1) the branch-family declines go, straight
coverage; (2) the types a JS value CANNOT recover survive a heterogeneous stream — uuid, datetime, char,
duration, bigdecimal, each a wrong wire CLASS rather than a wrong tag; (3) `bareInjectTag` and
`DECLARED_TYPE_REQUIRED` are deleted, and with them a second chance to get `char`/`uuid`/`datetime` wrong
(measured: it already had been); (4) `UNKNOWN` regains its declared meaning; (5) exact numeric literal
framing (`127b` → Byte) falls out free — **worth little on its own, so spend nothing extending it.**
`AliasScalarType`/`aliasScalarTypeOf` (`steps/context/context.ts`) is a lossy coarsening invented for the
same missing carrier — same increment or the next. A `vt` column materializes only where tags disagree, so
it is no width tax; both spines read the lattice, so legacy CONVERGES rather than growing a second copy.

**PASS-THROUGH is exact; ARITHMETIC is SQLite's.** Carrying the type is what makes the informed decision
possible at the point something changes it — and there SQLite is the engine, so its storage class governs:
the narrowest tag in the Number family that holds the result **without narrowing** (magnitude-based
Int/Long for `integer`, Double for `real` — what we already emit). Widening there is a DECISION taken with
the type in hand, not the old discard. Two hard edges: **never narrow** (`frameValue`'s `case 'byte'` calls
a strict `byteSerializer`; tagging 128 a Byte overflows it — a crash, not an inaccuracy), and **never leave
the Number family gratuitously** (BigInteger/BigDecimal decode to a JS BigInt / BigDecimal object and
`1123n !== 1123` — the `countBuffer` defect; `g_V_age_injectX1000nX_sum` asserts `d[1123].n` and PASSES only
because we frame something that decodes to a Number).

**Widening INSIDE the family changes no answer Gremlin can be asked** — a citation, not a convenience:
`gremlin-core/.../util/GremlinValueComparator.java` treats every `Number` subclass as ONE type
(`f instanceof Number && s instanceof Number`), routes both Comparability and Orderability to
`NumberHelper.compare`, exempts Numbers from the `equals` hashCode shortcut, and states it — *"does not
provide a stable order for numerics because of type promotion equivalence semantics."* So `Short 128` and
`Integer 128` are equal and identically ordered to `P.eq`, `P.lt`, `dedup()`, `order()`, a `group().by()`
key. **Not licensed by the JS client's blindness** (`feature-steps.js` captures only the numeral from
`d[…].[bsilfdmn]`): Java and .NET do preserve the class, and the honest residual is theirs — `Short s =
…sum().next()` is a CCE. Host-language typing, outside Gremlin's value semantics, and upstream's own
promotion already makes `sum()`'s class data-dependent.

**So NumberHelper's promotion tower is NOT built** — measured: all fourteen narrow-type `Sum.feature`
scenarios pass on both spines (`l3-state.json`). Promotion is also sticky and ORDER-dependent
(`mathOperationWithPromote` re-derives the class from the accumulator: `[100b,100b,-100b]` → Short 100 where
classifying the total gives Byte 100), so reproducing it needs a prefix window (`SUM(v) OVER (ORDER BY
encounter ROWS UNBOUNDED PRECEDING)`) — a streaming O(1) reducer becomes a sort plus an O(N) sorter on every
sum narrower than 64 bits, to choose between two tags the reference comparator calls equivalent. Deviation
documented, not silent: same value, never narrower, inside the one family.

Three platform walls, belonging beside P1–P5 rather than in a coverage counter: **128-bit arithmetic
declines** (no arbitrary precision, no UDFs — fail closed; do NOT raise, since `!fp && bits ≥ 64` is Long's
rule and the reference answers for BigInteger); **int64 overflow raises natively**, at exactly upstream's
rethrow point, so only the executor-side translation is ours; **32-bit float arithmetic is not expressible**
(SQLite REAL is always a double; `1f+2f+3f` is exact, so nothing observes it).

### The instruments — run all of them, not the cheapest

Most are inside `ci` (`check`, `lint`, `arch`, `binds`, `deletion`, `rel-sweep`, `test` over L1–L5 + the
census, `build`). The per-increment loop is: `ci` → `test:legacy-spine` (the differential, every
coverage-moving change) → `test:cf-limits` (every new SQL) → commit → `mise run L5` at the commit (its seed
is HEAD-derived, so a pre-commit run does not prove the commit) → push. `test:perturbed` only when the change
touches ORDER. What each is blind to:

| instrument | blind to |
|---|---|
| census (`ms` digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value; a lost fast path (same rows) |
| row-for-row vs legacy | a MISSING throw; a wrong ORDER both spines share; anything outside the INTERSECTION — it compares where both spines answer, and that set shrinks on purpose (§6·1) |
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
- **The CHILD SEAM (§6·6):** one injected `ChildSeam`, three total answers. Its scalar arm has the
  expression form (flat value+transform) and the reducer form (`__.out().count()`), with the
  reference's productivity/seed rules cited; its predicate arm is the filter-conjunction /
  correlated-`EXISTS` pair; its rooted arm is the fold re-entered.
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

1. **Phase 2.6 — delete the legacy write dispatcher.** Prerequisite (alias-through-a-creation) met; the
   gate is write coverage being COMPLETE. Ranked by what is left (`rel-blockers` + the L3 merge split,
   both move):
   - ~~**`mergeE` — not lowered at all**~~ — LOWERED, both endpoint kinds. Three findings worth
     keeping, because each refutes something this plan assumed:
     - **P5b did not arise.** The plan expected a position-correlated `RETURNING`; an edge's
       `(src, tgt)` IS its correlation key, so the `RETURNING` projects the endpoints and created
       edges join back BY VALUE. Nothing depends on the order rows come back in.
     - **The constant and incoming endpoint cases are ONE lowering**, not two. Carry the endpoint
       PAIR beside each incoming row; `Distinct` over the pair is what makes duplicate traversers
       right (one edge, N traversers — upstream's second iteration matching its first), and a
       constant endpoint is the degenerate case where every row carries the same pair.
     - **No gated counter moved, and that is not a null result.** Every parameterized `mergeE`
       arrives as a bound Map, which the corpus cannot express (so the census `spine` column cannot
       see it), and the L3 scenarios it moves already PASSED on legacy. `test/rel-spine.test.ts` is
       the record instead. **A family whose corpus presence is parameterized needs a test, not a
       counter** — worth checking before ranking the next one by census delta.
     What is LEFT of mergeE is `option(Merge.outV/inV, …)`: the shared parse refuses the selector,
     so ~7 L3 scenarios fail on BOTH spines. Admitting it is a `MergeMaps` change both spines read,
     and the endpoint vocabulary it needs (incoming | constant | ALIAS) is `elementAddE`'s `Endpoint`
     union under a different spelling.
   - **`property`'s residue is not one question and not per-traverser.** The text-level refusal and the
     `T`-token/guard-binding halves are done (§6·5); what is left is a meta-property under an
     UNDECLARED cardinality (the `set` arm PATCHES rather than inserts, an `UPDATE` this route does
     not emit yet) and the nested value below.
   - **the nested-value/label children** (`property(k, __.trav)`, `addV(__.trav)`, `addE(__.trav)`).
     **The reference is ASYMMETRIC and that decides the shape of the work** — read, not inferred:
     - A nested **KEY** resolves through `Parameters.get(traverser, T.key, …)`, which calls
       `TraversalUtil.apply` and takes `.get(0)`
       (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/Parameters.java:120-128`,
       `…/util/TraversalUtil.java:41-53`). `apply` is `traversal.next()` — the FIRST result, raising
       *"The provided traverser does not map to a value"* when there is none. **That is exactly the
       seam's `scalar` arm**, so a nested key needs no new machinery at all; the same is true of a
       nested `addV`/`addE` LABEL (`insertVertex` resolves one value).
     - A nested **VALUE** does not. `AddPropertyStep.sideEffect` detects a `Traversal` value that is
       not a `ConstantTraversal` and routes to `handleTraversalValue`, which collects ALL results via
       `TraversalUtil.applyAll`
       (`…/process/traversal/step/sideEffect/AddPropertyStep.java:105-199`) and then:
       **0 results → NO mutation, the element passes through unchanged** (`:140-142`);
       **>1 under `single`** (declared, else `graph().features().vertex().getCardinality(key)`) →
       `IllegalArgumentException` *"Single-cardinality property requires exactly one value, but
       traversal produced N results"* (`:172-182`);
       **>1 under `list`/`set`** → each written as its own value, and a non-Vertex element is an
       `IllegalStateException` (`:184-195`);
       otherwise `results.get(0)` (`:199`).
       The single-argument `property(traversal)` MAP form is a third case, flagged by `mapForm` rather
       than by inspecting the key, and it REQUIRES a Map result (`:150-168`).
     So: **the key, the label and any provably single-row value are the seam's existing `scalar` arm
     and can land now.** Only a possibly-multi-row VALUE needs more, and what it needs is a HOST-KEYED
     relation — the child body applied to the whole owners relation at once, carrying the owner key.
     That is not a lateral and not a new node: it is the ordinary fold with that relation as its input.
     It is also item 4's `local`/`properties` shape, so it is the one honest candidate for a FOURTH
     seam answer (§6·6 says three; this is the case that would make it four, deliberately). The
     `single`-cardinality-above-one throw is graph-dependent, so it is a GUARD BINDING — the same
     mechanism §6·5's second half owes `mergeE`.
   - **`PartitionStrategy` on a merge**, and `addE` after `addV` in one chain.
   Both laws reach past this phase: §6·5 is what lets the coverage counter reach zero at all, §6·6 is
   what item 4's by()-child matrix needs anyway.
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
   - **The per-row scalar type channel (§6·7)** — the decided carrier change: one `ScalarType` lattice, the
     inject source and the arm merge going `perRow`, `bareInjectTag`/`DECLARED_TYPE_REQUIRED` deleted. It is
     the prerequisite for the next bullet and it removes the branch family's tag-agreement declines.
   - ~~The numeric-tower PROMOTION~~ — **CLOSED; the claim it rested on was false.** It said 6 `Sum.feature`
     scenarios were blocked. Measured (`l3-state.json`): all fourteen narrow-type Sum scenarios pass, on both
     spines. Not built (§6·7). The real `sum`-adjacent failures are other families — `group().by(…sum)`,
     `sack`, `aggregate` side effects, `math`, `order().by(sum(local))`.
   - **The `set` framing marker** survives `range(local)`/`all`/`any`/`none` and is dropped only by
     `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop. That loop is
     duplicated (`src/compiler/rel/list.ts`'s `ListOf.set` vs the legacy `ListStream.set`), so this lands in
     RelIR and legacy sheds the shapes it gets wrong (§6·1). Do it twice only if the second copy is free.
   - **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong Pop.mixed wire
     type today) — needs head-position tracking on the RelIR `AliasEntry`.
   - **Checker hardening (Phase 3 prereqs):** refuse `Distinct`/`Limit`/`Sort` inside a recursive term (P3);
     a whole-row `Distinct` may not carry a per-row-unique channel; an `aggs` entry may not reference an
     input column outside an `Agg`; `name` should walk expression subplans (a shared node in a
     `Scalar`/`Exists` body is inlined twice).
6. **The last step:** delete the legacy spine and the routing switch (§6·1).

---

## §11. Open design decisions — NONE OPEN

All three are decided and recorded as laws; the section stays so the §-numbering (and the code comments
citing §12) does not move. Re-open one only with evidence, not with a preference.

1. ~~Exact-type literal framing~~ → **§6·7**. The tag table was the wrong lever; the missing per-row carrier
   was the defect. Exact framing becomes free, and the regression that blocked it disappears.
2. ~~Phase 2.6's `property` residue~~ → **§6·5** + **§6·6**. Not one question and not per-traverser: a
   text-level refusal, a compile-time constant not handed over, a correlated scalar the child seam already
   builds, and a graph-dependent refusal that becomes a guard binding. No permanent exception.
3. ~~The numeric-tower PROMOTION rule~~ → **§6·7**, resolved by NOT building it. The rule is real
   (`NumberHelper.getHighestCommonNumberInfo` keeps the narrowest common class, promotes on overflow, and
   RAISES at ≥64 bits non-fp) and reproducing it changes no answer Gremlin can be asked, while costing a
   sort. Preserve the wire type through pass-through; let SQLite's storage class govern arithmetic; never
   narrow; never leave the Number family gratuitously.

---

## §12. Traps — each cost a real defect, none found by reading

**The decline contract.** `null` is the ONLY decline and must stay cheap and total — a partial lowering that
silently drops a filter is invisible to the differential (both spines are asked; only one asks right). A
module whose contract is `null` must not let a throw escape. **A fast path is never silently dropped**
(`has(k,containing(t))` routes the trigram index; it DECLINES until §4.7 — coverage measures whether the new
spine CAN express, never whether it is entitled to take a specialized lowering). **Never let the two spines
answer the same traversal DIFFERENTLY on purpose** — that is the §6·1 hard half, and it is not the same
demand as parity: RelIR answering where legacy declines is legal, recorded, and expected. So a defect the
migration exposes is fixed in RelIR; legacy is fixed too when that is cheap and the defect is legacy's own,
and otherwise left to shed the shape. **A decline is only right when the OTHER spine is right** (§13n's
lesson): measure the other spine first; four "answer where TinkerPop raises" findings were kept because
legacy answered identically wrongly and declining bought zero correctness.

**Before reproducing a reference distinction, ask what a client can SEE.** Three bands: it changes the
VALUE → build it; it changes the decoded CLASS across a boundary every GLV has (Number ↔ BigInt/BigDecimal/
Date/UUID/string, scalar ↔ Array/Set/Map) → build it; it changes only the GraphBinary TAG inside a band
every GLV collapses → do not build it, document the deviation. Band 3 is never a reason to DISCARD upstream
(§6·7 — carriage is cheap and helps every type); it is only a reason not to build machinery downstream to
RECONSTRUCT what nothing can observe. That test retired `NumberHelper`'s promotion tower after it had been
carried in this plan as blocking work; apply it at design time, not after.

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
