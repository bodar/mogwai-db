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
option-keyed `choose(<projection>)` where the choice is a body rather
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


### Next round (from the 2026-11-03 sixth round — read before picking items)

Landed this round, each on trunk after an unpiped `mise run ci` that printed "CI passed", and green on GitHub CI
(runs 41549372469, 41557271336, 41542415028, 41558831375, 41548206239):
- `7f3a5996`, `c682a953`: onCreate `null` override (fourth-round follow-up 2). `c682a953` is a test-only L5 oracle fix:
  a window nested in a step argument has an undetermined count once the enclosing step is followed.
- `c9b06ee8`, `c16d4b52`: S8, `rowBounds`.
- `4edf3f20`, `745e65ef`, `0200909d`: one `ParamEnv` (fifth-round follow-up 3, reuse 1–3) and UUID-bound text equality.
- `4d6be2a9`, `2b02dbf8`, `17fa6316`: S10, the merge search seeks.
- `c4b1f4ef`, `22e3293d`, `839fbd1f`, `9e0d5ab1`: per-traverser `sample()` over a rooted body (fifth-round follow-up 1).

**PARKED — S9 re-land (ONE per-row Scoping reader). Resume point: branch `wf/s9-one-scoping-reader-reland-1-4`
(`e2c0704f`, series `4db1411c..e2c0704f` on merge-base `bea020a3`, NOT on trunk). The older resume point
`wf/s9-one-scoping-reader-4-4` is superseded by it.** Two things block it.
- **BLOCKER (reproduced): `math(…).by(__.select(k))` now RAISES where the row lacks `k` and no side effect is named
  `k`.** The error is "The variable _ for math() step must resolve to a Number". The reference FILTERS that row:
  `SelectOneStep.java:65,71-72` returns an EmptyTraverser, and `MathStep` drops a traverser whose variable is
  unproductive. It throws only for a productive non-Number. Paths are under
  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/`.
  Witnesses (modern):
  - `g.V().project('x').by('age').math('_ + 1').by(select('x'))`: trunk [30,28,33,36]; it raises at `e2c0704f`.
  - the `project('x','n')`, `local(…).count()` [4] and `union(…, constant(0)).count()` [10] twins: same failure.
  - `g.V().elementMap('age').math('_ + 1').by(select('age'))`: declined on trunk, raises at `e2c0704f`; ref
    [30,28,33,36].
  It entered at `4db1411c` or later (`12025cc9` raises too). Fix: carry `ScopedNode.held` from `scopeHost` into the
  variable's productivity (`src/compiler/rel/projector.ts` `mathValue`). Add an L4 pin with no side effect.
- **Stale base:** `git merge-tree` against trunk conflicts in `src/compiler/rel/lower/reduction.ts` and
  `src/compiler/rel/modulator.ts`. Rebase it, then re-run the record-host label probes and the sql-hygiene baseline.
  The current "CI passed" and its baselines describe a tree that will not land.

**Several S9 review majors share ONE root cause.** The reader picks its scope by a hand-written PEEPHOLE, not by the
framing its consumers need. Three spellings of it:
- `readsCompoundVocabulary` (`lower.ts` `selectMapFirst`) looks only at `steps[at+1]`. So `select('k').unfold()`
  answers while `select('k').identity().unfold()`, `.limit(2).unfold()`, `.dedup().unfold().count()` and
  `.map(count(local))` decline (trunk answered several of them). Over `aggregate('k').by('age').values('m')`,
  `select('k').unfold()` gives the collection even where row 1's own Map holds `k:10`.
- The chain `recordTail` `select(field)` checks only `namedElsewhere`, never `labelMayBeBound`. So
  `g.V().as('age').project('age','n').by(values('age')).by('name').select('age')` gives 4 rows, where the reference
  gives 6 (`ProjectStep.java:66` omits the key; `Scoping.java:119-135` then reads the label). The child forms decline.
- Each `by(select(k))` consumer decides for itself whether to land the scope node, so most re-inline it.
So the substrate goes FIRST, ordered before the S9 re-land:
1. **Prereq V2 `per-row-map-reenters-map-tail`** (fifth round, below). Once a per-row `{t,v}` map/list re-enters the
   map/list followers, the peephole can go: the per-row node becomes the default framing, and no next-step list is
   needed. Until V2 lands, decline a compound reader after a possible own entry on the query text. Do not switch
   scope by lookahead.
2. **Prereq V1 `scope-variant-label-arm`** (fifth round, below). Until V1 lands, the chain `recordTail`/`mapTail`
   `select` takes the SAME positional `labelMayBeBound` decline that `mapTail` uses (`fallback === 'label'`), so the
   chain and child forms agree.
3. **NEW prereq `scope-collection-by-reference`.** A Scoping reader over a row that MAY be a Map reads the row's own
   entry before a collection (`Scoping.java:119-122`), for every follower. Today
   `g.V().aggregate('k').by(constant(9)).values('m').select('k')` gives [[9,9],[9,9]]; the reference gives [1,[9,9]].
   `test/L4-addendum/one-scoping-reader.feature:1070` (on the branch) pins this as an answer. Re-tag it `@Unsupported`
   with the reference answer, and do NOT cover it in §17 "Map-valued property stream". It is a wrong value, not a
   JS/SQLite divergence. The same goes for a path label that hides a stored Map's own key
   (`g.V().constant(7).as('k').V().values('m').math('k + 1')`: ref 3×2.0 + 6×8.0): record it as a known wrong answer
   waiting on V1, not as accepted.
4. **NEW: compute the scope node ONCE in every by() consumer.** Land `ChildValue.shared` through the existing
   `landedChild`/`landShared` in the group/groupCount key, the project field, the dedup key, order, and math.
   - Measured: `withSideEffect('k',5).V().values('m').groupCount().by(select('k'))` emits 15 json_each subqueries
     (8.3 KB of SQL); `group()` emits 16; `map(select)` emits 1.
   - `order().by(select('k'))` writes `COALESCE(CASE WHEN vtype='map' …, json('{…}'))` about 12× per row.
   - The own-entry probe runs twice, as `f23_s0` and `rn24_s0`.
   - `format('%{k}%{k}%{k}')` mints a key per token, so memoise `scopeHost` by name in `formatValue`.
   Add `groupCount().by(select('k'))`, `project('z').by(select('k'))`, `order().by(select)` over a map, and
   `values(x).select(<element collection>).limit(n)` to `ADDENDUM_SHAPES`. sql-hygiene sees none of these: none is a
   duplicated subquery.
5. **One decode helper.** `map.ts:scopeNode`/`fallbackExpr` and `reduction.ts:childScopeNode` (`either`/`read`)
   each write out the own-entry/held/next CASE. Make the chain twin and the child twin call one function.
6. **Do not round-trip a record field with no reachable fallback.** `childScopeNode` returns `decodedNode(own…)` even
   with no next scope, so every row encodes a `{t,v}` and decodes it again. That is 3.3× slower for
   `project('a').by('x').math('_ + 1').by(select('a')).sum()` (20 → 66 ms at 8k) and doubles the `format` SQL. With no
   fallback, return `'pass'` (trunk's direct field read). With a scalar constant behind the field, COALESCE the typed
   column pair.
Minors with the re-land:
- The `collectionNode` doc claims the node is built once, but the emitted SQL rebuilds it per row. Fence it or fix
  the comment.
- `selectMapFirst`'s comment cites a §17 wording that has since been reverted.
- The select-family sql-hygiene reason in the `4db1411c` message (175 → 176) is stale since `12025cc9`. Restate it.
- Add an element-collection witness (`aggregate('k')` with no `by()`) to the scaling set and to the L4 scenarios.
- `src/rel/walk.ts` `rewrite`: each rewritten spine node clears all of `reach`/`shared`. The cost is quadratic in
  plan size; it is bounded by the query text, but either comment it or invalidate more cheaply. Also assert the
  invariant that a subplan reads only descendants of its host.
- Keep pinning `inject([a:1],[b:2]).dedup('z')` → [] as its §17 line.
Depth gaps (clean declines, record only):
- Hosts: `where/not/filter/coalesce/optional/repeat/sideEffect(select(k))`, `map(map|union(select(k)))`,
  `map(select(k).as('x').select('x'))`, `select('k','j')`, `local(select(k).fold())`.
- `inject()` map literals under union/choose/order/dedup/project/group `by()`.
- An element-stream or inject source `aggregate('k').map(select('k'))`, and `aggregate('k').format('%{k}')`.
- `as('k')` together with `aggregate('k')` on one name.
- Record hosts whose label only some rows carry: `where/not/optional/coalesce/choose/project().by(select('q'))`,
  `select(all,'q')`, `fold().unfold().map(select('q'))`.

**DEFERRED (prerequisite S9 re-land did not land; S9 is ordered BEFORE each):**
- **`project-productive-null-entry`.** Fourth-round follow-up 4: `project()` keeps a productive-null `by()` entry,
  for both the read and the `property(map)` write. It needs the S9 per-row scope node so that the record framing can
  carry a present-null field.
- **`alias-operand-once`.** Fifth-round follow-up 2: an alias/where operand and its tag are projected once at the
  `as()` site. It shares the scope node's compute-once landing (item 4 above), so it lands after S9, or together
  with S9's item 4.

**Follow-ups from review of the landed items (major first):**
1. **REGRESSION (major, `4edf3f20`): a user parameter named `injectedMap` collides with federate's fresh name.**
   `src/compiler/rel/segment.ts` `freshMapValuesParam` still tests `Object.hasOwn(params, param)`, but `params` is
   now `{values, types}`. So `g.V()…call("federate", ["graph":"crew"]).V().has("name", injectedMap)…` with
   `{injectedMap:'marko'}` declines, and the message leaks the internal sibling rewrite. Trunk answered [1].
   Fix: `Object.hasOwn(params.values, param)`. Add a collision pin.
2. **Data-size wall (major, pre-existing, flagged by 3 reviewers): a user LIST parameter under `inject()` is inlined
   as `jsonb_array(1, 2, …)`.** The read is `FROM (VALUES (jsonb_array(…)))` with binds `[]`. Above ~1000 elements,
   `g.inject(ns).unfold().count()` / `.addV()` fail with a bare `SQLiteError: too many arguments on function
   jsonb_array`. That is a data-size failure, and an internal error reaching the user. It breaks both rules:
   "a bind serves a user parameter" and "one json_each bind". `has(k, within(ns))` already binds
   `json_each(jsonb(?))`; route inject's list parameter the same way. File it in `docs/outstanding-work.md` §1.
3. **Merge `mapDrivers.driving` is K² per driver (major, `4d6be2a9`, 3 reviewers).** The `pick`, a correlated scalar
   that sorts by `cappedCount` with LIMIT 1, sits in a WHERE over the exploded ENTRIES. So a K-entry map pays K²
   capped probes. 30-key maps: 2.6 → 19 s (1k → 8k), trunk 1.4 → 9.7 s. One 1000-entry map spends 1.8 s in the
   driving statement alone; trunk spent <20 ms. Project the pick once per driver (or use one
   `row_number() OVER (PARTITION BY driver ORDER BY cappedCount, ord)`), then filter on `ord = picked`. Add a
   map-WIDTH witness (~30 entries) to `test/compiler/merge-scale.exec.test.ts`.
4. **`reSourcedOnce` re-implements `reSource`'s join contract (major, `c4b1f4ef`).** Both the bulk promotion, the
   encounter mint and the origin-major `parent_encounter` renumber are written twice
   (`src/compiler/rel/lower/movement.ts:19-97` and `src/compiler/rel/lower/reduction.ts`), and the n>1 arm is
   literally `reSource` over a different right-hand relation. Parameterise `reSource` on its right-hand relation
   (the scan, or the once-lowered candidates) so one function owns how a re-source crosses carried channels.
5. **S8's stated presence re-inlines the body and drops a productive null under `order`/`dedup` `by()` (major,
   `c16d4b52`).** `g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup())` evaluates the `rn10`
   window subquery 3× per row (trunk did 2×). It returns [b:1], while trunk and the reference return both rows, and
   the same query without the inner `dedup()` keeps both. A no-op step changes the count. A by() consumer that
   drops nulls should read presence from the node it already computed, not re-inline the value. Pin that
   `order().by(select(values))` and `order().by(select(values).dedup())` agree.
6. **Merge guard over key-name POOLS is still super-linear (major, remaining cost; trunk was worse).** A two-pool
   grid `[a{i%s}:1, b{i/s}:1]` takes 0.56 → 10.6 s (19×, ~N^1.5); three pools are ~N^(5/3). Ties pick the lowest
   key name, so √N key sets share one seek. Update `docs/outstanding-work.md`: it names only the power set, not the
   general k-subset or pool-product family. A tie-break that spreads the seeks, or the multi-key `OwnerSeek`
   intersection (outstanding-work §6), closes it. Add a grid witness `[a:i,b:j,c:k]` at N≈8k.
7. **WRONG (pre-existing, not newly reachable): a group value with no barrier lets a later null overwrite a
   value.** `g.inject(['a':3],['a':null]).unfold().group().by(keys).by(__.select(values))` → {a:null}, but the
   reference gives {a:3}: `GroupStep.GroupBiOperator.apply` never lets a null objectB win
   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java`).
   The last-wins pick `json_group_array(gt ORDER BY go) FILTER (WHERE gt IS NOT NULL)` treats `{t:null}` as a value.
   S8 makes more productive nulls reach it. Filter on the node's value, not on the node.
8. **WRONG (pre-existing): mergeV compares a map-valued property by its raw JSON spelling.**
   `g.inject([b:2, a:[x:1,y:2]],[a:[y:2,x:1]]).mergeV()` creates 2 vertices; Java Map equality ignores entry order.
   This affects `couldMatch` and the map-guard signature (`src/compiler/rel/write.ts`). It needs a canonical
   (key-sorted) map spelling at the comparison seam.
Minor (cheap, concrete):
- Merge vs `has()` disagree on Long.MAX against its nearest double
  (`addV().property('x',9223372036854775807L)`, then `inject([x:9.223372036854776E18d]).mergeV()` creates a vertex).
  Add the pair to the merge-finds-what-has-finds table, or make one numeric-equality authority serve both.
- The fallback arm `['-', ':')` of `decimalTextSeeks` is still quadratic for |c| ≥ 9e18, for ends of different
  lengths, and for string keys whose text begins with the driver's integer part (the prefix range ignores `vtype`).
  Name these in the doc comment and in outstanding-work. A length-keyed bound or a vtype-aware range would close
  them. `spans(c)` and `end(c,±)` are inlined about 3×, so project them once. Cite OUR `BigDecimal.toString`
  (`src/gremlin/types.ts`) for "no exponent", not Java's.
- Federate: the parameter types reach only in-process Bun siblings. `CloudflareGraphManager.runForeign` (`_paramTypes`
  ignored), `GraphStoreDO.runForeign` and `HttpForeignExecutor` (`src/http-federation.ts:88`) drop them. Either
  thread the types through the DO RPC and the GraphBinary bindings, or narrow the commit and comment claims.
- UUID type spaces:
  - `inject('<u>').is(UUID('<u>'))` → 1L, ref 0L. inject's scalar subject is UNKNOWN even when `Arg.type` is
    settled; give the inject source `STATIC(Arg.type)` the way `constant()` has.
  - Mixed UUID/String list-parameter membership (`within(mx)`) disagrees with the vararg form. Record it in §17 or
    outstanding-work.
  - The ordering predicates (`gte(x)` with a UUID) ignore type space. Reuse the `textSpaced` authority.
  - Fold `sameSpaceEquality`'s static early-return into `textSpaced`.
  - Add `inject([UUID]).unfold().is(x)` and a mixed NULL-tag arm to `test/compiler/param-env-depth.exec.test.ts`,
    plus non-union depth pins: a PartitionStrategy write, `property(list)`, a list param, `mergeV(map param)`, and
    short/byte/float/uuid params.
- Rooted `sample()`:
  - Some answers became declines and the commit message does not say so: `property('c', __.out().V().dedup()
    .sample(1).id())`, `property(list,'c', __.V().as('x').sample(1).select('x').id())`, and
    `property('c', __.V().order().by(shuffle).limit(2).sample(1).id())`. Add the shuffle-before-slice form to
    outstanding-work §7.
  - `dedup()` not followed by a slice or reducer does not couple across R copies, so treating it as non-coupling
    re-answers `__.out().V().dedup().sample(2)`.
  - The host-state route (`readsHostState`, e.g. `as('h').local(__.V().where(neq('h')).sample(1))`) costs
    origins × |V|. It is newly answered and correct, but put it in the §7 entry.
  - `project().by(__.V().sample(1))` gives every traverser one draw (§1). Route the by() rooted child through the
    per-origin draw.
  - Skip the per-origin RANDOM window when the re-source is the body's first step.
  - Comment, or assert in a plan test, that the equi-join relies on SQLite's AUTOMATIC COVERING INDEX.
  - Name the "no effect" guard precisely: writes only, not side-effect collections.
  - Make `streamsIntoChildren`'s doc and its name-based predicate agree about `optionArms`.
  - De-duplicate `ORDER_ONLY_BARRIERS` against `ir/bulk.ts` `REORDERS`, and `isShuffle` against `ranked-order.ts`.
  - Tests: n>1 scale, the sparse-redraw route, and declines for option() and branch() arms.
- S8:
  - `rowBounds` over a `ROW_NUMBER` + `rn=1` filter (dedup) and over a groupBy-less Aggregate with
    `HAVING count(1)>0` is wider than needed. Correct the doc's claim that a too-wide bound "costs only a guard".
  - Pin the `recursive` arm.
  - Retire the ad-hoc one-row checks (`write.ts` supplied-id addV, `lower.ts` `oneDriver`); see reuse 5.
- onCreate:
  - Add one L4 scenario for a side-effect onCreate map (`withSideEffect("c",["age":null])…option(onCreate,
    __.select("c"))`, the shape of `MergeVertex.feature:640`).
  - Cite `MergeElementStep.java:452` (`validateStaticNoOverrides`) next to `validateNoOverrides`, so the static
    raise on an existing vertex is not "fixed" into a create-only check.
- Telemetry: the census "encountered" wording changed ('integer' → 'int'/'long', 6 messages) and has not been
  re-recorded. Say so at the next census refresh.
- `order().by(<may-be-empty body>)` emits the body twice (sort key + presence). This pre-dates S8; fix it under
  "computed once".

**Reuse-sweep proposals (next round):**
1. **`slicesAcrossStarts` becomes `someStepDeep(…, streamsIntoChildren)`.** Delete `STREAM_CHILD_HOSTS` in
   `src/compiler/rel/lower/branch.ts`. It is a private recursive walk that misses `branch`, a bare `option` and
   `match` (the same miss `9e0d5ab1` fixed, `BranchStep.java:110`). Use the predicate
   `(SUBSET_SLICES.has(s.name) || selfCollapses(s.name)) && !isLocalScope(s)`, and keep `true` for an unreadable
   body. Pin the newly reached coalesce/optional + branch().option forms as declines.
2. **One transitive-CTE-reads authority.** `src/rel/emit.ts` `ctesFor` (`17fa6316`) and `src/rel/check.ts`
   `checkSnapshots.reads` now agree by coincidence. Move a shared `stepReads(node, declared)` into
   `src/rel/plan.ts`; emit keeps its recursive-list rule on top. No SQL change.
3. **One pair of materialize builders, `materialized(rel)` and `fence(rel)`.** Retire `write.ts` `spool`, the local
   fence in `reSourcedOnce`, and ~5 inline `make.materialize({…, fenced:true})` spellings. Also fix the trap that
   `build.ts` `fenced()` does NOT emit AS MATERIALIZED. Check the `channels: []` vs `rel.channels` override at each
   site. No SQL change.
4. **Build the scalar member node inside its one relation for every one-row scalar producer.** Extract the
   construction `c16d4b52` uses in `mapEntryChild` (with the value-nullness gate kept inside the relation) and use
   it in the seeded-fold arm, the numeric-reducer arm and `rootedCount`. Measured:
   `project('s').by(__.outE().values('weight').sum())` reads edge_properties 2× per host row, and `.max()` 3×.
   This retires `producedMemberNode`'s pmv/pmp wrapper and the three local `scalarOf` helpers.
5. **Name `oneRowValues(rel)` beside `writeSnapshot`** (`src/compiler/rel/write.ts`). Use it for the supplied-id addV
   check and `lower.ts` `oneDriver`. Do NOT substitute `bounds.ts` `atMostOneRow`, because a one-row aggregate over
   `nodes` still reads the table being written.

Still open: S9 re-land (parked above) and its two deferred dependants; fifth-round follow-ups 4–8 and reuse 2;
fourth-round S11, follow-ups 3, 5, 6, 8, 9, reuse 2–8, and S6's multi-driver mergeV lift; and from earlier rounds
M1, M2, S3, R13–R18, F8, F11–F13 and F14b.

**Needs-human questions:** none raised this round.

### Next round (from the 2026-11-02 fifth round — read before picking items)

Landed this round, each on trunk after an unpiped `mise run ci` that printed "CI passed", and green on GitHub CI:
- `bdfa6f0c` — trunk red CI fixed (test-only: the evaluate-once witness is one 50-traverser write per store, 3 trials).
- `fb030364..00256441` — R11 follow-ups 1 + 7 (scalar `aliasWhere` arm via `valueTheta`; `declaredParamTypes` at the
  compile seam; `correlatedExists` seeds `seedOuterAliases`).

**PARKED — S9 (ONE Scoping reader). [Superseded by the sixth round's `wf/s9-one-scoping-reader-reland-1-4`, above.] Resume point: branch `wf/s9-one-scoping-reader-4-4` (`0f2180e6`, 4 commits
`3cb9b019..0f2180e6`, not on trunk).** It answers every fourth-round S9 witness, scales linearly (1k→8k ≤4.7×), and
its CI was green, but review found a REGRESSION it cannot ship with: S9 makes every reader TRUST the framing's `held`
set (keys the row is guaranteed to hold), and `held` has writers that over-claim. Witnesses (modern graph; trunk was
right on 1–4, newly-reachable wrong on 5–8):
1. `g.withSideEffect('b',7).inject(1).union(__.constant(['a':1,'b':2]), __.constant(['a':3])).select('b')` → [2], ref [2,7].
2. `g.withSideEffect('b',7).V().choose(__.hasLabel('person'), __.constant(['a':1,'b':2]), __.constant(['a':3])).select('b')`
   → four 2s, ref four 2s + two 7s. 3. the `inject(1,2).choose(__.is(1), …)` twin → [2], ref [2,7].
4. (1) `.as('m').select('m').select('b')` → [2]. 5. (1) `.map(__.select('b'))` / `.local(…)` → [2].
6. (1) `.format('%{b}')` → ['2']. 7. (1) `.math('b + 1')` RAISES "must resolve to a Number", ref [3.0, 8.0].
8. `g.V().as('b').union(__.constant(['a':1,'b':2]), __.constant(['a':3])).map(__.select('b')).count()` → 6, ref 12.
Already wrong on trunk: the arms reversed, `union(constant([a:3]), constant([a:1,b:2])).select('b')` → [7,7], ref [7,2].
`Scoping.java` `getScopeValue` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`)
reads the Map, then side effects, then path labels, so a row lacking the key must fall through.

**Shared root cause → ONE substrate item, ordered BEFORE S9's re-land:**
- ✅ **S9a LANDED (`79c3a336`, `ce6498be`).** A map framing carries `MapKeyFacts` (`src/compiler/rel/framing.ts`):
  `keys` a sound MAY bound, `held` a sound MUST bound, `exact` for literals. Arm merges and alias joins go through
  ONE meet (`meetFraming`/`meetMapKeyFacts`, `lower/branch.ts`); local slices re-state facts via `slicedKeyFacts`;
  every map-first reader reads key presence through one authority, ambiguous cases decline on the query text.
  Fixed the reversed-arm union and the local-slice lost rows; L4 `map-key-facts.feature`. Remains: nothing —
  S9 can now rebase onto it.
- **S9a. `held` is a MUST-hold fact: every framing transformer preserves it soundly or drops it.** Two writers
  over-claim today, and both are independent of S9 (S9 only made the readers trust them):
  - the map arm of the branch merge (`src/compiler/rel/lower/branch.ts`) keeps the FIRST arm's `held`/`keys` →
    INTERSECT `held` across arms, UNION `keys` (fixes witnesses 1–8 and the reversed-arm case);
  - the local slice (`limit/range/skip/tail(local)` arm in `src/compiler/rel/lower.ts`'s `mapTail`) keeps `held`
    after it may remove keys → clear `held` there (and drop the old `keys` exemption). LOST ROWS on trunk today:
    `g.inject([a:1,b:2],[a:3,b:4]).limit(local,1).as('b').select('b')` → [], ref [{a:1},{a:3}];
    `…tail(local,1).as('a').select('a')`; `g.V().as('b').constant([a:1,b:2]).limit(local,1).select('b')` (ref 6
    vertices); `g.withSideEffect('m',[a:1]).inject(1).select('m').limit(local,0).as('a').select('a')` (ref [{}]).
  Audit every other `held` writer the same way (`bun scripts/refs.ts held`). L4 pins: a branch merge of map arms
  with different key sets, and a local slice between a `held` producer (map literal, shared-key inject, side-effect
  map constant, record `as()`) and a Scoping reader (`select`, `map(select)`, `format`, `math`, alias re-entry).
  Then rebase S9 onto it.
- **S9 re-land must also fix (review majors on `0f2180e6`, all pre-existing wrong answers S9 claims to unify):**
  1. order/dedup `by(__.select(k))` over a RECORD host still use the old field read, not `childScopeNode`:
     `g.withSideEffect('b',5).V().project('a','b').by('name').by('age').order().by(__.select('b')).select('a')` → 4
     rows, ref 6; `….dedup().by(__.select('b')).count()` → 4, ref 5 (`src/compiler/rel/lower/reduction.ts`,
     `scopeValue` in `modulator.ts` still declines map hosts via `mapScopeMayHold` — the second map-scope reader).
  2. Chain `select(k)` over a per-row scalar that may be a Map runs `selectCollection` BEFORE `selectMapFirst`
     (lower.ts select arm ~1278): `g.V().aggregate('k').by('age').V().values('m').select('k')` gives the collection
     where the row's map holds `k:1`; the child seam (`map(__.select('k'))`) answers right. Route through
     `selectMapFirst` first — `mapFirstFallback` already resolves collections.
  3. Answer → decline regression: `mapFirstFallback` returns 'label' for a label bound ANYWHERE in the program
     (`ctx.scopeNames.labels`), so `g.V().elementMap().select('age').as('age')`, `g.V().group().by('name').by('age').select('marko').as('marko')`
     and `g.V().elementMap().dedup('age').as('age').count()` (new `dedupByLabels` guard) decline; trunk answered.
     Use a positional MAY-be-bound-before set — a may-bind variant of `labelsBoundBefore` (`src/compiler/ir/labels.ts`).
  4. Commit message must name every sql-hygiene move: map 1256→1479, and also select 175→176, mergeV 374→376.
  5. §17 "Map scope": a row lacking the key where a same-named PATH LABEL exists (project(k)/valueMap(k)/
     elementMap(k), and the newly opened map()/local()/math() forms) is a LOST ROW, not a divergence — decline it
     until scope-variant-label-arm lands, and drop it from §17. Add an L4 pin for map()/local() with a path-label key.
  Minor/cheap with it: `renderedNode`'s per-row `(VALUES (json(shn0)))` subquery for each `format()` token
  (`src/compiler/rel/projector.ts`) → read the landed node column via `asStringOf` directly.
  Depth gaps S9 leaves (clean declines; record, not blockers): the side-effect fallback through
  union/choose/coalesce/optional arms, where/not/filter, order/group/project/dedup `by(select(k))`, repeat bodies,
  `select(k).by(…)`; `map(__.math(…))`; `map(select('k','j'))`; `map(unfold())`/`local(count())`/`map(select(keys))`
  over a map/record host; `valueMap().map(select(k))`; `project('a').by('name').map(__.select('zz'))` (ref [] — a key
  outside static keys is absent, not a decline); `withSideEffect('b', null)`; element/path/list hosts under `map()`;
  `where('a', eq('b'))` over map traversers; the chain `project('y').by('age').select('x')` over a collection (the
  child form answers).

**Deferred (decided not to build this round; prerequisite ordered first):**
- **Prereq V1 → `scope-variant-label-arm`.** Path-label scope behind a row that may be a Map (`g.V().as('k').values('m').select('k')`
  → ref [1, v2, v3]): needs a VARIANT (element-or-value) per-row stream framing that continues through followers —
  element-requiring steps apply to element rows; shape-agnostic steps (count/fold/dedup/as/select) carry the
  `{t,v}`/element node. Also the clean answer for S9 re-land item 5.
- **Prereq V2 → `per-row-map-reenters-map-tail`.** A per-row `{t,v}` map/list scalar re-enters the map/list followers
  (`unfold`, `select(keys)`, `count(local)`, `select(k1,k2)`, `format`, `mergeV`): decode a stored or scope-read
  `{t,v}` map/list into the map/list framing so `g.V().values('m').unfold()` and siblings answer. Unblocks the
  fourth-round S9 item 6 regressions (`withSideEffect('k',['x':1])…select('k').unfold()` etc.) for the scalar host.

**Follow-ups from review (major first):**
1. ✅ **LANDED (c4b1f4ef, 22e3293d, 839fbd1f, 9e0d5ab1) — per-traverser `sample()` over a rooted body is linear.**
   `reSourcedOnce` (`src/compiler/rel/lower/reduction.ts`, reached from the one re-source dispatch `reSourceTail` in
   `lower.ts`) lowers the origin-independent prefix once via `rootedRead` and draws per origin: `sample(1)` one fenced
   index equi-joined to the numbered candidates; `sample(n)` O(q log q) per origin (sparse draw-with-replacement keeping
   the first q distinct, else a per-origin rank where P < 2q). Coupling barriers at any depth (`streamsIntoChildren`,
   `ir/step.ts`) and side-effect collectors in the prefix decline instead of paying the product. Witness:
   `test/compiler/rooted-sample-scale.exec.test.ts` (~8x for 8x). Remains: nothing (residual declines and the
   first-value-child single-draw gap are tracked in `docs/outstanding-work.md`).
2. **R11 hygiene (major, introduced by `82d66183`).** `aliasOperandAt` reads the label's tag via `aliasTypeAt` beside
   `aliasValueAt`; the emitter fuses the alias-history read back in, so the whole history-entry expression
   (`jsonb_object` over the exact-REAL printf/CAST CASE) is spelled TWICE per operand (`$[#-1].v` and `$[#-1].t`), and
   a `math()` subject three times. `g.V().as('v').values('age').as('x').select('v').out().as('w').values('age').as('y').select('w').where('x', P.eq('y')).count()`:
   8.5→39.9 ms on trunk-before, 15.3→70.9 ms after (1k→8k; linear, ≈1.8× slower); values-family SQL 4072→6817 bytes.
   The `t` is the source row's `vtype` column. Project the label's v/t ONCE at the as() site (or read `t` from the
   source column when fused) — the same substrate as fourth-round item 8's last bullet (fold the history seed/last-read
   pair). Extend sql-hygiene to catch duplicated EXPRESSIONS, not only duplicated subqueries.
3. ✅ **LANDED (4edf3f20, 745e65ef, 0200909d) — nested bodies keep parameter types.** One `ParamEnv` = {values, types}
   (`src/gremlin/param-env.ts`) built once in `compilePlan`; `stepChain`/`extractArgs`/`walkArgs` take only the env, so a
   nested re-parse cannot drop the type. Also covers reuse proposals 1–3 below, plus UUID-bound equality fixes. Remains: nothing.
4. Minor, R11: an `or`/`and` of alias leaves applies each branch-bound label's `aliasGuard` per leaf, so
   `where(P.eq('o').or(P.eq('n')))` keeps a row with `o` unbound when `n` matches — the reference raises
   (`Scoping.getSafeScopeValue`); and a branch-bound label missing on some traversers FILTERS them
   (`g.V(1).union(__.values('age').as('a'), __.constant(5)).V(1).values('age').where(P.eq('a')).count()` → [1]).
   Both are the natural answer: one §17 line covering "unbound where label → row dropped, incl. under a connective".
5. Minor, R11: the `valueTheta` NULL arm (`CASE WHEN a IS NULL OR b IS NULL …`) is emitted even when both sides have a
   non-null static type (+131 bytes baseline) — skip it then. `valueTheta` is the third copy of the "evaluate operands
   once in a VALUES row, then project" pattern (`storedCompareOnce`, `typedNodeOnce`) — one helper.
6. Minor, R11: `declaredTypeOf` (`src/gremlin/types.ts`) re-walks list/set/map like `valueNodeOf`; derive one from the
   other. Stale comments in `src/wire.ts` (`decodeFields`, `parseJsonQuery` ~131) and `gremlinTypeOf`'s doc still
   describe the untyped-parameter fallback (reuse proposal 3).
7. Minor, CI-red test: the rewritten witness no longer covers the original form (one id-anchored traverser, unfiltered
   in-body `__.V().sample(1)`) — add one cheap old-form run; reword its comment to "one draw per traverser, read by
   both the snapshot and the write"; cite `AddPropertyStep.java:134` by its full `vendor/tinkerpop/gremlin-core/…` path.
8. Depth gaps (clean declines): `local()`/`flatMap()` around `__.V()…sample(1)`; `property(list,'l', __.V()…values('age').max())`;
   a scalar or element bare `where(P.op(label))` inside filter/where/not/optional/coalesce/choose/map/project().by()/
   repeat until/emit (the filter/branch seams in general); an element subject vs a VALUE label (compile-time fold:
   neq true, else false); `within`/`without`/`between`/TextP with label operands; list/map/path/property subjects or
   labels; `where(P.eq('a')).by(…)`; a double constant ordered against an int label (`constant(2.0d).where(P.gt('a'))`);
   the two-label `where('x', P.lt('y'))` over a scalar current traverser.

**Reuse-sweep proposals (next round):**
1. ✅ **LANDED (4edf3f20)** — **Carry parameter types IN the params environment** — `declaredParamTypes` (`src/gremlin/types.ts`) returns one
   typed environment (name → {value, type}) that `stepChain` reads, removing the parallel `paramTypes` argument from
   `stepChain`/`extractArgs`/`walkArgs` (`src/gremlin/frontend.ts`) and its `?? null` fallback. Today every nested
   re-parse (`ir/passes.ts:childSteps` ~367, `ir/labels.ts:48`, `ir/content-demand.ts:202/240`,
   `ir/productivity.ts:88/102`, `ir/strategies.ts:275`) passes params but not types, so a nested parameter is
   untyped again. Measured WRONG NUMBER CLASS: with `{x:5}` declared long, `g.addV('t').property('b', x).values('b')`
   frames Long but `g.V(1).union(__.addV('t').property('b', x)).values('b')` frames Int. No new SQL.
2. **`list.ts`'s "encountered %s" tail reads the argument's own type** — `flatType(arg.type) ?? gremlinTypeOf(value)`
   replaces the private `gremlinTypeOfValue` typeof ladder (`src/compiler/rel/list.ts` ~1453, called at 1419/1436),
   which misnames int32-overflow numbers, declared long/short/byte, and datetime/uuid literals. Message tail only.
3. **Retire the stale untyped-parameter comments** (`src/wire.ts:131`, `gremlinTypeOf`'s doc) — point at
   `declaredParamTypes`. Bundle with 1.

Still open from the fourth round (below): S11, follow-ups 2–6, 8, 9, reuse 2–8, and S6's multi-driver mergeV
lift (S9's entry-or-side-effect residual now waits on S9a → S9). From earlier rounds: S8, M1, M2, S3, R13–R18, F8,
F11–F13, F14b.

**Needs-human questions:** none raised this round.


### Next round (from the 2026-11-02 fourth round — read before picking items)

Landed this round, each on trunk after an unpiped `mise run ci` that printed "CI passed" locally:
- `39085c4d`: R11 (`seedOuterAliases`). `1254d29e`: S7 (`choicePresence`/`scalarChoice`).
- `4a34b58a..4a0530df`: M3 (a null `property()` traversal value removes the key; `sample()` draws per origin).
- `19115f5e..a33d7983`: S6 (map-first `select('k')`, `mapFirstFallback`).
- `3c7ba931..4c565396`: R10 + F7 (tuple-collapsed merge guard, `seekedSearch`).

Nothing was deferred whole. Branches left on purpose: `wf/s6-map-first-select-scoping-3-{0,2,3,4}` and
`wf/r10-merge-super-linear-3-{0,2}` show `git cherry` `+` only because `ae57c06b`/`a75db6e4` landed as `19115f5e`/
`3c7ba931` with a conflict resolution (imports in `reduction.ts`; both-sides-added in `write.ts`). Their content is on
trunk; they hold no resume point.

**0. ✅ TRUNK CI RED — FIXED (`bdfa6f0c`).** "a nullable body that draws is evaluated once" in
`test/compiler/writes.exec.test.ts` timed out on CI (40 × `seededStore()`). Landed: the witness is now ONE
multi-traverser write over one store, so a single run exercises the evaluate-once property across many traversers
instead of building 40 stores. Follow-up: in the write-body `V()` re-source lowering, apply the label filter before
the encounter window so the cost is linear (traversers × matching vertices). Separately, `local()`/`flatMap()`
wrapping `V().sample(1)`, and `property(...max())` over a re-sourced `V()`, raise `UnsupportedTraversal`.

**Parked residuals (each with its prerequisite, ordered before what it unblocks):**
- **S6's multi-driver `inject(maps).mergeV().option(Merge.onCreate, __.select('k'))`** — prerequisite R10/F7 is now
  LANDED, so this is a one-line lift at the "NARROWED to ONE driver" comment in `mergedFromMap`
  (`src/compiler/rel/write.ts`), plus a scaling witness at 1k/8k drivers. Take it in the same commit as S9 below only
  if S9 touches `mergedFromMap`; otherwise standalone.
- **S6's entry-or-side-effect value per row** (select/format over a valueMap or a list/map value side, `format` over
  an optional record field, `select` of an optional `project()` field) — prerequisite is S9.

**Shared root causes (one substrate item each, ordered BEFORE what they unblock):**
- **S9. ONE Scoping reader per row: own Map entry → side-effect constant → named collection → path label**
  *(Fifth round: BUILT on `wf/s9-one-scoping-reader-4-4` (`0f2180e6`) and PARKED behind S9a — see the fifth-round
  section above.)*
  (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135`),
  for EVERY host kind (scalar that may be a Map, map, record) and every consumer (select, format, math, keyed dedup,
  the child seam), LANDED ONCE as a fenced column (as `scalarMapKey` does with `SCOPE_NODE` + `presenceFenced`,
  `src/compiler/rel/map.ts`). S6 built the order (`mapFirstFallback`) but four hand copies of the expression
  (`scopedKey`/`mapKeyOr` in map.ts, `mapHostChild` and `scalarMapFirstChild` in `rel/lower/reduction.ts`, mapTail's
  keyed-dedup `mapScope` in lower.ts, `mathValue` in projector.ts) each cover a different subset. Review found, all
  from this one cause (major first):
  1. WRONG, pre-existing — `g.withSideEffect('k',5).V().values('m').math('k + 1')` over m=[k:1],[j:2],[j:3] gives
     [6,6,6], reference [2,6,6] (`MathStep.java:73` → `getNullableScopeValue`): `sideEffectBehindOwnScope` handles only
     record/map hosts; the scalar host goes straight to `sideEffectConst` (`src/compiler/rel/projector.ts`).
  2. WRONG, pre-existing — `g.V().as('k').values('m').select('k')` gives [v1,v2,v3], reference [1,v2,v3] (also
     `map(select('k'))`, `project('x').by(select('k'))`): `mapFirstFallback` returns 'label' and the readers pass
     straight to the alias. Contradicts §17 "Map scope".
  3. WRONG, pre-existing — record host in a by(): `g.withSideEffect('x',7).V().project('x').by(values('age')).math('_ + 1').by(select('x'))`
     gives [30,28,33,36], reference [30,28,8,33,8,36]. The chain and map hosts were fixed; the record child seam
     still goes through the generic select re-root.
  4. WRONG, pre-existing — a MAP stream's `selectKeys` drops instead of falling to the side effect:
     `g.withSideEffect('c','se').inject([a:1],[b:2]).select('c')` gives [] (reference ['se','se']);
     `withSideEffect('a','se')…select('a')` gives [1] (reference [1,'se']).
  5. LOST ROWS recorded as a §17 line — "Map scope" accepts dropping rows where Java falls through to a named
     collection (`g.V().aggregate('age').by('name').elementMap('age').select('age')`, `…groupCount('x')…cap('x').select('x')`
     → []). Move it out of §17: a clean decline now (the reader returns 'collection' → decline when the Map may lack
     the key), the answer with S9. Keep L3's `g_VX1X_groupXaX_byXconstantXaXX_byXnameX_selectXaX_selectXaX` green.
  6. REGRESSIONS (answer → decline, no corpus coverage): six forms of
     `g.withSideEffect('k',['x':1]).V().values('name').select('k')` followed by `.unfold()`, `.select(keys)`,
     `.count(local)`, `.select('x','y')`, `.format('%{x}')`, `.mergeV()` — `selectMapFirst` now runs before
     `selectSideEffectConstant` in `collectionArm` and loses the constant's map framing; and
     `g.withSideEffect('a',5).V().project('a','b').by('name').by('age').select('a')`. Let the map-framed side-effect arm
     own a map constant.
  7. REGRESSION — `injectMap` records `keys` on its framing, and projector.ts ~267 / `mapHostChild` treat a key
     outside the set as a DECLINE, contradicting `framing.ts:80` ("advisory ONLY — narrows a decline, never widens"):
     `g.inject(['name':'x']).format('%{k}')` was `[]`, now declines; `inject([a:1],[b:2]).dedup('z')` likewise.
     Treat an outside key as absent.
  8. HYGIENE — the child seam re-inlines the correlated `json_each` map read per reader (`selectedNodeChild`: `v`,
     `t`, and the `held` gate): 3× per row for `V().values('m').map(__.select('k'))`, 5× for `…math('_+1')`. Linear,
     but breaks "computed once"; sql-hygiene misses it because the shapes are L4-only — extend it.
  9. Minor: a null Map entry — chain keeps it (`SelectOneStep.java:62`), `map`/`local`/`flatMap`/`choose` drop it
     (`selectedNodeChild`'s `present: 'value-nullness'`); base presence on the node's nullness. And
     `inject([a:1],[b:2]).as('b').select('b')` → [2] where the reference gives [{a:1},2] (newly reachable instance of
     §17 "Map scope" from the key-set union) — note it in the L4 file.
  S9 absorbs reuse proposal 1 below. Add L4 scenarios for every witness above.
- ✅ **S10 LANDED (4d6be2a9, 2b02dbf8, 17fa6316, 2026-11-03).** Each merge driver now seeks its most selective key
  (`cappedCount`, LIMIT 64), a numeric search reads only the decimal TEXTs its cast can land on (`decimalTextSeeks`),
  `endpointSeek` takes the whole (src, label, tgt) key, and the map guard (`searchKeying`) crosses each earlier map
  only with the key sets it exactly contains, all as fenced MATERIALIZED CTEs of ONE statement (`emit.ts` `parts`
  now carries only the CTEs a step reads); item 5 measured a no-op. All six shapes are ~linear (1k → 8k ≤ 8.8×),
  pinned in `test/compiler/merge-scale.exec.test.ts`. **Remains:** the containment worst case — data key names
  where every key is shared by many longer key sets cost N × those holders — is in `docs/outstanding-work.md`; it
  now runs entirely inside one statement and never becomes a bind. The generic home for these seeks is still a
  correlated-join `OwnerSeek` in `src/rel/passes/semijoin.ts` (also noted there). Original item:
- **S10. The merge search seeks the CONJUNCTION, not the first key** (`seekedSearch`/`computedMatch`/`propertySeeks`/
  `mapEntrySeeks`/`endpointSeek`/`searchKeying`, `src/compiler/rel/write.ts`). R10/F7 is linear only for a selective
  first key, one map shape and no hub; four shapes stay super-linear (all equally quadratic on the parent, so none is a
  regression, but "performance is semantics at production size"):
  1. Low-selectivity FIRST key — the common upsert `mergeV([tenant:'acme', email:x])`:
     `g.V().mergeV(__.project('kind','name').by(constant('person')).by('name')).count()` 1,054 → 62,807 ms (1k → 8k,
     60×); map form `inject([kind:'p',name:…]…).mergeV()` 64×. Reversing the keys gives 34 → 71 ms. Intersect one seek
     per key (or pick by `sqlite_stat1` after ANALYZE).
  2. TEXT arm (`value >= ''`) reads every TEXT value of the key per NUMERIC driver: `…mergeV(__.project('name').by(values('age')))`
     683 → 44,587 ms (65×). Cheap, concrete fix: the arm exists only for the decimal-TEXT tail `storedScalar` writes
     (`src/gremlin/types.ts` ~354), which starts with `-` or a digit, so bound it to `value >= '-' AND value < ':'`.
     Take this first — it needs no new index or bind.
  3. Map MASK fan-out is data-sized: `searchKeying` crosses every earlier tuple with every DISTINCT key set, so
     `inject([k0:1],[k1:1],…).mergeV()` is 61× (1k → 8k). Key the guard on the later map's first searched entry, as
     `mapEntrySeeks` already does for the search.
  4. Hub edges: `endpointSeek` seeks `e_out` by `src` alone; re-upserting N edges from one hub is 30.6× (1k → 8k). Seek
     (src, label-id, tgt) when the map names OUT, label and IN.
  5. Hygiene: the guard's Aggregate groups by the keying columns AND projects them, so the correlated `g_ks`/`g_sig`
     subqueries (and `g_ck`) are spelled twice per driver row (SQLite never equates two subqueries) — project the
     keying columns under the Aggregate and group by the projected columns.
  Pin each shape in `test/compiler/merge-scale.exec.test.ts` (as a tracked gap if not fixed); the current seven
  witnesses cannot see any of them. Longer term, `semijoin.ts`'s OwnerSeek pass is the generic home for these seeks
  (a correlated-join OwnerSeek) — note in outstanding-work.
- **S11. A body-may-yield-NULL fact on the rows path.** `resolveValueRows` sets `nullFree` only on the scalar branch,
  so every `child.rows` body (`__.values(k)`, `__.id()`, `__.out().values(k)`, `union(constant…)`, `math`) pays M3's
  removal machinery with no user-visible reason: a snapshot, two windows (`lo`/`ls`), an extra `unheld` term and two
  DELETEs — +13–75% (`property(list,'x', union(constant(1),constant(2)))` 116 → 203 ms at 8k; still linear). A stored
  value is never NULL, `id()`/`constant(non-null)`/`math()` never yield one, and the framing already has
  `productiveNull` (`src/compiler/rel/framing.ts:56`). Take `nullable` from it; fold `lo`/`ls` into one window on
  `(o, sq)`. Expect the non-null plans to return byte-identical to pre-M3.

**Follow-ups from review (major first).**
1. ✅ **LANDED (`fb030364`..`00256441`).** `aliasWhere`'s bare `where(P)` arm takes a scalar subject (current value
   vs `aliasValueAt(label,'last')`) through the one `valueTheta` comparator, which now types an untyped side by its
   value and decides NULL first; untyped parameters are typed once at the compile seam (`declaredParamTypes`,
   `src/gremlin/types.ts`). Answers in legs and at top level; pinned in `where-leg-alias-scope.exec.test.ts`.
   Remains: nothing. *(Original:)* **R11 regression (major) — a VALUE-traverser `where(P.eq(label))` inside a multi-correlation leg now declines;
   trunk answered it correctly.** Deleting `legRight` deleted its `aliasValueAt` arm, and `aliasWhere`
   (`src/compiler/rel/lower.ts`) has no scalar-position arm. Witnesses (were 6, 6, 0; now decline):
   `g.V().as('b').values('name').as('n').select('b').out().as('a').where(__.select('a').in().values('name').where(P.eq('n'))).count()`,
   the `values('age')…math('_ + 0')` form, `g.V().as('b').out().as('a').where(__.select('a').in().values('name').where(P.eq('b'))).count()`.
   Give `aliasWhere` the arm (`aliasValueAt(label,'last')` = current value) — it also answers the top-level form
   `g.V().as('a').values('name').as('n').select('a').out().as('b').in().values('name').where(P.eq('n'))`, which
   declines today. Pin in `test/compiler/where-leg-alias-scope.exec.test.ts`.
2. ✅ **LANDED (7f3a5996).** An onCreate `null` against a merge key holding a value is now an override at both
   checks: the static `validateNoOverrides` (`src/compiler/ir/write-args.ts`, null on ONE side clashes) and the
   runtime `onCreateOverrideGuards` (`src/compiler/rel/write.ts`, the `remove` arm is `value IS NULL`); pinned in
   `test/L4-addendum/merge-oncreate-null-override.feature`. Landed with c682a953 (L5 oracle: a window nested in a
   step argument is count-undetermined after the enclosing step). Remains: nothing. *(Original:)*
   **Lost write (major, pre-existing) — `onCreateOverrideGuards` skips `write.kind === 'remove'`**
   (`src/compiler/rel/write.ts`): `g.inject([name:'x',age:1]).mergeV().option(Merge.onCreate,[age:null]).valueMap()`
   creates the vertex WITHOUT age; the reference raises `option(onCreate) cannot override values from merge()
   argument: (age, null)` (`MergeElementStep.java:325-334`, `Objects.equals(null, 1)` is false). Compare removes too.
3. **Wrong element written, recorded as §17 (major, pre-existing)** — S6's §17 line "Map-valued property stream …
   `values('m').mergeV(__.select(k))` merges by the side effect" accepts a write to the wrong element
   (`Scoping.java:121-122` merges by the Map's `[name:'zz']`). Remove the line; decline the scalar-stream mergeV fold
   when the select key is a side-effect constant and the stream may be a Map, or (with S9) feed `scalarMapKey`'s
   per-row node to `mergeVFromMap`. Also say in the matrix that the onCreate no-override check is skipped on a map
   driver only where it is (add `inject(map).mergeV().option(onCreate, __.select(k))` with an overlapping side effect).
4. **WRONG, pre-existing (M3 depth) — `project()` drops a productive-null by() entry**, so
   `g.V(1).property(__.project('age','y').by(__.coalesce(__.values('nope'), __.V().constant(null).limit(1))).by(__.constant(2)))`
   keeps age=29 (reference removes it, `ProjectStep` puts the null, `AddPropertyStep.java:152-160`); the bare read
   returns `{y:2}` for `{age:null,y:2}`. Fix in the project framing; narrow the `mapFormStatements` comment meanwhile.
5. **WRONG, pre-existing (R11 depth, `legSingle`)** —
   `g.V().as('b').out().as('a').in().as('c').where(__.select('a').in().as('c').select(Pop.all,'c').count(Scope.local).is(2)).count()`
   gives 0, reference 12 (the child path carries the parent's `c`, `B_O_S_SE_SL_Traverser.split`). Seed the parent
   path's labels into a single-correlation leg too — the same `seedOuterAliases` move; see 7.
6. **sql-hygiene baseline moved without a reason (minor, rule).** R10's commit re-banked valueMap terms 75 → 82 and
   where 91 → 87; re-recording on its parent gives the same deltas, so an EARLIER commit raised valueMap without
   banking it. Trace it (`git log -S` on the baseline / bisect `mise run sql-hygiene`) and name the user-visible reason
   or remove the term.
7. ✅ **LANDED (`fb030364`, with 1):** `correlatedExists` seeds with `seedOuterAliases`; the witness answers 6.
   Remains: nothing. *(Original:)* **R11 next step (coverage):** `correlatedExists` (`src/compiler/rel/lower/filter.ts`) still seeds with
   `NO_ALIASES`, so `g.V().as('a').out().as('b').where(__.in().where(P.eq('a'))).count()` declines while the
   `select('b')`-spelled twin answers 6. Seed it with `seedOuterAliases`.
8. **Cheap fixes.**
   - `src/compiler/rel/lower/slice.ts`: the M3 comment cites `.../AddPropertyStep.java:134` with an elided path —
     write `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java:134`;
     and lines ~36-43 still say `sample` is EXCLUDED from per-origin scoping (stale since M3; reuse proposal 7).
   - `PresentWhen` (`src/compiler/rel/child.ts`): state the invariant `choicePresence`'s `orValue` relies on — a stated
     `{when}` without `orValue` has a NULL value wherever `when` is false — so a future COALESCE-seeded producer cannot
     silently keep rows. `choicePresence`'s "every slot the same" is object identity; say so (reuse proposal 3 makes
     it fire more).
   - `removeRows`' doc claims to be the one removal; `properties().drop()` (write.ts ~297) still hand-builds the same
     pair — route it through `removeRows`.
   - M3's `effectScope` pushes a drawing snapshot's named subtrees into program-level `bindings`, so every later write
     statement carries the whole body as an unreferenced WITH (statement text and binds × statements, query-text
     bounded — matters at the DO 100 KB / 100-bind walls). Scope them to the snapshot statement.
   - The R11 inlined outer channel still reads `CAST(json_extract(jsonb_array(jsonb_object('k',0,'v',x)),'$[#-1].v') AS INT)`
     per inner row — fold a history-seed/last-read pair to `x` in the alias reader.
9. **Missing pins.** S7: the routes opened under `local()`/`flatMap()` (`yields: 'first'` → `flatMapRejoin`) and the
   mixed stated + value-nullness arm (`map(choose(hasLabel('software'), V().constant(null).limit(1), values('age')))`
   → 32,null,29,35,null,27). R11: a by()-modulated `where(P.eq(label)).by(T.label)` in a leg, which now declines
   instead of trunk's wrong 6 (reference 12); a multiplicity witness on a self-loop + parallel-edge graph
   (`BAC.where(__.select('b').out().where(P.eq('a')).count().is(2))` → 10). M3: a multi-traverser drawing witness
   for the evaluate-once test; list with a null mid-stream (`inject(1,null,2)` → [2]); set `inject(29,null,29)` → [29].
   S6: mixed-key inject maps under `as(k).select(k)`; a BigDecimal onCreate value; collection restatements in onCreate.

Still open from the third round (below): S8, M1, M2, items 4–7. From earlier: S3, R13–R18, F8, F11–F13, F14b.

**Depth gaps recorded this round (clean declines; not defects):**
- **S7:** an option-map choose whose CHOICE FUNCTION is an ordered/label-correlated re-sourced scalar
  (`map(__.choose(__.V().values('name').order().limit(1)).option('josh',…).option(Pick.none,…))`) — `choicePresence`
  covers arms, not the choice function's own stated presence; map(choose(stated arm)) after `repeat().emit()`, in
  `sideEffect`/`fold`/`filter`/`coalesce`/`optional`, as a group key, in a two-by project; over list/map/path/property
  hosts; an option map with no `Pick.unproductive` arm over a vertex host (needs a choice result that is scalar OR
  element, `ChooseStep.java:71-79`).
- **S6:** the new select in where/filter/not/coalesce/optional/sideEffect arms, a child continuing into a barrier
  (`map(__.select('k').fold())`), order/group/project `by(select('k'))`, repeat bodies, `select('k').by(…)`/`.path()`;
  every child-seam embedding over map and record hosts; heterogeneous `inject(1,[a:1],[b:2]).select('b')`;
  `inject([a:1],[b:2]).as('x').select('x')` (the key-set union should read "collision possible", not "unknown");
  `holdsNestedUnordered` declines (not compares) a nested map/set onCreate value. Pre-existing outside S6:
  `V().elementMap().dedup('label').count()` gives 0 where `DedupGlobalStep.java:82` raises.
- **R10/F7:** a computed mergeV inside local/map/union/optional/choose/coalesce/repeat; mergeV after
  `values()`/`inject(scalars)`; `by(constant(29.0m))`/`by(constant(9007199254740993L))`;
  `inject([name:'zz',a:1],[a:1,name:'zz']).mergeV()` declines because `createKey` spells JSON key-order-dependently.
- **R11:** a leg nested in where/filter/map/project-by/repeat/choose/coalesce/optional; choose/coalesce/optional
  inside a leg body; a body binding a label after the correlation; simplePath/cyclicPath/path() in a leg body.
- **M3:** a mutating `property()` inside any child body (local/union/choose/optional/sideEffect/flatMap/map/repeat),
  null or not; a `project(…)`-shaped map form.
- **Not this round, FYI:** `g.V().hasLabel('person').as('a').V().has('z',5).property(...)` is super-linear in the
  READ (mid-traversal `V().has` with no seek, 813 ms → 44.6 s, same on the parent).

**Reuse-sweep proposals (next round; no answer change unless noted):**
1. **`scopedNode(map, key, fallback, fresh)`** — factor `scopedKey`'s entry/COALESCE (`src/compiler/rel/map.ts`) and
   call it from `scalarMapFirstChild`, `mapHostChild` (`rel/lower/reduction.ts`) and mapTail's keyed-dedup `mapScope`
   (lower.ts ~3070); the shared `mayHold && valOf.kind !== 'scalar'` decline goes with it. ~12-15 lines. Subsumed by S9.
2. **`allOf(terms)`** in `build.ts` (= `terms.reduce(and, undefined) ?? TRUE`): replaces ~11 reduce sites
   (write.ts 3644/3696/3813/3824/3827/3941/3962/5965, map.ts:1976, lower/slice.ts:712, lower.ts:5525); the three R10
   sites stop emitting `1 = 1 AND`, and "reduce of empty array" (the R10 review TypeError) cannot recur.
3. **One TRUE/FALSE**: `predicate.ts:49 CONSTANT` moves to build.ts; `ALWAYS_PRODUCTIVE`/`NEVER_PRODUCTIVE`
   (child.ts 267/337), build.ts:390, record.ts:527, lower.ts:2789 and write.ts's ~8 fresh `eq(1,1)` reuse it. The
   identity folds in `caseWhen`/`choicePresence` then fire for write.ts's terms (SQL can only shrink).
4. **`reSourcedUnder` case 3 ends in `scalarChoice([{when: present, cv: value}], empty)`** (reduction.ts ~1533) —
   keep the `sameFraming` guard; restrict to `result === undefined` or carry the shared framing; SQL-diff the S7
   case-3 witnesses. ~7 lines.
5. **`armTyping(guarded, last)`** shared by `scalarChoice` (~1387) and `scalarCoalesceChild` (~1474): the
   static-type meet else per-row vtype CASE. ~8 lines, same SQL.
6. **`withChannelValues(rel, channels, set, prefix, fresh)`** in `alias.ts`: `bindAliases` (183-191) and
   `seedOuterAliases` (225-233) end in the same project. ~9 lines, same SQL.
7. **Per-origin `sample()` reuses the ranked-window builder** — give `perOriginWindow` (or a `rankedKeep` sibling)
   an optional empty partition and a `fence` flag; `sliceOp`'s sample path becomes one call. Keep `rn <= n` with no
   `rn > 0` and keep the Materialize fence (an unfenced RANDOM() window regressed `sample(n).fold()`). Fix the stale
   exclusion comment now regardless.
8. **`valueResume` uses `withEnclosing`** (lower.ts ~4110) — widen `withEnclosing` (`rel/lower/chain.ts`) to take
   `Iterable<string> | AliasMap`, so the enclosing-label set S6's `mapFirstFallback` reads has one writer.
9. Still open from the third round: reuse 1, 2, 4, 5 (3 is S8).

**Needs-human questions:** none raised this round.


### Next round (from the 2026-11-02 third round — read before picking items)

Landed this round, each on trunk after an unpiped `mise run ci` that printed "CI passed":
- `e8b93db8`: R8 + R9 (`MergeTraverser` fact; `collectionMembers` is the one Array|Set judge).
- `261bfb98`: S4, folding R1, R2, R3 and R12's §17 line.
- `a85c99b2` + `62226f6e` + `b73c4933`: S5, folding R4, R5, R6 and reuse proposal 2. The legCorrelated leg walk
  is now ANCHORED at its start element (`ChildSeam.anchored` / `anchoredSeed` in `src/compiler/rel/lower/filter.ts`),
  a correlated `[NOT] EXISTS` instead of a semi/anti join — the old plan was ~63× from N=1k to 8k.
- `3ed7002d` + `13acd8c7` + `6bb959c8`: R7 + R19, including the productive-null fix (`Presence { when, orValue }`).

Nothing was deferred whole. One residual was PARKED (R8's Map-first scoping, below). No round branch holds unlanded
work: `wf/r7-resourced-scalar-vtype-2-2` and `-2-3` were left in place only because their commit `402b7224` landed
as `13acd8c7` with a conflict resolution in `branch.ts`, so `git cherry` shows `+`; the content is on trunk.

**Shared root causes (one substrate item each, ordered BEFORE what they unblock):**
- ✅ **S6 LANDED (19115f5e..a33d7983, 2026-11-02).** Map-first `select('k')` where the traverser may be a Map, behind
  the shared select dispatch: the Map's entry when it holds `k`, else `mapFirstFallback` (`src/compiler/rel/lower.ts`)
  — the `withSideEffect` constant, or nothing; the per-row Map test is emitted only where that fallback is a constant
  or nothing. Covers the R8 residual, the single-driver map-tail `option(Merge.onCreate, __.select('k'))` (onCreate
  may restate, never override, a per-driver merge map), and the write-arg `cannotBeMap` fold. Remains: the
  multi-driver `inject(maps).mergeV().option(onCreate, __.select('k'))` stays declined until `mergeVFromMap`'s
  interleaving guard and created-map correlation are positional (the R10/F7 class); lifting it is a one-line change
  at the "NARROWED to ONE driver" comment in `mergedFromMap`. The plain multi-driver map mergeV is quadratic on trunk
  already. These still decline because there is no framing for an entry-or-side-effect value per row: a select or
  format over a valueMap or a list/map value side, `format` over an optional record field, and `select` of an optional
  `project()` field. Where the Map may hold the key, a named collection or path label behind it still drops the row
  (§17).
- **S6. Map-first scoping for `select('k')` on any host that may be a Map.** `Scoping.java:119-135`
  (`vendor/tinkerpop/gremlin-core/.../traversal/step/Scoping.java`) reads the traverser's own Map entry before the
  side effect and the path. Today only the record/map tails know that; the scalar tail assumes "a static scalar can
  never be a Map", and a write arg folds `select('k')` to the side effect under `cannotBeMap`. The substrate is ONE
  per-row reader: the Map entry when the traverser is a Map holding `k`, else the side effect/path value (one
  `json_type`/`json_extract` term, computed once). It unblocks, in this order:
  1. the R8 residual: `g.withSideEffect('k',[name:'se']).V(1).property('m',[k:[name:'mm']]).values('m').mergeV(__.select('k')).values('name')`
     gives `['se']`; the reference gives `['mm']`. Plain scalar-tail `select('k')` over a map-valued property has the
     same wrong answer (pre-existing, not newly exposed).
  2. the map-tail `option(Merge.onCreate, __.select('k'))`, which R8 turned from answer into a clean decline
     (`g.withSideEffect('k',[age:5]).inject([name:'x']).mergeV().option(Merge.onCreate, __.select('k')).valueMap()`
     answered `[name:[x], age:[5]]` on trunk, correct whenever the driver Map lacks `k`). `MergeVertexStep.java:103`.
  3. widening `cannotBeMap` in `verifyWriteArgs` (`src/compiler/ir/write-args.ts`): `elementKindAt` cannot type a
     list/path/VertexProperty stream, none of which can be a Map, so `…V(1).fold().mergeV(__.select('k'))` now
     declines where trunk raised the reference's `ValueParseError`. A "cannot be a Map" kind beside `elementKindAt`
     restores the error; with S6 it becomes moot.
  Separate prerequisite, NOT part of S6: the `project(…)`/record and `inject(map)` drivers with `select('k')` decline
  until `mergeFromTraversal` accepts a record or map driver.
- ✅ **S7 LANDED (1254d29e, 2026-11-02).** `choicePresence(arms, otherwise)` (`src/compiler/rel/child.ts`) builds a
  choice's presence as a CASE over the same guards as its value; `scalarChoice` (`rel/lower/reduction.ts`) builds the
  value/vtype/presence CASEs from one branches array for both `scalarChooseChild` and `scalarChooseOptions`, and
  `reSourcedUnder` case 3 calls the same helper (SQL byte-identical). Forms with no stated arm compile unchanged; no
  baseline moved. Remains: nothing.
  **S7. A choose's presence is built from its arm GUARDS.** R7 made `meetPresence` (`src/compiler/rel/child.ts`)
  return `'unknown'` for any arm with a stated `{ when }` presence, so `scalarChooseChild` (`reduction.ts` ~1409) and
  `scalarChooseOptions` (~1371) now DECLINE a choose with a re-sourced arm that trunk ANSWERED correctly:
  `g.V().map(__.choose(__.hasLabel('person'), __.V().values('name').order().limit(1), __.constant('x')))` →
  `[josh,josh,x,josh,x,josh]`, and the `…V().values('age').sum(), __.constant(0)` form → `[123,123,0,123,0,123]`.
  The null-arm variant (`…__.V().constant(null).limit(1), __.V(99).values('name')`, reference 4×null) was a WRONG
  answer on trunk and now declines. Fix ONCE: `meetPresence` takes the arm guards and returns
  `{ when: CASE pred THEN presenceOf(then) ELSE presenceOf(else) END }` — the shape `reSourcedUnder` case 3 already
  writes by hand, which then calls the helper instead of being a second copy. This also unblocks where/not over a
  choose body (`g.V().where(__.choose(__.hasLabel('person'), __.V().values('name').order().limit(1), __.constant(null)))`).
  Pin the choose-arm case (with and without a null arm) in `test/compiler/resourced-scalar-value.exec.test.ts`; its
  absence is why CI missed the regression.
- ✅ **S8 LANDED (`c9b06ee8`, `c16d4b52`).** `collapsedToOneRow`/`exactlyOneRow`/`atMostOneRow` are views over ONE
  recursive `rowBounds` (`src/rel/bounds.ts`, after Calcite's `RelMdMinRowCount`/`RelMdMaxRowCount`); a may-be-empty
  map-entry body states presence as `EXISTS` (`oneRowPresence`), so a productive null entry is not read as absent.
  `V().map(__.V().count().dedup())` drops its per-row guard (352 → 76 bytes); pinned in
  `test/compiler/row-bounds.exec.test.ts`. Remains: nothing.
- **S8. One row-count authority `rowBounds(rel) → {min, max}`.** There are now THREE hand switches over the same node
  kinds: `collapsedToOneRow` and `exactlyOneRow` (`src/compiler/rel/lower/reduction.ts` ~111/~130) and `atMostOneRow`
  (`src/compiler/rel/lower.ts` ~255). Calcite models this as one min/max authority
  (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/metadata/RelMdMinRowCount.java`, `RelMdMaxRowCount.java`).
  One walk answers all three and is more precise: a `Distinct` over exactly one row is exactly one row, and so is a
  literal `Limit ≥ 1` over one (`exactlyOneRow`'s docstring is wrong on the first point). Today
  `g.V().map(__.V().count().dedup()).count()` loses `'always'` for that reason: 77 → 353 bytes of SQL and a per-row
  `IS NOT NULL` with no user-visible reason (same answer). S8 absorbs reuse proposals 3 and 5 below.

**Follow-ups from review (major first).**
1. **M1 (major, SQL hygiene; from S4) — `hostKept` builds the by() projection over the ORIGINAL, possibly-absent
   host**, so a by() value already gated on the host carries the host predicate 2–3 times per row
   (`src/compiler/rel/modulator.ts`). Use the existing authority `presenceDischarged` (`src/compiler/rel/child.ts`
   ~293, "a body built under the gate owes no second copy of the same term"): build `projectionOf`/`typedOf` over
   `presenceDischarged(host)` whenever a `hostKeep` is attached. Witnesses (all linear, all correct, all
   over-weight):
   - `g.V().union(__.as("a"),__.identity()).as("b").dedup("a","b").by(__.constant(1)).count()` partitions by a
     `CASE WHEN <host present> THEN 1 END`, and its WHERE repeats the same `json_extract` predicate — 3 copies.
   - `…dedup("a","b").by(__.id()).count()` projects the key's correlated subquery as `rn18_s0` AND re-inlines it in
     the WHERE: one correlated subquery evaluated twice per row. sql-hygiene's twice-evaluated check does not cover
     this L4 shape; extend it while there.
   - `…where("a",P.eq("b")).by("name")` and `…by(__.constant(1))` add a `hostKeep` conjunct the value's own
     `IS NOT NULL` already implies.
2. **M2 (minor, rule "computed once"; from R7) — `reSourcedUnder` case 2 gates `vtype` with a second `gatedByHost`**,
   so the host-presence test runs twice per row
   (`g.V().as('a').optional(out().as('b')).map(__.select('b').V().values('age').sum())`, `r38`). Case 3 spells
   `present` twice in two `caseWhen`s. Leave `vtype` ungated (the row is filtered on `v IS NOT NULL`) or project
   `present` once.
3. ✅ **M3 LANDED (4a34b58a..4a0530df, 2026-11-02).** A null `property()` traversal value now REMOVES the key
   inside the one runtime writer, `runtimeWriteRows` (`src/compiler/rel/write.ts`): the null-seeing slots are taken
   as a snapshot before the write and their prior rows removed after it (only where the body is not `nullFree`); the
   body is evaluated once where its statements must agree, and `sample()` draws per traverser in a per-origin body.
   `nullValueGuard`'s data-dependent refusal is gone; matrix line updated. Remains: nothing.
   **M3 (data-dependent refusal, pre-existing class) — a null `property()` traversal value refuses through
   `nullValueGuard`** (`src/compiler/rel/write.ts`): `g.V().property('x', __.coalesce(__.values('age'), __.V().constant(null).limit(1)))`
   refuses on modern only because of the two software vertices. Trunk silently skipped the write (wrong when the key
   exists: the reference REMOVES it). Same as matrix line 196 (❌ a null property() traversal value). The real fix is
   "a null value removes the key"; it removes a refusal that depends on DATA, which CLAUDE.md calls an outage shape.
4. **`productivityFilter` still accepts a bare `Presence` string** beside the projection. The five `map.ts`
   group/groupCount callers and `sack.ts` ~214 pass `'value-nullness'`, so a host-absence drop could be forgotten
   there if their host ever becomes possibly-absent (not wrong today — the host is the chain traverser). Make the
   projection the only accepted shape, or comment why those hosts cannot be absent.
5. **Missing unit pins.**
   - `test/compiler/productivity-filter.test.ts`: `hostKeep ∧ valueKeep`; `hostKeep` alone when present is
     `'always'`; `hostKeep` NOT waived under ProductiveByStrategy (→ `{keep: hostKeep}`).
   - `exactlyOneRow` over `limit(1)`-over-filter and `having` (or S8's `rowBounds` once it lands).
   - R7: a host whose sack differs from the rooted body's seed
     (`g.withSack(1).V().sack(sum).by(__.constant(2)).map(__.V().sack())`, should decline); the S7 choose-arm pins.
   - S5's newly answering shapes, so a guard change cannot reopen the field-vs-label confusion:
     legCorrelated with a VALUE argument naming a non-correlated live alias
     (`g.V().as('x').out().as('a').out().as('b').where(__.as('a').out().where(P.eq('b')).has('name',P.neq('x'))).count()`
     → 2); match where-legs with a value argument naming an alias (→ 14; the `out('created')` over an alias named
     `created` form → 8); the record where guard on `scopeKeyReads`
     (`g.V().as('a').out().as('lop').as('c').select('a','lop').by('name').where(select('c').has('name','lop')).count()`
     → 3; `…where(__.select('c').constant('a'))` → 2).
   - `test/L4-addendum/source-union-starter.feature`: two former WRONG answers S5 turned into declines, as
     `@Unsupported` scenarios carrying the reference answer 6: `g.union(__.V().as('a').local(__.out().fold())).select('a').count()`
     (LocalStep keeps the outer path) and `g.union(__.V().as('a').groupCount('k')).select('a').count()`.
   - `'tree'` joined `KEYED_SIDE_EFFECT_WRITERS` (`src/compiler/ir/labels.ts`), which also widens
     `unlocatableSubPath` (right per `TreeSideEffectStep`, untested).
6. **S5 lost an answer it should record:** the source-union match-map exemption is now first-step-only, so
   `g.union(__.V().match(__.as('x').out().as('y'))).identity().select('y')` (answered on trunk) declines. Add an
   `@Unsupported` scenario or an outstanding-work line. The general fix is "the exemption holds while the traverser
   is still the arm's map", i.e. `identity()`/filters keep it.
7. **Cheap doc fixes.** `consumesPath`'s doc (`src/compiler/ir/labels.ts` ~446) cites `test/L2-ir/labels.test.ts`,
   which does not exist — the test is `test/compiler/path-labels.test.ts`. `test/L2-sql/match.sql.test.ts` still
   titles a test "(anti)" and calls the form a "multi-column ANTI JOIN"; it is now a Filter over a correlated
   `[NOT] EXISTS` on an anchored walk.

Still open from the round below: S3, R10 (with F7), R13–R18, and F8, F11–F13, F14b. R19 landed with R7.

**Depth gaps recorded this round (clean declines, unchanged from the parent commit; not defects):**
- **where-by / dedup-by (S4):** `where('a',eq('b')).by(…)` nested in where()/not(), inside
  `repeat(optional(out().as('a'))).times(n)`, or under ProductiveByStrategy; a scalar label under where-by/dedup-by
  (`values('age').union(as('a'),identity())…by(constant(1))`); `dedup('a','b')` inside coalesce or repeat;
  `dedup('k','a')` over a `project('k')` map; `map(__.valueMap().dedup('lang').count())`;
  `optional(outE().as('a')).dedup('a').by(label)`; the R1 shape inside where/choose/coalesce/optional/sideEffect.
- **record where-leg (S5):** the newly admitted value-argument leg answers only at the top of the record tail; it
  declines wrapped in `map`/`filter`/`local`/a union arm. `pathLabelsAt` has one production caller (`sourceUnion`).
  `g.union(__.V().match(…)).where(__.select('y')).count()` (reference 6). A multi-correlation where-leg declines in
  union-arm `where`, optional, coalesce, choose, filter, `where(where(…))`, sideEffect, `map(where(…))`, repeat
  bodies, a `select('a','b').by()` record host, and after `count().is()` in the leg body — anchoring removed the cost
  reason, so these are pure coverage gaps now.
- **re-sourced scalar (R7):** `project().by(__.map(__.V()…))`; where/filter/not/choose-predicate over
  `__.map(__.V()…)`; `group().by`/`order().by`/`groupCount().by` of it; coalesce, optional, sideEffect,
  `map(__.map(…))`, `map(__.local(…))`, `map(__.union(…))`, `map(__.optional(…))`, repeat bodies;
  `map(__.V().valueMap('name'))`, `map(__.V().values('age').order().fold())`, `map(__.inject(1,2.0d).order())`;
  property/list/map/path hosts (`properties('name').map(…)`, `fold().map(…)`, `valueMap().map(…)`, `path().map(…)`).
  Host-state over-declines (a sack still at its seed, a fresh `inject()` host, a label bound only in a nested arm) are
  tracked in `docs/outstanding-work.md` §4.
- **write args (R8/R9):** Set and List label hosts both decline in local/choose/optional/coalesce/map/sideEffect/
  repeat and for `addLabel/dropLabel(__.constant({}))` (the reference treats an empty Collection as no labels,
  `ElementHelper.getLabelsValue`).

**Reuse-sweep proposals (next round; no answer change unless noted):**
1. **One element-identity theta.** `src/compiler/rel/match.ts:thetaExpr` (~518) is the rule for "two element aliases
   are the same element"; `matchSteps`' `wpred` branch (~752-762), the no-by() identity branch of the
   `where(k1,P(k2))` lowering in `src/compiler/rel/lower.ts` (~5385-5397) and `aliasIdentityPred`'s eq/neq leaf
   (~5271-5276) are three more copies. Export a projection-taking `thetaOf(projA, projB, op, rel)` that `thetaExpr`
   wraps, so lower.ts does not mint the alias projection twice. About 12 lines; same SQL (re-check L2 snapshots only
   if relation-id minting order shifts).
2. **Two exports named `collectionMembers`.** `src/gremlin/frontend.ts:collectionMembers(a: Arg)` (~942) re-derives
   per-member types by hand; make it delegate to the R9 judge `src/gremlin/validate.ts:collectionMembers(value, type)`
   (no import cycle — validate imports only coerce/types) and rename it (e.g. `operandMembers`). The collection
   branch of `valueNodeOf` (`src/gremlin/types.ts` ~562) is a near-duplicate it can also absorb. Leave the two
   `Array.isArray` gates in `predicate.ts` ~900/~949 and `uncarried-literal.ts` ~61 alone unless `within($set)` is
   probed first — moving them would let a Set-valued bound param spread (a possible answer change).
3. **Fold `collapsedToOneRow`/`exactlyOneRow`** into one walk returning `'exactly' | 'atMost' | null`, so `rootedCount`
   walks once. Superseded by S8 if S8 is taken; otherwise the cheap half of it.
4. **`modulator.ts` ~515 reads presence through `aliasPresence`** (`src/compiler/rel/alias.ts`) instead of hand-
   translating `aliasGuard`: `present: aliasPresence(row.rel, projected.entry).present ?? 'always'`. One line, same
   SQL. (Overlaps the second round's reuse 5.)
5. **(Coverage; answer change decline → answer) `correlatedReduce` and `mapEntryChild` claim `'always'` from
   `collapsedToOneRow`** (`reduction.ts` ~1145/~1159/~1181 and ~2102/~2106-2111) and are protected only by a
   downstream decline. Use R1's rule `present: exactlyOneRow(tail.rel) ? 'always' : 'value-nullness'` (or S8). Probes
   that then likely answer, to pin as L4 witnesses against `ReducingBarrierStep`/`TraversalMapStep` in
   `vendor/tinkerpop/gremlin-core`: `g.V().map(__.out().count().is(0)).count()`,
   `g.V().map(__.out().fold().not(__.unfold())).count()`,
   `g.V().valueMap().unfold().map(__.select(values).unfold().count().is(5)).count()`.
6. Still open from the round below: reuse 1, 3–8, and their carried items (`firstPerPartition`, drop `prn > 0`,
   `unitRow`, `name()` takes the `Minter`, `ABSENT_VALUE`, `blockAliases`).

**Needs-human questions:** none raised this round.


### Next round (from the 2026-11-02 second round — read before picking items)

Landed this round, each on trunk after an unpiped `mise run ci` that printed "CI passed":
- `fa25b24e`: the text-literal decline sweep is unflaked.
- `8143edf2`: S2, the re-sourcing V()/E() arm honours the absent host.
- `e54b3a02`: reuse-sweep 1, `aliasElementHost`.
- `8cc14cd7`: F6, leg bodies see the row's labels.
- `30461694` and `311c95ae`: S1, one typed constant-name judge, and `mapSlot` is now injective.
- `71416f55`: source `g.union(…)` over the starter row.

Through S1 and S2 this also closed F1–F6, F9, F10, F14 (its first half), reuse 5 and reuse 6 of the round below.
Nothing was deferred or parked, and no round branch holds work that is not on trunk.

**Shared root causes (one substrate item each, ordered BEFORE the follow-ups they fix):**
- ✅ **LANDED (261bfb98, 2026-11-02), folding R1, R2, R3 and R12's §17 line.** `rootedCount` takes 'always' from
  `exactlyOneRow` (a Rel-level twin of `collapsedToOneRow` that excludes filter/distinct); `byProjection`/`byTyped`
  attach `hostKeep` once via `hostKept` and `productivityFilter` conjoins it; `dedupByLabels` uses
  `aliasElementHost`. Remains: nothing.
  **S4. A body's presence comes from ONE authority, and the CONSUMER gates on it.** Three follow-ups below (R1, R2,
  R3) share one defect. The consumer trusts a presence claim that is either wrong or that nobody honours:
  - `rootedCount` claims `'always'` from `collapsedToOneRow`, which means "at most one row", not "exactly one".
  - A where-by operand counts on each body arm to consult `hostPresence`, and a reducing `by()` does not.
  - `dedupByLabels` builds its host by hand with no presence at all.

  The fix: take presence from `ir/productivity.ts` `alwaysProduces`/`presenceOf` (that authority already returns
  false for `count().is(P.gt(0))`), and gate the by()/operand VALUE on host presence once, in
  `byProjection`/`productivityFilter`, not in each arm. Land this before R1–R3. They then reduce to witnesses plus
  the one-line `aliasElementHost` swap.
- ✅ **LANDED (b73c4933, 2026-11-02), folding R4, R5, R6 and reuse proposal 2.** One may-direction `pathLabelsAt`
  in `src/compiler/ir/labels.ts` (bound at any depth, cleared only by a top-level `consumesPath` step) drives the
  source-union guard; `legCorrelated` reads `scopeKeyReads` over the lifted right walk and declines on any live outer
  label; the record where guard reads `scopeKeyReads`. Remains: nothing.
  **S5. One "labels live at this position" judgement for every route that cannot carry the outer path.** Three
  follow-ups (R4, R5, R6) are one class: a route with no path decides which labels a read needs, and decides wrong.
  - Source-union `rootedLabelsOut` clears its set at every `isStreamBarrier`. It should clear only at a REDUCING
    barrier (`CHANNEL_BARRIER_POLICY` alias=consumed). `order`/`dedup`/`limit`/`aggregate`/`barrier` keep the path.
  - Its `match()` exemption holds even after a later step has replaced the binding map.
  - F6's `legCorrelated` exempts the leg's start label and its correlated labels, yet the fresh `V()` walk cannot
    see either.

  The fix: one helper in `src/compiler/ir/labels.ts`, built on `scopeKeyReads`. It returns the labels a downstream
  or inner read takes from the PATH (not from a map traverser) and the reducing barriers that clear them. Both
  routes call it and DECLINE on any label they cannot carry. Land this before R4–R6. It also absorbs reuse
  proposal 2 below.
- **S3 (carried). A write inside a child / multi-arm body.** Still the one substrate item for writes in arms.
  Nothing this round changed it.

**Follow-ups from review (major first).** All are pre-existing unless marked otherwise: trunk before this round gave
the same answer.
1. ✅ **LANDED via S4 (261bfb98, 2026-11-02).** `rootedCount` claims 'always' only from `exactlyOneRow`
   (`src/compiler/rel/lower/reduction.ts`); witnesses in `test/L4-addendum/absent-label-body-input.feature`. Remains: nothing.
   **R1 (major, wrong answer) — `count().is(P)` in a body is treated as always present** (via S4;
   `src/compiler/rel/lower/reduction.ts` `rootedCount`, `reSourcedUnder` case 3).
   - `g.V().map(__.V().count().is(0)).count()` gives 6; the reference gives 0 (`TraversalMapStep.java:52` drops a
     traverser whose child yields nothing).
   - `group().by(__.V().count().is(0))` gives `{null:6}`, and `project('x').by(__.V().count().is(0))` gives
     `{x:null}`.
   - Over `g.V().optional(__.out().as('a'))`, `map(__.select('a').V().count().is(6))` gives 6×6 plus 3 nulls; the
     reference gives 6×6. `group().by(…)` gives `{6:6, null:3}`; the reference gives `{6:6}`.
     `order().by(…).count()` gives 9; the reference gives 6.

   Fix it via S4: make `rootedCount` require that the reduction is the terminal step, or take presence from
   `presenceOf`. Add the `count().is()` forms to `test/L4-addendum/absent-label-body-input.feature`.
2. ✅ **LANDED via S4 (261bfb98, 2026-11-02).** The by() projection carries `hostKeep` where the host may be absent;
   `productivityFilter` (`src/compiler/rel/modulator.ts`) gates on it. Remains: nothing.
   **R2 (major, wrong count) — a where-by operand whose `by()` is a reducing barrier survives an unbound label** (via
   S4; `src/compiler/rel/lower.ts` `whereOperandHost`).
   - `g.V().union(__.as('a'), __.identity()).as('b').where('a', P.eq('b')).by(__.outE().count()).count()` gives 9; it
     should be 6.
   - The `out().count()` and `out().fold().count(local)` forms do the same.
   - The compound `P.eq('b').or(P.neq('b'))` gives 12.

   This contradicts the claim in `aliasElementHost`'s doc that "no host built off a label can drop it".
3. ✅ **LANDED via S4 (261bfb98, 2026-11-02).** `dedupByLabels` builds its host with `aliasElementHost` and drops an
   unbound key (the where-by rule, §17). Remains: nothing.
   **R3 (major, wrong count) — `dedup('a','b').by(…)` builds its alias host by hand with no presence**
   (`src/compiler/rel/lower/slice.ts` ~664, `dedupByLabels`). It is the last hand-built alias element host in `src/`.
   - `g.V().union(__.as('a'), __.identity()).as('b').dedup('a','b').by(__.id()).count()` gives 12.
   - `by(__.constant(1))` gives 1.

   Fix: `aliasElementHost(rel, proj, freshTraverserRow(rel))`. Then decide what `dedup` does over an unbound `by()`
   operand, in line with the where-by drop rule.
4. ✅ **LANDED via S5 (b73c4933, 2026-11-02).** Remains: nothing.
   **R4 (major, wrong answer) — a source-union rooted arm loses its labels across a non-reducing barrier** (via S5;
   `src/compiler/rel/lower/branch.ts` `rootedLabelsOut`).
   - `g.union(V().has('name','marko').as('a').out().order()).select('a').count()` gives 0; the reference and our own
     non-union form give 3.
   - The `barrier()`, `dedup()`, `limit(2)` and `aggregate('q')` arms do the same.
5. ✅ **LANDED via S5 (b73c4933, 2026-11-02).** Remains: nothing.
   **R5 (major, wrong answer / internal Error) — the source-union `match()` exemption holds after the map is
   replaced** (via S5).
   - `g.union(V().has('name','marko').match(__.as('x').out().as('y'))).select('x').select('y').values('name')` gives
     []; the reference gives vadas, josh, lop (`MatchStep.java:445,595` labels the path).
   - `…select('y').select('x')…` gives []; the reference gives marko×3.
   - `…select('y').out().select('x')` gives [].
   - `…select('x').as('z').select('y','z').count()` leaks a bare `Error: channel column 'a0' is already carried`.

   Restrict the exemption to a read whose input is the arm's map (Scoping.java:119-135), or decline. Add an L4
   witness to `test/L4-addendum/source-union-starter.feature`.
6. ✅ **LANDED via S5 (b73c4933, 2026-11-02).** Remains: nothing.
   **R6 (major, wrong answer) — `legCorrelated` admits reads of the start label and the correlated labels that the
   fresh walk cannot see** (via S5; `src/compiler/rel/match.ts` ~485-492).
   - `g.V().as('b').out().as('a').in().as('c').where(__.select('a').in().where(P.eq('c')).select('c')).count()` gives
     0; the reference gives 12.
   - `…select('a'))` gives 0, `…select('c').values('name'))` gives 0, and the `match()` spelling gives 0.
   - The `not(…)` form gives 12; the reference gives 0.

   Fix: decline every live outer label the body reads, and allow only the `P.eq`/`neq` operands that `legRight`
   turns into join conditions.
7. ✅ **LANDED (3ed7002d + 13acd8c7 + 6bb959c8, 2026-11-02).** `firstRootedValue` (build.ts) fences one Limit-1 MATERIALIZED row and reads value, per-row type (`relHostTag`) and `EXISTS` off it (`Presence { when, orValue }`), so the host never names a rooted column; a body reading host traverser state (sack, loops, path, unbound labels) declines in `rootedRead` (`'split'` vs `'source'`). Remains: nothing (per-host correlation of host state tracked in `docs/outstanding-work.md` §4).
   **R7 (major, bare internal Error) — the re-sourcing scalar arm leaks `RelIR: relation mfN has no declared column
   'vtype'` / `'vt'`.**
   - `g.V().map(__.V().values('name'))` and `g.V().optional(__.out().as('a')).map(__.select('a').V().values('name'))`
     both leak it.
   - So do the `.limit(1)`, `.order().limit(1)`, `.dedup()` and `coalesce(values('nope'), constant(9))` tails, and
     `map(select('a').V().values('age').sum())` / `…E().values('weight').max()`.

   These fail whenever the value is not wrapped by a downstream count or fold. Either frame the rooted value's
   type column or decline cleanly. Pin each case as an answer or a decline.
8. ✅ **LANDED (e8b93db8, 2026-11-02), with R9.** A `MergeTraverser` fact (`cannotBeMap`/`mayBeMap`, from
   `elementKindAt` and each lowering's input framing) is threaded through `src/compiler/ir/write-args.ts`'s
   `mergeMaps`/`resolveMergeArg`. A write-arg `select('k')` now folds to the side effect only where the traverser
   cannot be a Map. Under `mayBeMap` the query declines cleanly. Residual: a per-row scalar traverser that is a Map at
   runtime (for example a map-valued property) still lets `mergeV(select('k'))` fold to the side effect. Plain
   `select('k')` on the scalar tail has the same Map-first scoping gap. Fixing it needs the scalar-host select to check
   the Map entry first; it is not part of this round. Also, the `project`/record and `inject(map)` forms with
   `select(k)` now decline cleanly; answering them needs `mergeFromTraversal` to accept a record or map driver.
   **R8 (major, a valid query told it is invalid; newly raised by S1) — `select('k')` folds to the `withSideEffect`
   constant even when the traverser is a Map holding `k`.**
   - `g.withSideEffect('k',[(T.label):5]).V(1).project('k').by(__.constant([name:'marko'])).mergeV(__.select('k'))`
     now raises the `T.label` sentence. The reference reads the Map traverser's own `k` first
     (`Scoping.java:119-136`) and answers. Trunk before S1 declined.
   - The same happens with an `inject([k:…])` input and with `option(Merge.onMatch, __.select('k'))`.

   Fix: `constFromSelect`/`resolveMergeArg` (`src/compiler/ir/write-args.ts`) fold, and so judge, only when the
   select's input cannot be a Map (element input). Otherwise decline as before.
9. ✅ **LANDED (e8b93db8, 2026-11-02), with R8.** `src/gremlin/validate.ts` exports `collectionMembers`, the one
   Array|Set notion. `labelNames`/`foldedName` (and so `mutationLabelMembers` and `creationLabels`) use it, so
   `dropLabel`/`addLabel`/`addV` of a Set constant now act on its members.
   **R9 (major, wrong label kept) — a Set constant is not a Collection to `mutationLabelMembers`**
   (`src/compiler/rel/write.ts`, `Array.isArray`).
   - `g.V(1).dropLabel(__.constant({'person'}))` and the `withSideEffect('k',{'person'})…select('k')` form raise
     "…must produce a String or Collection<String>, but got: [\"person\"]". The reference drops `person`
     (`TraversalUtil.java:211-236` accepts any Collection). Trunk before S1 silently did nothing.
   - `addLabel(__.constant({'x'}))` has the same problem.

   Share `constantName`'s Collection notion rather than deciding it again.
10. ✅ **LANDED with F7 (3c7ba931..4c565396, 2026-11-02).** The interleaving guard pairs collapsed TUPLES
    (first/last ord) over an equi key (`PairKeying`/`searchKeying`), the search seeks per driver with the old test
    as residual (`seekedSearch`), and the creation join uses `Distinct`'s identity (`createdPerDriver`), all in
    `src/compiler/rel/write.ts`; `test/support/snapshot-scans.ts` flags an unkeyed snapshot self-join and a base
    table scanned per snapshot row. mergeE constant 43 → 58 ms (1k → 8k, was 43×); every witness 2.5–4.7×.
    Remains: nothing. (Now unblocked, separate: S6's multi-driver `inject(maps).mergeV().option(onCreate,
    __.select('k'))` one-line lift at "NARROWED to ONE driver" in `mergedFromMap`.)
    **R10 (major, performance) — per-traverser `mergeE` is super-linear.**
    `g.V().hasLabel('p').mergeE([(T.label):'kk',(Direction.from):1,(Direction.to):1])` takes 132 ms at N=1k and
    5,326 ms at N=8k (about 40×; 29–39× after S1). Same class as F7's `mergeV` O(N·V) below; fix them together.
    Give the match join an equi key, and extend `test/support/snapshot-scans.ts` to flag a base-table scan driven
    per snapshot row.
11. ✅ **LANDED (39085c4d, 2026-11-02).** A multi-correlation where()/not() leg seeds its anchored walk with the
    outer labels the body reads (`seedOuterAliases`, `src/compiler/rel/alias.ts`, beside `bindAliases`), so the
    body runs unchanged and `where(P.eq(label))` filters at its own position before any dedup/limit/range;
    `legRight`, the `mcN` channels and the post-walk `on` are deleted. Witness now gives 12; scaling linear
    (2.4x-5.3x, 1k->8k). Only a whole-path read (`path()`) inside the leg still declines. Remains: nothing.
    **R11 (wrong count, pre-existing) — `dedup()` inside a where leg dedups across ALL rows.**
    `g.V().as('b').out().as('a').in().as('c').where(__.select('a').in().where(P.eq('c')).dedup()).count()` gives 7;
    the reference gives 12. `TraversalUtil.test` resets the child for each traverser, so `dedup()` cannot remove a
    traverser's existence. Record it in `docs/outstanding-work.md` if it is not taken.
12. ✅ **LANDED via S4 (261bfb98, 2026-11-02).** Citations corrected; §17 line "an unbound where/dedup key drops the
    traverser" added. Remains: nothing.
    **R12 (minor, doc + §17) — the `getSafeScopeValue` citation is wrong.** At the pin, `Scoping.java:141-147`
    RAISES `IllegalArgumentException`. `getNullableScopeValue` is the variant that returns null.
    - Correct the citation in the `aliasElementHost` doc (`src/compiler/rel/alias.ts`), in the header of
      `test/L4-addendum/absent-label-where-by.feature`, and in `slice.ts` ~651.
    - Add a §17 line: "a `where()`/`where().by()` key unbound on a traverser drops that traverser (Java raises
      IllegalArgumentException)". `src/compiler/ir/labels.ts:314` already reads it right.
13. **R13 (minor, cheap) — the text-literal flake moved to a neighbouring test.**
    `test/text-literal.test.ts` "end to end: the decoded literal is the value a step sees" timed out at 5.2–6.4 s
    under load. Its `one` helper seeds a new store on each of 7 calls, and the 's'-suffix and char-literal tests
    seed 3 each. Have `one` and those tests share one lazily seeded store, like `declineStore`; every query there is
    a read. Drop the hard-coded "~80 ms / ≤15 ms" figures from the comment.
14. **R14 (minor, cheap) — `desugarPropertyMap` still calls `mapEntryType(entryType, String(k))`**
    (`src/compiler/ir/strategies.ts` ~481). It should pass `k`. It is inert today because the token-keyed property
    map declines. Reuse proposal 6 removes this whole pattern.
15. **R15 (minor, cheap) — pin the number-class change S1 made but did not name.** A `withSideEffect` constant now
    keeps its stated type: `3.0d` → double (was int), `3L` → long, `1.5f` → float, `[1,2L]` → int,long, datetime →
    datetime. Add a test for at least the `3.0d` → double case (3 vs 3.0 is visible to users).
16. **R16 (minor) — `mapSlot` comments overclaim.**
    - Parsed and wire token keys agree for `T` only: `Direction.from` and wire `Direction.OUT` get different slots
      (inert, since nothing mixes the two producers).
    - A typed wire or GraphSON map `{Int 1, Long 1}` still collapses to one entry silently. Either say so in the
      comment, or decline the pair at `src/wire.ts:64` / `src/formats/graphson.ts:155` as the literal path does.
    - `mapSlot` repeats the `isTokenArg`/`isDirectionArg` shape probes. Put the slot spelling next to `TaggedArg`, or
      fall back to a collision-free JSON spelling, so a third tagged key kind cannot collide.
17. **R17 (minor, SQL weight) — a constant `by()` under presence types the constant through a correlated
    `VALUES` subquery** (349 → 910 chars of SQL for the where-by witness). Fold a constant by() under presence to
    `CASE WHEN <present> THEN <literal> END`.
18. **R18 (minor) — missing pins.**
    - Negated-reducer legs that now answer: `not(__.select('a').values('age').sum())` → 4;
      `…mean()/min()/max()` → 4; `not(__.select('a').select('b').project('x').by('name'))` → 0;
      `not(__.select('a').select('b').values('age').is(P.gt(30)))` → 3.
    - A String key spelling a token (`'T.label'`) next to the real token key.
    - Set constants for `dropLabel`/`addLabel` (with R9).
    - The wire-typed Int `1` + String `'1'` map.
    - The read-back of `[1:'a','1':'b']` through `valueMap()`/`properties()`.
19. **R19 (minor) — `reSourcedUnder` compares framings with `JSON.stringify`**, which depends on key order. Use a
    structural equality helper. It is safe today because a mismatch declines.

Still open from the round below: F7 (with R10), F8, F11, F12, F13, and the second bullet of F14 (now reuse
proposal 5).

**Depth gaps recorded this round (clean declines; not defects):**
- **S2 arm:**
  - `map(select('a').V().fold())`, and groupCount/group/inject tails.
  - coalesce/union/choose/filter/sideEffect arms holding `select('a').V()…`.
  - `select(all,'a')` and `select('a','b')` hosts.
  - `map(map(…count()))`, and `repeat(map(…count()))`.
  - inject-map and valueMap hosts.
  - `local(…count().math().fold())`, `flatMap(…count().math())`, and `local(…values('age').sum())`.
  - a value-label host from `optional(values('age').as('a'))`.
- **where-by:**
  - repeat-bound labels.
  - coalesce/optional/where/not wrappers around the whole chain.
  - `P.within`/`P.without`, and a two-element by() ring.
  - by() bodies that are `select`, `constant(null)`, `fold`, `project`, `union`, `local` or `map`.
  - where-by after a `values().as('c')` reroot.
  - the `not(where('a',P.eq('b')).by(…))` twin (should answer 6), `filter`/`choose` over where…by, and a `match` leg
    whose body is where…by. These all decline through the child-predicate route.
- **S1:** `dropLabel` inside choose/where/flatMap/map/optional/sideEffect/repeat, `local(__.mergeV(…))`, and a
  per-row `dropLabel` body (S3 covers most of these). The `[1:'a','1':'b']` map works only as a stored property
  value; it declines in inject/constant/project/select/count(local)/unfold, and as a `mergeV` value.
- **F6:**
  - repeat `until`/`emit` and `shortestPath` predicates pass no aliases (`walk.ts:202/216`, `shortestpath.ts:203`), so
    `g.V().as('a').repeat(__.out()).until(__.select('a').hasLabel('person'))` declines.
  - `where(select('a').select('a','b'))` and `…select('b').by('name')` decline, as does a leg wrapped in
    coalesce/choose/optional/map/project-by/group-by/sideEffect.
- **Source union:**
  - a nested `union` as an arm's first step, and `g.union(constant(1), V().count())` (mixed arms).
  - `g.withSideEffect('m',[a:1]).union(select('m'), constant(2))`, and `g.withSack(1).union(…).V().sack()`.
  - writes in starter arms (S3).
  - `g.union(constant('x')).path()`, which needs an empty path seed on the starter.
  - `g.union(V().as('a'), V().has('age',29)).count()`, whose arms bind labels unevenly (the `mergeArms` route).

**Reuse-sweep proposals (next round; no answer change unless noted):**
1. **`choose()` conditions go through `childPredicate`**, the one predicate entry. Today they go through
   `bodyPredicate` directly at `src/compiler/rel/lower/reduction.ts` ~1312 and `src/compiler/rel/lower/branch.ts`
   ~1127, and `branch.ts` ~1016 passes no aliases. The change picks up the select-reroot, the match head and the
   mapping-terminal fallback. ANSWER CHANGE (decline → answer):
   `g.V().as('a').out().choose(select('a').hasLabel('person'), constant(1), constant(2))` and its
   `has(age,gt(30))` and `map(choose(…))` forms. Net about 0 lines.
2. ✅ **LANDED via S5 (b73c4933, 2026-11-02).** **Callers that only decline read labels through `scopeKeyReads`, not `labelReads`.** The sites are
   `src/compiler/rel/match.ts` ~490 (`legCorrelated`) and the `src/compiler/rel/lower.ts` ~5544 record where-scope
   guard. A body that uses the label's string as a VALUE (`constant('a')`, `has('name','a')`, `out('a')`) then
   stops declining. `labelReads` stays for the callers that delete. Fold this into S5.
3. **One emits-from-empty authority instead of three step-name tables.** Export `emitsFromNothing(step)` from
   `src/compiler/ir/productivity.ts`. It should cover the name set plus the `!isLocalScope` refinement and the
   keyed-argument refinement now held by `seedsUngated`. Then derive `SEEDED_TERMINAL` (productivity.ts ~28),
   `EMITS_FROM_NOTHING` (~152) and `branch.ts` `SEEDS_OVER_EMPTY` (~108) from it. A `count(local)` tail then takes
   the cheaper `gatedByHost` branch; only the SQL gets shorter.
4. **One alias-reroot core.** Add `aliasValueSubject(rel, proj, key?, present?)` beside `aliasElementSubject` in
   `src/compiler/rel/alias.ts`, and let both take a key and presence override from `rerootPresence`.
   `filter.ts:selectRerootSubject` then becomes two calls and `match.ts:scalarSubjectOf` is deleted (about 20–25
   lines). A value-label subject then cannot drop presence either.
5. **`aliasPresence` is the only judge of a label's presence.** `src/compiler/rel/modulator.ts` ~486 and
   `src/compiler/rel/record.ts` ~649 work it out again from `aliasGuard`. After this change `aliasGuard` keeps one
   outside caller (the record filter). This also covers the second bullet of F14. The SQL is unchanged.
6. **`mapEntryOf(tn, key)` next to `mapEntryType`** in `src/gremlin/types.ts`. It replaces the `tn.t === 'map' ?
   tn.entries[mapSlot(k)]` guard written out at `write-args.ts` ~548, `rel/map.ts` ~1247, `gremlin/float.ts` ~39
   (two lookups per entry), `wire.ts` ~107 and `types.ts` ~573. Do R14 with it. Compile time only.
7. **`caseWhen` is the one single-arm CASE builder.** Move it from `child.ts` ~287 to `src/compiler/rel/build.ts`,
   delete `operator.ts` ~129 `when`, and write `modulator.ts:gatedOn` as one call to `caseWhen(presenceOf(…), …)`.
   The SQL is unchanged.
8. **Build `VALUE_ARGUMENT_STEPS`** (`src/compiler/ir/labels.ts`) **from `VERTEX_MOVES`/`EDGE_MOVES`**
   (`src/compiler/ir/step.ts`) with `unionOf`, so a new move step is added in one place.
9. Still open from the round below: reuse 2 (`firstPerPartition`), 3 (drop `prn > 0`), 4 (`unitRow`) and 7
   (`name()` takes the `Minter`), plus 2026-11-01 proposals 6 (`ABSENT_VALUE`) and 7 (`blockAliases`).

**Needs-human questions:** none raised this round.


### Next round (from the 2026-11-02 round — read before picking items)

Landed this round, all on trunk with green CI: `803e8252` (`name()` takes the compile's minter, so the bare
`duplicate Plan binding 'r0'` is gone), `2184440a` (constant labels judged by ONE `constantName`), `89ca89d8`
(absent label ⇒ the rerooted body's INPUT is empty, carried as the host's `Presence`), `0dce4db8` (taken snapshots
that are read again are spooled as fenced `MATERIALIZED` CTEs, plus one `rankedFirst` first-pick policy). Nothing was
deferred or parked. The source-union item above has since LANDED as `71416f55`, rebased over `89ca89d8`'s presence
authority.

**Shared root causes (one substrate item each, ordered BEFORE the follow-ups they fix):**
- **S1. ✅ LANDED (30461694, 311c95ae) — one constant-label judge at EVERY host, typed.** *Landed:* `constantName`
  moved to `src/gremlin/validate.ts` and judges every name the query TEXT holds with the type the text states — merge-map
  `T.label` (`labelNames`, `validateLabel` refuses a non-String), `dropLabel(<traversal>)` via `mutationLabelMembers`
  (`mutationLabelNames` deleted), `withSideEffect` constants keep their declaring `Arg` (`SideEffectConstants`), and a
  constant property key folds through `KEY_NAME`; the map TypeNode's per-key slot is `mapSlot(key)`, now injective so a
  token key no longer shares a String key's slot. *Remains:* nothing for S1. Not fixed here: the super-linear
  per-traverser mergeE (29–40×) is a pre-existing problem in the mergeE lowering and needs its own item.
  Three follow-ups below (F2, F3, F4) are one defect class.
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
1. ✅ **LANDED via S2 (8143edf2).** **F1 (major, wrong answer, same on trunk) — the V()/E() arm skips the absent-host gate** (`src/compiler/rel/lower/reduction.ts`
   `scalarChildValue`, ~1471, returns `present:'always'` before the gate runs). On modern, with
   `g.V().optional(__.out().as('a'))` (9 rows, 3 unbound):
   - `.map(__.select('a').V().count()).fold()` gives [6×9]; the reference is [6×6].
   - `.map(__.select('a').V().values('name')).count()` gives 9; the reference is 6.
   - `.local(__.select('a').V().count())` gives 6 on the unbound rows; the reference is 0.
   - `local(select('a').E().count())` is also wrong.
   - `project('x').by(__.select('a').V().count())` keeps `x:6`; the reference omits the key.

   Fix it via S2. This also contradicts `hostSelfRow`'s claim to be "the ONE place".
2. ✅ **LANDED via S1 (30461694).** **F2 (major, wrong element written, same on trunk) — the literal merge-map `T.label` bypasses `constantName`.**
   Each of these writes the wrong label; the reference raises in every case:
   - `g.mergeV([(T.label): 5])` writes the label `'5'`, and a UUID value writes its text.
   - `[(T.label): ['a', 5]]` writes `['a','5']`.
   - the `option(Merge.onCreate|onMatch, [(T.label): 5])` forms do the same.
   - `g.mergeE([(T.label): 5 or UUID, …])` does the same.

   References: `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeElementStep.java:263-306`,
   `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/ElementHelper.java:258-281`.
   Fix it via S1. The map's TypeNode exists, so the typed judge is available there.
3. ✅ **LANDED via S1 (30461694).** **F3 (major, wrong label dropped, same on trunk) — `dropLabel(<traversal>)` validates nothing.** The builder said
   this "matches the reference", which is false. The reference resolves through `TraversalUtil.resolveStringArguments`
   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/DropLabelsStep.java:98-103`),
   with the same rules as `addLabel` except the empty/hidden check:
   - `g.V(1).dropLabel(__.constant(['person', 5]))` drops `person`; the reference raises before any drop.
   - `dropLabel(__.constant('person'), __.constant(5))` drops `person`; the reference raises.
   - `dropLabel(__.constant(null))` is a silent no-op; the reference raises.

   Fix: `constantName` with `ADD_LABEL_NAME`'s null/notString/collection rules, minus `validateIdentifier`. Then
   `mutationLabelNames` goes away.
4. ✅ **LANDED via S1 (30461694).** **F4 (major, wrong label written, same on trunk) — a UUID side-effect constant is written as a label.**
   `constFromNested`'s `withSideEffect` arm (`src/compiler/ir/write-args.ts:68`) has no TypeNode, so it infers
   `'string'`:
   - `g.withSideEffect('k', UUID(…)).addV(__.select('k'))` writes the uuid text as a label.
   - `withSideEffect('k', ['a', UUID(…)]).V(1).addLabel(__.select('k'))` does the same.

   Fix it via S1. Its prerequisite is that the side-effect registry keeps a typed value's type.
5. ✅ **LANDED via S2 (8143edf2) — one presence term per map expression; one copy remains in the `WHERE` from the
   existing produced-values filter.** **F5 (major, sql-hygiene) — nested gates repeat the same per-row presence term.**
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
7. ✅ **LANDED with R10 (3c7ba931..4c565396, 2026-11-02)** — see R10 above (`seekedSearch`/`computedMatch`,
   `src/compiler/rel/write.ts`). Remains: nothing.
   **F7 (major, depth) — a per-traverser `mergeV` map is still O(N·V).**
   `g.V().mergeV(__.project('name').by(values('name'))).count()` takes 2.9 s at N=3000 and 11.7 s at N=6000. The match
   join drives a spooled snapshot as the OUTER loop against `nodes` with a non-equi `(pp0 = 0) OR EXISTS(…)`
   predicate. `test/support/snapshot-scans.ts` misses it because the snapshot is outer. Either extend the detector to
   flag a full base-table scan driven per snapshot row, or give the match join an equi key. Record it in
   `outstanding-work.md` if it is not taken.
8. **F8 (minor, cheap) — make `rankedFirst`'s order key total.** Add `vt` as a third sort term (it is already a
   column, so this is no new per-row term). Today int `1` and double `1.0` tie, so the number class written is
   decided by scan order (`src/compiler/rel/write.ts`).
9. ✅ **LANDED via S1 (30461694).** **F9 (minor) — say the eager-raise change in §17.**
   - `g.V().limit(0).addLabel(__.constant(5))`, `…has('name','nobody').addLabel(__.constant(null))` and a statically
     dead `choose` arm now raise at compile time where the reference answers `[]` / `[v1]`.
   - `g.addV(__.constant(null))` changed from a decline to `Label can not be null`.

   §17 "Error timing" says "`limit(0)` still answers `[]`", which these cases contradict. Amend that line to cover a
   constant argument judged at compile time, and pin one empty-input case in a test.
10. ✅ **LANDED via S1 (30461694).** **F10 (minor) — render non-scalar values readably in `constantName`'s `notString`.** Today it prints `String(value)`:
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
14. ✅ **LANDED (first bullet) via reuse-sweep 1 (e54b3a02) — `rerootPresence`; the `aliasGuard` spelling bullet is
    carried as reuse proposal 5 of the round below.** **F14 (minor, cheap) — the reroot presence is spelled twice.**
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
5. ✅ **LANDED via S1 (30461694).** **Fold constant PROPERTY keys through `constantName(KEY_NAME)`** (`src/compiler/ir/write-args.ts:parseProperty`'s
   uuid/datetime carve-out and `key == null → kind:'none'`). Keys and labels then share one judge. **ANSWER
   CHANGE:** `g.V(1).property(__.constant(5), 1)` and `property(__.constant(null), 1)` go from an UnsupportedTraversal
   decline to KEY_NAME's reference sentences. Land it together with S1.
6. ✅ **LANDED via S2 (8143edf2) as `child.ts:caseWhen`; the remaining consolidation is reuse proposal 7 below.**
   **One `gateOn(pred, value)` CASE primitive**, split out of `child.ts:gatedByHost` and used by
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

**✅ LANDED 2026-11-02 (`71416f55`) — Source-position `g.union(…)` over a one-row STARTER.** `d85bc022` + `0ec60b2f`
re-landed as one commit; `a163f5a8`'s code (`guardedPredicate`, the `scalarChildValue` CASE) and `0ec60b2f`'s
`aliasGuard` conjunct were dropped, and its witnesses were kept, passing through trunk's `hostPresence`/`gatedByHost`.
Mechanism: a source union whose arms open off the starter is the chain-position `unionArms` over ONE starter `VALUES`
row (`literalSource`, shared with `injectSource`, `src/compiler/rel/lower/branch.ts`); `g.union()` is the empty
relation; downstream label reads are judged by `scopeKeyReads` (`src/compiler/ir/labels.ts`). L3 1,883 → 1,885.
Remaining: nothing. (The history below is kept for its reference citations.) It was originally parked because `a163f5a8` REGRESSES its parent with lost rows / wrong counts. Both open defects share ONE root cause:
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
  treating `label()` as a mapping terminal in `productivity.ts`, which other callers share). DONE as `71416f55`
  (`wf/source-union-starter-arms-1-3` is superseded and holds nothing to resume).
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
