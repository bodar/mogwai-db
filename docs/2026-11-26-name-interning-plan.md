# One name authority for labels and property keys, then intern property keys

**Status: Stage A LANDED (2026-11-26). Gate A PASSED (owner, 2026-11-26): a sane path. The Stage A
finish round landed A-f1, A-f2, A-f3, A-f5, N1–N3 (648eec92, e24da098) and merge-map-null-token
(420e020f, 6be6de05: A-w1–A-w3, A-f4, A-f6). Next: the reuse items N4–N7, then Stage B.**

**How a gate works (owner, 2026-11-26).** A gate asks one question: is this a sane path? The numbers
(line counts, stop rules) are evidence for that judgement, not automatic stops. If the path is sane,
run more rounds on the same stage until it lands properly (follow-ups, fixes, clean-ups). Then start
the next stage. Stop only for a wrong direction.

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
  `directedAdjacency` (`src/services/catalog/olap/kernel.ts`). (`GraphStore.dropVertexLabels` was
  here; A5 deleted it.)
- **Intern (write), 6 sites.** `internLabels` (`write.ts`, addV/addE). Two inline copies of its upsert
  plus a lookup join (mergeV and mergeE creation paths). `GraphStore.labelId`, memoized per load by
  `BatchingLoader` (`src/bulk.ts`); GraphSON, CSV and replication `_bulk_docs` all use it.
- **Decode (id to name), about 15 sites.** `labelTable`, `vertexLabels`, `edgeLabel`
  (`src/compiler/rel/element.ts`); `labelScalar`, `labelNames` and the `has(T.label, P)` arm of
  `hasTokenPredicate` (`source.ts`); five `scanAs('labels', …)` in `src/services/catalog/schema.ts`; raw
  SQL in `formats/drain.ts`, `formats/graphson.ts`,
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
   **Landed (3419cdb5), pure move.** `src/compiler/rel/names.ts` holds `nameIds` (was `labelIds`; it also
   takes a `string[]`, so `namedLabelIds` is deleted), `internNames` (was `internLabels`) and `dictScan`
   (replaces `LABELS_COLS` and the eight hand-built `labels` scans in `write.ts`). SQL is byte-identical;
   no baseline moved. `test/compiler/name-dict.exec.test.ts` tests the dictionary. **Remains:** nothing.
   `nameId`, `nameOf`, `withNames` and `isNameLookup` land with their first consumers (A2, A4).
   **Pre-A2 fix landed (7b71ba45), answer-changing, its own commit.** A Map-valued `mergeV`/`mergeE`
   reads a list `T.label` as several labels. It no longer refuses a batch whose drivers differ by
   `T.label`. Mechanism: `mapLabelNames` in `src/compiler/rel/write.ts` explodes the label; the creation
   path writes through `bindLabels`. **Remains:** one open item, `merge-map-label-seek`. A re-upsert of a
   batch whose maps share a property value but differ by label is quadratic in the search (321 s at
   8k). The cost was there before this commit; `docs/outstanding-work.md` logs it. Fix: rank the label
   beside the string entries in `mapDrivers`, and seek through `labelSeek` when the label is more
   selective.
2. **A2. Route the five `write.ts` resolve copies through `nameIds`/`nameId`.** Delete `namedLabelIds`.
   Acceptance: bytes the same or smaller; no `sql-plan` regression; merge, `dropLabel` and scale tests
   green. After A1.
   **Landed (6d52bf33), with A3.** `names.ts` adds `nameId` (one name's id, one UNIQUE seek).
   `endpointSeek`, `labelSeek` and the mergeV/mergeE candidate tests in `write.ts` use it. `labelSeek`
   now seeks `vertex_labels` through `vl_label`. `dropLabel` already used `nameIds` (A1). No answer change,
   no baseline move, `sql-plan` the same. Scaling 1k→8k is 5.4×–9.8×. **Remains:** nothing.
3. **A3. Route the mergeV and mergeE inline intern copies through `internNames`.** Use `RETURNING id,
   name` and delete the second lookup scan where the returned rows are enough. Acceptance: smaller SQL,
   net lines negative, `test/compiler/merge-scale.exec.test.ts` green. After A1.
   **Landed (6d52bf33), with A2.** mergeE's inline upsert and second `labels` lookup are now the relation
   form of `internNames`; the rows join its `RETURNING (id, name)` by name. mergeV already wrote through
   `bindLabels` (7b71ba45). Net production lines -6. **Remains:** nothing.
4. **A4. Route the decode sites through `nameOf`/`withNames`** (element.ts, source.ts, the five catalog
   scans). `hasTokenPredicate`'s P-over-name arm stays a join through `withNames`. Acceptance:
   byte-identical. After A1.
   **Landed (87a38aa3).** `names.ts` adds `nameOf` (one id's name, one primary-key seek) and `withNames`
   (a relation's ids decoded to `lid`/`name`). `element.ts`, `source.ts` `BaseGraph` and the five
   `services/catalog/schema.ts` scans use them; `labelTable` and `edgeLabel` are deleted. The SQL plan is
   the same; only alias numbers and `=` operand order change (corpus total -1873 bytes). No answer
   change, no baseline move. **Remains:** nothing.
5. **A5. Add store-side twins and route the raw-SQL sites.** `GraphStore.nameId`, `internName`,
   `namesOf(dict, ids)`. Route `labelId`, `dropVertexLabels`, `vertexLabels`, `labelName`, the bulk memo,
   the olap `directedAdjacency`, drain, graphson, csv `fill` and refresh. Acceptance: format, replication
   and `test/bulk.test.ts` green.
   **Landed (61a3f576), reduced scope.** It deletes the dead `GraphStore` label methods (`src/storage.ts`).
   The test graph helper (`test/support/graph.ts`) no longer uses them. The six raw-SQL label sites stay
   as they are: each is a one-line JOIN or IN, and a `names.ts` fragment adds lines. No SQL change, no
   baseline move. **Remains:** the `src/sql/names.ts` fragment (`labelIdsIn` plus the decode join) goes to
   B5. F1 no longer names the deleted methods.
6. **A6. Add a guard.** In `scripts/arch-check.ts`: only `names.ts` builds a scan of `labels`; only
   `storage.ts` names `labels` in raw SQL. One L2 test: `hasLabel('nope')`, `out('nope')`,
   `has('nope','k',v)`, `E().hasLabel('nope')`, `dropLabel('nope')` give no rows or a no-op, never an
   error. After A2–A5.
   **Landed (95f6651d), RelIR half only.** `scripts/arch-check.ts` fails the build when a file other than
   `src/compiler/rel/names.ts` builds a RelIR scan of `labels`. `test/L2-sql/unknown-label.sql.test.ts`
   tests the five unknown-label shapes. No baseline move. **Remains:** the raw-SQL half of the guard
   (`\b(FROM|JOIN|INTO)\s+labels\b`) goes to B6. The raw sites do not go through `names.ts` yet. No
   allowlist was added.

**Stage A landed (2026-11-26).** A1–A6 are on trunk (3419cdb5, 6d52bf33, 87a38aa3, 61a3f576,
95f6651d), plus the answer-changing merge fix 7b71ba45. No baseline moved except the mergeV
`sql-hygiene` bytes in 7b71ba45 (6611 → 8622, reason in that commit). A4 met "same plan, smaller SQL"
(-1873 bytes over the corpus), not "byte-identical": only alias numbers and `=` operand order changed.

**Stage A follow-ups (from review, order of value).**
- **A-f1. Close the arch-rule bypass: un-export `dictScan`.** A6's rule matches only `table: 'labels'`
  and `scanAs('labels'`. A file outside `names.ts` that calls `dictScan('labels', fresh)` passes the
  check (planted probe, exit 0). Only `names.ts` uses `dictScan`. Remove its `export`; this closes the
  hole by structure. Do it before Stage B adds `'keys'` to the same seam.
- **A-f2. Remove the `withNames` `on`-callback side channel.** `BaseGraph.hasTokenPredicate`
  (`src/compiler/rel/source.ts`) gets `valuePred`'s result by assignment inside the `on` callback. It is
  correct only because `withNames` calls `on` once, synchronously. Lower P on a name column first, or
  let `withNames` return "no predicate". No answer changes today.
- **A-f3. Document that `nameId` is NULL for an unknown name.** mergeE's `labelOk` is now
  `clabel = nameId(lbl)`, which is NULL, not FALSE, for an unknown label. It is safe in a positive ON
  clause. Add a comment at `labelOk` and in the `nameId` docstring: do not negate it. Fix the docstring
  SQL example, which names `labels` but the function takes `dict`.
- **A-f4. Add a mergeE numeric-label test.** A3 joins wanted rows (integer `5`) to the `RETURNING`
  text `'5'`. That join is the one place where affinity could drop a row. Probed correct; the test in
  `test/compiler/name-dict.exec.test.ts` covers mergeV only.
- **A-f5. Remove the `ScanHints` alias pair from the `names.ts` signatures** (`dictScan`, `nameIds`,
  `nameId`). It only keeps old alias spelling. Do it when a baseline may move for another reason.
- **A-f6. Small cleanups.** Name the `labelIsList` CASE lambda once (`labelListed`), used twice in
  `write.ts`. Fix the header comment of `test/compiler/element-id-param.exec.test.ts` (`labelIds` →
  `nameIds`).

**A-f1, A-f3, A-f5 and the A-f6 test header landed (648eec92).** `dictScan` is private to
`src/compiler/rel/names.ts`, so `tsc` rejects a bypass of the name authority. The `nameId` docstring
says the result is NULL for an unknown name and is safe only in a positive `=`; mergeE's `labelOk`
points at it. `ScanHints` is gone from the `names.ts` signatures (SQL aliases only, no baseline moved).
A new test in `test/compiler/name-dict.exec.test.ts` covers mergeE with an unknown label. **Remains:**
nothing for these items. A-f2, A-f4 and the A-f6 `labelListed` lambda are separate items.

**Open item from 7b71ba45:** `merge-map-label-seek` (see A1 above and `docs/outstanding-work.md`).

**Depth gaps seen in review (pre-existing, not Stage A scope).** These decline on trunk before and after
Stage A: `label()` as a `choose`/`coalesce` arm (`g.V().coalesce(outE().label(), constant('none'))`),
`has(T.label, TextP.regex(…))`, `hasLabel(TextP.startingWith(…))`, and `hasLabel(within(…))`/
`without(…)`. Each is a row in `docs/outstanding-work.md` (F-d): `haslabel-predicate` (every
`hasLabel(P)`), `token-regex` (`regex` on `T.label`/`T.id`) and `label-arm-string-constant` (a `label()`
arm beside a string `constant()` arm).

### Next round — reuse proposals (Stage A residue, before B1)

- **N1. `labelOwners(kind, fresh, hints?)` in `names.ts`.** One builder for the (owner, label) relation:
  `vertex_labels(node, label)` for a vertex, `edges(id, label)` for an edge. Route about 10 hand-built
  scans through it: `source.ts` `hasLabelPredicate`, `hasTokenPredicate`'s `T.label` arm, `labelScalar`,
  `labelNames`, `hasAnyLabel`; `element.ts` `vertexLabels`; `write.ts` `labelSeek` and the mergeV
  candidate probe. Four `kind` ternaries go. Expect about 25–30 lines removed; SQL the same apart from
  aliases. Optional: extend A6's arch rule to `vertex_labels` read scans.
- **N2. Merge the vertex and edge arms of `labelScalar` and `labelNames`.** After N1. One path:
  `labelOwners(kind)` → `withNames` → `firstOf` ordered by `lid` (equal to the vertex arm's `label`). The
  edge arm scans `(id, label)` instead of all edge columns. Expect about 15 lines removed.
- **N3. Delete `VERTEX_LABEL_COLS` in `write.ts`.** Use `OWNED_BY.vertexLabels.cols`, which already
  declares the same columns. Do it with N1; optionally add one `labelTargets(fresh)` for the four
  write-target scans (`bindLabels`, addV, mergeV, mergeE). No SQL change.

**N1, N2, N3 and A-f2 landed (e24da098).** `labelOwners(kind, fresh, of?)` in
`src/compiler/rel/names.ts` (backed by `LABEL_OWNERS` in `build.ts`) is the one (owner, label) relation.
`labelScalar` and `labelNames` use one path for both kinds. `withNames` has no `on` callback.
`VERTEX_LABEL_COLS` is gone; the label write targets use one `ownedTarget` from `OWNED_BY`. No answer
changed. The `sql-hygiene` baseline moved for alias churn only. **Remains:** nothing.

### Stage A finish — review notes to verify (dropped as low-reach, but cheap to settle)

- **A-w1. The §3 row from `7b71ba45` says a non-string map label "becomes its text".** A boolean does
  not: `g.inject([(T.label):true,name:'n']).mergeV().label()` gives `'1'`, not `'true'` (`json_extract`
  then `CAST AS TEXT`). Make the label text follow the one value-to-text rule the rest of the system
  uses, or correct the row. Pick the smaller change; no Java emulation.
- **A-w2. A NULL label in a mergeE map matches an existing edge.** `g.inject([(T.label):null,(OUT):1,
  (IN):2]).mergeE()` matches `knows`. The constant `mergeE` path and the reference refuse a null map
  value ("mergeE() does not allow null Map values - check: label"). Make the map path agree with the
  constant path. Also check the mergeV map path for a NULL label (it may treat the map as named).
- **A-w3. A labelless vertex and the default label.** `g.inject([name:'x'],[(T.label):'vertex',name:'x'])
  .mergeV()` now creates 2 vertices; the reference gives 1 (`Vertex.DEFAULT_LABEL`). Trunk refused it
  before. Decide from the existing labelless-vertex model in `docs/limitations.md`: if a labelless
  vertex is a documented divergence, add this case to that row; otherwise fix it.

### Stage A finish — parked item (resume point)

**LANDED as `420e020f` + `6be6de05` (M0, M1 done; `CI passed`).** A-w3 is not a wrong answer: under the TinkerPop 4 multi-label default, `addV()` makes a vertex with no labels (`ElementMap.feature` `zero_label_vertex`), so 2 vertices is correct. `6be6de05` rewords the §3 row to say so.

~~**`merge-map-null-token` is BUILT but NOT LANDED.**~~ It covers A-w2, A-w3, the A-w1 docs fix, A-f4 and
the A-f6 `labelListed` lambda. The commit is `4f95f2db` on branch `wf/merge-map-null-token-1-0`
(worktree `.claude/worktrees/wf_bc503f19-1bd-8`). The builder had to report before `mise run ci`
printed a verdict. Its logs show check, lint, arch, binds, sql-hygiene and build clean, all 10 test
brackets PASS, and every L8 bracket at 0 fail. But no `CI passed` line was seen. Its base is `aa29ea83`,
so it does not include `e24da098`, which also changed `src/compiler/rel/write.ts`.

What the commit does (`src/compiler/rel/write.ts`):
- `refuseDrivers(carrier, pairPred, message, guard, fresh, withKey?)`: one LIMIT-1 guard statement over
  the carrier's map pairs. The mergeV `T.id`, mergeE `T.id` and mergeE list-label guards use it.
- `refuseNullTokens(op, carrier)`: a `T`/`Direction` key with a null value raises
  `<op>() does not allow null Map values - check: <key>`, the constant path's sentence.
- `isTokenKey(pair, t, v)` replaces the two duplicate `isToken` closures; `labelListed` is named once.
- `docs/limitations.md` §3: the non-string map label row is corrected (A-w1: an integer gives its
  digits, `true` gives `'1'`, `2.0d` gives `'2'`, a datetime gives epoch ms). A new row covers a merge
  map with no label (A-w3).
- 3 new tests in `test/compiler/name-dict.exec.test.ts`.

Plan items, in order:
- **M0. Rebase `wf/merge-map-null-token-1-0` onto trunk (`e24da098` or later) and get a CI verdict.**
  Resolve any `write.ts` conflict against `ownedTarget`/`labelOwners`. Run `mise run ci` unpiped and read
  `CI passed`. This is the only prerequisite for M1.
- **M1. Land `merge-map-null-token`.** After M0. Then A-w1, A-w2, A-w3, A-f4 and A-f6 are done.

### Stage A finish — follow-ups from review (all minor; no answer changes)

- **F-a. The `dictScan` docstring overclaims.** It says no caller outside `names.ts` reads `labels`
  directly. `src/formats/csv.ts` `fill(store, 'labels', …)` (CSV edge export) does. Say "no RelIR
  caller". The raw-SQL site itself goes to B5. Cheap; do it with the next commit that touches `names.ts`.
- **F-b. Physical label facts live in two compiler tables.** `LABEL_OWNERS.vertex`/`.edge`
  (`src/compiler/rel/build.ts`) repeat `OWNED_BY.vertexLabels`/`.edges` (`src/compiler/rel/write.ts`).
  Reads use the first, writes the second. A third copy is `src/sql/schema.ts`. N6 below removes the
  compiler duplicate. `src/services/catalog/schema.ts` still scans `vertex_labels` by hand; N4 removes it.
- **F-c. `labelScalar` re-reads `edges` for an edge already in scope** (`g.V().outE().label()`,
  `g.E().order().by(T.label)`): one rowid seek per row. It existed before this round and scales
  linearly (1.82 ms at 1k, 6.91 ms at 8k, 3.8×). Not a defect. **Recorded** in `docs/outstanding-work.md`
  under `label-probe-edge-col`, which has the same fix.
- **F-d. Depth gaps (pre-existing, clean declines, no wrong answer).** **Recorded** in
  `docs/outstanding-work.md` with the list above: `haslabel-predicate`, `token-regex` and
  `label-arm-string-constant`.

### Next round — reuse proposals (before B1)

- **N4. The catalog reads label rows through `labelOwners`.** `src/services/catalog/schema.ts`
  `vertexLabels`, `properties` and `edgeTriples` hand-write `scanAs('vertex_labels', …)` three times.
  Use `labelOwners('vertex', fresh)`. Then `LABEL_OWNERS` is the one place that names the physical label
  table and owner column. No column clash (the other scans already rename). One Project node less per
  scan; same rows, so no answer change.
- **N5. One `labelArray` path for both kinds.** `BaseGraph.labelArray` (`source.ts`) has a kind ternary;
  `element.ts` `vertexLabels` hard-codes `'vertex'`. Give `vertexLabels` a `kind`. An edge has one
  `labelOwners` row, so `json_group_array` gives the same one-name array; `COALESCE(…, '[]')` still covers
  a vertex with no labels. Add `ownedNames(kind, fresh, of)` = `withNames('labels', labelOwners(kind,
  fresh, of), 'label', fresh)` in `names.ts`; it replaces four written-out copies (`hasTokenPredicate`,
  `labelScalar`, `vertexLabels`, `labelArray`). Finishes N2.
- **N6. Derive `OWNED_BY` table and owner from `LABEL_OWNERS`/`PROPERTIES`.** For example
  `vertexLabels: { ...LABEL_OWNERS.vertex, cols: [...] }`, and the same for `vertexProps`/`edgeProps`
  from `PROPERTIES`. Removes three duplicate facts (F-b); no SQL change. Leave
  `src/rel/passes/semijoin.ts` `SEEK_PROPERTIES`/`PROPERTY_OWNER` alone: `src/rel` must not import
  `src/compiler`.
- **N7. One `existsOf` (the `SELECT 1` probe) in `build.ts`.** Two private copies
  (`decorate.ts`, `boundgraph.ts`) and about 18 inline `make.project(… [['one', compilerInt(1)]])` +
  `{kind:'exists'}` sites (`source.ts` ×6, `write.ts` ×5, `map.ts` ×2, `list.ts`, `lower.ts`,
  `lower/filter.ts`). About 35–40 lines less; same SQL apart from aliases.

**Needs-human questions from this round:** none.

**Gate A (owner review) — PASSED 2026-11-26.** Evidence: the A1–A6 refactors are net −20 production
lines (A1 +26, A2+A3 −6, A4 −7, A5 −31, A6 −2); A4 is −1,873 SQL bytes over the corpus; `sql-plan`
unchanged. The separate answer fix `7b71ba45` is +116 lines. Stage A is worth landing alone.

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
