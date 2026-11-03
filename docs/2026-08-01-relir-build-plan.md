# RelIR — the algebra

`Step[] → RelIR → SQL`: an inspectable, rewritable relational algebra between the Gremlin front-end and
the `q` SQL kernel. It is the ONLY lowering.

**Numbers live in instruments, never in this prose** — coverage is `test/L7-census/goldens.tsv`, the
conformance floor is `test/L3-conformance/l3-state.json`, the per-family blockers are
`mise run rel-blockers` (re-run it; it moves). A machine-checkable statement of the same rules:
`docs/spec/relir-algebra.allium`.

**Legend:** ✅ landed (the mechanism is in the code; the line records only that it exists) · ⚠️ trap, do
not re-derive · 🚧 left · 🔴 needs a human call.

---

## §1. The measured platform envelope — LAW, do not re-derive

SQLite 3.51.2, re-confirmed on DO SQLite (workerd) via `test/cf-probe/`, `test/cf-constructs.test.ts`.
Facts about the platform, not preferences.

- **P1 — the recursive-term law.** The recursive reference appears **exactly once, at the top level of
  the term's `FROM`** — POSITIONAL. A derived table around it is `circular reference` even as the sole
  reference. No aggregates, no window functions in the term. A correlated scalar MAY reference the
  walk's alias, and a `Materialize` fence may never sit between the term and its own self-reference.
  **"Top level" means the join TREE**, so `project(join(self, edges))` is legal; `src/rel/block.ts` is
  the one authority (it is also the emitter's fusion table, so the checker cannot admit a plan the
  emitter then wraps).
- **P2 — legal but unexploited.** `NOT EXISTS`, joins against a derived `UNION`, `IN (SELECT …)`,
  correlated scalars and multi-hop join chains are all legal in a recursive term.
- **P3 — no per-iteration barrier is expressible in a recursive term, in ANY lowering.** `DISTINCT` is
  inert, `LIMIT`/`ORDER BY` cap the whole CTE, `UNION` dedups the whole walk (breaking the multiset
  rule). Nor can a term COLLAPSE: `GROUP BY id, SUM(bulk)` is an aggregate. Do not re-propose
  re-lowering. This is what forces `repeat()`'s two regimes (§9).
- **P4 — statistics are gatherable but not boundable, so the plan may not depend on them.** DO SQLite
  accepts `PRAGMA optimize`/`ANALYZE` (they populate `sqlite_stat1`, which persists across
  hibernations) but **refuses `PRAGMA analysis_limit` with `SQLITE_AUTH`** — the same authorizer that
  refuses `writable_schema`, not a dialect gap a runtime bump closes. So an unbounded `ANALYZE` is
  O(graph) on the DO's serial request budget and cannot be capped there. This is why the lowering pins
  the access path at compile time from what the traversal already states — a join-order fence
  (`Join.ordered`, the LEFT side is the outer loop; only an `inner` join may carry it) and a source
  seek that lifts a `has(k,v)`'s correlated `EXISTS` into a driven `DISTINCT` join
  (`src/rel/passes/semijoin.ts`'s `indexSeek`, gated `propertySeek`, `GATE_ONLY_FAST_PATHS`). Both are physical statements of a fact the traversal
  fixed, changing no rows, so the plan is **stable without stats**: a mid-size graph's 1-hop filtered
  lookup went ~9.8 s (planner guessing, superlinear) → ~19 ms, identical with and without
  `sqlite_stat1`. ⚠️ Benchmarks must `ANALYZE` or they measure the wrong plan. `test/plan-stability.test.ts`
  gates the stability (graph-sized access paths identical with and without stats); a `PRAGMA optimize`
  schedule to also gather stats is a follow-on, tracked in `docs/outstanding-work.md`.
- **P5 — the write envelope.** Legal: CTE→`INSERT … SELECT … RETURNING`; multi-row `INSERT …
  RETURNING`; `INSERT … ON CONFLICT DO UPDATE … RETURNING`; `UPDATE … FROM (subquery)`; `DELETE …
  WHERE … IN (SELECT)`. Illegal: the Postgres-style data-modifying CTE. So a write chain is a SEQUENCE
  of statements, O(write steps) and never O(rows).
- **P5b — `RETURNING` determinism.** Row order is undefined, but id assignment follows the source
  `SELECT`'s `ORDER BY`. Order the source and re-associate by a carried key, never by RETURNING
  position.

---

## §2. The clean-room boundary — LAW

`src/rel/` imports NOTHING from `src/compiler/` or `src/gremlin/` — pure data plus total functions,
testable with no graph, store or Gremlin. `mise run arch` gates it.

**It is a VOCABULARY boundary.** RelIR needs exactly two things about carried state: which output
columns are channels and in what order, and per channel its merge and barrier policy. The neutral
**channel core** is `src/channels.ts`. **A RelIR node cannot know what a sack is, and shape never
enters the node set** — if a `src/rel/` node acquires a `kind: 'scalar' | 'element' | …` field, the
layer has failed. `ChannelRole` is per-column carried-state bookkeeping, never the stream's Gremlin
type.

Gremlin-shape-aware payload construction lives in `src/compiler/rel/` (`list.ts`, `map.ts`,
`element.ts`, `path.ts`, `record.ts`, `foreign.ts`, …), outside `src/rel/`, so it may know shape. Only
`execute.ts`'s byte framers (`(rows, Shape) → Buffer[]`, no SQL) live past it.

---

## §3. The object model — complete and CLOSED

Two algebras — **expressions** (a value per row) and **relations** (rows) — plus **statements** for
writes. Immutable plain objects with a `kind` discriminant, every list `readonly`. Kinds and fields are
in `src/rel/{expr,rel,stmt}.ts` — **the code is the authority**; what follows is only what the
declaration cannot state.

**Construction is branded.** A `Rel` is minted only by its named kind factory (validates local shape,
freezes); a rewriter rebuilds through a factory and never spreads a node. `SelfRef` has no public
factory — only `recursive` supplies it. **The set is CLOSED**: a missing construct is a derived form,
and adding a kind requires proving the seam cannot EXPRESS the shape (§7).

### §3.0 The top of a plan is a PROGRAM, not a tree

```ts
type Plan    = { readonly bindings: readonly Binding[]; readonly result: Rel }
type Binding = { readonly name: string; readonly node: Rel | Stmt; readonly snapshot?: boolean }
```

A `Ref { name }` resolves a relation computed earlier — one concept, not two machines: a
multiply-referenced `Rel` binding is a **CTE** (`name`'s decision, §4); a `Stmt` binding is a
**statement boundary** (the executor runs it, retains its `RETURNING` rows, and a `Ref` resolves to
them as ONE JSON bind exploded by `json_each`); a `Rel` binding marked **`snapshot`** is a **read
boundary** with the same retention — "the value AT THIS POINT", because a CTE is recomputed by every
statement naming it. `retained(binding)` is `isStmt(node) || snapshot`; `checkPlan` proves the
discipline. **A write in a read position is a hoist to a binding** — `union(__.addV(), __.V())` is plan
composition, there is no driver anywhere, and effects are legal only at a binding as a type-level fact.

### §3.1 Types

`RelType = { cols: ColMeta[] }`, `ColMeta = { name, type: SqlType, nullable }`, `SqlType = 'int' |
'real' | 'text' | 'blob' | 'json' | 'any'` — SQLite storage classes plus `json`. **Never a Gremlin
vocabulary**; Gremlin typing stays in `ScalarType`/`CanonicalType`.

### §3.2 / §3.3 The node set

15 expression kinds, 19 relational/statement kinds — deliberately smaller than SQL, whose redundancy
collapses (`HAVING` is `Filter` over `Aggregate`; distinct `UNION` is `Distinct` over `Union{all}`).
The constraints you would otherwise violate:

- **`Scan` is the only physical-schema node** — the storage seam. **`Project` is the only node that may
  DECLARE channel columns.** **`Values` refuses the EMPTY relation** (invalid SQL) — the empty case is
  a `Filter(false)`.
- **`Distinct` is whole-row only** (a keyed dedup is `Window(row_number PARTITION BY key)` +
  `Filter(rn=1)`); **`Window` may only EXTEND its input**; **`Join` emits its sides' columns
  POSITIONALLY** and its sides must be DISTINCT relations; **`Union` is n-ary**; **`Aggregate` emits
  group keys then aggregates**; **`Recursive.step` is a function** with seed/step channels identical.
- **`Agg` only inside `Aggregate.aggs`, `WindowExpr` only inside `Window.specs`** (checked).
  `Scalar`/`Exists` may be correlated. `InList` is bounded by QUERY TEXT — a data-sized set is one JSON
  bind (§6·2). `Delete` has no `using`; membership is an `InQuery`.
- **`Explode` with no `input` is the SOLE-FROM form** (`FROM json_each(expr) x`), which is what makes a
  per-member computation a correlated scalar subquery rather than a join — and what lands a data-sized
  constant (a barrier's awaited rows, `compiler/rel/foreign.ts`) as a relation.
- **`WindowSpec.partitionBy: Expr[]`** unifies global / per-origin / per-origin-dedup (`[]`, `origins`,
  `[...origins, value]`).

### §3.4 What is deliberately NOT a node

`With`/CTE (a binding is the only naming mechanism) · `Param` (a parameter is `lit`'s `source:
'parameter'`) · `Correlate`/lateral (correlation is an `Expr` referencing an outer `RelId`; P1 forbids
the node) · shape/cardinality/productivity/bulk (all Gremlin-level, §2).

### §3.5 Channel obligations, per node — the LAW that keeps the largest defect class dead

⚠️ **33% of this repo's diagnosed defects were a carried field dropped at a barrier, merge or rejoin.**
Every node declares what it does to each channel and a total checker verifies it (`Record<RelKind,…>`
in `src/rel/obligations.ts`, so a new kind fails the build until declared). `Project` declares (a
subset of its outputs); `Union` merges per policy;
`Filter`/`Sort`/`Limit`/`Distinct`/`Window`/`Explode` PRESERVE — pass the input's channels through and
**never name a list**; `Join{left}` widens the right side to nullable.

**The barrier obligation is TWO contracts.** A **barrier** emits a new traverser, so no channel
survives. A **grouping by traverser identity** (a dedup keeping first, a movement coalescing convergent
walks) emits one row per surviving traverser, so its channels must survive or a later reducer counts
the collapse away. The node declares which by WHICH CHANNELS IT CARRIES, and `CHANNEL_GROUP_POLICY`
says which roles have a defined N→1 answer (`bulk` adds, `encounter` takes earliest;
alias/path/origin/sack/loops belong to one member and refuse).

### §3.6 Two budgets the plan owns, not the emitter

- **Binds.** A user PARAMETER earns a `?`; a compiler-held constant is a typed literal. A plan carries
  `bindCount()` and **fails closed above the DO cap of 100**, checked against the RENDERED bind list —
  a fused block can spell one value twice, and IR occurrence counts differ from the rendered list up to
  2×. An over-budget row set lands as ONE JSON bind.
- **Statement text.** DO caps at 100 KB, enforced by `cfLimitViolation` at the end of the spine. The
  producer that can exceed it is the `times(n)` unroll, which runs ABOVE the IR, so the ceiling belongs
  to that pass.

---

## §4. The passes — all `Rel → Rel`, total, order-declared

Structure is declared ONCE in `src/rel/walk.ts` (no `default` arm anywhere), so `noImplicitReturns`
makes a new kind a compile error. Rewriting is memoised, so the DAG stays a DAG.

⚠️ **Call this tier `rewrite`, not `Pass`.** `Pass` names the `Step[]→Step[]` pipeline in
`ir/passes.ts`, which runs ABOVE the lowering; these run below it.

| pass | state |
|---|---|
| **`check`** | the fail-closed verifier — column resolution, `Agg`/`WindowExpr` placement, §3.5 obligations, both §3.6 budgets, and the recursive-term laws via `src/rel/block.ts`. Always on in dev/tests |
| **`name`** | named CTE vs inlined derived table per shared node, honouring `Materialize`. **The only pass with a production caller** (`lower.ts`) |
| **`prune`** | column pruning — a walk carries only what its body and its consumer read |
| **`semijoin`** | the PHYSICAL tier: lift a correlated property `EXISTS` in front of the bare scan it filters, as a DISTINCT relation the plan is DRIVEN from (a semi-join). ONE decorrelation with the access path as a pluggable `OwnerSeek` strategy — `indexSeek` (base `vp_key_value`, switched by `propertySeek`) and `trigramSeek` (the `property_fts` trigram index, switched by `ftsSubstringPredicate`, positive + negative TextP). The caller passes the enabled strategies STRATEGY-MAJOR (trigram before index, so a substring predicate takes the trigram index); the pass reads no config. Formerly two clones, `seek.ts` + `fts.ts` |
| **`fuse`** | ✅ wired in the read `lowered()` before `semijoin` (`src/rel/passes/fuse.ts`, `a4d38776`): transposes a Filter below a no-PARTITION `row_number` renumber Window when a whole-plan use-analysis shows the minted column is read only as an ORDER position (Calcite `FilterWindowTransposeRule` relaxed only for that case). Not run on the stream feeding a write (see Next round) |
| **`flatten`** | ✅ landed by DISSOLUTION, not a pass — the join-flattening / decorrelation legality it needed became `src/rel/block.ts` (`shapeOf`/`fromTree`/`fusedInto`), consumed by `recursive.ts` (P1/barrier laws) and the emitter. No `JoinUnionTranspose` pass was built: a `union`-topped body decorrelates structurally |
| **`recognize`** | ✅ RETIRED as a distinct pass — "fast paths as plan rewrites" is the physical-rewrite KIND, realised by `semijoin` over the finished algebra, not a tier of its own. Residue is a PERF tail (a nested/param `containing()` takes the correct-but-unindexed generic `LIKE`), gated on a real slow query + EXPLAIN |

**Declared is not wired.** Only `name`, `fuse` and `semijoin` have production callers; there is no object that
orders them — the order above is the order.

---

## §5. The emitter — a SELECT block assembler

The IR is normalized (one operator per node) and a SQL `SELECT` composes operators into fixed slots.
The emitter accumulates a block (`{select, from, joins, where, group, having, order, limit, distinct}`),
opening a nested SELECT only when a needed slot is occupied. Prior art: Calcite's `RelToSqlConverter` /
`needNewSubQuery`. **Total** — every kind has an arm, no fallback; built on the `q` kernel ADDITIVELY.
*Refused:* a `Select` mega-node from `fuse`.

⚠️ A compound arm is a select-CORE, so an arm filling a tail slot needs its own derived table; splicing
a join side lifts its aliases, so two sides reading the same shared relation collide and the colliding
side stays in its own SELECT.

**The equivalence gate is results and access path, NEVER spelling.** Byte-identical SQL is not a gate
(unreachable, and it invites snapshotting the emitter against itself). Two properties over real
`test/L2-sql/` traversals: **same results** and **same `EXPLAIN QUERY PLAN`** (reduced to index
decisions).

---

## §6. The disciplines

### §6·1 — ONE SPINE

There is one lowering. A traversal it does not cover raises `UnsupportedTraversal` — a clear query
failure returned on the trailer, never a fallback, never an opaque escape node.

### §6·2 — a data-sized row set is a VALUE, not a control-flow loop

**A row set whose size is a function of DATA crosses the `Sql` seam as ONE VALUE — a single JSON bind
exploded by `json_each` — never N parameters, read or write.** Three reasons, none movable by a runtime
release: a read cannot chunk (it needs the set as a RELATION inside one query); a chunked write cannot
be the `Ref` a later step joins against, and that `Stmt`-binding-as-relation IS the pre-mutation
snapshot; and the DO cap becomes O(plan size) by construction, provable by `check`. JSON is also MORE
deterministic than native binds (an integer binds INTEGER on Bun, REAL on DO; `boolean`/`bigint` throw
on DO), so `transportable()` (`src/program.ts`) fails closed. ⚠️ Cost: a BLOB cannot travel, so a
`RETURNING` feeding a retained binding projects `json(x)`, never `jsonb`.

### §6·3 — a SHAPE is a VALUE plus a framing arm; the boundary is `Shape`

Growing a shape has three parts and no fourth: RelIR builds the VALUE with its own nodes; a
`RelFraming` arm says what the relation holds; `execute.ts` frames the rows from a `Shape`. Three
layers — **row algebra** (RelIR), **payload projection** (`src/compiler/rel/`), **byte framing**
(`execute.ts`). Calcite's decomposition is the model: a map is a TYPE plus an aggregate FUNCTION, never
a kind of stream.

### §6·5 — THREE facts wear one channel out of a lowering, and conflating them corrupts the signal

`null` is the ONLY decline, and it means **"not learned yet"**. A THROW is one of two other things, and
the CLASS is what tells them apart — a caller whose contract is `null` cannot ask a message:

- **`UnsupportedTraversal`** (`compiler.ts`) — nothing lowers this chain. Raised at the top, once.
- **`ValueParseError`** (`gremlin/coerce.ts`) — the traversal's ANSWER is an error. `asNumber('1,000')`
  must raise TinkerPop's exact wording and SQL cannot raise at all, so the parse happens at compile
  time and the throw travels out through the lowering. It PROPAGATES.
- **`CoercionDeferral`** (same file) — the fold has not learned this shape. It DECLINES.
- **`Deferral`** (`ir/write-args.ts`) — the IR `Pass` tier's "not learned yet", above the lowering.

⚠️ Without the classes, `rel-sweep` (whose whole subject is "a lowering threw instead of declining")
reads every unparseable literal as a contract violation.

⚠️ **A SHAPE the traversal cannot have is an ANSWER, not a gap — but only where the shape is CERTAIN.**
The list functions (`combine`/`intersect`/`difference`/`disjunct`/`merge`/`product`/`conjoin`) are the
worked example: one upstream interface, `ListFunction`, holds all six messages parameterised by the step
NAME, so they are one authority in `compiler/rel/list.ts` rather than seven copies. What the case teaches
beyond the coverage is the LIMIT: a SCALAR self is deliberately left declining, because "can't be null"
versus "can only take an array or an Iterable" is a PER-ROW choice there — **raising the WRONG error is
worse than declining**, and the shapes that can never be null (element, map, record, property) are exactly
the ones where the message is certain.

Two more rules on refusals:

- ⚠️ **A verifier must never narrow what the lowering may attempt.** Slicing a read tail after a merge
  in the Pass tier would have refused `mergeV(…).values('name')`, which the lowering continues past.
- ⚠️ **A refusal about the STREAM, not the arguments, must fail open where it cannot type the prefix.**
  `elementKindAt` (`ir/step.ts`) answers `vertex`/`edge`/**cannot-say**, and the third answer is the
  load-bearing one.
- **A GRAPH-dependent refusal becomes a guard binding**: `Binding.guard = { message, raiseWhen: 'rows'
  | 'empty' }`, a binding whose relation the executor runs and whose ROW COUNT it tests — O(plan size),
  one statement, inside P5. **The message is the reference's verbatim.** Both directions are real:
  `'rows'` is a COLLISION (`assertAvailableElementId`), `'empty'` a MISSING referent (`mergeE`'s
  *"Vertex does not exist"*).

### §6·6 — ONE child seam: a child body has THREE total answers

`src/compiler/rel/child.ts` declares it and `childSeam(ctx, fresh)` builds it: correlated **scalar**,
correlated **predicate**, **rooted** relation, plus a `rows` arm (the whole owners relation at once,
carrying the owner key via the `origin` channel) and the `body()` normalizer they share.

**The rule the seam exists to hold: a child body works wherever a child body is LEGAL, not wherever a
host was taught one.** `rooted` is deliberately POLICY-FREE — a consumer's admission rule is the
consumer's, or the seam becomes the union of its callers' requirements. `body()` is part of the DECLINE
contract, not a convenience: normalizing re-runs the Pass pipeline and can legitimately raise.

⚠️ **THE GENERALIZED LESSON, six witnesses: coverage must measure what the algebra can EXPRESS, never
what the caller remembered to ask.** Route gates on `sideEffects.size`/`sackInit`, `servicesNamedBy`
scanning only the top-level chain, `rootedRead` dropping settled values, `rel-blockers` calling
`lowerToRel` without the registry — each read identically to a missing lowering. **Its mirror is worse
because nothing is even asking: a fact the FRONT END drops**, so a lowering cannot decline on a policy
it cannot SEE. **Whenever a seam re-enters the fold, check what it HANDS OVER before concluding what
the algebra cannot express.**

⚠️ **THE GUARD WRITTEN BEFORE THE ARM is the cheapest form of this error, and it reads identically to a
missing lowering. It has now been found four times; assume there are more.** The tell is a blanket
decline sitting in front of an arm that reads the very thing the blanket refuses:

- `BY_READERS` was a five-name subset of `BY_HOSTS` while its own comment claimed to BE the
  intersection, so the blanket modulator decline refused every `group().by(…)` over a value stream.
- `groupRows`' `!bys[0]` test asked "was a `by()` written" when it meant "does this name the traverser",
  so `group().by()` never reached the cheap ROWID key its own comment describes and
  `group().by('name').by()` never reached the collect-the-elements arm.
- and the three list member ops below.

Three LIST member ops were filed as unexpressible and every one was UNREACHABLE:
`listMemberOp`'s blanket `step.modulators?.length` guard ran in front of an `order` arm that read a
comparator correctly (and whose own `!child && modulators` check was therefore dead code); `dedup(Scope.local)`
declined for EVERY input because the SCOPE TOKEN is an argument, so a bare `argValues(step).length` was 1
on the very form `isLocalScope` had just recognised; and `path().by(k).reverse()` was already wired
through `PATH_LIST_OPS` and waiting on the same guard. **Reaching an arm is also how you find out it was
wrong** — the `dedup` one declared two columns while emitting three and keyed on a payload without its
type tag, neither of which any test could see while nothing could call it. ⚠️ So when a blanket guard and
a specific check disagree, the specific one is dead: **grep for the arm before believing the family
table.**

⚠️ **The measured case of that mirror, and the one that shows how it HIDES: `walkArgs` dropped a NULL
where a string was allowed.** The grammar spells one as a bare `K_NULL` TOKEN inside
`stringNullableLiteral`/`stringNullableArgument` (`Gremlin.g4:1738-1741`) rather than through the
`nullLiteral` rule, so an unrecognised terminal fell off the end of the recursion and the argument
VANISHED. `hasKey(null)` arrived as `hasKey()`. What makes it the worse mirror is that four steps then
answered CORRECTLY BY LUCK — a null is genuinely inert in a positive set, so `hasLabel(null,'person')`,
`values('name','age',null)` and `concat(null,'b')` were right for a reason nothing had written down,
while `has(null,'k')` silently became the PRESENCE test `has('k')` and was empty only because the
fixture has no such key. **The repair is never "restore the drop"; it is to carry the fact and make each
site STATE the rule**, which is what `propertyKeyArgs`/`labelSetArgs` (`compiler/rel/build.ts`) are: a
null member is INERT beside a real one, and an ALL-NULL set matches NOTHING rather than collapsing to
the absent set that means EVERYTHING. `values(null)` is the empty result; `values()` is every property.
No corpus scenario exercises the all-null form, so nothing but the argument above would have found it.

### §6·7 — a scalar row's TYPE rides PER ROW; a static tag is an OPTIMIZATION, never the carrier

**THE RULE: what arrives on the wire is CARRIED until something naturally changes it** — never
re-derived, never re-guessed, never DISCARDED because modelling its carriage looked like work. Guessing
from a JS value cannot tell a UUID from a string, a datetime from a long, or a big long from either.
Carrying costs one column and helps every type at once.

**The lattice** (one authority, all sites landed): `static ∧ static(same) → static` · `static ∧
static(differ) → perRow` (each side projects its tag as a literal `vt`) · `perRow ∧ x → perRow` ·
`unknown ∧ x → a NULL tag`. ⚠️ That last case is NOT `→ unknown`, which would discard an arm's
`datetime` because its SIBLING could not say; a null `vtype` IS "infer from the value" everywhere in
the channel.

⚠️ **EVERY SHAPE DESCRIPTOR IS TOTAL — keep it that way.** Optionals were the defect generator, so
omitting a field is now a type error rather than a code review.

**PASS-THROUGH is exact; ARITHMETIC is SQLite's** — the narrowest tag in the Number family that holds
the result **without narrowing**. ⚠️ Two hard edges: **never narrow** (`frameValue`'s `case 'byte'`
calls a strict serializer, so tagging 128 a Byte is a crash) and **never leave the Number family
gratuitously** (BigInteger/BigDecimal decode to BigInt/BigDecimal and `1123n !== 1123`). Widening
INSIDE the family changes no answer Gremlin can be asked — cited, not assumed:
`GremlinValueComparator` treats every `Number` subclass as ONE type.

- 🚧 the **variant payload** has no `vtype` column, so an arm declares a STATIC tag or `UNKNOWN`;
  carrying `perRow` there needs the framer to read it, i.e. a wire change.
- 🔴 **Four documented deviations, not defects:** host-language typing in Java/.NET (`Short s =
  …sum().next()` is a CCE); 128-bit arithmetic DECLINES (no arbitrary precision, no UDFs — do NOT
  raise, since `!fp && bits ≥ 64` is Long's rule); int64 overflow raises natively at upstream's own
  rethrow point; 32-bit float arithmetic is not expressible (SQLite REAL is always a double).
- ✅ **Number CLASS is exact — §11's promotion closure is REOPENED (decided 2026-10-17).** The
  closure assumed the Int/Long/Double tag was invisible; it is not: `Max.feature` pins `d[1.0].d`, and
  Python decodes Int vs Double as `int` vs `float`. So every result reproduces the reference class
  (`NumberHelper.getHighestCommonNumberInfo` for sum/min/max/arithmetic, `MeanGlobalStep` always
  Double, literal and stored classes carried) through ONE `numericClassOf` authority (§10 cluster C).
  The cost the closure cited (a sort + O(N) sorter on narrow sums) is accepted; the four deviations
  above still stand. LANDED: the authority is `reducer.ts` `numberWidth`/`numberFloating` (a row's
  width/floating pair) → `commonNumberClass` (`determineNumberClass`), read by every `sum`, every
  `min`/`max` and the sack's folds (whose class rides in its own `sack`-role column); residue in
  `docs/outstanding-work.md` (Value carriage).

---

## §7. Scope control — the node set is CLOSED

RelIR is **structural only**: fusion, partition keys, pruning, legality, naming. **No cost model, no
statistics, no join reordering — SQLite is the optimizer.** Adding a node kind requires showing the
seam cannot EXPRESS a shape, not that it has not been HANDED one (§6·6).

---

## §8. The instruments — run all of them, not the cheapest

Per-increment loop: `ci` → `test:cf-limits` (every new SQL) → commit → `mise run L5` at the commit (its
seed is HEAD-derived) → push. `test:perturbed` only when the change touches ORDER.

| instrument | blind to |
|---|---|
| census (`ms` digest) | a wrong SHAPE over an empty result; a required THROW that became a plausible value. ⚠️ `n`/`ord` legitimately move under a collapse and are NOT gated |
| L2 shape assertions | a wrong VALUE with the right shape |
| L3 conformance | anything the corpus doesn't exercise — but the ONLY thing that sees a required error message |
| L4 `@Unsupported` | anything but the fail-closed half: it asserts the traversal REFUSES, and fails loudly when the refusal stops |
| `rel-sweep` | correctness — it asserts the lowering doesn't THROW and renders within the cap |
| `test:perturbed` | values — the only thing that sees an order right only by SQLite's scan luck |

⚠️ **A FIXTURE-CORRUPTING bug HANGS instead of failing, and no instrument above reports it.** The
census shares ONE store across every non-write traversal, so a write MISCLASSIFIED as a read mutates
the fixture — measured: a `mergeE` created six self-loops and the corpus `repeat()`s then walked a
cyclic graph. **A throw is not evidence of readness.** When a suite hangs after a coverage increment,
suspect the shared fixture first.

---

## §9. `repeat()` — the two regimes

`Recursive` wherever the walk is unbounded; the IR-level unroll (`unrollFixedRepeat`) for a bounded
`times(n)`; a clear refusal for unbounded-AND-barrier. **Neither regime alone is sufficient and neither
insufficiency shrinks with effort** — unroll cannot express an unbounded walk, and P3 (§1) says a term
can express neither a per-iteration barrier nor the collapse. The walk covers `until`/`emit`/`emit(pred)`
at all four modulator positions, a sack folded through it, and `repeat()` with NEITHER modulator as the
specified EMPTY result, under ONE positional collapse authority.

Measured facts behind the split are archived at `docs/archive/2026-08-09-repeat-two-regimes-plan.md` —
read it before re-opening any of it. ⚠️ Its §7.2 chain-global collapse relaxation is **REFUTED**; do not
retry.

🚧 Repeat residue is folded into §10's worklist in substrate order: the unbounded body whose UNION is not
the top node (join-union distribution), the UNORDERED bulked slice, the unroll's deny-list gate, and
`times($x)`→walk.

---

## §10. What is left — the worklist

Only what is OPEN. Landed work is deleted, not ticked: the code and `git log` are the record. Rank by what an
item UNLOCKS, not by L3 gain. Re-derive the live decline ranking with `mise run rel-blockers`; three
worklists fail loudly when a shape lands (`test/rel-spine.test.ts` `DECLINED`, `test/L4-addendum`
`@Unsupported`, L5 `LAW UNEVALUABLE`). IDs are stable — reference them, don't renumber. `(verify)` = may
already be fixed; check before building. A run appends its findings as ONE new `### Next round` section;
fold it into these lists at the end of the run.

### Cleanup — DECIDED by the owner (2026-11-03): LANDED

An audit of rounds 1–7 found the loop drifting into reviewer-CONSTRUCTED compositions: hundreds of src lines,
new per-row SQL on COMMON queries, and correct answers turned into declines, all to serve shapes nobody writes.
The owner's cleanup is on trunk; its specs are in `git log` (`68db5644` and each item's commit). Do NOT
relitigate it, and do not "fix" a resulting decline back into machinery: a contrived shape gets a clean
query-text decline (EXPLAIN, DON'T BAFFLE) or the simpler natural answer; a common/plausible shape keeps its
correct answer. Its laws are under "Laws found working this list"; its open follow-ups are folded into the
lists below. Landed:

- **A1** `1e561929` `reSourcedOnce` is a fast path behind ONE top-level whitelist; everything else falls through
  to GraphStep's product route. **A2** `3bf01eda` the once-path's n>1 walk is deleted (`sample(n>1)` ranks each
  origin's pairs — see cr-fu5). **A3** `a6a5aae8` a re-sourcing body holding `sample`/`coin`/shuffle declines
  where it would be drawn once for many hosts (one-host case: cr-fu6).
- **B1** `7b6557cb` V1 label-scope reverted. **B2** `2d11a73b` a named scope beyond a maybe-Map value wins (§17
  "Map scope"). **B3** `39aba300` (with cr-fu2) `MergeTraverser` is `'map' | 'notMap'`. **B4** `75a6928f`
  `MapKeyFacts` = `keys`, a MAY set merged by one union; `held`/`exact` deleted.
- **C1** `1aeb8683` group's null sort key only where a member can be a productive null. **C2** `024a9440`
  `landedOnce` deleted; a stated `by()` null drops (§17 "A null `by()` value"). **C3** `96bdf92b` a re-sourced
  body's null first value is absent (§17). **C4** `16401f5f` a `V()`/`E()` body over a may-be-absent host declines
  (`RESOURCE_UNDER_ABSENT`). **C5** `61d41586` a choice's presence is `meetPresence` of its arms.
- **D** `7ed8f578` map/set-valued equality operands and merge criteria decline from the query text.
- **cr-land-once** `5a722faf` `once()` (`rel/build.ts`), math() variables its first consumer — this also
  LANDED **cr-fu1** (the math-variable re-inlining: ten uses 59,949 → 4,665 bytes). **cr-fu2** `39aba300` (with
  B3). **cr-fu6** `5f50072f` `SHARED_DRAW` only for a many-row host, judged by `rowBounds`.
- ✅ **F** LANDED `5aeb46bf` (docs only; mechanism: this section + "Laws found working this list") — the plan folded: S9 and its tree, r7-fu1 (+r7-reuse2), r7-fu2, r7-fu6, M2, r2-gap-S2, S6.1 and
  r4-ru7 (done) dropped; r4-fu0 folded into rf3-fuse-write; S9's live witnesses promoted; the contrived residue
  moved to its own bucket; both `### Next round` sections folded in. **S9-blk** was re-probed at `5bc85fbd`
  and is CLOSED: `g.V().project('x').by('age').math('_ + 1').by(select('x'))` answers `[30,28,33,36]`, no raise. Remains: nothing (Tier B is an owner question under "Needs a human decision").
- **E** CLOSED by the owner (`f2e6e4c6`): `g.V().select('a')` with no `as('a')` keeps the reference's empty
  answer, pinned by 9 `Select.feature` scenarios; no decline built.

### Needs a human decision

- **Tier B — retire `PresentWhen`?** (raised by F, the cleanup's last step). `PresentWhen` (`rel/child.ts`, the
  `{ when, orValue? }` arm of `Presence`) is the one way a child body says "I produced, and my value is NULL" — a
  PRODUCTIVE null. C2/C3/C5 removed three of its producers; four remain: `aliasGuard` for a label bound in a
  branch arm (`modulator.ts` ~:522), `oneRowPresence`'s `EXISTS` for a nullable one-row body (`dedup()`/`is(null)`/
  `limit(1)` over a map entry, `lower/reduction.ts` ~:116), `selectedNodeChild`'s `{t,v}` node test (a Map entry
  holding null, ~:2628), and coalesce's `orValue` (~:1513); ≈33 lines read it across `child.ts`, `modulator.ts`,
  `projector.ts`, `write.ts`, `lower/reduction.ts`, plus the `HostPresence` split that exists only to keep it off
  a host. The choice:
  - **Retire it** — presence becomes `'always' | 'value-nullness' | 'unknown'`; a productive null in a CHILD body
    reads as absent everywhere, one §17 line generalising the existing "A null `by()` value" and "A re-sourced
    body's null first value" lines. Deletes the arm, `statedPresence`, `orValue`, `HostPresence`, and the per-row
    `EXISTS`/node tests. Cost: the shapes below become documented divergences — a dropped null traverser is a
    changed COUNT, which the Semantics traps otherwise forbid, so this needs the owner.
  - **Keep it** — it is the substrate for the open productive-null wrong answers: r4-fu4/rf3-project-null-label
    (`project()` keeps a productive-null `by()` entry — today §17 says it omits the key), S9.9 (null Map entry
    under map/local/flatMap/choose; the chain keeps it), rf3-static-null-is (`inject(null,1).map(__.is(P.neq(1)))`
    is `[]`, the chain spelling `inject(null,1).is(P.neq(1))` is `[null]`), and `docs/outstanding-work.md` §1's
    branch-bound null label (`…select('v').map(__.select('k'))` is `[]`, ref `[null, null]`). Then the work is
    the binding-presence substrate r7-fu1 was (dropped by F), re-scoped to those four witnesses.
  Recommendation: the four witnesses are chain-vs-child INCONSISTENCIES (the chain spelling answers right), which
  is the strongest form of "a user would call it wrong" — but none was reported by a user. Owner to choose.
- **cr-fu5** (A2) — confirm the trade: `sample(n>1)` under a candidate set that GROWS with the graph is quadratic
  (`rankPairs` crosses every origin with every candidate). `local(__.V().hasLabel('person').sample(2)).count()`
  281 ms → 19.6 s at 1k → 8k (70×; was 20 → 138 ms); `property(list,…sample(2)…)` 347 ms → 21.9 s. Fixed small
  candidate sets stay linear; `sample(1)` unchanged. The A2 commit quotes only 1k×1k — at 8k×8k it is ~20 s per DO
  request. Either way: an outstanding-work line, a test comment (nothing guards the origins×candidates axis), and
  fix the `rankPairs` doc (the rank CTE is not `MATERIALIZED`; "FENCED" overclaims).

### Contrived — build only on a user report

Real gaps, but in shapes nobody has been seen to write. Do NOT schedule them; build one only when a user reports
it, and then build the generic fix, not the witness.

- **r7-fu4** `group()` pooled fold value: `inject([a:3],[a:null]).unfold().group().by(keys).by(select(values).fold())`
  → `{a:[null]}`, ref `{a:[3,null]}` (`ProductiveByStrategy` must skip a child ending in a reducing barrier).
- **M1** `hostKept` `by()` repeats the host predicate 2–3×/row.
- **r1-gap-reroot / r1101-ab** absent-label reroot depth gaps (C4 now declines the `V()`/`E()` form outright).
- **r6-m-sample** rooted `sample()` residue.
- **Per-origin deterministic slice over a re-source** — `local(__.V().hasLabel('person').limit(2))` is
  O(origins × |V|) (7.5 s at 4k holders), the reference's own traverser count. With one row per origin the prefix
  through the slice is origin-independent: `rootedRead` it once and cross the origins with its small result.
- **r6-fu8 options A / B / JS barrier** for map/set-valued equality (D declines it from the query text today):
  (A) STORE entries in canonical key order (reads come back key-sorted, one §17 line, seeks stay index-backed);
  (B) canonicalise at every comparison in `couldMatch` and the map-guard signature (per-row SQL, loses the seek);
  or a gated JS barrier.

### Substrate — in unlock order

0. **decline-reason channel** (cr-fu9, B4's remains; `docs/outstanding-work.md` §3) — `lowerToRel` must return
   `null`, never throw (`scripts/rel-sweep.ts`), so every decline decided on FRAMING facts says only "no lowering
   covers …": B1/B2/B4's map-key collisions (recordTail, selectKeys, scopeValue, mapTail 'may', mergeV) and
   cr-fu13. A per-compile reason the lowering records and `compilePlan` reads when the result is `null`; it is the
   prerequisite for every explanatory decline that is not a property of the query text alone.
1. **`once` consumers** (follow-ups of cr-land-once) — route the remaining re-inliners through `once()`
   (`rel/build.ts`): value-run `is()` (rf3-is-chain-size, under Performance — a production-only statement-cap
   failure), and the modulator's `projectionOf`/`typedOf` (`rel/modulator.ts`), whose `by()` value is spelled per
   gate. The same tool serves r6-s9-4, S9.8, r5-fu2 and r6-m-orderby (Performance). Semantics-free: it must not
   bring back a Map probe or `landedOnce`'s presence half.
2. **per-row-node-vocabulary-closed** — every shape a per-row scalar stream may carry gets a `{t,v}` node and
   a framing arm: a Map.Entry (`{t:'entry', v:[[k,v]]}`, framed as a size-1 map like `execute.ts` `mapEntry`;
   `Column.java:46-63`) and an element (node carries the id). Followers dispatch on the tag; one that cannot read
   an arm raises the reference's per-row error via `src/rel/raise.ts`. Unblocks:
   - **per-row-unfold-entry-node** `unfold()`/`format()` over a per-row maybe-Map scalar (both decline, §17).
   - **scope-element-label-over-map-row** (V1's deferred half) — a variant `{scalar|list, elements}` continuation
     through element/collection followers, `g.V().as('k').values('m').select('k')`. Re-derive its expected
     answer against §17 "Map scope" (the label wins) before building. Also **r6-s9-2** (verify — B2/B4 made a
     record key beside a live label decline): `recordTail` `select(field)` ignored `labelMayBeBound`, 4 rows vs 6.
3. **S3 — a write inside a child / multi-arm body** (local/map/flatMap/union/coalesce/optional/choose/
   repeat/sideEffect/where, onMatch). `g.V().local(__.mergeV([name:'x']))`. Unblocks every write-in-arm
   decline below.
4. **G — thread alias channels through `childSeam`** (`rel/child.ts`): label scope into nested arms.
5. **H — one table per row-changing reference strategy** in `ir/`, citing vendor lines (the `bulk.ts`
   pattern). Never for strategies that only change execution order.
6. **Map shape**: map-valued `union` source (verify vs `71416f55`), seeded `fold([:], addAll)`, merge
   map operand, T-token key.
7. **List members**: `is(P)`/`order()` inside a correlated list-member body (bind-budget design call);
   `order`/`range(local)` over list-of-maps, PROPERTY and MIXED member lists, `select()` in a list-host body.
8. **Fan-out**: per-origin scalar order (`values(k).order().fold()`), reductions without fold, scalar-host
   group reducer, `tail`, child-label escape, `map` first-result window.
9. **Branch / slice**: MAP/RECORD/PATH/PROPERTY variant arm, batched `choose`, alias through a collapsed
   arm, nested branch in a sliced arm.
10. **Wide longs typed in SQL**: a wide constant is dropped by `sum/min/mean` over a varying stream; a
    top-level sum past 2^53 rounds. `g.V().local(union(constant(9007199254740993L), values('age')).sum())`

### Wrong answers on trunk

- **rf3-reuse1** WRONG-ELEMENT WRITE — RANK FIRST. Write-path vertex-id lookups bypass `idMembership`'s per-id
  clause: `write.ts` `endpointRowid` (~:6415), the map-valued mergeE `endpointRowid.byColumn` (~:5449, `id = v`
  with no uid check) and `withPreChecks` (~:1345) hand-roll `typeof id === 'number' ? … : …`. On a store with
  `addV('a').property(T.id,'x')` (rowid 1) + `addV('b')`: `g.mergeE([(T.label):'k',(OUT):1,(IN):2])`, the
  `inject(map).mergeE()` and `Merge.inV` forms write an edge from `'x'` although `g.V(1)` is `[]` (ref: "Vertex
  does not exist for mergeE"). Export the scalar clause (`externalIdIs(idCol, uidCol, v)` from `rowidOnly`); cost
  one `uid IS NULL` on a row the rowid seek already fetched. Leave `elementIdGuard` (~:2970) — physical occupancy.
- **rf3-bulk-remap-replace** `{idPolicy:'remap', onCollision:'replace'}`: `resolveReplace` ignores `idPolicy`, so
  `V(1)` lands as rowid 1 with uid NULL instead of a minted rowid with uid `"1"` (wrong element id). `src/bulk.ts`.
- **rf3-bulk-dup-uid** `loadBulk` APPEND with a uid twice in ONE batch (`[V('a'),V('a')]` on a non-empty store, or
  `[V('a\ud800'),V('a\udc00')]`) surfaces SQLite's raw "UNIQUE constraint failed: nodes.uid" — a raw error reaching
  the user. `assertNoCollisions` checks batch-vs-store only and is skipped on an empty target; add an in-batch
  check keyed like `dedupeByKey` (`toWellFormed`) with the named-remedy error; test the two-spellings case.
- **rf3-where-armlabel-json** a bare `Error: malformed JSON` reaches the user:
  `g.inject(1,2,3).choose(__.is(1), __.constant('cd').as('k'), __.choose(__.is(2), __.constant('ab').as('k'), __.constant(7))).where(__.select('k').toUpper().is('AB'))`
  → ref `[2]`; also `length()`/`trim()` bodies and `not(...)`. `map(...)`/`local(...)` of the same body answer.
  `lower/filter.ts` where-path over an arm-bound string label.
- **cr-fu14** `g.V().project('n','m').by('name').by(values('m')).select('m')` over a Map-valued property leaks
  `TypeError: pairs.flatMap is not a function` (`src/execute.ts:226`). Also `g.inject([x:1,y:2],[y:2,x:1]).dedup()
  .count()` → 2, ref 1 (the dedup half of `docs/outstanding-work.md` §1's map identity), and under
  ProductiveByStrategy a `group()` nested in `local()` still drops absent values (the strategy does not reach
  nested steps).
- **rf3-fed-barrier** (folds r7-fu7's remains) federate `noParents()` decides the zero-parent answer from
  `pushdown.reduces`, i.e. only the LAST pushed step, and with parents a pushed global barrier runs the sibling ONCE
  rather than per parent. With `h = g.V().has('name','nobody').call('federate',['graph':'crew'])`: `h.V().count().is(0)`
  `[]` (ref `[0]`), `.count().fold()` `[]` (`[[0]]`), `.count().sum()` `[]` (`[0]`), `.fold()` `[]` (`[[]]`),
  `.has('name','zzz').count().math('_+1')` `[]` (`[1]`); with parents `within('marko','vadas')…V().count()` `[6]`
  (ref `[12]`), `…count().fold()` `[[6],[6]]`. Fix ONE of: stop `pushableTailPrefix` at the first global barrier
  in MID form, or lower the pushed prefix locally over an EMPTY relation for the seed (`CountGlobalStep.java`,
  `FoldStep.java`, `ReducingBarrierStep.java:143-148`). Pin in `test/federation.test.ts`; drop the docstring's
  "deeper compositions" claim until then.
- **rf3-boundgraph-ids** (+rf3-reuse3) `BoundGraph.elementScan` (`src/compiler/rel/boundgraph.ts:103`, and
  `inlineNames` ~:55) still flattens every list id argument; `idMembership` follows TINKERPOP-3273. Federate
  subgraph `…with('subgraph',true).with('traversal',__.V().outE()).V(2,[3,4]).values('name')` → `[josh,lop,vadas]`,
  ref `[vadas]`; `V([3,4],[1])` → 3 rows, ref `[]`. Extract `idArgMembers(args)` from `idMembership` and call it
  from both. Pin a subgraph case in `test/L4-addendum/id-list-argument.feature`.
- **Productive nulls — chain-vs-child inconsistencies** (all wait on the Tier B decision above):
  **r4-fu4** + **rf3-project-null-label** `project()` keeps a productive-null `by()` entry (read and
  `property(map)` write; `ProjectStep.java:66`), incl. `project('a').by(__.select('k'))` over a branch-bound null
  label (ref `{a:null}`) — §17 "A null `by()` value" accepts the omission today; **S9.9** a null Map entry is
  dropped under map/local/flatMap/choose while the chain keeps it; **rf3-static-null-is** a statically known null
  fails a child `is()` the chain passes: `inject(null,1).map(__.is(P.neq(1)))` `[]` vs `inject(null,1).is(P.neq(1))`
  `[null]`, `inject(null).as('k').map(__.select('k').is(P.eq(null))).count()` 0 (ref 1) — re-read against C2: its
  §17 rule covers `by()` keys, not an `is()` filter, so this stays a wrong answer.
- **r7-fu5** a dedup key collapses a Long above 2^53 with its numeric String (tag-class CASE has no long arm,
  `lower/slice.ts`). `inject([a:9007199254740993L,b:'9007199254740993']).unfold().dedup().by(select(values)).count()` → 1, ref 2.
- **r6-fu1** REGRESSION: a user param named `injectedMap` collides with federate's fresh name. Step 1 landed
  `d4e6de21`. The rest must RESTART from this description (its branch `wf/federate-fresh-param-collision-2-4` no
  longer exists): land the `scanBound` metadata query with this consumer measured, then a `correlatedIn`
  (`rel/passes/semijoin.ts`) that avoids the parked attempt's majors — a string id `V('u0')` not treated as a bound
  (61×), a shared `EXISTS` hoisting a CTE over the whole property table, a constant seek that must outrank a
  correlated one (45×), four quadratic shapes regressing 1.15–1.45×, `mapValueElem` throwing a bare Error; pins
  for uid/`E('…')`/multi-conjunct in `test/plan-stability.test.ts`.
- **r6-m-longmax** merge and `has()` disagree on Long.MAX vs its nearest double — one numeric-equality authority.
- **r6-m-uuid** inject scalar subject typed UNKNOWN; mixed UUID/String `within()`; ordering predicates ignore
  type space. `inject('<u>').is(UUID('<u>'))`
- **r4-fu5** a single-correlation leg lacks the parent's path labels (`lower.ts` legSingle/seedOuterAliases).
- **o-aliasbinds** `AliasEntry.binds` counts a same-position rebind → `Pop.mixed` returns a list.
  `g.V(1).as('a').filter(__.identity()).as('a').select(Pop.mixed,'a')`
- **o-seeded-fold** per-row-typed answers where the reference raises ClassCastException; `fold(0L,sum)` frames Int.
- **o-content-demand** (verify) `literalKeysOf` may take 3-arg `has(label,key,value)`'s label as the key.

### Performance — measured super-linear (N≈1k → 8k), or over a production cap

- **rf3-is-chain-size** a chain of value-run `is()` re-inlines its input per `CASE WHEN test THEN value`:
  `union(values('age').as('k'), constant(0)).map(select('k').is(neq 5).is(neq 6).is(neq 7).is(neq 8))` emits 1.52 MB
  of SQL — over the DO 100 KB statement cap, a production-only failure. Route `is()` through `once()` (Substrate 1);
  pin it under `CfLimitedSql`.
- **cr-fu4** (A1) shapes the once-path ACCEPTED before A1 (a prefix holding a barrier or a child: order, dedup,
  slice, coalesce, union, map) now take GraphStep's product and the per-origin `RANDOM()` window over origins×graph —
  where a linear plan existed. Measure the common forms at 1k/8k; restore timed budget pins for one barrier prefix,
  one per-row-child prefix (union/coalesce arms) and one order-only prefix
  (`test/compiler/rooted-sample-scale.exec.test.ts`).
- **r6-s9-4** compute a by() consumer's scope node ONCE (`once()`) — groupCount re-reads `json_each` 15×, order
  12×/row. **S9.8** `json_each` re-inlined 3–5×/row in the child seam. **r5-fu2** alias operand/tag projected once
  at the `as()` site (≈1.8× slower today). **r6-m-orderby** `order().by(<may-be-empty>)` emits the body twice.
  **r6-s9-6** a record field with no fallback round-trips `{t,v}`: 3.3×.
- **Shared collection re-read per traverser** — `g.V().group('a').by(constant('a')).by('age').select('a')
  .select('a').count()` 57 ms → 3.4 s over 1k → 8k (59×; `docs/outstanding-work.md` §6): read the key once (one
  MATERIALIZED relation) and cross-join it.
- **rf3-fuse-write** (+r4-fu0) `fuse` runs only in the read `lowered()`; the stream feeding a write
  (addV/addE/property/mergeV after `order().by(…).V().has(…)`, or a write-body `V()` re-source's label filter)
  still renumbers |holders|×|V| before filtering. Soften fuse's "property predicate reaches the access-path
  strategies".
- **r7-fu3 remains** a correlated-value property seek in `src/rel/passes/semijoin.ts` — a narrowing
  `element.id IN (owner seek)` conjunct on a top-level positive conjunct whose value reads a sibling/enclosing
  relation, with the pass entering correlated subplans via `rewriteRels`; removes the N² for nested and
  top-level `V().has(k, select(label))` (55× for 64× rows after a re-source — linear but not cheap).
- **r7-fu7 remains** the per-parent mapValues injection cost is super-linear.
- **r6-fu6 / S10-r** merge guard over shared key-name pools: two pools 19× (~N^1.5); generic multi-key
  `OwnerSeek` (`rel/passes/semijoin.ts`, `write.ts` mapDrivers).
- **r6-m-decimal** `decimalTextSeeks` fallback arm quadratic for |c|≥9e18 and mixed-length ends.
- **r7-fu9** a K-entry map driver `inject([k0:0,…]).mergeV()` 55× (`json_extract` re-reads per entry); a child
  seek doesn't reach a `fold()` reducer (68×); `hasLabel` after an equi-joined hop in a re-source (16× for 4×).
- **r7-fu11** label-only multi-driver `mergeV` with different labels declines (interleaving guard too coarse).
- **r4-perf1** mid-traversal `V().has` with no seek in a READ: 813 ms → 44.6 s.
- **r6-reuse4** scalar member node rebuilt per one-row producer (`sum` 2×, `max` 3× edge reads/host row).
- **S11** a body-may-yield-NULL fact so the M3 removal machinery is skipped (+13–75% today).
- **r1101-lbl** `where(select('a').label())` tests a label subquery, not `id IS NOT NULL`.

### Writes

- After S3: merges in sideEffect/map/flatMap/coalesce/optional/choose arms; writes after path/fold/sack;
  computed-label residue (list-framed `addLabel` body, computed `dropLabel` — verify vs `30461694`);
  source-union starter-arm writes; `[1:'a','1':'b']` maps outside a stored property.
- **singleSource over rowBounds** (follow-up of cr-fu6) — re-express `write.ts` `singleSource` as a `rowBounds`
  question (`src/rel/bounds.ts`), so "does this write have one source row" has the same one authority as
  `rootedHosts`.
- **o-prop-trav** `property(k,<traversal>)`: the guard can fire after an earlier write; `mergeArmValueWrite`
  takes `limit 1` scan order and stores null. **o-seqguard** (verify) `sequentialGuard` may still be a
  data-size refusal — a production outage if so.
- **R8-res** record / `inject(map)` drivers with `select('k')` decline until `mergeFromTraversal` takes them.
- **o-meta-undeclared** meta-property under undeclared cardinality patches instead of inserting.
- **o-with-write** `with()` on a write; ~10 singletons (`addE` after `addE`, `addInE`).
- **o-addlabel-empty** `addLabel(__.constant([]))` declines; the reference is a no-op.
- r1101-cl-fu5 computed-label minors; r6-m-oncreate side-effect onCreate L4 scenario; r4-fu8c
  `properties().drop()` via `removeRows`; r4-fu8d `effectScope` snapshots leak into later statements' WITH.

### Declines to lift

- **Regressions from the cleanup** (trunk answered before): **cr-fu7** (C1) `sameGroupRecipe` (`rel/map.ts`)
  compares `mayYieldNull`, so two `group('m')` sites with differently nullable value bodies decline
  (`…group('m').by(label).by(values('age'))…group('m').by(label).by(id()).cap('m')`) — merge with `a || b` in
  `accumulate` (`collection.ts`); also fix `test/L4-addendum/group-value-null-member.feature`'s
  ProductiveByStrategy scenario to `order().by(label).by('name')` (answer `{x:27}`). **cr-fu10** (B1)
  `g.V().has('name','marko').values('m').math('k + a')` (a Map's OWN keys, no scope named `k`/`a`) declines,
  trunk answered `[3]` — keep the map-entry read when no scope beyond the Map names the variable
  (`Scoping.java:119-135`). **cr-fu11** (B1) a `project()` key equal to a live label declines even where every row
  holds the field (`g.V().as('name').project('name','age').by('name').by('age').select('name')`).
- **cr-fu12** (B2) side-effect constant read depth gaps — `project(...).by(__.select('k'))`,
  `group().by(__.select('k'))`, `order().by(__.select('k'))`, `sideEffect(__.select('k'))`, a null constant under
  `map`/`where` decline (the chain answers): the by()/project seam does not route to `sideEffectSelectChild`. Plus
  L4 coverage for the answering element-host forms (`withSideEffect('k',5).V().select('k')`, arms, `3.0d`/`3L`).
- **cr-fu6 remains** a `where`/`P`-operand body under a one-row host still declines `SHARED_DRAW` (the predicate
  seam names no host row); `g.addV().addE().to(__.V().sample(1))` declines (addV's output is a ref, unbounded).
  **cr-fu15 / A3** draw-independent bodies decline too (`project().by(__.V().sample(1).count())`,
  `local(__.V().sample(1).count())`) — recorded in `docs/outstanding-work.md` §4.
- **rf3-fed-explicit-params** explicit federate `traversal` referencing an outer user parameter declines
  ("Unbound parameter 'injectedMap'"): the explicit form sends `NO_PARAMS`; forward `boundParams` in both
  (`src/services/catalog/federate.ts`).
- **r7-fu3 remains** `union(...)`/`choose(...)`/`map(local(...))`/`as('p').map(...select('p')...)` around a
  re-scan body (`…local(__.values('name').as('e').V().has('name', select('e')).count())`) still decline.
- **Labels and scope**: r2-gap-wb where-by under repeat labels/wrappers/`P.within`/bodies, incl.
  `not(where…by)` (should answer 6); r2-gap-F6 repeat until/emit and shortestPath predicates see no
  aliases; r5-fu8 alias-where under within/between/TextP; r3-fu6, r1101-fu2, r1101-fu3 source-union label readers.
- **Source union**: nested union first step, mixed arms, withSideEffect/withSack, `union(constant('x')).path()`,
  steps after it; r1101-fu4 `opensOffStarter` vs `unionArms` disagree.
- **Path / property streams**: o-subpath `dedup()` before `path().from()`; o-pathvals `id`/`label`/`valueMap`
  positions and mixed `path().unfold()`; o-propstream `where(<body>)` over a property host, meta-properties.
- **Values**: o-setop-types set ops lose member types; o-set-framing `order(local)` keeps the `set` marker;
  o-order-elemlist global `order()` over element lists; o-split local split; o-sack merge seed and `normSack`;
  r6-fu2-r inject list residue.
- **Round-7 depth gaps**: V2 Column/multi-key select inside arms, multi-reader child bodies, per-row collections
  via inject/constant; V1 bodies with `select(k)` over a Map-capable scalar, `select(all,'k')` over a Map row;
  federate tails beyond values/count/order; mid-traversal `inject(xs)`; stated-presence `by()` inside
  local/map/optional; `project().by()` after an `emit().repeat(…simplePath())` walk.
- **Repeat**: o-times-param `times($x)` should prefer the walk and keep the bind; o-unroll-deny make the
  unroll gate a DENY-list (`loops`, named repeat, `emit`, `until`).
- **Families** (rank by `rel-blockers`): scalar-transform tail, body-keyed `choose`, Column/path row ops,
  `Pop.all/mixed`, side effects, local/match/where; and the single-missing-caller list (collection-select
  `by()`, projector over a record, `local(project)`, `by(labels()|union())`, folded-union `within`, …).

### Hygiene, docs and missing pins

r6-s9-1 drop the `readsCompoundVocabulary` next-step peephole — pick scope by the consumer's framing, never
lookahead (verify — V2/B2 may have done it) · r6-s9-5 one own-entry CASE decode helper · **cr-fu8** (C2) stale
`dedupBy`/`keptDedup` comments in `lower/slice.ts`; `lower.ts:959` `productivityFilter(step, key, key.raw ??
key.value)` → `key.value`; pin `compilerNull()` in `test/compiler/productivity-filter.test.ts` and the `aliasGuard`
witnesses (`union(constant(null).as('b'), constant(2).as('b'), constant(3)).order().by(select('b'))` → `[2]`;
`dedup().by(select('b')).count()` → 1) · **cr-fu13** (D) `UNCOMPARABLE_LITERAL` names the step and suggests the
intent (scalar keys, the map in `option(onCreate/onMatch)`); the two `@Unsupported` pins in
`merge-oncreate-overrides-runtime-map.feature` assert the reason; §10 Limits notes other text-borne drivers
(`identity()`, `barrier()`, `union(constant…)`) are unchecked — do NOT grow the peephole; `write-args.ts`
`validateNoOverrides` stringifies every JS Map as `"{}"` · **cr-fu15** `ONCE_FILTER_HOSTS` is a fourth spelling of
the per-traverser filter-host set (`COLLAPSE_FILTERS` `ir/bulk.ts`, `SHAPE_PRESERVING` `ir/step.ts`,
`EXISTENCE_FILTER_HOSTS` `strategies.ts`) — one authority or a comment why it differs; ≈10 hand-rolled `V||E`
re-source tests · **rf3-callsite-form** `barrierIn`'s `form = at === 0 ? 'source' : 'mid'` mislabels an arm call
via `nestedBarrierIn` (`rel/segment.ts`) · **rf3-alias-authority** `block.ts` `aliasOf` vs `emit.ts` `freshAlias`
can disagree under a correlated scope (conservative direction only) — a comment or a pin in
`test/rel-core-sql.test.ts:215`; `scopeAliases` rebuilt per nested `Scope` (compile-time quadratic) — extend the
parent's set in `withRel` · **rf3-ci-port** `test/cf-constructs.test.ts` binds fixed port 127.0.0.1:8977, so
concurrent `mise run ci` flakes — take an ephemeral port · **rf3-pins** emit-alias-freshness beyond vertex/name:
`g.E().local(__.values('weight').as('w').E().has('weight', select('w')).count())` → `[1,1,2,2,2,2]`;
`where('h', eq('j'))` re-scan → `[1,1,1,1]`; re-scan in `union`/`repeat` arms; replace the vacuous "hasId after a
hop adds no scan" pin in `test/plan-stability.test.ts` with the uncorrelated `IN (SELECT id FROM nodes WHERE …)`
shape · r6-m-s8 `rowBounds` too wide over `rn=1`/HAVING · r6-m-federate-types param types dropped by CF
federation · r6-m-census wording · r5-fu4 §17 line for an unbound where label · r5-fu5 skip `valueTheta`'s NULL
arm on non-null types · r5-fu6 derive `declaredTypeOf` from `valueNodeOf` · r4-fu6 trace the valueMap sql-hygiene
raise (75→82) · r4-fu8a/b/e comments and the R11 jsonb pair · r3-fu4 `productivityFilter` takes only a projection
· r3-fu7 stale test citations · R15 pin `withSideEffect` number class · R16 `mapSlot` overclaims · R17 constant
`by()` typed via correlated VALUES · F8 `rankedFirst` key total (add `vt`) · F11 `refReads` stops at a Ref · F12
read spools off the Plan · r7-fu10 one JS→JSON encoder for a literal list (`constantListBlob`) · r7-m
`perRowCollectionStep` re-parses JSON per row, stale comments (`sack.ts`, `walk.ts`, `write.ts` MapDrivers), drop
V2's `format()` claim, `dedupBy` tie on `payloadCols(input)`, §17 NUL/surrogate lines, `1.0e-300d` read-back,
inherited sql-hygiene drift · F14b `aliasGuard` presence spelling · o-membertag · o-plansize `byNode` nests its
CASE · o-l4-sweep stale L4 expectations · pins: r7 (V2 compositions, bind-key share, `crossCarried` n==1), r4-fu9,
r3-fu5, r5-fu7, R13, R18, F13, r1101-fu1.

### Reuse proposals (one authority each; most turn a decline into an answer or delete code)

**rf3-idquery-dup** `idQueryOf`'s `routable`/`listAmongSeveral` (`lower/filter.ts` ~:755) re-derive what
`idMembership` decides and already drift: `hasId([],[])`, `hasId(within([],[]))`, `hasId(without([],[]))` decline
(ref `[]`, `[]`, all 6) — classify the predicate only and let `idMembership` judge operands; fix its doc comment
"`V(1,[2,3]) ≡ V(1,2,3)`" (refuted by `GraphTraversalTest.java:146-147`); comment the null-safe `IS NOT 1`; pin
`hasId(neq('x'))`/`without('x',2)` over a uid-NULL row, `E(7,[8,9])`, `hasId('x',['y'])`; `V([2,[3]])` and
`hasId(null,[3,4])` still decline · **rf3-reuse2** one `jsonMembers(values)` helper (`SELECT value FROM
json_each(<stringifyExact bind>)`) for ~10 hand-rolled membership subqueries — `src/bulk.ts`, `src/setwrite.ts`,
`src/formats/drain.ts:32`, and three on bare `JSON.stringify` with USER strings (`olap/kernel.ts:84` — a
lone-surrogate label matches nothing; `olap/pagerank.ts:76`; `src/manager.ts:81`); a later `mise run binds` rule
can point at it · **rf3-reuse4** fold `semijoin.ts` `retarget` and `write.ts` `reScope` into `walk.ts` `substRelId`
(`reScope` then also follows a Col into a correlated subplan); one `colsRead(e, rel)` in `walk.ts` for fuse's
`colsOf`/`census`, prune's `refs`/`scan`, semijoin's `referencesBeyond`, walk's `freeRelIds` · **rf3-reuse5**
`olap/pagerank.ts:72` routes seeds by `rows.length` — route by the call's form (only alongside other kernel work) ·
**cr-fu3** a scalar side-effect constant at the child seam goes through `constLit`, not a `{t,v}` `constantNode`
decoded per reference (`where(__.select('k').is(5))` emits a ~1 KB CASE tower) · **cr-reuse1**
`perRowCollectionStep`'s `submap` reader calls `namedBeyondMap(k, ctx, live.has(k))` · **cr-reuse2** one
`mapKeyScope(presence, key, ctx, live)` beside `namedBeyondMap` for `mapTail`'s select(k) arm and `mapHostChild`
(probe first before folding in the multi-key select or `scopeValue`'s record arm — that ADDS declines) ·
**cr-reuse3** `record.ts` `selectKeys` gets a `beyond(label, live)` closure instead of rebuilding `namedBeyondMap`
· **cr-reuse4** derive `group()`'s `mayYieldNull` from `producedMemberNode`'s member gate (drops the null-first
sort term for fold/list/map/element-valued bodies; verify with `test/L2-sql/group.sql.test.ts`) · **cr-reuse5** a
chain-aware `firstInChainsDeep` in `ir/walk.ts` and an exported `someNode(value, pred)` for
`uncarriedLiteral`/`uncomparableLiteral`/`holdsNaN` ·
`firstPerPartition` for five `row_number` hand-rolls (r1-reuse2) · `unitRow` (r1-reuse4) · `name()` takes the
`Minter` (r1-reuse7) · drop always-true `prn > 0` (r1-reuse3) · `ABSENT_VALUE` (r1101-p6) · `blockAliases`
(r1101-p7) · `choose()` conditions via `childPredicate` (r2-reuse1) · `emitsFromNothing` (r2-reuse3) ·
`aliasValueSubject` (r2-reuse4) · `mapEntryOf` (r2-reuse6) · `caseWhen` (r2-reuse7) · `VALUE_ARGUMENT_STEPS` from
the move tables (r2-reuse8) · `thetaOf` (r3-reuse1) · frontend `operandMembers` (r3-reuse2) · `rowBounds` over
`collapsedToOneRow` (r3-reuse5) · `allOf` (r4-ru2) · one TRUE/FALSE constant (r4-ru3) · `armTyping` (r4-ru5) ·
`withChannelValues` (r4-ru6) · `withEnclosing` widening (r4-ru8) · `list.ts` reads the arg type (r5-reuse2) ·
`slicesAcrossStarts` via `someStepDeep` (r6-reuse1) · `stepReads` (r6-reuse2) · one `materialized`/`fence` pair
(r6-reuse3) · `oneRowValues` (r6-reuse5) · every self-contained fence through `build.ts`
`fenced`/`fencedWhereSelfContained`, ~10 hand-rolled sites (r7-reuse1, fold with r6-reuse3).

### Laws found working this list

- `select(k)` over a value that may be a Map: a named scope beyond the Map — `withSideEffect` constant, named
  collection, path label — WINS (§17 "Map scope"; the reference's own order is entry → side effect → collection →
  label, `Scoping.java:119-135`); else the row's own entry; a row lacking `k` with nothing bound yields nothing
  (`SelectOneStep.java:62-72`). Pick scope by the consumer's framing, never by next-step lookahead.
- **`keys` is a sound MAY set merged by union** (B4): a Map's key fact is an upper bound only — arm and alias
  merges take the union, unknown if any side is unknown; there is no MUST set, so a key a row MAY hold beside a
  same-named scope declines rather than guessing the row holds it. A key outside `keys` is absent.
- **A `V()`/`E()` body over a may-be-absent host declines** (C4): the body discards the host's value, so its answer
  would depend on which rows matched; `reSourcedUnder` asks `mayBeAbsent(host)` before lowering, whatever the host
  (a label, an optional field, an intermediate value). EXPLAIN, DON'T BAFFLE: suggest `select('a').out()` or
  `V().has(…, select('a'))`.
- **A fast path falls through; it never declines what the general route answers** (A1): `reSourcedOnce` and its
  kind return "not taken" (`undefined`) outside their whitelist, and the general route (GraphStep's product)
  answers at the reference's own cost. A decline belongs to the general route, never to an optimisation.
- **One row-count authority — `rowBounds` — answers one-host questions** (cr-fu6; Calcite
  `RelMdMinRowCount`/`RelMdMaxRowCount`): "is this host one row" (`rootedHosts` = `atMostOneRow` ∧
  self-contained) and "is this body exactly one row" (`exactlyOneRow`) both go through `src/rel/bounds.ts`; a new
  unique-key arm goes there, not into a caller. `write.ts` `singleSource` is the one outlier (Writes follow-up).
- A value read N>1 times per row is landed ONCE through `once()` (`rel/build.ts`), never re-inlined per use.
- `project()` omits a key whose `by()` is unproductive (`ProjectStep.java:66`); whether it keeps a productive
  null is the open Tier B question.
- A `property()` traversal value of null REMOVES the key (`AddPropertyStep.java:152-160`).
- `mergeV` `onCreate` may restate, never override, a per-driver merge map; a null vs merge-key value is an
  override and raises (`MergeVertexStep.java:103`, `MergeElementStep.java:325-334,452`).
- Map equality ignores entry order (we decline it from the query text — D). Any Collection, Set included, is a
  label Collection (`TraversalUtil.java:211-236`).
- Absent label ⇒ the body's INPUT is empty, so a seeded reducing tail still emits its seed
  (`ReducingBarrierStep.java:143-148`). Presence of a body is "exactly one row", never "at most one"
  (`TraversalMapStep.java:52`). One presence term per map expression, never re-inlined per gate.
- Only a REDUCING barrier clears path labels. A child path carries the parent's labels.
- A `RANDOM()` window stays behind a Materialize fence; a draw inside a body shared by many hosts declines.
- A refusal that is arithmetic over row count needs a runtime GUARD, not a decline.
- Never join-union with a disjunctive `ON (src=w OR tgt=w)`: a self-loop must yield twice under `both()`.

**Branches:** none is parked. The round-3 resume branches (`wf/alias-presence-binding-3-*`,
`wf/federate-fresh-param-collision-2-*`, `wf/s9-one-scoping-reader-*`) were removed before the cleanup round; S9
and r7-fu1 are dropped, r6-fu1 restarts from its description above.

---

## §11. Open design decisions

Live ones sit beside the work they gate — §9's unbounded-plus-barrier wall. (§10's three-answer label coercion
is settled by the landed runtime-name resolver; its last disagreeing route — addLabel's constant fold — closed by §10
follow-up 3, 2184440a.)

Closed and recorded as law: exact-type literal framing resolved into §6·7. The numeric-tower PROMOTION rule
was REOPENED on evidence (2026-10-17, see §6·7: exact class) — it had been closed by NOT building it, since reproducing
`NumberHelper.getHighestCommonNumberInfo` changes no answer Gremlin can be asked while costing a sort
plus an O(N) sorter on every sum narrower than 64 bits. Re-open one only with evidence, not a
preference.

---

## §12. ⚠️ Traps — each cost a real defect, none found by reading

**The decline contract.** `null` is the ONLY decline, cheap and total — a partial lowering that
silently drops a filter is invisible, and a module whose contract is `null` must not let a throw escape
(§6·5 for the three that legitimately do). **A fast path is never silently dropped**
(`has(k,containing(t))` routes the trigram index via `semijoin`'s `trigramSeek`; a nested/param form
DECLINES the trigram strategy and takes the correct-but-unindexed generic `LIKE` — a perf tail, never a dropped filter).

**Before reproducing a reference distinction, ask what a client can SEE.** Three bands: it changes the
VALUE → build it; it changes the decoded CLASS across a boundary every GLV has (Number ↔
BigInt/BigDecimal/Date/UUID/string, scalar ↔ Array/Set/Map) → build it; it changes only the GraphBinary
TAG inside a band every GLV collapses → do not build it, document the deviation. Band 3 is never a
reason to DISCARD upstream (§6·7 — carriage is cheap), only a reason not to build machinery to
RECONSTRUCT what nothing can observe.

**Wrong answers with the right arity** — the class no ladder level sees:

- A non-derivable fact must not be re-implemented (typed inject tags, `JAVA_WHITESPACE`) — call the one
  authority. A second implementation is a second chance to get it wrong.
- A type ASSERT is not a predicate (`is(typeOf(LIST))` RETYPES; as a filter it returns right rows framed
  wrong). A parse that must RAISE cannot be a `CAST` (`asNumber('1,000')` must raise, not answer 1).
- A dedup must not distinguish rows by MULTIPLICITY; a survivor stands for itself.
- `count()` is not SQL — an `Agg` with no args means "over all rows". A `Lit` cannot express a REAL
  literal whose value is integral (JS `1.0` IS `1` → integer division); use an explicit `Cast`.
  `values(k…)` reads EVERY key, not `args[0]`.
- Comparison across type spaces (a range predicate, `min`/`max`) must gate on type-space agreement;
  reducer eligibility and order go through `storedCompareOn`, never SQLite's storage class.
- **Only the `elements` framing arm carries `bulk` to the wire.** Every other arm drops it, so a
  collapse in front of a chain that retypes and then ENDS answers N traversers as one row. A collapse
  is legal only where the carried channels survive a merge (`CHANNEL_GROUP_POLICY`) AND the suffix
  reads the multiplicity (`ir/bulk.ts`); a BODY's end is not the wire, and `bulked` goes STALE at a
  barrier that drops the channel.
- **A NULL frames as null under EVERY static tag — the tag describes the STREAM, not the row.**
  `frameValue` short-circuits a null value to the untyped-null serialization before its tag switch;
  coercing it (`Number(null)` → 0, `Boolean(null)` → false, `BigInt(null)` throws) turns a genuine
  null traverser into a plausible value with the right arity — the class no ladder level sees. Two
  witnesses: `asNumber(GType.INT)` over a null (`AsNumberStep.map` returns null before the token
  branch) and an all-null `min`/`max` (one null traverser is emitted). A typed-null and an untyped-null
  decode to the same language null in every GLV (a Band-3 tag distinction), so the untyped null is the
  observationally-correct framing and needs no per-tag null encoding.

**Order and determinism.** Deterministic, not merely ordered — `ROW_NUMBER() OVER (ORDER BY encounter,
id)` needs the tie-break, and the tie-break is the caller's argument. Mint the emission order ONCE over
a whole fan-out, never per arm. A sort SUPERSEDES the arriving order, so re-MINT where a position is
carried. A correlated hop threads no order. **Collapse and emission order are MUTUALLY EXCLUSIVE.** A
non-deterministic ordering expression (`RANDOM()` for `sample`) must never sit in a slot the assembler
can inline — rank in a window and filter. Slice tests must pass under `test:perturbed`.

**Structure and plumbing.** A chain-level requirement (path/encounter demand) is computed over the
WHOLE chain, at the point the chain is identified. A clause reader (`WHERE`/`ORDER BY`) that reads a
select alias needs a `Materialize` fence — the FIRST reader only. A window may not read a windowed
column; the ASSEMBLER closes the block. Relation ids are minted PER LOWERING (a module-global counter
makes two compiles emit different SQL) and a replicated subplan carries FRESH ids. A `Project` over a
whole-relation `Aggregate` that reads none of its outputs ERASES the aggregation — the emitter blocks
it (Calcite's `fieldsUsed.isEmpty()`). Two shared authorities keep a repeated SQL shape from drifting
between its sites (§6·6's rule applied to the emitter, not just the fold): `rowNumberWindow` (`build.ts`)
is the ONE `ROW_NUMBER() OVER (…)` mint — every per-origin slice, keyed dedup, argmax, `sample`,
`renumber` and write ordinal extend the input through it, keeping only their own filter/reprojection;
`firstRootedValue` (`build.ts`) is the ONE "a rooted operand's FIRST value" (`ORDER BY encounter LIMIT
1`), shared by `nestedFirstValue` and the list-member-predicate seam — a hand-rolled copy of the latter
had drifted to a scan-order value.

**Consulting the reference is the root `CLAUDE.md`'s rule, not repeated here.**
