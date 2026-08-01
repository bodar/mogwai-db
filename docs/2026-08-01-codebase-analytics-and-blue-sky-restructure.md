# Codebase analytics: duplication, complexity, split concepts — and the rebuild that follows

**Status: analysis session, 2026-08-01, measured against `c69d101`, rebased onto `1299ff1`. No code
landed.** Every number comes from an instrument run in this session, not from a prior doc.

**Trunk moved 17 commits between the measurement and the push, and three findings changed as a
result — all three corrections are kept in place rather than edited away** (§4a, §5a, and item 1 in
§9). Two cited defects closed; one predicted consolidation landed independently and confirms the
method. Read §4a and §5a before acting on §4 or §5: the first *weakens* this doc's biggest claim and
says so, and the second is the only forward-reasoned structural prediction in this repo's history to
have been confirmed rather than falsified.

**What this doc owns, now that RelIR is decided.** It owns the *measurements of the codebase as it
stands*: where the duplication is (§1–§2), where the complexity is (§3), which concepts are split
against `gremlin-core` (§4–§5), and the diagnosis that follows (§6). It **stops at the diagnosis**.
The design, the measured SQLite envelope, the object model and the build order are
[relir-build-plan](./2026-08-01-relir-build-plan.md), which supersedes §6's design half and §9's
ranking. Nothing about RelIR's construction is repeated here, so the two cannot drift.

This doc answers four questions asked together: where is the duplication, where are the overly
complex paths, what large refactor is worth doing, and — using `gremlin-core` as the reference —
where have we split a concept the reference keeps whole. It ends with the blue-sky restructure.

**It is subject to this repo's own base rate.** Structural need predicted forward from an
architecture sketch has been falsified by measurement ~12 times here
([shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md):164–180). So §§1–5 are
measurements, §6–7 are a design, and §9 gives each proposal a *pre-committed kill criterion* rather
than a rationale. Nothing here relitigates a refuted item; §8 lists what I deliberately did not
propose and why.

---

## 0. The instruments

Three, all reusable, none added as a dependency:

| Instrument | What it answers |
|---|---|
| normalized line-run clone detector (type-1 and identifier-blind type-2, sliding window + maximal extension) | where is text duplicated |
| `documentSymbol`-driven function ranker (LOC, decision count, `throw` count, `return null` count) | where is the complexity |
| dispatch-table key extractor over the 11 `*_DISPATCH` maps | where is the *semantic* duplication |

The third matters most. The first two are standard; the third is the one shaped to this codebase,
because in a compiler that dispatches on shape, duplication does not look like duplicated text — it
looks like the same step name appearing in eleven tables with eleven handlers.

**Scale, for calibration.** 29,049 hand-written LOC in `src/` (the generated `parser/` excluded, at
`1299ff1`), ~1,240 functions. `compiler/steps/tail/` alone is **11,201 LOC — 39% of everything
hand-written**, and
that concentration is the single most important number in this document. It is where every finding
below lands.

---

## 1. Textual duplication is effectively zero — and that is the finding

Exact-clone detection over `src/**` (6-line window, comments and brace-only lines normalized out)
returns **14 groups, but most are sliding windows over the same clone**. Collapsed to distinct pairs
there are **six — four substantive and two parameter lists**:

- `tail/mapscalar.ts:445-458` ≡ `:521-534` — 13 lines, the `option()` arm scan (key/`Pick.none`
  triage), and `:475-480` ≡ `:541-546` — 6 more, the `CASE WHEN`/productive-`CASE` builder. **Both
  pairs are the same two functions**: `lowerChooseOptions` (`:412`) and `lowerChooseOptionsScalar`
  (`:510`). One `choose().option()` lowering written twice, once per parent shape.
- `ir/strategies.ts:933-939` ≡ `:982-988` — 7 lines, the repeat-region gather loop, in
  `formRepeatRegions` and in `tryUnroll`.
- `write/write.ts:676-686` ≡ `:1417-1427` — 11 lines, the write-continuation object literal.
- Two 6-line **parameter lists** repeated between sibling functions (`tail/child.ts:643` ≡ `:665`,
  `write/write.ts:60` ≡ `:94`). Not duplication in any meaningful sense — noted only so the group
  count reconciles.

The identifier-blind (type-2) pass adds nothing structural: its top hits are lookup-table literals
(`gremlin/types.ts:183-199`, `context/context.ts:295-368`, `gremlin/math.ts:32-42`), which are
supposed to look alike.

**Four substantive clones in 29k lines is an exceptionally clean result**, and it is worth stating
plainly because it forecloses a whole class of proposal. There is no "extract the duplicated helper"
refactor available here. Whatever duplication costs this codebase, it is not costing it in text.

The corollary is the useful half: **the duplication is semantic, and only an instrument shaped like
the architecture can see it.** That is what §2 measures.

---

## 2. The dispatch-adapter tax — measured, mechanical, and not yet recorded in this form

Eleven shape dispatch tables, 94 explicit entries, **49 distinct step names**. Of those, **20 names
are implemented in more than one table, accounting for 65 of the 94 entries** — 69% of the dispatch
surface is a step name that exists in at least two tables.

```
table        explicit keys        table        explicit keys
FOREIGN            2              PATH                3
LIST               9              VARIANT             3
MAP                9              RECORD              5
MAP_ENTRY          3              ELEMENT            18
GROUP              5              SCALAR             27
PROPERTY          10
```

Top multiply-implemented names:

```
10x  count     LIST MAP MAP_ENTRY GROUP PROPERTY PATH VARIANT RECORD ELEMENT SCALAR
 5x  where     LIST PROPERTY PATH VARIANT RECORD
 5x  unfold    LIST MAP GROUP VARIANT SCALAR
 5x  is        LIST MAP GROUP PATH SCALAR
 5x  order     MAP GROUP PROPERTY RECORD ELEMENT
 5x  select    MAP MAP_ENTRY GROUP RECORD ELEMENT
```

**But the interesting split is inside `count`, and it is not what the raw 10 suggests.** Reading all
ten handlers:

- **Five are byte-identical adapters** — `(s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)`
  at `group.ts:1076`, `list.ts:697`, `path.ts:381`, `select.ts:726`, `variant.ts:175`. Same function,
  same wrapper, five copies.
- Five genuinely differ (`listCount`, `tailCount`, `scalarCount`, and the two custom lambdas at
  `group.ts:735` / `list.ts:635`), and §7 of the shape doc is right that some of that difference is
  *load-bearing* — a grouped `PathStream` has one row per position, so `COUNT(*)` would count
  positions.

The same pattern holds for `where`: **four byte-identical `aliasCompareRows` registrations**
(`group.ts:1068`, `list.ts:518`, `path.ts:378`, `variant.ts:173`), plus two composed forms.

So the honest finding is narrower and sharper than "count is implemented ten times":

> **The shared handlers already exist. What is duplicated is the *adapter* that wraps them for a
> dispatch table** — `(s, _step, _steps, at) => continueLowering(F(s), at + 1)` — and it is copied
> once per table per shared op.

`globalRowOps()` (`tail/barrier.ts:227`) is the fix already built for exactly this, and an LSP
reference query shows it reaching **7 sites** (5 at the time of measurement, 2 added since). **`ELEMENT_DISPATCH` (18 keys) and `SCALAR_DISPATCH` (27 keys) —
the two largest tables, 45 of the 94 entries — do not use it at all.** That is item 17's claim,
independently re-derived, and the fresh number is that the un-shared half of the dispatch surface is
not a minority: it is the majority of it.

This is the cheapest real refactor available and §9 ranks it first. It is also the one with a live
trap, already recorded and worth repeating because it cost 42 corpus traversals: a shape table is a
`Map`, the **last duplicate key wins**, and `dispatchShapeTail` consults exactly one handler per
name — so spreading a shared op into a table that already owns that name *replaces* the incumbent,
and a handler that declines falls to the fallback throw rather than through. Compose with `firstOf`
(the pattern already at `projection.ts:872`).

---

## 3. The two complexity outliers, and what shape their complexity has

Ranking all 1,238 functions by LOC and by decision count produces the same two at the top, by a wide
margin. Nothing else is close.

| Function | LOC | decisions | throws | file |
|---|---|---|---|---|
| `repeat` | **296** | **75** | **15** | `steps/prefix/branch.ts:791` |
| `tryLowerGroupChildSource` | **285** | **71** | 2 | `steps/tail/group.ts:212` |
| `walkArgs` | 162 | 42 | 2 | `gremlin/frontend.ts:377` |
| `compileScalarChildRows` | 155 | 32 | 4 | `steps/tail/child.ts:486` |
| `compileInlinePredicate` | 145 | 51 | 1 | `steps/prefix/predicate.ts:181` |

The third through fifth are large but ordinary. The top two are structurally different from each
other and both are worth naming precisely, because they fail in *opposite* directions.

### 3a. `repeat` — a validator wearing a compiler's clothes

Of its 296 lines, the great majority is **admission control, not lowering**. Reading `:791-899`, the
function computes, in sequence: region lookup, a named-loop refusal, an emit-predicate flag, a times
type-check, an until flag, three pairwise-interaction refusals (`until`+`times`, `until`+`emit`, none
of the three), an emit-before/after position, body normalization, a `simplePath` tail check, a
body-aggregate extraction with its own nested `local()` unwrap, a movement filter, an edge-step
probe, a sack-fold probe, a body-vocabulary predicate, a `has()`-arity probe, a flat-expansion
recognition flag, a single-move fast-path flag, a sack column resolution, a depth bound, a
path-output flag, and two more path refusals — **before any SQL is built**.

That is 15 `throw` sites and ~20 derived booleans in one lexical scope. The complexity is not
accidental and none of the individual checks is wrong; the problem is that **the admission decision
and the lowering decision are the same function**, so every new `repeat()` capability has to be
threaded through a scope that already holds twenty flags.

The file itself already names the deeper half of this. `expandRepeatBody` (`:710`) carries a comment
calling it *"a private movement/filter mini-compiler: its own direction table, its own edge aliases,
its own has() handling — a second implementation of what the StepFns already do, and therefore a
vocabulary wall"* (`:764-768`). It stays deliberately, as the frontier-lazy fast path, with
`tail/keyed.ts` as the generic fallback. **That is the right call and I am not proposing to remove
it** — but it means `repeat` is hosting two lowerings plus the triage that chooses between them, and
the triage is what has grown to 296 lines.

### 3b. `tryLowerGroupChildSource` — eight eager boolean gates

The opposite failure. `group.ts:212-297` computes **eight `genericX` booleans** —
`genericKey`, `genericProjectKey`, `genericVal`, `genericReducer`, `genericFold`,
`genericElementFold`, `genericElementImplicitFold`, `genericGroupVal` — each by calling a different
classifier over a re-derived body, and then:

```ts
if (!genericKey && !genericProjectKey && !genericVal && !genericReducer && !genericFold
    && !genericElementFold && !genericElementImplicitFold && !genericGroupVal) return null;
```

Every gate is computed **eagerly**, whether or not an earlier one already decided the case; several
call `classifyScalarChildRows` or `classifyElementChildRows` over the same body with different
parameters. This is accretion by one boolean per supported scenario — the exact pattern
`steps/CLAUDE.md` warns about ("extend the generic seam, don't special-case the scenario"), arrived
at from inside a family rather than from outside it.

The tell that it is accretion rather than essential complexity: the comments read as a changelog of
which gate was added when and what it fixed (`:226-234` is an eight-line explanation of why two
classifiers must both be tried, ending "`count` was special for no semantic reason"). Essential
complexity does not need that; a decision table does not accumulate archaeology.

**The refactor is a triage table, not a rewrite.** These eight gates are a `(key-shape, value-shape)
→ lowering` relation. Written as data — one row per admitted combination, with the classifier and the
emitter named per row — the function becomes a lookup plus the emit it already delegates to, and a
ninth combination becomes a row rather than a boolean plus a clause in a nine-term conjunction. That
is the same "register in a Map, never grow a switch" rule the compiler already applies everywhere
else; group is where it was not applied.

### 3c. The deferral surface, freshly counted

`throw` sites across `src/` excluding `parser/`: **627**, of which ~218 say *"not yet supported"*.
The tree-wide count in outstanding-work item 5c is **533** by its own instrument (`src/compiler`,
`src/sql`, `src/execute.ts`), so these are different denominators and should not be diffed — but 627
against 29k LOC is **one throw every 46 lines**, and that is the real texture of this codebase. It
is a *correct* texture given "fail closed, never mis-execute", and it is also why complexity
concentrates in triage functions rather than in lowering functions: the hard part here is deciding
what you are willing to answer.

---

## 4. The largest split concept: reads compile, writes interpret

This is the biggest finding in the document, and `gremlin-core` settles it in one line.

**In TinkerPop, a write step is a map step.** `AddVertexStep` is declared
`public class AddVertexStep<S> extends ScalarMapStep<S, Vertex> implements AddVertexStepContract<S>`
(`vendor/tinkerpop/gremlin-core/.../step/map/AddVertexStep.java:48`), and it lives in `step/map/`
alongside every read step. `MergeVertexStep`, `MergeEdgeStep`, `AddEdgeStep`, `PropertyMapStep` — all
in `step/map/`. Mutation is a **marker interface** (`step/Mutating.java`, `step/Writing.java`), not a
separate execution model. There is exactly one traversal machine.

Here, there are two:

| | read path | write path |
|---|---|---|
| output | `Compiled { sql, binds, shape }` | `WritePlan { run: (store) => WriteResult[] }` |
| execution | one SQL statement, SQLite's planner traverses | JS loop, **44 `store.*` calls** in `write.ts` |
| step handling | `StepFn` registered in a Map, folded by the engine | `for` loop over `steps` with `if/else` on `s.name` |
| composition | any step, any position, via the generic seam | a fixed set of chain shapes, each with a bespoke parser |

`runWriteChainFull` (`write/write.ts:813-835`) is the clearest exhibit — a literal step interpreter:

```ts
for (let i = 0; i < steps.length; i++) {
  const s = steps[i];
  if (s.name === 'addV') { … while (…) propSteps.push(steps[++i]); … }
  else if (s.name === 'as') { … }
  else if (s.name === 'addE') { const cluster = parseEdgeCluster(steps, i); i = cluster.next - 1; … }
  else throw new Error(`write-chain step not supported: ${s.name}()`);
}
```

Index arithmetic over siblings, an if/else chain on step name, and a mutable `currentV` cursor. Three
of those are things `src/compiler/steps/CLAUDE.md` explicitly forbids ("no sibling/index scanning
inside a step compiler", "never grow a switch", "never build a second implementation"), and the root
`CLAUDE.md`'s locked decision #3 forbids the fourth: *"Compile to SQL, never interpret. Row-at-a-time
JS interpretation is the failure mode this project exists to avoid."*

`parseEdgeCluster` (`:730`), `parseVertexSpec` (`:357`), `parseMergeOptions` (`:1148`) and
`resolveEndpoint` (`:845`) are four more private mini-parsers over `Step[]`, and
`materializeElementDrivers` (`:631`) is the seam where the read path's relation is drained into JS
rows so the interpreter can iterate them.

**Why this is under-recorded rather than unrecorded.** The repo knows about it, but files it as a
narrow execution-model question: `outstanding-work.md`'s Internal-debt entry says *"`write.ts`
row-at-a-time nested read — … purely the execution-model question"*, and
`.claude/rules/schema-storage.md` calls it *"an acknowledged imperative surface"*. Both framings are
about the **nested read** inside the write path. The measurement says the scope is larger: it is not
that the write path does a row-at-a-time read, it is that **the write path is a second traversal
machine**, with its own step dispatch, its own argument parsers, its own composition rules, and its
own result type.

### 4a. Two of the three consequences closed while this was being written — read that carefully

I first wrote this section citing three live defects. Between the analysis and the push, trunk moved
17 commits and **two of the three closed**. Both the correction and what it does to the argument are
recorded here rather than quietly edited out, because the direction of the update is the interesting
part.

- **Silent wrong answers — ✅ CLOSED, and my citation was stale.**
  `addV('animal').property('name','mateo').property('name','gateo').property('name','cateo')` keeping
  only `cateo` was **fixed 2026-08-01**; `write-path.md:47-54` marks W1 closed, all five silent wrong
  answers, L3 1679 → 1689. **Note that `outstanding-work.md` item 16 still asserts this defect as
  live** — the index is stale in the *pessimistic* direction here, which is the rarer of the two it
  warns about, and worth a sweep.
- **The determinism gap — ✅ CLOSED.** Item 20's three write rows were id-assignment order; `04b5080`
  made the driver consume its input in emission order and the perturbed census went **4 → 1**. The
  one row left is item 4's `repeat`/`range` boundary, not a write row.
- **The composition wall — still open.** Item 10 (`addV` mid-chain, read-tails-after-write) remains,
  and it is the one that is *structural* rather than a defect: the interpreter has no way to be *in
  the middle of* a compiled relation. `compileMidAddV` (`:645`) is the workaround — materialize
  drivers to JS, loop, re-compile a read per driver (`:680-683`).

**What this does to §4's argument, honestly.** It weakens the urgency and it strengthens the
strongest counter-position: *the interpreter is incrementally fixable, and it is being incrementally
fixed, fast.* Five silent wrong answers and three determinism rows closed in a day is not the profile
of a structure that has to be replaced. Anyone reading §4 as "this must be rewritten now" is reading
it wrong, and the measurement above is why.

What survives is narrower and does not depend on any open bug:

1. The structural facts are unchanged — a second step dispatcher, four private `Step[]` parsers, an
   interpreter loop with sibling index arithmetic, a separate result type.
2. **The defect rate is the signal, not any single defect.** `write-path.md:290` records *"One defect
   the W1 work EXPOSED, now fixed (`3d9222f`) — **and the shape to expect more of**"* — the plan's own
   words. Extending the interpreter keeps producing defects of the same shape, each cheap, each found
   by the census. That is a *tax*, not a crisis, and the question a rewrite has to answer is whether
   its one-time cost is below the integral of that tax. I do not have that number and neither does
   anyone else yet.
3. Item 10 is the one consequence a contract widening cannot reach, because it is about *position in
   a relation* rather than about what a driver can resolve.

So §9 ranks the write-path RelIR slice **behind** a measurement, not ahead of one — and the tranche
owner's incremental route is winning on evidence at the time of writing.

Item 0b's `ModulationContract`/`ElementReadDriver` work is the right direction and is real progress;
the point of this section is that it is being pursued as *contract widening on an interpreter* rather
than as *replacing the interpreter*, and the ceiling of the first is lower than the second.

---

## 5. Split concepts, against the reference

Beyond §4, the reference-versus-us comparison finds three more, of which **only the first is a
defect**. Recording the other two as *deliberate and correct* matters as much, because both look like
duplication to a fresh reader and both have already been proposed and rejected.

| Concept | `gremlin-core` | Here | Verdict |
|---|---|---|---|
| **Mutation** | a marker interface on an ordinary map step (`Mutating`, `Writing`) | a separate module, result type and execution model | **Split that should be one** (§4) |
| **Row operations** | `Ranging` / `Barrier` / `LocalBarrier` interfaces; `Scope` chooses global vs local at builder time | `globalRowOps()` (global) + `rankedRows()` (per-origin), both in `tail/barrier.ts`, both gating on `cardinalityOf` | **Was a split; closed on trunk 2026-08-01 — and the way it closed is §5a** |
| **Step organization** | by semantic category (`map` 124, `filter` 30, `sideEffect` 22, `branch` 6) | by **position** (`prefix/` 2,984 LOC, `tail/` 11,177) | **Correct as-is.** The prefix fold's stop-boundary is a structural fact of the compiler, not a filing convention — it is what decides `range`/`limit` before-vs-after `order()`. Already argued and settled in [tinkerpop-core-engine-alignment](./2026-07-29-tinkerpop-core-engine-alignment.md) §4.6; the measurement here does not disturb it. |
| **Capability dispatch** | ~35 marker interfaces + `instanceof` chains | registration in a `Map` | **Correct as-is, and better here.** A Map lookup is total and a missing key fails closed; an `instanceof` chain falls through silently. Same doc, §7. |

### 5a. This one closed mid-analysis, and it closed *as predicted* — which is the useful part

My first draft of this row said we express "the same operation, global or per-partition" as **two
unrelated code paths**: a shared `globalRowOps` table, and five private scalar-only functions
(`partitionedSlice`, `partitionedTail`, `rootTail`, `partitionedOrder`, `partitionedDedup`). The
argument was that all five share one skeleton — rank with `ROW_NUMBER() OVER (PARTITION BY origins
ORDER BY <key>)`, filter on `rn`, rebuild — differing only in the order key and the `rn` predicate,
and that the global versions differ in exactly one respect: **the `PARTITION BY` clause is empty**. So
it is not five functions' worth of concept; it is one operator with a partition parameter.

**`f9597ca` landed `rankedRows` on trunk while this was being written, and that is exactly what it
is.** Four of the five are now call sites of one builder; `partitionedOrder` stays separate on merit
(it *mints* an encounter in place rather than ranking and filtering, which is a different operation,
not a variant of the same one). The row above is corrected accordingly.

I am leaving the reasoning in rather than deleting it, because **the independent convergence is
evidence about the method, not about the row.** The prediction was derived from a duplication
measurement plus the `gremlin-core` comparison; the implementation was derived from the row-op matrix.
They arrived at the same operator within hours of each other. That is the first time in this repo's
recorded history that a forward-reasoned structural claim was confirmed rather than falsified — the
base rate is ~12 falsifications — and it is a meaningful (if single) data point for §9's step 5,
which asks the same *kind* of question one layer up.

**Two things the landed version teaches that my draft did not anticipate**, both of which sharpen §6:

- **The partition parameter had to be a CALLBACK, not a column list.** `barrier.ts:126-129` states
  why: a per-origin dedup partitions by *the traverser's value*, and *"that authority does not
  exist — the callback is how the scalar site keeps its own knowledge of `v` while sharing the
  skeleton."* This is the same missing authority the shape doc §7 identified, item 17 still names,
  and `Scope.local` needs. **A callback is the honest workaround for a missing concept, not the
  concept.** RelIR does not fix this by itself and §6 should not pretend otherwise.
- **`lowerScalarRows` is untouched** — still the ~100-line if-chain, still the one tail never
  transposed to a dispatch Map (item 17 says so explicitly in its updated text). Sharing the
  *skeleton* did not dissolve the *dispatch*, which is precisely the "re-encoding, not
  simplification" risk §6 lists against itself.

---

## 6. Blue sky: the missing middle

Here is the structural claim, and it is the only large one in this document.

> **The compiler has a front end and a back end and no middle.** `Step[]` is lowered directly to SQL
> text. At no point does the query exist as *data the compiler can inspect or rewrite*.

The evidence is in the kernel. `Query` (`sql/kernel/q.ts:153`) holds `private ctes: Cte[]`, and
`cte()` / `recursiveCte()` **append**; there is no API to read one back, rewrite one, reorder them, or
fuse two. A CTE's `body` is an `Expression` — a lazyrecords SQL-template tree, so it is inspectable as
*syntax* but never as *relational structure*. `render()` walks the list once and emits text. The
kernel is, in the sense that matters, **write-only**.

This is a deliberate and successful design for what it does — `src/sql/CLAUDE.md`'s guardrails
(fail-closed on absent columns and undefined holes, two rendering modes and exactly two) have
demonstrably killed bug classes. The claim is not that the kernel is wrong. It is that **the absence
of a middle layer is what forces three otherwise-unexplained structures**, each of which the codebase
has independently discovered and documented as an oddity:

1. **The fast-path layer exists because optimization cannot happen after lowering.**
   `options/fast-paths.ts` recognizes sub-shapes *in `Step[]`, before lowering*, and emits specialized
   SQL. With an inspectable plan these would be plan rewrites — the normal place for them — and the
   whole `equivalentWhen`/enabled≡disabled apparatus would be a plan-equivalence property rather than
   a per-path committed test. (The apparatus is excellent; it is compensating for the missing layer.)

2. **`TailAcc` exists because `order()` + `limit()` must be fused before either is emitted.** Item 17
   records that converting it *"is architectural, not a spread — its fusion into one SELECT is what
   makes `order()`+`limit()` correct in a single statement"*, and that this is why `ELEMENT_DISPATCH`
   is the one shape not on the dispatch substrate. Operator fusion is a textbook mid-end peephole. It
   is an accumulator here because there is no plan to peep at.

3. **Row-ops split global from partitioned** (§5) because the partition key is not a *value* anywhere
   — it is implicit in which function you called. Given a `partitionBy` parameter, global is the case
   where it is empty and per-origin is the case where it is the origins. **The duplication does not
   need to be shared; it needs to stop existing.** (`rankedRows` had to take that parameter as a
   *callback* because, in its own words, "that authority does not exist" — §5a.)

So the blue-sky restructure is a three-stage compiler instead of a two-stage one:

```
Gremlin text  ──parse──▶  Step[]  ──lower──▶  RelIR  ──emit──▶  SQL text
                            │                   │                  │
                     Pass pipeline        plan rewrites:      the q kernel,
                      (unchanged)      fusion, unrolling,      unchanged
                                      partition keys, pruning
```

**One sentence on why this is not the refuted "typed core IR", because §8 would otherwise seem
contradicted:** that refutation is about putting **Gremlin shape** into the **`Step[]` IR**, which
every consumer would then have to construct; RelIR sits on the *other side* of lowering — it is what
lowering *produces*, no Pass ever sees it, and it carries no Gremlin shape vocabulary at all. Stated
in full, with the falsifier that would prove it violated, in the build plan §2.

**The node set, the passes, the emitter and the phases are the build plan.** An abbreviated sketch
of them used to sit here and has been removed rather than maintained in two places — a partial node
list competing with the authoritative one is worse than no list.

### 6a. `repeat()` is the sharpest test of the diagnosis, and it passes

Asked whether `expandRepeatBody` is the same smell, I probed SQLite directly rather than reasoning
about it. Two findings, both now owned by the build plan (§1 P1–P4) and stated here only as
conclusions:

- **`expandRepeatBody` is a hand-written join-flattener, not a platform workaround.** Everything
  `REPEAT_BODY_OK` refuses — anti-joins, a join against a derived `UNION`, `IN (SELECT …)`, `LEFT
  JOIN` with the walk on the left, correlated scalar subqueries — is **legal SQLite in a recursive
  term**. The vocabulary wall is ours. It exists because nothing in the pipeline can flatten, which
  is this section's claim in its purest form.
- **No per-iteration barrier is expressible in a recursive term in any lowering** — a platform wall,
  and a stronger statement than "no `LATERAL`". But it binds only 5 of 53 corpus barrier bodies: the
  other 48 are `times(n)`-bounded and unroll, and unrolling removes the recursive term rather than
  working around it.

**→ The design, the measured envelope, the object model and the build order are
[relir-build-plan](./2026-08-01-relir-build-plan.md).** This document deliberately stops at the
diagnosis; everything downstream of "the middle is missing" lives there, so the two do not drift.

## 7. If we rebuilt from scratch

Keeping every locked decision (TinkerPop 4, generated parser, compile-never-interpret, reuse the
client's GraphBinary, front-end/compiler boundary) and every hard-won semantic in `test/`, the
structure I would choose:

**The layer structure is the build plan's** ([relir-build-plan](./2026-08-01-relir-build-plan.md)
§2–§5: the clean-room boundary, the complete object model, the passes, the emitter). Not repeated
here. What follows is the part that is *not* about RelIR — what a rebuild should carry over
untouched, and one thing neither codebase has.

**What I would keep verbatim**, because the measurement says it is working and because most of it was
paid for in bugs:

- The `q` kernel's fail-closed contracts, and both rendering modes with the subclass split.
- The Pass categories and their ordering constraint.
- `RowBatch`/`bindChunks` and both bind-limit gates (`mise run binds`, `test:cf-limits`) — a
  production-only wall that shipped twice is a permanent gate.
- The `Sql`/`IoStore` seams, and DI by scope.
- The whole test ladder, and especially the **census** — it is the only instrument that can tell a
  refactor "20 deferrals quietly became wrong answers" from "behaviour preserved", and no restructure
  in this document is safe to attempt without it.
- The LSP tooling. `refs.ts` over grep is not a convenience; the `standardRegistry` measurement (16
  textual hits, 11 real references, all in `test/`) is why.

**What I would not rebuild:** the fast-path layer as a separate concept (it becomes plan rewrites),
`TailAcc` (it becomes fusion), the five `partitioned*` functions (they become a parameter), and
`WritePlan` (it becomes plan nodes).

### 7a. A fourth unfinished consolidation — the guards exist, the call sites never moved

This one is new, it is cheap, and it **corrects a stale claim in an existing doc**, so it is recorded
here rather than left as a line item.

[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §3 says the front end
mints 14 ad-hoc tagged tokens of which *"**12 have no declared type anywhere**"*, that detection is
`'tag' in a` at every consumer, and that *"only `{nested}` has a guard"*. **All three statements are
now false.** `gremlin/frontend.ts:83-108,245` declares a `TaggedArg` union and **15 type guards** —
`isOrderArg`, `isPopArg`, `isColumnArg`, `isTokenArg`, `isDirectionArg`, `isMergeArg`,
`isCardinalityArg`, `isCardinalityValueArg`, `isGTypeArg`, `isPickArg`, `isWithOptionArg`, `isDtArg`,
`isOperatorArg`, `isScopeArg`, `isNested` — each a proper `arg is Extract<TaggedArg, …>` predicate
over one `tagged()` helper. The vocabulary was built.

**What was never done is converting the consumers.** Measured this session, `'<tag>' in ` detection
still appears at **61 sites across `src/` (excluding `parser/`)**, and only **1** of them is in
`frontend.ts` — so this is entirely a *compiler-side* residue, not a front-end one:

```
by file                          by token
14  tail/mapscalar.ts            27  nested      (guard: isNested)
13  write/write.ts               20  token       (guard: isTokenArg)
 6  tail/scalar-arm.ts            4  pick        (guard: isPickArg)
 5  prefix/branch.ts              3  operator, 3 direction, 2 merge,
 4  tail/group.ts                 2  column, 1 pop, 1 cardinality
 …11 more files, 1-3 each
```

Every one of the nine tokens in that right-hand column has a declared guard. `nested` and `token`
alone are ~47 of the 61.

This is a **fourth instance of the exact pattern shape-doc §4 names as this repo's recurring failure
mode** — *"The designs already exist, are already written down, and are already right. What failed
three times is finishing them; in each case the first consumer was converted and the rest kept a
local alias or a hand-written copy so their call sites would not move."* §4 lists `ScalarType`,
`VALUETYPE_TO_CANONICAL` and `streamPayloadCols`. This is the same shape, undetected because the
grep that would find it (`'x' in `) looks like ordinary TypeScript narrowing rather than like a
duplicate.

It is also a **rename-safety hole of the same species as the `as any` item**: `'nested' in a`
survives a field rename and silently stops matching, invisibly to `tsc` — which is precisely defect
#1 in the 2026-07-29 sweep's post-mortem ("*`as any` defeats it entirely — 16 sites*"). A guard call
does not survive it; it fails to compile. So converting the 63 is not tidying, it is closing the same
hole from the other side.

**Do it token by token, not file by file** (`isNested` first, 27 sites, then `isTokenArg`, 20), each
one commit, census after each — because a `'token' in a` site that also reads `a.token` needs the
read converted with it, and mixing two tokens in one commit is what makes that review not scale.

**One thing I would add that does not exist in either codebase:** a declared, machine-checkable
**deferral taxonomy**. 627 throws, ~218 of them "not yet supported", and the only way to know today
which are permanent walls versus unbuilt features is prose — which is why item 23 exists as an
ongoing wording cleanup and why the same message competes with real gaps in the telemetry that ranks
the backlog. A typed deferral (`throw new Deferral({kind: 'platform-wall' | 'unbuilt' | 'shape-gap', …})`)
makes the support matrix generatable instead of hand-maintained, and makes `feature-support-matrix.md`
stop over-promising (a defect that outstanding-work already records against itself, twice).

---

## 8. What I deliberately did not propose

Each of these looks right from the measurements above and is refuted elsewhere; I checked before
writing §6, and none of them is what §6 says.

- **A cross-layer shape algebra.** Targets 6% of measured defects and structurally cannot see the 33%
  (carried-channel drops). Refuted, shape doc §9.
- **A typed core IR / shape in `Step[]`.** Measured at 56.8% ⊤ against a pre-committed 10% kill
  criterion. Settled, shape doc §5/§9.
- **Merging `Stream` into `Shape`.** `Stream` is a capability partition holding a live `Query`;
  merging drags the SQL kernel into the wire layer.
- **Widening `ChildShape` to `'map'`.** Converts a clean deferral into a wrong answer.
- **Reorganizing `steps/` by semantic category to match `gremlin-core`.** §5 — position is the cause,
  shape polymorphism the consequence.
- **Marker interfaces + `instanceof` dispatch.** Our Map registration is better here and for a stated
  reason.
- **Merging the movement vocabulary sets.** They differ on `otherV` and those differences are
  load-bearing; derive with a named difference, never merge.
- **Re-lowering a `repeat()` body barrier to reach a legal recursive-term form.** Measured and dead:
  `DISTINCT` in a recursive term is legal but *inert*, `LIMIT`/`ORDER BY` are global caps on the whole
  CTE, aggregates and window functions are rejected outright. **No per-iteration barrier is
  expressible there in any lowering.** Recorded because the *legality* result alone makes the idea
  look alive — it is the semantics that kill it. This bounds the inlining route only; the majority
  route is the unroll (build plan §1 P3/P4, Phase 3.3).
- **Naively spreading a shared `countRows` into every shape table.** §2 — five of the ten `count`
  handlers legitimately differ, and blind spreading produces wrong answers, not free coverage.

---

## 9. Where each finding went

**This section was a ranked build order. It is now a disposition map**, because RelIR was decided
rather than gated and four of the seven items became phases of
[relir-build-plan](./2026-08-01-relir-build-plan.md). Keeping the ranking here as well would be two
build orders for one body of work — exactly the drift this restructure exists to remove.

| # | Finding | Where it lives now |
|---|---|---|
| 1 | Finish `globalRowOps` into `ELEMENT`/`SCALAR` (§2) | **build plan Phase 0.1** — reframed as a prerequisite that shrinks the Phase-4 migration surface |
| 2 | The 61 `'<tag>' in ` sites → the 15 existing guards (§7a) | **build plan Phase 0.2** — reframed as a *rename-safety* prerequisite, not tidying: `'nested' in a` survives a rename silently, and Phase 2 moves a great deal of code |
| 3 | `tryLowerGroupChildSource`'s eight eager booleans → a triage table (§3b) | **stays here.** Independent of RelIR, local, and the only item on this list RelIR does not touch. Kill criterion unchanged: if the table needs >~12 rows, or a row needs a predicate that is not `(key-shape, value-shape)`, the gates are not a relation — stop |
| 4 | Split `repeat`'s admission control from its lowering (§3a) | **build plan Phase 3.4** — deliberately sequenced *after* `flatten` and `unroll`, so the deletion is the measurement rather than a prediction |
| 4b | Split item 3 of `outstanding-work` into three (§6a) | **build plan Phase 0.3** |
| 5 | Prove or kill RelIR on the row-op matrix | **not run, and superseded.** §6a's corpus measurement and the write-envelope probe answered the same question more directly and more favourably. Recorded so nobody re-derives the gate and thinks it was skipped |
| 6 | RelIR, write path first | **the build plan**, Phases 1–4 |
| 7 | The typed deferral taxonomy (§7) | **stays here.** Independent of RelIR; 627 throws, ~218 saying "not yet supported", and its payoff is making the backlog telemetry trustworthy — which every other item is ranked by |

**Not ranked, but free:** the four substantive textual clones in §1. Three are ten minutes each. The
fourth is not free and belongs with item 3: `lowerChooseOptions` / `lowerChooseOptionsScalar`
duplicate *twice* (`mapscalar.ts:445`≡`:521` and `:475`≡`:541`) — one `choose().option()` lowering
written once per parent shape, the same one-copy-per-shape disease as §2 at whole-function
granularity.
