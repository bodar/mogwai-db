# Multi-label vertices — `labels()` / `addLabel()` / `dropLabel()` / `dropLabels()`

**Status:** planned, not started. Measured 2026-07-30 against L3 1529 / 2297.
Design-of-record for `docs/outstanding-work.md` item 19.

**Storage is DECIDED, not open:** vertex labels normalize into a `vertex_labels` table which becomes
their sole home; `edges.label` stays inline. Taken deliberately **now, while the project has no
users, so there is no migration** — see "Storage" below.

## Why build this at all

Worth stating plainly, because the honest answer is not a user-demand story.

**What a label is, as distinct from a property** — three things that are real in this engine, not
just in the abstract:

1. **Label is structure; a property is data.** TinkerPop models it as a token (`T.label`), not a
   key, so it cannot collide with a user property literally named `"label"`, and
   `elementMap`/`valueMap` render it in a separate position from the property map. Every element
   has one; properties are optional.
2. **It is the physical partitioning key.** Literally, here: `n_label ON nodes(label)`, and the
   label sits *inside* `e_out(src, label, tgt)` / `e_in(tgt, label, src)`. `out('knows')` reads the
   label straight out of the covering index — locked decision #3 working. A property cannot do
   that; it is a `(key, value)` row you must join to.
3. **Labels are interned** — an integer FK into `labels`, so comparison is integer equality, where
   a property key is text per row.

**Why more than one:** orthogonal facets. Upstream's own fixture is the tell — `tux` is `animal`,
`bird`, `aquatic`, `endangered`, which is not a hierarchy but four independent classifications.
With one label you either invent combinatorial labels (`endangered_aquatic_bird`) or demote
classification to a list property, losing `hasLabel`'s index and traversal-primitive status. The
other canonical case is mixins — `Person` + `Employee` + `Manager`, where `hasLabel('Employee')`
should find you whatever else you are. It is the Neo4j model.

**The counterweight, recorded so it is not rediscovered as an objection:** multi-label is close to
"a set-cardinality property with privileged status". If you need none of the three properties
above, `has('type','bird')` does the job.

**So the reason to build it is CONFORMANCE** — 81 failing scenarios, ~10% of everything still red,
specified in TinkerPop 4. Not that anyone is asking for facet classification. Anyone weighing this
against another P2 item should weigh it on that basis.

## The measurement, and the correction it forced

Item 19 was first filed as "31 scenarios across three feature files". **That was the label-STEP
files only. It is 84 scenarios, 81 failing** (3 pass incidentally), across **19 feature files**,
all carrying upstream's `@MultiLabel` tag:

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
(25)**. Reachable at all only because the parser regeneration (`f5cddda`) added the four label
steps to the tracked grammar.

## The governing concept — a declared per-graph capability

`vendor/tinkerpop/gremlin-core/.../structure/LabelCardinality.java`:

| | min | max | mutable | notes |
|---|---|---|---|---|
| `ONE` | 1 | 1 | no | **TinkerGraph's default**; 3.x compatibility. All mutation throws. |
| `ONE_OR_MORE` | 1 | ∞ | yes | `dropLabels()` always throws; `dropLabel(x)` only if one remains. |
| `ZERO_OR_MORE` | 0 | ∞ | yes | no constraints; zero labels is legal. |

Providers declare it through `Graph.Features`, and the two element kinds differ **by spec**:

- `VertexFeatures.getLabelCardinality()` — configurable, defaults to `ONE`.
- `EdgeFeatures.getLabelCardinality()` — javadoc: *"Edge labels are **always** … @return the label
  cardinality for edges, **always** `LabelCardinality.ONE`"*.

Two consequences that shape everything below:

1. **Declaring `ONE` and refusing correctly IS conformance.** The scenarios *without* the
   `@MultiLabel` tag assert that a single-label graph raises `"Label mutation is not supported"`.
   Seven scenarios are won by refusing properly.
2. **Multi-label is opt-in per graph.** The cucumber runner routes `@MultiLabel` + empty-graph
   scenarios to a separate traversal source (`gmultilabel`, `feature-steps.js:103-105`), leaving
   `gmodern` and the plain empty graph at `ONE`. **So turning the capability on cannot regress the
   1,509 modern-graph scenarios** — they never see the multi-label regime.

The target for `gmultilabel` is `ZERO_OR_MORE`, pinned by `g_addV_labels` (`g.addV()` → `labels()`
count 0), `g_V_dropLabels_labels` (count 0) and `g_V_elementMap_zero_label_vertex_multi_label_default`.

## Storage — decided

```sql
CREATE TABLE IF NOT EXISTS vertex_labels(
  node  INTEGER NOT NULL REFERENCES nodes(id),
  label INTEGER NOT NULL REFERENCES labels(id),
  PRIMARY KEY (node, label));
CREATE INDEX IF NOT EXISTS vl_label ON vertex_labels(label, node);
```

- **`nodes` becomes `(id, uid)`** — the `label` column and `n_label` are dropped. `vertex_labels` is
  the sole home for a vertex's labels; there is no denormalized copy and therefore no drift class.
- **`edges` is untouched**: `(id, uid, src, label, tgt)`, with `e_out`/`e_in` intact.
- `vl_label ON vertex_labels(label, node)` replaces `n_label` and serves `hasLabel` as the same
  index-only seek producing node ids.

**The rule this follows, read off what we already did for properties:** *normalize where cardinality
is 0..N; keep inline where it is exactly 1.* `edge_properties` is a table because an edge has many
properties — and it lacks `vertex_properties`' `meta` column and pins `UNIQUE(edge, key)` because,
per its own DDL comment, "TinkerPop's edge Property has no id/meta/multi". Our storage already
mirrors TinkerPop's vertex/edge model rather than forcing symmetry. Labels are the same shape:
vertex labels are 0..N, an edge label is fixed at 1 by spec, so an `edge_labels` table would be a
strict 1:1 side table buying no expressiveness while taking the label out of the two covering
indexes every movement rides.

**Two things the schema gives for free**, both of which would otherwise be step logic:

- `PRIMARY KEY (node, label)` makes it a SET. `addLabel("person")` on a vertex already labelled
  `person` is a no-op via `INSERT OR IGNORE` — which is exactly
  `g_V_addLabelXexistingX_labels_count` → 1, enforced by the schema rather than by a step.
- **Zero-label vertices become expressible** (zero rows). They are impossible against a `NOT NULL`
  column, and `ZERO_OR_MORE` requires them.

**No migration path is written, deliberately.** The schema change lands in one commit while there
are no users, with the declared capability still `ONE`, so storage becomes multi-label-capable
before any behaviour changes and never has to change again.

## What is already true — de-risking findings

Read off the code, not assumed. Each removes a phase someone would otherwise plan:

- **The wire needs no change.** GraphBinary already frames an element's label as a LIST, and
  `vertexBuffer`/`edgeBuffer` (`src/execute.ts:41,60`) already write `[label]` — a bare list of one,
  with the comment saying so. Upstream's `EdgeSerializer`/`GraphSerializer` read and write
  `List<String>` for the same reason. Multi-label reads are a longer list in a field already a list.
- **The label is already an interned id**, resolved through `labelIn` (`plan/plan.ts:32`). A label
  *set* extends an indirection that exists.
- **`label()` is deprecated but live**, and on a multi-label vertex returns an arbitrary one of them
  — `Element.label()`'s javadoc says so, and `g_V_label_deprecated_multilabel_value_is_one_of_labels`
  asserts only that it is *within* the set. It does not become a list.
- **Edges read but never mutate.** `g.E().labels()` must answer (returning the one label); every
  `g_E_addLabel*` / `g_E_dropLabel*` expects the mutation error even under `@MultiLabel`.

## Blast radius, measured 2026-07-30 — and the one trap that matters

Dropping `nodes.label` touches:

- **~20 sites doing `JOIN labels l ON l.c.id = n.c.label`** to resolve a vertex's label name —
  `tail/{group,path,select,projection,modulation}.ts`, `prefix/filter.ts`, `plan/plan.ts`,
  `services/catalog/search.ts`.
- **9 `labelIn` call sites, but only 4 are VERTEX** (`prefix/filter.ts:106,123`,
  `prefix/predicate.ts:271,289` via `ctx.labelIdExpr`, `write/write.ts:899`). The other five are
  `e.label` and **do not move**.
- 28 `labelNameSub` references, and `write/write.ts:233`'s raw response-framing SQL.

> **THE TRAP: a scalar label position must not become a join.** Every one of those ~20 sites reads
> the label in a ONE-row-per-vertex projection — `label()`, `by(T.label)`, `elementMap`/`valueMap`'s
> `T.label` token, path framing, select payloads. Replacing the join to `labels` with a join through
> `vertex_labels` **silently multiplies rows**: N labels become N copies of the vertex. That is
> precisely the "silently answer a different question" failure CLAUDE.md forbids, and it would pass
> every single-label test.
>
> **The fix is one named accessor, introduced first and mechanically.** `vertexLabelName(idExpr)`
> returns a scalar subquery with a deterministic pick (`… ORDER BY vl.label LIMIT 1`); every scalar
> position routes through it, and **`labels()` is the ONLY consumer that fans out**. One accessor,
> N readers — the same shape as `classifyBy`.

## Phases

Ordered so the schema lands first and each phase is independently provable. Counts are what that
phase alone turns green.

### Phase A — schema + accessor (**+0 scenarios; a pure refactor, and must be provable as one**)

- Add `vertex_labels`; drop `nodes.label` and `n_label`. The write path inserts exactly one row.
- Introduce `vertexLabelName` (scalar) and the set reader; route all ~20 sites and the 4 vertex
  `labelIn` sites through them. No behaviour changes; declared capability stays `ONE`.
- **Exit criterion: L3 still 1529, and the census TSVs are byte-identical.** If either moves, the
  refactor changed semantics and the trap above is the first place to look.

### Phase B — `labels()` and correct refusal (**+7 scenarios**)

- `labels()` lowers as the fan-out reader over `vertex_labels` — one row per label, and the only
  site allowed to join. On edges it yields the single inline label.
- `addLabel` / `dropLabel` / `dropLabels` throw `"Label mutation is not supported"` — the exact
  message scenarios match on. Write it as a **capability check against the declared
  `LabelCardinality`**, not a `step not implemented` stub, so Phase D changes a constant rather than
  re-finding the sites.
- Clears 36 unique `step not implemented` deferrals from the census in passing.

### Phase C — conformance harness (**+0; prerequisite for D and E**)

Named separately so its cost is not hidden inside Phase D.

- A **`gmultilabel` traversal source** in `conformance-server.ts`'s `SEEDS`, declaring
  `ZERO_OR_MORE` while `ggraph` stays `ONE` — the first time our host serves two graphs with
  *different capabilities*, so the capability must reach the store, not just the seed.
- A **`gzoo` reference graph**, and it has a real blocker: the zoo graph ships in the submodule
  **only as `tinkerpop-zoo-v3.kryo`** — no GraphSON — so `graphsonSeed` cannot read it and we should
  not grow a Gryo reader. Hand-transcribe it as write traversals, as `MODERN_SEED` and `CREW_SEED`
  already are. 27 of the 84 scenarios need it.

### Phase D — turn the capability on (**~40 scenarios**)

- `addLabel` / `dropLabel` / `dropLabels`, including **traversal-valued arguments**
  (`addLabel(constant("employee"))`, `addLabel(constant(["a","b"]))`) — that is item 0b's
  apply-contract, so reuse `ElementReadDriver` rather than growing a fourth argument evaluator.
  Note the specified error for a collection in a *multi-argument* position
  (`addLabel(constant(["a","b"]), constant("c"))` → message containing `"Collection"`).
- `hasLabel(...)` and `has(T.label, P)` become **ANY-match over the set** — the widest-reaching
  change, and the one to write the equivalence test for.
- `addV("a","b")` (AddVertex, 6) and `mergeV({T.label: ["a","b"]})` (MergeVertex, 9).
- `dedup().by(labels().order().fold())` should follow once `labels()` is a list producer.

### Phase E — the map shapes (**~23; gated on item 13**)

`ElementMap` (14) and `ValueMap` (9) render labels per regime, selected by a traversal-source option
— `g.with("multilabel")` / `g.with("single-label")`. That selector is index item 13
(`with(...)` / `OptionsStrategy` sugar), so this phase is genuinely blocked on it.

## Traps

- **The scalar-vs-fan-out trap above is the big one.** Everything else here is smaller.
- **A negated predicate over a set is not the negation of the member test.**
  `has(T.label, without('animal'))` means *no* label is `animal`, **not** *some* label is not
  `animal`. `g_V_hasXlabel_withoutXanimalXX_name_multilabel` pins it. Get the quantifier wrong and
  it passes on single-label graphs and is wrong everywhere else.
- **`dropLabels()` throws on `ONE_OR_MORE` but succeeds on `ZERO_OR_MORE`.** Two of the three
  cardinalities are mutable and they disagree — encode the min/max/mutable triple as data, as
  TinkerPop does, rather than as booleans at call sites.
- **`dropLabel("xyz")` on a vertex lacking that label is a no-op, not an error**
  (`g_V_dropLabelXnonExistentX_labels`).
- **A zero-label vertex is still a vertex** — it appears in `g.V()`, has properties, and frames with
  an empty label list. Any read path assuming a label exists breaks here.
- **Do not descope `@MultiLabel` in `tags.ts` to improve the number.** These are supportable
  scenarios against a graph we configure; descoping shrinks the denominator and hides the largest
  bucket in the suite. (Contrast the standing P3 hygiene item, which descopes OLAP/GraphComputer —
  genuine architectural walls.)

## Not covered

`labels()` as a *child body* shape, and `order().by(labels())`, follow the ordinary child-seam rules
(index items 2 and 5); this plan does not special-case them.
