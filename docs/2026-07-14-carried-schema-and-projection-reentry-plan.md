# Plan — carried-schema-through-branches + chained-projection re-entry

**Date:** 2026-07-14 · **Status:** Item 1 Move A + Move B (aliases through
union/coalesce/optional/flatMap/choose) **LANDED** (L3 824→825, CI green). Item 2
**count-after-scalar core LANDED** (`values/id/label.count()` retypes to a scalar
stream — correct, +0 L3 because the official suite rarely writes it). **Item 1b
path-through-branches LANDED** (pad-to-max `cols`: union/coalesce/optional/choose/flatMap
thread path, ragged arms NULL-padded + LEFT JOIN; deep fix — `carriedCols` now orders
path LAST so movement's appended position stays in sync, which also fixed a latent
coalesce/optional+path desync; +0 L3 — every branch+path scenario in the suite also needs
`path().by()` or nested-`optional`). Still open:
repeat alias-threading, and the REAL bulk of "chained
projections" — `valueMap().select()` (map-value), projections nested inside
branch/where/group bodies, and `fold().is(typeOf).count()` (blocked by `typeOf`
over stored props, a storage-type-tag wall, not the chain). See the corpus note:
top-level `values(k).count()` is rare; the ~40 estimate conflated these shapes.
**Context:** architecture review of the read compiler's remaining deferral clusters.
See `docs/feature-support-matrix.md` (§5 branches, §3 chained projections) and
`docs/2026-07-12-conformance-structural-bets.md`.

## Thesis

The compiler is **not** in a local optimum requiring a rewrite. 204→824 rode a clean
substrate (`parse → normalize → fold`, the 4-shape `Stream` union with `dispatchNext`
re-entry, one SQL statement). The remaining deferrals are **unbuilt features within the
design**, and two of them are single structural gaps each subsuming a large,
scattered set of `throw`s. This doc plans both. Neither is a new abstraction — each
*extends a mechanism the codebase already has* to a seam that doesn't yet participate.

Explicitly out of this plan (orthogonal / genuine walls, do NOT fold in):
- **regex / `typeOf` over stored props** — platform walls (no SQLite UDF on DO), now
  🚫 in the matrix. Not structural.
- **Comparability/Orderability** (~66F) — semantic fail-closed territory
  (mixed-type/null/NaN), not a carried-state problem.
- The one-SQL-statement constraint stays. Both items below are fully expressible in it.

---

# Item 1 — carried-column schema through branch merges (the big lever)

## The gap, grounded

Linear steps already thread an arbitrary carried-column schema. `src/steps/context.ts`:
`carriedCols(st)` = `[...aliasCols, ...pathCols, origin?, sack?, fromV?]`; `carryFrag`
splices them after the moved id in every movement/filter/passthrough CTE; `advance`
preserves them. This is fully general and proven for five distinct carried columns.

**Branch operators are the sole non-participants.** In `src/steps/branch.ts`, *every*
branch StepFn opens with:

```ts
if (st.aliases.size > 0) throw new Error('X after as() not yet supported');
if (st.path)             throw new Error('path tracking through X not yet supported');
```

— union, optional, coalesce, flatMap, choose, repeat (six sites). They seed arm bodies
with `{ ...st, aliases: new Map(), path: undefined }` and merge via `branchOutCols`,
which hard-codes `id` (plus `origin` only). So the UNION-ALL merge **drops the carried
schema**. `origin` already rides through (proof the merge *can* carry an extra column);
it just hasn't been generalized.

This single gap is the largest deferral cluster in the matrix:
- **Select alias-threading** (~68F — the frontier's #1 named item): `as('a')…select('a')`
  spanning a branch.
- Nearly every §5 row's `❌ after as()` and `❌ path tracking through`.
- Path family (§7): `path()` over a `union()` source, steps that need path preserved
  across a branch.

## The change — reify the carried schema, THEN fix the merge

Do this in two moves, in this order. Move A (the structural extraction) is deliberately
bold: it's not strictly required to fix the branch bug, but it's the change that makes
the bug **impossible to reintroduce** and every future carried column a one-place edit.
The branch fix (Move B) then falls out as a method on the object Move A extracts —
instead of a fifth hand-edit to a function nobody was forced to call.

### Move A — extract `Carried` (structural, no behaviour change)

Today `Carry` (context.ts) is a flat bag mixing three unrelated kinds of thing:
- **Physical carried columns** — `aliases`, `path`, `origin`, `sack`, `fromV`,
  `trackFromV`. These are (or govern) columns physically present on the id-relation and
  MUST travel together, be threaded by `carryFrag`, and agree across a branch merge.
- **Ambient compile context** — `q` (the CTE builder), `params` (bindings). Not
  per-traverser, not columns.
- **A separate registry** — `sideEffects` (named CTEs that OUTLIVE the traverser).

Nothing signals that the six physical-column fields are one unit — which is exactly why
the branch merge could quietly drop them. **Fix: group them under one field.**

```ts
export interface Carried {
  readonly aliases: AliasMap;
  readonly path?: PathState;
  readonly origin?: string;   // coalesce/optional input ordinal
  readonly sack?: string;     // mutable per-traverser scalar
  readonly fromV?: string;    // edge: the entering vertex (otherV)
  readonly trackFromV?: boolean;
}
export interface Carry { readonly q: Query; readonly params: Record<string, any>;
  readonly sideEffects?: SideEffectMap; readonly carried: Carried; }
export interface St extends Carry { readonly kind: 'elements'; readonly last: Relation; readonly elem: Elem; }
```

**This is a struct of typed roles, NOT a flat `Column[]`** — deliberately. The roles are
heterogeneous for real reasons (aliases is a name→col Map for `select`; path is a
two-regime union; sack is *mutable*; fromV *clears on landing*; origin *drops at branch
output*). Homogenising them into a uniform typed-column list would re-lose the structure
every reader needs — that's the "Schema type" over-abstraction we explicitly rejected.
Group; don't homogenise.

The column-threading logic moves onto `Carried` as the single source of truth:
- `carriedCols(c: Carried): string[]` — the ordered SQL column list (was a free fn over `St`).
- `carryFrag(c: Carried, p): Expression` — the `, p.a0, p.p0, …` fragment.
- `carriedWith(c, patch): Carried` — apply the tri-state patch (`origin: null` clears,
  `undefined` keeps, a value sets), the logic currently inline in `advance`.

**Keep `advance`'s flat opts signature identical** (`{ aliases?, path?, origin?, sack?,
fromV?, elem?, cols? }`) — it just routes the carried opts through `carriedWith`
internally. So **all 24 `advance()` call sites are untouched**; the churn is confined to
(1) read sites `st.aliases` → `st.carried.aliases` (~40, mechanical), (2) the ~6
`{...st, aliases: new Map(), …}` spread-seeds → a `withCarried(st, patch)` helper, and
(3) `stream.ts` `carryOf` (now copies `q`/`params`/`sideEffects`/`carried`). The whole
of Move A is a **pure refactor**: `bun test` + L3 baseline must stay green with
semantically-equivalent SQL after it. Land it as its own commit before touching branch semantics.

### Move B — the branch fix, as `Carried` methods

With `Carried` extracted, the fix is small and self-evident:

1. **`mergeCarried(seed: Carried, arms: Carried[]): { cols: string[] }`** on the object:
   assert every arm exposes the seed's carried columns (guaranteed by the shared seed +
   the new-`as()`-in-arm guard below), return the projection list `['id', ...cols]`. A
   branch merge that ignores this is now *visibly* wrong.
2. **union / coalesce / flatMap / choose**: seed arms WITH the incoming `Carried`
   (aliases + path preserved) instead of the empty reset. Movement/filter already thread
   the columns via `carryFrag`. `originSeed` (coalesce/optional) must project the
   incoming carried cols alongside its new `o` ordinal (currently `SELECT id, ROW_NUMBER()
   … AS o` — extend to `SELECT id, <carried cols>, ROW_NUMBER() … AS o`).
3. **Merge projecting the carried cols**, not bare `id`. `branchOutCols` → `mergeCarried`.
   `advance` the merged relation preserving the incoming `Carried` so downstream
   `select`/`where(as…)` resolve the alias columns off the merged CTE.
4. **Drop the `if (st.carried.aliases.size > 0) throw`** in union/coalesce/optional/
   flatMap/choose.
5. **optional fast-path** (`branch.ts:101`): its hand-rolled LEFT-JOIN/COALESCE-to-self
   SELECT must splice `carryFrag(st.carried, p)`.
6. **choose `gate()`** (`branch.ts:265`): the gated seed's SELECT must splice
   `carryFrag(st.carried, p)` through the JOIN.

**Deferral kept, fail closed:** an arm that **binds a NEW `as()` inside its body** makes
arms disagree on the schema. v1 preserves only *incoming* aliases; detect an `as` step in
an arm body and throw "as() inside a branch arm not yet supported". This keeps the
shared-seed invariant that makes `mergeCarried`'s assertion hold by construction.

### Path through branches (1b — deliberately deferred, NOT dropped)

Path is genuinely asymmetric: arms can append **different numbers** of linear positions
(`cols` regime `p0,p1,…`), so a naive UNION-ALL is ragged. This is real design (pad-to-max
vs switch to the `array` JSONB regime, which currently forbids movement-after), so it
gets its **own** follow-on. Keep the `if (st.carried.path) throw` guard on the branch ops
until then — deferring correctly beats merging ragged columns and returning wrong paths
([[correct-by-design]]). Bold ≠ reckless: Move A + aliases-through-branches is a
complete, correct, shippable increment; path rides the next one.

## Scope / sequencing (each its own commit, each green before the next)

1. **Move A** — extract `Carried`, migrate all readers, `withCarried` helper. Pure
   refactor; L3 baseline unchanged. Run `/code-review`.
2. **Move B on `union`** first (simplest merge). Add SQL snapshots; ratchet L3.
3. **Move B on `coalesce` / `optional` / `flatMap` / `choose`** (origin-seed projection +
   the two hand-rolled selects). Ratchet.
4. **repeat** alias-threading is SEPARATE (its walk is a recursive CTE, not UNION-ALL —
   carrying alias cols through the `WITH RECURSIVE` term). Own follow-on; keep its guard.
5. **Path through branches (1b)** — own doc/commit.

## Test plan

- SQL snapshots: `V().as('a').union(out(), in()).select('a')`, `optional(out()).select('a')`,
  `choose(has(k), out(), in()).select('a')`, `coalesce(out(), in()).select('a')` — assert
  the alias column survives the merge.
- Cucumber: widen `test/conformance/tags.ts` for select/branch scenarios that failed on
  `after as()`; baseline auto-ratchets locally (commit it).
- Corpus stays 2298/2298.
- Fail-closed snapshots: arm binding a new `as()` still throws; `path` through a branch
  still throws (until 1b).
- `/code-review` on Move A (pure refactor — verify zero behaviour drift) and on Move B.

## Risk / blast radius

- **Move A** is wide but shallow (mechanical read-site rename + one struct regroup);
  the test suite catches any missed site (a `st.aliases` left dangling won't compile).
- **Move B**'s failure mode is a column-count mismatch in the UNION-ALL — neutralised by
  `mergeCarried`'s assertion + the shared-seed invariant + the new-`as()`-in-arm guard.
- `origin` is now inside `Carried`, so `carriedCols` counts it exactly once — the old
  hand-rolled `branchOutCols` double-count risk disappears.

---

# Item 2 — chained projections via scalar-stream re-entry (finish the pattern)

## The gap, grounded

`src/steps/projection.ts:133`:

```ts
if (acc.projStep) throw new Error('only one projection step is supported per traversal');
```

`foldTailAcc` accumulates at most one projection. So `values().count()`,
`valueMap().select()` (element-VALUE case), and similar element→scalar→scalar chains
throw (~40F, §3).

**But the re-entry machinery already dissolves this for other shapes.** `compileTail`
(`projection.ts:190–224`) handles a **non-terminal** `group()` by retyping to a
`MapStream` and calling `dispatchNext`; a **non-terminal** `fold()` retypes to a
`ListStream` (`compileFold` → `dispatchNext`); `unfold()` retypes to elements/scalar.
Each retype gives the next phase a **fresh accumulator** — that's exactly what dissolves
the one-projection ceiling *for those steps*. Scalar-producing projections just never got
the same treatment.

`compileFromScalar` (the `ScalarStream` consumer, `index.ts:195`) already exists and
handles a scalar stream's own tail (it's what `compileInject` reuses). The missing piece
is a **retype from an element projection to a `ScalarStream`** when a step follows.

## The change

Mirror the non-terminal `group()`/`fold()` handling for scalar-producing projections
(`values`, `id`, `label` — the ones that yield a `v`-column stream; `count`/`sum`/… are
reducers, and `valueMap`/`elementMap`/`select`/`project`/`path` are map/element shapes
routed elsewhere).

1. In `compileTail`, **before `foldTailAcc`**, detect: `steps[stop]` is a scalar-producing
   projection AND a step follows it (`stop+1 < steps.length`) that isn't already absorbed
   as a value-tail modifier of *this* projection. If so, build a `ScalarStream` from the
   projection and `dispatchNext(scalarStream, steps, stop+1)`.
   - `values()` is a flatMap JOIN (N rows, one `v` col) → a `ScalarStream` of N rows.
   - `id()`/`label()` → one `v` per element.
2. Add a `projectionToScalarStream(st, projStep)` retype in `projection.ts` (sibling to
   `groupToMapStream`/`compileFold`) that emits the `v`-column relation and wraps it as
   `ScalarStream` (`stream.ts`), carrying `carryOf(st)`.
3. `compileFromScalar` then consumes the follower — `count()` over the scalar stream
   (`COUNT(*)`), `fold()` (→ `ListStream`), `is(P)`, `order()`, `dedup()`, etc. Most of
   these already exist in the scalar tail vocabulary (`foldTailAcc` is shared).

**Boundary with what already works:** a *terminal* scalar projection stays
`buildProjection` (unchanged — do not reroute). Only a projection *with a follower
that isn't its own value-tail modifier* retypes. The existing value-tail modifiers
(`is`/`order`/`limit`/transforms/`inject`) must still fold onto the projection directly
(they're cheaper as one query), so the retype trigger is: **follower is another
PROJECTION_NAME or a reducer/`fold`/`unfold`**, not a MODIFIER already in the vocabulary.

## Scope / sequencing

1. `values().count()` first — the dominant idiom. Verify `count` over a `ScalarStream`
   in `compileFromScalar` (add if missing).
2. `values().fold()` (scalar → list, likely already reachable once the retype exists),
   `id().count()`, `label().dedup().count()`.
3. `valueMap().select(...)` (element-VALUE map) is the **MapStream** path (§MapStream),
   partly done — track separately, do not conflate with the scalar retype.

## Test plan

- SQL snapshots: `V().values('age').count()`, `V().out().id().count()`,
  `V().values('name').fold()` (if not already via terminal fold).
- Cucumber: the §3 `chained projections` scenarios; baseline ratchets.
- Corpus 100%.
- Fail-closed check: an unsupported follower (e.g. a map-shape after a scalar) still
  throws clearly.

## Risk / blast radius

- Smaller and better-fenced than Item 1: the retype is additive and the terminal path is
  untouched. Main risk is mis-triggering the retype on a step that *should* fold onto the
  projection (e.g. `values().is(gt(30))`) — guard the trigger on the follower being a
  projection/reducer/retype step, never a MODIFIER.

---

# Recommended order

1. **Matrix regex → 🚫** (done in the same review).
2. **Item 2** (scalar re-entry) — smaller, well-fenced, finishes an existing pattern,
   ~40F. Good warm-up that exercises the retype seam.
3. **Item 1 Phase 1a** (aliases through union, then the other UNION-ALL branches) — the
   big lever, ~68F select-threading + the scattered branch `after as()` rows.
4. **Item 1 Phase 1b** (path through branches) and **repeat alias-threading** — follow-ons.

Both items are extensions of mechanisms already in the tree (the carried-column fold;
the `dispatchNext` stream re-entry), not new abstractions — which is why neither warrants
backtracking the architecture.
