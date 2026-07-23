# Compiler rearchitecture — dependency objects + directory hierarchy

**Status:** planned (2026-07-23, revised). A large, intentional refactor in two movements:
first a **dependency/state separation** that turns the lowering core into dependency-injected
objects, then a **directory restructure** that mirrors the resulting hierarchy. No behaviour
change; the L1/L3/L4 gates and L2 semantic-equivalence hold at every landing point.

L3 passing floor (ratchet, must not drop): **1264**.

## Progress & resume protocol

Gate: `mise run ci` (check + test + build). Commit + push trunk after each green landing.
Auto mode: bigger-bang landings are fine (over-fragmenting hurts); worst case = revert.

- ✅ **Stage 0** — baseline green (750 pass), L3 floor 1264 recorded.
- ✅ **M1.1** (committed `5c2af31`) — DI scopes `src/scopes.ts`: `AppScope` (registry/fastPaths/
  source) + `CompilerScope` (q/params/federationDepth, child of app). Executor builds an app
  scope, passes it via `CompileOptions.app`; `compilePlan` mints a compiler scope. Required a
  **yadic parent-chaining fix** (bumped to `@bodar/yadic@0.495.349`): a child container now
  exposes inherited parent deps by DIRECT access. Guard: `test/scopes.test.ts`.
- ⏳ **M1.2+3** (in progress) — engine core → dependency-injected OBJECTS, one atomic landing:
  `Engine` (dispatcher: PREFIX + lower*/buildPrefix/compileRead) + family compilers
  (`ChildCompiler`/`TailCompiler`/`CallCompiler`/`WriteRouter`) as separate classes, each built
  from the compiler scope. Remove `fastPaths`/`registry`/`federationDepth`/`engine` from `Carry`
  (→ pure state: q/params/carried/sideEffects). Dissolve the `index.ts` barrel. Classes stay
  FLAT in `steps/` for now (M2 relocates). Dependency-read surface to migrate (verified):
  fastPaths at `movement.ts:17`, `filter.ts:152/163/217`, `projection.ts:940`, `branch.ts:243`,
  `scalar.ts:394`, `child.ts:1462`; registry/depth at `call.ts:127/154`; `carryOf`-style copies
  of fastPaths at `labelselect.ts:96`, `scalar.ts:520`, `variant.ts:79`, `stream.ts:346` (drop
  the field once off Carry). `src/steps/deps.ts` holds the `Engine`/`EngineDeps` interfaces.
- ⬜ **M2** — directory relocation (mechanical, deps no longer threaded): sql/ · gremlin/ ·
  compiler/{ir,options,plan,segment,engine} · services/{spi,params,catalog} ·
  steps/{context,prefix,tail,write} · cloudflare worker 3-way split · test monolith split ·
  docs (CLAUDE.md paths + DI/object-model section).

**To resume:** `git log --oneline -5` for the last landing; `git status` for uncommitted work;
`mise run L2` for the fastest red/green signal; this doc's stage list for what's next.

## Why this shape (the governing idea)

When DI was introduced to the *outer* compile (the `Executor` holding `registry`/`source` as
constructor dependencies, `execute.ts`), it immediately simplified things — because it
**separated real dependencies from per-call arguments**. This refactor pushes that separation
all the way down into the lowering core.

The core distinction:

- **Dependencies** — ambient capabilities fixed for a whole compilation: the service
  `registry`, the `fastPaths` config, the recursive-lowering engine itself, the store
  `source`, `federationDepth`. They do not vary per traverser, per step, or per stream shape.
- **State** — the actual per-query lowering state: `q` (the CTE accumulator), `params`,
  `carried` (aliases/path/sack/bulk/origins/encounter), `sideEffects`.

Today `Carry` conflates both, so every dependency is threaded through the state object *and*
through every function signature that builds a fresh stream (`correlated.ts`, `predicate.ts`,
`bulk.ts`, …). That threading is the pain. The fix:

> **Functions that need dependencies become objects that hold those dependencies as fields;
> their methods take only per-call arguments. Functions that need no dependencies stay pure
> free functions. `Carry` reverts to pure per-query state.**

Wiring is **yadic scoped containers** (`@bodar/yadic`, already the outer DI) — the container
*is* the typed dependency object for the next scope, so nothing is threaded.

## Principles for the directory shape (unchanged)

- A package should mostly import **from within itself**.
- Group by **domain concept**, never file-type/arbitrary bucket.
- Names from the **existing code vocabulary** (Stream shapes, step families, the `q` kernel,
  the IR Step chain, strategies, fast-paths, services/call(), writes, wire/edge/store tiers,
  Bun/Cloudflare adapters). No invented names.
- Prefer **deeper nesting** where it introduces no import cycle; smaller independent files;
  **no solo-file directories** (a directory earns its keep with ≥2 cohesive files).
- Tests mirror the source 1:1 where sensible; the L1/L3/L4 ladder + fixtures stay put.

---

## Movement 1 — dependency objects (the fundamental change)

### The three dependency lifecycles → three yadic scopes

`@bodar/yadic` `LazyMap.create(parent)` gives parent-child containers whose entries resolve
lazily (and cache as read-only on first access). Three tiers:

1. **App scope** — created once per process/runtime. Holds `registry` (which services exist),
   `fastPaths` (which optimizations are on), the store `source` (federation reach). This is
   where `application.ts` already lives; it grows these entries.
2. **Compile scope** — a child container created per `compile()` call, with the app container
   as its typed parent. Holds the per-compilation collaborators: `q` (a fresh `Query`),
   `params`, `federationDepth`, and — built here, closing over both scopes — the **lowering
   objects** (the engine and its family compilers).
3. **Per-step/traverser state** — NOT in a container. This is `carried`/`rel`/`elem`, passed
   as method arguments and folded/replaced as the compile proceeds.

Because container entries are lazy, the lowering objects can reference **each other** (the
engine needs the child-scope compiler; the child compiler needs the engine; projection needs
both) — each `.set('x', deps => new X(deps))` factory reads `deps.otherObject`, and the first
access resolves the graph. This is what dissolves the `index⇄child⇄projection` cycle: the
objects depend on each other **through the container**, wired once, lazily — there is no
source-level import cycle because each object imports only the *interfaces* it needs, and the
concrete graph is assembled in the compile-scope container.

### `Carry` becomes pure state

```ts
// steps/context.ts — after
export interface Carry {
  readonly q: Query;                 // the CTE accumulator (per-compilation collaborator)
  readonly params: Record<string, any>;
  readonly carried: Carried;         // per-traverser column schema
  readonly sideEffects?: SideEffectMap;
}
```

Gone from `Carry`: `fastPaths`, `registry`, `engine`, `federationDepth`. (`q`/`params` stay:
they are genuinely the query being lowered, and they're already on every stream; treating
them as ambient would be a larger churn for little gain. They are supplied by the compile-scope
container when the root stream is seeded, then ride the stream like today.)

### StepFns become methods on a per-compile `Lowerer`

The ~20 movement/filter/branch/passthrough StepFns read `fastPaths` (a dependency). They become
**methods on a `Lowerer` object** constructed with the compile-scope deps; the `PREFIX` dispatch
table maps a step name to a bound method:

```ts
// compiler/engine/lowerer.ts (illustrative)
class Lowerer {
  constructor(private readonly deps: CompileDeps) {}       // { fastPaths, registry, engine, q-factory… }
  // movement
  move(step: PStep, st: ElementStream): ElementStream { /* …this.deps.fastPaths… */ }
  toEdge(step: PStep, st: ElementStream): ElementStream { /* … */ }
  // filter
  has(step: PStep, st: ElementStream): ElementStream { /* … */ }
  where(step: PStep, st: ElementStream): ElementStream { /* …this.deps.engine.lowerElementSteps… */ }
  // …
  private readonly PREFIX = new Map<string, StepFn>([
    ['out', this.move], ['in', this.move], ['has', this.has], /* … */
  ]);
}
```

The recursive callers (`child`, `match`, `correlated`, `inject`, `projection`, `bulk`, `list`,
`write`) that today import `lowerElementSteps`/`buildPrefix`/… from `index.ts` instead call
`this.engine.lowerElementSteps(…)` on their injected engine reference — no import of the
dispatcher module, no parameter threading, no `Carry.engine`.

The genuinely **pure** files stay free functions (no object, no deps): the `q` kernel, most of
`plan.ts` (`predicateSql`/`hasProp`/`labelIn`/…), `context.ts`'s `carriedCols`/`carryFrag`/
`partitionOver`/`advance`, `alias.ts`, `coerce.ts`, `materialize.ts`'s pure framing,
`variant.ts`'s arm builders, `strategies.ts`, `frontend.ts`, `gremlin-types.ts`. They operate
only on their arguments, so they need no injection.

### What the objects are (first cut — refined during build)

Grouped by the family boundaries that already exist, each constructed with the deps it needs:

- **`Lowerer`** — the PREFIX StepFn methods (movement/filter/branch/passthrough/sack/
  sideeffect) + the `lowerElementSteps`/`lowerSteps`/`lowerStepsStrict` orchestration (was the
  bulk of `index.ts`). Needs `fastPaths`, `registry`, `q`, and a reference to the child-scope
  compiler + tail/projection compiler.
- **`ChildCompiler`** — the parent-polymorphic child seam (was `child.ts`). Needs the engine
  (to lower child bodies) + `fastPaths`.
- **`TailCompiler`** — the tail/projection dispatcher (was `projection.ts` + the shape
  compilers it routes to). Needs the engine + child compiler.
- **`CorrelatedCompiler`** — the correlated fast-path middle (was `correlated.ts` +
  `predicate.ts`). Needs the engine (it folds real StepFns in inline mode).
- **`CallCompiler`** — `call()` seeding/lowering (was `call.ts`/`call-head.ts`). Needs the
  registry + engine.
- **`WriteRouter`** — the write path (was `write.ts`/`inject.ts`). Needs the engine + the FTS
  indexer.

The exact object boundaries are confirmed as each family is converted (the guiding rule: an
object per cohesive family that shares a dependency set; do not over-fragment — `child.ts`/
`projection.ts` stay single cohesive units as established earlier).

### How this dissolves the cycle (the DAG proof)

Today: `index.ts → child.ts → index.ts` is a literal import cycle. After: `ChildCompiler`
imports the **`Engine` interface** (a leaf type); the concrete `Lowerer` (which *is* the
engine) is handed to `ChildCompiler` at construction, out of the compile-scope container. The
container's factories reference each other lazily. Source imports: `ChildCompiler` →
`Engine`-interface; `Lowerer` → `ChildCompiler`-interface + `TailCompiler`-interface; the
container module → all concrete classes. No class imports a class that imports it back — only
interfaces, which are leaves. Topological order: interfaces → concrete classes → container →
`compile()`. A DAG.

---

## Movement 2 — the directory tree (after the objects exist)

Once dependencies are injected rather than threaded, relocation is mechanical. Target:

```
src/
  sql/
    kernel/{q.ts, query.ts?, render.ts}   # q: zero-import leaf; query.ts split optional
    schema.ts
  gremlin/
    types.ts        # was gremlin-types.ts
    frontend.ts
    math.ts
  compiler/
    ir/strategies.ts
    options/fast-paths.ts       # FastPathConfig/CompileOptions/resolvers (the dep descriptors)
    plan/plan.ts                # the read seam (pure — stays free functions)
    segment.ts
    engine/
      engine.ts                 # the Engine interface (+ ChildCompiler/TailCompiler interfaces)
      lowerer.ts                # the Lowerer class: PREFIX methods + lower* orchestration
      container.ts              # the compile-scope yadic container: wires the objects
    compiler.ts                 # compile(): builds the compile-scope container, drives it
  steps/                        # the lowering-object implementations + pure step helpers
    context/{context.ts, alias.ts, stream.ts}
    prefix/{movement.ts, filter.ts, predicate.ts, branch.ts, match.ts, passthrough.ts, sideeffect.ts, sack.ts}
    tail/{projection.ts, child.ts, scalar.ts, variant.ts, barrier.ts, list.ts, group.ts,
          select.ts, labelselect.ts, mapscalar.ts, modulation.ts, coerce.ts, correlated.ts,
          bulk.ts, materialize.ts, foreign.ts, call.ts, call-head.ts}
    write/{write.ts, inject.ts}
    injection.ts
  services/
    spi/{types.ts, registry.ts}
    params/{call-params.ts, traversal-param.ts, federation-depth.ts}
    catalog/{directory.ts, search.ts, degree-centrality.ts, federate.ts}
    standard.ts
    fts-index.ts
  storage.ts  execute.ts  api.ts  manager.ts  serializers.ts  io.ts
  wire.ts  http.ts  router.ts  docs.ts  application.ts   # app-scope DI container lives here
  bun/{BunSqlite.ts, BunGraphManager.ts, server.ts}
  cloudflare/{DurableObjectSqlite.ts, graph-store-do.ts, cloudflare-graph-manager.ts, worker.ts}
```

(The exact home of the `Lowerer`/family classes — `compiler/engine/` vs `steps/` — is settled
during Movement 1: the *interfaces* and the container live in `compiler/engine/`; the family
*implementations* live under `steps/` beside the pure helpers they use. The precise split
falls out of which imports keep each package self-contained.)

### Tests

Ladder (L1/L3/L4) + `fixtures/` + `support/` stay put. The two monoliths split by the
step-family taxonomy already in their banner comments, pairing 1:1:
`test/L2-sql/{movement,filter,branch,repeat-path,group,scalar,call,write,plumbing}.sql.test.ts`
and `test/compiler/{…}.exec.test.ts`. Root single-file domain tests
(wire/streaming/serializers/services/federation/foreign/typed-collections/…) already named by
concept — left as single files, not wrapped in solo dirs.

---

## Migration order (CI green + trunk push at every landing point)

`mise run ci` is the gate. Stages are not locked — fold where splitting causes churn; the
object-conversion of a family + its cycle edge should land atomically.

**Movement 1 — object model, in place (files where they are today):**

1. **Introduce the compile-scope container + `Carry` slimming, engine interface first.** Define
   the `Engine`/`ChildCompiler`/`TailCompiler` interfaces. Build the compile-scope yadic
   container in `compiler.ts` (child of the app container that `execute.ts` already has via the
   Executor's `registry`). This is the highest-risk landing — verify the full suite green with
   the container wired but before removing the old threading, if that intermediate compiles.
2. **Convert the PREFIX StepFns to `Lowerer` methods**; move `lowerElementSteps`/`lowerSteps`/
   `lowerStepsStrict`/`buildPrefix`/`compileRead` onto/around the `Lowerer`. Drop the
   `index.ts` barrel. Recursive callers switch to `this.engine.*`.
3. **Convert the family compilers** (`ChildCompiler`, `TailCompiler`, `CorrelatedCompiler`,
   `CallCompiler`, `WriteRouter`) to objects taking their deps; remove `fastPaths`/`registry`/
   `engine`/`federationDepth` from `Carry`. Each family + its cycle edge lands atomically.
4. Full suite green; the compiler core is now dependency-injected with a pure `Carry`.

**Movement 2 — directory relocation (mechanical, deps no longer threaded):**

5. `sql/` (q/render/schema). 6. `gremlin/`. 7. `compiler/{ir,options,plan,segment,engine}`.
8. `services/{spi,params,catalog}`. 9. `steps/{context,prefix,tail,write}`. 10. Cloudflare
worker 3-way split. 11. Test monolith split. 12. Docs (CLAUDE.md paths + the DI/object-model
section; feature-support-matrix; docs refs).

Each Movement-2 stage is a pure path-rename (no behaviour change — Movement 1 did and verified
the semantic change). Commit + push trunk after each green landing.

---

## Open sub-decisions (resolve with code in hand, not up front)

- **`q`/`params` on `Carry` vs in the container.** Kept on `Carry` for now (genuine query
  state, already on every stream). Revisit only if it reads awkwardly once objects exist.
- **One `Lowerer` object vs per-family objects** (`MovementSteps`/`FilterSteps`/…). Start with
  the family grouping that matches the target directories; collapse or split as the shared
  dependency-set dictates.
- **`compiler/engine/` vs `steps/` home for the concrete classes.** Interfaces + container in
  `compiler/engine/`; implementations under `steps/`. Firm up when imports are drawn.
```
