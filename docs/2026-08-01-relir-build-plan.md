# RelIR — the algebra

`Step[] → RelIR → SQL`: an inspectable, rewritable relational algebra between the Gremlin front-end and
the `q` SQL kernel. It is the ONLY lowering.

**Numbers live in instruments, never in this prose** — coverage is `test/census/goldens.tsv`, the
conformance floor is `test/L3-conformance/l3-state.json`, the per-family blockers are
`mise run rel-blockers` (re-run it; it moves). A machine-checkable statement of the same rules:
`docs/spec/relir-algebra.allium`.

**Legend:** ⚠️ trap, do not re-derive · 🚧 left · 🔴 needs a human call.

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
| **`flatten`** | ✅ landed by DISSOLUTION, not as a pass. `expandRepeatBody` is deleted; the join-flattening / decorrelation legality it needed became `src/rel/block.ts` (`shapeOf`/`fromTree`/`fusedInto` — Calcite `SqlImplementor.needNewSubQuery` prior art), consumed by `recursive.ts` (P1/barrier laws) and the emitter. No standalone `JoinUnionTranspose` pass was built: a `union`-topped body decorrelates structurally (block.ts treats a union side as `closed`→derived table while the self-ref stays unwrapped in the term's FROM), so `repeat(__.bothE().inV())` composes without one |
| **`recognize`** | RETIRED as a distinct pass. "Fast paths as plan rewrites" is not a tier of its own but the physical-rewrite KIND, now realised by `semijoin` (two `OwnerSeek` strategies over the finished algebra); `recognize` was a placeholder name, not a term of art. What remains is a PERF tail, not a pass: `trigramSeek` fires only on a filter over a bare scan with a literal ≥3-char term, so a nested / non-scan-rooted / parameterized `containing()` takes the correct-but-unindexed generic `LIKE`. Gate any widening on a real slow query + EXPLAIN, not on a structural hunch — the uncovered cases already answer correctly |

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
Re-derive the live blocker ranking from `mise run rel-blockers` (it rots — `blame()` once read a wrapper
and reported the LARGEST family as absent; read a decline's REASON, not its date). Three worklists FAIL
LOUDLY when a shape lands, so check them before assuming something is untracked: `test/rel-spine.test.ts`'s
`DECLINED`, `test/L4-addendum`'s `@Unsupported`, L5's `LAW UNEVALUABLE`.

**Substrate — each unlocks several families, do these first:**

- **The map shape (a READ).** The map-value SOURCE is now built: `g.inject([k:v, …])` seeds a
  map-valued traverser (`mapLiteralBlob`/`injectMap`, `compiler/rel/{map,lower}.ts`), so the whole
  re-enterable tail already built for `group()`/`valueMap()` works over a literal. It reuses
  `valueNodeOf` — the one authority for the stored `{t,v}` tree — so the blob is a compile-time typed
  literal (zero binds). **Multi-key `select(k1,k2,…)`** over a map is also in (`mapSelect`) — a sub-map
  projection in select order, filtering the traverser when a key is absent (`SelectStep.java:66-89`)
  and keeping a present-null key (`Scoping.getScopeValue:121` reads `containsKey`). What is LEFT of the
  multiplier: the map-valued **`union`** source, and the remaining corpus TAILS — **seeded
  `fold([:], Operator.addAll)`** and the **`merge`** map-operand. A non-string (`T`-token) key and a
  map feeding `mergeV`/`mergeE` (7 write traversals — ⚠️ not write work) decline whole and belong to
  the write substrate.
- **A list whose members may be ELEMENTS.** LANDED for the ops that do not read a member as a VALUE:
  member admission is now PER ARM rather than one `isBareList` door, so the local slices and
  `order`/`dedup` serve an element list while a string transform and a member predicate still decline (a
  rowid is not a string). An element member IS a `ChildHost`, so `by(k)`/`by(T.label)`/`by(<body>)` cost
  nothing new, and an unproductive `by()` drops the member (`Order.feature:281-289`). ⚠️ Its compare key
  and identity are the SAME two per-type facts the property `RowShape` states — `GremlinValueComparator`
  compares an Element by id, `ElementHelper` hashes it by id. 🚧 What is LEFT: the map-family residue
  (`with(tokens, ids)`, the `by(__.unfold())` that pairs with them, `order(Scope.local)` over map
  entries), and a PROPERTY-member or NESTED-list member list in the same arms.
- **A list whose members are MAPS — LANDED.** `project(k…).by(…).fold()`, `valueMap().fold()`,
  `group().…fold()`, and a nested `project().by(__.…project().fold())` — every GraphQL to-many object
  field at depth ≥ 2 (`docs/2026-08-07-graphql-front-end-plan.md` §2·2, the substrate item it names
  first). `fold()` had an arm only on the scalar/element tails; it now has one on `recordTail`/`mapTail`
  too, a record collapsing via `recordToMap` FIRST so `foldMaps` (`list.ts`, `foldScalars`' twin) sees
  ONE map column whatever produced it — the per-row pairs array, collected under `json()` so
  `json_group_array` keeps each member a nested array rather than a re-encoded string. `ListOf` grew a
  `{ kind: 'map'; of: MapOf }` arm (`render.ts` — the total-union completion, framed by the one
  `frameTypedNode` `{t:'map'}` rule already in `execute.ts`). ⚠️ A list NESTED inside a `project()` field
  frames through `listNodeExpr`, NOT `listPayloadExpr` — the same `elementNode`/`elementObject` split one
  level up: a member inside a map value is read by the TREE walker (`frameTypedNode`), which needs every
  leaf tagged, where the top-level list framer takes bare element objects; getting this wrong frames a
  folded element list as untyped objects (`[null,…]` off the wire). **`unfold()` closes the round trip**
  (`unfoldMapMembers`, `unfoldNested`'s twin): a map-membered list unfolds to one MAP traverser per
  member, re-entering `mapTail`, so `project().fold().unfold()` and `select(Pop.all).by(__.…fold()).unfold()`
  compose. ⚠️ That surfaced a LATENT key-encoding split — `group()`/`valueMap()` emit a `{t,v}` node key,
  `project()` a BARE string key; both frame identically but `select(<key>)` read only the `{t,v}` form, so
  the map-key match is now tolerant of both (`keyMatches`, `COALESCE($[0].v, $[0])`, shared by
  `mapKey`/`mapSelect`). 🚧 What is LEFT: the remaining member ops over a list-of-maps (`order`/`range` at
  `Scope.local`) fail closed pending their own arms (`count(local)` is shape-agnostic and works).
  ✅ **A `by(<pre>.fold())` GROUP VALUE — a LIST per partition — LANDED** (`groupCollected`, `map.ts`):
  the sibling of `groupReduced`, pooling the pre-fold body's rows through `child.rows` (so
  `by(__.out().fold())`'s many-per-traverser body flattens exactly as `by(__.out().count())`'s does) and
  COLLECTING them rather than reducing. A `FoldStep` SEEDS `[]`, so an empty pool keeps its key with `l[]`
  rather than dropping it — the same SEED row `groupReduced`'s count arm unions in, filtered from the array
  by the collecting aggregate's `FILTER`. Members frame through `producedMemberNode` (factored out of
  `byNode`, so an element list rides as `{t:'vertex',…}` nodes), and the pooled rows hand off to `groupMap`
  unchanged — so a `by(<pre>.fold())` frames identically to the by()-less collect one container along. An
  `order()` before the fold composes for free (`child.rows` preserves the origin through it, and a global
  order restricted to a partition IS that partition's order); a `dedup()` before it DECLINES (it collapses
  the pool). The ELEMENT-identity key (`by()`) now reaches the pooled arm — count AND fold — by taking the
  key from the child rows' `origin`. L3: the `sideEffect/Group.feature` `byXout_foldX`/`byXout_order_foldX`
  family plus `map/Group`'s ordered-fold scenarios. 🚧 What is LEFT: a `dedup()`/`sample()` before the fold
  (a partition-relative barrier the shared pool cannot honour); a SCALAR host.
  ⚠️ **A record field's PRESENCE guard re-emits the field's whole value expression** (`recordPairs`'s
  `CASE WHEN <value> IS NOT NULL THEN json_insert(…, <value>)`), so an OPTIONAL nested field spells its
  entire correlated subquery TWICE — and it COMPOUNDS with nesting (a depth-3 selection was 27 KB). A
  field is only optional when its `by()` body can be UNPRODUCTIVE; a `fold()`/`count()` seeds and is
  always productive, so `byField` reads the seam's `present === ALWAYS_PRODUCTIVE` (moved to `child.ts`
  as the one shared object) and drops the guard. Measured: depth-2 6.2 KB → 3.3 KB, depth-3 27 KB → 8 KB,
  and the `select`/`tail` hygiene baselines returned to their pre-feature bytes.
  ⚠️ **The map COLLAPSE re-emits each field column too** — `jsonMember`'s `CASE` spells `v`/`vtype` ~6×
  per field and the emitter INLINES a `Project` column's definition at every reference, so a field whose
  value is a `firstOf` property subquery re-emitted the whole subquery ~6× (a single `project('n').by('name')`
  → 16 `vertex_properties` subqueries). `recordToMap` now FENCES the record relation (`Materialize`) so each
  field column is computed once in a CTE — but ONLY when `freeRelIds(rel).size === 0` (self-contained): a
  CORRELATED record inside a `by(__.…fold())` reads an outer row and a fence would hoist it out of that
  scope (`freeRelIds` is the shared authority `name`/`flatten` use, and `check` refuses a fence over a
  self-reference for the same reason). Measured: `project('n').by('name')` 2570 → 1243 B, `select` family
  −53 %, behaviour byte-identical (census answer-change gate clean). 🚧 What is LEFT: a CORRELATED inner
  fold (`by(__.out().project().fold())` at depth ≥ 2) cannot be fenced, so its per-field property read still
  duplicates (correct, just verbose). ⚠️ The fix is NOT to route `recordNode`/the inline record through
  `byNode`: measured, that regresses a TYPED record key/value to `t: null` because `byNode` DROPS a per-row
  vtype (its "compute-once invariant" — a plain map side cannot carry one, but a record field must, and the
  `group().by(__.project(…))` L2 assertions pin `t:'string'`/`t:'int'`). The correct shape is a single
  correlated subquery projecting `{t: vtype, v: jsonMember(value, vtype)}` with value/vtype as COLUMNS of
  ONE scan — `byNode`'s own property-KEY arm (`firstOf(typedNode(col,col))`) already does exactly this, so
  the increment is teaching the record-field path to reuse that shape per host WITHOUT the vtype-dropping
  scalar arm. Low urgency: exactly ONE corpus traversal has `by(__.project(…))`, and the common
  depth-1/non-correlated selections are already fenced.
- **A `by()` body over a LIST host — LANDED for element members.** `select(Pop.all).by(__.unfold().values(k).fold())`
  and `.by(__.unfold().count())`: the traverser is a COLLECTION, so `ChildHost` grew a `list` variant
  (`child.ts`, carrying the list value + its `ListOf`) and `scalarChild` a `listHostChild` arm. `unfold()`
  is the opener that CONSUMES the collection — `correlatedListMembers` (`list.ts`) explodes the host's
  list value into a CORRELATED member relation (no `input`, exactly as `membersOf` is), and an element
  list then re-enters `correlatedReduce` — the SAME engine an adjacency-rooted `by(__.out().values(k).fold())`
  uses, rooted at the members instead of a hop, so the trailing `values(k).fold()` / reducer and the
  empty-list seed rule are free. `hostSelf` gained the list identity arm (a bare `by()` over a list
  selection projects the collection). 🚧 What is LEFT: SCALAR/`typed`/`mixed`/nested-list and MAP members
  decline (fail closed) — their correlated re-entry is a later increment; and `select()` inside a list-host
  body (`by(__.select('a').unfold()…)`) is the other opener, not yet built.
- **`RowShape` — a per-row shape as a first-class row participant.** The row-algebraic ops are ONE engine
  now (`orderRows`, `rowOp`, `dedupOn` in `compiler/rel/lower.ts`), parameterised by what a shape owes it:
  the `by()` host, the deterministic tie-break, the IDENTITY columns, and whether that identity names the
  whole payload. The property stream was wired through it (`propertyRowShape`), which is what removed the
  fourth copy of `order()` rather than adding one. ⚠️ Two facts a new shape must supply and cannot guess,
  both per TYPE and both cited in `compiler/rel/property.ts`: **`GremlinValueComparator` dispatches the
  NATURAL ORDER per type** — a `VertexProperty` by id, an edge `Property` by KEY then VALUE, so an
  identity `by()` is a term LIST and not one expression (`naturalSort` exists for exactly that) — and
  **`ElementHelper` hashes an Element by id and a Property by key+value, ignoring the owning element**, so
  `g.V().bothE().properties().dedup()` collapses equal weights ACROSS edges. 🚧 What is LEFT: the SCALAR
  and RECORD tails still call `orderRows` from their own loops rather than declaring a `RowShape` (so
  neither gets `dedup`'s identity rule), and the MAP/LIST tails are not in it at all.
- **The property stream's remaining vocabulary.** Its row ops and its two filters
  (`hasKey`/`hasValue`, via `propertyHasClause` + `valueSet`) are in; 🚧 what is left is the `by()`
  vocabulary (`T.key`/`T.value` are absent from `TOKENS` in `modulator.ts`, so `order().by(T.key)` and
  `dedup().by(value)` decline), the `id()`/`label()` retypes off a property row (a `VertexProperty`'s
  `label()` IS its key), `where(<body>)` over a property host, and META-properties
  (`properties().properties()`, `has(k,v)` over a VertexProperty — a different row, deliberately not
  answered off this one).
- **The child seam consumer + `origin` naming a rowid-less parent.** `ChildSeam.rows`+`origin` EXISTS; the
  CONSUMER is what is left. **`flatMap`/`local` FAN-OUT bodies now consume it** (`flatMapRejoin`,
  `lower.ts`): a barrier-free body is TRANSPARENT (`flatMap(__.out())` is `out()`), so it mints `origin`,
  lowers the body, drops `origin` after — a downstream whole-row `dedup` must not distinguish rows by which
  host they descend from. The **per-origin SLICE has LANDED** (`partitionedSlice`): a trailing
  `limit`/`skip`/`range` inside the body is `n` per HOST — a `row_number() PARTITION BY origin` window,
  `dedupOn`'s shape, ordered by `encounter`+payload so the impl-defined "result should be OF … count N" pick
  is DETERMINISTIC and perturbation-stable (L3 +8; = Calcite `convertDistinctOn`). The **per-origin FOLD has
  LANDED** too, and NOT via `GROUP BY origin`: `local(__.out().fold())` is the SAME correlated shape as
  `local(__.out().count())`, so `scalarChild`'s movement-then-reducer arm accepts a `list`-framed tail and
  lands a correlated LIST subquery. The seed is FREE — `foldElements`/`foldScalars` already
  `COALESCE(json_group_array, '[]')`, so a sink's subquery over an empty body yields `[]` with no seed
  machinery. And because the body is ONE correlated subquery per host, a barrier INSIDE it (`order()`/`dedup()`
  before the fold) is scoped per-origin for FREE and correct (L3 +1). ✅ **A `coalesce`/`optional` ARM is now a
  consumer too** (`reductionArm`, `lower.ts`): a branch arm ending in a per-origin collapse
  (`coalesce(__.out().count(), __.constant(0))`, `coalesce(__.values(k).fold(), …)`) routes through the SAME
  `scalarChild` reduction — one row per host, so a `local`-style per-origin fold/count works as a branch arm
  AND carries the frozen fan-out position, composing under a downstream slice. `reductionHost`/`reductionTail`
  are the extracted host + payload projection shared with `perTraverserChild`. ⚠️ ONLY `coalesce`/`optional`
  (`FlatMapStep`/`AbstractStep`, per-traverser); `union`/`choose extends BranchStep` BATCH a reducer arm over
  the whole input (`element-branch-child.feature`, `[6,4]`), so their reducer arms are the arm-major lowering,
  NOT this. `coalesce-reduction-arm.feature`. 🚧 LEFT on this arm: a SEEDED reducer only (`count`/`fold`) — a
  non-seeded `max`/`sum` arm whose emptiness needs a `present` filter stays declined. ✅ **A `count` arm now
  MEETS a plain scalar** (`coalesce(__.out().count(), __.constant(0))`): `result:'count'` carries a
  `STATIC('long')` type and NO `vt` column, so `meetScalarArms` admits it (count→long, constant→int, a per-row
  tagged scalar; the count wins as a `long` since it seeds, the default is a dead fallback). A `result:'number'`
  reducer (`sum`/`mean`) is still refused there — its type rides on a `vt` column the meet's own `vtype` would
  contradict. ✅ **The SHAPE-AGNOSTIC tail over a variant stream landed** (`variantTail`, `lower.ts`): a mixed-shape
  merge (`union`/`choose`/`coalesce`/`optional` whose arms disagree on shape) composes with `count()`
  (`countTail` = `SUM(bulk)`), the SLICES (`sliceOp` — `limit`/`range`/`skip`), and a bare `dedup()` — a
  whole-PAYLOAD `Distinct` (`dedupOn` over `(vk, v, rid, list)`, the identity across every arm: an element by
  `(vk, rid)`, a scalar by `(vk, v)`, so a cross-arm equal scalar collapses and two shapes never collide).
  A slice reads the fan-out `encounter` the branch minted, so `union(…).limit(1)`/`.skip(1)` are deterministic
  under `test:perturbed` (the arm-order pin in `variant-rowops.feature`); `count()`/`dedup()` are order-free.
  🚧 LEFT: anything that reads a PAYLOAD MEMBER — `unfold()`, a member transform, a keyed/`by()` dedup —
  declines; a variant has no uniform member shape, so that is the variant-MEMBER vocabulary. 12+ `@Unsupported`
  scenarios across `variant-rowops`/`list-branch-child`/`nested-branch-arms`/`scalar-reentry` dropped their tag
  (verified, incl. `V()`-re-source arms `union(constant(x), __.V()).count()`). ✅ **`optional`
  now lowers** (`optionalArms`) as `coalesce(t, __.identity())` — an EMPTY-body fallback arm that `continueAs`
  restores as the input unchanged — so it inherits the reduction arm, the traverser-major slice key, and (a
  branch, so the `path` channel's `pad` merge already handles it) `optional(…).path()` at depth: the two nested
  `Optional.feature` path scenarios pass exactly (+2 L3). `optional` is now in `BRANCH_HOSTS`, so a `by()`/`local()`
  body may self-root it too. 🚧 LEFT: an element re-source arm (`optional(__.V())`). 🚧 What is
  LEFT of the fan-out multiplier,
  fail-closed today: a per-origin SCALAR-order path (`values(k).order().fold()` still declines — a scalar
  stream order in the correlated body), and the reductions with NO fold (`max(local)`/`mean(local)` after a
  scoped fold); the same machinery is what `group().by(k).by(__.out().fold()|limit(n)|order())` needs;
  `tail` (count-from-end); a **child-body-label ESCAPE**
  (`local(out().as('b')).select('a','b')` — the reference's 4 maps, currently declined not `[]`; the same
  @Unsupported feature as `map(out().as('a')).select('a')`); **path HIDING** through a fan-out
  (`flatMap(out().out()).path()` is `[v,end]`, `FlatMap.feature:56`); and `map`'s per-origin WINDOW (it takes
  the FIRST body result). Unlocks the group-scoped reducer (`count()` with a non-empty body — LANDED for the
  count arm — and a SCALAR
  host — the empty pool is PER-REDUCER and decides INNER vs LEFT: `CountGlobalStep` seeds 0 and keeps its
  key, `SumGlobalStep` does not; a scalar host needs `origin` to name a parent with no rowid) and
  `property(k, <traversal>)` writes. ⚠️ For `property(k,<traversal>)`, two values are provably ONE-ROW (the
  first increment); a multi-row value is a SEPARATE case (`applyAll`, `AddPropertyStep.java:105-199`): 0
  rows → NO mutation (never a NULL write); >1 under `single` → the guard-binding message *"Single-cardinality
  property requires exactly one value, but traversal produced N results"*; >1 under `list`/`set` → each
  written; the single-argument MAP form is a third case.
- **`flatten` / join-union transpose** (§4; Calcite `JoinUnionTransposeRule`). Decorrelation into the P1
  envelope; unlocks the unbounded repeat body whose UNION is not the top node (`repeat(__.bothE().inV())` —
  term is `project(join(union(…),…))`, and a projection over a compound needs a derived table). ⚠️ Must NOT
  be shortcut with a disjunctive single-arm join `ON (e.src=w.id OR e.tgt=w.id)`: it matches a SELF-LOOP
  once where `both()` must yield the vertex twice, and it fails SILENTLY.
- **Mint one deterministic window order over a whole fan-out.** Unlocks the UNORDERED bulked slice
  (`g.V().both().both().limit(2)` — `bulkSlice` has no position to accumulate along, so a collapse is
  refused in front of it) AND the demanded-order branch merge (below). Three demand levels, and the
  first two have LANDED:
  - **POSITIONLESS** (`!ctx.ordered`): a `union` over an ordered input, or with an arm-local
    `order()/limit()`, drops the spent order and merges (`dropEncounter`, `unionArms`) — correct
    because a union is unordered.
  - **COLLECT/write demand** (`ctx.ordered && !ctx.sliced`): a `fold`/`cap`/`group` needs a COLUMN to
    collect by but does not pin WHICH order — TinkerPop's own `BranchStep` emission order is
    impl-defined (`vendor/tinkerpop/gremlin-core/.../branch/BranchStep.java:120-152`) and no corpus
    scenario pins a branch fold's member order. `withFanoutOrder` (`lower.ts`) mints a whole-row
    `ROW_NUMBER` after the merge, general over every framing. (Calcite: a plain `Union` carries no
    collation — `RelMdCollation` guarantees order only for `EnumerableMergeUnion` — so the order is
    IMPOSED via a window, `SqlStdOperatorTable.ROW_NUMBER`.)
  - **SLICE demand** (`ctx.ordered && ctx.sliced`) — the TRAVERSER-major half LANDED (`mintTraverserMajor`,
    `sliceableBranch`). A positional `limit/range/skip/tail` reads the fan-out to pick a SUBSET, and
    `BranchStep.standardAlgorithm` pins it: barrier-free arms are TRAVERSER-major, arm-minor
    (`[parent position, arm_idx, arm_encounter]` — realised as the within-(parent,arm) PAYLOAD tie,
    which the slices, falling on traverser boundaries, never observe); `coalesce`/`optional`
    (`FlatMapStep`) are always traverser-major. The parent position rides each arm UNCHANGED through its
    hops as the `branchOrder` channel (already in the channel core: `identical` merge, `empty` barrier,
    `undefined` group), minted from the input's `encounter` (`augmentParent`) — which works where
    `origin`, a rowid, cannot (a scalar parent, and position ≠ id under `order().by(k)`) — plus a
    per-arm `arm_idx` `branchOrder` channel, re-minted into a fresh `encounter` after the ordinary
    `mergeArms` (element/scalar/list/map/variant merge unchanged; the key is orthogonal). Nine
    `branch-traverser-major`/`emission-order` scenarios pass. ✅ **ARM-major landed for the ALL-BATCHED case**
    (`batchedBranch`/`mintArmMajor`, `lower.ts`): a `union` where EVERY arm holds a barrier (`armBatches`) is
    run per arm over the WHOLE input — each arm was already `continueAs`'d as a GLOBAL reduction over the
    source, so the work is to UNION them ARM-major (`tagArm` + `renumber` over `[arm_idx, payload]`, the mirror
    of `mintTraverserMajor` with no parent key) with a real `Sort` for the bare-result wire order. Two facts
    made it tractable: the arms COLLAPSED (a barrier drops the per-row channels), so the merge base is the arms'
    OWN channels not the input's — which is exactly what made the per-row `mergeArms` refuse them (`[bulk]` vs
    `[]`); and the EMPTY-INPUT gate (`hasLabel('none').union(count,…)` is EMPTY not `[0,…]` — an option no start
    was routed to emits nothing) is an `Exists(input)` where `input` is the SHARED branch source, so `name` CTEs
    it with no replication. `union(__.count(), __.out('created').count())` → `[6,4]`, `union(__.min(),__.max())`
    → `[27,35]`, both deterministic under `test:perturbed` (`element-branch-child`/`scalar-reentry`, 4 tags
    dropped). ✅ **The MIXED batched/streaming case landed for SCALAR arms** (`mixedScalarBranch`/`toScalarArm`):
    a collapsed reduction beside a per-input arm (`union(__.min(), __.constant(99))` → `[27,99,99,99,99]`,
    `union(__.count(), __.values('age'))` → `[6, ages…]`) — each arm is normalized to a common `[v, vtype, bulk]`
    scalar (the batched arm gains `bulk = 1`, a `number` reduction's `vt` / a `count`'s `long` / a scalar's own
    type becomes the shared `vtype`), then handed to `batchedBranch`. ⚠️ The batching test is `isReductionArm`
    (a body holding a `selfCollapses` barrier), NARROWER than `armBatches` (any Barrier) on purpose: a SLICE arm
    (`union(out().limit(1), in())`) batches too but does not COLLAPSE, so it stays the ordinary merge — using
    `armBatches` here stopped two corpus reads executing (census caught it). ✅ **MIXED-SHAPE landed too**
    (`mixedBranch`): a collapsed scalar/list reduction beside a streaming ELEMENT arm merges as a VARIANT
    arm-major — `union(__.count(), __.out())` → `[1, v[vadas], v[lop], v[josh]]`, `union(__.values('name').fold(),
    __.out())` → `[l[marko], …]` — a scalar arm normalizes via `toScalarArm`, an element/list arm gains
    `bulk=1` (`ensureBulk`), then `mergeArms`' variant merge reconciles the shapes — including a LIST-of-ELEMENTS
    arm (`union(__.fold(), __.out())` → `[l[v[marko]], v[vadas], …]`): `variantPayload` now frames the folded
    list's members through the SAME `listPayloadExpr` expansion the non-variant list uses (rowids →
    `{id,label,props}` objects), where before it passed raw rowids and `rowVertex` threw on an undefined
    `props`. ✅ **The SINGLE-arm form LANDED** (`unionArms`/`sourceUnion`): `union(t)` IS `t` — `UnionStep`'s
    one branch takes every traverser — so a non-reduction single arm returns its own lowering (chain- and
    source-position), which is what makes `union(__.out().limit(2)).count()` the GLOBAL `2` rather than a
    per-origin `5` (`element-branch-child`, two tags dropped). A single REDUCTION arm still declines (it owes
    the arm-major `Exists(input)` gate a `Union` of one input cannot carry). 🚧 What is LEFT, each fail-closed:
    a variant with a MAP/RECORD/PATH/PROPERTY arm (no `vk`); a **batched `choose`** (a per-arm gate, not the
    shared-input one — see the census note); an **alias through a collapsed arm** (`union(min.as('x'),
    …).select('x')` — the barrier drops the label); a **NESTED** branch inside a sliced arm (a key STACK).
- **`recognize` — RETIRED.** "Fast paths as plan rewrites" landed as the `semijoin` physical tier
  (§4), not as an umbrella pass. The residual (a nested/param `containing()` taking generic `LIKE`) is
  a PERF tail on already-correct queries, gated on measurement — not a pass to build.

**Guard-binding family** — a shared mechanism (a GRAPH-dependent refusal → `Binding.guard`, §6·5):

- **Runtime / computed LABEL** (~6 writes). `ElementHelper.validateLabel` is three PURE predicates → a
  guard binding, not a decline. ⚠️ The message set depends on ARITY — `addV(single)` gives three `Label
  can not be …` messages; `addV(a, b)` IS a Collection and `AddVertexStep.resolveLabelCollection` raises
  FOUR others BEFORE `validateLabel`. 🔴 Settle the three-answer coercion HERE, don't add a fourth:
  `mergeV([(T.label): x])` coerces, `g.addV(x)` declines, `addLabel(x)` coerces — all reachable
  (`stringArgument : stringLiteral | variable`). `validateLabel` is TYPED upstream and coerces
  (`String(label)`), so the gap is a missing guard at the nine CALL SITES, raise per-site. ✅ The `- found:
  %s` tail names a GREMLIN type (`CanonicalType`), the tail only.
- **`T.id` on `mergeV`/`mergeE`** (5 writes). `elementIdGuard` exists; the `Insert` column plumbing does not.

**Parameter / repeat residue:**

- **Parameterised `times($x)` should PREFER the walk** (§9), where it stays a bind — unrolling forces the
  early parameter reduction the root `CLAUDE.md` names.
- **The unroll's admitted-body gate should be a DENY-list** of exactly `loops()`, a named `repeat('a',…)`,
  `emit()`, `until()` — the transform's validity is a property of `repeat`, not the body's step names. ⚠️
  Worth ~+10, but most bounded declines are blocked by steps the SPLICED chain still cannot lower (`select`,
  `local`, `group`, the map shape) — most of the repeat gap is the ordinary coverage gap in a `repeat` costume.
  ✅ Partially done by ADDITION rather than inversion: `simplePath()`/`cyclicPath()` joined `unrollableBodyStep`
  (they are pure path filters an unrolled phase reproduces exactly), which is the pattern — each step earns
  admission by an argument that its spliced phase is faithful, and the residual gate becomes a deny-list once
  every remaining body step has one. The path filters were the ones the SPLICED chain already lowers.

**Leaf gaps — one family, no downstream unlock:**

- ✅ **`simplePath()` / `cyclicPath()` — LANDED for BOTH the linear form AND inside the recursive walk.**
  `Path.isSimple()` is "no two path objects are equal"; the path is carried (`tracksPath`, seeded
  because a PATH_FAMILY step is present, extended at every hop) as a JSONB array of tagged entries
  (`{k,v[,t]}`), and equal objects produce the IDENTICAL entry (an element by rowid, a value by its
  `{v,t}`), so uniqueness is a correlated `COUNT(*) = COUNT(DISTINCT entry)` over `json_each(path)`
  (`pathSimplePredicate`), a filter that keeps the element framing. Verified row-for-row
  (`V(1).out('created').in('created').simplePath()` → josh,peter; `cyclicPath()` → marko).
  ✅ **The RECURSIVE form landed with the path channel through the walk** (`repeatWalk`, `compiler/rel/walk.ts`):
  the walk no longer declines a path-tracking input — the channel is seeded at the source, APPENDED per hop
  by the body's own movement (`extendPath`, so a multi-hop `outE().inV()` body records edge AND vertex
  positions), and `simplePath()` reads it in-body as an ordinary correlated filter (a nested SELECT the
  recursive-term barrier laws allow). The append (`Project`) and the filter both sit over a `both()` body's
  hop-union, and `distributeThroughUnion` (the generalized loops-bump transpose, Calcite
  `Project`/`FilterSetOpTransposeRule`) pushes them into the arms so each stays a single recursive reference.
  L3 +5 (`Unfold`/`Loops` incl. `loops()` in `until`/`Repeat` `outE_inV`).
  ✅ **The BOUNDED form landed too** — `simplePath()`/`cyclicPath()` are now `unrollableBodyStep`s
  (`ir/strategies.ts`), so `repeat(__.both().simplePath()).times(n)` splices the filter into a flat chain
  and lowers through the linear path machinery; splicing it TOP-LEVEL is also what makes `analyzeChain`
  track a path with no explicit `path()` tail (the pass runs before analyze). L3 +2
  (`SimplePath` `timesX3X_path`, and the `order()`-in-body `order_byXname_descX...timesX2X_path` — order
  composes through the per-phase splice, verified incl. ORDER).
  ✅ **The PATH-COMPOSITION family LANDED — combinatorial completeness (the corpus combines none of them):**
  a `by(<proj>)` compares each position by its projection (`pathSimpleByPredicate` — cycling `by()` ring,
  drop on unproductive, distinctness over projections; `cyclicPath().by('age')` → `[marko,marko]`, L3 +1);
  a BARRIER/retype after a path-carrying stream DROPS the spent path (`dropPath` — `count`/`fold`/unkeyed
  `group`/`dedup`/`select`; `simplePath().count()` counts what the filter kept) rather than declining; an
  UNBOUNDED in-body path step with no `path()` tail seeds the walk anyway (`repeatBodyTracksPath` in analyze
  scans repeat bodies); a JOIN-over-UNION recursive body composes (`distributeThroughUnion`'s join case,
  Calcite `JoinUnionTransposeRule` — `bothE().inV()` sharing the plain edge scan across arms); and a VALUE
  position mid-path is recorded (`appendValuePosition` — `values(k).path()` frames `[V,V,value]`, the
  `pathPositions` value arm reshaping `{k,v,t}`→`{t,v}` with no rejoin; L3 +2). 🚧 LEFT — `from`/`to`
  sub-path scoping (`simplePath().by(T.label).from('b').to('c')` — a `subPath` between alias positions,
  fail-closed today); `id`/`label`/`valueMap` value positions (channels:`[]`, no carry); `path().unfold()`
  over a MIXED element+value path (the `scalars` boundary — a list cannot yet hold an element member); and
  the ENCOUNTER-plus-path walk.
- ✅ **`all`/`any`/`none` over a SCALAR traverser is EMPTY — LANDED.** Their `filter` returns FALSE for a
  non-Iterable item (`vendor/tinkerpop/gremlin-core/.../filter/{All,Any,None}Step.java` — the `return false`
  after the `instanceof Iterable` block), so a value stream (`values('age').none(P.gt(32))`,
  `inject(7).all(P.eq(7))`, `inject(null).any(P.eq(null))`) drops WHOLE regardless of the predicate. The
  scalar tail now filters `CONSTANT.false` for a single-arg quantifier; the LIST form (`listMemberOp`, member
  testing) is unchanged. L3 +9. ✅ **The nested-traversal member predicate over a LIST also lands**
  (`inject([…]).none(P.eq(__.V(9999).values(k)))`): `memberPredicate` gained a `resolveScalar` hook built
  from the child seam's `rooted` read (a member list has no element host, so only the rooted arm applies —
  the cross-module twin of `nestedFirstValue`'s rooted branch, since `list.ts` cannot reach `lower.ts`).

- ✅ **Exact REAL → JSON — LANDED as ONE authority, `jsonMember`/`jsonMemberByTypeof` (`build.ts`).** Every
  scalar crossing INTO a `json_object`/`json_array`/`json_group_array` is now lossless at any depth: a
  binary64 rides as a 17-digit JSON number (lossy-only guard) and a wide integer as decimal TEXT (BigInt
  at the wire, generalizing `sumTower`'s exact tail to any blob). Routed through by `typedNode` (all `{t,v}`
  members), `foldScalars` (static/per-row/unknown), `byNode` (map keys/values — a computed scalar carries
  its static tag so a count key frames Long and a `math()` value keeps its digits), and `injectList`/
  `injectSource`. This unblocked group-scoped `mean` (`map/Mean.feature`, L3 +1) and fixed whole-number
  doubles (`1.0` was framing Int) and wide ints in folds. The four traps still hold and are encoded:
  (1) JSON-ENTRY not `storedValueOn` (the row path re-quotes); (2) gate on the TAG where there is one, and
  on `typeof(value)` ONLY for a materialized COLUMN (`jsonMemberByTypeof`) — never a subquery; (3) the
  lossy-only guard; (4) `json()` as the aggregate's direct argument. ⚠️ The `typeof` arm repairs a REAL
  only: a wide integer's TEXT needs a `long`/`bigint` tag the untyped path lacks, so an untyped wide int
  stays a magnitude-inferred number rather than a wrong-type String.
- **Set-op keeps its members' types** — `values('when').fold().merge(…)` returns raw millis. The lossy test
  must span BOTH sides; `withLossyFlag` asks it of one relation. ⚠️ Gating on the compile-time `typed` flag
  is a DIFFERENT question, measured wrong: `values('name').fold()` is `typed` while every member is bare at
  run time.
- **The `set` framing marker** survives `range(local)`/`all`/`any`/`none`, dropped only by
  `order(local)`/`unfold()` — a state-threading change through the list tail's follower loop. The
  THREADING is now in place: an arm that decides the marker returns it and `listTail` treats the field as
  authoritative-when-present, so `reverse()` unmaking a set (`ReverseStep` returns a `List`) is stated
  rather than inferred. 🚧 `order(local)` still does not drop it.
- **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type today) — needs head-position tracking on the RelIR `AliasEntry`.
- **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what
  `path().by(<transform>)` writes) — inert until tags join a comparison; a null tag means "infer from the
  value" everywhere else.
- ✅ **A GLOBAL string transform over a LIST is TinkerPop's type error, not a gap — LANDED.**
  `toUpper/toLower/trim/lTrim/rTrim/length/substring/replace` each have a `*GlobalStep` that throws
  `IllegalArgumentException` on a non-String receiver, and over a list the receiver IS the list
  (`vendor/tinkerpop/gremlin-core/.../map/{ToUpper,…,Replace}GlobalStep.java`). The shape is CERTAIN in
  the list vocabulary (§6·5), so `listMemberOp` raises the reference's verbatim
  `"The <step>() step can only take string as argument, encountered class java.util.ArrayList"` (a
  `ValueParseError` that PROPAGATES) rather than declining to a generic `UnsupportedTraversal`
  (`GLOBAL_STRING_THROWS`, `ir/step.ts`). Calcite's prior art is the LAYER, not the message: an
  operator over a wrong-typed operand raises at VALIDATION before any plan node
  (`vendor/calcite/core/.../sql/validate/SqlValidatorImpl.java`), which is exactly a compile-time raise
  ahead of SQL emission. `asString` is the ONE exclusion — `AsStringGlobalStep` stringifies any value
  (`"[1, 2]"`), a real answer.
- ✅ **The LOCAL `StringLocalStep` form over a non-string MEMBER is a runtime guard — LANDED, and it
  fixed a WRONG ANSWER.** `g.inject([1,2]).trim(Scope.local)` and `values('age').fold().trim(local)`
  were SILENTLY COERCING (`["1","2"]`) where `StringLocalStep.map` throws per member on a non-null
  non-string (`vendor/tinkerpop/gremlin-core/.../step/util/StringLocalStep.java:54-58`) — the §12
  "wrong answer with the right arity" class, banked in the census goldens. The member type here is
  per-row/unknown (never a static tag), so it can be neither a decline (that refuses the valid
  all-string `values('name').fold()`) nor a compile-time throw: it is a **runtime VALUE guard**
  (`localStringMemberGuard`, `list.ts`) — the §6·5 `Binding.guard` mechanism applied to `json_each`
  members instead of a graph row, raising iff a member's `memberTypeTag` is non-null and not `'string'`.
  Threaded through the ONE list-loop return that can carry a guard (`lower.ts`, on `effects` like a
  snapshot). The guard set is exactly `GLOBAL_STRING_THROWS` — `asString(local)` is NOT one
  (`AsStringLocalStep` stringifies each member; only a null member raises `Can't parse null as String.`,
  a different error not yet built). Message is the reference's verbatim to the corpus-checked prefix
  (the offending `<class>` is omitted — `Guard.valueColumn` appends, the reference spells it
  mid-sentence, no scenario checks past the prefix). L3 +3.
- ✅ **An illegal `range(low, high)` (`low > high`, both != -1) RAISES — LANDED.** `RangeGlobalStep`/
  `RangeLocalStep` throw `"Not a legal range: [low, high]"` in their CONSTRUCTOR
  (`vendor/tinkerpop/gremlin-core/.../step/filter/RangeGlobalStep.java:65-66`). `sliceOf` already
  computed the check; it now throws a `ValueParseError` (a propagating ANSWER, §6·5) instead of a plain
  `Error`, and the two `sliceOp`/`listMemberOp` catchers rethrow that class rather than swallowing it to
  a generic `UnsupportedTraversal`. Both scopes, though the corpus names only the global — one authority.
  L3 +2.
- **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy for the role) and
  `barrier(Barrier.normSack)`. Both honest.
- **Meta-property under an UNDECLARED cardinality** (2 writes) — the `set` arm PATCHES rather than inserts;
  needs an `UPDATE` this route does not emit.
- **`with()` on a write · singletons** (`addE` after `addE`, `addInE`; ~10 writes) — one reason each.
- **L4 sweep** — two committed expectations encoded a since-deleted implementation's bug; nobody has swept
  the rest.
- **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself; one commit.
- **`split()` (7 blockers) is DEFERRED BY DESIGN, not a leaf to build.** It is a Java-`StringUtil.split`
  string→list transform whose every arm diverges from SQL (whole-separator empty-token collapsing,
  char-split, whitespace-split), so its home is the Java-string-op semantics commitment in
  `docs/2026-08-12-regex-as-a-barrier-research.md` (a SQL-native `replace`/recursive-CTE form with a
  documented divergence, or the JS barrier), NOT a bespoke recursive-CTE reproduction of Commons. It
  fails closed correctly today. Do not build it ahead of that one decision.

Families still largely open (rank live via `rel-blockers`): the scalar-transform tail, branch (the
SOURCE-position `g.union(a, b)` and the option-keyed `choose(<projection>).option(k, arm)` where the
choice is a body rather than a `T` token — the arm-merging half is now ONE dispatcher over three builders
at both per-row shapes, `BRANCH_HOSTS`/`branchArms`, and a token choice is `tokenChoice`), row ops
(`Column`-keyed and the `path()` tails), aliases (`select`, dominated by `Pop.all`/`Pop.mixed` history
reads), side effects, then `local`, `match`, `where`, the `path` tails.

🚧 **The next callers, named because each is now a SINGLE missing caller rather than missing algebra** — the
pattern this whole stage kept finding:
- ✅ **`hasId(…)` — LANDED, and it was ENTIRELY unlowered (0 executing, 21 deferrals) despite the algebra
  existing.** `hasId` reads the element's EXTERNAL id (`COALESCE(uid,id)`), the same row `has(T.id,…)`
  does — so `sourceFilter` now routes it straight to `hasTokenClause('id',…)` with the id token supplied,
  and every predicate form composes for free: `hasId(1)`/`hasId([2,6])`/`hasId(1,2)` an id-membership
  `within` (the front end keeps a collection arg WHOLE with `.members`, exactly the single-collection
  operand `predicateExpr`'s `within` spreads), `hasId(P.gt(2))` a range, `hasId(P.eq(__.V(x).id()))` the
  nested-operand compare (composing with the resolveScalar work above), and
  `hasId(P.within([]))`/`hasId(P.without([]))`/`hasId(null)`/`hasId(P.eq(null))` the degenerate sets that
  fold to their truth value (`filter/HasId.feature` pins `within[]`→0, `without[]`→6, `null`→empty). Both
  vertex and edge. The param-bearing forms (`hasId(vid1)`) are the census's "unbound" set; L3 binds them.
- ✅ **a KEYED `dedup(k1,…,kn)[.by(proj)]` on the ELEMENT stream — LANDED, and it was PURELY a missing
  caller.** `dedupByLabels` (`lower.ts`, `DedupGlobalStep` with `dedupLabels`) was already built and wired
  into the RECORD tail (the post-`select` form); the PRE-`select` form (`g.V().as('a').both().as('b').dedup('a','b').by(T.label).select('a','b')`,
  `dedup('a','b').path().by('name')`) declined only because the element loop's `rowOp` rejects an
  args-bearing `dedup` and nothing called the helper where the live alias map is in scope. One `if` before
  the `rowOp` call reuses it verbatim: each label's `Pop.last` identity (rowid, or the shared `by()`
  projection) tuples into `dedupOn`'s ranked window, the survivor keeps its whole payload+path, and a
  non-live label or unproductive `by()` declines/drops per the reference. The representative is
  impl-defined ("should be of"), so the deterministic first-per-tuple is a valid member and the pinned
  COUNT (distinct tuples) is perturbation-invariant. L3 +3 (`filter/Dedup.feature`, `SubgraphStrategy.feature`).
  🚧 LEFT: a bare `dedup()` over a path-carrying element stream (still the `pathCarried` decline), and a
  `Scope.local` `dedup(labels)` over a fold.
- ✅ **a `select(<label>)` RE-ROOT in a child body — LANDED.** `selectRerootHost` (`lower.ts`) is the alias
  analogue of `rerootedHost`'s endpoint/owner reroots: a body leading with `select('a')` reads the label
  off the `HostRow`'s alias map (`aliasProjection`, `Scoping.getScopeValue` resolves a label off the
  traverser's scope) and CONTINUES against it — an element alias → an element host, a value alias → a scalar
  host carrying the label's per-row type. A list/Pop history and a record host (whose own MAP SCOPE answers
  `select` in `recordTail`, § `scopeValue`) decline, fail closed. One missing caller, not missing algebra:
  `byExpr`/`scalarChild` already dispatch a nested `by()`/`map`/`is`/`concat` body through `child.scalar`,
  so it composes at every host at once — `map(__.select('a').values('name'))`,
  `by(__.select('a').values('name'))` and `order().by(__.select('a')…)` over element AND scalar hosts (L3
  +2). ✅ **`concat(__.<traversal>)` now routes its operand through the seam too** — a nested operand is a
  correlated scalar (`scalarChild`) whose FIRST result is appended through the same `concat_ws` + all-null
  guard as the string form. A PROVABLY-PRODUCTIVE operand rides no extra machinery; a MAYBE-empty one no
  longer DECLINES — it now carries a runtime throw guard (`concatEmptyGuard`, §6·5) because
  `TraversalUtil.apply` THROWS on an empty sub-traversal where a correlated subquery would yield the null
  `concat_ws` silently skips. The guard runs the operand-`present` predicate over the surviving traversers
  and raises the reference's verbatim `'The provided traverser does not map to a value'` iff SOME row's
  operand produced nothing, so `concat(__.select('a').values('lang'))` over software SUCCEEDS ({lop,ripple}
  uses java) and a mixed stream RAISES rather than fabricating a short answer (`concat(__.select('a'))`,
  L3 +1; the maybe-empty form, +2). ✅ **A COMPARISON/`eq` predicate operand that is a nested traversal now resolves too**
  (`is(P.gt(__.V(x).values(k)))`, `has(k, P.eq(__.V(9999).values(k)))`, bare `is(__.V(9999)…)` =
  `is(P.eq(…))`): `predicateExpr`'s `resolveScalar` hook (shared with the within/without vararg member)
  returns the operand's FIRST value via `nestedFirstValue` — a ROOTED operand (`__.V(x)…`) as a scalar
  SUBQUERY over `rootedRead` (SQLite reads the first row = `tv.next()`), a CORRELATED one (`__.values(k)`)
  via the element-host `scalarChild`. The compare is DIRECT (`binary(cmp, subject, nested)`, not `ordered`'s
  vtype cast — a runtime operand has no compile-time type; SQLite's storage-class order matches
  `GremlinValueComparator` for the same-typed pairs the corpus makes). An unproductive operand is a NULL
  scalar and `subject <cmp> NULL` → not-true, which is the SCALAR predicate's empty-operand SHORT-CIRCUIT
  (`P.resolve` → `resolvedEmpty` → `test` false) for every op but `neq`, which declines (its `IS NOT 1`
  negation reads a NULL as true; no corpus pairs `neq` with a traversal). Wired at `has`/`is`/`where`. L3 +5.
  ✅ **Also wired into a `choose`/`where`/`filter` CONDITION** (`sourceFilter`'s `is`, `valuePredicate`) — so
  `choose(__.is(P.eq(__.V(9999).values(k))), …)` and `choose(__.is(P.gte(__.V().…mean())), …)` lower. That
  surfaced a latent `choose` bug and FIXED it: `ChooseStep` routes on the condition's PRODUCTIVITY (produced
  → then, else → else), and the else arm was `NOT pred`, which is NULL (row dropped from BOTH arms) when the
  condition is UNPRODUCTIVE — an absent value or an empty `V(9999)` operand. It is now `notProduced(pred)`
  (`pred IS NOT 1`), sending a false-OR-null condition to the else, identical to `NOT pred` wherever pred
  cannot be null (census: 0 changed answers, so no live `choose` had a nullable condition before). L3 +2.
  ✅ **the operand seam now carries the traverser's SCOPE — a `select`/alias or `sack` read as a comparison
  operand.** `nestedFirstValue` built its element child host with no `row`, so `scalarChild`'s select arm
  (`selectRerootHost`, which reads `host.row.aliases`) and the sack channel had nothing to resolve against;
  a `select`/`sack`-led operand therefore declined where a rooted `__.V(x)…` or a bare `__.values(k)` did
  not. Threading the alias map onto that host — the operand-seam twin of `selectRerootHost` in a
  `by()`/`map()` body — makes `has(k, P.gt(__.select('a').values(k)))` compare each traverser to its aliased
  START (`g.V().as('a').out().has('age', P.gt(__.select('a').values('age')))` keeps the neighbour older than
  the vertex it was reached from) and `has(k, P.gt(__.sack()))` compare against the sack. L3 +2; census +1
  newly executing (`withSack(29).V().has('age',P.gt(__.sack())).values('name')`, verified = `P.gt(29)`), 0
  changed. Pinned in `test/L4-addendum/predicate-operand-scope.feature`. 🚧 LEFT: the SCALAR-stream `is`/`where`
  callers still pass a null host (`values('age').is(P.gt(__.select('a')…))`); a multi-key `select` in a child
  body (a record); a `Pop` history select.
- ✅ **the FILTER seam now carries the alias scope — a `select`/`as`-variable reads in a predicate body.**
  `sourceFilter`/`childPredicate`/`bodyPredicate`/`valuePredicate`/`projectionProductive` folded every
  `where`/`filter`/`not`/`and`/`or` body with `NO_ALIASES`, so no filter body could read a label —
  where TinkerPop's `Scoping` consults the traverser's scope for a filter body exactly as for a
  projection. The map is threaded through the seam and `selectRerootSubject` reroots a `select`-led body
  to the aliased traverser (the predicate-seam twin of `selectRerootHost`). So
  `where(__.select('n').hasLabel('person'))`, the or/and-of-selects forms, and — via the `as`→`select`
  where-variable Pass rewrite — the `where(__.and(__.as('b').in(), __.not(__.as('a')…)))` start-variable
  family lower and answer (Where.feature). `correlatedExists` keeps `NO_ALIASES` on purpose: it folds
  over the CHILD relation, whose scope starts empty (an outer label persisting into a moved child body
  is a later, correlated-join phase). 🚧 LEFT: an alias read AFTER a movement inside a filter body
  (`where(__.out().select('n')…)`); a list/Pop history alias in a filter body.
- ✅ **a COMPOUND alias-compare `where(k, P)` over label identities.** `aliasWhere` accepted only a
  single binary `where(k1, P.op(k2))`; `WherePredicateStep` composes `eq`/`neq`/`and`/`or`/`not` over
  `selectKey` operands. `aliasIdentityPred` recurses the connective tree (the mirror of `predicateExpr`'s
  and/or/not), each leaf comparing the start alias's rowid against the operand label's — the no-`by()`
  IDENTITY form (`where('c', P.not(P.eq('a').or(P.eq('d'))))`, Where.feature).
- ✅ **the `by()`-value compound alias-where over the modulator RING — LANDED** (`aliasValueWhere`).
  `WherePredicateStep`'s `filter`/`setPredicateValues` project the startKey through `by[0]` once, then
  each predicate LEAF's operand label through the NEXT `by()` in encounter order, CYCLING (the
  `TraversalRing` resets per traverser; the `ConnectiveP` tree is walked left-to-right). The LHS is
  shared across leaves; a non-productive projection drops the row (an `IS NOT NULL` term per projection,
  a `ProductiveByStrategy` keep-null still declining). Verified row-for-row vs `Where.feature` including
  the CYCLED `d`→`by[0]` in `where('a', P.lt('b').or(P.gt('c')).and(P.neq('d'))).by('age').by('weight').by(min)`.
- ✅ **a bare `where(P)` alias-compare — the subject is the CURRENT traverser** (`where(P.neq('a'))`,
  `WherePredicateStep` with a null startKey uses `traverser.get()`). Handled over an element stream as an
  identity rowid compare (reusing `aliasIdentityPred`), GATED on the predicate naming a live label — else
  it is an ordinary value predicate and falls through to `sourceFilter`. Unblocks the `addE` co-developer
  write and the Grateful-Dead `where(P.eq('song'))` join.
- ✅ **`math()`/`format()` resolve a `withSideEffect()` CONSTANT variable** (`math('_ + x')` with
  `withSideEffect('x', 100)`). `Scoping.getScopeValue` consults the side-effects before the path labels;
  `sideEffectConst` inlines the seam's registered constant as a typed literal (zero binds).
- ✅ **a `within`/`without` operand may be a RUN-TIME folded list** (`P.within(__.V(x).out('knows').values(k).fold())`).
  `predicateExpr` gained a `resolveListSet` hook (the caller owns it — it holds the child seam); a single
  nested operand explodes the resolved set with json_each (`subject IN (SELECT sv FROM json_each(<list>))`).
  `foldedListSet` lowers the folded traversal as a rooted read (it re-sources → one fixed set correlated to
  nothing), takes its one `list` value as a scalar subquery, explodes it sole-from; a member compares raw
  (`Contains.within` is `.equals`, a scalar fold's members are bare). Wired at `is`/`where`/`has`.
  ✅ **The VARARG-traversal-member form now lowers too** (`within(__.values('nonexistent'), __.constant('marko'))`,
  `Has.feature`, L3 +2): unlike the fold, each operand is NOT rooted — `P.resolve(traverser)`
  (`vendor/tinkerpop/gremlin-core/.../P.java:328-373`) runs each child traversal against the CURRENT
  traverser and takes its FIRST result as ONE element, dropping an operand that produced nothing. So
  `predicateExpr` gained a `resolveScalar` hook alongside `resolveListSet`: a nested vararg operand resolves
  to the correlated first value via the element-host `scalarChild` (`varargScalar`), and the members build the
  ordinary `IN`-list — the operand's `values(k)` becomes a `SELECT … ORDER BY id LIMIT 1` correlated subquery
  (NULL when unproductive) and a `constant(v)` inlines. The NULL member is INERT in the `IN`/`NOT IN` idiom
  exactly as a literal null is, so "drop the non-producing operand" and "leave its NULL in the list" are the
  same answer (both `within`'s empty→no-match and `without`'s empty→match fall out). The single non-fold
  operand (`within(__.values(k))` = its one first value) falls through the fold check into the SAME path. 🚧 LEFT: a
  folded UNION operand (the source-`union` gap, fail closed); a vararg operand whose first result is itself a
  LIST/ELEMENT (a list-valued or element member no scenario names — declined by the scalar-framing gate).
- **the branch + filter families over the PROPERTY tail — LANDED.** `Subject` grew a third `property`
  variant (mirroring the `property` `ChildHost`), `branchSubject` answers the property framing, and
  `childHostOf` maps it — so `union`/`choose`/`coalesce` all fold their arm/condition bodies through a
  property host, and `where`/`filter`/`not`/`and`/`or` route through the SAME `sourceFilter` vocabulary
  (`SCALAR_FILTER_HOSTS`) and preserve the shape. `is` stays declined (a property has no single value).
  What is LEFT on this tail is `project`/`select`. ⚠️ `project(k…).by(…)` over a property is NOT just a
  missing caller: routing it through `recordOf` with the property host COMPILES and `select(field)` reads
  the field, but the record→map WIRE framer emits EMPTY maps (`[{}, …]`) — a wrong answer with the right
  arity. The record/map framer does not yet frame property-derived fields, so this needs framer work, not
  a one-line dispatch (verified 2026-08-13, reverted rather than shipping the mis-frame).
  **`constant` is now a SINGLE shared retype** (`constantRetype`) reached from every tail — element,
  scalar, list, property, map — rather than two copies plus three gaps.
  ✅ **`fold()`/collect after a `union`/`choose`/`coalesce` — LANDED** (`withFanoutOrder`,
  `g.V().coalesce(__.values('name'), __.constant('x')).fold()`): a COLLECT demand takes any
  deterministic fan-out order (see §10's mint bullet). The SLICE demand's TRAVERSER-major half also
  landed (barrier-free branches + `coalesce`); what is LEFT is the ARM-major / nested / scoped-fold-arm
  residue (see the SLICE bullet). Common pattern, real L3.
  ✅ **A branch arm may now END in a `project()` — RECORD-valued arms merge, agreeing or not.** Two
  rungs, and the second is the interesting one. (1) Arms whose records AGREE merge as records:
  `sameFraming` declined `record` outright ("nothing builds a record-valued branch arm yet"), and the gap
  was the equality, not a node — `RecordField.prefix` is POSITIONAL, so structurally-equal records already
  occupy the same columns and the positional `Union` merges them (`sameRecordFields`; `optional` is
  compared rather than merged, because `mergeArms` adopts the FIRST arm's framing and a wrong flag is a key
  present where `ifProductive` omits one). (2) Arms whose records DISAGREE demote to MAP values
  (`mapDemotedArms` → `recordToMap`): the fix is a NARROWER row, not a wider one — the fields collapse into
  the one `map` column whose entries are self-describing `{t,v}` nodes, so arms with entirely different key
  sets become two rows of one column. **That makes the same key able to hold a different TYPE per arm**
  (measured: `{v:29}` … `{v:'java'}`), which as columns is one column with two storage classes and is
  unrepresentable. Agreeing records deliberately do not demote — they keep their columns — and the
  demotion costs the COLUMN, not the reachability: `select(k)` still answers through the map's JSON member
  and correctly DROPS a row whose key is absent (`SelectStep.java:65-90`) instead of reading a sibling
  arm's value. Prior art both sides: Neo4j's GraphQL library emits exactly this per-branch map
  (`CALL { … WITH this0 { .id, __resolveType: "Child1" } AS this0 RETURN this0 AS this UNION … }`), and
  Calcite's `SetOp` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/SetOp.java`) requires
  the row-type agreement both rungs establish. Zero L3 (the corpus has no record-armed branch) —
  `test/compiler/record-branch-arms.exec.test.ts` is the coverage. `coalesce` came with it, via
  `ALWAYS_PRODUCTIVE_TERMINAL` gaining `project`/`valueMap`/`elementMap` — each a `ScalarMapStep` whose
  `processNextStart` splits unconditionally (`ScalarMapStep.java:38-40`), `select` deliberately NOT (it
  returns `EmptyTraverser`), which is what keeps that set a real distinction rather than "map-shaped steps".
  🚧 LEFT on this tail: a record arm against an ELEMENT/scalar/list arm (declines — `variantArmOf` has no
  `vk` for a record), and `local(__.project(…))`.
  ✅ **A `by()` arm may COLLECT the host's OWN rows — the self-rooted `fold()`.** Pure reachability, and
  the strange edge it left is the tell: `by(__.out().fold())` worked (movement-rooted) while
  `by(__.values(k).fold())` — the more ordinary Gremlin — declined. `correlatedReduce` has had a
  per-origin FOLD arm all along; the gate admitting a body to the SELF root named only the numeric
  reducers and `count`, so nothing reached it without a leading hop. `selfCollapses` adds `fold`, kept a
  LOCAL predicate rather than a widening of `COLLAPSING_BARRIERS` (same question, different purpose —
  that set also feeds `BATCHED_BARRIERS` and `repeat()`'s body-barrier reasoning, where `fold`'s
  membership is its own claim). Newly answering: `by(__.values(k).fold())` over a `Cardinality.list`
  property and **`by(__.labels().fold())` over a MULTI-LABEL vertex** — the multi-label read a GraphQL
  type-identity field needs. Empty is `FoldStep`'s seed both ways (an absent key and a zero-label vertex
  each give `[]`, never the `[null]` an outer join would). `labels()` emission order is the label
  dictionary id, the same pick `LabelStep` makes, so the first collected label and `label()` agree — now
  asserted so the two cannot drift into separate picks. `selfRootedReduce` extracts the one-row self-root
  source the branch arm and the barrier arm built identically. 🚧 LEFT: a bare `by(__.labels())` and
  `by(__.union(values,values))` — a fan-out body a `by()` must take the FIRST of
  (`TraversalUtil.produce` → `traversal.next()`), i.e. `yields: 'first'` for a fan-out, which is the
  expression arm's business; and `by(__.properties(k).fold())`, the property-member list.
  ⚠️ **A FILTERED mapping arm is not always productive — a measured WRONG ANSWER, and the set that caused
  it was two kinds conflated.** `ALWAYS_PRODUCTIVE_TERMINAL` is read from a body's LAST STEP ALONE, which
  is sound for a SEEDED terminal (`count`/`fold` emit however empty the input, so nothing before them can
  matter) and unsound for a MAPPING one (`constant`/`project`/`valueMap`/`elementMap` are `ScalarMapStep`s
  emitting one traverser per INCOMING traverser — they still need an input). So
  `coalesce(__.hasLabel('person').project(…), __.hasLabel('software').project(…))` declared arm 1
  always-firing, exhausted the coalesce, and returned only the person rows — the software vertices vanished.
  `constant` carried the same defect BEFORE the mapping terminals joined the set, and it would equally have
  let the filter-no-op Pass delete the filter in `where(__.hasLabel('person').constant(1))`. Fixed as
  `SEEDED_TERMINAL` vs `MAPPING_TERMINAL` (a mapping terminal qualifies only as the WHOLE body —
  conservative, because the precise rule wants `isStreamIdentity` and that module imports this one), plus an
  EXACT reduction in `childPredicate`: a trailing mapping terminal is transparent to the productivity
  QUESTION, so ask the prefix (`<prefix>.project(k)` produces exactly when `<prefix>` does). The second half
  is what makes this a capability gain rather than a new decline. **It is load-bearing for GraphQL:** a union
  field must lower to `coalesce`, not `union`, because GraphQL admits one concrete type per value while a
  vertex may bear several labels — measured on the zoo's overlapping `aquatic`/`endangered`, `union`
  duplicates tux and atlas under two type names (11 rows) where `coalesce` resolves each once (8).
  ✅ **`constant()` carries its DECLARED type.** It framed every plain literal `UNKNOWN` — inference at the
  wire for a type the front end had already parsed onto `Arg.type` — and inference reads the SQL storage
  class, which cannot see a LEXICAL distinction (and `constLit` narrows it further, inlining a boolean as
  INTEGER 1). Three silent wrong wire types, asserted on the TYPE BYTE because JS cannot tell an Int from a
  Long: `constant(30L)` framed INT, `constant(30.5f)` DOUBLE, `constant(true)` **INT 1 rather than BOOLEAN**.
  No framer work — a stored boolean already frames as GraphBinary BOOLEAN from an INTEGER column plus a
  `boolean` tag, so the route existed and the constant simply never named its type (§6·7).
- **the SCALAR and RECORD tails declaring a `RowShape`.** They call `orderRows` from their own loops, so
  neither gets `dedup`'s identity rule; the map and list tails are not in it at all.
- ✅ **a set op over an ELEMENT-member list — LANDED.** `listSetOp` admits an element-membered self+operand
  when both are the SAME kind, comparing by ROWID (`ElementHelper` hashes/equals an Element by id AND
  class, so a vertex rowid never equals an edge's), and the result keeps its element `of`. A cross-kind
  operand and element `product` decline (a mixed-element or bare-framed-rowid result the payload layer
  cannot carry). The corpus names only the ERROR forms (`combine(__.V())` — a non-folded stream is not
  iterable), so this is pure combinatorial completeness (0 L3).

✅ **The SLICE-demanded TRAVERSER-major merge LANDED** (`mintTraverserMajor`) — a barrier-free
`union`/`choose` and every `coalesce` present the reference's traverser-major subset via the
`branchOrder` parent-position carrier (see §10's mint bullet for the mechanism and the residue). What
still DECLINES, fail-closed: the ARM-major key (a union/choose with a batched-barrier arm), a NESTED
branch inside a sliced arm (needs a key stack), and a scoped-fold arm (its grouping empties the key).

⚠️ **Where a refusal is arithmetic over the INPUT's row count, a host that cannot count statically needs a
GUARD, not a decline.** `addV` proves single-row at COMPILE time (a literal `Values`); an `addE` mid-chain
input is a traverser relation, and nothing static separates `g.V(1)` from `g.V()`.

⚠️ **Invariants earned here — re-breaking each costs a wrong answer** (the rest are at their call sites):

- **A NULL never WINS a min/max and must never be FILTERED.** `NumberHelper.max/min` return the non-null
  side; over an all-null input they reduce to null and ONE null traverser is emitted. Nulls sort LAST, with
  an explicit `IS NULL` term (SQLite orders NULLs first ascending).
- **A map is a SCOPE, consulted BEFORE the path labels** (`Scoping.java:119-135`); `containsKey` is presence
  (an `EXISTS`), not "the value is not null". An unresolvable `select()` key is the EMPTY RESULT, not a
  decline (`Select.feature:578-596`).
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
it (Calcite's `fieldsUsed.isEmpty()`).

**Consulting the reference is the root `CLAUDE.md`'s rule, not repeated here.**
