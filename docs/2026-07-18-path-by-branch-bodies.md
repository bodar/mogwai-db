# path().by(__.trav): branch-body positions (union/choose/coalesce)

**Date:** 2026-07-18
**Status:** design / continuation — a follow-on to the path `by(traversal)` rework.
**Baseline:** L3 1226. `path().by(__.trav)` already lowers value/transform/reducer/count
children through the generic scalar child seam (`tryCompileScalarValueChild`), re-rooted per
position (`src/steps/select.ts lowerPath`).

## What's left

A `by(__.trav)` path position whose body is a **branch** — `union(...)`, `choose(...)`,
`coalesce(...)` yielding a scalar — fails closed:

```
g.V().out().path().by(__.union(__.values("name"), __.constant("x")))
g.V().out().path().by(__.coalesce(__.values("lang"), __.constant("none")))
g.V().out().path().by(__.choose(__.hasLabel("person"), __.constant("P"), __.constant("S")))
→ "path().by(traversal) position must be a scalar child (…); other shapes not yet supported"
```

Reason: the position child routes through `classifyScalarChild` + `tryCompileScalarValueChild`,
which classify *value/transform/reducer* bodies. Branch steps are a **different seam** — the
scalar-arm machinery (`tryScalarUnionChild`/`tryScalarChooseChild`/`tryScalarCoalesceChild` in
`child.ts`, and the element-parent `tryLowerScalarUnion`/`…Choose`/`…Coalesce` in
`projection.ts`). Those produce a `ScalarStream` but are not wired into the per-position path
builder.

## The move

In `lowerPath`'s by(traversal) branch (`select.ts`), when `classifyScalarChild` declines, try
the scalar-arm compilers against the re-rooted position seed (inside the same pushed child
scope, `reuseCurrentFrame(outer.scope, outer.frame)`), take the arm's `first` result as the
position's scalar `v`, and join by ordinal exactly as the value-child branch does.

Key questions to resolve during implementation:
1. **Ordinal keying.** The scalar-arm compilers (`tryScalarUnionChild` etc.) take a
   `ScalarStream` parent and lower arms; do they thread the child `ordinal` so the result
   rejoins per position? The record/select branch-arm path already composes arms under a child
   scope — check whether `compileScalarChildRows` → arm path preserves `frame.ordinal`, or
   whether the arm compilers need the pushed scope passed through.
2. **first-result semantics.** A path position is ONE object. `union(a,b)` fans out (2 results)
   → must take the FIRST (arm-order). This is the SAME "take first, deterministic emission
   order" problem the `map()`-over-scalar-arm non-goal names (see CLAUDE.md 🚫). If union at a
   path position must pick a deterministic first, it needs an arm-index emission order — which
   may put it in the same locked-non-goal bucket. `choose`/`coalesce` are 1-to-1 (a single arm
   fires) so they're clean; `union` (fan-out) may be the deferred edge.
3. Depends on / composes cleanly with the child-scope path split
   (`docs/2026-07-18-child-scope-path-split.md`) — do that FIRST if the arm bodies contain
   movement under path tracking (same latent bug).

## Recommendation

Likely split this: **`choose`/`coalesce` (1-to-1) are tractable** and worth doing — a single
arm produces the scalar, no fan-out. **`union` (fan-out) probably lands in the same
take-first-needs-emission-order non-goal** as `map()`-over-scalar-arm; if so, defer it with a
clear fail-closed message and an L4 `@gap:path-branch` marker, not code. Confirm by tracing
question 1/2 before committing.

## Test strategy

L4 `@gap:path-position` additions (once working): `path().by(__.choose(…))`,
`path().by(__.coalesce(…))`. Full suite + L3 ≥1226 + corpus 2298 green. Fail-closed test for
whatever remains deferred (`union` fan-out if it stays a non-goal).
