import { arg, isNested, stepChain } from '../../gremlin/frontend.ts';
import { col, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../plan/plan.ts';
import type { AliasMap } from '../plan/alias.ts';
import { asLabelsOf } from '../ir/labels.ts';
import type { IRStep } from '../ir/step.ts';
import { eq, type Minter } from './build.ts';
import type { ChildSeam } from './child.ts';
import type { FramedRel, RelFraming } from './framing.ts';
import { aliasIdAt, bindAliases, liveAliases } from './alias.ts';
import { selectKeys } from './record.ts';

/**
 * `match(p1, p2, …)` — the CONJUNCTIVE PATTERN step, lowered as a BINDING TABLE threaded through the
 * ONE fold, not as a private engine.
 *
 * ## Why a binding table and not a bespoke join planner
 *
 * TinkerPop's `MatchStep` maintains a traverser whose PATH carries the pattern variables and folds
 * each pattern onto it once its start-label is bound (`MatchStep.java` `CountMatchAlgorithm`); its
 * output is the bindings MAP over `startLabels ∪ endLabels` (`getBindings`). We reproduce exactly
 * that: an ordinary stream whose ALIAS CHANNELS are the variables, each pattern re-rooted at its
 * start alias, run through the ordinary fold, and rejoined by binding its end (a new column) or
 * constraining it (an equality against an already-bound column). This is left-deep by construction;
 * **pattern order is unobservable** — `CountMatchAlgorithm` reorders patterns by runtime cardinality,
 * which is the proof — so join order is SQLite's job (locked decision #3) and we schedule only for
 * READINESS (a pattern runs once its start is bound), never by a cost model.
 *
 * ## The load-bearing invariant: bodies lower through the CHILD SEAM
 *
 * Every pattern body is lowered by `child.chain` — "run the ordinary fold over a supplied stream".
 * That is the whole reason this composes at any depth where the deleted legacy engine did not: a
 * pattern body inherits the ENTIRE step vocabulary (movements, `has`, `where`, `order().by().limit()`,
 * `repeat`, `map`, a nested `match`) for free, because it is the same fold the top-level chain uses,
 * not a re-taught subset. The legacy `prefix/match.ts` carried its own `lowerElementSteps`, which is
 * exactly why it deferred `and`/`or`/nested-`match`/modulated bodies. See
 * `docs/2026-08-13-match-relir-lowering-plan.md`.
 *
 * ## No new algebra
 *
 * Binding = the existing alias channel widened by `bindAliases`; back-edge constraint = an equality
 * `Filter` against `aliasIdAt`; the bindings map = the same `selectKeys` a terminal `select(labels)`
 * builds. `src/rel` already carries `join` (incl. `semi`/`anti`), `union` and the correlated `exists`
 * Expr for the filter/connective legs a later phase reaches. If this file grows a new `Rel` node kind,
 * that is the signal to stop and reuse those (`src/compiler/CLAUDE.md`).
 */

/** One pattern, classified by how it rejoins the binding table. `start`/`end` are alias labels; `body`
 *  is the movement/filter chain BETWEEN the anchoring `as()`s. A `constraint` has no end — its body
 *  only narrows `start`. A `filter` head (`where`/`not`/`and`/`or`) is a later phase. */
type Pattern =
  | { readonly kind: 'binding'; readonly start: string; readonly body: readonly IRStep[]; readonly end: string };

/** Parse a match argument into a `Pattern`, or `null` to decline the whole step (fail closed). P0
 *  admits only the anchored binding shape `as(start).<body>.as(end)`; the constraint/filter/connective
 *  shapes are the next phases and DECLINE here rather than being mis-lowered. */
function classify(a: unknown, params: Record<string, any>): Pattern | null {
  if (!isNested(a)) return null;
  const chain = stepChain((a as { nested: unknown }).nested, params) as IRStep[];
  if (chain.length < 2) return null;
  const head = chain[0]!;
  const tail = chain[chain.length - 1]!;
  if (head.name !== 'as' || tail.name !== 'as') return null;
  const starts = asLabelsOf(head);
  const ends = asLabelsOf(tail);
  // A single label at each anchor is the shape `MatchStartStep`/`MatchEndStep` model; `as('a','b')`
  // as an anchor is a front-end shape this has not seen, so decline rather than guess which is meant.
  if (starts.length !== 1 || ends.length !== 1) return null;
  const body = chain.slice(1, -1);
  // The body must not itself re-anchor (a nested `as()` inside a pattern is not P0's shape).
  if (body.some((s) => s.name === 'as')) return null;
  return { kind: 'binding', start: starts[0]!, body, end: ends[0]! };
}

/** The root label — TinkerPop's `computeStartLabel`: a start that is never an end. The incoming
 *  traverser binds to it, so every pattern (including the root's own) re-roots uniformly via its start
 *  alias. When that set is empty (a CYCLE — every start is also an end, e.g.
 *  `a_created_b__b_0created_a`), fall back to the first start label; the readiness loop then still has
 *  an anchor because the incoming traverser is bound to it. */
function rootLabel(patterns: readonly Pattern[]): string | null {
  const starts = patterns.map((p) => p.start);
  const ends = new Set(patterns.map((p) => p.end));
  return starts.find((s) => !ends.has(s)) ?? starts[0] ?? null;
}

/** Synthesize an IR step borrowing the host `match` step's parse context, so an error raised deep in
 *  the fold still points at the right source span (as `gql.ts`/`strategies.ts` do). */
const syn = (host: IRStep, name: string, values: unknown[] = []): IRStep =>
  ({ name, args: values.map((v) => arg(v)), ctx: host.ctx });

/**
 * Lower a `match()` step over the current element stream. `terminal` says the match is the LAST step
 * of its chain — if so the bindings MAP is projected (TinkerPop emits it; a downstream `select` would
 * otherwise read the alias channels directly). Returns `null` to decline (⇒ `UnsupportedTraversal`).
 *
 * The result carries the live `aliases` alongside the framed relation, because a NON-terminal match
 * hands the pattern variables on to the downstream `select`/`dedup`/`where` as alias channels — a
 * `FramedRel` alone would drop the label→column map they resolve against.
 */
export function lowerMatch(
  step: IRStep, seed: Rel, elem: Elem, aliases: AliasMap,
  terminal: boolean, params: Record<string, any>, child: ChildSeam, fresh: Minter,
): (FramedRel & { readonly aliases: AliasMap }) | null {
  // A modulator/option arm on `match` is a front-end shape this has not seen; decline.
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];
  if (!args.length) return null;

  const patterns: Pattern[] = [];
  for (const a of args) {
    const p = classify(a.value, params);
    if (!p) return null; // one unclassifiable pattern declines the whole step — fail closed.
    patterns.push(p);
  }

  const root = rootLabel(patterns);
  if (root === null) return null;

  // Bind the incoming traverser to the root label, so the root pattern re-roots on its own start
  // exactly like every other pattern. `bindAliases` mints the alias channel and appends the history.
  const rootBound = bindAliases(syn(step, 'as', [root]), seed, aliases, { kind: 'element', elem, id: col(seed.id, 'id') }, fresh);
  if (!rootBound) return null;
  let rel = rootBound.rel;
  let labels = rootBound.aliases;
  const bound = new Set<string>([...liveAliases(aliases, seed).keys(), root]);

  // READINESS SCHEDULING — greedy, correctness-only (order is unobservable). A binding pattern is
  // ready once its start is bound; when it runs, its end joins the table. A dependency the loop can
  // never satisfy (an unreachable start) is an UNMATCHABLE pattern and declines the whole step.
  const pending = [...patterns];
  while (pending.length) {
    const i = pending.findIndex((p) => bound.has(p.start));
    if (i < 0) return null; // no ready pattern — a cyclic/unsolvable binding dependency. Fail closed.
    const p = pending.splice(i, 1)[0]!;

    // Re-root at the pattern's start alias, then run the body through the ONE fold. The result relation
    // carries every prior alias channel (movements keep channels) plus a payload at the body's end.
    const chainSteps: IRStep[] = [syn(step, 'select', [p.start]), ...p.body];
    const ran = child.chain(rel, { kind: 'elements', elem } as RelFraming, chainSteps, labels);
    if (!ran) return null;
    // The body must end on an ELEMENT for P0 (a scalar/count end is a later phase). Anything else
    // declines rather than being bound as the wrong shape.
    if (ran.framing.kind !== 'elements') return null;
    const producedId: Expr = col(ran.rel.id, 'id');

    if (bound.has(p.end)) {
      // BACK EDGE — the end names an already-bound variable, so the produced element must EQUAL it.
      // A `Filter` equality against the stored rowid, which is what turns a cyclic pattern into a
      // narrowing of the table rather than a widening (`MatchEndStep`: `traverser.equals(path.get(end))`).
      const entry = liveAliases(ran.aliases, ran.rel).get(p.end);
      if (!entry) return null;
      const constraint = eq(producedId, aliasIdAt(col(ran.rel.id, entry.col), 'last'));
      rel = make.filter({ id: fresh('mf'), input: ran.rel, channels: ran.rel.channels, type: ran.rel.type, pred: constraint });
      labels = ran.aliases;
    } else {
      // BINDING — the end is fresh, so widen the alias channels with it. `bindAliases` on the produced
      // element is the same act `as('b')` performs anywhere.
      const bindEnd = bindAliases(syn(step, 'as', [p.end]), ran.rel, ran.aliases, { kind: 'element', elem: ran.framing.elem, id: producedId }, fresh);
      if (!bindEnd) return null;
      rel = bindEnd.rel;
      labels = bindEnd.aliases;
      bound.add(p.end);
    }
    elem = ran.framing.elem;
  }

  // The BINDINGS MAP over every declared label — `startLabels ∪ endLabels`, in first-mention order —
  // built by the same `selectKeys` a `select(labels)` uses. When the match is terminal this IS the
  // result; when it is not, a downstream `select`/`dedup`/`where` reads the alias channels instead and
  // this projection is what carries the shape a bare-terminal consumer would read.
  const declared: string[] = [];
  for (const p of patterns) for (const l of [p.start, p.end]) if (!declared.includes(l)) declared.push(l);
  if (!terminal) return { rel, framing: { kind: 'elements', elem }, aliases: labels };
  const bindings = selectKeys(syn(step, 'select', declared), rel, labels, child, fresh);
  return bindings && { ...bindings, aliases: labels };
}
