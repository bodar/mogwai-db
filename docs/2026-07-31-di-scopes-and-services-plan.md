# Dependencies vs arguments: a request tier, and services in DI

**Status: in progress — steps 1-4 landed 2026-07-31, steps 5-6 outstanding (see §6).** Origin: phase 5 of
`2026-07-31-bulk-transfer-and-io-substrate-plan.md` needed `io().read()` to reach a `GraphStore` and an
`IoStore`, and the barrier contribution's signature had nowhere to put them. The first answer was to
widen the signature into a context object. **That was the wrong shape**, and noticing why turned a
one-signature question into a consolidation this doc scopes: the project already has a DI mechanism and
a stated rule for exactly this, and three places quietly work around it.

The rule, from `src/compiler/CLAUDE.md`, is already ours:

> **Dependencies vs state are separate — do not conflate.** Ambient capabilities … are DI, grouped by
> lifecycle into `AppScope`/`CompilerScope`. … Never put a dependency on `LoweringState` or thread it
> through signatures — add a scope field + an `Engine` accessor instead.

## 1. What the code says today

**a. The barrier signature is a hand-rolled copy of the scopes.**
`Contribution` (`services/spi/types.ts`) declares:

```ts
apply(rows: readonly ForeignRow[], params: CallParams, source: FederationSource, depth: number)
```

Of those four, `source` is **already in `AppScope`** and `depth` is **already in `CompilerScope`**
(`federationDepth`). Only `rows` is genuinely per-call. `params` is per-call but is *also* on
`ServiceCallCtx`, which the service already receives at `resolve` time — and `federate.ts` writes
`resolve: () => …`, ignoring its ctx entirely, which is *why* it needs everything positionally. Adding
`store` and `io` here would repeat the workaround twice more.

**b. `q` and `params` live in a scope AND in state.** `CompilerScope` holds `q`/`params`;
`LoweringState` (`compiler/steps/context/context.ts:185`) holds `q`/`params`/`sideEffects`/
`traverserLayout`. The same two values are a dependency and state at once, which is the conflation the
rule above forbids.

**c. There is no request tier, so the request-shaped fields are re-threaded by hand.**
`createCompilerScope` is called four times in `src/` — once for the root compile
(`compiler.ts:60`) and three times for nested sub-compiles (`engine/engine.ts:181,540,547`) — and every
nested call restates `params` and `federationDepth`. They are restated because there is nothing above
the compile tier to inherit them from. Meanwhile the HTTP/RPC edge mints no per-request object at all:
the router calls `manager.executor(id).framedAsync(gremlin, params)` and the values flow as arguments.

**d. Services have no construction-time dependencies.** `standardRegistry` / `extendedRegistry`
(`services/standard.ts:26-29`) are module-level CONSTANTS built from module-level service objects. A
service can therefore depend on nothing: everything it needs must arrive per call, which is (a)'s root
cause. Upstream does the opposite — `Service.ServiceFactory.createService(isStart, params)` is built by
the provider, so a Java service captures its graph access at construction and `execute(ctx, in, params)`
carries only per-call values.

## 2. The shape

**Three dependency tiers, and `LoweringState` keeps only state.**

| entry | tier | why |
|---|---|---|
| `registry` (services), `fastPaths`, `source`, `labelCardinality`, `io` | **App** — one per process/graph | `scopes.ts` already states the lifecycle: *"app scope is per-graph (one Executor, one store, one scope)"* |
| `params`, `federationDepth`, `sourceOptions` | **Request** — one per client request / federated hop | a hop to a sibling graph IS a new request, with its own params and depth |
| `store` | **Request** (executor-minted, see §4) | per-graph by lifetime, but placed by *visibility* |
| `q`, `traverserLayout`, `sideEffects` | **not a scope — `LoweringState`** | per-compile mutable accumulation, already threaded as state |

So `CompilerScope` → `RequestScope` is **not a rename**: three fields move up into a tier that does not
exist yet, and `q` moves out (down into the state it is already in). Whether the compile tier vanishes
entirely depends on one check the implementation must make first: **does anything read `scope.q`?**
`engine.ts` passes `q` *into* `createCompilerScope`, so something does — if that reader can take the
`Query` from the `LoweringState` it already holds, the tier goes; if not, a two-field compile scope stays
and the split is App → Request → Compile.

**Services become scope entries.** `createRegistry([...])` becomes a function of the app scope, so
`federate` takes `source`, and the `io` service takes `io` + `store`, at construction. `Contribution`
then shrinks to what is genuinely per-call:

```ts
| { kind: 'stream';  build(ctx: ServiceCallCtx): Stream }
| { kind: 'barrier'; apply(rows: readonly ForeignRow[]): Promise<ForeignRow[]> }
```

with `params` reaching the service through the ctx it already gets (or staying an argument — see the
open question in §5). `ServiceCallCtx` loses `registry` (a dependency) and keeps only what a *call* is.

**And `ServiceCallCtx` should probably be renamed.** Upstream's `ServiceCallContext` is
`{traversal, step}` plus `generateTraverser`/`split`, documented for *"Barrier services that want to
produce their own Traversers that maintain path information"* — a need we do not have (we lower to SQL;
path rides in columns). Ours is a compile-time collaborator bag wearing that name, which is the trap the
root `CLAUDE.md` names: *"never copy a TinkerPop implementation name because an approximate analogue
exists."*

## 3. What this buys, beyond phase 5

- **`io()` needs no contract change at all** — it reads its dependencies like every other service.
- **A service can depend on another service** by naming it, instead of reaching through
  `ctx.registry.get(name)`.
- **Three re-threaded arguments disappear** from the nested-compile call sites.
- **One duplication resolves** (`q`/`params` in two places).

## 4. Constraints the implementation must respect

1. **The apparent registry↔scope cycle is fine BECAUSE `LazyMap` is lazy.** `AppScope` holds
   `registry`; the registry's members need the `AppScope`. `set('registry', (scope) => …)` resolves on
   first use, after the scope is fully declared. With eager construction this would be a real cycle.
2. **The `.set()` stays in the ENTRY POINTS, never in `scopes.ts`.** `src/services/CLAUDE.md`:
   *"Do not make the compiler core import the service impls."* `scopes.ts` may declare the `registry`
   TYPE (it already does); only `application.ts` / `bun/server.ts` / `cloudflare/worker.ts` / the L3 host
   may name `standard.ts`.
3. **`--list` must keep enumerating exactly the reference set.** The official `g_call` /
   `g_callXlistX` scenarios assert it, which is why `extendedRegistry` (with `mogwai.graph.federate`)
   is production-only and the conformance host takes the reference registry. An INTERNAL `io` service
   needs the same treatment as the directory service, which excludes itself from its own `list()`
   (`DIRECTORY_SERVICE_NAME`, `spi/types.ts`). Getting this wrong is a visible L3 regression, so it is
   the cheapest thing to check first.
4. **A service cycle fails at first use, not at compile.** Lazy resolution turns A→B→A into a stack
   overflow when the service is called. Nothing prevents it; a clear error would need a resolution guard.
5. **`store` placement is a visibility decision, not a lifetime one.** Its lifetime is per-graph
   (`AppScope`), but putting it there makes a store reachable from COMPILE-time code, which today is
   impossible because no compile-time type has the field. Keeping the property costs nothing if the
   store is minted by the executor into the request tier and `compile()` is handed app + compile only —
   enforced by the type, needing no new `mise run arch` rule. **Decided 2026-07-31: prefer that
   placement, and do not add a gate.** The risk of someone reading rows at compile time and
   interpreting in JS (locked decision #3's failure mode) is real but unlikely, and if it ever happens
   a gate can be added then — the interesting fact is that #3 does not *state* this boundary; the
   boundary is what keeps #3 self-enforcing.

## 5. Open questions, deliberately not answered here

- ~~**Does `params` stay an argument or move to the ctx?**~~ **Answered in step 2: the ctx.** Upstream
  keeps it an argument (`execute(ctx, in, params)`) because ITS service instance is shared across
  calls; ours is resolved per call site, so the argument was pure redundancy.
- ~~**Does the compile tier survive?**~~ **Answered in step 4: no.** Its only content was state the
  per-compile object already held.
- **Do the two param TIERS upstream has matter to us?** `createService(isStart, params)` (static —
  which service INSTANCE you get) vs `execute(…, params)` (per call). We collapse both into one map.
  The one place it brushes against us is `io("x.json").with(IO.reader, IO.graphson).read()`, where the
  reader choice is upstream a *static* param selecting the codec. Collapsing is simpler and probably
  right; recorded so the next reader knows it was a choice.

## 6. Sequencing

This is a **behaviour-preserving refactor**: no traversal changes its answer, so the census
(`mise run census`) is the gate that matters, alongside `mise run ci`. Suggested order, each landing green:

1. ~~`--list` check (constraint 3) — cheapest, and it bounds what an internal service may be called.~~
   **Landed.** The check found the exclusion was a NAME comparison in the registry mechanism
   (`s.name !== DIRECTORY_SERVICE_NAME`), so an internal service was not merely unbuilt, it was
   unexpressible without another special case. It is now `Service.internal`, a flag on the service
   that owns the decision, and the reference surface is asserted as a SET (`standardRegistry.list()`
   ≡ {`tinker.search`, `tinker.degree.centrality`}) rather than implied — so a later internal service
   that forgets the flag fails a unit test instead of an L3 scenario. Answer to "what may an internal
   service be called": anything. The name carries no policy now.
2. ~~Services as scope entries; `Contribution.apply` shrinks; `federate` stops taking `source`/`depth`
   positionally.~~ **Landed.** `RegistryProvider = (app: AppScope) => ServiceRegistry` (`scopes.ts`);
   `createFederateService(source)` + `createDirectoryService(app)`; `apply(rows)`; `federationDepth`
   joins `ServiceCallCtx`, `registry` leaves it. §5's first open question is answered by the code:
   **`params` moved to the ctx** — `resolve` already received it, so keeping it an argument as well
   would have been the redundancy, and upstream's reason for the argument (a service instance shared
   across calls) does not apply when `resolve` runs per call site.
   One thing the plan did not predict: yadic types a `.set()` provider against the scope built SO
   FAR, so a provider needing the whole `AppScope` (the directory needs `registry`) does not
   typecheck against it. `createAppScope` therefore names the scope and closes over it
   (`const app: AppScope = ….set('registry', () => provider(app))`) — the laziness constraint 1
   relies on, made explicit rather than cast away. Two dead things fell out: `MidBarrierPoint.registry`
   (nothing read it) and `Executor.source` as a field.
3. ~~The request tier: `CompilerScope` → `RequestScope`, `params`/`federationDepth`/`sourceOptions` move
   up, nested compiles stop restating them.~~ **Landed**, as an App → Request → Compile split rather
   than a two-tier one (see step 4 for why the compile tier survived this step). `RequestScope` holds
   params/federationDepth/sourceOptions; `CompilerScope` holds `q`; the engine holds the request scope
   so `child`/`subEngine`/`withQuery` restate nothing.
   **The restating was hiding a bug**: no nested `createCompilerScope` call passed `sourceOptions`, so
   it reset to an empty Map and a sub-compile computed a different `labelRegime` than its own root —
   `g.with(multi/single-label)` never reached nested lowering. Inheritance fixes it; census unmoved,
   so nothing in the corpus was relying on the reset.
   One field did NOT simply move up: `params` stays OVERRIDABLE on the compiler scope, because
   `compileInject` seeds its own source and lowers against an empty param table. The plan's table put
   `params` in the request tier without noticing that; the difference that matters is that an absent
   override now INHERITS instead of resetting to `{}`, which is what a mandatory argument did.
4. ~~`q` out of the scope (or a two-field compile tier), resolving the `LoweringState` duplication.~~
   **Landed, and the compile tier VANISHED** — §2's check resolved the second way round. The one
   reader of `scope.q` is the `LoweringEngine`, which copies it into a field and attaches itself to
   it; with the request tier underneath, the compile scope held that Query plus inject()'s params
   override and nothing else. Both are per-compile STATE the engine already owns and publishes, so
   the tier is not two fields, it is zero: `new LoweringEngine(request, { q?, params?, fastPaths? })`.
   The split is **App → Request**, and `src/compiler/CLAUDE.md` now says so, with the reason a third
   scope is not coming back.
5. `ServiceCallCtx` renamed to whatever it actually is.
6. **Then** phase 5 of the bulk-transfer plan lands on top: `IoStore` in `AppScope`, an `io` service
   reading it, `io()` desugaring to a `call()`.

Steps 1–2 alone unblock phase 5; 3–5 are the consolidation that makes it not a workaround.
