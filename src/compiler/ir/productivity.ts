import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';

// ---------- productivity: does a child body ALWAYS yield a traverser? ----------
//
// One authority, two consumers that were each about to answer this independently:
//   • `choose()`'s option-map classifier (`choiceCanBeUnproductive`) —
//     is an unclaimed `Pick.unproductive` arm reachable?
//   • the `isAlwaysProductiveFilterNoOp` Pass (ir/strategies.ts) — is this filter provably a no-op?
// It lives here in `ir/` as the single authority both consumers share; duplicating the reasoning
// below into two sets is exactly how they would drift.
//
// This module is pure step-name reasoning over a Step[] — no streams, no SQL, no Engine.

/**
 * ⚠️ THERE ARE TWO KINDS OF "ALWAYS PRODUCTIVE" TERMINAL AND THEY DIFFER IN WHAT PRECEDES THEM.
 * Conflating them is a silent wrong answer, measured — see `alwaysProduces`.
 *
 * A SEEDED terminal emits however EMPTY its input, because it is a reducing barrier carrying a seed:
 * `count()` is 0 and `fold()` is `[]` over an empty stream. That makes it INPUT-INDEPENDENT, so nothing
 * before it can take its productivity away.
 *
 * `sum`/`min`/`max`/`mean` are deliberately NOT here: TinkerPop emits NOTHING for them on empty input
 * (`SumGlobalStep` overrides `processAllStarts` rather than supplying a seed), so they can be
 * unproductive even as barriers.
 */
const SEEDED_TERMINAL: ReadonlySet<string> = new Set(['count', 'fold']);

/**
 * A MAPPING terminal emits exactly one traverser PER INCOMING traverser, so it is productive iff
 * something REACHES it. Each is a `ScalarMapStep`, whose `processNextStart` is
 * `return traverser.split(this.map(traverser), this)` — unconditional
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ScalarMapStep.java:38-40`)
 * — and each one's `map()` returns its value however empty: a `project()` all of whose `by()`s were
 * unproductive still emits `{}` (`ProjectStep.java:63-70`, the `ifProductive` per-KEY omission), and a
 * `valueMap()` on a property-free element still emits `{}` (`PropertyMapStep.java:80-87`,
 * `ElementMapStep.java:62`). `constant()` ignores its input's VALUE, but it still needs an input.
 *
 * That "still needs an input" is the whole difference from a seeded terminal, and it is why
 * `alwaysProduces` admits these only as a WHOLE body.
 *
 * **`select` is the counter-example and must never join either set**, which is what makes this a real
 * distinction rather than "map-shaped steps": `SelectStep.processNextStart` `break`s out of its key loop
 * and returns `EmptyTraverser.instance()` when a `by()` is unproductive or a key is missing
 * (`SelectStep.java:65-90`), dropping the traverser even with an input. Same substrate, opposite host
 * rule — the asymmetry `record.ts`'s header records.
 */
export const MAPPING_TERMINAL: ReadonlySet<string> = new Set(['constant', 'project', 'valueMap', 'elementMap']);

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
 * Productivity is `alwaysProduces`' question, and its two-kinds rule matters HERE too: reading the last
 * step alone would make `where(__.hasLabel('person').constant(1))` a provable no-op and delete a filter
 * that really filters.
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
 * The terminal decides, which is why `count()` qualifies and `count().is(P.gt(0))` does not — but the
 * terminal alone is NOT enough, and assuming it was produced a measured wrong answer:
 *
 *   g.V().coalesce(__.hasLabel('person').project('a').by(__.values('name')),
 *                  __.hasLabel('software').project('a').by(__.values('lang')))
 *
 * A `project()` is a MAPPING terminal, so reading the last step alone claimed arm 1 always fires, which
 * exhausted the `coalesce` and made arm 2 unreachable — the two software vertices returned NOTHING where
 * the reference returns their `lang`. A `hasLabel()` in front of a mapping terminal takes its input away,
 * and its productivity with it. (The same shape was already wrong for `constant`, which sat in the
 * combined set before the mapping terminals joined it.)
 *
 * So a SEEDED terminal qualifies whatever precedes it, and a MAPPING terminal qualifies only as the WHOLE
 * body — deliberately conservative, because the precise rule is "nothing before it filters or moves" and
 * the authority for that (`isStreamIdentity`, `ir/strategies.ts`) sits in a module that imports THIS one,
 * so consulting it here would be a cycle. `coalesceArms` already ORs the whole-body identity test
 * alongside this call, which is where a side-effect-prefixed body is recognised; anything else falls
 * through to `childPredicate` or declines. Fail closed, and never a claim that a filtered body cannot
 * filter.
 */
export function alwaysProduces(body: readonly { readonly name: string }[]): boolean {
  const last = body.at(-1);
  if (!last) return false;
  if (SEEDED_TERMINAL.has(last.name)) return true;
  return MAPPING_TERMINAL.has(last.name) && body.length === 1;
}
