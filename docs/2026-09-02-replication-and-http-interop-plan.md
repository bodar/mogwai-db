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
  the transferable idea: incremental log-ship when the gap is small, **fall back to a full store copy +
  replay the delta** when the gap exceeds retained history. That two-tier shape maps directly onto our
  "pull since checkpoint, or bootstrap a snapshot then catch up." Its **bookmarks** (a write returns a
  token; a read can block until a replica has caught up to it) are a clean causal read-your-writes
  primitive. Neo4j **CDC** is a cursor feed (`db.cdc.current` / `db.cdc.query(since, selectors)`) but is
  explicitly *not for making an exact copy*.
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

---

## §5. The central axis — the change model, as a discussion

This is the open question. The research (§13) lets us *shape* it well, and the reframe you asked for —
"is there a more tractable way to look at this?" — has a real, cited answer. It is not "replace the
mechanism"; it is **decompose it.**

### §5·1 "Rev" is secretly doing three jobs

CouchDB's `_rev` bundles three responsibilities that are separable, and separating them is what makes the
problem tractable:

1. **Identity / idempotency / conflict** — "are these the same version; what are you missing; is replaying
   this a no-op." Answered by a per-element content signature.
2. **The `since` cursor** — "enumerate what changed after checkpoint X." Answered by an *ordering*, which a
   content hash alone cannot provide (a hash tells you *whether* something differs, not *when*).
3. **The backstop** — "reconcile two peers with no shared history, or catch silent divergence / bit-rot."
   Answered by comparing the whole set, made affordable by a tree.

CouchDB fuses jobs 1 and 2 (rev + seq) and leans on rev-trees for a version of job 3. We do better by
keeping them separate, because each has a *different* cheapest answer on our substrate.

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
  - *Leaning:* generation + content hash — it is the CouchDB-faithful choice, gives idempotent replay AND
    a deterministic winner for §6 conflicts, and the generation is one integer.

### §5·3 Job 2 — the `since` cursor: a change-log is the tractable primary

The content hash does not give a resumable ordered cursor. Something must. The options, and the research
verdict:

- **A change-log table** (recommended primary): `changelog(seq INTEGER PRIMARY KEY AUTOINCREMENT, kind,
  id, rev, deleted, ...)` appended in the write path. `_changes?since=N` is `WHERE seq > N ORDER BY seq` —
  a single indexed range scan, **already O(changes) with no hashing**. This is additive (one table, native
  SQLite B-tree), its write cost rides the row write already happening, and it is the shape cr-sqlite and
  every log-shipping system converge on.
- **A per-element `~seq` property** — folds the cursor into job 1's substrate, but a *globally monotonic*
  per-element seq needs a global counter and gives no efficient "all rows with seq > N" scan without an
  index over that property anyway. Weaker than a dedicated log.
- **Full-set reconciliation each sync** — no cursor at all; compare every `(id, rev)`. Correct, needs zero
  ordering machinery, but O(size) every sync. This is job 3, not a continuous path.
- **A maintained Merkle/prolly tree** — tempting, and the reframe you asked about. The verdict below is
  that it is the *wrong* everyday mechanism and the *right* backstop.

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

### §5·4 Job 3 — the backstop: an on-demand Merkle tree over the `~rev` properties

Here the reframe earns its keep, and it composes beautifully with §5·2 *because the rev is a property*:

- A Merkle tree over `(id, ~rev)` can be **computed on demand by scanning the rev properties** — no
  maintained shadow store, no second embedded storage engine, no GC, none of the write amplification Dolt
  suffered. Cassandra's on-demand model, minus Cassandra's 10TB-scan pain, because a DO caps at 10GB and
  the tree is over compact `(id, rev)` pairs, not full bodies.
- It is bounded by the job-2 watermark (Cassandra's incremental-repair trick): only rehash the range newer
  than the last checkpoint for routine verification; do the full tree only for first-contact or an
  integrity audit.
- It buys exactly what the change-log cannot: **checkpoint-free reconciliation** (two peers that have never
  synced, or whose logs diverged) and **silent-divergence / bit-rot detection** (a monotonic seq cannot
  see corruption that does not advance it).

### §5·5 The recommendation, and what stays open

**Recommended layering (trust-but-verify, the classic distributed-systems shape the prior art keeps
re-deriving):**

- **Job 1** — `~rev` hidden property, generation + content hash. *(Low-regret; recommend adopting.)*
- **Job 2** — a change-log table driving `_changes`-equivalent + a revs-diff query. *(The continuous
  path.)*
- **Job 3** — an on-demand Merkle tree over the rev properties, for bootstrap/first-contact and periodic
  anti-entropy. *(The backstop, not the hot path. Can land last, or never, without blocking 1–2.)*

**Deliberately left open for discussion (these are the real forks, and none needs deciding to start §10
Phase 0–1):**

1. Rev content: generation+hash vs opaque token vs plain hash (§5·2 leaning: generation+hash).
2. Whether the change-log is the *only* durable cursor or the Merkle backstop is built at all in v1.
3. Conflict policy (§6·3) — the one place the change model and the graph's referential integrity collide,
   and the decision most in need of your judgement.

---

## §6. The graph-specific hard parts — each a real sub-problem, not a footnote

These are the consequences of §4's inversion. None is optional for a *faithful* replica; each is where "a
trained monkey could design it" stops being true for a graph.

### §6·1 Cross-peer identity — the biggest hidden prerequisite

**Our element ids are integer rowids** (`nodes.id` / `edges.id`), faced externally as `COALESCE(uid, id)`
(`src/storage.ts`). Two independently-created graphs mint rowids **independently** — vertex 5 on peer A is
unrelated to vertex 5 on peer B. CouchDB requires a globally-unique `_id` per document and mints a UUID by
default. **Replication is meaningless without a stable cross-peer identity**, and a bare `addV()` today has
only a rowid, which is local.

So a prerequisite of replication is: **every replicated element carries a stable, cross-peer id.** The
natural home is the existing `uid TEXT UNIQUE` column — promote it from "optional user id" to "the
replication identity," minting a UUID into `uid` when the user supplied none. This interacts with job 1
(the rev is keyed by the stable id, and an edge's rev must reference its endpoints *by stable id*, not
rowid, or the same edge hashes differently on two peers). This is a write-path + schema-usage change and
is on the critical path — flagged here so it is not discovered late. It is also the single most likely
reason a naive prototype "works" on one machine and is incoherent across two.

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

### §6·3 Conflicts — why rev-trees are the wrong port, and what "conflict" even means for an edge

CouchDB keeps *all* divergent leaves and picks a deterministic winner on read (not-deleted > higher
generation > higher rev-hash lexically; `to_doc_info_path` in `couch_doc.erl`), resolving nothing itself —
"in the data model, there is no merge." Two reasons this does not port cleanly:

- **Rev-trees' whole payoff is keeping divergent versions of a record — which a graph cannot honor for a
  vertex an edge points at.** You cannot have two live "leaf" versions of vertex 5 when an edge's integrity
  depends on *the* vertex 5. Multi-leaf MVCC is exactly the feature the graph's referential integrity
  forbids at the structural level.
- **"Conflict" is richer for a graph.** A value conflict on a property is CouchDB-shaped (two writers set
  `age`). But: peer A deletes vertex 5 while peer B adds an edge into it — that is not a value fork, it is
  a *referential* conflict (an edge to a tombstone). No amount of rev-tree bookkeeping resolves it; it is
  a graph-invariant decision.

Options, to discuss:

- **Last-writer-wins by deterministic winner** (recommended default): reuse CouchDB's winner rule
  (generation, then rev-hash) *per element*, so both peers converge without coordination, and handle
  referential conflicts with a fail-closed rule (an edge to a deleted vertex is dropped, or the delete is
  refused — a policy choice). Simple, converges, never dangles.
- **Conflict *detection*, surfaced not resolved** — keep the winner live but record that a conflict
  occurred (a `~conflict` hidden property / a side list), so a human or an application traversal can
  reconcile. Couch's "co-flicked" spirit without the tree.
- **Full multi-leaf MVCC** — rejected for the structural reason above; recorded so it is not re-proposed.

This is the decision most in need of your steer, and it is downstream of the rev choice (§5·2), which is
why they are flagged together.

### §6·4 Deletes / tombstones — we have none today

`drop()` deletes rows; there is no tombstone, no record that something *was* deleted (confirmed: no
`deleted`/tombstone concept anywhere in `src/`). Replication must propagate deletions, and a pure "diff
the live sets" approach cannot tell "deleted on the source" from "not yet created on the source." So
replication needs **tombstones**: the change-log records a delete (kind, stable id, rev, `deleted:true`),
and a delete replicates as a marker, exactly as CouchDB ships a `_deleted` rev in `_changes`. Costs: a
tombstone lives until every peer has seen it (or until a purge horizon), so the log grows; a pruning
policy (CouchDB's revision-pruning analog) is a later concern but a real one. Tombstones also interact
with §6·3 (a delete is a rev like any other, and can lose to a concurrent update).

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
- **Bootstrap reuses `io()`.** A first-contact full sync is a snapshot transfer, which is exactly what
  `io()` + `IoStore` already stream, bounded-memory, both ways (`src/services/catalog/io.ts`,
  `src/iostore.ts`). Neo4j's catchup protocol validates the shape: **snapshot to bootstrap, incremental to
  stay current.** The replication engine is "io()-snapshot for the initial pull, then `_changes` deltas."

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
- **The new backend is a plain implementer.** An `HttpFederationSource.executor(url).runForeign(...)`:
  resolve the `graph` param to a configured external base URL, `POST {gremlin, bindings}` via the vendored
  `Client.submit` (or a direct `fetch` of the JSON wire shape `src/wire.ts` documents), decode the
  response, and **map it into the closed `ForeignResult` contract** (`elements | scalar | map | values`,
  `src/api.ts`). Nothing downstream (`src/compiler/rel/foreign.ts`, `src/execute.ts`) cares how the bytes
  arrived.
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

## §9. The DX — engine with two skins, and the single URL

**Decision (from our discussion): build the replication engine once; expose it as BOTH a Gremlin service
and a thin HTTP endpoint.** The engine is the reusable core; the skins are ergonomics.

- **Gremlin-service skin** — on-brand with `io()` (which is itself a service, `io.ts`) and the "no separate
  control plane" guardrail (`.claude/rules/management-api.md`). E.g. `g.call("replicate", {from: "<url>"})`
  / `{to: "<url>"}`, or an `io()`-shaped `g.io("<url>").pull()`. Reuses the barrier/segment substrate and
  the worker residency.
- **HTTP-endpoint skin** — the CouchDB single-URL DX you want: a `POST /gremlin/{g}/_replicate {source,
  target, continuous?}` on the existing router (`src/router.ts`; new routes slot in beside the GraphQL edge,
  matched before the generic `{g}` path). "Point a local graph at production and pull it down" is one
  request.
- **The peer-facing endpoints** the engine speaks between two mogwai servers — the mogwai-native analog of
  CouchDB's protocol. Either literally adopt CouchDB's names (`_changes`, `_revs_diff`, `_bulk_docs`,
  `_local/{id}`) for familiarity and possible interop, or a mogwai-native set. Recommendation: mirror
  CouchDB's *shapes* (they are well-designed and §5's model maps onto them), on mogwai routes. Direction is
  the caller's: pull = "I am target, you are source"; push = the reverse; same engine, roles swapped (§4·4).

---

## §10. The phased plan — unlock order

Each phase is independently valuable and lands green before the next. Ordered so the shared substrate and
the smallest proof come first, and the genuinely hard graph semantics come after the transport is trusted.

- **Phase 0 — the outbound HTTP client + external federation.** Build `HttpFederationSource` (§8) on the
  vendored `gremlin` client. Smallest, most independent win; ships a real feature (federate to an external
  TinkerPop server); proves the outbound client and residency story that replication will reuse. No schema
  change, no rev, no change-log. *Gate: a mogwai graph federates a sub-traversal to an external Gremlin
  server and merges the result.*
- **Phase 1 — cross-peer identity + the rev property (§6·1, §5·2).** Promote `uid` to the stable
  replication id (mint a UUID when absent); add the `~rev` hidden property and the touch-on-write hook
  (generation + content hash, keyed by stable id; edge rev references endpoints by stable id). Pure local
  substrate — no networking yet — and independently testable (a graph's revs are stable across
  export/reimport). *Gate: every element has a stable id and a rev; identical content converges to the same
  rev; revs survive an `io()` round-trip.*
- **Phase 2 — the change-log + the read side (§5·3, §6·4).** Add the change-log table + append-on-write
  (including tombstones for deletes). Expose the `_changes`-equivalent (a since-cursor scan) and the
  revs-diff query. Still server-only — no replication engine, but a peer can now be *asked* what changed
  and what it's missing. *Gate: `_changes?since=N` and revs-diff return correct deltas incl. deletes.*
- **Phase 3 — the replication engine + checkpoint + skins (§9, §5, Neo4j catchup).** The pull/push loop:
  bootstrap via `io()` snapshot, then `_changes` → revs-diff → transfer (vertices before edges, §6·2) →
  apply idempotently → checkpoint (`_local`-analog, deterministic replication id). Wire up both skins
  (Gremlin service + `_replicate` endpoint). *Gate: pull a remote graph to a fresh local graph; re-pull is
  a resumable no-op; push is the same with roles swapped.*
- **Phase 4 — conflicts + continuous (§6·3).** Deterministic-winner convergence, referential-conflict
  policy (edge-to-tombstone), optional conflict *surfacing*; continuous replication (a live `_changes`
  tail, or interval-poll). *Gate: two peers each mutate and cross-replicate; both converge; no dangling
  edge; deletes propagate.*
- **Phase 5 — the anti-entropy backstop (§5·4).** On-demand Merkle over `(id, ~rev)`, watermark-bounded,
  for first-contact reconciliation and integrity verification. Optional — the layering is designed so
  Phases 1–4 are complete without it. *Gate: two peers with divergent/absent history reconcile without a
  shared checkpoint; a silently-corrupted row is detected.*

---

## §11. Open design decisions — to resolve in discussion

1. **Rev content** (§5·2): generation+hash (leaning) vs opaque token vs plain hash.
2. **Conflict policy** (§6·3): deterministic LWW (default) vs LWW + conflict surfacing vs — rejected —
   multi-leaf. Referential-conflict rule for edge-to-deleted-vertex (drop edge vs refuse delete).
3. **Peer protocol naming** (§9): adopt CouchDB endpoint names (familiarity/interop) vs mogwai-native.
4. **Backstop in v1?** (§5·4/§5·5): ship the Merkle anti-entropy in the first cut or defer to Phase 5.
5. **Tombstone pruning horizon** (§6·4): when may a delete marker be reclaimed.
6. **Filtered replication** (CouchDB selectors/doc_ids): a graph-scoped filter (a sub-traversal defining
   the replicated subgraph) is the natural analog and composes with our engine — in scope for the design,
   later for the build. Note it interacts with referential integrity (a filtered subgraph can produce
   dangling edges by construction).

---

## §12. Traps — recorded so they are not rediscovered

- **The session extension will lie to you** (§2). It is present in `bun:sqlite` and absent on DO, so a
  changeset-based prototype passes every dev test and cannot ship. Any change-tracking must be plain SQL on
  both runtimes.
- **rowid is not identity** (§6·1). Keying replication on rowid works on one machine and is incoherent
  across two. The stable id is `uid`, minted if absent, and an edge's rev must reference endpoints by
  stable id, not rowid.
- **A Merkle tree is not free even "on demand"** (§5·3). Its O(diff) is *comparison*; construction is
  O(size). Use it as a watermark-bounded backstop, never the hot path — the field (AT Protocol, Cassandra,
  Dolt) re-derived this repeatedly.
- **Never re-execute the query on the far side** (§3). Ship materialized mutations (effects), not Gremlin
  to replay — replaying a non-deterministic traversal diverges peers.
- **Dangling edges** (§6·2). Vertices before edges, always; a cross-batch edge to an unreplicated endpoint
  waits or fails closed — never writes a dangling row. We already enforce this on load; the wire is the
  same discipline.
- **Don't put `fetch` in the store tier / DO compile path** (§7). Outbound waits are worker-residency, like
  federate's barrier.
- **A rev-tree is the wrong port** (§6·3). Its payoff (keeping divergent leaves) is the exact thing graph
  referential integrity forbids for an element another element points at.

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

**Merkle / prolly-tree reframe** (real, but a backstop not the hot path):
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
