import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';
import type { IRStep } from './step.ts';

// ---------- THE IR walker: every child position of a step, at any depth ----------
//
// A step's children live in more places than its `args`: a predicate's operands, a list/set/map
// argument (keys AND values), a `by()` modulator the canonicalize passes folded onto the host, a
// `with()` option, and the two folded CLUSTERS (`repeatRegion`, `optionArms`) that are chains of their
// own rather than nested traversals. Before this module each whole-tree question re-implemented that
// enumeration — `someStepDeep` (args only), `nondeterministic`, `labels.ts`' `descend`/`carriesBarrier`/
// `eachChainDeep`, `write.ts`' `bodyReach`/`programWrites` — and each one missed a different position
// (`someStepDeep` saw no modulator, so a write inside `order().by(addV(...))` was invisible to the
// ranked-order head and leaked an internal error). A whole-tree question is now a predicate handed to
// this walker; the positions are enumerated ONCE, here.
//
// The reference walks the same tree the same way: `TraversalHelper.getStepsOfAssignableClassRecursively`
// descends `TraversalParent.getGlobalChildren()` AND `getLocalChildren()`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalHelper.java`)
// — a `by()` traversal is a LOCAL child, a branch/repeat body a GLOBAL one, and a whole-tree question
// that consults only one of the two lists is the defect this module removes.

/** Read a nested traversal's payload as a chain, or `null` when it cannot be read (e.g. it needs a
 *  parameter the caller does not have). Each caller supplies its own — a lowering normalizes a body
 *  through its child seam, a Pass reads it raw (`rawBodies`). */
export type BodyReader = (nested: unknown) => readonly Step[] | null;

/** The raw reader: `stepChain`, with an unparseable body reported as `null`. */
export const rawBodies = (params: Record<string, any>): BodyReader => (nested) => {
  try { return stepChain(nested, params); } catch { return null; }
};

/** Every node of an argument VALUE, preorder: the value itself, then — through an `Arg`'s `value`, a
 *  predicate's `operands`, a list, a set, and a map's keys AND values — everything inside it. A nested
 *  traversal is yielded as a node but never entered: its body is a CHAIN, walked as one. */
export function* valueNodes(value: unknown): Generator<unknown> {
  yield value;
  if (value == null || typeof value !== 'object' || isNested(value)) return;
  if (value instanceof Map) { for (const [k, v] of value) { yield* valueNodes(k); yield* valueNodes(v); } return; }
  if (value instanceof Set || Array.isArray(value)) { for (const v of value) yield* valueNodes(v); return; }
  if ('value' in value) yield* valueNodes((value as { value: unknown }).value);
  if ('operands' in value) yield* valueNodes((value as { operands: unknown }).operands);
}

/**
 * WHICH child positions a walk enters — the caller's choice, never the walker's. `'all'` (the default,
 * and the only right answer for a whole-tree question: does anything anywhere write, draw, barrier,
 * read a label) is every position below. `'arguments'` is a step's own ARGUMENT values only — no folded
 * `by()`/`with()`, no folded repeat/choose cluster — for a caller whose CONSUMER can act only on what a
 * step's own source text carries: federate's injection rewrite edits the sibling query's TEXT, and a
 * pushed step's text is its own `ctx` (`segment.ts` `inferredPushdown`), which a folded modulator is not
 * part of. Consulting a position that consumer cannot reach is how `order().by(select('e'))` after a
 * federate barrier became an injection the rewrite then could not perform.
 */
export type ChildPositions = 'all' | 'arguments';

/** Every argument-shaped VALUE a step holds: its arguments, then (`positions: 'all'`) its folded `by()`
 *  modulators and its folded `with()` options. (`from`/`to` are label strings, never values that hold a
 *  child.) */
export function stepValues(s: Step, positions: ChildPositions = 'all'): unknown[] {
  const ir = s as IRStep;
  const args = (s.args ?? []).map((a) => a.value);
  if (positions === 'arguments') return args;
  return [
    ...args,
    ...(ir.modulators ?? []).flat(),
    ...(ir.withArgs ?? []).map(([, v]) => v),
  ];
}

/** Does any node of any of this step's values (`stepValues`, `valueNodes`) satisfy `pred`? The
 *  value-side half of a whole-tree question — a `T.label` token, an `Order.shuffle`, a string. */
export const someValueNode = (s: Step, pred: (node: unknown) => boolean): boolean =>
  stepValues(s).some((v) => { for (const n of valueNodes(v)) if (pred(n)) return true; return false; });

/** Every CHILD CHAIN of one step — each nested traversal in any value position, read through `read`,
 *  then the folded `repeat()`/`choose()` clusters. A body `read` cannot read is reported to
 *  `unreadable` instead; what that MEANS (skip, or fail closed) is the caller's question, never this
 *  walker's. */
export function eachChildChain(
  s: Step, read: BodyReader, visit: (chain: readonly Step[]) => void, unreadable: () => void = () => {},
  positions: ChildPositions = 'all',
): void {
  for (const v of stepValues(s, positions)) for (const n of valueNodes(v)) {
    if (!isNested(n)) continue;
    const body = read(n.nested);
    if (body === null) unreadable(); else visit(body);
  }
  if (positions === 'arguments') return;
  const ir = s as IRStep;
  if (ir.repeatRegion) visit(ir.repeatRegion);
  if (ir.optionArms) visit(ir.optionArms);
}

/** Visit every CHAIN at ANY depth — `chain` itself first, then each child chain (through `positions`),
 *  recursively. */
export function eachChainDeep(
  chain: readonly Step[], read: BodyReader, visit: (chain: readonly Step[]) => void, unreadable: () => void = () => {},
  positions: ChildPositions = 'all',
): void {
  visit(chain);
  for (const s of chain) eachChildChain(s, read, (c) => eachChainDeep(c, read, visit, unreadable, positions), unreadable, positions);
}

/** Visit every STEP at ANY depth — `eachChainDeep`, a step at a time. */
export function eachStepDeep(
  chain: readonly Step[], read: BodyReader, visit: (s: Step) => void, unreadable: () => void = () => {},
): void {
  eachChainDeep(chain, read, (c) => { for (const s of c) visit(s); }, unreadable);
}

/**
 * Does any step at ANY depth — every child position (`eachChildChain`) — satisfy `pred`? A body that
 * cannot be read answers `unreadable`: `true` for a question whose `true` is the REFUSAL (a write, a
 * random draw, a barrier — fail closed), `false` for one that merely skips what it cannot see.
 */
export function someStepDeep(
  steps: readonly Step[], params: Record<string, any> | BodyReader, pred: (s: Step) => boolean, unreadable = false,
): boolean {
  const read: BodyReader = typeof params === 'function' ? params as BodyReader : rawBodies(params);
  const any = (chain: readonly Step[]): boolean => chain.some((s) => {
    if (pred(s)) return true;
    let hit = false;
    eachChildChain(s, read, (c) => { if (!hit && any(c)) hit = true; }, () => { if (unreadable) hit = true; });
    return hit;
  });
  return any(steps);
}
