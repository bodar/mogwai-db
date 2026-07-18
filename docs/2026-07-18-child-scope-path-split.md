# pushChildScope: split the body-seed from the frame-domain (path-in-child bug)

**Date:** 2026-07-18
**Status:** IMPLEMENTED 2026-07-19 — but by a smaller, deeper fix than this doc proposed
(see "What actually shipped" below). The design analysis here is kept as the investigation
record; the "seed a path-free reprojection + migrate 4 consumers" plan was NOT the fix.
**Baseline when written:** L3 1226, full suite 396+ green, trunk @ the path-history commits.

## What actually shipped (2026-07-19)

The root cause was narrower than "the child inherits path": `pushChildScope` appended the new
child **ordinal** as the physically-LAST domain column, *after* the path columns — but
`carriedCols` orders origins BEFORE path. So the seed's declared schema (ordinal-in-origins)
disagreed with its physical layout (ordinal-last) whenever the outer chain also tracked a path.
Harmless for `lowerElementSteps` (name-based, no assert — so branch/local arms always worked),
fatal at `lowerSteps`'s `assertStreamColumns` (the group/scalar by-children).

The fix is two localized changes, NO consumer migration, and path is **kept** (never stripped):

1. **`pushChildScope` (child.ts):** build the domain's carried columns in `carriedCols` order —
   the ordinal minted by `ROW_NUMBER()` lands in its origins slot, every other carried column
   projected by name. The seed's declared schema now equals its physical layout. ~20 lines.
2. **Scoped reduce barriers (barrier.ts `lowerScopedScalarFold`/`lowerScopedElementFold`/
   `lowerScopedScalarReducer`):** a reduce barrier emits one row per origin and must carry the
   **frame's** (parent domain) schema, not the child body's — the child's `out()` legitimately
   extends the path *inside* the child (`p2`), and that extension collapses at the barrier by
   definition. `ChildFrame` now carries the domain's `carried`; the three barriers use it.

Why this is better than the split-seed plan: branch/local arms CONTINUE the traverser and MUST
extend the outer path — a path-free seed broke them (union/optional/coalesce/choose/local
`.path()` all regressed). Keeping path everywhere + fixing the ordinal position + the barrier
carry handles both the reduce-children (group/project/aggregate/where/path.by) and the
continuation arms with one honest invariant and zero per-consumer flags. `lowerPath`,
`tryLowerTraversalRecord`, `lowerScalarProject`, `dedup`, `group` were NOT touched.

Coverage: execution regression tests in `test/compiler.test.ts` (group/project/where/path.by +
branch-arm path guards) and an L4 `@gap:child-path` family (`test/conformance/addendum/
child-path.feature`) — which required teaching the L4 mini-parser the official `m[…]` Map
notation (maps are pervasive in the L3 corpus; the parser just needed it).

---

_Original design analysis follows (superseded by the above)._

## The bug (pre-existing, reachable, fails closed)

A `by(__.traversal)` child body that contains **movement** (`out()/in()/both()/…`), lowered
while the outer chain is **tracking a path** (any `path()`/`simplePath()`/`cyclicPath()` in the
chain enables tracking), makes the child's own movement **append a path position** to the
outer path — because the child seed inherits `carried.path`. The appended column then
mismatches the declared carried schema at the child's fold/reducer barrier.

Reachable repro (fails on trunk today):

```
g.V().out().simplePath().group().by(T.label).by(__.out().values("name").fold())
→ Error: elements stream column mismatch: expected [id, bulk, o0], got [id, bulk, p0, p1, o0]
```

`count()` children happen to survive (their reducer drops carried, so the bogus path column
never surfaces); `fold()`/element children preserve carried and expose it. It **fails closed**
(a clear column-mismatch throw, never wrong data), which is why it went unnoticed — no corpus
scenario combines `simplePath()` with a fold-with-movement child.

The `path().by(__.trav)` FEATURE (2026-07-18 path rework) is NOT affected: it strips path in
its own `reRootElement` childParent (`select.ts lowerPath`), so its child bodies are path-free.
This bug is the *general* child seam, every other consumer.

## Why it isn't a one-liner — the domain is triple-purposed

`pushChildScope` (`src/steps/child.ts`) builds ONE relation (`domain`) and returns it as BOTH
`seed` (the parent for the child body) AND `frame.domain` (the join/carry anchor). Three
consumers read that one relation with **conflicting** needs:

1. **The child body** (`lowerElementSteps(body, pushed.seed)`) must NOT see `path` — its
   movement appends to it. → wants path stripped (carried AND physical columns, or the
   `assertStreamColumns` contract fails: `seed.carried` without path vs `seed.rel.cols` with
   `p0,p1` → `column mismatch`).
2. **path-position** (`select.ts lowerPath`, its own `pushChildScope(st)`) reads the path
   columns `p.c[p0]` off `outer.seed.rel` to build the path. → wants path columns PRESENT.
3. **dedup / group / record carry-forward** read `carryFrag(st.carried, frame.domain)` where
   `st.carried` still has path. → wants path columns PRESENT.

So a carried-only strip breaks (1)'s contract; a full strip of the shared domain breaks (2)
and (3). The three needs can only be met by giving the child body a **different relation**
from the one consumers anchor on.

## The move — return two relations

`pushChildScope` returns:

- `frame.domain` = the FULL domain (payload + all carried incl `path` + `ordinal`), exactly as
  today. Consumers that read path columns or carry path forward use THIS.
- `seed` = a **path-free reprojection** of the domain when `parent.carried.path` is set
  (`SELECT payload, carryFrag(pathFreeCarried, domain), ordinal FROM domain`), so its
  `rel.cols` and `carried` agree (contract-valid) and the child body lowers path-free. When
  there is no path, `seed === domain` (no extra CTE — zero overhead on the hot path).

Both share the same `ordinal` values (the reprojection preserves them), so every existing
`JOIN … ON child.ordinal = domain.ordinal` still lines up.

### Consumer migration (this is the real work)

Audit every reader of `pushChildScope(...).seed.rel` (or `outer.seed.rel`) and decide per site
whether it wants the **body seed** (path-free) or the **frame domain** (path-full):

- **Body lowering** (`lowerElementSteps(prefix, pushed.seed)`, `lowerSteps(pushed.seed, body)`
  in `compileScalarChildRows`/`compileElementChildRows` and the inline arm compilers) → keep
  `pushed.seed` (now path-free). Auto-fixed, no change.
- **path-position** (`select.ts lowerPath`): `p = outer.seed.rel` → `outer.frame.domain`;
  `reRootElement(outer.seed, p=frame.domain, p.c[pos.col], …)`. Its explicit childParent
  path-strip becomes redundant (seed is already path-free) — delete it.
- **dedup(traversal)** (`filter.ts lowerElementDedup`): `rows.frame.domain` already — verify it
  reads `frame.domain`, not `stream.rel`, for the carry.
- **record** (`select.ts tryLowerTraversalRecord`): the hard one. It builds branches off
  `outer.seed` AND assembles `carryFrag(st.carried, from)` where `from` is a branch relation.
  Under path tracking `st.carried` has path but the branches (path-free) don't → mismatch.
  Resolve by either (a) assembling `from = outer.frame.domain` and joining branches onto it, or
  (b) recognizing a record is a barrier that does not forward path (path() after a record fails
  anyway) and building the record with a path-stripped `st.carried`. (b) is simpler and likely
  correct — confirm no scenario forwards path through a select/project.
- **group** (`group.ts tryLowerGroupChildSource`): confirm it joins on `frame.ordinal` to
  `frame.domain` (path-full) and its child bodies run on `pushed.seed` (path-free).

### Reuse-frame branch

`pushChildScope`'s early `reuseFrame` return uses `parent.rel` directly. A reused parent came
from a prior push; if that push already produced a path-free seed, the reuse chain stays
path-free. Verify the multi-modulator (record fields, math vars via `reuseCurrentFrame`) path
still lines up — siblings share one ordinal, so path-free reprojections must preserve it.

## Test strategy

- Land the `pushChildScope` split FIRST with NO consumer changes and run the full suite — it
  should stay green (seed path-free only matters where a body has movement under path, which
  currently errors anyway). Then migrate consumers one at a time, full suite per step.
- New coverage tests (were fail-closed, should pass after):
  - `g.V().out().simplePath().group().by(T.label).by(__.out().values("name").fold())`
  - `g.V().out().simplePath().aggregate("a").by(__.out().values("name").fold()).cap("a")`
  - `g.V().out().simplePath().project("x").by(__.out().count())` (already passes — regression guard)
- Add an L4 `@gap:child-path` addendum family for the newly-working combinations.
- Watch L3 (≥1226) + corpus 2298 at every step.

## Payoff

Removes the last place a child inherits outer state it has no business seeing — the same class
of cleanup as the shape re-entry work. Unlocks any child-body-with-movement under path
tracking (group/aggregate/project/dedup/order fold+movement children), and makes the child
seam's contract honest (a child scope is genuinely its own scope). Per the session's pattern:
each time we make the seam generic, a latent bug falls out and coverage compounds.

## Non-negotiables

Fail closed (never mis-execute a path scope). `carriedCols` order (path LAST) is load-bearing —
the reprojection must emit columns in `carriedCols` order. SQL snapshots assert semantic
equivalence, not byte-identity. No new global state; the split stays inside `pushChildScope`.
