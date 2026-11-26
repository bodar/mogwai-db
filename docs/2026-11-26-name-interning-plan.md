# One name authority for labels and property keys, then intern property keys

**Status: PROPOSED (2026-11-26). Waiting for owner review.**

**Source.** `docs/outstanding-work.md` §4 "Shared substrate: compiler internals": `name-interning`, then
`property-key-interning`. Background is in `docs/2026-11-25-storage-density-plan.md` S6 and Q3.
Scope: element labels (`labels`, `vertex_labels.label`, `edges.label`) and property keys
(`vertex_properties.key`, `edge_properties.key`, `vertex_property_cardinality.key`, `property_fts.pk`).
Step labels (`as()`/`select()`) are out of scope.

**Rules for every item.**
- No answer changes. No new decline. Nothing may depend on data size.
- No migration code. The project is pre-alpha. A schema change may make an old store unreadable. If an
  item makes an upgrade shim dead, delete the shim (for example `upgradePropertyFts` in `src/storage.ts`).
- **Earn its keep.** Each commit message states the net production lines and the measured effect. A
  large change for a small saving is a reason to stop and report, not a reason to land.
- Be mechanically sympathetic. A name resolves to an id inside the SQL statement, at run time, through a
  UNIQUE-index seek. Do not cache names in JS on the compile path: the edge compiles without the store.
- An unknown name resolves to no rows. It never causes an error. A write interns a name the first time
  it uses it.
- Measure with the LDBC harness in the session scratchpad `ldbc-mogwai/` (`load.ts`, `bench.ts`, data
  in `../ldbc/`). If it is gone, rebuild it as a `scripts/bench/` instrument. Get the size breakdown from
  `dbstat` grouped by `name` (`nix shell nixpkgs#sqlite -c sqlite3`). The corpus ratchets are
  `mise run sql-hygiene` and `mise run sql-plan`.

## Scout facts (verified 2026-11-26, trunk `d8a7a7d1`)

**F1. Label sites: 29 sites in 12 files, in three patterns.**
- **Resolve (name to id), 8 sites.** `labelIds` (`src/compiler/rel/build.ts`) is already the shared
  reader (`label IN (SELECT id FROM labels WHERE name IN (…))`); `BaseGraph.edgeLabelMatch` and
  `hasLabelPredicate` (`source.ts`) use it. Five hand-written copies are in `src/compiler/rel/write.ts`:
  `namedLabelIds` (`dropLabel`), the `labelId()` scalar in `endpointSeek`, `labelSeek`, the `T.label`
  probe in the mergeV candidate test, and the label filter in the mergeE candidate test. Raw SQL is in
  `directedAdjacency` (`src/services/catalog/olap/kernel.ts`) and `GraphStore.dropVertexLabels`.
- **Intern (write), 6 sites.** `internLabels` (`write.ts`, addV/addE). Two inline copies of its upsert
  plus a lookup join (mergeV and mergeE creation paths). `GraphStore.labelId`, memoized per load by
  `BatchingLoader` (`src/bulk.ts`); GraphSON, CSV and replication `_bulk_docs` all use it.
- **Decode (id to name), about 15 sites.** `labelTable`, `vertexLabels`, `edgeLabel`
  (`src/compiler/rel/element.ts`); `labelScalar`, `labelNames` and the `has(T.label, P)` arm of
  `hasTokenPredicate` (`source.ts`); five `scanAs('labels', …)` in `src/services/catalog/schema.ts`; raw
  SQL in `GraphStore.vertexLabels`, `GraphStore.labelName`, `formats/drain.ts`, `formats/graphson.ts`,
  `fill` in `formats/csv.ts`, and `refresh.ts`.
- **Natural home:** a new `src/compiler/rel/names.ts` (resolve a set, resolve one name, decode, intern),
  plus a pure shape recognizer in `src/rel/names.ts` (passes in `src/rel/` never import
  `src/compiler/`). A store-side twin on `GraphStore` serves the raw-SQL sites.

**F2. Storage today.** `labels(id INTEGER PRIMARY KEY, name TEXT UNIQUE)`, `vertex_labels(node,label)`
with `vl_label`, `edges.label INTEGER` with `e_out`/`e_in`/`e_label`. An unknown label on read gives an
empty `IN` set, so no rows. A write interns by `INSERT … ON CONFLICT(name) DO UPDATE SET name=name
RETURNING id`. Label order (`ORDER BY lid`, the first-label pick) is interning order; keep it.

**F3. Key sites.** About 95 references to the `key` column in `src/compiler/rel`, `src/rel` and
`src/services`, plus about 45 raw-SQL lines outside the compiler. Only `keyMembership` (`build.ts`) is
shared. About 20 filter sites hand-write `eq(col(…,'key'), compilerText(key))` or `propertyKeyExpr`.
Output sites read `key` as a name. Key-to-key joins stay correct on ids. Passes: `trigramSeek`
(`semijoin.ts`) matches the key literal through `literalEq(…, 'key')`; `seekable` refuses any subplan
in a lifted seek, so a `key = (SELECT id FROM keys …)` would silently lose the `(key, value)` seek unless
the recognizer admits the lookup; `membership`/`readsTable` treat any table-reading subquery as
data-sized.

**F4. Edge compile.** A compile never reads the store (`src/compiler/plan-cache.ts`). Labels already
resolve at run time as an uncorrelated subquery; keys use the same form. EXPLAIN (bun:sqlite, 200k rows):
`key=(SELECT id FROM keys WHERE name='age') AND value=5` seeks `vp_kv (key=? AND value=?)` in 0.07 ms;
the `IN` form seeks the same; an unknown key gives 0 rows in 0.01 ms; a range seeks
`(key=? AND value>? AND value<?)`; a correlated EXISTS seeks `vp_nk (node=? AND key=?)`. A decode is one
INTEGER PRIMARY KEY seek per row.

**F5. Size (LDBC sf0.1).** 16 vertex keys over 1.88M rows (14.8 MB of key text), 4 edge keys over 251k
rows (2.5 MB). The key is stored three times per row (table and two indexes): about 44 MB for vertices,
7.5 MB for edges, minus about 6 MB for the integers. `property_fts.pk` adds up to about 10 MB after S1.
**Expected saving: about 45–55 MB, about 7–8% of the post-S1 store (669.9 MB).**

## Stage A — element labels resolve in one place

1. **A1. Create the name authority.** Add `src/compiler/rel/names.ts`. Move `labelIds` into it as
   `nameIds(dict, args)`. Add `nameId(dict, nameExpr)` (scalar; correlated when the operand is a
   column), `nameOf(dict, idExpr)` and `withNames(dict, input, idCol)` (decode), and `internNames(dict,
   names)` (from `internLabels`). `dict` is `'labels'`; Stage C adds `'keys'`. Add `isNameLookup(plan)`
   in `src/rel/names.ts`. Acceptance: SQL byte-identical; unit tests for the recognizer.
2. **A2. Route the five `write.ts` resolve copies through `nameIds`/`nameId`.** Delete `namedLabelIds`.
   Acceptance: bytes the same or smaller; no `sql-plan` regression; merge, `dropLabel` and scale tests
   green. After A1.
3. **A3. Route the mergeV and mergeE inline intern copies through `internNames`.** Use `RETURNING id,
   name` and delete the second lookup scan where the returned rows are enough. Acceptance: smaller SQL,
   net lines negative, `test/compiler/merge-scale.exec.test.ts` green. After A1.
4. **A4. Route the decode sites through `nameOf`/`withNames`** (element.ts, source.ts, the five catalog
   scans). `hasTokenPredicate`'s P-over-name arm stays a join through `withNames`. Acceptance:
   byte-identical. After A1.
5. **A5. Add store-side twins and route the raw-SQL sites.** `GraphStore.nameId`, `internName`,
   `namesOf(dict, ids)`. Route `labelId`, `dropVertexLabels`, `vertexLabels`, `labelName`, the bulk memo,
   the olap `directedAdjacency`, drain, graphson, csv `fill` and refresh. Acceptance: format, replication
   and `test/bulk.test.ts` green.
6. **A6. Add a guard.** In `scripts/arch-check.ts`: only `names.ts` builds a scan of `labels`; only
   `storage.ts` names `labels` in raw SQL. One L2 test: `hasLabel('nope')`, `out('nope')`,
   `has('nope','k',v)`, `E().hasLabel('nope')`, `dropLabel('nope')` give no rows or a no-op, never an
   error. After A2–A5.

**Gate A (owner review).** Report net production lines (expected negative), the `sql-hygiene` byte
delta and the `sql-plan` diff. **Stop rule:** stop and report if the net change is above +40 lines or any
`sql-plan` query regresses. Stage A is worth landing alone.

## Stage B — property keys go through the same authority, still stored as TEXT

1. **B1. Add the key half of the authority, emitting today's SQL.** `keyIs(col, keys | null)` (takes
   over `keyMembership`), `keyEq(col, name | param)` (takes over the hand-written `eq` and
   `propertyKeyExpr`), `keyNameOf(col)` and `keyCell(nameExpr)` (identity for now), `internKeys(names)`
   (no-op for now). Add `keyLiteral(expr, rel)` in `src/rel/names.ts`; use it in `trigramSeek`.
   Acceptance: byte-identical. After A1.
2. **B2. Route the about 20 filter sites through `keyIs`/`keyEq`** (`source.ts`, `property.ts`,
   `modulator.ts`, `write.ts`). Byte-identical.
3. **B3. Route the output sites through `keyNameOf`** (`vertexProps`/`edgeProps`, the property-stream
   `pk`, `catalog/schema.ts`, the `properties` group key). Byte-identical.
4. **B4. Route the write sites through `keyCell`, with an `internKeys` call at each write that names a
   key.** Key-to-key joins stay; list each with a reason in the guard allowlist. Byte-identical.
5. **B5. Route the raw-SQL key sites through store-side twins** (`bulk.ts`, `refresh.ts`,
   `fts-index.ts`, drain/csv/graphson, olap `weightKey`). After A5.
6. **B6. Add a guard.** A check in `scripts/arch-check.ts`: no `col(…, 'key')` on a property table
   outside `names.ts` and the allowlist.

**Gate B (owner review).** List every site Stage C must still touch by hand. **Stop rule:** stop and
report if more than 10 sites remain outside the authority. This is S6's "one central change" test.

## Stage C — intern property keys in storage

1. **C0. Measure first (spike, no landing).** On a copy of the LDBC store, rebuild the tables by hand
   with a `keys` table, integer `key` columns, the indexes and `pk`. Run `dbstat`. **Stop rule:** stop if
   the saving is under 30 MB.
2. **C1. Let the passes accept the lookup form before the switch.** `seekable` and
   `readsTable`/`membership` (`semijoin.ts`) treat `isNameLookup` as a constant bounded by the query
   text. `keyLiteral` reads the name through the lookup. Prove it with unit tests on hand-built plans.
   After B6.
3. **C2. The central switch (one commit).** Schema: `keys(id INTEGER PRIMARY KEY, name TEXT NOT NULL
   UNIQUE)`; `key INTEGER NOT NULL` on `vertex_properties`, `edge_properties` and
   `vertex_property_cardinality`; `property_fts.pk` holds the key id. Update `src/sql/schema.ts` and
   `src/rel/rel.ts`. Flip the authority bodies to the lookup, decode and upsert forms; `internKeys`
   becomes one upsert per write program. Flip the store twins and the bulk memo. Delete
   `upgradePropertyFts`. Route raw test inserts through one seeding helper. Acceptance: CI green, L3
   unchanged, `sql-plan` shows no new SCAN of a property table. After C1.
4. **C3. Measure and record.** LDBC sf0.1 `dbstat` by table; the 30-query lane (30/30, p50 sum);
   bulk-load time; a write micro-lane (`addV().property()` ×1k, `mergeV` with a map). **Stop rule:**
   revert if the saving is under 30 MB, a lane query is more than 10% slower at p50, or a write lane is
   more than 15% slower.

**Gate C (owner review).** The measured saving, the line count and the write cost.

## Questions for the owner

1. **One dictionary or two?** A shared `names` table halves the schema. Two tables (`labels`, `keys`)
   keep a label listing free of keys; the code is shared through `dict`. Recommendation: two tables.
2. **Write cost.** Interning on write adds one upsert statement to each write program that names a key.
   C3 measures it. Accept it inside the stop rule?
3. **The dictionary never shrinks.** It keeps a key after its last property is dropped, as `labels`
   does. No read lists the dictionary alone, so no answer changes. Accept?
4. **Implicit order.** After C2, a group by key with no explicit order could follow key id, not key
   text. The scout found no such site (bags order by property id). The L3/L5 differentials in C2 check
   it.
