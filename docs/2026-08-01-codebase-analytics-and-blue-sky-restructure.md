# Codebase analytics: duplication, complexity, split concepts — and the rebuild that follows

**Status: analysis session, 2026-08-01, measured against `c69d101`, rebased onto `1299ff1`. No code
landed.** Every number comes from an instrument run in this session, not from a prior doc.

**Trunk moved 17 commits between the measurement and the push, and three findings changed as a
result — all three corrections are kept in place rather than edited away** (§4a, §5a, and item 1 in
§9). Two cited defects closed; one predicted consolidation landed independently and confirms the
method. Read §4a and §5a before acting on §4 or §5: the first *weakens* this doc's biggest claim and
says so, and the second is the only forward-reasoned structural prediction in this repo's history to
have been confirmed rather than falsified.

**§6a is the sharpest test of §6 and was added after the first push**, in response to the question
*"isn't `repeat()`'s mini-compiler the same smell?"* — it is, for half the body vocabulary, and the
other half is a measured platform wall that kills an attractive idea.

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
   — it is implicit in which function you called. In a relational IR, `Slice`, `Sort`, `Distinct`,
   `Tail` and `Sample` are five operators each carrying `partitionBy: Column[]`, and `globalRowOps` is
   the case where that array is empty. **The 5-vs-5 duplication does not need to be shared; it needs
   to stop existing.**

So the blue-sky restructure is a three-stage compiler instead of a two-stage one:

```
Gremlin text
   │  parse
   ▼
Step[]  ──────────── Pass pipeline (unchanged: extract/decoration/canonicalize/simplify/verify)
   │  lower
   ▼
RelIR   ──────────── plan rewrites: fusion, fast paths, partition-key assignment, dead-column pruning
   │  emit
   ▼
SQL text (via the q kernel, unchanged)
```

`RelIR` is a small relational algebra — `Scan`, `Filter`, `Project`, `Join`, `Union`, `Aggregate`,
`Window`, `Slice`, `RecursiveCTE`, and (this is the point of §4) `Insert` / `Update` / `Delete`. Ten
to fifteen node kinds. It is *not* Gremlin-shaped and carries no Gremlin shape vocabulary.

**This is emphatically not the refuted "typed core IR".**
[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §6 refutes putting
**Gremlin shape** into the **`Step[]` IR** — turning "the shape is knowable" into "here is a `Core[]`
every consumer must construct", which is structurally the reverted `{t,v}` envelope move. RelIR sits
on the *other side* of lowering: it is what lowering *produces*, not an annotation on what lowering
*consumes*. The anchor rule ("a Pass may CONSULT shape, never CONSTRUCT it") is untouched, because
RelIR is not visible to any Pass. Shape stays exactly where §6 puts it — in `steps/`, owned by
lowering, and `Compiled.shape` still rides out to the wire layer unchanged.

### What it would buy, concretely

- **`tail/`'s 11,177 LOC is the thing that shrinks.** The 11 dispatch tables exist because a step's
  lowering depends on the traverser's shape. Much of that dependence is *how to find the value's
  column*, not *what relational operation to perform* — which is precisely the criterion
  `applyChildCardinality` already generalises on (it needs only payload column **names**, never an
  expression denoting the traverser's value, `child.ts:204-243`). Steps that pass that criterion —
  the row-algebraic class — become one RelIR construction each, and the shape tables keep only the
  shape-interpreting class, which is per-shape forever and correctly so.
- **The write path rejoins the traversal machine** as `Insert`/`Update`/`Delete` nodes over the same
  plan, killing the interpreter, the four private `Step[]` parsers, and `WritePlan`'s separate result
  type — and with them the three consequence-clusters in §4.
- **The `count` question §2 could not answer becomes decidable.** `COUNT(*)` vs `COUNT(DISTINCT pk)`
  is exactly the row→traverser cardinality axis the shape doc §7 named (`cardinalityOf`,
  `RelationalCardinality`) and which today has one consumer. On a plan it is a property of the input
  relation, so `Aggregate{count}` reads it instead of ten handlers each knowing it privately.

### 6a. `repeat()`'s mini-compiler — measured, because it is the sharpest test of the whole idea

The question put to this analysis: *`expandRepeatBody` is a second movement compiler, so isn't that a
smell RelIR dissolves — you'd take the body's existing plan and lift it into the recursive term?*

**Yes for one half, and a measured no for the other.** The dividing line is not our compiler's; it is
SQLite's recursive-term law, and it turns out to be narrower and stranger than "SQLite has no
`LATERAL`". Probed directly (SQLite 3.51.2 via `bun:sqlite`; the rules are core CTE semantics, but a
DO re-check belongs with `test:cf-limits` before anything ships on this):

**The law, precisely.** The recursive reference must appear **exactly once, at the top level of the
recursive term's `FROM`**. Wrapping it in a derived table fails with `circular reference` *even as the
only reference* — so the rule is positional, not a count. Once it is there, a **correlated scalar
subquery may reference its alias freely**. That confirms `src/sql/CLAUDE.md`'s existing claim ("the
lateral rule is positional, not absent") by direct measurement. Additionally: **no aggregates**
(`recursive aggregate queries not supported`) and **no window functions** (`cannot use window
functions in recursive queries`) anywhere in the term.

**Half one — the vocabulary wall is ours, and RelIR dissolves it.** `REPEAT_BODY_OK`
(`prefix/branch.ts:869`) admits movement + `has` + a sack fold + a sack `where` guard. Every one of
these is **legal SQLite in a recursive term** and refused by us:

| shape | Gremlin | legal? |
|---|---|---|
| `NOT EXISTS` anti-join | `not()`, `where()` | ✅ |
| join against a derived `UNION` | a `union()` arm | ✅ |
| `IN (SELECT …)` | set-valued predicate operand | ✅ |
| `LEFT JOIN`, walk on the left | `optional()` | ✅ |
| correlated scalar subquery on the walk alias | a `by()` / nested read | ✅ |
| multi-hop join chains | `out().out()`, edge steps | ✅ |

So `expandRepeatBody` is not compensating for a platform limit here — it is a **hand-written
join-flattener**, and it exists because nothing in the pipeline can flatten. Substituting the walk
relation for the body plan's scan and then **normalizing into the legal envelope is textbook
join-flattening / subquery decorrelation** — the canonical mid-end pass, and unavailable today for
exactly the §6 reason: the body's SQL is already text in an append-only `Query` by the time anyone
could rewrite it. This is item 3's *"adjacent row-local gate"* (8 queries) plus the generality behind
it, and it is the strongest single argument in this document for the missing middle.

**Half two — an attractive idea, measured and DEAD. Do not build it.** I expected the bigger prize to
be re-lowering barriers: `dedup()` lowers to a `ROW_NUMBER` window here, but raw `DISTINCT` is legal
in a recursive term, so a RelIR could *choose the legal lowering per position*. The legality holds —
and the semantics do not:

```
diamond 1->2, 1->3, 2->4, 3->4        LIMIT/ORDER BY in the recursive term
UNION ALL          → [1,2,3,4,4]      LIMIT 2      → 2 rows TOTAL, not per iteration
SELECT DISTINCT    → [1,2,3,4,4]      ORDER BY+LIMIT 2 → 2 rows TOTAL
UNION (not ALL)    → [1,2,3,4]
```

`DISTINCT` in a recursive term is **legal but semantically inert** — SQLite feeds the term one queue
row at a time, so it never sees two frontier rows together. `LIMIT`/`ORDER BY` are **global caps on
the whole CTE**, not per-iteration barriers. `UNION` does dedup, but whole-walk on the entire row
tuple — which violates the multiset rule the root `CLAUDE.md` names as a semantics trap.

> **Therefore: a per-iteration barrier is not expressible inside a SQLite recursive term in ANY
> lowering.** Not as an aggregate, not as a window, not as `DISTINCT`, not as `ORDER BY`/`LIMIT`.

This is a **platform wall for the recursive term specifically**, and it is a materially stronger
statement than "no `LATERAL`". It also independently explains *why* TinkerPop's own
`RepeatUnrollStrategy` is "intentionally conservative … especially barriers".

### 6b. But the wall is small, because almost nothing needs the recursion — measured

The obvious reading of §6a is "barrier bodies are dead". **That reading is wrong, and the corpus says
so.** Of 125 corpus traversals mentioning `repeat()`, **53 have a barrier in the body**, and they
split:

```
48   times(n)-bounded   → UNROLLABLE, no recursive CTE involved at all
 5   until()/emit()     → recursion required → the genuine wall
```

(Denominator note: this counts *all* corpus traversals whose repeat body holds a barrier, passing or
failing. Item 3's 41 counts L3-failing ones. Different instruments — do not diff them. The
times-vs-until ratio is the transferable signal.)

**Unrolling removes the constraint entirely rather than working around it.** With no recursive CTE
there is no recursive term, so every prohibition in §6a evaporates: each phase is an ordinary
relation and a barrier over it is an ordinary barrier, windows and aggregates included. This is
exactly the argument item 3 already makes and credits to our architecture rather than to
TinkerPop's — *"our phases are set-at-a-time by construction, so 'the whole frontier at iteration k'
IS phase k's relation — the property `:217` had to special-case to obtain."*

**And unrolling is a plan transformation** — replicate a subplan `n` times and chain it — which is
precisely the operation an inspectable plan makes trivial and an append-only SQL builder makes
impossible. Today `tryUnroll` (`ir/strategies.ts:949`) has to work on `Step[]` *before* lowering,
which is why it is bounded by a step-name allowlist rather than by what the relational form can
express.

Unroll depth is not a practical obstacle: corpus `times(n)` is **83× `times(2)`, 16× `times(1)`, 9×
`times(3)`, 8× `times(5)`, one each of 8 and 10 — maximum 10**. It does need a declared ceiling,
because DO caps statement text at 100 KB and a hand-written `times(1000)` would blow it; above the
ceiling, fall back to the recursive CTE, which then refuses a barrier body as a clean deferral.

**So the corrected picture, and it is much more favourable to RelIR than §6a alone suggests:**

| repeat body | route | RelIR helps? |
|---|---|---|
| row-local vocabulary beyond `REPEAT_BODY_OK` (`not`/`where`/`union`/`optional`/`IN`) | inline into the recursive term | **yes** — join-flattening is the missing pass |
| barrier body + `times(n)` — **48 of 53** | unroll; no recursion, so no prohibition | **yes** — unrolling is subplan replication |
| barrier body + `until()`/`emit()` — **5 of 53** | none | **no** — genuine platform wall |

**So item 3 should be re-framed as three items, not one.** A compiler limitation worth dissolving, a
transformation that is cheap once plans are data, and a five-traversal platform wall. Filing them
together is what makes the 41 read as one prize and what has made the unroll look like a big bet
rather than the majority route.

### The honest counter-argument

This is a large forward-reasoned structural proposal, which is the exact species this repo has
falsified twelve times. Three specific risks:

1. **It could be a re-encoding, not a simplification** — 11 shape tables becoming 11 shape-aware RelIR
   *builders*, with a new layer added and nothing removed. This is the `{t,v}` failure mode.
2. **SQLite is the optimizer.** Locked decision #3 says the planner does the traversal. A mid-end that
   starts making cost decisions duplicates work SQLite does better. RelIR must stay a *structural*
   layer (fusion, partition keys, pruning), never a cost-based one.
3. **The census is the only thing that could tell you it went wrong**, and most of the work would show
   L3 delta = 0 — the caveat the shape doc already flags for its own step 2.

§9 turns these into a gate.

---

## 7. If we rebuilt from scratch

Keeping every locked decision (TinkerPop 4, generated parser, compile-never-interpret, reuse the
client's GraphBinary, front-end/compiler boundary) and every hard-won semantic in `test/`, the
structure I would choose:

**Four layers, one direction.**

1. **Front end** — `parse → Step[]`, plus the tagged-token vocabulary. Unchanged in role. The work
   here is already half done and is §7a below.
2. **Pass pipeline** — unchanged. Categorized, ordered, `Step[] → Step[]`. This part is good and the
   measurement gives no reason to touch it.
3. **Lowering** — `Step[] → RelIR`. Shape lives here and only here. **One table per step name, not one
   per (step, shape)**: a `StepFn` receives the stream and returns RelIR, and the row-algebraic
   majority stops caring which shape it got. Writes are steps like any other.
4. **Emission** — `RelIR → SQL`, the `q` kernel essentially as it stands, plus the plan rewrites that
   today are fast paths and accumulators.

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
- **Re-lowering a `repeat()` body barrier to reach a legal recursive-term form.** §6a: measured and
  dead. (Note this kills the *inlining* route only — §6b measures that 48 of 53 such bodies are
  `times(n)`-bounded and unroll instead, where no prohibition applies.) `DISTINCT` there is legal but inert, `LIMIT`/`ORDER BY` are global caps, aggregates and window
  functions are rejected outright. **No per-iteration barrier is expressible in a SQLite recursive
  term in any lowering** — so item 3's 41 barrier-body queries are a platform wall, and the unroll is
  the only route. Recorded so the idea is not re-derived from the legality result alone.
- **Naively spreading a shared `countRows` into every shape table.** §2 — five of the ten `count`
  handlers legitimately differ, and blind spreading produces wrong answers, not free coverage.

---

## 9. Ranked, each with a kill criterion

> **SUPERSEDED IN PART, 2026-08-01.** RelIR was **decided** rather than gated — see
> [relir-build-plan](./2026-08-01-relir-build-plan.md), which absorbs items 1, 2, 4 and 5–6 into its
> Phase 0/2/3 and adds the complete object model, the measured SQLite envelope (five probes) and the
> phase gates. Items 3 and 7 are unaffected and stay here. The kill criterion in item 5 below was
> not run: §6b's corpus measurement (48 of 53 barrier bodies unroll) and the write envelope probe
> answered the same question more directly and more favourably.

Ordered by (evidence × payoff) ÷ risk. Every one gates on `mise run ci` including the census.

**1 — Finish `globalRowOps` into `ELEMENT` and `SCALAR`.** *Small, mechanical, measured.* §2: the two
largest tables (45 of 94 entries) do not use the shared table. Compose with `firstOf`, never spread
over an owned key. **Kill criterion:** none needed — the census is a sufficient gate.
**Re-scoped 2026-08-01:** the per-origin lifts this item originally also called for are **done**
(`f9597ca`, §5a) — `rankedRows` now backs four of the five. What is left here is the *element tail*,
which item 17's updated text also now names as the remainder, and it is architectural rather than a
spread: `ELEMENT_DISPATCH` routes through the `TailAcc` accumulator whose `order()`+`limit()` fusion
is what makes a single statement correct. **Sequence it after 3, and read §6.2 first — this is the
item RelIR would most change the shape of.**

**2 — Convert the 61 `'<tag>' in ` sites to the guards that already exist.** *Small, mechanical,
closes a rename hole.* §7a. The `TaggedArg` union and all 15 guards are built; the consumers were
never moved. Token by token (`isNested` ~27, then `isTokenArg` ~20), one commit each. **Kill criterion:**
none — but note it *will* surface real bugs where a site's hand-rolled check is subtly wider or
narrower than the guard, and those are findings, not obstacles. Sweep shape-doc §3's three stale
sentences in the same change.

**3 — Turn `tryLowerGroupChildSource`'s eight booleans into a triage table.** *Medium, local, no new
concepts.* §3b. Pure restructuring of one function plus its classifier calls; the emitters are
untouched. **Kill criterion:** if the table needs more than ~12 rows or any row needs a predicate that
is not `(key-shape, value-shape)`, the gates are not a relation and this is the wrong shape — stop.

**4 — Split `repeat`'s admission control from its lowering, and split item 3 in two.** *Medium.* §3a
+ §6a. A `classifyRepeat(region) → RepeatPlan | Deferral` leaf, then two lowerings that consume a
validated plan. **Kill criterion:** if the extracted classifier still needs ≥10 fields on
`RepeatPlan`, the complexity was essential and the split only moved it — revert and record that.
**Do the index change regardless of the code change**: item 3 currently files three different
answers as one item — a dissolvable row-local vocabulary gate, a barrier-body majority that unrolls
(48 of 53 corpus bodies), and a five-traversal platform wall. §6a/§6b have the measurements.

**5 — Prove or kill RelIR on the row-op matrix, before writing any of it.** *The gate for §6, and
cheap.* Item 17 has already measured the matrices: root scope **66 gaps / 150**, child scope **41 /
63**. The question RelIR lives or dies on is answerable by reading those gaps, not by building
anything:

> Of the gaps, what fraction is *"the same relational operator with a different partition key or a
> different column authority"* versus *"a genuinely different relational operation"*?

**Pre-committed criterion: above 60% same-operator → RelIR is the right layer and step 6 follows.
Below 30% → RelIR is a re-encoding; record the number and close §6 permanently.** In between →
inconclusive, and the default is not to build it. This mirrors the shape doc's step-5 discipline,
which is the only structural question in this repo's history that got a clean answer, and it costs a
reading pass rather than a migration.

**6 — Conditional on 5: RelIR, write path first.** Not "add a layer then migrate everything" — the
write path is the slice that (a) has the clearest payoff, (b) is bounded, (c) already has a plan
covering its semantics ([write-path](./2026-08-01-write-path-plan.md)), and (d) is where the known
silent wrong answers are (items 16, 20's three write rows). If `Insert`/`Update`/`Delete` plan nodes
kill the interpreter and item 16's multi-property loss without a new shape vocabulary, the layer has
earned the read side. If it does not, nothing else was disturbed. **Note the coordination
constraint:** the write cluster is CLAIMED by a second agent as of 2026-08-01 — this must be
sequenced with them, not started alongside.

**7 — The typed deferral taxonomy.** *Medium, independent of everything above.* §7. Its real payoff is
that it makes the backlog's own telemetry trustworthy, which every other item on this list is ranked
by.

**Not ranked, but free:** the four substantive textual clones in §1. Three are ten minutes each. The
fourth is not free and should be folded into item 3 instead: `lowerChooseOptions` /
`lowerChooseOptionsScalar` duplicate *twice* (`mapscalar.ts:445`≡`:521` and `:475`≡`:541`), which
makes them one `choose().option()` lowering written once per parent shape — the same
one-copy-per-shape disease as §2, at whole-function granularity rather than adapter granularity.
