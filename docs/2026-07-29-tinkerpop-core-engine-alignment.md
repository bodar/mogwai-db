# Naming the compiler: a layered vocabulary

**Status: design session, 2026-07-29. No code landed.** Revised the same day after review. The first
pass asked one question — *does TinkerPop have an established name for this?* — and that is the wrong
test for two thirds of the surface. The revision replaces it with a layered rule (§0), and most of the
proposed renames changed as a result: three because the code refutes the proposal outright (§4.1), one
because the rule cuts *against* TinkerPop (§4.1), and two reversals of direction — §4.6 reverses the
first draft, §4.3 reverses this revision's own first attempt at it.

Basis: a read of TinkerPop `gremlin-core` on `origin/master` (`f475bca`) against `src/compiler/**` at
`ddef441`. Every "keep it" and "rename it" below is checked against what the code actually does, not
against what the previous draft's summary of it said.

**Blast radius is not an input.** An LSP rename costs the same at 12 references as at 1,200, so a
reference count is not evidence about a name. The first draft carried a `Sites` column and let it
argue for deferring one rename as "too big for the payoff"; both are gone. Two questions decide every
row below, and nothing else does:

1. Does the name say what the thing *is*?
2. Can it be confused with a different thing?

The structural half of the answer is **already in flight** — see
[channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md), which this doc defers
to rather than duplicates.

## 0. The rule

> **Use TinkerPop vocabulary for Gremlin semantics and observable traversal behaviour. Use compiler
> and relational vocabulary for Mogwai's analysis, rewriting, lowering and SQL representation. Do not
> copy a TinkerPop implementation name merely because an approximate analogue exists.**

The question to ask of any name is *not* "does TinkerPop have a word for this?" but:

> Is this concept part of Gremlin's public semantic model, or an implementation detail of a compiler
> that lowers Gremlin to SQL?

TinkerPop is excellent prior art for the first and often the wrong prior art for the second, because
it is an interpreter with an open Java step hierarchy while we are a staged compiler with a
SQL-producing IR. This doc already acted on that distinction when refusing marker interfaces and
`instanceof` dispatch (§7); §0 just states it once so the rest follows from it.

| Kind of concept | Vocabulary from | Examples here |
|---|---|---|
| Gremlin semantics | TinkerPop | `traverser`, `bulk`, `encounter`, `modulator`, `barrier`, `productivity`, side effect, local/global |
| Traversal structure | TinkerPop, where it fits | step, child traversal, traversal parent, option arm |
| Compiler pipeline | compiler literature | pass, analysis, canonicalize, rewrite, simplify, lower, verify |
| Intermediate representation | compiler literature | IR node, region, canonical form |
| SQL construction | relational terminology | relation, CTE, projection, correlation |
| Runtime row state | database/compiler terms, Gremlin-qualified | traverser layout, carried columns |

Two failure modes it rules out symmetrically: inventing private terminology (`Seam 3`, `Layer C2` —
§3), and importing a TinkerPop name that exists only because of TinkerPop's JVM runtime architecture.
`TraversalStrategy` is useful *semantic* prior art for a categorized pre-evaluation rewrite; it is not
a reason to call every Mogwai compiler pass a strategy.

The rule earns its place by settling cases in *both* directions below: it moves `bys` towards
TinkerPop (§4.2) and `ChainFacts` away from it (§4.1).

## 1. `TraverserRequirement` — prior art for `Carried`, and why this is a citation not a plan

`TraverserRequirement` is a 9-value enum (`BULK`, `LABELED_PATH`, `NESTED_LOOP`, `OBJECT`,
`ONE_BULK`, `PATH`, `SACK`, `SIDE_EFFECTS`, `SINGLE_LOOP`). Each step declares `getRequirements()`; a
`TraversalParent` unions its children's via `getSelfAndChildRequirements(...)`;
`DefaultTraversal.getTraverserRequirements()` (`util/DefaultTraversal.java:167-185`) folds the tree
once and memoizes; then `DefaultTraverserGeneratorFactory` **derives** the concrete traverser class
from the union (`B_LP_NL_O_P_S_SE_SL_Traverser` and ~19 siblings).

The structure worth copying is **declare → union → derive**. The 20-class pre-generated cross product
is not — that is a JVM monomorphisation trick with no analogue here.

`Carried` (`steps/context/context.ts:160`) is the same object built the same way round: 8 typed roles
declared, and the physical column list *derived* by `carriedCols` (`context.ts:351`), already the
single source of truth. Two gaps remain, and **both are already Phase 1 of
[channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md)**:

- the ORDER RULE that makes the derivation correct is a prose comment (`context.ts:344-350`),
  enforced only after the fact by `assertStreamColumns`;
- threading is still dominated by hand-written spreads.

**Corrections to the first pass, both worth recording**: `mergeCarried` *does* exist
(`context.ts:269`) — the shape doc's §8 says it does not, which was true when written and is now
stale. And `carryThrough` *also* already exists (`stream.ts:384`, landed in `2096c41`); the first pass
reported it absent after grepping for `export function` when it is an `export const` arrow. So "add
the named preserving rebuild" is **done**; what remains is deployment breadth, which
channel-preservation already scopes.

**What this doc adds** is the citation *and a distinction the citation makes available*:

```
TraverserRequirement  — the logical capability a traversal DEMANDS   (TinkerPop's word, Gremlin semantics)
TraverserLayout       — the physical representation chosen to PROVIDE it  (ours, compiler/relational)
```

`Carried` is the second, not the first, which is exactly why it should not be renamed
`TraverserRequirements` (an earlier candidate). We do not currently materialise the logical half as
its own type and do not need to; the conceptual split is still what a future reader needs when
deciding whether a new role belongs on the layout. Cite `TraverserRequirement` in its doc-comment
when the rename lands.

## 2. The collisions worth closing regardless

These are the only names that can cause a *mistake* rather than a moment's confusion.

1. **`Carry` vs `Carried`** — the state bag versus the row layout, nested inside each other and one
   letter apart, so `st.carried` beside `carryOf(st)` reads as a typo. `Carry` is compilation state;
   `Carried` is a row layout. See §4.2 for both names, and §4.3 for why fixing this is *cheap* —
   the collision is entirely between the two type names.
2. **`CompileScope` (`steps/tail/child-shape.ts:50`) vs `CompilerScope` (`scopes.ts:36`)** — two
   letters apart, one import apart, unrelated meanings: the root-or-nested-child-frames position
   during lowering, versus a DI container lifecycle. TinkerPop keeps these vocabularies apart
   (`TraversalParent` children vs `TraversalStrategies`). See §4.2.
3. **`fold` means three different things** (new in this revision, and the worst of the three).
   `fold()` is a Gremlin step; a *functional fold* is how the lowering threads `StepFn`s over a
   `Stream`; and `fold` is a `PassCategory` (`ir/pass.ts:22`) with 8 passes named `fold*`
   (`ir/passes.ts:57-65`). `collapseFoldCountLocal` contains two of the three senses in one
   identifier. Exactly one of the eight `fold*` functions is a fold in the compiler sense —
   `foldConstantPredicateOperands` (`ir/strategies.ts:484`), which resolves a constant operand to a
   literal, i.e. genuine constant folding. The rest are canonicalizations. Fixed in §5.

## 3. Two private numbering schemes to retire

`Seam 2`/`Seam 3` (`compiler.ts:21,25`, `engine/engine.ts:42`, `context.ts:8`, `ir/strategies.ts:4`)
and `Layer A/B/C1/C2` (`ir/pass.ts:4`, `ir/analyze.ts:3`, `options/fast-paths.ts:70`) are **two
incompatible numbering schemes for one three-way split**, with the numbering defined only in an
archived doc and `Seam 1` never mentioned anywhere.

The split is good. Name it plainly — and note the third row, which the first draft got wrong:

| Ours | What it does | TinkerPop analogue |
|---|---|---|
| `Pass` | rewrites the chain (`Step[]→Step[]`), or verifies and throws | `TraversalStrategy` |
| `ChainFacts` | annotates the chain, never rewrites | `TraverserRequirement` aggregation |
| `FastPath` | recognizes a sub-shape and lowers it to **specialized** SQL, with the generic path retained as the semantic authority and a committed enabled≡disabled test | `ProviderOptimizationStrategy` |

The first draft summarised the third as "selects a lowering", which is what made a rename to
`LoweringRule` look right. It is not what a `FastPath` is — see §4.1.

Comments only, no code change; then state it once in `src/compiler/CLAUDE.md`.

## 4. The rename set

### 4.1 Three proposals the code refutes

Recorded because each looked right from the prose and is wrong against the source.

- **`FastPath` → `LoweringRule`: NO. Keep `FastPath`.** The test is whether "fast" means
  *performance-specialised, with a slower general path retained* or merely *supported native
  lowering*. `options/fast-paths.ts` settles it: every `FastPath` carries
  `equivalentWhen` — "the name of the committed test proving enabled ≡ disabled. Required — a
  FastPath without it fails the registry test" (`:107-110`) — recognition failure is `null` and
  falls through to the generic path, never a support boundary (`:102-105`), and all six default to
  on (`DEFAULT_FAST_PATHS`). A lowering that is *required* for correctness could not satisfy any of
  those. `FastPath` is precisely accurate; the §3 table was the defect.
- **`ChainFacts` → `TraversalFacts`: NO. Keep `ChainFacts`.** This one is settled by §0 against
  the instinct to reach for TinkerPop. A *traversal* is TinkerPop's name for the user-facing query
  object; a *chain* is our IR's own word for the flat `Step[]` (`stepChain` in the front-end,
  `originalChain` on `PassContext`, and locked decision #5 in the root `CLAUDE.md`). `analyze()`
  computes facts about the IR, so it takes the IR's noun. Rename the *function* `analyze` →
  `analyzeChain` and the pairing reads as compiler code should: `const facts: ChainFacts =
  analyzeChain(steps)`.
- **`materializeFinal` → `materializeRoot`: IMPOSSIBLE as written.** `materializeRoot(query, tail,
  shape)` already exists (`steps/tail/materialize.ts:17`) as the low-level primitive every
  `materialize<Kind>Root` sibling calls. The defect the first draft found is real — "final" and
  "root" name one boundary — but the free name is a third one. `materializeFinal` is the root entry
  point that rejects an unprojected element stream and dispatches by kind, so
  **`materializeRootStream`**: consistent with the `*Root` family, distinct from the primitive, and
  it says what it takes. "Materialize" itself stays — `materialize.ts:1` is "the one read
  materialization boundary", which is the strong database sense of the word, correctly used.

### 4.2 The renames to make

Kind = which row of §0's table the name is drawn from.

| Ours | Rename to | Kind | Why |
|---|---|---|---|
| `Carry` | `LoweringState` | pipeline | Its contents are `q`/`params`/`sideEffects`/`carried` — an append-only query builder plus threaded state, not an *environment* (no name bindings, no symbol table). Its own doc-comment already says "PURE per-query STATE". `Lowering*` is established here (`LoweringEngine`, `LoweringResult`, `LoweringSuspension`, `LoweringContinuation`), and it makes the phase pairing explicit: `PassContext` is the pass phase's threaded state, this is the lowering phase's — which `pass.ts:37` already says in prose. |
| `Carried` | `TraverserLayout` | row state | "Traverser" grounds it in Gremlin; "Layout" admits physical columns *plus* layout metadata. `Schema` would over-promise: `trackFromV` is a capability flag and `consumedAliases` is marked "METADATA ONLY — never a physical column" (`context.ts:171`). `Frame` would misread as an activation record. |
| `PStep` | `IRStep` | IR | Single unexplained letter. Name the object, not a phase it once went through: `NormalizedStep` (the first draft's pick) goes stale the moment a later pass runs — and §4.4 is a phase-named field that already drifted. `Step` stays the front-end's flat node; `IRStep` is the compiler's, carrying folded children. |
| `advance` | `appendCte` | SQL construction | It appends a CTE and returns state rebased on it (`context.ts:456`); "advance" reads like a cursor op and `emitCte` (the first draft's pick) reads like final code emission. Document the pair, since the ambiguity is real: `q.cte()` mints a relation; `appendCte()` mints one *and* rebases the traverser layout onto it. |
| `cluster` (`IRStep` field) | `repeatRegion` | IR | It is exactly the fused `repeat/until/emit/times` run (`REPEAT_CLUSTER`, `ir/strategies.ts:33`). "Region" is the compiler word for a structured IR part that may contain nested control flow, which this does; "cluster" implies an optimisation grouping with no defined semantics. Not `Block` — this is not single-entry/single-exit and "basic block" means something specific. |
| `bys` (`IRStep` field) | `modulators` | Gremlin | Moves *towards* TinkerPop, correctly: `by()` is a Gremlin-language concept and TinkerPop models it as `ByModulating`/`modulateBy`. A pluralized step name is not a field name. Not `projections` — `by()` is step-dependent and only sometimes a projection. |
| `options` (`IRStep` field) | `optionArms` | structure | The token is overloaded three ways — this field, `CompileOptions`, and `FastPathConfig` — so an accurate name has to distinguish them, and the rename must be driven off the *type* (LSP, field-scoped), never a text match on `options`. Close to TinkerPop's `TraversalOptionParent.addChildOption`; "arm" is established for `choose`/branching. |
| `materializeFinal` | `materializeRootStream` | SQL construction | §4.1. |
| `CompileScope` | `ChildFrameStack` | IR | Kills the `CompilerScope` collision. The element type `ChildFrame` already exists, so this needs no imported vocabulary. The arms `RootScope`/`ChildScope` **keep** their names: a `ChildFrame`'s `domain`+`ordinal` genuinely determine what relation is visible to the body, which is what a scope is. |
| six `*_TAIL` tables + bare `TAIL` | `<SHAPE>_DISPATCH`, bare `TAIL` → `ELEMENT_DISPATCH` | IR | They are shape-keyed dispatch tables, not positions; the unqualified one is an odd-one-out asymmetry. |

**Keep, and document once instead**: `encounter`, `bulk`, `productivity.ts` (all three are TinkerPop's
own words — `ProductiveByStrategy`, `TraversalProduct.isProductive`, "encounter order", a Traverser's
bulk; say so once and stop re-explaining bulk as "multiplicity"/"RLE" in every comment); `Stream` (a
12-member union threaded everywhere — rename cost enormous, concept documented); `FastPath` and
`ChainFacts` (§4.1); `steps/resource.ts` → `steps/graph-source.ts` still stands, as `lowerReSource` is
a mid-traversal `V()`/`E()` and `GraphStep` is TinkerPop's name for exactly that.

`q` → `query` was considered and declined: it is a good name badly abbreviated, but it is the single
most-threaded identifier in the compiler and the abbreviation is unambiguous within it.

### 4.3 The whole `carry*` family, named

An earlier revision of this section proposed renaming only the two type names and deferring the field
and the eleven functions as "cosmetic", on the grounds that the sweep was large. That was a cost
argument wearing a correctness costume, and it is withdrawn. If `Carried` becomes `TraverserLayout`,
then `st.carried` is an adjective standing where a noun belongs and `carryFrag` names a fragment of a
thing that no longer exists. Half a rename is a worse state than either end of it.

So the family gets named, member by member — not by prefix-substituting `carry` → `layout`, which
would preserve two abbreviations (`Frag`, `Opts`) and one outright inaccuracy (`withoutCarried`):

| Now | Rename to | Why this name |
|---|---|---|
| `carried` (field on `LoweringState`) | `traverserLayout` | Not bare `layout`: `PathStream.layout` already exists (`tail/path.ts:230,333,360`) and means the linear-vs-grouped *path* layout. Two different `layout` fields on two stream types is exactly the confusion §0's second question rules out. The qualifier goes on the general one because the specific one is self-evident in context — a `PathStream`'s layout is obviously a path layout. |
| `CarriedOpts` | `LayoutPatch` | It is a tri-state patch, not options: a value sets, `null` clears, `undefined` keeps (`context.ts:389-403`). "Opts" says nothing about that. |
| `carriedWith` | `patchLayout` | Applies that patch. The `X`-`With` shape reads as a constructor; this is a patch application. |
| `carriedCols` | `layoutCols` | Keep `Cols` abbreviated: `Relation.cols` is the SQL kernel's own spelling, so `layoutColumns` would drift from the layer it feeds. |
| `rigidCols` | unchanged | "Rigid" is a defined term with a stated contract (per-traverser state a branch cannot fork or reconcile) and it is the distinguishing word. |
| `carryFrag` | `layoutProjection` | It emits `, p.a0, p.p0, …` — a SQL projection list. "Frag" abbreviates "fragment", which was never the concept. |
| `carryFragMint` | `layoutProjectionMinting` | Same projection with one named column computed fresh instead of forwarded. `mint` stays: it is this codebase's consistent word for allocating a fresh column or ordinal, used at every mint site. |
| `mergeCarried` | `mergeLayouts` | |
| `withCarried` | `withLayout` | |
| `rehomeCarried` | `rehomeLayout` | "Rehome" is accurate and already documented (child-scoped state onto the parent's schema). |
| `withoutCarried` | `dropLayoutAtBarrier` | The current name is the one *inaccuracy* in the family. It does not produce a stream without a layout: it resets the layout while retaining `trackFromV` and **recording the dropped label names in `consumedAliases`** so a downstream `select(label)` can throw a clear deferral instead of silently returning `[]` (`context.ts:437-448`). It is barrier-specific by contract, and the name should say so — a caller reaching for a generic "clear the layout" helper is a caller about to lose that diagnosis. |
| `carryThrough` | `withRelation` | A new stream over a new relation with everything else identical, column-asserted (`stream.ts:384`). Joins the `withX` preserving-rebuild convention already in this file. |
| `carryOf` | `loweringStateOf` | Projects the shape-independent state out of a stream; the `XOf` accessor shape is already the convention here (`carriedCols`, `pathColsOf`, `aliasColsOf`). |

Two members keep their names on merit: `withoutPath` and `trackFromV` both say exactly what they do.

The one real sequencing constraint is unchanged and is not about size: this family is the same set of
call sites the in-flight [channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md)
work is editing, so it lands after that, or it produces conflicts in every file it touches.

### 4.4 A phase-named field that already drifted (fixed in `bd6dfaf`)

`PassContext.originalChain` was documented as "The chain AFTER `fold` but BEFORE any `decoration`
pass ran" (`ir/pass.ts:46`), echoed as "folded but not injected" (`ir/passes.ts:115`). But
`PASS_CATEGORIES` orders `decoration` *before* `fold` (`pass.ts:22`, and `pass.ts:26-29` explains why
it must), and the driver snapshots at the boundary into decoration (`passes.ts:183`), where its own
comment correctly reads "extract-only: … nothing injected/folded". The behaviour is the driver's; two
doc-comments described a pipeline order that does not exist.

Fixed as a comment-only change. It stays recorded here because it is the concrete case for §4.2's
`IRStep`-over-`NormalizedStep` argument: a name or a comment that pins something to a *pipeline phase*
has to be re-verified every time the pipeline is reordered, and this one was not. Names that say what
a thing is do not carry that maintenance obligation.

### 4.5 `ir/strategies.ts` — the one structural split

1013 lines, ~36 importers, and its own header (`:4`) calls the contents "pass BODIES". Two thirds have
nothing to do with TraversalStrategies. Intended three ways, re-exporting from `strategies.ts` in the
same commit so importers move separately:

- **`ir/step.ts`** — `IRStep` plus the vocabulary sets from §6. **DONE** (`ir/step.ts` exists,
  `strategies.ts` re-exports `IRStep`); §6's sets land here.
- **`ir/rewrites.ts`** — the rewrite bodies, renamed per §5. **NOT DONE — deliberately.**
- **`ir/strategies.ts`** — what the name promises, and the part with a real TinkerPop counterpart
  (`strategy/{decoration,verification}`): `NO_OP_STRATEGIES`, `ALWAYS_ON_STRATEGIES`,
  `VERIFICATION_STRATEGIES`, `injectSubgraphRec`, `injectPartitionRec`, `markProductiveBy`, `verify`,
  `verifyReadOnlyChildren`, `rejectMsg`.

**Why the rewrites/strategies partition is still open.** It is not the mechanical move the first
draft assumed. The two halves are *interleaved*, and several private helpers are shared across the
line: `nestedArg` and `someStepDeep`/`recurseInject` serve both `canonicalizeConnectives` and the
injectors; `MUTATING_STEPS` serves both `verify` and `verifyReadOnlyChildren`; the
`VERTEX_PRODUCERS`/`EDGE_PRODUCERS`/`EXPLODE_EDGE` sets sit between two rewrite bodies but belong to
the injectors. So the split needs a third decision the plan never made — where shared helpers live —
and a cross-import between the two new modules risks the very cycle the `deps ◂ families ◂ engine`
DAG exists to prevent.

That makes it a design question, not a file move, and it is the lowest-yield item in this doc:
`IRStep` was the part with a real dependency (§6 needs a home), and it is done. Whoever takes the
rest should decide the shared-helper home FIRST — most likely a fourth leaf, since both halves
importing a shared `ir/step-vocabulary.ts` is acyclic while `rewrites ⇄ strategies` is not.

### 4.6 `tail/`: keep it — rename only the dispatch tables

**Reversing the first draft.** It proposed `steps/tail/` → `steps/shaped/` on the grounds that "tail"
names the layer by *position* when the real axis is element-typed fold (`prefix/`) versus
shape-polymorphic dispatch. `shaped/` is a bad name for that axis (`shape-dispatch/` would be the
right one), but the premise itself is what fails: **position is the defining property of this layer,
and shape-polymorphism is a consequence of it.**

What makes these files one group is that they are what the prefix fold falls through *to*.
`engine.ts`'s fold stops at the first step absent from the prefix table, and the
`range`/`limit`-before-vs-after-`order()` split is decided by exactly that stop-boundary
(`ir/strategies.ts:16-19`) — a structural fact of the compiler, not a filing convention. The shape
polymorphism follows: once a chain leaves elements it is in twelve shapes, so anything past the
boundary has to dispatch on shape. Naming the layer `shape-dispatch/` would name the consequence and
lose the cause.

The corollary matters too. "Tail" is not just in import paths — it is the vocabulary of the prose
contract (`src/compiler/steps/CLAUDE.md`: "a TAIL step", "the tail cascades", "at a tail boundary",
"a child body's tail barrier", plus four other `CLAUDE.md`s). If `shape-dispatch/` were the more
correct name, the right move would be to rename that prose too, not to leave the code and the
filesystem disagreeing. It isn't, so neither happens.

So: **keep `steps/tail/` and `steps/prefix/`**, and take the part of the finding that stands on its
own — the `*_TAIL` **tables** are shape-keyed dispatch tables, not positions, and become `*_DISPATCH`
(§4.2 — a rename, no file moves). Two lodgers to fix while there: `PROPERTY_TAIL` +
`compileFromProperty` live in `tail/group.ts`, and `compileFromMap`/`compileFromMapEntry` live in
`tail/list.ts`.

## 5. Rewrite vocabulary: verbs, not one `fold` bucket

The first draft's `ir/folds.ts` would have bucketed twelve functions under a word that means three
things here (§2.3) and describes one of them (`foldConstantPredicateOperands`). Compiler literature
has the distinct verbs already:

| Verb | Means |
|---|---|
| `canonicalize` | rewrite equivalent source forms into one standard form |
| `form` | recognise several nodes and construct one structured node |
| `absorb` | attach a trailing modulator onto its host step (this codebase's own word: "Steps that **absorb** trailing by() modulators", `ir/strategies.ts:35`) |
| `simplify` / `collapse` | reduce or fuse structure |
| `drop` / `eliminate` | remove a provable no-op |
| `rewrite` | generic semantics-preserving replacement |
| `fold` | constant folding — a known value resolved at compile time |
| `lower` | replace a higher-level construct with a lower-level representation |

Applied:

| Now | Becomes | Verb |
|---|---|---|
| `foldRepeatClusters` | `formRepeatRegions` | recognises 2–4 steps, constructs one region |
| `foldByModulators` | `absorbModulators` | attaches `by()` onto its host |
| `foldChooseOptions` | `absorbOptionArms` | attaches `option()` arms onto `choose` |
| `foldCallWith`, `foldValueMapWith` | `absorbCallWith`, `absorbValueMapWith` | same shape |
| `foldConnectives` | `canonicalizeConnectives` | infix `and()`/`or()` → one nested form |
| `foldConstantPredicateOperands` | **unchanged** | the one true fold |
| `collapseFoldCountLocal`, `dropRedundantOrder`, `rewriteWhereEndLabels`, `stripTerminal` | **unchanged** | already verb-accurate (`Fold` in the first is the Gremlin step, correctly) |
| `alwaysProductiveFilterIsNoOp` | `isAlwaysProductiveFilterNoOp` | it is a predicate, not a rewrite |

And the change that removes the third meaning of "fold" from the codebase: **rename the
`PassCategory` `fold` → `canonicalize`** (`ir/pass.ts:22`, plus the `category:` literal on 8 passes).
The category comment already describes it as "canonicalize multi-step shapes"; ordering and behaviour
are untouched. After this, "fold" in this codebase means the Gremlin step or a functional fold —
both standard.

Do **not** promote every rewrite to a formal `Pass`-adjacent concept beyond what exists; local
transformations stay plain functions the pipeline wraps.

## 6. Vocabulary-set drift — and why the obvious fix is wrong

`{count,sum,min,max,mean}` appears **verbatim at 6 sites** (`analyze.ts:97`, `ir/strategies.ts:613`,
`child-shape.ts:304`, `bulk.ts:52`, `list.ts:405`, `group.ts:155`); the movement vocabulary has ~10
overlapping spellings; the set-op lists have 4.

**The sets are not interchangeable, and the differences are load-bearing:**

| Set | Contents | Differs by |
|---|---|---|
| `COLLAPSE_MOVES` (`analyze.ts:94`) | out,in,both,outE,inE,bothE,outV,inV,bothV | no `otherV` |
| `POSITION_MOVEMENTS` (`path.ts:43`) | the same 9 | no `otherV` — and this omission **is** the open `otherV()` path bug in [outstanding-work](./outstanding-work.md) item 0 |
| `VERTEX_PRODUCERS` (`ir/strategies.ts:201`) | V,out,in,both,outV,inV,bothV,**otherV** | has `otherV` and `V`, no edge steps |
| `REPEAT_MOVES` (`branch.ts:518`) | out,in,both | vertex-to-vertex only |
| `BULK_MOVES` (`bulk.ts:49`) | out,in,both | same three, different reason |
| `MOVES` (`predicate.ts:54`) | out,in,both,outE,inE,bothE | no edge-to-vertex |

A naive merge would silently change semantics in at least three places — the exact failure mode
[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §9 refutes, and the
reason the "these two must not drift" comments (`child.ts:122-125`, `child-shape.ts:302-303`) are
load-bearing prose.

**So: derive with a named difference, never merge.** Extract one base
(`VERTEX_MOVES`/`EDGE_MOVES`/`ENDPOINT_MOVES`/`OTHER_V`/`REDUCERS`) and have each existing set spell
its own membership relative to it, e.g. `COLLAPSE_MOVES = union(VERTEX_MOVES, EDGE_MOVES,
ENDPOINT_MOVES)` — so the missing `OTHER_V` becomes *visibly* missing instead of invisibly absent.

Rules, because this is the delicate one:

1. Every set keeps its own name and call sites. This changes how membership is **written**, never
   what any set contains.
2. **No membership changes here.** If a derivation makes a set look wrong — `POSITION_MOVEMENTS` is
   the known case — file it. It needs its own test, or the fix lands untested and disguised as a
   rename.
3. One commit per family (moves, reducers, set-ops, path-steps) so a revert is clean.

The one *unambiguous* duplicate found: `{path, simplePath, cyclicPath}` is spelled three times
(`analyze.ts:34`, `ir/strategies.ts:41`, and a file-local `const PATH` at `bulk.ts:158`). Start there
— a one-line deletion that proves the mechanism.

## 7. Do NOT adopt — recorded so it is not re-proposed

- **Marker interfaces + `instanceof` dispatch.** TinkerPop's dominant idiom (~35 capability
  interfaces: `ByModulating`, `Scoping`, `PathProcessor`, `Barrier`, …). Right for an *interpreter*
  with an open step hierarchy. We compile, and our "register in a Map, never grow a switch" rule is
  *better here*: a Map lookup is total and a missing key fails closed, whereas an `instanceof` chain
  falls through silently. Keep ours — and note this is §0's rule in its sharpest form: the
  *capability names* (`Barrier`, `ByModulating`, `Scoping`, `TraversalParent`) are excellent and we
  should use them; the dispatch mechanism they exist to serve is not.
- **The Global/Local step-class split.** TinkerPop models `Scope.local` as two distinct classes
  (`OrderGlobalStep`/`OrderLocalStep`) because the bases are incompatible — barrier vs scalar-map —
  and `Scope` is a *builder-time dispatch token only*, gone before any strategy runs. We already have
  the equivalent separation in the shape tables; adopting the naming is churn.
- **`GValue`/`GValueHolder`/placeholder-step duality.** TinkerPop's newest pattern: every
  parameterizable step exists twice (`GraphStep`/`GraphStepPlaceholder`) behind a `*StepContract`,
  with `GValueManager.pinVariable` taint-tracking any strategy that reads a concrete parameter, so a
  plan is marked non-generalizable the moment an optimization depends on a literal. Genuinely
  elegant. **It buys nothing without a plan cache**, which we do not have — revisit only if one is
  ever built.
- **A typed core IR / cross-layer shape algebra.** Refuted in
  [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §6 and §9.
- **Merging `Stream` into `Shape`.** Refuted in the same doc §9 — `Stream` is a capability partition
  holding a live `Query`; merging drags the SQL kernel into the wire layer.

## 8. One thing TinkerPop master confirms

`Bytecode` is **gone** on master — `find . -name "Bytecode*.java"` returns nothing repo-wide, replaced
by `GremlinLang` (a canonical Gremlin string plus a parameter map, reachable via
`Traversal.Admin.getGremlinLang()`). Independent confirmation of locked decision #1 in the root
`CLAUDE.md`.

## The mechanism: `tools/rename.ts`

Renames go through `tools/rename.ts`, which drives the LSP server **inside our pinned `typescript`
dependency** — `tsc --lsp --stdio`. No new dependency, and the rename is definitionally in agreement
with the compiler `mise run check` gates on.

```
bun tools/rename.ts <file> <oldName> <newName> [--dry] [--at line:col]
```

Why not the obvious alternatives: typescript@7 is the native Go port and deleted both `tsserver.js`
and the `typescript.js` compiler-API bundle (`node_modules/typescript/lib/` holds only `tsc.js`,
`version.cjs`, `getExePath.js`). `typescript-language-server` and `vtsls` spawn a `tsserver` that no
longer exists; ts-morph bundles its own TypeScript 5.x, so it would analyse with a *different*
compiler than the gate uses. TS 7's own JS API (`typescript/unstable/sync`) exposes references
(`Checker.getReferencedSymbolsForNode`) but **no `findRenameLocations`**, so renames must go through
the LSP rather than be reconstructed from references — reconstruction would miss
`import { x as y }`, shorthand property assignments and string element access.

Three properties that matter for this plan:

- **Position is discovered, not hand-counted.** Every whole-word occurrence in the target file is
  offered to `textDocument/prepareRename`, and the first the server *accepts* is used. The server's
  own answer to "is this a renameable symbol here" is what skips comments and strings — no heuristic
  of ours. A word that appears only in prose exits 1 with a clear message.
- **Field renames are type-scoped.** Pointing it at a declaration renames that symbol only, so
  `optionArms` cannot touch `CompileOptions`. This is the entire reason §4.2's `options` row is safe
  and a text substitution would not be.
- **Comments are never touched.** LSP `textDocument/rename` has no `findInComments` option (that was
  tsserver-only). So every group below has a second, deliberate half: the prose that names the
  symbol. Treat a rename as unfinished until the comments around it read correctly — for the
  `carry*` family that prose is most of the work, not a tidy-up.

Two protocol notes recorded because they cost real debugging time: the server sends
`client/registerCapability` as a **request**, and ignoring it deadlocks every later request (a rename
that never returns); and `--stdio` is only a legal flag alongside `--lsp`, which is otherwise absent
from `tsc --help --all`.

## Sequencing and gates

**Land semantic groups separately, one commit each, census after every one.** The LSP removes the
mechanical risk of a rename; it does not remove the risk of renaming the *wrong* `options` or `fold`,
which is why the groups stay small and the gates stay.

Ordering is by dependency and edit-conflict only — a group is not "later" for being larger.

| # | Group | Why here |
|---|---|---|
| 1 | §2/§3 comment-only: retire `Seam`/`Layer`, fix the `FastPath` row | Nothing depends on it and it depends on nothing. §4.4's comment fix already landed in `bd6dfaf`. |
| 2 | `CompileScope` → `ChildFrameStack`; `*_TAIL` → `*_DISPATCH`; `materializeFinal` → `materializeRootStream`; `analyze` → `analyzeChain`; `steps/resource.ts` → `steps/graph-source.ts` | Five independent names, no shared files with any other group. |
| 3 | The whole `carry*` family (§4.3) | Must follow the in-flight [channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md) work, which is editing these exact call sites. A real conflict, not a cost. |
| 4 | `advance` → `appendCte`; `cluster` → `repeatRegion`; `bys` → `modulators`; `options` → `optionArms` | `appendCte`'s signature takes the patch type group 3 renames, and both edit `context.ts` — adjacent to 3 so that file is touched once per concern. |
| 5 | `PStep` → `IRStep` | The three field renames in group 4 are fields *of* this type; doing the fields first keeps each commit's diff about one name. |
| 6 | §5 rewrite verbs + `PassCategory` `fold` → `canonicalize` + §4.5 file split | The split creates `ir/step.ts` around `IRStep`, so it needs group 5's name to exist. |
| 7 | §6 vocabulary sets, one commit per family | The sets move into `ir/step.ts` in group 6, and this group alone carries the byte-identical SQL gate below — it should not have another rename in flight to confuse a snapshot diff. |

Every item uses the same gate: `mise run test` (**not** bare `bun test` — it skips `tsc --noEmit` and
the submodule), and **the census is the real gate** (`test/census/`, which fails the build if a
traversal stops executing, returns a different multiset, or turns a clean deferral into a crash).

§6 needs a **stricter** gate: because it only changes how membership is written, the emitted SQL must
be **byte-identical**, not merely behaviourally equal — diff the `test/L2-sql/` snapshots. Any
movement there means a derivation altered a set's contents, which §6 forbids. Re-check too that
`COLLAPSE_MOVES`/`POSITION_MOVEMENTS`/`VERTEX_PRODUCERS` still differ on `otherV` exactly as
tabulated.

**Caveat, inherited from the shape doc**: expect L3 delta = 0 across all of this. That is the point of
the census — without it, "behaviour preserved" is indistinguishable from "20 deferrals quietly became
wrong answers".

## The base rate this doc is subject to

Structural need predicted forward from an architecture sketch has been falsified by measurement
roughly twelve times in this repo
([shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md):164-180). Three
falsifications in §4.1 and the reversal in §4.6 arrived within a day of the first draft, from nothing
more than reading the code the draft was about.

§4.3 failed differently and is worth recording as its own mode: nothing about it was falsified by
measurement, it was *decided* by measurement that should never have been admitted as evidence. A
reference count made a half-rename look prudent, and "large" got written down as "cosmetic". A rename
is right or wrong on the name; the only legitimate use of scale here is edit-conflict ordering, which
is what the sequencing table now says and all it says.

Nothing here is a proposal for a universal algebra; that is ruled out in the same doc and is not
relitigated.
