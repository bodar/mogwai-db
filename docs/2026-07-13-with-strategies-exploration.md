# `withStrategies` / `withoutStrategies` — exploration & research

**Date:** 2026-07-13
**Status:** research → **partly IMPLEMENTED (2026-07-13, L3 495→543).** The analysis
below stands; the server-side program in Part V (SubgraphStrategy vertex-criterion,
PartitionStrategy read-filter + write-stamp, and the ReadOnly/EdgeLabel/ReservedKeys
verification strategies) has since landed as `applyStrategies` in `src/strategies.ts`
(spec extraction in `src/frontend.ts` `extractStrategies`; wired in `src/compiler.ts`).
Deferred tails (Subgraph edge/vertexProperty criteria + adjacency, Partition
meta-properties + merge, ProductiveBy, nested-body descent) fail closed with clear
errors. Client-side partition→DO routing (Part II) was explicitly out of scope and
is NOT built. This began as analysis to decide *whether*, *where* (client vs server),
and *in what order* strategy support should land.

**Reading order:** this sits alongside `docs/2026-07-12-conformance-structural-bets.md`
(bet #7) and `docs/2026-07-13-seam-reuse-audit.md`. It supersedes the *reasoning* in
bet #7's "Real-world: LOW-MEDIUM" paragraph (not the mechanics — those still hold).

---

## 0. Where things stand today (verified)

`withStrategies` / `withoutStrategies` are **not** IR steps. They're
`TraversalSourceSelfMethod_*` nodes intercepted at the raw parse tree by
`checkStrategies()` in `src/compiler.ts:50-65`, before any compilation:

- A **15-name optimization whitelist** (`SAFE_OPTIMIZATION_STRATEGIES`,
  `compiler.ts:42-48`) is accepted as a **pure no-op** — nothing is emitted, the call
  just doesn't throw. Correct-by-design: TinkerPop's own contract says these can't
  change the result set, and our SQL planner does its own optimization. Landed in
  `ad240df` (L3 474→495).
- **Everything else fails closed** with:
  > `withStrategies(...) is not supported: only result-preserving optimization
  > strategies are accepted (as no-ops); semantic strategies (e.g. PartitionStrategy,
  > SubgraphStrategy) would silently ignore the filtering they imply and leak
  > unfiltered data. Rejected to fail closed.`
- The `new`-constructor form (`new SubgraphStrategy(...)`) still fails closed — ANTLR's
  `getText()` drops whitespace to `newSubgraphStrategy`, which the regex matches as
  `SubgraphStrategy`, not on the whitelist.
- `with(...)` (the `OptionsStrategy` sugar, e.g. `g.with('x')`,
  `valueMap().with(WithOptions.tokens)`) is a **different** mechanism — a real
  `TraversalMethod_with` IR step, never seen by `checkStrategies`. It currently dies
  with the generic `step not implemented: with()` (`projection.ts:137`).

Test coverage: `test/compiler.test.ts:248-279` (semantic fail-closed; optimization
no-op accept).

---

## Part I — "DO routing already does partitioning" is a category error

### The presumption, quoted

`docs/2026-07-12-conformance-structural-bets.md:139-141`:
> `PartitionStrategy` = multi-tenancy *within one graph* — but mogwai already isolates
> tenants as **one Durable Object per graph**, so the main use case is covered
> structurally elsewhere.

and line 163-164:
> **Strategies** (#7) only when in-graph partitioning is an actual ask — the
> DO-per-tenant model already covers isolation.

### Why it's wrong — they operate at different levels

DO-per-tenant and `PartitionStrategy` are **not** two implementations of the same
feature. They're two *levels of a hierarchy*, and they compose:

| | Durable Object routing | `PartitionStrategy` |
|---|---|---|
| **Granularity** | one physical graph per tenant | logical sub-views *inside* one graph |
| **Selected by** | URL path `/g/{graphId}` (Worker) | `withStrategies(...)` in the traversal |
| **Isolation kind** | hard — separate SQLite, separate storage, separate CPU limit | soft — a filter predicate over shared rows |
| **Cross-partition traversal** | impossible (separate DOs; no shared edges) | **possible** — one query can read `readPartitions: [a, b]` |
| **Write target** | the DO you routed to | `writePartition` stamped as a property |
| **Who decides** | the platform / auth layer | the *application* issuing the traversal |

The presumption collapses the second column into the first. But the canonical
`PartitionStrategy` use cases are exactly the ones a single DO *cannot* express:

1. **Sub-tenancy within a tenant.** A tenant owns one graph (one DO). Inside it they
   want per-environment (`prod`/`staging`), per-region, or per-customer sub-partitions —
   with the ability to run a query that spans several (`readPartitions: [...]`) or writes
   to exactly one (`writePartition`). Separate DOs can't do the "span several" half:
   there are no cross-DO edges.
2. **Soft-delete / versioning / temporal views.** Stamp a partition, later flip which
   partitions are readable. Pure application-level, inside one graph.
3. **Overlapping visibility.** Reader A sees `[a]`, reader B sees `[a, b]`. Same graph,
   same edges, different windows. Not expressible as DOs at all — the same edge is
   visible to both.

So the honest statement is: **DO routing is the tenant boundary; `PartitionStrategy`
is an intra-graph filtering dimension. They're complementary.** The user's instinct is
correct. Two-and-a-half levels of hierarchy are actually available:

```
/g/{graphId}          →  DO            (hard tenant boundary,  platform-routed)
   └─ body `g` field  →  named graph   (a second select within a tenant; today ignored in prod)
        └─ partition   →  filter view   (PartitionStrategy / SubgraphStrategy, app-driven)
```

`SubgraphStrategy` is the same story but *predicate-defined* rather than
*label-defined*: a filtered view whose criterion is an arbitrary traversal
(`vertices: __.has("name", within(...))`). Also purely intra-graph, also impossible to
fake with DO routing.

### The one grain of truth

For the narrowest reading of "multi-tenancy" — *hard* isolation between unrelated
customers — the DO model genuinely is better than `PartitionStrategy` (isolation by
construction beats isolation by remembering to add a `WHERE`). That's real and worth
keeping. It just isn't the *whole* of what `PartitionStrategy` is for, and it says
nothing about `SubgraphStrategy`.

---

## Part II — How the DO-as-graph model meets the Gremlin driver, and can it route client-side?

### The URL is opaque to the driver — so DO routing "just works"

The v4 JS driver (`gremlin@4.0.0-beta.2`) takes the server URL as an **opaque string**
and passes it verbatim to `fetch()` (`connection.ts:168,182`). It imposes no path
scheme (no mandatory `/gremlin` suffix). Therefore a client pointed at
`https://host/g/mytenant` maps *directly* onto the Worker router
(`worker.ts:35` regex `^\/g\/([^/]+)\/?$` → `getByName("mytenant")`). The DO *is* the
server, as far as the driver is concerned. This is already the design and it is clean.

The body-level `g` (traversal-source name) field is **independent** of the URL path and
is deliberately ignored in production (`handler.ts:256-263,290`); it only selects among
named toy graphs in the dev cucumber harness.

### Strategies travel as literal text — server-parsed, not client-applied

Key wire fact (`gremlin-lang.ts:103-111,166-180`): `g.withStrategies(new
PartitionStrategy({...}))` is serialized into the submitted **gremlin string** as the
literal text `.withStrategies(new PartitionStrategy(partitionKey:'p',...))`. The
client-side `TraversalStrategy.apply()` is a no-op; the **server** is expected to parse
and honour it. So server-side is the *default* home for strategy semantics, and mogwai
already receives the text (it just rejects it).

### But there IS a client-side interception precedent: `OptionsStrategy`

The one exception (`driver-remote-connection.ts:59-98`): `OptionsStrategy` is **stripped
from the script client-side** and folded into per-request options (evaluationTimeout,
batchSize, materializeProperties, …). This is the exact pattern the brain-dump imagines
— a strategy intercepted before the wire and turned into request metadata.

### The client hooks that could reroute a request

`ConnectionOptions` exposes (`connection.ts:45-66,146-187`):

- **`interceptors`**: `RequestInterceptor = (HttpRequest) => HttpRequest | Promise<…>`,
  where `HttpRequest = { url, method, headers, body }`. Each runs before `fetch` and can
  **rewrite the URL** (reroute to a different DO / graphId), inject headers, or re-sign
  the body.
- **`headers`**: static extra headers.
- Auth (`auth.ts`) is *itself* just prebuilt interceptors (`basic`, `sigv4`). So the
  brain-dump's "the auth hooks you could use to reroute" is precisely right — auth and
  routing are the same hook.

### So: can a partition auto-map to a DO on the client? Yes, with one honest catch

The vision — "read the `PartitionStrategy` and route it to the matching DO" — is
buildable client-side, but note **what** it means and **where** the value lives:

- **Semantics differ.** Client-side "partition → DO path" gives you *hard* isolation
  (separate DO per partition, no cross-partition traversal). Server-side
  `PartitionStrategy` gives *soft* filtering (one graph, cross-partition reads allowed).
  These are the two columns of the Part I table again — offer both, they're different
  products, not two ways to the same result.
- **The catch:** by the time an `interceptor` sees `body`, the partition value is buried
  inside the GraphBinary-serialized gremlin string. Three clean ways out, none free:
  1. **A custom client strategy, `OptionsStrategy`-style.** Subclass/extend so a
     `RoutingPartitionStrategy` is intercepted *before* script generation (like
     `OptionsStrategy`) and its value pulled into `url`. Cleanest, but needs a client
     shim. **Upstream-first candidate:** propose a pluggable "pre-submit strategy hook"
     on the driver so partition→routing is a first-class client extension, not a fork.
     Small diff, generally useful, gives back. (Consistent with `UPSTREAM.md`.)
  2. **Out-of-band signal.** App sets the partition in a header or the URL path itself
     (`/g/{tenant}/{partition}`) rather than via `withStrategies`. Zero client magic;
     the Worker regex grows one segment. Least "TinkerPop-native", most robust.
  3. **Interceptor parses the body.** Possible, ugly, brittle (re-deserialize + regex
     the script). Not recommended.

**Recommendation for the client angle:** treat it as a *second, optional* transport for
partition-as-hard-isolation, built on `interceptors` (option 1 upstream, option 2 as the
pragmatic default). It must **not** be the only way — server-side `PartitionStrategy`
(soft filtering, cross-partition reads) is the semantically complete one and the only one
the conformance suite exercises.

---

## Part III — The strategy landscape: taxonomy, counts, complexity

### The full set (TinkerPop 4, 4 categories)

**Decoration (change results — must be honoured, not no-op'd):** PartitionStrategy,
SubgraphStrategy, OptionsStrategy, ConnectiveStrategy, ElementIdStrategy, EventStrategy
(JVM-only), HaltedTraverserStrategy, SeedStrategy, SackStrategy/SideEffectStrategy/
RequirementsStrategy (internal to `withSack`/`withSideEffect`).

**Optimization (result-preserving rewrites — safe to no-op in a SQL backend):**
IdentityRemoval, FilterRanking, InlineFilter, MatchPredicate, RepeatUnroll,
PathRetraction, Count, Adjacent↔Incident (both directions), EarlyLimit, LazyBarrier,
OrderLimit, PathProcessor, ByModulatorOptimization, **ProductiveBy** (⚠ author admits
"more of a decoration" — changes `by()` null semantics), **GValueReduction** (parameter
materialization — understand, don't just drop).

**Finalization:** Profile, ReferenceElement (result *shape* — id+label only),
MatchAlgorithm.

**Verification (throw on illegal constructs — never change results):** ReadOnly,
LambdaRestriction, EdgeLabelVerification, ReservedKeysVerification, StandardVerification,
ComputerVerification (OLAP).

Grammar (`Gremlin.g4:959-965`): a strategy is syntactically just
`[new] <Identifier> [ ( key: value, … ) ]` — no name enumeration; config-key validity is
a runtime concern. `withStrategies` takes ≥1 `traversalStrategy`; `withoutStrategies`
takes ≥1 bare `classType`.

### Conformance counts (verified against corpus.txt + pinned feature files)

- **`withStrategies` = 174 corpus traversals** (audit's "166 rejected" = these minus the
  ones already passing as no-ops). **`withoutStrategies` = 44.**
- **All ~218 strategy scenarios are currently in L3 scope and failing** — every one is
  tagged `@With<Name>Strategy`, and `tags.ts` excludes **none** of them. They count
  against the 495 ratchet as failures today.
- **`withoutStrategies` (44) is almost entirely no-op-able** — a "disable each optimizer
  and re-check identical rows" sweep, dominated by RepeatUnroll(9).

Per-strategy (with + without), most-frequent first:

| count | strategy | bucket |
|------:|----------|--------|
| **62** | SubgraphStrategy | semantic |
| **29** | ProductiveByStrategy | semantic-ish (by() nulls) |
| **24** | PartitionStrategy | semantic |
| 18 | RepeatUnrollStrategy | optimization (no-op) |
| 7 | ReadOnlyStrategy | verification (throw) |
| 6 | SeedStrategy | semantic (RNG determinism) |
| 5 | VertexProgramStrategy | OLAP (descope) |
| 3 each | AdjacentToIncident, MatchAlgorithm, OptionsStrategy, ReservedKeysVerification, EdgeLabelVerification, EarlyLimit, HaltedTraverser, LazyBarrier | mixed |
| 2 each | ~14 others | mostly no-op / OLAP |

### The effort cut (what a SQL/OLTP compiler must actually *do*)

| Bucket | ~Traversals | Strategies | Effort |
|---|---:|---|---|
| **Semantic — real filtering work** | ~115 | **Subgraph 62, ProductiveBy 29, Partition 24** | High, but see Part IV — two of three reuse existing seams |
| **Optimization — no-op accept** | ~51 | RepeatUnroll 18 + ~12 others; all of `withoutStrategies` | **Already handled** (15-name whitelist) where the *rest* of the traversal compiles |
| **Verification — assert + throw** | ~17 | ReadOnly 7, EdgeLabel 3, ReservedKeys 3, Lambda 2, Standard 2 | Cheap per strategy: implement the check + exact error string. `throwException:false` variants are free no-ops |
| **OLAP / GraphComputer** | ~23 | VertexProgram(+Restriction) 8, Halted 3, ReferenceElement 2, … | Out of scope — descope via tags or reject cleanly |

**Headline: ~115 of 218 strategy scenarios (≈53%) collapse onto three strategies —
SubgraphStrategy, ProductiveByStrategy, PartitionStrategy.**

> **Counting caveat (don't over-claim the unlock).** The strategy is only the *first*
> rejection in a scenario. Real net gain = scenarios whose *remainder* already compiles.
> Two big entanglements:
> - **ProductiveBy(29)** overwhelmingly appears with `aggregate().by().cap()` — and
>   `aggregate`/`cap` are themselves deferred (net-new side-effect state). So
>   ProductiveBy unlocks little **until** aggregate/cap land. It's gated, not standalone.
> - Many Subgraph/Partition bodies use already-supported steps (`V()`, `both()`,
>   `dedup()`, `values()`), so those *do* convert directly.

---

## Part IV — The architectural payoff: Subgraph & Partition fit an existing seam

The reason bet #7 called this "medium, invasive" — "must apply the implied filter to
every read and write" — is exactly right about *what*, but mogwai now has the machinery
to do it *without* new compiler infrastructure. Both are, in TinkerPop's own
implementation, **traversal rewrites** — and mogwai already has a traversal-rewrite seam:
`src/strategies.ts` (the `Step[]→Step[]` normalization passes, Seam 3).

### SubgraphStrategy ≈ "inject a synthetic `where()` after every element step"

TinkerPop's `SubgraphStrategy.apply()` inserts a `TraversalFilterStep(vertexCriterion)`
after every vertex-emitting step, an edge filter after edge steps, and expands
`out()`→`outE().filter(edgeCriterion).inV().filter(vertexCriterion)` when an edge
criterion exists. In mogwai terms:

- `vertexCriterion: __.has("name", within(...))` is **exactly a `where(__.<traversal>)`**
  filter — and mogwai already compiles multi-hop `where` via `compileExistsChain`
  (`src/plan.ts`) and single-hop via `compileFilterPredicate`. Landed 2026-07-13
  (per-traverser branching).
- So `SubgraphStrategy` becomes a **new `strategies.ts` pass**: after every
  movement/element step in the chain, splice a synthetic `where`/`has` step carrying the
  criterion. The existing dispatch then compiles it as a filter CTE. No new SQL shape.

That reframes the biggest bucket (62) from "invasive new machinery" to "a normalization
pass that reuses the where/exists seam." Genuinely medium, not hard.

### PartitionStrategy ≈ "inject `has(partitionKey, within(readPartitions))` + stamp writes"

- **Reads:** splice `has(partitionKey, within(readPartitions))` after every
  vertex-producing step. `has(...within...)` **already compiles.** Another
  `strategies.ts` pass. The identifier-safe key splice + auto-built expression index
  (see `CLAUDE.md` schema notes) even make the partition filter index-eligible for free.
- **Writes:** stamp `writePartition` as a property on every created element. The write
  interpreters (`src/steps/write.ts`) already set properties on insert; this is one extra
  property injected into the cluster. Meta-property partitioning (`includeMetaProperties`)
  is the fiddly tail — defer it.
- **`withoutStrategies(PartitionStrategy)`** stays coupled: once the pass applies by
  default it must be suppressible. But `PartitionStrategy` is *never* a default here
  (it's only ever explicit via `withStrategies`), so `withoutStrategies` of it is a
  clean no-op — the coupling worry in `compiler.ts:35-37` only bites for strategies we
  turn on by default (none semantic today).

### The seam story, summarized

| Strategy | Shape in mogwai | Reuses | New machinery |
|---|---|---|---|
| Optimization (15) | no-op accept | — | none (done) |
| `withoutStrategies` (opt) | no-op accept | — | none (done) |
| **SubgraphStrategy** | `strategies.ts` pass → synthetic `where`/`has` per step | `compileExistsChain`/`compileFilterPredicate` | the injection pass |
| **PartitionStrategy** | `strategies.ts` pass → `has(within)` per read + property stamp on write | `has` compiler, write interpreters | the injection pass + write stamp |
| Verification (throw) | check + throw exact message | `checkStrategies` walk already exists | per-strategy checks |
| ProductiveBy | `by()` null-coalesce | tied to `aggregate`/`cap` (net-new) | gated on side-effect state |
| Seed / OLAP / Event | reject or descope | — | none |

The strategy-rewrite passes need one thing `strategies.ts` doesn't do today: they must be
driven by the **parsed strategy config** (partitionKey, readPartitions, the criterion
traversal), which currently `checkStrategies` only regex-sniffs for names. So step one is
a real parse of the `withStrategies` argument list into a config object, threaded into
`normalize()`. That parse is the shared prerequisite for all semantic strategy work.

---

## Part V — Recommendation (for sequencing, not for building now)

1. **Keep the fail-closed guard as-is** until a semantic strategy is genuinely honoured.
   Silent filter-dropping is the one unacceptable outcome (data leak). The current
   `compiler.ts` posture is correct.
2. **Correct the record:** DO routing and `PartitionStrategy`/`SubgraphStrategy` are
   complementary levels, not substitutes. In-graph partitioning *is* a legitimate ask
   independent of the tenant boundary. (This doc supersedes bet #7's dismissal.)
3. **If/when strategy work is picked up, order by seam-reuse and unlock:**
   - **(a) `withStrategies` config parse** — the shared prerequisite. Parse args →
     `{name, config}[]`, thread into `normalize()`.
   - **(b) SubgraphStrategy** — biggest bucket (62), cleanest reuse (`compileExistsChain`
     already exists). A `strategies.ts` injection pass. **Best first semantic pick.**
   - **(c) PartitionStrategy** (24) — the second injection pass (`has(within)` + write
     stamp). Delivers the intra-graph sub-tenancy the presumption wrongly dismissed.
   - **(d) Verification-with-error** (~12) — cheap, independent throws (ReadOnly,
     ReservedKeys, EdgeLabel). Reuses the existing tree walk.
   - **(e) ProductiveBy** — only alongside `aggregate`/`cap` (it's gated on them).
   - **Descope** OLAP/GraphComputer strategies via `tags.ts` so the ratchet isn't
     silently counting ~23 permanently-out-of-scope scenarios as failures.
4. **Client-side partition→DO routing** is a *separate, optional* transport for
   *hard* isolation, built on the driver's `interceptors` hook (upstream a pre-submit
   strategy hook, or use an out-of-band URL segment). Never the sole mechanism; server-
   side soft filtering is the conformance-complete one.

**Throughline (unchanged):** every semantic strategy has a SQL-native shape as a
traversal rewrite over existing seams — grow the compiler, don't add an interpreter.

---

## Appendix — one-liner to refresh strategy counts

```sh
grep -oE 'with(out)?Strategies\([^)]*' test/conformance/corpus.txt \
  | grep -oE '[A-Za-z_]+Strategy' | sort | uniq -c | sort -rn
```
