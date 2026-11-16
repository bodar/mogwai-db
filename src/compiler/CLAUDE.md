# src/compiler — architecture

_Scope: `src/compiler/**`. The algebra it lowers to is `src/rel/` (`docs/archive/2026-08-01-relir-build-plan.md`);
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
- **The lowering is a fold over `Step[]`, not an object graph.** The `src/compiler/rel/lower/` module
  is the fold — `lower.ts` holds the fold core (the shape tails, `continueAs`, assembly and the
  `lower*` entry points), and the cohesive clusters live beside it as `lower/{chain,movement,slice,
  filter,reduction,branch}.ts` (shared vocabulary; physical movement; slice/row algebra; the
  filter/predicate family; child/correlated reduction; branch/merge). The shape-aware payload builders
  a level up (`element.ts`, `list.ts`, `map.ts`, `record.ts`, `path.ts`, `foreign.ts`, …) are pure
  functions it calls. The `lower/` family is mutually recursive (a tail calls `continueAs` which
  re-dispatches into a cluster which calls back), so it uses function-level import cycles WITHIN the
  family by design — the clean-DAG rule holds at the family boundary, not inside it. What a lowering
  gets from the request is a RECORD of settled values (`RelRequest`, `rel/spine.ts`) — never an
  ambient capability, and never a recursive dispatcher to reach back through.
- **A whole-tree question is a predicate handed to `ir/walk.ts`, never a private walk.** A step's
  children sit in `args` (through predicate operands, lists, sets, map keys AND values), `by()`
  modulators, `with()` options and the folded `repeatRegion`/`optionArms`; `eachChildChain` enumerates
  them once, and `someStepDeep`/`eachChainDeep`/`eachStepDeep` are built on it. Every private copy
  missed a different position (a write inside `order().by(…)` leaked an internal error). What an
  UNREADABLE body means — skip, or fail closed — is the caller's argument, never the walker's choice;
  so is WHICH positions a walk enters (`ChildPositions`): `'all'` for every whole-tree question,
  `'arguments'` only for a consumer that can act on nothing but a step's own source text (federate's
  injection rewrite — consulting a folded `by()` there turned a decline into a bare `Error`).
- **Fast paths are opt-in, never the semantic authority.** Two survive the single-spine cut and both
  are switches the lowering READS rather than a second lowering: `movementCollapse` (the grouped
  `SUM(bulk)` movement) and `propertySeek` (`src/rel/passes/semijoin.ts`, a physical rewrite over the
  finished algebra — the same pass hosts the trigram `ftsSubstringPredicate` seek as a second
  access-path strategy). Either position must compile the same traversal — turning one off may change the
  PLAN, never whether there is one — and L5's per-switch sweep is what checks that claim. No new
  switch without its differential + perf evidence in the same change.
- **A child traversal lowers through the SCOPED-RELATION CONNECTOR — this is THE mechanism for nesting,
  and all new work goes through it.** `rel/lower/scoped.ts` scopes the host stream (any framing), lowers
  the body over ONE correlated host row through `continueAs` — the root's own fold, so every step the root
  lowers is automatically a step a body lowers — and reconnects it by the host's row in `CONNECTORS`
  (keyed by step name). Where SQL can hold the dependency the body stays correlated (an `EXISTS`, a
  correlated first-row scalar — SQLite has no hash join, so an index-seeking dependent join is the fast
  form); otherwise it is DECORRELATED (`src/rel/decorrelate.ts`, Neumann/Calcite
  `TopDownGeneralDecorrelator`: one rule per RelIR node kind, the scope key added to every grouping/
  window/limit, a scalar aggregate LEFT-joining the domain for its value over zero rows). This is what
  flattened the nesting-depth decline cliff (measured: `docs/2026-11-15-compositional-coverage-plan.md`
  G1/G2 and Phase 3) — composition comes from the ALGEBRA, not from enumerating routes. So:
  - **A new child-taking host is a `CONNECTORS` row** built from the shared reconnect primitives
    (existence join, `rejoin` under the `split`/`forward` traverser policy, arm priority, `by()` values
    landed as JOIN COLUMNS the host's own lowering reads through `childSeam`, a pool scoped by a GROUP key).
    The rows' host names are also `ir/analyze.ts` `CONNECTOR_HOSTS`; the two sets are checked equal at load.
    **Never** a new correlated route, ladder rung or `(host, body-shape)` branch — that is the pattern
    that produced ~890 decline sites and a 98% decline rate at depth 5.
  - **A body that does not lower is fixed in the body's lowering or in `decorrelate.ts`** (one rule per
    node kind), so the fix composes at every depth and under every host at once.
  - **The old ladder is the `correlatedChild` FastPath and it is SHRINKING.** A route survives only with
    a MEASURED win (`mise run scaling`, 1k/8k) weighed against its complexity; a complex route the
    connector replaces is deleted. Never extend it. Deleting a rung is scope worth taking. A deleted route's host
    joins `LADDERLESS` (`lower/scoped.ts`, so the dispatch offers no ladder there); every route still standing is
    in the plan's "Kept routes" catalogue with its margin, its sole-answer queries and the owner's call to make.
  - The two orders are each other's fallback at a site and `bothChildOrders` (`rel/spine.ts`) retries a
    declining compile in the other order, so the switch never decides coverage. A body that draws or
    re-sources stays the ladder's (`scopedBody`) until the connector owns it.
  - **Three CI guards hold this direction:** `mise run ladder` (the `return null` count in `rel/` never rises —
    the total, and per file for the ladder files; the connector's own `scoped.ts` is outside the total because
    L9 guards its reach by coverage, not by site count), and L9 (`test/L9-connector/`): the host-closure ratchet with the
    connector ALONE (`FastPathConfig.connectorOnly` — no ladder at any site, no retry) and host totality (a
    child-taking position is a `CONNECTORS` row or a `deferred-hosts.ts` entry with its reason and blocker).
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
  typed core IR — already LAW in `docs/archive/2026-08-01-relir-build-plan.md` §2 (shape never enters the
  `src/rel/` node set). The shape vocabularies themselves landed as that plan's §6·3 three-layer
  boundary (row algebra → payload projection → byte framing). **The burden on any structural proposal
  here is a measurement, not a design sketch** — forward-reasoned "this needs a new substrate" has been
  falsified about a dozen times; the wins were reachability fixes, one measured vocabulary
  unification (`ScalarType`), and the scoped-relation connector above — which is the model of how a
  structural change earns its place: an attribution instrument showed 94.5% of deep declines were ONE
  seam (G1), a switched spike showed the curve flatten with zero wrong answers (G2), then it was built
  out. Measure first; when the measurement says "one substrate", build the substrate.
