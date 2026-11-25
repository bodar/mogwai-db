# Storage density — make a graph smaller without changing an answer

**Status: PROPOSED (2026-11-25). Owner-approved direction (this session).**

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
- Every item re-measures the LDBC sf0.1 store size and the 30-query lane, and records both numbers.
  The harness is `ldbc-mogwai/` from the source run; if it is gone, rebuild it as a `scripts/bench/`
  instrument (see `docs/2026-11-21-benchmark-suite-plan.md`), not as a test bracket.

## Items

### S1. Index only string values in FTS
`TextP` applies only to strings, so a non-string value in `property_fts` is dead weight. Write FTS rows
for string values only, at every insert site (`src/refresh.ts`, `src/storage.ts`, the bulk loader).
Read the vendored reference for what `TextP` does on a non-string (`vendor/tinkerpop/gremlin-core`) and
cite it. Expected saving: about 90 MB at sf0.1.

### S2. Remove redundant indexes
Candidates: `e_pair(src, tgt)`, `e_label(label)`, and any other index that no plan uses. For each,
prove it is redundant: no `EXPLAIN QUERY PLAN` across `mise run sql-plan`, L3, L6 and the LDBC lane
uses it, OR another index serves the same seek at the same cost. Keep an index if the proof is not
clean, and record why. Expected saving: 16–40 MB.

### S3. Intern property keys
Store a property key as an integer id in a keys table, as `labels` already does for labels. Apply it to
`vertex_properties.key`, `edge_properties.key`, their indexes and `property_fts.pk` if it holds the key.
One interning rule for labels and keys, not two copies. The compiler resolves a key literal to its id the
same way it resolves a label. A key that does not exist yet resolves to "no rows", never to an error.
Expected saving: about 40 MB.

### S4. Compact `rev` storage
Store `rev` as an integer generation plus a binary hash (8–16 bytes), not 87 B of JSONB. The WIRE form
(`_changes`, `_revs_diff`, `_bulk_docs`) does not change: render it at the edge. Expected saving: about
120 MB.

### S5. Derived data on demand — one substrate, two users
One mechanism for derived data that a graph builds only when first used: state `off → building →
ready`, a bounded and resumable backfill, and every write maintains the data from the moment it is
`building`.

- **User 1: replication metadata (`gid`, `rev`, `seq` and their indexes).** Owner decision: the FIRST
  replication call on a graph (`_changes`, `_revs_diff` or `_bulk_docs`) turns it on. Each `_changes`
  page first backfills at most one page of elements without metadata — vertices before edges, because an
  edge's `rev` references its endpoints' `gid`s. The `dirty` marker and its partial index
  (`src/refresh.ts`) are the resumable cursor. The paced scheduler (`src/scheduler.ts`, `maxBatches`
  per wake) already drains a large graph across ticks, so no request does unbounded work. A graph that
  never replicates pays nothing, and its writes skip the rev hash.
- **User 2: FTS per property key.** The first `TextP` predicate on key `k` answers correctly by scan and
  marks `k` wanted. A bounded backfill slice runs after each request to that graph (not a DO alarm: an
  alarm blocks the DO's single SQL thread, `src/scheduler.ts` header). From `building` on, every write to
  `k` writes its FTS row. At `ready`, the planner uses FTS for `k`. The set of ready keys is a compile
  input, so it is part of the compiled-plan cache key (LDBC plan item L2).
- Expected saving: up to ~260 MB (user 1) and most of the remaining FTS (user 2).
- Prerequisites: S1, S4 and LDBC plan item L2.

## Rejected
- **One JSONB document per element instead of one row per property.** It could keep the typing (the
  `{t,v}` value tree), but it loses the `(key, value)` index seek (a per-key expression index is a
  declaration, i.e. schema), it rewrites the whole document on each property write, and one element
  near the DO's 2 MB row cap would decline on data size. Estimated saving about 90 MB — less than S1, S4
  or S5. S3 takes the safe part of it. Owner agreed, 2026-11-25.

## Deferred / follow-ups
(none yet)
