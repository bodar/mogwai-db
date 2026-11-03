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
| **`fuse`** | ✅ wired in the read `lowered()` before `semijoin` (`src/rel/passes/fuse.ts`, `a4d38776`): transposes a Filter below a no-PARTITION `row_number` renumber Window when a whole-plan use-analysis shows the minted column is read only as an ORDER position (Calcite `FilterWindowTransposeRule` relaxed only for that case). Not run on the stream feeding a write (rf3-fuse-write, §10 Performance) |
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

Only what is OPEN. Landed work is deleted, not ticked: the code and `git log` are the record. Every item
states its REACH (`.claude/workflows/execute-workflow.js` RUBRIC). Work comes from the `.feature` corpus and
its one-step neighbours, from ordinary queries, and from L5 at realistic shapes. A reviewer-constructed shape is
not work. Rank by reach and by what an item UNLOCKS, not by L3 gain. Re-derive the live decline ranking with
`mise run rel-blockers`. Three worklists fail loudly when a shape lands: `test/rel-spine.test.ts` `DECLINED`,
`test/L4-addendum` `@Unsupported`, and L5 `LAW UNEVALUABLE`. IDs are stable. `(verify)` means the item may
already be fixed. A run appends ONE `### Next round` section, and folds it in at the end of the run.

The owner's 2026-11-03 cleanup (A1–F, cr-land-once, cr-fu1/2/6; E closed) is on trunk. Its specs are in
`git log` from `68db5644`. Do not relitigate it. A contrived shape gets a clean query-text decline or the simpler
natural answer, never machinery. A common or plausible shape keeps its correct answer.

### Needs a human decision

- **nr-b4-record-alias — accept the decline, or a required-fields provenance fact?** (parked 2026-11-03; no
  branch — not built). Owner's question, verbatim: "The plan rates nr-b4-record-alias '(1) Major, plausible
  reach', but on trunk `select('a','b').by('name').as('m').select('a')` and `….as('m').format('%{a}->%{b}')`
  answer. Only the self round trip `as('m').select('m').select('a')` and a local slice before select decline,
  cleanly. Accept the decline (contrived), or admit a required-fields provenance fact on record-born maps,
  which also kills nr-b4-dedup-absent-term's per-row term for records?" Prerequisite if admitted (a plan item
  ordered BEFORE nr-b4-record-alias): **record-required-fields** — a record-born map carries its required-field
  list as a PROVENANCE fact, dropped at every union/merge, never a lattice element (B4's no-MUST law holds), read
  by `mapTail`'s `select` and keyed `dedup`.
- **C4 — narrow the re-source-under-absent law to label-sourced absence?** (merged into Substrate 0's wording
  work; not urgent). Verbatim: "C4 declines a re-sourcing body over a VALUE-RUN host
  (`map(__.values('age')…by(__.V().count()))`). There, a missing property simply yields no traverser, which is
  ordinary filter semantics and not the baffling select('a').V() case, so a gated answer (4 rows) would be the
  natural one. Should C4's law be narrowed to label-sourced absence? Contrived reach, so it is not urgent."

- **Tier B — retire `PresentWhen`?** `PresentWhen` (`rel/child.ts`, the `{ when, orValue? }` arm of
  `Presence`) is the one way a child body says "I produced, and my value is NULL" (a PRODUCTIVE null). It has four
  remaining producers:
  - `aliasGuard` (`modulator.ts`);
  - `oneRowPresence`'s `EXISTS` (`lower/reduction.ts`);
  - `selectedNodeChild`'s `{t,v}` node test;
  - coalesce's `orValue`.

  About 33 lines read it, plus the `HostPresence` split.
  - **Retire it.** Presence becomes `'always' | 'value-nullness' | 'unknown'`, and a productive null in a CHILD
    body reads as absent. This needs one §17 line generalising "A null `by()` value" and "A re-sourced body's
    null first value". It deletes the arm, `statedPresence`, `orValue`, `HostPresence` and the per-row
    `EXISTS`/node tests. The cost: a dropped null traverser changes a COUNT.
  - **Keep it.** Then build a binding-presence substrate scoped to these witnesses. Each is a chain-vs-child
    inconsistency:
    - **r4-fu4 / rf3-project-null-label**: `project()` drops a productive-null `by()` entry
      (`ProjectStep.java:66`).
    - **S9.9**: a null Map entry is dropped under map/local/flatMap/choose.
    - **rf3-static-null-is**: `inject(null,1).map(__.is(P.neq(1)))` gives `[]`, but the chain gives `[null]`.
    - A branch-bound null label: `…select('v').map(__.select('k'))` gives `[]`, ref `[null,null]`.
    - A re-sourced productive-null arm inside `choose`.
    - Stated-presence `by()` inside local/map/optional.
    - F14b: `aliasGuard`'s presence spelling.

  None of these was reported by a user. Owner to choose.

### Contrived — build only on a user report

Real gaps in shapes nobody has been seen to write. Do not schedule them. If a user reports one, build the generic
fix.

- **r7-fu4** `inject([a:3],[a:null]).unfold().group().by(keys).by(select(values).fold())` gives `{a:[null]}`,
  ref `{a:[3,null]}`.
- **rf3-where-armlabel-json** A bare `Error: malformed JSON` reaches the user from `where(__.select('k').toUpper()
  .is('AB'))` over a string label bound in nested `choose` arms (`lower/filter.ts`).
- **cr-fu11** A `project()` key equal to a live label declines:
  `g.V().as('name').project('name','age').by('name').by('age').select('name')`. A lift must return the ENTRY
  (`Scoping.java:119-121`).
- **Wide longs** `sum/min/mean` drop a wide constant over a varying stream, and a top-level sum past 2^53 rounds:
  `local(union(constant(9007199254740993L), values('age')).sum())`.

### Substrate — in unlock order

1. **`once` consumers.** Route every re-inliner through `once()` (`rel/build.ts`). It is semantics-free: it must
   not bring back a Map probe or `landedOnce`. Reach: common. CLAUDE.md requires that "an expression referenced
   N times is computed ONCE". In order:
   - **nr-once-twins**: `predicate.ts` `storedCompareOnce` (~:551) → `once([subject, vtype], …)` (nr-ru1), and
     `valueTheta` (~:692) → `once([lhs.value, lhs.tag ?? …, …], …)` (nr-ru2), dropping its NULL arm on non-null
     types (r5-fu5). Both private `cheap` tests go. Reach: every correlated `where()`/`has()` comparison.
   - **rf3-is-chain-size**: a chain of value-run `is()` re-inlines its input per `CASE`. Four `is()` emit 1.52 MB,
     over the DO 100 KB cap, so it fails only in production. Pin it under `CfLimitedSql`.
   - The modulator's `projectionOf`/`typedOf`, whose `by()` value is spelled per gate.
   - **r6-s9-4** groupCount re-reads `json_each` 15×/row and `order` 12×/row. **S9.8** `json_each` 3–5×/row in
     the child seam. **r5-fu2** alias operand projected once at `as()` (1.8×). **r6-m-orderby**
     `order().by(<may-be-empty>)` emits the body twice. **r6-s9-6** a record field round-trips `{t,v}` (3.3×).
   - The math label-variable history fold, spelled 3× inside the VALUES row (~3.2 KB).
2. **per-row-node-vocabulary-closed.** Every shape a per-row scalar stream may carry gets a `{t,v}` node and a
   framing arm. A Map.Entry is `{t:'entry', v:[[k,v]]}`, framed like `execute.ts` `mapEntry` (`Column.java:46-63`).
   An element node carries its id. A follower that cannot read an arm raises the reference's error via
   `src/rel/raise.ts`. It unblocks **per-row-unfold-entry-node**: `g.V().values('m').unfold()` and `format()` over
   a per-row maybe-Map scalar both decline today.
3. **S3 — a write inside a child or multi-arm body** (local/map/flatMap/union/coalesce/optional/choose/repeat/
   sideEffect/where, onMatch). Reach: common. Witnesses: the `fold().coalesce(unfold(), addV(…))` upsert idiom,
   `g.V().local(__.mergeV([name:'x']))`, and the corpus's `coalesce(E()…, addE(…))` and
   `mergeV(…).option(onMatch, sideEffect(properties('age').drop()).select('m'))` (r6-m-oncreate). After it:
   merges in sideEffect/map/flatMap/coalesce/optional/choose arms, writes after path/fold/sack, and source-union
   starter-arm writes.
4. **G — thread alias channels through `childSeam`** (`rel/child.ts`): carry label scope into nested arms.
   Corpus: the aliases family has 10 open scenarios.
5. **H — one table per row-changing reference strategy** in `ir/`, citing vendor lines (the `bulk.ts` pattern).
   Never one for a strategy that only changes execution order.
6. **Map shape** (corpus: 9 open): map-valued `g.union(select('map'),…)` source, seeded `fold([:], addAll)`,
   merge map operand, T-token key.
7. **List members** (corpus): `fold().as('m').mergeV(select('m').limit(local,1).unfold())`; `is(P)`/`order()`
   inside a correlated list-member body (a bind-budget design call); `order`/`range(local)` over list-of-maps,
   PROPERTY and MIXED member lists; `select()` in a list-host body.
8. **Fan-out**: per-origin scalar order (`project().by(values(k).order().fold())`), reductions without fold,
   scalar-host group reducer, `tail`, child-label escape, `map` first-result window.
9. **Branch / slice** (corpus: 10 open): MAP/RECORD/PATH/PROPERTY variant arm, batched `choose`, alias through a
   collapsed arm, nested branch in a sliced arm.

### Wrong answers on trunk

- **rf3-reuse1** WRONG-ELEMENT WRITE — RANK FIRST. Write-path vertex-id lookups bypass `idMembership`'s per-id
  clause. Affected sites in `write.ts`: `endpointRowid`, the map-valued mergeE `endpointRowid.byColumn` (`id = v`
  with no uid check), and `withPreChecks`. Witness: a store with `addV('a').property(T.id,'x')` (rowid 1) plus
  `addV('b')`. Then `g.mergeE([(T.label):'k',(OUT):1,(IN):2])` writes an edge from `'x'`, although `g.V(1)` is
  `[]` (ref: "Vertex does not exist for mergeE"). Fix: export `externalIdIs(idCol, uidCol, v)` from `rowidOnly`;
  it costs one `uid IS NULL` on a row the seek already fetched. Leave `elementIdGuard` alone.
- **nr-fu-null-dup-create** WRONG COUNT OF CREATED ELEMENTS. Reach: plausible (a batch with a duplicate row and
  a null optional field). `g.inject([name:'a',age:null],[name:'a',age:null]).mergeV().id()` gives `[7,7]` and
  creates ONE vertex; mergeE with `[…,w:null]`×2 gives `[13,13]`. The reference creates TWO: the second
  driver's search is `has('age', null)` (`MergeElementStep.searchVertices` → `HasContainer.test`, which needs a
  present property) and a null is never stored (`ElementHelper.attachProperties`, `ElementHelper.java:348-352`),
  so it cannot match the first creation. Our own separate-query search already agrees (two runs of
  `g.mergeV([name:'a',age:null])` give 7 then 8); only the in-traversal `createKey`/`mapCouldMatch` collapse in
  `rel/write.ts` disagrees. Fix: a driver map holding a null entry never collapses with another (its search can
  match no element it created). Predates 5fbebe54; that commit made it visible.
- **rf3-bulk-remap-replace** `{idPolicy:'remap', onCollision:'replace'}`: `resolveReplace` ignores `idPolicy`,
  so `V(1)` lands as rowid 1 with uid NULL (a wrong element id). `src/bulk.ts`.
- **rf3-bulk-dup-uid** `loadBulk` APPEND with one uid twice in ONE batch surfaces SQLite's raw "UNIQUE constraint
  failed". Add an in-batch check keyed like `dedupeByKey` (`toWellFormed`) with the named-remedy error, and test
  the two-spellings case.
- **cr-fu14** `g.V().project('n','m').by('name').by(values('m')).select('m')` over a Map-valued property leaks
  `TypeError: pairs.flatMap is not a function` (`src/execute.ts:226`). Also wrong:
  - `g.inject([x:1,y:2],[y:2,x:1]).dedup().count()` gives 2, ref 1 (Map identity, `docs/outstanding-work.md` §1);
  - a `group()` nested in `local()` is not reached by ProductiveByStrategy.
- **rf3-fed-barrier** (+r7-fu7) federate `noParents()` decides the zero-parent answer from the LAST pushed step
  only. With parents, a pushed global barrier runs the sibling once, not per parent. With
  `h = g.V().has('name','nobody').call('federate',['graph':'crew'])`:
  - `h.V().count()` gives `[]`, ref `[0]`;
  - `.fold()` gives `[]`, ref `[[]]`;
  - with parents, `…V().count()` gives `[6]`, ref `[12]`;
  - the per-parent mapValues injection is super-linear.

  Fix by stopping `pushableTailPrefix` at the first global barrier in MID form, or by lowering the pushed prefix
  over an EMPTY relation for the seed (`ReducingBarrierStep.java:143-148`). Pin it in `test/federation.test.ts`.

### Performance — measured super-linear (N≈1k → 8k), or over a production cap

- **cr-fu5 + per-origin slice** A re-source over an origin-INDEPENDENT candidate set is quadratic.
  - `project().by(__.V().hasLabel('product').sample(3)…fold())`-style draws: `local(__.V().hasLabel('person')
    .sample(2)).count()` goes 281 ms → 19.6 s (70×), because `rankPairs` crosses origins × candidates.
  - `local(__.V().hasLabel('person').limit(2)).count()` goes 355 ms → 24.6 s (69×).

  `sample(1)` is linear. Fix: `rootedRead` the origin-independent prefix once, and cross the origins with its
  small result. Add a scale pin on the origins×candidates axis. Fix the `rankPairs` doc: the CTE is not
  `MATERIALIZED`, so "FENCED" overclaims.
- **Shared collection re-read per traverser** `g.V().group('a').by(constant('a')).by('age').select('a')
  .select('a').count()` goes 57 ms → 3.4 s (59×). Read the key once as one MATERIALIZED relation and cross-join
  it.
- **rf3-fuse-write** (+r4-fu0) `fuse` runs only in the read `lowered()`. A write fed by
  `order().by(…).V().has(…)`, or a write-body `V()` re-source's label filter, still renumbers holders×V before
  filtering.
- **r7-fu3 remains** (+r6-fu1's remainder) A correlated-value property seek in `rel/passes/semijoin.ts`: a
  narrowing `element.id IN (owner seek)` conjunct for `V().has(k, select(label))`, with the pass entering
  correlated subplans via `rewriteRels` (55× for 64× rows). Pins for uid/`E('…')`/multi-conjunct go in
  `test/plan-stability.test.ts`. The parked attempt failed on four things, so avoid each:
  - a string id `V('u0')` not treated as a bound (61×);
  - a shared `EXISTS` hoisting a CTE over the whole property table;
  - a constant seek that must outrank a correlated one (45×);
  - `mapValueElem` throwing a bare Error.
- **r6-fu6 / S10-r** Multi-driver batch `mergeV` merge guard over shared key-name pools: two pools 19× (~N^1.5).
  Needs a generic multi-key `OwnerSeek` (`semijoin.ts`, `write.ts` mapDrivers).
- **r7-fu9** A K-entry map driver `inject([k0:0,…]).mergeV()` is 55× (`json_extract` re-reads per entry). A
  child seek does not reach a `fold()` reducer (68×). `hasLabel` after an equi-joined hop in a re-source is 16×
  for 4×.
- **r4-perf1** Mid-traversal `V().has` with no seek in a READ: 813 ms → 44.6 s.
- **r6-reuse4** The scalar member node is rebuilt per one-row producer:
  `project().by(outE().values('weight').sum())` reads the edges 2× per host row (`max`: 3×).
- **S11** A body-may-yield-NULL fact, so the M3 removal machinery is skipped (it costs +13–75% today).

### Writes

- **o-seqguard** A DATA-SIZE REFUSAL, verified: `sequentialGuard` (`rel/write.ts`) emits `count(*) > 1` guards
  that raise at run time. Witnesses:
  - `…V().values('name').mergeV(__.select('k')).option(Merge.onMatch, __.select('j'))` raises over 6 traversers
    and answers over 1, with a constant, idempotent onMatch;
  - `mergeV([name:'zz']).option(onMatch,[age:1])` raises the same way;
  - label-only multi-driver `mergeV` with different labels declines (r7-fu11).

  Each must answer: the write sees a SNAPSHOT of its input.
- **nr-fu-token-keys** Reach: common (label plus key is the usual upsert map). `literalKeyFacts`
  (`rel/framing.ts`) gives up on any non-string key, so a Map driver holding `T.label`/`Direction` has UNKNOWN
  keys: `mapSearchedKeys` returns null (the one-at-a-time guard refuses any onMatch/`property()` write) and
  `mayHold` is always true (a side-effect `select(k)` arm declines `merge-map-scope` though no map can hold
  `k`). Witnesses: `g.inject([(T.label):'person',name:'marko'],[(T.label):'person',name:'vadas']).mergeV()
  .option(Merge.onMatch,[seen:true])` declines "write to a key a per-traverser search reads";
  `g.withSideEffect('upd',[w:1.0]).inject([(T.label):'knows',(Direction.OUT):1,(Direction.IN):2]).mergeE()
  .option(Merge.onMatch, __.select('upd'))` declines while the literal `mergeE([...])` form answers 1.0. Fix:
  record the STRING keys beside the token keys; a string `select(k)`/`has(k)` never hits a token key
  (`Scoping.java:119-121`, `Map.containsKey`). This makes the edge half of nr-fu2 real.
- **nr-fu-onmatch-scope** LATENT WRONG ANSWER behind a decline. `mergeMaps` (`ir/write-args.ts` ~:783) resolves
  every option arm with the Map as its traverser, but the reference re-points an onMatch arm at the MATCHED
  ELEMENT first (`MergeVertexStep.java:100`, `MergeEdgeStep.java:279`: `traverser.set(v)` before
  `materializeMap`); only onCreate and the main argument see the Map. Today
  `g.withSideEffect('age',[seen:true]).inject([name:'marko',age:29]).mergeV().option(Merge.onMatch,
  __.select('age'))` declines with an untrue reason (the reference reads the side effect and sets seen=true). If
  `merge-own-entry` is ever filled through this seam, onMatch would read the Map's own entry — a wrong answer.
  Fix: pass `'notMap'` for onMatch arms. Build BEFORE R8-res.
- **R8-res** Record and `inject(map)` drivers with `select('k')` decline until `mergeFromTraversal` takes them.
  This includes the batch-upsert idiom `inject([lookup:…, create:…]).mergeV(__.select('lookup'))` and
  `unfold().mergeV(__.select('match'))`, a Map driver's OWN entry.
- **o-prop-trav** `property(k, <traversal>)`: the guard can fire after an earlier write, and
  `mergeArmValueWrite` takes `limit 1` scan order and stores null.
- **o-meta-undeclared** A meta-property under undeclared cardinality patches instead of inserting.
- **singleSource over rowBounds** (+nr-ru5) Re-express `write.ts` `singleSource`, and the addV(T.id) one-row
  admission (~:3027 → `!atMostOneRow(input)`), as `rowBounds` questions (`src/rel/bounds.ts`). It lifts
  `g.V(1).addV().property(T.id,99)`. The source addV id-collision guard must then cover the mid-chain path.
  `writeSnapshot` stays Values-only.

### Declines to lift

- **nr-b4-record-alias** PARKED on the owner question under "Needs a human decision"; if admitted, build
  `record-required-fields` first (+nr-b4-dedup-absent-term). A `select('a','b')`/`match()` record re-entered
  as a Map declines `select(k)` of its own field. Witnesses, all answering at `020fecdf`:
  - `…select('a','b').by('name').as('m').select('m').select('a')`;
  - `….format('%{a}->%{b}')`;
  - `…limit(local,2).select('a')`;
  - `…tail(local,1).select('b')`.

  Fix: a record collapse resolves `select(field)` against its REQUIRED fields before re-entering `mapTail`.
  Every field of a `select(k…).by()` record is required. Add no MUST set to `MapKeyFacts`. The same fact drops
  `mapTail`'s per-row `absent` test for records. Fix the stale recordTail comment and the §17 "Map scope" wording.
- **cr-fu10** (B1) `g.V().has('name','marko').values('m').math('k + a')` over a Map's OWN keys declines; trunk
  answered `[3]`. Keep the map-entry read when no scope beyond the Map names the variable
  (`Scoping.java:119-135`).
- **cr-fu12** (B2) Side-effect constant reads decline although the chain answers. Forms:
  - `project(...).by(__.select('k'))`, `group().by(__.select('k'))`, `order().by(__.select('k'))`;
  - `sideEffect(__.select('k'))`;
  - a null constant under `map`/`where`.

  The by()/project seam does not route to `sideEffectSelectChild`. Add L4 coverage for the answering forms.
- **inject-label-addV** `g.inject(1,2,3).as('i').addV('person').property('age', __.select('i'))` declines.
- **rf3-fed-explicit-params** An explicit federate `traversal` referencing an outer user parameter declines
  ("Unbound parameter"). Forward `boundParams` in both forms (`src/services/catalog/federate.ts`).
- **Labels and scope**:
  - r2-gap-wb: `where().by()` under repeat labels/wrappers/`P.within`/bodies, including `not(where…by)` (answer 6);
  - r2-gap-F6: repeat `until`/`emit` and shortestPath see no aliases
    (`g.V().as('a').repeat(out()).until(where(eq('a')))`);
  - r5-fu8: alias-where under within/between/TextP.
- **Source union** (corpus): nested union first step, mixed arms, withSideEffect/withSack,
  `union(constant('x')).path()`, steps after it. r1101-fu4: `opensOffStarter` and `unionArms` disagree.
- **Path / property streams** (corpus): o-subpath `dedup()` before `path().from()`; o-pathvals
  `id`/`label`/`valueMap` positions and mixed `path().unfold()`; o-propstream `where(<body>)` over a property
  host, meta-properties.
- **Values** (corpus): o-setop-types set ops lose member types; o-set-framing `order(local)` keeps the `set`
  marker; o-order-elemlist global `order()` over element lists; o-split local split; o-sack merge seed and
  `normSack`; r6-fu2-r inject list/set residue (`g.inject({1,1})`).
- **Depth gaps**:
  - Column/multi-key select inside arms (corpus `path().select(Column.keys)`);
  - `values('m').select(k)` over a Map-capable scalar;
  - federate tails beyond values/count/order;
  - mid-traversal `inject(xs)`;
  - `project().by()` after an `emit().repeat(…simplePath())` walk.
- **Families** (rank by `rel-blockers`): scalar-transform tail, body-keyed `choose`
  (`choose(values('name')).option(is('marko'),…)`), Column/path row ops, `Pop.all/mixed`, side effects
  (`group('m').by().by(__.in().values())`), local/match/where. Also the single-missing-caller list.

### Hygiene, docs and missing pins

- **cr-fu8** (C2):
  - fix the stale `dedupBy`/`keptDedup` comments (`lower/slice.ts`);
  - `productivityFilter(step, key, key.raw ?? key.value)` → `key.value`; it takes only a projection (r3-fu4);
  - pin `compilerNull()` and the `aliasGuard` witnesses;
  - fix `group-value-null-member.feature`'s ProductiveByStrategy scenario to `order().by(label).by('name')`
    (`{x:27}`).
- **cr-fu13** (D) `UNCOMPARABLE_LITERAL` names the step and suggests the intent, through the Substrate 0 reason.
  The two `@Unsupported` pins in `merge-oncreate-overrides-runtime-map.feature` assert it. `validateNoOverrides`
  stringifies every JS Map as `"{}"`. Do NOT grow the peephole.
- **cr-fu15** `ONCE_FILTER_HOSTS` (`lower/reduction.ts:1739`) is a fourth spelling of the per-traverser
  filter-host set, beside `COLLAPSE_FILTERS`, `SHAPE_PRESERVING` and `EXISTENCE_FILTER_HOSTS`. Make one authority,
  or comment why it differs. Also ≈10 hand-rolled `V||E` re-source tests.
- **rf3-callsite-form** `barrierIn`'s `form = at === 0 ? 'source' : 'mid'` mislabels a federate call in an arm
  (`rel/segment.ts`).
- **rf3-ci-port** `test/cf-constructs.test.ts` binds fixed port 8977; take an ephemeral port.
- **rf3-pins** Replace the vacuous "hasId after a hop adds no scan" pin (`test/plan-stability.test.ts`) with the
  uncorrelated `IN (SELECT id FROM nodes WHERE …)` shape.
- **once naming** Rename `rel/build.ts` `once` to `heldOnce`/`evaluateOnce`: `refs.ts once` resolves to
  `emit.ts`'s locals, which fails "can it be confused?". Pin the math chain's exponential→linear win:
  `g.V().values('age').as('a').math('a+1').as('b').math('a+b').as('c').math('a+b+c')` → `[118,110,130,142]` at
  ~15 KB, plus the re-bound `as('a').math('a+1').as('a')…` → `[33,31,36,39]`.
- **Delete `ContentDemand.keys`** (`ir/content-demand.ts`). It is unconsumed, and `literalKeysOf` takes the label
  of a 3-arg `has` as its key.
- **Docs**:
  - the C3 §17 line: name `not()`, the `order()` route, the seats it covers, and that the concat raise is not
    Java's;
  - `docs/outstanding-work.md` §4: draw-independent bodies DECLINE;
  - the r7-m §17 lines for NUL and surrogates.
- **Single items**:
  - r4-fu6: trace the `valueMap` sql-hygiene raise (75→82);
  - r7-m: `perRowCollectionStep` re-parses JSON per row;
  - r6-m-s8: `rowBounds` is too wide over `rn=1`/HAVING;
  - r6-m-federate-types: param types are dropped by CF federation (verify);
  - r5-fu6: derive `declaredTypeOf` from `valueNodeOf`;
  - R15: pin the `withSideEffect` number class;
  - F8: make `rankedFirst`'s key total (add `vt`);
  - F11: `refReads` stops at a Ref;
  - r7-fu10: one JS→JSON encoder for a literal list (`constantListBlob`);
  - o-plansize: `byNode` nests its CASE;
  - o-l4-sweep: stale L4 expectations;
  - r4-fu8c: `properties().drop()` via `removeRows`;
  - r4-fu8d: `effectScope` snapshots leak into later statements' WITH (verify).

### Reuse proposals (each deletes code or turns a plausible decline into an answer)

- **rf3-idquery-dup** `idQueryOf`'s `routable`/`listAmongSeveral` (`lower/filter.ts`) re-derive `idMembership`
  and already drift. Classify the predicate only, and let `idMembership` judge the operands. Fix the refuted
  "`V(1,[2,3]) ≡ V(1,2,3)`" doc (`GraphTraversalTest.java:146-147`).
- **rf3-reuse3** Extract `idArgMembers(args)` from `idMembership` for `BoundGraph.elementScan`/`inlineNames`
  (`rel/boundgraph.ts`). This fixes a federate subgraph's `V(2,[3,4])`, which gives `[josh,lop,vadas]`, ref
  `[vadas]`.
- **rf3-reuse2** One `jsonMembers(values)` helper for ~10 hand-rolled `json_each` membership subqueries
  (`bulk.ts`, `setwrite.ts`, `formats/drain.ts`). Three of them use bare `JSON.stringify` on USER strings
  (`olap/kernel.ts:84`, `olap/pagerank.ts:76`, `manager.ts:81`), so a lone-surrogate label matches nothing.
- **rf3-reuse4** Fold `semijoin.ts` `retarget` and `write.ts` `reScope` into `walk.ts` `substRelId`. Make one
  `colsRead(e, rel)` for fuse/prune/semijoin/walk's five column walkers.
- **rf3-reuse5** `olap/pagerank.ts:72` routes seeds by `rows.length`; route by the call's form instead.
- **cr-fu3** Spell a scalar side-effect constant at the child seam with `constLit`, not a per-reference `{t,v}`
  decode. `where(__.select('k').is(5))` emits a ~1 KB CASE tower today.
- **cr-reuse4** Derive `group()`'s `mayYieldNull` from `producedMemberNode`'s member gate. That drops the
  null-first sort term for fold/list/map/element bodies (check `test/L2-sql/group.sql.test.ts`).
- **cr-reuse5** Add a chain-aware `firstInChainsDeep` (`ir/walk.ts`) and `someNode(value, pred)` for
  `uncarriedLiteral`/`uncomparableLiteral`/`holdsNaN`.
- **nr-ru3** One owned one-row relation builder: move `lower.ts` `oneRow` to `build.ts` and add
  `rowOf(cells, names, fresh)`, which `once()` uses. That deletes five hand-rolled `VALUES(1)` units, and absorbs
  r1-reuse4 `unitRow` and r6-reuse5 `oneRowValues`.
- **Smaller consolidations**:
  - `firstPerPartition` for five `row_number` hand-rolls (r1-reuse2);
  - drop the always-true `prn > 0` (r1-reuse3);
  - `choose()` conditions via `childPredicate` (r2-reuse1);
  - `VALUE_ARGUMENT_STEPS` derived from the move tables (r2-reuse8);
  - `rowBounds` over `collapsedToOneRow` (r3-reuse5);
  - every self-contained fence through `build.ts` `fenced`/`fencedWhereSelfContained`, ~10 sites
    (r6-reuse3 + r7-reuse1).

### Next round

Round 3 of the 2026-11-03 run landed Substrate 0 (`3cbf460b`), nr-c5-sideeffect-arm (`a4c62a20`), B4 collision
reasons (`82805dde`), cr-fu6's gated hint (`22fd3b71`) and nr-fu2's Map-driver merge scope
(`3140e83b`..`5fbebe54`). Parked: nr-b4-record-alias (owner question above). Merged: C4's wording into
Substrate 0 (owner question above). Fold this section into the lists above at the end of the run.

**Review follow-ups, major first.**

- **nr-fu-b4-unknown-keys** MAJOR — the B4 advice is wrong wherever the Map's key set is UNKNOWN. Reach: common.
  `valueMap()`/`elementMap()` with no key args, `group()`/`groupCount()` leave `facts.keys` undefined, so
  `mayHoldKey` is true for every name and "rename the label (as('v1')) or the key" can never fix the query:
  `g.V().as('v').valueMap().select('v')` → as('v1') → "rename … (as('v11'))", forever. The corpus hits it:
  `g.V().label().groupCount().as("x").select("x")` (`Select.feature:167`). It also calls an ordinary
  label-then-map idiom "ambiguous", against EXPLAIN, DON'T BAFFLE. Fix in `mapKeyCollision`/`mapKeyCollided`
  (`rel/lower.ts`): give the rename advice only when `facts.keys` is KNOWN and holds the key; when unknown, say
  the Map's keys are not known at compile time and suggest naming them (`valueMap('name',…)`) or selecting the
  label before the map step. Also soften "which one is read would depend on the row" where a Map DEFINITELY
  holds the key (the Map wins, `Scoping.java:120-122`) — MapKeyFacts is MAY-only, so drop the clause rather
  than add a MUST set. Pin `g.V().as('v').valueMap().select('v')` in `test/compiler/map-key-collision.exec.test.ts`.
  No answer changes.
- **nr-fu-b4-one-authority** `mapKeyCollision` decides only the MESSAGE; each site still spells the decline
  condition (`mapTail` select(k), `mapHostChild`, select(k1,k2)'s `namedElsewhere` which omits enclosingLabels,
  `projector.ts`'s `sideEffectBehindOwnScope`/`mayScope`/`mapScopeMayHold`). A disagreement silently loses the
  explanation. Fold the verdict into the classifier (reuse proposal *mapKeyScope* below). Also: the FIRST
  advisory wins (`Declines.note` `??=`), so a speculative route's collision can blame the wrong step
  (`g.V().as('name').elementMap().as('m').select('m').select('name')` blames select('m')) — record only on the
  route that declines.
- **nr-fu-s0-default-kind** ~25 self-explaining declines (federate params, io() GraphML/Gryo, olap scope,
  `channels.ts` arm disagreement, q.ts NUL constant, `coerce.ts` dateAdd, ResumeGap) carry kind `'uncovered'`.
  Rename the default `'unsupported'`, or give them kinds, before any consumer reads `.kind`. Remaining throws
  inside the lowering, against "`lowerToRel` never throws": `channels.ts:266/272` (`mergeChannels`) and
  `sql/kernel/q.ts:174` — migrate them to the sink.
- **nr-fu-s0-nested-draw** A draw one host deeper loses its shared-draw reason and says "no lowering covers":
  `g.V().map(__.map(__.V().sample(1)))`, `where(__.map(__.V().sample(1)).is(neq(0)))`,
  `repeat(__.map(__.V().sample(1))).times(2)`. Propagate the recorded reason through the enclosing child hosts.
- **nr-fu-hint-depth** cr-fu6's hint checks only the map()'s own host, so it still suggests local(…) where that
  declines too: `coalesce(__.map(__.V().sample(1)), __.identity())`, `optional(__.map(…))`,
  `where(__.map(…).count().is(1))`, `local(__.map(…))`, `flatMap(__.map(…))`. Skip the hint when the map is nested
  in another child body, or make the `reSourcesOncePerOrigin` doc say "the immediate host admits it". Same
  change: name `sample(n)` not `sample(1)`, and note local() emits every body result while map() emits one;
  extract `perOriginSafeBody(body)` so `localDrawsPerRow` and `flatMapRejoin` share the barrier admission.
- **nr-fu-addE-draw** `g.V().addE('x').to(__.V().sample(1))` (link each vertex to a random one — a natural app
  query) declines SHARED_DRAW with no hint, while `g.V().property('pick', __.V().sample(1).id())` answers.
  Belongs under S3 / the shared-draw family.
- **nr-fu-merge-messages** (`ir/write-args.ts`) "a Map stream MAY hold 'k'" leaks the lattice term — say "the
  injected Maps may contain a 'k' key, and a side effect 'k' is also declared". And
  `g.withSideEffect('k',[name:'zz']).inject([name:'q']).mergeV(__.select('k'))` lost its explanation (now folds
  to the side effect and hits "no lowering covers": no whole-argument Map-driver form). A decline that depends on
  a parameter Map's keys (contrived) is noted; it is sound, as every compile sees its own parameters.
- **nr-fu-c5-hygiene** Over the answering side-effect choose arm: fold `json_extract(json('{"t":"int","v":5}'),
  '$.v'/'$.t')` of a compile-time constant to the literal (overlaps cr-fu3); `scalarChoice` spells a mixed-vtype
  choose's predicate in both v and vtype (`CASE WHEN rn.id IN (…)` twice) → `once()`; over a may-be-absent host
  the gated node is re-inlined ~20×/row including inside `is(5)`'s type-tag tower. All linear (×0.9–×5.0 1k→8k).
  Comment `constantSelectChild`'s inline `caseWhen(hostPresence(host), value)` as "gatedByHost, keeping its
  predicate". Depth gaps (clean declines, older than C5): repeat body, `where(__.map(choose…).is(5))`, a by()
  with a filter tail, `local(…map(choose…).sum())`, a property host, single-arm `coalesce(choose(…))`.
- **nr-fu-mapentry-props** `mapEntryProperties` (`rel/write.ts`) adds a fourth hand-rolled `json_extract` helper
  (`sideOf`, beside three local `ext`s) and evaluates `json_extract(values,'$.v')` twice per entry row — hoist one
  helper, compute once. Overlaps the *propertyRowsInsert* proposal.
- **nr-fu-ci-flake** `test/compiler/one-row-one-traverser.exec.test.ts` "a typed inject payload crosses a
  branch… MERGED_VTYPE" timed out at 5000 ms under the full parallel run (5.5 s alone); it failed one `ci` run
  this round. Give it an explicit timeout or shrink it.
- **Depth gaps recorded, not scheduled** (clean declines, older than this round): Map-driver/computed merges in
  local/union/optional/coalesce arms (S3); record-framed `project('name').by('name').mergeV()` (`mergedFromMap`
  admits only Map framing — reach common, beside R8-res); `mergeV(__.valueMap('name').by(__.unfold()))`;
  explanations for `where/map/group().by/order().by/filter/format` over `valueMap().select(label)` (they decline
  before the key fact is read).

**Reuse-sweep proposals.**

- **merge collision via mapKeyCollision** — `ir/write-args.ts` `resolveMergeArg` (~:376-380) writes its own
  collision sentence from `sideEffects?.has(k)` and sees only withSideEffect constants. Let `MapScopeDeferral`
  carry only the key; `mergedFromMap` (`rel/lower.ts` ~:6278) asks `mapKeyCollision(k, facts, ctx, false)`,
  records it terminal when non-null, else `merge-own-entry`. User prose leaves the Pass-tier module; one wording
  table; `merge-map-scope` kind and prefix row deleted (needs a `terminal` flag on `mapKeyCollided`). Do AFTER
  nr-fu-b4-unknown-keys so the merge message inherits the corrected advice.
- **one Deferral catch** — `deferred(ctx, () => …)` for the four narrowed catches (`rel/lower.ts`
  `mergedElements` ~:6145, `mergedFromMap` ~:6278; `rel/write.ts` `propertyWrites` ~:2602, the token-property
  loop ~:3129). Notes a `MapScopeDeferral` terminal, drops a plain `Deferral`, optionally as an ADVISORY reason
  so "merge with select(k) needs a withSideEffect(k, map) constant" reaches the user. No answer change.
- **`presentWhere(pred)`** in `rel/child.ts` beside `presenceOf` (null/`ALWAYS_PRODUCTIVE` → `'always'`, else
  `{when}`), so no producer can report `{when: ALWAYS_PRODUCTIVE}` — the a4c62a20 regression's cause. Replaces
  the ternaries in `selectedNodeChild` (~:2671), `modulator.ts` `aliasField` (~:522) and `gatedOn` (~:658), and
  deletes `meetPresence`'s doc caveat. Zero SQL change. (Moot if Tier B retires `PresentWhen`.)
- **`propertyRowsInsert`** — six sites in `rel/write.ts` (`mapEntryProperties`, `mergeArmValueWrite`,
  `armValueWriteCorrelated`, the mergeV/mergeE FromMap literal-create loops, `propertyStatements`) build the same
  PROPERTY_TABLE scan, `typeOf(meta(owner…), …)` row type and `insert({cols, type: WRITTEN_TYPE, returning})`;
  two hard-code `'node'`/`'edge'`. One builder with `{meta?, onConflict?}`; byte-identical SQL, ~30 lines.
- **`mapKeyScope`** — `mapTail` select(k) (`rel/lower.ts` ~:3223) and `mapHostChild` (`lower/reduction.ts`
  ~:2545) run the same four-way dispatch (collided / beyond / absent / entry) and evaluate `namedBeyondMap`
  twice. One `mapKeyScope(key, facts, ctx, live)` beside `mapKeyCollision`, plus `sideEffectConstantNode(key,
  ctx)` for the duplicated `constantNode(c.value, c.type ?? null, c.name ?? null)` pair. This is the vehicle for
  nr-fu-b4-one-authority.

### Laws found working this list

- `select(k)` over a value that may be a Map: a named scope beyond the Map wins. That scope can be a
  `withSideEffect` constant, a named collection or a path label (§17 "Map scope"). Otherwise the row's own entry
  is read. A row lacking `k`, with nothing bound, yields nothing (`SelectOneStep.java:62-72`). Pick scope by the
  consumer's framing, never by next-step lookahead.
- **`keys` is a sound MAY set merged by union** (B4). There is no MUST set: a key a row MAY hold beside a
  same-named scope declines, and the ONE classifier `mapKeyCollision` (`rel/lower.ts`) names the collision. A key
  outside `keys` is absent.
- **A `V()`/`E()` body over a may-be-absent host declines as ambiguous** (C4). `reSourcedUnder` asks
  `mayBeAbsent(host)`. EXPLAIN, DON'T BAFFLE: suggest traversing FROM the value or filtering by it.
- **A decline decided on a framing fact records a `DeclineReason`** (a kind plus a message) into the one
  per-compile sink, and the lowering returns `null`. `lowerToRel` never throws. An advisory reason only appends
  a hint (Substrate 0, `src/compiler/unsupported.ts`).
- **A fast path falls through. It never declines what the general route answers** (A1).
- **One row-count authority, `rowBounds`, answers one-host questions** (Calcite
  `RelMdMinRowCount`/`RelMdMaxRowCount`). New unique-key arms go in `src/rel/bounds.ts`, not into a caller.
- A value read N>1 times per row is landed ONCE through `once()`, never re-inlined per use.
- `project()` omits a key whose `by()` is unproductive (`ProjectStep.java:66`). Whether it keeps a productive null
  is Tier B.
- A `property()` traversal value of null REMOVES the key (`AddPropertyStep.java:152-160`).
- `mergeV` `onCreate` may restate, never override, a per-driver merge map. A null vs merge-key value is an
  override and raises (`MergeVertexStep.java:103`, `MergeElementStep.java:325-334,452`).
- Map equality ignores entry order; we decline it from the query text (D). Any Collection, Set included, is a
  label Collection (`TraversalUtil.java:211-236`).
- An absent label means the body's INPUT is empty, so a seeded reducing tail still emits its seed
  (`ReducingBarrierStep.java:143-148`). A body's presence is "exactly one row" (`TraversalMapStep.java:52`). Use
  one presence term per map expression.
- Only a REDUCING barrier clears path labels. A child path carries the parent's labels.
- A `RANDOM()` window stays behind a Materialize fence. A draw inside a body shared by many hosts declines.
- **A refusal whose condition is arithmetic over row count is a DATA-SIZE decline.** A runtime guard does not
  make it acceptable. Answer it from a snapshot of the input (o-seqguard).
- Never join-union with a disjunctive `ON (src=w OR tgt=w)`: a self-loop must yield twice under `both()`.

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
