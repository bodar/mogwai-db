import { isNested } from '../../../gremlin/frontend.ts';
import { and, col, compilerInt, compilerNull, eq, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import { decorrelate } from '../../../rel/decorrelate.ts';
import { atMostOneRow, exactlyOneRow } from '../../../rel/bounds.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta } from '../../../rel/types.ts';
import { exprHasSubquery, forEachRel, isSelfContained, relExprs, substRelId } from '../../../rel/walk.ts';
import { columnIsStored } from '../../../rel/copies.ts';
import { withChannel, type Channel, type ChannelRole } from '../../../channels.ts';
import type { AliasMap } from '../../alias.ts';
import { nondeterministic, type IRStep } from '../../ir/step.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { meta, payloadCols, rowNumberWindow, typeOf, type Minter } from '../build.ts';
import { framingCols, type RelFraming } from '../framing.ts';
import { continueAs, dropPath } from '../lower.ts';

import { byField, isProductiveBy, modulations, type ByField } from '../modulator.ts';
import { appendValuePosition, extendPath, pathCarried } from '../path.ts';
import { recordOf } from '../record.ts';
import type { Declines } from '../../unsupported.ts';
import { bodyOf, ENCOUNTER, inBody, type ChainCtx, type Tail } from './chain.ts';
import { childSeam, defaultCollation, perOriginWindow, reductionHost } from './reduction.ts';

// SCOPED RELATIONS — a child-taking host as a CONNECTOR, not a route (`docs/2026-11-15-compositional-coverage-plan.md`
// §2, S1–S4). Every host here is the same three moves, and only the third differs:
//
//   1. SCOPE the input (S1): number its rows — `ROW_NUMBER()`, which needs no rowid, so EVERY framing has a
//      scope key (an element, a value, a list, a map, a record, a path);
//   2. lower the body through `continueAs` — the fold the ROOT uses — over ONE correlated row of the input
//      (the traverser TinkerPop hands the child, `TraversalUtil.apply`), then DECORRELATE it against the scoped
//      input (`src/rel/decorrelate.ts`): an ordinary relation keyed by the scope key. Every barrier in the body
//      is scoped by the key by construction (S2) — an `Aggregate` grouped by it, a `Window` partitioned by it —
//      and every enclosing scope's key rides as one more key column when THAT scope decorrelates the plan this
//      one is nested in, so the scope STACK is the set of key columns, never a route per depth. A seeded barrier
//      over an empty scope keeps its seed (S3) because a scalar aggregate LEFT JOINs the domain and takes its
//      value over zero rows — the correlated plan's own SQL answer, kept exactly;
//   3. RECONNECT on the key by the host's policy (S4) — one row per host in `CONNECTORS`, keyed by step name.
//
// THE ladder of specialised correlated routes (`scalarChild`, `correlatedReduce`, `flatMapRejoin`, …) is kept
// as the `correlatedChild` FAST PATH: on (the default) it is tried first and this is the fallback where it
// declines; off, this is tried first and the ladder is the fallback. Either way the SUPPORTED set is the
// union of the two, so L5's per-switch differential compares the two lowerings wherever both answer.

/** The channels a child body does NOT inherit from its host row. A child is handed ONE traverser at bulk 1
 *  (`TraversalUtil.apply`, `LocalStep.java:80-88`), so the host's multiplicity, its position in the host
 *  stream and its scope keys stay with the host — the connector puts them back from the scoped input. */
const HOST_ONLY: ReadonlySet<ChannelRole> = new Set<ChannelRole>(['bulk', 'encounter', 'origin', 'branchKey']);

interface Scope {
  /** The input with its scope key — computed ONCE (a fenced CTE where it is self-contained, else numbered
   *  deterministically), because the body's domain and the reconnect both read it. */
  readonly scoped: Rel;
  readonly key: string;
}

/**
 * S1 — THE SCOPE KEY, over any framing: `ROW_NUMBER()`. Two reads of the scoped input (the reconnect, and the
 * domain inside the decorrelated body) must agree on which row holds which key, so the numbering is computed
 * once: a FENCED materialization where the input is self-contained, and otherwise (a scope inside a correlated
 * body, which no CTE can hold) a numbering ORDERED BY EVERY COLUMN — rows that tie on every column are
 * interchangeable, so both reads pair each key with the same row content.
 */
function scope(rel: Rel, fresh: Minter): Scope {
  const key = fresh('sk') as string;
  const selfContained = isSelfContained(rel);
  const order = selfContained ? [] : rel.type.cols.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const }));
  const numbered = rowNumberWindow(rel, key, rel.channels, { partitionBy: [], orderBy: order }, fresh);
  const scoped = selfContained
    ? make.materialize({ id: fresh('scm'), input: numbered, channels: numbered.channels, type: numbered.type, fenced: true })
    : numbered;
  return { scoped, key };
}

/** ONE correlated row of the scoped input — the traverser the child body starts from: its payload and every
 *  channel the body may read (labels, path, sack), minus the host-only ones. */
function seedRow(rel: Rel, scoped: Rel, fresh: Minter, positioned: boolean): Rel {
  // ONE traverser has a trivial emission order — position 0 — the one `positioned` gives any one-row input.
  // It is carried only where the body reads a POSITION from its start (`tail`, the last n, which has no
  // answer without one): a position the body does not need would order every collect in it by emission
  // (`fold`'s members) where the correlated lowering orders them by value, and the two routes of one
  // connector site must agree on a value they each pick deterministically.
  const own = rel.channels.filter((channel) => !HOST_ONLY.has(channel.role));
  const channels = positioned ? withChannel(own, ENCOUNTER) : own;
  const named = (name: string): ColMeta => rel.type.cols.find((column) => column.name === name)!;
  const cols = [...payloadCols(rel), ...channels.map((channel) => (channel === ENCOUNTER ? meta(ENCOUNTER.col, 'int') : named(channel.col)))];
  const unit = make.values({ id: fresh('su'), channels: [], type: typeOf(meta('n', 'int')), rows: [[compilerInt(1)]] });
  return make.project({
    id: fresh('ss'), input: unit, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, column.name === ENCOUNTER.col ? compilerInt(0) : col(scoped.id, column.name)] as const),
  });
}

/** A body lowered over one host row and decorrelated against the scope: its rows keyed by `keyCol`. */
interface ScopedBody {
  readonly rel: Rel;
  readonly keyCol: string;
  readonly tail: Tail;
}

/** Step 2: the body, lowered as the root lowers a chain, then keyed by the scope. `null` declines. */
function scopedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, sc: Scope, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read',
): ScopedBody | null {
  // Two body forms stay the ladder's, each for a reason about the QUERY TEXT:
  // - a random DRAW (`sample`/`coin`/`shuffle`, at any depth) — the decorrelated body draws over every scope
  //   at once, and a draw in a part that does not read the host would be one draw SHARED by every scope,
  //   the exact defect the ladder's `shared-draw` decline names;
  // - a RE-SOURCE (`V()`/`E()`) anywhere in the body — whether it is the uncorrelated read the ladder
  //   answers once, or a re-source under a host value that may be absent (`resource-under-absent`, an
  //   explained decline), is the ladder's decision, and the connector must not answer around it.
  if (nondeterministic(body, ctx.params) || someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true)) return null;
  const seed = seedRow(rel, sc.scoped, fresh, someStepDeep(body, ctx.params, (s) => s.name === 'tail'));
  // A child traversal BEGINS here, handed one traverser at a time (`ChainCtx.traversal`); it is a body, so
  // the movement collapse is off (`inBody`), and it has no per-origin domain of its own — its barriers are
  // scoped by decorrelation, not by an origin channel.
  // An EXISTENCE gate reads no order from its body (`ChainCtx.bodyOrder` 'free'); a FIRST-per-scope reconnect
  // reads the body's emission order ('read') — `map(union(a, b))` is `a`'s first.
  const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: body, rooted: false }, originDomain: undefined, ...(order ? { bodyOrder: order } : {}) };
  const tail = continueAs(seed, framing, body, 0, false, bodyCtx, fresh, labels);
  // A body with EFFECTS is not a read the connector may evaluate per scope.
  if (!tail || tail.effects?.length) return null;
  const keyed = decorrelate(tail.rel, sc.scoped, sc.key, fresh);
  return keyed && { rel: keyed.rel, keyCol: keyed.keyCol, tail };
}

/**
 * Step 2, CORRELATED: the body lowered over one row of `rel` itself and left correlated to it — no scope key,
 * no decorrelation. Where the reconnect is an EXPRESSION of the host row (an existence test), SQLite runs it as
 * the nested-loop join it is built for: one index seek per host row. Unnesting a dependent join pays where the
 * engine has a set-oriented join to hand it; SQLite's join IS a nested loop, so a correlated body the planner
 * can seek is already the decorrelated plan's best physical form. The decorrelated body (`scopedBody`) is the
 * fallback where the correlated plan cannot sit in a subquery: a `Recursive` (a walk is a CTE; the decorrelator
 * keys it instead).
 */
function correlatedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read',
): Tail | null {
  if (nondeterministic(body, ctx.params) || someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true)) return null;
  const seed = seedRow(rel, rel, fresh, someStepDeep(body, ctx.params, (s) => s.name === 'tail'));
  // The body re-reads every host column its seed carries, and a correlated read SPELLS that column inside
  // the subquery — a COMPUTED one (a label's `jsonb_array`, a path) would be computed again per inner row,
  // where the decorrelated form reads it once off the scoped input. A carried column is there to be read
  // (`copyRepeatsWork`'s rule), so any computed one keeps the body decorrelated.
  if (!seed.type.cols.every((column) => column.name === ENCOUNTER.col || columnIsStored(rel, column.name))) return null;
  const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: body, rooted: false }, originDomain: undefined, ...(order ? { bodyOrder: order } : {}) };
  const tail = continueAs(seed, framing, body, 0, false, bodyCtx, fresh, labels);
  if (!tail || tail.effects?.length) return null;
  let walk = false;
  forEachRel(tail.rel, (r) => { if (r.kind === 'recursive') walk = true; });
  return walk ? null : tail;
}

/** A correlated body as an `EXISTS` operand, projecting its FIRST column alone: an `EXISTS` reads no value, so
 *  the body's other columns (labels, path) are not spelled; a column rather than a literal keeps an aggregate
 *  block an aggregate query (the reason `childPredicate`'s probe gives, `filter.ts`). */
function existenceProbe(tail: Tail, fresh: Minter): Rel {
  return make.project({
    id: fresh('sp'), input: tail.rel, channels: [], type: typeOf(meta('one', 'any', true)),
    exprs: [['one', col(tail.rel.id, tail.rel.type.cols[0]!.name)]],
  });
}

/**
 * The FIRST row of a CORRELATED body, as one correlated scalar subquery per payload column — `ORDER BY` the
 * body's emission order then its payload, `LIMIT 1`: the same deterministic pick `firstPerScope` makes per
 * key (`defaultCollation`), made per host row by SQLite's nested loop instead of by a window over every key.
 *
 * Each column's subquery evaluates the body again (SQL has no row-valued scalar subquery), so this is a COST
 * rule on the body's columns: ONE column always (no repetition), TWO — a value and its per-row type tag — only
 * over a FLAT body (no subplan of its own), so the repeat is one more index seek and never compounds with
 * nesting (`k` columns per level would be `k^depth` spellings). Anything wider is the decorrelated window's.
 */
function correlatedFirst(tail: Tail, names: readonly string[], fresh: Minter): ReadonlyMap<string, Expr> | null {
  const payload = names.map((name) => tail.rel.type.cols.find((column) => column.name === name));
  if (!payload.length || payload.length > 2 || payload.some((column) => !column)) return null;
  let nested = false;
  forEachRel(tail.rel, (r) => { if (relExprs(r).some(exprHasSubquery)) nested = true; });
  if (payload.length > 1 && nested) return null;
  // A body of at most one row (a reducer, a record over the one seed row) IS its first row: no sort. A wider
  // body is sorted by its payload, and a payload that is itself a correlated subquery may not be a sort term:
  // SQLite resolves an ORDER BY term's subquery without the scopes beyond its own query (measured, bun:sqlite
  // 3.51: `SELECT (SELECT (SELECT t.x) v FROM (VALUES (1)) ORDER BY (SELECT t.x) LIMIT 1) FROM t` is "no such
  // column: t.x"), so such a body stays decorrelated.
  const single = atMostOneRow(tail.rel);
  if (!single && nested) return null;
  const first = single ? tail.rel : make.limit({
    id: fresh('cl'), input: make.sort({ id: fresh('cs'), input: tail.rel, channels: tail.rel.channels, type: tail.rel.type, terms: defaultCollation(tail.rel) }),
    channels: tail.rel.channels, type: tail.rel.type, count: compilerInt(1),
  });
  return new Map((payload as ColMeta[]).map((column) => [column.name, {
    kind: 'scalar',
    plan: make.project({ id: fresh('cv'), input: first, channels: [], type: typeOf({ ...column, nullable: true }), exprs: [[column.name, col(first.id, column.name)]] }),
  } as Expr]));
}

/** The scoped input reprojected to the input's own columns (the key shed). */
function unscoped(rows: Rel, rel: Rel, fresh: Minter): Rel {
  return make.project({
    id: fresh('sx'), input: rows, channels: rel.channels, type: rel.type,
    exprs: rel.type.cols.map((column) => [column.name, col(rows.id, column.name)] as const),
  });
}

/** The FIRST row per scope of a keyed body, its payload renamed so it can sit beside the host's columns:
 *  `ROW_NUMBER() … = 1` partitioned by the key (`perOriginWindow`, Calcite's per-domain top-N), ordered by the
 *  body's own emission order, then its payload — one deterministic member of what the reference allows. */
function firstPerScope(
  body: ScopedBody, names: readonly string[], fresh: Minter,
): { readonly rel: Rel; readonly key: string; readonly renamed: ReadonlyMap<string, string> } {
  const first = perOriginWindow(body.rel, col(body.rel.id, body.keyCol), [], { scope: 'global', offset: 0, limit: 1 }, fresh);
  const renamed = new Map(names.map((name) => [name, fresh('sf') as string]));
  const key = fresh('sfk') as string;
  const typed = (name: string): ColMeta => ({ ...first.type.cols.find((column) => column.name === name)!, nullable: true });
  const rel = make.project({
    id: fresh('sfp'), input: first, channels: [],
    type: typeOf({ ...typed(body.keyCol), name: key }, ...names.map((name) => ({ ...typed(name), name: renamed.get(name)! }))),
    exprs: [[key, col(first.id, body.keyCol)], ...names.map((name) => [renamed.get(name)!, col(first.id, name)] as const)],
  });
  return { rel, key, renamed };
}

/** The ONE nested-traversal argument of a single-body host, or `null`. */
function singleBody(step: IRStep, ctx: ChainCtx): readonly IRStep[] | null {
  if (step.modulators?.length || step.optionArms || step.args.length !== 1) return null;
  const nested = step.args[0]!.value;
  if (!isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params, ctx.sideEffects);
  return body?.length ? body : null;
}

interface HostSite {
  readonly step: IRStep;
  readonly rel: Rel;
  readonly framing: RelFraming;
  readonly steps: readonly IRStep[];
  readonly at: number;
  readonly bulked: boolean;
  readonly ctx: ChainCtx;
  readonly fresh: Minter;
  readonly labels: AliasMap;
}

type Connector = (site: HostSite) => Tail | null;

/**
 * `where(b)` / `filter(b)` — a SEMI-join on the scope key; `not(b)` the ANTI-join. `TraversalFilterStep` keeps a
 * traverser iff its child has a next (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TraversalFilterStep.java`),
 * `NotStep` iff it has none (`…/step/filter/NotStep.java`). A `where()` whose body names scope variables is a
 * `WhereTraversalStep`, rewritten before lowering into the select/`where(P.eq)` forms this lowers like any
 * other body (`rewriteWhereVariables`, `ir/strategies.ts`). The traverser itself is untouched — its channels,
 * its path, its labels are the host's (a label bound in the body does not escape a filter).
 */
const existence = (negated: boolean): Connector => (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const bodies = step.name === 'and'
    ? step.args.every((arg) => isNested(arg.value)) && !step.modulators?.length && !step.optionArms && step.args.length
      ? step.args.map((arg) => bodyOf((arg.value as { nested: unknown }).nested, ctx.params, ctx.sideEffects))
      : null
    : [singleBody(step, ctx)];
  if (!bodies || bodies.some((b) => !b?.length)) return null;
  // Every body correlated: the semi/anti-join is an `EXISTS` over the body itself, read against the host row
  // (the dependent join kept as such — `correlatedBody`); `and`'s bodies are a conjunction of them.
  const correlated = (bodies as (readonly IRStep[])[]).map((body) => correlatedBody(body, rel, framing, ctx, fresh, labels, 'free'));
  if (correlated.every((tail) => tail)) {
    const pred = (correlated as Tail[]).map((tail): Expr => ({ kind: 'exists', plan: existenceProbe(tail, fresh), negated }))
      .reduce((all, one) => and(all, one));
    return continueAs(make.filter({ id: fresh('sj'), input: rel, channels: rel.channels, type: rel.type, pred }), framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  const sc = scope(rel, fresh);
  let kept = sc.scoped;
  // `and(b1, b2, …)` is every body's semi-join in turn (`AndStep`, a `ConnectiveStep` over its children).
  for (const body of bodies as (readonly IRStep[])[]) {
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'free');
    if (!keyed) return null;
    kept = make.join({
      id: fresh('sj'), left: kept, right: keyed.rel, join: negated ? 'anti' : 'semi', channels: kept.channels, type: kept.type,
      on: eq(col(kept.id, sc.key), col(keyed.rel.id, keyed.keyCol)),
    });
  }
  return continueAs(unscoped(kept, rel, fresh), framing, steps, at + 1, bulked, ctx, fresh, labels);
};

/**
 * `map(b)` — the FIRST result per scope, INNER-joined back: `TraversalMapStep` emits `traverser.split(next)` when
 * the child has one and drops the traverser when it has none
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53`).
 * The payload is the body's; every channel is the host's — `split` keeps the pre-child traverser's labels, sack
 * and bulk, and EXTENDS its path by exactly the emitted value (`…/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71`).
 * Which result is "first" in an unordered body is the body's emission order, then its payload — the same
 * deterministic pick a per-origin `limit(1)` makes (`defaultCollation`).
 */
const firstInner: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const body = singleBody(step, ctx);
  if (!body) return null;
  const hostChannel = (channel: Channel): ColMeta => rel.type.cols.find((column) => column.name === channel.col)!;
  let mapped: Rel;
  let outFraming: RelFraming;
  const tail = correlatedBody(body, rel, framing, ctx, fresh, labels, 'read');
  const first = tail && framingCols(tail.framing) ? correlatedFirst(tail, payloadCols(tail.rel).map((column) => column.name), fresh) : null;
  if (tail && first) {
    // The dependent join kept: each payload column the body's first row, read per host row. A host row
    // whose body is EMPTY is dropped (`TraversalMapStep`) — by the lead column's nullness where the body
    // never emits a null there, else by an `EXISTS` of the body.
    outFraming = tail.framing;
    const bodyPayload = payloadCols(tail.rel);
    const lead = bodyPayload[0]!;
    const gated = lead.nullable
      ? make.filter({ id: fresh('sme'), input: rel, channels: rel.channels, type: rel.type, pred: { kind: 'exists', plan: existenceProbe(tail, fresh), negated: false } })
      : rel;
    const projected = make.project({
      id: fresh('smp'), input: gated, channels: rel.channels,
      type: typeOf(...bodyPayload.map((column) => ({ ...column, nullable: true })), ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, gated === rel ? first.get(column.name)! : substRelId(first.get(column.name)!, rel.id, gated.id)] as const),
        ...rel.channels.map((channel) => [channel.col, col(gated.id, channel.col)] as const)],
    });
    const present = lead.nullable ? projected : make.filter({
      id: fresh('smf'), input: projected, channels: projected.channels, type: projected.type,
      pred: { kind: 'binary', op: 'is not', left: col(projected.id, lead.name), right: compilerNull() },
    });
    mapped = make.project({
      id: fresh('smq'), input: present, channels: rel.channels, type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, col(present.id, column.name)] as const),
        ...rel.channels.map((channel) => [channel.col, col(present.id, channel.col)] as const)],
    });
  } else {
    const sc = scope(rel, fresh);
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read');
    if (!keyed) return null;
    outFraming = keyed.tail.framing;
    if (!framingCols(outFraming)) return null;
    const names = payloadCols(keyed.tail.rel).map((column) => column.name);
    const firstRow = firstPerScope(keyed, names, fresh);
    const joined = make.join({
      id: fresh('smj'), left: sc.scoped, right: firstRow.rel, join: 'inner', channels: sc.scoped.channels,
      type: typeOf(...sc.scoped.type.cols, ...firstRow.rel.type.cols),
      on: eq(col(sc.scoped.id, sc.key), col(firstRow.rel.id, firstRow.key)),
    });
    const bodyPayload = payloadCols(keyed.tail.rel);
    mapped = make.project({
      id: fresh('smp'), input: joined, channels: rel.channels,
      type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [
        ...bodyPayload.map((column) => [column.name, col(joined.id, firstRow.renamed.get(column.name)!)] as const),
        ...rel.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const),
      ],
    });
  }
  // The emitted value extends the path (`split`) — an element by its id, a value as a value position; any
  // other object has no position this path can append, so the path is dropped and a later read declines.
  const pathed = !pathCarried(mapped) ? mapped
    : outFraming.kind === 'elements' ? extendPath(mapped, { kind: 'element', elem: outFraming.elem, id: col(mapped.id, 'id') }, fresh, ctx.demandsPathLabels)
      : outFraming.kind === 'scalar' && mapped.type.cols.some((column) => column.name === 'v') ? appendValuePosition(mapped, outFraming.type, fresh)
        : dropPath(mapped, fresh);
  return continueAs(pathed, outFraming, steps, at + 1, bulked, ctx, fresh, labels);
};

/**
 * `project(k…).by(b)…` — each child `by()` the FIRST result per scope, LEFT-joined back, one join per `by()`:
 * `ProjectStep.map` puts a key only where its `by()` is productive
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:64-67`),
 * so an unmatched scope leaves the field absent — the record's own `optional` field, read by value nullness as
 * every other optional field is. A `by()` that is not a child traversal (a key, a token, `select`) is the
 * record builder's own, over the joined row.
 *
 * `ProjectStep` is a MAP step, so the record is a new object on the traverser — one no value position of a
 * carried path can hold. The path is DROPPED after it, the idiom every child result with no position uses
 * (`childResultPath`): a body may read the host's path, and a later `path()` declines rather than answer a
 * history with a step missing.
 */
const recordLeft: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.optionArms) return null;
  const child = childSeam(ctx, fresh);
  const keys = step.args.length;
  const bys = modulations(step, keys, child);
  if (!bys) return null;
  const host = (from: Rel) => (framing.kind === 'elements' || framing.kind === 'scalar' ? reductionHost(from, framing, labels) : null);
  const ownHost = host(rel);
  // The scope is minted only once a slot needs it.
  let sc: Scope | undefined;
  // Which `by()` slots this connector answers: a CHILD body the ladder's own field cannot answer (the fast
  // path on), or every child body it can lower (off). Decided per slot, so one unanswerable `by()` does not
  // cost the others their fast path. A slot's ring position is `index % bys.length` (`TraversalRing`).
  const owned = new Map<number, { readonly first: ReturnType<typeof firstPerScope>; readonly framing: RelFraming }>();
  // A slot whose body stays CORRELATED: its first row read per host row (`correlatedFirst`), no join at all.
  const correlated = new Map<number, { readonly exprs: ReadonlyMap<string, Expr>; readonly framing: RelFraming; readonly total: boolean }>();
  let joined: Rel = rel;
  for (let slot = 0; slot < bys.length; slot++) {
    const by = bys[slot]!;
    if (by.key.kind !== 'child' || by.order !== undefined) continue;
    if (ctx.correlatedChild && byField(step, by, ownHost, framing, (name) => col(rel.id, name), ctx.source, fresh, child)) continue;
    const tail = correlatedBody(by.key.body, rel, framing, ctx, fresh, labels, 'read');
    const fieldCols = tail && framingCols(tail.framing);
    const exprs = tail && fieldCols && correlatedFirst(tail, fieldCols.map((column) => column.name), fresh);
    if (tail && exprs) { correlated.set(slot, { exprs, framing: tail.framing, total: exactlyOneRow(tail.rel) }); continue; }
    const scoped = sc ??= scope(rel, fresh);
    if (joined === rel) joined = scoped.scoped;
    const keyed = scopedBody(by.key.body, rel, framing, scoped, ctx, fresh, labels, 'read');
    const cols = keyed && framingCols(keyed.tail.framing);
    if (!keyed || !cols || cols.some((column) => !keyed.tail.rel.type.cols.some((c) => c.name === column.name))) {
      if (ctx.correlatedChild) return null;
      continue;
    }
    const first = firstPerScope(keyed, cols.map((column) => column.name), fresh);
    joined = make.join({
      id: fresh('spj'), left: joined, right: first.rel, join: 'left', channels: joined.channels,
      type: typeOf(...joined.type.cols, ...first.rel.type.cols),
      on: eq(col(joined.id, scoped.key), col(first.rel.id, first.key)),
    });
    owned.set(slot, { first, framing: keyed.tail.framing });
  }
  // No slot a child this connector owns: the record is the builder's own over the host row, as the ladder's
  // is — only the path rule below differs.
  const over = joined;
  const fieldFor = (slot: number): ByField | undefined => {
    const kept = correlated.get(slot);
    // A correlated field reads the host row, which every relation the joins built still carries by name.
    if (kept) return {
      exprs: framingCols(kept.framing)!.map((column) => [column.name, over === rel ? kept.exprs.get(column.name)! : substRelId(kept.exprs.get(column.name)!, rel.id, over.id)] as const),
      framing: kept.framing,
      // A body of exactly one row always yields the field — it is never absent, so never optional.
      optional: !kept.total && !isProductiveBy(step),
    };
    const field = owned.get(slot);
    if (!field) return undefined;
    return {
      exprs: framingCols(field.framing)!.map((column) => [column.name, col(over.id, field.first.renamed.get(column.name)!)] as const),
      framing: field.framing,
      // `ProductiveByStrategy` keeps the key (as null) where the body has no result; otherwise it is absent.
      optional: !isProductiveBy(step),
    };
  };
  const record = recordOf(over, host(over), framing, step, child, ctx.source, fresh, fieldFor);
  if (!record) return null;
  return continueAs(dropPath(record.rel, fresh), { kind: 'record', fields: record.fields }, steps, at + 1, bulked, ctx, fresh, labels);
};

/** THE CONNECTOR TABLE — one row per host, keyed by step name (§2 S4). */
const CONNECTORS: ReadonlyMap<string, Connector> = new Map<string, Connector>([
  ['where', existence(false)],
  ['filter', existence(false)],
  ['and', existence(false)],
  ['not', existence(true)],
  ['map', firstInner],
  ['project', recordLeft],
]);

/** Is the ladder lowering THIS connector site right now (`ChildStrategy.ladderAt`)? Then a tail must not hand
 *  it back to `continueAs`. */
export const atLadder = (ctx: ChainCtx, steps: readonly IRStep[], at: number): boolean =>
  ctx.ladderAt?.steps === steps && ctx.ladderAt.at === at;

/** Is `step` a site a connector may own? The cheap gate a tail loop asks before yielding to `continueAs`. */
export const connectorSite = (step: IRStep | undefined): boolean =>
  !!step && CONNECTORS.has(step.name) && (step.name === 'project' || step.args.some((arg) => isNested(arg.value)));

/**
 * The dispatch at a connector site: the ladder (the `correlatedChild` fast path) and the connector, in the order
 * the switch names, each the other's fallback. `undefined` where `steps[at]` is not a connector site.
 */
export function scopedHost(
  rel: Rel, framing: RelFraming, steps: readonly IRStep[], at: number, bulked: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap, ladder: (ctx: ChainCtx) => Tail | null,
): Tail | null | undefined {
  const step = steps[at];
  if (!connectorSite(step)) return undefined;
  const connector = CONNECTORS.get(step!.name)!;
  const scoped = (under: ChainCtx): Tail | null => connector({ step: step!, rel, framing, steps, at, bulked, ctx: under, fresh, labels });
  const routes = ctx.correlatedChild ? [ladder, scoped] : CONNECTOR_ONLY ? [scoped] : [scoped, ladder];
  // Each route records its decline reasons into its OWN sink (`Declines.fork`): the reasons of the route that
  // answered are kept, and a route that declined while the other answered leaves none — so which route is
  // tried first (the switch) changes the plan, never whether the traversal compiles.
  const tried: Declines[] = [];
  for (const route of routes) {
    const sink = ctx.declines.fork();
    const tail = route({ ...ctx, declines: sink });
    if (tail) { ctx.declines.adopt(sink); return tail; }
    tried.push(sink);
  }
  for (const sink of tried) ctx.declines.adopt(sink);
  return null;
}

/**
 * A MEASUREMENT knob, never a product setting: `MOGWAI_CONNECTOR_ONLY=1` with the switch OFF takes the ladder
 * fallback away at a connector site, so the depth curve and the host-closure table can read what the general
 * path answers ALONE (the plan's Phase 2 G2 measurement). Read once; absent outside Bun/Node.
 */
export const CONNECTOR_ONLY: boolean = typeof process !== 'undefined' && process.env?.MOGWAI_CONNECTOR_ONLY === '1';

