// ---------- synthesizing a sub-traversal's STEPS back to a rooted Gremlin string ----------
//
// A federated call() carries its sub-traversal as PARSED `IRStep[]` (call-params.ts `TraversalParam`).
// The ONE place that becomes a string again is federate's RPC edge: it runs the sub-traversal on a
// SIBLING graph (a different DO) via the string-based data-plane seam (query(id, gremlin, params)), so
// the steps must become a rooted Gremlin STRING to cross the wire. This is the ONLY string conversion
// (the memory `federate-subtraversal-as-steps`); every other consumer reads the steps directly.
//
// We do NOT hand-roll an un-parser and no longer need the client's Translator: each `IRStep` KEEPS its
// `ctx` (the antlr parse node it was lowered from), so `ctx.getText()` gives back re-parseable Gremlin
// verbatim (`V()`, `hasLabel("person")`, `has("age",gt(x))` — a bound `$x` stays a param the sibling
// resolves). Re-rooting is `'g.' + <steps joined by '.'>`. This is the SAME synthesis the arg-less
// pushdown already used for its inferred sibling query, so the explicit and inferred forms now produce
// the string one identical way. Verbatim source text (not the Translator's canonical form) — both
// re-parse on the sibling, and verbatim keeps the two federate forms consistent.

import type { IRStep } from '../../compiler/ir/strategies.ts';

/** Synthesize a rooted `g.…` Gremlin string from a sub-traversal's steps — the RPC-edge serialization.
 *  Each step reconstructs its own source text through its `ctx`; `'g.'` re-roots the chain (the first
 *  step is the sub-traversal's own `V()`/`E()` source). The caller (federate) validates that the result
 *  is source-rooted for its needs; an anonymous body is never handed here (OLAP reads its edge-scope
 *  steps directly, never as a string). */
export function subTraversalToGremlin(steps: readonly IRStep[]): string {
  return 'g.' + steps.map((s) => s.ctx.getText()).join('.');
}
