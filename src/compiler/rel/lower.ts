import { withChannel, type Channel, type Channels } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { DO_BIND_CAP, planBindCount } from '../../rel/check.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta, SortTerm } from '../../rel/types.ts';
import { isLocalScope, sliceOf } from '../ir/step.ts';
import { PER_ROW, STATIC, UNKNOWN, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { flattenListArgs, isNested } from '../../gremlin/frontend.ts';
import { childSteps, collectionAssert } from '../steps/tail/child-shape.ts';
import type { IRStep } from '../ir/strategies.ts';
import { analyzeChain } from '../ir/analyze.ts';
import { containsTextSearch, predicateExpr, SUBJECT_UNKNOWN, type SubjectType } from './predicate.ts';
import { bareInjectTag } from '../steps/write/inject.ts';
import {
  and, EDGE_COLS, eq, labelIds, meta, minter, NODE_COLS, PROPERTIES, storedValue, typeOf,
  type Minter,
} from './build.ts';
import { byExpr, modulations, orderProductivity, productivityFilter, type ByHost, type Modulation } from './modulator.ts';
import { REL_TRANSFORMS, transformExpr } from './transform.ts';
import { isReducer, reducerAggregate } from './reducer.ts';

/**
 * THE SECOND LOWERING — `Step[] -> RelIR` (§10·4 of `docs/2026-08-01-relir-build-plan.md`).
 *
 * The legacy spine (`LoweringEngine`) builds SQL into an append-only `Query`, so the query never
 * exists as data and every optimization has to happen before or during lowering. This module is the
 * replacement route, and it grows STEP BY STEP: a traversal whose every step is covered here lowers
 * to a `Plan` and takes the RelIR route end-to-end; anything else returns `null` and the legacy
 * spine handles it whole. **Never mixed inside one traversal** — that is what keeps RelIR a real
 * algebra rather than a wrapper, and it is why there is no opaque escape node and never will be
 * (§10·4: "not as a bridge, not temporarily, not behind a flag").
 *
 * `null` is therefore the ONLY decline, and it must stay cheap and total: a step this module has
 * not learned yet is not an error, it is coverage that has not been written. What it must never do
 * is answer a DIFFERENT question — a partial lowering that silently drops a filter would be
 * invisible to the differential, since both spines would be asked and only one asked correctly.
 *
 * ## What this module does NOT do
 *
 * **Framing.** Gremlin shape is resolved above RelIR and rides to the wire as `Compiled.shape`
 * (§2), so this returns a RELATION plus the channel/layout facts the framing layer needs, and
 * `spine.ts` hands that to the existing per-shape framing. Re-encoding the element payload
 * projection in RelIR would be §7's named risk ("re-encoding, not simplification") for no gain: the
 * shape-interpreting class stays per-shape forever and correctly so.
 */

/**
 * WHAT THE FRAMING LAYER MUST BUILD over the result relation — the shape half of a lowering.
 *
 * Gremlin shape is resolved ABOVE RelIR and rides to the wire as `Compiled.shape` (§2), so a
 * lowering hands back a relation plus the minimum the framing layer needs to pick its per-shape
 * projection. This union is that minimum, and it is deliberately a union rather than a widened
 * record: an element stream has no scalar type and a scalar stream has no element kind, and
 * pretending otherwise is how a shape vocabulary starts leaking into the algebra.
 *
 * It grows one arm per stream kind the spine learns, and `spine.ts` switches on it TOTALLY — the
 * shape-interpreting class stays per-shape forever and correctly so (§6, Phase 4).
 */
export type RelFraming =
  | { readonly kind: 'elements'; readonly elem: Elem }
  | { readonly kind: 'scalar'; readonly type: ScalarType; readonly result?: 'value' | 'count' | 'number' };

/**
 * A covered chain, lowered: the program, and what to frame over it.
 *
 * The output COLUMNS and the CHANNELS are deliberately absent: both are properties of
 * `plan.result`, and carrying them beside it was two bookkeeping variables threaded through every
 * arm of the fold with nothing but discipline keeping them in step with the relation they described.
 * `spine.ts` reads them off the result (§9's declare-vs-derive finding, applied where the desync was
 * actually reachable — a channel list shorter than the relation's is the 33% defect category).
 */
export interface RelLowering {
  readonly plan: Plan;
  readonly framing: RelFraming;
}

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];

/**
 * The EMISSION-ORDER channel, and the second carried role this route models.
 *
 * A chain that slices has an answer depending on which rows come first; `analyzeChain` marks it
 * `demandsEncounter` and the SOURCE seeds a monotone column — but that flag is only ever the seed's
 * question, never the plan's. **The channel set is a property of each RELATION**, so an `order()`
 * MINTS this channel where none arrived and every reader downstream keys on its presence rather than
 * on a chain-global boolean threaded from the source. That is why `withChannel` exists in the core:
 * `ROLE_ORDER` is an invariant of a `Channels` list, and the framing layer's `layoutCols` sorts the
 * same way — bulk before encounter — so a mint that appended out of order would desync the declared
 * schema from the physical one.
 */
const ENCOUNTER: Channel = { col: 'encounter', role: 'encounter' };
const encounterOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'encounter');

/**
 * An element relation's DECLARED COLUMNS: the traverser's id, then one column per carried channel,
 * in the channel list's own order.
 *
 * Derived from the channels rather than from a boolean, which is the whole of the model change: a
 * chain no longer has one element shape decided at its source, so every producer here asks its
 * INPUT what it carries. A role this route grows tomorrow gets its column with no edit at all.
 */
const elementCols = (channels: Channels): readonly ColMeta[] =>
  [meta('id', 'int'), ...channels.map((channel) => meta(channel.col, 'int'))];



/**
 * A source-scope FILTER as a predicate over the element scan — the whole of `hasLabel`/`has` that
 * needs no predicate vocabulary.
 *
 * Written against the SCAN rather than against a projected id-relation, which is the structural
 * difference from the legacy spine and the point of the exercise: legacy gives every filter its own
 * CTE that re-joins the element table to reach a column its predecessor projected away
 * (`… FROM nodes n JOIN c1 p ON n.id=p.id WHERE EXISTS(…)`), so `has(a).has(b)` is three CTEs and
 * two redundant self-joins. Here they conjoin into ONE `WHERE` over one scan, because a filter
 * neither changes the relation's cardinality contract nor consumes a channel, and the plan is data
 * so a later step can still see the columns.
 */
/** What a filter may read about the element it is filtering. `label` is present only where the
 *  relation physically carries it — an edge SCAN does, a moved id-relation does not — so the edge
 *  label test can take the direct column read at the source and the membership form elsewhere,
 *  without either position having to know which it is in. */
interface Subject { readonly id: Expr; readonly label?: Expr; readonly rel: Rel; }

/** What a filter needs beyond the step and its subject: the bound parameters a nested body parses
 *  against, and whether the correlated-child form is this compile's to emit (see `Lowering`). */
interface FilterCtx { readonly params: Record<string, any>; readonly correlatedChildren: boolean; }

function sourceFilter(step: IRStep, subject: Subject, elem: Elem, fresh: Minter, ctx: FilterCtx): Expr | null {
  // One filter form HOSTS a `by()` — the alias-compare `where('a', P.eq('b')).by('key')`, which
  // `isAliasCompareWhere` detects structurally rather than by name — and it is not covered at all
  // (it needs the alias channel). So this stays a blanket decline, and `modulator.ts` is what it will
  // read when that lands; the vocabulary is already there, which is the point of having built it as
  // one. Every other step reaching here (`hasLabel`, `has`, `filter`, `not`) is not a `BY_HOSTS`
  // member, so a modulator on one is a front-end impossibility and declining is belt-and-braces.
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];

  if (step.name === 'hasLabel') {
    const names = flattenListArgs(args);
    if (!names.length || names.some((n) => typeof n !== 'string')) return null;
    const ids = labelIds(names as string[], fresh);
    // An EDGE carries its label inline; a VERTEX may hold several, in a side table. Two different
    // physical questions, which is exactly why `Scan` is the only node that names a table.
    if (elem === 'edge') {
      // Direct where the column is physically present (the source scan), and a membership test on
      // the edge id where it is not (after a movement, the relation is `id` + channels). Same
      // question, and the first form keeps the covering-index read the source position deserves.
      if (subject.label) return { kind: 'in-query', expr: subject.label, plan: ids, negated: false };
      const e = make.scan({ id: fresh('el'), table: 'edges', alias: fresh('rel'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
      const matching = make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: { kind: 'in-query', expr: col(e.id, 'label'), plan: ids, negated: false } });
      const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
      return { kind: 'in-query', expr: subject.id, plan: owners, negated: false };
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const matching = make.filter({ id: fresh('f'), input: vl, channels: [], type: vl.type, pred: { kind: 'in-query', expr: col(vl.id, 'label'), plan: ids, negated: false } });
    const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('node', 'int')), exprs: [['node', col(matching.id, 'node')]] });
    return { kind: 'in-query', expr: subject.id, plan: owners, negated: false };
  }

  // `where`/`filter`/`not` over a TRAVERSAL body: a correlated existence test, which is the same
  // question `has` asks of a property row asked of a whole sub-traversal. The body folds through
  // the SAME movement and filter vocabulary as the outer chain — that reuse is the point, and it
  // is why growing movement grew this for free.
  if (step.name === 'where' || step.name === 'filter' || step.name === 'not') {
    const [nested, extra] = args;
    if (extra !== undefined || !isNested(nested)) return null;
    // The correlated EXISTS is `predicateInlining`'s form. With the switch OFF the legacy spine
    // lowers a MATERIALIZED child-existence gate instead — a pushed ordinal, a LEFT JOIN and a
    // rejoin — which is a lowering STRATEGY this route has not learned, so it declines exactly as
    // it declines an unlearned step. That is not spine choice reading the fast-path config to dodge
    // an optimization (the FTS rule): the flag selects between two strategies and RelIR implements
    // one of them, so both positions stay live and L5's differential still compares two forms.
    if (!ctx.correlatedChildren) return null;
    const body = childSteps(nested.nested, ctx.params);
    if (!body.length) return null;
    // The body's FIRST step must be a movement: it is what makes the child a relation to test for
    // rows at all. A filter-only body (`where(__.has('name','x'))`) is a predicate on the SAME
    // traverser, not a sub-traversal — legacy inlines it directly and there is nothing to gain by
    // wrapping it in an EXISTS here.
    let child = movement(body[0]!, { correlated: subject.id }, elem, fresh);
    if (!child) return null;
    for (const inner of body.slice(1)) {
      const hop = movement(inner, { rel: child.rel }, child.elem, fresh);
      if (hop) { child = hop; continue; }
      const clause = sourceFilter(inner, { id: col(child.rel.id, 'id'), rel: child.rel }, child.elem, fresh, ctx);
      if (!clause) return null;
      child = { rel: make.filter({ id: fresh('f'), input: child.rel, channels: BULK, type: child.rel.type, pred: clause }), elem: child.elem };
    }
    const probe = make.project({ id: fresh('p'), input: child.rel, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', lit(1, 'int')]] });
    // `NOT EXISTS`, not legacy's `NOT COALESCE(EXISTS(…), 0)`: EXISTS is never NULL, so the
    // COALESCE guards nothing here.
    return { kind: 'exists', plan: probe, negated: step.name === 'not' };
  }

  if (step.name === 'has') {
    // `has(key)` and `has(key, <value-or-predicate>)`. `has(label, key, value)` and the `T`-token
    // forms decline rather than being half-answered — a token key is a different question (it
    // reads the element's id or label, not a property row).
    const [key, val, extra] = args;
    if (typeof key !== 'string' || extra !== undefined) return null;
    // A substring `TextP` over a STORED property is `ftsSubstringPredicate`'s, and taking it here
    // would swap a trigram-index seek for a base-table LIKE scan — a regression the census cannot
    // see, reported by the coverage number as progress. §4.7 lifts this.
    if (containsTextSearch(val)) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // The property row's own `vtype` is in scope here, so an ordering comparison gets the
    // vtype-aware key — the whole reason `predicateExpr` takes `compare` as a parameter.
    const matches = val === undefined ? undefined
      : predicateExpr(col(props.id, 'value'), val, { kind: 'perRow', vtype: col(props.id, 'vtype') });
    if (val !== undefined && !matches) return null;

    const matching = make.filter({
      id: fresh('f'), input: props, channels: [], type: props.type,
      pred: matches
        ? and(and(eq(col(props.id, owner), subject.id), eq(col(props.id, 'key'), lit(key, 'text'))), matches)
        : and(eq(col(props.id, owner), subject.id), eq(col(props.id, 'key'), lit(key, 'text'))),
    });
    // `EXISTS (SELECT 1 …)`, correlated on the outer scan — a property FILTER asks whether a row
    // exists, and joining instead would multiply the traverser once per matching property.
    const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', lit(1, 'int')]] });
    return { kind: 'exists', plan: probe, negated: false };
  }

  return null;
}

/**
 * `V(...)` / `E(...)` — the element source, and the same relation the legacy `seedSource` builds for
 * the same arguments: one row per element at bulk 1, narrowed by an id list bounded by the QUERY
 * TEXT (never by row count, so `InList` is right here and a JSON bind is not).
 *
 * Numeric args match the rowid and string args the user id, because the id-relation carries rowids
 * throughout and a `uid` match still projects the rowid. That asymmetry is the storage schema's,
 * which is why it lives at the one node that names a table.
 */
function elementScan(step: IRStep, fresh: Minter): { scan: Rel; pred?: Expr; elem: Elem } | null {
  const elem: Elem = step.name === 'E' ? 'edge' : 'vertex';
  // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
  // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal
  // SQL and silently resolve an outer correlation to the inner table.
  const scan = make.scan({
    id: fresh('src'), table: elem === 'edge' ? 'edges' : 'nodes', alias: elem === 'edge' ? 're' : 'rn', channels: [],
    type: typeOf(...(elem === 'edge' ? EDGE_COLS : NODE_COLS)),
  });

  const ids = flattenListArgs(step.args);
  const nums = ids.filter((a): a is number => typeof a === 'number');
  const strs = ids.filter((a): a is string => typeof a === 'string');
  // An id argument that is neither is a hard error in the legacy spine too, but this route must
  // not THROW on a shape it merely has not learned — declining routes it to the spine that owns
  // the message.
  if (ids.length !== nums.length + strs.length) return null;

  const clauses: Expr[] = [];
  if (nums.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'id'), values: nums.map((n) => lit(n, 'int')) });
  if (strs.length) clauses.push({ kind: 'in-list', expr: col(scan.id, 'uid'), values: strs.map((s) => lit(s, 'text')) });
  const pred = clauses.reduce<Expr | undefined>((left, right) =>
    left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
  return { scan, pred, elem };
}

/**
 * MOVEMENT — the graph algebra proper, as a join over `edges` and a re-projection.
 *
 * Six adjacency steps plus the three endpoint reads, each one direction table entry: which edge
 * column matches the incoming id, and which column the outgoing id comes from. `both`/`bothE`/
 * `bothV` are the UNION of their two halves and get no special case beyond being two entries — the
 * multiset rule means UNION ALL, so a self-loop legitimately yields the vertex twice.
 *
 * `otherV` is absent, and deliberately: it reads the entering vertex a preceding edge step
 * retained (`fromV`), which is carried state this route does not yet model. Declining is the whole
 * contract — a movement that quietly forgot which end it came from is a wrong answer.
 */
interface Hop { readonly from: 'src' | 'tgt' | 'id'; readonly to: 'src' | 'tgt' | 'id'; readonly elem: Elem; }
const HOPS: Readonly<Record<string, readonly Hop[]>> = {
  out: [{ from: 'src', to: 'tgt', elem: 'vertex' }],
  in: [{ from: 'tgt', to: 'src', elem: 'vertex' }],
  both: [{ from: 'src', to: 'tgt', elem: 'vertex' }, { from: 'tgt', to: 'src', elem: 'vertex' }],
  outE: [{ from: 'src', to: 'id', elem: 'edge' }],
  inE: [{ from: 'tgt', to: 'id', elem: 'edge' }],
  bothE: [{ from: 'src', to: 'id', elem: 'edge' }, { from: 'tgt', to: 'id', elem: 'edge' }],
  inV: [{ from: 'id', to: 'tgt', elem: 'vertex' }],
  outV: [{ from: 'id', to: 'src', elem: 'vertex' }],
  bothV: [{ from: 'id', to: 'src', elem: 'vertex' }, { from: 'id', to: 'tgt', elem: 'vertex' }],
};

/** Steps whose input must already be an edge (`inV`/`outV`/`bothV`) vs a vertex. Mis-applying one
 *  is a hard error in the legacy spine; here it is a decline, so that spine keeps owning the
 *  message rather than this route inventing a second one. */
const FROM_EDGE = new Set(['inV', 'outV', 'bothV']);

/**
 * Where a hop starts from: an incoming id-RELATION (the ordinary case, joined) or a single
 * correlated id EXPRESSION (a child body's first hop, compared).
 *
 * The correlated form is what lets a `where()` body be lowered with no seed node at all. The legacy
 * spine writes `(SELECT n.id AS id) p` — a projection with no input, which RelIR has no node for —
 * and §7's bar says a missing node needs proof the seam cannot EXPRESS the shape. It can: compare
 * the edge column to the outer expression directly, which is one derived table FEWER than the form
 * it replaces. Both arms produce the same `(id, bulk)` shape, so every hop after the first is the
 * ordinary one and there is no second movement implementation.
 */
type Frontier = { readonly rel: Rel } | { readonly correlated: Expr };
const frontierRel = (from: Frontier): Rel | undefined => ('rel' in from ? from.rel : undefined);

function movement(step: IRStep, from: Frontier, elem: Elem, fresh: Minter): { rel: Rel; elem: Elem } | null {
  const hops = HOPS[step.name];
  if (!hops || step.modulators?.length || step.optionArms) return null;
  if (FROM_EDGE.has(step.name) !== (elem === 'edge')) return null;

  const labels = flattenListArgs(step.args ?? []);
  if (labels.some((l) => typeof l !== 'string')) return null;
  // A label restriction is meaningless on an endpoint read — the edge is already chosen — and
  // TinkerPop's inV()/outV() take no arguments at all.
  if (labels.length && FROM_EDGE.has(step.name)) return null;

  const input = frontierRel(from);
  // WHAT THE HOP CARRIES is its input's channels, read off the frontier rather than off a
  // chain-global flag. Only a ROOTED hop carries anything at all: a correlated one lives inside an
  // `EXISTS`, which asks whether a row is there and never in what order — so its `bulk` is synthetic
  // and it carries no position.
  const carried = input ? input.channels : BULK;
  const armCols = elementCols(carried);
  const arms = hops.map((hop) => {
    const e = make.scan({
      id: fresh('mv'), table: 'edges', alias: fresh('rme'), channels: [],
      type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
    });
    const incoming = input ? col(input.id, 'id') : (from as { readonly correlated: Expr }).correlated;
    const on = labels.length
      ? and(eq(col(e.id, hop.from), incoming),
        { kind: 'in-query', expr: col(e.id, 'label'), plan: labelIds(labels as string[], fresh), negated: false })
      : eq(col(e.id, hop.from), incoming);
    // A correlated hop FILTERS the edge table against the outer id; a rooted one JOINS the incoming
    // frontier, `edges` on the LEFT — the join order the legacy spine emits, so the access path
    // stays the one the covering indexes were built for. The projection is identical either way,
    // which is what keeps the second hop from needing a second implementation. A correlated body's
    // `bulk` is synthetic: an EXISTS asks whether a row is there, never how many traversers it is.
    const source = input
      ? make.join({
        id: fresh('j'), left: e, right: input, join: 'inner', on, channels: carried,
        type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int'), meta('pid', 'int'),
          ...carried.map((channel) => meta(channel.col, 'int'))),
      })
      : make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: on });
    // The arm carries the INCOMING position through unchanged; re-minting happens once over the
    // whole fan-out below, not per arm — two arms each numbering from 1 would interleave.
    return make.project({
      id: fresh('m'), input: source, channels: carried, type: typeOf(...armCols),
      exprs: [['id', col(source.id, hop.to)],
        ...(input
          ? carried.map((channel) => [channel.col, col(source.id, channel.col)] as const)
          : [['bulk', lit(1, 'int')] as const])],
    });
  });
  const [first, ...rest] = arms;
  if (!first) return null;
  // N-ary UNION ALL, minted once — and ALL, never distinct: traversers are a multiset, so a vertex
  // reachable both ways is two traversers.
  const fanned = rest.length
    ? make.union({ id: fresh('u'), inputs: arms, all: true, channels: carried, type: typeOf(...armCols) })
    : first;
  const encounter = encounterOf(carried);
  return { rel: encounter ? remintOrder(fanned, encounter, fresh) : fanned, elem: hops[0]!.elem };
}

/**
 * THE ROW-ALGEBRAIC CLASS over an element relation — Phase 4.1, and only the part of it that is a
 * relation operator rather than a framing one.
 *
 * `dedup()` is `Distinct` over a projection that RESETS the multiplicity: collapsing duplicates
 * means the survivor is one traverser, not the sum of the ones it stood for. `identity()` is the
 * universal no-op and is here rather than nowhere because it composes — a chain is not less covered
 * for containing one.
 *
 * `order()` IS here, and as a MINT of the emission-order channel rather than as anything new (see
 * `elementOrder`). `tail`/`sample` are still absent: `tail` reads the order BACKWARDS and `sample`
 * has no stable position at all, so each is its own increment rather than one blanket "not yet".
 */
/**
 * `limit`/`skip`/`range` over ANY relation that carries an emission order — element or scalar, which
 * is why it is its own function rather than an arm of the element fold. What it needs is not a
 * SHAPE but a channel: a window is only a window if there is an order to take it from.
 *
 * A relation with no order still slices where the order cannot matter — after `count()`, whose one
 * row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question. Legacy emits the bare `LIMIT`
 * there and this matches it, because emitting a sort over a single row would be a difference in
 * the plan for no difference in the answer.
 */
function sliceOp(step: IRStep, input: Rel, bulked: boolean, fresh: Minter): Rel | null {
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return null;
  if (!SLICE_STEPS.has(step.name)) return null;
  const encounter = encounterOf(input.channels);
  const bulk = input.channels.find((channel) => channel.role === 'bulk');

  // `sample(n)` is n traversers chosen UNIFORMLY — `SampleGlobalStep` is a weighted reservoir sample
  // whose weights come from a `by()`, and with no modulator every weight is 1. `ORDER BY RANDOM()
  // LIMIT n` is that, and it needs no emission order at all: which n is the answer, not which order
  // they come in (the root still sorts by the carried position, so the sample is REPORTED in emission
  // order — the same shape legacy emits). A `by()` declines through the blanket modulator gate above.
  //
  // Over a COLLAPSED relation it declines rather than sampling: a uniform sample of ROWS is not a
  // uniform sample of traversers when a row stands for N of them, and there is no trimming to do —
  // sample has no band, so `bulkSlice` has nothing to say about it.
  if (step.name === 'sample') {
    if (bulked) return null;
    const shuffled = make.sort({
      id: fresh('sh'), input, channels: input.channels, type: input.type,
      terms: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }],
    });
    return make.limit({ id: fresh('li'), input: shuffled, channels: input.channels, type: input.type, count: lit(countArg(step), 'int') });
  }

  // `tail(n)` is `limit(n)` read from the FAR END, so it is the direction flag on the shared slice
  // rather than a fourth builder — and it is the one window `sliceOf` will not decode, because "the
  // last n" is an offset only once something supplies the member count. Nothing has to: read the
  // relation backwards and the count never appears.
  //
  // It NEEDS a carried position, and that is not a limitation to work around — "last" is a question
  // ABOUT emission order, so a relation carrying none has no last. Declining hands it to the spine
  // that owns the message.
  if (step.name === 'tail') {
    if (!encounter) return null;
    const last = { offset: 0, limit: countArg(step) };
    if (bulked && bulk) return bulkSlice(input, last, encounter, bulk, 'desc', fresh);
    return slice(input, last, encounter, 'desc', fresh);
  }

  // `sliceOf` REJECTS an illegal range (`range(2,1)`) by throwing, which is right where it is the
  // only answer available — but this module's contract is that `null` is its only decline, and a
  // throw from here would mean the RelIR route raising an error the legacy spine has not reached
  // yet. Declining hands the traversal to the spine that owns the message, which raises the
  // identical one. Found by sweeping every prefix of every corpus traversal under all four switch
  // combinations, which is the only way a decline-contract violation shows up at all.
  let window;
  try { window = sliceOf(step); } catch { return null; }
  // A COLLAPSED relation's row stands for `bulk` traversers, so `LIMIT n` would take n ROWS and
  // answer a different question. `bulked` says the multiplicity is not provably 1, and then the
  // slice must count traversers — which needs a position to accumulate along, so a bulked relation
  // with no emission order declines rather than guessing one.
  if (bulked && bulk) return encounter ? bulkSlice(input, window, encounter, bulk, 'asc', fresh) : null;
  return slice(input, window, encounter, 'asc', fresh);
}

/** The row slice steps this fold serves. `tail` and `sample` are here as DIRECTIONS and a shuffle on
 *  the same op rather than as separate arms, which is what `globalRowOps` says with its own three
 *  handlers over one `reprojectRows`. */
const SLICE_STEPS = new Set(['limit', 'skip', 'range', 'tail', 'sample']);

/** `tail(n)`/`sample(n)`'s count. Both default to 1, and neither takes a range, so the numeric
 *  argument is the whole decode — `sliceOf` deliberately refuses `tail` (see `sliceOp`). */
const countArg = (step: IRStep): number =>
  Number((step.args ?? []).find((arg: unknown) => typeof arg === 'number') ?? 1);

/** `ORDER BY <position> [DESC] LIMIT/OFFSET` — the plain slice, where a row IS one traverser. An
 *  unordered relation stays unordered rather than inventing a SQLite scan order: a slice with no
 *  position to take a window from only reaches here where the order cannot matter (after `count()`,
 *  whose one row makes `LIMIT 1` and `ORDER BY … LIMIT 1` the same question). */
function slice(
  input: Rel, window: { readonly offset: number; readonly limit: number | null },
  encounter: Channel | undefined, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  const source = encounter
    ? make.sort({
      id: fresh('so'), input, channels: input.channels, type: input.type,
      terms: [{ expr: col(input.id, encounter.col), dir }],
    })
    : input;
  return make.limit({
    id: fresh('li'), input: source, channels: input.channels, type: input.type,
    ...(window.limit === null ? {} : { count: lit(window.limit, 'int') }),
    ...(window.offset ? { offset: lit(window.offset, 'int') } : {}),
  });
}

/**
 * A SLICE THAT COUNTS TRAVERSERS — the cumulative-bulk window, and the composition that makes
 * element `order()` safe to cover at all.
 *
 * Under `movementCollapse` a row is an (element, N) pair, so the traverser a slice's boundary falls
 * inside is a row whose multiplicity must be TRIMMED rather than taken or dropped whole. A running
 * `SUM(bulk)` over the emission order gives each row the index one past its last traverser (`cum`),
 * so the row covers the half-open band `[cum - bulk, cum)`; the slice keeps the rows whose band
 * intersects `[offset, offset + limit)` and re-projects `bulk` as the width of the intersection.
 *
 * Legacy hand-rolls exactly this shape in the element FRAMING projection (`buildProjection`'s
 * bulk-aware limit/range), where it can only happen once and only at the end. Here it is four
 * ordinary nodes over any relation carrying a multiplicity and a position — which is why it serves
 * the element fold and the scalar tail from one place, and why `order().limit()` composes rather
 * than being a shape the framing layer has to recognise.
 *
 * The frame is explicit (`ROWS UNBOUNDED PRECEDING … CURRENT ROW`) rather than left to SQLite's
 * default: over a total order the default `RANGE` form agrees, but the emission order is only total
 * because the mint tie-broke it, and a window whose correctness depends on a caller's tie-break
 * argument is the kind of thing that goes wrong silently when the caller changes.
 */
function bulkSlice(
  input: Rel, window: { readonly offset: number; readonly limit: number | null },
  encounter: Channel, bulk: Channel, dir: 'asc' | 'desc', fresh: Minter,
): Rel {
  const lo = window.offset;
  const hi = window.limit === null ? null : lo + window.limit;
  const running = make.window({
    id: fresh('bw'), input, channels: input.channels,
    type: typeOf(...input.type.cols, meta('cum', 'int')),
    specs: [['cum', {
      kind: 'window-expr', fn: 'sum', args: [col(input.id, bulk.col)],
      spec: {
        // The direction is the whole of `tail(n)`: accumulate BACKWARDS and the band `[0, n)` is the
        // last n traversers instead of the first. The rows keep their positions either way, so the
        // root's `ORDER BY <position>` still reports them in emission order.
        partitionBy: [], orderBy: [{ expr: col(input.id, encounter.col), dir }],
        frame: { mode: 'rows', start: { kind: 'unbounded-preceding' }, end: { kind: 'current-row' } },
      },
    }]],
  });
  // Each node addresses its own INPUT's columns, so the band is spelled twice against two relations
  // rather than once against a relation that is out of scope where it is read.
  const band = (rel: Rel): { readonly first: Expr; readonly past: Expr } =>
    ({ first: { kind: 'binary', op: '-', left: col(rel.id, 'cum'), right: col(rel.id, bulk.col) }, past: col(rel.id, 'cum') });
  const inner = band(running);
  const kept = make.filter({
    id: fresh('bf'), input: running, channels: running.channels, type: running.type,
    pred: and(
      { kind: 'binary', op: '>', left: inner.past, right: lit(lo, 'int') },
      hi === null ? undefined : { kind: 'binary', op: '<', left: inner.first, right: lit(hi, 'int') },
    ),
  });
  const outer = band(kept);
  const from: Expr = lo ? { kind: 'call', fn: 'MAX', args: [outer.first, lit(lo, 'int')] } : outer.first;
  const to: Expr = hi === null ? outer.past : { kind: 'call', fn: 'MIN', args: [outer.past, lit(hi, 'int')] };
  return make.project({
    id: fresh('bs'), input: kept, channels: input.channels, type: input.type,
    exprs: input.type.cols.map((column) => [column.name, column.name === bulk.col
      ? { kind: 'binary', op: '-', left: to, right: from } as Expr
      : col(kept.id, column.name)] as const),
  });
}

function rowOp(step: IRStep, input: Rel, elem: Elem, bulked: boolean, fresh: Minter): Rel | null {
  if (step.optionArms) return null;
  if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;
  if (step.name === 'order') return elementOrder(step, input, elem, fresh);
  const sliced = sliceOp(step, input, bulked, fresh);
  if (sliced) return sliced;

  if (step.name !== 'dedup' || (step.args ?? []).length || isLocalScope(step)) return null;

  const ordered = !!encounterOf(input.channels);
  const bys = modulations(step, 1);
  if (!bys) return null;
  if (bys[0]) return dedupBy(step, bys[0], input, elem, fresh);

  // `dedup()` RESETS the multiplicity: the survivor stands for itself, not for the sum of the
  // duplicates it replaced.
  //
  // Under an emission order it stops being a `Distinct` at all, and the reason is semantic rather
  // than mechanical: the survivor must keep the FIRST occurrence's position, so the step is a
  // GROUPING by traverser identity that takes `MIN(encounter)`. That is the per-traverser reduction
  // the channel core's third policy table (`CHANNEL_GROUP_POLICY`) exists to permit — a grouping
  // may carry a role only where N-rows-into-one has a defined answer, which `bulk` and `encounter`
  // have and an alias, a path or a sack do not.
  if (!ordered) {
    const projected = make.project({
      id: fresh('dd'), input, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
      exprs: [['id', col(input.id, 'id')], ['bulk', lit(1, 'int')]],
    });
    return make.distinct({ id: fresh('d'), input: projected, channels: BULK, type: projected.type });
  }
  return make.aggregate({
    id: fresh('dd'), input, channels: input.channels, type: typeOf(...elementCols(input.channels)),
    groupBy: [col(input.id, 'id')],
    aggs: [['bulk', lit(1, 'int')], ['encounter', { kind: 'agg', fn: 'min', args: [col(input.id, 'encounter')] }]],
  });
}

/**
 * `dedup().by(<projection>)` over an ELEMENT relation — the first host to take a real `by()`.
 *
 * It is a `Window` + `Filter`, not a grouped aggregate, and the difference is the reason: the survivor
 * is the one traverser with the LOWEST id per key, and every other column must be ITS values — an
 * `Aggregate` can produce `MIN(id)` but not "the encounter belonging to the row that had it". That is
 * what a ranked window says and an aggregate cannot, so this is the shape legacy emits too.
 *
 * PRODUCTIVITY is the vocabulary's, not this host's: TinkerPop drops a traverser whose `by()` yielded
 * nothing (`DedupGlobalStep.filter` → `product.isProductive()`), and `ProductiveByStrategy` turns that
 * off. `productivityFilter` returns the predicate or `undefined`, so the rule cannot be forgotten here.
 *
 * **`bulk` RESETS to 1, which is the reference's rule and NOT the spelling legacy uses.** TinkerPop's
 * `DedupGlobalStep.filter` calls `traverser.setBulk(1L)` unconditionally — before it even looks at the
 * `by()` — so a survivor stands for itself whether or not a projection was given
 * (`vendor/tinkerpop/gremlin-core/.../DedupGlobalStep.java:75`). Legacy carries `p.bulk` through
 * instead, and the two are NOT observably different: `analyzeChain`'s collapse-safety rule excludes a
 * `dedup` that has modulators, so `movementCollapse` never fires upstream of one and the multiplicity
 * is provably 1 where it arrives. Checked, not assumed — `g.V().both().both().dedup().by('lang')`
 * emits no `GROUP BY` on either spine. So this is not a divergence to reconcile; it is the form that
 * stays correct if that safety rule is ever relaxed, at no cost today.
 */
function dedupBy(step: IRStep, modulation: Modulation, input: Rel, elem: Elem, fresh: Minter): Rel | null {
  // A comparator on `dedup()` is not a form Gremlin has — `DedupGlobalStep` is not a comparator host —
  // so an `Order` in its `by()` is a chain `verifyByModulatorArity` never sees. Decline rather than
  // silently ignoring it.
  if (modulation.order !== undefined) return null;
  const key = byExpr(modulation, { kind: 'element', id: col(input.id, 'id'), elem }, fresh);
  if (!key) return null;

  const productive = productivityFilter(step, key);
  const domain = productive
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: productive })
    : input;
  const cols = elementCols(input.channels);
  // WHICH traverser survives is the EMISSION-ORDER question, not an id question. TinkerPop keeps the
  // FIRST occurrence, so the rank orders by the carried position where there is one and falls back to
  // the element id where there is not — which is the only order a positionless relation has, and the
  // one legacy uses there too (`ORDER BY <orderSql>, p.id`). Ranking by id alone was right only while
  // nothing could mint a position: `g.V().order().by('name',desc).dedup().by('age')` then kept the
  // lowest-id member of each age instead of the first in the sorted stream — the same rows, a
  // different member, which the census's multiset digest DID see (it is a different set) but no
  // assertion in the ladder named.
  const position = encounterOf(domain.channels);
  const ranked = make.window({
    id: fresh('dw'), input: domain, channels: domain.channels, type: typeOf(...cols, meta('rn', 'int')),
    specs: [['rn', {
      kind: 'window-expr', fn: 'row_number', args: [],
      // The element id is always the last term, so the rank is DETERMINISTIC rather than merely
      // ordered — the property `mise run test:perturbed` checks.
      spec: {
        partitionBy: [key],
        orderBy: [...(position ? [{ expr: col(domain.id, position.col), dir: 'asc' as const }] : []),
          { expr: col(domain.id, 'id'), dir: 'asc' as const }],
      },
    }]],
  });
  const survivors = make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: eq(col(ranked.id, 'rn'), lit(1, 'int')),
  });
  return make.project({
    id: fresh('dk'), input: survivors, channels: input.channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name,
      column.name === 'bulk' ? lit(1, 'int') : col(survivors.id, column.name)] as const),
  });
}

/**
 * RENUMBER the emission order — `ROW_NUMBER()` into the `encounter` channel's own column, over
 * whatever order the caller names, leaving every other column exactly as it was.
 *
 * ONE function because the two callers ask the identical question of different orders, and reading
 * them side by side is what makes that visible: a fan-out renumbers by *the incoming position*
 * (several outgoing rows share one, so the old numbers no longer number the new rows), and a
 * scalar `order()` renumbers by *its own sort key* (the sort SUPERSEDES the arriving order, so a
 * later slice must take its window from the new positions and not the stale seed). Legacy has these
 * as two hand-rolled window projections; here the difference is the `terms` argument and nothing
 * else.
 *
 * The last term is a TIE-BREAK, and it is the caller's to supply because only the caller knows what
 * makes its order total. Without one the rows sharing a rank are numbered in whatever order SQLite
 * produced them — right multiset, arbitrary window — which is exactly the defect
 * `mise run test:perturbed` exists to find and which no assertion in the ladder can see.
 *
 * Two nodes because `Window` may only EXTEND its input (§3.5) — it adds the new column, and the
 * projection is what makes that column the channel and drops the stale one. The assembler fuses
 * them back into one SELECT, which is the division of labour §5 describes: the IR stays normalized
 * and the emitter does the composing.
 */
function renumber(
  rel: Rel, terms: readonly SortTerm[], cols: readonly ColMeta[], channels: Channels, fresh: Minter,
): Rel {
  const minted = 'rn';
  const encounter = channels.find((channel) => channel.role === 'encounter');
  // Renumbering a relation with nowhere to put the number is a lowering bug, not a deferral: every
  // caller checks the channel first, so reaching here means a plan was built whose declared type and
  // whose channels disagree — the class of defect the factory's own width checks catch three nodes
  // later, where the cause is no longer visible.
  if (!encounter) throw new Error('RelIR lowering: renumber() needs an encounter channel to mint into');
  // The window EXTENDS its own input (§3.5), so its declared type is the INPUT's columns plus the
  // minted one — not the output's. The two differ exactly when this is a MINT rather than a re-mint:
  // there `cols` names an emission-order column the input does not have yet, and the projection below
  // is where it comes into existence.
  const windowed = make.window({
    id: fresh('w'), input: rel, channels: rel.channels, type: typeOf(...rel.type.cols, meta(minted, 'int')),
    specs: [[minted, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: terms } }]],
  });
  return make.project({
    id: fresh('ro'), input: windowed, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(windowed.id, column.name === encounter.col ? minted : column.name)] as const),
  });
}

/** The fan-out re-mint: renumber by the incoming position, tie-broken on the element id so rows
 *  that shared one incoming traverser get a deterministic order rather than SQLite's. */
const remintOrder = (rel: Rel, encounter: Channel, fresh: Minter): Rel => renumber(
  rel,
  [{ expr: col(rel.id, encounter.col), dir: 'asc' }, { expr: col(rel.id, 'id'), dir: 'asc' }],
  elementCols(rel.channels), rel.channels, fresh,
);

/**
 * ELEMENT `order()` — a MINT of the emission-order channel, and the step the model change was for.
 *
 * There is no new machinery, which is the point: an element relation's order IS the `encounter`
 * channel, and the element materialization already emits `ORDER BY p.encounter` whenever that
 * channel is live — so the whole of `order()` is "renumber by the sort key", the same `renumber` the
 * fan-out re-mint and scalar `order()` already share. `analyzeChain` reports `demandsEncounter`
 * FALSE for these chains (legacy folds the order into the framing clause and needs no channel at
 * all), so the source seeded nothing and this MINTS one — the case a chain-global boolean threaded
 * from the source structurally could not express.
 *
 * Two tie-breaks, and which applies is semantic rather than incidental. Re-minting over a carried
 * position tie-breaks on THAT position, which is what makes the sort STABLE (legacy's
 * `partitionedOrder` says the same). Minting from nothing has no arriving position to be stable
 * against, so it tie-breaks on the element id — deterministic rather than "whichever row SQLite
 * produced first", which is the defect `mise run test:perturbed` exists to find.
 *
 * **NOT a `Sort` of the core relation with the framing on top:** a JOIN's output order is
 * unspecified, so the framing join may return sorted rows in any order — and on a six-vertex
 * fixture it will reliably return the flattering one, which no assertion in the ladder would catch.
 * Minting the channel is what makes the order survive the join, and it is also what makes `order()`
 * COMPOSE: a fold into the framing `ORDER BY` can only happen once, at the end.
 */
function elementOrder(step: IRStep, input: Rel, elem: Elem, fresh: Minter): Rel | null {
  const sort = sortTerms(step, { kind: 'element', id: col(input.id, 'id'), elem }, fresh);
  if (!sort) return null;
  const domain = sort.drop
    ? make.filter({ id: fresh('f'), input, channels: input.channels, type: input.type, pred: sort.drop })
    : input;
  const carried = encounterOf(domain.channels);
  const channels = carried ? domain.channels : withChannel(domain.channels, ENCOUNTER);
  const tie = col(domain.id, carried ? carried.col : 'id');
  return renumber(domain, [...sort.terms, { expr: tie, dir: 'asc' }], elementCols(channels), channels, fresh);
}

/**
 * The convergent-walk COLLAPSE: `SELECT id, SUM(bulk) … GROUP BY id`, so the frontier stays bounded
 * by reachable |V| instead of by the (exponential) walk count.
 *
 * It is the `movementCollapse` fast path, expressed IN the algebra rather than beside it — which
 * is legitimate where the FTS one was not, and the difference is worth stating. Routing a substring
 * predicate through a base-table scan would have LOST an index seek the legacy spine performs;
 * here the specialized form is a plan rewrite RelIR can state exactly, so expressing it keeps the
 * optimization AND keeps the switch meaningful: `fastPaths.movementCollapse` still selects between
 * two forms, so L5's differential still has two positions to compare on a RelIR-routed traversal.
 * Reading the flag here does NOT make spine choice depend on it — coverage is unchanged either way.
 *
 * `isReEncoding` (src/rel/obligations.ts) is what lets the result keep carrying `bulk`: this is a
 * re-encoding of the same traverser multiset, not a barrier.
 *
 * **COLLAPSE AND AN EMISSION ORDER ARE MUTUALLY EXCLUSIVE**, and the caller asks the RELATION rather
 * than a chain-global flag: a collapse merges convergent walks by discarding which one arrived, which
 * is exactly the per-row identity a position IS. `analyzeChain` folds the seeded case in
 * (`collapseSafe && !demandsEncounter`), but an element `order()` MINTS a position mid-chain on a
 * chain analyze reports as demanding none — so the law has to be stated where the position is
 * visible, not where the chain is.
 */
const coalesce = (rel: Rel, fresh: Minter): Rel =>
  make.aggregate({
    id: fresh('cl'), input: rel, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    groupBy: [col(rel.id, 'id')],
    aggs: [['bulk', { kind: 'agg', fn: 'sum', args: [col(rel.id, 'bulk')] }]],
  });

/**
 * `count()` is the RLE TRAVERSER total, and which expression that is depends on whether the relation
 * carries a multiplicity at all.
 *
 * With a `bulk` channel it is `SUM(bulk)` — a collapse merged convergent walks into (row, N) pairs,
 * so counting rows would count the collapse away. Without one (an `inject()` source has no
 * multiplicity: each row is one traverser by construction) it is `COUNT(*)`, which is what legacy
 * emits there. Reading the CHANNEL rather than the step name is what keeps the two in step.
 */
function countExpr(input: Rel): Expr {
  const bulk = input.channels.find((channel) => channel.role === 'bulk');
  return bulk
    ? { kind: 'call', fn: 'COALESCE', args: [{ kind: 'agg', fn: 'sum', args: [col(input.id, bulk.col)] }, lit(0, 'int')] }
    : { kind: 'agg', fn: 'count', args: [] };
}

/**
 * A TERMINAL that retypes the element relation into another shape — the SHAPE BOUNDARY, and the
 * substrate every scalar-valued step then rides on.
 *
 * `null` declines, as everywhere here. What makes this the boundary rather than one more step is
 * that both arms change the STREAM KIND: everything before produces elements and frames as the
 * element payload, and these produce one scalar per row and frame through the value projection.
 */
function terminal(step: IRStep, input: Rel, elem: Elem, fresh: Minter): { readonly rel: Rel; readonly framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];

  // count() is the RLE traverser TOTAL, not the row count: a collapse merges convergent walks into
  // (row, N) pairs, so the answer is SUM(bulk) — identical to COUNT(*) only while bulk is 1
  // everywhere. Reading it off the carried channel rather than off the step is what keeps the two
  // in step when movement lands.
  if (step.name === 'count') {
    if (args.length) return null;
    const total = countExpr(input);
    // A reducing aggregate is a BARRIER: no channel survives it (§3.5), which is exactly what
    // `barrierChannels` says and why the channels list is empty rather than trimmed by hand.
    return {
      rel: make.aggregate({ id: fresh('agg'), input, channels: [], type: typeOf(meta('v', 'int')), groupBy: [], aggs: [['v', total]] }),
      framing: { kind: 'scalar', type: STATIC('long'), result: 'count' },
    };
  }

  if (step.name === 'values') {
    // TinkerPop's `PropertiesStep` is `element.properties(keys)`: no keys means EVERY key, several
    // mean membership in the set. A non-string key is a decline rather than a guess — answering
    // "every key" for one would be answering a different question.
    const keys = args.filter((a): a is string => typeof a === 'string');
    if (keys.length !== args.length) return null;

    const { table, owner } = PROPERTIES[elem];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying
    // the row is the answer rather than the bug it would be in a filter.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      // The key set is bounded by the QUERY TEXT, never by row count, so an `InList` is right here
      // and a JSON bind is not (root CLAUDE.md's rule is about data-sized sets).
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keys.length
        ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map((k) => lit(k, 'text')) }
        : undefined),
    });
    return {
      rel: make.project({
        id: fresh('sv'), input: joined, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...input.channels.map((channel) => meta(channel.col, 'int'))),
        exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')],
          ...input.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
      }),
      // The value's Gremlin type is PER ROW, off the stored `vtype` column — one compile-time tag
      // would be a lie for an untyped property key.
      framing: { kind: 'scalar', type: PER_ROW('vtype') },
    };
  }

  return null;
}

/** The tail steps that read the traverser's value from a clause SQL cannot alias into — a `WHERE`
 *  or an `ORDER BY`. What they have in common is the bind wall, and the remedy, both in `scalarTail`. */
const CLAUSE_READERS = new Set(['is', 'order']);

/** The tail steps that HOST a `by()` (`BY_HOSTS` ∩ this fold's vocabulary). Named rather than checked
 *  inline because the blanket `step.modulators?.length` decline must exempt exactly these — a host
 *  added to the fold without being added here silently loses its modulator, which is the failure mode
 *  the modulator seam exists to end. */
const BY_READERS = new Set(['order', 'dedup']);

/**
 * An `order()`'s sort terms over any host, or `null` to decline.
 *
 * Scalar `order()` IS a relation operator, and that is what separates it from the element one: over
 * values legacy emits `SELECT p.v FROM c0 p ORDER BY p.v ASC` — a `Sort` in the algebra, exactly —
 * whereas over elements it folds the order into the FRAMING projection, which is `TailAcc`'s and
 * Phase 4.2's. Same step name, two different layers, and only one of them is here today; the host
 * parameter is what will let the other one in without a second parse.
 *
 * `by()` is READ, not declined, and the whole of it lives in `modulator.ts`: which value to sort on
 * and which direction, with the ordering flag asking for the vtype-aware compare key — the same
 * authority the range predicates use, because comparing and sorting are the same question. `shuffle`
 * is the one term with no subject at all: `RANDOM()` re-evaluates per row and that IS the semantics,
 * so it is a `Call` rather than a projection, and the census sees it through the multiset digest only.
 */
function sortTerms(step: IRStep, host: ByHost, fresh: Minter): { readonly terms: readonly SortTerm[]; readonly drop?: Expr } | null {
  if (isLocalScope(step) || (step.args ?? []).length) return null;
  // ONE slot: TinkerPop's `order()` takes a comparator per key, so a multi-key sort is valid Gremlin
  // — it is this lowering that has one term, and declining says so rather than sorting on the first.
  const bys = modulations(step, 1);
  if (!bys) return null;
  const modulation: Modulation = bys[0] ?? { key: { kind: 'identity' } };
  if (modulation.order === 'shuffle') return { terms: [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }] };
  const key = byExpr(modulation, host, fresh, true);
  if (!key) return null;
  const terms = [{ expr: key, dir: modulation.order === 'desc' ? 'desc' as const : 'asc' as const }];
  // PRODUCTIVITY rides with the terms rather than being each host's to remember: a traverser whose
  // `by('age')` yielded nothing is DROPPED, so `g.V().order().by('age')` is four rows on the modern
  // graph and not six. A forgotten drop is a wrong answer with the right arity, and it sorts the
  // extra rows FIRST (SQLite orders NULL low), which the census's multiset digest cannot see.
  const drop = orderProductivity(step, modulation, key);
  return drop ? { terms, drop } : { terms };
}

/**
 * THE SCALAR TAIL — the vocabulary above a one-value-per-row relation, wherever that relation came
 * from. `values()`/`count()` retyping an element stream and `inject()` seeding one both land here,
 * which is why it is a function and not two inline folds.
 *
 * `is(P)` uses the SAME predicate module the source filters use, over the scalar's own `v`. A slice
 * uses the same `sliceOp` as the element fold. `dedup()` is `Distinct` over the whole row — which
 * for a scalar IS the value. `count()` reduces to a long, reading the multiplicity off the CHANNEL
 * rather than assuming one exists.
 *
 * Every fact about the current relation — its columns, its channels, whether a per-row `vtype` is in
 * scope — is READ OFF `rel` rather than tracked beside it. Two accumulator variables used to shadow
 * them, and a step that reshaped the relation without updating both was a desync no type could see.
 */
function scalarTail(
  seed: Rel, framing: RelFraming, steps: readonly IRStep[], from: number, bulked: boolean, fresh: Minter,
): { readonly rel: Rel; readonly framing: RelFraming } | null {
  let rel = seed;
  let out: RelFraming = framing;
  const carries = (name: string): boolean => rel.type.cols.some((column) => column.name === name);
  // WHAT IS KNOWN about the value's Gremlin type, read off the framing rather than guessed — the ONE
  // fact both `is`'s ordering comparisons and its `typeOf` test need, so it is computed once as a
  // total union rather than twice as two optionals. A per-row `vtype` column is in scope only where
  // the value came from a stored property; a `count()` is a compile-time `long`, which is what lets
  // `count().is(P.typeOf(GType.LONG))` constant-fold without touching a row; an injected value with a
  // heterogeneous or untagged type is honestly `unknown`. Same three cases `predicateSql` calls
  // `TypeCtx`, in the algebra's own expression vocabulary.
  const subjectType = (): SubjectType =>
    carries('vtype') ? { kind: 'perRow', vtype: col(rel.id, 'vtype') }
      : out.kind === 'scalar' && out.type.kind === 'static' ? { kind: 'static', type: out.type.type }
        : SUBJECT_UNKNOWN;

  // A BOUNDARY before a CLAUSE-POSITION READER, and it is not cosmetic. Fusing a `Filter` or a
  // `Sort` into its input's block means the input's outputs are spelled as the EXPRESSIONS that
  // compute them (§5) — SQL has no other option, since neither a `WHERE` nor an `ORDER BY` can name
  // a select alias. So each one re-inlines the whole projection, and with the vtype-aware ordering
  // CASE in play that is ~20 binds apiece: measured 25 / 45 / 65 for one, two and three range
  // predicates against legacy's 2 / 3 / 4, and 24 against legacy's 1 for a single `order()` (whose
  // key inlines the value expression three times over — once per arm of the compare CASE). A fourth
  // predicate would exceed the DO cap and fail closed where legacy answers — a support regression,
  // not a wall worth shipping. `Materialize` is the declared remedy (§3.3, "a boundary hint … where
  // the planner needs a fence") and lands the same CTE-then-read shape legacy emits.
  //
  // Only the FIRST tail step needs the hint, and that is structural rather than lucky: a reader
  // further along sits over a node the assembler already refuses to fuse into — a `Limit`, a
  // `Distinct`, an earlier `Sort`, or this very fence — so its subject is a column of a finished
  // block and there is nothing left to re-inline.
  if (CLAUSE_READERS.has(steps[from]?.name ?? '') && seed.kind !== 'values')
    rel = make.materialize({ id: fresh('m'), input: rel, channels: rel.channels, type: rel.type });

  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = step.args ?? [];
    if (step.optionArms) return null;
    // The blanket modulator decline exempts the two steps that HOST a `by()` here; each reads it
    // through `modulator.ts` and declines the projections a value stream cannot serve.
    if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
    // A value's own `vtype` is in scope only where it came from a stored property, which is the same
    // distinction `compare()` above draws and the reason `ByHost` carries it as an optional.
    const host: ByHost = { kind: 'scalar', value: col(rel.id, 'v'), ...(carries('vtype') ? { vtype: col(rel.id, 'vtype') } : {}) };

    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }

    if (step.name === 'order') {
      const sort = sortTerms(step, host, fresh);
      if (!sort) return null;
      const { terms } = sort;
      // A value's `by()` is identity-only (a value has no properties), so `drop` is never owed here —
      // applying it anyway keeps the rule in ONE place rather than in each host's head.
      if (sort.drop) rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: sort.drop });
      // A sort SUPERSEDES the arriving emission order, so where one is carried the positions must be
      // re-minted and not merely re-sorted: a later slice reads the channel, and taking its window
      // from the stale seed would return the right multiset from the wrong place. Legacy says the
      // same thing with its own window projection (`partitionedOrder`), tie-broken on the old
      // encounter — which is what makes the sort STABLE, so that is the second term here too.
      const encounter = encounterOf(rel.channels);
      rel = encounter
        ? renumber(rel, [...terms, { expr: col(rel.id, encounter.col), dir: 'asc' }], rel.type.cols, rel.channels, fresh)
        : make.sort({ id: fresh('so'), input: rel, channels: rel.channels, type: rel.type, terms });
      continue;
    }

    const sliced = sliceOp(step, rel, bulked, fresh);
    if (sliced) { rel = sliced; continue; }

    // THE SCALAR TRANSFORM FAMILY — one `Project` per transform, and the assembler fuses a run of them
    // into one SELECT (`upper(lower(p.v))`), which is what legacy's `fuseScalarSegment` hand-rolls.
    // Membership is checked BEFORE the lowering is asked for, so an unlowerable member of the family
    // (`reverse`, `asBool`) DECLINES rather than falling through to be misread by a later arm.
    if (REL_TRANSFORMS.has(step.name)) {
      // `seed.kind === 'values'` IS "the value is a compile-time literal": an `inject()` source is the
      // only one, and it is the population legacy constant-folds. Read off the SEED rather than the
      // current relation, because a preceding transform does not stop a value being literal-derived.
      const tx = transformExpr(step, col(rel.id, 'v'), seed.kind === 'values');
      if (!tx) return null;
      // EVERY transform drops the per-row `vtype` column, not only the casts: `toUpper()` leaves a
      // value the stored row no longer describes and `length()` turns it into an integer outright, so
      // carrying the column would reframe the RESULT as the INPUT's type. The framing type becomes
      // whatever the transform knows, or `UNKNOWN` — which infers per value and is what legacy frames
      // here. Dropping it also removes the vtype from `subjectType()`, so a following `is(P.gt(…))`
      // stops asking for an ordering key the value no longer has one for, which is correct: the
      // transformed value is a native SQLite value and compares directly.
      const carried = rel.channels;
      rel = make.project({
        id: fresh('tx'), input: rel, channels: carried,
        type: typeOf(meta('v', 'any', true), ...carried.map((channel) => meta(channel.col, 'int'))),
        exprs: [['v', tx.expr], ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
      });
      out = { kind: 'scalar', type: tx.type ?? UNKNOWN };
      continue;
    }

    if (step.name === 'is') {
      if (args.length !== 1) return null;
      // `is(typeOf(GType.LIST|SET|MAP))` is a TYPE ASSERT, not a predicate: over a scalar stream
      // carrying a stored collection it RETYPES the stream to a list or a map, so lowering it as a
      // filter would return the right rows framed as the wrong shape — a different question, which is
      // the one thing this module may never answer. `collectionAssert` is the derived view of legacy's
      // ONE `typeOfAssert` decode (`child-shape.ts`), reused rather than re-recognized: five arms had
      // already drifted apart decoding this inline, and a sixth copy here would be the same mistake.
      if (collectionAssert(step)) return null;
      const pred = predicateExpr(col(rel.id, 'v'), args[0], subjectType());
      if (!pred) return null;
      rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred });
      continue;
    }

    if (step.name === 'dedup') {
      // `Distinct` is WHOLE-ROW and only whole row (§3.3), so what the row IS decides the answer —
      // and a channel must not be in it. Two reasons, both load-bearing:
      //
      //  - a dedup must not DISTINGUISH rows by their multiplicity. Keeping `bulk` in the key means
      //    the same value at bulk 1 and bulk 3 survives twice, which is a wrong answer the moment a
      //    collapse upstream makes bulk anything but 1 — invisible on a fixture where it never is.
      //  - the survivor STANDS FOR ITSELF, not for the sum of the duplicates it replaced, so the
      //    multiplicity is dropped rather than carried: a following `count()` then reads
      //    `COUNT(*)`, which is what legacy emits and what the traversers actually number.
      //
      // The emission order goes with it for the same reason — a survivor has no one position — and
      // that matches legacy, whose scalar dedup projects the payload alone.
      //
      // A `by()` here is IDENTITY or nothing, and that is not a gap: over a value stream the only
      // projection available IS the value, so `dedup().by()` and bare `dedup()` are the same question
      // (legacy emits the identical `SELECT DISTINCT p.v` for both). `by(key)`/`by(token)` decline
      // through the vocabulary, which is where the "a value has no properties" rule lives.
      if (args.length || isLocalScope(step)) return null;
      const deduped = modulations(step, 1);
      if (!deduped || (deduped[0] && !byExpr(deduped[0], host, fresh))) return null;
      if (deduped[0]?.order !== undefined) return null;
      const payload = rel.type.cols.filter((column) => !rel.channels.some((channel) => channel.col === column.name));
      if (!payload.length) return null;
      const projected = make.project({
        id: fresh('dp'), input: rel, channels: [], type: typeOf(...payload),
        exprs: payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      });
      rel = make.distinct({ id: fresh('d'), input: projected, channels: [], type: projected.type });
      continue;
    }

    // THE REDUCER FAMILY — one `Aggregate`, four step names, and the barrier that ENDS the tail's
    // channels: a reducing aggregate collapses the whole multiset into one row, so nothing survives it
    // (§3.5's `barrierChannels`), which is why the channels list is empty rather than trimmed by hand.
    if (isReducer(step.name)) {
      if (args.length || isLocalScope(step)) return null;
      const bulk = rel.channels.find((channel) => channel.role === 'bulk');
      const reduced = reducerAggregate(col(rel.id, 'v'), step.name, bulk && col(rel.id, bulk.col));
      rel = make.aggregate({
        id: fresh('red'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
        groupBy: [], aggs: [['v', reduced.value], ['vt', reduced.type]],
      });
      // `result: 'number'` is the framing arm that reads the `vt` column — the result's storage class is
      // DYNAMIC (a sum of integers is an integer, of reals a real), so there is no compile-time tag to
      // give and `UNKNOWN` would throw the second column away.
      out = { kind: 'scalar', type: UNKNOWN, result: 'number' };
      continue;
    }

    if (step.name === 'count') {
      if (args.length) return null;
      rel = make.aggregate({
        id: fresh('agg'), input: rel, channels: [], type: typeOf(meta('v', 'int')),
        groupBy: [], aggs: [['v', countExpr(rel)]],
      });
      out = { kind: 'scalar', type: STATIC('long'), result: 'count' };
      continue;
    }

    return null;
  }
  return { rel, framing: out };
}

/**
 * `g.inject(v…)` — a SCALAR source, and the largest single blocker measured over the corpus: 387 of
 * the 2,298 traversals begin with one, 17% of the whole set.
 *
 * `Values` is the node, and it is the one construct measured emitting SQL's `VALUES` (§3.3). The
 * relation is one column and NO channels — an injected row is one traverser by construction, so
 * there is no multiplicity to carry and nothing has established an emission order.
 *
 * A UNIFORM DECLARED TYPE is not derivable from the values and must not be re-derived: a `char`, a
 * `uuid`, a `datetime` and a long past 2^53 all arrive as ordinary JS strings or numbers, so framing
 * by inference reframes them as the wrong wire type. `bareInjectTag` is the one authority for that
 * and this calls it rather than reimplementing it. Measured: before it did, the census caught four
 * corpus traversals (`inject("a"c)`, `inject(UUID(…))` and friends) changing their answer — right
 * arity, plausible rows, wrong GraphBinary type.
 *
 * Two forms decline, each for a reason rather than a blanket. A COLLECTION argument
 * (`inject([1,2])`) is a LIST traverser, a different framing arm and a JSONB payload rather than a
 * scalar column. `inject()` with no arguments is the EMPTY relation, which legacy spells
 * `SELECT NULL AS v WHERE 0` and `Values` cannot express at all — §3.3 records why it refuses to
 * (`Values([])` rendered as invalid SQL that only failed at the database), and the algebra's answer
 * is a `Filter(false)` over something, which there is nothing here to be over.
 */
function injectSource(step: IRStep, fresh: Minter): { rel: Rel; framing: RelFraming } | null {
  if (step.modulators?.length || step.optionArms) return null;
  const args = step.args ?? [];
  if (!args.length) return null;
  const rows = args.map((arg) => (arg === null ? lit(null, 'any') : operandLit(arg)));
  if (rows.some((row) => !row)) return null;
  return {
    rel: make.values({
      id: fresh('inj'), rows: (rows as Expr[]).map((row) => [row]), channels: [],
      type: typeOf(meta('v', 'any', true)),
    }),
    // A uniform declared type where there is one; per-value inference otherwise, which is what
    // `UNKNOWN` means and is the honest floor for a heterogeneous inject (there is no per-row vtype
    // column to carry a mixed type on).
    framing: { kind: 'scalar', type: (() => { const tag = bareInjectTag([step], args.length); return tag ? STATIC(tag) : UNKNOWN; })() },
  };
}

/** A literal an injected row can hold. Anything else — a collection, a map, a nested traversal —
 *  is a different traverser shape and declines. */
const operandLit = (arg: unknown): Expr | null =>
  typeof arg === 'string' ? lit(arg, 'text')
    : typeof arg === 'number' ? lit(arg, 'real')
      : typeof arg === 'boolean' ? lit(arg, 'int') : null;

/**
 * Lower a whole rooted chain, or decline.
 *
 * Coverage today is the element SOURCE plus a run of source-scope filters. The declines are the
 * growth list, and the measured order of what each is worth over the 2,298-traversal corpus is
 * recorded in the build plan — `has(key, P…)` is the next single largest, then the reducers.
 */
/** The compile-scoped facts a lowering reads beyond the chain itself: the bound parameters, and
 *  which lowering STRATEGIES this compile has asked for. `collapse` and `correlatedChildren` are
 *  the two fast-path switches RelIR implements a side of; a switch it cannot implement is never
 *  read here, because coverage must not become a function of configuration. */
export interface Lowering {
  readonly params?: Record<string, any>;
  readonly collapse?: boolean;
  readonly correlatedChildren?: boolean;
}

/**
 * THE BIND BUDGET IS A COVERAGE QUESTION, not a crash.
 *
 * §3.6 makes the DO 100-parameter cap a property of the plan that fails closed rather than SQL that
 * only fails in production — and `check` enforces it by THROWING, which is right inside the algebra
 * and wrong at this seam: a traversal legacy answers must not become a compile error because the new
 * route spells its predicate more expensively (§11 — RelIR throwing where legacy answers is the one
 * failure mode the routing switch cannot absorb). So the budget is asked HERE, before the plan is
 * handed over, and an over-budget plan is a decline like any unlearned step.
 *
 * It bites at a knowable place: RelIR renders the vtype-aware compare key's class lists as binds
 * where legacy inlines them as literals, so one element `order().by(key)` is ~27 binds against
 * legacy's 2 — three in one chain would exceed the cap. Making that a decline is what keeps the wall
 * out of production; making the key cheaper is a separate increment.
 */
const lowered = (rel: Rel, framing: RelFraming): RelLowering | null => {
  const plan = nameBindings(rel);
  return planBindCount(plan) > DO_BIND_CAP ? null : { plan, framing };
};

export function lowerToRel(steps: readonly IRStep[], opts: Lowering = {}): RelLowering | null {
  const { params = {}, collapse = true, correlatedChildren = true } = opts;
  const ctx: FilterCtx = { params, correlatedChildren };
  // EMISSION ORDER is a chain-global fact, decided once and threaded — never re-derived per step.
  // `analyzeChain` is the same authority the legacy source seeds from, so the two cannot disagree
  // about which chains have an order to take a window from. A chain that demands one and reaches a
  // step this route cannot thread it through declines WHOLE: silently omitting the channel would
  // not defer, it would pick a different window from the same multiset — right arity, plausible
  // rows, and a census that structurally cannot see it (`ord` is telemetry, `ms` is the gate).
  const ordered = analyzeChain(steps as IRStep[]).demandsEncounter;
  const seedChannels = ordered ? withChannel(BULK, ENCOUNTER) : BULK;
  const first = steps[0];
  if (!first) return null;
  const fresh = minter();

  if (first.name === 'inject') {
    const injected = injectSource(first, fresh);
    if (!injected) return null;
    const tail = scalarTail(injected.rel, injected.framing, steps, 1, false, fresh);
    if (!tail) return null;
    return lowered(tail.rel, tail.framing);
  }

  if (first.name !== 'V' && first.name !== 'E') return null;
  // A modulator or an option arm on the source is not a source argument; decline rather than
  // silently ignore it.
  if (first.modulators?.length || first.optionArms) return null;
  const seeded = elementScan(first, fresh);
  if (!seeded) return null;

  // PHASE 1 — the source scan and the filters that fuse into its own WHERE. Kept separate from the
  // general fold below because only here is the physical row in scope: an edge's `label` is a
  // column to read rather than a membership test, and a run of filters conjoins into ONE `WHERE`
  // over one scan instead of the legacy CTE-per-filter with its re-join.
  let pred = seeded.pred;
  let at = 1;
  let elem = seeded.elem;
  for (; at < steps.length; at++) {
    const clause = sourceFilter(steps[at], { id: col(seeded.scan.id, 'id'), label: elem === 'edge' ? col(seeded.scan.id, 'label') : undefined, rel: seeded.scan }, elem, fresh, ctx);
    if (!clause) break;
    pred = and(pred, clause);
  }

  const source = pred ? make.filter({ id: fresh('f'), input: seeded.scan, channels: [], type: seeded.scan.type, pred }) : seeded.scan;
  // The seed of the emission order is the ROWID, exactly as the legacy source seeds it: a scan's
  // natural order is the only order a bare source has, and naming it makes every later slice ask
  // the same question of the same column instead of of whatever SQLite happened to produce.
  let rel: Rel = make.project({
    id: fresh('c'), input: source, channels: seedChannels, type: typeOf(...elementCols(seedChannels)),
    exprs: [['id', col(source.id, 'id')], ['bulk', lit(1, 'int')],
      ...(ordered ? [['encounter', col(source.id, 'id')] as const] : [])],
  });

  // PHASE 2 — movement and post-movement filtering, over the id-relation. A filter here reads only
  // the traverser's id, which is why `Subject` carries no `label`: after a hop the relation is
  // `(id, bulk)` and an edge-label test becomes the membership form.
  // Does a row stand for more than ONE traverser? Only a collapse makes that true, and a slice has
  // to know because `LIMIT n` over (element, N) rows answers a different question (`bulkSlice`). It
  // is a fact about the relation the algebra cannot state — `bulk` is a channel whether its value is
  // 1 or not — so it rides beside `rel` exactly as `elem` does. Conservative on purpose: a `dedup`
  // resets the multiplicity to 1 and this does not learn that, which costs the heavier slice form
  // and never a wrong answer.
  let bulked = false;
  for (; at < steps.length; at++) {
    const step = steps[at];
    const moved: { rel: Rel; elem: Elem } | null = movement(step, { rel }, elem, fresh);
    if (moved) {
      // The mutual exclusion is read off the RELATION (see `coalesce`): a movement under a live
      // emission order must not collapse, whether that order was seeded at the source or minted by
      // an `order()` further up. Getting this from `demandsEncounter` alone built a collapse that
      // dropped the encounter column its own declared type still promised — caught by the factory as
      // a join-width mismatch three nodes later, found by a sweep calling `lowerToRel` directly.
      const collapsing = collapse && !encounterOf(moved.rel.channels);
      rel = collapsing ? coalesce(moved.rel, fresh) : moved.rel;
      bulked = bulked || collapsing;
      elem = moved.elem;
      continue;
    }
    const clause = sourceFilter(step, { id: col(rel.id, 'id'), rel }, elem, fresh, ctx);
    // `rel.channels`, NOT `BULK`: a `Filter` is channel-preserving by contract (§3.5), so naming a
    // list rather than passing the input's through is a chance to name a SHORTER one — and under
    // `demandsEncounter` the relation carries `bulk` AND `encounter`, so the hardcoded `BULK` dropped
    // the position its own input still declared. The factory catches it (`filter changed its carried
    // channels`), which made a fail-closed VIOLATION rather than a wrong answer: RelIR threw where
    // legacy answers. Found by L5 on a generated `E().limit(1).has(…).where(…)` — no corpus traversal
    // has that prefix, so the corpus sweep could not reach it.
    if (clause) { rel = make.filter({ id: fresh('f'), input: rel, channels: rel.channels, type: rel.type, pred: clause }); continue; }
    const row = rowOp(step, rel, elem, bulked, fresh);
    if (!row) break;
    rel = row;
  }

  if (at === steps.length) return lowered(rel, { kind: 'elements', elem });

  const retyped = terminal(steps[at], rel, elem, fresh);
  if (!retyped) return null;

  const tail = scalarTail(retyped.rel, retyped.framing, steps, at + 1, bulked, fresh);
  if (!tail) return null;
  return lowered(tail.rel, tail.framing);
}
