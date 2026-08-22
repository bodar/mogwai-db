# GraphSource — one traversal vocabulary over two graph shapes (PLAN)

**Status: IN PROGRESS.** Plan of record. **Naming SETTLED (step 1): `GraphSource` / `BaseGraph` /
`BoundGraph`** (compiler words for machinery, per root `CLAUDE.md`). `GraphSource` + `BaseGraph` live in
`src/compiler/rel/source.ts`, threaded on `ChainCtx.source` (default `BaseGraph`). The interface grows
ONE method per rerouted chokepoint (no speculative/dead methods).

**Steps 1 + most of 2 LANDED** — six Mechanism-A chokepoints rerouted, each census-invariant + ci-green:
- `movement` adjacency → `adjacencyEdges` + `edgeLabelMatch` (`95ad5ba`)
- `values()` value stream → `propertyValues` (`bff0300`)
- `V()`/`E()` element sourcing → `elementScan` (`3861a94`)
- `hasLabel()` + label half of `has(label,k,v)` → `hasLabelPredicate` (`15fc002`)
- `has(k[,v])` property filter → `hasPropertyPredicate` (value comparison stays vocabulary via a
  callback handed the graph's value+vtype exprs; the indexSeek/trigramSeek EXISTS shape preserved) (`3a0b845`)
- `has(T.id/T.label)` → `hasTokenPredicate` (`5c79e55`)

**Steps 3 + 4 LANDED — the bound graph flows through the ONE vocabulary.** `BoundGraph`
(`src/compiler/rel/boundgraph.ts`) is a `GraphSource` over a landed subgraph, **id-carry + rejoin**: a
bound element travels as an ID, and `movement`/`sourceFilter`/`propertyValues`/`externalId`/
`labelScalar`/`leafPayload` are the SAME shared builders the base graph uses, reached through `ctx.source`.
`detachedTail` is now a thin ORCHESTRATOR (it keeps only the bound `.V()`/`.E()` RE-ROOT and routes every
other step through the shared builders); the `foreign.ts` twins (`boundVertexMove`, `boundVertexHas`,
`boundVertexHasLabel`, `boundById`, `endpointVertices`, `foreignValues`) are DELETED. The leaf framing
(Mechanism B) rejoins the landed CTE for the wire payload (`source.leafPayload`, the `elements`/`detached`
framing arms). **Materialize-once is done as a `fenced` (`AS MATERIALIZED`) CTE Plan binding** declared once
in `lowerForeign`, referenced by every read via a `Ref` — Calcite's `RelOptMaterialization`, which also
keeps the landing at ONE `json_each` bind (the cf-limits DO-legality invariant). A bonus of routing through
the shared `sourceFilter`: bound `has(...)` now composes EVERY predicate form (was a fixed handful).
Net: `test/federation.test` 43 green (incl. the new element-terminal cases), `test:cf-limits` 2091 green,
real-workerd `cloudflare.test` 37 green. Residual: the label-scalar cluster below; and no end-to-end
federation-on-real-DO test exists (federation is not in `cloudflare.test`), so DO coverage for the bound SQL
rests on cf-limits DO-legality + the Program shipping RENDERED (no new RPC-crossing structure).

**Step 2 label cluster — LANDED.** `byExpr`'s token arm (reached by `by(T.id)`/`by(T.label)`, the
`label()`/`id()` steps, `labelled()`) now reads through `BaseGraph.externalId`/`labelScalar`, deleting the
duplicate inline SQL. `byExpr` is base-only today (a bound element reads label through `source.labelScalar`
in `detachedTail`, never here), so it calls `BaseGraph` directly; threading `ctx.source` through `byExpr`'s
~22 call sites is the step for when a bound `by()` first reaches it.

**Step 2 label cluster — FULLY LANDED.** `labels()` fan-out routes through `source.labelNames`
(BaseGraph joins the side tables; BoundGraph explodes the landed array), and bound `labels()` composes
(a `detachedTail` branch). `byExpr`'s token AND property arms route through `source` (`externalId`/
`labelScalar`/`propertyScalar`).

**BOUND AGGREGATION — LANDED.** `source: GraphSource` is threaded as an explicit parameter (like
`fresh`) through the entire `by()`/projection cascade — byExpr, byNode/byField, math/format, sack,
list, the group + record + path + collection machinery, lowerMatch — NOT shoehorned onto a carry
object. Once a bound subgraph's source-position steps are done, `detachedTail` HANDS OFF to the main
fold (`continueAs`) with `ctx.source = BoundGraph`, so `group()`/`groupCount()`/`order()`/`project()`/
the reducers compose over the injected graph through the ONE vocabulary. Fail-closed via
`BOUND_HANDOFF_DENY` (writes + `properties()`/`valueMap()` element-bag reads that scan base tables by a
foreign id) and the encounter guard (a chain demanding a SOURCE order the landed stream cannot provide
declines unless an `order()` mints it). `federation.test` covers order/groupCount/group.by(count)/
project/order.fold, oracled on crew; `test:cf-limits` 2099 green (DO-legal).

**ENCOUNTER over a bound graph — LANDED.** The landed relation carries its emission order (`foreignRelation`
`withOrder` exposes the json_each array index as `ord` on the materialized binding + every `Ref`), and the
source-form seed AND the `.V()`/`.E()` re-root mint the `encounter` channel from it. So a bound
`fold()`/`order()`/reducer collects in the sibling's own order — the id-carry model "gains order for free."
The `lowerForeign` encounter guard relaxed (a subgraph source-form seed provides the encounter);
`detachedTail`'s `labels()` honours an arriving encounter; its `dedup()` shortcut yields to the main fold
once the stream carries an encounter (group-by-identity). `federation.test` covers source-order
`values().fold()`, the group VALUE fold (previously declined), `dedup().count()`.

**BULK over a bound graph — LANDED.** The bound seed and `.V()`/`.E()` re-root carry a `bulk` channel
(=1) always (encounter only when ordered — mutually exclusive), and `detachedTail`'s movement collapses a
convergent bound walk with the SAME four conditions `elementTail` uses (fast path on, no live order,
groupable channels, `bulkObservedFrom` suffix). `coalesce` is the same `SUM(bulk) GROUP BY id` RLE; a
`bulked` flag threads forward so the terminal leaf re-expands on the wire (`source.leafPayload` carries the
bulk column) and a reducer reads `SUM(bulk)`. `federation.test` asserts the collapse fires (compact rows <
the multiset) and `count()` sums bulk.

**The bound graph now flows through the FULL traversal vocabulary AND all traverser channels** (encounter +
bulk) via `GraphSource` — movement, filters, `values`/`label`/`labels`, `group`/`order`/`by`/`project`,
order-sensitive `fold`/reducers, and convergent-walk collapse — through the ONE engine.

**OUT OF SCOPE — bound WRITES, by design (not deferred).** A landed subgraph is a DETACHED snapshot, and
a detached element is not mutable — TinkerPop says so outright (`DetachedVertex`: *"not traversable or
mutable"*). A write through the bound stream would mutate a local, ephemeral copy that is discarded when
the query ends — it would reach nothing. Mutating the SOURCE graph is a different operation entirely (a
federate command that pushes a mutation to the sibling), not a write threaded through the detached
traversal. So `MUTATING_STEPS` are in `BOUND_HANDOFF_DENY` and decline permanently — this is a semantic
wall, not a missing feature.

**REMAINING (fail-closed today — but mostly UNBUILT features, not walls; the landed `{t,v}` tree + ids
carry the data):**
- **`valueMap(keys…)` over bound — LANDED.** `GraphSource.valueMapPairs` yields the per-key value arrays
  (base tables, or the landed `{t,v}` tree for a bound graph); `elementValueMap` shapes them into the map.
  `valueMap(true)` / `elementMap()` (the id/label TOKENS) fail closed over bound — `tokenRow` still reads
  base tables for the external id + the label gate, not yet source-routed. `valueMap(keys…)` composes.
- **`path` over bound — UNBUILT, not a wall.** The path channel is a stream fact like encounter/bulk
  (both now carried): seed it at the bound source, extend through bound movement (`extendPath` over the
  bound ids), and rejoin each path step's payload at framing (Mechanism-B per step). Moderate.
- **`properties()` over bound — LANDED (stream + value/key/element).** `GraphSource.propertyStream`
  explodes the landed `{t,v}` tree into the `PROP`-row shape (base tables over the base graph); `.value()`,
  `.key()`, `.element()`, and terminal VertexProperty framing (synthetic `owner:pk`) all compose. `.id()`
  (no landed `vpid`) and meta-properties fail closed — landed-DATA gaps the federate service closes by
  landing more (`vpid`/`meta`), NOT engine walls.
- **`properties()` / `valueMap()` over bound** — element-bag reads not yet routed through `GraphSource`
  (`propertyRelation`/`elementValueMap` scan base tables); `properties()` additionally has no landed
  identity (a detached VertexProperty has no rowid), so it is a genuine wall.
- **Bound WRITES** — a fetched subgraph is a read-only snapshot; writes decline.
- Mechanism B for the BASE leaf is already `source.leafPayload` (= `elementPayload`); no further work.

It supersedes the piecemeal bound-graph vocabulary that landed in `src/compiler/rel/foreign.ts` +
`detachedTail` (`docs/2026-08-21-barrier-substrate-design.md` §B, commits `a33bc26`…`d5064ae`): that work
is CORRECT and pinned the semantics, but it is a **second hand-written traversal vocabulary**, and this
plan retires it in favour of one vocabulary parameterised by a graph source.

## The problem

The traversal algebra (`movement`, `values`, `has`, `hasLabel`, `label`, `id`, `V()`/`E()`) is written
against the base graph's PHYSICAL schema — SQLite tables `nodes`/`edges`/`vertex_properties`/`labels`/
`vertex_labels`/`property_fts`. When a graph is INJECTED (a federate subgraph today; a local `subgraph()`
or `io()` import tomorrow) it arrives in a DIFFERENT physical shape — properties as an inline JSON `{t,v}`
tree, labels as JSON name arrays, edge labels as name strings, endpoints as ids. The base vocabulary's
SQL cannot read that shape, so a parallel vocabulary was hand-written over the JSON (`foreign.ts`:
`boundVertexMove`/`boundVertexHas`/`boundVertexHasLabel`/`foreignValues`/`endpointVertices`/`boundById`).

The result is exactly the smell: **every step taught the bound shape by hand**, one "slice" at a time,
and the bound graph is missing everything the base has (convergent-walk collapse, path tracking,
`order()`, `group()`, …). The vision — inject a graph from anywhere and the vocabulary just flows through
— requires the physical access to be an abstraction, not a hardcode.

## The abstraction

**`GraphSource`** — the interface the traversal ALGEBRA reads a graph through — with two implementations,
`BaseGraph` (SQLite tables) and `BoundGraph` (landed CTEs/JSON). It exposes the LOGICAL operations; each
impl emits its own physical SQL. Sketch (final column/return shapes settle in step 1):

```
interface GraphSource {
  // element sourcing
  vertices(fresh): Rel;                              // all vertices (col: id)
  edges(fresh): Rel;                                 // all edges (id, src, tgt, label)
  byId(kind: Elem, ids: readonly unknown[], fresh): Rel;   // V(ids)/E(ids)

  // adjacency — the vocabulary owns the JOIN; the source owns the edge relation + the label match
  adjacencyEdges(fresh): Rel;                        // the edge relation a hop joins
  edgeLabelMatch(labelCol: Expr, names: readonly string[]): Expr | null;

  // properties
  propertyRows(elem: Rel, kind: Elem, keys: readonly string[], fresh): Rel;   // (value, vtype[, key]) per element
  hasPropertyPredicate(elem: Rel, kind: Elem, key: string, match): Expr;      // has(k[,v/P]) as EXISTS

  // labels
  labelNames(elem: Rel, kind: Elem, fresh): Rel;     // (name) rows per element
  hasLabelPredicate(elem: Rel, kind: Elem, names: readonly string[]): Expr;
  labelScalar(elem: Rel, kind: Elem): Expr;          // label() — the first/only name

  // identity
  externalId(elem: Rel, kind: Elem): Expr;           // COALESCE(uid,id) base; the landed id bound
}
```

`BaseGraph` implements each with the CURRENT SQL (scan `nodes`/`edges`, `labelIds`, `propertyJoin`, …).
`BoundGraph` implements each with the landed CTE/JSON (bound vertices/edges CTE, `json_each` unnest,
`label IN (names)`). The vocabulary calls these primitives through a `GraphSource` threaded on `ChainCtx`
(`src/compiler/rel/lower.ts:254`), default `BaseGraph`; a subgraph segment sets `BoundGraph`.

## The load-bearing boundary decisions

- **Labels stay a PREDICATE the source supplies, never a forced name.** The base `edges.label` is an
  interned INT id inside the `e_out(src,label,tgt)`/`e_in(tgt,label,src)` covering indexes; forcing labels
  to names everywhere would add a `labels` join to every hop and deoptimise the base. So `edgeLabelMatch`
  returns the id-set subquery on the indexed column for `BaseGraph` (movement's seek is UNCHANGED) and
  `label IN (names)` for `BoundGraph`. The movement JOIN STRUCTURE (frontier ⋈ edges, `ordered: true`)
  stays in the vocabulary; only the edge relation + the label predicate come from the source.
- **Channels are orthogonal — they live on the STREAM, not the graph.** `bulk`/`encounter`/`path` are
  traverser facts threaded by the vocabulary; the base stream carries them, the landed stream currently
  carries none. `GraphSource` abstracts only the PHYSICAL ROWS, so once the vocabulary is source-
  parameterised the bound graph GAINS collapse/path/order for free — the improvement, not just a merge.
- **Leaf framing (Mechanism B) is STAGED, not in the first milestone.** Two physical-access mechanisms
  exist: Mechanism A is the traversal algebra above; Mechanism B is `src/compiler/plan/plan.ts` reading
  `nodes`/`vertex_properties`/`labels` to build the id/label/prop WIRE BAGS at terminal output. A bound
  element's leaf output already frames through the detached framing (the `foreign.ts` landed payload), so
  Mechanism B stays base-specific until a later milestone unifies it. The first milestone is Mechanism A.

## The site inventory (the map for the refactor)

Physical schema (`src/sql/schema.ts`): `nodes(id, uid)`; `edges(id, uid, src, label, tgt)` — **`label` an
INT id into `labels`, `src`/`tgt` node rowids**; `vertex_properties(id, node, key, value, vtype, meta)`;
`edge_properties(id, edge, key, value, vtype)` — no `meta`; `labels(id, name)`; `vertex_labels(node,
label)`; `property_fts(owner_elem, pid, owner, pk, kind, text)`. Covering indexes `e_out`/`e_in` + the FTS
DDL live in `src/storage.ts`.

**Mechanism A — traversal algebra (`src/compiler/rel/*`), the first-milestone surface:**
- **Movement / adjacency — one chokepoint:** `movement()` `lower.ts:1159`; `HOPS` `lower.ts:1128`; the
  `edges` scan `lower.ts:1184`; the `ordered` seek `lower.ts:1206`; the label restriction call
  `lower.ts:1190`. Called from `lower.ts:328` (correlated child), `:4683` (element tail), `:7409`
  (reducing child body). Endpoint reads that bypass it: `edgeEndpoint()` `element.ts:112`.
- **Element sourcing — one chokepoint:** `elementScan()` `lower.ts:967` (`V()`/`E()`/`V(ids)`/`E(ids)`,
  numeric→`id`, string→`uid`). Re-source (non-start `V()`/`E()`) `lower.ts:1023`.
- **Labels — `name→id` chokepoint `labelIds()` `build.ts:330`; arg normaliser `labelSetArgs()`
  `build.ts:307`.** Scattered readers: `hasLabelClause()` `lower.ts:842`; `hasTokenClause()`
  `lower.ts:917` (`has(T.label/T.id)`); `by(T.label)` `modulator.ts:280-311`; `labels()` fan-out
  `lower.ts:2208`; `label()` payload `element.ts:68/89`; `labelled()` `map.ts:1099`.
- **Properties — `propertyJoin()` `property.ts:62` is the `values`/`properties` chokepoint.** Scattered:
  `hasPropertyClause()` `lower.ts:880` (`has(k[,v])` EXISTS); element bag framing `element.ts:147/184`;
  the `PROPERTIES` owner map `build.ts:148`. Fast paths (physical rewrites over finished algebra):
  `indexSeek` `semijoin.ts:193`, `trigramSeek` `semijoin.ts:242` (+ `SEEK_PROPERTIES` `semijoin.ts:162`).

**Mechanism B — leaf framing (`src/compiler/plan/plan.ts`), a LATER milestone:** label builders
`plan.ts:37-135`; property readers `plan.ts:848-953`; `elemTable()` `plan.ts:541`; `sqlElem()`
`plan.ts:527`; external-id `extIdOf()` `plan.ts:644`; element payload `elementPayload()` `plan.ts:664`.

**The existing BoundGraph (to fold in, then delete as a standalone twin):** `src/compiler/rel/foreign.ts`
— `foreignRelation()` `:60`, `boundVertexMove()` `:237`, `endpointVertices()` `:133`, `foreignValues()`
`:316`, `boundVertexHas()` `:189`, `boundVertexHasLabel()` `:214`, `boundById()` `:205`, plus the
`detachedTail` arms in `lower.ts` that dispatch them.

## The incremental, census-invariant plan

Safe to do step-by-step because the CENSUS (answer-invariance) + L2 SQL snapshots + `rel-sweep` gate every
step. The base graph's SQL stays semantically identical until step 4. `bash scripts/ci.sh` (grep the
`CI: PASS`/`CI: FAIL` verdict line, never the pipeline exit code) after each step; commit + push when green.

1. **Define `GraphSource` + `BaseGraph`; thread it on `ChainCtx` (default `BaseGraph`).** No behaviour
   change — `BaseGraph`'s methods are the current SQL, called from the same sites. Pure plumbing.
2. **Reroute the Mechanism-A chokepoints through `BaseGraph`, ONE at a time**, each a behaviour-preserving
   refactor (census-invariant, ci-green, answer-identical): `movement` → `values`/`has` → labels
   (`labelIds`/`hasLabelClause`/`hasTokenClause`/`labels()`/`by(T.label)`) → `elementScan`. This alone is a
   real cleanup: it centralises the scattered physical access the inventory found.
3. **Add `BoundGraph`** — the `foreign.ts` logic, re-expressed as a `GraphSource` implementation of the
   SAME interface (landed CTEs + `json_each`; `label IN (names)`; landed id as `externalId`).
4. **Point the subgraph tail at `BoundGraph` and DELETE the `detachedTail`/`foreign.ts` twin.** The one
   vocabulary now flows over the injected graph — and the bound graph gains collapse/path/order/group for
   free (verify each against the sibling's own traversal, as the current bound tests do).
5. **(Later milestone) Mechanism B — unify leaf framing** so a bound element frames through the same seam
   (`plan.ts`), retiring the detached framing. Not required for flow-through; staged deliberately.

## What is deferred / open

- **Mechanism B unification** (step 5) — leaf framing over a bound element. The detached framing covers it
  until then.
- **FTS / `trigramSeek` over a bound graph** — the base FTS index does not exist for a landed subgraph, so
  `has(containing…)` over a bound graph would be a linear JSON scan (or a decline). Decide when reached.
## The bound-stream model — LOCKED to id-carry + rejoin (2026-08-22)

Confirmed against BOTH vendored references (prior-art check requested by the user):

- **TinkerPop = model (A), id-carry.** The handle is `id` (`GraphStep.convertElementsToIds` downgrades any
  element to `.id()`, `vendor/tinkerpop/gremlin-core/.../step/map/GraphStep.java:183-190`); movement
  re-reads the live graph (`VertexStep.flatMap` → `traverser.get().vertices(dir,labels)`,
  `.../step/map/VertexStep.java:71-75`); re-attach = re-fetch by id (`Attachable.getVertex` =
  `hostGraph.vertices(id)`, `.../structure/util/Attachable.java:183-186`). Payload-carry is exactly
  TinkerPop's **detached/inert** form — `DetachedVertex` carries a property snapshot but its
  `edges()`/`vertices()` return empty and it is doc'd *"not traversable"*
  (`.../structure/util/detached/DetachedVertex.java:46-47,163-171`). A subgraph is a FILTER decoration over
  a normal structure-reading traversal (`.../strategy/decoration/SubgraphStrategy.java:104-115`), not a
  detached bag.
- **Calcite = model (A).** Source binds ONLY at the leaf (`RelOptTable`; every other node's
  `getTable()==null`, `vendor/calcite/core/.../plan/RelOptTable.java` + `.../rel/AbstractRelNode.java:319-321`);
  columns re-derived by ordinal `RexInputRef`, never carried (`.../rel/core/TableScan.java:112-114`;
  `rel2sql` renders `FROM <source>`, `.../rel/rel2sql/RelToSqlConverter.java:958-974`); correlated re-fetch =
  `Correlate` join keyed by a column bitset (`.../rel/core/Correlate.java:47-57`). Payload-carry has NO analog.
- **The perf con is dissolved by Calcite's planner move:** repeated re-fetch of the same derived relation is
  a MATERIALIZATION concern (`RelOptMaterialization` swaps the leaf scan; Spool-to-table), NOT a reason to
  carry payload. So **materialize the landed relation ONCE** (one CTE referenced N times) rather than
  re-exploding the JSON literal per rejoin.

Why it fits us: the `GraphSource` interface (Steps 1-2) is id-carry BY CONSTRUCTION — predicates correlate
on `id`, `propertyValues` takes an id-bearing input — so payload-carry never fit it; keeping payload-carry
= keeping `foreign.ts` as a permanent second vocabulary, which this plan retires.

**Obligation:** id-carry drops payload mid-stream, so the LEAF framing (a bound element → wire) must REJOIN
the landed CTE for id/label/props (**Mechanism B**) — under pure id-carry it can NOT stay deferred. Net for
the rewrite = the element-terminal subgraph tests in `test/federation.test.ts` (added 2026-08-22) +
`test/cloudflare*.test.ts` (green Bun ci is not sufficient for this DO-boundary path).

**`detachedTail` stays as a thin bound ORCHESTRATOR — it is NOT replaced by `elementTail`.** A real
semantic difference forces this: the federate-subgraph `.V()`/`.E()` **RE-ROOT** a fresh traversal at the
injected graph (`sg.traversal().V()` — discards the incoming stream; `federation.test` `.V().values(name)`
== the DISTINCT subgraph vertices), whereas base mid-traversal `.V()` is `GraphStep` (a cross-join that
KEEPS the stream). So `elementTail`/`reSource` semantics are wrong for a bound `.V()`. `detachedTail` keeps
the re-root + terminal-leaf logic and routes every OTHER step (movement, `has`/`hasLabel`, `values`,
`id`/`label`) through the SHARED builders with `ctx.source = BoundGraph` — which is what deletes the
`foreign.ts` twins. The "one vocabulary" is the shared builders reached through the source; the bound
orchestrator loop remains because its source-position semantics genuinely differ from base.

- **The label-id remapping for a bound graph** — `BoundGraph.edgeLabelMatch` is `label IN (names)` (no id
  table), so there is nothing to remap; the base keeps its id-set. This is why the boundary is a predicate,
  not a shared representation.
- **Naming** — `GraphSource` vs `GraphAccess`; `BaseGraph`/`BoundGraph` vs `TableGraph`/`LandedGraph`.
  Settle in step 1 per the root `CLAUDE.md` naming rule (compiler words for machinery).

## References

- The bound-graph vocabulary this retires: `docs/2026-08-21-barrier-substrate-design.md` §B; `foreign.ts`.
- Why there is no temp-table substrate B (a landed subgraph is CTEs): same doc §(B), measured in
  `test/cf-probe/substrate-b.probe.ts`.
- Prior art for "traverse an injected graph": TinkerPop `sg.traversal()`, SPARQL `SERVICE`+`CONSTRUCT`
  then query / `GRAPH ?g`, Neo4j GDS graph projection.
