# src/compiler — architecture

_Scope: `src/compiler/**`. The lowering surface it dispatches to is `src/compiler/steps/CLAUDE.md`; the SQL
kernel is `src/sql/CLAUDE.md`. Root `CLAUDE.md` holds cross-cutting rules._

`compile()` = `parse → runPasses → analyze → dispatch`. Detailed rationale (both landed, archived):
`docs/archive/2026-07-24-unified-rewrite-passes-plan.md` and
`docs/archive/2026-07-23-directory-restructure-plan.md`.

## Three roles, named plainly

Pre-lowering work splits three ways, and each has exactly one verb. Earlier comments numbered these
(`Seam 2`/`Seam 3`, `Layer A/B/C1/C2` — two incompatible schemes for one split, defined only in an
archived doc); the names below are the whole vocabulary.

| Role | Verb | Never | TinkerPop analogue |
|---|---|---|---|
| `Pass` (`ir/pass.ts`) | rewrites the chain, or verifies and throws | annotates, selects SQL | `TraversalStrategy` |
| `ChainFacts` (`ir/analyze.ts`) | annotates the chain | rewrites | `TraverserRequirement` aggregation |
| `FastPath` (`options/fast-paths.ts`) | lowers a recognized sub-shape to **specialized** SQL | is the semantic authority | `ProviderOptimizationStrategy` |

Naming anything new in here follows the layered vocabulary in the root `CLAUDE.md` (**Naming**) —
these three names are that rule applied: the roles are compiler concepts, so they take compiler words,
while what they operate on keeps TinkerPop's.

## Guardrails

- **IR rewrites are Passes, not switches.** Every `Step[]→Step[]` rewrite is one `Pass` in the
  ordered pipeline (`ir/pass.ts`/`passes.ts`), categories `extract < decoration < canonicalize < simplify
  < verify`. Add a Pass; never grow a switch or do index arithmetic in a step compiler. Whole-chain
  facts (path/encounter/collapse-safety) are `analyzeChain()` annotations, not rewrites.
- **Dependencies vs state are separate — do not conflate.** Ambient capabilities (registry,
  fastPaths, federationDepth, the lowering engine, the store source) are DI, grouped by lifecycle
  into `AppScope`/`RequestScope` (`src/scopes.ts`). `LoweringState` is PURE per-query state (q/params/
  traverserLayout/sideEffects). Never put a dependency on `LoweringState` or thread it through signatures — add a
  scope field + an `Engine` accessor instead.
  **There are TWO scopes, not three, and the missing one is deliberate:** what a single compile owns
  (its fresh CTE `Query`, and inject()'s empty-param-table override) is per-compile STATE, held by
  the one-per-compile `LoweringEngine`. A compile scope only duplicated `q` into DI. Rationale:
  `docs/2026-07-31-di-scopes-and-services-plan.md`.
- **One engine, families are free functions.** The `LoweringEngine` (`engine/engine.ts`) holds the
  recursive surface; step families reach it via `engineOf(stream)` and import only the leaf
  interface `engine/deps.ts`. This one-way DAG (deps ◂ families ◂ engine ◂ compiler) is what keeps
  the imports cycle-free — a per-concern compiler *object* was evaluated and rejected as net churn.
- **Fast paths are opt-in, never the semantic authority.** Each is one `FastPath` object in
  `options/fast-paths.ts`, fired family-locally. A specialized lowering qualifies ONLY if disabling
  it compiles the same traversal generically, recognition-failure falls through (never throws), and
  a committed enabled≡disabled equivalence test exists. No new fast path without that test + perf
  evidence in the same change.
