import { arg, isNested, isPred, stepChain, type Arg } from '../../gremlin/frontend.ts';
import { normalize } from '../ir/passes.ts';
import { col, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Elem } from '../elem.ts';
import type { AliasMap } from '../alias.ts';
import { asLabelsOf } from '../ir/labels.ts';
import type { IRStep } from '../ir/step.ts';
import { and, eq, or, type Minter } from './build.ts';
import type { ChainRead, ChildSeam } from './child.ts';
import type { FramedRel, RelFraming } from './framing.ts';
import { aliasIdAt, aliasProjection, aliasTypeAt, aliasValueAt, bindAliases, liveAliases } from './alias.ts';
import type { ChildHost, Subject } from './child.ts';
import { SUBJECT_UNKNOWN, type SubjectType } from './predicate.ts';
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
  | { readonly kind: 'leg'; readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] }
  /** `or(<branch>, <branch>, …)` — TinkerPop's OR connective in match position, a DISJUNCTION over the
   *  binding table. Every corpus `or` is a FILTER disjunction (each branch tests already-bound
   *  variables and BINDS NOTHING NEW — an existence/back-edge/theta condition), so the whole connective
   *  is one boolean PREDICATE `branch₁ ∨ branch₂ ∨ …` applied as a single `Filter`, NOT a UNION of
   *  per-branch tables. A branch that would bind a fresh variable is the disjunctive-UNION regime (a
   *  later phase) and DECLINES here. `branches` are the raw args (each re-classified at run time against
   *  the bound set); `reads` is every alias any branch references, so readiness waits for all of them.
   *  (A top-level `and(…)` is not this — it flattens into the shared binding table via `andChildren`.)
   *  `declares` is the branches' START∪END labels (their `as()` anchors, recursively) — the variables
   *  the bindings map must carry, because TinkerPop folds a nested connective's `matchStartLabels`/
   *  `matchEndLabels` into the parent's (`MatchStep.java:127-128`), and `getBindings` keys on that union
   *  (`:330`). It is a SUBSET of `reads`: `reads` also carries `where`-referenced labels (needed for
   *  readiness) which are NOT bindings-map keys unless some pattern also anchors them. */
  | { readonly kind: 'connective'; readonly op: 'or'; readonly branches: readonly Arg[]; readonly reads: readonly string[]; readonly declares: readonly string[] };

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
  p.kind === 'wpred' ? [p.startKey, p.otherKey] : (p.kind === 'leg' || p.kind === 'connective') ? p.reads : [p.start];

/** Every ALIAS label a branch body references — its `as()` anchors/back-edges, its `select()`/`where()`
 *  key, and any predicate operand under a `where()` (a `P.eq(label)` alias reference, NOT a `has()`
 *  value). Recurses into nested connective/leg bodies. Used to size a connective's readiness `reads`:
 *  an over-approximation is safe (a filter branch binds nothing, so every alias it mentions must be
 *  bound anyway), but it must EXCLUDE non-alias strings (edge labels, property values) or readiness
 *  would wait forever on a name that is never a binding and the whole step would fail closed. */
function aliasRefsIn(steps: readonly IRStep[], params: Record<string, any>, out: Set<string>): void {
  for (const s of steps) {
    if (s.name === 'as') for (const l of asLabelsOf(s)) out.add(l);
    if (s.name === 'select') for (const a of s.args ?? []) if (typeof a.value === 'string') out.add(a.value);
    if (s.name === 'where') {
      if (typeof s.args?.[0]?.value === 'string') out.add(s.args[0]!.value);
      const pred = s.args?.[0]?.value;
      if (isPred(pred)) for (const o of pred.operands) if (typeof o.value === 'string') out.add(o.value);
    }
    for (const a of s.args ?? []) if (isNested(a.value)) { const inner = patternSteps(a.value.nested, params); if (inner) aliasRefsIn(inner, params, out); }
  }
}

/** The START∪END labels a branch body BINDS/references via `as()` — recursively, so a nested `and`/`or`
 *  contributes its own anchors. Distinct from `aliasRefsIn`: this is ONLY the `as()` labels (the
 *  bindings-map keys per `MatchStep.getBindings`), not the `where`-referenced ones. */
function asLabelsDeep(steps: readonly IRStep[], params: Record<string, any>, out: Set<string>): void {
  for (const s of steps) {
    if (s.name === 'as') for (const l of asLabelsOf(s)) out.add(l);
    for (const a of s.args ?? []) if (isNested(a.value)) { const inner = patternSteps(a.value.nested, params); if (inner) asLabelsDeep(inner, params, out); }
  }
}

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

/** If a match ARGUMENT is a bare `or(…)` connective, return it as a `connective` Pattern; else `null`.
 *  Unlike `and`, an `or` is NOT flattened into the binding table — its branches are ALTERNATIVES, so it
 *  stays one pattern whose branches are re-classified against the bound set at run time (`branchToExpr`)
 *  and combined into one disjunctive predicate. `reads` (for readiness) is every alias the branches
 *  reference. TinkerPop replaces a match arg whose start step is an `OrStep` with a nested `MatchStep`
 *  of connective OR (`MatchStep.configureStartAndEndSteps`, `MatchStep.java:122`). */
function orConnective(a: unknown, params: Record<string, any>): Pattern | null {
  if (!isNested(a)) return null;
  const chain = patternSteps((a as { nested: unknown }).nested, params);
  if (!(chain?.length === 1 && chain[0]!.name === 'or')) return null;
  const branches = chain[0]!.args ?? [];
  if (branches.length < 2) return null;
  const reads = new Set<string>();
  const declares = new Set<string>();
  for (const b of branches) if (isNested(b.value)) { const bs = patternSteps(b.value.nested, params); if (bs) { aliasRefsIn(bs, params, reads); asLabelsDeep(bs, params, declares); } }
  return { kind: 'connective', op: 'or', branches, reads: [...reads], declares: [...declares] };
}

/** Flatten a match argument list into patterns, expanding every top-level `and(…)` connective into its
 *  children (recursively — a nested `and` flattens too) and keeping each top-level `or(…)` as one
 *  disjunctive `connective`. Each other argument classifies as one `Pattern`. Returns `null` to DECLINE
 *  the whole step (fail closed) on any unclassifiable argument. */
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
    const conn = orConnective(a.value, params);
    if (conn) { out.push(conn); continue; }
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
  const starts = patterns.flatMap((p) => (p.kind === 'wpred' || p.kind === 'connective' ? [] : [p.start]));
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
  const single = legSingle(leg, rel, labels, child, fresh);
  if (single === null) return null;
  if (single) return make.filter({ id: fresh('ml'), input: rel, channels: rel.channels, type: rel.type, pred: single });
  // A MULTI-correlation leg is a `semi`/`anti` JOIN against the fresh walk — the standalone form, one
  // relational node (`branchToExpr` reaches for the `exists`-Expr form instead, so it composes inside a
  // disjunction; `src/rel/emit.ts:404` renders BOTH to the same `[NOT] EXISTS (SELECT 1 …)` SQL).
  const cor = legCorrelated(leg, rel, labels, child, host, fresh);
  return cor && make.join({ id: fresh('mj'), left: rel, right: cor.ran.rel, join: leg.negated ? 'anti' : 'semi', on: cor.on, channels: rel.channels, type: rel.type });
}

/** A leg's existence test as a boolean `Expr` over the carrying table — the composable form the
 *  connective path (`branchToExpr`) OR/ANDs together. You cannot OR two SEMI JOINs, but you can OR two
 *  `exists` Exprs, which is the whole reason a leg is an Expr here and a `Rel` in `applyLeg`: an
 *  `or(<leg>, <leg>)` match argument is one predicate, not two joins. A single-correlation leg is its
 *  correlated predicate directly; a multi-correlation one is a correlated `[NOT] EXISTS` over the same
 *  fresh walk `applyLeg`'s join builds (`negated` ⇒ `NOT EXISTS`). */
export function legExpr(
  leg: { readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] },
  rel: Rel, labels: AliasMap, child: ChildSeam, host: IRStep, fresh: Minter,
): Expr | null {
  const single = legSingle(leg, rel, labels, child, fresh);
  if (single === null) return null;
  if (single) return single;
  const cor = legCorrelated(leg, rel, labels, child, host, fresh);
  return cor && { kind: 'exists', plan: make.filter({ id: fresh('mx'), input: cor.ran.rel, channels: cor.ran.rel.channels, type: cor.ran.rel.type, pred: cor.on }), negated: leg.negated };
}

/** The SINGLE-correlation arm shared by `applyLeg`/`legExpr`: a leg reading only its own start, whose
 *  body `child.predicate` can express (a movement/filter head over the one bound element), is that
 *  correlated predicate. `null` = the start alias is not a bound element (decline the whole leg); a
 *  present `false` (`undefined`) = "fall through to the multi-correlation form" — either the leg reads
 *  more than its start, or the body is a walk only `child.chain` can lower (a `repeat`/reducing walk),
 *  which `child.predicate` fails closed on. */
function legSingle(
  leg: { readonly negated: boolean; readonly start: string; readonly body: readonly IRStep[]; readonly reads: readonly string[] },
  rel: Rel, labels: AliasMap, child: ChildSeam, fresh: Minter,
): Expr | null | undefined {
  const startProj = aliasProjection(rel, labels, leg.start, 'last', fresh);
  if (!startProj || startProj.read.kind !== 'element') return null;
  if (leg.reads.length !== 1) return undefined;
  const subject: Subject = { kind: 'element', id: aliasIdAt(col(rel.id, startProj.entry.col), 'last'), rel, elem: startProj.read.elem };
  return child.predicate(leg.body, subject, leg.negated) ?? undefined;
}

/** The MULTI-correlation core shared by `applyLeg` (→ `semi`/`anti` join) and `legExpr` (→ `exists`
 *  Expr): a FRESH walk of the leg body (its own `V()`/`E()` source, never a re-derivation of the
 *  carrying table — `col(rel.id,…)` on both sides collapses the correlation) plus the `on` clause
 *  correlating it back on every position `legRight` bound (the start by equality, each
 *  `where(P.eq/neq(label))` at any depth as a channel). `null` to decline. */
function legCorrelated(
  leg: { readonly start: string; readonly body: readonly IRStep[] },
  rel: Rel, labels: AliasMap, child: ChildSeam, host: IRStep, fresh: Minter,
): { readonly ran: ChainRead; readonly on: Expr } | null {
  const startProj = aliasProjection(rel, labels, leg.start, 'last', fresh);
  if (!startProj || startProj.read.kind !== 'element') return null;
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
  return on ? { ran, on } : null;
}

/** A two-variable THETA clause between two already-bound ELEMENT aliases (`where('a', P.eq/neq('c'))`),
 *  as a boolean `Expr` — the same rowid compare the `wpred` pattern applies, factored out so a `where`
 *  inside an `or` branch composes. Both aliases must be elements; a scalar-alias compare is a later
 *  phase. */
function thetaExpr(keyA: string, op: 'eq' | 'neq', keyB: string, rel: Rel, labels: AliasMap, fresh: Minter): Expr | null {
  const pa = aliasProjection(rel, labels, keyA, 'last', fresh);
  const pb = aliasProjection(rel, labels, keyB, 'last', fresh);
  if (!pa || !pb || pa.read.kind !== 'element' || pb.read.kind !== 'element') return null;
  const same = eq(aliasIdAt(col(rel.id, pa.entry.col), 'last'), aliasIdAt(col(rel.id, pb.entry.col), 'last'));
  return op === 'eq' ? same : { kind: 'unary', op: 'not', arg: same };
}

/** One branch of an `or`/`and` connective as a boolean `Expr` over the binding table — the recursive
 *  core that makes a disjunction of existence tests one predicate. A branch is a filter that BINDS
 *  NOTHING; it reads only already-bound aliases. The shapes, in the order tried:
 *  - a NESTED connective (`and(…)`/`or(…)`) — recurse and combine (scenario A's
 *    `or(…, and(<back-edge>, <scalar is>))`);
 *  - a `where('a', P.eq/neq('c'))` theta, or a `where(<body>)`/`not(<body>)` existence leg;
 *  - an anchored `as(start).<body>[.as(end)]` whose `start` (and any `end`) are ALREADY BOUND:
 *    · a REDUCING-scalar back edge (`as('b').in().count().as('c')`, c a bound scalar) → `reduce(start)`
 *      (a correlated `child.scalar`) EQUALS the stored `c`;
 *    · an element back edge (`as('a').out('knows').as('b')`, b bound) → `where(P.eq(b))` rewrite, then a
 *      multi-correlation existence via `legExpr`;
 *    · a no-end movement/filter body over an element `start` → single/multi-correlation existence;
 *    · a no-end body over a SCALAR `start` (`as('c').is(P.gt(2))`) → a value predicate over the bound
 *      scalar (`child.predicate` with a scalar subject).
 *  A branch that would bind a FRESH variable (an unbound `.as(end)`) is the disjunctive-UNION regime —
 *  a later phase — and returns `null`, declining the whole connective (fail closed). */
function branchToExpr(
  branch: unknown, rel: Rel, labels: AliasMap, bound: ReadonlySet<string>,
  child: ChildSeam, host: IRStep, fresh: Minter, params: Record<string, any>,
): Expr | null {
  if (!isNested(branch)) return null;
  const steps = patternSteps(branch.nested, params);
  if (!steps || !steps.length) return null;
  const only = steps[0]!;

  if (steps.length === 1 && (only.name === 'and' || only.name === 'or'))
    return connectiveExpr(only.name, only.args ?? [], rel, labels, bound, child, host, fresh, params);

  if (steps.length === 1 && (only.name === 'where' || only.name === 'not')) {
    if (only.name === 'where') {
      const wargs = only.args ?? [];
      const pred = wargs[1]?.value;
      if (wargs.length === 2 && typeof wargs[0]!.value === 'string' && isPred(pred)
        && (pred.op === 'eq' || pred.op === 'neq') && pred.operands.length === 1 && typeof pred.operands[0]!.value === 'string')
        return thetaExpr(wargs[0]!.value, pred.op, pred.operands[0]!.value, rel, labels, fresh);
    }
    const leg = classifyLeg(only, params);
    return leg && leg.kind === 'leg' ? legExpr(leg, rel, labels, child, host, fresh) : null;
  }

  const head = steps[0]!;
  const starts = asLabelsOf(head);
  if (head.name !== 'as' || starts.length !== 1) return null;
  const start = starts[0]!;
  if (!bound.has(start)) return null;
  const tail = steps[steps.length - 1]!;
  let body: readonly IRStep[];
  if (tail.name === 'as' && steps.length >= 2) {
    const ends = asLabelsOf(tail);
    if (ends.length !== 1) return null;
    const end = ends[0]!;
    // A FRESH end is a binding branch (the disjunctive-UNION regime) — a later phase; decline.
    if (!bound.has(end)) return null;
    const inner = steps.slice(1, -1);
    const reduce = reducingEnd(inner);
    if (reduce) {
      // A REDUCING-SCALAR BACK EDGE (`as('b').in().count().as('c')`, c a bound scalar): the per-origin
      // reduction of the start EQUALS the bound scalar — `child.scalar` rooted at start (the same
      // correlated read the binding form uses), compared to the stored `c` value. A trailing `is()`
      // filter (`reduce.filtered`) would DROP the row before the compare — a later phase; decline.
      if (reduce.filtered) return null;
      const sproj = aliasProjection(rel, labels, start, 'last', fresh);
      if (!sproj || sproj.read.kind !== 'element') return null;
      const cEntry = liveAliases(labels, rel).get(end);
      if (!cEntry) return null;
      const hostR: ChildHost = { kind: 'element', id: aliasIdAt(col(rel.id, sproj.entry.col), 'last'), elem: sproj.read.elem, row: { rel, aliases: labels } };
      const produced = child.scalar(reduce.reduceBody, hostR);
      if (!produced || produced.framing.kind !== 'scalar') return null;
      return eq(produced.expr, aliasValueAt(col(rel.id, cEntry.col), 'last'));
    }
    // A bound `.as(end)` back edge is `where(P.eq(end))`, exactly the trailing-end rewrite the Pass
    // applies to a `where`/`not` arg — done HERE because the connective heads are (deliberately) not in
    // `MATCH_FILTER_HEADS`, so the bind-vs-constrain decision for an `or` branch lives in this lowering.
    body = [...inner, syn(head, 'where', [{ op: 'eq', operands: [arg(end)] }])];
  } else {
    body = steps.slice(1);
    if (!body.length || body.some((s) => s.name === 'as')) return null;
    // A SCALAR-start branch (`as('c').is(P.gt(2))`, c a bound scalar): a value predicate over the bound
    // scalar via `child.predicate` with a scalar subject. An element start falls through to `legExpr`.
    const sproj = aliasProjection(rel, labels, start, 'last', fresh);
    if (!sproj) return null;
    if (sproj.read.kind === 'value') {
      const subject = scalarSubjectOf(sproj, rel);
      return subject && child.predicate(body, subject, false);
    }
  }
  const reads = new Set<string>([start]);
  for (const s of body) {
    if (s.name !== 'where') continue;
    const pred = s.args?.[0]?.value;
    if (isPred(pred)) for (const o of pred.operands) if (typeof o.value === 'string') reads.add(o.value);
  }
  return legExpr({ negated: false, start, body, reads: [...reads] }, rel, labels, child, host, fresh);
}

/** A bound SCALAR alias as a `child.predicate` subject — its stored `v` value plus the `SubjectType`
 *  restored from the alias's recorded scalar type (a per-row type reads back its `t` tag column, the
 *  same mapping `values(k).is(P)` uses over a stream). `null` when the alias is not a value. */
function scalarSubjectOf(sproj: NonNullable<ReturnType<typeof aliasProjection>>, rel: Rel): Subject | null {
  if (sproj.read.kind !== 'value') return null;
  const value = aliasValueAt(col(rel.id, sproj.entry.col), 'last');
  const t = sproj.read.type;
  const vtype = t.kind === 'perRow' ? aliasTypeAt(col(rel.id, sproj.entry.col), 'last') : undefined;
  const type: SubjectType = t.kind === 'static' ? { kind: 'static', type: t.type, text: t.text }
    : vtype ? { kind: 'perRow', vtype } : SUBJECT_UNKNOWN;
  return { kind: 'scalar', value, rel, type, ...(vtype ? { vtype } : {}) };
}

/** A whole `and(…)`/`or(…)` connective as one boolean `Expr`: every branch to an `Expr`, folded with
 *  the connective's operator. Fail closed — one unclassifiable branch declines the whole connective. */
function connectiveExpr(
  op: 'and' | 'or', branches: readonly Arg[], rel: Rel, labels: AliasMap, bound: ReadonlySet<string>,
  child: ChildSeam, host: IRStep, fresh: Minter, params: Record<string, any>,
): Expr | null {
  let acc: Expr | undefined;
  for (const b of branches) {
    const e = branchToExpr(b.value, rel, labels, bound, child, host, fresh, params);
    if (!e) return null;
    acc = op === 'and' ? and(acc, e) : or(acc, e);
  }
  return acc ?? null;
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

    if (p.kind === 'connective') {
      // A DISJUNCTIVE FILTER — every branch is an existence/back-edge/theta test over already-bound
      // variables, so the connective is one boolean predicate over the binding table (readiness has
      // ensured every alias it reads is bound). A branch that would bind a fresh variable declines.
      const clause = connectiveExpr(p.op, p.branches, rel, labels, bound, child, step, fresh, params);
      if (!clause) return null;
      rel = make.filter({ id: fresh('mo'), input: rel, channels: rel.channels, type: rel.type, pred: clause });
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
    p.kind === 'binding' ? [p.start, p.end] : p.kind === 'constraint' ? [p.start]
      // A connective's branches ANCHOR variables the bindings map must carry (`b` in
      // `or(as('a').out('knows').as('b'), …)`) even though the connective binds no NEW column — those
      // labels are already live (pre-bound or bound by a sibling pattern), and TinkerPop's `getBindings`
      // keys on the folded start∪end union. A `wpred` only references already-declared aliases → [].
      : p.kind === 'connective' ? p.declares : [];
  for (const p of patterns) for (const l of declaredOf(p)) if (!declared.includes(l)) declared.push(l);
  // A 0- or 1-variable pattern's bindings map is NOT a `select()`: `select('a')` yields the VALUE, not
  // the `{a: …}` one-key map TinkerPop emits (a `project('a').by(select('a'))`, as `gql.ts` builds).
  // Decline rather than emit the bare value — fail closed against a wrong answer; a later phase.
  if (declared.length < 2) return null;
  const bindings = selectKeys(syn(step, 'select', declared), rel, labels, child, source, fresh);
  return bindings && { ...bindings, aliases: labels };
}
