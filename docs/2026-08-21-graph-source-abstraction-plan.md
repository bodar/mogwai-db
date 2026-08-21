# GraphSource — one traversal vocabulary over two graph shapes (PLAN)

**Status: PLAN, not yet built.** This is the plan of record for the next run. Nothing here is on trunk
yet. It supersedes the piecemeal bound-graph vocabulary that landed in `src/compiler/rel/foreign.ts` +
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
