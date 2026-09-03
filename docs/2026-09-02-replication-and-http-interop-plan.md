# Replication, and mogwai as an HTTP client of another graph — design + plan

_Design doc AND phased plan. This is not a changelog and not a commitment to build tomorrow — it records
what a CouchDB-grade replication experience WOULD take on top of what we already have, where the genuine
design choices are, and the order to build in. The authority is the code; where this cites CouchDB or
prior art it cites the canonical source so the claim is checkable. The one decision this doc deliberately
does NOT foreclose is the change-detection model (§5) — that is a discussion, and the doc's job is to make
it a well-shaped one, not to pick for you._

Two features share one foundation and so share one doc:

1. **Replication** — the CouchDB developer experience: point a local graph at a remote one over HTTP and
   pull it down (or push it up), incrementally, resumably, in a direction you control. Debug a production
   graph on your laptop by syncing it, through a single URL.
2. **External-HTTP federation** — `federate()` today crosses to a sibling graph over Durable Object RPC
   (`src/services/catalog/federate.ts`). The same seam can reach an *external* TinkerPop graph server over
   HTTP.

The foundation both need is the one thing mogwai has never been: **an outbound HTTP client of another
graph.** Today mogwai is only ever a server. Build the client once and both features stand on it.

---

## §1. The experience we are chasing, and why it does not exist yet

CouchDB's replication DX is justly loved: `POST /_replicate {"source": "...url...", "target": "...url..."}`
and you are done. Push and pull are the same operation with the endpoints swapped. It survives
disconnection, resumes from where it stopped, and never silently loses a write. The canonical description
is worth reading in full — the "Is it like Git?" essay
([couchdb replication/conflicts, "What is the CouchDB replication protocol?"](https://docs.couchdb.org/en/stable/replication/conflicts.html)):

> A replicator simply connects to two DBs as a client, then reads from one and writes to the other. …
> CouchDB has no way of knowing who is a normal client and who is a replicator … It all looks like client
> connections. Some of them read records. Some of them write records.

**This DX does not exist for graph databases.** The prior-art sweep (§3) is unambiguous: every mainstream
property-graph database does replication as *intra-cluster* consensus (Raft) plus async read-replica
log-shipping. Where a change feed exists, the vendor disclaims replication with it — Neo4j states its CDC
"is not the right tool to create an exact copy of a Neo4j database"
([Neo4j CDC intro](https://neo4j.com/docs/cdc/current/)). The one vendor that built cross-deployment async
logical replication (ArangoDB DC2DC) *retired* it. The only genuinely CouchDB-like graph system, GUN.js,
buys the DX by giving up rich querying and resolving conflicts at the key/value level, beneath the
graph-structural invariants a Gremlin-over-SQL engine must protect
([GUN conflict resolution](https://github.com/amark/gun/wiki/Conflict-Resolution-with-Guns)).

So this is whitespace: **"point a URL at a remote graph and pull it, independent of any cluster, over
HTTP" is a first-class feature no serious graph query engine offers.** It is also a natural fit for our
substrate — one graph is one Durable Object, addressed by a URL already (`/gremlin/{g}`), created on first
access, torn down idempotently. A DO *is* a standalone, independently-addressable graph. That is exactly
the topology CouchDB replication assumes and Neo4j's cluster model forbids.

---

## §2. The platform envelope — LAW, do not re-derive

**Replication for mogwai must be LOGICAL (graph elements over HTTP), never physical (storage/WAL). This is
forced, not chosen.** On Cloudflare Durable Objects we get `ctx.storage.sql` — a synchronous, sandboxed,
SQL-only surface — and nothing beneath it. Every physical-replication mechanism needs a hook we do not
have:

| Mechanism | Needs | Available to us on DO? |
|---|---|---|
| Litestream | direct `-wal` file access + checkpoint control | No — no filesystem ([litestream how-it-works](https://litestream.io/how-it-works/)) |
| LiteFS | a FUSE mount interposed on SQLite's file I/O | No — no filesystem ([LiteFS architecture](https://github.com/superfly/litefs/blob/main/docs/ARCHITECTURE.md)) |
| dqlite | a custom VFS compiled into SQLite | No — no native extensions ([dqlite replication](https://canonical.com/dqlite/docs/explanation/replication)) |
| Turso/libSQL embedded replicas | a WAL-frame client/server below SQL | No — same |
| cr-sqlite | a **loadable** native extension | No — DO enables only FTS5/JSON/math; loadable extensions unsupported ([workerd#6878](https://github.com/cloudflare/workerd/issues/6878)) |
| SQLite session extension (changesets) | the compiled-in `sqlite3session_*` C API | **Bun yes, DO no** — asymmetric, so unusable as the shared mechanism ([Bun Session](https://bun.com/reference/node/sqlite/Session), [DO SQL API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)) |
| Cloudflare's own DO WAL replication (PITR, read-replicas) | it exists — but is platform-internal | No hook — the same sandbox boundary that gives Cloudflare its exclusivity walls it off from us ([sqlite-in-DO](https://blog.cloudflare.com/sqlite-in-durable-objects/)) |

The session extension is the sharpest trap: it is right there in `bun:sqlite`, so a dev-only prototype
would work and then be impossible to ship. **A mechanism that is not present on BOTH runtimes is not a
mechanism** (this is the same discipline `src/cf-limits.ts` enforces for binds).

What the constraint LEAVES is exactly the logical model, and two production systems validate it from
different angles: **rqlite** proves that replicating the *deterministic operation* (not storage bytes)
through an ordinary SQL path is production-grade ([rqlite FAQ](https://rqlite.io/docs/faq/)); **cr-sqlite**
proves a per-row/per-column logical-clock changes-table, merged by ordinary `SELECT`/`INSERT`, is a
production-grade *conflict* strategy ([cr-sqlite](https://github.com/vlcn-io/cr-sqlite)) — and it needs
nothing a plain `sql.exec()` cannot do. We re-implement the *model*, in application code, on plain SQL.
That is not a compromise imposed on us; it is precisely why lifting CouchDB's *logical* protocol is the
correct instinct.

---

## §3. Prior art — where everyone else landed, and the one line worth stealing from each

Full citations in the research appendix (§13). The landscape, along one axis — *can two independently-run
instances, not members of one live cluster, be pointed at each other and synced, tolerating
disconnection?*:

- **Neo4j** — Raft among core servers (synchronous), transaction-log shipping to read replicas
  (asynchronous), both strictly intra-cluster. No independent-instance sync. Its **catchup protocol** is
  two-tier — incremental log-ship when the gap is small, **fall back to a full store copy** when the gap
  exceeds retained history — but that split is a *retention artifact*: Neo4j's transaction log rotates, so a
  far-behind replica can't be served incrementally. We deliberately do NOT copy this (§7): keeping the by-seq
  feed current-state-sized (§5·3) means `since=0` is always a valid full sync, so one mechanism covers both
  cases. Its **bookmarks** (a write returns a token; a read can block until a replica has caught up to it)
  are a clean causal read-your-writes primitive worth stealing. Neo4j **CDC** is a cursor feed
  (`db.cdc.current` / `db.cdc.query(since, selectors)`) but is explicitly *not for making an exact copy*.
- **Dgraph** — Raft per predicate-shard. Predicate-as-shard-key is an interesting *sharding* axis, nothing
  new for async logical replication.
- **JanusGraph** — has no replication of its own; delegates to the storage backend (Cassandra). This is
  the option we structurally *cannot* take — there is no storage seam below us to delegate to. Worth
  stating precisely because it is the reflex answer ("just let the store replicate") and it is unavailable.
- **TigerGraph / Neptune** — async cross-region via Kafka-mirrored change log (TigerGraph CRR) or
  storage-layer volume replication + a CDC stream (Neptune). Neptune Streams is the one case a vendor
  *does* reuse its change feed as the replication payload — but only inside AWS-managed infrastructure.
- **ArangoDB** — Active Failover (async, read-only followers pulling the leader's WAL). DC2DC, the one
  cross-cluster async logical option, was **removed in 3.12** — a cautionary data point on the cost of
  maintaining exactly this.
- **FalkorDB/RedisGraph** — Redis primary/replica; ships *effects*, not query replay. The universal
  principle: **ship the materialized mutation, never re-execute the query on the far side.**
- **GUN.js** — the only real CouchDB-like graph sync (CRDT/HAM, multi-master, offline). Proves the *DX
  category* is achievable; its trade-offs (no rich query engine, conflict resolution below graph
  invariants) are exactly what we will not accept, which is what makes this hard rather than solved.

The synthesis: mainstream graph DBs converge on Raft + async read-replica log-shipping, sometimes with a
CDC feed *deliberately scoped to feed other systems*; the one cross-deployment logical attempt was
withdrawn; and the CouchDB DX shows up only in a CRDT-first system that is not in our class of engine. The
gap is real.

---

## §4. What ports from CouchDB, and the one thing that inverts

The transferable core of CouchDB is **five primitives**, none of which is the document data model
([couchdb replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html)):

1. A **monotonic change sequence** — `_changes?since=<seq>`, an *opaque* cursor over write history
   (CouchDB is explicit: the seq "MUST be incremental, but MAY NOT always be an integer" — never parse it).
2. A **cheap "what are you missing?" diff** — `POST /_revs_diff {id: [rev,…]}` → the subset the target
   lacks. A pure key lookup that never touches a body. *This is the efficiency engine.*
3. A **resumable checkpoint** — a deterministic replication-id keyed to the config, stored in a
   non-replicated `_local/{id}` doc; both peers record it, and resume from the latest *common* session.
4. **Direction-agnostic roles** — source is read-from, target is written-to; push = pull with the roles
   swapped; the replicator is just an HTTP client of both.
5. **Idempotent replay** — `_bulk_docs {new_edits:false}` writes documents at their stated rev, so
   re-running a batch is a no-op.

**The one thing that does NOT port is the reason CouchDB's replicator is "trivial."** From the essay
again: *"Every record in CouchDB is completely independent of all others. That sucks if you want to do a
JOIN or a transaction, but it's awesome if you want to write a replicator. Just figure out how to
replicate one record, and then repeat that for each record."*

A graph is nothing *but* joins. An edge is a join made durable — it references two vertices by identity. So
the graph *inverts* CouchDB's founding assumption, and that inversion is where every graph-specific hard
part in §6 comes from: you cannot replicate one element in isolation, order does not commute (an edge
needs its endpoints first), a "conflict" can violate a structural invariant rather than just fork a
value, and deletion has referential consequences. The five primitives port; the triviality does not.

**Governing principle (LAW): CouchDB is the gold standard; we deviate ONLY when we can empirically do
better, or when graph semantics force it.** "Simpler for us" is not a licence — it is the reasoning that
produced a wrong first cut here (a discard-LWW conflict model, since corrected). Measured against this
principle the whole design has exactly a handful of justified deviations, each recorded at its section: the
**64-bit integer id** (§6·1 — *empirically better*: integer joins keep the covering indexes index-only,
which we measured; and even it borrows CouchDB's `sequential` prefix+counter shape); the **transfer
ordering** vertices-before-edges (§6·2 — *graph-forced*); and the **referential conflict** rule for an edge
to a deleted endpoint (§6·3 — *graph-forced*, no document-store analog). Everything else — the rev,
conflict preservation, the by-sequence feed, keeping tombstones — follows CouchDB, because CouchDB is right
and we have no empirical reason to differ. The two graph-forced deviations share one root: **an edge is the
JOIN that CouchDB documents do not have.**

---

## §5. The central axis — the change model (resolved)

The research (§13) shaped this, and the reframe — "is there a more tractable way?" — resolved not by
replacing the mechanism but by **decomposing it**, then holding each piece against the governing principle
(§4). The resolution below is CouchDB's model almost wholesale: the one place we thought we'd deviate
(conflicts) we now do NOT, and the place we thought needed new machinery (pruning) turns out not to, once
CouchDB's *actual* mechanism is understood.

### §5·1 "Rev" is secretly doing two jobs (and a tempting third we don't need)

CouchDB's `_rev` bundles responsibilities that are separable, and separating them is what makes the problem
tractable:

1. **Identity / idempotency / conflict** — "are these the same version; what are you missing; is replaying
   this a no-op." Answered by a per-element content signature.
2. **The `since` cursor** — "enumerate what changed after checkpoint X." Answered by an *ordering*, which a
   content hash alone cannot provide (a hash tells you *whether* something differs, not *when*).

A tempting third — **a backstop** ("reconcile peers with no shared history, or catch bit-rot," via a Merkle
tree) — turns out NOT to be needed: CouchDB does not have one, and its absence is not graph-forced (§5·4).
CouchDB answers job 1 with the rev (a bounded rev-tree per doc) and job 2 with a by-sequence index; we land
on both of CouchDB's answers, and stop there.

### §5·2 Job 1 — identity: the rev is a hidden property (the faithful port)

**Decision (recommended, low-regret): the rev is a hidden element property `~rev`, not a new schema
column.** This is the faithful CouchDB port — in CouchDB `_rev` *is* a reserved field of the document, so
"a property of the element" is the exact analog, not a shortcut. The payoff is that it rides substrate we
already have instead of touching the schema:

- **Zero schema migration.** A rev is one more row in `vertex_properties` / `edge_properties` — already
  normalized, typed (`vtype`), indexed (`src/storage.ts`).
- **It round-trips through everything for free.** `io()` (`src/services/catalog/io.ts`), the bulk loader
  (`src/bulk.ts`), GraphSON export/import (`src/formats/graphson.ts`), and set-writes
  (`src/setwrite.ts`) all already carry properties. So *the replication payload is the existing element
  payload* — no bespoke wire format, no "also send the revs" side path. A rev-carrying graph already backs
  up and restores with its revs intact.
- **`_revs_diff` becomes a query, not a mechanism.** "Which of your `(id, rev)` do I lack?" is a predicate
  over the rev property — it compiles to SQL like any traversal. That is dead-on for "compile to SQL,
  never interpret."
- **Hidden-key hygiene already exists in the model.** TinkerPop hidden keys (the `~` prefix,
  `Graph.Hidden`) are excluded from `values()`/`valueMap()`/`properties()` by convention — the project
  already uses this shape (`~tinkerpop.io.reader` in `io.ts`). `~rev` is naturally invisible to user
  queries and is excluded from its own content hash exactly as CouchDB excludes `_rev` from the body hash.

Two honest costs, both real, neither fatal:

- **Storage is free; maintenance is not.** Every mutation must recompute and rewrite the element's `~rev`,
  and to content-hash it the write path must gather the element's current content (O(element size) per
  write). That "touch the rev on write" hook is the actual work — and it is *model-independent*: any rev
  scheme needs something to bump the version on write. Rev-as-property makes only the *storage* free.
- **What the rev IS remains open** (a genuine sub-decision, not settled by "where it lives"):
  - **content hash** — `hash(labels/endpoints + properties)`, à la CouchDB's `new_revid`
    (`MD5(deleted, prev-gen, prev-hash, body, atts)`). Idempotent: identical writes converge to the same
    rev, so replay and re-sync dedup naturally. Costs a content read per write.
  - **opaque per-write token (uuid)** — O(1) write, no content read, but loses content-dedup (two peers
    that independently made the *same* edit still look divergent).
  - **generation + hash** (`N-hash`, full CouchDB rev) — carries a generation counter, which is what makes
    CouchDB's deterministic conflict winner (higher generation wins) work. Cheap add-on to the hash form.
  - **DECIDED: generation + content hash** — the CouchDB-faithful choice: idempotent replay AND a
    deterministic winner for §6 conflicts, and the generation is one integer. Generation is a *logical*
    clock (it increments from the parent rev), deliberately NOT wall-clock time — a time-based rev would
    make the conflict winner depend on whose clock was right across peers. The content hash is the entropy.

**Because we preserve conflicts (§6·3), the `~rev` holds a bounded rev-TREE, not a scalar** — the current
leaf revision(s) plus a stemmed ancestry (CouchDB's `_revs_limit`, a small depth cap), enough to select a
deterministic winner and to graft an incoming rev at the right place for revs-diff. It still rides the
property substrate: we already store typed JSON trees in a property value, so `~rev` is one such tree. The
winner's content stays in the normal live rows (the query hot path is untouched); losing leaves are held
aside in a shadow/conflict store, read only by a conflict-aware query.

### §5·3 Job 2 — the `since` cursor: a by-sequence index, exactly like CouchDB

The content hash does not give a resumable ordered cursor. Something must — and CouchDB's answer, correctly
understood, is the one to copy. **CouchDB's `_changes` is NOT an append-only op-log; it is a by-sequence
index with ONE entry per document** (the doc's *latest* seq). Updating a doc *moves* its entry to a higher
seq rather than appending, so the feed is **current-state-sized — O(elements), not O(writes)** — and
`_changes?since=0` returns each live doc once (plus tombstones), not every write ever. This is the fact that
makes "just keep everything from 0" cheap: "everything" is current state, which we already store.

**DECIDED: a per-element `seq` (last-modified sequence, from a per-graph monotonic counter), indexed.**
`_changes?since=N` is a range scan `WHERE seq > N ORDER BY seq` over an index holding one row per element; a
write bumps the element's `seq` (and rev). This is CouchDB's by-seq, and it is strictly better than the
append-only "change-log table" a first cut reaches for: no unbounded growth from writes (the index is
graph-sized), and no separate log structure to maintain or prune. (A tombstone keeps a small retained entry
so a delete still appears in the feed — §6·4.)

Two rejected alternatives, for the record: an **append-only change-log table** grows O(writes) and needs
pruning the by-seq index does not; **full-set reconciliation every sync** (compare every `(id,rev)`) needs
no cursor but is O(size) each time — a fallback for the no-shared-checkpoint case (`since=0` handles it),
not the continuous path.

**The Merkle/prolly reframe — honestly costed.** Content-addressed, deterministically-chunked trees
(Noms → Dolt, AT Protocol's MST, Cassandra/Dynamo anti-entropy) do give O(differences) *tree comparison*.
But the research is decisive that this does not make it the everyday change detector for a normalized-SQL
source of truth:

- O(diff) is the cost of comparing two *already-built* trees. **Building and maintaining** the tree is the
  real cost, paid on every write ([Dolt: prolly tree balance](https://www.dolthub.com/blog/2025-06-26-prolly-tree-balance/)).
- The closest analogue to us — Dolt putting prolly trees over *columnar* (multi-structure) storage — hit
  **multiplicative write amplification**: one logical write touches N independent structures, each needing
  its own chunk-rewrite ([Dolt: prolly trees and columnar storage](https://www.dolthub.com/blog/2025-09-10-challenges-with-prolly-trees-and-columnar-storage/)).
  Our schema is exactly that shape: one `addEdge` touches `edges`, two adjacency index positions, and
  `edge_properties`.
- **AT Protocol (Bluesky), a purpose-built greenfield MST system, moved its *sync* path off tree-diffing
  onto a causally-ordered append log**, keeping the MST only for content-addressing/verification
  ([atproto#1410](https://github.com/bluesky-social/atproto/discussions/1410)). The strongest field signal
  there is: even from scratch, the log won the sync-critical role.
- Cassandra builds Merkle trees **on demand** (O(size) to build) and makes it tractable via *incremental
  repair* gated by a persisted "repaired-up-to" watermark — which is structurally a checkpoint/seq again
  ([Cassandra repair / node density](https://rustyrazorblade.com/post/2025/repair-and-node-density/)).

### §5·4 The backstop is NOT needed — a Merkle tree is a CouchDB deviation we can't justify

The reframe (§13) genuinely works — an on-demand Merkle tree over `(id, rev)`, computed by scanning the rev
properties, would give O(diff) reconciliation and bit-rot detection with no maintained shadow store. But
leaning harder into CouchDB (§4) settles it the other way: **CouchDB has no Merkle tree, and we don't need
one either.** Checking what it would uniquely buy, against the governing principle:

- **First-contact / no-common-checkpoint reconciliation** — already handled by `since=0` (a full sync). No
  Merkle needed.
- **Bit-rot / silent-corruption detection** — the one thing a Merkle tree adds that rev+seq cannot. But
  **CouchDB does not do this either**, it is not graph-forced, and we have no measured need — so it is not a
  justified deviation.
- **Efficient whole-graph equality for two large, mostly-synced peers that lost their checkpoints** — Merkle
  is O(diff) where a `since=0` revs-diff is O(elements). Real, but a rare degenerate case; CouchDB's answer is
  to keep checkpoints reliably (they are tiny) so you almost never hit it, and eat the slow path when you do.
  We follow suit.

So the Merkle tree is **dropped from the plan.** It was always the cleanly-separable "optional / last /
can-be-never" piece, so removing it costs nothing and simplifies the model to two jobs (§5·1). Recorded here
so it is not re-proposed; the obvious place to revisit **only if** a measured need appears — huge graphs that
frequently reconcile without checkpoints, or a hard integrity-audit requirement.

### §5·5 The resolution

Following the governing principle (§4), the change model is CouchDB's, with the two graph-forced deviations
isolated to §6:

- **Job 1 — identity/conflict** — a `~rev` hidden property holding a bounded rev-tree, generation + content
  hash; conflicts PRESERVED (CouchDB, §6·3), winner-on-read.
- **Job 2 — the cursor** — a per-element `seq` (by-sequence index, current-state-sized), driving
  `_changes?since=N` and a revs-diff query. `since=0` is a full sync; there is ONE mechanism, not a
  snapshot/incremental split (§7).
- **No job 3.** The Merkle backstop is dropped (§5·4) — CouchDB works without one and we have no justified
  reason to add it.

What stays open is small and none of it blocks §10 Phase 0–1: the **rev-tree depth cap** (`_revs_limit`
analog, §6·4) and the **id layout detail** (§6·1). The conflict, pruning, and backstop questions that were
open are resolved — preserve conflicts (never reject, never lose); keep tombstones with no up-front pruning;
no Merkle tree.

---

## §6. The graph-specific hard parts — each a real sub-problem, not a footnote

These are the consequences of §4's inversion. None is optional for a *faithful* replica; each is where "a
trained monkey could design it" stops being true for a graph.

### §6·1 Cross-peer identity — the native id becomes a 64-bit global integer

**Our element ids are per-DO integer rowids** (`nodes.id` / `edges.id`), faced externally as
`COALESCE(uid, id)` (`src/storage.ts`). Two independently-created graphs mint rowids **independently** —
vertex 5 on peer A is unrelated to vertex 5 on peer B. Replication is meaningless without a stable
cross-peer identity, and a bare `addV()` today has only a local rowid.

**DECIDED: change the NATIVE id to a 64-bit globally-unique integer — do not co-opt `uid`.** TinkerPop
does not require integer ids (element ids are arbitrary `Object`s; Neptune uses strings, JanusGraph
custom); we chose integer rowids for *performance* — the covering indexes `e_out(src,label,tgt)` /
`e_in(tgt,label,src)` do integer src/tgt joins for index-only traversal (`src/storage.ts`). So we are free
to change the id's *value scheme* while keeping it an integer, which keeps that performance intact — a
128-bit UUID stored as TEXT would widen every join key and lose it. `uid` is then freed entirely for
users, rather than us co-opting it. (Identity needs *uniqueness*, not content: two structurally-identical
elements are still two elements, so the id's entropy is the prefix+counter — content addressing is the
rev's job, §5·2. This is exactly why CouchDB's `_id` is a random/time token and its content hash lives in
`_rev`.)

**Structure: a per-instance prefix + a monotonic counter** — CouchDB's own `sequential` algorithm
(`couch_uuids.erl`: a random prefix plus an incrementing counter) is the proven prior art for
"collision-safe id that keeps insert locality." The counter gives B-tree insert locality; the prefix
namespaces the peer so two peers minting locally-originated ids never collide. Counter-only (no wall-clock)
is the leaning (§11) — it removes any clock-skew / time-going-backward dependency and still orders inserts;
a Snowflake time+peer+seq layout is the alternative.

**The prefix identifies the physical INSTANCE, never the graph name — a correctness point, not a
preference.** The canonical replication case is *the same logical graph on two peers* (pull prod `social`
onto a laptop, also `social`). A `hash(graph name)` prefix would give both instances the same namespace,
so their independently-created elements would collide — exactly what the prefix exists to prevent. (Graph
names are not globally unique across deployments anyway.) So the prefix is a random per-instance id
assigned at graph creation and stored in graph metadata — analogous to CouchDB's per-server UUID. It
doubles as **origin provenance**: a replicated element keeps its origin's id (prefix and all), and a peer
mints ids only for elements *created locally* — so after a pull, prod-origin elements carry prod's prefix
and your local debugging edits carry the laptop's, and you can tell which is which. (Relatedly, TinkerPop
has no rename-graph primitive and neither do we — a graph is a DO addressed by `idFromName`, management is
create/info/destroy on `/gremlin/{g}`, `.claude/rules/management-api.md` — so "rename" is itself a
copy/replication, and name-derived identity would be doubly wrong.)

The rev (§5·2) is keyed by this global id, and an edge's rev references its endpoints *by global id*, so
the same edge hashes identically on every peer. Costs, all bounded: a 64-bit id exceeds 2^53, so it needs
the lossless-int64 handling the codebase **already has** (bigint binds + CAST-AS-TEXT reads, the DO
precision work — `src/gremlin/types.ts`, `src/storage.ts`); the write path mints the id (prefix + counter
from a metadata/singleton row) instead of leaning on SQLite's auto-rowid. Interned label ids stay *local*
(peer A's label 3 ≠ peer B's), so replication carries label/property-key NAMES, which `io()`/GraphSON
already do — only the element id needs to be global. This is the quiet gating item for Phase 1.

**A compounding payoff: the global id deletes ~375 LOC of federation machinery and closes the last open
federate item.** Multigraph federation today keeps sibling ids from colliding *only* when several landed
graphs are UNIONed into one stream, via a first-class `graph` provenance channel + a composite `(graph, id)`
rejoin (`unifiedBoundGraph`, the `graph` `ChannelRole` and its four policy-table entries, `graphTag` /
`LOCAL_GRAPH`, and `postMergeTail`'s fail-closed allow-list — `src/compiler/rel/{boundgraph,segment,lower/
slice}.ts`, `src/channels.ts`, `src/compiler/ir/step.ts`, ~375 LOC). All of it exists ONLY because two
graphs can each mint id 5. Global ids remove the premise: the discriminator is baked into the id's prefix, so
a merged federated stream rejoins by bare (global) `id` through the ORDINARY `BoundGraph`, and the whole
`graph`-channel apparatus is deletable. This closes the deferred gaps it only partly covered —
`hasLabel` / `has` / movement / `group` / `groupCount` over a merged multi-graph stream (today `'unsafe'`,
fail-closed in `segment.ts`; the last "multi-graph mixing / cross-graph identity" item in
`docs/outstanding-work.md`) all just compose. (The separate ~640 LOC of id-carry+rejoin for a *detached*
foreign element — `foreign.ts`, single-sibling `boundgraph.ts` — is a physical-distribution concern,
unaffected in kind, though "which graph" could then be derived from the prefix instead of a carried token.)
So the global id is not only a replication prerequisite; it pays for itself in federation simplification —
exactly the substrate win to bank. It also generalizes the base+federate mixed-merge case
(`segment.ts` `nestedBarrierIn`, today fail-closed) once EVERY graph — local included — mints from the same
prefixed-global scheme, which this decision already implies.

### §6·2 Referential integrity and ordering — we already solved the read half

An edge references two vertices; applying an edge before its endpoints exist is a dangling write. CouchDB
never faces this (independent records). We already face and solve it *on load*: **the GraphSON two-pass
loader lands every vertex, then every edge** (`loadGraphsonStreaming`, `src/formats/graphson.ts`), because
an adjacency line's edge may target a later line. Replication is the same discipline over the wire:
**transfer and apply vertices before edges**, and within a batch resolve endpoints against already-landed
rows (the `BatchingLoader` pattern, `src/bulk.ts`). The unit of replication is therefore the *element*
(vertex or edge), not a CouchDB-style "document" — but the *ordering* between the two element kinds is a
hard constraint, not a convenience. A cross-batch edge whose endpoint has not yet replicated must either
wait (buffer) or fail-closed and retry on a later pass — never write a dangling edge.

### §6·3 Conflicts — CouchDB preservation, with one graph-forced exception

**DECIDED: preserve conflicts, CouchDB-style — do NOT discard-LWW.** (This reverses a first cut that
discarded the loser; under the governing principle §4, "simpler for us" was never a licence to deviate, and
here it is not empirically better either — it silently loses writes.) So: keep *all* divergent leaves, pick
a deterministic winner on read (not-deleted > higher generation > higher rev-hash lexically —
`to_doc_info_path` in `couch_doc.erl`), resolve nothing automatically, and surface the losers to the
application (a `~conflicts` analog of CouchDB's `?conflicts=true`) to resolve. Reads return the winner's
content (the normal live rows — the query hot path is untouched); conflicts are invisible unless asked for.

**The earlier "multi-leaf breaks graph invariants" objection was overstated, and the real deviation is
narrower.** An edge references a vertex by its stable id, and **the id is constant across leaves** — the
divergent leaves are about an element's *content* (properties/labels), not its identity or existence. So a
property/label conflict on a vertex is *pure* CouchDB and we follow it exactly. Even delete-vs-update on a
single element is CouchDB-shaped: a delete is a `_deleted` leaf, and CouchDB's "not-deleted beats deleted"
rule sensibly resurrects an element that has a concurrent update.

The **one** place with no CouchDB analog is the **referential** conflict: peer A deletes vertex V while peer
B keeps (or adds) an edge E→V. Documents have no referential constraints, so CouchDB never faces a dangling
reference; a graph must. But the CouchDB PRINCIPLE still binds: **replication always succeeds — never reject
a write, never silently lose one.** So both naive options are out — "refuse the delete" *rejects* (forbidden),
and "drop the dangling edge" *silently loses data* (forbidden). Instead we extend CouchDB's own winner rule:
**"not-deleted beats deleted", and a referencing edge is an existence-claim on its endpoint.** So E's
existence beats V's delete — **V is resurrected and its delete becomes the surfaced conflict** (a `~conflicts`
entry the application resolves later: re-confirm the delete and cascade to E, or keep V). This never rejects,
never loses (the delete is preserved as a losing leaf), and keeps the live graph referentially consistent by
construction (V is back, so E does not dangle) — with no quarantine machinery. The alternative (delete-wins,
edge quarantined-and-surfaced) is defensible if you want deletes to be sticky, but it needs a quarantine
store and leaves an element in limbo; edge-resurrects-endpoint is the recommendation, and that a/b choice is
the only remaining knob (§11). This plus the transfer ordering (§6·2) are the only two graph-forced
deviations, and both share one root: an edge is the JOIN CouchDB documents lack.

The cost (honest): preserving conflicts is heavier substrate than discarding — an element's content becomes
rev-versioned (winner live in the normal rows; losing leaves in a shadow/conflict store) and `~rev` holds a
bounded rev-tree (§5·2). The read≫write reality softens it: conflicts are rare, so the shadow store is
seldom populated. Under the governing principle this is the right price — it is what "never silently lose a
write" costs, and CouchDB pays it.

### §6·4 Deletes / tombstones, and why up-front pruning is NOT needed

`drop()` deletes rows; there is no tombstone, no record that something *was* deleted (confirmed: no
`deleted`/tombstone concept anywhere in `src/`). Replication must propagate deletions, and a pure "diff the
live sets" approach cannot tell "deleted on the source" from "not yet created on the source." So replication
needs **tombstones**: a small retained entry (kind, global id, rev, `deleted`) carrying its own `seq`, so a
delete appears in the by-seq feed exactly as CouchDB ships a `_deleted` rev in `_changes`. A delete is a rev
like any other and can lose to a concurrent update (§6·3).

**Up-front pruning is NOT needed — a first cut over-engineered it.** Correctly understood, CouchDB does not
keep "all history," and what it *does* keep is either self-bounding or cheap:

- **The by-seq feed is current-state-sized** (§5·3): one entry per element, moved (not appended) on write.
  It needs no pruning — it is graph-sized by construction. This is why `since=0` always reconstructs a full
  replica, and why the snapshot/incremental split collapses to CouchDB's one mechanism (§7).
- **Rev-tree ancestry is depth-stemmed**, automatically and cheaply — CouchDB's `_revs_limit` (default
  1000): beyond a depth cap, old rev-ids drop off the tree. We do the same; it is bounded, not a horizon
  (the depth value is the one tuning knob, §11).
- **Only tombstones truly accumulate**, and CouchDB itself does not auto-prune them (purge is manual and
  discouraged, because a peer that has not seen the delete would resurrect it). Following the governing
  principle we match CouchDB: keep tombstones, offer a manual purge later. Deletes are infrequent
  (read≫write) and a tombstone is tens of bytes, so accumulation is tolerable for a long time — the same
  trade CouchDB lives with.

So there is no retention horizon and no mandatory pruning in v1: keep everything, `since=0` is the full sync,
and a purge mechanism is a later, optional addition — not a prerequisite.

---

## §7. The transport — mogwai as an outbound HTTP client (the shared foundation)

Both features need mogwai to *call out* over HTTP to another graph. Today it never does. The good news:
the outbound driver already exists in the tree and is a production dependency.

- **The vendored `gremlin` client is a `fetch`-based outbound driver** (`Client.submit(gremlin,
  parameters)`, `Connection.#makeHttpRequest` uses `fetch` —
  `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/{client,connection}.ts`), exported from the
  top-level package mogwai already imports for its GraphBinary serializers (decision #4 in root
  `CLAUDE.md`). `fetch` is native inside a Worker/DO, so it works on both runtimes. This is the reuse-first
  path for the *Gremlin-speaking* outbound call (external federation, §8).
- **For the replication peer protocol**, the peer speaks a small set of endpoints (§9), not Gremlin — so
  the replication client is a thin `fetch` wrapper over those endpoints, decoding the same GraphBinary/JSON
  value shapes our own server produces (`src/http.ts`, `src/wire.ts` document both sides).
- **ONE mechanism — `_changes?since=N` — with `io()` as an efficient `since=0`.** Because the by-seq feed is
  current-state-sized and we keep everything (§5·3, §6·4), `since=0` reconstructs a full replica and
  `since=checkpoint` an incremental one — the *same* mechanism, exactly like CouchDB. There is no
  snapshot-vs-incremental *tier* and no retention horizon to fall off (the earlier two-tier framing, and the
  Neo4j catchup it borrowed, are gone — Neo4j needs two mechanisms only because its transaction log rotates).
  The one refinement: a fresh full pull of a large graph is better streamed in bulk than driven through a
  chatty changes→revs-diff→bulk loop, so **`io()` + `IoStore` (`src/services/catalog/io.ts`,
  `src/iostore.ts`) is the efficient *implementation* of the `since=0` case** — bounded-memory, R2 multipart
  — an optimization of one mechanism, not a second one.

**LAW: the HTTP edge stays out of the store tier.** Adding replication must not put `fetch` inside the DO's
compile/run path. Outbound calls belong at the worker/edge residency, the way federate's barrier declares
`residency: 'worker'` so the Worker drives the remote wait and frees the DO (`src/compiler/segment.ts`,
`src/services/catalog/federate.ts`). A replication *pull* driven from the Worker across the peer HTTP call
is the same residency story; a *server* answering `_changes`/`_revs_diff` is ordinary read work in the
store tier.

---

## §8. The federation half — an external-HTTP `FederationSource`

This is the smaller, cleaner feature and a perfect Phase 0 because it proves the outbound client with
almost no new concepts.

- **The seam is already abstract.** `federate()` depends only on `FederationSource`
  (`src/compiler/segment.ts`): a one-method interface, `executor(id).runForeign(gremlin, params, depth,
  …) → Promise<ForeignResult>`. RPC is *not* hardwired; the Cloudflare and Bun managers each just happen to
  implement it over DO RPC / in-process calls (`src/cloudflare/cloudflare-graph-manager.ts`,
  `src/bun/BunGraphManager.ts`). `federate.ts` imports no RPC types.
- **The trigger is the `graph` param becoming a URI — no new Gremlin surface (§9).** A *relative* URI stays
  a local sibling graph (today); a *fully-qualified* URI dispatches to the HTTP backend. So the seam is a
  `FederationSource` that inspects the id: local ids resolve through the existing manager, absolute URIs
  through an `HttpFederationSource`. External federation is thus just `call("federate", {graph})` with a URL.
- **The new backend is a plain implementer.** `HttpFederationSource.executor(uri).runForeign(...)`:
  `POST {gremlin, bindings}` to the URI via the vendored `Client.submit` (or a direct `fetch` of the JSON
  wire shape `src/wire.ts` documents), decode the response, and **map it into the closed `ForeignResult`
  contract** (`elements | scalar | map | values`, `src/api.ts`). Nothing downstream
  (`src/compiler/rel/foreign.ts`, `src/execute.ts`) cares how the bytes arrived.
- **Two invariants to honor**, both visible in the seam: thread and increment `depth`
  (`guardFederationDepth`, `src/services/params/federation-depth.ts`) so a hop out to an external server
  and back stays bounded; and translate the external response into `ForeignResult` faithfully (a scalar
  where elements are expected is a contract violation, fail closed — `federate.ts` already does this for
  the RPC backend). Note `RpcPayload`/`rpcTry` (`src/rpc.ts`) is a DO-RPC-only convention — an HTTP backend
  uses ordinary `throw`/`catch` around `fetch`, no failure-as-value dance.
- **The mapValues/`inject($map)` round-trip** federate uses for mid-traversal calls
  (`mapValuesGremlin`, `federate.ts`; the grammar delta
  `patches/upstream/tinkerpop-06-inject-generic-argument-varargs.patch`) is *pure Gremlin* — it rides an
  external HTTP hop for free, since the payload is one bound param in the request body.

The shared substrate with replication is precisely the outbound HTTP client (§7). Federation sends
*queries* and gets *live detached results*; replication sends *sync requests* and gets *state deltas* —
different protocols, one client foundation, one residency discipline.

---

## §9. The DX — one-shot lives in Gremlin (standard GLV); ongoing replication lives in the management API

**LAW: the GLV is not ours to extend — we use STANDARD Gremlin only.** No invented step, no non-standard
method on the client (`g.io(url).pull()` in an earlier draft was exactly this mistake — `pull()` is not a
GLV step). Any GLV change needs a compelling reason AND an upstream PR — the bar we already cleared once for
federate's `inject($map)` varargs (`patches/upstream/tinkerpop-06-inject-generic-argument-varargs.patch`).
This law decides the split below, and it decides it cleanly.

**The split follows an idiom boundary, not taste.** Gremlin is a *one-shot* language — run a query, get
results; even `io()` is a one-shot bulk load. There is no prior art anywhere in Gremlin for a query that
keeps running in the background, and we won't invent one. So:

- **One-shot pulls stay in Gremlin, and both are already STANDARD GLV — no new surface:**
  - **Cross-graph query → `federate` with a URI.** `federate`'s `graph` param is just a string
    (`graphOf`, `federate.ts`); make it URI-aware — a *relative* URI is a local sibling graph (today's
    behavior), a *fully-qualified* URI is a remote graph pulled over HTTP (the §8 backend). External
    federation then needs no new surface at all; it is the same `call("federate", {graph})` with a URL.
  - **Bulk transfer → `io()` with a URL.** `g.io(url).read()` / `.write()` are standard GLV steps; the
    argument is just a string the provider's io registry interprets. Today it names an R2 key / file; let it
    also name another database over HTTP. "Slurp from another graph instead of from R2" is a pure `io()`
    feature — one-shot, idiomatic, no GLV change.

- **Ongoing replication is a persistent config + a scheduler — it lives in the management API, NOT Gremlin.**
  CouchDB confirms the shape (`replicator.rst`): a replication is a *document* in the `_replicator` database
  (`source`, `target`, `continuous`, `filter`, `checkpoint_interval`), run by a **scheduler** that
  periodically starts/stops jobs (`max_jobs`/`interval`/`max_churn`), with a state machine and introspection
  at `_scheduler/jobs` / `_scheduler/docs`. The mogwai analog:
  - **A CRUD management interface over persistent replication configs** (create / edit / delete a
    source→target config), on the existing thin REST router (`src/router.ts`), the same shape as the graph
    lifecycle verbs — no new control plane, just more of the one we have.
  - **A scheduler that runs them.** On a Durable Object "continuous" is not a held connection (a DO
    hibernates) — it is a **DO alarm-driven periodic pull** (wake → `_changes` since checkpoint → apply →
    sleep), with the crash-backoff CouchDB uses. One-shot configs run once and complete.
  - **Introspection endpoints** — a `_scheduler/jobs` analog: job status + history.
- **The cheap UI falls out of OpenAPI.** We already generate an OpenAPI spec and a docs UI over the
  management API (`buildDocs`, `src/docs.ts`, served at `/docs` + `/openapi.json`, `src/router.ts`). Document
  the replication config CRUD + introspection there and the UI is generated for free — our Fauxton, no
  bespoke front-end. Default is to document *everything* publicly (it helps anyone extend), so the
  peer-facing sync endpoints go in the spec too.

**The peer-facing sync endpoints** (what two mogwai servers speak) mirror CouchDB's *shapes* on mogwai
routes — `_changes?since=N`, a revs-diff, a bulk apply, a checkpoint (`_local`-analog). We adopt the shapes
because they are well-designed and §5's model maps onto them, NOT for wire interop (§9·1). Direction is the
caller's: pull = "I am target, you are source"; push = the reverse; one engine, roles swapped (§4).

### §9·1 Interoperating with CouchDB itself is a non-goal

Tempting — "edges and vertices are the world's smallest documents" — but no. A generic CouchDB replicator
moving our elements as documents would not honor vertices-before-edges ordering (§6·2), would break
referential integrity, and does not share our id/rev/conflict semantics — it would produce a dangling,
corrupt graph, not a replica. So we follow CouchDB's *design* as the gold standard (§4) and mirror its
endpoint *shapes* for familiarity, but wire-level interop with a real CouchDB is out of scope: our peer
protocol is mogwai↔mogwai.

---

## §10. The phased plan — unlock order

Each phase is independently valuable and lands green before the next. Ordered so the shared substrate and
the smallest proof come first, and the genuinely hard graph semantics come after the transport is trusted.

- **Phase 0 — the outbound HTTP client + the one-shot Gremlin surfaces (§7, §8, §9).** Make `federate`'s
  `graph` param URI-aware (relative = local sibling, absolute = remote HTTP via `HttpFederationSource`) and
  let `io()` accept a URL source — both STANDARD GLV, no new surface. Build the outbound client on the
  vendored `gremlin` driver. Smallest, most independent win; ships two real features (federate to an external
  graph; bulk-slurp another graph by URL) and proves the outbound client + worker-residency that replication
  reuses. No schema change, no rev, no seq. *Gate: a mogwai graph federates a sub-traversal to an external
  Gremlin server; `g.io(url).read()` imports another graph over HTTP.*
- **Phase 1 — the global id + the rev property (§6·1, §5·2).** Change the native element id to a 64-bit
  globally-unique integer (per-instance prefix + monotonic counter, minted on write; `uid` freed for
  users); add the `~rev` hidden property and the touch-on-write hook (generation + content hash, edge rev
  referencing endpoints by global id). Pure local substrate — no networking yet — and independently
  testable. *Gate: every element has a global id and a rev; identical content converges to the same rev;
  ids and revs survive an `io()` round-trip; two graphs mint non-colliding ids.*
- **Phase 2 — the by-seq feed + the read side (§5·3, §6·4).** Add the per-element `seq` (indexed) bumped on
  write, and tombstone entries for deletes. Expose the `_changes?since=N` scan and the revs-diff query. Still
  server-only — no replication engine, but a peer can now be *asked* what changed and what it's missing.
  *Gate: `_changes?since=N` and revs-diff return correct deltas incl. deletes; `since=0` enumerates full
  current state; the feed stays current-state-sized under repeated updates.*
- **Phase 3 — the replication engine + checkpoint + the peer protocol (§9, §5).** The pull/push loop — ONE
  mechanism: `_changes?since=N` (N=0 for first contact, `io()`-streamed for the bulk case) → revs-diff →
  transfer (vertices before edges, §6·2) → apply idempotently → checkpoint (`_local`-analog, deterministic
  replication id). Expose the peer-facing sync endpoints and a transient one-shot `POST /gremlin/{g}/_replicate
  {source, target}` trigger. *Gate: pull a remote graph to a fresh local graph; re-pull is a resumable no-op;
  push is the same with roles swapped.*
- **Phase 4 — conflict preservation + tombstones (§6·3, §6·4).** The rev-tree + shadow/conflict store;
  deterministic-winner-on-read; conflict surfacing (`~conflicts`); the referential-conflict rule
  (edge-resurrects-endpoint — never reject, never lose, §6·3); rev-ancestry depth-stemming (`_revs_limit`
  analog); keep tombstones (no up-front pruning). *Gate: two peers each mutate and cross-replicate; both
  converge; conflicts are preserved and surfaced, never silently lost; a delete racing an incident edge
  resurrects-and-surfaces rather than dangling or rejecting; deletes otherwise propagate.*
- **Phase 5 — persistent replication: config CRUD + scheduler + OpenAPI UI (§9).** A CRUD management
  interface over persistent source→target configs; a DO-alarm-driven scheduler that runs them (continuous =
  periodic pull with crash-backoff; one-shot = run once); introspection (a `_scheduler/jobs` analog); and the
  OpenAPI spec + generated docs UI over all of it (`src/docs.ts`) — our Fauxton for free. *Gate: create a
  config that keeps a local graph synced from a remote one on a schedule, visible + editable in the generated
  UI.*
- **Phase 6 — optional manual tombstone purge (§6·4).** A manual purge for the rare graph that accumulates
  enough tombstones to matter (CouchDB-style, opt-in). The Merkle anti-entropy backstop is NOT planned (§5·4)
  — dropped as an unjustified CouchDB deviation. *Gate: a purge reclaims tombstones without breaking a peer
  that is still current.*

---

## §11. Open design decisions — to resolve in discussion

Governing principle (§4): **follow CouchDB; deviate only when empirically better or graph-forced.** Resolved
in review (recorded so they are not reopened): **rev = generation + content hash, held as a bounded rev-tree
in `~rev`** (§5·2); **native id = 64-bit global integer, per-instance prefix + counter, `uid` freed** (§6·1);
**conflicts = CouchDB preservation (keep leaves, winner-on-read, surface, resolve) + one graph-forced
referential exception** (§6·3); **cursor = a per-element by-sequence index, current-state-sized** (§5·3);
**tombstones kept (no up-front pruning); rev-ancestry depth-stemmed; ONE `since=N` mechanism** (§6·4, §7).
Two more, added in review: **the DX splits by idiom — one-shot pulls are STANDARD-GLV Gremlin (`federate`
with a URI, `io()` with a URL), ongoing replication is a persistent config + scheduler in the management API
with an OpenAPI-generated UI** (§9, and the **standard-GLV-only** law); **CouchDB wire interop is a non-goal**
(§9·1); **CouchDB is vendored for reference** (§14); **the Merkle backstop is dropped — CouchDB has none and
it is not graph-forced** (§5·4); **the referential conflict never rejects and never loses — a referencing
edge resurrects a deleted endpoint, the delete surfaced** (§6·3). Still open:

1. **Id layout detail** (§6·1): the bit split (prefix width vs counter width), and counter-only (leaning, no
   clock dependence) vs Snowflake time+peer+seq. A tuning decision, not a mechanism.
2. **Peer protocol naming** (§9): adopt CouchDB endpoint names (familiarity/interop) vs mogwai-native.
3. **Rev-tree depth cap** (§6·4): the `_revs_limit` analog — how deep to keep rev ancestry before stemming.
4. **Referential-conflict winner** (§6·3): edge-resurrects-endpoint (recommended — mirrors
   not-deleted-beats-deleted, keeps the live graph consistent, no quarantine store) vs
   delete-wins-edge-quarantined. Never reject / never lose is locked either way.
5. **Filtered replication** (CouchDB selectors/doc_ids): a graph-scoped filter (a sub-traversal defining
   the replicated subgraph) is the natural analog and composes with our engine — in scope for the design,
   later for the build. Interacts with referential integrity (a filtered subgraph can produce dangling
   edges by construction).

---

## §12. Traps — recorded so they are not rediscovered

- **The session extension will lie to you** (§2). It is present in `bun:sqlite` and absent on DO, so a
  changeset-based prototype passes every dev test and cannot ship. Any change-tracking must be plain SQL on
  both runtimes.
- **The native id must be global, and its peer-prefix must NOT be the graph name** (§6·1). Keying on a
  per-DO rowid is incoherent across peers. The native id is a 64-bit global integer (per-instance prefix +
  counter); the prefix identifies the physical INSTANCE, not the logical name — the canonical case is the
  same-named graph on two peers, which a name-hash prefix would collide. A replicated element keeps its
  ORIGIN id; only locally-originated elements are minted here (so the prefix doubles as provenance).
- **Don't add a Merkle tree** (§5·4). It's a CouchDB deviation with no justification — its O(diff) is only
  *comparison* (construction is O(size)), CouchDB reconciles without one, `since=0` covers first-contact, and
  bit-rot detection isn't graph-forced. Revisit only on a measured need.
- **Never reject or silently drop on a referential conflict** (§6·3). Replication always succeeds: an
  edge-to-deleted-endpoint *resurrects* the endpoint and *surfaces* the delete — it does not refuse the delete
  (rejection) or drop the edge (data loss).
- **Never re-execute the query on the far side** (§3). Ship materialized mutations (effects), not Gremlin
  to replay — replaying a non-deterministic traversal diverges peers.
- **Dangling edges** (§6·2). Vertices before edges, always; a cross-batch edge to an unreplicated endpoint
  waits or fails closed — never writes a dangling row. We already enforce this on load; the wire is the
  same discipline.
- **Don't put `fetch` in the store tier / DO compile path** (§7). Outbound waits are worker-residency, like
  federate's barrier.
- **Don't discard-LWW to "keep it simple"** (§6·3, §4). Preserving conflicts is the CouchDB gold standard;
  discarding the loser silently loses writes and is a deviation with neither an empirical nor a graph-forced
  justification. The rev-tree IS the right port — divergent leaves are about an element's *content*, and an
  edge references it by stable id (constant across leaves), so multi-leaf does NOT break referential
  integrity. The only graph-forced conflict deviation is the narrow edge-to-deleted-endpoint case.
- **The `_changes` feed is current-state-sized, not an op-log** (§5·3, §6·4). It is a by-sequence index with
  one entry per element (moved on write, not appended), so it needs no pruning and `since=0` is the full
  sync. Don't build an append-only change-log table — it grows O(writes) and reintroduces a pruning problem
  the by-seq index doesn't have.

---

## §13. Research appendix — sources

**CouchDB protocol** (the normative model): [Replication Protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) ·
[Replication intro](https://docs.couchdb.org/en/stable/replication/intro.html) ·
[Conflicts + "Is it like Git?"](https://docs.couchdb.org/en/stable/replication/conflicts.html) ·
[`_revs_diff`](https://docs.couchdb.org/en/stable/api/database/misc.html) ·
[`_changes`](https://docs.couchdb.org/en/stable/api/database/changes.html). Local checkout for the code-level
facts (rev hash `new_revid`, deterministic winner `to_doc_info_path`, `couch_key_tree:find_missing`):
`/home/dan/Projects/couchdb` (session-added; cite the URLs above for anything durable).

**SQLite / storage-layer landscape** (why physical replication is off the table):
[Litestream](https://litestream.io/how-it-works/) ·
[LiteFS](https://github.com/superfly/litefs/blob/main/docs/ARCHITECTURE.md) ·
[dqlite](https://canonical.com/dqlite/docs/explanation/replication) ·
[rqlite FAQ](https://rqlite.io/docs/faq/) ·
[cr-sqlite](https://github.com/vlcn-io/cr-sqlite) · [crsql_changes](https://vlcn.io/docs/cr-sqlite/api-methods/crsql_changes) ·
[SQLite session extension](https://sqlite.org/sessionintro.html) · [Bun Session](https://bun.com/reference/node/sqlite/Session) ·
[DO SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) ·
[SQLite in Durable Objects](https://blog.cloudflare.com/sqlite-in-durable-objects/) ·
[D1 read replication](https://blog.cloudflare.com/d1-read-replication-beta/) ·
[workerd extensions unsupported](https://github.com/cloudflare/workerd/issues/6878) ·
[ElectricSQL](https://electric.ax/sync/postgres-sync) · [PowerSync](https://powersync.com/sync-postgres) ·
[Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction).

**Graph-DB replication prior art** (the gap):
[Neo4j clustering](https://neo4j.com/docs/operations-manual/current/clustering/introduction/) ·
[Neo4j CDC](https://neo4j.com/docs/cdc/current/) · [Neo4j Fabric](https://neo4j.com/docs/operations-manual/4.0/fabric/introduction/) ·
[APOC export/import](https://neo4j.com/docs/apoc/current/export/) ·
[Dgraph architecture](https://docs.dgraph.io/installation/dgraph-architecture/) ·
[JanusGraph architecture](https://docs.janusgraph.org/getting-started/architecture/) ·
[ArangoDB replication](https://www.arangodb.com/docs/stable/architecture-replication.html) · [DC2DC (retired)](https://docs.arangodb.com/3.10/deploy/arangosync/) ·
[TigerGraph CRR](https://www.tigergraph.com/docs/tigergraph-server/current/cluster-and-ha-management/crr-index) ·
[Neptune global database](https://docs.aws.amazon.com/neptune/latest/userguide/neptune-global-database.html) · [Neptune Streams](https://docs.aws.amazon.com/neptune/latest/userguide/streams.html) ·
[FalkorDB replication](https://docs.falkordb.com/operations/replication.html) ·
[GUN conflict resolution](https://github.com/amark/gun/wiki/Conflict-Resolution-with-Guns).

**Merkle / prolly-tree reframe** (researched; dropped — CouchDB has none, §5·4):
[Dolt: prolly trees](https://www.dolthub.com/blog/2024-03-03-prolly-trees/) ·
[Dolt: prolly tree balance](https://www.dolthub.com/blog/2025-06-26-prolly-tree-balance/) ·
[Dolt: prolly trees + columnar storage](https://www.dolthub.com/blog/2025-09-10-challenges-with-prolly-trees-and-columnar-storage/) ·
[Dolt: push/pull on a Merkle DAG](https://www.dolthub.com/blog/2020-09-09-push-pull-on-a-merkle-dag/) ·
[Dolt: garbage collection](https://www.dolthub.com/blog/2020-10-16-garbage-collection-in-dolt/) ·
[Noms intro](https://github.com/attic-labs/noms/blob/master/doc/intro.md) ·
[Cassandra repair / node density](https://rustyrazorblade.com/post/2025/repair-and-node-density/) ·
[AT Protocol repository (MST)](https://atproto.com/specs/repository) · [AT Proto: sync history removal](https://github.com/bluesky-social/atproto/discussions/1410).

**mogwai code cited** (the authority): `src/iostore.ts`, `src/services/catalog/io.ts`,
`src/cloudflare/R2IoStore.ts`, `src/formats/{graphson,drain,csv}.ts`, `src/bulk.ts`, `src/setwrite.ts`,
`src/storage.ts`, `src/router.ts`, `src/compiler/segment.ts` (`FederationSource`),
`src/services/catalog/federate.ts`, `src/api.ts` (`ForeignResult`), `src/wire.ts`, `src/http.ts`,
`src/cf-limits.ts`, `.claude/rules/{management-api,schema-storage,wire-protocol}.md`, and the vendored
`gremlin` client at `vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/{client,connection}.ts`.

---

## §14. Vendor CouchDB as reference — it is the gold standard, so keep the code at hand

Per the governing principle (§4), CouchDB is the design authority for this whole feature, so it earns a
vendored, reference-only submodule beside `vendor/tinkerpop`, `vendor/calcite`, and `vendor/gds` — same
discipline (blobless + sparse, gitlink-only, never built, never imported; provisioned by
`scripts/init-submodule.sh`; cite at the pin so claims are checkable by CI and by others, unlike the
session-local clone this doc currently cites). This doc's CouchDB citations should move to
`vendor/couchdb/...` paths once it lands. It is `shallow` (read only at the pin), like calcite/gds.

**The parts to sparse-checkout** (the replication reference surface, ~a handful of dirs/files):

- `src/docs/src/replication/` — `protocol.rst` (the normative spec), `conflicts.rst` (the rev-tree +
  winner model + the "Is it like Git?" essay), `intro.rst`, `replicator.rst` (the `_replicator` DB +
  scheduler + states — §9).
- `src/docs/src/api/database/{changes,misc,bulk-api}.rst` and `src/docs/src/api/local.rst` — the
  `_changes`, `_revs_diff`, `_bulk_docs`, `_local` endpoint references.
- `src/couch/src/` — `couch_key_tree.erl` (the rev-tree: `merge`, `find_missing`, `stem`), `couch_doc.erl`
  (`new_revid`, the deterministic winner `to_doc_info_path`), `couch_db.erl` (`get_missing_revs`),
  `couch_uuids.erl` (the id algorithms — §6·1's `sequential` prior art).
- `src/couch_replicator/src/` — `couch_replicator_ids.erl` (the checkpoint/replication-id derivation) and
  the scheduler modules (the persistent-job model behind §9).

Actual vendoring is a discrete, reviewed change (submodule + `init-submodule.sh` sparse config), best done
alongside Phase 0 so every later phase can cite the gold standard at the pin.
