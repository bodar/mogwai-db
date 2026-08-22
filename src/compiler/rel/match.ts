import { arg, isNested, isPred, stepChain, type Arg } from '../../gremlin/frontend.ts';
import { normalize } from '../ir/passes.ts';
import { col, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../plan/plan.ts';
import type { AliasMap } from '../plan/alias.ts';
import { asLabelsOf } from '../ir/labels.ts';
import type { IRStep } from '../ir/step.ts';
import { and, eq, type Minter } from './build.ts';
import type { ChildSeam } from './child.ts';
import type { FramedRel, RelFraming } from './framing.ts';
import { aliasIdAt, aliasProjection, aliasValueAt, bindAliases, liveAliases } from './alias.ts';
import type { ChildHost, Subject } from './child.ts';
import type { TraverserObject } from './history.ts';
import { selectKeys } from './record.ts';
import type { GraphSource } from './source.ts';

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
 *  `start`, binding nothing (`as('d').has('name','vadas')`). A `where`/`not` filter head is a `leg`
 *  (below); the `and`/`or` connective groups are a later phase. */
type Pattern =
  | { readonly kind: 'binding'; readonly start: string; readonly body: readonly IRStep[]; readonly end: string }
  | { readonly kind: 'constraint'; readonly start: string; readonly body: readonly IRStep[] }
  /** `where('a', P.eq/neq('b'))` — TinkerPop's `WherePredicateStep`, a THETA clause between two
   *  ALREADY-BOUND variables (no sub-traversal, no join). It binds nothing and reads both keys. */
  | { readonly kind: 'wpred'; readonly startKey: string; readonly op: 'eq' | 'neq'; readonly otherKey: string }
  /** `where(<body>)` / `not(<body>)` as a match ARGUMENT — TinkerPop's `WhereTraversalStep`/`NotStep`
   *  in match position: an existence test over a re-rooted sub-traversal that BINDS NOTHING and only
   *  NARROWS the binding table (`where` keeps rows the body produces for, `not` keeps rows it does
   *  not). The Pass (`rewriteWhereEndLabels`) has already re-rooted the body's leading `as(start)` to
   *  `select(start)` and constrained each bound end `.as(e)` to `where(P.eq(e))`, so `start` is the one
   *  alias it re-roots at and `reads` is every alias the body references (all must be bound). A leg
   *  reading ONE alias is a single-correlation `[NOT] EXISTS` (the tested predicate seam); a leg
   *  reading SEVERAL is a multi-column SEMI/ANTI join. */
  | { readonly kind: 'leg'; readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] };

/** A pattern chain PARSED AND NORMALIZED. The Pass pipeline folds `order().by()`, `repeat().times()`,
 *  `sack().by()` and every other modulator into ONE `IRStep` (`normalize`, `passes.ts:336` — "`order().by()`
 *  must arrive as ONE `IRStep` before any shape-aware lowering sees it"), which a raw `stepChain` does
 *  NOT do. The top-level passes do not recurse into a match pattern, so a modulated body used to arrive
 *  as split steps and DECLINED at the fold; normalizing here is the same seam every other nested body
 *  crosses via `childSteps`. A pattern keeps its `as()` anchors, so it runs `normalize` directly rather
 *  than `childSteps` (which strips a source). `null` where normalizing RAISES — a deferral, not a crash. */
function patternSteps(nested: unknown, params: Record<string, any>): IRStep[] | null {
  try { return normalize(stepChain(nested, params), params).steps as IRStep[]; } catch { return null; }
}

/** The alias labels a pattern READS — all must be bound before it is ready to run. */
const readsOf = (p: Pattern): readonly string[] =>
  p.kind === 'wpred' ? [p.startKey, p.otherKey] : p.kind === 'leg' ? p.reads : [p.start];

/** The adjacency steps — a body containing one FANS the traverser OUT. A no-end constraint whose body
 *  is FILTER-ONLY (none of these) is a pure narrowing of `start` and folds as one re-rooted filter; a
 *  MOVING no-end body is an existence check (a semi-join), which is a later phase. `where`/`and`/`or`/
 *  `not` are absent because they are filters, not movements — they never fan out. */
const MOVEMENTS: ReadonlySet<string> = new Set([
  'out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'otherV', 'V', 'E', 'values', 'properties', 'label', 'id',
]);

/** Steps whose fold crosses ORIGIN boundaries — a global slice or barrier. `child.chain` runs a
 *  pattern body over the WHOLE binding table, so any of these applies across all origins at once, while
 *  TinkerPop runs each pattern per traverser (`MatchStep.java:158-164`). A binding/constraint body
 *  containing one is a WRONG answer, not a slow one, so it DECLINES (a per-origin windowed lowering is a
 *  later phase). `order()` is absent — it drops nothing, so a global sort leaves the binding multiset
 *  unchanged; a reducing barrier as the END is absent from the general path because `reducingEnd` handles
 *  it per-origin first. */
const PER_ORIGIN_UNSAFE: ReadonlySet<string> = new Set([
  'limit', 'range', 'tail', 'skip', 'sample',
  'dedup', 'fold', 'group', 'groupCount', 'aggregate', 'cap',
  'count', 'sum', 'mean', 'min', 'max',
]);

/** The value-REDUCING barrier ends — a pattern like `as('a').out().count().as('c')` binds `c` to a
 *  reduction that must be computed ONCE PER ORIGIN with a 0/empty default. That is the scalar-child
 *  seam's job (`child.scalar`, the same correlated read `by(__.out().count())` uses), NOT the row fold,
 *  which drops the empty origins. `fold` is absent — it ends a LIST, a later phase. */
const REDUCING_ENDS: ReadonlySet<string> = new Set(['count', 'sum', 'mean', 'min', 'max']);

/** A pattern body that ENDS in a value-reducing barrier, optionally followed by scalar `is(P)` filters:
 *  `as('a').out().count().as('c')` or `as('a').out().count().is(P.gt(10)).as('c')`. Returns the
 *  `reduceBody` (up to and including the barrier — what `child.scalar` reduces to one value per origin)
 *  and whether trailing `is()` FILTERS follow (which DROP a row before the reduction binds, exactly the
 *  predicate `valuePredicate` builds for `where(<…count().is(P)>)`). `null` when the body is not a
 *  reduction — the ordinary per-row fold takes it. A non-`is` step after the barrier (a second movement)
 *  is not this shape and declines, since a barrier resets the stream. */
function reducingEnd(body: readonly IRStep[]): { readonly reduceBody: readonly IRStep[]; readonly filtered: boolean } | null {
  let i = body.length - 1;
  while (i >= 0 && body[i]!.name === 'is') i--;
  if (i < 0 || !REDUCING_ENDS.has(body[i]!.name)) return null;
  return { reduceBody: body.slice(0, i + 1), filtered: i < body.length - 1 };
}

/** A `where(<body>)`/`not(<body>)` filter LEG, after the Pass has re-rooted its body. The body's head
 *  is a `select(start)` (the Pass rewrote the leading `as(start)`), and its `reads` are `start` plus
 *  every alias a `where(P.eq/neq(label))` in the body references (the Pass rewrote each bound end that
 *  way). A leg BINDS nothing, so an intra-body `as()` — which the Pass leaves alone in the MIDDLE — is
 *  an unseen shape and declines. */
function classifyLeg(head: IRStep, params: Record<string, any>): Pattern | null {
  const negated = head.name === 'not';
  const nested = head.args?.[0]?.value;
  if ((head.args?.length ?? 0) !== 1 || !isNested(nested)) return null;
  const inner = patternSteps((nested as { nested: unknown }).nested, params);
  if (!inner) return null;
  // The Pass re-roots a body whose start label is bound; a leg whose leading `as()` it could not
  // rewrite (an unbound start) is not the re-rooted `select` shape, so decline.
  if (inner.length < 2 || inner[0]!.name !== 'select') return null;
  const starts = (inner[0]!.args ?? []).map((s) => s.value).filter((v): v is string => typeof v === 'string');
  if (starts.length !== 1) return null;
  const start = starts[0]!;
  const body = inner.slice(1);
  // A mid-body re-anchor binds a variable; a leg binds nothing, so decline (a later phase).
  if (body.some((s) => s.name === 'as')) return null;
  const reads = new Set<string>([start]);
  for (const s of body) {
    if (s.name !== 'where') continue;
    const pred = s.args?.[0]?.value;
    if (isPred(pred)) for (const o of pred.operands) if (typeof o.value === 'string') reads.add(o.value);
  }
  return { kind: 'leg', negated, start, body, reads: [...reads] };
}

/** One position in a multi-correlation leg's body that must EQUAL/DIFFER from a bound alias — a
 *  `where(P.eq/neq(label))` the leg reads, wherever it sits in the body. `channel` is the fresh alias
 *  the fresh right walk BINDS the walk's current position to, so the constraint becomes a join clause
 *  `op(left.label, right.channel)` rather than a value the right does not hold. */
interface LegCorrelation { readonly op: 'eq' | 'neq'; readonly label: string; readonly channel: string; }

/** The FRESH right-side walk of a multi-correlation leg, plus its correlation clauses. Every
 *  `where(P.eq/neq(label))` in the body — at ANY position, so a MID-body constraint is carried, not
 *  dropped (TinkerPop's `MatchStartStep.getScopeKeys` reads a leg's WHOLE recursive scope-key set,
 *  `MatchStep.java` `anyStepRecursively`, not only the trailing `WhereEndStep`) — BINDS the walk's
 *  current position as a fresh channel and contributes one correlation `op(left.label, right.channel)`;
 *  the start binds a fresh channel correlated by equality. Every other step (movements, `has`, a
 *  non-label `where`) passes through the fold unchanged. `null` never happens here — an unmodellable
 *  step declines later, when `child.chain` cannot lower it. */
function legRight(start: string, body: readonly IRStep[], host: IRStep, fresh: Minter): { readonly chain: IRStep[]; readonly corr: readonly LegCorrelation[] } {
  const startChannel = fresh('mc');
  const corr: LegCorrelation[] = [{ op: 'eq', label: start, channel: startChannel }];
  const chain: IRStep[] = [syn(host, 'as', [startChannel])];
  for (const s of body) {
    const pred = s.name === 'where' ? s.args?.[0]?.value : undefined;
    if (isPred(pred) && (pred.op === 'eq' || pred.op === 'neq') && pred.operands.length === 1 && typeof pred.operands[0]!.value === 'string') {
      // A label constraint anywhere in the body: bind the current walk position as a fresh channel and
      // lift the equality/inequality into the join's ON. This is the SAME move a trailing bound end
      // takes (the Pass turned its `.as(e)` into this `where(P.eq(e))`), applied uniformly at any depth.
      const channel = fresh('mc');
      corr.push({ op: pred.op, label: pred.operands[0]!.value, channel });
      chain.push(syn(host, 'as', [channel]));
      continue;
    }
    chain.push(s);
  }
  return { chain, corr };
}

/** Parse a match argument into a `Pattern`, or `null` to decline the whole step (fail closed). Admits
 *  the anchored `as(start).<body>[.as(end)]` shapes, the two-variable `where('a', P)` clause, and a
 *  `where(<body>)`/`not(<body>)` filter leg; the `and`/`or` connective groups are a later phase and
 *  DECLINE here rather than being mis-lowered. */
function classify(a: unknown, params: Record<string, any>): Pattern | null {
  if (!isNested(a)) return null;
  const chain = patternSteps((a as { nested: unknown }).nested, params);
  if (!chain) return null;
  // A single `where`/`not` step is a FILTER argument, not an anchored pattern.
  if (chain.length === 1 && (chain[0]!.name === 'where' || chain[0]!.name === 'not')) {
    const head = chain[0]!;
    // `where('a', P.eq/neq('b'))` — a two-variable THETA clause. A label key and a predicate whose
    // single operand is another label. Only `eq`/`neq` (element identity) here; the other ops over two
    // element aliases are not meaningful.
    if (head.name === 'where') {
      const wargs = head.args ?? [];
      const pred = wargs[1]?.value;
      if (wargs.length === 2 && typeof wargs[0]!.value === 'string' && isPred(pred)
        && (pred.op === 'eq' || pred.op === 'neq') && pred.operands.length === 1 && typeof pred.operands[0]!.value === 'string')
        return { kind: 'wpred', startKey: wargs[0]!.value, op: pred.op, otherKey: pred.operands[0]!.value };
    }
    return classifyLeg(head, params);
  }
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
  // A bare `as('a')` binds `a` at the root and is not a pattern.
  if (!body.length) return null;
  // A MOVING no-end body is an EXISTENCE check — TinkerPop's `MatchEndStep` with a null key passes the
  // traverser through iff the body PRODUCED, so `as('b').out('created').has('name','lop')` survives a
  // `b` exactly when it has such an out-edge. That is a single-correlation semi-join reading only
  // `start` — the same shape a `where(<body>)` leg takes — so route it as a `leg`, whose
  // `child.predicate` builds the correlated `EXISTS`. A FILTER-ONLY body has no adjacency to test and
  // stays a re-rooted `constraint` (a pure narrowing of `start`).
  if (body.some((s) => MOVEMENTS.has(s.name))) return { kind: 'leg', negated: false, start, body, reads: [start] };
  return { kind: 'constraint', start, body };
}

/** If a match ARGUMENT is a bare `and(…)` connective, return its child arguments (each itself a
 *  pattern or a further connective); else `null`. TinkerPop replaces a match arg whose START step is an
 *  `AndStep` with a nested `MatchStep` of connective AND (`MatchStep.configureStartAndEndSteps`,
 *  `vendor/tinkerpop/gremlin-core/.../MatchStep.java:122`). An AND sub-match shares the parent's
 *  variable scope and binding table — every child must match — so it is exactly a CONJUNCTION: its
 *  children are simply more patterns on the same table. (`or(…)` is a DISJUNCTION — a UNION of
 *  per-branch tables — a different construction, a later phase; it is NOT flattened here.) */
function andChildren(a: unknown, params: Record<string, any>): readonly Arg[] | null {
  if (!isNested(a)) return null;
  const chain = patternSteps((a as { nested: unknown }).nested, params);
  return chain?.length === 1 && chain[0]!.name === 'and' ? (chain[0]!.args ?? []) : null;
}

/** Flatten a match argument list into patterns, expanding every top-level `and(…)` connective into its
 *  children (recursively — a nested `and` flattens too). Each non-connective argument classifies as one
 *  `Pattern`. Returns `null` to DECLINE the whole step (fail closed) on any unclassifiable argument. */
function collectPatterns(args: readonly Arg[], params: Record<string, any>): Pattern[] | null {
  const out: Pattern[] = [];
  for (const a of args) {
    const children = andChildren(a.value, params);
    if (children) {
      const nested = collectPatterns(children, params);
      if (!nested) return null;
      out.push(...nested);
      continue;
    }
    const p = classify(a.value, params);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** The root label — TinkerPop's `computeStartLabel`: a start that is never an end. The incoming
 *  traverser binds to it, so every pattern (including the root's own) re-roots uniformly via its start
 *  alias. When that set is empty (a CYCLE — every start is also an end, e.g.
 *  `a_created_b__b_0created_a`), fall back to the first start label; the readiness loop then still has
 *  an anchor because the incoming traverser is bound to it. */
function rootLabel(patterns: readonly Pattern[]): string | null {
  const starts = patterns.flatMap((p) => (p.kind === 'wpred' ? [] : [p.start]));
  const ends = new Set(patterns.flatMap((p) => (p.kind === 'binding' ? [p.end] : [])));
  return starts.find((s) => !ends.has(s)) ?? starts[0] ?? null;
}

/** Synthesize an IR step borrowing the host `match` step's parse context, so an error raised deep in
 *  the fold still points at the right source span (as `gql.ts`/`strategies.ts` do). */
const syn = (host: IRStep, name: string, values: unknown[] = []): IRStep =>
  ({ name, args: values.map((v) => arg(v)), ctx: host.ctx });

/** A `where(<body>)`/`not(<body>)` filter LEG lowered against a stream that CARRIES the bound aliases —
 *  the match binding table OR the record a terminal `match`/`select` produced (`recordTail`). A leg
 *  BINDS nothing and only NARROWS: `where` keeps rows the body produces for (a SEMI join / EXISTS),
 *  `not` keeps rows it does not (an ANTI join / NOT EXISTS).
 *
 *  Two lowerings, tried in order:
 *  - A SINGLE-correlation leg with a MOVEMENT-headed body is a correlated `[NOT] EXISTS` — the tested
 *    predicate seam (`child.predicate` → `correlatedExists`), re-rooted at the one bound element.
 *  - Otherwise — a MULTI-correlation leg (the body constrains a SECOND bound alias) OR a single leg
 *    whose body `child.predicate` cannot express (a RECURSIVE/reducing walk, `repeat().times()`) — is a
 *    SEMI/ANTI JOIN against a FRESH walk of the body. `legRight` builds the walk with its own source,
 *    binding the start and each `where(P.eq/neq(label))` position (at ANY depth) as a channel, and
 *    `make.join` correlates it back on every position. The right must be a relation OF ITS OWN, never a
 *    re-derivation of the carrying table (`col(rel.id, …)` on both sides collapses the correlation),
 *    which is why `child.chain` lowers it over a fresh `V()`/`E()` source — and that path lowers the
 *    FULL step vocabulary, so a `repeat` body works here where a single-subject `EXISTS` cannot thread. */
export function applyLeg(
  leg: { readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] },
  rel: Rel, labels: AliasMap, child: ChildSeam, host: IRStep, fresh: Minter,
): Rel | null {
  const startProj = aliasProjection(rel, labels, leg.start, 'last', fresh);
  if (!startProj || startProj.read.kind !== 'element') return null;

  if (leg.reads.length === 1) {
    const subject: Subject = { kind: 'element', id: aliasIdAt(col(rel.id, startProj.entry.col), 'last'), rel, elem: startProj.read.elem };
    const clause = child.predicate(leg.body, subject, leg.negated);
    // A movement-headed body answered here; a non-movement head (a recursive/reducing walk) declines
    // and falls through to the fresh-walk join, which lowers the body via `child.chain`.
    if (clause) return make.filter({ id: fresh('ml'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
  }

  const { chain: rightBody, corr } = legRight(leg.start, leg.body, host, fresh);
  const src = child.rooted([syn(host, startProj.read.elem === 'edge' ? 'E' : 'V')]);
  if (!src || src.framing.kind !== 'elements') return null;
  const ran = child.chain(src.rel, src.framing, rightBody, new Map());
  if (!ran) return null;
  const live = liveAliases(ran.aliases, ran.rel);
  let on: Expr | undefined;
  for (const { op, label, channel } of corr) {
    const lproj = aliasProjection(rel, labels, label, 'last', fresh);
    const rEntry = live.get(channel);
    if (!lproj || !rEntry) return null;
    const same = lproj.read.kind === 'element'
      ? eq(aliasIdAt(col(rel.id, lproj.entry.col), 'last'), aliasIdAt(col(ran.rel.id, rEntry.col), 'last'))
      : eq(aliasValueAt(col(rel.id, lproj.entry.col), 'last'), aliasValueAt(col(ran.rel.id, rEntry.col), 'last'));
    on = and(on, op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same });
  }
  if (!on) return null;
  return make.join({ id: fresh('mj'), left: rel, right: ran.rel, join: leg.negated ? 'anti' : 'semi', on, channels: rel.channels, type: rel.type });
}

/** Parse a top-level `where(<body>)`/`not(<body>)` step (over a record's bound aliases) into a leg, or
 *  `null` to decline. The same classifier `match` uses for a filter argument — the body's leading `as`
 *  is Pass-re-rooted to `select(start)`, and `reads` is every alias it references. */
export function classifyWhereLeg(step: IRStep, params: Record<string, any>): { readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] } | null {
  if ((step.name !== 'where' && step.name !== 'not') || step.modulators?.length || step.optionArms) return null;
  const p = classifyLeg(step, params);
  return p && p.kind === 'leg' ? p : null;
}

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
  params: Record<string, any>, child: ChildSeam, source: GraphSource, fresh: Minter,
): (FramedRel & { readonly aliases: AliasMap }) | null {
  // A modulator/option arm on `match` is a front-end shape this has not seen; decline.
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];
  if (!args.length) return null;

  const patterns = collectPatterns(args, params);
  if (!patterns) return null; // one unclassifiable pattern declines the whole step — fail closed.

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
    const i = pending.findIndex((p) => readsOf(p).every((l) => bound.has(l)));
    if (i < 0) return null; // no ready pattern — a cyclic/unsolvable binding dependency. Fail closed.
    const p = pending.splice(i, 1)[0]!;

    if (p.kind === 'wpred') {
      // A two-variable THETA clause between already-bound ELEMENT aliases: compare rowids. `eq` keeps
      // rows where they are the SAME element, `neq` where they differ (`WherePredicateStep` over two
      // path values). Both must be elements; a scalar-alias compare is a later phase.
      const projA = aliasProjection(rel, labels, p.startKey, 'last', fresh);
      const projB = aliasProjection(rel, labels, p.otherKey, 'last', fresh);
      if (!projA || !projB || projA.read.kind !== 'element' || projB.read.kind !== 'element') return null;
      const same = eq(aliasIdAt(col(rel.id, projA.entry.col), 'last'), aliasIdAt(col(rel.id, projB.entry.col), 'last'));
      const clause: Expr = p.op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same };
      rel = make.filter({ id: fresh('mw'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
      continue;
    }

    if (p.kind === 'leg') {
      const filtered = applyLeg(p, rel, labels, child, step, fresh);
      if (!filtered) return null;
      rel = filtered;
      continue;
    }

    // A REDUCING-barrier end (`as('a').out().count().as('c')`) binds a per-origin reduction with a
    // 0/empty default — the scalar-child seam, rooted at the start alias, NOT the row fold (which
    // drops empty origins). The reduction is a correlated scalar projected into the alias column; the
    // binding row's own payload is untouched, so `framing` carries. A trailing `is(P)` filter
    // (`count().is(P.gt(10)).as('c')`) DROPS the row before the reduction binds — the same predicate
    // `where(<…count().is(P)>)` builds, applied as a correlated filter over the START element.
    const reduce = p.kind === 'binding' ? reducingEnd(p.body) : null;
    if (p.kind === 'binding' && reduce) {
      if (reduce.filtered) {
        // The whole body incl. the trailing `is()` is a correlated predicate over the start element —
        // `child.predicate` routes it through `valuePredicate` (reduce, then compare), which is exactly
        // the drop this end owes. Filter FIRST, then rebuild the alias read against the narrowed table.
        const sproj = aliasProjection(rel, labels, p.start, 'last', fresh);
        if (!sproj || sproj.read.kind !== 'element') return null;
        const subject: Subject = { kind: 'element', id: aliasIdAt(col(rel.id, sproj.entry.col), 'last'), rel, elem: sproj.read.elem };
        const clause = child.predicate(p.body, subject, false);
        if (!clause) return null;
        rel = make.filter({ id: fresh('mr'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
      }
      const proj = aliasProjection(rel, labels, p.start, 'last', fresh);
      if (!proj || proj.read.kind !== 'element') return null;
      const host: ChildHost = { kind: 'element', id: aliasIdAt(col(rel.id, proj.entry.col), 'last'), elem: proj.read.elem, row: { rel, aliases: labels } };
      const produced = child.scalar(reduce.reduceBody, host);
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

    // FAIL CLOSED on a GLOBAL slice/barrier in the body. `child.chain` folds the body over the WHOLE
    // binding table at once, so a `limit`/`range`/`tail`/`dedup`/`fold`/`group` would apply ACROSS all
    // origins rather than per-origin — but TinkerPop runs each pattern PER TRAVERSER (`MatchStep`
    // rewrites a barrier body into a `TraversalFlatMapStep` so it is "locally computable",
    // `vendor/tinkerpop/gremlin-core/.../MatchStep.java:158-164`). `a.outE.order.by(weight,desc).limit(1).inV.b`
    // would bind ONE global edge's target instead of one per `a` — a WRONG answer, so decline until a
    // per-origin windowed lowering exists. A reducing barrier as the END is already handled per-origin
    // above (`child.scalar`); `order()` alone drops nothing and stays.
    if (p.body.some((s) => PER_ORIGIN_UNSAFE.has(s.name))) return null;

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
  const declaredOf = (p: Pattern): readonly string[] =>
    p.kind === 'binding' ? [p.start, p.end] : p.kind === 'constraint' ? [p.start] : [];
  for (const p of patterns) for (const l of declaredOf(p)) if (!declared.includes(l)) declared.push(l);
  // A 0- or 1-variable pattern's bindings map is NOT a `select()`: `select('a')` yields the VALUE, not
  // the `{a: …}` one-key map TinkerPop emits (a `project('a').by(select('a'))`, as `gql.ts` builds).
  // Decline rather than emit the bare value — fail closed against a wrong answer; a later phase.
  if (declared.length < 2) return null;
  const bindings = selectKeys(syn(step, 'select', declared), rel, labels, child, source, fresh);
  return bindings && { ...bindings, aliases: labels };
}
