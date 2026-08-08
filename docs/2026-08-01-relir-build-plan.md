# RelIR — the build plan

**Status: BUILDING.** RelIR is the missing middle: `Step[] → RelIR → SQL`, an inspectable, rewritable
relational algebra between the Gremlin front-end and the `q` SQL kernel. It replaces the legacy
compile-straight-to-SQL spine, whose `Query.ctes` is a private append-only array — the query never exists
as data, so every optimization had to happen *before* lowering or be hand-built around.

**The migration finishes when the IMPORT GRAPH is severed and `repeat()` works — not when coverage reaches
100%** (§8 measures why: coverage gates the route, the import graph gates the code, and only the second one
decides how much you can delete). Coverage is a SIGNAL for ranking an increment, never the finish line.

**Three instruments run it, all in committed, `ci`-gated artifacts — never copied here** (a number in prose
goes stale): the coverage signal is `test/census/goldens.tsv` (the `spine` column), the name countdown is
`scripts/deletion-ratchet.tsv`, and the deletion criterion is the import edge count into
`src/compiler/steps/` (§10 Phase 0 — one `grep`, and it should be a gate). Read them from a `ci` run. The
blocker ranking is `mise run rel-blockers` — re-run it every round, it moves.

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
- **THE EXIT CRITERION IS NOT COVERAGE.** It was, and that was measurably the wrong gate — see §8. It is
  now: **the import graph is severed, and `repeat()` works.** Everything else legacy still answers on the
  day of deletion becomes a clear deferral, not a blocker. Coverage remains a SIGNAL — read it to rank an
  increment, never to decide whether the migration may finish.
- **The differential is cut PER PHASE, with the code it compares.** Not kept whole until the last commit:
  when the write route goes (Phase 1), the write half of the harness goes with it. What survives each cut
  is L5's metamorphic oracle + the census + L1–L4. "We would lose the differential" is not a reason to keep
  a route whose code is already deleted.

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

### §6·4 (was §10·7/§10·8) — split every file at the KERNEL/EMISSION line; the unit of work is the FAMILY

**Share DATA and pure computation across spines; re-express only the EMISSION** (a re-derived
`JAVA_WHITESPACE` missing a code point is wrong in a way no test names). That was always the rule. What
§8's measurement adds is that it is also the DELETION mechanism, and it must run FIRST:

**Every legacy file splits at one line — the pure kernel, and the emission that spends it on legacy's
object model.** `math` is the worked example: `mathToSql`/`mathVars` already live in `src/gremlin/math.ts`
importing nothing but the `q` kernel, while `lowerMath`/`lowerMathScalar` (`steps/tail/mapscalar.ts`) are
~85 lines of `traverserLayout`/`aliasCtx`/`layoutProjection` plumbing, duplicated once per dispatch table.
`mapscalar.ts` is safe to delete **because the valuable part already left**.

**THE SPLIT IS ONE LINE FURTHER IN THAN THIS SECTION CLAIMED, and the correction is the interesting
part** — measured 2026-08-07, before writing any of it. "Migrating `math` is *calling the same kernel with
a different `resolveVar`*" is FALSE: `mathToSql` is typed `(formula, resolveVar) => Expression`, and every
arm of it — `realLit`'s `raw()`, all twenty `FN` entries, every `q\`\`` in the precedence climb —
CONSTRUCTS a q-kernel `Expression`. RelIR composes `Expr`. So the file is a kernel with an EMISSION TAIL
still fused to it, which is the same shape `steps/` files have, one layer down. See Phase 2 for what the
separation costs and why the obvious AST split is the wrong one.

**EXTRACT THE KERNEL BEFORE DELETING THE FILE.** A kernel still trapped inside `steps/` is what turns every
deletion into a re-derivation — and re-deriving a table is the one failure mode no test names. This is not
a separate refactor from the migration; it is the migration's first step, done first instead of last (§10
Phase 0, which carries the inventory).

Then the ordinary rule: read the blocker table to find WHERE the fold gives up, and land the whole FAMILY
that step belongs to — never the step alone (a ragged edge re-derives the parse/projection/type-context the
next increment needs). Rank by **which import EDGE it cuts**, then by which deletion-ratchet name it lets
you delete, with marginal coverage as the tiebreak.

### §6·5 — TWO reasons wear one `null`, and conflating them corrupts the ranking signal

§12's "`null` is the only decline" stays true, but two FACTS spell it: **"not learned yet"** (temporary,
ratchets to zero) and **"the answer is an ERROR"** (permanent — never a capability). Both are
`catch { return null }` inside the lowering today, and the second lies to the census: a REFUSED traversal
counts as an uncovered gap forever. That no longer blocks the exit (§6·1 moved it off coverage), but it
still CORRUPTS THE SIGNAL the exit is ranked by — a permanent error banked as a permanent gap makes a
finished family look unfinished, and misranks the next increment. A whole-migration defect that merely
surfaced in the write family.

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

**A FIXTURE-CORRUPTING bug HANGS instead of failing, and no instrument in that table reports it.**
The census shares ONE store across every non-write traversal, so a write MISCLASSIFIED as a read
mutates the fixture every later traversal reads. Measured: `isWrite()` asked `compile(q, {})` — the
AMBIENT spine — and swallowed the throw as "read", so under `MOGWAI_RELIR=0` a new `mergeE` shape was
filed as a read, ran against the shared store, and created six SELF-LOOPS; the 86 corpus `repeat()`s
then walked a cyclic graph, which is infinite per the spec. The suite did not fail, it stopped.
Two rules fall out, both now encoded: **a spine-sensitive CLASSIFIER must ask both spines** (§6·1's
union rule is not only about coverage), and **a throw is not evidence of readness.** When a suite
hangs after a coverage increment, suspect the shared fixture before suspecting a loop in the new
code — the new code is usually the one traversal that is fine.

---

## §7. Scope control — the node set is CLOSED

RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no
statistics, no join reordering — SQLite is the optimizer.** Adding a node kind requires showing the seam
cannot EXPRESS a shape, not that it has not been HANDED one. Before declaring a substrate missing, check
whether an existing one is merely not REACHED (`src/compiler/steps/CLAUDE.md`'s "cannot express" vs "cannot
be handed"). If Phase 2 ever grows an `ElementReadDriver` analogue, it has failed.

---

## §8. What this deletes — the EXIT CRITERION

**COVERAGE GATES THE ROUTE. THE IMPORT GRAPH GATES THE CODE — and this plan used to model only the route.**
That is why the migration felt all-or-nothing and why iteration slowed: measured over `src/`, **all 39
files in `src/compiler/steps/` are transitively reachable from non-legacy code**, so no incremental
deletion is possible at all under the current coupling. Deleting the legacy route AND `engine/engine.ts`
today frees **7 files / 2,466 of 17,634 lines — 14%**. The other 15,168 stay, pinned not by coverage but by
**14 direct import edges**.

**The pinned-edge inventory — Phase 0's worklist.** Ranked by the size of what the edge drags in. The
symbols column is what is actually imported; the file's remaining lines are pinned only because the edge
exists.

| pinned file | lines | imported symbols | pinned by |
|---|---|---|---|
| `tail/child.ts` | 1241 | `scopedMovementCount` | `services/catalog/degree-centrality.ts` |
| `tail/child-shape.ts` | 1183 | ~~`childSteps`, `assertsGType`, `collectionAssert`, `typeOfAssert`~~ · `ChildFrameStack`, `ChildParent` | `services/spi/types.ts`, ~~`rel/lower.ts`~~ |
| ~~`tail/group.ts`~~ | 1125 | ~~`propertyPayload`~~ | ~~`services/catalog/search.ts`~~ |
| `context/context.ts` | 991 | `LoweringState`, `ElementStream`, `TraverserLayout`, `rootLayout`, `AliasMap`, `AliasEntry`, `aliasScalarTypeOf`, `withShape` | `rel/{lower,write,alias}.ts`, `engine/deps.ts`, `services/catalog/{directory,search}.ts` |
| ~~`tail/list.ts`~~ | 742 | ~~`LIST_LOCAL_TX`, `STRING_LOCAL_TX`~~ | ~~`rel/list.ts`~~ |
| `context/stream.ts` | 480 | `Stream`, `LoweringSuspension`, `toScalarStream`, `toPropertyStream`, `PropertyStream` · ~~`PROPERTY_PAYLOAD`~~ | `services/spi/types.ts`, `engine/deps.ts`, `services/catalog/{directory,search}.ts` |
| ~~`tail/path.ts`~~ | 409 | ~~`PATH_LIST_OPS`~~ | ~~`rel/lower.ts`~~ |
| ~~`tail/coerce.ts`~~ | 188 | ~~`dtFactor`, `numericSpec`~~ | ~~`rel/transform.ts`~~ |
| `write/inject.ts` | 179 | `bareInjectTag` · ~~`foldConstantCoercions`~~ | `rel/lower.ts` |
| ~~`context/alias.ts`~~ | 103 | ~~`SHAPE_K`, `elemShape`, `AliasShape`~~ | ~~`rel/{path,history}.ts`~~ |
| ~~`write/validate.ts`~~ | 39 | ~~`validateLabel`, `validatePropertyKey`~~ | ~~`rel/write.ts`, `ir/write-args.ts`~~ |
| ~~`injection.ts`~~ | 35 | ~~`INJECT_VALUES_KEY`~~ | ~~`services/catalog/federate.ts`~~ |

Those twelve transitively drag `branch.ts` (1415), `projection.ts` (1321), `select.ts` (740), `scalar.ts`
(724) and the rest. **Read the table honestly in both directions:** it is a FILE-level closure, so it
over-counts what an edge costs (most edges take one to three symbols, so cutting the edge frees far more
than the row suggests) — and it under-counts nothing, because 39/39 really are reachable.

**Struck rows are CUT** — the kernel half of Phase 0 landed, and `scripts/steps-edges.tsv` is the live
count (this table is the ORIGINAL measurement, kept so the shape of the remaining work stays legible
against it). Fourteen non-exempt importers → eight. What the strike-through shows, and the reason the
kernel pass was worth doing first: **every row that fell was a table or a total function**, and no row
fell because a capability moved. What is LEFT on all eight is the object model —
`LoweringState`/`Stream`/`TraverserLayout`/`AliasMap`/`ChildFrameStack`/`ChildParent` and the four
accessors over them — plus `scopedMovementCount` (the child seam, not a kernel: the plan filed it under
"pure kernels" and it is not one — it reaches `pushChildScope` and `engineOf`) and `bareInjectTag` (§6·7
deletes it). Where each kernel went, since "a neutral module" was the instruction and the ANSWER is the
durable part:

| kernel | new home | why there |
|---|---|---|
| `validateLabel`/`validatePropertyKey` | `gremlin/validate.ts` | TinkerPop's `ElementHelper` rules; zero imports, `gremlin/math.ts`'s profile |
| `dtFactor`/`numericSpec`/`foldConstantCoercions` + the whole coercion file | `gremlin/coerce.ts` | the const-fold RAISES TinkerPop's exact messages — Gremlin semantics, not lowering |
| `INJECT_VALUES_KEY` | `ir/injection.ts` | a parsed IR operand shape + a reserved params key; its own header already called it a dependency-free leaf |
| `SHAPE_K`/`elemShape`/`aliasEntry`/the Pop slices | `plan/alias.ts` | the as()-label history ENCODING, beside `JAVA_WHITESPACE`/`STORAGE_CLASS` — data both spines must agree on |
| `PROPERTY_PAYLOAD`/`propertyPayload` | `plan/plan.ts` | beside `elementPayload`, its element twin |
| `SCALAR_TRANSFORMS`/`LIST_LOCAL_TX`/`STRING_LOCAL_TX`/`PATH_LIST_OPS` | `ir/step.ts` | it already IS the step-name vocabulary home, and three of the four are exactly the "derive with a named difference, never merge" case it enforces |
| `typeOfAssert`/`assertsGType`/`collectionAssert` | `ir/step.ts` | beside `sliceOf` — the other total decode of one step's arguments |
| `childSteps` | `ir/passes.ts` | beside the `normalize` it is built on; parsing a nested arg into IR is IR production |

**THE UNNAMED PIN, and the one that would make a late deletion fail expensively:
`src/services/spi/types.ts:1-2` types the whole service SPI on legacy's `Stream` and
`ChildFrameStack`/`ChildParent`.** Every service — `call()`, FTS search, degree-centrality, federation —
is written against legacy's object model. No phase of this plan named it before.

**And naming it as a TYPING problem was still wrong** — measured while cutting the rest of Phase 0.
`call()` exists only on the legacy spine, so the SPI is typed on `Stream` because that is the only lowered
form there is; retyping it severs one row and leaves the three catalog services holding the same edge. It is
a CAPABILITY MIGRATION, it is scheduled as its own unit before Phase 4, and the sizing is in
"Phase 0's residue" under §10.

**The trapped kernels ARE the import edges** (§6·4), which is why Phase 0 is one job and not two:

| kernel | where it lives |
|---|---|
| `mathToSql`, `mathVars` | ✅ `src/gremlin/math.ts` — the worked example |
| `JAVA_WHITESPACE` | ✅ `src/compiler/plan/plan.ts` |
| `LIST_LOCAL_TX`, `STRING_LOCAL_TX`, `PATH_LIST_OPS`, `SCALAR_TRANSFORMS` | ✅ `src/compiler/ir/step.ts` |
| `dtFactor`, `numericSpec`, `foldConstantCoercions` | ✅ `src/gremlin/coerce.ts` |
| `validateLabel`, `validatePropertyKey` | ✅ `src/gremlin/validate.ts` |
| `propertyPayload`, `PROPERTY_PAYLOAD` | ✅ `src/compiler/plan/plan.ts` |
| `SACK_OPS`, `combineSack` | ❌ `tail/scalar.ts` — no edge yet; Phase 2 moves it with `sack` |
| `scopedMovementCount` | ❌ `tail/child.ts` — **not a kernel**: it reaches `pushChildScope`/`engineOf`, so it falls out of the object-model work, not this list |

**The exit criterion, restated: the import graph is severed and `repeat()` works.** `mise run deletion`
gates the floors in `scripts/deletion-ratchet.tsv` (that file IS the list; editing prose here changes
nothing) and stays the countdown for the NAMES. It is no longer the finish line on its own — a floor may
reach 0 by deletion rather than by migration, which is the point. Non-zero today:

- **Phase 1 (write dispatcher):** `runWriteChainFull`, `parseEdgeCluster`, `parseVertexSpec`,
  `resolveEndpoint`, `materializeElementDrivers`, `WritePlan`.
- **Phase 3 (repeat):** `expandRepeatBody`, `REPEAT_BODY_OK`.
- **Phase 4 (block assembler / row-algebraic / fast paths):** `TailAcc`; `globalRowOps` (legacy-side only
  now — every step name routes through RelIR when the rest of the chain does); `runFastPath`, `appliesWhen`,
  the five-copy `count` adapter, the four-copy `where` adapter.

---

## §9. Landed — the substrate to build on

Read coverage from the census; this is the qualitative map of what RelIR already lowers.

- **Reads:** element and scalar sources; source-scope filters; the `P`/`TextP` predicate vocabulary;
  movement (with bulk collapse); correlated `where`/`filter`/`not`; the `by()` modulator vocabulary;
  `dedup`/`identity`; the row-algebraic class (`limit`/`skip`/`range`/`tail`/`order`/`sample` as
  `Sort`/`Limit`/`Distinct`/`Window`); the scalar transform + reducer families; `has()`'s three argument
  shapes; the leading coercion prefix (`asNumber`/… folded at compile time, reusing legacy's parse).
- **Shapes:** the LIST shape (collection literal + `fold()`, member frame, set-ops, `unfold()`); the MAP
  shape (`group`/`groupCount`, value `by()`); the **PROPERTY shape** (`properties()` and its three
  retypes `key()`/`value()`/`element()`, plus `count()` — which needed no arm of its own, since
  `countExpr` reads the BULK CHANNEL and the property join carries the parent's channels through);
  the ALIAS channel (`as()`/`select(label)`); the PATH channel
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
  (`relirAhead`), the scenario-name set difference. **All of this is HARNESS** — it is cut per phase with
  the code it compares and gone entirely by Phase 4 (§6·1), so do not build on it.

---

## §10. The phases

**Ordering principle: FOCUS before volume, volume before capability.** Phase 0 deletes nothing and moves no
counter — that is the point, and saying it out loud is how it does not read as stalling. It is also the
phase that makes every later deletion a `rm` instead of a re-derivation.

**Naming.** The old work-unit names (`Phase 2.6` = the write dispatcher, `Phase 3` = repeat, `Phase 4.1/4.2/
4.4`) survive in `scripts/deletion-ratchet.tsv`'s notes and in code comments. Mapping: 2.6 → Phase 1,
3 → Phase 3, 4.x → Phase 4. Nothing else moved.

### Phase 0 — extract the kernels, sever the import graph

§8's table IS the worklist. Three kinds of edge, and they are not equally hard:

- ✅ **Pure kernels — move to a neutral module.** DONE; §8's table names where each landed. It was hours,
  as predicted, and it cut six of the fourteen non-exempt importers outright. Two corrections the work
  produced: **`scopedMovementCount` was never a kernel** (it reaches `pushChildScope` and `engineOf`, so
  it severs with the object model, not before it), and **the right neutral module was almost never a new
  file** — seven of the eight kernels had an existing home that already owned their concern
  (`ir/step.ts` for step-name vocabularies and argument decodes, `plan/plan.ts` for payload tuples,
  `ir/passes.ts` for IR production, `gremlin/` for TinkerPop semantics). Only `gremlin/validate.ts`,
  `gremlin/coerce.ts` and `ir/injection.ts` are new paths, and all three are whole-file MOVES.
- ✅ **Already scheduled to die.** `bareInjectTag` went with §6·7's per-row type channel — built, not moved.
  The `undefined` it returned for disagreeing declared types became `UNKNOWN`, which means "the JS client
  cannot say" and here meant "our source cannot carry two" — §6·5's mistake in the type channel, costing a
  wrong wire CLASS. The authority is now per ARGUMENT (`injectValueTypes`, `gremlin/coerce.ts`) with the
  uniform reading DERIVED from it; RelIR projects disagreeing tags into a `vt` column, in the stored-vtype
  vocabulary so the framer needed nothing new. `g.inject("zzz", datetime(…))` frames `['String','Date']`
  where legacy still frames `['String','Number']` — pinned in `test/rel-spine.test.ts`, because a coverage
  number cannot see it and the differential is blind to a reading both spines shared.
- **The object model.** ✅ for the ALIAS half: `AliasEntry`/`AliasMap`/`AliasScalarType` and their five
  functions now live in `plan/alias.ts` with the tagged-entry ENCODING they describe. **The plan's own
  instruction here was wrong and is superseded** — "give `src/compiler/rel/` its own alias and child-frame
  types" predates §10·10 retiring the `TraverserLayout` bridge, and a per-spine copy would have bought a
  second encoding to keep in step, silently (a wrong compile-time summary emits valid SQL against a correct
  encoding). What is LEFT of the object model is `LoweringState`/`Stream`/`TraverserLayout`/`ChildFrameStack`
  on the four SERVICE rows — and that is the residue below, which is not a retype at all.

**Done when `src/compiler/steps/` is imported by exactly two files: `engine/engine.ts` and `compiler.ts`.**
Nothing user-visible changes; the differential is at FULL value throughout, since no capability moves and
the two spines must therefore agree everywhere.

**THE GATE — `mise run edges` (`scripts/edges-check.ts`), floors in `scripts/steps-edges.tsv`.** This is the
criterion every later phase spends, so it is an instrument, not a `grep` someone remembers to run. It counts
DIRECT imports of `src/compiler/steps/**` from outside it, per importing file, with the symbols named — the
same shape as `scripts/deletion-ratchet.tsv` and for the same reason: **a floor may only be re-recorded
DOWNWARD** (`mise run edges-record`), a rise or a NEW importer fails the build, and prose here changes
nothing. It is a RATCHET rather than a zero-gate because zero is the wrong target — some importers ARE
legacy and keep their edges until Phase 4 deletes them outright. **Phase 0 is over when the exempt rows are
the only rows left.**

**THE BAR FOR AN EXEMPTION IS NARROW, and the narrowness is the whole value of the gate.** A file qualifies
only if it is reached ONLY by legacy AND does not exist after Phase 4. Three do: the two routers
(`engine/engine.ts`, `compiler.ts`) and the Engine INTERFACE they are typed by (`engine/deps.ts`).
**"Legacy still needs it" is NOT the bar** — that admits anything. A file that RelIR or a SERVICE reaches
must be severed however awkward, because it OUTLIVES the deletion, and an exemption there converts scheduled
work into a Phase 4 surprise. `deps.ts` only came to clear that bar because `compileViaRel` stopped taking an
`Engine` (it read two fields off it) and now takes a `RelRequest`; before that change it did not qualify,
which is why the bar is written in `scripts/edges-check.ts` and the TSV rather than left to a phrase.

Deliberately DIRECT edges only, not the transitive closure. The closure is what §8 measures to size the
prize, and it is the wrong thing to gate on: it moves when an unrelated file changes an import three hops
away, so it would fire on work that has nothing to do with severing anything. The direct edge is the thing a
commit actually cuts.

### Phase 0's residue — `call()` IS A CAPABILITY MIGRATION, and it was mis-filed as a retype

Phase 0 assumed the service rows were a TYPING problem: "retype `services/spi/types.ts` off legacy's
`Stream`/`ChildFrameStack`". Measured, they are not. **`call()` exists only on the legacy spine** —
`lowerToRel` has no `call` step at all — so `Contribution.build(site): Stream` returns a legacy `Stream`
because that is the only lowered form there is. Retyping the SPI to a spine-neutral type parameter would
sever exactly one row (`spi/types.ts`) and leave the three catalog services holding the same edge through
their own imports. **The edge is not the type; it is that the capability lives on one spine.**

So this is scheduled as its own unit, before Phase 4. It is NOT hard — the sizing below is measured, not
estimated — but it is a capability migration plus a deletion, which is Phase-1-shaped work and not something
Phase 0 (which "deletes nothing and moves no counter") can absorb. **Phase 0 therefore ends with four LIVE
service rows, and that is the honest state**: they are not exempt, they fail the bar, and the phase that
clears them is written down.

**THE CRUX: one SERVICE may never have two implementations — but that does not make the PHASE indivisible,
and conflating those two is the trap.** A service that produced both a legacy `Stream` and a `Rel` would be
the duplicated lowering `steps/CLAUDE.md` forbids outright, and legacy composes q-kernel CTEs so it cannot
consume a `Rel`. The first reading of that was "so `call()` migrates all at once". Wrong: it means each
service migrates all at once.

`Contribution` is ALREADY a discriminated union (`stream` | `barrier`) for exactly this kind of reason, so
the migration rides the discriminant. Add a third arm — `{kind:'rel', buildRel(site): …}` — and the routing
falls out with no service implementing anything twice:

- a `rel` service makes LEGACY's call route decline, so the traversal reaches RelIR;
- a `stream` service makes RELIR's call step decline, so it falls to legacy, which is the ordinary
  "not learned yet" `null` and needs no special case;
- `barrier` is untouched by either, since it contributes no lowering at all.

So the order is: `call()` into `lowerToRel` (declining every service still on `stream`) → `directory` →
`degree.centrality` → `search`, each its own green commit and its own census movement. When no `stream` arm
remains, the arm and legacy's call route (`steps/tail/call.ts`, `seedCall`, and the
`BarrierPoint`/`MidBarrierPoint` surface on `engine.ts`) are deleted together, and `Contribution` goes back
to two arms with `rel` in `stream`'s place. The transitional arm has an end date written into the phase,
which is what §6·1 demands of any harness.

What it actually costs, per service:

| service | kind | what RelIR needs | sizing |
|---|---|---|---|
| `federate`, `io` | `barrier` | **nothing.** A barrier `Contribution` has no `build` — its rows come from an awaited sibling and `apply` runs at EXECUTION time, in the executor's segment loop. Spine-independent already. | zero |
| ✅ `directory` (`--list`) | `rel` | a `Values` relation of strings + scalar-string framing — which is `injectSource` minus the coercion fold | trivial, as predicted |
| ✅ `search` (`tinker.search`) | `rel` | ~~translation, not design~~ — **this sizing was WRONG.** `RelFraming` had six arms and none was a PROPERTY, so the shape had to be built first (below). The service itself then was mechanical | **shape first**, then mechanical |
| `degree.centrality` | `stream` | **BLOCKED, and not on the seam** — see below. The seam part was built and MEASURED working; what stops it is `project()` | blocked on `project()` |

The genuinely new piece is `call()` as a STEP in `lowerToRel` — the source form (`g.call(…)`) and the
mid-traversal form (`V().call(…)`, which pushes a child scope) — plus making the SPI RelIR-native rather
than generic. Generic is the wrong answer here precisely because there is no second consumer to be generic
FOR once legacy's call route is gone; a type parameter would be scaffolding with no end date.

**✅ ALL SIX STEPS LANDED, and the edge ratchet has NO live rows left — `mise run edges` prints
"PHASE 0 IS OVER".** The exempt trio (`engine/engine.ts`, `engine/deps.ts`, `compiler.ts`) are the only
files reaching into `src/compiler/steps/`, which is the criterion this phase was written against.

1. ✅ `RelFraming` → its own leaf (`rel/framing.ts`), so a producer outside the fold can name it.
2. ✅ the registry stops at the DI boundary. `servicesNamedBy` resolves names in `compiler.ts`, where the
   app scope is, and the lowering receives the SETTLED services — not the registry. `ChainCtx` holds only
   settled values, and a `ServiceRegistry` is an ambient capability (`compiler/CLAUDE.md`).
3. ✅ the `rel` arm, plus `CallSite` split into the common contract with `StreamCallSite`/`RelCallSite`
   extending it — `CallSite` used to carry `q: Query` outright, which made it legacy-shaped.
4. ✅ `call()` as a SOURCE in `lowerChain`, routed through `continueAs` so a service's shape is not a
   special case there.
5. ✅ `--list`, then `tinker.search` (after the property shape).
6. ✅ `degree.centrality`, then the `stream` arm and legacy's stream call route deleted together.
   `Contribution` is back to two arms with `rel` in `stream`'s place, `StreamCallSite` is gone (it was
   THE UNNAMED PIN — the SPI typed on legacy's `Stream`/`ChildFrameStack`/`ChildParent`), and
   `scopedMovementCount` went with its only caller. What survives in `steps/tail/call.ts` is the
   BARRIER half only: federation's rows arrive from an awaited sibling, so `seedCall` builds a
   `BarrierPoint` or refuses, and the segment machinery is Phase 4's to delete with the engine.

### `degree.centrality` was blocked on `project()` — the RECORD shape is what unblocks it

The seam half works. Built and probed: a mid-traversal `call` in `terminal()` (which is exactly where
an element relation retypes to a scalar), the host and `ChildSeam.scalar` on the site, and the service
reduced to handing the seam a synthetic `[{name: direction}, {name:'count'}]` body — the same body
legacy's `scopedMovementCount` synthesises. `g.V().call("tinker.degree.centrality")` and its `OUT`
variant answered **identically to legacy** (`[0,1,3,1,1,0]` / `[3,0,0,2,0,1]` on the modern graph), as
did `.is(3)` and `.count()` after it.

**It was reverted anyway, and the reason is the pre-flight check every service migration needs.**
Migrating a service makes legacy REFUSE it, so a shape where RelIR declines for an unrelated step stops
being a fallback and becomes a THROW. All six corpus traversals that use this service are such shapes:

- **five go through `project()`** — `g.V().as("v").call(…).project("vertex","degree").by(select("v")).by()`
  — and `project()` is not on the RelIR spine at all. Measured directly:
  `g.V().project("a").by(__.out().count())` routes to legacy. That is a whole family, not a gap next to
  this service.
- **one is `g.V().where(call(…).is(3))`** — a call inside a `where()` CHILD BODY. This one is genuinely
  close: `g.V().where(__.in().count().is(3))` already routes to RelIR, so only the child-body position
  cannot reach the `call` handling, which lives in the element tail.

So migrating it would have fixed ZERO corpus traversals and broken SIX. **The order is therefore
`project()` first, then this service** — and the check is cheap: compile the traversals that USE a
service before moving it, not after. Nothing was kept from the attempt, because a `{kind:'value'}`
contribution arm and a mid-traversal call step with no service to exercise them are untested code, and
the finding is worth more than the diff.

**`project()` LANDED as the RECORD shape** (`src/compiler/rel/record.ts`, `RelFraming.record`), and the
shape is why it is not "a step": a record is a map whose KEYS ARE KNOWN AT COMPILE TIME, so its fields
stay addressable columns and a following `select(key)` re-roots to a stream of that field's own shape.
Collapsing it to the map VALUE `group()` already emits happens once, at the wire — which is also why it
needed no new `Shape` and no `execute.ts` arm. Three pieces came out of it that are not `project`'s:

- **`payloadCols(framing)`** — the payload column names each framing's relation carries, as a total
  function. Implicit knowledge until a record had to hold N of them side by side; field re-entry is now
  that list applied in reverse.
- **`byField()`** — the by() vocabulary's third question about itself, beside `byExpr`/`byNode`. Those
  two collapse a projection to one comparable value or one typed node, and both therefore lose what the
  projection IS. Multi-label `select()` and `valueMap()` are its next callers.
- **the child seam's `scalar` arm returns `{expr, framing, vtype?}`** — §6·7 one layer in. It was
  discarding a type it already had (`countTail` says `long`, `transformExpr` reports the cast
  subfamily's target, a leading `values(k)` has a stored vtype), so every child projection reached the
  wire to be guessed at.

What is LEFT before the service can move is the by() arm this service's own traversals need:
`by(__.select('v'))` over a SCALAR host, which is an ALIAS read rather than a correlated child — the
alias column is on the row, not behind a subquery.

**THE DESIGN POINT the attempt settled, so it need not be re-derived:** a
mid-traversal service contributes a per-parent VALUE, not a relation. `degree.centrality` is
`type: 'streaming'`, and what it produces per input vertex is one number. So `RelContribution` wants to
be a union —
`{kind:'relation', rel, framing}` for a SOURCE service, `{kind:'value', expr}` for a per-parent one —
and that split is not ours to invent: it is TinkerPop's own `Service.Type`, `start` versus `streaming`.
Making the product follow the declared type is what stops the mid-traversal form becoming a second
call-lowering.

Both rows are CUT now. Two things came out of the migration that are not this service's, and both are
the same shape of finding — a decline that was measuring the ROUTER rather than the algebra:

- **`servicesNamedBy` only scanned the TOP-LEVEL chain**, so `where(__.call(dc).is(3))` and
  `group().by(__.call(dc))` reached a lowering that had never been HANDED the service. §6·6's lesson,
  in the same function `rel-blockers` once had it in. It now walks nested arguments, `by()`
  modulators, `with()` values, option arms and repeat regions.
- **`valuePredicate`** — a body that PROJECTS a value and then TESTS it is a COMPARISON, not an
  existence question, which is the seam's third predicate answer and the one the other two could not
  give (`correlatedExists` declines every body whose head is not a movement). SQL's null semantics
  give the productivity rule for free. It closed the branch/where family's shared gap at the same
  time: `choose(__.values('age').is(P.gt(30)), …)` and `where(__.values('age').is(P.gt(30)))` route
  with identical answers.

**One lesson from the two that landed, both of which cost a debugging cycle and neither of which CI
caught:** migrating a service makes legacy REFUSE it, so (a) a service's own validation THROW must
propagate rather than being caught as a decline — §6·5's "the answer is an ERROR" — because legacy is no
longer there to raise the message, and (b) a shape the service used to answer EMPTY must still answer
empty rather than declining, since a decline now leaves nothing answering at all. Both were found by
probing the service by hand; the suites went green through both defects.

### Phase 1 — writes: three capabilities, then the first cut

**Measured, and it is much nearer than "write coverage COMPLETE" implied.** Re-measured 2026-08-07 over
every `graph initializer of` block: **127 of 131 distinct initializers already compile on the RelIR write
path and none throws** (multi-label `addV` included, once the graph's cardinality is `ONE_OR_MORE`). The
reference graphs are GraphSON-bulk-loaded and bypass the compiler entirely, bar two hand-authored seeds. So
the corpus LOADS without legacy writes once these capabilities land:

- ✅ **multi-label `addV("a","b")`** — already routed under `ONE_OR_MORE` (the `internLabels` CROSS JOIN is
  N-label by construction). ✅ **`addLabel()`** — LANDED as a sideEffect over an existing vertex stream:
  `internLabels`' creation pairing applied to rows that already exist, plus `elementProperty`'s
  snapshot-then-pass-through. `vertex_labels` is `PRIMARY KEY (node, label)`, so a repeat is a no-op through
  the emitter's new **`ON CONFLICT … DO NOTHING`** arm (an empty `onConflict.set` used to render an empty
  `DO UPDATE SET` — invalid SQL nothing could reach; it is the generic idempotent set-insert, not this step's).
  **The refusals DECLINE rather than throw, and that is the migration-shaped choice, not a weaker one:**
  `lowerToRel` may never throw (`rel-sweep`'s decline-contract gate), so while legacy's route lives it owns
  the message the suite matches — an edge (edge label cardinality is fixed at ONE by spec), an immutable
  graph, a mixed collection, a non-constant nested label. Both spines therefore raise
  `"Label mutation is not supported"` identically. Moving that refusal ABOVE both spines is §6·5's `verify`
  Pass work, and it is what `dropLabel`/`dropLabels` should land with — `dropLabels` can fall below `min`,
  so it is the one that genuinely needs a guard binding; `addLabel` needs none, because every MUTABLE
  cardinality has `max = Infinity`.
- ✅ **`addE` with implicit endpoints** (`addV(…).addE("self")`) — LANDED. An unset `from`/`to` defaults to
  the incoming traverser (`AddEdgeStepContract.java:88-92`), so both-implicit is a self-loop, not a refusal;
  the SOURCE form still declines (it carries no incoming vertex). Pinned in `test/rel-spine.test.ts` — the
  corpus exercises it only under PartitionStrategy.
- ✅ **`property(T.id, …)` / `property(T.label, …)` on `addE`** — LANDED, and it was NOT quite "the same
  mechanism on the edge insert". The partition is shared (`creationTokens` is host-agnostic, because
  `parseProperty` reports a token neutrally and lets the host decide) and both tokens are the reference's
  on this step. What differs is that **a supplied id needs TWO graph-dependent refusals here where `addV`
  needs one**: `addV` proves single-row at COMPILE time — its one-row case is a literal `Values` — while an
  `addE` mid-chain input is a traverser relation, and nothing static separates `g.V(1)` from `g.V()`. So the
  arithmetic `addV` settles by DECLINING becomes a second guard binding: `Limit{offset: 1, count: 1}` +
  `raiseWhen: 'rows'`, non-empty exactly when a second row exists. Without it, N rows sharing one public id
  collide on a UNIQUE the guard is not the authority for and surface as a RAW SQLITE ERROR rather than the
  reference's sentence — and upstream raises `id already exists` on its second loop iteration, so the
  message is the same one. **That is the general lesson for the rest of the write family: where a refusal is
  arithmetic over the INPUT's row count, a host that cannot count statically needs a guard, not a decline.**

**The payoff is the criterion itself: `MODERN_SEED` now compiles WHOLE on RelIR** — every statement a
program, and the nodes/edges/properties byte-identical to what legacy builds (pinned in
`test/rel-spine.test.ts`, because a seed that differs silently re-bases every test above it).

**Separate "can the corpus load" from "is write coverage complete" and cut at the first.** The residue below
is real work, but it is not load-bearing for running the suite and must not gate the deletion:

- **`property`'s residue** — the text-level refusal and the `T`-token/guard-binding halves are done (§6·5).
  Left: a meta-property under an UNDECLARED cardinality (the `set` arm PATCHES rather than inserts, an
  `UPDATE` this route does not emit yet).
- **the nested-value/label children** (`property(k, __.trav)`, `addV(__.trav)`, `addE(__.trav)`).
  **First, the case that is not a child body at all and was being counted as one:** a
  `ConstantTraversal` is TinkerPop's own wrapper for a LITERAL, and every write host unwraps it before
  anything else looks at it (`AddVertexStep.java:253-259`, `AddEdgeStep.java:180-181`,
  `AddPropertyStep.java:106-110` — *"Exclude ConstantTraversal which is used internally by TinkerPop to
  wrap literal values"*). So it never reaches the reference's per-traverser path, and folding it is the
  reference's behaviour rather than an approximation of it. ✅ LANDED for LABELS, through one authority
  (`constLabelArg`) because three hosts ask it; `addE(__.constant(l))` is `relirAhead`, since legacy
  refuses a nested addE label outright where the reference resolves the constant.
  ✅ **And for VALUES**, which took the extra step the labels did not: a label is always a string, while
  `vtype` names only the OUTER stored shape of a value. **The type was already there and was being thrown
  away** — `constFromNested` reads the constant's own `Arg`, which holds the full `TypeNode`, and returned
  the coarse vtype alone, so every caller wanting a typed constant had to re-infer from the JS value.
  §6·7's discard in miniature, and in the SHARED PARSE rather than in a lowering. Widening the carrier at
  the source costs one field and helps every type at once; the `withSideEffect` arm returns `null` for it
  honestly, since that value leaves the registry with no wire arg behind it. Census 864 → 881. The
  regression test that matters is `datetime`: re-inferring from the JS value yields a Number, a wrong wire
  CLASS rather than a wrong tag.
  **What is left is therefore the genuinely PER-ROW body**, and its rules are why it cannot be a
  correlated scalar: `AddPropertyStep.handleTraversalValue` collects ALL results, so 0 results means NO
  mutation (never a NULL write, which is what a scalar subquery would produce), >1 under `single` raises,
  and >1 under `list`/`set` writes each. That wants the HOST-KEYED relation — §6·6's honest fourth answer.

  **A RUNTIME LABEL IS WHERE RelIR CAN BEAT LEGACY OUTRIGHT, and the reference is what says so.**
  The question "can we validate a label we will not see until execution" looked like grounds to decline;
  it is not. `ElementHelper.validateLabel` is three PURE PREDICATES over the value — null, empty, hidden
  (`Graph.Hidden.HIDDEN_PREFIX` is `~`) — with no graph access and no traverser state, so all three are
  expressible in SQL and belong in a GUARD BINDING (§6·5) rather than in a decline. That is better than
  legacy on three axes at once and worse on none: one statement instead of O(rows) round-trips, the whole
  set checked before anything is written instead of the first bad row reached, and the reference's message
  verbatim either way. The atomicity difference is not new — every RelIR write is already one set-based
  statement, so "create some, then throw" is not expressible on this spine however the check is spelled.

  Three facts to build it against, none of them guessable:
  - **The message set depends on ARITY.** `addV(single)` is not a `Collection`, so the resolved value goes
    into `graph.addVertex(keyValues)` → `ElementHelper.getLabelValue` → `validateLabel`, giving the three
    `Label can not be …` messages (and a `ClassCastException` on a non-String).
    `addV(a, b)` IS a Collection, so it takes `AddVertexStep.resolveLabelCollection`
    (`.../step/map/AddVertexStep.java:165-182`), which raises FOUR distinct messages of its own BEFORE
    `validateLabel` runs: *"Label traversal must not produce null"*, *"…must produce a scalar String when
    multiple traversals are provided, but got a Collection"*, *"…must produce a String, but got %s"*.
  - **`TraversalUtil.apply` is `.next()`** — the FIRST result — so a rooted single-row label is the child
    seam's existing arm plus a `Limit 1`, exactly as `endpointOf`'s `read` arm already spells it for
    `to(__.V(2))`.
  - **Our shared `validateLabel` COERCES where the reference raises** (`String(label)`, `gremlin/validate.ts`),
    so a runtime label of `5` becomes `"5"` on BOTH spines today. A pre-existing divergence in shared code,
    invisible to the corpus (no scenario asserts any of these messages) and therefore exactly the class
    §12 says goes to the vendored source rather than to the corpus.

  So the build is: `internLabels` generalized from a compile-time `string[]` to EXPRESSIONS; a rooted
  single-row label through the seam's existing arm; an ALIAS-read label (`addV(__.select('a').label())`),
  which is a column already on the row rather than a subquery; and the validity guards, chosen by arity.
  **The reference is ASYMMETRIC and that decides the shape of the work** — read, not inferred:
  - A nested **KEY** resolves through `Parameters.get(traverser, T.key, …)`, which calls
    `TraversalUtil.apply` and takes `.get(0)`
    (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/Parameters.java:120-128`,
    `…/util/TraversalUtil.java:41-53`). `apply` is `traversal.next()` — the FIRST result, raising
    *"The provided traverser does not map to a value"* when there is none. **That is exactly the seam's
    `scalar` arm**, so a nested key needs no new machinery; same for a nested `addV`/`addE` LABEL.
  - A nested **VALUE** does not. `AddPropertyStep.sideEffect` detects a `Traversal` value that is not a
    `ConstantTraversal` and routes to `handleTraversalValue`, which collects ALL results via
    `TraversalUtil.applyAll` (`…/process/traversal/step/sideEffect/AddPropertyStep.java:105-199`) and then:
    **0 results → NO mutation, the element passes through unchanged** (`:140-142`);
    **>1 under `single`** (declared, else `graph().features().vertex().getCardinality(key)`) →
    `IllegalArgumentException` *"Single-cardinality property requires exactly one value, but traversal
    produced N results"* (`:172-182`); **>1 under `list`/`set`** → each written as its own value, and a
    non-Vertex element is an `IllegalStateException` (`:184-195`); otherwise `results.get(0)` (`:199`).
    The single-argument `property(traversal)` MAP form is a third case, flagged by `mapForm` rather than by
    inspecting the key, and it REQUIRES a Map result (`:150-168`).
  So: **the key, the label and any provably single-row value are the seam's existing `scalar` arm and can
  land now.** Only a possibly-multi-row VALUE needs more, and what it needs is a HOST-KEYED relation — the
  child body applied to the whole owners relation at once, carrying the owner key. Not a lateral and not a
  new node: the ordinary fold with that relation as its input. It is also Phase 4's `local`/`properties`
  shape, so it is the one honest candidate for a FOURTH seam answer (§6·6 says three; this is the case that
  would make it four, deliberately). The `single`-cardinality-above-one throw is graph-dependent, so it is a
  GUARD BINDING.
- **`PartitionStrategy` on a merge**, and `addE` after `addV` in one chain.

**`inject()` is not a write and must move with this phase.** `routeWrite` owns it as a SOURCE
(`steps/write/write.ts:1295`), and measured over the full suite it is the dispatcher's largest tenant by a
wide margin: of **944 distinct traversals the legacy dispatcher answers, 591 (63%) contain no mutating step
at all**, 543 of them `g.inject(…)` reads. Deleting "the write dispatcher" without moving `inject` deletes
a third of what it does.

**`mergeE` landed, both endpoint kinds.** Three findings kept because each refutes something this plan
assumed: **P5b did not arise** (an edge's `(src, tgt)` IS its correlation key, so created edges join back BY
VALUE and nothing depends on `RETURNING` order); **the constant and incoming endpoint cases are ONE
lowering** (carry the endpoint PAIR beside each incoming row; `Distinct` over the pair is what makes
duplicate traversers right, and a constant endpoint is the degenerate case); and **no gated counter moved,
which is not a null result** — every parameterized `mergeE` arrives as a bound Map the corpus cannot
express, so `test/rel-spine.test.ts` is the record instead. **A family whose corpus presence is
parameterized needs a test, not a counter.** `option(Merge.outV/inV, …)` landed too and corrected a shared
MISREADING: a `Merge.outV` in a map's `Direction` slot is a REFERENCE to that option, not to the incoming
traverser, and its absence is an error (`MergeEdgeStep.resolveVertex`, gremlin-core
`.../step/map/MergeEdgeStep.java:231-251`). Both spines substituted the current traverser — agreeing, so no
differential could see it. **Where both spines share a reading, the corpus and the differential are BOTH
blind; only the reference is not.**

**THE GAP TO THE CUT IS MEASURED, NOT ESTIMATED — and the way to measure it is to TURN THE ROUTE OFF.**
The prose above ranked the residue by reading the code, which is exactly the method §7 warns about: it
reports what the author remembered, not what the suite needs. Stub `routeWrite` to `null` behind a local
env switch, run L3, and the answer is a NAME LIST — 78 scenarios (measured 2026-08-08, at L3 1749/2267).
Run each blocked traversal back through `lowerToRel` prefix by prefix and every one of them names the step
it stops at. **Do that before touching a lowering, every round: the ranking it produces disagreed with the
prose in the first entry.**

What it found, in size order, and the first line is the point:

- **`labels()` — a READ — was holding the entire label-write family**, ~20 of the 78. Every
  `addLabel`/`dropLabel` scenario ends in `.labels()`, so the writes lowered and the tail did not, and no
  amount of reading the write module could have shown it. ✅ LANDED (`terminal()`, census 937 → 942):
  `label()`'s FLAT-MAP twin per `LabelsStep`'s own javadoc, the edge arm sharing `label()`'s projection and
  the vertex arm being `values()`' join with the label side tables. The INNER join is the SPECIFIED answer,
  not a default — under `ZERO_OR_MORE` a zero-label vertex must contribute no rows.
- **`mergeV`/`mergeE` positions**, ~28. ✅ **The SCALAR-STREAM half landed and it was one line of
  substrate.** What `addV`/`addE`/`mergeV`/`mergeE` take from their input is its ROW COUNT, and a
  scalar relation has one exactly as an element relation does — the reference draws no distinction,
  since `MergeVertexStep` never looks at the traverser except to materialize a map from it. What
  declined was the SNAPSHOT, which projected an `id` column a scalar relation does not have, so the
  fix is `traverserCol` (`id` for an element relation, `v` for a scalar one) plus routing, and NOT a
  scalar-specific write path. `elem` widens to `Elem | null`, which is the whole of the safety: the
  two steps that read the traverser as an ELEMENT — `addE` with an implicit endpoint, `mergeE` with an
  omitted `Direction` — already test `elem !== 'vertex'` and refuse. **RelIR is now AHEAD on the
  CREATIONS**: `routeWrite` builds an ELEMENT prefix and throws on a scalar source, so
  `g.inject(1).addV("person")` had no answer at all before. L3 1748 → 1750, census 942 → 944 — and the
  second census gain is a PartitionStrategy write over an `inject` source, a COMBINATION neither half
  was reachable in before, which is the compounding §7 predicts and a per-step counter cannot show.
  What is LEFT is the ENDPOINT-LESS `mergeE` (`g.mergeE([:])`, `g.mergeE([(T.label):'self'])`): with no
  `Direction` key the search is `g.E()` [+ label] [+ props] and `resolveVertices` resolves nothing, so
  a MATCH is answerable and a CREATE is impossible — the reference raises *"Out Vertex not specified in
  onCreate - edge cannot be created"* exactly when the search came back empty. That is a GUARD BINDING
  with `raiseWhen: 'empty'`, not a decline.
- **`dropLabel()`/`dropLabels()`**, ~12 — ✅ LANDED, and this plan had the guard on the WRONG STEP.
  `LabelCardinalityValidator` splits them and the split decides the shape of the work:
  `validateDropAll` raises for ANY `min > 0` *whatever the element carries*, so `dropLabels()` is a
  COMPILE-TIME decline (a guard there would always fire); `validateDrop` SIMULATES the removal and
  raises only if the survivors fall below `min`, so `dropLabel(x…)` is the one that earns the guard
  binding. It runs BEFORE the delete — the reference's own order, and what keeps a refused drop from
  leaving a partly stripped vertex — and it counts CORRELATED per owner rather than grouped, because a
  vertex losing all its labels produces no group row and `HAVING COUNT(*) < min` would miss exactly
  the element that fell furthest. The snapshot-then-pass-through and the argument grammar are now
  SHARED with `addLabel` (`labelMutationScope`, `mutationLabelNames`) rather than copied.
  **Nothing in the corpus reaches that guard** — `ONE_OR_MORE` is the only cardinality where a named
  drop can fall below the floor and no conformance graph declares one (`@MultiLabel` maps to
  `ZERO_OR_MORE`) — so `test/rel-spine.test.ts` is the record, exactly as `mergeE` needed.
- **`property(k, __.trav)` with a possibly-multi-row VALUE**, ~13 — the HOST-KEYED relation below, and the
  only item on this list that needs new substrate rather than a new position.

**The cut:** delete the write route, `steps/write/write.ts`, and the write half of the differential.

### Phase 2 — ✅ sack, then the extracted families

**✅ `sack` LANDED** (`src/compiler/rel/sack.ts`), and the prediction held: `src/channels.ts` already
modelled the role completely — merge `identical`, barrier `drop`, a `ROLE_ORDER` slot, a group policy of
`undefined` — so seeding, folding and reading it is three projections. Legacy's 94 lines had no
counterpart to port: they hand-roll the layout re-projection, THROW on
`aliases.size || path` (a sack may not coexist with any other per-traverser channel) and defer
sack-through-repeat/barrier/local and split/merge-on-fork, which are exactly the questions §3.5's
obligations checker answers for every channel at once. Coexistence is now what happens when nobody
prevents it.

**One correction to what this section used to say, because it read as cheaper than it was:** "delete the
gate and let the machinery that already exists carry it" overstates it. Deleting the gate alone makes a
sack traversal DECLINE — the CHANNEL existed, the STEPS did not. The gate deletion is what makes the work
REACHABLE; the lowering is new code. Small, but new.

**THE LAST ROUTE-LEVEL GATE IS GONE WITH IT.** `compiler.ts`'s `!sackInit` never OFFERED a `withSack()`
traversal to this route, whatever else was in it; the seed now travels as a settled value like
`labelCardinality`, and what the route cannot express declines inside the lowering. That is §6·6's lesson
at the routing switch — and the same defect turned up twice more in the same increment, which is why it is
worth naming as a class rather than as three bugs: `rel-blockers` was not handing the lowering the seed
either (825 → 850 with no code change), and `servicesNamedBy` scanned only the top-level chain.

Two DECLINES remain, both honest: `withSack(seed, Operator.x)` names a MERGE operator, which is a third
policy answer for the role and therefore a channels-core change rather than a step lowering; and
`barrier(Barrier.normSack)` is its own step.

#### ✅ `math` — the OPS RECORD landed, and the resolver turned out to be the interesting half

**The split was where the correction said it was** (`src/gremlin/math.ts`): the lexer, the
precedence/associativity climb, the juxtaposition rule (`sin _`), the messages and the function NAME
set are shareable; `realLit`'s `raw()`, every `q\`\`` in the climb and all twenty `FN` entries were
CONSTRUCTION. `compileMath<T>(formula, ops: MathOps<T>)` is the shape — seven primitives (`variable`,
`real`, `binary`, `negate`, `call`, `conditional`, `compare`, `nul`), each spine supplying its own
(`qMathOps` in `steps/tail/mapscalar.ts`, `relMathOps` in `compiler/rel/math.ts`).

**The AST split stays refuted and it is worth keeping the reason**: three of the twenty entries are
non-derivable SQL facts, not operator names — `log` is exp4j's NATURAL log and maps to `LN` while
SQLite's own `log()` is log10; `cbrt` splits on sign because `POW` domain-errors to NULL on a negative
base with a fractional exponent; `signum` is a three-way `CASE`. An AST whose nodes are `{fn:'cbrt'}`
makes each spine re-derive that expansion (§12's "a non-derivable fact must not be re-implemented"),
and the `conditional` primitive is exactly what an ops record has and an AST does not. The gate that
holds it is now a TEST rather than a claim: both L2 math tests run every kernel assertion in a loop
over both spines, which is the one thing no per-spine assertion could see.

**THE PREDICTION ABOUT THE RESOLVER UNDERSOLD IT.** "`scopeValue` answers both" was right and the
consequence is bigger than a saved parse: a math variable NAMES A HOST, and the ring's `by()`
PROJECTS a value out of it (`MathStep.processNextStart` —
`TraversalUtil.produce(getNullableScopeValue(Pop.last, var, traverser), traversalRing.next())`). So
the whole resolver is `scopedHost` (new, `modulator.ts` — the by() vocabulary's fourth answer about
itself, beside `byExpr`/`byNode`/`byField`) composed with an UNCHANGED `byExpr`. What falls out
rather than being built:

- **element, VALUE and RECORD hosts all work**, including the `project()` blocker this section
  predicted (`project('a','b')…math('a / b')` reads the FIELDS by map-scope-first);
- **`math()` as a CHILD BODY**, leading and mid-run, so the whole by()-child matrix gains it at once.
  The two child arms' transform loops were byte-identical and are now one `valueRun`, which is where
  mid-run composition (`by(__.values('age').math('_ * 2'))`) lives;
- **a `by()`-less `math("a + b")` over labelled values ANSWERS**, because `TraversalRing.next()`
  yields nothing for an empty ring and `TraversalUtil.produce` hands back the scoped value. Legacy
  throws there — RelIR ahead, recorded, not reconciled (§6·1).

Two rules the increment settled: the productivity filter is ONE `v IS NOT NULL`, because SQL's NULL
propagation IS `MathStep`'s `productive` flag (every operator and both sign-split CASEs return NULL
for a NULL argument); and an ELEMENT under an identity `by()` DECLINES, because the reference RAISES
there (`traverser.get()` is not a Number) and projecting a rowid would answer a different question.

Measured: census 862 → 881 (+19), 0 changed answers, L3 flat in both positions. `binds`/`bound` stayed
at 0 — a property key is a compiler-held constant — so only statement text moved (`sql-hygiene`).

#### ✅ `format` — the family was two members, and the shared PATTERN was a correctness fix

**`math()` and `format()` are ONE question**, and naming that is what made the second member nearly
free: a small language over the traverser's SCOPE, one value per row, with a productivity rule that
drops the traverser when a reference does not resolve. Upstream says so too — both are `MapStep`,
`ByModulating`, `TraversalParent`, `Scoping`, `PathProcessor`, both driving a `TraversalRing` — and
legacy's own header called them one section while giving each its own copy of the ring, the
resolution and the projection. `compiler/rel/projector.ts` is the family; what differs is three
fields (`projectorValue`), and the relation they land in is shared. `format()` therefore arrived at
all four positions at once (element, VALUE, RECORD, child body) where legacy has the element host
only.

**The template PARSE moved to `gremlin/format.ts`, and it is a PLAIN PART LIST rather than an ops
record — the asymmetry with `math` is the point.** A template part carries no non-derivable SQL
fact, so the shared form is exactly as large as the shared content. What it BOUGHT is a correctness
fix on both spines at once: the reference's pattern is `(?<!%)%\{(.*?)\}` and **the lookbehind is an
ESCAPE**. Each spine carried its own `%\{([^}]*)\}`, which read `%%{name}` as a reference and then
filtered every traverser for which `name` did not resolve — a wrong answer with the right arity,
AGREED ON BY BOTH SPINES, so neither the differential nor the census could see it. §12's rule with a
fresh witness: agreement between the two spines is evidence of a shared cause, not of correctness,
and only the reference is not blind.

Three semantics read off `FormatStep.processNextStart` rather than inferred: the ring advances ONLY
for `%{_}`; `%{name}` is a PROPERTY FIRST and then a scope key with a NULL traversal (so a named
token takes no `by()` at all, and `COALESCE(property, scoped)` IS that fallthrough — with the
property branch guarded by `current instanceof Element`, which is why a VALUE host reads the scope
key directly rather than declining as legacy does); and the filter is
`!productive || get() == null`, i.e. a productive-but-NULL token filters too, which is exactly what
`||` does. A token-free template is a constant and owes no filter at all.

Measured: census 881 → 888, 0 changed answers, L3 1744 → 1745.

#### ✅ the ELEMENT-membered list — and the ranking instrument that was hiding the real top family

**Read the instrument as code that can rot.** `rel-blockers`' `blame()` told a NAMED collection
(`group("a")…cap("a")`, a side-effect substrate) from an unkeyed barrier (`group()`, the map shape) by
`typeof step.args[0] === 'string'`. An `Arg` has been `{value, type, name}` since a user PARAMETER
became a first-class IR fact, so that test had been permanently false and every labelled
`group`/`groupCount`/`aggregate`/`store` was filed under the unkeyed bucket. The board said *78 the
map shape · 0 side effects*; it actually reads **95 side effects · 48 the map shape**. The largest
family was reported as absent and the third as the first. Nothing in the compiler changed — this is
the ranking every increment is chosen by, and it was ranking by a wrapper.

**Then the element-membered list, which is ONE substrate wearing four names.** `fold()` over an
element stream, `cap()` over a named collection, `group().by().by(__.out().fold())` and `aggregate`'s
default member were all blocked on the same missing thing, and `listPayloadExpr`'s own decline comment
had already named the trigger — *"it becomes reachable the moment `fold()` over elements lands."*

**THE MEMBERS STAY ROWIDS FOR THE WHOLE OF THEIR LIFE INSIDE THE ALGEBRA.** `foldElements` collects
ids, `unfoldList` hands them back as an ordinary element relation, and only `listPayload` expands them
— at the ROOT, once per SURVIVING member. Two things follow that would not from expanding inside the
barrier: the round trip is LOSSLESS (a payload object has no rowid to move from, so `unfold().out()`
would have to parse one back out of JSON), and a discarded member is free
(`fold().range(local,0,2)` computes two property bags, not six). `elementNode`/`elementObject` are now
a pair over one `correlatedElement`, because the two encodings serve two framers and the FRAMER
decides which: a typed tree's member needs the `{t,v}` tag, an `of.kind === 'elem'` list must not have
one.

**A fail-closed VIOLATION fell out of it, and it is §12's channel rule with a new witness.** The
ordered `dedup()` hardcoded `aggs: [['bulk', …], ['encounter', …]]` while deriving its declared TYPE
from the input's channels. Every ordered element relation carried both until a `fold().unfold()`,
which is the first that does not — a fold collapses the stream to one traverser, so the members come
back with a position and no multiplicity. The factory caught the mismatch as a THROW out of a lowering
whose contract is `null`: RelIR failing where legacy answers, the one failure the routing switch
cannot absorb. **Never name a channel list** — the aggregates are derived from the channels the input
carries, and a role with no defined N→1 answer declines.

Two places RelIR is AHEAD, pinned rather than reconciled: an EMPTY fold frames as one empty list
(`FoldStep` supplies a seed), and `fold().unfold().values("name")` keeps the traverser order where
legacy answers alphabetically — the property table's scan order showing through. Both spines are
asserted to frame an element fold to the SAME BYTES through two different `Shape` descriptors, which
is the claim that actually needed a gate.

Measured: the list-shape family 31 → 10.

#### ✅ the NAMED-COLLECTION substrate — `aggregate()`/`cap()`, and a fact the front end was dropping

**The largest family on the board (95) needed no new node kind, no `Binding` and no executor
change**, which is what §3.0 had already predicted: *a named CTE and a prior result are the same
concept*. A collection IS the relation the traversal held at that point, and a node referenced from
two places in the DAG is what the `name` pass already turns into a CTE. `aggregate` records the node,
`cap` reads it, the sharing is the mechanism. It rides directly on the element-membered list above —
a bare `aggregate` over vertices is `foldElements`, a projected one is `foldScalars`, `cap` is
`listTail` — which is what "land the whole FAMILY" buys and a per-step increment would not have.

**The fold happens AT the aggregate, not at the cap**, because that is what "the value at this point"
means: `AggregateGlobalStep` is a barrier, so the collection is complete and a `cap` anywhere
downstream reads the whole of it. Deferring it would mean re-deriving which relation was current N
steps earlier — the "the query never exists as data" problem the migration exists to end.

**THE LOAD-BEARING HALF IS A FACT THE FRONT END WAS DROPPING.**
`withSideEffect("a", 1, Operator.max)` supplies an initial value AND a merge policy, neither of which
this substrate expresses — and the decline was IMPOSSIBLE TO WRITE. `extractSideEffects` skips the
reducer form (correctly: there is no constant to substitute) and recorded nothing, so the label read
as FRESH and the collection registered with the seed and the operator silently dropped.
**`compiler.ts` had already written down that this decline belonged "inside the lowering"; what was
missing is that a lowering cannot decline on a fact it cannot SEE.** `sideEffectReducers(tree)` is
that fact — a SET, separate from the constant registry because the two hold different kinds of thing
(a value to substitute versus a policy), travelling as a settled value exactly as `withSack`'s seed
does rather than as a route-level gate. **Generalize it: §6·6's rule has a mirror. A gate at the
router reads identically to a missing lowering; so does a fact the FRONT END drops, and the second is
harder to see because nothing in the compiler is even asking.**

One deliberate non-claim, recorded so it does not read as an oversight: a projected collection folds
BARE rather than typed. §6·7 wants the per-row type and `by('uuid')` will need it — but claiming it
changes the answer for an ALL-NULL collection (`ProductiveByStrategy` keeps a null member per
unproductive traverser), because a local reducer over a TYPED list of nulls emits nothing where over
a BARE one it emits null. That is a question about `MaxLocalStep`, not about collections, so it
matches the spine being replaced and the tag is its own change on both sides.

Measured: census 890 → 916, 0 changed answers.

**✅ the labelled forms too.** `group("a")`/`groupCount("a")` differ from their unkeyed twins in what
happens to the RESULT, not in how the map is computed, so `groupBarrier` builds either and the CALLER
decides. `Collection` carries a `RelFraming` rather than a `ListOf`, which is what made that small:
`cap()` hands the pair to `continueAs` and whichever tail owns that shape takes the rest of the chain.
**A divergence arrived without being new** — the keyed twin of an already-declared `RELIR_AHEAD` row
became visible the moment this family routed, which is worth naming as a class: a shed capability does
not become a fresh divergence when a NEIGHBOURING family lands, it stops being hidden behind a
fallback. It also nearly cost a wrong "fix": `group().by(k).by(__.constant(1))` is `{j:1}` on RelIR and
`{j:[1]}` on legacy, and the plausible reading (a non-reducing value traversal collects) is refuted by
`Grouping.convertValueTraversal` — it appends `fold()` for a `ValueTraversal`/`TokenTraversal`/
`IdentityTraversal`/`ColumnTraversal` ONLY (`gremlin-core/.../step/Grouping.java:92-101`) and returns
an anonymous CHILD unchanged, so the operator is `Operator.assign` and one value per key is right.
§12's trap, avoided by one grep.

#### ✅ §6·7's lattice at the ARM MERGE — the first of its three sites

`sameFraming` compared the whole `ScalarType`, so `union(__.values('name'), __.constant(1))` declined
for no reason but a tag disagreement: both arms are one value per row, the relation merges perfectly,
and all that was missing was somewhere to record that the halves are typed differently. That somewhere
is the `vtype` column a stored read already carries; the cost is one projection per arm, and the meet
runs BEFORE the framing and column tests because re-projecting is what makes the arms comparable.

**One refinement of the plan's lattice, recorded as a deviation.** `static ∧ static(same)` stays
static (agreement costs no column — this is a widening, not a re-encoding); `static ∧ static(differ)`
and `perRow ∧ x` go per-row. The plan said `unknown ∧ x → unknown`; an UNKNOWN arm now contributes a
NULL tag instead. Not a different answer — a null `vtype` IS "infer from the value" — and strictly
more capable, because collapsing would discard an arm's `datetime` because its SIBLING could not say.
That discard is precisely what §6·7 exists to end, so reproducing it at the merge would have been the
same bug one layer along. The remaining two sites (the inject source, the reducer) are unchanged.

**✅ `union()` in SOURCE position** landed beside it, and it is a source ARM rather than a widening of
`unionArms`: that one lowers each body against the CURRENT traverser, and a source union has none —
each arm is a whole traversal re-entering `lowerChain` through the seam's rooted answer. Everything
after the arms exist is shared, and `mergeArms` taking a `Channels` rather than an input RELATION is
what makes it parent-agnostic in the types as well as the comment (it only ever wanted the channels).

**A SILENT NARROWING fell out of it, and it is §6·6 at a second seam.** `rootedRead` re-entered
`lowerChain` with five settled values and dropped three — `services`, `sack` and
`sideEffectReducers` — so a rooted arm naming a service was handed LESS than the chain around it and
declined for want of a fact the compile already held. Same class as `servicesNamedBy` scanning only
the top-level chain and as `rel-blockers` not passing the sack seed: **whenever a seam re-enters the
fold, check what it HANDS OVER before concluding what the algebra cannot express.**

#### ✅ the VARIANT — and it added NO wire concept

Arms of different SHAPES now merge as a per-row tagged union, and almost all of the family was one
syntactic shape: a two-argument `choose` has an IMPLICIT identity else arm (`ChooseStep`'s private
constructor installs one), so the moment its `then` retypes the branch is mixed.

**`Shape{kind:'variant'}` and the `vk` discriminant were already legacy's and `execute.ts` has always
framed them** (0 null, 1 scalar, 2 vertex, 3 edge, 4 list). So this taught the ALGEBRA to produce rows
the framer could already read — §6·3 exactly — and the proof is that both spines now DECLARE the same
arm list for a shape they both answer, not merely the same rows. **Structurally it is the scalar meet
one level up**: a tag disagreement widens the schema by ONE column, a shape disagreement by THREE, and
both then hand the arms to the same `Union`. §7's bar is "show the seam cannot EXPRESS the shape" — it
could; it had not been taught to.

Rowids until the root, as the element list does: an element arm carries only `rid` and
`correlatedElementColumns` expands it once, a THIRD caller of the same id/label/props expressions
rather than a third spelling of the tuple. The scalar arm declares a STATIC tag or `UNKNOWN` and never
the `perRow` an arm may arrive with — the payload has no `vtype` column, so `perRow` would describe a
row shape the algebra did not build. Carrying it is §6·7's extension point and needs the framer to
read it, i.e. a wire change.

RelIR ahead in two ways, both pinned by decoded CLASS rather than by rows (a vertex framed through
`rowEdge` is a wrong GraphBinary type, not a wrong value): the retyping two-arg `choose`, which legacy
refuses outright; and MIXED ELEMENT KINDS, a shape legacy's own wire vocabulary can express (`vk` 2 vs
3) and its lowering declines.

**The family barely moved (55 → 54), and that was the finding**: what was left of `choose` was almost
entirely the OPTION-MAP form.

#### ✅ the OPTION-MAP `choose` — and three things it taught

**It needed a FACT, not a gate.** `ChildValue.present` carries productivity beside the value, because
`Pick.none` (a productive choice matching no key) and `Pick.unproductive` (a choice that produced
nothing) are distinguishable no other way — `TraversalProduct` calls a productive null a value, so
`choice IS NULL` answers a different question. A body that cannot report it DECLINES. §6·7's rule at a
third seam, and legacy computes the identical signal as its modulation `present` column.

**WHICH ARM A ROW TAKES IS ONE COLUMN, and the measurement is the argument.** The naive gating is
O(n²) in the EXPENSIVE term — arm k tests its key, negates every earlier one, the pass-through negates
them all, and a key test is the vtype-aware ordering compare `is(P.between(…))` spends. A three-option
map: **18.7 KB** of statement text with the choice inlined, **7.5 KB** with the choice projected to a
column, **1.9 KB** with the tests projected into one ordinal `CASE`. The group key's rule one level up.
The ordinal also gives FIRST-MATCH-WINS free, because a `CASE` takes its first true `WHEN` — and that
rule cost a wrong answer first: `BranchStep.pickBranches` collects EVERY match, and `ChooseStep`
OVERRIDES it with `branches.subList(0, 1)` (`.../ChooseStep.java:139-142`). Reading the super-method
alone emitted six rows where `Choose.feature:244-256` pins four.

**TWO COMMITTED L4 EXPECTATIONS ENCODED LEGACY'S BUG**, which is the part worth generalizing. Our own
addendum asserted that an UNPRODUCTIVE choice takes the `Pick.none` body; it takes the unwritten
`Pick.unproductive` identity, i.e. the traverser itself, and the OFFICIAL corpus pins that exact
pattern elsewhere (`Choose.feature:371-387`). The scenarios were written when legacy was the only
spine. **An addendum written against one implementation records that implementation, not the
reference** — so an L4 scenario in a family the migration is about is worth re-deriving from
`gremlin-test`/`gremlin-core` rather than trusted.

Closing the gap in LEGACY was tried and REVERTED, and the rule that decided it is worth stating:
declining its CASE projector does make legacy correct there — its own comment predicted as much — but
it hands the shape to a `map()`-child position NEITHER spine lowers, so a second L4 scenario stopped
being answered at all. **§6·1 lets legacy SHED a capability RelIR holds; it does not let the union
lose a shape.** Legacy keeps its documented gap; the scenario is tagged `@SpineRel`, because the two
spines ANSWER differently here rather than one refusing (which is what `@RelIR` declares).

Measured: census 929 → 937 (40.8%), L3 1747 → 1748, branch 54 → 46.

Then the families whose kernels Phase 0 extracted and whose only remaining legacy content is emission —
`math`/`format` were the proof case (§6·4) — then the scalar-transform tail, the property shape
(`properties`/`valueMap`), the map shape's mid-chain consumers, branch, aliases, `local`, `match`, `where`,
`path` tails, the by()-child matrix (`group`←reducer, `project` as a step, `select` multi-label), and the
named-collection substrate the string-label `aggregate`/`store`/`cap` side effects need.

### Phase 3 — `repeat()` — THE GATE

The one family whose absence disqualifies the server, so deletion waits on it and on nothing else.
`flatten` (P1 legality in `check`; a body that cannot be made legal throws a clear deferral) → route
`repeat()`'s body through ordinary lowering → `unroll` for `times(n)` (take `dedup` first, one barrier per
commit with an L4 pin; `prune`'s remainder — pruning below Join/Union/Aggregate — is a precondition). Per §1
P4 that is the 48 `times(n)`-bounded majority; the 5 `until()`/`emit()` barrier bodies throw the P3 wall.

Phase 4's read-side work rides along where it is a prerequisite: the block assembler replaces `TailAcc`,
`ELEMENT_DISPATCH` joins the shared substrate, aggregate/count handlers become one `Aggregate`, and
`recognize` (§4.7) makes the fast paths plan rewrites, which lifts the FTS decline.

### Phase 4 — `rm -rf src/compiler/steps/`

Phase 0 severed the graph and Phase 3 cleared the gate, so this is a deletion, not a migration. Sweep
SYMBOL-level, not file-level — `bun scripts/refs.ts` and `mise run orphans`, since a file-level closure
over-counts (§8). Everything legacy still answered on the day becomes a clear deferral, NOT a blocker: that
is the exit criterion (§6·1), and a traversal that stops working is a recorded regression to be re-earned in
RelIR, never a reason to keep the route. The routing switch, `options/spine.ts`, `MOGWAI_RELIR`,
`test:legacy-spine`, the `legacySpine` L3 floor with `unionPassing`/`partitionLegacyRegressions`/`spineGap`,
the census's legacy pinned position, `relirAhead` and the per-test `{spine}` pins all go with it.

### Phase 5 — the docs sweep

The corpus of `docs/` was written against a two-spine world and most of it will be lying by here.

1. **Archive every plan that only describes the old pipeline** — move to `docs/archive/`, do not edit in
   place. A plan whose subject no longer exists is not a stale plan, it is history.
2. **Edit every plan that PARTLY survives down to what still applies.** Delete the superseded half rather
   than annotating it; a doc that argues with itself costs more than one that is short. This file included.
3. **Sweep the citations.** Code comments and `scripts/deletion-ratchet.tsv` notes cite `§`-numbers and the
   old phase names; a deleted section must not leave a dangling reference (root `CLAUDE.md`'s pointer list
   and `src/compiler/CLAUDE.md` both name files that will move).
4. **Then, and only then, refresh `docs/feature-support-matrix.md` and `docs/outstanding-work.md`** — the
   matrix per step against what actually compiles post-deletion, the index re-derived and COMPACTED.
   Doing these before the sweep records a world that is about to change.

### §10·6 Correctness follow-ups — orthogonal to the phases

Each cited, corpus-mostly-invisible, none a one-liner. Rank them against phase work, do not queue them
behind it.

- **The per-row scalar type channel (§6·7)** — one `ScalarType` lattice, the inject source and the arm merge
  going `perRow`, `bareInjectTag`/`DECLARED_TYPE_REQUIRED` deleted. Removes the branch family's
  tag-agreement declines, and Phase 0 depends on it to avoid moving `bareInjectTag` pointlessly.
- **The `set` framing marker** survives `range(local)`/`all`/`any`/`none` and is dropped only by
  `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop. That loop is
  duplicated (`src/compiler/rel/list.ts`'s `ListOf.set` vs the legacy `ListStream.set`); land it in RelIR and
  let legacy shed the shapes it gets wrong (§6·1).
- **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type today) — needs head-position tracking on the RelIR `AliasEntry`.
- **Checker hardening (Phase 3 prereqs):** refuse `Distinct`/`Limit`/`Sort` inside a recursive term (P3); a
  whole-row `Distinct` may not carry a per-row-unique channel; an `aggs` entry may not reference an input
  column outside an `Agg`; `name` should walk expression subplans (a shared node in a `Scalar`/`Exists` body
  is inlined twice).


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
