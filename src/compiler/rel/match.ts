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
import { aliasIdAt, aliasProjection, aliasValueAt, bindAliases, liveAliases } from './alias.ts';
import type { ChildHost } from './child.ts';
import type { TraverserObject } from './history.ts';
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
 *  is the movement/filter chain after the anchoring `as(start)`. A `binding` ends `as(end)` and WIDENS
 *  the table (a new column) or, when `end` is already bound, CONSTRAINS it (a back edge). A
 *  `constraint` has no `as(end)` — TinkerPop appends a `MatchEndStep` with a null key that only passes
 *  the traverser through, so the pattern survives iff its body PRODUCES: an existence filter on
 *  `start`, binding nothing (`as('d').has('name','vadas')`). A `filter` head (`where`/`not`/`and`/`or`)
 *  is a later phase. */
type Pattern =
  | { readonly kind: 'binding'; readonly start: string; readonly body: readonly IRStep[]; readonly end: string }
  | { readonly kind: 'constraint'; readonly start: string; readonly body: readonly IRStep[] };

/** The adjacency steps — a body containing one FANS the traverser OUT. A no-end constraint whose body
 *  is FILTER-ONLY (none of these) is a pure narrowing of `start` and folds as one re-rooted filter; a
 *  MOVING no-end body is an existence check (a semi-join), which is a later phase. `where`/`and`/`or`/
 *  `not` are absent because they are filters, not movements — they never fan out. */
const MOVEMENTS: ReadonlySet<string> = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'otherV', 'V', 'E', 'values', 'properties', 'label', 'id',
]);

/** The value-REDUCING barrier ends — a pattern like `as('a').out().count().as('c')` binds `c` to a
 *  reduction that must be computed ONCE PER ORIGIN with a 0/empty default. That is the scalar-child
 *  seam's job (`child.scalar`, the same correlated read `by(__.out().count())` uses), NOT the row fold,
 *  which drops the empty origins. `fold` is absent — it ends a LIST, a later phase. */
const REDUCING_ENDS: ReadonlySet<string> = new Set(['count', 'sum', 'mean', 'min', 'max']);

/** Parse a match argument into a `Pattern`, or `null` to decline the whole step (fail closed). Admits
 *  the anchored `as(start).<body>[.as(end)]` shapes; the FILTER/connective heads
 *  (`where`/`not`/`and`/`or`) are a later phase and DECLINE here rather than being mis-lowered. */
function classify(a: unknown, params: Record<string, any>): Pattern | null {
  if (!isNested(a)) return null;
  const chain = stepChain((a as { nested: unknown }).nested, params) as IRStep[];
  if (chain.length < 2) return null;
  const head = chain[0]!;
  const starts = asLabelsOf(head);
  // A single start label is the shape `MatchStartStep` models; `as('a','b')` as an anchor is a
  // front-end shape this has not seen, so decline rather than guess which variable is meant.
  if (head.name !== 'as' || starts.length !== 1) return null;
  const start = starts[0]!;

  const tail = chain[chain.length - 1]!;
  const ends = tail.name === 'as' ? asLabelsOf(tail) : [];
  // A trailing `as()` with several labels is likewise an unseen shape.
  if (tail.name === 'as' && ends.length !== 1) return null;
  const hasEnd = ends.length === 1;
  const body = hasEnd ? chain.slice(1, -1) : chain.slice(1);
  // The body must not itself re-anchor (an intra-pattern `as()` is a later phase).
  if (body.some((s) => s.name === 'as')) return null;
  if (hasEnd) return { kind: 'binding', start, body, end: ends[0]! };
  // A no-end constraint folds as a re-rooted FILTER, so its body must not move (a moving no-end body
  // is an existence semi-join, a later phase) and must be non-empty (a bare `as('a')` binds `a` at the
  // root and is not a pattern).
  if (!body.length || body.some((s) => MOVEMENTS.has(s.name))) return null;
  return { kind: 'constraint', start, body };
}

/** The root label — TinkerPop's `computeStartLabel`: a start that is never an end. The incoming
 *  traverser binds to it, so every pattern (including the root's own) re-roots uniformly via its start
 *  alias. When that set is empty (a CYCLE — every start is also an end, e.g.
 *  `a_created_b__b_0created_a`), fall back to the first start label; the readiness loop then still has
 *  an anchor because the incoming traverser is bound to it. */
function rootLabel(patterns: readonly Pattern[]): string | null {
  const starts = patterns.map((p) => p.start);
  const ends = new Set(patterns.flatMap((p) => (p.kind === 'binding' ? [p.end] : [])));
  return starts.find((s) => !ends.has(s)) ?? starts[0] ?? null;
}

/** Synthesize an IR step borrowing the host `match` step's parse context, so an error raised deep in
 *  the fold still points at the right source span (as `gql.ts`/`strategies.ts` do). */
const syn = (host: IRStep, name: string, values: unknown[] = []): IRStep =>
  ({ name, args: values.map((v) => arg(v)), ctx: host.ctx });

/** What a pattern body PRODUCED as the thing its `as(end)` binds or constrains: an ELEMENT (a movement
 *  end, addressed by rowid) or a SCALAR VALUE (`count()`/`values()`/`select(key)` end, addressed by the
 *  `v` column and its `vtype` tag). `value` is the expression a back edge compares against the stored
 *  binding; `bind` is the `TraverserObject` `bindAliases` widens the alias channels with. A list/map/
 *  record end returns `null` — a later phase. */
function producedObject(rel: Rel, framing: RelFraming): { readonly value: Expr; readonly kind: 'element' | 'value'; readonly bind: TraverserObject } | null {
  if (framing.kind === 'elements') {
    const id = col(rel.id, 'id');
    return { value: id, kind: 'element', bind: { kind: 'element', elem: framing.elem, id } };
  }
  if (framing.kind === 'scalar') {
    // A REDUCING BARRIER end (`count()`/`sum()`/…, `result` 'count'|'number') declines: its value is a
    // reduction that must be computed ONCE PER ORIGIN with a 0/empty default (a correlated scalar
    // child), and folding it inline drops the empty origins instead — a wrong answer, not a decline.
    // That is the scalar-child seam's job and a later phase. A PER-ROW value (`values('name')`,
    // `select(key)`) has no such marker and binds directly.
    if (framing.result === 'count' || framing.result === 'number') return null;
    const value = col(rel.id, 'v');
    const vtype = rel.type.cols.some((c) => c.name === 'vtype') ? col(rel.id, 'vtype') : undefined;
    return { value, kind: 'value', bind: { kind: 'value', value, type: framing.type, ...(vtype ? { vtype } : {}) } };
  }
  return null;
}

/**
 * Lower a `match()` step over the current element stream. It ALWAYS emits the bindings MAP — the
 * traverser TinkerPop's `MatchStep` produces — so it composes the same whether a `select`/`limit`/
 * `identity` follows or not. Returns `null` to decline (⇒ `UnsupportedTraversal`).
 *
 * The result carries the live `aliases` alongside the framed relation, so a downstream `select(k)` can
 * read a pattern variable off the record's alias channel — a `FramedRel` alone would drop the
 * label→column map it resolves against.
 */
export function lowerMatch(
  step: IRStep, seed: Rel, elem: Elem, aliases: AliasMap,
  params: Record<string, any>, child: ChildSeam, fresh: Minter,
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

  // The variables ALREADY bound before the match (an outer `V().as('a')…`). When the root is one of
  // them, the match runs in TinkerPop's ZERO-ROOT regime: there is nothing to seed, and rebinding the
  // root to the incoming traverser would CORRUPT it — the payload is whatever the outer chain walked
  // to (e.g. `b` after `V().as('a').out().as('b')`), not the root's element.
  const incoming = new Set<string>(liveAliases(aliases, seed).keys());
  let rel = seed;
  let labels = aliases;
  if (!incoming.has(root)) {
    // Bind the incoming traverser to a FRESH root, so the root pattern re-roots on its own start
    // exactly like every other pattern. `bindAliases` mints the alias channel and appends the history.
    const rootBound = bindAliases(syn(step, 'as', [root]), seed, aliases, { kind: 'element', elem, id: col(seed.id, 'id') }, fresh);
    if (!rootBound) return null;
    rel = rootBound.rel;
    labels = rootBound.aliases;
  }
  // The binding table's CURRENT framing — threaded rather than a bare `elem`, because a scalar-valued
  // end (`count().as('c')`) leaves the payload a scalar, and the NEXT pattern's re-root must dispatch
  // through the right tail (scalarTail handles a leading `select` re-root exactly as elementTail does).
  let framing: RelFraming = { kind: 'elements', elem };
  const bound = new Set<string>([...incoming, root]);

  // READINESS SCHEDULING — greedy, correctness-only (order is unobservable). A binding pattern is
  // ready once its start is bound; when it runs, its end joins the table. A dependency the loop can
  // never satisfy (an unreachable start) is an UNMATCHABLE pattern and declines the whole step.
  const pending = [...patterns];
  while (pending.length) {
    const i = pending.findIndex((p) => bound.has(p.start));
    if (i < 0) return null; // no ready pattern — a cyclic/unsolvable binding dependency. Fail closed.
    const p = pending.splice(i, 1)[0]!;

    // A REDUCING-barrier end (`as('a').out().count().as('c')`) binds a per-origin reduction with a
    // 0/empty default — the scalar-child seam, rooted at the start alias, NOT the row fold (which
    // drops empty origins). The reduction is a correlated scalar projected into the alias column; the
    // binding row's own payload is untouched, so `framing` carries.
    if (p.kind === 'binding' && REDUCING_ENDS.has(p.body[p.body.length - 1]?.name ?? '')) {
      const proj = aliasProjection(rel, labels, p.start, 'last', fresh);
      if (!proj || proj.read.kind !== 'element') return null;
      const host: ChildHost = { kind: 'element', id: aliasIdAt(col(rel.id, proj.entry.col), 'last'), elem: proj.read.elem, row: { rel, aliases: labels } };
      const produced = child.scalar(p.body, host);
      if (!produced || produced.framing.kind !== 'scalar') return null;
      if (bound.has(p.end)) {
        const entry = liveAliases(labels, rel).get(p.end);
        if (!entry) return null;
        rel = make.filter({ id: fresh('mf'), input: rel, channels: rel.channels, type: rel.type, pred: eq(produced.expr, aliasValueAt(col(rel.id, entry.col), 'last')) });
      } else {
        const bindEnd = bindAliases(syn(step, 'as', [p.end]), rel, labels, { kind: 'value', value: produced.expr, type: produced.framing.type }, fresh);
        if (!bindEnd) return null;
        rel = bindEnd.rel;
        labels = bindEnd.aliases;
        bound.add(p.end);
      }
      continue;
    }

    // Re-root at the pattern's start alias, then run the body through the ONE fold. The result relation
    // carries every prior alias channel (movements keep channels) plus a payload at the body's end.
    const rooted: IRStep[] = [syn(step, 'select', [p.start]), ...p.body];
    const ran = child.chain(rel, framing, rooted, labels);
    if (!ran) return null;

    if (p.kind === 'constraint') {
      // A NO-END pattern with a FILTER-ONLY body binds nothing and only NARROWS `start`: `classify`
      // guaranteed the body does not move, so `child.chain` is a pure filter of the binding table
      // (same alias channels, no fan-out) and its result relation IS the constrained table.
      if (ran.framing.kind !== 'elements') return null;
      rel = ran.rel;
      labels = ran.aliases;
      framing = ran.framing;
      continue;
    }

    // The produced traverser is either an ELEMENT (a movement end) or a SCALAR (`count()`/`values()`/
    // `select(key)` end). Either binds its label or, when the end is already bound, constrains it — the
    // element by rowid, the scalar by value. A list/map/record end is a later phase.
    const object = producedObject(ran.rel, ran.framing);
    if (!object) return null;
    if (bound.has(p.end)) {
      // BACK EDGE — the end names an already-bound variable, so the produced object must EQUAL it. A
      // `Filter` equality turns a cyclic pattern into a narrowing of the table rather than a widening
      // (`MatchEndStep`: `traverser.equals(path.get(end))`). Element ends compare rowids; scalar ends
      // compare stored values.
      const entry = liveAliases(ran.aliases, ran.rel).get(p.end);
      if (!entry) return null;
      const held = object.kind === 'element'
        ? aliasIdAt(col(ran.rel.id, entry.col), 'last')
        : aliasValueAt(col(ran.rel.id, entry.col), 'last');
      rel = make.filter({ id: fresh('mf'), input: ran.rel, channels: ran.rel.channels, type: ran.rel.type, pred: eq(object.value, held) });
      labels = ran.aliases;
    } else {
      // BINDING — the end is fresh, so widen the alias channels with it. `bindAliases` on the produced
      // object is the same act `as('b')` performs anywhere, element or value alike.
      const bindEnd = bindAliases(syn(step, 'as', [p.end]), ran.rel, ran.aliases, object.bind, fresh);
      if (!bindEnd) return null;
      rel = bindEnd.rel;
      labels = bindEnd.aliases;
      bound.add(p.end);
    }
    framing = ran.framing;
  }

  // match ALWAYS emits the BINDINGS MAP over every declared label — `startLabels ∪ endLabels`, in
  // first-mention order — because that is the traverser TinkerPop's `MatchStep` produces
  // (`getBindings` → `traverser.split(bindings)`), NOT the last pattern's payload. A following
  // `identity()`/`limit()` must see the map, and a `select(k)` re-enters a field or reads the alias
  // channel the record still carries (`recordTail`). Built by the same `selectKeys` a terminal
  // `select(labels)` uses; `framing` above is otherwise unused now that the map is unconditional.
  const declared: string[] = [];
  for (const p of patterns)
    for (const l of p.kind === 'binding' ? [p.start, p.end] : [p.start])
      if (!declared.includes(l)) declared.push(l);
  // A 0- or 1-variable pattern's bindings map is NOT a `select()`: `select('a')` yields the VALUE, not
  // the `{a: …}` one-key map TinkerPop emits (a `project('a').by(select('a'))`, as `gql.ts` builds).
  // Decline rather than emit the bare value — fail closed against a wrong answer; a later phase.
  if (declared.length < 2) return null;
  const bindings = selectKeys(syn(step, 'select', declared), rel, labels, child, fresh);
  return bindings && { ...bindings, aliases: labels };
}
