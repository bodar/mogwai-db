# A GraphQL front end — design and build plan

**A PLAN — nothing here has landed.** Every capability claim in §2 is a **probe result** (method: §10).
The one dependency is approved (§7·4).

**What this answers.** A mogwai graph is driven the normal way, over Gremlin. This doc is about the
*other* caller: a client that speaks only GraphQL, pointed at that same graph. The question is **which
of GraphQL's own features that client gets, which it does not, and why** — and, where the answer is
"not yet", the layer to build it (the IR — §3).

It is deliberately NOT about what Gremlin can do that GraphQL cannot. A GraphQL client never asks for a
traversal, a `path()` or a `sack()`, so "GraphQL can't express them" is not a gap — it is the surface
working as designed. The only features that count here are the ones in GraphQL's own spec.

**Short answer:** most of the GraphQL surface maps directly (§1·1); the features that need help
(deep/recursive relationships, aggregation — §1·2) are the ones every GraphQL-over-a-database product
solves the same way, with a directive or a schema convention. And the engine work they require is the
**top of the RelIR fold's own worklist** (§2), so serving GraphQL and advancing the engine's main line
are a single build.

---

## 1. The GraphQL feature surface — which features a GraphQL client gets

GraphQL is not a graph query language. It is a **hierarchical field-selection language over a typed
schema**: the *schema* is a graph, but every *query* is a tree of statically-known finite depth.
That one property decides which features serve cleanly and which need help.

### 1·1 Features that work

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
| `@skip` / `@include` | resolved at translation — the field is kept or dropped |
| Interfaces / unions | `hasLabel()` type dispatch; per-type fields from the inline fragment |
| Introspection (`__schema`, `__type`) | the reflected schema (§4), served in GraphQL's own shape |
| Variables | the params map → **binds** (see §6) |
| Mutations | `addV` / `addE` / `property` / `drop` / `mergeV` |

The selection-set → `project()/by()` correspondence is not an analogy. It is a structural identity:
both are "for each traverser, produce a named tuple whose fields are computed by sub-traversals."

### 1·2 Features that need a convention or an escape hatch — and why

Each of these is a GraphQL feature (or the standard GraphQL-over-a-database extension of one), not a
Gremlin capability GraphQL happens to lack:

- **Deep / recursive relationships.** GraphQL query depth is literal and finite — no native transitive
  closure, variable-length path, or "to any depth". This is the one place every product extends the
  language, with a non-standard directive (Dgraph `@recurse`, Neo4j `@cypher`). We do the same:
  `@recurse(depth:)` → `repeat().times()` (§8, Phase 4). It works, but only through the documented
  extension, never from a bare selection set.
- **Aggregation / grouping.** GraphQL has no native `count` / `sum` / `group`. Products expose it as
  schema convention — aggregate fields (`personAggregate { count }`) or a directive — lowering to our
  `group` / `groupCount`. A schema-shape decision, not an engine gap.
- **Filtering beyond the schema's arguments.** A client can filter only on the args the schema
  declares; there is no arbitrary-predicate syntax. That is a **feature** — it is the authorization
  boundary — but it is why GraphQL is a *complementary* surface, never the only one a graph needs.

Gremlin's own traversal power — `path()`, `sack()`, barriers, side effects, arbitrary walks — sits
outside all of this. No GraphQL client asks for it, so it is not a missing GraphQL feature, just not
part of the surface. That separation is the whole reason to run both against one graph.

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

Not a coincidence: a selection set with per-level arguments IS the relational shape the fold exists to
express — nested projection with per-level filter, order and slice, `rel2sql`'s home ground
(`vendor/calcite`). GraphQL asks not for a concept the engine lacks but for the concepts the fold is
furthest through designing and has not finished lowering.

### 2·2 The one item that is not a family — **LANDED**

**`ListOf` gained a `map` member.** The union was `elem | property | scalar | list | mixed`; a *list of
maps* had no representation at the render boundary, so no producer above it could emit one whatever the
fold learned to lower. It is now `… | { kind: 'map'; of: MapOf }` (`src/sql/kernel/render.ts`) — the
total-union completion this section predicted, framed by the one `frameTypedNode` `{t:'map'}` rule
already in `execute.ts`, rather than a coarse view bolted beside it.

Every GraphQL to-many object field is a list of maps, at every depth ≥ 2, and this was the substrate
item that comes first. With it landed, so did the producers and the callers: `fold()` gained an arm on
the record and map tails, `foldMaps` collects the per-row pairs array, and a list NESTED in a
`project()` field frames through `listNodeExpr` (the self-describing twin of `listPayloadExpr`). So
`project(k…).by(…).fold()`, `valueMap().fold()`, `group().…fold()`, and a nested
`project().by(__.…project().fold())` — the depth-2 GraphQL selection — all lower and frame to real
GraphBinary maps. The owning worklist is the RelIR plan's §10 (its "a list whose members are MAPS"
bullet); the coverage is `test/compiler/list-of-maps.exec.test.ts` (the corpus underexercises deep
selections, so this is where the shape is checked).

---

## 3. Where the layer goes: the IR

**The IR — `Step[]`. Not RelIR, not SQL.** (Whether the translator *reaches* it by emitting Gremlin
text and re-parsing, or by constructing `Step[]` directly, is §5·2 and is open. Either way the layer
the compiler sees is the IR, which is what this section is about.)

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
a vocabulary that has exactly one (`src/compiler/CLAUDE.md`, the bright line: a Pass may CONSULT
shape, never CONSTRUCT it). RelIR is where the §2 work lands — it is not the entry point.

**Why not SQL.** Reimplements the compiler. Nothing to weigh.

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
`call()` is a first-class source. `call('schema')` makes the reflected schema
reachable *from Gremlin* as well as from the GraphQL endpoint, and gives the GraphQL layer no private
back door into storage. Introspection then falls out for free — GraphQL introspection is just this
schema, served in GraphQL's own shape.

A user-supplied SDL with mapping directives (pin `Person.friends` to `out('knows')`) is a **later**
override, not the first cut. Reflection-first is the DO-shaped answer: address a graph, get a working
GraphQL endpoint with introspection and tooling, zero config.

---

## 5. Placement — **locked**. Emission — **open, decide by spike**

### 5·1 Placement: the Worker. Locked.

**GraphQL translation runs in the Worker, not in the Durable Object.** Not a trade to weigh, and not
really a question about GraphQL: a DO is single-threaded, and translation needs no store. Putting it
in the DO would spend a graph's serial budget parsing a document — occupancy no other caller of that
graph can use — for work a horizontally-scaled runtime does in parallel. Full argument:
`docs/archive/2026-08-07-edge-compilation-plan.md` §1. It applies here unchanged; this front end is one more
thing on the elastic side of the same line.

So the path is `document → (Gremlin) → plan → DO`, with everything left of the DO in the Worker.

### 5·2 Emission: a Gremlin string, or `Step[]` directly — ✅ DECIDED BY SPIKE: **a Gremlin string**

**The spike found a fact argument could not: the direct-`Step[]` path is not wired end to end.**
`compile()`/`compilePlan()` (`src/compiler/compiler.ts`) start from a STRING — `parseGremlin` then the
`extractSack`/`extractSideEffects`/`extractStrategies` walkers ALL read the ANTLR parse tree, not
`Step[]`. `gql.ts` emits `Step[]` only because a Pass SPLICES it into an already-parsed chain (it never
calls `compile(Step[])`); a standalone translator emitting `Step[]` would have to reproduce those
extract-walkers over IR — real, untested plumbing. So the string path is the plan's "tested door"
argument made concrete: the translator emits Gremlin text and `compile()` carries it through the fully
instrumented entry. The **hybrid still applies** for the type concern — the renderer IS the pipeline
output (not a separate display layer), and a spike test confirmed `parseGremlin(render(steps))`
round-trips, so grammar-legality holds by construction. The one residual cost (typed inline literals,
`30` vs `30L`) is bounded: most values are variables (params map + `paramTypes`, typed either way), and
the renderer controls the literal FORM for the inline minority. Measured: a depth-2 selection rendered
to `g.V().hasLabel('person').project('name','friends').by(__.values('name')).by(__.out('knows')
.project('name').by(__.values('name')).fold())` and ran to the correct nested result.

Historical trade (kept for the record — the spike above supersedes it):
Both translation and compilation now happen in the same Worker process, which retires the two
arguments that used to settle this: nothing is serialized (so emitting IR is not "reinventing the
bytecode TinkerPop 4 deleted" — a `Step[]` is an in-process object handed to `runPasses`), and the
re-parse is 0.142 ms of local CPU (`…edge-compilation-plan.md` §2·3), i.e. nothing.

What is left is a genuine trade, and it is about where fragility lands.

**For emitting a Gremlin string:**

- **Grammar-legality by construction.** A string that parses is legal by definition. A hand-built
  `Step[]` can be a chain the grammar could never produce, and **nothing checks** —
  `src/gremlin/validate.ts` covers identifier rules only (hidden keys, empty labels); there is no
  structural IR validator. The compiler's input contract is "whatever a front end produced", and
  every existing front end is grammar-driven. Emitting IR is a fail-open surface.
- **It lands on the tested door.** L1–L5, the corpus, `rel-blockers`, the census, `test:perturbed` —
  everything enters through `parseGremlin`. A translator emitting strings can have its output run
  through every instrument already in the tree.
- **Readable in a log**, where a `Step[]` is JSON soup.

**For emitting `Step[]`:**

- **No text-generation layer to get wrong, and the sharp case is types.** Gremlin encodes numeric
  type *lexically* — `30` vs `30L` vs `30.0`. GraphQL's `Int` is 32-bit, `Float` is a double, custom
  scalars are whatever they declare. Emitting text means mapping GraphQL types onto Gremlin literal
  FORMS and trusting the parser to infer back what was meant; emitting `arg(30, 'int')` states it.
  Against the typed-property-values work, this is the strongest argument on either side. (Partly
  mitigated: most user values arrive as *variables*, which travel in the params map with
  `paramTypes`, so their type is stated either way. It is inline literals in the document where the
  lexical form bites.)
- **It is the in-repo idiom.** `src/gremlin/gql.ts` — the precedent front end §3 cites — emits
  `Step[]` directly through a local `step(ctx, name, args, argTypes)` helper with explicit
  `TypeNode`s per argument. `math.ts` does the same, and the compiler synthesizes steps itself
  (`strategies.ts`'s `synth`). Building IR programmatically is the established pattern here.

**The framing that may decide it:** a `Step[] → Gremlin` renderer is wanted either way (§5·3), and
it is the fragile part. If the string is the pipeline, a quoting or type-suffix bug is a **wrong
answer**; if the string is only a rendering, the same bug is a **display** bug. That argues IR — but
it trades away grammar-legality-by-construction and the tested-door property, which are this repo's
fail-closed instincts, so it should not be traded away casually.

**A hybrid may get both**, and is worth trying in the spike: emit `Step[]`, write the renderer for
display, and assert in tests that `parseGremlin(render(steps))` is equivalent to `steps`. That
restores grammar-legality as a *property* rather than a construction — if it renders and re-parses
equivalently, the chain was expressible, therefore legal — and it is the same shape as the L5
differential oracles already in the tree.

**Decide by spike, not by this document.** Both options are a single file. The two things a spike
answers that argument cannot: how bad `Step[]` construction is ergonomically for a deeply nested
selection set, and how bad Gremlin text generation is for typed literals. Whoever does the work
decides; nothing else in this plan depends on the answer.

### 5·3 Explain is an `extensions` entry, not a query parameter

GraphQL-over-HTTP defines exactly four request parameters — `query`, `operationName`, `variables`,
`extensions` — and states that all other property names are reserved, that implementers MUST extend
by other means, and that the RECOMMENDED means is an implementer-scoped entry in `extensions`.

So a top-level `?explain` is **non-conformant**, and `graphql-http`'s `serverAudits` (§7·1) is
exactly the thing that would catch it. The shape is `extensions: {"mogwai:explain": true}` on the
request, answered under a scoped key in the response's `extensions`.

The affordance is still wanted — showing a user the Gremlin their document became is the debugging
story and a real escape ladder (read it, then hand-edit it). Note only that it does **not** come free
with the string option: the scoped-extension plumbing is the same either way, and only the payload is
lying around.

### 5·4 The dependency, and the one thing GraphQL adds

Everything right of the translator belongs to `docs/archive/2026-08-07-edge-compilation-plan.md`. GraphQL
must not build a private version of it, and does not need to: until that plan's Phase 1 lands, the
translator hands `{gremlin, params, paramTypes}` across the existing `GraphManager` seam
(`src/router.ts`, `src/api.ts:160`) exactly as a Gremlin client does, needing **zero changes** to the
manager or executor contract. So GraphQL is not blocked by it — only aligned with it.

**The one asymmetry.** Compilation is a pure function of the query (`…edge-compilation-plan.md`
§2·1). **Translation is not** — it is a function of the query *and the schema*, and the schema is
read from the store (§4).

**Start by fetching the schema per request.** Correct, no invalidation, simplest thing that works.
The cost is that a GraphQL request becomes **two DO round trips** instead of one, and that is DO
occupancy — the scarce resource — which makes this the mirror image of a cache that would spend the
abundant one. Whether it matters is unmeasured and genuinely unknown: the reflection is a few
`GROUP BY`s over `labels` / `vertex_labels` / `vertex_properties` / `edges`, index-covered, so on a
small graph the extra hop dominates and on a large one `DISTINCT key` over a million property rows
does not.

**Batching cannot collapse it, and the reason is worth writing down.** SQLite has no multiple-result-
set concept — DO's `exec` accepts several statements but returns one cursor — but that is not the
obstacle. The obstacle is that the second query's **text does not exist yet**: it is computed in
JavaScript, in the Worker, from the first query's results. That is a *compilation* dependency, not a
data dependency, and no amount of statement batching resolves it. The two-hop shape is inherent to
translating anywhere but inside the DO.

**If it measures, the answer is a compare-and-swap, not a TTL.** Send the plan together with the
schema version it was compiled against; the DO executes if the version still holds, and otherwise
returns the fresh schema instead of results, for the Worker to retry. One hop in steady state, two
only when the schema actually moved — and *correct* under staleness rather than merely fast, which a
time-based cache is not. The write counter §4 already proposes is what it keys on.

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

### 7·4 The dependency decision — **APPROVED**

`graphql` (graphql-js) as a RUNTIME dependency, `graphql-http` as dev-only. Recorded because the
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

1. **`ListOf` gains a `map` arm — ✅ LANDED** (`src/sql/kernel/render.ts`) — §2·2. The vocabulary gap at
   the render boundary; it unblocked everything after it and nothing unblocked it. Shipped WITH its
   producers (`fold()` on the record/map tails, `foldMaps`) and its nested-field caller
   (`listNodeExpr`), so a list of maps is producible, framable, and composes to **depth-3 selections
   and beyond** (measured: `person { name, created { name, creators { name } } }` — nesting is
   structural, `fieldNode`/`listNodeExpr`/`frameTypedNode` all recurse). `unfold()` closes the round
   trip, and a `by()` body over a list host (`select(Pop.all).by(__.unfold().values(k).fold())`) landed
   for element members — see the RelIR §10 "list whose members are MAPS" and "a `by()` body over a LIST
   host" bullets.
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

**Phase 1 — schema reflection as a service. ✅ MOSTLY LANDED.** `g.call('mogwai.schema')`
(`src/services/catalog/schema.ts`) reflects the label/property/edge model as a STREAM of one
self-describing map per schema element — `{kind:'vertexLabel',name,count}`, `{kind:'property',label,key,type}`,
`{kind:'edge',label,src,tgt}` — a handful of `GROUP BY`/`DISTINCT`s over the five schema tables, zero
binds. The stream shape (not a single document) is the prior-art answer: TinkerPop's own `--list`
meta-service and Neo4j's `db.schema.nodeTypeProperties` both emit one record per element, and it composes
with the map vocabulary (`.count()`, `.fold()` verified — `.fold()` rides the list-of-maps substrate).
Namespaced `mogwai.schema` (our extension → `extendedRegistry` only, NEVER `standardRegistry`, so the
reference-exact `--list` conformance surface is unchanged). 🚧 What is LEFT: SDL printing on top (belongs
in `src/graphql/`, Phase 2), a `with('aggregate', true)` document variant if ever wanted, edge-property
types, and the write-counter cache (an optimisation, not correctness). `src/graphql/` reads THIS.

**Phase 2 — the translator + the HTTP edge. ✅ LANDED (core surface).** The §5·2 spike settled emission
(a Gremlin string). `src/graphql/` is built:
- `schema.ts` folds the `mogwai.schema` rows into an addressable `GraphSchema` (a GraphQL object type =
  a vertex label, a scalar field = a property key, an object field = an edge — reflection-first, an
  in/out pair disambiguated by a `_in` suffix).
- `translate.ts` walks a document top-down against it — a root → `V().hasLabel(Type)`, a scalar →
  `by(__.values(key))`, an object field → `by(__.<out|in>(edge).project(…)….fold())`, recursing to any
  depth. Fail-closed: arguments, fragments, mutations, multiple roots, unknown fields all RAISE
  `GraphQLTranslationError` rather than emit a half-Gremlin string.
- `edge.ts` is the `POST/GET /graphql/{g}` handler (§5·1, in the Worker): §5·4's `reflect schema →
  translate → run → {data}` flow, a spec-shaped `{data}`/`{errors}` JSON envelope (200 for an executed
  op, 400 for malformed transport), and the scoped `extensions: {"mogwai:explain"}` payload (§5·3). BOTH
  verbs are GraphQL-over-HTTP and BOTH return JSON only: `POST` reads the JSON body, `GET` reads
  `?query=` (the spec's GET form, what `graphql-http`'s audit grades). The edge serves NO HTML — no
  in-browser explorer, no server-rendered page of any kind; the endpoint is the product and a page
  reflecting the path id is a surface with no payoff. Wired into the shared `makeRouter`
  (`src/router.ts`) on a path SEPARATE from the gremlin prefix, so the two protocols never collide.

The full **reflect → translate → run** path is verified over a live seeded graph to depth-3 (both edge
directions) AND end-to-end through the real router (`test/graphql.test.ts`). It crosses the EXISTING
manager seam (zero executor changes) and picks up plan-shipping for free now that
`docs/archive/2026-08-07-edge-compilation-plan.md` has landed.

🚧 What is LEFT of Phase 2 (all additive, no new gates): field ARGUMENTS → `has()`/`order()`/`limit()`
(the filter/order/first tail of §1·1); variables → the params map (§6); `@skip`/`@include`;
interfaces/unions; `__typename`; and the §5·4 compare-and-swap schema cache (an optimisation — two DO
round trips per request today, correct and un-cached).

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
- **What the schema reflection costs a DO** (§5·4) — the number that decides whether fetch-per-request
  is fine or the compare-and-swap is needed. Measure it as occupancy, against graph size, since the
  two ends of that range plausibly disagree.

**Two findings from the probes run for §5 are bigger than this document.** A point-lookup-plus-1-hop
on a 20 000-vertex graph took 9.8 s because SQLite had no statistics and inverted the join order —
since fixed by the plan-stability work (RelIR plan §1 P4). And compilation turns out to touch the
store zero times, which makes the whole request path splittable
(`docs/archive/2026-08-07-edge-compilation-plan.md`). Neither is a prerequisite here.

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
`docs/archive/2026-08-07-edge-compilation-plan.md` (a finding §5's probes turned up; the plan-stability
finding has since landed, RelIR plan §1 P4),
`docs/2026-07-28-property-based-testing-l5.md` (the differential-oracle pattern Phase 3 reuses),
`docs/2026-07-17-agent-memory-vision.md` (the consumer that most wants this surface).
