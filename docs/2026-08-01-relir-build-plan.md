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
| **`fuse`** | 🚧 small semantic rewrites. Ask what still buys anything the assembler doesn't before wiring it |
| **`flatten`** | ✅ landed by DISSOLUTION, not a pass — the join-flattening / decorrelation legality it needed became `src/rel/block.ts` (`shapeOf`/`fromTree`/`fusedInto`), consumed by `recursive.ts` (P1/barrier laws) and the emitter. No `JoinUnionTranspose` pass was built: a `union`-topped body decorrelates structurally |
| **`recognize`** | ✅ RETIRED as a distinct pass — "fast paths as plan rewrites" is the physical-rewrite KIND, realised by `semijoin` over the finished algebra, not a tier of its own. Residue is a PERF tail (a nested/param `containing()` takes the correct-but-unindexed generic `LIKE`), gated on a real slow query + EXPLAIN |

**Declared is not wired.** Only `name` and `semijoin` have production callers; there is no object that
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

## §10. What is left — the worklist, in compounding-substrate order

Rank by what a gap UNLOCKS, not by L3 gain — substrate that opens other families first, leaf gaps last.
Re-derive the live blocker ranking from `mise run rel-blockers` (it rots — read a decline's REASON, not
its date). Three worklists FAIL LOUDLY when a shape lands, so check them before assuming something is
untracked: `test/rel-spine.test.ts`'s `DECLINED`, `test/L4-addendum`'s `@Unsupported`, L5's `LAW
UNEVALUABLE`.

### Landed substrate (✅ — each line records only that the mechanism exists; the code is the authority)

- ✅ **Map shape (a READ).** `inject([k:v,…])` map source (`injectMap`, zero-bind typed literal via
  `valueNodeOf`); multi-key `select(k…)` sub-map projection in select order (`mapSelect`); `by(<pre>.fold())`
  group value = a LIST per partition (`groupCollected`); `Scope.local` count/slice over a select record
  (`recordToMap` → `mapTail`).
- ✅ **List shape.** Members-as-ELEMENTS (per-arm admission, local slices, `order`/`dedup` by id); members-as-MAPS
  (`project`/`valueMap`/`group().fold()`, `unfold()` round-trip); element-member SET OPS same-kind by rowid
  (`listSetOp`); `by()` over a LIST host (`unfold()`→`correlatedListMembers`→`correlatedReduce`) for ELEMENT
  and SCALAR members (`by(__.unfold().count()|sum()|max()|min()|fold())`, the member position carried as the
  `encounter` channel so `fold()` preserves list order); `by(<pre>.fold())` collect + fence (`recordToMap`
  `Materialize` when self-contained).
- ✅ **`RowShape`** — one row-algebra engine (`orderRows`/`rowOp`/`dedupOn`) for **all six streams**: element,
  property, scalar, record, list, map (`elementRowShape`/`propertyRowShape`/`scalarRowShape`/`payloadRowShape`,
  the last shared by record/list/map). `order`/`dedup`/slice ARE one operation over the traverser stream
  (TinkerPop's `OrderGlobalStep<S>`/`DedupGlobalStep<S>` are generic in `S`); the only per-shape input is
  compare/equality/position/host, which is the `RowShape`. Three moves made it the single authority: the
  collapsing `Distinct`/`Aggregate` arms are payload-GENERAL (project `payloadCols`, group by `shape.identity`,
  not a hard-coded `id`); a non-collapsible channel (an alias/sack) no longer declines but routes to the window
  arm, which keeps the FIRST occurrence's whole traverser (`DedupGlobalStep`'s rule) — so the collapse is a pure
  SQL optimization, `V().as('a').both().dedup().select('a')` now lowers, and the lift COMPOUNDS (every shape gets
  per-origin dedup, graph identity, the ordered first-occurrence, the deterministic tie for free). `natural` is
  absent for scalar/record/list/map so a bare `order()` does not invent an order in SQL — TinkerPop 4's
  Orderability (a recursive total order over all types) is a SEMANTICS feature that runs in JS where SQL cannot
  express it, NOT "no comparator" (see the §10 note; a LIST and a MAP stream now land via the whole-stream barrier,
  a mixed stream still declines). The ordered-dedup aggregate CONDITIONALLY fences
  a computed payload (`AS MATERIALIZED`) so a scalar `label()`/`values(k)` subquery is not re-evaluated in both
  `GROUP BY` and `SELECT`; a physical `id` groups directly, byte-unchanged.
- ✅ **Fan-out / child seam.** `flatMap`/`local` fan-out rejoin (`flatMapRejoin`); per-origin SLICE
  (`partitionedSlice`, = Calcite `convertDistinctOn`) and FOLD (correlated list subquery, seed-free);
  `coalesce`/`optional` reduction arm (`reductionArm`, seeded `count`/`fold` only); `optional` lowering;
  the shape-agnostic variant tail (`variantTail` — count/slice/dedup over a mixed merge).
- ✅ **Branch merge / emission order.** Positionless, collect-demand (`withFanoutOrder`) and slice-demand
  TRAVERSER-major (`mintTraverserMajor`, the `branchOrder` parent-position carrier) mints; ARM-major for
  all-batched (`batchedBranch`), mixed batched/streaming SCALAR (`mixedScalarBranch`), and MIXED-SHAPE
  arms (`mixedBranch`); single-arm `union(t)`≡`t`; record-valued arms (agree→record, disagree→map-demote);
  branch + filter over the property tail.
- ✅ **Path family.** `simplePath`/`cyclicPath` linear + recursive (path channel through the walk) + bounded
  (`unrollableBodyStep`); `by(<proj>)` path compare; barrier-drops-path (`dropPath`); value positions
  mid-path (`appendValuePosition`); `from`/`to` sub-path scoping via gated labels-on-path (`subPathMembers`).
- ✅ **Predicate / alias / scope seams.** Nested-traversal operand for compare / `within` / `without` (rooted
  + correlated, order-faithful `nestedFirstValue`; folded-list and vararg forms); alias scope threaded through
  the filter seam (`where(select…)`), compound alias-`where` over the modulator ring (`aliasValueWhere`), bare
  `where(P)` identity compare; `select(name)` over a NAMED COLLECTION (CROSS join, `selectCollection`);
  `math`/`format` over a record order key and a `withSideEffect` constant; `select`/alias re-root in a child body
  (`selectRerootHost`/`selectRerootSubject`); `concat(__.<traversal>)` operand (with `concatEmptyGuard`);
  `by(__.values(k).is(P))`; keyed `dedup(k…)` on the element stream (`dedupByLabels`); self-rooted `by(__.…fold())`.
- ✅ **Retype / typing leaves.** `constant()` carries its declared type; `hasId(…)` (was entirely unlowered);
  exact REAL→JSON (`jsonMember`/`jsonMemberByTypeof`); a GLOBAL string transform over a list = TinkerPop's
  type error (`GLOBAL_STRING_THROWS`, propagates); the LOCAL `StringLocalStep` runtime value guard
  (`localStringMemberGuard`); illegal `range(low,high)` raises (`ValueParseError`); `all`/`any`/`none` over a
  SCALAR traverser = empty; a single shared `constantRetype` from every tail; a COLLECTION literal fed
  straight to a scalar cast (`inject([…]).asNumber()/.asBool()/.asDate()`) RAISES TinkerPop's parse error
  (`ScalarMapStep` over the whole traverser; the inject dispatch routes a `CONSTANT_FOLDED` cast at
  position 1 over an array/map arg to `injectSource`'s fold rather than the list/map shape source, and
  `javaTypeName` gives the one `ArrayList`/`LinkedHashMap` class-name authority for the message).

### Still open — the worklist, in unlock order

**Substrate (each opens several families):**

- 🚧 **Map-shape residue:** the map-valued `union` source; seeded `fold([:], Operator.addAll)`; the `merge`
  map-operand; a non-string (`T`-token) key. (A map feeding `mergeV`/`mergeE` — 7 write traversals — is write
  substrate, not this.)
- 🚧 **List members that read as a VALUE:** SCALAR, TYPED, MAP and nested-LIST member `by()` reductions LANDED
  (above — `correlatedListMembers` returns one `{rel, framing}` per member kind, so `by(__.unfold().count()|fold())`
  over a list-of-maps/lists and a typed `max`/`min`/`order`/`fold` all reduce through `correlatedReduce`; only a
  MIXED-membered list still declines). LEFT: an `is(P)`/`order()` INSIDE the correlated body declines —
  `scalarTail` fences a clause-reader with a `Materialize` and `correlatedReduce` refuses a fenced
  (uncorrelatable) tail (🔴 bind-budgeting a correlated clause-reader without a `Materialize` is a design call —
  the naive fence-skip is unsafe for a typed member's ~20-bind vtype ORDER CASE); `order`/`range(Scope.local)`
  over a list-of-maps (the `nested` decline in `listMemberOp`, a recursive compare/equality key); a PROPERTY-member
  list; `select()` inside a list-host body (the other opener).
- 🚧 **`flatten` / join-union transpose** (§4; Calcite `JoinUnionTransposeRule`) — decorrelation into the P1
  envelope; unlocks the unbounded repeat body whose UNION is not the top node (`repeat(__.bothE().inV())`).
  ⚠️ Must NOT be shortcut with a disjunctive single-arm join `ON (e.src=w.id OR e.tgt=w.id)`: it matches a
  SELF-LOOP once where `both()` must yield the vertex twice, and it fails SILENTLY.
- 🚧 **Fan-out multiplier residue:** a per-origin SCALAR-order path (`values(k).order().fold()`); reductions with
  NO fold (`max`/`mean(local)` after a scoped fold); the group-scoped reducer with a SCALAR host (empty pool is
  per-reducer — `CountGlobalStep` seeds 0 and keeps its key, `SumGlobalStep` does not; a scalar host needs
  `origin` to name a rowid-less parent); `tail` (count-from-end); a child-body-label ESCAPE
  (`local(out().as('b')).select('a','b')`); path HIDING through a fan-out (`flatMap(out().out()).path()`);
  `map`'s per-origin WINDOW (it takes the FIRST body result).
- 🚧 **Branch / slice residue:** a variant with a MAP/RECORD/PATH/PROPERTY arm (no `vk`); a batched `choose`
  (a per-arm gate, not the shared-input one); an ALIAS through a collapsed arm (the barrier drops the label);
  a NESTED branch inside a sliced arm (a key STACK).
- ✅ **`RowShape` — CLOSED.** All six streams (element/property/scalar/record/list/map) route `order`/`dedup`/slice
  through the one `rowOp` engine (see the Landed-substrate `RowShape` line). Scalar/record/list/map dedup, the
  element alias/sack first-occurrence dedup, and `order().by(Column.values)`/`by(Column.keys)` over an unfolded
  Map.Entry stream (`byExpr`'s `column` arm reads the entry side under the compare wrapper its `$.t` names) all
  lifted. ✅ **Bare global `order()` over a LIST and MAP stream landed (2026-09-02)** via TinkerPop 4's
  **Orderability** (`GremlinValueComparator` — a total order over ALL types: a cross-type precedence ladder plus a
  RECURSIVE element-wise compare for collections). SQL has no such comparator, so it runs in JS through the
  WHOLE-STREAM value-transform barrier: `orderStreamValue`/`orderMapStreamValue` reorder the array of head values by
  `orderabilityCompare` (a map by its sorted ENTRY-SET, `mapComparator`), and `lowerListResumeOf`/`lowerMapResumeOf`
  re-inject in sorted order (`order-dedup-local.ts` `buildOrderGlobalSegment`, `barrier-value.ts`
  `buildValueStreamTransformSegment` with a `valueHead`/`mapHead` resolver). This is the stream twin of the
  `order(Scope.local)` barrier and reuses the SAME `orderability.ts` comparator, not a sortable-key SQL encoding —
  the recursion boundary the codebase already draws for `order(Scope.local)`. It also fixed a shared substrate bug:
  the value-resume seed now carries the array index as an ENCOUNTER channel (`lower.ts` `RESUME_ORD`), so a re-
  injected list/map stream keeps stream order across a later `unfold()` — `split()`/`reverse()` re-injects shared the
  bug (they interleaved lists: `x,p,y,q` for `split(',').unfold()` over `'x,y','p,q'`). LEFT: an element-membered
  list (cannot round-trip — the rowid is gone once it JSONs through the barrier — fail-closed decline). A SCALAR
  stream stays in SQL (SQLite orders by storage class). (`order(Scope.local).by(Column.values)` — sorting one map's
  entries in place — is the other open leaf, a `mapRange`-family local op, not the row engine.)
- 🚧 **Property-stream vocabulary:** the `by()` vocabulary (`T.key`/`T.value` absent from `TOKENS`), the
  `id()`/`label()` retypes off a property row, `where(<body>)` over a property host, and META-properties
  (`properties().properties()`). `project`/`select` over a property needs FRAMER work — the record→map wire
  framer emits empty maps (`[{}, …]`), verified 2026-08-13 and reverted rather than shipping the mis-frame.

**Guard-binding family** (§6·5 — a graph-dependent refusal → `Binding.guard`):

- 🔴 **Runtime / computed LABEL** (~6 writes). `ElementHelper.validateLabel` is three PURE predicates → a guard,
  not a decline; the gap is a missing guard at the nine CALL SITES. ⚠️ The message set depends on ARITY. Settle
  the three-answer coercion HERE, don't add a fourth: `mergeV([(T.label): x])` coerces, `g.addV(x)` declines,
  `addLabel(x)` coerces.
- 🚧 **`T.id` on `mergeV`/`mergeE`** (5 writes) — `elementIdGuard` exists; the `Insert` column plumbing does not.

**Writes** (rel-blockers: property 4, addE 3, addV 2, mergeE 1):

- 🚧 **`property(k, <traversal>)`** — two values are provably ONE-ROW (first increment); a multi-row value is the
  `applyAll` case (`AddPropertyStep.java:105-199`): 0 rows → NO mutation; >1 under `single` → the guard message
  *"Single-cardinality property requires exactly one value, but traversal produced N results"*; >1 under
  `list`/`set` → each written; the single-argument MAP form is a third case.
- 🚧 **Meta-property under an UNDECLARED cardinality** (2 writes) — the `set` arm PATCHES rather than inserts;
  needs an `UPDATE` this route does not emit.
- 🚧 **`with()` on a write · singletons** (`addE` after `addE`, `addInE`; ~10 writes) — one reason each.

**Parameter / repeat residue:**

- 🚧 **`times($x)` should PREFER the walk** (§9), where it stays a bind — unrolling forces the early parameter
  reduction the root `CLAUDE.md` names.
- 🚧 **The unroll's admitted-body gate should be a DENY-list** of exactly `loops()`, a named `repeat('a',…)`,
  `emit()`, `until()`. ✅ Partially done by ADDITION: `simplePath()`/`cyclicPath()` joined `unrollableBodyStep`
  (pure path filters an unrolled phase reproduces). ⚠️ Worth ~+10, but most bounded declines are ordinary
  coverage gaps in a `repeat` costume (`select`/`local`/`group`/the map shape the spliced chain still can't lower).

**Leaf gaps** (one family, no downstream unlock):

- 🚧 **Set-op keeps members' types** — `values('when').fold().merge(…)` returns raw millis; the lossy test must
  span BOTH sides (`withLossyFlag` asks it of one). ⚠️ Gating on the compile-time `typed` flag is a DIFFERENT
  question, measured wrong.
- 🚧 **The `set` framing marker** survives all but `order(local)`/`unfold()`; the threading is in place but
  `order(local)` still does not drop it.
- 🚧 **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type) — needs head-position tracking on the RelIR `AliasEntry`.
- 🚧 **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what
  `path().by(<transform>)` writes) — inert until tags join a comparison.
- 🚧 **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy) and `barrier(Barrier.normSack)`.
- 🚧 **`dateAdd`/`dateDiff` over a NON-datetime input is a wrong answer, not a throw.** `DateAddStep.map`
  throws *"dateAdd() accept only OffsetDateTime or Date (deprecated)."* and `DateDiffStep` throws on a
  non-date LEFT operand (`vendor/tinkerpop/gremlin-core/.../step/map/DateAddStep.java`), but the const-fold
  (`foldConstantCoercions`, `gremlin/coerce.ts`) computes `Number(v) ± delta` unconditionally, so
  `inject(null).dateAdd(DT.day,2)` answers epoch-0+2d and `inject(1234).dateAdd(…)` treats the int as
  millis — both should raise. Unwitnessed (every DateAdd.feature scenario feeds `datetime(…)`), and the
  fix is fiddly: the fold must gate on datetime PROVENANCE (`as==='datetime'` OR a datetime-literal source)
  without breaking the working `inject(datetime(…)).dateAdd(…)` path, whose datetime literal does not set
  `as`. Neighbour of the reducer null family (2026-09-05) but its own increment.
- 🚧 **Path value positions** — `id`/`label`/`valueMap` (channels `[]`, no carry); `path().unfold()` over a MIXED
  element+value path; the ENCOUNTER-plus-path walk.
- 🚧 **L4 sweep** — two committed expectations encoded a since-deleted implementation's bug; nobody has swept
  the rest.
- 🚧 **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself; one commit.
- 🚧 **`split()` (7 blockers) is DEFERRED BY DESIGN, not a leaf to build.** A Java-`StringUtil.split` string→list
  transform whose every arm diverges from SQL; its home is the string-op-semantics decision in
  `docs/2026-08-12-regex-as-a-barrier-research.md`, NOT a bespoke recursive-CTE. Fails closed correctly today.

**Families still largely open** (rank live via `rel-blockers`): the scalar-transform tail; branch (the
SOURCE-position `g.union(a, b)` and the option-keyed `choose(<projection>)` where the choice is a body rather
than a `T` token); row ops (`Column`-keyed and the `path()` tails); aliases (`select`, dominated by
`Pop.all`/`Pop.mixed` history reads); side effects; then `local`, `match`, `where`, the `path` tails.

**Single-missing-caller residue** (each is one caller, not missing algebra — the pattern this whole stage kept
finding): `by()` over a collection select + a multi-key select mixing a collection name with labels; a projector
body with a TAIL past it over a record; the SCALAR-stream `is`/`where` callers still pass a null host; a record
arm against an ELEMENT/scalar/list arm and `local(__.project(…))`; a bare `by(__.labels())` and `by(__.union(…))`
(a fan-out `by` takes the FIRST); `by(__.properties(k).fold())`; a folded UNION operand for `within` (the
source-`union` gap); a vararg operand whose first result is itself a LIST/ELEMENT; a `Pop` history select.

⚠️ **Where a refusal is arithmetic over the INPUT's row count, a host that cannot count statically needs a
GUARD, not a decline.** `addV` proves single-row at COMPILE time (a literal `Values`); an `addE` mid-chain
input is a traverser relation, and nothing static separates `g.V(1)` from `g.V()`.

⚠️ **Invariants earned here — re-breaking each costs a wrong answer** (the rest are at their call sites):

- **A NULL never WINS a min/max and must never be FILTERED.** `NumberHelper.max/min` return the non-null side;
  over an all-null input they reduce to null and ONE null traverser is emitted. Nulls sort LAST, with an
  explicit `IS NULL` term (SQLite orders NULLs first ascending).
- **EVERY global reducer emits its reduced value over a NON-EMPTY input and NOTHING over an EMPTY one, and
  a non-empty all-null input reduces to null.** `Sum`/`Mean`/`Min`/`MaxGlobalStep` all override
  `processAllStarts` with `if (starts.hasNext())` and their `generateSeedFromStarts` reduces an all-null
  stream to null. min/max realise this with their argmax window (zero rows for empty input by
  construction); sum/mean use SQL aggregation, which collapses to ONE row for BOTH empty and non-empty
  all-null, so a `count(*)` HAVING guard (`nonEmptyReducer`) distinguishes them and `productiveNull`
  carries the surviving null out. `count(*)` (rows, not bulk) IS the `starts.hasNext()` test.
- **A scalar-shape NULL row frames as null under EVERY tag, never coerced (`frameValue` short-circuit,
  §12).** Distinct from the reducer rule above: this is the wire framer, that is the row's *presence*.
- **A map is a SCOPE, consulted BEFORE the path labels** (`Scoping.java:119-135`); `containsKey` is presence (an
  `EXISTS`), not "the value is not null". An unresolvable `select()` key is the EMPTY RESULT, not a decline
  (`Select.feature:578-596`).
- **`ChildValue.present` carries productivity beside the value** — `Pick.none` and `Pick.unproductive` are
  distinguishable no other way, and a body that cannot report it DECLINES.

---

## §11. Open design decisions

Live ones sit beside the work they gate — §10's three-answer label coercion, and §9's
unbounded-plus-barrier wall.

Closed and recorded as law: exact-type literal framing and the numeric-tower PROMOTION rule both
resolved into §6·7 — the second by NOT building it, since reproducing
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
