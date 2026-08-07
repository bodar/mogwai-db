# A GraphQL front end — design and build plan

> **STATUS: PLAN. Nothing below has landed.** Written 2026-08-07 against trunk at `41c897d`,
> tinkerpop submodule at the current pin. Every capability claim in §2 is a **probe result**; the
> method is at the bottom (§10). The one dependency this needs is approved (§7·4).

The question this answers: *how well does GraphQL map onto a graph database, and if it maps well,
what is the natural layer to attach it to — Gremlin, the RelIR, or SQLite?*

Short answer: **it maps well on shape and badly on traversal**, the natural layer is **the IR**, and
the work is dominated not by GraphQL but by gaps GraphQL merely forces. Which is the good outcome:
those gaps are the **top families of the RelIR fold's own worklist** (§2), so one build closes the
GraphQL requirement and moves the engine's main line at the same time.

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

## 2. What the engine covers — measured, not estimated

GraphQL's whole structural requirement, expressed in Gremlin, is one shape:
`project(k…)` whose `by()` arms are themselves traversals that project, filter, order and slice.
Every selection set at every depth is that, and nothing else.

So the question "how much of GraphQL already works" is exactly "how much of that shape does the
RelIR fold lower". `lowerToRel` answers with a plan or `null`, so the probe is direct: feed it every
prefix of a chain and name the step after the longest one it accepts.

| chain | fold |
|---|---|
| `hasLabel('person').out('created').dedup().values('name')` | **covered** |
| `project('n','k').by(values('name')).by(out('knows').count())` | gives up at `project` (2/3) |
| `…by(out('knows').values('name').fold())` | gives up at `project` (2/3) |
| `…by(out('knows').has('age',gt(20)).values('name').fold())` | gives up at `project` (2/3) |
| `…by(out('knows').fold())` | gives up at `project` (2/3) |
| `…by(out('knows').elementMap('name').fold())` | gives up at `project` (2/3) |
| `…by(out('knows').project('name').by(values('name')).fold())` | gives up at `project` (2/3) |
| `…by(out('knows').limit(1).values('name').fold())` | gives up at `project` (2/3) |
| `…by(out('knows').order().by('name').values('name').fold())` | gives up at `project` (2/3) |
| `hasLabel('person').valueMap('name','age')` | gives up at `valueMap` |
| `hasLabel('person').elementMap('name')` | gives up at `elementMap` |
| `hasLabel('person').order().by('name').limit(10).valueMap()` | gives up at `valueMap` (4/5) |
| `hasLabel('person').group().by('age').by(values('name').fold())` | gives up at `group` |
| `repeat(out('knows')).times(2).dedup().values('name')` | gives up at `repeat` (2/5) |

One of eighteen probed chains, and it is the one with no GraphQL content in it. Corpus-wide,
`mise run rel-blockers` reports **793 / 2298 traversals fully covered (34.5%)**, ranked by family:

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

### 2·1 The ranking IS the scoping instruction

Read that list against §1·1. GraphQL needs `project`, `select`, `valueMap`, `elementMap`, `fold`,
`order`, `limit`, `dedup`, and eventually `group`. **That is the same list, in roughly the same
order** — the map shape, aliases, the property shape, row ops and the list shape are five of the top
seven families, and together they are precisely *a selection set with per-level arguments*.

This is not a coincidence to remark on and move past. A selection set with per-level arguments IS the
relational shape the fold exists to express — nested projection with per-level filter, order and
slice, which is `rel2sql`'s home ground (`vendor/calcite`). GraphQL is not asking for a feature the
engine lacks a concept for; it is asking for the concepts the fold is furthest through designing and
has not finished lowering.

### 2·2 The one item that is not a family

**`ListOf` has no record member** — `src/sql/kernel/render.ts:16`. The union is
`elem | property | scalar | list`. A *list of maps* has no representation at the render boundary, so
no producer above it can emit one, whatever the fold learns to lower.

Every GraphQL to-many object field is a list of maps, at every depth ≥ 2. So this is the substrate
item and it comes first — it is a vocabulary gap at the boundary where shape is DECLARED, not a
lowering gap, and it is the shape of cleanup `docs/2026-07-28-scalartype-refactoring-pattern.md`
describes: a total union gaining the arm that makes the vocabulary complete, rather than a coarse
view bolted beside it.

---

## 3. Where the layer goes: the IR

**The IR. Not RelIR, not SQL, not a generated Gremlin string re-parsed by accident.**

And this is not a new architectural bet — **`src/gremlin/gql.ts` already did it.** The MATCH-string
front end takes a *second, foreign query language* embedded in a string argument, parses it with its
own generated grammar (`parser/gql/`), and emits ordinary `Step[]`. Nothing downstream learned a GQL
concept; a GQL grammar bump moves two files. It went 0 → 25/25 on `MatchString.feature`
(`docs/archive/2026-07-28-match-string-frontend-design.md`). GraphQL is the same move with a bigger
schema story: **a sibling front end under locked decision #5.**

**Why not straight into RelIR.** Tempting — a GraphQL tree → relational tree is structure-preserving,
where a flat step chain looks like an information detour. But everything that makes an element an
element lives at or above the IR: `COALESCE(uid, id)` external ids, label interning, typed property
values (`vtype`), property-shape polymorphism, the canonical emission order. A front end that
constructs relational nodes directly has to reproduce all of it, and would be the second producer of
a vocabulary that has exactly one (`docs/2026-07-28-shape-vocabulary-architecture.md`: a layer may
CONSULT shape, never CONSTRUCT it). RelIR is where the §2 work lands — it is not the entry point.

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

## 5. Placement: the edge — **locked**

**GraphQL translation runs in the Worker, not in the Durable Object.** This is no longer a trade to
weigh, because it is not really a question about GraphQL: a DO is single-threaded, and translation
needs no store. Putting it in the DO would spend a graph's serial budget on parsing a document —
occupancy that no other caller of that graph can use — for work a horizontally-scaled runtime does in
parallel. The full argument is `docs/2026-08-07-edge-compilation-plan.md` §1; it applies here
unchanged, and this front end is simply another thing on the elastic side of the same line.

So the path is `document → Gremlin + params → plan → DO`, with everything left of the DO in the
Worker. The translator emits a **Gremlin string**, which is a deliberate choice and not a stepping
stone: it makes the translation auditable (`?explain` returns the generated Gremlin), gives users a
real escape ladder (read it, then hand-edit it), and keeps `wrangler tail` legible. The rejected
alternative was emitting `Step[]` directly to skip a re-parse — measured at 0.142 ms per query
(`docs/2026-08-07-edge-compilation-plan.md` §2·3), and paid for with a bespoke traversal
serialization. Not a trade worth making.

### 5·1 The dependency

Everything right of the translator belongs to the edge-compilation plan. GraphQL does not need to
build any of it, and must not build a private version:

- **the compile half** — turning that Gremlin string into a plan, in the Worker, and shipping the
  plan rather than the text. That is `docs/2026-08-07-edge-compilation-plan.md` Phase 1. Until it
  lands, the translator hands `{gremlin, params, paramTypes}` across the existing `GraphManager` seam
  (`src/router.ts`, `src/api.ts:160`) exactly as a Gremlin client does, needing **zero changes** to
  the manager or executor contract.
- **the DO-side execution** — unchanged either way.

So GraphQL is **not blocked** by that plan; it is aligned with it. What is locked is that Phase 2
below must not be designed as though the translator might one day live in the DO, because it must
not.

### 5·2 The one thing GraphQL adds that edge compilation does not have

Compilation is a pure function of the query (`…edge-compilation-plan.md` §2·1). **Translation is
not** — it is a pure function of the query *and the schema*, and the schema is read from the store
(§4).

That is a genuine addition to the edge's job, not a detail: the Worker must hold a per-graph schema,
fetched from the DO, and it must be invalidated when a write changes the label or property set. This
is the one cache in either document that has a real invalidation problem, and it exists because
without it there is nothing to translate against — it is a requirement, not an optimization. The
write counter §4 already proposes is what it keys on; moving it to the edge means the counter has to
travel, which is one extra field on a response, not a mechanism.

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

### 7·4 The dependency decision — **APPROVED (Dan, 2026-08-07)**

`graphql` (graphql-js) as a RUNTIME dependency, `graphql-http` as dev-only. Recorded here because the
no-new-dependencies rule makes the approval, not the choice, the thing that needs writing down.
graphql-js is MIT with zero runtime dependencies of its own.

Locked decision #2's reasoning — *generate the parser from upstream's own grammar, never hand-edit* —
**does not transfer**: GraphQL's grammar is EBNF prose inside the spec document, and no
foundation-owned `.g4` exists (the ANTLR grammars-v4 GraphQL grammar is community-authored). For
GraphQL, **graphql-js *is* the authoritative artefact**, occupying the same role `Gremlin.g4` does for
Gremlin. Hand-rolling a GraphQL parser would also mean hand-rolling the spec's ~20 validation rules,
which is the genuinely expensive half and the half a reference implementation gives away.

The rejected alternative was dev/test-only — hand-roll parse+validate for production, keep graphql-js
as the oracle. It duplicates the expensive half (the validation rules) to save ~500 KB in a Worker
bundle — the elastic side, where §5 puts it and where size costs least.

So: parse, validate and introspection types come from the reference implementation, and we own only
translation. The dependency is not added yet — it arrives with Phase 2, and `package.json` should
carry it with the same comment discipline as `antlr4ng`'s pin.

---

## 8. Phases

**Phase 0 — the substrate (no GraphQL in it at all).** §2's families, in dependency order rather than
by size:

1. **`ListOf` gains a `record` arm** (`src/sql/kernel/render.ts:16`) — §2·2. A vocabulary gap at the
   render boundary, so it unblocks everything after it and nothing unblocks it.
2. **The property shape** — `valueMap` / `elementMap` (51). The smallest family that is pure
   projection, and every GraphQL leaf object depends on it.
3. **Row ops inside a child scope** — `order` / `dedup` / `range` / `limit` (30). GraphQL's per-level
   `first:` / `orderBy:` / `distinct:`.
4. **Aliases and the record shape** — `select` / `project` (55 + 16). The selection set itself.
5. **The map shape** — `group` / `groupCount` (78). The largest family, and what GraphQL aggregation
   fields need later (§9). Last because nothing above depends on it.

Tests are ordinary L1/L2 Gremlin — `project().by(out().project(…).fold())` and friends at depth 3,
plus the neighbouring valid compositions (`valueMap`, `elementMap`, `select`, inside `local()`,
inside a branch arm). `mise run rel-blockers` is the progress instrument: each item should move its
family off the ranking, and if it does not, the diagnosis was wrong. Ships value with or without the
rest of this plan — 2 through 5 are the engine's main line whether GraphQL ever exists.

**Phase 1 — schema reflection as a service.** `call('schema')` → the label/property/edge model.
SDL printing on top. Cached against a write counter.

**Phase 2 — the translator, in the Worker (§5).** `src/graphql/` — document AST + reflected schema →
Gremlin string + params, plus the edge-side schema cache §5·2 requires. Router: `POST /graphql/{g}`,
`GET /graphql/{g}` for introspection/GraphiQL, `?explain` for the generated Gremlin. Hands its output
across the existing manager seam; picks up plan-shipping for free when
`docs/2026-08-07-edge-compilation-plan.md` Phase 1 lands.

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

**Unmeasured:**
- Whether a deep selection set generates a plan whose bind count stays O(plan size). It should — all
  literals inline, only variables bind — but "should" is not a measurement, and the 100-bind cap is
  the wall that has shipped twice.
- Whether a depth-4 selection set's SQL stays under the DO's 100 KB statement-text cap.
- **Schema-cache invalidation cost** (§5·2) — how often a write actually changes the label/property
  set, and therefore whether the write counter is a cheap check or a constant refetch. The only new
  unknown §5 introduces.

**Two findings from the probes run for §5 are bigger than this document**, and both have their own
plan: a point-lookup-plus-1-hop on a 20 000-vertex graph takes 9.8 s because SQLite has no statistics
and inverts the join order (`docs/2026-08-07-query-plan-stability.md`), and compilation turns out to
touch the store zero times, which makes the whole request path splittable
(`docs/2026-08-07-edge-compilation-plan.md`). Neither is a prerequisite here. The first is a
prerequisite for caring about performance at all.

---

## 10. Method

**§2's coverage probe does not go through the executor**, and that is load-bearing: running a
traversal proves only that *something* answered it. It calls `lowerToRel` directly on
`runPasses(stepChain(…))` output, over every prefix of the chain, and reports the step after the
longest prefix that returns non-null — the same method `scripts/rel-blockers.ts` uses, so the
per-chain answers and the corpus-wide ranking are computed identically and can be compared. Source
locations were read at the pin and are cited inline.

Related: `docs/archive/2026-07-28-match-string-frontend-design.md` (the precedent front end),
`docs/2026-08-01-relir-build-plan.md` (where Phase 0 lands, and whose worklist it shares),
`docs/2026-08-07-query-plan-stability.md` and `docs/2026-08-07-edge-compilation-plan.md` (the two
findings §5's probes turned up, each now its own plan),
`docs/2026-07-28-property-based-testing-l5.md` (the differential-oracle pattern Phase 3 reuses),
`docs/2026-07-17-agent-memory-vision.md` (the consumer that most wants this surface).
