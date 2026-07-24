# Unified rewrite passes + chain analysis — plan

**Date:** 2026-07-24
**Status:** PLAN (not started). Sequenced, behavior-preserving. Every stage lands green
against the L2 SQL snapshots and the L3 ratchet (`l3-state.json`) with **no delta** — this
is a *structural* refactor, not a semantics change.

**Reading order:** sits alongside `docs/2026-07-13-with-strategies-exploration.md` (the
*external* `withStrategies` feature — SETTLED) and the compiler-architecture section of
`CLAUDE.md`. This doc is about the layer that `withStrategies` doc **never considered**:
the *internal* normalization + analysis machinery, and the observation that it shares a
shape with the external strategy layer.

---

## 0. The insight this doc captures

The `withStrategies` exploration treated a TinkerPop strategy as *a feature to support*
and landed on the correct model: **a strategy is a `Step[]→Step[]` rewrite over our own IR,
driven by parsed config, failing closed on anything not explicitly handled** (implemented in
`src/compiler/ir/strategies.ts` `applyStrategies`).

What that doc did **not** notice: our *internal* compiler optimizations are **the same shape**.
`foldRepeatClusters`, `foldByModulators`, `dropRedundantOrder`, `collapseFoldCountLocal` — every
one is a `Step[]→Step[]` (or `PStep[]→PStep[]`) rewrite, hand-sequenced inside `normalize()`.
The external strategy dispatch (`applyStrategies`) and the internal normalization (`normalize`)
are **two implementations of one idea, living in the same file under a comment that says they
merely share a name** (`strategies.ts:39-47`). They should share a *contract*.

TinkerPop's own architecture already validates this: its `TraversalStrategy` categories
(Decoration / Optimization / ProviderOptimization / Finalization / Verification, applied in a
fixed topological order) are exactly this — *categorized, ordered, declarative traversal
rewrites*. We cannot subclass its JVM classes (we parse a string; there is no live `Traversal`
object graph — see the `withStrategies` doc §II and the v4 grammar `traversalStrategy :
K_NEW? classType ...`, which is a **Java class reference**, JVM-server-internal). But we can and
should adopt the *pattern*: **one `Pass` contract, categorized, ordered** — for our internal
folds AND the external strategies, uniformly.

**Scope decision (locked at plan time): three sibling abstractions, one verb each.** The
temptation is "one Rule type for everything." That is *false* unification — layer C is not one
thing, it is two, and neither shares a verb with a Pass. The clean design is **three cohesive
registries, each owning exactly one verb, zero union types**:

| Abstraction | Verb | Signature | Layer | Members |
|---|---|---|---|---|
| `Pass` (§2) | **rewrite** the chain | `Step[] → Step[]` (or throw) | A + B | folds, Subgraph/Partition inject, verify |
| `ChainFacts` (§4) | **annotate** the chain | `Step[] → facts` | C1 | the four whole-chain scans |
| `FastPath` (§5) | **select** a SQL lowering | `(Stream, steps) → Stream \| null` | C2 | predicate inlining, movement collapse, … |

Why NOT one union `{ run?, annotate?, select? }`: a consumer would have to re-narrow which verb
each Rule implements — the abstraction leaks and every call site grows a switch (the exact thing
`CLAUDE.md` forbids). Three types with one verb apiece read *cleaner* than one type with three
optional verbs. This is the real "clean unification": not one abstraction swallowing three jobs,
but each job given its own well-shaped Rule. It mirrors how real compilers separate logical
tree-rewrites from physical operator selection (Calcite's `RelRule` vs its physical conversion
rules are deliberately distinct interfaces — same lesson).

Layer C2 (`FastPath`) is the "nice Rule shape" — it promotes today's six ad-hoc `try*` fast-paths
onto ONE interface that encodes the qualification contract `CLAUDE.md` currently states only in
prose. It is **in scope** for this plan (§5), as its own registry, sequenced last.

---

## 1. The current landscape (verified against code, 2026-07-24)

### Layer A — external `withStrategies` (`applyStrategies`, strategies.ts:321-342)

An if/else ladder over spec names, with a `Set`-based taxonomy already acting as categories:

| Handling | Mechanism today | Members |
|---|---|---|
| no-op | `NO_OP_STRATEGIES` Set → `continue` | ~30 optimization/OLAP/lambda-ban strategies |
| inject | `injectSubgraphRec` / `injectPartitionRec` / `markProductiveBy` | Subgraph, Partition, ProductiveBy |
| verify | `VERIFICATION_STRATEGIES` Set → deferred `verify()` | ReadOnly, EdgeLabel, ReservedKeys |
| reject | catch-all `throw rejectMsg(name)` | everything else (fail closed) |
| always-on | `ALWAYS_ON_STRATEGIES` → reject `withoutStrategies` | ConnectiveStrategy |

Runs **before** `normalize()` (compiler.ts:41) so injected `has()`/`where()` canonicalize like
any parsed step.

### Layer B — internal `normalize()` passes (strategies.ts:370-373)

One hand-composed pipeline, read inside-out:

```ts
normalize(steps) =
  dropRedundantOrder(
    collapseFoldCountLocal(
      foldCallWith(
        foldChooseOptions(
          foldByModulators(
            foldRepeatClusters(
              stripTerminal(steps).steps))))))
```

Seven passes, each a pure `Step[]→Step[]`:

| Pass | Kind | What |
|---|---|---|
| `stripTerminal` | extract | pop trailing `discard()`/`none()`, return `{steps, discard}` out-of-band |
| `foldRepeatClusters` | fold | gather `repeat/emit/times/until` run → one `.cluster` step |
| `foldByModulators` | fold | absorb trailing `by()`/`from()`/`to()` → host `.bys`/`.from`/`.to` |
| `foldChooseOptions` | fold | absorb `.option()` run → `choose.options` |
| `foldCallWith` | fold | absorb `with()` run after `call()` → `.withArgs` |
| `collapseFoldCountLocal` | simplify | `fold().count(local)` ≡ `count()` |
| `dropRedundantOrder` | simplify | drop keyless `order()` before an order-insensitive reducer |

The **ordering is load-bearing and implicit**: `collapseFoldCountLocal` must run before
`dropRedundantOrder` (comment at :417); `foldByModulators` must run before `dropRedundantOrder`
so an `order().by()` has its `.bys` set and is skipped (:441). Today these constraints live in
prose comments and the nesting order — not encoded anywhere a reader or a test can check.

### Layer C — analysis scans + fast-paths (scattered; NOT unified here)

Four whole-chain scans, each re-walking `steps` independently:

| Scan | Location | Produces | Granularity |
|---|---|---|---|
| `chainTracksPath` | engine.ts:75 | does any step need the path threaded? | chain-global |
| `demandsEncounterOrder` | strategies.ts:396 | positional consumer after a fan-out? | chain-global |
| `chainCollapseSafe` | engine.ts:110-148 | is `movementCollapse` result-safe here? | chain-global |
| `chainNeedsFromV` | engine.ts:78 | does the chain name `otherV`? | **per-scope** — already re-derived on `carried.trackFromV` (engine.ts:325); NOT a chain fact (see §4) |

Consumed at: `seedSource` (path/encounter columns), `collapseSafeFastPaths` (gate the flag),
`compileRead` (encounter demand). The first three become `ChainFacts` (§4); `chainNeedsFromV`
stays a per-scope `carried` derivation. Plus the
per-site fast-paths (`predicateInlining`, `singleHopOptional`, `bulkRepeatCount`,
`ftsSubstringPredicate`, `scalarPredicateInlining`, `movementCollapse` — `fast-paths.ts`),
each a `try*` recognizer returning `null` to fall through.

These are **read-only derivations + SQL-shape choices**, not rewrites. They get §4.

---

## 2. Target: the `Pass` contract (layers A + B)

One shape for every `Step[]→Step[]` transform, external or internal:

```ts
/** A categorized, ordered rewrite over the step chain. The SINGLE shape for both internal
 *  normalization folds and external withStrategies application. `run` is the only verb —
 *  a Pass either rewrites the chain or (verify category) throws; it never annotates or
 *  selects SQL (that is ChainFacts / fast-paths, §4). */
interface Pass {
  readonly name: string;
  readonly category: PassCategory;
  /** Cheap gate: skip `run` when this chain can't contain the pass's trigger. Optional;
   *  a pass with no `applies` always runs. Keeps the pipeline O(passes) not O(passes·rescans). */
  applies?(ctx: PassContext): boolean;
  /** The rewrite. Pure. For a verify-category pass, throws the spec's canonical message
   *  and returns the chain unchanged. */
  run(steps: PStep[], ctx: PassContext): PStep[];
}

/** Fixed topological order — mirrors TinkerPop's category ordering, scoped to what a
 *  SQL provider does. Lower runs first. */
type PassCategory =
  | 'extract'      // stripTerminal — pull out-of-band flags (discard). Runs first.
  | 'fold'         // repeat/by/choose/callWith clustering — canonicalize multi-step shapes
  | 'decoration'   // Subgraph/Partition/ProductiveBy — inject filters/stamps (external, config-driven)
  | 'simplify'     // dropRedundantOrder/foldCountLocal — provable no-op removals
  | 'verify';      // ReadOnly/EdgeLabel/ReservedKeys — assert legality, throw; runs LAST

interface PassContext {
  readonly params: Record<string, any>;
  readonly strategies: StrategyUse;   // parsed withStrategies/withoutStrategies specs
  /** Out-of-band results a pass may set (discard flag). Mutable bag, written by `extract`. */
  readonly out: { discard: boolean };
}
```

### Why this ordering (and why it is now *encoded*, not prose)

The implicit constraints from §1 become explicit category order:

- `extract` first — `stripTerminal` pops `discard()` before anything folds a cluster that
  might otherwise include it.
- `fold` before `simplify` — `dropRedundantOrder` needs `foldByModulators` to have set `.bys`
  (so `order().by()` is skipped); `collapseFoldCountLocal` before `dropRedundantOrder`.
  Both are satisfied by `fold` < `simplify`.
- `decoration` (external strategies) before `simplify` — an injected `where()`/`has()` from
  Subgraph/Partition should be subject to the same simplifications as a parsed one. **This is
  a behavior-equivalent reordering** of today's "strategies before normalize" (compiler.ts:41):
  today injection happens, then ALL of normalize; here injection is a `decoration` pass slotted
  between `fold` and `simplify`. Injected steps are plain `where`/`has`/`property` — they carry no
  `by()`/cluster, so running `fold` before them changes nothing (verified: `synth()` bodies are
  already-lowered `Step[]`, idempotent under the folds). **Equivalence obligation: prove no L2
  snapshot moves.** If any does, keep decoration pre-fold (a `decoration-early` category) — the
  plan accommodates either; the snapshots decide.
- `verify` last — asserts against the (already-rewritten) chain. NB today `verify()` runs against
  the *user's original* pre-injection chain (strategies.ts:340). **Preserve that:** verify passes
  read `ctx` for the original chain, OR the pipeline snapshots the pre-decoration chain and hands
  it to verify passes. Decide at build time; the original-chain semantics is the contract.

### The pipeline driver replaces both `applyStrategies` and `normalize`

```ts
function runPasses(steps: Step[], use: StrategyUse, params): { steps: PStep[]; discard: boolean } {
  const ctx = { params, strategies: use, out: { discard: false } };
  let chain = steps as PStep[];
  for (const pass of PASSES) {               // PASSES sorted by category, then intra-category order
    if (pass.applies && !pass.applies(ctx)) continue;
    chain = pass.run(chain, ctx);
  }
  return { steps: chain, discard: ctx.out.discard };
}
```

`PASSES` is one flat, ordered array assembled from category groups — the "register in a Map/array,
don't grow a switch" law (`CLAUDE.md`) applied to the strategy layer. Adding a rewrite = add a
`Pass` to the right category group. The if/else ladder in `applyStrategies` and the inside-out
`normalize()` nesting both dissolve into declared members.

### External strategies become decoration/verify Passes

- `NO_OP_STRATEGIES` → a pass that is simply **absent** (a no-op strategy contributes no Pass).
  The name-classification Set stays as the *lookup* (`applies` reads it), but "no-op" stops being
  a code path — it's the default of having no pass.
- `injectSubgraphRec` → `SubgraphPass` (category `decoration`, `applies`: `use.with` names it).
- `injectPartitionRec` → `PartitionPass` (decoration).
- `markProductiveBy` → `ProductiveByPass` (decoration).
- `verify()` split into `ReadOnlyPass` / `EdgeLabelPass` / `ReservedKeysPass` (verify).
- reject catch-all → the pipeline's final check: any `use.with` name not consumed by some
  pass's `applies` → `throw rejectMsg(name)`. Fail-closed is preserved as a **pipeline
  invariant**, not a ladder `else`.
- `ALWAYS_ON_STRATEGIES` / `withoutStrategies` suppression → resolved in `PassContext`
  construction (filter `use.with` by `use.without`; reject `withoutStrategies` of an always-on),
  exactly as `applyStrategies` does today.

---

## 3. Migration sequence (each stage green, no L3 delta)

**Stage 0 — ChainFacts extraction (do FIRST; see §4).** Independent of the Pass work,
highest value / lowest risk. Land it, bank it.

**Stage 1 — introduce `Pass` + `runPasses`, migrate the internal folds only.** Move
`stripTerminal`/`foldRepeatClusters`/`foldByModulators`/`foldChooseOptions`/`foldCallWith`/
`collapseFoldCountLocal`/`dropRedundantOrder` behind `Pass` objects; `normalize()` becomes a
thin `runPasses(steps, EMPTY_STRATEGY_USE, params)` that ignores decoration/verify. Leave
`applyStrategies` untouched and still called separately from compiler.ts. **Equivalence:
identical output for every input — pure mechanical move.** L2 snapshots must not budge.

**Stage 2 — fold `applyStrategies` into the same pipeline.** Migrate Subgraph/Partition/
ProductiveBy → decoration Passes, verifications → verify Passes, the reject/no-op/without
logic → pipeline invariants + `PassContext`. compiler.ts calls `runPasses` ONCE instead of
`applyStrategies` then `normalize`. **Equivalence obligation: the decoration-vs-fold ordering
question (§2) — prove no snapshot moves, else keep decoration early.** This is the stage that
delivers the "one shape" headline.

**Stage 3 — encode ordering constraints as a test.** A unit test asserts category order and
the two intra-fold constraints (`collapseFoldCountLocal` < `dropRedundantOrder`;
`foldByModulators` < `dropRedundantOrder`), so a future reorder that breaks them fails loudly
instead of silently mis-compiling. Turns today's load-bearing prose comments into a guard.

**Stage 4 — the `FastPath` registry (§5).** Migrate the six `try*` fast-paths onto the `FastPath`
interface + a dispatch registry; `FastPathConfig` keeps its role as enable switches. Independent of
Stages 1–3 (touches lowering-site dispatch, not the pre-lowering pipeline) — can land before or
after them. Each fast-path already has its equivalence test (now named in `equivalentWhen`), so this
is a pure dispatch-shape refactor. **Equivalence: L2 + L3 unchanged.**

Each stage is independently revertable and independently green. Recommended order: 0 (ChainFacts) →
1 → 2 → 3, then 4 whenever convenient — 4 is orthogonal to the Pass pipeline and depends on
ChainFacts only for `MovementCollapseFastPath`'s gate.

---

## 4. Layer C1 — `ChainFacts` (annotation, NOT a Pass, NOT a FastPath)

The four whole-chain scans (§1 layer C) each re-walk `steps`. Consolidate them into **one
analysis pass producing an immutable annotation** the Engine reads — the compiler's
equivalent of a dataflow-analysis phase (attribute grammar / "decorate the tree").

### `ChainFacts` is DATA, not a class — and NOT per-step attributes

Three shapes were on the table; the code decides between them:

1. **Flat chain-level record** (chosen) — `interface ChainFacts { ...scalars }` + a free
   `analyze(steps): ChainFacts`. No behavior, no methods → an interface/frozen record, exactly
   like `FastPathConfig` (and the opposite of `LoweringEngine`, which is a class because it has
   injected deps + behavior). **Facts have no behavior, so they are data.**
2. **Per-step attributes** (attribute-grammar / "decorate every `PStep`") — rejected. Verified
   against consumption: each surviving fact is read at *exactly one* seeding site as *one boolean*
   (see below). Attaching `.isFanout`/`.producesEdge` to every step to compute one chain-global
   yes/no read in one place is over-engineering — the tree-decoration pattern earns its keep only
   when many sites read many per-node attributes, which is not this.
3. **Riding `PStep`/`Carry` fields** (the `.bys`/`.cluster`/`carried.trackFromV` mechanism) — this
   already exists and is the RIGHT home for the *per-scope* annotations. See the scoping split below.

```ts
/** Whole-chain properties derived once, before lowering. Read-only DATA (no methods); the Engine
 *  consults it instead of re-scanning. NOT a Pass (it does not rewrite) and NOT per-step (each
 *  field is one value for the whole compile, read at one seeding site). */
interface ChainFacts {
  readonly tracksPath: boolean;       // was chainTracksPath        → seedSource: add p0 column?
  readonly demandsEncounter: boolean; // was demandsEncounterOrder  → seedSource: add encounter column?
  readonly collapseSafe: boolean;     // was chainCollapseSafe      → gate the movementCollapse flag
}

function analyze(steps: PStep[]): ChainFacts { /* one cohesive walk */ }
```

### The scoping split the flat-record framing initially hid (a real correction)

The first draft of this doc listed `needsFromV` (was `chainNeedsFromV`) as a fourth `ChainFacts`
field. **That is wrong, and the code proves it.** `needsFromV` is NOT a chain-global fact: it is
re-derived PER-SCOPE at `lowerElementSteps` (engine.ts:325 — `!seedSt.carried.trackFromV &&
steps.some(...otherV)`), because a nested scope (a correlated predicate, a child count) can
independently need the entering-vertex context even when the root chain does not. It already rides
`carried.trackFromV`. Folding it into a chain-level record would DROP that per-scope re-derivation
and silently break nested edge chains. So there are **two kinds of annotation, and they stay
separate**:

| Kind | Granularity | Home | Members |
|---|---|---|---|
| **Chain fact** | one value / compile, read once at seeding | `ChainFacts` record (new) | `tracksPath`, `demandsEncounter`, `collapseSafe` |
| **Carried annotation** | per-scope, threaded through lowering | `Carry` / `PStep` fields (exists) | `trackFromV`, `.bys`, `.cluster`, `.options` |

`ChainFacts` is *only* for the chain-global things. The per-scope "annotation" instinct is real but
already served by `Carry` — do not migrate `trackFromV` into `ChainFacts`.

Wiring: `LoweringEngine` receives `ChainFacts` (built once in `compilePlan`, after
`runPasses`). `seedSource` reads `facts.tracksPath`/`facts.demandsEncounter`; the movementCollapse
gate reads `facts.collapseSafe`. `buildPrefix`/`lowerElementSteps` keep deriving `trackFromV`
per-scope onto `carried` exactly as today.

The `demandsEncounterOrder`/`chainCollapseSafe` interdependence (they must agree on the `sawOrder`
reset — see strategies.ts:404 and engine.ts:142) becomes **one function computing both**, so they
cannot drift apart. That drift-risk is the strongest argument for this extraction and is called out
in both files' comments today.

Fast-paths are a **separate** abstraction (§5) — a different verb (select SQL, not annotate).
`ChainFacts` may *feed* a FastPath's `appliesWhen` (e.g. `movementCollapse`'s gate is
`facts.collapseSafe`), but the two stay distinct types.

**ChainFacts equivalence:** pure refactor. The four scans produce the same booleans; only the
call sites change (read a field vs call a function). L2 + L3 unchanged.

---

## 5. Layer C2 — the `FastPath` registry (the "nice Rules")

Today's six fast-paths (`fast-paths.ts` `FastPathConfig` + their `try*` recognizers scattered
across `plan.ts`/`bulk.ts`/`correlated.ts`/`filter.ts`) all *conceptually* obey one contract —
`CLAUDE.md` writes it out in **prose**: "the generic path stays the semantic authority; disabling
the switch compiles the same traversal generically; recognition failure returns `null`/falls
through; enabled-vs-disabled are result-equivalent in a committed test; an EXPLAIN/benchmark shows
material benefit." Six functions, six subtly different signatures, one unwritten interface. Promote
that prose contract into a **type**:

```ts
/** A recognized sub-shape lowered to specialized SQL, with the generic path as the fallback and
 *  semantic authority. ONE verb: select a lowering (or decline with null). NOT a Pass (it does not
 *  rewrite Steps) and NOT ChainFacts (it does not annotate) — the third sibling. */
interface FastPath {
  readonly name: string;                     // matches the FastPathConfig flag name
  /** Cheap structural gate. May read ChainFacts (e.g. movementCollapse → facts.collapseSafe) and
   *  the enable flag. Returns false → skip straight to the generic middle. */
  appliesWhen(ctx: FastPathContext): boolean;
  /** Try the specialized lowering. Returns the specialized Stream/LoweringResult, or `null` to
   *  fall through to the generic path. Recognition failure is ALWAYS null — never a throw, never
   *  a support boundary (the CLAUDE.md law). */
  tryLower(s: Stream, steps: PStep[], at: number, ctx: FastPathContext): LoweringResult | null;
  /** The equivalence obligation, as a machine-checkable reference: the name of the committed test
   *  proving enabled ≡ disabled. A FastPath with no `equivalentWhen` fails review — this field is
   *  the "prove it's result-equivalent" law turned into a required declaration. */
  readonly equivalentWhen: string;
}
```

### What migrates onto it

| Today | → `FastPath` | Gate (`appliesWhen`) |
|---|---|---|
| `predicateInlining` (`predicate.ts` → `compileCorrelatedChild`) | `PredicateInliningFastPath` | flag; predicate-shaped child |
| `scalarPredicateInlining` (scalar-parent gate) | `ScalarPredicateInliningFastPath` | flag; scalar parent |
| `singleHopOptional` | `SingleHopOptionalFastPath` | flag; `optional(single-hop)` |
| `bulkRepeatCount` (`bulk.ts` `tryBulkRepeat`) | `BulkRepeatCountFastPath` | flag; `repeat().times(n).count()` shape |
| `ftsSubstringPredicate` (`plan.ts`, gated at `has()`) | `FtsSubstringFastPath` | flag; ≥3-char positive substring over stored prop |
| `movementCollapse` (gated by `chainCollapseSafe`) | `MovementCollapseFastPath` | flag **and** `facts.collapseSafe` |

`FastPathConfig` stays as the **enable switches** (still per-compilation, still not a global —
locked), but the *dispatch* becomes: for a lowering site, walk the registered `FastPath`s whose
`appliesWhen` holds, take the first non-`null` `tryLower`, else the generic middle. The
`null`-fallthrough discipline is now the registry's contract, not six independent conventions.

### Why this is genuinely the "nice Rule" you liked — and why it is NOT a Pass

It is the same *quality* win (one declared shape, a reviewable contract, "add one = add a member")
— but the verb is **select a SQL lowering**, `(Stream, steps) → LoweringResult | null`, not
`Step[] → Step[]`. That is why it is its own registry: a `Pass` rewrites the IR *before* lowering;
a `FastPath` chooses *how* a lowering site emits SQL. Merging them would need a `run | tryLower`
union and every consumer would re-narrow it. Kept apart, each stays a clean single-verb Rule. This
is exactly Calcite's logical-rule / physical-conversion-rule split, at our scale.

### What stays out (honestly scoped)

- **No cost ranking.** A `FastPath` is `appliesWhen` → first-match, not cost-compared alternatives.
  SQLite's planner does physical optimization (locked). The registry is recognition + swap, nothing more.
- **`equivalentWhen` is a declaration, not a generator.** It names an existing committed test; it
  does not auto-derive one. It makes the obligation *visible and required*, so a FastPath landing
  without its equivalence test fails review structurally.

### FastPath equivalence

Pure refactor: the six recognizers keep their exact bodies (moved behind `tryLower`), the config
flags keep their meanings, and each already HAS its committed enabled-vs-disabled equivalence test
(that is why they qualified as fast paths). Only the dispatch shape changes. L2 + L3 unchanged.

---

## 6. What this buys (and what it deliberately does NOT change)

**Buys:**
- One answer to "where does a new rewrite go?" — a `Pass` in the right category — regardless of
  whether it came from `withStrategies(...)` or our own optimizer. The external/internal seam
  that `strategies.ts:39-47` apologizes for in a comment disappears.
- Pass ordering is *declared and testable*, not implicit in nesting depth + prose.
- Fail-closed rejection becomes a pipeline invariant (one place), not a ladder `else`.
- `ChainFacts` kills four independent re-scans and the `demandsEncounter`/`collapseSafe` drift risk.
- `FastPath` turns the prose fast-path qualification checklist into a required type (`equivalentWhen`
  makes "prove it's equivalent" a declaration a reviewer can check), and the six ad-hoc `try*`
  signatures into one dispatch contract.
- **Three clean single-verb Rules** (rewrite / annotate / select) — the "clean unification" is that
  each job has its own well-shaped abstraction, not that one abstraction does three jobs.
- The taxonomy maps onto TinkerPop's own category model, so a reader who knows TinkerPop reads our
  compiler faster — without us pretending to have JVM strategy classes we can't have.

**Does NOT change (locked, do not relitigate):**
- Compile-to-SQL, never interpret (decision #3). No pass evaluates anything at compile time
  beyond the pure IR rewrites that already exist.
- No cost-based optimizer. Passes are unconditional-or-`applies`-gated rewrites and FastPaths are
  first-match recognizers, NOT cost-ranked alternatives — SQLite's planner does physical
  optimization (the locked bet).
- The `Stream` shape union and the lowering Engine are untouched. This is purely the pre-lowering
  IR-rewrite + analysis layer plus a re-shaping of the existing fast-path *dispatch* (not the
  lowerings themselves).
- External strategy *semantics* are byte-for-result identical to `docs/2026-07-13`'s
  implementation — this reshapes the container, not the behavior.
- Fast-path *behavior* is identical: same recognizers, same enable flags, same generic fallback.
  Only the dispatch shape (registry vs scattered `try*` calls) changes.

---

## 7. Risks / open questions

1. **decoration-vs-fold ordering (§2, Stage 2).** The one place a naive migration could move
   output. Mitigation: the L2 snapshots are the oracle; if any moves, use a `decoration-early`
   category slot (the pipeline supports arbitrary category order — it's just the `PASSES` array
   assembly). Not a blocker, a decision the snapshots make.
2. **verify-against-original-chain.** `verify()` runs against the pre-injection chain today.
   The pipeline must preserve that (snapshot the chain before decoration, hand it to verify
   passes via `ctx`). Straightforward, but must be explicit or ReadOnly/etc. would verify the
   *injected* chain and could miss/misreport.
3. **`applies` gate cost.** Each pass's `applies` may re-scan the chain, reintroducing the
   O(passes·rescans) cost ChainFacts removes elsewhere. Mitigation: `applies` reads `ctx`
   (strategy names, cheap) or a shared `ChainFacts`; it must not do its own full walk when a
   fact already answers it. Keep `applies` O(1)-ish or fact-backed.
4. **`PStep` vs `Step` typing across the boundary.** Folds produce `PStep` (with `.cluster`/
   `.bys`/…); external injection produces bare `Step`. The pipeline runs on `PStep[]` throughout
   (a bare `Step` is a `PStep` with no optional fields), and `stepChain` is idempotent on a
   `Step[]` — so synthetic injected bodies flow through verbatim (already relied on by
   `recurseInject`). Verify this holds when injection is a mid-pipeline decoration pass, not a
   pre-pipeline step.
5. **`FastPath` dispatch cohesion.** Today the six `try*` calls sit at their natural lowering
   sites (`has()` for FTS, `compileRead` for bulk-repeat, the child seam for predicate inlining).
   The registry must not *centralize* dispatch to one place — a FastPath still fires at its own
   site; the registry gives them a shared *shape*, not a single call point (that would fight the
   family-local structure `CLAUDE.md` mandates). Open question: one registry filtered by site, or
   per-site sub-registries. Lean per-site (keeps the family-locality); decide when migrating.

---

## 8. Appendix — file-level change map

| File | Change |
|---|---|
| `src/compiler/ir/strategies.ts` | split into: `passes.ts` (the `Pass` contract + `PASSES` array + `runPasses`), keep the concrete fold/inject/verify functions here re-exported as Pass `run`s. The `NO_OP`/`VERIFICATION`/`ALWAYS_ON` Sets stay (now feed `applies`/`PassContext`). |
| `src/compiler/ir/analyze.ts` (new) | `interface ChainFacts` (data, no methods) + `analyze(steps) → ChainFacts`; absorbs `demandsEncounterOrder` (moved from strategies.ts) + `chainTracksPath`/`chainCollapseSafe` (moved from engine.ts). **`chainNeedsFromV` is NOT moved** — it stays a per-scope `carried.trackFromV` derivation (see §4). |
| `src/compiler/options/fast-paths.ts` | add the `FastPath` interface + the `FASTPATHS` registry; `FastPathConfig` stays as the enable-switch bag. |
| `src/steps/tail/bulk.ts`, `src/compiler/plan/plan.ts`, `src/steps/tail/correlated.ts`, `src/steps/prefix/filter.ts` | wrap the existing `tryBulkRepeat`/`ftsSubstringPredicate`/`compileCorrelatedChild`/scalar-predicate recognizers as `FastPath.tryLower` bodies (Stage 4). Bodies unchanged. |
| `src/compiler/engine/engine.ts` | Engine takes `ChainFacts`; `seedSource`/`compileRead`/the collapse gate read fields instead of calling scans. `chainTracksPath`/`chainCollapseSafe` deleted (moved to analyze.ts); **`chainNeedsFromV` and the engine.ts:325 per-scope `trackFromV` derivation stay.** `MovementCollapseFastPath.appliesWhen` reads `facts.collapseSafe`. |
| `src/compiler/compiler.ts` | `compilePlan` calls `runPasses` once (replacing `applyStrategies` + `normalize`), builds `ChainFacts` via `analyze`, passes it to the Engine. |
| `test/L2-sql/plumbing.sql.test.ts` (or a new `passes` test) | Stage 3 ordering-invariant test. |
| `docs/2026-07-13-with-strategies-exploration.md` | one-line status note: strategy application now lives in the unified pass pipeline (this doc). |
| `CLAUDE.md` | once landed: the fast-path prose contract now has a type (`FastPath.equivalentWhen`); update the "fast paths" paragraph to point at the interface. |
