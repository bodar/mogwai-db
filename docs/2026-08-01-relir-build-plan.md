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
- ✅ **Seeded fold `fold(seed, Operator.x)`** at every depth on the ONE Operator walk (`seededLeftFold`,
  `operator.ts`, shared with `withSideEffect(k, seed, Operator.x)`): a scalar stream folds member-by-member in
  emission order (composes as a correlated child; a terminal seeded fold is productive like `count()`); a map
  stream + `addAll` is `mapsMerged`; `fold([], addAll)` is `fold()`. Long overflow and `/ by zero` raise the
  reference's errors. Where the reference would have BULKED the input (the `NoOpBarrierStep`
  `PathRetractionStrategy` puts after a path processor, including one `InlineFilterStrategy` splices out of a
  `filter()`/`and()`), the arm declines unless the stream is provably distinct — `referenceUnbulkedAt` in
  `src/compiler/ir/bulk.ts`, also used by the map `addAll` arm.

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
  stream stays in SQL (SQLite orders by storage class).
- ✅ **Ranked-order barrier + map-local order landed (2026-10-17).** `order().by(<key>)` whose key is a
  path/list/map (ORDERABILITY, `Order.java`) runs as a RANKED barrier (`src/compiler/rel/ranked-order.ts`): head
  reads each key as JSON text, JS dense-ranks via `orderability.ts`, the resume re-lowers the chain joined to the
  rank through ONE `json_each` bind and orders on (rank, arrival) — every channel survives. Fails closed on a
  writing/random chain. `order(Scope.local)` over a MAP, bare or `by(Column.keys|values)` (`order-dedup-local.ts`).
  Computed longs past 2^53 stay exact at every JS reader (`src/json-exact.ts` `parseExactJson`;
  `BarrierInput.injectedText` carries head text across DO RPC). Sub-path `from`/`to` labels survive non-reducing
  barriers (`ir/labels.ts`).
- 🚧 **Computed wide-long residue** (needs wide longs TYPED in SQL, bigger than a leaf): a wide `long` constant
  (stored as text) is DROPPED by `sum`/`min`/`mean` over a per-row-varying stream
  (`local(union(constant(2^53L), values('age')).sum())`); a top-level runtime-typed sum past 2^53 is still rounded
  on the wire. `json-exact.ts` relies on ES2025 JSON.parse source-text access — unverified on workerd (absent →
  declines, fail-closed). Per-value size cap on the single ranking bind on CF is unmeasured.
- 🚧 **Sub-path residue:** `as('a').out().dedup().path().from('a')` declines at lowering; a sub-path inside a
  nested body declines unless the body binds its own label — raising `Path.subPath`'s exact errors needs a
  runtime guard binding.
- 🚧 **Property-stream vocabulary:** the `by()` vocabulary (`T.key`/`T.value` absent from `TOKENS`), the
  `id()`/`label()` retypes off a property row, `where(<body>)` over a property host, and META-properties
  (`properties().properties()`). `project`/`select` over a property needs FRAMER work — the record→map wire
  framer emits empty maps (`[{}, …]`), verified 2026-08-13 and reverted rather than shipping the mis-frame.

**Guard-binding family** (§6·5 — a graph-dependent refusal → `Binding.guard`):

- ✅ **Runtime / computed LABEL** — `addV(<traversal>)` / `addE(<traversal>)` resolve the label PER TRAVERSER
  (`AddVertexStep.java:140-182`), and `addLabel(<traversal>)` resolves over the snapshot it mutates
  (`TraversalUtil.resolveStringArguments`, `TraversalUtil.java:211-236`, then `AddLabelStep.java:86-95`). Mechanism:
  ONE runtime NAME resolver shared with the runtime property key — `runtimeNameRows` / `parameterSite` /
  `resolvedNames` in `src/compiler/rel/write.ts` (only the message table differs: `Property.Exceptions` vs
  `Element.Exceptions`); the emitter's `shadowsOuter` (`src/rel/emit.ts`) keeps a correlated subquery's re-read
  enclosing relation private so the absent-value guard fires per traverser. No `sequentialGuard` on labels.
- 🚧 **Computed LABEL residue** (unchanged by the above): a single `addLabel` body framed as a list
  (`Collection<String>`) still declines; a computed `dropLabel` name still declines; writes inside
  `union`/`local`/`optional`/`coalesce` arms decline even with constant labels — a separate prerequisite (a write
  inside a multi-arm or child body). ⚠️ Flagged for the index: `sequentialGuard` on property writes is a refusal
  that depends on DATA SIZE (the first-pick tie raise is gone — follow-up 4, `0dce4db8`).
- 🔴 **Follow-ups from the 2026-11-01 review of the computed label** (major first; each prerequisite is ordered
  before what it unblocks):
  1. ✅ **LANDED (2026-11-02, `0dce4db8`).** A retained binding read twice, on a join side that may run as the inner
     loop, or in a correlated subplan, is read through a fenced `Materialize` over its Ref (`spools` in
     `src/rel/emit.ts`, `refReads` in `src/rel/walk.ts`; Calcite `Spool`), so SQLite auto-indexes it;
     `runtimeNameRows` takes ONE first-per-traverser `(o, name, t, vt)` snapshot and the absent guard is one anti join;
     runtime-write slot cleanup is driven from the written rows (`slotRows`). ~6k vertices: 9–32 s → ~0.1 s, linear.
     Gates: `test/compiler/runtime-name-scale.exec.test.ts`, and `sql-hygiene` fails a taken-snapshot inner-loop scan
     (`test/support/snapshot-scans.ts`). Remains: writes inside `union()`/`local()` arms still decline — already true
     and unrelated to this item. Original report follows.
     **PREREQUISITE — an O(N) join between two taken snapshots** (the shared reading of a `json_each` snapshot in
     `src/compiler/rel/write.ts`). Every per-traverser runtime NAME route is QUADRATIC: the equi-joins on `(o)` and
     `(name)` are `json_each(?) ⨝ json_each(?)` nested loops with no index. Measured: `g.V().addV(__.values('name'))`
     0.84 s @2k / 12.5 s @8k; `addLabel(__.values('name'))` 0.9 s @1k / 14 s @4k / 193 s @16k (two quadratic
     statements: `internLabels`' `INSERT INTO labels` and the `vertex_labels` pairing); the now-correct absent guard is
     O(N·M) as a correlated `NOT EXISTS`. Constant `addV('k')` is 47 ms @16k. On a DO's CPU budget this fails ONLY in
     production — the data-size failure root `CLAUDE.md` forbids. Pre-existing on trunk's runtime property KEY
     (`property(__.values('name'),1)` 2.8 s @2k), so fix it ONCE in the substrate, not per caller: carry `name` + the
     interned id on the resolved per-traverser row so pairing needs no re-join, or emit a joined-by-key snapshot as a
     `MATERIALIZED` CTE so SQLite's automatic index applies; the absent guard becomes ONE set op (host `o` EXCEPT
     value-row `o`). Same item: `runtimeNameRows` re-inlines its scan + two windows into six statements (guards + the
     final take) — read one taken `(o, v, vt)` first-per-traverser snapshot instead (root rule: computed ONCE). Add a
     larger-N exec test or a `sql-hygiene` check for `json_each ⨝ json_each`.
  2. ✅ **LANDED (2026-11-02, `803e8252`).** `name()` (`src/rel/passes/name.ts`) now takes its fresh-name source as
     a REQUIRED argument — every caller passes the compile's one minter (`() => fresh('r')`), so two separately named
     plans spliced into one write program can no longer both mint `r0`. Witnesses + deeper compositions pinned in
     `test/L4-addendum/write-program-binding-names.feature`. Remains: nothing. Original report follows.
     **Bare internal `Error: RelIR: duplicate Plan binding 'r0'`** reaches the user for
     `g.V().both().addV(__.values('name')).groupCount().by(label)` and `…addV(__.values('name')).label().groupCount()`
     (trunk declined these; the constant twin `g.V().both().addV('x').label().groupCount()` already leaked on trunk).
     Root: `both()` (a union of directions) feeding a write and then a reducing barrier — `out()`/`in()`/`hasLabel()`
     sources answer correctly. Fix the binding replication, not the label route.
  3. ✅ **LANDED (2184440a)** — a constant label (addLabel/addV) is judged by ONE `constantName(value, vtype, rules)`
     (`src/compiler/rel/write.ts`), with the type the query text states; the all-constant fold routes through
     `mutationLabelMembers`, the `String()` coercion is gone, and the identifier sentences live once in
     `src/gremlin/validate.ts`. Remains: `addLabel(__.constant([]))` still declines (as before) — the reference
     treats it as a no-op, so passing the vertices through would be faithful; out of scope. Original report:
     **ONE authority for addLabel's argument grammar** — `elementAddLabel` runs `mutationLabelNames` FIRST, whose
     all-constant fold does `String(resolved)`: `addLabel(__.constant(null))` writes `'null'`, `addLabel(__.constant(1))`
     writes `'1'`, a `UUID` constant writes its text (also `g.addV(__.constant(UUID(…)))`), while
     `addLabel(__.values('lang'), __.constant(null))` raises correctly via `addLabelConstant` — whether a query raises
     depends on whether ANOTHER member is a body. Reference: `TraversalUtil.java:211-236` ('Traversal argument must not
     produce null' / '…must produce a String or Collection<String>'), `AddLabelStep.java:86-95`. Not a regression
     (trunk `7f041997` same). Fix = reuse-sweep proposal 1 below (route all-constant through `mutationLabelMembers`,
     delete the `String()` coercion; `mutationLabelNames` then serves `dropLabel` only). Needs a test that the label is
     NOT written.
  4. ✅ **LANDED (2026-11-02, `0dce4db8`).** `rankedFirst` on `(sq, v)` is the ONLY first-pick policy (runtime keys,
     edge values, folded parameters too); `firstPerTraverser`/`unorderedFirstGuard`/`UNORDERED_FIRST`/`NameRules.first`
     are deleted, so the data-dependent refusal is gone. §17 "Unordered slices" names it and matrix row 196 drops the
     decline. Remains: nothing. Original report follows.
     **One first-pick policy for the shared resolver.** A label ranks by `(sq, v)` (`rankedFirst`); a key keeps
     `firstPerTraverser`'s data-dependent `UNORDERED_FIRST` raise (`NameRules.first`). So `g.V(3).addLabel(__.in()
     .values('name'))` writes 'josh' while `g.V(3).addV(__.in().values('name')).label()` gives 'marko', and
     `property(__.out().values('name'),1)` can refuse on graph contents. Moving KEY_NAME to `'rank'` is now one line and
     removes a data-size decline (simplification item 7 / outstanding-work §6). Then add a clause to §17 'Unordered
     slices' naming runtime labels/keys (today only a code comment covers it) and drop matrix row 196's "needs an
     unordered first pick" decline for `property()`.
  5. Minor: `g.addV(__.inject('q')).label()` answered `['q']` on trunk and now declines — acceptable
     (`AddVertexStartStep.java:144-160` applies the body to a `false` placeholder), but `parameterSite`'s non-rooted
     branch admits only bodies starting `V`/`E`, so `g.addV(constant("prefix_").concat(__.V(vid1).label()))`
     (`Concat.feature:204`) and `g.addV(__.constant('x').concat('y'))` decline; record in the matrix row. The non-String
     message spells a datetime as its epoch (`…but got 1577836800000`). `emit.ts` `shadowsOuter` skips `walkFree`
     (self-ref) inputs and `fenced()` now uses `outer.has(rel)` — comment why unreachable or pin with a unit test (incl.
     differing spellings). Tests: add MIXED multiset witnesses (`g.V().addLabel(__.values('lang'))`,
     `g.V(1,3).addV(__.values('lang'))`). Depth gaps (clean declines, mostly shared with constant labels): a computed
     label over non-element traversers (`g.inject('a','b').addV(__.identity())`, `properties('name').addV(__.value())`,
     path/valueMap hosts); a per-traverser COLLECTION label (`addV(__.values('name').fold())` — reference unfolds a
     single Collection, `AddVertexStep.resolveLabelCollection`); edge-sourced `g.V().outE().addE(__.label())…`; channel
     carriage (`withSack(1)…addV(__.values('name')).sack()`, `.path()`).
- ✅ **`T.id` on `mergeV`/`mergeE`** — upsert-by-id on both hosts (`src/compiler/rel/write.ts`).

**Writes** (rel-blockers: property 4, addE 3, addV 2, mergeE 1):

- ✅ **`property(k, <traversal>)`** — multi-row `applyAll` (`AddPropertyStep.java:105-199`: 0 rows → no mutation,
  >1 under `single` → the guard message, `list`/`set` → each written, the map form) lowers at depth via
  `sequenceGuard`/`bodyReach`/`programWrites` in `src/compiler/rel/write.ts`; a body whose read could observe a
  same-statement write (a key, a label — `labels()`, 3-arg `has`, `T.label` — or an opaque step) is refused, not
  answered. Reference answers for the refused shapes: `test/L4-addendum/property-traversal-site.feature`.
- 🚧 **`property(k, <traversal>)` residue** — a `sequenceGuard` refusal can fire AFTER an earlier write step has
  already written (tracked in `docs/outstanding-work.md`; each guard's input must be re-derived from pre-write
  state); `union()` encounter order inside a child body; pipelined reads after an earlier write inside a body;
  `mergeArmValueWrite` still takes `limit 1` in scan order and stores a null.
- 🚧 **`content-demand` 3-arg `has`** — `literalKeysOf` (`src/compiler/ir/content-demand.ts`) takes
  `has(label, key, value)`'s FIRST argument (the label) as the key to fetch; if that narrowing ever applies to the
  3-arg form the real key is not fetched. Unverified — check.
- ✅ **A write over a multi-row literal input runs once per traverser** (`MergeEdgeStep`/`MergeVertexStep` are
  per-traverser) — `writeSnapshot()` in `src/compiler/rel/write.ts` skips the input snapshot only for a ≤1-row
  `Values` input, so "no position ⇒ one row" is true by construction across all six write hosts
  (`inject(1,2,3).mergeE(..)` / `mergeE([:])` / computed `mergeV`/`mergeE` no longer cross N traversers × N
  matches). Regression: `test/merge-multi-row-values.test.ts`.
- 🚧 **Merge inside `sideEffect`/`map`/`flatMap`/`coalesce`/`optional`/`choose` arms** still declines
  (`UnsupportedTraversal`); the multi-row-input fix is not yet promoted to an L4 `.feature` scenario.
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
  span BOTH sides (now per member, `lossyMember`). ⚠️ Gating on the compile-time `typed` flag is a DIFFERENT
  question, measured wrong.
- 🚧 **The `set` framing marker** survives all but `order(local)`/`unfold()`; the threading is in place but
  `order(local)` still does not drop it.
- 🚧 **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type) — needs head-position tracking on the RelIR `AliasEntry`.
- 🚧 **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what
  `path().by(<transform>)` writes) — inert until tags join a comparison.
- 🚧 **Seeded-fold residue** — declines (correct, but lost answers): a seeded fold as a `group` value and a
  group value-by whose reducing barrier has more steps after it;
  over-declines of `or(<path processor>)` (`processOrStep` inlines only `has()`) and `filter(math(…))` before the
  fold (rank-0). DEFECTS (answer instead of raising/promoting): a per-row-typed stream answers where the
  reference raises `ClassCastException` (`values('age').fold('z', min)`, `values('name').fold(0, sum)`), and
  `fold(0L, sum)` over ints frames Int instead of promoting to Long.
- 🚧 **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy) and `barrier(Barrier.normSack)`.
- ✅ **`dateAdd`/`dateDiff` over a NON-datetime input RAISES** (2026-09-05). `DateAddStep.map` throws
  *"dateAdd() accept only OffsetDateTime or Date (deprecated)."* and `DateDiffStep` on a non-date LEFT
  operand; the const-fold (`foldConstantCoercions`, `gremlin/coerce.ts`) used to compute `Number(v) ± delta`
  unconditionally, so `inject(null).dateAdd(DT.day,2)` answered epoch-0+2d and `inject(1234).dateAdd(…)`
  treated the int as millis. It now gates on datetime PROVENANCE — `as==='datetime'` (a leading `asDate`
  or a prior `dateAdd`) OR the SOURCE being a datetime literal (`at===1` and every inject arg typed
  `datetime`) — and raises otherwise, leaving `inject(datetime(…)).dateAdd(…)` and the chained/`asDate`
  forms working. Unwitnessed (every DateAdd.feature scenario feeds `datetime(…)`), so it moved no L3/census.
- 🚧 **Path value positions** — `id`/`label`/`valueMap` (channels `[]`, no carry); `path().unfold()` over a MIXED
  element+value path; the ENCOUNTER-plus-path walk.
- 🚧 **L4 sweep** — two committed expectations encoded a since-deleted implementation's bug; nobody has swept
  the rest.
- 🚧 **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself; one commit.
- ✅ **`split()`** lowers as a value-transform barrier (`src/compiler/rel/split.ts`), not a recursive CTE.
  Residue (fail-closed): `split(Scope.local, …)` over a folded list, a LIST-shaped head, and a label bound
  before it read after it — the last is the barrier channel-carrying item in `docs/outstanding-work.md`.

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


### Next round (from the 2026-11-02 round — read before picking items)

Landed this round, all on trunk with green CI: `803e8252` (`name()` takes the compile's minter, so the bare
`duplicate Plan binding 'r0'` is gone), `2184440a` (constant labels judged by ONE `constantName`), `89ca89d8`
(absent label ⇒ the rerooted body's INPUT is empty, carried as the host's `Presence`), `0dce4db8` (taken snapshots
that are read again are spooled as fenced `MATERIALIZED` CTEs, plus one `rankedFirst` first-pick policy). Nothing was
deferred or parked. The source-union item above is UNBLOCKED: its prerequisite landed in `89ca89d8`, so rebasing
`wf/source-union-starter-arms-1-3` onto trunk and dropping its `guardedPredicate` and `scalarChildValue` CASE is now
the first step.

**Shared root causes (one substrate item each, ordered BEFORE the follow-ups they fix):**
- **S1. One constant-label judge at EVERY host, typed.** Three follow-ups below (F2, F3, F4) are one defect class.
  `constantName` is the judge, but the literal merge-map `T.label` (`src/compiler/ir/write-args.ts` `labelNames` →
  `validateLabel`, which does `String(v)`), `dropLabel`'s traversal form (`mutationLabelNames`), and an untyped
  `withSideEffect` constant all bypass it or reach it without a type. The fix that closes the class is: `validateLabel`
  REFUSES a non-string rather than coercing it, every constant label goes through `constantName`, and the side-effect
  registry keeps the `TypeNode` of a typed value. If that last part is too big for one item, decline a typed
  side-effect constant at a label site and say so in `docs/outstanding-work.md`.
- **S2. ✅ LANDED (8143edf2) — the re-sourcing V()/E() arm honours the absent-host INPUT rule. Remains: nothing.** (Corrected wording: an OUTPUT
  gate around `scalarChildValue` is the refuted 2026-11-01 mechanism — it loses a seed, a seed table is wrong once any
  step follows the reduction, and it would add a per-row CASE to the arms that already gate their input.) The one arm
  that ignored the host now goes through `reduction.ts:reSourcedUnder`: unchanged for a host that cannot be absent;
  `gatedByHost` where the tail yields nothing from nothing (`ir/productivity.ts:yieldsNothingFromEmpty`); else
  `CASE WHEN <presence> THEN <rooted body> ELSE <rooted [V|E, limit(0), …tail]> END` — two uncorrelated scalars, so
  the empty-input answer is the body's own lowering. The fan-out path (`flatMapRejoin`) was already right (it
  reroots through the host). F5: a record built under the host gate sees the host `presenceDischarged`. One
  `caseWhen` primitive backs `gatedByHost` and `modulator.ts:gatedOn`.
- **S3 (carried). A write inside a child / multi-arm body**: still the one substrate item for
  `local`/`flatMap`/`map`/`union`/`coalesce`/`optional`/`choose`/`repeat`/`sideEffect`/`where`/merge `onMatch` writes.
  This round confirmed it from three sides: `name()` probes, the `addLabel` probes, and the spooling item's
  union/local arms.

**Follow-ups from review (major first):**
1. **F1 (major, wrong answer, same on trunk) — the V()/E() arm skips the absent-host gate** (`src/compiler/rel/lower/reduction.ts`
   `scalarChildValue`, ~1471, returns `present:'always'` before the gate runs). On modern, with
   `g.V().optional(__.out().as('a'))` (9 rows, 3 unbound):
   - `.map(__.select('a').V().count()).fold()` gives [6×9]; the reference is [6×6].
   - `.map(__.select('a').V().values('name')).count()` gives 9; the reference is 6.
   - `.local(__.select('a').V().count())` gives 6 on the unbound rows; the reference is 0.
   - `local(select('a').E().count())` is also wrong.
   - `project('x').by(__.select('a').V().count())` keeps `x:6`; the reference omits the key.

   Fix it via S2. This also contradicts `hostSelfRow`'s claim to be "the ONE place".
2. **F2 (major, wrong element written, same on trunk) — the literal merge-map `T.label` bypasses `constantName`.**
   Each of these writes the wrong label; the reference raises in every case:
   - `g.mergeV([(T.label): 5])` writes the label `'5'`, and a UUID value writes its text.
   - `[(T.label): ['a', 5]]` writes `['a','5']`.
   - the `option(Merge.onCreate|onMatch, [(T.label): 5])` forms do the same.
   - `g.mergeE([(T.label): 5 or UUID, …])` does the same.

   References: `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeElementStep.java:263-306`,
   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/ElementHelper.java:258-281`.
   Fix it via S1. The map's TypeNode exists, so the typed judge is available there.
3. **F3 (major, wrong label dropped, same on trunk) — `dropLabel(<traversal>)` validates nothing.** The builder said
   this "matches the reference", which is false. The reference resolves through `TraversalUtil.resolveStringArguments`
   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/DropLabelsStep.java:98-103`),
   with the same rules as `addLabel` except the empty/hidden check:
   - `g.V(1).dropLabel(__.constant(['person', 5]))` drops `person`; the reference raises before any drop.
   - `dropLabel(__.constant('person'), __.constant(5))` drops `person`; the reference raises.
   - `dropLabel(__.constant(null))` is a silent no-op; the reference raises.

   Fix: `constantName` with `ADD_LABEL_NAME`'s null/notString/collection rules, minus `validateIdentifier`. Then
   `mutationLabelNames` goes away.
4. **F4 (major, wrong label written, same on trunk) — a UUID side-effect constant is written as a label.**
   `constFromNested`'s `withSideEffect` arm (`src/compiler/ir/write-args.ts:68`) has no TypeNode, so it infers
   `'string'`:
   - `g.withSideEffect('k', UUID(…)).addV(__.select('k'))` writes the uuid text as a label.
   - `withSideEffect('k', ['a', UUID(…)]).V(1).addLabel(__.select('k'))` does the same.

   Fix it via S1. Its prerequisite is that the side-effect registry keeps a typed value's type.
5. **F5 (major, sql-hygiene) — nested gates repeat the same per-row presence term.**
   `g.V().optional(__.out().as('a')).project('x').by(__.select('a').project('y').by(__.constant(1)))` inlines
   `CAST(json_extract(un16.a0,'$[#-1].v') AS INT) IS NOT NULL` four times. The answers are correct. This breaks
   "computed ONCE". Fix it via S2.
6. ✅ **LANDED (8cc14cd7).** **F6 (major, wrong answer, same on trunk) — a second `select()` in a FILTER body after a reroot reads as unbound.**
   - `g.V().as('b').out().as('a').where(__.select('a').select('b')).count()` gives 0; the reference is 6.
   - `not(…)` gives 6; the reference is 0.
   - `g.V().as('b').out().where(__.select('b').select('b')).count()` gives 0; the reference is 6.

   The where-leg / end-label route (`classifyWhereLeg`, `src/compiler/rel/lower/filter.ts`) lowers the second select
   to an EXISTS over `WHERE (0 = 1)` and never reaches `selectRerootSubject`. The `map(…)` form is correct (6). Route
   it through `selectRerootSubject` or decline cleanly, and test it either way. Reference: `SelectOneStep` →
   `Scoping.getScopeValue`, where the output is a split that keeps the path.
   **Landed:** `ChildSeam.predicate` now takes the row's aliases and dispatches through `childPredicate` (the one
   where/filter/not entry), so a leg-body `select()` re-roots via `selectRerootSubject` (`src/compiler/rel/child.ts`,
   `src/compiler/rel/match.ts`); the fresh-walk multi-correlation route declines a body reading an uncorrelated live
   outer label (`labelReads`). Tested in `test/compiler/where-leg-alias-scope.exec.test.ts`. Remains: nothing.
7. **F7 (major, depth) — a per-traverser `mergeV` map is still O(N·V).**
   `g.V().mergeV(__.project('name').by(values('name'))).count()` takes 2.9 s at N=3000 and 11.7 s at N=6000. The match
   join drives a spooled snapshot as the OUTER loop against `nodes` with a non-equi `(pp0 = 0) OR EXISTS(…)`
   predicate. `test/support/snapshot-scans.ts` misses it because the snapshot is outer. Either extend the detector to
   flag a full base-table scan driven per snapshot row, or give the match join an equi key. Record it in
   `outstanding-work.md` if it is not taken.
8. **F8 (minor, cheap) — make `rankedFirst`'s order key total.** Add `vt` as a third sort term (it is already a
   column, so this is no new per-row term). Today int `1` and double `1.0` tie, so the number class written is
   decided by scan order (`src/compiler/rel/write.ts`).
9. **F9 (minor) — say the eager-raise change in §17.**
   - `g.V().limit(0).addLabel(__.constant(5))`, `…has('name','nobody').addLabel(__.constant(null))` and a statically
     dead `choose` arm now raise at compile time where the reference answers `[]` / `[v1]`.
   - `g.addV(__.constant(null))` changed from a decline to `Label can not be null`.

   §17 "Error timing" says "`limit(0)` still answers `[]`", which these cases contradict. Amend that line to cover a
   constant argument judged at compile time, and pin one empty-input case in a test.
10. **F10 (minor) — render non-scalar values readably in `constantName`'s `notString`.** Today it prints `String(value)`:
   - `addLabel(__.constant([['a']]))` raises "…but got: a".
   - a map prints "[object Map]".
   - a datetime prints epoch millis.

   Use JSON for a list or map and ISO text for a datetime (`TraversalUtil.java:225` names the class).
11. **F11 (minor) — `refReads` stops at a Ref** (`src/rel/walk.ts`). A non-retained plan CTE that reads a retained
    snapshot inline is never spooled; only the corpus gate `nestedSnapshotScans` catches it. Either walk into the
    definitions of non-retained bindings, or document the limit. Also document that the outer side of an unordered
    inner join is spooled too: one extra O(N) fill, which corrects the "byte for byte" claim.
12. **F12 (minor) — `snapshot-scans.ts` finds spools by regex** with one nesting level. Read spool names off the Plan
    (or an emitter marker) so a deeper spool body cannot silently leave the gate.
13. **F13 (minor) — missing witnesses.** Each of these now answers correctly but has no test:
    - choose/coalesce branch-bound labels: `hasLabel('person').choose(values('age').is(gt(30)), out().as('a'), identity()).map(select('a').constant(1)).count()` = 3; `coalesce(out('created').as('a'), identity()).where(select('a').constant(1)).count()` = 4.
    - a self-loop under `optional(both().as('a'))`.
    - a nested by-of-reroot record.
    - `local(select('a').constant(1).sum())` = 6.
    - `order().by(select('a').label()).by(select('a').id())` = 6.
    - `map(select('a').id().math('_+1'))` = 6 (trunk raised).
    - coalesce/choose-led bare `by()`/`map()` bodies.
    - addLabel in coalesce/optional/flatMap arms, multiplicity `union(identity(),identity()).addLabel(constant('z'))`,
      and a nested-list item.
14. **F14 (minor, cheap) — the reroot presence is spelled twice.**
    - `selectRerootHost` and `filter.ts:selectRerootSubject` repeat `gatedByHost(host, payload)` + the
      `mayBeAbsent ? 'value-nullness' : aliasPresence` pair. Make it one helper (e.g. `rerootPresence`).
    - `aliasGuard` spells "label bound" as `aliasPresent(col)` while `aliasPresence` uses `payload id IS NOT NULL`.
      Make `aliasGuard` use the cheaper spelling, so the fact has one spelling.

**Depth gaps recorded this round (clean declines, unchanged from trunk; not defects):**
- **Absent-label reroot:**
  - an edge label rerooted through an endpoint (`optional(outE().as('e')).map(select('e').inV())`), so the
    edge-endpoint `present` carry is unexercised.
  - a property/list/map-valued label.
  - a repeat-body label (`emit().repeat(out().as('a')).times(1).map(select('a'))`, `select(last,'a')`).
  - a value label with a seeded tail.
  - a label bound in a union over a value host.
  - `select('a').valueMap()/elementMap()/project()` under `map()`/`local()`.
  - top-level union/coalesce/choose/optional with `select('a')…` arms.
  - `match(__.as('a').where(select('a').label()))`.
  - `local(select('a').count())`, `where(select('a').count().is(1))`, `choose(select('a'),…)`,
    `coalesce(select('a').constant(1),…)`, `map(select('a').identity())`.
- **Writes in arms (S3):**
  - `local/map/flatMap/union/coalesce/choose/optional/where/sideEffect/repeat(__.both().addV(..))`.
  - `path()/fold()/groupCount()/valueMap()/simplePath()` feeding `addV`.
  - `values('name').as('n').addV().property('n', select('n'))`.
  - `withSack(1)…sack(sum).addV().sack()`.
  - `addV().path()`.
  - addLabel in `project().by()`, `map()`, `where()`, `repeat()` bodies and in `mergeV` `option(onMatch, …)`.
  - `mergeV([(T.label): __.constant(x)])`.
- **`addLabel(__.constant([]))` still declines.** The reference treats it as a no-op, so passing the vertices
  through is the faithful answer. This is cheap.

**Reuse-sweep proposals (next round; no answer change unless noted):**
1. ✅ **LANDED (e54b3a02).** **One `aliasElementHost(rel, proj, row)` constructor that always carries `aliasPresence`** (`src/compiler/rel/alias.ts`).
   *Landed:* `aliasElementHost` in `src/compiler/rel/alias.ts` is the one alias element host (always carries
   `aliasPresence`); the where-by hosts now keep `present`, so the witness answers 6. F14 `rerootPresence` is shared by
   `selectRerootHost` and `selectRerootSubject`. Witnesses: `test/L4-addendum/absent-label-where-by.feature`.
   *Remains:* the `not(where('a', P.eq('b')).by(...))` twin (should answer 6), `filter`/`choose` over where…by, and a
   `match` leg whose body is where…by still fail with a clean `UnsupportedTraversal` from the child-predicate route.
   They were unsupported before this item; that is a separate route.
   It replaces the four inline alias element hosts in `src/compiler/rel/match.ts` (~469/588/787/794) and the two
   `hostOf` closures in `src/compiler/rel/lower.ts` (`aliasValueWhere` ~5262, the where-by VALUE-compare ~5357).
   **This one is a BUG FIX:** those closures drop `present`.
   `g.V().union(__.as('a'), __.identity()).as('b').where('a', P.eq('b')).by(__.constant(1)).count()` gives 12 on
   trunk and should be 6 (`by('name')` gives 6). Reference: `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java:131-151`.
   Static-label SQL is unchanged.
2. **One `firstPerPartition(rel, partitionBy, orderBy, fresh)`** (Window `row_number` + Filter `rn = 1` +
   Project-away; this is Calcite's DISTINCT ON,
   `vendor/calcite/core/src/main/java/org/apache/calcite/sql2rel/SqlToRelConverter.java:1045-1113`). It replaces five
   hand-rolls: `write.ts:rankedFirst`, `map.ts:dedupGroupMembers` (~1155), `collection.ts:firstOccurrences` (~720),
   the `lower/slice.ts` dedup survivors (~600), and `lower.ts` first-map-per-driver (~5764). It supersedes the
   2026-11-01 proposal 5. `perOriginWindow` delegates when offset=0 and limit=1. ~35–45 lines; the SQL is identical
   except for rank/alias names.
3. **`perOriginWindow` drops the always-true `prn > 0` when `slice.offset` is 0**
   (`src/compiler/rel/lower/reduction.ts`). That is one per-row term fewer in every local/flatMap/match
   `limit(n)`/`tail`. The sql-hygiene byte baselines move DOWN; say so in the commit.
4. **`unitRow(fresh, hint)` in `build.ts`** for the one-row `Values(1)` source. It replaces six literals:
   `reduction.ts:hostSelfRow` and `mapEntryChild`, the `lower.ts` addE/addV/mergeV source arms (~4303/4311/4321), and
   `write.ts` ~1354. `mapEntryChild`'s column `one` becomes `n`.
5. **Fold constant PROPERTY keys through `constantName(KEY_NAME)`** (`src/compiler/ir/write-args.ts:parseProperty`'s
   uuid/datetime carve-out and `key == null → kind:'none'`). Keys and labels then share one judge. **ANSWER
   CHANGE:** `g.V(1).property(__.constant(5), 1)` and `property(__.constant(null), 1)` go from an UnsupportedTraversal
   decline to KEY_NAME's reference sentences. Land it together with S1.
6. **One `gateOn(pred, value)` CASE primitive**, split out of `child.ts:gatedByHost` and used by
   `modulator.ts:gatedOn` (~623). Collapse the identity Presence remap at `reduction.ts` ~1380 to `final.present`.
   Do it with S2.
7. **`name()` takes the compile's `Minter` directly** (or one shared helper), replacing the seven `() => fresh('r')`
   adapters (`lower.ts` ×4, `write.ts` ×3). Readability only.
8. Still open from the 2026-11-01 round: proposal 6 (one exported `ABSENT_VALUE`) and 7 (`emit.ts`
   `blockAliases`/`renderedAliases`). Proposal 5 is superseded by item 2 above.

**Test infrastructure note — ✅ LANDED 2026-11-02 (`fa25b24e`).** `test/text-literal.test.ts` "a decoded NUL or lone
surrogate declines at every position that inlines it" used to time out at 5 s under the parallel suite. It is now a
`test.each` with one case per position (each case gets its own budget, and a failure names the query), and every case
shares one lazily seeded store because each one declines at compile time. Remaining: nothing.

**Needs-human questions:** none raised this round. (One conditional call for whoever picks it up, not a question:
reuse proposal 5 turns a decline into a raise. The project rule "a decline costs the user something" favours the
raise.)

### Next round (from the 2026-11-01 round — read before picking items)

**PARKED — UNBLOCKED 2026-11-02 (prerequisite landed `89ca89d8`) — Source-position `g.union(…)` over a one-row STARTER** (branch `wf/source-union-starter-arms-1-3`, unpushed:
`d85bc022` source union + `g.union()`, `0ec60b2f` arm labels ride on, `a163f5a8` partially-bound label presence gate).
Parked because `a163f5a8` REGRESSES its parent with lost rows / wrong counts. Both open defects share ONE root cause:
the absent-label gate is applied to the body's OUTPUT, so a SEEDED reducing tail loses its seed. Reference: an absent
key makes `SelectOneStep` emit nothing (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java`),
then `ReducingBarrierStep.processNextStart` still emits its seed (`…/step/util/ReducingBarrierStep.java:143-148`) — 0
for `count`, `[]` for `fold`.
- Defect 1 (`src/compiler/rel/lower/reduction.ts` `scalarChildValue` select reroot, `CASE WHEN guard THEN rest.expr
  ELSE NULL`): over `g.V().optional(__.out().as('a'))` (9 rows, 3 unbound) — `map(__.select('a').values('name')
  .count())` six 1s (want +three 0s); `.fold()` misses three `[]`; `map(__.select('a').out().count())` 6 rows (want 9);
  `project('x').by(…count())` gives `{}` (want `{x:0}`); `order().by(…count()).count()` 6 (want 9);
  `group().by(__.select('a').out().count()).by(__.count())` `{0:5,2:1}` (want `{0:8,2:1}`);
  `g.V().has('name','marko').union(__.identity().as('a'), __.out()).map(__.select('a').out().count())` `[3]` (want
  `[3,0,0,0]`); `g.V().choose(__.hasLabel('person'), __.as('a'), __.identity()).map(__.select('a').out().count())` 4 rows
  (want 6).
- Defect 2 (`src/compiler/rel/alias.ts` `guardedPredicate`, used by `filter.ts` `childPredicate` and `match.ts`
  `legSingle`/`existenceExpr`/reducing back edge — `and(guard, pred)` vetoes a leg TRUE over empty input):
  `…optional(__.out().as('a')).where(__.select('a').values('name').count().is(0)).count()` 0 (want 3);
  `where(__.select('a').out().count().is(0))` 5 (want 8); `not(…)` 4 (want 1); the marko-union `where` form 0 (want 3).
- ✅ **LANDED (89ca89d8, 2026-11-02) — the PREREQUISITE below.** An unbound label now empties the rerooted body's
  INPUT through the host's EXISTING `present?: Presence` (lifted from ChildHost's scalar arm to the element arm and
  `Subject`): `aliasPresence` (`src/compiler/rel/alias.ts`) sets `present:'value-nullness'` exactly where `aliasGuard`
  owed a guard; `hostPresence`/`gatedByHost` in `src/compiler/rel/lower/child.ts` gate every consumer; statically bound
  labels carry no field, so their SQL is unchanged. Witnesses: `test/L4-addendum/absent-label-body-input.feature`,
  `test/compiler/absent-label-body-input.exec.test.ts`. Remaining, all present before this change:
  `g.V().as('a').out().as('b').where(__.select('a').select('b')).count()` answers 0 (ref 6) — the where body lowers into
  an EXISTS over a `WHERE 0=1` relation, a different mechanism; still declining exactly as on trunk:
  `map(select('a').valueMap())`, `map(select('a').project(..))`, map over select of an edge label then `outV()`,
  `local(select('a').count())`, a union-headed select body ending in `fold()`, a value label bound in `optional()`, and a
  label read after an emitting `repeat(...).times(1)`; `where(select('a').label())` over a branch-bound label tests the
  label subquery IS NOT NULL rather than the cheaper id IS NOT NULL (correct, one correlated read; cheapening it means
  treating `label()` as a mapping terminal in `productivity.ts`, which other callers share). NEXT: rebase
  `wf/source-union-starter-arms-1-3` onto trunk and drop its `guardedPredicate` and `scalarChildValue` CASE.
- **PREREQUISITE (ordered BEFORE re-landing the item): ONE "absent label ⇒ the body's INPUT is empty" authority at
  the select-of-alias lowering itself**, consulting the existing productivity authority
  (`src/compiler/ir/productivity.ts` `MAPPING_TERMINAL`/`presenceOf`) to know whether the tail is seeded. The gate
  empties the rerooted host's row presence, so a seeded reduction emits its seed and a predicate over it sees the seed;
  every body (map/local/flatMap/project-by/order-by/group-by/where/not/match legs) inherits it, replacing the two
  per-consumer sites (`guardedPredicate`, the `scalarChildValue` CASE) and the per-consumer `aliasGuard` in
  `childPredicate`/`selectRerootSubject`. A leg form that cannot empty its input DECLINES. Then rebase the branch onto it.
- Before re-landing also: add L4 scenarios for a label bound inside a starter arm and read downstream
  (`g.union(constant(1), constant(2).as('a')).select('a')` → [2], with its `inject(0)` oracle; both arms binding 'a' →
  [1,2]), a reducing tail after a partially-bound select in each consumer (the witnesses above), and
  `project('x').by(__.select('a'))` → `[{x:1},{}]` (ProjectStep omits an unproductive key). Narrow the rooted-arm label
  decline: `labelsBoundBefore` counts `match` labels `rootedRead` does carry (trunk answered
  `g.union(__.V().has('name','marko').match(__.as('x').out().as('y'))).select('y')` = [vadas, josh, lop]), and
  `labelReads` collects every downstream string so `g.union(__.V()…as('a')).constant('a')` / `.has('name','a')` decline
  — use an operand-position reader like `preBarrierSelectRead`. `opensOffStarter` admits a declared side-effect
  `select(k)` but `unionArms` refuses a scalar/list one (`g.withSideEffect('x',1).union(__.select('x'), __.constant(2))`)
  — cover it or fix the docstring.
- Depth gaps (clean declines, mostly inherited from `inject(0).union(…)`): `g.union().inject(1)` (ref [1]),
  `g.union().coalesce(constant(1))` (ref []); `g.union(constant('x')).path()` → `[p[x]]` needs only an EMPTY path seed on
  the starter (`tracksPath` blocks it today — UnionStep drops the starter's path) — name it as the next step;
  `repeat`/`local`/`flatMap`/`map`/`fold`/`count`/`unfold` after a source union; mixed starter and re-sourcing arms (by
  design).

**Shared root causes this round surfaced (one substrate item each, ordered before their dependants):**
- ✅ (`0dce4db8`) **O(N) snapshot⨝snapshot join** — computed label item 1 above; unblocks every per-traverser runtime name (label,
  key) and the property-key route's existing cost.
- **A write inside a child / multi-arm body** (`local`/`flatMap`/`map`/`union`/`coalesce`/`optional`/`choose`/
  `repeat`/`sideEffect`) — declines for constant AND computed labels, for merges, and for `addLabel`; one substrate
  item, not per-write-step.
- **Absent-label ⇒ empty body input** — the source-union prerequisite above; also what every select-in-body consumer
  needs.

**Reuse-sweep proposals** (no answer change unless noted):
1. ✅ (2184440a, with 2 and 3) **addLabel parses its arguments once** — `elementAddLabel` sends the all-constant case through
   `mutationLabelMembers`/`addLabelConstant` too (all-string members → `bindLabels({owners, names})`, constant SQL
   byte-identical); `mutationLabelNames` serves `dropLabel` alone. ~15 lines. ANSWER CHANGE (a fix):
   `g.V(1).addLabel(__.constant(5)).labels()` answers `[person, 5]` today, reference raises (`TraversalUtil.java:211-236`);
   `constant(null)` writes `'null'`. Needs a test that nothing is written.
2. ✅ (2184440a) **One compile-time `constantName(value, rules: NameRules)`** replacing `labelMember`'s constant branch and
   `addLabelConstant` (null → `rules.nullMessage`, list → `rules.collection`, non-String → `rules.notString`+value, else
   `validateLabel`), so compile-time refusal and `runtimeNameRows`' run-time guard read one table. ~12 lines.
3. ✅ (2184440a) **KEY_NAME/LABEL_NAME/ADD_LABEL_NAME sentences from `src/gremlin/validate.ts`** — export its tables (the owner of
   `ElementHelper`'s rules) and build the `NameRules` from them; six duplicated literals go.
4. ✅ (`0dce4db8`, with follow-up 1) **One positional label-pairing join** — `labelledByPosition` (write.ts) takes the key column (ORD for a creation,
   `o` for `targetsOf`), so `bindLabels`' non-constant arm and `elementAddLabel`'s `owned`/`named` joins go. ~20 lines;
   a computed-addLabel census digest may move (say so). Do it together with prerequisite 1 above — same joins.
5. **`rankedFirst` and `mergeFromTraversal`'s first-map-per-driver on `perOriginWindow`** — move `perOriginWindow`
   (+`defaultCollation`) from `lower/reduction.ts` into `compiler/rel/build.ts` beside `rowNumberWindow`; emit `rn = 1`
   for offset 0/limit 1. Two hand-rolled copies gone; census digest may move.
6. **One exported `ABSENT_VALUE`** ('The provided traverser does not map to a value') — rename write.ts's
   `ABSENT_LABEL`, export beside `Guard` in `rel/plan.ts` or in `validate.ts`; quote it at `lower.ts` `emptyOperand` and
   `mergeFromTraversal`'s miss guard.
7. **`emit.ts` `blockAliases(b)` / `renderedAliases(b)`** — replaces four spellings in `shadowsOuter`,
   `unanchoredAggregate`, `side()`, `sideAliases`; keeps the two textual qualifier tests agreeing. ~6 lines.

**Needs-human questions:** none raised this round.

### Substrate worklist (root-cause synthesis, 2026-10-17) — PRUNED 2026-10-18

The 2026-10-17 synthesis grouped every recurring wrong answer into eight clusters (A–H) and built a
channel or total table for each. The **2026-10-18 simplification review** found that most of what
A, C (its Float/out-of-range/signed-zero residue), E and F built emulates how Java EXECUTES — merge
order, laziness, error timing, write interleave, number spelling — rather than which rows a query
returns, and that two of its declines fire on DATA SIZE. Those clusters are therefore **closed, not
open**: their residue is NOT a worklist item, and their landed machinery is scheduled for removal in
`docs/archive/2026-10-18-simplification-plan.md`. Do not add more merge, interleave, raise-extent, signed-zero,
UTF-16 or Java-dialect machinery; the accepted answers are listed in `docs/feature-support-matrix.md`
§17 *Deliberate divergences*. The code is the authority for every mechanism named below.

- ✅ **A — bulking positions / TraverserSet merges: REVERTED (simplification item 9).** `bulkingPositions`,
  `regroupFirstOccurrence`, `mergedAt`, the 2500-slot merge-window raise, `barrier()` merging, `order()`
  merge-then-DENSE_RANK, the sorted-host merge declines, the bulk-forwarding declines and `poolMergeGuard`
  emulate `LazyBarrierStrategy`/`TraverserSet` and change only the order of an unordered stream (and which
  rows an unordered `limit()` keeps). Kept: `count(1)` (SQLite's countOfView bug), the per-start
  reducing-option gate, `optional(count())` per start, `mergePeerArms`, the mergeV origin key,
  `path().by()` value positions (`mergesNothing` went with the merges it guarded).
- ✅ **B — the branch emission key.** ONE authority in `rel/lower.ts` (`branchOrderOwed`, `BranchKeys`,
  `mintBranchOrder`). The simplification reduced the key to one rule (`f78f3387`) —
  `row_number() OVER (ORDER BY input.encounter, arm_ordinal, arm.encounter)` — with start-major order
  for flatMap/local bodies.
- 🟡 **C — the number/type channel.** KEPT: the class authority (`reducer.ts` `numberWidth`/
  `numberFloating` → `commonNumberClass`; 1 stays Int, 1.0 Double, `count()` Long, a Boolean a Boolean),
  the variant per-row class column, alias-rebind class, `numberClassOf`, federate `leafStore`, atomic
  write programs / bulk load / replication. REVERTED (landed): the Float authority (a
  Float is stored as the Double of its literal, `Math.fround` at the framer), the out-of-range Double
  carrier (`<w>p<n>`, `binary64Pair`, `wireCarrier`), signed-zero ordering and keys (`ZeroCarrier`,
  `signedCompare`, `unstableTieGuard`), min/max tie windows and promotion, predicate compare "cells".
  Typed equality becomes SQLite value + a coarse family (boolean, number, string, other).
- ✅ **D — productivity.** `ChildValue.present` is required; `productivityFilter` is the one by()-drop
  authority. Presence is `value IS NOT NULL` (a NULL `by()` counts as absent) and `coalesce()` is SQL
  `COALESCE` (`309dad10`).
- ⛔ **E — raise extent: SUPERSEDED (revert to the eager form).** A raise is ONE in-statement predicate
  (`raisingRows`, the `593317fe` design) evaluated wherever SQLite evaluates it; a query containing a type
  error may raise "early". The pull-level/span machinery (`raise-channel.ts`), `conjoinInOrder`, the
  MATERIALIZED raise fence, the FilterRankingStrategy model and `sack-nan.ts` are DELETED. Kept: the five guards
  consolidated into one raise, `hostTag`, every no-bare-`Error` fix, the per-value `dateAdd` message.
- ⛔ **F — write interleave: SUPERSEDED (snapshot writes).** A write step sees a SNAPSHOT of its input;
  steps after it see all its writes (what `barrier()` gives in Java, and what TinkerPop's docs tell users
  to add). `readBeforeWrite`/`readAfterWrite`/`writeAfterWrite`/`mergedOnceAlike`/`barrierHoldsAll` are DELETED (work item 7).
  Kept: the side-effect-under-slice decline, `iterate()` → `discard()`, the `where(as(unbound))` decline,
  shared-creation onMatch (without `ProgramWrites.reads`/`overwritten`).
- ✅ **G — label scope into nested arms.** ONE total IR walker (`ir/walk.ts`), arm column decline,
  `writesAnywhere`; a `where`/keyed `dedup` scope key reads a `project()` field / the traverser's own map
  first (`fa1f902d`, `382d4734`). Residue: threading alias channels through `childSeam`. The path-entry
  maybe/ambiguous lattice is removed (simplification item 21).
- 🚧 **H — reference strategy facts copied by hand.** Emit-first unroll and `PLAIN_FOLD` landed; open:
  one table per reference strategy in `ir/` (the `bulk.ts` pattern), each row citing its vendor line —
  for strategies that change WHICH rows a query returns, never for ones that only change execution order.

The per-parked-branch resume table is retired: every row was either salvaged on trunk (`792b9816`) or
proposed rebuilding on A/E, which are superseded.

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
