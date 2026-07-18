# Deep-seam migration roadmap

**Date:** 2026-07-18
**Status:** high-level roadmap — each item spawns its own detailed plan doc
**Scope:** the next wave of "make a shape a first-class re-enterable Stream
participant so everything composes through one engine, and delete the bespoke
handler" — the move that already paid off for scalar values and properties.

## The pattern

A shape is *deep-seamed* when steps can lower **from** it back into the generic
`lowerSteps` engine (retype via `LoweringContinuation`), instead of the shape
being a terminal dead-end that only materializes, and instead of a private
mini-compiler special-casing it. Payoff each time we've done it: bugs surface,
combinations that were silently unsupported start working, L3 climbs.

**Done (reference shape):** `ElementStream` (the hub), `ScalarStream`,
`PropertyStream` — fully re-enterable, retype to any shape.

**Frontier (this roadmap), ranked by leverage:**

| # | Target | Kind | Substrate move | Confidence |
|---|--------|------|----------------|------------|
| 1 | Group / Map stream | ✅ done | nested values + element values through the generic seam | landed 2026-07-18 |
| 2 | Traverser bulking | ✅ mostly done | A+B+C landed; only `group`/`groupCount` weighting remains | landed 2026-07-18 |
| 3 | Scalar-parent child arms | widen re-entry | scalar seed re-sources to elements | high (test bed exists) |
| 4 | VariantStream | ✅ row-ops done | shape-agnostic tail; heterogeneity wall on the rest | landed 2026-07-18 |
| 5 | PathStream breadth | fill + 1 piece | map-valued carried alias entry | mixed |

---

## 1. GroupStream / MapStream — first-class re-entry, kill the last inline reader ✅ (landed 2026-07-18)

**Done.** Stage 1 deleted `tryLowerNestedMapGroup`; nested-group values lower through the
generic child seam (any inner movement/filter + generic key/reducer). Stage 2 added the
element-valued group entry (`v_rid` + `json_group_array` in `deriveGroupEntries`), closing
group.ts:478 — `select(Column.values)`/`unfold()` over element values now re-enter. L3
1179→1180. Details: `docs/2026-07-18-group-value-generic-seam-plan.md`. Remaining group
deferrals (element-valued inner keys, single-element `tail` value entries, `by(traversal)`
element keys) are distinct follow-ons, not this seam.


**Problem.** `GroupStream` is near-terminal (`is(typeOf(MAP))`/`count`/`unfold`/
`select(Column)` then materialize — `group.ts:429`); `MapStream` can't even
materialize, pure transient (`materialize.ts:165`). Element-valued groups throw
(`group.ts:478`), composite `project()` keys throw (`group.ts:471`).

**The tell.** `tryLowerNestedMapGroup` (`group.ts:265-331`) is a hand-rolled
mini-compiler for `group().by(k).by(__.<move>.groupCount())` — special-cases
`properties`/`outE`/`inE`/`bothE` by name, hand-rolls movement SQL, re-implements
key/reducer selection. This is the exact surviving analogue of the deleted
`tryPropertyGroupScalar` property-group reader.

**Move.** Same fix that worked for property groups: make the child seam
parent-polymorphic over GROUP/MAP parents so group values lower through
`lowerSteps → compileFrom*`; delete `tryLowerNestedMapGroup`.

**Unlocks.** §4 whole row (group >2 `by()`, composite/traversal keys,
element-value groups, nested-map groups), `group().by(count)` after repeat, group
value re-entry.

**Why first.** Proven playbook, one genuine bypass to delete, highest confidence.
Shares its map-valued-alias piece with #5.

## 2. Traverser bulking — finish the substrate move ✅ (mostly landed 2026-07-18)

**Done (A+B+C).** `bulk` is now a first-class `Carried` column; collapse auto-fires by query
shape (pure movement/filter/bare-`dedup`/`order`/`limit`·`range`·`skip` → a reducer or a bare
element leaf, plus element- and count-returning `repeat().times(n)`) — bounded frontier + `(v,N)`
RLE on the wire, L3 1180 held. See the STATUS header of
`docs/2026-07-18-wire-bulking-rearchitecture.md` for the landed map + the deviations from plan
(bulk orthogonal to shape via `bulkOf`/`frameValues`; `movementCollapse` fast path; cumulative-bulk
`order`/`limit` window). **ONE piece remains:** `group`/`groupCount` bulk-weighting (element-key
forms use an unweighted `COUNT(*)`; needs bulk threaded through `GroupSource` + careful gating);
`sample`/`coin` correctly never collapse (must unbulk) → left excluded. The original problem/move
framing follows for reference.

**Problem.** `bulk` exists ONLY inside the bespoke recognizer `bulk.ts` (one
shape: `repeat(single-hop).times(n).count()`). It is NOT a carried column —
`Carried` (`context.ts:100`) carries `sack/origin/path/aliases`, no `bulk`.
Everything else is pure UNION-ALL row duplication.

**Move.** Promote `bulk` to a first-class `Carried` column on the **existing
sack/origin rails**: field in `Carried`, into `carriedCols`/`carryFrag`, seeded in
`seedSource`, tri-stated in `advance`. Teach three semantics once —
movement-collapse `SUM(bulk)`, `dedup → bulk=1`, reducers weight by `bulk`; force
unbulk at `order/range/limit/sample`. `docs/2026-07-14-traverser-bulking.md:145-165`
already specs this; plumbing exists, was never wired.

**Unlocks.** Correct graph-wide `count/sum/groupCount` after any repeat (grateful
graph unblocks), `sample(n)`/`coin(p)` (not implemented at all today), dedup
weight. The deepest correctness debt — reducers are silently OK today only because
big-repeat graphs are withheld from conformance.

**UPDATE 2026-07-18 — re-architected for the wire.** The `2026-07-14` premise ("wire is a
dead end") was wrong: GraphBinary V4's `{bulked}` response byte is real, the pinned beta.2
client requests + decodes it, and it's backwards-compatible. So bulk now buys end-to-end
tractability for element-returning big-`repeat` too, not just reducers. Staged A→B→C in
`docs/2026-07-18-wire-bulking-rearchitecture.md`. **Stage A landed** (wire bulking, bulk≡1,
contract/L3-verified). B (first-class `bulk` carried column, ≡1) + C (enable collapse, gated
by path-freedom) queued — B+C are a paired delivery (B alone is valueless substrate).

## 3. Scalar-parent child arms — widen scalar re-entry into arms

**Problem.** Scalar re-entry at the **tail** is done, but child **arms** over a
scalar parent are whitelisted. `SCALAR_CHILD_PREFIX` (`child.ts:1036`) is value-ops
only; movement, element-emitting reducers, and nested branches are excluded, so the
arm defers (`child.ts:1041-1055`).

**Move.** Let a pushed scalar seed re-source into element space through the same
child seam — the re-enter the ScalarStream tail already does, extended to arms.

**Unlocks.** Trailing ❌ on 7 branch steps (`choose`/`coalesce`/`union`/
`optional`/`flatMap`/`map`/`local`) + scalar-parent `project` — ~8 matrix rows,
the widest raw row count. Live test bed already exists:
`test/conformance/addendum/scalar-reentry.feature` (`@gap:scalar-position`).

**Why after 1–2.** Widest count but closest to surface-fill; do it after the two
true substrate moves.

## 4. VariantStream — shape-agnostic row-ops ✅ (landed 2026-07-18)

**Problem.** The one relational shape with no `compileFrom*` handler — inlined in
`lowerStream` (`index.ts:298-302`), only `unfold`/`count`, else threw.

**Key correction to the original framing.** This is NOT the scalar/property
"make it fully re-enterable" move — that is *impossible* here. A variant is a
**heterogeneous per-row union** (null/scalar/node/edge/list tagged by `vk`); you
cannot lower it back into element space because some rows aren't elements. Full
parity is a category error. Only the **shape-agnostic** steps — ones that never
look inside a row — can compose uniformly.

**What landed.** Extracted the inline block into a real `compileFromVariant`
handler (`src/steps/variant.ts`, mirroring the list/group family), added the
shape-agnostic row-ops via a `reselect` that re-projects the relation's declared
columns without touching the per-row tag:
- `count` (relational barrier → Long), `unfold` (re-open a cap()'d aggregate)
- `limit` / `skip` / `range` (row-preserving slices)
- `dedup` (`DISTINCT` on the tagged `(vk,v,rid)` row; defers on carried path/label
  state, mirroring element dedup)

Everything that must inspect a row — movement, `order`, value filters — fails
closed by construction. Covered by a compiler unit test (SQL + rows + fail-closed)
and `test/conformance/addendum/variant-rowops.feature` (`@gap:variant-position`).

## 5. PathStream — breadth fill + one substrate piece

**Problem.** Substrate is already built (two-regime `PathState` cols/array,
`AliasEntry` history — the Sqlg prior-art is built, not pending). What's left:
- **Incremental fill:** `from()`/`to()` labels (`select.ts:685`), post-`path()`
  steps that read label history — `order`/reducer/`is` (`select.ts:694`),
  by()-modulator variants.
- **One real substrate piece:** a map-valued carried alias entry so `as()` works
  on group/map/path streams (labels doc item #3) — couples to #1.

**Move.** Mostly feature fill on the existing substrate; land the map-valued alias
entry alongside #1 since they share it.

---

## Recommended order

**1 → 2 → 3**, with **4** dropped in opportunistically and **5** landing its
substrate piece alongside 1. **#1, #2, #4 are ✅ landed (2026-07-18)** — #2 has only
`group`/`groupCount` bulk-weighting left; #3 (scalar-parent child arms) and #5 (path breadth)
are the live frontier.

- #1: highest-confidence structural win, deletes a real bypass, shares a piece with #5.
- #2: ✅ mostly landed (A+B+C) — the deepest substrate debt is paid; only `group`/`groupCount` bulk-weighting remains.
- #3: widest row count but closest to surface — after the true substrate moves.
- #4: ✅ landed — shape-agnostic row-ops only; full re-entry is impossible (heterogeneous union).
- #5: substrate largely built; breadth fill + shared alias piece.

## Non-goals (platform walls / locked)

🚫 rows are NOT candidates: regex TextP (needs UDFs), `tree()`, `store`, lambdas,
OLAP, `withoutStrategies(ConnectiveStrategy)`, Sack/ElementId/Event strategies.

🚫 **`map()` first-of-many over a scalar FAN-OUT arm** (a re-source projection /
nested `union` under `map`): first-result-only would need a deterministic
emission-order column threaded through the fan-out (arm-index through `union`,
id-order through re-source) — not a natural fit for the set-oriented SQL engine,
and zero corpus examples. Fails closed (`armFansOut`); `flatMap`/`local` cover the
all-results need. (The other scalar-parent-arm shapes — reducer/nested-branch/
re-source, and mixed-shape `union`/`choose`/`coalesce`/`optional` variants — all
landed; see [[scalar-stream-reentry]].)
