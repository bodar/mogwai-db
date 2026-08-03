import type { Channels } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
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
import { byExpr, modulations, productivityFilter, type ByHost, type Modulation } from './modulator.ts';
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

/** A covered chain, lowered: a relation, its output columns, its channels, and what to frame. */
export interface RelLowering {
  readonly plan: Plan;
  readonly framing: RelFraming;
  /** The result relation's output columns, in order — the framing layer's `Relation` header. */
  readonly cols: readonly string[];
  readonly channels: Channels;
}

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];

/**
 * The EMISSION-ORDER channel, and the second carried role this route models.
 *
 * A chain that slices has an answer depending on which rows come first, so `analyzeChain` marks it
 * `demandsEncounter` and the source seeds a monotone column the whole chain threads. Its position
 * in the list is not free: `ROLE_ORDER` (src/channels.ts) is an INVARIANT of a `Channels` list, and
 * the framing layer's `layoutCols` sorts the same way — bulk before encounter — so a producer that
 * emitted them the other way round would desync the declared schema from the physical one.
 */
const ORDERED: Channels = [{ col: 'bulk', role: 'bulk' }, { col: 'encounter', role: 'encounter' }];
const elementChannels = (ordered: boolean): Channels => (ordered ? ORDERED : BULK);
const elementCols = (ordered: boolean): readonly ColMeta[] =>
  [meta('id', 'int'), meta('bulk', 'int'), ...(ordered ? [meta('encounter', 'int')] : [])];



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
  // Only a ROOTED hop threads the emission order. A correlated one lives inside an `EXISTS`, which
  // asks whether a row is there and never in what order — so its `bulk` is synthetic and it carries
  // no position at all.
  const ordered = !!input && input.channels.some((channel) => channel.role === 'encounter');
  const armCols = elementCols(ordered);
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
        id: fresh('j'), left: e, right: input, join: 'inner', on, channels: elementChannels(ordered),
        type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int'), meta('pid', 'int'), ...armCols.slice(1)),
      })
      : make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: on });
    // The arm carries the INCOMING position through unchanged; re-minting happens once over the
    // whole fan-out below, not per arm — two arms each numbering from 1 would interleave.
    return make.project({
      id: fresh('m'), input: source, channels: elementChannels(ordered), type: typeOf(...armCols),
      exprs: [['id', col(source.id, hop.to)], ['bulk', input ? col(source.id, 'bulk') : lit(1, 'int')],
        ...(ordered ? [['encounter', col(source.id, 'encounter')] as const] : [])],
    });
  });
  const [first, ...rest] = arms;
  if (!first) return null;
  // N-ary UNION ALL, minted once — and ALL, never distinct: traversers are a multiset, so a vertex
  // reachable both ways is two traversers.
  const fanned = rest.length
    ? make.union({ id: fresh('u'), inputs: arms, all: true, channels: elementChannels(ordered), type: typeOf(...armCols) })
    : first;
  return { rel: ordered ? remintOrder(fanned, fresh) : fanned, elem: hops[0]!.elem };
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
 * `order`/`limit`/`range`/`skip`/`tail`/`sample` are ABSENT, and each for its own reason rather
 * than one blanket "not yet". A slice needs the emission-order `encounter` channel, which the
 * caller gates on (`demandsEncounter`) until this route models a carried role beyond `bulk`. An
 * element `order()` is not a relation operator at all in the legacy lowering — `TailAcc` folds it
 * into the FRAMING projection's `ORDER BY` (`… FROM nodes n JOIN c0 p ON n.id=p.id ORDER BY n.id`),
 * which is Phase 4.2's block assembler and not this route's to take.
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
function sliceOp(step: IRStep, input: Rel, fresh: Minter): Rel | null {
  if (step.modulators?.length || step.optionArms || isLocalScope(step)) return null;
  if (step.name !== 'limit' && step.name !== 'skip' && step.name !== 'range') return null;
  // `sliceOf` REJECTS an illegal range (`range(2,1)`) by throwing, which is right where it is the
  // only answer available — but this module's contract is that `null` is its only decline, and a
  // throw from here would mean the RelIR route raising an error the legacy spine has not reached
  // yet. Declining hands the traversal to the spine that owns the message, which raises the
  // identical one. Found by sweeping every prefix of every corpus traversal under all four switch
  // combinations, which is the only way a decline-contract violation shows up at all.
  let slice;
  try { slice = sliceOf(step); } catch { return null; }
  const ordered = input.channels.some((channel) => channel.role === 'encounter');
  const source = ordered
    ? make.sort({
      id: fresh('so'), input, channels: input.channels, type: input.type,
      terms: [{ expr: col(input.id, 'encounter'), dir: 'asc' }],
    })
    : input;
  return make.limit({
    id: fresh('li'), input: source, channels: input.channels, type: input.type,
    ...(slice.limit === null ? {} : { count: lit(slice.limit, 'int') }),
    ...(slice.offset ? { offset: lit(slice.offset, 'int') } : {}),
  });
}

function rowOp(step: IRStep, input: Rel, elem: Elem, ordered: boolean, fresh: Minter): Rel | null {
  if (step.optionArms) return null;
  if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;
  const sliced = sliceOp(step, input, fresh);
  if (sliced) return sliced;

  if (step.name !== 'dedup' || (step.args ?? []).length || isLocalScope(step)) return null;

  const bys = modulations(step, 1);
  if (!bys) return null;
  if (bys[0]) return dedupBy(step, bys[0], input, elem, ordered, fresh);

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
    id: fresh('dd'), input, channels: input.channels, type: typeOf(...elementCols(true)),
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
function dedupBy(step: IRStep, modulation: Modulation, input: Rel, elem: Elem, ordered: boolean, fresh: Minter): Rel | null {
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
  const cols = elementCols(ordered);
  const ranked = make.window({
    id: fresh('dw'), input: domain, channels: domain.channels, type: typeOf(...cols, meta('rn', 'int')),
    specs: [['rn', {
      kind: 'window-expr', fn: 'row_number', args: [],
      // Partitioned by the KEY and ordered by the element id: the lowest id per key survives, which is
      // deterministic rather than merely "one of them" — the property `mise run test:perturbed` checks.
      spec: { partitionBy: [key], orderBy: [{ expr: col(domain.id, 'id'), dir: 'asc' }] },
    }]],
  });
  const survivors = make.filter({
    id: fresh('f'), input: ranked, channels: ranked.channels, type: ranked.type,
    pred: eq(col(ranked.id, 'rn'), lit(1, 'int')),
  });
  return make.project({
    id: fresh('dk'), input: survivors, channels: elementChannels(ordered), type: typeOf(...cols),
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
  const windowed = make.window({
    id: fresh('w'), input: rel, channels: rel.channels, type: typeOf(...cols, meta(minted, 'int')),
    specs: [[minted, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: terms } }]],
  });
  return make.project({
    id: fresh('ro'), input: windowed, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(windowed.id, column.name === encounter.col ? minted : column.name)] as const),
  });
}

/** The fan-out re-mint: renumber by the incoming position, tie-broken on the element id so rows
 *  that shared one incoming traverser get a deterministic order rather than SQLite's. */
const remintOrder = (rel: Rel, fresh: Minter): Rel => renumber(
  rel,
  [{ expr: col(rel.id, 'encounter'), dir: 'asc' }, { expr: col(rel.id, 'id'), dir: 'asc' }],
  elementCols(true), ORDERED, fresh,
);

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
function terminal(step: IRStep, input: Rel, elem: Elem, ordered: boolean, fresh: Minter): Omit<RelLowering, 'plan'> & { readonly rel: Rel } | null {
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
      framing: { kind: 'scalar', type: STATIC('long'), result: 'count' }, cols: ['v'], channels: [],
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
      id: fresh('j'), left: input, right: props, join: 'inner', channels: elementChannels(ordered),
      type: typeOf(...elementCols(ordered), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
      // The key set is bounded by the QUERY TEXT, never by row count, so an `InList` is right here
      // and a JSON bind is not (root CLAUDE.md's rule is about data-sized sets).
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keys.length
        ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map((k) => lit(k, 'text')) }
        : undefined),
    });
    return {
      rel: make.project({
        id: fresh('sv'), input: joined, channels: elementChannels(ordered),
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...elementCols(ordered).slice(1)),
        exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')], ['bulk', col(joined.id, 'bulk')],
          ...(ordered ? [['encounter', col(joined.id, 'encounter')] as const] : [])],
      }),
      // The value's Gremlin type is PER ROW, off the stored `vtype` column — one compile-time tag
      // would be a lie for an untyped property key.
      framing: { kind: 'scalar', type: PER_ROW('vtype') },
      cols: ['v', 'vtype', ...elementCols(ordered).slice(1).map((c) => c.name)], channels: elementChannels(ordered),
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
function sortTerms(step: IRStep, host: ByHost, fresh: Minter): readonly SortTerm[] | null {
  if (isLocalScope(step) || (step.args ?? []).length) return null;
  // ONE slot: TinkerPop's `order()` takes a comparator per key, so a multi-key sort is valid Gremlin
  // — it is this lowering that has one term, and declining says so rather than sorting on the first.
  const bys = modulations(step, 1);
  if (!bys) return null;
  const modulation: Modulation = bys[0] ?? { key: { kind: 'identity' } };
  if (modulation.order === 'shuffle') return [{ expr: { kind: 'call', fn: 'RANDOM', args: [] }, dir: 'asc' }];
  const key = byExpr(modulation, host, fresh, true);
  if (!key) return null;
  return [{ expr: key, dir: modulation.order === 'desc' ? 'desc' : 'asc' }];
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
 */
function scalarTail(
  seed: Rel, framing: RelFraming, cols: readonly string[], channels: Channels,
  steps: readonly IRStep[], from: number, fresh: Minter,
): (Omit<RelLowering, 'plan'> & { readonly rel: Rel }) | null {
  let rel = seed;
  let out: RelFraming = framing;
  let outCols = cols;
  let outChannels = channels;
  // WHAT IS KNOWN about the value's Gremlin type, read off the framing rather than guessed — the ONE
  // fact both `is`'s ordering comparisons and its `typeOf` test need, so it is computed once as a
  // total union rather than twice as two optionals. A per-row `vtype` column is in scope only where
  // the value came from a stored property; a `count()` is a compile-time `long`, which is what lets
  // `count().is(P.typeOf(GType.LONG))` constant-fold without touching a row; an injected value with a
  // heterogeneous or untagged type is honestly `unknown`. Same three cases `predicateSql` calls
  // `TypeCtx`, in the algebra's own expression vocabulary.
  const subjectType = (): SubjectType =>
    outCols.includes('vtype') ? { kind: 'perRow', vtype: col(rel.id, 'vtype') }
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
    rel = make.materialize({ id: fresh('m'), input: rel, channels: outChannels, type: rel.type });

  for (let at = from; at < steps.length; at++) {
    const step = steps[at];
    const args = step.args ?? [];
    if (step.optionArms) return null;
    // The blanket modulator decline exempts the two steps that HOST a `by()` here; each reads it
    // through `modulator.ts` and declines the projections a value stream cannot serve.
    if (!BY_READERS.has(step.name) && step.modulators?.length) return null;
    // A value's own `vtype` is in scope only where it came from a stored property, which is the same
    // distinction `compare()` above draws and the reason `ByHost` carries it as an optional.
    const host: ByHost = { kind: 'scalar', value: col(rel.id, 'v'), ...(outCols.includes('vtype') ? { vtype: col(rel.id, 'vtype') } : {}) };

    if (step.name === 'identity' || step.name === 'barrier') { if (args.length) return null; continue; }

    if (step.name === 'order') {
      const terms = sortTerms(step, host, fresh);
      if (!terms) return null;
      // A sort SUPERSEDES the arriving emission order, so where one is carried the positions must be
      // re-minted and not merely re-sorted: a later slice reads the channel, and taking its window
      // from the stale seed would return the right multiset from the wrong place. Legacy says the
      // same thing with its own window projection (`partitionedOrder`), tie-broken on the old
      // encounter — which is what makes the sort STABLE, so that is the second term here too.
      const encounter = outChannels.find((channel) => channel.role === 'encounter');
      rel = encounter
        ? renumber(rel, [...terms, { expr: col(rel.id, encounter.col), dir: 'asc' }], rel.type.cols, outChannels, fresh)
        : make.sort({ id: fresh('so'), input: rel, channels: outChannels, type: rel.type, terms });
      continue;
    }

    const sliced = sliceOp(step, rel, fresh);
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
      const payload = [meta('v', 'any', true), ...outChannels.map((channel) => meta(channel.col, 'int'))];
      rel = make.project({
        id: fresh('tx'), input: rel, channels: outChannels, type: typeOf(...payload),
        exprs: [['v', tx.expr], ...outChannels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
      });
      out = { kind: 'scalar', type: tx.type ?? UNKNOWN };
      outCols = payload.map((column) => column.name);
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
      rel = make.filter({ id: fresh('f'), input: rel, channels: outChannels, type: rel.type, pred });
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
      const payload = rel.type.cols.filter((column) => !outChannels.some((channel) => channel.col === column.name));
      if (!payload.length) return null;
      const projected = make.project({
        id: fresh('dp'), input: rel, channels: [], type: typeOf(...payload),
        exprs: payload.map((column) => [column.name, col(rel.id, column.name)] as const),
      });
      rel = make.distinct({ id: fresh('d'), input: projected, channels: [], type: projected.type });
      outCols = payload.map((column) => column.name);
      outChannels = [];
      continue;
    }

    // THE REDUCER FAMILY — one `Aggregate`, four step names, and the barrier that ENDS the tail's
    // channels: a reducing aggregate collapses the whole multiset into one row, so nothing survives it
    // (§3.5's `barrierChannels`), which is why the channels list is empty rather than trimmed by hand.
    if (isReducer(step.name)) {
      if (args.length || isLocalScope(step)) return null;
      const bulk = outChannels.find((channel) => channel.role === 'bulk');
      const reduced = reducerAggregate(col(rel.id, 'v'), step.name, bulk && col(rel.id, bulk.col));
      rel = make.aggregate({
        id: fresh('red'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('vt', 'text', true)),
        groupBy: [], aggs: [['v', reduced.value], ['vt', reduced.type]],
      });
      // `result: 'number'` is the framing arm that reads the `vt` column — the result's storage class is
      // DYNAMIC (a sum of integers is an integer, of reals a real), so there is no compile-time tag to
      // give and `UNKNOWN` would throw the second column away.
      out = { kind: 'scalar', type: UNKNOWN, result: 'number' };
      outCols = ['v', 'vt'];
      outChannels = [];
      continue;
    }

    if (step.name === 'count') {
      if (args.length) return null;
      rel = make.aggregate({
        id: fresh('agg'), input: rel, channels: [], type: typeOf(meta('v', 'int')),
        groupBy: [], aggs: [['v', countExpr(rel)]],
      });
      out = { kind: 'scalar', type: STATIC('long'), result: 'count' };
      outCols = ['v'];
      outChannels = [];
      continue;
    }

    return null;
  }
  return { rel, framing: out, cols: outCols, channels: outChannels };
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
  const channels = elementChannels(ordered);
  // COLLAPSE AND ORDER ARE MUTUALLY EXCLUSIVE, and this module says so itself rather than trusting
  // its caller to. A collapse merges convergent walks by discarding which one arrived — exactly the
  // per-row identity an emission order IS — so the two cannot both hold. `analyzeChain` already
  // folds that in (`collapseSafe && !demandsEncounter`), so the engine never asks for both; but a
  // lowering that produces an invalid plan when handed a combination it cannot honour is a defect
  // whether or not today's caller can reach it. Found exactly that way: a sweep calling
  // `lowerToRel` directly built a collapse that dropped the encounter column its own declared type
  // still promised, and the factory caught it as a join-width mismatch three nodes later.
  const collapsing = collapse && !ordered;
  const first = steps[0];
  if (!first) return null;
  const fresh = minter();

  if (first.name === 'inject') {
    const injected = injectSource(first, fresh);
    if (!injected) return null;
    const tail = scalarTail(injected.rel, injected.framing, ['v'], [], steps, 1, fresh);
    if (!tail) return null;
    const { rel: injRel, ...injRest } = tail;
    return { plan: nameBindings(injRel), ...injRest };
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
    id: fresh('c'), input: source, channels, type: typeOf(...elementCols(ordered)),
    exprs: [['id', col(source.id, 'id')], ['bulk', lit(1, 'int')],
      ...(ordered ? [['encounter', col(source.id, 'id')] as const] : [])],
  });

  // PHASE 2 — movement and post-movement filtering, over the id-relation. A filter here reads only
  // the traverser's id, which is why `Subject` carries no `label`: after a hop the relation is
  // `(id, bulk)` and an edge-label test becomes the membership form.
  for (; at < steps.length; at++) {
    const step = steps[at];
    const moved: { rel: Rel; elem: Elem } | null = movement(step, { rel }, elem, fresh);
    if (moved) {
      rel = collapsing ? coalesce(moved.rel, fresh) : moved.rel;
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
    const row = rowOp(step, rel, elem, ordered, fresh);
    if (!row) break;
    rel = row;
  }

  if (at === steps.length)
    return { plan: nameBindings(rel), framing: { kind: 'elements', elem }, cols: elementCols(ordered).map((c) => c.name), channels };

  const retyped = terminal(steps[at], rel, elem, ordered, fresh);
  if (!retyped) return null;
  const { rel: retypedRel, ...rest } = retyped;

  const tail = scalarTail(retypedRel, rest.framing, rest.cols, rest.channels, steps, at + 1, fresh);
  if (!tail) return null;
  const { rel: tailRel, ...tailRest } = tail;
  return { plan: nameBindings(tailRel), ...tailRest };
}
