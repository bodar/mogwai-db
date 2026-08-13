# src/compiler — architecture

_Scope: `src/compiler/**`. The algebra it lowers to is `src/rel/` (`docs/2026-08-01-relir-build-plan.md`);
the SQL kernel is `src/sql/CLAUDE.md`. Root `CLAUDE.md` holds cross-cutting rules._

`compile()` = `parse → runPasses → analyze → lower to RelIR → emit`. **There is ONE lowering.** The
second spine — `steps/`, `engine/`, the routing switch, `MOGWAI_RELIR` — is deleted; a traversal the
lowering does not cover raises `UnsupportedTraversal` rather than falling through to anything.

## Three roles, named plainly

Pre-lowering work splits three ways, and each has exactly one verb. Earlier comments numbered these
(`Seam 2`/`Seam 3`, `Layer A/B/C1/C2` — two incompatible schemes for one split, defined only in an
archived doc); the names below are the whole vocabulary.

| Role | Verb | Never | TinkerPop analogue |
|---|---|---|---|
| `Pass` (`ir/pass.ts`) | rewrites the chain, or verifies and throws | annotates, selects SQL | `TraversalStrategy` |
| `ChainFacts` (`ir/analyze.ts`) | annotates the chain | rewrites | `TraverserRequirement` aggregation |
| `FastPath` (`options/fast-paths.ts`) | a switch the lowering reads (collapse, property seek) | is the semantic authority | `ProviderOptimizationStrategy` |

Naming anything new in here follows the layered vocabulary in the root `CLAUDE.md` (**Naming**) —
these three names are that rule applied: the roles are compiler concepts, so they take compiler words,
while what they operate on keeps TinkerPop's.

## Guardrails

- **IR rewrites are Passes, not switches.** Every `Step[]→Step[]` rewrite is one `Pass` in the
  ordered pipeline (`ir/pass.ts`/`passes.ts`), categories `extract < decoration < canonicalize < simplify
  < verify`. Add a Pass; never grow a switch or do index arithmetic in a step compiler. Whole-chain
  facts (path/encounter/collapse-safety) are `analyzeChain()` annotations, not rewrites.
- **Dependencies vs state are separate — do not conflate.** Ambient capabilities (registry,
  fastPaths, federationDepth, the federation source) are DI, grouped by lifecycle into
  `AppScope`/`RequestScope` (`src/scopes.ts`); what a LOWERING receives is the settled VALUE the
  dependency produced, never the dependency (`RelRequest`). **There are TWO scopes, not three, and
  the missing one is deliberate:** what a single compile owns — its relation-id minter, its plan — is
  per-compile STATE, threaded explicitly. A compile scope only duplicated it into DI.
- **The lowering is a fold over `Step[]`, not an object graph.** `src/compiler/rel/lower.ts` is the
  fold; the shape-aware payload builders beside it (`element.ts`, `list.ts`, `map.ts`, `record.ts`,
  `path.ts`, `foreign.ts`, …) are pure functions it calls. What a lowering gets from the request is a
  RECORD of settled values (`RelRequest`, `rel/spine.ts`) — never an ambient capability, and never a
  recursive dispatcher to reach back through.
- **Fast paths are opt-in, never the semantic authority.** Two survive the single-spine cut and both
  are switches the lowering READS rather than a second lowering: `movementCollapse` (the grouped
  `SUM(bulk)` movement) and `propertySeek` (`src/rel/passes/seek.ts`, a physical rewrite over the
  finished algebra). Either position must compile the same traversal — turning one off may change the
  PLAN, never whether there is one — and L5's per-switch sweep is what checks that claim. No new
  switch without its differential + perf evidence in the same change.
- **Shape is CONSULTED, never CONSTRUCTED — the bright line.** Shape may be an annotation a Pass reads
  and may DECLINE on; it must never be a representation a Pass CONSTRUCTS or a lowering CONSUMES, and
  sharing across shapes is registration into a Map, never a widening fallback chain. This is a
  prohibition rather than a convention because of an asymmetry: a fail-closed lowering THROWS, but a
  declining decoration Pass is SILENT — a shape-guarded Pass that hits an unknown shape silently
  reproduces the original wrong answer, and L5's differential cannot see it (both configs decline
  identically). `elementKindAt` (`ir/step.ts`) is the shape of a correct consulter: it answers
  `vertex`/`edge`/**cannot-say**, the third answer is load-bearing, and it must not grow into a shape
  annotation. The only shape-specific rewrites that are correct anchor on
  `VERTEX_PRODUCERS`/`EDGE_PRODUCERS` (`ir/strategies.ts`) — step names whose output shape is fixed by
  the name alone; `order()`'s output shape is its input's, which is why injecting `has(key)` for a
  non-productive `by(key)` from a Pass broke every non-element `order().by(key)` form.
  **Do not re-propose, each refuted by measurement not argument:** (1) adding a shape field to the IR —
  ran as an experiment (`test/L5-properties/shape-annotation.test.ts`), far above its committed 10%
  kill bar, so the classifiers stay in the lowering; (2) a designed cross-layer shape *type* — targets
  ~6% of diagnosed defects while structurally blind to the 33% carried-field-at-a-barrier class, which
  is killed instead by channel obligations (`src/rel/obligations.ts`, `CHANNEL_GROUP_POLICY`); (3) a
  typed core IR — already LAW in `docs/2026-08-01-relir-build-plan.md` §2 (shape never enters the
  `src/rel/` node set). The shape vocabularies themselves landed as that plan's §6·3 three-layer
  boundary (row algebra → payload projection → byte framing). **The burden on any structural proposal
  here is a measurement, not a design sketch** — forward-reasoned "this needs a new substrate" has been
  falsified about a dozen times; the wins were reachability fixes and one measured vocabulary
  unification (`ScalarType`).
