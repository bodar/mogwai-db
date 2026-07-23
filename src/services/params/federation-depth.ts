// ---------- federation recursion guard (shared, runtime-agnostic) ----------
//
// A sibling graph runs the SAME engine, so a federated sub-traversal may itself contain a
// federate call() pointing at a third graph — genuine recursive pushdown. Unbounded recursion
// (A→B→A ping-pong, or a very deep chain) would multiply per-request CPU/memory across DOs, so
// we bound it by DEPTH.
//
// Depth is REQUEST-SCOPED STATE, threaded through the executor like `env`/`registry`: it starts
// at 0 at the top-level query and each federated hop passes `depth + 1` into the sibling's
// execution. The env is a stable per-runtime CAPABILITY (how to reach a sibling), NOT a
// depth-carrying object — the two are deliberately separate (an earlier draft baked depth into a
// per-hop env closure; that conflated the two and allocated an env per hop). The ceiling is a
// static policy constant checked at each hop, BEFORE the RPC — so an over-deep or cyclic chain
// fails closed immediately, never hangs. A depth cap still terminates an A→B→A cycle (after MAX
// hops); true graph-cycle detection would need a visited-set threaded per hop — more machinery
// than this phase's honest scope, and the depth bound already caps the blast radius.
//
// This is the same philosophy as repeat()'s "no artificial cap, rely on the platform limit" —
// except a cross-DO fan-out's blast radius spans tenants, so a cheap explicit depth ceiling is
// warranted here.

export const MAX_FEDERATION_DEPTH = 4;

/** Guard one federated hop about to run at `depth`. Throws a clear, fail-closed error once the
 *  ceiling is exceeded — call BEFORE issuing the sibling query. `id` names the target for the
 *  message. Shared by both runtimes so the bound + error are identical (parity is structural). */
export function guardFederationDepth(depth: number, id: string): void {
  if (depth > MAX_FEDERATION_DEPTH)
    throw new Error(`federation depth exceeded (${MAX_FEDERATION_DEPTH}) reaching graph "${id}" — a cyclic or too-deep federated traversal`);
}
