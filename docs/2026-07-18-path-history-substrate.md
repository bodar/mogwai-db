# Path-history substrate — labels-on-path, from/to scoping, per-position children

**Date:** 2026-07-18
**Status:** design — the structural bet behind path-track Slices 2–4 (roadmap #5).
**Baseline:** L3 1209 (after path→list retype Slice 1, commit 2b7c61c).

## The problem

The linear path substrate (`PathState.cols` = per-position rowid columns p0…pN) records
element identity per position but **nothing about labels or per-position traversals**. Three
otherwise-independent frontier features all bottom out here:

- **`path().from(l).to(l)`** — scope a Path to the positions between two `as()` labels.
- **`path().by(__.trav)`** — project each position through a child traversal, not just a key.
- **`select(label)` / `path().select(Column.keys)` after `path()`** — read the label history
  a path carries (currently wiped by `withoutCarried` at the path barrier).

The unifying fact: on a **linear** chain, `as(label)` attaches to the *current* element,
whose path position index is **known at compile time** (`path.cols.length - 1` at bind).
So labels-on-path needs **no runtime column** — it's a static label→position map. This is
what makes the substrate tractable rather than a runtime-tagged rewrite.

## Target scenarios (grounded)

```
g.V().as("a").out().as("b").out().as("c").path().from("b").to("c").by("name")   → p[josh,ripple]
g.V().both().as('a').both().as('b').simplePath().path().by('age').from('a').to('b')
g.V().as("a").out().as("b").out().as("c").simplePath().by(T.label).from("b").to("c").path().by("name")
g.V().out().out().path().by(__.values("name").toUpper())        (+ the Merge/Difference/… by(trav) forms)
g.V().asXa_bX().out().as("c").path().select(Column.keys)
g.V().as("a").out().as("b").in().as("c").dedup("a","b").path().by("name")
```

Deferred (needs path *natural-order* comparability, a separate harder piece):
`g.V().out().out().as("head").path().order().by(asc).select("head")` (Orderability ×8).

## The three pieces

### Piece A — labels-on-path (compile-time static) + `from()`/`to()` scoping

**Model.** Extend `AliasEntry` (context.ts) with `pathPos?: number` — the linear path
position index recorded when `as()` binds while `path` tracking is active
(`st.carried.path?.kind === 'cols'` → index = `cols.length - 1`). Single-bind labels are the
suite; a rebind overwrites `pathPos` with the latest (documented; multi-bind from/to has no
scenario and can fail closed).

**`from`/`to` folding.** `from`/`to` arrive as their own modulator steps after `path()`
(and after `simplePath()`). Fold them onto the host like `by()`: add a `foldFromTo` pass in
`strategies.ts` writing `PStep.from?: string` / `PStep.to?: string` onto the preceding
`path`/`simplePath`/`cyclicPath` host (mirror the `BY_HOSTS` fold). NB `to` already names an
edge-movement step (`addE().to()`, `EDGE_TRAVERSAL_STEPS`) — the fold only fires when the
host is a path step, so no collision.

**`lowerPath` / `compilePathArray`.** Given `from`/`to`, resolve each to its `pathPos` via the
alias map, then **slice `positions` to `[posFrom … posTo]`** before building the row. The
result stays a `PathStream` (framed `p[…]`). Out-of-range / unbound label → clear deferral
(or empty, matching spec) — fail closed.

**`simplePath()`/`cyclicPath()` from/to.** `pathDistinctTest` (filter.ts:84) already reads the
per-position columns; scope its pair loop to `[posFrom … posTo]` (delete the "from()/to()
scoping is deferred" note at filter.ts:82).

**Files:** context.ts (AliasEntry.pathPos, set in `as` StepFn filter.ts:51), strategies.ts
(foldFromTo + PStep.from/to), select.ts (lowerPath/compilePathArray slice), filter.ts
(pathDistinctTest scope).

### Piece B — `path().by(__.trav)` per-position child

**Model.** `pathBy` (select.ts:670) throws on a nested by(). A path row joins each position's
element table (`x{i}n`); a `by(__.values("name").toUpper())` is a **scalar child correlated on
`x{i}n.id`**. Reuse the child seam: for a value position, push a child scope off the position
element (an `ElementStream` seeded from `x{i}n.id`) and lower the body to a scalar via
`tryCompileScalarValueChild` / a correlated-scalar rendering, emitting `x{i}_v`.

The cleanest route that avoids a new renderer: build a tiny per-position `ElementStream` seed
(like `reRootElement`, but keyed on the position's join alias) and run
`classifyScalarChild`+`tryCompileScalarValueChild` (`first` cardinality) — the same call
`lowerSingleSelect` (select.ts:211-212) already makes for `select(label).by(__.trav)`. The
child returns a `ScalarStream` whose `v` becomes the position value column.

**by(T.token).** `by(T.label)`/`by(T.id)` project the element's label/id — a direct column, no
child. Handle alongside (cheap).

**Files:** select.ts (pathBy → child dispatch; lowerPath position build).

### Piece C — path() preserves alias history → `select(label)` / `select(Column.keys)` after path()

**Model.** `lowerPath` currently does `toPathStream(withoutCarried(carryOf(st)), …)`, wiping
aliases. A **linear** path is row-preserving (one row per path), so — per the labels-doc
barrier audit — the alias history MUST thread through. Keep aliases (drop only the path/origin
carried state that the path barrier legitimately consumes). Then `compileFromPath` gains:
- `select(label)` → the existing alias resolver (`selectOneFromAlias`) over the carried history.
- `select(Column.keys)` → the set of bound labels as a list (static keys).

This is the smaller half of the Orderability cluster; the `order()`-of-paths half stays
deferred (path natural-order comparability).

**Files:** select.ts (lowerPath carry threading; compileFromPath select branch).

## Sequencing & risk

1. **A first** — compile-time static, self-contained, unlocks the from/to cluster (Path +
   SimplePath + the by-name framing). Lowest regression risk (no runtime column, no barrier
   change).
2. **B** — per-position child; reuses the proven `tryCompileScalarValueChild` seam.
3. **C** — the one barrier change (alias threading through linear path); guarded by the
   existing alias-history tests + the ratchet.

Each lands as its own commit on green local `mise run ci`; corpus stays 2298/2298; L3 ratchet
auto-folds. Deferred throughout (documented, fail closed): path natural-order, multi-bind
from/to, recursive-regime from/to, map-valued alias entry (that's the separate design-doc-#3
shape project).

## Non-negotiables (from CLAUDE.md)

Compile to SQL, never interpret. Fail closed — an unresolvable label/position defers, never
mis-scopes. `carriedCols` order (path last) load-bearing. SQL snapshots assert semantic
equivalence, not byte-identity.
