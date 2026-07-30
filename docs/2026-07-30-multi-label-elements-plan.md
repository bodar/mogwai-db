# Multi-label elements — `labels()` / `addLabel()` / `dropLabel()` / `dropLabels()`

**Status:** planned, not started. Measured 2026-07-30 against L3 1529 / 2297.
Design-of-record for `docs/outstanding-work.md` item 19.

## The measurement, and the correction it forces

Item 19 was filed as "31 scenarios across three feature files". **That was the label-STEP files
only. The real feature is 84 scenarios, 81 of them failing** (3 pass incidentally), spread over
**19 feature files** — every one carrying the `@MultiLabel` tag:

| feature | @MultiLabel | feature | @MultiLabel |
|---|---|---|---|
| `map/ElementMap` | 14 | `map/Label` | 3 |
| `sideEffect/DropLabel` | 11 | `filter/HasLabel` | 3 |
| `map/ValueMap` | 9 | `filter/Has` | 3 |
| `map/MergeVertex` | 9 | `sideEffect/GroupCount` | 2 |
| `sideEffect/AddLabel` | 8 | `branch/Choose` | 2 |
| `map/AddVertex` | 6 | `map/Order`, `filter/{Or,Not,Dedup,And}`, `branch/Branch` | 1 each |
| `map/Labels` | 5 | | |

At 81 failing this is **the largest single open bucket in L3 — roughly 3× item 7b's match-string
(25)**, and about 10% of everything still red. It is also the only bucket of that size whose
blocker is a *storage* decision rather than the child seam.

## The governing concept — it is a declared per-graph capability, not a global switch

`vendor/tinkerpop/gremlin-core/.../structure/LabelCardinality.java` is the whole design axis:

| | min | max | mutable | notes |
|---|---|---|---|---|
| `ONE` | 1 | 1 | no | **TinkerGraph's default**; 3.x compatibility. All mutation throws. |
| `ONE_OR_MORE` | 1 | ∞ | yes | `dropLabels()` always throws; `dropLabel(x)` only if one remains. |
| `ZERO_OR_MORE` | 0 | ∞ | yes | no constraints; zero labels is legal. |

Two consequences that shape everything below:

1. **Declaring `ONE` and throwing correctly IS conformance.** The scenarios *without* the
   `@MultiLabel` tag — `g_V_addLabelXemployeeX_single_label_graph`,
   `g_V_dropLabels_single_label_graph`, and five siblings — assert that a single-label graph
   raises `"Label mutation is not supported"`. Seven scenarios are won by refusing correctly.
2. **Multi-label is opt-in per graph**, which is what makes this safe to build: the cucumber
   runner routes `@MultiLabel` + empty-graph scenarios to a *separate traversal source*
   (`gmultilabel`, `feature-steps.js:103-105`), leaving `gmodern` and the plain empty graph at
   `ONE`. **So Phase 2 below cannot regress the 1,509 modern-graph scenarios** — they never see
   the multi-label regime.

The target for `gmultilabel` is `ZERO_OR_MORE`, pinned by three scenarios: `g_addV_labels`
(`g.addV()` → `labels()` has count 0), `g_V_dropLabels_labels` (count 0), and
`g_V_elementMap_zero_label_vertex_multi_label_default`.

## What is already true — the de-risking findings

Established by reading the code, not assumed. Each removes a phase someone would otherwise plan:

- **The wire needs no change.** GraphBinary already frames an element's label as a LIST, and
  `vertexBuffer`/`edgeBuffer` (`src/execute.ts:41,60`) already write `[label]` — a bare list of
  one, with the comment saying so. Multi-label reads are a longer list in a field that is already
  a list. There is no serializer work in this plan.
- **The label column is already an id, not a string.** `nodes`/`edges` hold an FK into a `labels`
  intern table, and `labelIn` (`src/compiler/plan/plan.ts:32`) resolves names through it. A
  set-of-labels table is an extension of an indirection that exists, not a new one.
- **Edges stay single-label, and our schema and TinkerPop agree.** Every `g_E_addLabel*` /
  `g_E_dropLabel*` scenario expects `"Label mutation is not supported"` *even under
  `@MultiLabel`*. Independently, `e_out ON edges(src, label, tgt)` and `e_in ON edges(tgt, label,
  src)` (`src/storage.ts:53-54`) bake the edge label into the two covering indexes every movement
  step rides. **So `edges.label` is untouched by this plan** — only `g.E().labels()` (a read,
  returning the one label) changes. This halves the blast radius.
  Note this makes vertex and edge label storage diverge, and that is *correct and precedented*:
  `edge_properties` already lacks `vertex_properties`' `meta` column and pins `UNIQUE(edge, key)`,
  because — per the DDL's own comment — "TinkerPop's edge Property has no id/meta/multi". Our
  storage already mirrors TinkerPop's vertex/edge model rather than forcing symmetry, so a
  vertex-only label set is the established pattern.
- **`label()` is deprecated but live**, and on a multi-label vertex returns exactly one of the
  labels (`g_V_label_deprecated_multilabel_value_is_one_of_labels` asserts only that it is *within*
  the set). It does not have to become a list.

## Phases

Ordered so each lands independently and the cheap, zero-risk one is first. Scenario counts are
what that phase alone turns green.

### Phase 0 — declare `ONE`, implement `labels()`, refuse mutation (**+7 scenarios, no schema change**)

The whole of this phase is correct behaviour for the graph we already have.

- `labels()` lowers as a scalar projection of the element's label name — one row per element,
  reusing `labelNameSub` (`plan/plan.ts:471`). It is `label()`'s row-shape twin, so it registers
  beside it rather than needing new machinery.
- `addLabel()` / `dropLabel()` / `dropLabels()` throw `"Label mutation is not supported"` —
  the exact message the scenarios match on. This is a *deliberate* fail-closed refusal that is
  also the specified answer, so it should read as a capability check against a declared
  `LabelCardinality.ONE`, not as a `step not implemented` stub. Do it that way now and Phase 2
  changes a constant instead of finding the sites again.
- Clears 36 unique `step not implemented` deferrals from the census in passing.

**Exit:** the 7 untagged `*_single_label_graph` scenarios pass; `g.V().labels()` and
`g.E().labels()` answer on `gmodern`.

### Phase 1 — the conformance harness (**+0 scenarios, prerequisite for everything below**)

Named as its own phase precisely because it wins nothing and would otherwise hide inside Phase 2's
estimate.

- **A `gmultilabel` traversal source** on the conformance host (`test/L3-conformance/conformance-server.ts`
  `SEEDS`) — a graph whose declared cardinality is `ZERO_OR_MORE` while `ggraph` stays `ONE`. This
  is the first time our host has served two graphs with *different capabilities*, so the capability
  has to reach the store, not just the seed.
- **A `gzoo` reference graph, and this one has a real blocker:** the zoo graph ships in the
  submodule **only as `tinkerpop-zoo-v3.kryo`** — there is no GraphSON v3 file, so
  `graphsonSeed` cannot read it and we have no Gryo reader (nor should we grow one). It must be
  hand-transcribed as write traversals, the way `MODERN_SEED` and `CREW_SEED` already are.
  27 of the 84 scenarios need it (`tux` the penguin: `animal`, `bird`, `aquatic`, `endangered`).

### Phase 2 — vertex label sets (**the bulk: ~40 scenarios**)

Storage, then the read paths, then the writes.

- `addLabel(...)` / `dropLabel(...)` / `dropLabels()`, including **traversal-valued arguments**
  (`addLabel(constant("employee"))`, `addLabel(constant(["a","b"]))`) — that is item 0b's
  apply-contract, so it reuses `ElementReadDriver` rather than growing a fourth argument
  evaluator. Note the specified error for a collection in a *multi-argument* position
  (`addLabel(constant(["a","b"]), constant("c"))` → message containing `"Collection"`).
- `hasLabel(...)` and `has(T.label, P)` become **ANY-match over the set**. This is the change with
  the widest reach — `labelIn` has many callers — and the one to write the equivalence test for.
- `addV("a","b")` (AddVertex, 6) and `mergeV({T.label: ["a","b"]})` (MergeVertex, 9).
- `label()` keeps returning one label; `dedup().by(labels().order().fold())` must work, which it
  should for free once `labels()` is a list producer.

### Phase 3 — the map shapes (**~23 scenarios, gated on item 13**)

`ElementMap` (14) and `ValueMap` (9) render labels differently per regime, selected by a
traversal-source option — `g.with("multilabel")` / `g.with("single-label")`. That selector is
index item 13 (`with(...)` / `OptionsStrategy` sugar), so this phase is genuinely blocked on it
and should not be attempted first.

## The one real decision — how a vertex's label set is stored

Two options, and **this plan does NOT pick one**, because the first draft's reasons for picking
did not survive review. They are recorded here with what actually decides between them.

- **(a) Supplement.** `nodes.label` keeps the first label; `vertex_labels(node, label)` holds the
  whole set and is what `labels()` reads. Under `ONE` the side table is one row per vertex.
- **(b) Replace.** `nodes.label` goes; `vertex_labels` is the sole home for a vertex's labels.
  `edges.label` stays inline either way.

**A retracted argument, recorded so it is not re-made.** The first draft rejected (b) partly
because it "creates an asymmetry with edges". That is void: `vertex_properties` and
`edge_properties` are *already* asymmetric — the latter has no `meta` column and carries
`UNIQUE(edge, key)` — and the DDL comment gives the reason: "TinkerPop's edge Property has no
id/meta/multi". The split tracks TinkerPop's model. Labels are the same shape (vertices multi,
edges single), so a vertex-only label table is **the existing precedent, not a departure from it**.
Under (b) the asymmetry is if anything more honest, because the storage would then say
out loud that multi-label is a vertex concept.

**The surviving argument is a perf claim, and it is UNMEASURED — treat it as the spike to run,
not as a finding.** The concern is that `n_label ON nodes(label)` is what `hasLabel` rides and
that (b) turns every `labelIn` into a join. On inspection that is overstated:
`V().hasLabel('person').out()` seeks `n_label` for node ids and feeds `e_out` without ever reading
the `nodes` row, and an index on `vertex_labels(label, node)` serves the same index-only seek
producing the same ids. The join (b) adds is often to a table the query was not reading.
So: **EXPLAIN + time `hasLabel` seek, `hasLabel().out()`, and a `has(T.label, within(...))` under
both shapes before choosing.** That measurement is the deciding input.

The counterweight is on (a): a denormalized first-label column can drift from the set, and
"which is the real label" becomes a question every read path must answer. (b) has one home and
therefore no drift class at all.

**Phase 0 and Phase 1 are unaffected either way**, so land those first and take this decision with
the Phase 2 code and the measurement in front of you.

## Traps

- **`dropLabels()` on `ONE_OR_MORE` always throws, but on `ZERO_OR_MORE` succeeds.** Two of the
  three cardinalities are mutable and they disagree. Encode the cardinality as data with the
  min/max/mutable triple, exactly as TinkerPop does, rather than as three booleans at call sites.
- **`dropLabel("xyz")` on a vertex that lacks that label is a no-op, not an error**
  (`g_V_dropLabelXnonExistentX_labels`).
- **`addLabel("person")` on a vertex already labelled `person` leaves one label, not two**
  (`g_V_addLabelXexistingX_labels_count` → 1). It is a SET.
- **A zero-label vertex must still be a vertex** — it appears in `g.V()`, has properties, and
  frames on the wire with an empty label list. Any read path that assumes a label exists breaks
  here, and `ZERO_OR_MORE` is the target regime.
- **Do not descope `@MultiLabel` in `tags.ts` to make the number look better.** These are
  supportable scenarios against a graph we choose to configure; descoping would shrink the
  denominator and hide the largest bucket in the suite. (Contrast the standing P3 hygiene item,
  which descopes OLAP/GraphComputer — genuine architectural walls.)

## Not covered

`labels()` as a *child body* shape, and `order().by(labels())`, follow the ordinary child-seam
rules (index items 2 and 5) — this plan does not special-case them.
