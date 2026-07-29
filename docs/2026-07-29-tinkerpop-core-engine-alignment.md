# Aligning the compiler's vocabulary with TinkerPop's core engine

**Status: design session, 2026-07-29. No code landed.** A read of TinkerPop `gremlin-core` on
`origin/master` (`f475bca`) against `src/compiler/**` at `a2b8d4b`, asking: where do we diverge
from a decade of converged naming, and which of those divergences should we close? Counts and
`file:line` citations were verified by hand at `a2b8d4b`; the ones that changed my
recommendation are called out as such.

The structural half of the answer is **already in flight** — see
[channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md), which this doc
defers to rather than duplicates. What is left here is a vocabulary alignment, plus a record of
which TinkerPop patterns to deliberately *not* adopt.

## What the comparison actually found

Three classes of finding, in descending order of value:

1. **One structural idea worth naming** — TinkerPop's `TraverserRequirement` → traverser-class
   derivation (declare → union → derive). Our `Carried` is the same concept, and closing the gap
   is already Phase 1 of the channel-preservation plan. This doc adds the prior-art citation,
   not new work (§1).
2. **A rename set** where we invented a word for a standard concept, including two *collisions*
   that can cause a mistake rather than a moment's confusion (§2, §4).
3. **Four TinkerPop patterns to refuse**, recorded so they are not re-proposed (§6). One of them
   (`GValue`) is genuinely elegant and worth revisiting under one specific future condition.

## The base rate this doc is subject to

Structural need predicted forward from an architecture sketch has been falsified by measurement
roughly twelve times in this repo
([shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md):164-180). So the
ordering below is by *measured yield*, and the largest section (§4–§5) is explicitly the low-value
mechanical half. Nothing here is a proposal for a universal algebra; that is ruled out in the same
doc and is not relitigated.

---

## 1. `TraverserRequirement` — the prior art for `Carried`, and why this is a citation not a plan

`TraverserRequirement` is a 9-value enum (`BULK`, `LABELED_PATH`, `NESTED_LOOP`, `OBJECT`,
`ONE_BULK`, `PATH`, `SACK`, `SIDE_EFFECTS`, `SINGLE_LOOP`). Each step declares
`getRequirements()`; a `TraversalParent` unions its children's via
`getSelfAndChildRequirements(...)`; `DefaultTraversal.getTraverserRequirements()`
(`util/DefaultTraversal.java:167-185`) folds the whole tree once and memoizes; then
`DefaultTraverserGeneratorFactory` **derives** the concrete traverser class from the union
(`B_LP_NL_O_P_S_SE_SL_Traverser` and ~19 siblings).

The structure worth copying is **declare → union → derive**. The 20-class pre-generated cross
product is not — that is a JVM monomorphisation trick with no analogue here.

`Carried` (`steps/context/context.ts:160`) is the same object built the same way round: 8 typed
roles declared, and the physical column list *derived* by `carriedCols` (`context.ts:352`), which
is already the single source of truth. Two gaps remain, and **both are already Phase 1 of
[channel-preservation](./2026-07-28-channel-preservation-refactoring-plan.md)**:

- the ORDER RULE that makes the derivation correct is a prose comment (`context.ts:344-350`),
  enforced only after the fact by `assertStreamColumns`;
- threading is still dominated by hand-written spreads — **104 `...carried` against 39
  `carriedWith`** at `a2b8d4b`.

**Corrections to my own first pass, both worth recording**: `mergeCarried` *does* exist
(`context.ts:269`) — the shape doc's §8 says it does not, which was true when written and is now
stale. And `carryThrough` *also* already exists (`stream.ts:384`, landed in `2096c41`); I
initially reported it absent because I grepped for `export function` and it is an
`export const` arrow. So the "add the named preserving rebuild" step is **done**, and what
remains is its deployment breadth, which the channel-preservation plan already scopes.

**The one thing this doc adds**: when that phase lands, cite `TraverserRequirement` in the
`Carried` doc-comment. The pattern has a name and a decade of prior art, and a future reader
deciding whether a new role belongs on `Carried` benefits from knowing the shape is deliberate.

## 2. The two name collisions worth closing regardless

These are the only renames that can cause a *mistake*.

1. **`CompileScope` (`steps/tail/child-shape.ts:51`) vs `CompilerScope` (`scopes.ts:36`)** — two
   letters apart, one import apart, unrelated meanings: a lexical/relational frame stack for
   child bodies, versus a DI container lifecycle. TinkerPop keeps these vocabularies apart
   (`TraversalParent` children vs `TraversalStrategies`). Rename the child-body one to the frame
   vocabulary it is (`ChildFrameStack`/`BodyScope`), leaving "Scope" to mean DI lifetime only.
2. **`Carry` vs `Carried`** — the state bag versus the row layout, nested inside each other and
   one letter apart, so `st.carried` beside `carryOf(st)` reads as a typo. `Carry` is a
   *compilation environment*; `Carried` is a *row/frame layout*. `Carried`'s own doc-comment
   says "the per-traverser CARRIED SCHEMA" — the honest word is already there.

## 3. Two private numbering schemes to retire

`Seam 2`/`Seam 3` (`compiler.ts:21,25`, `engine/engine.ts:42`, `context.ts:8`,
`ir/strategies.ts:4`) and `Layer A/B/C1/C2` (`ir/pass.ts:4`, `ir/analyze.ts:3`,
`options/fast-paths.ts:70`) are **two incompatible numbering schemes for one three-way split**,
with the numbering defined only in an archived doc and `Seam 1` never mentioned anywhere.

The split itself is good, and close to TinkerPop's own division of labour — so name it plainly:

| Ours | What it does | TinkerPop analogue |
|---|---|---|
| `Pass` | rewrites the chain | `TraversalStrategy` |
| `ChainFacts` | annotates, never rewrites | `TraverserRequirement` aggregation |
| `FastPath` | selects a lowering | `ProviderOptimizationStrategy` |

Comments only, no code change; then state it once in `src/compiler/CLAUDE.md`.

## 4. Renames where ours is homegrown

Each is rename-only, with a blast radius counted at `a2b8d4b`. One commit each, census after
every one. **Re-grep before starting** — several of these files are actively changing.

| Ours | Rename to | Sites | Why |
|---|---|---|---|
| `advance` (`context.ts:456`) | `emitCte` | 33 | Most-called function in the compiler; "advance" reads like a cursor op. It appends a CTE and returns new state. |
| `cluster` (`ir/strategies.ts:31`) | `repeatGroup` | 7 | It is the fused `repeat/until/emit/times` run. |
| `steps/resource.ts` | `steps/graph-source.ts` | 3 | The file is `lowerReSource` — a mid-traversal `V()`/`E()`. TinkerPop's name for this is `GraphStep`. |
| `options` on `PStep` | `optionArms` | ~30 | Collides with `CompileOptions`/`FastPathConfig` throughout. TinkerPop: `TraversalOptionParent.addChildOption`. Grep carefully — `.options` also means compile options. |
| `materializeFinal` | `materializeRoot` | 33 | "root" and "final" used interchangeably for one boundary; `materialize<Kind>Root` siblings settle it. |
| `bys` (`ir/strategies.ts:31`) | `modulators` | 72 | TinkerPop's word is `ByModulating`/`modulateBy`. A pluralized step name is not a field name. |
| `PStep` (`ir/strategies.ts:31`) | `NormalizedStep` | 304 | Single letter, unexplained. Biggest and most mechanical — land last. |

**Keep, but document once**: `encounter` (TinkerPop's "encounter order"); `bulk` (correct
TinkerPop terminology for a Traverser's bulk — say so once and stop re-explaining it as
"multiplicity"/"RLE" in every comment); `productivity.ts` (opaque, but it *is* TinkerPop's word —
`ProductiveByStrategy`, `TraversalProduct.isProductive`); `Stream` (a 12-member union threaded
everywhere: rename cost enormous, concept documented); `ChainFacts` (non-standard, but the
`Pass`/`ChainFacts`/`FastPath` triad reads well).

### `ir/strategies.ts` — the one structural split

1013 lines, 35 importers, and its own header (`:4`) calls the contents "pass BODIES". Two thirds
have nothing to do with TraversalStrategies. Split three ways, re-exporting from
`strategies.ts` in the same commit so importers move separately:

- **`ir/folds.ts`** — `foldRepeatClusters`, `foldByModulators`, `foldChooseOptions`,
  `foldCallWith`, `foldConnectives`, `foldValueMapWith`, `foldConstantPredicateOperands`,
  `stripTerminal`, `collapseFoldCountLocal`, `dropRedundantOrder`, `rewriteWhereEndLabels`,
  `alwaysProductiveFilterIsNoOp`.
- **`ir/strategies.ts`** — what the name promises, and the part with a real TinkerPop
  counterpart (`strategy/{decoration,verification}`): `NO_OP_STRATEGIES`,
  `ALWAYS_ON_STRATEGIES`, `VERIFICATION_STRATEGIES`, `injectSubgraphRec`, `injectPartitionRec`,
  `markProductiveBy`, `verify`, `verifyReadOnlyChildren`, `rejectMsg`.
- **`ir/step.ts`** — `PStep`/`NormalizedStep` plus the vocabulary sets from §5.

### `tail/` → `shaped/`

**Correcting a first-pass claim**: I asserted `steps/tail/` was full of files that are not "the
tail of a chain" — `keyed.ts`, `correlated.ts`, `barrier.ts`, `child.ts`. Checking their exports,
that was too strong: they are all child/barrier **provisioning** for the shape-dispatch half, so
they *are* one coherent layer. The defect is only that "tail" names the layer by *position* when
the real axis is **element-typed fold (`prefix/`) vs shape-polymorphic dispatch**.

So the rename stands but is smaller than first estimated:

- `steps/tail/` → `steps/shaped/`: 51 files carry `tail/` import paths — mechanical.
- The six `*_TAIL` tables plus the unqualified `TAIL` — **18 references total**. Rename to
  `<SHAPE>_DISPATCH`, and give the bare `TAIL` a shape name (`ELEMENT_DISPATCH`), removing the
  odd-one-out asymmetry.
- Keep `prefix/`: it genuinely *is* the chain prefix and the element-typed fold.
- Two lodgers to fix while here: `PROPERTY_TAIL` + `compileFromProperty` live in
  `tail/group.ts`; `compileFromMap`/`compileFromMapEntry` live in `tail/list.ts`.

Land this **last** — it moves files, so it conflicts with everything else.

## 5. Vocabulary-set drift — and why the obvious fix is wrong

`{count,sum,min,max,mean}` appears **verbatim at 6 sites** (`analyze.ts:97`,
`ir/strategies.ts:613`, `child-shape.ts:304`, `bulk.ts:52`, `list.ts:405`, `group.ts:155`); the
movement vocabulary has ~10 overlapping spellings; the set-op lists have 4.

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
[shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §9 refutes, and
the reason the "these two must not drift" comments (`child.ts:122-125`,
`child-shape.ts:302-303`) are load-bearing prose.

**So: derive with a named difference, never merge.** Extract one base
(`VERTEX_MOVES`/`EDGE_MOVES`/`ENDPOINT_MOVES`/`OTHER_V`/`REDUCERS`) and have each existing set
spell its own membership relative to it, e.g.
`COLLAPSE_MOVES = union(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES)` — so the missing `OTHER_V`
becomes *visibly* missing instead of invisibly absent.

Rules, because this is the delicate one:

1. Every set keeps its own name and call sites. This changes how membership is **written**, never
   what any set contains.
2. **No membership changes here.** If a derivation makes a set look wrong —
   `POSITION_MOVEMENTS` is the known case — file it. It needs its own test, or the fix lands
   untested and disguised as a rename.
3. One commit per family (moves, reducers, set-ops, path-steps) so a revert is clean.

The one *unambiguous* duplicate found: `{path, simplePath, cyclicPath}` is spelled three times
(`analyze.ts:34`, `ir/strategies.ts:41`, and a file-local `const PATH` at `bulk.ts:158`). Start
there — a one-line deletion that proves the mechanism.

## 6. Do NOT adopt — recorded so it is not re-proposed

- **Marker interfaces + `instanceof` dispatch.** TinkerPop's dominant idiom (~35 capability
  interfaces: `ByModulating`, `Scoping`, `PathProcessor`, `Barrier`, …). Right for an
  *interpreter* with an open step hierarchy. We compile, and our "register in a Map, never grow a
  switch" rule is *better here*: a Map lookup is total and a missing key fails closed, whereas an
  `instanceof` chain falls through silently. Keep ours.
- **The Global/Local step-class split.** TinkerPop models `Scope.local` as two distinct classes
  (`OrderGlobalStep`/`OrderLocalStep`) because the bases are incompatible — barrier vs
  scalar-map — and `Scope` is a *builder-time dispatch token only*, gone before any strategy
  runs. We already have the equivalent separation in the shape tables; adopting the naming is
  churn.
- **`GValue`/`GValueHolder`/placeholder-step duality.** TinkerPop's newest pattern: every
  parameterizable step exists twice (`GraphStep`/`GraphStepPlaceholder`) behind a `*StepContract`,
  with `GValueManager.pinVariable` taint-tracking any strategy that reads a concrete parameter, so
  a plan is marked non-generalizable the moment an optimization depends on a literal. Genuinely
  elegant. **It buys nothing without a plan cache**, which we do not have — revisit only if one is
  ever built.
- **A typed core IR / cross-layer shape algebra.** Refuted in
  [shape-vocabulary-architecture](./2026-07-28-shape-vocabulary-architecture.md) §6 and §9.
- **Merging `Stream` into `Shape`.** Refuted in the same doc §9 — `Stream` is a capability
  partition holding a live `Query`; merging drags the SQL kernel into the wire layer.

## 7. One thing TinkerPop master confirms

`Bytecode` is **gone** on master — `find . -name "Bytecode*.java"` returns nothing repo-wide,
replaced by `GremlinLang` (a canonical Gremlin string plus a parameter map, reachable via
`Traversal.Admin.getGremlinLang()`). That is independent confirmation of locked decision #1 in
the root `CLAUDE.md`: v4 dropped bytecode and the wire format is a string + parameters.

## Sequencing and gates

§2 and §3 are independent and can land any time. §4 and §5 should wait for the in-flight
concat/channel work — §4 renames the directory those files live in.

Every item uses the same gate: `mise run test` (**not** bare `bun test` — it skips
`tsc --noEmit` and the submodule), and **the census is the real gate** (`test/census/`, which
fails the build if a traversal stops executing, returns a different multiset, or turns a clean
deferral into a crash).

§5 needs a **stricter** gate than the others: because it only changes how membership is written,
the emitted SQL must be **byte-identical**, not merely behaviourally equal — diff the `test/L2-sql/`
snapshots. Any movement there means a derivation altered a set's contents, which §5 forbids.
Re-check too that `COLLAPSE_MOVES`/`POSITION_MOVEMENTS`/`VERTEX_PRODUCERS` still differ on
`otherV` exactly as tabulated above.

**Caveat, inherited from the shape doc**: expect L3 delta = 0 across all of this. That is the
point of the census — without it, "behaviour preserved" is indistinguishable from "20 deferrals
quietly became wrong answers".
