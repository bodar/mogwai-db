// ---------- the element-identifier rules every write must satisfy ----------
//
// TinkerPop enforces these in `ElementHelper.validateProperty`/`validateLabel` and
// `Graph.Hidden` (gremlin-core), and every write step reaches them: `TinkerGraph.property()`,
// `addV`, `addE`, and — explicitly, per map — `MergeElementStep.validate`. We enforced NONE of
// them, so `g.addV('~vertex')`, `g.V(1).property('~id','y')` and `g.mergeV(['~label':'vertex'])`
// all wrote happily. `~` is not decoration: it is TinkerPop's HIDDEN namespace, the one a graph
// uses for its own bookkeeping, and a graph that lets a user write there has no way left to tell
// its own keys from theirs.
//
// The messages are TinkerPop's verbatim because the corpus asserts on their text
// (`MergeVertex.feature`, `MergeEdge.feature` — "containing text of").
//
// This module holds ONLY the rules that are about the identifier itself. Whether a given map may
// carry a T token at all, and whether an `option(onCreate)` may restate a key, are questions about
// the STEP, and live with the merge lowering that asks them.

/** TinkerPop's hidden namespace (`Graph.Hidden`): a key a graph reserves for its own bookkeeping.
 *  User writes to it are rejected everywhere — a property key, a label, in a map or as an argument. */
export const isHiddenKey = (key: string): boolean => key.startsWith('~');

/** `ElementHelper.validateProperty`'s key half. Returns the key so a caller can validate inline. */
export function validatePropertyKey(key: unknown): string {
  if (key === null || key === undefined) throw new Error('Property key can not be null');
  const k = String(key);
  if (k === '') throw new Error('Property key can not be the empty string');
  if (isHiddenKey(k)) throw new Error(`Property key can not be a hidden key: ${k}`);
  return k;
}

/** `ElementHelper.validateLabel`. Returns the label so a caller can validate inline. */
export function validateLabel(label: unknown): string {
  if (label === null || label === undefined) throw new Error('Label can not be null');
  const l = String(label);
  if (l === '') throw new Error('Label can not be empty');
  if (isHiddenKey(l)) throw new Error(`Label can not be a hidden key: ${l}`);
  return l;
}
