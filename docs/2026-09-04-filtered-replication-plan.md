# Filtered replication + placement — design + plan

_Settled design (not a changelog) for **filtered replication** — replicating a **subgraph** of a source
into a target, and choosing **where it attaches** in the target. Companion to
`docs/archive/2026-09-02-replication-and-http-interop-plan.md` (the replication substrate; §-refs below point into
it). The authority is the code; CouchDB claims cite the vendored source at the pin
(`vendor/couchdb/...`). Governing rule inherited from the parent plan (§4): **follow CouchDB; deviate only
when empirically better or graph-forced** — filtered replication has two graph-forced additions CouchDB
has no analog for (placement, and weak references), because a graph has structure a flat document store
does not._

Two knobs on a replication job, both optional, both plain Gremlin, and beautifully symmetric:

1. **`filter`** — a source-side selector traversal: *which subgraph* do I pull?
2. **`placement`** — a target-side write traversal: *where* does it attach once it lands?

---

## §1. What it is, and why

CouchDB replicates a **subset** three ways (`vendor/couchdb/src/docs/src/replication/intro.rst:104`):
`doc_ids`, a **`selector`** (a declarative Mango query — the efficient, recommended one), or a JS
`filterfun`. The filter runs **on the source**, so a peer pulls only its slice. The mogwai analog: the
filter is a **captured Gremlin vertex-selector traversal** (Gremlin *is* our query language, so it is the
natural equivalent of Mango, and it compiles to SQL like everything else). Stored in
`replication_config.filter` (already a column, §9·2 of the parent plan).

Why you want it:
- **Edge / browser replicas.** A DO graph is up to 10 GB; a browser isolate is ~128 MB. You want the
  *working subset* in a tab, not the whole graph — the direct payoff for "pull from Cloudflare into a local
  tab." Same for a phone or an embedded device.
- **Multitenancy / sharding within one graph** — replicate one tenant's or region's subgraph out.
- **Privacy / authorization** — the filter runs on the *source*, so it is an enforcement boundary: a peer
  physically cannot pull what the selector excludes.
- **Bandwidth / cost** — ship and store less.
- **Agent memory** — an agent syncs only the slice of the memory graph relevant to it.

**The graph-forced twist CouchDB can't have:** documents are independent, so a filtered subset is trivially
a valid DB. **A graph is joins** — an edge references two vertices — so a filtered vertex set has edges that
reach *outside* the set, which would dangle. We reuse the never-dangle rule (parent §6·3): an edge is an
existence-claim, so a boundary edge pulls its endpoint in. A filtered pull therefore yields a **1-hop
edge-closed subgraph** — the selected vertices *plus* the endpoints their edges reach — valid by
construction. Filtering *composes* with referential integrity rather than fighting it.

---

## §2. `filter` — the source-side selector

- **An arbitrary traversal, validated by RUN-ON-SAVE (not static analysis).** The filter may be any
  traversal; we do not statically analyse its leaf. When a config with a `filter` is saved, we **execute it
  against the source** (bounded — a `.limit(k)` probe) and confirm its terminal is a **vertex stream**. If it
  errors, or yields scalars/edges/nothing, the save is **rejected** with a clear message — fail-closed at
  save, so a broken filter never becomes a silently-wrong replication. It costs nothing extra at run time
  (the filter runs on the source every pass regardless); save just runs it once eagerly. For a *pull* the
  source is remote, so the trial-run goes over the peer — the same mechanism the replication uses.
  (Static leaf-analysis was considered and rejected: a tar pit for arbitrary traversals, and "run it and
  look" is this project's empirical spirit.)
- **1-hop edge-closure, never transitive.** Matched vertices + the immediate endpoints their edges reach.
  Transitive closure would let one matched vertex drag in the whole graph.
- **Dynamic, never-prune — on the MATCH dimension only.** The filter is re-run every pass; whatever it
  matches *now* is pulled/refreshed. An element that *stops matching* (but is still alive on the source)
  **stays** in the replica (frozen at its last-synced value; resumes updating if it re-matches). We never
  prune on the match dimension. *This is distinct from deletion* — see §4.
- **Consequence to write filters around:** for a *live* monitoring view, filter on something stable
  (`assignee = dan`) and let the volatile property (`status`) ride along, rather than filtering on the
  volatile property — else a no-longer-matching item freezes stale.

---

## §3. `placement` — the target-side attach (why C, not a built-in mount)

Once a subgraph lands, by default it is just *present* — addressable by `g.V(gid)` or by its own
labels/properties, floating alongside whatever else is in the target. That is fine for a dedicated replica.
**Placement** is the optional target-side traversal that grafts it into pre-existing target structure —
the symmetric partner of `filter` (`filter` produces a match set on the source; `placement` consumes it on
the target).

**We chose the explicit placement traversal (option "C") over a built-in "mount under vertex M" (option
"A").** A is a *special case* of C (`inject(matches).mergeE(...).from(V(M))`), so building the general,
idiomatic thing once gives A as a one-liner — the compounding-substrate move, and the same pattern that made
federation's `as()`/`select()` (`inject($map)`) beautiful. A-as-a-primitive would also have to invent
answers for "what are the roots?" and "how do local mount edges behave" that C makes the author state
explicitly. (Option "B", an origin-namespace/provenance channel, is **out** — we deleted exactly that
channel in favour of gids; not coming back.)

- **The arrival reference = the filter's CURRENT match set** (empirically derived, not "the delta this
  pass"). Traced across passes: a delta-only input leaves an element **orphaned** if a pass crashes after
  import but before placement; running placement over the *whole current match set* every pass, idempotently,
  **self-heals** that and re-affirms on every pass. So placement is a **convergence step**, exactly like the
  rest of replication (revs_diff avoids re-sending bodies; `mergeE` avoids re-creating edges). Duplicates
  disappear as a natural consequence rather than something to fight.
- **Steer to `mergeE` (idempotent upsert).** A naive `addE` placement duplicates every pass; we document
  placement must be idempotent and give `mergeE` examples. We do not (cannot) enforce it for arbitrary
  Gremlin — the safety net is undo (§6), not static proof.

```
filter    (source): g.V().hasLabel('task').has('assignee','dan').has('status','open')
placement (target): inject(<current matches>).mergeE([label:'inbox_holds', from: V('inbox')])
```

---

## §4. Deletes always propagate — never-prune is match-only

**A source delete removes the element from the replica.** Never-prune (§2) is about the *match predicate*,
NOT about deletion — two distinct fates:
- Still alive on the source but **stops matching** → **stays** in the replica (frozen). Never-prune.
- Genuinely **deleted** on the source → its **tombstone replicates** → the target deletes it. Core
  replication (parent Phases 2 & 4); filtering must not break it.

So the filtered feed carries **tombstones**, not just live matches (simplest correct form: ship all
tombstones since the cursor alongside the filtered live set — `applyDeletes` is a no-op for a gid the target
does not hold, so out-of-scope deletes cost a tiny row; scoping tombstones to held gids is a later
optimization). A boundary vertex pulled in by 1-hop closure gets its delete the same way.

---

## §5. Weak references — the placement/delete interaction

A synthesized **placement edge** must not out-vote a real delete. If `inbox → x1` is a placement edge and
the source deletes `x1`, the parent §6·3 resurrect rule ("a live edge referencing V is an existence-claim →
resurrect V") would wrongly veto the delete and keep `x1` in the inbox forever. The fix is a clean, general
distinction that also sharpens the *existing* resurrect rule:

- **Strong reference** — a replicated or user-created edge. A genuine existence claim: it **pins** its
  endpoint (resurrect on a racing delete, parent §6·3).
- **Weak reference** — a placement-synthesized edge. A decoration: it **does not pin**; on a delete of its
  endpoint it **cascades** (is removed) instead of resurrecting.

Mechanism: a hidden `~`-property on the synthesized edge (reusing TinkerPop's `~` hidden-marker convention +
our `edge_properties`) tags it weak. **Weak ≠ invisible** — the mount edge is a normal, traversable edge
(`g.V('inbox').out('inbox_holds')` must work); "weak" governs only the delete/resurrect branch.

**Weakness is LOCAL to the synthesizing graph; the marker does NOT travel.** This was the subtle one, and
the reasoning is worth keeping (it is why there is no "propagate/strip the marker" rule):

- The synthetic edge exists only in the graph that ran the placement (M). The source (A) never heard of it.
- **At M** — A deletes `x1` → M must delete it, but `inbox→x1` has *no incoming tombstone* (A can't tombstone
  an edge it doesn't know about). This is the *only* place the resurrect-vs-cascade question is even asked,
  and the weak marker answers it: cascade (and tombstone) the edge, don't resurrect.
- **Downstream (a replica B of M)** — B receives tombstones for *both* `x1` and `inbox→x1` (M cascaded and
  tombstoned the edge). With edges-before-vertices delete ordering, B removes the edge then the vertex; no
  live edge references `x1` at delete time, so resurrect never fires. **B never needs to know the edge was
  weak.** So the marker need not travel (and need not be stripped — whether it rides along is immaterial to
  correctness).

The genuinely-related reuse (kept narrow — this is *edge reference* semantics, not a theory of everything):
the resurrect rule becomes an *explicit* strong/weak split rather than an implicit "all edges strong", and
federation's *detached* foreign element (parent `foreign.ts`, "inert / not-traversable") is conceptually a
weak reference into another graph. Derived *values* (OLAP scores, decorations) are **not** references and
are deliberately out of this abstraction — they are "snapshot-on-replicate," a different idea.

---

## §6. Save + undo instead of static validation

- **Save runs the first pass immediately** and returns the result (what matched, what landed). No pre-flight
  proof of an arbitrary write traversal.
- **Undo is the safety net** for a placement that is *valid but wrong* (the case static analysis can never
  catch). The clean split:
  - **Dedicated target (the common case)** — a filtered replica is almost always a *fresh* graph, so
    everything replication does is additive; undo is free (`DELETE /gremlin/{target}`, or delete everything
    the replication created).
  - **Shared target** — placement/import can mutate pre-existing elements, so undo needs **before-images**.
    The rev-tree stores rev *ancestry* (hashes), not old *bodies*, so the concrete form of "use the
    revisions" is a bounded **write journal per replication** (`{replication_id, gid, op, prev_body?}`) —
    the shadow-store pattern (parent §6·3) pointed at replication provenance. Undo walks it: delete-created,
    restore-superseded. Deferred until shared-target replication is real.

---

## §7. The corner cases, resolved

- **Placement edge vs a replicated delete** — weak reference (§5): cascade, don't resurrect.
- **Weak edge on a downstream replica** — no special handling; the explicit edge tombstone + delete ordering
  make it a normal delete (§5).
- **Placement crashes mid-pass** — arrival = current match set + idempotent placement → next pass
  self-heals (§3).
- **Non-idempotent placement (`addE`)** — the *only* source of duplicates; steer to `mergeE`, and undo is
  the net (§6).
- **An element stops matching vs is deleted** — two distinct fates, cleanly separated (§4).

---

## §8. Schema + config

`replication_config` already carries `filter TEXT` (parent §9·2). Add **`placement TEXT`** (the target-side
traversal). Both optional; both validated at save (filter: trial-run yields vertices; placement: run the
first pass and surface the result). No other schema change — placement's weak edges are ordinary
`edges`/`edge_properties` rows with a `~`-marker.

---

## §9. Phased plan

Each phase independently valuable, lands green before the next (the parent plan's discipline).

- **F1 — filtered `_changes` + 1-hop closure + save validation.** The source evaluates the captured selector
  to a match set and restricts the feed to (matches + 1-hop endpoint closure), still shipping tombstones
  (§4); `runReplication` passes the filter through; save trial-runs the filter (must yield vertices).
  *Gate: a filtered pull yields a valid edge-closed subgraph; deletes still propagate; a non-vertex filter
  is rejected at save.*
  - ✅ **F1a — the source-side filtered feed.** `Executor.filterVertexIds(gremlin)` runs the captured
    selector and returns the matched vertices' external ids, failing closed unless it is a READ yielding a
    VERTEX stream (the one check that is both the run-time contract and the save-time validation, §2).
    `changesFeed(store, since, limit, match?)` closes the 1-hop subgraph (matched vertices + incident edges
    + boundary endpoints) via a `matched`/`incident`/`closure` CTE seeded by one `json_each` bind (external
    ids resolved to rowids, type-safe by `COALESCE`'s NONE affinity), while ALL tombstones still ship (§4).
    The `filter` threads through the `changes` seam on every runtime and through `Peer.changes`; `_changes`
    accepts it as a GET `?filter=` OR a POST body (a captured traversal is arbitrary-length, so `remotePeer`
    POSTs it), a non-vertex filter failing closed as a 400. `test/replicate-filter.test.ts`.
  - ✅ **F1b — wire the config `filter` into `runReplication`.** `runReplicationPass`/`runReplication`
    take a `filter`, re-evaluated every pass (dynamic/never-prune) and passed to `source.changes`;
    `ReplicateOptions.filter` threads it through the one-shot `_replicate` and `replicateWith`; the
    scheduler's `runJob` passes `config.filter`, so a persistent config now restricts what it replicates.
  - **F1c — save-time validation.** *(next)* `handleReplicator` trial-runs the filter (bounded) against the
    source peer and rejects a non-vertex/erroring one at save.
- **F2 — placement + weak references.** The optional `placement` traversal, run each pass over the current
  match set (idempotent); synthesized edges marked weak (`~`); the delete path consults weak/strong
  (cascade vs resurrect). *Gate: a placement grafts the subgraph idempotently (no duplicates on re-run,
  self-heals a skipped pass); a deleted endpoint cascades its weak mount instead of resurrecting.*
- **F3 — undo.** Dedicated-target undo (destroy / delete-by-provenance) first; the shared-target
  before-image journal when shared-target replication lands.

---

## §10. Related engine items this design surfaced (NOT filtered-replication proper)

Captured here so they are not lost; each is its own small piece of work against the *existing* engine.

1. **Cascade-on-apply tombstones (a revision to parent Phase 2b).** Today a vertex drop tombstones the
   vertex **and every incident edge** (degree N → N+1 tombstones). Because deleting a vertex
   *deterministically* implies its incident edges are gone, a replica can **cascade locally** from a single
   vertex tombstone — deleting the vertex and its incident edges, with **weak** ones cascading and a
   **strong concurrent-peer-add** edge still resurrecting (§5). This is **O(1) tombstones per vertex-drop**
   regardless of degree, and it is the *same* local-cascade the weak-edge story already requires — so the two
   unify. Edge-only drops still ship an edge tombstone (no vertex to cascade from). A genuine multi-element
   subgraph delete still costs one tombstone *per vertex deleted* (per-element identity is unavoidable), but
   not per edge. Filtered replication (with weak placement edges) is the forcing function that makes
   cascade-on-apply necessary anyway.

2. **Export vs native snapshot (an io()-subsystem distinction).** Interop formats (CSV, vanilla GraphSON)
   are **live-only and lossy by design** — they carry graph *data* for other tools and cannot/should not
   carry meta (a tombstone is not a vertex/edge; CSV is not ours to extend). A **faithful backup**
   (restore-and-keep-replicating) is a **native whole-DB snapshot** — a mogwai-owned artifact where a
   tombstone is just another table row (all tables: nodes/edges/properties/labels/tombstones/update_seq/
   conflicts/checkpoints; `barrier_state` excluded as intra-request scratch). So "carries across every seam"
   is a property of *continuation* seams (replication — already does; native snapshot — a row like any
   other), NOT of interop export. The gap worth closing: today an io() GraphSON/CSV round-trip loses
   tombstones, so a restore-and-re-replicate could resurrect deletes — the fix is a native snapshot format,
   *not* stuffing meta into a format we don't own.

3. **Tombstone purge — WITHDRAWN, not supported.** CouchDB's `_purge` is explicitly unsafe (a behind replica
   silently keeps a deleted doc). It *could* be made safe (record a `purged_up_to` horizon; refuse an
   incremental feed below it → force a too-far-behind puller into a full rebuild; a fresh `since=0` replica is
   always safe) — but that is a pile of caveats around a dangerous operation (an operator must choose the
   horizon; a straggler pays a full rebuild), for little gain: **cascade-on-apply (item 1) makes a vertex drop
   O(1) tombstones, tombstones are tiny (~40 bytes), and deletes are infrequent** (read≫write, parent §6·4).
   So tombstones are **kept forever** and purge is **not implemented** (this closes the parent plan's Phase 6
   by withdrawal). Recorded here so it is not re-proposed: the safe design exists, but the caveat-to-value
   ratio does not justify it.

---

## §11. Decisions — locked

- **`filter`** = arbitrary traversal, validated by run-on-save (must yield vertices), 1-hop edge-closed,
  dynamic/never-prune on the match dimension (§2).
- **Deletes always propagate** via tombstones; never-prune is match-only (§4).
- **`placement`** = optional target-side idempotent write traversal (option C), run each pass over the
  current match set (a convergence step); steer to `mergeE` (§3). A/B rejected.
- **Weak references** = synthesized placement edges don't pin their endpoint (cascade, not resurrect);
  **local to the synthesizing graph, marker does not travel** (§5). Strong = replicated/user edges.
- **Save + undo**, not static analysis; undo free for dedicated targets, a before-image journal for shared
  (§6).
- **Schema** = add `placement TEXT` to `replication_config` (§8).
- **Related (separate work):** cascade-on-apply tombstones, export-vs-native-snapshot (§10). Tombstone purge
  is WITHDRAWN — not supported (§10·3).
