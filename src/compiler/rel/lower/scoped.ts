import { isNested } from '../../../gremlin/frontend.ts';
import { and, col, compilerInt, compilerNull, eq, isNot, or, type Expr } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import { decorrelate } from '../../../rel/decorrelate.ts';
import { positionKeys } from '../../../rel/position.ts';
import { atMostOneRow, exactlyOneRow } from '../../../rel/bounds.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { ColMeta, RelId } from '../../../rel/types.ts';
import { exprHasSubquery, forEachRel, isSelfContained, relExprs, rewriteExpr, substRelId } from '../../../rel/walk.ts';
import { columnIsStored, spelledOuterColumns } from '../../../rel/copies.ts';
import { withChannel, type Channel, type ChannelRole } from '../../../channels.ts';
import type { AliasMap } from '../../alias.ts';
import type { ChildHost, ChildValue } from '../child.ts';
import { nondeterministic, type IRStep } from '../../ir/step.ts';
import type { ListOf, MapOf } from '../../../sql/kernel/render.ts';
import { groupKeyTerms, isValueBarrier, keyedValuesMap, mapHoldsRowids, mapNodePayload } from '../map.ts';
import { selfDescribingList } from '../list.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { CONNECTOR_HOSTS } from '../../ir/analyze.ts';
import { firstArrival, listNode, mapNode, meta, payloadCols, rowNumberWindow, typeOf, type Minter } from '../build.ts';
import { framingCols, type RecordField, type RelFraming } from '../framing.ts';
import { branchOrderOwed, continueAs, edgeFeedsOtherV, dropEncounter, dropPath, freezeParent, mintBranchOrder, positioned } from '../lower.ts';
import { chooseArms, coalesceArms, ensureBulk, isReductionArm, mergeArms, optionalArms, reconcileCollapsed, unionArms, type RoutedCondition } from './branch.ts';

import { byField, byNode, isProductiveBy, memberNodeOf, modulations, productivityFilter, type ByField, type Modulation } from '../modulator.ts';
import { appendValuePosition, extendPath, pathCarried } from '../path.ts';
import { recordOf, recordToMap } from '../record.ts';
import type { Declines } from '../../unsupported.ts';
import { bodyOf, ENCOUNTER, encounterOf, FROM_V, inBody, NO_ALIASES, type ChainCtx, type Tail } from './chain.ts';
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
//      The rows are built from a few generic reconnect primitives: an existence join (semi/anti), the REJOIN
//      (`rejoin`: every result or the first per scope, under the `split` or `forward` traverser policy), a
//      PRIORITY over arms (each arm's host anti-joined on every earlier arm's key), by() VALUES landed as join
//      columns for the host's own lowering to read (`landValues`, S5), and a POOL whose scope is a group key
//      rather than a traverser (`pooledGroup`).
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
function scope(rel: Rel, fresh: Minter, asChannel = false): Scope {
  const key = fresh('sk') as string;
  const selfContained = isSelfContained(rel);
  const order = selfContained ? [] : rel.type.cols.map((column) => ({ expr: col(rel.id, column.name), dir: 'asc' as const }));
  const window = rowNumberWindow(rel, key, rel.channels, { partitionBy: [], orderBy: order }, fresh);
  // `asChannel`: the key rides as a CHANNEL (an enclosing scope key, `branchKey`) rather than a payload column,
  // for a host whose own lowering carries the scoped rows onward (`chooseRoute`) — every tail carries a channel.
  const keyChannel: Channel = { col: key, role: 'branchKey' };
  const channels = asChannel ? withChannel(rel.channels, keyChannel) : rel.channels;
  const cols = [...payloadCols(rel), ...channels.map((channel) => window.type.cols.find((column) => column.name === channel.col)!)];
  const numbered = asChannel
    ? make.project({ id: fresh('skc'), input: window, channels, type: typeOf(...cols), exprs: cols.map((column) => [column.name, col(window.id, column.name)] as const) })
    : window;
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

/**
 * The body lowered through `continueAs` — the fold the ROOT uses — over ONE row of the host (read off `from`:
 * the host itself, or its scoped copy). A child traversal BEGINS here, handed one traverser at a time
 * (`ChainCtx.traversal`); it is a body, so the movement collapse is off (`inBody`), and it has no per-origin
 * domain of its own — its barriers are scoped by the connector, not by an origin channel.
 *
 * An EXISTENCE gate reads no order from its body (`ChainCtx.bodyOrder` 'free'); a FIRST-row reconnect reads
 * the body's EMISSION order ('read'): `TraversalMapStep` keeps `mapTraversal.next()`, the child's first
 * traverser in its own iteration order
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53`,
 * `…/traversal/util/TraversalUtil.java` `apply`) — `map(union(a, b))` is `a`'s first, `map(values(k))` the
 * first-stored value. So a body that may yield SEVERAL rows and carries no position yet is lowered from a
 * POSITIONED seed: its hops then number their rows in storage order (the same `encounter` a root chain's
 * `fold` reads), and the pick is by that position, never by value. A body of at most one row (a reducer, a
 * record) has nothing to pick and keeps the unpositioned plan — whose collects order their members as the
 * correlated ladder does. `positionedSeed` asks for the position outright (a merge that numbers its arms).
 */
function lowerBody(
  body: readonly IRStep[], rel: Rel, from: Rel, framing: RelFraming, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false,
): Tail | null {
  const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: body, rooted: false }, originDomain: undefined, ...(order ? { bodyOrder: order } : {}) };
  const positioned = positionedSeed || someStepDeep(body, ctx.params, (s) => s.name === 'tail');
  const run = (at: boolean): Tail | null => continueAs(seedRow(rel, from, fresh, at), framing, body, 0, false, bodyCtx, fresh, labels);
  const tail = run(positioned);
  if (order === 'read' && tail && !positioned && !encounterOf(tail.rel.channels) && !atMostOneRow(tail.rel)) return run(true);
  return tail;
}

/** A body that DRAWS or RE-SOURCES stays the ladder's (`scopedBody` says why). */
const ladderOwns = (body: readonly IRStep[], ctx: ChainCtx): boolean =>
  nondeterministic(body, ctx.params) || someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true);

/** Step 2: the body, lowered as the root lowers a chain, then keyed by the scope. `null` declines. */
function scopedBody(
  body: readonly IRStep[], rel: Rel, framing: RelFraming, sc: Scope, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  order?: 'free' | 'read', positionedSeed = false, reframe?: (tail: Tail) => Tail | null,
): ScopedBody | null {
  // Two body forms stay the ladder's, each for a reason about the QUERY TEXT:
  // - a random DRAW (`sample`/`coin`/`shuffle`, at any depth) — the decorrelated body draws over every scope
  //   at once, and a draw in a part that does not read the host would be one draw SHARED by every scope,
  //   the exact defect the ladder's `shared-draw` decline names;
  // - a RE-SOURCE (`V()`/`E()`) anywhere in the body — whether it is the uncorrelated read the ladder
  //   answers once, or a re-source under a host value that may be absent (`resource-under-absent`, an
  //   explained decline), is the ladder's decision, and the connector must not answer around it.
  if (ladderOwns(body, ctx)) return null;
  const lowered = lowerBody(body, rel, sc.scoped, framing, ctx, fresh, labels, order, positionedSeed);
  // A body with EFFECTS is not a read the connector may evaluate per scope.
  if (!lowered || lowered.effects?.length) return null;
  // The host's own re-expression of the body's value, BEFORE the key is added (`landValues`' record).
  const tail = reframe ? reframe(lowered) : lowered;
  if (!tail) return null;
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
  if (ladderOwns(body, ctx)) return null;
  const tail = lowerBody(body, rel, rel, framing, ctx, fresh, labels, order);
  if (!tail || tail.effects?.length) return null;
  let walk = false;
  forEachRel(tail.rel, (r) => { if (r.kind === 'recursive') walk = true; });
  return walk ? null : tail;
}

/**
 * Does a correlated plan, read as `outputs`, COMPUTE only with stored host columns? A correlated read spells
 * the host column it computes with INSIDE the subquery (`spelledOuterColumns`), so a COMPUTED one — a label's
 * `jsonb_array`, a path, a normalized value — would be computed again per inner row, where the decorrelated
 * form reads it once, by name, off the scoped input. Such a plan stays decorrelated (`columnIsStored`). A
 * column the body only CARRIES (a label it never reads) is not spelled, so it costs nothing.
 */
function spellsStored(plan: Rel, outputs: readonly string[], host: Rel): boolean {
  const spelled = spelledOuterColumns(plan, host.id, outputs);
  return !!spelled && [...spelled].every((name) => columnIsStored(host, name));
}

/** A correlated body as an `EXISTS` operand, projecting its FIRST column alone: an `EXISTS` reads no value, so
 *  the body's other columns (labels, path) are not spelled; a column rather than a literal keeps an aggregate
 *  block an aggregate query (the reason `childPredicate`'s probe gives, `filter.ts`). Nor does it read an order,
 *  so a position the body numbered is not computed for it (`positionKeys` drops the window). */
function existenceProbe(tail: Tail, fresh: Minter): Rel {
  const enc = encounterOf(tail.rel.channels);
  const rows = (enc && positionKeys(tail.rel, enc.col, fresh)?.rel) || tail.rel;
  return make.project({
    id: fresh('sp'), input: rows, channels: [], type: typeOf(meta('one', 'any', true)),
    exprs: [['one', col(rows.id, tail.rel.type.cols[0]!.name)]],
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
function correlatedFirst(tail: Tail, names: readonly string[], host: Rel, fresh: Minter): ReadonlyMap<string, Expr> | null {
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
  // The FIRST row in EMISSION order (`lowerBody`): sorted by the position's own keys where the body numbered
  // it with a window (`positionKeys` — a top-1 sort, no window per host row), else by the position itself; the
  // payload breaks what ties remain, `defaultCollation`'s rule.
  const enc = encounterOf(tail.rel.channels);
  const keyed = !single && enc ? positionKeys(tail.rel, enc.col, fresh) : null;
  const base = keyed?.rel ?? tail.rel;
  const terms = keyed
    ? [...keyed.keys, ...payloadCols(tail.rel).map((column) => ({ expr: col(base.id, column.name), dir: 'asc' as const }))]
    : defaultCollation(tail.rel);
  const first = single ? tail.rel : make.limit({
    id: fresh('cl'), input: make.sort({ id: fresh('cs'), input: base, channels: base.channels, type: base.type, terms }),
    channels: base.channels, type: base.type, count: compilerInt(1),
  });
  const plans = (payload as ColMeta[]).map((column) => [column.name,
    make.project({ id: fresh('cv'), input: first, channels: [], type: typeOf({ ...column, nullable: true }), exprs: [[column.name, col(first.id, column.name)]] })] as const);
  if (!plans.every(([name, plan]) => spellsStored(plan, [name], host))) return null;
  return new Map(plans.map(([name, plan]) => [name, { kind: 'scalar', plan } as Expr]));
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
): KeyedRows {
  return keyedRows(body, names, fresh, true);
}

/** A keyed body's rows (`first`: only the first per scope), their named columns renamed so they can sit
 *  beside the host's — the right side of every reconnect. */
interface KeyedRows { readonly rel: Rel; readonly key: string; readonly renamed: ReadonlyMap<string, string> }

function keyedRows(body: ScopedBody, names: readonly string[], fresh: Minter, firstOnly: boolean): KeyedRows {
  const first = firstOnly ? perOriginWindow(body.rel, col(body.rel.id, body.keyCol), [], { scope: 'global', offset: 0, limit: 1 }, fresh) : body.rel;
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
  const connective = step.name === 'and' || step.name === 'or';
  const bodies = connective
    ? step.args.every((arg) => isNested(arg.value)) && !step.modulators?.length && !step.optionArms && step.args.length
      ? step.args.map((arg) => bodyOf((arg.value as { nested: unknown }).nested, ctx.params, ctx.sideEffects))
      : null
    : [singleBody(step, ctx)];
  if (!bodies || bodies.some((b) => !b?.length)) return null;
  // Every body correlated: the semi/anti-join is an `EXISTS` over the body itself, read against the host row
  // (the dependent join kept as such — `correlatedBody`); `and`'s bodies are a conjunction of them.
  const correlated = (bodies as (readonly IRStep[])[]).map((body) => correlatedBody(body, rel, framing, ctx, fresh, labels, 'free'));
  const probes = correlated.map((tail) => tail && existenceProbe(tail, fresh));
  if (probes.every((probe) => probe && spellsStored(probe, ['one'], rel))) {
    const pred = (probes as Rel[]).map((plan): Expr => ({ kind: 'exists', plan, negated }))
      // `and` a conjunction of the bodies' EXISTS, `or` a disjunction (`OrStep`: some child has a next).
      .reduce((all, one) => (step.name === 'or' ? or(all, one) : and(all, one)));
    return continueAs(make.filter({ id: fresh('sj'), input: rel, channels: rel.channels, type: rel.type, pred }), framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  const sc = scope(rel, fresh);
  let kept = sc.scoped;
  // `and(b1, b2, …)` is every body's semi-join in turn (`AndStep`, a `ConnectiveStep` over its children);
  // `or(b1, b2, …)` ONE semi-join on the UNION of the bodies' keys — a traverser passes iff some child has a next
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/OrStep.java`).
  const keys: Rel[] = [];
  for (const body of bodies as (readonly IRStep[])[]) {
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'free');
    if (!keyed) return null;
    if (step.name === 'or') {
      keys.push(make.project({
        id: fresh('sok'), input: keyed.rel, channels: [], type: typeOf(meta('sok', 'int')),
        exprs: [['sok', col(keyed.rel.id, keyed.keyCol)]],
      }));
      continue;
    }
    kept = make.join({
      id: fresh('sj'), left: kept, right: keyed.rel, join: negated ? 'anti' : 'semi', channels: kept.channels, type: kept.type,
      on: eq(col(kept.id, sc.key), col(keyed.rel.id, keyed.keyCol)),
    });
  }
  if (keys.length) {
    const any = keys.length === 1 ? keys[0]! : make.union({ id: fresh('sou'), inputs: keys, all: true, channels: [], type: keys[0]!.type });
    kept = make.join({
      id: fresh('sj'), left: kept, right: any, join: 'semi', channels: kept.channels, type: kept.type,
      on: eq(col(kept.id, sc.key), col(any.id, 'sok')),
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
  // An `otherV()` after the map reads the HOST as the entering vertex (`rejoin`'s `FROM_V`), which only the
  // decorrelated rejoin carries.
  const feedsOtherV = edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false);
  const hostChannel = (channel: Channel): ColMeta => rel.type.cols.find((column) => column.name === channel.col)!;
  const tail = feedsOtherV ? null : correlatedBody(body, rel, framing, ctx, fresh, labels, 'read');
  const first = tail && framingCols(tail.framing) ? correlatedFirst(tail, payloadCols(tail.rel).map((column) => column.name), rel, fresh) : null;
  const lead = tail && payloadCols(tail.rel)[0];
  const probe = tail && lead?.nullable ? existenceProbe(tail, fresh) : null;
  if (tail && first && (!probe || spellsStored(probe, ['one'], rel))) {
    // The dependent join kept: each payload column the body's first row, read per host row (beside the host's
    // own columns, under fresh names). A host row whose body is EMPTY is dropped (`TraversalMapStep`): a
    // present lead value proves a row, and only where the lead may be a NULL value is the body's `EXISTS` asked
    // — after the `OR`, so a row whose value is present never pays for it.
    const bodyPayload = payloadCols(tail.rel);
    const named = new Map(bodyPayload.map((column) => [column.name, fresh('smv') as string]));
    const projected = make.project({
      id: fresh('smp'), input: rel, channels: rel.channels,
      type: typeOf(...rel.type.cols, ...bodyPayload.map((column) => ({ ...column, name: named.get(column.name)!, nullable: true }))),
      exprs: [...rel.type.cols.map((column) => [column.name, col(rel.id, column.name)] as const),
        ...bodyPayload.map((column) => [named.get(column.name)!, first.get(column.name)!] as const)],
    });
    const leadPresent: Expr = { kind: 'binary', op: 'is not', left: col(projected.id, named.get(lead!.name)!), right: compilerNull() };
    const present = make.filter({
      id: fresh('smf'), input: projected, channels: projected.channels, type: projected.type,
      pred: probe ? or(leadPresent, substRelId({ kind: 'exists', plan: probe, negated: false }, rel.id, projected.id)) : leadPresent,
    });
    const mapped = make.project({
      id: fresh('smq'), input: present, channels: rel.channels, type: typeOf(...bodyPayload, ...rel.channels.map(hostChannel)),
      exprs: [...bodyPayload.map((column) => [column.name, col(present.id, named.get(column.name)!)] as const),
        ...rel.channels.map((channel) => [channel.col, col(present.id, channel.col)] as const)],
    });
    return continueAs(splitPath(mapped, tail.framing, ctx, fresh), tail.framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  // Not SQL-holdable as a dependent join: the decorrelated body, its FIRST row per scope through the rejoin.
  const sc = scope(rel, fresh);
  const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read');
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, rel, 'split', true, ctx, fresh, labels, false, feedsOtherV);
  return out && continueAs(out.rel, out.framing, steps, at + 1, bulked, ctx, fresh, out.aliases);
};

/**
 * THE REJOIN — a keyed body's rows (`firstOnly`: its first per scope) INNER-joined back to `host` (the scoped
 * input, or a subset of it) on the key: each host traverser once per body result. Which traverser state the
 * result carries is the host's policy, and there are exactly two in the reference:
 *
 * - `'split'` — `head.split(result)`: the payload is the body's, every channel the PRE-child traverser's, and
 *   the path is extended by exactly the emitted value (`FlatMapStep.java:42-52`, `MapStep`,
 *   `…/traverser/B_LP_O_S_SE_SL_Traverser.java:66-71`); a label bound in the body does not escape. `map`,
 *   `flatMap`, `coalesce`.
 * - `'forward'` — the CHILD's own traverser is emitted (`OptionalStep.java:47-57`, `LocalStep.java:80-88`):
 *   payload, path, labels and sack are the body's; only what a child never inherits (`HOST_ONLY` — the bulk,
 *   the position in the host stream, the enclosing scope keys) comes back from the host row.
 */
function rejoin(
  sc: Scope, host: Rel, keyed: ScopedBody, rel: Rel, policy: 'split' | 'forward', firstOnly: boolean,
  ctx: ChainCtx, fresh: Minter, labels: AliasMap, bodyPosition = false, feedsOtherV = false,
): ChainReadOut | null {
  const outFraming = keyed.tail.framing;
  if (!framingCols(outFraming)) return null;
  // A body row that stands for several traversers (a BULKED body, its own `bulk` column) is that many results
  // for EACH of the host row's traversers: the two multiplicities MULTIPLY. An unbulked body's `bulk` is one
  // per row, and the first of a scope is one traverser whatever it stood for.
  const bodyBulk = firstOnly || !keyed.tail.bulked ? undefined : keyed.tail.rel.channels.find((channel) => channel.role === 'bulk');
  if (!firstOnly && keyed.tail.bulked && !bodyBulk) return null;
  const hostBulk = rel.channels.find((channel) => channel.role === 'bulk');
  const bodyPayload = payloadCols(keyed.tail.rel);
  // `bodyPosition`: each result's position WITHIN its scope (the body's own `encounter`) replaces the host's,
  // which the caller has frozen into a parent key (`freezeParent`) for the emission order (`mintBranchOrder`).
  const bodyEnc = bodyPosition ? encounterOf(keyed.tail.rel.channels) : undefined;
  const bodyChannels = [
    ...(policy === 'forward' ? keyed.tail.rel.channels.filter((channel) => !HOST_ONLY.has(channel.role)) : []),
    ...(bodyEnc ? [bodyEnc] : []),
    ...(bodyBulk && !hostBulk ? [bodyBulk] : []),
  ];
  const bodyCol = (name: string): ColMeta => keyed.tail.rel.type.cols.find((column) => column.name === name)!;
  const carried = [...bodyPayload.map((column) => column.name), ...bodyChannels.map((channel) => channel.col), ...(bodyBulk && hostBulk ? [bodyBulk.col] : [])];
  const rows = keyedRows(keyed, carried, fresh, firstOnly);
  const joined = make.join({
    id: fresh('smj'), left: host, right: rows.rel, join: 'inner', channels: host.channels,
    type: typeOf(...host.type.cols, ...rows.rel.type.cols),
    on: eq(col(host.id, sc.key), col(rows.rel.id, rows.key)),
  });
  const hostChannels = (policy === 'forward' ? rel.channels.filter((channel) => HOST_ONLY.has(channel.role)) : rel.channels)
    .filter((channel) => !bodyPosition || channel.role !== 'encounter');
  // The channels in the canonical role order (`withChannel`), so two arms laid out from different sources
  // still agree column for column.
  // An `otherV()` after a `split` reads the PREVIOUS path object — the pre-child head itself, since the body's
  // own hops are hidden (`EdgeOtherVertexStep`, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java:44-55`):
  // so the entering vertex of an edge result is the HOST element (`FROM_V`).
  const hostFromV = policy === 'split' && feedsOtherV && outFraming.kind === 'elements' && outFraming.elem === 'edge'
    && rel.type.cols.some((column) => column.name === 'id') && !hostChannels.some((channel) => channel.role === 'fromV');
  const channels = [...hostChannels, ...(hostFromV ? [FROM_V] : [])].reduce(withChannel, bodyChannels);
  const fromBody = new Set(bodyChannels.map((channel) => channel.col));
  const hostChannel = (channel: Channel): ColMeta => channel === FROM_V ? meta(FROM_V.col, 'int') : rel.type.cols.find((column) => column.name === channel.col)!;
  const read = (name: string): Expr => (hostFromV && name === FROM_V.col ? col(joined.id, 'id') : bodyBulk && hostBulk && name === hostBulk.col
    ? { kind: 'binary', op: '*', left: col(joined.id, name), right: col(joined.id, rows.renamed.get(bodyBulk.col)!) }
    : col(joined.id, fromBody.has(name) ? rows.renamed.get(name)! : name));
  const mapped = make.project({
    id: fresh('smp'), input: joined, channels,
    type: typeOf(...bodyPayload, ...channels.map((channel) => (fromBody.has(channel.col) ? bodyCol(channel.col) : hostChannel(channel)))),
    exprs: [
      ...bodyPayload.map((column) => [column.name, col(joined.id, rows.renamed.get(column.name)!)] as const),
      ...channels.map((channel) => [channel.col, read(channel.col)] as const),
    ],
  });
  if (policy === 'forward') return { rel: mapped, framing: outFraming, aliases: keyed.tail.aliases, bulked: !!bodyBulk };
  return { rel: splitPath(mapped, outFraming, ctx, fresh), framing: outFraming, aliases: labels, bulked: !!bodyBulk };
}

/** `split`'s path: the emitted value extends it — an element by its id, a value as a value position; any other
 *  object has no position this path can append, so the path is dropped and a later read declines. */
function splitPath(mapped: Rel, outFraming: RelFraming, ctx: ChainCtx, fresh: Minter): Rel {
  return !pathCarried(mapped) ? mapped
    : outFraming.kind === 'elements' ? extendPath(mapped, { kind: 'element', elem: outFraming.elem, id: col(mapped.id, 'id') }, fresh, ctx.demandsPathLabels)
      : outFraming.kind === 'scalar' && mapped.type.cols.some((column) => column.name === 'v') ? appendValuePosition(mapped, outFraming.type, fresh)
        : dropPath(mapped, fresh);
}

/** A rejoined relation; `bulked` where a body row's own multiplicity rode into the host's `bulk`. */
interface ChainReadOut { readonly rel: Rel; readonly framing: RelFraming; readonly aliases: AliasMap; readonly bulked: boolean }

/**
 * `union(b1, …, bn)` — every arm is a GLOBAL child: `UnionStep` is a `BranchStep` whose arms are each fed EVERY
 * start (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:87-88, 143-147`),
 * so the scope is the whole stream and there is no key to decorrelate on: the reconnect is the arm merge itself
 * (`unionArms` — emission order, reducing arms and their empty-input gate, the shape meet). A row here so a
 * union's arms are read like every other connector body — a path an arm reads is seeded (`CONNECTOR_HOSTS`).
 */
const globalArms: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const merged = unionArms(step, rel, framing, bulked, ctx, fresh, labels, { steps, at });
  if (!merged || merged.effects?.length) return null;
  return continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, merged.aliases);
};

/**
 * `choose(c, t[, f])` — the condition is a LOCAL child, the options are GLOBAL ones: `ChooseStep` routes each
 * traverser by whether `c` produced for it, then each option traversal runs over every traverser routed to it
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java`,
 * `…/branch/BranchStep.java:123-153`). So only the CONDITION is scoped: it is decided per row as an EXISTS on the
 * scope key into the decorrelated condition body, and the routing, the option arms, their empty-input gate and
 * the merge are the host's own (`chooseArms`), handed that predicate (`RoutedCondition`). The key rides the
 * scoped rows as a channel and is shed once they are routed, so no arm carries it.
 */
const chooseRoute: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.optionArms || step.modulators?.length || step.args.length < 2) return null;
  const choice = step.args[0]!.value;
  if (!isNested(choice)) return null;
  const condition = bodyOf(choice.nested, ctx.params, ctx.sideEffects);
  if (!condition) return null;
  const sc = scope(rel, fresh, true);
  const keyed = scopedBody(condition, sc.scoped, framing, sc, ctx, fresh, labels, 'free');
  if (!keyed) return null;
  const routed: RoutedCondition = {
    pred: (source) => (source.type.cols.some((column) => column.name === sc.key) ? {
      kind: 'exists', negated: false,
      plan: make.filter({
        id: fresh('scx'), input: keyed.rel, channels: keyed.rel.channels, type: keyed.rel.type,
        pred: eq(col(keyed.rel.id, keyed.keyCol), col(source.id, sc.key)),
      }),
    } : null),
    shed: (routedRows) => {
      const channels = routedRows.channels.filter((channel) => channel.col !== sc.key);
      const cols = routedRows.type.cols.filter((column) => column.name !== sc.key);
      return make.project({
        id: fresh('scs'), input: routedRows, channels, type: typeOf(...cols),
        exprs: cols.map((column) => [column.name, col(routedRows.id, column.name)] as const),
      });
    },
  };
  // The routed rows read the scoped input under an alias of their OWN: the condition's EXISTS plan reads the
  // scoped input too (its domain), and a correlation to the same name from inside it would bind to its own row.
  const input = make.project({
    id: fresh('scr'), input: sc.scoped, channels: sc.scoped.channels, type: sc.scoped.type,
    exprs: sc.scoped.type.cols.map((column) => [column.name, col(sc.scoped.id, column.name)] as const),
  });
  const merged = chooseArms(step, input, framing, bulked, ctx, fresh, labels, { steps, at }, routed);
  if (!merged || merged.effects?.length) return null;
  return continueAs(merged.rel, merged.framing, steps, at + 1, bulked, ctx, fresh, merged.aliases);
};

/**
 * `flatMap(b)` / `local(b)` — EVERY result per scope, the rejoin: `FlatMapStep` emits `head.split(r)` for each of the
 * body's results (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52`),
 * `LocalStep` forwards each of the child's own traversers (`…/step/branch/LocalStep.java:80-88`) — the `split` and
 * `forward` policies. Where the stream's order is read, each result keeps its position within its scope behind
 * the host's (start-major, `originMajor`'s rule): the host position frozen as the parent, the body run from a
 * positioned seed, numbered by `mintBranchOrder` as a one-arm merge would be.
 */
const allRows = (policy: 'split' | 'forward'): Connector => (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  const body = singleBody(step, ctx);
  if (!body) return null;
  const owed = branchOrderOwed(ctx, { steps, at }, rel);
  const frozen = owed ? freezeParent(positioned(rel, fresh), fresh) : null;
  const input = frozen ? frozen.rel : rel;
  const sc = scope(input, fresh);
  const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body));
  if (!keyed) return null;
  const out = rejoin(sc, sc.scoped, keyed, input, policy, false, ctx, fresh, labels, owed, edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false));
  if (!out) return null;
  const arm: Tail = { ...out, bulked: bulked || out.bulked };
  const merged = frozen ? mintBranchOrder([arm], frozen.parent, labels, ctx.source, fresh) : { ...out, rel: dropEncounter(out.rel, fresh) };
  return merged && continueAs(merged.rel, merged.framing, steps, at + 1, arm.bulked, ctx, fresh, merged.aliases);
};

/**
 * `coalesce(b1, …, bn)` / `optional(b)` — PRIORITY: per scope, every result of the lowest-index arm that has
 * one. `CoalesceStep.flatMap` resets each arm per traverser and returns the FIRST that `hasNext()`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CoalesceStep.java:52-62`),
 * so arm k answers exactly the scopes that are in none of arms 1…k−1's keyed relations: the host ANTI-joined
 * on each earlier arm's key, then the rejoin. `coalesce` is a `FlatMapStep` (`split`); `OptionalStep` forwards
 * its child's traverser, and the traverser ITSELF where the child has none
 * (`…/step/branch/OptionalStep.java:47-57`) — a final identity arm over the scopes left.
 * The arms merge as a branch's do (`mergeArms`: a scalar meet, a variant, rehomed labels).
 */
const priority: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  if (step.modulators?.length || step.optionArms || !step.args.length || step.args.some((arg) => !isNested(arg.value))) return null;
  const optional = step.name === 'optional';
  if (optional && step.args.length !== 1) return null;
  const bodies = step.args.map((arg) => bodyOf((arg.value as { nested: unknown }).nested, ctx.params, ctx.sideEffects));
  // An EMPTY body (one a Pass reduced to nothing, `where(count())`) is admitted: it lowers as the identity,
  // the traverser itself. Only an unreadable one declines.
  if (bodies.some((body) => !body)) return null;
  // ONE correlated host row (a body inside another child, `project().by(coalesce(…))`): there is nothing to
  // scope, and the dependent join is the plan — each arm over the row, gated by the earlier arms' NOT EXISTS
  // (`coalesceMerge`, the correlated form cc3b keeps for `map`/`where`). Only where that form declines is the
  // row scoped and decorrelated below.
  if (atMostOneRow(rel)) {
    const branch = optional ? optionalArms(step, rel, framing, bulked, ctx, fresh, labels, { steps, at })
      : coalesceArms(step, rel, framing, bulked, ctx, fresh, labels, { steps, at });
    if (branch && !branch.effects?.length) return continueAs(branch.rel, branch.framing, steps, at + 1, bulked, ctx, fresh, branch.aliases);
  }
  // A consumer that READS the merge's order (`branchOrderOwed`) gets the emission key — host position, then
  // arm, then the result's position within its scope (`mintBranchOrder`): the host is positioned and its
  // position frozen into a parent key, and each body runs from a positioned seed so it carries its own.
  const owed = branchOrderOwed(ctx, { steps, at }, rel);
  const frozen = owed ? freezeParent(positioned(rel, fresh), fresh) : null;
  const input = frozen ? frozen.rel : rel;
  const sc = scope(input, fresh);
  const arms: Tail[] = [];
  let remaining: Rel = sc.scoped;
  for (const body of bodies as (readonly IRStep[])[]) {
    // Where the merge's order is read, a STREAMING arm runs from a positioned seed, so its results are numbered
    // in its own emission order; a REDUCING arm (`isReductionArm`) has one result per scope and no position to
    // keep — the ladder's own split between its positioned arms and its per-traverser reduction arm.
    const keyed = scopedBody(body, input, framing, sc, ctx, fresh, labels, owed ? 'read' : 'free', owed && !isReductionArm(body));
    if (!keyed) return null;
    const out = rejoin(sc, remaining, keyed, input, optional ? 'forward' : 'split', false, ctx, fresh, labels, owed,
      edgeFeedsOtherV(steps, at, ctx.needsFromV ?? false));
    if (!out) return null;
    arms.push({ ...out, rel: owed ? out.rel : dropEncounter(out.rel, fresh), bulked: bulked || out.bulked });
    remaining = make.join({
      id: fresh('sa'), left: remaining, right: keyed.rel, join: 'anti', channels: remaining.channels, type: remaining.type,
      on: eq(col(remaining.id, sc.key), col(keyed.rel.id, keyed.keyCol)),
    });
  }
  if (optional) {
    const left = unscoped(remaining, input, fresh);
    arms.push({ rel: owed ? left : dropEncounter(left, fresh), framing, aliases: labels, bulked });
  }
  // A REDUCING arm's scalar rides its type on a `vt` column (`result: 'number'`/`'value'`), which the scalar
  // meet refuses beside a plain one; normalized onto the merged per-row vtype it meets like any other — the
  // one normalization every branch merge uses (`reconcileCollapsed`).
  const marked = arms.some((arm) => arm.framing.kind === 'scalar' && arm.framing.result !== undefined && arm.framing.result !== 'count');
  // An arm whose body carried its own multiplicity has a `bulk` the others may lack (a nested scope's host
  // row has none): each of theirs is ONE traverser (`ensureBulk`).
  const counted = arms.some((arm) => arm.rel.channels.some((channel) => channel.role === 'bulk'))
    ? arms.map((arm) => ({ ...arm, rel: ensureBulk(arm.rel, fresh) })) : arms;
  const met = marked ? reconcileCollapsed(counted, fresh) : counted;
  if (!met) return null;
  // ONE arm (`coalesce(b)`) has nothing to merge; where its order is read it is still numbered host-major.
  const merged = met.length === 1 ? met[0]!
    : frozen ? mintBranchOrder(met, frozen.parent, labels, ctx.source, fresh) : mergeArms(met, labels, ctx.source, fresh);
  return merged && continueAs(merged.rel, merged.framing, steps, at + 1, arms.some((arm) => arm.bulked), ctx, fresh, merged.aliases);
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
    // A RECORD-valued by() (`by(__.project(…))`) is held as the MAP it is (`recordAsMap`): a record's own first
    // column is a SUB-field's, so presence read off it dropped an outer key whose inner map was empty.
    const lowered = correlatedBody(by.key.body, rel, framing, ctx, fresh, labels, 'read');
    const tail = lowered && recordAsMap(lowered, ctx, fresh);
    const fieldCols = tail && framingCols(tail.framing);
    const exprs = tail && fieldCols && correlatedFirst(tail, fieldCols.map((column) => column.name), rel, fresh);
    if (tail && exprs) { correlated.set(slot, { exprs, framing: tail.framing, total: exactlyOneRow(tail.rel) }); continue; }
    const scoped = sc ??= scope(rel, fresh);
    if (joined === rel) joined = scoped.scoped;
    const keyed = scopedBody(by.key.body, rel, framing, scoped, ctx, fresh, labels, 'read', false, (t) => recordAsMap(t, ctx, fresh));
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

/** A child body's identity across `bodyOf` calls (each re-runs the passes, so the arrays are never the same
 *  object): its structure, spelled deterministically. A `bigint` literal spells as text, and an object met
 *  again (the IR shares and back-references nodes) as a marker, so the walk is finite. */
const bodyKey = (body: readonly IRStep[]): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(body, (_, value: unknown) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[seen]';
      seen.add(value);
    }
    return value;
  });
};

/** The relation a host's own expressions read, where it names one. */
function hostRelOf(host: ChildHost): RelId | undefined {
  const at = host.kind === 'element' || host.kind === 'property' ? host.id
    : host.kind === 'scalar' ? host.value : host.kind === 'list' ? host.list : host.kind === 'map' ? host.map : undefined;
  return at?.kind === 'col' ? at.rel : host.row?.rel.id;
}

/** A ChildValue's expressions, each rewritten. */
const mapValue = (v: ChildValue, f: (e: Expr) => Expr): ChildValue => ({
  ...v, expr: f(v.expr), ...(v.vtype ? { vtype: f(v.vtype) } : {}), ...(v.node ? { node: f(v.node) } : {}),
  present: typeof v.present === 'object' ? { ...v.present, when: f(v.present.when) } : v.present,
});

/** The columns of `rel` an expression reads. */
function colsRead(e: Expr, rel: RelId): Set<string> {
  const names = new Set<string>();
  rewriteExpr(e, (node) => { if (node.kind === 'col' && node.rel === rel) names.add(node.name); return node; });
  return names;
}

/** The pre-joined value of `body` over `host` (`ChildStrategy.scopedValues`), or `undefined` — the seam then
 *  builds its own. Read only over the relation the values were joined into. */
export function scopedValue(ctx: ChainCtx, body: readonly IRStep[], host: ChildHost): ChildValue | undefined {
  const scoped = ctx.scopedValues;
  const value = scoped?.values.get(bodyKey(body));
  if (!scoped || !value) return undefined;
  const at = hostRelOf(host);
  if (at === scoped.over) return value;
  // The host reads a PASS-THROUGH of the joined relation (a fence the tail put over it): the landed columns
  // ride it under their names, so the value is re-pointed at it — where every column it reads is there.
  const row = host.row?.rel;
  if (!row || row.id !== at) return undefined;
  const reads = [value.expr, value.vtype, value.node, typeof value.present === 'object' ? value.present.when : undefined]
    .flatMap((e) => (e ? [...colsRead(e, scoped.over)] : []));
  if (!reads.every((name) => row.type.cols.some((column) => column.name === name))) return undefined;
  return mapValue(value, (e) => substRelId(e, scoped.over, row.id));
}

/** The slots of a by()-modulated host whose child value is PER TRAVERSER — each traverser's first result
 *  (`TraversalUtil.produce`). `group()`'s VALUE `by()` is not one: `Grouping` pools a key's traversers into
 *  its first barrier, so its scope is the KEY. */
const perTraverserSlot = (step: IRStep, slot: number): boolean => step.name !== 'group' || slot === 0;

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (§2 S5). Each child `by()` is the first result per scope (`firstPerScope`), LEFT-joined onto the scoped
 * input; the host step is then the ladder's own lowering over that relation, reading each value as a column
 * where it would have built a correlated subquery (`scopedValue`). The by() semantics — an unproductive key
 * drops the traverser unless `ProductiveByStrategy` keeps it (`OrderGlobalStep`, `DedupGlobalStep.java:77-78`,
 * `GroupCountStep`'s `TraversalUtil.produce`), the comparator, the survivor, the map — stay the host's; only
 * where the value comes from changes. The joined columns are shed after the step.
 */
/**
 * THE by() VALUES AS JOIN COLUMNS (§2 S5): each body's first result per scope (`firstPerScope`), LEFT-joined
 * onto the scoped input. The answer is that relation and, per body (by `bodyKey`), the `ChildValue` reading
 * its columns — what `childSeam`'s `scalar` hands a host lowered over it (`scopedValue`). `null` declines.
 */
function landValues(
  rel: Rel, framing: RelFraming, bodies: ReadonlyMap<string, readonly IRStep[]>, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): { readonly over: Rel; readonly values: ReadonlyMap<string, ChildValue> } | null {
  const sc = scope(rel, fresh);
  let joined = sc.scoped;
  const landed: { readonly key: string; readonly first: KeyedRows; readonly framing: RelFraming; readonly cols: readonly ColMeta[] }[] = [];
  for (const [key, body] of bodies) {
    const keyed = scopedBody(body, rel, framing, sc, ctx, fresh, labels, 'read', false, (t) => recordAsMap(t, ctx, fresh, true));
    const cols = keyed && framingCols(keyed.tail.framing);
    // One value column (and a scalar's per-row type) is what a ChildValue carries.
    if (!keyed || !cols || cols.length > (keyed.tail.framing.kind === 'scalar' ? 2 : 1)) return null;
    if (cols.some((column) => !keyed.tail.rel.type.cols.some((c) => c.name === column.name))) return null;
    const first = firstPerScope(keyed, cols.map((column) => column.name), fresh);
    joined = make.join({
      id: fresh('sbj'), left: joined, right: first.rel, join: 'left', channels: joined.channels,
      type: typeOf(...joined.type.cols, ...first.rel.type.cols),
      on: eq(col(joined.id, sc.key), col(first.rel.id, first.key)),
    });
    landed.push({ key, first, framing: keyed.tail.framing, cols });
  }
  const over = joined;
  const values = new Map(landed.map(({ key, first, framing: valueFraming, cols }) => [key, {
    expr: col(over.id, first.renamed.get(cols[0]!.name)!),
    ...(cols[1] ? { vtype: col(over.id, first.renamed.get(cols[1].name)!) } : {}),
    framing: valueFraming,
    // The body produced exactly where its scope has a first row — a NULL value under it is a productive null.
    present: { when: isNot(col(over.id, first.key), compilerNull()) },
    yields: 'first' as const,
    // A MAP value whose values hold element rowids is NESTED wherever a host puts it (a group key, a member):
    // its node carries them expanded (`mapNodePayload`), as a root map's are framed; a key that only compares
    // (`dedup`) reads `expr`.
    ...(valueFraming.kind === 'map' && mapHoldsRowids(valueFraming.valOf)
      ? { node: mapNode(mapNodePayload(col(over.id, first.renamed.get(cols[0]!.name)!), valueFraming.valOf, ctx.source, fresh)) } : {}),
  } satisfies ChildValue]));
  return { over, values };
}

/** Can the tree framer (`listNodeExpr`) walk a list of these members, at every depth? A map member's element
 *  rowids are expanded there (`mapNodePayload`); a path member has no `{t:'path'}` node yet. */
const treeFramed = (of: ListOf): boolean =>
  of.kind === 'list' ? treeFramed(of.of) : of.kind === 'scalar' || of.kind === 'mixed' || of.kind === 'map' || of.kind === 'elem';

/**
 * A RECORD value (`by(__.project(…))`) as the MAP it is — `ProjectStep` emits a `Map` for every traverser it
 * maps, an empty one included: one `map` column (`recordToMap`), so the value is ONE column, present wherever the
 * body produced and equal by its entries. Read as a record, its presence was its FIRST SUB-field's, so an inner
 * map with that field absent read as no value at all (`project('x').by(project('a','b').by(has('lang'))…)`
 * dropped `x`). The ladder's seam already hands a project body back collapsed the same way.
 */
function recordAsMap(tail: Tail, ctx: ChainCtx, fresh: Minter, always = false): Tail | null {
  // Only where the record's presence CANNOT be read off its first column: a first field that is itself always
  // there (a `count()`, a token) proves the record, and the record's columns stay as they are (no JSON built) —
  // `always` where the value must be ONE column regardless (a landed by() value, `landValues`).
  const readable = (fields: readonly RecordField[]): boolean => {
    const first = fields[0];
    return !!first && !first.optional && (first.framing.kind !== 'record' || readable(first.framing.fields));
  };
  if (tail.framing.kind !== 'record' || (!always && readable(tail.framing.fields))) return tail;
  const map = recordToMap(tail.rel, tail.framing.fields, ctx.source, fresh);
  return map && { ...tail, rel: map.rel, framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: map.valOf } };
}

/** The child bodies of a step's per-traverser `by()` slots, by `bodyKey`. */
function perTraverserBodies(step: IRStep, bys: readonly (Modulation | undefined)[]): Map<string, readonly IRStep[]> {
  const bodies = new Map<string, readonly IRStep[]>();
  bys.forEach((by, slot) => {
    if (by?.key.kind === 'child' && perTraverserSlot(step, slot)) bodies.set(bodyKey(by.key.body), by.key.body);
  });
  return bodies;
}

/** A host's `by()` slot count: `group()` a key and a value, `groupCount()` a key, the others one per `by()`. */
const byArity = (step: IRStep): number =>
  step.name === 'group' ? 2 : step.name === 'groupCount' ? 1 : step.modulators?.length ?? 0;

/**
 * `order().by(b)` / `dedup().by(b)` / `groupCount().by(b)` / `group().by(b)` — the by() VALUE as JOIN COLUMNS
 * (`landValues`). The host step is then the ladder's own lowering over the joined relation, reading each value
 * as a column where it would have built a correlated subquery (`scopedValue`). The by() semantics — an
 * unproductive key drops the traverser unless `ProductiveByStrategy` keeps it (`OrderGlobalStep`,
 * `DedupGlobalStep.java:77-78`, `GroupCountStep`'s `TraversalUtil.produce`), the comparator, the survivor, the
 * map — stay the host's; only where the value comes from changes. The joined columns are shed after the step.
 * A `group()` whose VALUE `by()` is a child is `pooledGroup`'s.
 */
const byValues: Connector = (site) => {
  const { step, rel, framing, steps, at, bulked, ctx, fresh, labels } = site;
  // An ARGUMENT changes what the by() runs over: `dedup("a")` projects each scope LABEL's value on a NEW traverser
  // (`freshTraverserRow`), and `group("m")`/`groupCount("m")` is a keyed SIDE EFFECT — neither is a per-traverser
  // by() over this stream, so both stay the host's own.
  if (step.optionArms || !step.modulators?.length || step.args.length) return null;
  const bys = modulations(step, byArity(step), childSeam(ctx, fresh));
  if (!bys) return null;
  if (step.name === 'group' && bys[1]?.key.kind === 'child') return pooledGroup(site, bys);
  const all = perTraverserBodies(step, bys);
  // A body the host's own seam answers as a CORRELATED value (`scalarChild` — one index seek per row) keeps the
  // dependent join, as cc3b's `map`/`project` rows do: only the bodies it cannot hold are landed as join columns.
  const seam = childSeam(ctx, fresh);
  const host = framing.kind === 'elements' || framing.kind === 'scalar' ? reductionHost(rel, framing, labels) : null;
  const bodies = new Map([...all].filter(([, body]) => !host || !seam.scalar(body, host)));
  // No child body to land (a `by(__.identity())` IS a bare `by()`): the host's own lowering, over the input.
  const landed = bodies.size
    ? landValues(rel, framing, bodies, ctx, fresh, labels)
    : { over: rel, values: new Map<string, ChildValue>() };
  if (!landed) return null;
  const { over, values } = landed;
  // The ladder lowers THIS step alone over the joined relation, reading the landed values.
  const only = [step];
  const tail = continueAs(over, framing, only, 0, bulked,
    { ...ctx, scopedValues: { over: over.id, values }, ladderAt: { steps: only, at: 0 } }, fresh, labels);
  if (!tail) return null;
  // The joined columns are shed: a framing-preserving step (order, dedup) carries them as payload.
  const payload = payloadCols(rel);
  const preserved = tail.framing.kind === framing.kind;
  if (preserved && !payload.every((column) => tail.rel.type.cols.some((c) => c.name === column.name))) return null;
  const kept = preserved
    ? make.project({
      id: fresh('sbx'), input: tail.rel, channels: tail.rel.channels,
      type: typeOf(...payload, ...tail.rel.channels.map((channel) => tail.rel.type.cols.find((c) => c.name === channel.col)!)),
      exprs: [...payload.map((column) => column.name), ...tail.rel.channels.map((channel) => channel.col)]
        .map((name) => [name, col(tail.rel.id, name)] as const),
    })
    : tail.rel;
  return continueAs(kept, tail.framing, steps, at + 1, tail.bulked, ctx, fresh, tail.aliases);
};

/**
 * `group().by(k).by(b)` — the VALUE body POOLED PER KEY. `Grouping` runs every traverser of a key up to the value
 * traversal's first barrier into ONE pool and reduces it there (`determineBarrierStep`, `doFinalReduction`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125`;
 * `GroupStep.projectTraverser`, `…/step/map/GroupStep.java:118-143`), so the value's SCOPE is the key, not the
 * traverser: the domain is the stream's distinct keys (`groupKeyTerms`, the equality `groupMap` keys by), the body
 * is lowered once over ONE key's members — the input filtered to that key, correlated to one domain row — and
 * decorrelated against the domain. Its barrier is then grouped by the key by construction (S2), and a seeded one
 * keeps its seed for a key whose pool reduced to nothing (S3: `fold()` → `[]`, `count()` → 0); an unseeded one
 * (`sum()`) emits nothing and the key is absent, `GroupStep`'s `hasNextBarrier` false. A body with NO barrier
 * takes each traverser's first value and keeps the last (`Operator.assign`), which is not a pool: the ladder's.
 * The key `by()` is the host's own (a child key is landed as a join column first, `landValues`).
 */
function pooledGroup(site: HostSite, bys: readonly (Modulation | undefined)[]): Tail | null {
  const { step, rel, framing, steps, at, ctx, fresh, labels } = site;
  if (step.args.length || (framing.kind !== 'elements' && framing.kind !== 'scalar')) return null;
  const valueBy = bys[1]!;
  if (valueBy.key.kind !== 'child' || valueBy.order !== undefined) return null;
  const body = valueBy.key.body;
  // The POOL exists only where the value traversal has a `Barrier` (`isValueBarrier`, the step `determineBarrierStep`
  // stops at); without one each traverser's first value is assigned, last wins — the host's own arm.
  if (!body.some(isValueBarrier)) return null;
  // An enclosing per-traverser scope's key would have to ride every pool as one more group key; the ladder's.
  if (rel.channels.some((channel) => channel.role === 'origin' || channel.role === 'branchKey')) return null;
  // THE KEY: the host's own by() vocabulary over the (possibly value-landed) relation.
  const keyBy = bys[0] && !(bys[0].key.kind === 'identity' && bys[0].order === undefined) ? bys[0] : undefined;
  const keyBodies = keyBy ? perTraverserBodies(step, [keyBy]) : new Map<string, readonly IRStep[]>();
  const landed = keyBodies.size ? landValues(rel, framing, keyBodies, ctx, fresh, labels) : { over: rel, values: new Map<string, ChildValue>() };
  if (!landed) return null;
  const over = landed.over;
  const keyCtx: ChainCtx = keyBodies.size ? { ...ctx, scopedValues: { over: over.id, values: landed.values } } : ctx;
  const host = reductionHost(over, framing, labels);
  const keyElem = !keyBy && framing.kind === 'elements' ? framing.elem : undefined;
  const keyExpr = keyElem ? col(over.id, 'id') : byNode(keyBy ?? { key: { kind: 'identity' } }, host, ctx.source, fresh, childSeam(keyCtx, fresh));
  if (!keyExpr) return null;
  // Every member beside its key, the key computed ONCE (fenced): the domain and the pools both read it.
  const own = rel.type.cols;
  const KEY = fresh('pgk') as string;
  const withKey = make.materialize({
    id: fresh('pgm'), channels: rel.channels, type: typeOf(...own, meta(KEY, keyElem ? 'int' : 'json', true)),
    input: make.project({
      id: fresh('pgp'), input: over, channels: rel.channels, type: typeOf(...own, meta(KEY, keyElem ? 'int' : 'json', true)),
      exprs: [...own.map((column) => [column.name, col(over.id, column.name)] as const), [KEY, keyExpr] as const],
    }),
  });
  // An unproductive key drops its traverser, unless `ProductiveByStrategy` keeps it under null.
  const keyKeep = productivityFilter(step, 'value-nullness', col(withKey.id, KEY));
  if (!keyKeep) return null;
  const members = keyKeep.keep
    ? make.filter({ id: fresh('pgf'), input: withKey, channels: withKey.channels, type: withKey.type, pred: keyKeep.keep })
    : withKey;
  // THE DOMAIN: one row per key under the grouping's own equality, the first arrival's key node naming it.
  const terms = groupKeyTerms(col(members.id, KEY), !!keyElem);
  const termCols = terms.map(() => meta(fresh('pgt') as string, 'any', true));
  const enc = encounterOf(members.channels);
  const domain = make.aggregate({
    id: fresh('pgd'), input: members, channels: [], type: typeOf(...termCols, meta(KEY, keyElem ? 'int' : 'json', true)),
    groupBy: terms, aggs: [[KEY, firstArrival(col(members.id, KEY), enc ? [col(members.id, enc.col)] : [])]],
  });
  const sc = scope(domain, fresh);
  // ONE KEY'S POOL: the members whose key is the domain row's, as the traverser stream the body starts from.
  const memberTerms = groupKeyTerms(col(members.id, KEY), !!keyElem);
  const pooled = make.filter({
    id: fresh('pgs'), input: members, channels: members.channels, type: members.type,
    // NULL-safe (`IS`): a term may be NULL for every member of a key (a string key has no family tag).
    pred: memberTerms.map((term, i): Expr => ({ kind: 'binary', op: 'is', left: term, right: col(sc.scoped.id, termCols[i]!.name) }))
      .reduce((a, b) => and(a, b)),
  });
  const seed = make.project({
    id: fresh('pgn'), input: pooled, channels: rel.channels, type: rel.type,
    exprs: own.map((column) => [column.name, col(pooled.id, column.name)] as const),
  });
  if (ladderOwns(body, ctx)) return null;
  const bodyCtx: ChainCtx = { ...inBody(ctx), traversal: { steps: body, rooted: false }, originDomain: undefined, bodyOrder: 'read' };
  const tail = continueAs(seed, framing, body, 0, site.bulked, bodyCtx, fresh, labels);
  if (!tail || tail.effects?.length) return null;
  const keyed = decorrelate(tail.rel, sc.scoped, sc.key, fresh);
  if (!keyed) return null;
  // THE VALUE NODE: the reduced value of the key's pool, one row per key (a FIRST, for a body whose last
  // barrier is not its last step and could still fan out — `doFinalReduction` reads `next()`).
  const valueCols = framingCols(tail.framing);
  if (!valueCols || valueCols.length > (tail.framing.kind === 'scalar' ? 2 : 1)) return null;
  const first = firstPerScope({ rel: keyed.rel, keyCol: keyed.keyCol, tail }, valueCols.map((column) => column.name), fresh);
  const joined = make.join({
    id: fresh('pgj'), left: sc.scoped, right: first.rel, join: 'inner', channels: [],
    type: typeOf(...sc.scoped.type.cols, ...first.rel.type.cols),
    on: eq(col(sc.scoped.id, sc.key), col(first.rel.id, first.key)),
  });
  const valueExpr = col(joined.id, first.renamed.get(valueCols[0]!.name)!);
  const produced: ChildValue = {
    expr: valueExpr, framing: tail.framing, yields: 'one', present: 'always',
    ...(valueCols[1] ? { vtype: col(joined.id, first.renamed.get(valueCols[1].name)!) } : {}),
  };
  const valueFraming = tail.framing;
  // A list value is NESTED in the map, so its members must describe themselves (`selfDescribingList`) — and
  // be members the tree framer can walk (`listNodeExpr`): a path member has no `{t:'path'}` node yet.
  if (valueFraming.kind === 'list' && !treeFramed(valueFraming.of)) return null;
  // …and a MAP value keeps its element rowids for the root framer, which expands them through `singleOf`
  // (`mapNodePayload`, recursive over a nested map); any other value shape is not one this node builder states.
  if (valueFraming.kind !== 'list' && valueFraming.kind !== 'map' && valueFraming.kind !== 'scalar' && valueFraming.kind !== 'elements') return null;
  const listed = valueFraming.kind === 'list' ? selfDescribingList(valueExpr, valueFraming.of, fresh) : null;
  const node = listed ? listNode(listed.list) : memberNodeOf(produced, ctx.source, fresh);
  if (!node) return null;
  const singleOf: MapOf = valueFraming.kind === 'list' ? { kind: 'list', of: listed!.of, ...(valueFraming.set ? { set: true } : {}) }
    : valueFraming.kind === 'map' ? { kind: 'map', of: valueFraming.valOf } : { kind: 'scalar' };
  const grouped = keyedValuesMap(joined, col(joined.id, KEY), keyElem, node, singleOf, step, ctx.source, fresh);
  return continueAs(grouped.rel, { kind: 'map', keyOf: grouped.keyOf, valOf: grouped.valOf }, steps, at + 1, false, ctx, fresh, NO_ALIASES);
}

/** THE CONNECTOR TABLE — one row per host, keyed by step name (§2 S4). */
const CONNECTORS: ReadonlyMap<string, Connector> = new Map<string, Connector>([
  ['where', existence(false)],
  ['filter', existence(false)],
  ['and', existence(false)],
  ['or', existence(false)],
  ['flatMap', allRows('split')],
  ['choose', chooseRoute],
  ['union', globalArms],
  ['local', allRows('forward')],
  ['not', existence(true)],
  ['map', firstInner],
  ['coalesce', priority],
  ['optional', priority],
  ['project', recordLeft],
  ['order', byValues],
  ['dedup', byValues],
  ['groupCount', byValues],
  ['group', byValues],
]);

// The chain facts seed a path for a connector body that reads one (`CONNECTOR_HOSTS`, `ir/analyze.ts`), so the
// two host sets are one fact — kept equal here, loudly, rather than by a reader's care.
if (CONNECTORS.size !== CONNECTOR_HOSTS.size || [...CONNECTORS.keys()].some((name) => !CONNECTOR_HOSTS.has(name)))
  throw new Error('RelIR lowering: CONNECTORS and CONNECTOR_HOSTS (ir/analyze.ts) name different hosts');

/** Is the ladder lowering THIS connector site right now (`ChildStrategy.ladderAt`)? Then a tail must not hand
 *  it back to `continueAs`. */
export const atLadder = (ctx: ChainCtx, steps: readonly IRStep[], at: number): boolean =>
  ctx.ladderAt?.steps === steps && ctx.ladderAt.at === at;

/** Is `step` a site a connector may own? The cheap gate a tail loop asks before yielding to `continueAs`. */
export const connectorSite = (step: IRStep | undefined): boolean =>
  !!step && CONNECTORS.has(step.name) && (step.name === 'project' || step.args.some((arg) => isNested(arg.value))
    || (step.modulators ?? []).some((by) => by.some(isNested)));

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

