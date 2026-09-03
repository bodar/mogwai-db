# Replication, and mogwai as an HTTP client of another graph — design + plan

_Settled design + phased build plan (not a changelog). It records what a CouchDB-grade replication
experience takes on top of what we have, the decisions (all made — §11), and the build order (§10). The
authority is the code; CouchDB / prior-art claims cite the canonical source. Governing rule throughout (§4):
**follow CouchDB; deviate only when empirically better or graph-forced.**_

Two features, one foundation:

1. **Replication** — the CouchDB DX: point a local graph at a remote one over HTTP and pull it down (or push
   up), incrementally, resumably, direction your choice. Debug a production graph on your laptop through one URL.
2. **External-HTTP federation** — `federate()` crosses to a sibling graph over DO RPC today
   (`src/services/catalog/federate.ts`); the same seam can reach an *external* TinkerPop server over HTTP.

Both need the one thing mogwai has never been: **an outbound HTTP client of another graph.** Build it once.

---

## §1. The experience we are chasing, and why it does not exist yet

CouchDB's DX: `POST /_replicate {source, target}` and you are done — push and pull are one operation with the
endpoints swapped, it survives disconnection, resumes, and never silently loses a write ("a replicator simply
connects to two DBs as a client, reads from one and writes to the other" —
[couchdb "Is it like Git?"](https://docs.couchdb.org/en/stable/replication/conflicts.html)).

**No graph database offers this.** Mainstream graph DBs replicate via *intra-cluster* Raft + async
read-replica log-shipping — never independent-instance sync. Where a change feed exists the vendor disclaims
it (Neo4j: CDC "is not the right tool to create an exact copy of a Neo4j database"); the one cross-deployment
logical attempt (ArangoDB DC2DC) was *retired*; the only CouchDB-like graph system (GUN.js) gets the DX only
by dropping rich querying and resolving conflicts below graph invariants. So this is real whitespace — and a
natural fit: one graph is one Durable Object, already a standalone URL-addressed graph (`/gremlin/{g}`),
exactly the topology CouchDB assumes and clusters forbid. (Sources: §13.)

---

## §2. The platform envelope — LAW, do not re-derive

**Replication must be LOGICAL (graph elements over HTTP), never physical (storage/WAL) — forced, not
chosen.** On Cloudflare DO we get `ctx.storage.sql` and nothing beneath it: no file/WAL, no VFS, no FUSE, no
loadable extensions (only FTS5/JSON/math). So every physical mechanism is out — Litestream/LiteFS (file/WAL),
dqlite/libSQL (VFS/frame), cr-sqlite (loadable extension), and Cloudflare's own DO WAL replication (exists,
but platform-internal, no developer hook). **The sharpest trap: the SQLite session extension is in
`bun:sqlite` but NOT on DO** — a changeset prototype passes every dev test and cannot ship. *A mechanism not
present on BOTH runtimes is not a mechanism* (the `src/cf-limits.ts` discipline).

What is left is exactly the logical model, in application code on plain SQL — validated by rqlite (replicate
the deterministic operation, not bytes) and cr-sqlite (a logical-clock changes model merged by ordinary SQL).
That is precisely why lifting CouchDB's logical protocol is right, not a compromise.

---

## §3. Prior art — the gap, and the few lines worth stealing

Full landscape in §13; three takeaways are load-bearing rather than survey noise:

- **The gap is real** (§1) — no serious graph query engine offers independent-instance, over-HTTP,
  disconnection-tolerant sync. We are not missing a standard solution.
- **A change feed is not a replication protocol** (Neo4j CDC; Neptune Streams only within AWS infra) — an
  exact copy needs the rev/checkpoint discipline, not just a feed.
- **Ship the materialized mutation, never re-execute the query on the far side** (FalkorDB and all) — a
  replayed non-deterministic traversal diverges peers. (Trap, §12.)

One mechanism we explicitly REJECT: Neo4j's two-tier catchup (incremental + full-store-copy fallback) — it
exists only because Neo4j's tx log rotates, a premise our design avoids (§7).

---

## §4. What ports from CouchDB, the inversion, and the governing principle

The transferable core is **five primitives**, none of which is the document data model
([replication protocol](https://docs.couchdb.org/en/stable/replication/protocol.html)):

1. A **monotonic change cursor** — `_changes?since=N`, an *opaque* cursor (never parse it).
2. A **cheap "what are you missing?" diff** — `_revs_diff`, a pure key lookup that never touches a body. *The
   efficiency engine.*
3. A **resumable checkpoint** — a deterministic replication-id, stored in a non-replicated `_local/{id}`.
4. **Direction-agnostic roles** — push = pull with source/target swapped; the replicator is just an HTTP
   client of both.
5. **Idempotent replay** — writes at a stated rev (`_bulk_docs {new_edits:false}`), so re-running is a no-op.

**What does NOT port is the reason Couch's replicator is "trivial": every record is independent.** A graph is
nothing but joins — an edge references two vertices by identity. That inversion is the root of every
graph-specific hard part in §6.

**Governing principle (LAW): CouchDB is the gold standard; deviate ONLY when we can empirically do better or
when graph semantics force it.** "Simpler for us" is not a licence (it produced a wrong first cut — see the
traps in §12). Measured against it, the design has exactly **two** graph-forced deviations: the **transfer
ordering** vertices-before-edges (§6·2) and the **referential conflict** rule (§6·3) — both rooted in "an
edge is the JOIN documents don't have." Everything else follows CouchDB. (One thing is *orthogonal*, not a
deviation: a local integer rowid as the fast join key — §6·1 — an SQLite optimization a document store has no
need for.)

---

## §5. The change model

CouchDB's `_rev` bundles two separable jobs, and separating them is what makes this tractable:

1. **Identity / version / conflict** — answered by the rev (a per-element `generation-hash`), §5·1.
2. **The `since` cursor** — answered by a by-sequence index, §5·2.

A tempting third job — a **Merkle-tree backstop** for checkpoint-free reconciliation / bit-rot — is NOT
needed (§5·3). We land on CouchDB's answers for 1 and 2 and stop there.

### §5·1 The rev — generation + content hash, a dedicated column

**DECIDED: `rev` = generation + content hash, a dedicated column on `nodes`/`edges`** (alongside `gid`, §6·1;
both columns, not properties — §6·5 for why). This is CouchDB's model. Generation is a *logical* clock
(increments from the parent rev), deliberately NOT wall-clock time — a time-based rev would make the conflict
winner depend on whose clock was right. Content hash is the entropy. Together: idempotent replay (identical
writes converge to the same rev) AND the deterministic conflict winner §6·3 needs (higher generation, then
higher hash). `_revs_diff` is then a query over the `gid`/`rev` columns, not a bespoke mechanism.

The real cost is *maintenance*, not storage: every mutation recomputes the rev, which means reading the
element's current content (O(element size) per write) — a "touch the rev on write" hook, cheapest as an
in-place column update (§6·5). Because we preserve conflicts (§6·3), `rev` holds a bounded rev-TREE (current
leaf(s) + stemmed ancestry) as a JSONB blob, winner cheap off the front; losing leaves live in a
shadow/conflict store read only by a conflict-aware query.

### §5·2 The `since` cursor — a by-sequence index, exactly like CouchDB

**CouchDB's `_changes` is not an append-only op-log; it is a by-sequence index with ONE entry per document**
(the doc's latest seq — a write *moves* the entry, doesn't append). So the feed is **current-state-sized
(O(elements), not O(writes))**, and `since=0` returns each live doc once — which is why "keep everything from
0" is cheap (it is just current state, which we already store).

**DECIDED: a per-element `seq` column (last-modified sequence from a per-graph monotonic counter), indexed.**
`_changes?since=N` is `WHERE seq > N ORDER BY seq`; a write bumps the element's `seq` (and rev). This is
strictly better than an append-only change-log table (which grows O(writes) and needs pruning the by-seq
index does not — trap, §12).

### §5·3 No Merkle backstop

The content-addressed-tree reframe (prolly/Merkle) genuinely gives O(diff) comparison, but it is **dropped**:
CouchDB has no Merkle tree and doesn't need one, and neither do we. First-contact / no-shared-checkpoint
reconciliation is already `since=0`; bit-rot detection is the only thing it uniquely adds and is not
graph-forced. And the tree isn't free — building/maintaining it is O(size) write-amplifying work (AT
Protocol's greenfield MST *retreated* to a causal log for its sync path). Revisit only on a measured need
(huge graphs reconciling frequently without checkpoints, or a hard integrity-audit requirement). Trap, §12.

---

## §6. The graph-specific hard parts

These are the consequences of §4's inversion — where "a trained monkey could design it" stops being true.

### §6·1 Cross-peer identity — a uuid_v7 `gid`, separate from the local rowid

**A rowid can never be cross-peer identity.** Two instances mint rowids independently — including two
*replicas of the same graph, both writing*: prod and a laptop in sync (counters at 1000) each create a
different vertex → both rowid 1001 → they name two distinct vertices on replication. A per-store sequential
rowid is structurally unusable as identity.

**DECIDED: split the two jobs.**

- **`rowid` — the local, sequential, fast join key; unchanged.** `INTEGER PRIMARY KEY`; owns B-tree insert
  locality and is the covering-index join key (`e_out`/`e_in`). Never leaves the store as identity. The only
  place "sequential is load-bearing" lives.
- **`gid` — global identity: a `uuid_v7` (RFC 9562), one of CouchDB's own id algorithms
  (`couch_uuids.erl` `v7_bin`; its *configured default* is `sequential`, `uuid_v7` opt-in).** 128 bits = 48-bit ms
  timestamp + **74 random bits**; those random bits make it globally unique with **no instance prefix, no
  coordination, no collision fragility** (two independent deployments collide only on the same ms *and* the
  same 74-bit draw — never). uuid_v7's timestamp buys only secondary-index locality, never uniqueness, so it
  does not reintroduce a clock-skew *correctness* dependency. Immutable, assigned at element creation. (Packing
  identity into the 64-bit rowid with a random prefix was explored and rejected — it made every prefix clash a
  *total* collision; trap, §12.)

**The local↔global mapping is the one real cost, and it rides existing machinery.** A replicated element gets
a fresh local rowid; its immutable `gid` travels with it. Edges reference endpoints by `gid` on the wire; on
apply we translate `gid`→local rowid — exactly the endpoint resolution `BatchingLoader` already does
(`src/bulk.ts`), keyed on the indexed `gid` column. Ordinary single-graph traversal touches only rowids;
`gid` surfaces at replication and federation-merge boundaries. `uid` stays free for users; interned label ids
stay local (replication carries label/key NAMES, as `io()`/GraphSON already do).

**Payoff — `gid` deletes ~375 LOC of federation machinery and closes the last open federate item.** Multigraph
federation today disambiguates colliding sibling rowids in a merged stream via a first-class `graph`
provenance channel + composite `(graph, id)` rejoin (`unifiedBoundGraph`, the `graph` `ChannelRole` + its four
policy-table entries, `graphTag`/`LOCAL_GRAPH`, `postMergeTail`'s allow-list —
`src/compiler/rel/{boundgraph,segment,lower/slice}.ts`, `src/channels.ts`, ~375 LOC). It exists only because
two graphs can each mint rowid 5. With a globally-unique `gid`, a merged stream dedups/groups/rejoins by bare
`gid` through the ordinary `BoundGraph`; the `graph`-channel apparatus deletes, and the deferred gaps it only
partly covered (`hasLabel`/`has`/movement/`group` over a merged multi-graph stream — the last "multi-graph
mixing / cross-graph identity" item in `docs/outstanding-work.md`) just compose. (The separate ~640 LOC of
id-carry+rejoin for a *detached* foreign element — `foreign.ts` — is a physical-distribution concern,
unaffected.)

### §6·2 Referential integrity and ordering — the read half is already solved

An edge references two vertices; applying it before its endpoints is a dangling write. We already solve this
on load: **the GraphSON two-pass loader lands every vertex, then every edge** (`loadGraphsonStreaming`,
`src/formats/graphson.ts`). Replication is the same discipline over the wire: **transfer vertices before
edges**, resolve endpoints against already-landed rows (`BatchingLoader`, `src/bulk.ts`). A cross-batch edge
whose endpoint has not yet arrived waits or fails closed — never a dangling row (trap, §12).

### §6·3 Conflicts — CouchDB preservation, with one graph-forced exception

**DECIDED: preserve conflicts, CouchDB-style — never discard-LWW.** Keep all divergent leaves, pick a
deterministic winner on read (not-deleted > higher generation > higher rev-hash lexically —
`to_doc_info_path`, `couch_doc.erl`), resolve nothing automatically, surface losers to the application (a
`~conflicts` analog of `?conflicts=true`). Reads return the winner from the normal live rows (hot path
untouched); conflicts are invisible unless asked for. Multi-leaf does NOT break graph invariants — an edge
references a vertex by stable id, constant across leaves; the divergent leaves are about *content*
(properties/labels), which is pure CouchDB.

**The one place with no CouchDB analog is the referential conflict**: peer A deletes vertex V while peer B
keeps/adds an edge E→V. The CouchDB principle still binds — **replication always succeeds; never reject a
write, never silently lose one** — so "refuse the delete" (rejection) and "drop the dangling edge" (data
loss) are both out. Instead we extend CouchDB's own rule ("not-deleted beats deleted"): **a referencing edge
is an existence-claim, so E resurrects V and V's delete becomes the surfaced conflict** — never rejects, never
loses, and keeps the live graph consistent by construction (V is back, E doesn't dangle), no quarantine store.
This is DECIDED, not a knob: delete-wins would invert CouchDB's rule and add machinery it doesn't have. (Trap,
§12.)

Honest cost: preserving conflicts is heavier than discarding — content becomes rev-versioned (winner live,
losers in the shadow store). Read≫write makes conflicts rare, so the shadow store is seldom populated; it is
what "never lose a write" costs, and CouchDB pays it too.

### §6·4 Deletes / tombstones, and why up-front pruning is NOT needed

`drop()` hard-deletes and there is no tombstone today, but replication must propagate deletes (a live-set diff
can't tell "deleted on source" from "not yet created"). So a delete records a **tombstone** (§6·5) carrying
its own `seq`, appearing in the `_changes` feed exactly as CouchDB ships a `_deleted` rev.

**No up-front pruning.** The by-seq feed is current-state-sized (self-bounding, §5·2). Rev-tree ancestry is
depth-stemmed — **DECIDED: copy CouchDB's `_revs_limit` default of 1000** (a config knob, no known reason to
differ). Only tombstones truly accumulate, and CouchDB itself keeps them (purge is manual, discouraged);
deletes are infrequent and a tombstone is tiny, so we match CouchDB — keep them, offer a manual purge later
(§10 Phase 6). `since=0` is always the full sync; a retention horizon is not needed.

### §6·5 The schema deltas — CouchDB-named where it makes sense

Three columns on `nodes` and `edges`, named to mirror CouchDB's document fields (SQL-formatted — snake_case,
no `_` field-prefix, since a column needs no "reserved" marker):

| CouchDB field | mogwai column | type | notes |
|---|---|---|---|
| `_id` | `gid` | BLOB (16-byte uuid_v7), indexed | global identity (§6·1). NOT `id` — that stays the rowid. |
| `_rev` / `_revisions` | `rev` | BLOB (JSONB) | generation + content hash + bounded rev-tree (§5·1). |
| `seq` / `update_seq` | `seq` | INTEGER, indexed | the by-sequence cursor (§5·2). |

`id` (rowid) and `uid` (now free for users) are unchanged. Deletes (`_deleted`) go to a small **`tombstones`**
table, not a `deleted` flag on live rows — a flag would force `WHERE deleted=0` on every traversal (hot path).
`tombstones(gid BLOB, rev BLOB, seq INTEGER, kind TEXT)`, so `_changes?since=N` is a UNION of live
`nodes`/`edges` `WHERE seq > N` and `tombstones WHERE seq > N`. These are dedicated columns (not hidden
properties) for storage/perf: a property row would store the key string inline on *every* element (keys aren't
interned) plus a second index — double-digit GB at ~10⁸ elements against the 10 GB DO ceiling — and it is also
more CouchDB-faithful (Couch stores `_id`/`_rev` as cheap inline fields). Cost: a schema change + `gid`/`rev`
plumbing in the format adapters (`src/formats/`) so they round-trip.

---

## §7. The transport — mogwai as an outbound HTTP client — ✅ LANDED (federation half, Phase 0)

Both features need mogwai to call out over HTTP. The transport is modelled as ONE uniform seam,
`Http = (Request) => Promise<Response>` (`src/api.ts`) — the exact shape a server handler already has
(`makeRouter` returns one; a Worker `fetch` export is one; global `fetch` satisfies it). Every outbound
caller takes an injected `Http`; the ONLY place that touches global `fetch` is the production default
(`defaultHttp`, `src/http-federation.ts`). That uniformity is load-bearing, not cosmetic: a test hands the
outbound client a *server's own router handler* and the whole hop runs IN MEMORY, no socket — the same
discipline L3's cucumber runner already uses (`test/support/in-memory-transport.ts`).

- **We build the GraphBinary REQUEST directly, NOT via `Client.submit` — a deliberate, measured deviation.**
  Three findings against the vendored client as the driver, each grounded in the code (the authority):
  1. **Its read/`deserializeValue` side already keeps properties** — only its *write*/`serialize` side
     hardcodes them empty (which is why the server hand-rolls `vertexBuffer` etc.). So the earlier claim
     that we must "register property-carrying element serializers to *decode* a response" was WRONG (it
     retired the note that shipped in `ca88e61`). The real gap is that the stock reader **type-collapses**
     (a Long → a JS Number, a UUID → a String), which a federated element's props and a pushed reducer's
     scalar cannot afford — a LOCAL tail over the detached result (`has("age", gt(30))`, `order().by("age")`)
     must be correct at depth. So we own the decode: `decodeForeignResult` (`src/foreign-decode.ts`), a
     TYPE-PRESERVING GraphBinary response decoder — the exact inverse of `execute.ts`'s framing, capturing
     each value's wire DataType as its `{t,v}` tag, decoding elements at any depth (a `fold()` of vertices).
  2. **`inject($map)` must reach the peer verbatim.** The federate barrier's mid-traversal correlation
     synthesizes `g.inject($map).unfold().group().by(Column.keys).by(…)`, which only parses because of our
     carried grammar patch. The vendored client builds/validates the request client-side and encodes params
     as a gremlin-lang string, so it could reject it; we pass the string untouched.
  3. **the `$map` binding is a typed `Map`** (parent-ordinal → injected value) — JSON cannot carry it, but a
     GraphBinary MAP does. So the request is the exact inverse of the server's `wire.ts parseRequest`
     (`encodeGraphBinaryRequest`, `src/http-federation.ts`), reusing the same `ioc` serializers as the decode.
  Net: we reuse the client's GraphBinary SERIALIZERS (decision #4, reuse-first) and hand-roll only the thin
  request/response framing our wire layer already owns — and gain portability (no undici/dispatcher to bundle
  on a Worker) and in-memory testability for free.
- **The replication peer client** is a thin `Http` caller over the §9 endpoints, decoding the same
  GraphBinary/JSON shapes our server produces (`src/http.ts`, `src/wire.ts`).
- **ONE mechanism — `_changes?since=N`.** Because the by-seq feed is current-state-sized and we keep
  everything (§5·2, §6·4), `since=0` reconstructs a full replica and `since=checkpoint` an incremental one —
  the same mechanism, no snapshot-vs-incremental tier and no retention horizon (this is why we reject Neo4j's
  two-tier catchup, §3). The one refinement: a fresh full pull of a large graph is better bulk-streamed than
  driven through a chatty changes→revs-diff loop, so **`io()` + `IoStore` is the efficient *implementation* of
  the `since=0` case** (bounded-memory, R2 multipart) — an optimization of one mechanism, not a second one.

**LAW: the HTTP edge stays out of the store tier.** Outbound calls belong at worker/edge residency, the way
federate's barrier declares `residency: 'worker'` to free the DO across the wait (`src/compiler/segment.ts`).
A replication *pull* driven from the Worker is the same story; a *server* answering `_changes`/`_revs_diff` is
ordinary read work.

---

## §8. External-HTTP federation — a `FederationSource` over the wire

The smaller, cleaner feature and a perfect Phase 0 — it proves the outbound client with almost no new
concepts:

- **The seam is already abstract.** `federate()` depends only on `FederationSource`
  (`src/compiler/segment.ts`): a one-method `executor(id).runForeign(gremlin, params, depth) →
  Promise<ForeignResult>`. RPC is not hardwired — the CF/Bun managers just happen to implement it; `federate.ts`
  imports no RPC types.
- **The trigger is the `graph` param becoming a URI — no new Gremlin surface. ✅ LANDED.** A *relative* id is
  a local sibling; a *fully-qualified* `http(s)` URI dispatches to an `HttpForeignExecutor`
  (`src/http-federation.ts`) that POSTs a GraphBinary request (§7) and maps the response into the closed
  `ForeignResult` contract (`elements|scalar|map|values`, `src/api.ts`) via `decodeForeignResult`. The
  dispatch is one shared line, `remoteOrLocal(id, http, local)`, called by BOTH managers' `executor(id)`
  (`BunGraphManager`, `CloudflareGraphManager`), so `federate.ts` is UNTOUCHED — it still just calls
  `source.executor(graph).runForeign(…)`. Downstream cares only about the contract, not how the bytes arrived.
  Verified end to end in memory (`test/http-federation.test.ts`): source form with typed props, a pushed
  `count()` scalar, a value-stream tail, a map terminal, a peer error surfacing as a throw, and — the critical
  barrier path — the `as()/select()` mid injection carrying its bound `Map` through `inject($map)` over the wire.
- **Honor two invariants**: thread + increment `depth` (`guardFederationDepth`) so a hop stays bounded; and
  translate faithfully into `ForeignResult` (fail closed on a shape mismatch). `rpcTry` (`src/rpc.ts`) is
  DO-RPC-only — an HTTP backend uses ordinary `throw`/`catch`. **Follow-up (noted, not a Phase 0 gate):** the
  local depth guard bounds the local chain, but `depth` is not yet threaded to the peer (which compiles a fresh
  request at depth 0), so a cyclic *cross-server* federate is bounded per-server, not globally — hardening is a
  `federationDepth` request field the peer honours (touches `framedAsync`'s signature across implementations).

---

## §9. The DX — one-shot in Gremlin (standard GLV); ongoing replication in the management API

**LAW: the GLV is not ours to extend — STANDARD Gremlin only.** No invented step or method (`g.io(url).pull()`
in an early draft was exactly this mistake). A GLV change needs a compelling reason AND an upstream PR — the
bar we cleared once for federate's `inject($map)` varargs. This decides the split cleanly, because Gremlin is
a *one-shot* language (even `io()` is a one-shot bulk load) with no idiom for a background-running query.

- **One-shot pulls stay in Gremlin, already STANDARD GLV — no new surface:** cross-graph *query* via
  `federate` with a URI (§8); bulk *transfer* via `io()` with a URL (`g.io(url).read()`/`.write()` — the io
  registry just interprets the string; today an R2 key, tomorrow another database over HTTP).
- **Ongoing replication is a persistent config + a scheduler — the management API, NOT Gremlin.** CouchDB's
  shape (`replicator.rst`): a replication is a *document* in `_replicator` (`source`, `target`, `continuous`,
  `filter`, `checkpoint_interval`) run by a scheduler with a state machine and introspection at
  `_scheduler/jobs`/`_scheduler/docs`. The mogwai analog: a CRUD management interface over persistent configs
  on the existing REST router (`src/router.ts`); a **DO-alarm-driven scheduler** ("continuous" is a periodic
  wake→`_changes`→apply→sleep with crash-backoff, since a DO hibernates — not a held connection); and
  introspection endpoints.
- **The UI falls out of OpenAPI for free.** We already generate an OpenAPI spec + docs UI (`src/docs.ts`,
  `/docs` + `/openapi.json`). Documenting the config CRUD + introspection there gives a Fauxton-equivalent with
  no bespoke front-end. Default to documenting everything publicly.

**Peer-facing sync endpoints** mirror CouchDB's shapes on mogwai routes — `_changes?since=N`, revs-diff, bulk
apply, `_local`-analog checkpoint. We adopt the shapes because they are good and §5 maps onto them, NOT for
wire interop (§9·1). Direction is the caller's: pull = "I am target, you are source"; push = the reverse; one
engine, roles swapped.

### §9·1 CouchDB wire interop is a non-goal

A generic CouchDB replicator moving our elements as documents would ignore vertices-before-edges ordering
(§6·2), break referential integrity, and not share our id/rev/conflict semantics — a dangling, corrupt graph,
not a replica. We follow CouchDB's *design* and mirror its endpoint *shapes*; wire-compat with a real CouchDB
is out of scope. Our peer protocol is mogwai↔mogwai.

### §9·2 The control-plane store — dedicated tables, CouchDB-named

Scheduler/config/job state lives in **dedicated tables in the graph's own DO SQLite — not dogfooded as a
graph.** Dogfooding is right where data is genuinely graph-shaped and user-facing (the replication payload IS
a graph; federation IS the engine), but control-plane metadata is the wrong fit: our "graph" unit is a whole
DO with the full schema (vs CouchDB's lightweight db), the state is tiny/local/churny/hot-path, and it must
NOT be replicated or versioned (you never replicate your job state; CouchDB itself excludes
`_replicator`/`_local`). A plain table is non-replicated by construction; the queryable surface comes from
REST + OpenAPI, not graph storage. Field names mirror CouchDB (SQL-formatted):

- **`replication_checkpoint`** (CouchDB `_local/{replication_id}`): `replication_id TEXT PRIMARY KEY,
  session_id TEXT, source_last_seq, replication_id_version INTEGER, history BLOB` — `history` a JSONB array of
  session records with CouchDB's field names (`session_id, start_last_seq, end_last_seq, recorded_seq,
  start_time, end_time, docs_read, docs_written, doc_write_failures, missing_checked, missing_found`).
- **`replication_config`** (CouchDB `_replicator` doc): `id TEXT PRIMARY KEY, source TEXT, target TEXT,
  continuous INTEGER, create_target INTEGER, filter TEXT, checkpoint_interval INTEGER, use_checkpoints
  INTEGER` — `filter` holds the captured traversal for filtered replication (§11).
- **`replication_job`** (CouchDB `_scheduler/docs`+`jobs`): `config_id TEXT, replication_id TEXT, state TEXT,
  error_count INTEGER, info BLOB, last_updated, start_time` — `state` uses CouchDB's vocabulary
  (`initializing / running / pending / crashing / completed / failed`).

**System HTTP URLs take the `_` prefix (CouchDB's convention), not `~`.** `~` is TinkerPop's *hidden-property*
marker (and `_` is a legal Gremlin property key, so `_` can't be the hidden marker in property space); in URL
space `_` is the near-universal REST system-endpoint marker, it is what CouchDB's endpoint names already
carry, and it reserves the namespace for a future CouchDB-style `_design`/`_view` rendering surface. Each
layer keeps its own authoritative marker; the difference signals the layer boundary.

---

## §10. The phased plan — unlock order

Each phase is independently valuable and lands green before the next.

- **Phase 0 — outbound HTTP client + the one-shot Gremlin surfaces (§7, §8, §9). ✅ LANDED.** URI-aware
  `federate` (relative = local sibling, absolute = remote HTTP via `HttpForeignExecutor`) + `io()` from a URL —
  both STANDARD GLV, no schema change. The transport is the one `Http = (Request)=>Promise<Response>` seam
  (`src/api.ts`), so both features are validated ENTIRELY IN MEMORY against a server's own router handler (no
  socket): `test/foreign-decode.test.ts`, `test/http-federation.test.ts`, `test/http-io.test.ts`. CouchDB
  vendored alongside (§14). *Gate MET: federate a sub-traversal to a peer, decoding vertices/edges WITH typed
  props (and the `inject($map)` mid-injection barrier path); `g.io(url).read()` imports a GraphSON document
  over HTTP.* Two things turned out NOT as §7 first sketched, both corrected there: no custom element
  DESERIALIZER is needed (the client's read side keeps props; we own the decode only for type-fidelity), and
  we build the GraphBinary request directly rather than via `Client.submit`. io()-from-URL is a document
  fetch (GraphSON/CSV) — a live-peer full pull is Phase 3's job, and io WRITE to a URL fails closed.
  **Browser lift (2026-09-03) — the one runtime Phase 0 first missed.** The per-graph Worker
  (`GraphWorkerHost`) now takes the same injected `Http` seam and wires `httpAwareIoStore` +
  `remoteOrLocal`, so io()/federate over an http(s) URL works in the browser exactly as on Bun/CF (a
  relative id/path stays local — OPFS / a sibling Worker — a URL fetches over the seam). All three
  runtimes now match. The seam is ALLOWLISTED (the SSRF guard added alongside — `src/http-allowlist.ts`,
  empty allowlist ⇒ deny all), fed by one unified `MogwaiConfig` (`src/config.ts`) each runtime builds
  from its native source: Bun flags/env, a Worker's `env` (a structured `CONFIG` object var), and in the
  browser the page's inline-`<script>` JSON read by the bootstrap and handed to each Worker at boot
  (`configFromBrowser`). Test: `test/graph-worker-http.test.ts` (in-memory WASM, under Bun).
- **Phase 1 — the `gid` + `rev` columns (§6·1, §5·1, §6·5). ✅ LANDED.** `gid` (uuid_v7 BLOB,
  immutable, UNIQUE-indexed) and `rev` (`{gen, hash}` JSONB) columns are on `nodes`/`edges` (`src/storage.ts`).
  A portable pure-JS uuid_v7 minter (`src/uuid.ts`) and SHA-256 (`src/hash.ts`, vector-tested), and the rev
  model (`src/rev.ts`, CouchDB's chained `new_revid`). Both derived columns are (re)computed by ONE post-write
  refresh (`src/refresh.ts`) run by `frameResolved`, keyed on a UNIFORM `dirty` flag (+ partial index) — the
  single recompute marker for gid, rev, and any future derived column. **The write barrier was examined and
  rejected as the mechanism** (a write frames its own output, entangled with its `RETURNING` bindings — a
  post-write refresh is the honest shape; recorded in the commit history). Landed + green on trunk:
  - ✅ `gid` on the bulk/format path (mint-on-load, GraphSON preserve / CSV re-mint) and the compiled path
    (addV/addE/mergeV/mergeE via the refresh); two graphs never collide; gid survives an `io()` round-trip.
  - ✅ the unified `dirty` marker (`gid IS NULL` → `dirty` flag); a create is born dirty, the refresh clears it.
  - ✅ `rev` on the compiled CREATE path: every created element gets `{gen:1, hash}`; identical content
    converges across independent graphs; an edge's rev references its endpoint gids.
  - ✅ **rev recompute on MUTATION (touch-on-write).** `markDirty(elem, owners)` is one RelIR `update`
    (`UPDATE <nodes|edges> SET dirty = 2 WHERE id IN <owner ids>`, the twin of `deleteOwnedBy`, O(plan
    size) via `InQuery`), spliced once per content-mutation site over the OWNER ELEMENTS only — a create
    is already born dirty so it never marks. Sites: `elementProperty` (property add/remove),
    `labelMutationScope` (addLabel/dropLabel, vertex-only), `propertyDrop` (owner element derived via the
    new `propertyOwnerId`; its snapshot now carries both the property row id and the owner id from one
    lowering), and both merge onMatch/tail arms (mergeV/mergeE, guarded on there being a write, so a pure
    match bumps nothing). A mutation chains the rev (gen 2, new hash); an untouched sibling keeps its rev.
  - ✅ **rev through the bulk/format path.** The bulk loader unifies onto the ONE gid/rev authority
    (`src/refresh.ts`): gid stays preserve-or-mint inline (always present); `rev` is preserve-or-COMPUTE —
    a carried rev (a mogwai GraphSON dump ships one) lands verbatim born CLEAN (idempotent replay), an
    absent rev lands born DIRTY so `flush`'s `refreshElements` computes `{gen:1, hash}` from content, the
    SAME authority the compiled path uses (so a rev-less bulk load and a compiled create converge). Bulk
    refreshes per flush over only that flush's dirty rows (streaming-safe). GraphSON carries `rev` as a
    nested `{gen, hash}` object mirroring gid; `'replace'` chains a matched vertex's rev via the new
    reusable `markMembersDirty` (`setwrite.ts`, the set-based twin of `deleteMembers`).
  *Gate MET: every element has a stable `gid`/`rev`; identical content converges to the same rev (compiled
  path AND bulk); rev survives an `io()` round-trip verbatim incl. a chained generation; two independent
  graphs never collide on `gid`.*
- **Phase 2 — the by-seq feed + read side (§5·2, §6·4). 🚧 IN PROGRESS.** Per-element `seq` (indexed,
  bumped on write) + tombstones. Expose `_changes?since=N` and revs-diff. Server-only. *Gate: correct
  deltas incl. deletes; `since=0` enumerates full current state; the feed stays current-state-sized under
  repeated updates.*
  - ✅ **2a — the `seq` column + monotonic counter, assigned by the refresh.** `seq` joins gid/rev as a
    derived column the ONE post-write refresh assigns (the "any future one" the dirty marker anticipated);
    the dirty flag is now a small enum (1 = create, 2 = mutation, 3 = preserve). A single-row `update_seq`
    counter, bumped a block per write via `nextSeqBlock`; node seqs precede edge seqs (§6·2). Bulk-preserved
    rows land dirty=3 so an io()/replicated element takes a fresh LOCAL seq while keeping its rev. Gate met:
    every write bumps seq; a mutation moves the element forward; a sibling is unchanged; every live element
    has seq > 0.
  - ✅ **2b — the `tombstones` table + `drop()` records one** (§6·4, §6·5). A `tombstones(gid, rev, seq,
    kind)` table; `recordTombstones` is one RelIR INSERT-from-SELECT spliced into the compiled
    `elementDrop` cascade BEFORE the element row goes (gid/rev still readable). A vertex drop tombstones
    the vertex AND its cascade-deleted incident edges; `gid IS NOT NULL` skips a create-and-drop (no gid
    committed); `refreshTombstones` assigns the seq after the write's live seqs. Gate met.
  - ✅ **2c — the `_changes?since=N` endpoint**. `changesFeed(store, since)` (shared, beside `graphInfo`):
    a UNION of live nodes/edges `WHERE seq > N AND gid IS NOT NULL` and tombstones `WHERE seq > N`, ordered
    by the globally-unique seq — one entry per element at its latest state, keyed by gid, a delete as
    deleted:true. Plumbed through the manager seam like `info` (Bun / CF DO RPC / browser Worker); the
    router adds an `_`-prefixed system-path matcher (`GET /gremlin/{g}/_changes`). `last_seq` = update_seq
    for checkpoint-and-resume. Gate met (full state at since=0, current-state-sized, deletes, incremental).
  - ⏳ **2d — the `_revs_diff` endpoint**: a pure gid/rev key lookup — "what are you missing?".
- **Phase 3 — the replication engine + checkpoint + peer protocol (§9, §5).** The pull/push loop:
  `_changes?since=N` (N=0 for first contact, `io()`-streamed for bulk) → revs-diff → transfer (vertices before
  edges) → apply idempotently → checkpoint. Expose the peer endpoints + a transient one-shot
  `POST /gremlin/{g}/_replicate {source, target}`. *Gate: pull a remote graph to a fresh local one; re-pull is
  a resumable no-op; push is the same with roles swapped.*
- **Phase 4 — conflict preservation + tombstones (§6·3, §6·4).** Rev-tree + shadow store;
  deterministic-winner-on-read; conflict surfacing; the referential rule (edge-resurrects-endpoint);
  depth-stemming at 1000. *Gate: two peers cross-replicate and converge; conflicts preserved and surfaced,
  never lost; a delete racing an incident edge resurrects-and-surfaces; deletes otherwise propagate.*
- **Phase 5 — persistent replication: config CRUD + scheduler + OpenAPI UI (§9).** Persistent configs, a
  DO-alarm scheduler (continuous = periodic pull; one-shot = run once), introspection, and the
  OpenAPI-generated UI. *Gate: a config keeps a local graph synced from a remote one on a schedule, editable
  in the generated UI.*
- **Phase 6 — optional manual tombstone purge (§6·4).** Opt-in, CouchDB-style. (No Merkle backstop — §5·3.)

---

## §11. Decisions — locked; what remains is the build (§10)

All under the governing principle (§4). Locked:

- **Identity** = a `uuid_v7` `gid` column (globally unique, no prefix/coordination), separate from the local
  rowid join key; `uid` freed (§6·1).
- **Rev** = generation + content hash, a bounded rev-tree in the `rev` column (§5·1).
- **Cursor** = a per-element by-sequence index, current-state-sized (§5·2). No Merkle backstop (§5·3).
- **Conflicts** = CouchDB preservation (keep leaves, winner-on-read, surface); the referential conflict
  resurrects the endpoint and surfaces the delete — never reject, never lose (§6·3).
- **Tombstones** kept, no up-front pruning; rev-ancestry depth cap = CouchDB's `_revs_limit` default 1000
  (§6·4). ONE `since=N` transport mechanism (§7).
- **DX** splits by idiom: one-shot pulls are STANDARD-GLV Gremlin (`federate` URI, `io()` URL); ongoing
  replication is a persistent config + scheduler in the management API with an OpenAPI UI (§9); standard-GLV-only
  is LAW.
- **Schema** = `gid`/`rev`/`seq` + `tombstones`, CouchDB-named columns (§6·5); control-plane state in dedicated
  CouchDB-named tables, not dogfooded (§9·2); system URLs take the `_` prefix (§9·2).
- **Non-goals**: CouchDB wire interop (§9·1); a Merkle tree (§5·3). **Vendor** CouchDB for reference (§14).

One feature is designed but deferred to the build: **filtered replication** is a *captured traversal* (the
vertex selector — CouchDB's selector/`doc_ids` analog, stored in `replication_config.filter`) plus the
never-dangle resolution we already have (§6·3): an edge to a boundary endpoint pulls that endpoint in, so a
filtered pull yields a valid edge-closed subgraph. No new machinery.

---

## §12. Traps — recorded so they are not rediscovered

- **The session extension will lie to you** (§2). In `bun:sqlite`, not on DO — a changeset prototype ships
  green and then can't ship. Change-tracking must be plain SQL on both runtimes.
- **rowid is never cross-peer identity; the `gid` is** (§6·1). A sequential rowid collides across instances
  (two replicas both writing → both rowid 1001). Don't pack global uniqueness into the 64-bit rowid — a random
  prefix makes every clash a *total* collision. rowid stays a local join key; a replicated element gets a fresh
  rowid and its `gid` travels with it.
- **Don't discard-LWW to "keep it simple"; don't reject or drop on a referential conflict** (§6·3). Preserve
  conflicts (CouchDB); an edge-to-deleted-endpoint resurrects the endpoint and surfaces the delete — it never
  refuses the delete (rejection) or drops the edge (data loss). Multi-leaf does NOT break integrity (leaves
  differ in content; the id is constant).
- **The `_changes` feed is current-state-sized, not an op-log** (§5·2). One entry per element (moved on write).
  Don't build an append-only change-log table — it grows O(writes) and needs pruning the by-seq index doesn't.
- **Don't add a Merkle tree** (§5·3). CouchDB reconciles without one; `since=0` covers first-contact; bit-rot
  detection isn't graph-forced. Revisit only on a measured need.
- **Dangling edges** (§6·2). Vertices before edges, always; a cross-batch edge to an unreplicated endpoint
  waits or fails closed.
- **Never re-execute the query on the far side** (§3). Ship materialized mutations, not Gremlin to replay.
- **Don't put `fetch` in the store tier / DO compile path** (§7). Outbound waits are worker-residency.

---

## §13. Research appendix — sources

**CouchDB (the normative model):** [Replication Protocol](https://docs.couchdb.org/en/stable/replication/protocol.html) ·
[Conflicts / "Is it like Git?"](https://docs.couchdb.org/en/stable/replication/conflicts.html) ·
[`_changes`](https://docs.couchdb.org/en/stable/api/database/changes.html) ·
[`_revs_diff`](https://docs.couchdb.org/en/stable/api/database/misc.html) ·
[`_replicator`/scheduler](https://docs.couchdb.org/en/stable/replication/replicator.html). Code-level facts
(`new_revid`, `to_doc_info_path`, `couch_key_tree:find_missing`, `couch_uuids.erl`) — vendor at the pin (§14).

**Why physical replication is impossible for us:** [DO SQLite API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) ·
[workerd extensions unsupported](https://github.com/cloudflare/workerd/issues/6878) ·
[SQLite session ext](https://sqlite.org/sessionintro.html) / [Bun Session](https://bun.com/reference/node/sqlite/Session) (asymmetric) ·
[rqlite](https://rqlite.io/docs/faq/) · [cr-sqlite](https://github.com/vlcn-io/cr-sqlite) (the logical model that IS reproducible).

**Graph-DB prior art (the gap):** [Neo4j CDC](https://neo4j.com/docs/cdc/current/) ("not for an exact copy") ·
[ArangoDB DC2DC (retired)](https://docs.arangodb.com/3.10/deploy/arangosync/) ·
[FalkorDB replication](https://docs.falkordb.com/operations/replication.html) (ship effects) ·
[GUN conflict resolution](https://github.com/amark/gun/wiki/Conflict-Resolution-with-Guns) (the only CouchDB-like graph sync).

**Merkle/prolly (surveyed, dropped — §5·3):** [Dolt prolly trees](https://www.dolthub.com/blog/2024-03-03-prolly-trees/) /
[+ columnar cost](https://www.dolthub.com/blog/2025-09-10-challenges-with-prolly-trees-and-columnar-storage/) ·
[AT Proto MST → log](https://github.com/bluesky-social/atproto/discussions/1410) ·
[Cassandra anti-entropy](https://rustyrazorblade.com/post/2025/repair-and-node-density/).

**ID schemes (§6·1):** [RFC 9562 UUIDv7](https://www.rfc-editor.org/rfc/rfc9562) · CouchDB `uuid_v7`/`sequential`
(`couch_uuids.erl`). (KSUID/ULID/Snowflake surveyed; packed-64-bit and string-sortability were explored and
superseded once identity split from the rowid.)

**mogwai code (the authority):** `src/iostore.ts`, `src/services/catalog/io.ts`, `src/formats/*`, `src/bulk.ts`,
`src/setwrite.ts`, `src/storage.ts`, `src/router.ts`, `src/docs.ts`, `src/compiler/segment.ts`
(`FederationSource`), `src/services/catalog/federate.ts`, `src/api.ts` (`ForeignResult`), `src/wire.ts`,
`src/http.ts`, `src/cf-limits.ts`, and the vendored `gremlin` client at
`vendor/tinkerpop/gremlin-js/gremlin-javascript/lib/driver/{client,connection}.ts`.

---

## §14. Vendor CouchDB as reference — ✅ LANDED (`vendor/couchdb`, CouchDB 3.5.2 `5b4d921`)

CouchDB is the design authority here, so it earns a vendored, reference-only submodule beside
`vendor/tinkerpop`/`calcite`/`gds` — same discipline (blobless + sparse, gitlink-only, never built/imported,
provisioned by `scripts/init-submodule.sh`, `shallow`, cited at the pin). LANDED at CouchDB 3.5.2 (`5b4d921`),
so this doc's CouchDB citations now resolve at `vendor/couchdb/...` for everyone and for CI. The
sparse-checkout is exactly the replication reference surface (cone-mode, whole dirs), 3.3M on disk:

- `src/docs/src/replication/` (`protocol.rst`, `conflicts.rst`, `intro.rst`, `replicator.rst`) and
  `src/docs/src/api/database/{changes,misc,bulk-api}.rst` + `api/local.rst`.
- `src/couch/src/` — `couch_key_tree.erl` (rev-tree `merge`/`find_missing`/`stem`), `couch_doc.erl`
  (`to_doc_info_path`), `couch_db.erl` (`new_revid`, `get_missing_revs`), `couch_uuids.erl` (`v7_bin`/`v7_hex`;
  note the configured *default* algorithm is `sequential`, with `uuid_v7` an available option — §6·1 corrected).
