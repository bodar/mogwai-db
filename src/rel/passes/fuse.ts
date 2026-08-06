import type { Rel } from '../rel.ts';

/**
 * `fuse` — the reserved home for SEMANTIC algebraic rewrites on the RelIR tree, and a NO-OP TODAY BY
 * DESIGN. Not unfinished: adjacent-node collapses that genuinely simplify the ALGEBRA belong here, and
 * until one earns its place there is nothing to do. It stays wired as identity so the pipeline has the
 * slot (build-plan §4.4) and a reader of this FILE — not the plan — sees the emptiness is intentional.
 *
 * BELONGS HERE (unbuilt; add a case only once it buys something the block assembler cannot):
 *   - `Distinct(Distinct x)` collapses to `Distinct x`.
 *   - `Limit` over `Limit` composes to one window.
 *   - a `Sort` rendered dead by a downstream barrier is dropped.
 * All are same-semantics collapses across ADJACENT nodes — the province of a `Rel → Rel` pass.
 *
 * DOES NOT BELONG HERE — each already has a home, so adding it here would be a SECOND implementation:
 *   - Adjacent `Filter`s conjoining into one `WHERE`: the EMITTER already does this
 *     (`src/rel/emit.ts`, `conjoin(b.where, pred)`), so `fuse` must not. This WAS `fuse`'s one
 *     historical rewrite; it was removed as redundant when the pass became the reserved slot.
 *   - `Sort` + `Limit`: that is one SELECT's slots, filled by the block assembler (build-plan §5).
 *   - Collapsing a run of nodes into a `Select` mega-node: REFUSED — it would put the SQL surface
 *     inside the IR and hand every pass two forms of one thing (build-plan §5, §7). The assembler's
 *     slot-filling, not `fuse`, is what deletes `TailAcc`.
 *
 * Design + run-order: `docs/2026-08-01-relir-build-plan.md` §4.
 */
export function fuse(plan: Rel): Rel {
  return plan;
}
