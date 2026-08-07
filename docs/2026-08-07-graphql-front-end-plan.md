# A GraphQL front end — design and build plan

> **STATUS: PLAN. Nothing below has landed.** Written 2026-08-07 against trunk at `bae05c7`,
> tinkerpop submodule at the current pin. Every capability claim in §2 is a **probe result** on the
> modern graph, run through `test/support/executor.ts`; the method is at the bottom (§10). One
> decision needs Dan's approval before Phase 2 (§7·3).
>
> **REVISED same day, at `41c897d`.** The original §2 reported the probe as run on "both spines,
> identical verdicts". That claim was hollow and is retracted — `lowerToRel` *declines* to legacy for
> an uncovered chain rather than failing, so pinning `rel` measured legacy twice. §2·2 is the honest
> answer, and it re-scopes Phase 0 (§8).

The question this answers: *how well does GraphQL map onto a graph database, and if it maps well,
what is the natural layer to attach it to — Gremlin, the RelIR, or SQLite?*

Short answer: **it maps well on shape and badly on traversal**, the natural layer is **the IR**, and
the work is dominated not by GraphQL but by gaps GraphQL merely forces. Which is the good outcome:
the expensive part is already on the roadmap. Where it lands changed on revision — the gaps are not
legacy-spine holes to patch, they are the **top four families of the RelIR migration's own worklist**
(§2·2), so Phase 0 builds them in the RelIR fold and closes both at once.

---

## 1. How well does GraphQL map?

GraphQL is not a graph query language. It is a **hierarchical field-selection language over a typed
schema**: the *schema* is a graph, but every *query* is a tree, of statically-known finite depth.
That single property decides everything below.

### 1·1 What maps cleanly

| GraphQL | Gremlin / IR |
|---|---|
| Root field + args | `V().hasLabel(L).has(k, v)` |
| Scalar field | `values(k)` inside a `by()` |
| Object/list field over an edge | `out(L)` / `in(L)` / `both(L)`, `.fold()` for a list |
| Selection set | `project(k…).by(…)…` — near-isomorphic |
| Alias | the `project()` key |
| Fragment / inline fragment | inlined at translation; `hasLabel()` for the type condition |
| `first` / `offset` / cursor | `limit()` / `range()` |
| `orderBy` | `order().by(k, asc\|desc)` |
| `filter` args | `has(k, P.…)` |
| `__typename` | `label()` |
| Variables | the params map → **binds** (see §6) |
| Mutations | `addV` / `addE` / `property` / `drop` / `mergeV` |

The selection-set → `project()/by()` correspondence is not an analogy. It is a structural identity:
both are "for each traverser, produce a named tuple whose fields are computed by sub-traversals."

### 1·2 What does not map

- **Recursion / transitive closure.** The wall. GraphQL query depth is literal and finite; there is
  no `repeat()`, no variable-length path, no shortest-path, no fixpoint. *Every* real implementation
  bolts on a non-standard directive (Dgraph `@recurse`, Neo4j `@cypher`). We must too (§8, Phase 4).
- **Path semantics** — `path()`, `simplePath()`, `sack()`, side effects, barriers, `bulk`. No
  vocabulary at all. Not reachable from a selection set; only from an escape hatch.
- **Aggregation / grouping.** Not native. Needs bespoke schema fields (`personAggregate { count }`)
  or a directive.
- **Arbitrary predicates.** Only what the schema's args expose. That is a *feature* — it is the
  authorization story — but it means GraphQL can never be the only surface.

### 1·3 The prior art's one lesson

Every implementation that works compiles the **whole selection set into ONE query**: Hasura and
PostGraphile → one SQL statement with lateral joins + `json_agg`; the Neo4j GraphQL library → one
Cypher. Every implementation that does not — resolver-per-field with a DataLoader batching patch —
is row-at-a-time interpretation with an N+1 profile, i.e. precisely the failure mode locked decision
#3 exists to forbid. So the compile-the-whole-tree requirement is not a performance nicety here; it
is the same constraint the project already lives under, arriving from a second direction.

---

## 2. What already works — measured, not estimated

Probe: the modern graph, `project('n','k').by(values('name')).by(<ARM>)`, executed end to end. This
section is what the SHIPPING engine answers today; §2·2 is which spine answered it.

**Works today:**

| by-arm | result |
|---|---|
| `out('knows').count()` | `{n: marko, k: 2}` |
| `out('knows').values('name').fold()` | `{n: marko, k: [vadas, josh]}` |
| `out('knows').has('age', gt(20)).values('name').fold()` | filtered list ✅ |
| `out('knows').fold()` | full element list (id/label/properties) ✅ |
| `out('knows').out('created').values('name').fold()` | depth-2 traversal inside the arm ✅ |

**Fails, all with the same deferral** — `by(traversal) modulator not yet supported`
(`src/compiler/steps/tail/select.ts:33`):

| by-arm | what GraphQL needs it for |
|---|---|
| `out('knows').elementMap('name').fold()` | **any nested object field** |
| `out('knows').valueMap('name').fold()` | same |
| `out('knows').project('name').by(values('name')).fold()` | **any selection set at depth ≥ 2** |
| `out('knows').elementMap('name')` | a to-one object field |
| `out('knows').limit(1).values('name').fold()` | `first:` on a nested list |
| `out('knows').order().by('name').values('name').fold()` | `orderBy:` on a nested list |
| `out('knows').dedup().values('name').fold()` | `distinct:` |

Read the two tables together and the shape of the work is exact: **filtering and traversal inside a
child arm already compose to arbitrary depth; producing a MAP inside a child arm, and slicing/ordering
a child arm, do not.** Those two are 100% of GraphQL's structural requirement and 0% of its surface
syntax.

### 2·1 Root cause, precisely located

Three findings, in dependency order:

1. **`ListOf` has no record member** — `src/sql/kernel/render.ts:16`. The union is
   `elem | property | scalar | list`. A *list of maps* has no representation at the render boundary,
   so nothing above it can produce one. **This is the substrate item.**
2. **The record-field classifier offers no record arm** — `recordChildPlan`,
   `src/compiler/steps/tail/select.ts:87`, tries `classifyScalarChild → classifyListChild →
   classifyElementChild` and returns `null` otherwise. Meanwhile **`tryCompileRecordChild` already
   exists** (same file, ~line 440) and is wired only into the child-body path, not into a record
   *field*. The provider is built; the classifier does not offer it.
3. **`classifyListChild` accepts one body shape** — `src/compiler/steps/tail/child-shape.ts:807`:
   the pre-`fold()` body must be a scalar projection or a bare element run. A `limit`/`order`/`dedup`
   in front of it falls out, and so does a record projection. (The `limit` half is the
   **child-scope-limit gap** already recorded from the canonical-emission-order work — this plan does
   not discover it, it collides with it.)

None of the three is GraphQL-specific. Fixing them makes
`g.V().project('a','b').by(…).by(out().project(…).fold())` work for Gremlin users first.

Those three locations are the LEGACY spine's. §2·2 is why the fix should not go there.

### 2·2 Which spine answers any of this — the retraction

`lowerToRel` returns a plan or `null` and never throws; an uncovered chain **declines** and the
legacy spine answers it (`scripts/rel-sweep.ts` exists to protect exactly that contract). So pinning
`spine: 'rel'` does not prove the RelIR path ran. The original probe pinned both and got identical
answers because it ran legacy twice.

Probed properly — longest prefix that `lowerToRel` accepts, then name the step after it:

| chain | RelIR |
|---|---|
| `hasLabel('person').out('created').dedup().values('name')` | **covered** |
| every GraphQL depth-1 shape from §2 (all five) | declines at `project` (2/3) |
| every GraphQL depth-2+ shape from §2 (all five) | declines at `project` (2/3) |
| `hasLabel('person').valueMap('name','age')` | declines at `valueMap` |
| `hasLabel('person').elementMap('name')` | declines at `elementMap` |
| `hasLabel('person').order().by('name').limit(10).valueMap()` | declines at `valueMap` (4/5) |
| `hasLabel('person').group().by('age').by(values('name').fold())` | declines at `group` |
| `repeat(out('knows')).times(2).dedup().values('name')` | declines at `repeat` (2/5) |

One of eighteen. Corpus-wide, `mise run rel-blockers` reports **793 / 2298 traversals fully covered
(34.5%)**, and its family ranking is:

```
78  the map shape       group*:52 groupCount*:26
67  scalar transforms   math:15 asNumber:12 …
63  branch              choose:36 union:20 …
55  aliases             select:52 as:3
51  the property shape  valueMap:38 elementMap:7 value:4 properties:2
30  row ops             order:17 dedup:11 range:2
24  the list shape      fold:24
    (in no family yet)  repeat:86 … project:16 …
```

**Read that against §1·1.** GraphQL needs `project`, `select`, `valueMap`, `elementMap`, `fold`,
`order`, `limit`, `dedup`, and eventually `group`. That is the same list, in roughly rank order —
the map shape, aliases, the property shape, row ops, and the list shape are five of the top seven
families, and they are precisely a selection set with per-level arguments.

This is not a coincidence worth remarking on; it is a scoping instruction. A selection set with
per-level arguments IS the relational shape RelIR was built to express — nested projection with
per-level filter, order and slice — so the RelIR fold is not merely *a* place to build it, it is the
place where the shape is native rather than retrofitted onto a step-tail accumulator.

---

## 3. Where the layer goes: the IR

**The IR. Not RelIR, not SQL, not a generated Gremlin string re-parsed by accident.**

And this is not a new architectural bet — **`src/gremlin/gql.ts` already did it.** The MATCH-string
front end takes a *second, foreign query language* embedded in a string argument, parses it with its
own generated grammar (`parser/gql/`), and emits ordinary `Step[]`. Nothing downstream learned a GQL
concept; a GQL grammar bump moves two files. It went 0 → 25/25 on `MatchString.feature`
(`docs/archive/2026-07-28-match-string-frontend-design.md`). GraphQL is the same move with a bigger
schema story: **a sibling front end under locked decision #5.**

**Why not RelIR.** Tempting — a GraphQL tree → relational tree is structure-preserving, where a flat
step chain looks like an information detour. But everything that makes an element an element lives at
or above the IR: `COALESCE(uid, id)` external ids, label interning, typed property values (`vtype`),
property-shape polymorphism, the canonical emission order. Entering below that duplicates all of it,
onto a spine still mid-migration (`docs/2026-08-01-relir-build-plan.md`). RelIR is where the *fix* in
§2·1 lands — it is not the entry point.

**Why not SQL.** Reimplements the compiler. Nothing to weigh.

**Why not "generate a Gremlin string"** — actually, do exactly that, at first. See §5.

---

## 4. Schema: reflect it, don't declare it

The graph is schemaless — interned labels and typed properties, no declared types. GraphQL demands
SDL. The schema is nonetheless **fully derivable from four tables**:

```
labels                  → object type names
vertex_labels           → which labels exist, and their counts
vertex_properties       → per-label field names + vtype  → GraphQL scalar type
edges (src,label,tgt)   → edge fields + their endpoint label pairs → field return types
edge_properties         → edge-field argument/payload types
```

That is a handful of `GROUP BY` queries over the existing schema (`src/storage.ts:16-63`). One DO =
one graph, so reflection is per-graph, cheap, and can be cached against a write counter.

**Build it as a service, not a special case.** `src/services/` + the registry already exist and
`call()` is now a first-class source (`9c5d11f`). `call('schema')` makes the reflected schema
reachable *from Gremlin* as well as from the GraphQL endpoint, and gives the GraphQL layer no private
back door into storage. Introspection then falls out for free — GraphQL introspection is just this
schema, served in GraphQL's own shape.

A user-supplied SDL with mapping directives (pin `Person.friends` to `out('knows')`) is a **later**
override, not the first cut. Reflection-first is the DO-shaped answer: address a graph, get a working
GraphQL endpoint with introspection and tooling, zero config.

---

## 5. Placement: edge-side translation first

Two placements, and the first is strictly cheaper.

**(a) Translate at the edge, emit a Gremlin string + params.** The router already parses a request
and hands `{gremlin, params, paramTypes}` across the `GraphManager` seam (`src/router.ts`,
`src/api.ts:160`). A GraphQL endpoint at `/graphql/{g}` that produces those three values needs
**zero changes to the manager or executor contract**, and keeps a GraphQL parser out of the DO
bundle. It also makes the translation *auditable*: `?explain` returns the generated Gremlin, which is
both the debugging story and a real escape ladder for users (read it, then hand-edit it).

**(b) Translate in the store tier, emit `Step[]` directly.** No text round-trip, but needs a new
executor method and puts the GraphQL parser in the DO.

**Do (a) first.** The GraphQL surface is identical under both, so (b) is a later, invisible swap if
re-parse cost measures badly — and *whether it does* is a measurement nobody has taken. Note it as an
open number (§9), not a reason to pre-optimize.

---

## 6. Variables are parameters — the bind rule lands exactly right

GraphQL variables arrive in a `variables` map, separate from the document. They map onto the params
map, which makes them **binds**, which is exactly what CLAUDE.md's bind rule asks for: a variable is
the user's own statement that this value changes. A literal typed inside the GraphQL document is a
parsed constant and inlines as a typed SQL literal, spending none of the 100-parameter budget.

No new machinery. The alignment is total, and it is worth stating because it is the one place where
GraphQL's design and the DO's 100-bind cap agree without being made to.

---

## 7. Validating it — the conformance question

There is **no portable `.feature`-style execution corpus** for GraphQL the way `gremlin-test` is for
Gremlin. There are three real oracles, and together they cover more than one corpus would.

### 7·1 The official HTTP audit suite — a true conformance ratchet

`graphql-http` is the GraphQL Foundation's **reference implementation of the GraphQL-over-HTTP spec,
plus an audit suite**: `serverAudits({ url, fetch })` runs the compliance tests against any running
server, MUST/SHOULD-graded. It is what [graphql-http.com](https://graphql-http.com/) uses to publish
its compliance table for every major server, and it is runnable offline.

This is a direct analogue of the L3 ratchet: a fixed external corpus, a pass count that may only go
up. It audits the **protocol** (content negotiation, status codes, error shapes, GET vs POST, media
types) — not our execution semantics. Cheap, high-value, and it lands before any query work does.

### 7·2 Differential execution against graphql-js — the strong one

`graphql-js` is the reference implementation. Point it at a naive resolver set over the same graph
and it becomes an **execution oracle**: same document, same variables, two engines, compare. This is
exactly the L5 property-based shape already built here
(`docs/2026-07-28-property-based-testing-l5.md`) — generate documents from the *reflected schema*
(which bounds generation to legal queries for free) and diff.

Where the two disagree, graphql-js is right by definition. It covers field ordering, null
propagation through non-null types, alias collision, fragment spreading, error `path` entries — the
long tail no hand-written corpus reaches.

### 7·3 Introspection round-trip

`getIntrospectionQuery()` → our endpoint → `buildClientSchema()` → `printSchema()` compared against
the SDL our reflector generated. A one-assertion test that validates the entire schema layer, and the
thing every GraphQL client tool depends on.

### 7·4 The dependency decision — **needs approval**

All three oracles want `graphql` (graphql-js): MIT, zero runtime dependencies of its own.
`graphql-http` is dev-only.

Locked decision #2's reasoning — *generate the parser from upstream's own grammar, never hand-edit* —
**does not transfer**: GraphQL's grammar is EBNF prose inside the spec document, and no
foundation-owned `.g4` exists (the ANTLR grammars-v4 GraphQL grammar is community-authored). For
GraphQL, **graphql-js *is* the authoritative artefact**, occupying the same role `Gremlin.g4` does for
Gremlin. Hand-rolling a GraphQL parser would also mean hand-rolling the spec's ~20 validation rules,
which is the genuinely expensive half and the half a reference implementation gives away.

Three options:

1. **Runtime dependency on `graphql`, dev dependency on `graphql-http`.** Parse + validate +
   introspection types come from the reference implementation; we own only translation.
   **Recommended.**
2. **Dev/test only** — hand-roll parse+validate for production, keep graphql-js as the oracle.
   Duplicates the expensive half to save ~500 KB in a bundle that may not even carry it under
   placement (a).
3. Neither — no GraphQL. (Stated for completeness.)

Recommending (1). Flagging it rather than doing it, per the no-new-dependencies rule.

---

## 8. Phases

**Phase 0 — the substrate, built in the RelIR fold (no GraphQL in it at all).**

The original draft put this in `src/compiler/steps/` — the three §2·1 locations. §2·2 says not to.
Patching the legacy spine buys the RelIR migration nothing and has to be paid for a second time when
those families migrate; building it in the fold closes the GraphQL gap and moves the migration's top
families in one pass. The legacy spine keeps answering these chains until the fold covers them,
because that is exactly what the decline contract is for — so this is not a flag day and there is no
window where a shape stops working.

The order is the dependency order, not the family ranking:

1. **`ListOf` gains a `record` arm** (`src/sql/kernel/render.ts:16`). A list of maps has no
   representation at the render boundary, so nothing above can produce one. Unblocks everything else
   and is the one item that is genuinely shared — the legacy tail needs it too, so it is a render
   boundary change either way, not a spine choice.
2. **The property shape in the fold** — `valueMap` / `elementMap` (51 declines). The smallest family
   that is pure projection, and every GraphQL leaf object depends on it.
3. **Row ops inside a child scope** — `order` / `dedup` / `range` / `limit` (30 declines). This is
   GraphQL's per-level `first:` / `orderBy:` / `distinct:`, and the pre-existing child-scope-limit gap.
4. **Aliases and the record shape** — `select` / `project` (55 + 16). The selection set itself.
5. **The map shape** — `group` / `groupCount` (78). The largest family, and what GraphQL aggregation
   fields need later (§9). Last because nothing above depends on it.

Tests are ordinary L1/L2 Gremlin — `project().by(out().project(…).fold())` and friends at depth 3,
plus the neighbouring valid compositions (`valueMap`, `elementMap`, `select`, inside `local()`,
inside a branch arm) — with `mise run rel-blockers` as the progress instrument and `mise run census`
proving both spines still answer identically. Ships value with or without the rest of this plan.

**Phase 1 — schema reflection as a service.** `call('schema')` → the label/property/edge model.
SDL printing on top. Cached against a write counter.

**Phase 2 — the translator.** `src/graphql/` — document AST + reflected schema → Gremlin string +
params. Router: `POST /graphql/{g}`, `GET /graphql/{g}` for introspection/GraphiQL, `?explain` for
the generated Gremlin.

**Phase 3 — the oracles.** `graphql-http` `serverAudits` as a ratcheted suite; the graphql-js
differential; the introspection round-trip. Wire into `mise run ci`.

**Phase 4 — the escape ladder.** `@recurse(depth:)` → `repeat().times()`; a `_gremlin(query: String!)`
root field for everything the tree cannot say. Both are non-standard by necessity — every
implementation has them, and they are where "GraphQL over a *graph*" stops being a document API.

**Phase 5 — mutations.** `addV`/`addE`/`property`/`drop`/`mergeV`, generated per label from the same
reflected schema.

Phase 0 is the only phase with real depth; 1–3 are surface, and 4–5 are additive.

---

## 9. Deliberately not in scope, and open numbers

**Not in scope:** subscriptions (no change feed exists, and the DO story for one is its own design);
Apollo Federation (a different spec with its own subgraph-compatibility suite — orthogonal, and our
cross-DO federation is not it); persisted queries; a declarative SDL-with-directives mapping layer
(§4 — the override, later).

**Measured since the first draft** (§5's placement question, which is what turned these up):

- **Compile never touches the store** — 0 `store.query` calls across all eight probe shapes. So
  `(gremlin, params) → {sql, binds, shape}` is a pure function and placement (b) is viable, not just
  (a). `WritePlan` is `{run: (store) => …}`, a closure, so this holds for reads only — edge-side
  compilation is structurally read-first rather than by choice.
- **Compile is a fixed ~4 ms per query shape**, independent of graph size (it must be — see above),
  against an execution cost that scales. So compile is 66% of a request on the 6-vertex modern graph,
  77% at 200 vertices, 44% at 1 000, 19.5% at 4 000. The agent-memory shape sits left of that
  crossover.
- **Parse is 2.7% of a request** (0.14 ms of 5.3 ms). The cost is the compiler, not the parser —
  which is why §5 ships `{sql, binds, shape}` rather than `Step[]`.
- **ANTLR cold start is 422×** — 45.2 ms first parse in a fresh process vs 0.107 ms warm.

**Still unmeasured:**
- Whether a deep selection set generates a plan whose bind count stays O(plan size). It should — all
  literals inline, only variables bind — but "should" is not a measurement, and the 100-bind cap is
  the wall that has shipped twice.
- Whether a depth-4 selection set's SQL stays under the DO's 100 KB statement-text cap.
- Gremlin re-parse cost per GraphQL request under placement (a) — now bounded above by the parse
  number, so this is a small question rather than an open one.

**And a finding from the same probes that is bigger than this document:** a point-lookup-plus-1-hop
on a 20 000-vertex graph takes 9.8 s because SQLite has no statistics and inverts the join order;
0.5 ms of `PRAGMA optimize` makes it 19 ms. Nothing here is worth tuning until that is fixed —
`docs/2026-08-07-query-plan-stability.md`.

---

## 10. Method

Probes run from a worktree at `bae05c7` (§2·2 and §9 re-measured at `41c897d`) via
`test/support/executor.ts` against `test/fixtures/seed-modern.ts`, decoded through
`test/support/decode.ts`. §2's table is the shipping engine's answer with no spine pinned.
§2·2 does NOT go through the executor — pinning a spine cannot distinguish "RelIR handled it" from
"RelIR declined and legacy handled it", which is the error the first draft made. It calls
`lowerToRel` directly on `runPasses(stepChain(…))` output, over every prefix, and reports the step
after the longest one that returns non-null — the same method `scripts/rel-blockers.ts` uses, so the
per-chain answers and the corpus-wide ranking are computed the same way.
Deferral messages are quoted verbatim from the thrown `Error`;
source locations were read at the pin and are cited inline.

The §9 timings come from throwaway benchmark scripts, not committed: a synthetic graph (N `person`
+ N `software` vertices, 4 `knows` + 1 `created` edge per person) bulk-loaded into
`new GraphStore(new BunSqlite(':memory:'))`, each query warmed then timed over 20–200 iterations,
with `parseGremlin` / `compilePlan` / `framed` timed separately so exec+frame is the residual. The
store-touch gate wraps `store.query` with a counter and runs `compilePlan` alone. Sizes were
`ANALYZE`d — see `docs/2026-08-07-query-plan-stability.md` for why that qualifier is load-bearing and
what the first, unanalyzed run wrongly showed.

Related: `docs/archive/2026-07-28-match-string-frontend-design.md` (the precedent front end),
`docs/2026-08-01-relir-build-plan.md` (where Phase 0 now lands, and whose worklist it shares),
`docs/2026-08-07-query-plan-stability.md` (the bigger finding these probes turned up),
`docs/2026-07-28-property-based-testing-l5.md` (the differential-oracle pattern Phase 3 reuses),
`docs/2026-07-17-agent-memory-vision.md` (the consumer that most wants this surface).
