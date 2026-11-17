import type { ParamEnv } from '../../gremlin/param-env.ts';
import { isNested, stepChain, type Step } from '../../gremlin/frontend.ts';
import { isLocalScope, SCALAR_TRANSFORMS, stepHasEffect } from './step.ts';
import { someStepDeep } from './walk.ts';

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
 *
 * GLOBAL SCOPE ONLY. The seed belongs to the reducing BARRIER, and `count(Scope.local)` is not one: it is
 * `CountLocalStep`, a `ScalarMapStep` sizing each incoming traverser's collection
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CountLocalStep.java:37`),
 * so over an empty arm it emits nothing. Reading the NAME alone claimed `values('m').count(local)` always
 * fires, which exhausted a `coalesce` and dropped its fallback for every traverser the arm skipped.
 */
const SEEDED_TERMINAL: ReadonlySet<string> = new Set(['count', 'fold']);
const seededTerminal = (step: Step): boolean => SEEDED_TERMINAL.has(step.name) && !isLocalScope(step);

/**
 * The REVERSE question, "can this step yield a traverser when NO traverser reaches it", is a superset of
 * `SEEDED_TERMINAL`. It adds the other seeded reducing barriers, whose seed supplier is the empty `{}` or
 * tree (`GroupStep`, `GroupCountStep`, `TreeStep` under `.../traversal/step/map/`). It adds the supplying
 * barrier `cap` (`SideEffectCapStep` extends `SupplyingBarrierStep`, which emits the side effect however
 * empty its input). It adds a mid-chain `inject` (`InjectStep` extends `StartStep`) and `call`, whose
 * service may start a stream. These are not in `SEEDED_TERMINAL` because that set answers "always
 * produces", and keyed `group('x')` is a pass-through side effect, not a seed. HERE a name match only
 * makes the caller fail closed, so the name alone is enough.
 *
 * Only the TOP-LEVEL steps matter. A step that hosts a child body runs it per traverser it RECEIVES, so
 * a child sees nothing when nothing arrives: `BranchStep` checks `hasStarts()` before pulling an option,
 * because a `ReducingBarrierStep` "will always return true for hasNext()"
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java`).
 */
const PRODUCES_WITHOUT_INPUT: ReadonlySet<string> = new Set([...SEEDED_TERMINAL, 'group', 'groupCount', 'tree', 'cap', 'inject', 'call']);

/**
 * Can this body yield a traverser from an EMPTY input stream, i.e. is it NOT strict? A strict body
 * (`out()`, `values('x').is(…)`, `out().where(__.count())`) yields nothing from nothing. A body with a
 * seeded or supplying step at its top level (`out().count().is(0)`, `fold()`) can yield something from
 * nothing. The answer is fail-closed: a name match says "may produce", even for a `count(local)` that
 * cannot. That is why a predicate may split `where(F.rest)` into `F ∧ productive(rest)` only when this
 * returns false.
 */
export function producesWithoutInput(body: readonly { readonly name: string }[]): boolean {
  return body.some((s) => PRODUCES_WITHOUT_INPUT.has(s.name));
}

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
const MAPPING_TERMINAL: ReadonlySet<string> = new Set(['constant', 'project', 'valueMap', 'elementMap']);

/** A mapping terminal, by STEP: the named set plus `count(Scope.local)`. `CountLocalStep` is a
 *  `ScalarMapStep` too (one size per incoming traverser, never a drop), which its GLOBAL namesake, a
 *  seeded barrier, is not; scope is an argument, so a name-keyed set cannot say this alone. */
export const isMappingTerminal = (step: Step): boolean =>
  MAPPING_TERMINAL.has(step.name) || (step.name === 'count' && isLocalScope(step));

/** A slice/draw count that is a parsed LITERAL ≥ 1 (a user parameter may be 0, so it never counts). */
const literalAtLeastOne = (a: Step['args'][number] | undefined): boolean =>
  !!a && a.name == null && (typeof a.value === 'number' || typeof a.value === 'bigint') && a.value >= 1;

/**
 * Can this step EMPTY a stream that reaches it non-empty? `false` only where the reference says it cannot —
 * the question an existence check asks of everything after its last row-dropping step:
 *
 * - a MAPPING terminal (`isMappingTerminal`): one traverser out per traverser in (`ScalarMapStep.java:38-40`);
 * - `id()`/`label()` — `ScalarMapStep`s too (`.../step/map/IdStep.java`, `LabelStep.java`), and a bare
 *   `path()` (no `by()`/`from`/`to`), which splits every traverser it receives (`PathStep.processNextStart`;
 *   a `by()` there DROPS the path when unproductive, so it is excluded);
 * - a GLOBAL `limit(n)`/`range(0, n)`/`tail(n)`/`sample(n)` with a literal `n ≥ 1` (`range(0, -1)` is the
 *   whole stream) and no `by()`: each keeps at least one of a non-empty stream
 *   (`.../step/filter/RangeGlobalStep.java`, `TailGlobalStep.java`; `SampleGlobalStep.java:103-105` returns the
 *   whole set when it is no larger than the amount). A weighted `sample().by()` may draw nothing.
 *
 * `select`, `dedup().by` and `order().by` are NOT here and never may be: an unproductive `by()` or a missing
 * key drops the traverser there (`SelectStep.java:65-90`; §17's by() line).
 */
const neverEmpties = (s: Step): boolean => {
  const ir = s as Step & { modulators?: unknown[]; from?: string; to?: string };
  if (isMappingTerminal(s)) return true;
  if (ir.modulators?.length || isLocalScope(s)) return false;
  if (s.name === 'id' || s.name === 'label') return !s.args.length;
  if (s.name === 'path') return !s.args.length && ir.from === undefined && ir.to === undefined;
  const nums = s.args;
  if (s.name === 'limit' || s.name === 'sample') return nums.length === 1 && literalAtLeastOne(nums[0]);
  if (s.name === 'tail') return !nums.length || (nums.length === 1 && literalAtLeastOne(nums[0]));
  if (s.name === 'range') {
    const [lo, hi] = nums;
    return nums.length === 2 && lo!.name == null && hi!.name == null && Number(lo!.value) === 0
      && (literalAtLeastOne(hi) || Number(hi!.value) === -1);
  }
  return false;
};

/**
 * THE EXISTENCE PREFIX — the body an existence check actually asks: `body` up to its last step that can drop a
 * row. Every step after it maps or slices a non-empty stream to a non-empty one (`neverEmpties`), so "did the body
 * produce anything" is answered by the prefix alone, and the suffix need never be computed:
 * `where(out().project('a').by(path()))` is `where(out())`, `where(out().sample(1))` is `where(out())`.
 *
 * Trimming stops at the first step (from the end) that is `isImpure` — a side effect, an `as()` at any depth, a
 * step that may raise — because removing it would skip what it does. An EMPTY prefix means the body produces for
 * every traverser that reaches it.
 *
 * ONE authority with two consumers: the `trimExistenceSuffix` Pass (`ir/strategies.ts`) rewrites a body in a TRUE
 * existence position, and `childPredicate` (`rel/lower/exists.ts`) asks it for a `coalesce` arm's emptiness, whose
 * body it cannot rewrite because the arm's VALUE is used. `null` where there is nothing to trim.
 */
export function existencePrefix<S extends Step>(body: readonly S[], params: ParamEnv): readonly S[] | null {
  let end = body.length;
  while (end > 0) {
    // A RAW body (a nested argument the Pass reads before its own normalization) still spells a host's
    // modulators as the steps after it; they are the host's, trimmed with it or not at all.
    let host = end - 1;
    while (host > 0 && RAW_MODULATORS.has(body[host]!.name)) host--;
    const cluster = body.slice(host, end);
    const modulated = cluster.some((s) => s.name === 'by') ? { ...cluster[0]!, modulators: [[]] } : cluster[0]!;
    const scoped = cluster.some((s) => s.name === 'from' || s.name === 'to') ? { ...modulated, from: '' } : modulated;
    if (RAW_MODULATORS.has(cluster[0]!.name) || !neverEmpties(scoped) || isImpure(cluster, params)) break;
    end = host;
  }
  return end < body.length ? body.slice(0, end) : null;
}

/** The modulator steps a raw chain spells after their host (`absorbModulators` folds them later). */
const RAW_MODULATORS: ReadonlySet<string> = new Set(['by', 'from', 'to', 'with']);

/** A step whose evaluation can THROW over the data it meets — a value transform (`asNumber(GType.BYTE)`
 *  overflows, `toUpper()` rejects a non-String: `NumberHelper.java:724-800`, the `*GlobalStep.map`s) or
 *  `math()`. The reference evaluates a filter body whether or not the filter could reject
 *  (`TraversalFilterStep` calls `hasNext()`), so removing the body skips its error: the answer becomes
 *  the input stream where the reference throws. */
const mayRaise = (s: Step): boolean => SCALAR_TRANSFORMS.has(s.name) || s.name === 'math';

/** Does this chain (or anything nested inside it) have an EFFECT — `stepHasEffect`, the one effect
 *  vocabulary `dropEffectFreeSideEffect` asks too (a graph write, a keyed collector, a raise) — mutate the
 *  sack (`sack(op)`; a bare `sack()` only reads it), or bind an `as()` label? Each makes a filter step
 *  unsafe to REMOVE even when its body always produces a traverser: the effect would be skipped, and — although a filter consumer confines its body's binds today
 *  (see the child-seam guardrail in steps/CLAUDE.md) — declining on `as()` keeps this Pass from
 *  depending on that asymmetry holding. Fail closed: an unrecognisable arg counts as impure. */
function isImpure(steps: readonly Step[], params: ParamEnv): boolean {
  // EVERY child position (`ir/walk.ts`), an unreadable body impure: a folded `by()` body
  // (`project('a').by(__.as('x'))`) is a child as much as an argument is.
  return someStepDeep(steps, params, (s) => stepHasEffect(s) || (s.name === 'sack' && s.args.length > 0) || s.name === 'as' || mayRaise(s), true);
}

/**
 * Is this body a filter that can never reject anything — always productive AND free of side effects
 * or label binds, so the enclosing filter step is provably a no-op?
 *
 * Productivity is `alwaysProduces`' question, and its two-kinds rule matters HERE too: reading the last
 * step alone would make `where(__.hasLabel('person').constant(1))` a provable no-op and delete a filter
 * that really filters.
 */
export function bodyAlwaysProduces(nested: any, params: ParamEnv): boolean {
  if (!isNested(nested)) return false;
  const body = stepChain(nested.nested, params);
  // `identity()` alone is what `trimExistenceSuffix` leaves of a body that trims away entirely.
  const identity = body.length > 0 && body.every((s) => s.name === 'identity' && !s.args.length);
  return (identity || alwaysProduces(body)) && !isImpure(body, params);
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
export function alwaysProduces(body: readonly Step[]): boolean {
  const last = body.at(-1);
  if (!last) return false;
  if (seededTerminal(last)) return true;
  return isMappingTerminal(last) && body.length === 1;
}
