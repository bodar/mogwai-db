# Fix plan — review findings (75+ confidence) on 8 property/child-scope commits

Scope: the 7 findings scoring ≥75 from the local review of commits `86b4ec2`..`3f9414c`.
Two are correctness bugs (write a failing test first, then fix); one is a latent
correctness bug behind a slice; the rest are duplication/genericity (add/confirm test
coverage, then refactor to a shared helper). Every change lands with L2 snapshot + a
compiler.test.ts execution assertion, corpus stays 100%, and L3 must not regress.

---

## A. Correctness bugs (test-first, then fix)

### A1 — `select(Pop.all)` over a property alias in a RECORD select frames garbage (B1, 78)
`src/steps/select.ts:431` builds the property-shape list column with `historyValues(col)`
(`->>` text extraction) while declaring `of.kind:'property'`. Downstream `listFieldBuffer`
reads `x.vpid`/`x.pk`/`x.pv` off strings → `undefined` → VertexProperties framed with
`undefined:undefined` ids. The single-label path (`labelselect.ts:154`) already uses the
correct `historyPropertyValues`.

- **Test (failing first):** add to `test/compiler.test.ts` a case like
  `g.V().hasLabel('person').properties('name').as('p').select(Pop.all,'p')` embedded in a
  multi-label `select`/`project` so it routes through `selectRecordFromAlias` (NOT the
  single-label path). Assert the framed VertexProperties have real keys/values (e.g.
  `['marko','vadas',...]` by `.value()` or the VP ids), which fails on the string-garbage
  output today. Add the L4 mirror in a `.feature` if it expresses cleanly.
- **Fix:** export `historyPropertyValues` from `labelselect.ts` and use it (not
  `historyValues`) in the `shape === 'property'` arm of `selectRecordFromAlias`
  (`select.ts:431`). This is the same one-line swap the single-label path already made.
- **Note:** `labelselect.ts:178` has the same `shape === 'property'` arm but the history
  reviewer showed it is unreachable (the `entry.shapes.size===1 && has('property')` block
  at :151 handles pure-property first). Leave it, but change its `historyValues` too for
  consistency OR delete the dead arm — decide during implementation; do not leave a live
  `historyValues` property path anywhere.

### A2 — `properties().order().by(__.traversal)` sorts lexically, not numerically (B2, 75)
`src/steps/group.ts:711` orders on the raw child value `f.c.k` with no `compareKey`, unlike
the token branch (`:729`) which wraps in `compareKey(pv, pvtype)`. Numeric properties stored
in SQLite TEXT storage class sort lexically (9 > 35). Latent: the modern-seed ages are all
two-digit so the committed test passes.

- **Test (failing first):** seed (or use an existing graph with) a numeric property whose
  values span digit widths (e.g. `9, 35, 3, 200`), run
  `g.V().properties('n').order().by(__.value()).value()` and assert numeric order
  `[3,9,35,200]`. Add to `test/compiler.test.ts` (execution) — this fails today (lexical).
- **Fix:** carry the child value's `vtype` into the `firstVal` CTE and wrap the sort key in
  `compareKey`. The scalar child rows already expose `rows.stream.vtype`; select it as an
  extra `vt` column in `firstVal`, then `sortKey = compareKey(f.c.k, f.c.vt) <dir>`. Mirror
  the token branch exactly so both paths share the same numeric-sort guarantee. (When the
  refactor in B1/B3-of-section-C lands a shared property-order helper, this compareKey lives
  in one place.)

### A3 — `dedup()` after `order()` in an element child stops collapsing (B3, 75)
`src/steps/child.ts:1115` emits `SELECT DISTINCT id, <carried…>`; once `order()` (:1103)
mints a unique `encounter` into carried, `carryFrag` includes it so DISTINCT never collapses.
Latent: no test exercises `order().dedup()` in a child.

- **Test (failing first):** `g.V(1).local(__.out().order().by('name').dedup()).values('name')`
  or a `where(__.out().order().dedup())`-style existence case that would double-count.
  Assert the deduped count. Fails today.
- **CORRECTED 2026-08-01 — the fix below landed and its rationale was wrong.** `DedupGlobalStep`
  keeps the FIRST occurrence, so `order().by('name').dedup()` still emits in name order: clearing the
  encounter did not "legitimately discard the prior emission order", it discarded an order the
  reference keeps, and `mise run test:perturbed` caught it. Both sites are now a `GROUP BY` with
  `MIN(encounter)` — the same set barrier, plus the order. Do not restore the clearing.
- **Fix:** in the `dedup` branch, clear the encounter as part of the advance so DISTINCT sees
  only the real payload: `advance(end, q\`SELECT DISTINCT ... \`, { encounter: null })` and
  drop `end.carried.encounter` from the projected `carryFrag`. Rationale: a `dedup()`
  re-establishes set semantics and legitimately discards the prior emission order, so
  clearing `encounter` here is correct-by-design, not a workaround. Confirm any following
  `limit` in the same suffix then falls back to `ORDER BY id` (the `end.carried.encounter ?
  ... : p.c.id` ternary at :1123 already handles the cleared case).

---

## B. Test data hygiene (A pure-dedup, no code change beyond regen)

### B1 — duplicate scenarios inflate the L3 ratchet count by 2 (F1, 100)
`test/L3-conformance/l3-state.json` `passed[]` has two names twice (lines 318-319, 333-334):
`g_V_bothE_properties_dedup_hasKeyXweightX_hasValueXltX0d3XX_value` and
`g_V_both_properties_dedup_hasKeyXageX_hasValueXgtX30XX_value`. `passing`/README/matrix
inherit the +2. `test/L2-sql/sql-snapshots.test.ts:1654-1655` also has a duplicated
`.toContain('ROW_NUMBER() OVER (PARTITION BY p.pv')` assertion (same copy-paste).

- **Fix:** remove the duplicate snapshot assertion. Then do a clean local L3 run (`!CI`) so
  the ratchet re-records `l3-state.json` with de-duplicated `passed[]` and rewrites the
  synced count in `README.md` + `docs/feature-support-matrix.md` via the markers. Commit
  `l3-state.json` + synced files together (per CLAUDE.md's ratchet discipline). Verify the
  new `passing` is `oldCount - 2` and `passed.length` has no duplicates.

---

## C. Duplication / genericity (confirm coverage, then refactor to shared helpers)

For each: the behaviour is already correct and tested at the feature level; the work is to
ensure a snapshot/exec test pins the behaviour, then collapse the duplication so the sites
can't drift. No behavioural change intended — L2 snapshots asserted for semantic
equivalence, not byte-identity.

### C1 — property-list framing line duplicated ×3 in `execute.ts` (D1, 75)
`execute.ts:186` and `:373` are byte-identical; `:528` is the same minus the
`typeof pmeta === 'string'` guard (a latent inconsistency — throws if `pmeta` arrives
pre-parsed).

- **Refactor:** extract `framePropertyRow(x): Buffer` — owner/vpid fallback +
  `frameStoredValue(x.pv, x.pvtype ?? null)` + the guarded pmeta normalization
  (`x.pmeta ? (typeof x.pmeta==='string' ? JSON.parse : x.pmeta) : null`). Call it from all
  three sites (`listFieldBuffer`, `frameListOf`, the `case 'property'` row generator). This
  also FIXES the :528 divergence (it gets the guard), so add a small test that frames a
  property whose `pmeta` is already an object (not a JSON string) if the row path can produce
  that — otherwise the guard unification is covered by the existing property-framing tests.

### C2 — property tie-break + payload longhand duplicated (D5/D2, 85)
(a) The property tie-break ORDER BY is re-spelled in `group.ts:672` (dedup, using a
*divergent* `owner,pk,vpid`), `:714`, and `:739` (order, `owner,pk,pvtype,pv`).
(b) The 7-field `PROPERTY_PAYLOAD` payload is enumerated longhand in the SELECT expressions
at `list.ts:92`, `labelselect.ts:48` (json_object), and `labelselect.ts:131`
(`propertyAliasField` ×7), even though those sites already use `PROPERTY_PAYLOAD` for the
paired column list — silent drift if a field is added.

- **Refactor (a):** add `propertyTieBreak(rel, ownerElem): Expression[]`
  (node → `[vpid ASC]`; edge → `[owner, pk, pvtype, pv]` all ASC) in a shared spot
  (`group.ts` local or `plan.ts` near the property helpers). Use it in both `propertyOrder`
  branches. **Reconcile the dedup key deliberately:** the dedup ranking at :672 should use
  the SAME canonical tie-break so "which row survives" is consistent with order; adopt
  `owner,pk,pvtype,pv` (drop the odd `vpid` in the middle). Guard with a test asserting a
  stable survivor for edge-property dedup.
- **Refactor (b):** derive the SELECTs from `PROPERTY_PAYLOAD.map(...)`:
  - `list.ts` unfold: `list(PROPERTY_PAYLOAD.map(c => q\`json_extract(je.value, ${value('$.'+c)}) AS ${c}\`), ', ')`
  - `labelselect.ts` `selectPropertyAlias`: same shape via `propertyAliasField(selected, c)`.
  - `labelselect.ts:48` as() `json_object`: build the key/value pairs from `PROPERTY_PAYLOAD`
    then append `'elem', <ownerElem>`.
  This single-sources the payload against `PROPERTY_PAYLOAD` (stream.ts). Snapshot tests
  already assert the extracted columns; they should be unchanged (equivalent SQL).

### C3 — child `order`/slice/firstPolicy hand-write `PARTITION BY <innermost ordinal>` (D3/D4, 75)
`child.ts:1107` (order), `:1123` (slice), `:1137` (firstPolicy) each spell
`PARTITION BY ${p.c[pushed.frame.ordinal]} ORDER BY <elementOrderSql>, id` inline — three
copies of the same window. Verified NOT a correctness bug (ordinals are globally unique, so
innermost ≡ full stack), but it's the "second implementation" pattern the compiler-extension
law steers away from, and `propertyOrder` already uses the shared `partitionOver`.

- **Refactor:** route the three sites through `partitionOver(end.carried, p, orderKey)` (the
  module-doc'd shared window builder) instead of the hand-written `PARTITION BY ordinal`.
  This de-dups AND future-proofs against an ordinal-scheme change (the exact rationale in
  `context.ts:214-218`). Factor the shared "rank per parent by an order expression" into one
  local helper (`rankPerParent(end, p, orderExpr)`) used by order, slice, and firstPolicy.
  `local` (:1096) already delegates to `tryCompileElementChild` — leave it, but note it as
  the model the refactor should not undercut.
- **Coverage:** existing `nested-local` + child order/limit tests pin behaviour; add a
  child `order()` snapshot asserting the `partitionOver` shape (≥1 `PARTITION BY` over the
  ordinal + `ORDER BY`) so the refactor is result-equivalent. Keep the assertion semantic
  (fragment `.toContain`), not byte-identical.

---

## D. Doc-comment sync (trivial, ride-along)
`src/render.ts:103` — the `jsonbList.of` doc-comment now under-describes `of` (it also
carries a flat `property` descriptor, dispatched directly in `frameListOf`). Update the
comment to mention the property/flat-descriptor case. (C1 flagged this at 75-adjacent; fold
it into the C1 commit since both touch property list framing.)

---

## Build discipline (applies to every commit above)
- `mise run L2` + `bun test test/compiler.test.ts` green; new tests added per finding.
- `mise run L1` corpus still 100%.
- `mise run L3` locally (`!CI`) after B1's de-dup so the ratchet re-records; do NOT let L3
  regress on any other finding (the refactors are equivalence-preserving).
- SQL snapshot updates: equivalence, not byte-identity (CLAUDE.md).
- Suggested commit grouping: (1) A1, (2) A2, (3) A3, (4) B1 ratchet de-dup, (5) C1+D,
  (6) C2, (7) C3 — small, reviewable, each with its own tests. Bugs before refactors so the
  refactors land on green.
