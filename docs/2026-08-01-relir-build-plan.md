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

- 🔴 **Runtime / computed LABEL** (~6 writes). `ElementHelper.validateLabel` is three PURE predicates → a guard,
  not a decline; the gap is a missing guard at the nine CALL SITES. ⚠️ The message set depends on ARITY. Settle
  the three-answer coercion HERE, don't add a fourth: `mergeV([(T.label): x])` coerces, `g.addV(x)` declines,
  `addLabel(x)` coerces.
- 🚧 **`T.id` on `mergeV`/`mergeE`** (5 writes) — `elementIdGuard` exists; the `Insert` column plumbing does not.

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
  span BOTH sides (`withLossyFlag` asks it of one). ⚠️ Gating on the compile-time `typed` flag is a DIFFERENT
  question, measured wrong.
- 🚧 **The `set` framing marker** survives all but `order(local)`/`unfold()`; the threading is in place but
  `order(local)` still does not drop it.
- 🚧 **`AliasEntry.binds`** must not increment on a rebind at the SAME path position (a wrong `Pop.mixed` wire
  type) — needs head-position tracking on the RelIR `AliasEntry`.
- 🚧 **`memberTypeTag` returns a NULL tag unresolved** for a wrapped member whose `t` is null (what
  `path().by(<transform>)` writes) — inert until tags join a comparison.
- 🚧 **Seeded-fold residue** — declines (correct, but lost answers): a seeded fold as a `group` value and a
  group value-by whose reducing barrier has more steps after it; a per-origin seeded fold mid-body in `local()`;
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

### Substrate worklist (root-cause synthesis, 2026-10-17)

🚧 **Why per-item fix rounds did not converge.** Six parked items were each fixed round after round by
adding a predicate to ONE host (`tiesProjectAlike`, `sliceDownstream`, `branchMajor`, `stringReceiverGuard`,
`sequentialGuard`'s `site.host`, an advisory math guard); the next review found the same fact at a depth that
host does not reach. Every recurring fact is a reference behaviour this repo RECOMPUTES PER HOST or does not
model at all: where equal traversers merge, the order a branch emits, whether a body was productive, whether
a row's evaluation raised, a value's number class, and which traversers have already written when a body
reads. §3.5 already holds the cure for one such fact (`CHANNEL_GROUP_POLICY`, `obligations.ts`) — make the fact
a CHANNEL or a TOTAL TABLE every node declares — and the clusters below apply that move again. Every cluster
has a confirmed wrong answer on TRUNK, not only on a branch. Two branches also built competing raise
substrates (`branch-residue`'s separate-statement `raiseGuard`/`rowGuard`, racy under `sample`/`shuffle`;
`fanout-by-first`'s in-statement fence in `src/rel/raise.ts`) — merging either as-is leaves two raise
authorities.

- 🚧 **A — bulking positions (where equal traversers merge).** Authority:
  `vendor/tinkerpop/gremlin-core/.../traverser/util/TraverserSet.java` (a LinkedHashMap; `add` merges into the
  FIRST arrival's slot), `AbstractTraverser.java` / `B_LP_O_S_SE_SL_Traverser.java` (equality per traverser
  class), `strategy/optimization/LazyBarrierStrategy.java` + `step/map/NoOpBarrierStep.java` (the windowed
  barrier after each flat-map after the first), `step/util/CollectingBarrierStep.java` + `OrderGlobalStep`
  (stable sort over the merged set), `step/branch/BranchStep.java` (with a barrier, equal starts merge at the
  arm), `RangeGlobalStep` (a slice trims BULK, so the merge changes counts, not just order). Seam:
  `src/compiler/ir/bulk.ts` `referenceUnbulkedAt`/`referenceDistinctAt` answer a boolean that each consumer
  asks separately; nothing lowers the merge. Design: ONE authority `bulkingPositions(steps, rooted)` (noop /
  collecting / armStart, with the window) encoding LazyBarrier + PathRetraction/InlineFilter as a table, the
  boolean callers derived from it; ONE mint `regroupFirstOccurrence(rel, eqKey, window)` beside
  `renumber`/`rowNumberWindow` — `eqKey` per traverser class (payload + `vtype`, so `1`≠`1.0`; + path/alias/loops
  when tracked), declining on a carried `sack`/`origin` and inside a recursive term (P1); applied at each
  position under `ctx.ordered` and at a per-origin slice. Deletes `tiesProjectAlike` and `mintOrdered`'s
  input-position key. Stopgap: decline an explicit `barrier()` / CollectingBarrier `order()` over a
  non-distinct input when order is read, and a `partitionedSlice` whose host is not unbulked — NOT plain
  flat-map chains before `fold()` (measured: loses most of L3). Size: L, ~400–600 LOC + a census run; the
  window needs an L4 scenario.
  ✅ **Stopgap fail-open holes closed 2026-10-17 (`4841b638`, `998f37f8`):** `referenceMergeObservableAt`
  asks which comes FIRST after a tie-every `order()` — a reader or an eraser (`orderReadBeforeErased`, readers
  at any depth via `readsOrder`) — so a slice between the order and an eraser declines; a tie-every key is any
  key chain that discards the traverser (a `constant()` step or a variable-free `math()`); ONE `erasesOrder`
  authority (global reducing form only — a side-effect `groupCount('x')` passes through, not an eraser).
  Pinned in `test/L4-addendum/traverser-set-merge.feature`. The regroup mint itself and the data-dependent-tie
  / LazyBarrier residue (indexed in `docs/outstanding-work.md`) remain.
  ✅ **Stopgap LANDED (`9b1e80e9`):** one authority `referenceMergeObservableAt` (`ir/bulk.ts`), consulted by
  `rowOp` and every inline `barrier()` site, declines an explicit `barrier()` / tie-everything `order()` over a
  possibly-non-distinct stream when an order reader is downstream; pinned in
  `test/L4-addendum/traverser-set-merge.feature`. L3 unchanged (1863). The full `bulkingPositions` /
  `regroupFirstOccurrence` authority above is still open.
  ✅ **Authority LANDED (wf7/substrate-bulking-positions):** `bulkingPositions` (`ir/bulk.ts`) places every merge —
  start iterator, LazyBarrier (first flat-map exempt, `Barrier`-next exempt, `GraphStep` id rule, labelled
  path, PATH/`drop`/`element` off-switches), PathRetraction after a label-free `math`/`select(key)`/`format`,
  `RepeatUnrollStrategy`'s per-body barrier (`unrolled: 'strategy'`), a spliced `flatMap()` (`splicedHost`),
  explicit/collecting/side-effect barriers — with a SUPERSET mode `referenceUnbulkedAt` is now derived from.
  `regroupFirstOccurrence` (`rel/build.ts`) re-positions equal rows to their first arrival's encounter (shared
  — the bulk), raising a deferral past one 2500-slot drain; `mergeEqual` applies it per implicit position at
  every tail head (`mergedAt`), in `barrier()` (`barrierRows`), in `order()` (`mergedOrder`, dense-ranked so
  a merged slot stays one traverser) and at a barrier-arm branch start (`armStartMerge`). The syntactic
  `referenceMergeObservableAt`/`byTiesEveryTraverser`/`orderReadBeforeErased` are deleted. **Refuted at the
  pin:** "`local` diverges on a merged slot" — `LocalStep.nextStart` splits a slot into units
  (`LocalStep.java:80-88`), so `g.V().out().local(both().limit(1)).count()` is 6, not 4; `OptionalStep` does
  forward bulk, and a bulk-nonlinear `optional` body after a possible merge declines (`bulkForwardingDiverges`).
  Residue: `'unknown'` positions (labels, a body unrolled past the strategy, a `RepeatStep`'s re-entry) leave
  the order unmerged unless the superset places a merge under a reader (`mayMergeAt` — then decline).
  ✅ **r2 (wf7/substrate-bulking-positions-r2):** `EarlyLimitStrategy` (a prior of `LazyBarrierStrategy`) is now
  applied over EVERY always-bound `MapStep` run, not only a side-effect one (`ir/early-limit.ts`, movable set
  per `StepOutputArityPredictor` — `inV`/`outV` dropped, `project`/`count(local)`/`map(always-bound)` added),
  so `….id().limit(n)` and `….limit(n).id()` are one chain and merge alike (a moved `RangeGlobalStep` is a
  `Barrier`, so no `NoOpBarrierStep` precedes it). **Refuted at the pin:** "a slice right after the second
  flat-map must see that flat-map's merge" — `RangeGlobalStepContract` is a `FilteringBarrier`, so the
  strategy places none there (`LazyBarrierStrategy.java:117-120`). Child traversals merge at their own
  positions (`DefaultTraversal.java:144-148`) with a single-traverser start tracked through the scan; a
  slice over a child stream with no emission order declines; the merge window's raise is a DEFERRAL
  (`deferralExpr`), which an unread side-effect drain does not force.
  ✅ **r3 (wf7/substrate-bulking-positions-r3):** a merge never reads a BRANCH's emission order, which is not
  the reference's until B lands. ONE authority, `branchOrderedAt`/`branchOrderedAfter` (`ir/bulk.ts` — a
  `union`/`choose`/`coalesce`/`optional`/`branch` at this level or in a child that streams it, at any depth;
  an arm inherits its host's side through `ChainCtx.branchOrderedInput`/`branchOrderedOutput`), asked in ONE
  place, `mergeEqual` (`readsBranchOrder`). Behind a branch: an implicit merge raises a deferral on every row it
  would MOVE (`regroupFirstOccurrence` window 0) and leaves a stream with no equal traversers as the branch
  emitted it; an explicit `barrier()` declines on either side of a branch; a stable `order()` merges equal
  traversers freely and raises only where a key group holds two DIFFERENT traversers (`guardTies`, build.ts) —
  so `union(out(),in()).order().by('name')` still answers. Witnesses (reviewer, all declining on trunk):
  `V(1).union(constant(9),constant(5),constant(9)).barrier().fold()` and its `order().by(constant(0))`,
  `local(…)`, `inject(1)`, `out().union(out(),identity())`, `flatMap(union(…))`, `union(out().out(),out())`
  forms, `inject(3,2,3,1).order().by(constant(0)).union(identity()).fold()`,
  `inject(9,5,9).union(identity().barrier()).fold()`. Residue, B's and pre-existing on trunk: an order() over
  a DISTINCT branch stream (`union(…).dedup().order().by(constant(0))`) and a keyed `dedup().by(x)` still read
  the branch order.
  ✅ **r4–r6 + whole item ON TRUNK 2026-10-17 (`9b8e878b..8f561d0a`):** the merge keys on the reference's TYPED
  equality (`typedEquality`, build.ts — storage class + zero sign; `AbstractTraverser.java:185-188`), an
  unmergeable `withSack(seed)` merges nothing (`mergesNothing`); a collection keeps `-0.0`/a whole Double
  (`src/json-exact.ts` spelling rule) and a map merges by `mapIdentity` (no entry order); a merged branch frames
  by the column it projects (`mergeArms`) and a NULL per-row tag reads the value at every subject
  (`perRowSubject`, predicate.ts). Residue stays indexed in `docs/outstanding-work.md` (TraverserSet merge).
- ✅ **B — the branch emission key.** Authority: `step/branch/BranchStep.java` (traverser-major/arm-minor
  without a barrier, arm-major with one), `step/branch/LocalStep.java` + `util/TraversalUtil.java` `applyAll`
  (arm-major is PER PARENT), `step/map/CoalesceStep.java`. Seam: `src/compiler/rel/lower.ts` `branchResult`
  (positionless fallback when `!ctx.ordered`), `sliceableBranch` (no key stack), `tagArm` (DROPS the arm's own
  encounter), `mintTraverserMajor`. Design: ONE `EmissionKey` stack as `origin`-role channels
  `[parent_1…parent_k, arm, armEncounter]` — `augmentParent` pushes a level, `tagArm` keeps the arm encounter,
  arm-major is only a different key order inside the innermost per-traverser scope, a slice demand forces
  `ordered`, and a branch that cannot mint DECLINES rather than taking the positionless fallback. Replaces
  `withFanoutOrder`, `branchOrder`/`mintOrdered`, `branchMajor` and the `sliceDownstream` marks. Stopgap:
  `branchResult` returns `null` when sliced and not sliceable; decline an arm that carries an encounter in
  `tagArm`'s callers. Size: L, ~300–500 LOC. Depends on A (first-occurrence key).
  ✅ **Stopgap LANDED (`9b1e80e9`):** `tagArmPositioned` keeps the arm's own encounter as a third key (an arm
  with no position declines); any step list holding a positional slice raises `sliced` (`chainDemandsSlice`),
  and `branchResult` declines a sliced merge before its positionless case.
  ✅ **EmissionKey stack LANDED ON TRUNK 2026-10-17 (`55a175a6`, fix-forward `2e917115`).** ONE authority in
  `rel/lower.ts`: `branchOrderOwed` (does any reader read the order) + `BranchKeys` (`bord_p/a/s`, stacked by
  depth) + `mintBranchOrder` (traverser-major, or arm-major per `armMajorScope` when an option holds a barrier,
  `BranchStep.java:87-88,123-158`); replaces `withFanoutOrder`/`branchResult`/`sliceableBranch`/
  `tagArmPositioned`/`mintTraverserMajor` and deletes the BRANCH_ORDER_READ stopgaps. Fix-forward: an
  argument-less count renders `count(1)` over any derived table (`countArgument`, `src/rel/emit.ts`) — SQLite's
  countOfViewOptimization miscounts a correlated nested UNION ALL; a correlated merged sort goes unfenced.
  L3 1871 -> 1873. Residue: cap() BulkSet member grouping (outstanding-work.md, collection substrate).
  ✅ **Arm fold order LANDED ON TRUNK 2026-10-17 (`44039caa`, ff-union-arm-fold).** A fold inside a branch arm
  reads the branch INPUT's order, never its own content sort (`BranchStep.java:143-153`, `FoldStep` keeps arrival
  order): ONE predicate `armCollectsInOrder` (`ir/analyze.ts`) seeds the source encounter in
  `computeDemandsEncounter` and makes `emissionSource` (union/choose/option) require a positioned input or
  DECLINE. Pinned in `test/L4-addendum/branch-arm-collect-order.feature`; no baseline moved.
- 🚧 **C — the number/type channel.** Authority: `util/GremlinValueComparator.java` (Number is one rung,
  compared by `NumberHelper.compare`), `util/NumberHelper.java` `performConversion` (throws on an infinite or
  out-of-range double), `SumGlobalStep` / `MaxGlobalStep` / `MeanGlobalStep`, `Max.feature`'s `d[1.0].d`.
  Seams (each fails OPEN today): `rel/orderability.ts` `kindOf` (a `{t:null}` node → `unknown` → silent tie —
  fix: `t == null` means `kindOf(v)`, and `unknown` throws `CoercionDeferral`); `rel/reducer.ts` `eligible()`
  (by storage class, so a wide long held as TEXT is dropped — route through `storedCompareOn(vtype)` or
  decline); `asNumberOverflowGuard` (integers only — decline a floating source or guard per `NumberHelper`'s
  messages); `write.ts`'s runtime property insert writing `NULL AS vt` (carry the source vtype, §6·7); the
  coalesce/flatMap arm-type merge stamping one arm's static tag onto another (apply the §6·7 lattice). Design:
  ONE total `numericClassOf(vtypeExpr, valueExpr)` for reducer eligibility, reducer result type, orderability
  and casts. Policy DECIDED (§6·7, 2026-10-17): the class is exact — build the full authority. Size: stopgaps S
  (~60 LOC); full authority M (~300 LOC).
  ✅ **Stopgap LANDED 2026-10-17 (`56473649`, `f7b964cb`, `a34c4df6`):** every seam above fails closed —
  `kindOf` throws on `unknown`, reducer eligibility no longer drops a TEXT-held wide long, a write carries
  the source vtype, and a reducer's known long class rides beside `result:'number'`. Predicates compare
  in the reference common class (`predicate.ts` `numericPair`, per `NumberHelper.compare`); `asNumber` is a
  WHERE fence (`transform.ts` `asNumberFilter`) so it raises at every existence depth, and its constant
  fold is `NumberHelper.performConversion` (`coerce.ts`). Pinned in
  `test/compiler/number-class-fail-closed.exec.test.ts`. The FULL one-`numericClassOf` authority is still open (policy now decided: exact).
  ✅ **Full authority LANDED ON TRUNK 2026-10-17 (`6415964a`, substrate-number-class).** One class authority
  (`reducer.ts` `numberWidth`/`numberFloating` → `commonNumberClass`) at every depth; a Float rides as its exact
  value (`src/gremlin/float.ts`, `src/compiler/rel/float.ts`); one BigDecimal carrier (`bigDecimalOfCarrier`);
  an uncarriable literal declines (`ir/uncarried-literal.ts`); a Double outside SQLite's correctly-rounded range
  defers (`src/rel/exact-decimal.ts`); a 16-17-digit literal crosses JSON exactly at `jsonEntry` (`rel/emit.ts`).
  Pinned in `test/compiler/number-class-authority.exec.test.ts`, `number-class-type-space.exec.test.ts`,
  `test/L4-addendum/number-carrier.feature`. Residue: `docs/outstanding-work.md` (Value carriage).
  ✅ **Rebound-label + variant scalar class LANDED ON TRUNK 2026-10-17 (`bdacf917`..`7d8ce995`,
  ff-alias-rebind-class).** A rebound label keeps every entry's own class: `joinAliasEntry`
  (`src/compiler/alias.ts`) is the ONE join for rebind and branch merge (a disagreeing scalar class →
  PER_ROW_ENVELOPE, each entry framed by its own `t`; a disagreeing list/map descriptor goes absent and
  readers decline; `binds`/`pathPos` kept only where arms agree). A shape-mixed branch's variant carries each
  scalar arm's own class in one per-row `vkt` column (`variantArm`/`variantScalarType`, framed through ONE
  `typedValueBuffer`) instead of value inference; an envelope-carried per-row scalar declines. Reference:
  `Scoping.getScopeValue`/`Path.get(Pop, label)`, `step/branch/BranchStep.java`. Pinned in
  `test/compiler/alias-rebind-class.exec.test.ts`, `variant-scalar-class.exec.test.ts`. No baseline moved.
- ✅ **D — a null first result vs an absent one (productivity).** Authority: `util/TraversalUtil.java`
  `produce` (a null `next()` IS productive), `util/TraversalProduct.java`, `ProjectStep`, `TraversalMapStep`,
  `GroupStep`/`Grouping.doFinalReduction` (pools keep null traversers). Seam: `src/compiler/rel/child.ts`
  `ChildValue.present` is OPTIONAL ("absent means cannot say") — exactly the optional-field defect generator
  §6·7 names. Design: `present: Expr | 'unknown'`, REQUIRED; a consumer needing presence declines on
  `'unknown'`, so `correlatedFirst`, `reductionTail` and `pooledRegroup` stop at a type error until they carry
  presence apart from the payload; fold/group pools aggregate `{t,v}` nodes and never filter `v IS NULL`.
  Stopgap: decline a fold/pool over a body whose members may be null (null constant, collection literal with a
  null, null-literal `coalesce`/`union` arms). Size: M, ~200 LOC, mostly typing churn.
  ✅ **Stopgap LANDED 2026-10-17 (`888affc3`):** `mayYieldNull` (`ir/strategies.ts`, a predicate on the total
  walker `ir/walk.ts`) — a group value by() whose body may yield a null (null-holding `constant`/`inject`
  literal at any depth) declines.
  ✅ **Required `present` LANDED 2026-10-17 (`2b0b1e27`):** `ChildValue.present: Expr | 'unknown'` is
  REQUIRED (`rel/child.ts`, one decline authority `knownPresence`, one `casePresence`); pooled regroup decides
  a member's outer NULL by presence (`producedMemberNode`), so a productive null is a pool member; the
  `mayYieldNull` stopgap is removed; `coalesce()` as a child value is a CASE on arm presence. Open residue:
  order()/dedup()/groupCount() by()-KEY productivity still reads the key's nullness (`productivityFilter`) —
  `g.inject([null,1]).order().by(unfold())` answers `[]`; the key consumers must read byTyped's presence.
  ✅ **Required-present fix-forward LANDED 2026-10-17 (`da957253`..`3275d454`):** the residue above is closed —
  `productivityFilter(step, present)` (`rel/modulator.ts`) is the ONE by()-productivity drop authority (decline on
  'unknown'), and order/dedup/sack/aggregate/where/group/project/select all route through it; group value
  barriers pool per key or decline; a record's map states its value side at one authority (`RecordField.presentCol`);
  an absent map key falls through to the side effect / path label of the same name (every map-scope reader
  declines or raises); a reducer's null seed reaches every container as null (`asExactReal`, `sumBuffer`).
  ✅ **Mean-null tag + typed equality LANDED ON TRUNK 2026-10-17 (`03eefba2`..`e56e9352`, ff-mean-null-tag).**
  An all-null `mean()` is a NULL tagged at its producer (`typeof(<mean>)`, `rel/reducer.ts`, `list.ts`), so
  `math()` raises (`MathStep.java:72-88`); `within`/`without` hold a null member (`predicate.ts`, null-safe
  `IS NOT 1`); dedup, the list set ops, label-/by()-keyed dedup and group keys all key on TYPED equality at ONE
  authority — `typedEquality`/`valueClass`/`classedKey`/`classedNode` (`rel/build.ts`), the class normalized as
  `coalesce(reducedVtype(tag), inferredVtype(v))` (`DedupGlobalStep.java:74-88`); a floating-tagged value enters
  JSON as `CAST(v AS REAL)` (`asExactReal`); a child subject reads a NULL per-row tag via `perRowSubject`.
  Pinned in `test/compiler/typed-equality-sites.exec.test.ts` and `test/L4-addendum/null-membership-typed-sets.feature`.
- 🚧 **E — per-row runtime raises and evaluation extent.** Authority: `step/map/MathStep.java`,
  `ToUpperGlobalStep` / `ConcatStep` (`IllegalArgumentException`), `RangeGlobalStep` (stops pulling at high)
  vs `CollectingBarrierStep` (drains everything), `NumberHelper` (`/ by zero`, overflow). Seam: THREE
  competing mechanisms — `Binding.guard` (`src/rel/plan.ts`; right for §6·5 graph-dependent refusals, wrong
  for per-row value errors: blind to correlated scopes, re-evaluates randomness), `raiseExpr`
  (`src/rel/raise.ts`; extent is whatever SQLite evaluates), and per-host guards (`asNumberOverflowGuard`, the
  asString guard, `localStringMemberGuard`). Design: a `raise` CHANNEL ROLE declared in `CHANNEL_GROUP_POLICY`
  + `obligations.ts` — streaming nodes PRESERVE it per row (a Filter reading a raising value keeps the row,
  raised), barrier nodes ESCALATE it (`MAX(raise)`/window), `ChildValue` carries `raise` beside
  `value`/`present`, and the executor's framing loop (`src/execute.ts`, before `frameValue`) throws
  `RaisedByQuery` on the first framed raised row — so a root `limit(1)` never frames it and an `order()`
  escalates, exact by construction. `raiseExpr` remains only for a recursive-term accumulator, `Binding.guard`
  only for §6·5; `raiseGuard`/`rowGuard` and the advisory flag are deleted. Stopgap: ONE `receiverProvably(kind)`
  at the step→Rel dispatch for `math`/`toUpper`/`toLower`/`trim`/`concat`/`asString`/`asNumber` (vtype meet +
  `ChainCtx` nesting), measured against L3 first (declining math over a numeric property regressed L3/L4 —
  if so, decline only a known-non-numeric or `unknown` tag). Size: M–L, ~400 LOC.
  ✅ **Stopgap LANDED 2026-10-17 (`888affc3`, `eeb0e667`):** ONE receiver authority `src/compiler/rel/receiver.ts`
  (`receiverProvably` → proven/refuted/runtime): a refuted static receiver declines, a per-row one raises the
  reference's message in-row (`raiseInRow`); asked at the scalar transform dispatch (root fold + child value run,
  so every depth) and per math variable; math `/`,`%` raise "Division by zero!"; a filtered-out child value is
  unproductive to the checks; concat's traversal operand is type-checked. L3 unchanged. The `raise` channel role
  (full design) is still open.
  ✅ **Consolidation LANDED 2026-10-17 (`wf6/substrate-raise-channel-r1`):** the per-row VALUE raises of the scalar
  fold and the list member ops are ONE in-statement form — `raisingRows`/`projectRaising` (`lower.ts`) and
  `raisingMembers` (`list.ts`), all fed by the receiver authority's offences. The five value-error
  `Binding.guard` builders (`concatEmptyGuard`, `asStringNullGuard`, `asNumberOverflowGuard`,
  `localStringMemberGuard`, `asStringNullMemberGuard`) are deleted; `Binding.guard` is left to §6·5 refusals
  and the `drainRaisingSite` drain. The verifier's remaining wrong answers were EVIDENCE reachability, not a
  missing substrate: a scalar host dropped its static tag (`hostTag`, `child.ts`, now the one carrier), the root
  receiver evidence ignored a mixed `inject`'s `vt` tag, and `asString` rendered by storage class — now
  `asStringOf` (`receiver.ts`, `String.valueOf` by Java type: Boolean `true`/`false`, a Double only where
  SQLite's text is `Double.toString`, else a deferral). A bare list literal with a Boolean member declines.
  **Measured against the channel design before building it:** its claim "a root `limit(1)` never frames the
  raising row, exact by construction" is NOT the reference — `RangeGlobalStep.filter` only learns it is past
  `high` on the NEXT pull (`step/filter/RangeGlobalStep.java:72-82`), so the upstream map raises on traverser
  n+1 (`g.inject('a', 1).toUpper().limit(1)` raises). Exact extent is "evaluate n+1 under a slice", which the
  in-statement WHERE already gets wherever the chain is ordered (the `ORDER BY` evaluates every row). A
  physical `raise` column through ~900 node-construction sites is therefore not the next step; an
  unordered-chain slice over a raising input evaluating n+1 is.
  ✅ **The `raise` channel LANDED 2026-10-17 (`wf7/substrate-raise-channel-r1`), SPAN-SCOPED, not plan-wide:**
  the eager row predicate over-raised under a slice — `g.V().order().by(label,desc).where(__.values('age')
  .toUpper().fold()).limit(1)` raised on marko where the reference answers `[lop]` (the `ORDER BY` evaluates
  every row's `WHERE`, but the reference pulls only n+1). `src/compiler/rel/raise-channel.ts` is the one
  authority: a raise source (`raisingRows`'s transforms, the sack fold, a filter host's child value) DEFERS
  only where `defersRaise` proves the span — through a run of filters (`hostFilter` keeps a raising row) to a
  HEAD slice, which settles the message over exactly the n+1 rows the reference pulls (`pulledBy`) and then
  takes its n; or, in a child body whose host takes the raise as data, to the terminal reducing barrier,
  which ESCALATES it into `ChildValue.raise` (`correlatedReduce`, `valueRun`, the `and`/`or` arms gated by
  the arms before them). Everywhere else the source settles eagerly as before — but only where that is exact
  (`settlesExactly`: a draining barrier, or no bounded slice, after it); a raise that would be settled eagerly
  ahead of a bounded slice behind a streaming non-filter step (`dedup()`, a movement) DECLINES. The sack's
  always-present overflow offences make that rule decline `sack(op).by(…).out().limit(n)`; the census and L3
  are unchanged by it. The channel never reaches framing, so the executor needs no throw;
  `raiseContained` refuses (declines) any plan in which a raising relation is read by anything but a vetted
  carrier or a consumer, so a dropped raise cannot become an answer. A filter host whose clause still raises
  eagerly before a head slice (a movement-headed `where(__.out()…toUpper().fold())`) DECLINES. Also: a NaN
  literal the sack may fold declines (`ir/sack-nan.ts`), and a list-local reducer's own deferral is evaluated
  under an existence-only tail (`values('name').fold().sum(local).count()` raises).
  ✅ **Round 2 (`wf7/substrate-raise-channel-r2`): exactness is a property of the PULL, at every depth.** The
  r1 rules looked only at a source's own step list, so a body's raise settled eagerly under a slice AFTER its
  host (`optional(where(…toUpper().fold())).limit(1)`, a `choose` arm, a `project().by(…)`), and a head slice
  assumed `n + 1` even when a later slice stopped pulling first (`limit(2).limit(1)` pulls 2). Now
  `ChainCtx.pull` marks every step a tail folds (`pullAt`), and a list's `PullLevel` (`reached` / `drained`)
  is derived from its HOST's position, so `settlesExactly` answers through every enclosing host to the root.
  `pullExtent` composes a RUN of `limit`/`range`/`skip` from its far end (asked `k` times a `range(lo, hi)`
  pulls `min(lo + k, hi + 1)`), and is `null` where a filter between two slices makes it data-dependent. ONE
  generic check, `raisesWherePulled`, runs at every step boundary (and at every tail handoff): an in-statement
  raise a step minted — a projector's, a list-local reducer's, a child value's own at any depth — declines
  unless the reference pulls every row reaching that step. That also closes the silent UNDER-raise: SQLite
  evaluates a select-list raise only for the rows a `LIMIT` returns (measured: `VALUES (1),('a')` with a
  raising `CASE` and `LIMIT 1` answers `[2]`), while the reference pulls one more and raises; `math()` now
  defers through the channel like the transform family (`inject(1, 2, 'a').math('_+1').limit(1)` is `[2.0]`,
  `limit(2)` raises). The compile-time coercion fold over `inject()` casts only the values a slice run after it
  pulls (`inject('1','2','x').asNumber().limit(1)` is `[1]`), and elsewhere raises only where the reference
  casts the offending value (`foldRaiseMet`), else declines; a `dateAdd`/`dateDiff` subject is checked per
  value. A raise inside a branch arm or an `optional()`/`local()` body under a slice after
  the host still DECLINES: carrying it out of the host's merge is the next increment. `LazyBarrierStrategy`'s
  `NoOpBarrierStep`s are deliberately not drains (a barrier holds at most 2500 traversers, so what it pulls
  ahead depends on the data), which is why `sack(sum).by('age').out().limit(1)` declines.
  ✅ **Rounds 1–2 + per-start extent LANDED ON TRUNK 2026-10-17 (`af39d584`..`0d20446d`).** Last increment:
  `union` is NOT a lazy per-start body host (`LAZY_BODY_HOSTS`, `raise-channel.ts`) — `BranchStep` never
  resets its child, so a body slice's pull count is data-dependent (`step/branch/BranchStep.java`); a raise
  before a `union()`-body slice now declines (pinned in `test/L4-addendum/raise-extent.feature`). Census and
  L3 unchanged. Open: carrying a raise out of a branch arm / `optional()` / `local()` merge under a later slice.
  ✅ **Residue LANDED ON TRUNK 2026-10-17 (`305af651`).** A zero-width global slice/tail over a pending
  raise or `raiseExpr` arm declines at `sliceRows` (the one slice builder, every depth) — the reference still
  pulls `low + 1` starts (`step/filter/RangeGlobalStep.java`, `FilterStep.processNextStart`), SQLite evaluates
  nothing under `LIMIT 0`; a mutating value-argument child raises `ReadOnlyChildValidator`'s text; federate's
  param validation throws `UnsupportedTraversal`. Double ±Infinity verified correct (pinned). No baseline moved.
  ✅ **Raise-residue 2 LANDED ON TRUNK 2026-10-17 (`aeaba8bb`).** A filter after a raising step is met in
  written order at ONE authority — the emitter fuses it as an ordered CASE term (`conjoinInOrder`, `src/rel/emit.ts`)
  and fences a raising CTE `AS MATERIALIZED`; `raiseOrdered` (raise-channel.ts) declines what that cannot reach
  (beneath an explode / in a union arm / a constant predicate). `filterRankingMoves` models
  `FilterRankingStrategy.java` and declines a raising filter the strategy would move (24 raise-extent scenarios
  behind `order()` now @Unsupported). property() mutating children raise `VerificationException`
  (`StandardVerificationStrategy.java:87-101`); no bare Error on a user path (services, federate); ±Infinity in
  collections spelled `9.0e+999`. Baseline moved: sql-hygiene bytes (the fence itself).
  ✅ **Error-surface residue LANDED ON TRUNK 2026-10-17 (`b55a5de8`..`609ffe12`, ff-error-surface).** Every
  user-reachable failure is `UnsupportedTraversal` / the reference's own text / a data-decided raise, never a
  raw JS/SQLite/bare Error: a NaN element id honours `constLit`'s decline at its one site (`source.ts`);
  `asNumber()` parses via the `isCreatable`/`createNumber` port and a non-finite → BIGDECIMAL declines
  (`coerce.ts`, `transform.ts`); ±Infinity prints `Infinity` at the one `floatingText` authority; `regex()` is
  read in Java's `Pattern` dialect (`regex.ts` `javaPatternAsJs`; a construct the dialects read differently
  declines; an escape reads a whole code point) and the trigram prefilter never reads a group or half an
  escape as a mandatory run. Pinned in `test/error-surface.test.ts` + the randomized differential in
  `test/regex.test.ts`. Baseline moved: sql-hygiene bytes (run-time NaN/infinity guard, Infinity arms).
- 🚧 **F — writes interleave one traverser at a time.** Authority: `step/map/MergeVertexStep.java` /
  `MergeEdgeStep.java` (one flatMap per traverser: search, then onMatch or add),
  `step/sideEffect/AddPropertyStep.java`, `AddLabelStep`, `LazyBarrierStrategy.java` (a small `V(ids)` gets no
  barrier, so writes stay interleaved). Seam: `src/compiler/rel/write.ts` `elementMergeV` binds `matched` once
  BEFORE any create; `sequentialGuard` counts `site.host` rows, not the stream at the upstream writer. Design
  (set-based, inside P5): partition drivers by match key, rank by `ord` — rank one with no pre-existing match
  creates, every other driver MATCHES (including the rank-one creation), a constant onMatch is idempotent per
  key, a runtime onMatch declines until last-writer-by-`ord` exists; `ProgramWrites` records each writer's
  INPUT STREAM and the guard counts traversers at every writer the body can observe, so "a truncating step
  between writer and site" becomes a property of that count. Stopgap: decline a multi-row creating merge with
  an onMatch arm or match-dependent tail; `sequentialGuard` refuses a non-single-row upstream writer via ONE
  `isOneRowSeed` shared with `writeSnapshot` (unifying the duplicated checks). Size: stopgap S; full M, ~300 LOC.
  ✅ **Slice/endpoint stopgap LANDED 2026-10-17 (`b9595f52`):** `EarlyLimitStrategy` performed where a slice crosses a
  side effect (`src/compiler/ir/early-limit.ts`), and where it cannot move the slice the write DECLINES
  (`ProgramWrites.truncated`, `src/compiler/rel/write.ts`, enumerating values through `ir/walk.ts`); an `addE`
  endpoint runs the `property(k, <traversal>)` race guard, a literal-id source gets a program-start existence
  pre-check (`ProgramWrites.preChecks`); `sum` keeps the reference number class. The per-traverser write driver
  (full design above) is still open.
  ✅ **Keyed side effect run per traverser behind a slice LANDED 2026-10-17 (`ffca8f77`):** `local`/`map`/`flatMap`
  (`__.aggregate('a')`) spliced by `inlineIdentityHostBody`, then sliced, answered the full collection;
  `ProgramWrites.truncated` now counts a KEYED side-effect collector (`collectsSideEffect`: aggregate, keyed
  group/groupCount/tree, subgraph) as a side effect at every depth, and `ir/early-limit.ts` no longer moves a
  slice past a spliced step (`step/branch/LocalStep.java`, `step/filter/RangeGlobalStep.java:72-82`). Declines
  pinned in `test/L4-addendum/early-limit-side-effect.feature`.
  ✅ **Lazy read of a collection still filling + correlated collector LANDED 2026-10-17 (`103d6cbe`,
  ff-collector-reads):** `programWrites` (`rel/write.ts`) tracks keys still FILLING per traverser (a
  per-traverser host body, a spliced collector over >1 traverser, what a global child leaves pending; a drain
  clears them) and a Scoping read of one at any depth (`step/Scoping.java:120-135`) sets `truncated` and
  declines; `rel/collection.ts` declines a collector registration whose site has a free relation id (was the
  internal "no relation 'src0' is in scope"). Decline-only; pinned in
  `test/L4-addendum/side-effect-lazy-read.feature`.
- ✅ **G — label scope into nested arms; internal errors past the decline contract.** Authority:
  `step/util/Scoping.java` + `TraversalSelectStep` (a local child keeps the parent path),
  `strategy/optimization/IdentityRemovalStrategy.java` (copyLabels). Seams: the union arm merge (`mergeArms`
  via `lower/branch.ts`) must compare arm column/channel sets and return `null` instead of leaving
  `src/rel/check.ts`'s invariant to throw an internal error; a scope read (`select`, `where(as)`, `path`) in an
  arm lacking the parent's alias channel declines (full fix: thread alias channels through `childSeam`); ONE IR
  walker — `someStepDeep` (`ir/strategies.ts`) walks only `args`, and `nondeterministic` (`ranked-order.ts`),
  `lowerRankHead`'s `MUTATING_STEPS`, the `write.ts` arg walkers and the `labels.ts` walkers each re-implement
  it; make it total over every IR child position (args, modulators, `repeatRegion`, `optionArms`) and route
  all of them through it (fixes the `order().by(addV…)` leak); `mergeStepLabels` (`ir/passes.ts`) folds labels
  as IdentityRemovalStrategy does. Size: S–M, ~200 LOC. Do this FIRST — cheap, and every later branch re-trips it.
  ✅ LANDED 2026-10-17 (`1ad88ccf`, `fec9e97c`): ONE total walker `src/compiler/ir/walk.ts` (`eachChildChain` over
  args incl. predicate operands/maps, modulators, with() options, repeatRegion/optionArms; callers choose
  `ChildPositions`) with `someStepDeep`/`nondeterministic`/`lowerRankHead`/write/label walkers routed through it
  (`order().by(addV…)` now declines); a scope read of a hidden host label declines; `mergeStepLabels` seeds a
  branch body with the host's path entry; federate fails closed at every seam (`test/support/fail-closed.ts` is
  the positive no-internal-error contract). Residue: threading alias channels through `childSeam` (the full fix)
  is still open.
  ✅ Fix-forward LANDED 2026-10-17 (`08dac561`, `7f2d7835`): path entries follow the reference split
  (`map`/`flatMap(identity())` open an entry; `union`/`optional`/`choose`/`local` do not — label set is the
  arm intersection); ONE `writesAnywhere` authority consulted by `lowerRankHead` and `scalarChild`, so a write
  in any correlated child value declines; a federated sibling's collapsed (element, bulk) row lands `bulk`
  times (`runForeign` was dropping it — `fold().count(local)` over landed elements counted distinct).
- 🚧 **H — reference strategy/step facts copied by hand.** emit-first `times(n)` unroll drops the last level
  (`step/branch/RepeatStep.java` RepeatEndStep emits on `doUntil`; seam `tryUnroll` in `ir/strategies.ts` —
  emit it or decline emit-first; check `l3-state.json` for `g_V_emit_repeatXoutX_timesX2X_path`) — ✅ LANDED
  2026-10-17 (`eaf3093c`..`91689dab`): a bounded emit unroll emits exactly the reference levels, a
  cross-iteration dedup body declines (its empty-past-level-1 exception admits only GLOBAL-scope steps), a body
  side effect is written once (the level-n double doubles the arm's OUTPUT), and multi-arm emit / walk
  side-effect bodies decline; pinned in `test/L4-addendum/repeat-times-emit-levels.feature`;
  `fold([], addAll)` treated as `fold()` (`dsl/graph/GraphTraversal.java` / `util/function/ConstantSupplier.java`
  / `ReducingBarrierStep.java` — the seed is shared, so the identity holds only where the fold runs once;
  seam `PLAIN_FOLD` in `rel/operator.ts`; decline a mutable seed in a per-traverser child); keyed
  `groupCount('a')` treated as a movable side effect (`SideEffectBarrierStep.java`, `EarlyLimitStrategy.java`;
  branch-only `ir/early-limit.ts` — drop KEYED from `movable`). Design: one table per reference strategy in
  `ir/` (the `bulk.ts` pattern), each row citing its vendor line, so review checks a table not a code path.

**Ordering.**

| Step | Substrate | Size | Why here |
|---|---|---|---|
| 0 | Trunk stopgap declines: A slice/barrier, B `branchResult`+`tagArm`, C `kindOf`/eligibility/asNumber-fp/`vt` carry, D null-pool, E `receiverProvably`, F merge/guard single-row, G arm-column decline + total `someStepDeep`, H unroll + `PLAIN_FOLD` | S–M total | removes every confirmed trunk wrong answer; L3 only moves DOWN where a wrong pass declines |
| 1 | ✅ G — one IR walker, arm column decline, alias into arms (landed `1ad88ccf`/`fec9e97c`; alias-channel threading open) | S–M | cheapest; every later branch re-trips it |
| 2 | ✅ C — number-class authority (landed `6415964a`) | M | `asNumber`, orderability, reducers are all consumers |
| 3 | E — the `raise` channel role | M–L | replaces three mechanisms; unblocks four branches |
| 4 | ✅ D — required `present` (landed `2b0b1e27`; fix-forward `da957253`..`3275d454`) | M | small once E adds the third `ChildValue` field in the same pass |
| 5 | A — `bulkingPositions` + `regroupFirstOccurrence` | L | the biggest unlock |
| 6 | ✅ B — the `EmissionKey` stack (landed `55a175a6`; fix-forward `2e917115`) | L | needs A |
| 7 | F — set-based merge interleave + writer-stream guard | M | independent; can run alongside 3–6 |

**Per parked branch — resume or rebuild** (all tips fork from `2c3000b2`).

| Item (tip) | Clusters | Verdict |
|---|---|---|
| `write-property-guard` (`79e8dfbb`) | H, F | **RESUME now** — drop KEYED from `movable`/`SIDE_EFFECTS` in `ir/early-limit.ts`, restore `writes.exec.test.ts` and `L4-addendum/property-traversal-site.feature` to the trunk answer, accept `fold` as a drain in `ProgramWrites.truncated` |
| `alias-select-residue` (`70fc8270`) | G, C, E, A | **RESUME after G + C** — the open major is one predicate (decline `asNumber` over an fp/math source, or raise per `NumberHelper`); its `select(Traversal)` lowering is safe once G declines nested-arm scope reads; drop its advisory math guard once E lands |
| `fanout-by-first` (`0e613e5b`) | A, E, D | **RESUME after A**, deleting `tiesProjectAlike`; PROMOTE its `src/rel/raise.ts` fence + `holdsLazyRaise` into E; `pooledRegroup` adopts D's required presence |
| `seeded-fold-aliasing` (`1133e148`) | A, B, E, H | **SPLIT** — land the ConstantSupplier aliasing decline (H) now; REBUILD `branchOrder`/`mintOrdered` on A+B; `stringReceiverGuard` folds into E |
| `branch-residue` (`2f93b271`) | B, E, H | **REBUILD** the slice/branch parts on B (`sliceDownstream`/`tagArm` are what B replaces); DISCARD `raiseGuard`/`rowGuard` (a second raise substrate that evaluates random input twice); salvage the EarlyLimit/identity math-liveness pieces as E consumers |
| `union-columns-deferral` (`26dc3cac`) | B, A | **REBUILD on B** — its content is a branch-order policy (`branchMajor`) carrying regressions against trunk; keep only its recursive barrier-in-arm DETECTION as an input to `bulkingPositions` |

Trunk-landed items with open audit wrong answers fall into the same clusters and are fixed through step 0, not
through branches: mergeE/mergeV onMatch (`55a47cd8`) → F; ranked-order `{t:null}` keys and wide-long union sum
(`2c3000b2`) → C; the `order().by(addV)` internal error (`2c3000b2`) → G; `PLAIN_FOLD` aliasing (`314bbb86`) → H;
`sequentialGuard` upstream writer and the max/mean stored type (`7a18f7ca`–`423e4b84`) → F, C.

---

## §11. Open design decisions

Live ones sit beside the work they gate — §10's three-answer label coercion, and §9's
unbounded-plus-barrier wall.

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
