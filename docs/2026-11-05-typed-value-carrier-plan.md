# A typed value is one carrier — plan

**Status: DECIDED by the owner (2026-11-05). Build as written; do not relitigate. We have no users, so do
the correct thing; widening scope for a better result is the intended direction.** It replaces
outstanding-work §2 "Tier B — retire `PresentWhen`?": the side channel goes, and every correct answer stays.

**Re-scoped twice on 2026-11-05 (owner):**
1. **No storage migration.** Nothing is deployed. A browser-demo scratch database may read an old null map
   entry as absent, and that is accepted. The P0 migration runner (`186bff82`) was reverted.
2. **The brand is on the TYPED VALUE, never on presence.** A first run built a `PresenceTag`: a branded
   type for presence only, carrying its presence expression in a side `WeakMap`, with every other tag left
   unbranded. That swapped `PresentWhen` for a disguised `when`. It was reverted (`78df472a` P2,
   `91e2fe04` P3, `b99be552` P4b). P1 (`08aacfbc`) stays.

Evidence: the design study `.logs/presence-tag-study.md` (local) and its probes in `.logs/presence/`. It
has file:line maps of every tag site, producer and consumer, and measured costs.

## The idea

**A typed value is ONE carrier: its value and its TYPE TAG, travelling together.** The tag is TOTAL:
- never NULL for a value that exists;
- `'null'` for a null value;
- NULL only when there is no value.

That makes four states:

| State | Tag | Value |
|---|---|---|
| absent (the body produced nothing) | NULL | NULL |
| a null | `'null'` | NULL |
| NaN | a numeric tag | NULL |
| a value | `t` | `v` |

Presence, a productive null and NaN are not separate concepts with types of their own. They are READINGS
of the carrier:
- `present(x)` is `tag IS NOT NULL`;
- `isNull(x)` is `tag = 'null'`;
- `isNaN(x)` is a numeric tag with a NULL value.

Nothing is stored beside the carrier.

Both vendored references model it this way:

- **TinkerPop.** A value travels with one productivity bit: `util/TraversalProduct.java`, set from
  `hasNext()` in `TraversalUtil.produce` (`util/TraversalUtil.java:108-140`). It is read uniformly by
  `ProjectStep.java:66`, `TraversalMapStep.java:49-53`, `CoalesceStep.java:58`, `SelectOneStep.java:64-65`,
  `DedupGlobalStep.java:77-83`, `OrderGlobalStep.java:183-184`, `BranchStep.java:161-162` and
  `TraversalUtil.test:143-151`.
- **Calcite.** `RelDecorrelator` projects ONE indicator column INSIDE the subquery (`:3157-3170`), rewrites
  `count(*)` onto it (`:3374-3388`), and gates every constant hoisted above the join on it (`visitLiteral`,
  `:2720-2726`).

Our per-row type tag (`vtype`; the archived RelIR plan §6·7: "a static tag is an optimization, never the
carrier") is that column, once it is total and is never attached from outside.

## Rules (they keep it from drifting again)

1. **One branded carrier type for EVERY typed value in the compiler**, in `src/compiler/rel/tag.ts`. Only
   its constructors can build one (a module-private brand, so `tsc` rejects a hand-built one). That covers:
   - property reads;
   - child-seam values;
   - framing tags (`hostTag`, `armTag`, `mergedVtypeOf`, `staticTagExpr`);
   - record fields;
   - collection members;
   - write values;
   - sack values.

   Nothing is exempt. A site that genuinely cannot be a carrier is listed in this plan with its reason,
   not waved through in code.
2. **No presence-specific type, no side map, no `{when}`.** If a design wants to store "the presence
   expression" next to a tag, the design is wrong. Fix the tag instead.
3. **The tag is built INSIDE the row that has the value**: a constant in the body's own select list when
   static (free), and an inference only over a real row column. It is never inferred over a scalar-subquery
   result (`typeof` answers `'null'` on no-row, which is the inverse defect). It is never attached by a host
   unless it is gated on the arm's carrier (Calcite `visitLiteral`).
4. **Value and type cross a correlated seam as ONE read**, a packed jsonb. They never travel as two
   correlated subqueries that can disagree about whether a row exists. Where value and tag come from the
   same row with no extra read, the carrier may be two columns; the carrier type hides the physical form.
5. **Where a type admits no null, the value alone is the carrier's presence**, with zero extra cost. That
   is the optimisation, not a different concept.

## Steps

Each step lands green on its own, IDs are stable, and `after` gives the order.

- ✅ **P1 total-tag encoding — LANDED (`08aacfbc`).** A null leaf/member is `{t:'null'}` via `valueNodeOf`
  (`src/gremlin/types.ts` `NULL_TAG`/`isNullTag`/`leafTag`). Compile-time-null alias entries write
  `t:'null'`. SQL tag inference is consolidated in `src/compiler/rel/tag.ts` with one `nodeIsNull`. Revs are
  unchanged (`propsCanonical`). Witness `test/null-tag.test.ts`.

- **T1 the typed-value carrier (after P1)** — rules 1–5 as code.
  - A branded `Typed` in `rel/tag.ts`, with constructors for:
    - a row value (inference inside, refused over a subquery);
    - a static type (a constant in the body's select list);
    - a packed jsonb read;
    - a gated hoist (`CASE WHEN <carrier present> THEN <tag> END`).
  - Readers: `present`, `isNull`, `value`, `tag`.
  - Convert EVERY tag site to it: the framing tags included, and the outside-attached ones gated (coalesce's
    `ELSE armTag(final)` at `lower/reduction.ts` ~:1752, choose's arm tags ~:1657, `hostTag` over a
    may-be-absent value).
  - Where a value and its tag cross a correlated seam as two subqueries today, they become one packed read.
    The study measured 28% faster at 8k (V6 vs V1b). Measure the common shapes before and after; a slower
    packed form is investigated, not kept as two readers.
  - Enforcement is the brand plus, where needed, `mise run arch`.
  - `PresentWhen` still exists after T1; this step only gives every value a total carrier.

- **T2 producers read presence off the carrier (after T1)** — one commit each. Replace each `{when}` with
  `present(carrier)`, deleting the stated branch and the declines that guarded it:
  - `oneRowPresence` (EXISTS → the body's carrier);
  - `aliasGuard`/`rerootPresence`;
  - `selectedNodeChild` (the node IS the carrier);
  - `producedOnlyWhere`;
  - coalesce (`orValue` → a carrier-driven CASE).

  Verified by the reverted builds, so reuse it:
  - **Alias entries.** `json_extract(a, '$[#-1].k')` (the entry's shape tag) is total for every entry
    shape and NULL exactly where the history is NULL or empty, at the cost of the one read it replaces.
    Element labels keep `id IS NOT NULL`, and statically bound labels carry nothing (byte-identical).
  - **A filter `is()` over a may-be-absent subject** must conjoin the subject's presence, so that
    `where(select('k').is(neq(1)))` does not pass a row on which `k` is unbound.

  Wrong answers that flip to right (study §5), each an L4 scenario citing its reference step, census
  recorded with reasons:
  - `map(__.V().constant(null).limit(1))`: `[]` → `[null]`;
  - `where(…)` over that body: `[]` → `[1]`;
  - `inject(0).union(constant(null).as('a'), constant(2)).map(select('a'))`: `[]` → `[null]`
    (`Scoping.getScopeValue`);
  - the null-bound label under `project`.

  Trace S9.9 (`inject(['a':null]).map(select('a'))`). If it is a separate map-host gap, fix that too.

- **T3 an `is()` gate keeps a productive null that passes (after T2)** — `inject(null,1).map(is(neq(1)))`
  is `[null]` (`FilterStep`; `TraversalMapStep.java:49-53`). Verified by the reverted build:
  - `predicateOnNull` (beside `predicateExpr`) says whether a predicate holds over a NULL subject: neq,
    without, eq(null) and negative TextP do; gt, eq(v), within(non-null) and ranges do not; typeOf is
    unknown. Hold it to the emitted SQL with a test.
  - The carrier's tag is gated by the test, and the predicate is spelled ONCE through `once()` (2.2× vs
    +12% measured).
  - A run of k `is()` tests the value the FIRST one saw, so cost is linear in k.

  Also cover it through a transform, a projector and a nested host: the carrier survives those, which the
  reverted presence-only version could not.

- **T4 admit the `constant(null)` child (after T2)** — `reduction.ts` ~:2824 and its element-arm twin: a
  carrier `('null', NULL)`, gated on the host. This lifts r4-fu4 (`project('x').by(constant(null))`,
  `project('nick').by(coalesce(values('nick'), constant(null)))`) and the `map`/`local`/`flatMap`/`group`
  declines.

- **T5 consumers follow the REFERENCE (after T3, T4)** — `reductionTail`, `record.ts` (so `project` keeps a
  null key), filters, branches, `productivityFilter`, and `order`/`dedup`/`sack` keys read the carrier.
  Delete `meetPresence`. **Delete the §17 "A null `by()` value" divergences** (`docs/feature-support-matrix.md`):
  - `OrderGlobalStep` / `DedupGlobalStep` keep a productive-null key and order it per orderability;
  - `CoalesceStep` lets a null first arm win.

  Keep a §17 line only where the reference's answer is genuinely impossible, and say why.

- **T6 delete the side channel (after T5)** — remove `PresentWhen`, `statedPresence`, `HostPresence`,
  `orValue` and every `'when' in` switch. No `Presence` arm carries an expression. Presence is the
  carrier's reading, plus `'always'`/`'unknown'` facts where they are static. Element hosts stay on
  `id IS NOT NULL`, which is already exact.

- **T7 NaN is a carrier state (after T6)** — a numeric tag with a NULL value. JSON nodes get
  `{"t":"double","v":null}`. End to end:
  - **Literals and parameters:** lift the decline (`ir/uncarried-literal.ts`, the `const.ts` NaN fold).
  - **Storage:** `(value NULL, vtype 'double')`, with no schema change. Reads use the carrier, never
    `value IS NOT NULL`.
  - **Framing and wire:** `execute.ts` frames a GraphBinary double NaN. GraphSON, CSV, federation and
    replication all round-trip it.
  - **Predicates:** null tests are `isNull`. Comparisons follow `Comparability.feature`.
  - **Reducers:** `sum`/`mean`/`min`/`max` propagate NaN (`NumberHelper`), with the term spent only where a
    NaN can occur.
  - **Ordering:** NaN sorts above +∞ (`orderability.ts`).
  - **Keys:** dedup, group and set keys keep NaN distinct from null.
  - **`math()`:** `0/0` yields NaN where the reference does.

  Lifts the 6 `nan-literal` L3 scenarios. Delete their ledger reason and the matrix NaN row.

- **T8 the law (after T5)** — an L5 property law that for a random body `b` the child form agrees with
  the chain form:
  - `map(b)` ≡ `b` per traverser;
  - `where(b)` keeps exactly the traversers for which `b` is productive;
  - `project('x').by(b)` holds `x` exactly when `b` is productive, with its first value.

  It catches the whole class generically (`docs/property-based-testing-l5.md`).

## Cost discipline

- **The common shapes must not get slower.** These are `order().by(select('a'))`, `project('x').by('age')`,
  `map(values('age'))`, `where(out().count().is(gt(1)))`, `dedup().by('name')` and `project … coalesce`.
  Where the carrier becomes one packed read they should get faster.
- **`sql-hygiene` may only go down.** Any rise names the user-visible answer it buys (CLAUDE.md).
  `test/compiler/compile-work.test.ts` ceilings move only with a stated reason.
- **Scaling probe** at N≈1k and 8k on every step that touches a producer or a reader.

## Done when

- Every typed value in the compiler is a branded carrier, and no presence-specific type, side map or
  `{when}` exists.
- `PresentWhen` is gone.
- The study's §5 wrong answers match the reference.
- The "A null `by()` value" §17 row and the NaN wall are deleted.
- The L5 law is green.
- No common shape got slower.
