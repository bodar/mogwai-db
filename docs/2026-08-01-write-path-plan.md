# The write path — every open problem in one place

**Status: a survey, not a design.** Assembled 2026-08-01 by sweeping `docs/outstanding-work.md`, the
`docs/` corpus (live + archive), the L3 telemetry, the committed census, and
`mise run test:perturbed`. Every number below was measured on that date against trunk `9ba3fee`;
every wrong answer was reproduced with a probe before it was written down. Where a claim is
inherited from an older doc rather than re-measured, it says so.

**The headline, and it contradicts the index.** `docs/outstanding-work.md` says the write half of
item 22 "was MEASURED clean on 2026-07-31" and that no item below it is a known wrong answer. That
measurement was about the *validation refusals* — it did not look at graph STATE. Eleven L3
scenarios fail at a `the graph should return N for count of …` step, meaning the write ran and left
the graph wrong. Three are reproduced in §2. **Those come first**, because a silent wrong answer is
the one thing the root `CLAUDE.md` says we do not ship.

## 0. What the write path already is — read this before adding anything

- **One nested-argument seam, and it is the sole authority.** `resolveSpecValue` / `resolveSpecKey` /
  `resolveMergeSpec` (`steps/write/write.ts`) evaluate a write argument that depends on the current
  element, per driver row. Do NOT add a second argument evaluator; item 0b's whole point is to
  *extend the declared contract* (`ModulationContract` / `ElementReadDriver`).
- **One identifier-rule authority.** `steps/write/validate.ts` holds TinkerPop's `ElementHelper`
  rules and is reached from the four storage waists. Item 23 deleted four per-host arity checks it
  dominates; do not reintroduce a host-local check.
- **The driver is row-at-a-time by DESIGN-DEBT, not by accident.** `run(store)` interleaves reads
  with INSERTs and reads back what it wrote. Both a row-at-a-time and a set-based rendering are
  verified; what is missing is the DECISION, because a set-based form must settle match-vs-create for
  the whole driver set before writing anything (Internal debt, `outstanding-work.md`).
- **Bulk loading is a different machine.** `BulkLoader` + `src/rowbatch.ts` (chunked, fixed-shape
  binds) serve `io()` and would serve import/federation. It is not the traversal write driver.
- **Bind caps are gated.** Never hand-roll placeholder repetition; `mise run binds` fails the build.
  A write chunks through `bindChunks`; a read lands a set as one JSON bind.

## 1. The numbers (measured 2026-08-01)

| Instrument | Write-related | Of |
|---|---|---|
| L3 failing scenarios | **66** — mergeE 25, mergeV 16, addV 14, addE 9 | 588 failing / 2267 |
| …of those, wrong GRAPH state (ran, wrong result) | **11** | — |
| Census clean deferrals mentioning a write step | ~61 rows | 443 deferrals |
| Census `crashed` | **0** (the README's "17" is stale) | — |
| Perturbed census rows that are writes | **3** | 4 remaining |

The 66 cluster into four tranches below. They are ordered by *kind of wrongness*, not by count:
wrong answers, then refusals of legal traversals, then unreachable positions, then determinism.

## 2. W1 — the SILENT WRONG ANSWERS. Do these first.

Three reproduced on the modern graph (probe: run the write, then query the graph):

```
g.addV("animal").property("name","mateo").property("name","gateo").property("name","cateo")  — FIXED 2026-08-01
  ours:      values("name") → ["cateo"]          — each property() OVERWRITES
  reference: all three survive (the scenario asserts has(name,mateo) AND (…,gateo) AND (…,cateo))

g.V().outE().property("weight", null)                                    — FIXED 2026-08-01
  ours:      E().properties("weight").count() → 6   — the property is kept
  reference: 0 — a null value REMOVES the property
  (same shape: g.V().hasLabel("person").property("name", null), and
   g.mergeE(…).option(onMatch, [weight: null]))

g.V(1).property(Cardinality.list, "friends", __.out("knows").values("name"))
  ours:      properties("friends").count() → 1   — only the first value is stored
  reference: 2 — marko knows vadas and josh, and list cardinality appends BOTH
```

Two more in the same family, not yet characterised, so verify before designing:
`g.addV().property(["name":"foo","age":42])` and
`g.V().has('name','foo').property(["name": Cardinality.set("bar"), "age": 43])` — the whole-MAP
argument form of `property()` (corpus lines 442, 1493, 1514).

**What ties the first and third together is item 16's W4** — the multi/meta-property schema rework.
We implement `single` semantics where the reference's default for a NEW vertex property is a
multi-property, and we take the first value where a traversal yields several. Treat W4 as the
substrate for W1 rather than a separate item; the wrong answers are its visible face and are what
justify the schema work.

**The DEFAULT half of that landed 2026-08-01 (`a9f4c0c`), and the schema it needed was one small
table, not a rework.** L3 1682 → 1684. What the survey got wrong is worth keeping, because both
errors were about where a fact lives rather than about the fact:

- *"We implement `single` where the reference's default is multi"* is right, but a CONSTANT default
  cannot be the fix either way. The corpus pins the same graph in both directions — one
  `@MultiProperties` scenario needs an undeclared repeat write to APPEND, and
  `g_V_hasXperson_name_aliceX_propertyXsingle_age_…` needs one to REPLACE on a key its initializer
  wrote as `property(single, …)`. TinkerPop's javadoc for `getCardinality(key)` splits providers on
  exactly this ("implementations that employ a schema can consult it" vs "return their default …
  for every key") and the corpus needs the schema-bearing kind. Flipping the constant to `list`
  measures +2/−1; the recorded declaration measures +2/−0.
- The declaration is scoped to **(node, key)**, not to the key, which is a deliberate divergence
  from TinkerPop's signature. Graph scope was built first and measured wrong: the conformance runner
  empties the shared graph with `g.V().drop()`, which clears data and not schema, so one scenario's
  declaration silently changed a later scenario's undeclared write. No corpus scenario distinguishes
  element scope from graph scope.
- The real thread was not schema at all: `readCardinality` collapsed "the step declared none" to
  `'single'` at PARSE time, so the graph never got asked. Carrying `null` to the storage waist is the
  whole fix, and it is the same shape as `insertVertex` applying the default LABEL.

**Still open in this family (unchanged):** the third wrong answer — a traversal value under
`Cardinality.list` stores only the first result — plus the whole-MAP argument form. Those are about
a MULTI-VALUED nested-traversal value (`AddPropertyStep.handleTraversalValue` collects ALL results
and applies one mutation per result under list/set, and throws under `single`), which is the
`nestedScalarValue` "first row wins" seam, not the schema.

**One fidelity gap this opens, and it is real:** `io()`/`BulkLoader` round-trips do not carry the
declarations, so a graph exported and reimported loses a `single` and reverts that (vertex, key) to
the `list` default. Nothing in L3 reaches it; decide it with the meta-property VALUE typing in §6,
since both are "what the adjacency format does not carry".

**The null-removal case is DONE (2026-08-01, `15ceefa`).** It was independent and small, as
predicted: a semantic rule (`null` value ⇒ remove), not a schema question. What the estimate got
wrong is that it does not have "three hosts" — it has **two**, and they are the storage waists
(`applyVertexProperty` / `insertEdgeProperty`), because removal is cardinality-independent AND
lifecycle-independent, so vertex `property()`, edge `property()`, addV/addE creation and
`mergeE(onMatch)` all reach it there. The `single`-cardinality replace turned out to BE that same
delete, so the two now share `removeProperties`. L3 1679 → 1682; census moved 5 rows, all this rule.

That change also grew L4 a step it did not have: upstream's
`And the graph should return N for count of "<traversal>"`. **Every remaining tranche in this
document needs it** — without it an L4 write scenario can only pin what the write RETURNED, which is
trap 4 from the other side.

## 3. W2 — the upsert cluster: 41 of the 66 failures

| Cause | Failing | Note |
|---|---|---|
| whole-arg map traversal (`__.identity()`, `__.select(…).limit().unfold()`, `__.sideEffect(…)`) | 10 | item 0b's **map-valued driver** — the declared blocker |
| `mergeE option(Merge.outV)` | 8 | |
| step not implemented after `mergeV()` (`property()`, `as()`) | 8 | a read/write TAIL after an upsert (§4's item 10 overlaps) |
| `PartitionStrategy` + `mergeV`/`mergeE` (partition-aware upsert) | 7 | also `outstanding-work.md` line 534 |
| "Out Vertex not specified in onCreate — edge cannot be created" | 3 | we refuse where the reference creates |
| bare `mergeV()`/`mergeE()` (incoming traverser IS the map) | 3 | needs the same map-valued driver |

**They share one substrate**, which is why they are one tranche: a driver whose current object is a
MAP rather than an element. `resolveMergeSpec` already resolves per-VALUE traversals correlated per
driver; what does not exist is a driver whose whole argument is a map produced by a traversal, or
whose incoming traverser is that map. Build that once and six rows move.

`option(onCreate) cannot override values from merge() argument` (12 thrown, mostly on PASSING
error-assertion scenarios) is the *correct* refusal — do not "fix" it. Check whether a scenario
expects the throw before touching any merge refusal; item 23 landed a family of these deliberately.

## 4. W3 — writes in positions the driver cannot reach

- `union(__.addV(…), __.addV(…))` as a SOURCE — "unsupported source step: addV" (3 scenarios, and
  the feature matrix's `union()` row already names it).
- `optional(__.addV())`, `repeat(__.addV().property())` — a write inside a branch/loop body.
- `addE` after `select()`; `addE from/to` with an unknown `as()` label; an endpoint read tail past a
  movement.
- `addE(label)` with a nested-traversal label (2).
- **addV mid-chain + read-tails-after-write** — `outstanding-work.md` item 10, linked to
  `2026-07-16-compiler-consolidation-plan.md` §6.1(c). This is the one that gates the others: a
  write that is not the last step needs its output to re-enter the read spine as an ordinary element
  stream.
- One WORDING mismatch left over from item 23: we say `addE needs both endpoints — supply from()/to()
  or an incoming traverser` where the reference says `must resolve to a Vertex or the ID of a Vertex
  present in the graph`.

## 5. W4 — the execution model, and a measurement that changes its priority

**The three perturbed census writes are ID-ASSIGNMENT order, not wrong graphs.** Measured:

```
g.V().as("a").in("created").addE("createdBy").from("a").property("year",2009).property("acl","public")
  normal    → edges (lop→marko, lop→josh, ripple→josh, lop→peter), ids 13,14,15,16 in that order
  perturbed → the SAME four edges, ids assigned in the reverse order
```

The graph is identical; only which new element got which id differs, and the census digest includes
ids. So **the perturbed gate does not require the driver rewrite.** Two ways to close it, and the
first is now cheap:

1. **Make the driver consume its input in emission order.** The substrate exists as of 2026-08-01:
   the source seeds `encounter = id`, every row slice already demands it, and a child scope's ordinal
   is order-bearing. A write's assigned ids are observable, so a write chain demanding an encounter
   is the same argument `COLLECTING_CONSUMERS` already makes for `fold`/`aggregate`/`cap`.
   Reproducible ids are also something users notice.
2. Exempt the three rows in the perturbed runner, naming the reason.

`g.V().repeat(__.both()).times(3).range(5,11)` needs an exemption either way — it is item 4's
`repeat`/`match` boundary and expected.

**The row-at-a-time rewrite stays a separate, later question.** It is an execution-model decision
(match-vs-create for the whole set before writing), not a correctness bug, and nothing above depends
on it.

## 6. Deliberately NOT in this plan

- **Federated materialize / import-a-graph** (item 11) — it writes through `BulkLoader`, not this
  driver, and its blocker (cross-graph id collision) is already answered by
  `idPolicy: 'remap'`/`'renumber'`. Different machine, different plan
  (`archive/2026-07-31-bulk-transfer-and-io-substrate-plan.md` §5/§7).
- **`io()`** — landed.
- **Item 22's remaining refusals** — `trim`/`asString` per-member type errors are string steps, not
  writes, and they need a runtime error channel.
- **Meta-property VALUE typing** (item 16's second half) — storage carries a flat `{metaKey: scalar}`
  bag, so a meta value round-trips as whatever JSON returns. Adjacent to W1's schema work; decide
  whether to widen the schema once, rather than twice.

## 7. Traps — each one has already cost someone a wrong turn

1. **`@StepWrite` is NOT the data-write steps.** It tags `io().write()` graph serialization. The
   write steps carry `@StepAddV`/`@StepAddE`/`@StepMergeV`/`@StepMergeE` and are already ratcheted.
   (Corrected once, in `archive/2026-07-17-writes-through-read-spine-plan.md`.)
2. **Legality defines the support surface, not the corpus.** `[k: __.trav]` is legal because
   `mapEntry : mapKey COLON genericLiteral` includes `nestedTraversal` — the corpus being silent
   about a form is not evidence it is unreachable. That reasoning was got wrong in both directions
   once already.
3. **Check whether a refusal is the reference's answer before removing it.** A third of the write
   messages in the L3 telemetry belong to scenarios that PASS because they assert the throw.
   `vendor/tinkerpop/gremlin-core` is the authority; cite the file and line, as T1–T4 did.
4. **Do not fix a graph-state failure by making the verification query pass.** Read the reference's
   semantics for the write itself; the verification query is a consequence.
5. **The census is the guard, and re-recording it without a written reason is the thing it exists to
   prevent.** A write tranche will move `goldens.tsv`; every moved row needs a sentence.
6. **`mise run test:cf-limits` is not optional for write work.** A write that scales its bind list
   with row count passes every test on Bun and fails only in a Durable Object.

## 8. Sequencing, and how each tranche is verified

| # | Tranche | Verified by |
|---|---|---|
| W1 | the three (five) silent wrong answers + W4 schema — **null-removal landed** | the reproductions in §2 become L4 pins; census `goldens.tsv` moves with a reason |
| W2 | the map-valued driver, then the five upsert rows that follow it | L3 ratchet (expect ~41 candidates, not all reachable) |
| W3 | addV mid-chain / read-tail-after-write first, then the positions it unblocks | L3 ratchet + the matrix rows 207–209 |
| W4 | driver input in emission order | `mise run test:perturbed` — 3 census rows, and with the `repeat` exemption the instrument becomes a GATE |

W1 and W4 are independent of each other and of W2/W3. W3's mid-chain item is the prerequisite for
several of W2's tails, so if only one large thing gets done, do W3's first item.

**Start each tranche by re-measuring its numbers.** This document is a snapshot, and
`docs/outstanding-work.md`'s own warning applies double here: the index has been stale in both
directions, and the "write half is clean" line above is exactly what a stale index looks like.
