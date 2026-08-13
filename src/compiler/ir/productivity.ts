import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';

// ---------- productivity: does a child body ALWAYS yield a traverser? ----------
//
// One authority, two consumers that were each about to answer this independently:
//   • `choose()`'s option-map classifier (steps/tail/child-shape.ts `choiceCanBeUnproductive`) —
//     is an unclaimed `Pick.unproductive` arm reachable?
//   • the `isAlwaysProductiveFilterNoOp` Pass (ir/strategies.ts) — is this filter provably a no-op?
// The set began as a private const in child-shape.ts; it moved here because `ir/` cannot import from
// `steps/` (the layering runs deps ◂ families ◂ engine ◂ compiler, and Passes run before dispatch),
// and because duplicating the reasoning below into two sets is exactly how they would drift.
//
// This module is pure step-name reasoning over a Step[] — no streams, no SQL, no Engine.

/** Terminals that yield a traverser however empty their input, so a body ending in one is ALWAYS
 *  productive.
 *
 *  Being precise here is load-bearing in BOTH directions (the original comment on this set, kept
 *  because it is still exactly the tradeoff): too coarse and a `choose(T.label)` gains an arm it can
 *  never emit; too loose and an unproductive input is silently answered with the wrong body.
 *
 *  `count()` is 0 and `fold()` is `[]` over an empty stream, and `constant()` ignores its input
 *  entirely — all three always emit. `sum`/`min`/`max`/`mean` are deliberately NOT here: TinkerPop
 *  emits NOTHING for them on empty input, so they can be unproductive. */
export const ALWAYS_PRODUCTIVE_TERMINAL: ReadonlySet<string> = new Set(['count', 'fold', 'constant']);

/**
 * Steps that touch state beyond their own traverser stream, keyed by the arity that makes them do so.
 *
 * `true` = always side-effecting. A predicate is the KEYED form only: bare `group()`/`groupCount()`
 * are reducers, while `group('x')` writes a named side effect; bare `sack()` reads the accumulator,
 * `sack(op)` mutates it. Getting that distinction right is what lets the no-op Pass fire on
 * `where(__.group().by('name').count())` — a pure reducer body — while declining
 * `where(__.aggregate('x').count())`, where removing the step would skip the aggregate.
 */
const SIDE_EFFECTING: Record<string, true | ((s: Step) => boolean)> = {
  aggregate: true, store: true, subgraph: true,
  property: true, addV: true, addE: true, mergeV: true, mergeE: true, drop: true,
  group: (s) => s.args.length > 0,
  groupCount: (s) => s.args.length > 0,
  sack: (s) => s.args.length > 0,
};

const isSideEffecting = (s: Step): boolean => {
  const rule = SIDE_EFFECTING[s.name];
  return rule === true || (typeof rule === 'function' && rule(s));
};

/** Does this chain (or anything nested inside it) write a side effect, or bind an `as()` label?
 *  Both make a filter step unsafe to REMOVE even when its body always produces a traverser: the
 *  side effect would be skipped, and — although a filter consumer confines its body's binds today
 *  (see the child-seam guardrail in steps/CLAUDE.md) — declining on `as()` keeps this Pass from
 *  depending on that asymmetry holding. Fail closed: an unrecognisable arg counts as impure. */
function isImpure(steps: readonly Step[], params: Record<string, any>): boolean {
  return steps.some((s) => {
    if (isSideEffecting(s) || s.name === 'as') return true;
    return s.args.some((a) => isNested(a.value) && isImpure(stepChain(a.value.nested, params), params));
  });
}

/**
 * Is this body a filter that can never reject anything — always productive AND free of side effects
 * or label binds, so the enclosing filter step is provably a no-op?
 *
 * Productivity is decided by the body's LAST step alone, which is why `count()` qualifies but
 * `count().is(P.gt(0))` does not: the terminal there is `is()`, which filters.
 */
export function bodyAlwaysProduces(nested: any, params: Record<string, any>): boolean {
  if (!isNested(nested)) return false;
  const body = stepChain(nested.nested, params);
  return alwaysProduces(body) && !isImpure(body, params);
}

/**
 * PRODUCTIVITY ALONE, over an already-normalized body — the half of `bodyAlwaysProduces` that is not
 * about purity.
 *
 * The two are separate because their consumers need different things. Removing a filter step needs BOTH
 * (a skipped side effect is a wrong answer even when the filter cannot reject), while asking "can a
 * later `coalesce` arm ever fire" needs only the first: an arm that always produces exhausts the
 * coalesce whether or not it also writes something. Conflating them would have made the purity gate
 * silently narrow a branch lowering.
 *
 * Decided by the LAST step alone, which is why `count()` qualifies and `count().is(P.gt(0))` does not.
 */
export function alwaysProduces(body: readonly { readonly name: string }[]): boolean {
  const last = body.at(-1);
  return !!last && ALWAYS_PRODUCTIVE_TERMINAL.has(last.name);
}
