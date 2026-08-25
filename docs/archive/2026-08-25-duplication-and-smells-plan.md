# Duplication & architectural-smell consolidation — plan

> **Status: ✅ COMPLETE — every item landed (2026-08-25).** A whole-`src/` sweep for large-scale
> duplication and architectural smells; every item was a behaviour-preserving consolidation with a
> working precedent already in-repo. All of Themes A/B/C/D are on trunk. This doc is kept for the
> RECORD of what was consolidated and — more durably — the "Checked and deliberately NOT flagged" list,
> which is the map of parallels a future sweep must not "fix". A new sweep starts by re-auditing, not by
> reopening these.

## The one finding behind the whole sweep

The real debt is one recurring shape:

> **A shared helper was extracted for its first caller, and the siblings — often in the same file or
> directory — still hand-roll the same thing.** The fix usually already exists as a precedent a few
> lines away, which is exactly why these are low-risk.

So the work is mostly *finishing* factorings the code already began. Verify each remaining item is still
open before starting it — the precedent helper it names may already have been generalized.

## Already landed (do not re-plan)

The original audit's higher-value items shipped as their own commits and are on trunk. Confirm with
`git log --oneline --grep=refactor` if in doubt; representative landings:

- **Theme A file split** — `lower.ts` decomposed into `lower/branch.ts`, `lower/reduction.ts`,
  `lower/filter.ts`, `lower/slice.ts`, `lower/movement.ts`, `lower/chain.ts` (was A3), and the two
  collection-vocabulary tails now share their arms (was A1's core).
- **Theme B** — `decorateBarrier` factory in `olap/kernel.ts` (B1), the two registries composed from a
  shared base list (B4), the `UND` undirected-adjacency CTE exported from `kernel.ts` (B5).
- **Theme C** — construction-time structural laws single-sourced so the factory is the sole authority
  (C1), the shared value-transform barrier shell `buildValueTransformSegment` (C2), the drain
  owner-scoped reads pushed into `drain.ts` (C3), `propertyRowFor` for the three property-table reads
  (C4), `relationHandleSegment`/`idHead` for the path/pair segment shells (C5), `correlatedColumn` for
  the four edge/vertex correlated reads (C7).
- **Theme C (continued)** — `mapNestedArgs` for the identity-preserving nested-arg recursion (C8 — the
  two plain recursions `canonicalizeConnectives`/`markUnrollSuppressed`; the scope walk stays separate by
  design, it transforms the body and signals unchanged via null), `gatherRepeatRegion` for the
  repeat-cluster gathering loop shared by `unrollFixedRepeat`/`formRepeatRegions` (C9).
- **Theme D (complete)** — `sameColumns`/`sameNames` hoisted to `rel/types.ts`, the column-preservation
  classification single-sourced, `sizedContainer` for the GraphBinary containers (every MAP/LIST/SET
  prefix goes through it — D3), the composite `Expr` builders in `expr.ts`, one `json_extract` builder
  (`jsonField`) in `build.ts`, `freeze` hoisted to `rel/util.ts` (D1), `parseAnonBodyIR` in `olap/kernel.ts`
  shared by `edgeScopeOf`/`targetBody` (D2).

## Remaining findings

**None — the menu is fully worked through.** Theme A landed last:

- **A2** — `explodeMembers(rel, column, as, fresh)` in `build.ts`: the byte-identical json_each explode +
  channel-carry + ordinal-passthrough of the six unfold sites, returning the explode plus a project
  closure that lands the caller's payload. (The `as` descriptor carries the optional member-type column,
  so `list.ts`'s `MEMBER` and `map.ts`'s `PAIR` both fit.)
- **A4** — `projectScalar(input, exprs, cols, framing)`: the per-row scalar retype (`constant`, `label`/
  `id`, the `labels` edge arm, the `call()`-value consumer), built on `withPayload` so the channel carry
  has one authority. Fewer sites than the original ×9 — the `lower/` split had already absorbed several
  into `withPayload`/`constantRetype`/`sackRead`.
- **A5** — `valueResume`: the shared prologue/epilogue of `lowerValueResume`/`lowerListResume` (mint,
  settle, chain facts, decline a channel-demanding tail, one json_each bind, `lowered()`), each producer
  passing its own seed builder + re-entry tail.
- **A3** (the file split into `lower/{branch,reduction,filter,slice,movement,chain}.ts`) landed earlier —
  see "Already landed".

### Theme C — "extracted for one caller" leftovers

All landed (C4/C5/C7/C8/C9 — see "Already landed"). One judgement call recorded for the next sweep: the
scope walk's per-step arg loop in `strategies.ts` (originally C8's third site) was deliberately NOT
folded into `mapNestedArgs` — it transforms the body before recursing (the where-variable rewrite) and
signals "unchanged" with a null return rather than reference identity, so sharing that contract would
obscure its scope tracking. Do not re-flag it.

### Theme D — small shared utils

All landed (see "Already landed"). `uniqueNames` from the original audit does not exist (the two
duplicate-name guards `named`/`names` differ by message wording and stay separate); the MAP prefix was
already fully routed through `sizedContainer`.

## Checked and deliberately NOT flagged

The two `GraphSource` implementations (documented strategy pattern, `source.ts:13`); the
`Record<RelKind,…>` totality tables (walk/emit/check/block/obligations — each answers a distinct
question, totality is the design, `walk.ts:8`); `check.bindCount` (IR count) vs `emit.renderStep`
(rendered count) — two intentional authorities (`check.ts:73`); the `ir/step.ts` overlapping step-name
`Set`s (each encodes a load-bearing difference, merging forbidden by the file's own doctrine); GraphQL
/`gql` emitting Gremlin strings into the one front-end; the Bun↔Cloudflare manager/store/io seams;
`drive.ts`'s async/sync trampoline twins (function-coloring, hard to DRY without obscuring the hot
path); the `passes.ts` Pass registry (a registry with a `group()` constructor, not per-Pass
boilerplate; named functions required by the `arch-check` call-hierarchy gate). Re-auditing these is
wasted effort.

## How it was landed (for the record)

Risk-ascending, each an independently shippable behaviour-preserving commit validated by `mise run ci`
+ the L1–L5 ladder, with the **census** (`ran` unchanged, no answer changed) as the load-bearing gate
for the hot-path Theme A extractions. Order: C1 → Theme B (the `decorateBarrier` factory + registries) →
Theme C leftovers (C2/C3/C4/C5/C7/C8/C9) → Theme D (the small utils) → Theme A last (A3 file split, then
A2/A4/A5 in the fold).

The one durable lesson: this was never a rename campaign — each item was a real extraction with a test
surface, and the risk throughout was turning a documented-deliberate twin into a wrong "fix". The
"Checked and deliberately NOT flagged" list above is the record of which parallels are intentional; a
future sweep re-reads it before touching anything that looks duplicated.
