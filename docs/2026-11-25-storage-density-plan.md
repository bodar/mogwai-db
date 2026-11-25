# Storage density — make a graph smaller without changing an answer

**Status: PROPOSED (2026-11-25). Owner-approved scope and order (2026-11-25).**

**Source.** The LDBC SNB sf0.1 head-to-head against Relate 1.2.0
(`docs/2026-11-25-ldbc-findings-plan.md`). The mogwai store for 327,588 vertices and 1,477,965 edges is
976 MB by `dbstat` (1,118 MB with WAL). A DO caps storage at 10 GB and bills per GB, so at this density
LDBC sf1 (about 10×) is at the cap.

Where the bytes go (`dbstat`, MB):

| Part | MB | Detail |
|---|---|---|
| FTS (`property_fts_data/_content/_docsize`) | 316 | 2.13M rows = every vertex AND edge property value, 614k of them integers |
| Replication metadata | ~260 | `rev` is 87 B JSONB per element; `gid` 16 B; `seq`; indexes `edges_gid` 39, `nodes_gid` 9, `edges_seq` 19, `nodes_seq` 4 |
| `vertex_properties` + `vp_key_value` + `vp_node_key` | 190 | 1.88M rows; key TEXT repeated per row and per index entry |
| Edge topology + indexes | ~140 | `e_out` 27, `e_in` 27, `e_pair` 24, `e_label` 16, `uid` autoindex 15 |
| `edge_properties` + `ep_key_value` | 33 | 251k rows |

**Rules for every item.**
- No answer changes. No new decline. Nothing may depend on data size (CLAUDE.md, "Never decline on
  data size").
- No data migration. The project is pre-alpha with no users (owner, 2026-11-25). A schema change may
  make an old store unreadable; the browser demo site wipes and reseeds its data. Do not write upgrade
  code, and delete an existing upgrade shim if an item makes it dead.
- **Earn its keep.** Each item states its net production-line count and its measured saving in the
  commit message. A large change for a small saving is a reason to stop and report, not to land.
- Every item re-measures the LDBC sf0.1 store size and the 30-query lane, and records both numbers.
  The harness (`load.ts`, `bench.ts`) is in the session scratchpad
  `/tmp/claude-1000/-home-dan-Projects-mogwai-db/698cd1dd-3bfc-40f1-89ec-20ca9053aa33/scratchpad/ldbc-mogwai/`
  with the data in `../ldbc/`. If it is gone, rebuild it as a `scripts/bench/` instrument (see
  `docs/2026-11-21-benchmark-suite-plan.md`), not as a test bracket. The size breakdown is `dbstat`
  grouped by `name` (the Bun build of SQLite lacks `dbstat`; use `nix shell nixpkgs#sqlite -c sqlite3`).

## Items, in order

### S1. Index only string values in FTS
`TextP` applies only to strings, so a non-string value in `property_fts` is dead weight. Write FTS rows
for string values only, at every insert site (`src/refresh.ts`, `src/storage.ts`, the bulk loader).
Cite the vendored reference for what `TextP` does on a non-string (`vendor/tinkerpop/gremlin-core`).
Expected: about 90 MB at sf0.1, about 20 lines.

### S2. `uid` uniqueness as a partial index

✅ **LANDED (2026-11-25, `3a9623b9`).** `nodes.uid` and `edges.uid` lose the column `UNIQUE`. Two partial
unique indexes, `nodes_uid` and `edges_uid` (`WHERE uid IS NOT NULL`), replace it — see `SCHEMA` in
`src/storage.ts`. Measured: LDBC sf0.1 shrinks by 18.4 MB. Every `uid` lookup still seeks
(`test/performance.test.ts` pins this). Remaining: nothing.
`nodes.uid` and `edges.uid` are `TEXT UNIQUE`. The implicit index holds a row for every element, but
most elements have no `uid` (LDBC: none). Replace the column constraint with
`CREATE UNIQUE INDEX … WHERE uid IS NOT NULL`, and check that every `uid` lookup still seeks it.
Expected: 15–20 MB, a few lines.

`e_pair` and `e_label` STAY: `src/storage.ts` records the measured cost of removing each (24–46× on the
hub-scale test; O(|E|) for a root `E().hasLabel`). Remove another index only with the same evidence.

### S3. Replication metadata on demand (`gid`, `rev`, `seq` and their indexes)

✅ **LANDED (2026-11-25, `1fbd3261`).** A graph computes `gid`, `rev` and `seq` only after it first
exposes identity: a replication call, the match set, or a GraphSON export. CSV does not turn it on.
Mechanism: `exposeIdentity` in `src/refresh.ts` and the `replication` state row. It backfills in rowid
pages, vertices before edges. `nodes_gid` and `edges_gid` are now partial indexes. Measured: LDBC sf0.1
shrinks by 289 MB, and bulk load goes from 105 s to 53 s. Remaining: nothing.
Owner decision: the FIRST replication call on a graph (`_changes`, `_revs_diff` or `_bulk_docs` — a
target needs the metadata too) turns it on. Until then a write computes no `gid`, `rev` or `seq` (no
content hash), and their indexes hold nothing.
- Each `_changes` page first backfills at most one page of elements without metadata, vertices before
  edges (an edge's `rev` references its endpoints' `gid`s). The `dirty` marker and its partial index
  (`src/refresh.ts`) are the resumable cursor. The paced scheduler (`src/scheduler.ts`, `maxBatches`
  per wake) drains a large graph across ticks, so no request does unbounded work.
- Facts already in place: a tombstone is recorded only for an element that has a `gid`
  (`src/compiler/rel/write.ts`), so a delete before replication needs none; GraphSON writes `gid`/`rev`
  only when present (`src/formats/graphson.ts`).
- Expected: up to ~260 MB, and faster writes.

### S4. Compact `rev` storage

✅ **LANDED (2026-11-25, `0e21709b`).** A stored `rev` is one packed BLOB: a 4-byte generation, then
each ancestry hash as 16 raw bytes, leaf first. It crosses SQLite as hex, the same idiom as `gid`.
Mechanism: `encodeRev`/`decodeRev`, `storedRev` and `wireRevText` in `src/rev.ts`. The wire form does
not change. Measured on LDBC sf0.1 after replication: rev bytes 157 MB → 36 MB, db file −133 MB.
Remaining: nothing.
Store `rev` as an integer generation plus a binary hash (8–16 bytes), not 87 B of JSONB. The WIRE form
(`_changes`, `_revs_diff`, `_bulk_docs`) does not change: render it at the edge. After S3 this matters
only for a graph that replicates. Expected: about 120 MB on such a graph.

### S5. FTS on demand, per property key
The first `TextP` predicate on key `k` answers correctly by scan and marks `k` wanted. The scan path
exists already (a needle under 3 characters uses it). A bounded backfill slice runs after each request
to that graph (not a DO alarm: an alarm blocks the DO's single SQL thread, `src/scheduler.ts` header).
From `building` on, every write to `k` writes its FTS row. At `ready`, the planner uses FTS for `k`.
The set of ready keys is a compile input, so it is part of the plan-cache key
(`src/compiler/plan-cache.ts`, whose note says a compile does not read the store — keep that true by
passing the key state in).
- Expected: most of the remaining ~225 MB of FTS.
- **Stop rule (owner, 2026-11-25):** keep S5 unless it proves really complex or does not deliver. If the
  scout or the build finds either, stop and report with the measured line count and saving; do not land.

### S6. Intern property keys
Store a property key as an integer id in a keys table, as `labels` already does. Apply it to
`vertex_properties.key`, `edge_properties.key`, their indexes and `property_fts.pk` if it holds the key.
One interning rule for labels and keys. A key literal resolves once, as a label does; an unknown key
resolves to "no rows", never to an error.
- Expected: about 45 MB.
- **Scout first.** About 130 SQL sites name the `key` column. Land it only if one central change does
  it (as labels resolve once). If it needs a change at each site, stop and report.

## Rejected
- **One JSONB document per element instead of one row per property.** It could keep the typing (the
  `{t,v}` value tree), but it loses the `(key, value)` index seek (a per-key expression index is a
  declaration, i.e. schema), it rewrites the whole document on each property write, and one element
  near the DO's 2 MB row cap would decline on data size. Estimated saving about 90 MB. S6 takes the
  safe part of it. Owner agreed, 2026-11-25.
- **Removing `e_pair` / `e_label`.** Measured reasons to keep both; see S2.

## Deferred / follow-ups
(none yet)
