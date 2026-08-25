# Duplication & architectural-smell consolidation — plan

> **Status: PARTIALLY LANDED — remaining menu (audited 2026-08-25, compacted 2026-08-25).** A
> whole-`src/` sweep for large-scale duplication and architectural smells. Nothing here is a bug; every
> item is a behaviour-preserving consolidation, and almost all have a working precedent already in-repo.
> This is a menu, sequenced by risk, not a commitment — pick items when a file is open for other reasons.
> **The bulk of the original sweep has since landed** (see "Already landed" below); what follows is only
> the residue.

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

### Theme A — `lower.ts` / step-family files

- **A2 [HIGH] — "explode a collection column into a member stream" block ×6.** Identical
  explode+project+channel-carry+ordinal-passthrough shape at `list.ts:805`, `831`, `853`, `1462`,
  `1485` and `map.ts:1247`; the three-column member `typeOf(...)` triple recurs ~8× in `list.ts`. Only
  the payload column and its expression differ.
  → `explodeMembers(rel, column, as, payload, fresh)` in `build.ts`. Single largest concrete win in the
  step-family files. (`build.ts`'s `withPayload` covers only the "replace payload, keep channels" case;
  the unfold family needs *extra* passthrough columns, so widen the carry helper.) *(line numbers
  predate the `lower/` split — re-locate before extracting.)*

- **A4 [MED] — "project one value column, carry channels through" idiom ×9** (originally `lower.ts:2132`,
  `2163`, `2241`, `2772`, `2804`, + detached variants); `constantRetype` and `sackRead` already
  encapsulate the move. → `projectScalar(input, expr, {tag, valueType, framing})`; removes the "forgot
  the `carriedCols` carry" bug class the arm comments document. *(the arms now live across `lower/`; grep
  the idiom rather than trusting the old lines.)*

- **A5 [MED] — 6 resume entry points share prologue/epilogue** (`lowerToRel` + `lower*Resume`);
  `lowerValueResume`/`lowerListResume` are near-twins. → a `resume(seed, framing, …)` wrapper owning
  minter/settle/chainCtx/`lowered`.

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

## Suggested sequencing

Risk-ascending; each is independently shippable and behaviour-preserving. `mise run ci` + the L1–L5
ladder is the safety net; validate before every push (`bash scripts/ci.sh` for the truthful verdict).

1. **Theme A** (A2 `explodeMembers`, A4 `projectScalar`, A5 resume wrapper) — the only work left, and
   the largest payoff. Hot path; touch carefully and lean on the conformance ladder.

(Themes B, C, D are done — only Theme A remains.)

Do not treat this as a rename campaign — each item is a real extraction with a test surface. The value is
finishing factorings the code already started; the risk is turning a documented-deliberate twin into a
wrong "fix", so re-read the "NOT flagged" list before touching anything that looks parallel.
