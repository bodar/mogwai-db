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
  seek that lifts a `has(k,v)`'s correlated `EXISTS` into a driven `DISTINCT` join (`src/rel/passes/seek.ts`,
  gated `propertySeek`, `GATE_ONLY_FAST_PATHS`). Both are physical statements of a fact the traversal
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
| **`seek`** | lifts a correlated property `EXISTS` in front of the scan it filters, as a DISTINCT relation the plan is driven from. Switched by `propertySeek` |
| **`fuse`** | 🚧 small semantic rewrites. Ask what still buys anything the assembler doesn't before wiring it |
| **`flatten`** | 🚧 join flattening / decorrelation into the P1 envelope; deletes `expandRepeatBody`. Most of it dissolved into `block.ts`'s legality analysis |
| **`recognize`** | 🚧 the fast paths as plan rewrites, so a fast-path decline can be lifted |

**Declared is not wired.** Only `name` and `seek` have production callers; there is no object that
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
  CONSUMER is what is left. Unlocks the group-scoped reducer (`count()` with a non-empty body, and a SCALAR
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
  refused in front of it) AND the demanded-order branch merge (below). ⚠️ Cost: choosing WHICH
  traversers an unordered `limit` returns is legal (TinkerPop specifies only membership) but moves an
  answer digest → re-record the census with that argument. The ARM-BLOCKED order a `union`/`choose`
  (`BranchStep`) presents is `[arm_ordinal, arm-local position, tie]` and its within-arm tie is per
  SHAPE (element → id); `coalesce` is per-traverser (`[parent position, tie]`) instead. The
  POSITIONLESS half already landed: a `union` over an ordered input, or with an arm-local
  `order()/limit()`, drops the spent order and merges (`dropEncounter`, `unionArms`) — correct because
  a union is unordered — and declines only when `ctx.ordered` says a downstream slice/collect reads
  the fan-out order (which is what this mint would supply).
- **`recognize` (§4) — the fast paths as plan rewrites,** so a fast-path decline can be lifted.

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

**Leaf gaps — one family, no downstream unlock:**

- **Exact REAL → JSON.** SQLite's JSON *writer* uses 15 significant digits and cannot round-trip a binary64
  (the parser is exact). Apply ONLY where precision is lost: `CASE WHEN CAST(printf('%.15g',v) AS REAL) = v
  THEN v ELSE json(printf('%!.17g',v)) END`. ⚠️ Four traps, each cost a cycle: (1) a JSON-ENTRY rule, NOT a
  stored-value rule — in `storedValueOn` it corrupts the ROW path (`values('weight')`→JSON text a later
  `fold()` quotes); (2) gate on the VTYPE, not `typeof(value)` — the value can be a whole correlated subquery
  spliced three times; (3) `%.17g` drops real-ness (`1.0`→`1`), `%!.17g` always writes 17 digits
  (`0.2`→`0.20000000000000001`) — hence the lossy-only guard; (4) SQLite's JSON subtype survives only when
  `json()` is the aggregate's direct argument.
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
- **Two `sack` declines** — `withSack(seed, Operator.x)` (a MERGE policy for the role) and
  `barrier(Barrier.normSack)`. Both honest.
- **Meta-property under an UNDECLARED cardinality** (2 writes) — the `set` arm PATCHES rather than inserts;
  needs an `UPDATE` this route does not emit.
- **`with()` on a write · singletons** (`addE` after `addE`, `addInE`; ~10 writes) — one reason each.
- **L4 sweep** — two committed expectations encoded a since-deleted implementation's bug; nobody has swept
  the rest.
- **Plan-size wart** — `byNode`'s property arm nests the collection CASE inside itself; one commit.

Families still largely open (rank live via `rel-blockers`): the scalar-transform tail, branch (the
SOURCE-position `g.union(a, b)` and the option-keyed `choose(<projection>).option(k, arm)` where the
choice is a body rather than a `T` token — the arm-merging half is now ONE dispatcher over three builders
at both per-row shapes, `BRANCH_HOSTS`/`branchArms`, and a token choice is `tokenChoice`), row ops
(`Column`-keyed and the `path()` tails), aliases (`select`, dominated by `Pop.all`/`Pop.mixed` history
reads), side effects, then `local`, `match`, `where`, the `path` tails.

🚧 **The next callers, named because each is now a SINGLE missing caller rather than missing algebra** — the
pattern this whole stage kept finding:
- **the branch family over the PROPERTY tail — the BRANCH half LANDED.** `Subject` grew a third
  `property` variant (mirroring the `property` `ChildHost`), `branchSubject` answers the property framing,
  and `childHostOf` maps it — so `union`/`choose`/`coalesce` all fold their condition/arm bodies through a
  property host and compose. What is LEFT on this tail is `project`/`select`/`where`, which do not route
  through `branchArms`: they need a call-site in `propertyTail` (the host is already built). Also note the
  pre-existing `coalesce`-exhaustion-over-scalar gap (`coalesce(__.identity(), __.identity())` declines on
  ANY scalar, property included) — orthogonal to the branch subject, in the guard machinery.
  **`constant` is now a SINGLE shared retype** (`constantRetype`) reached from every tail — element,
  scalar, list, property, map — rather than two copies plus three gaps.
- **the SCALAR and RECORD tails declaring a `RowShape`.** They call `orderRows` from their own loops, so
  neither gets `dedup`'s identity rule; the map and list tails are not in it at all.
- ✅ **a set op over an ELEMENT-member list — LANDED.** `listSetOp` admits an element-membered self+operand
  when both are the SAME kind, comparing by ROWID (`ElementHelper` hashes/equals an Element by id AND
  class, so a vertex rowid never equals an edge's), and the result keeps its element `of`. A cross-kind
  operand and element `product` decline (a mixed-element or bare-framed-rowid result the payload layer
  cannot carry). The corpus names only the ERROR forms (`combine(__.V())` — a non-folded stream is not
  iterable), so this is pure combinatorial completeness (0 L3).

⚠️ **A merge over a DEMANDED position still declines** — where `ctx.ordered` says a downstream
slice/collect reads the fan-out's emission order, `union`/`choose`/`coalesce` decline rather than let a
bare `LIMIT` read incidental `UNION ALL` byte order. That is §10's "mint one deterministic window order
over a whole fan-out" seen from the branch side. The POSITIONLESS half landed for all three callers — `union`, the boolean `choose`, and `coalesce`:
each drops the spent order and merges when `ctx.ordered` is false (`Union`/`Choose`/`Coalesce.feature`
are all unordered, and a terminal coalesce's per-traverser order is unobserved anyway — no root demand
orders the wire). The DEMANDED-order half of all three (a downstream slice/collect over the fan-out)
still declines and waits on the mint: arm-blocked `[arm_ordinal, arm-local position, tie]` for the two
`BranchStep`s, per-traverser `[parent position, tie]` for `coalesce`.

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
(`has(k,containing(t))` routes the trigram index and DECLINES until `recognize`).

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
