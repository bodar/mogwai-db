# Directory restructure — mirror the compiler's real hierarchy

**Status:** planned (2026-07-23). A large, intentional refactor. No behaviour change; the
L1/L3/L4 gates and L2 semantic-equivalence must hold at every landing point.

## Goal & principles

Reshape `src/` and `test/` so the **directory structure maps to the actual functional
hierarchy** of the compiler (ship → engine-room → engine → cylinder). Concretely:

- A package should mostly import **from within itself**. Lift a folder out and only a few
  imports would need changing.
- Group by **domain concept**, never by file-type/arbitrary bucket.
- Names come from the **existing code vocabulary** (Stream shapes, step families, the `q`
  kernel, the IR Step chain, strategies, fast-paths, services/call(), writes, the wire/edge/
  store tiers, Bun/Cloudflare adapters). No invented names.
- Prefer **deeper nesting** wherever it introduces no import cycle. Smaller, independent
  files. **But no solo-file directories** — a directory earns its existence with ≥2 cohesive
  files.
- Tests mirror the source split 1:1 where it makes sense.

## The one hard constraint: the compiler-engine cycle

`src/steps/` is a **mesh, not a stack**. There is a real strongly-connected component:

```
steps/index.ts  ⇄  steps/child.ts  ⇄  steps/projection.ts
```

plus one-directional back-edges into `index.ts`:

| Caller | pulls from index.ts |
| --- | --- |
| child.ts | lowerElementSteps, lowerStepsStrict, tryLowerElementSteps |
| match.ts | lowerElementSteps |
| correlated.ts | lowerElementSteps |
| inject.ts | lowerStepsStrict |
| bulk.ts | buildPrefix |
| list.ts | compileReadCompiled |
| write.ts | buildPrefix, compileReadCompiled |

`index.ts` is two things: a **barrel** (`export { compileTail }` + the fact everyone imports
the dispatcher through it) and the **dispatcher engine** (the `PREFIX` table,
`lowerElementSteps`/`lowerSteps`/`lowerStepsStrict`/`buildPrefix`/`compileRead`/
`compileReadCompiled`, `seedSource`/`seedUnion`, `chainCollapseSafe`).

`child.ts` (1738 lines) and `projection.ts` (1018 lines) **stay whole** — splitting them by
parent-shape recreates the "second movement/filter/projection implementation" the extension
law forbids.

### The fix: a `LowerEngine` seam carried on the existing `Carry` channel

The 5 recursive functions become an interface:

```ts
interface LowerEngine {
  lowerElementSteps(steps, seed, from?): { stream: ElementStream; next: number };
  tryLowerElementSteps(steps, seed): ElementStream | null;
  lowerSteps(initial, steps, from): Stream | LoweringSuspension;
  lowerStepsStrict(initial, steps, from): Stream;
  buildPrefix(steps, params, query, sackInit?, fastPaths?, wantsEncounter?, registry?): { st; stop };
}
```

**Wiring — the key decision.** The compiler already has a per-compilation DI seam: `registry`,
`fastPaths`, and `federationDepth` ride on `CompileOptions` and are threaded onto every
`Stream` via `Carry` (the `{...st}` spread every StepFn does). **The `LowerEngine` rides the
same channel** — it is added to `Carry` beside `registry`/`fastPaths`.

- **Deep recursive callers** (`child`, `match`, `correlated`, `inject`, `projection`) always
  hold a `Stream`/`Carry` at their call sites → they call `carry.engine.lowerElementSteps(…)`.
  Verified: every one of the ~20 deep call sites has a stream in hand.
- **Seed-level callers** (`bulk`, `write`, `list` — they *build* a fresh prefix from steps,
  no stream yet) take the engine as an argument, exactly like they already take
  `params`/`query`/`registry`.
- `root.ts` (`compileRead`) seeds `carry.engine` once when it builds the initial stream; it
  propagates for free thereafter.

**Why not the alternatives.** A mutable module-level `installLowerEngine`/`getLowerEngine`
global (both architects' first instinct) conflicts with the codebase's own "never a mutable
global" rule for fast-paths. `@bodar/yadic` (used in `application.ts`) is the right tool at the
**app/HTTP tier** (request-lifetime, runtime-selected `GraphManager`) but the wrong altitude
here — the engine cycle is a compile-time module-graph problem inside the per-query hot path;
a `LazyMap` lookup through thousands of recursive `lowerElementSteps` calls is cost with no
benefit. The `Carry` channel is the project's *native* compiler-DI idiom and already proven.

**Why this is a DAG.** `child.ts` (and peers) import only the `LowerEngine` *type* (from the
substrate layer, a leaf) and read the concrete engine off the `Carry` they already receive.
Nothing they import points back at the dispatcher module. `root.ts` imports the concrete
prefix/lower functions and seeds them onto the carry — and nothing imports `root.ts` except
`compiler.ts`, an outer caller. Topological order: substrate → families → prefix/lower →
root → compiler. No cycle.

### `index.ts` dissolves into three files

Removing the barrel means the dispatcher moves into real, domain-named modules (more testable
than one big `engine.ts`):

- **`prefix.ts`** — the `PREFIX` dispatch table, `lowerElementSteps`/`tryLowerElementSteps`/
  `buildPrefix`, `seedSource`/`seedUnion`, `chainCollapseSafe` + its `COLLAPSE_*` sets, the
  `isSackMutate`/`isSideEffectGroup`/`isShapedLocal` guards, `PATH_STEPS`/`chainTracksPath`/
  `chainNeedsFromV`.
- **`lower.ts`** — the shape-dispatch loop (`lowerStream`/`lowerSteps`/`lowerStepsStrict`,
  `dispatchAlias`/`isAliasStep`/`isValueShape`) + the `LowerEngine` **interface** definition.
- **`root.ts`** — `compileRead`/`compileReadCompiled`, `segmentFromBarrier`/
  `segmentFromMidBarrier`, and the wiring that seeds the concrete engine onto the carry.

## Target `src/` tree

```
src/
  sql/
    kernel/
      q.ts                # q/Relation/list/empty/derived/render — ZERO imports (the leaf)
      query.ts            # the Query CTE-accumulator class (split from q.ts — optional, only if clean)
      render.ts           # Compiled/Shape/WritePlan + readCompiled/renderFrom
    schema.ts             # nodes/edges/labels/vertexProperties/edgeProperties/propertyFts

  gremlin/
    types.ts              # (was gremlin-types.ts) TypeNode/ValueNode/BigDecimal/Duration/coercions
    frontend.ts           # parseGremlin/stepChain/extract* — Step[] IR
    math.ts               # mathToSql/mathVars (frontend micro-DSL for math()/format())
    # NOTE: the generated parser/ stays where it is (generated, never edited).

  compiler/
    ir/
      strategies.ts       # PStep + Step[]→Step[] normalization (Seam 3)
    options/
      fast-paths.ts       # FastPathConfig/CompileOptions/resolve* — carries registry+engine DI
    plan/
      plan.ts             # the read seam (hasProp/scalarProp/framedProps/predicateSql/…)
    segment.ts            # SegmentPlan/FederationSource
    engine/
      prefix.ts           # PREFIX table + prefix fold + seedSource/seedUnion + chainCollapseSafe
      lower.ts            # shape-dispatch loop + the LowerEngine interface
      root.ts             # compileRead + segment plumbing + seeds the engine onto the carry
    compiler.ts           # parse → normalize → dispatch (imports engine/root.ts)

  steps/
    context/
      context.ts          # Carry/Carried/ElementStream/StepFn substrate (+ carries `engine`)
      alias.ts            # AliasShape/aliasId/… (as()/label bookkeeping)
      stream.ts           # the Stream union + LoweringResult/continuation/suspension
    prefix/               # the PREFIX StepFn families (movement/filter/branch/passthrough/…)
      movement.ts
      filter.ts
      predicate.ts        # predicateInlining fast path (a filter-family helper)
      branch.ts
      match.ts
      passthrough.ts
      sideeffect.ts
      sack.ts
    tail/                 # the re-enterable tail: shape retyping, child seam, projection
      projection.ts       # compileTail dispatcher + compileFromScalar (stays whole)
      child.ts            # the parent-polymorphic child seam (stays whole)
      scalar.ts
      variant.ts
      barrier.ts
      list.ts
      group.ts
      select.ts
      labelselect.ts
      mapscalar.ts
      modulation.ts
      coerce.ts
      correlated.ts       # the correlated fast-path middle
      bulk.ts             # tryBulkRepeat fast path
      materialize.ts      # the one root materialization boundary
      foreign.ts
      call.ts
      call-head.ts
    write/
      write.ts            # addV/addE/mergeV/mergeE/drop/property + routeWrite
      inject.ts           # compileInject (a source constructor routed via write)
    injection.ts          # INJECT_VALUES_KEY marker (steps-only vocabulary)

  services/
    spi/
      types.ts            # Service/Contribution/ServiceCallCtx/CallSpec + DIRECTORY_SERVICE_NAME
      registry.ts         # createRegistry/EMPTY_REGISTRY
    params/               # call() argument PARSING (a frontend concern, not a Service)
      call-params.ts
      traversal-param.ts
      federation-depth.ts
    catalog/              # the real callable Services
      directory.ts        # --list
      search.ts           # tinker.search
      degree-centrality.ts# tinker.degree.centrality
      federate.ts         # mogwai.graph.federate (barrier)
    standard.ts           # standardRegistry/extendedRegistry (DI composition; imports catalog/*)
    fts-index.ts          # FTS5 write-path indexer (NOT a Service — kept here; low-value to move)

  # --- the outer tiers stay at src/ root (already a clean foundation→edge layering) ---
  storage.ts              # GraphStore over the Sql interface
  execute.ts              # Executor: compile+run+frame
  api.ts                  # Sql/Executor/GraphManager/ForeignRow — the cross-layer contract (stays shallow)
  manager.ts              # GraphManager helpers
  serializers.ts          # registerExtendedSerializers (GraphBinary extensions)
  io.ts                   # ioc reuse (relative import into gremlin's binary serializers)
  wire.ts                 # parseRequest (request decode)
  http.ts                 # streamBuffers/errorResponse (response framing/pacing)
  router.ts               # makeRouter — the HTTP edge
  docs.ts                 # OpenAPI + /docs
  application.ts          # DI wiring via @bodar/yadic

  bun/
    BunSqlite.ts
    BunGraphManager.ts
    server.ts
  cloudflare/
    DurableObjectSqlite.ts
    graph-store-do.ts     # NEW — the DO class + ensureLive/destroy (split from worker.ts)
    cloudflare-graph-manager.ts  # NEW — the GraphManager adapter (split from worker.ts)
    worker.ts             # thinned to the fetch entry point (matches Bun's 3-file split)
```

Notes:
- **The outer tiers (`storage`/`execute`/`api`/`wire`/`http`/`router`/…) stay at `src/` root.**
  They already form a clean foundation→edge layering with no cycles; nesting them would add
  import churn for no cohesion gain. Deeper nesting is spent where it buys something: the
  compiler internals and services.
- **`injection.ts`** moves under `steps/` (it is steps-only vocabulary, imported by
  `steps/prefix/filter.ts` and `services/catalog/federate.ts`).
- **`fts-index.ts`** stays in `services/` — it has exactly 2 imports and no other `services/`
  file depends on it; moving it buys no DAG improvement. (Candidate for a future `write/`
  consolidation, not forced now.)
- The `q.ts` → `q.ts`+`query.ts` split is **optional polish** — only if it proves clean during
  the move; `q.ts` is the literal zero-import foundation, so touch it with care.

## Target `test/` tree

Ladder (`L1-corpus/`, `L3-conformance/`, `L4-addendum/`) + `fixtures/` + `support/` **stay
put** (locked by CLAUDE.md; the ladder organizes by conformance level, not domain). Only the
two monoliths split, along the step-family taxonomy already present in their banner comments;
they pair 1:1 (SQL-shape twin ↔ execution-semantics twin), so split along identical boundaries.

```
test/
  L1-corpus/            # unchanged
  L3-conformance/       # unchanged
  L4-addendum/          # unchanged
  fixtures/             # unchanged (shared L3+L4 seeds)
  support/executor.ts   # unchanged (shared exec fixture)
  contract.ts           # unchanged

  L2-sql/               # was one 2869-line file → split by step family, mirroring steps/
    movement.sql.test.ts
    filter.sql.test.ts        # has/where/dedup/simplePath + is/where/not/TextP
    branch.sql.test.ts        # union/optional/choose/coalesce + and/or
    repeat-path.sql.test.ts   # repeat/times/emit + path (linear + recursive JSONB regimes)
    group.sql.test.ts         # group/groupCount + nested by()
    scalar.sql.test.ts        # scalar-parent projection/math/format/split/choose
    call.sql.test.ts          # call()/service snapshots
    write.sql.test.ts         # addV/addE/mergeV/mergeE/drop
    plumbing.sql.test.ts      # stream physical schema, CTE/derived-table shape, bulking

  compiler/             # was root compiler.test.ts (2393 lines) — split 1:1 with L2-sql above
    scalar-branch.exec.test.ts
    scalar-math-format.exec.test.ts
    scalar-resource.exec.test.ts
    scalar-split-tail.exec.test.ts
    child-scope.exec.test.ts
    scalar-project-choose.exec.test.ts
    unified-lowering.exec.test.ts   # the big "unified lowering characterization" block
    writes.exec.test.ts
    repeat-path.exec.test.ts
    typed-properties.exec.test.ts

  # root single-file domain tests — already named by concept, NOT wrapped in solo dirs:
  wire.test.ts  streaming.test.ts  serializers.test.ts  exact-values.test.ts
  typed-collections.test.ts  typed-collections-e2e.test.ts  performance.test.ts
  services.test.ts  federation.test.ts  foreign.test.ts  fts-index.test.ts
  bun.test.ts  cloudflare.test.ts
```

The exact per-file section allocation for the two splits is decided when the files are opened
(the banner comments are the guide); the boundaries above are the intended shape.

## Self-containment (the "lift a folder out" test)

- `sql/` — imports nothing upward (`q.ts` has zero imports; `schema`/`render` import only `q`).
- `gremlin/` — imports only the generated parser + itself.
- `compiler/` — imports `sql/`, `gremlin/`, `steps/`, `services/spi` (types).
- `steps/` — 27 of 28 files import only other `steps/*` + the foundation (`sql`/`compiler/plan`/
  `compiler/ir`/`compiler/options`/`gremlin`); the only cross-edges to `services/` are the SPI
  **types** and `EMPTY_REGISTRY` (thin, documented, load-bearing — not accidental coupling).
- `services/` — imports *from* `steps/` (stream/context/child types) but nothing in `steps/`
  imports a concrete service; this one-directional edge is why `services/spi/types.ts` is placed
  to avoid a cycle, and it stays one-directional.

## Migration order (CI green at every landing point; stages are NOT locked)

`mise run ci` is the gate. Run `mise run L1 L2` for fast feedback during a stage; full
`mise run test` (adds L3/L4) before closing one. Fold stages together wherever splitting causes
churn (a half-moved set of mutually-referencing files won't compile — move those atomically).

1. **Break the cycle in place (highest risk, cheapest to verify — no files moved yet).**
   Add the `engine` field to `Carry`. Change the deep recursive callers to read
   `carry.engine.*`; give the seed-level callers (`bulk`/`write`/`list`) an engine argument.
   `compileRead` seeds `carry.engine`. `steps/index.ts` still exists and still exports the
   concrete functions (now assigned into the seeded engine object). **Verify the full suite
   green here** — this is the one behaviour-relevant change, and with no files moved a
   regression is unambiguously attributable to the seam.
2. **Foundation:** `q`/`render`/`schema` → `sql/`. Pure path-rename (q.ts has zero imports).
3. **Front-end:** `gremlin-types`/`frontend`/`math` → `gremlin/`.
4. **Compiler leaves:** `strategies`/`fast-paths`/`plan`/`segment` → `compiler/{ir,options,plan}`.
5. **Services SPI + params:** `types`/`registry` → `services/spi/`; `call-params`/
   `traversal-param`/`federation-depth` → `services/params/`.
6. **Steps substrate + leaves (atomic):** `context`/`alias`/`stream` → `steps/context/`;
   the pure-leaf families → `steps/prefix/` and `steps/tail/`.
7. **The former-cycle members + remaining tail (atomic):** `child`/`projection`/`scalar`/
   `variant`/`barrier`/`list`/`group`/`select`/`labelselect`/`mapscalar`/`correlated`/`bulk`/
   `foreign`/`call`/`call-head`/`materialize` → `steps/tail/`; `write`/`inject` → `steps/write/`.
8. **Dissolve `index.ts`** → `compiler/engine/{prefix,lower,root}.ts`; delete the barrel; point
   `compiler.ts` at `engine/root.ts`. (Fold with step 7 if that reduces churn.)
9. **Services catalog:** `directory`/`search`/`degree-centrality`/`federate` → `services/catalog/`.
10. **Cloudflare worker split** into 3 files (independent; validate against `cloudflare.test.ts`).
11. **Test split** (last, against stable `src/` paths): extract one `describe`/section per file,
    delete from the monolith, run the level, repeat — suite stays green after each extraction.
12. **Docs:** update `CLAUDE.md` file-path references (`src/steps/*` → new homes; document the
    `LowerEngine` seam beside the "Compiler extension law"), `docs/feature-support-matrix.md`,
    and any other `docs/` reference to old paths.

Steps 2–10 are pure mechanical path renames (no behaviour change — step 1 already did and
verified the only semantic change). Step 11 is test-only churn.
```
