import type { Channels } from '../../channels.ts';
import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { name as nameBindings } from '../../rel/passes/name.ts';
import type { Plan } from '../../rel/plan.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelType, type SqlType } from '../../rel/types.ts';
import { isLocalScope, sliceOf } from '../ir/step.ts';
import { PER_ROW, STATIC, type ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { flattenListArgs, isNested } from '../../gremlin/frontend.ts';
import { childSteps } from '../steps/tail/child-shape.ts';
import type { IRStep } from '../ir/strategies.ts';
import { analyzeChain } from '../ir/analyze.ts';
import { containsTextSearch, predicateExpr, storedCompare } from './predicate.ts';

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

const meta = (colName: string, type: SqlType, nullable = false): ColMeta => ({ name: colName, type, nullable });
const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });

/** Physical columns of the two element tables, as `Scan` must declare them. `Scan` is the one node
 *  that names the physical schema (§3.3), so this list IS the algebra's view of storage. */
const NODE_COLS = [meta('id', 'int'), meta('uid', 'text', true)];
const EDGE_COLS = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

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

/** Relation ids, minted PER LOWERING. A module-global counter would make the emitted SQL depend on
 *  how many traversals this process had already compiled — two compiles of one query producing two
 *  different strings, which breaks every snapshot and every cache keyed on the text. */
type Minter = (hint: string) => import('../../rel/types.ts').RelId;
const minter = (): Minter => { let n = 0; return (hint) => relId(`${hint}${n++}`); };

/** The two element tables' property side-tables, and the column each keys its owner by. The
 *  asymmetry (`node` vs `edge`) is the physical schema's, so it lives beside the `Scan` tables. */
const PROPERTIES = {
  vertex: { table: 'vertex_properties', owner: 'node' },
  edge: { table: 'edge_properties', owner: 'edge' },
} as const;

function and(left: Expr | undefined, right: Expr): Expr;
function and(left: Expr, right: Expr | undefined): Expr;
function and(left: Expr | undefined, right: Expr | undefined): Expr {
  if (!left || !right) {
    const only = left ?? right;
    if (!only) throw new Error('RelIR lowering: a conjunction of nothing');
    return only;
  }
  return { kind: 'binary', op: 'and', left, right };
}

const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });


/** `SELECT id FROM labels WHERE name IN (…)` — the name→id indirection every label-aware step
 *  reaches through, and the reason `labels` is a `Scan` table rather than a string in an emitter. */
function labelIds(names: readonly string[], fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('lbl'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const matching = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: { kind: 'in-list', expr: col(scan.id, 'name'), values: names.map((n) => lit(n, 'text')) },
  });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
}

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
      : predicateExpr(col(props.id, 'value'), val, storedCompare(props.id));
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

/** The storage-class recovery every stored value goes through on the way out: a JSON-typed value
 *  comes back as JSON, everything else as itself. Shared by `values()` and, later, every other
 *  reader of a property value. */
const storedValue = (rel: import('../../rel/types.ts').RelId): Expr => ({
  kind: 'case',
  whens: [[{ kind: 'in-list', expr: col(rel, 'vtype'), values: ['list', 'map', 'set'].map((t) => lit(t, 'text')) },
    { kind: 'call', fn: 'json', args: [col(rel, 'value')] }]],
  else: col(rel, 'value'),
});

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
function rowOp(step: IRStep, input: Rel, ordered: boolean, fresh: Minter): Rel | null {
  if (step.modulators?.length || step.optionArms) return null;
  if (step.name === 'identity' || step.name === 'barrier') return (step.args ?? []).length ? null : input;

  if (step.name === 'limit' || step.name === 'skip' || step.name === 'range') {
    // A slice is only a WINDOW if the relation has an order to take it from, and `demandsEncounter`
    // is what guarantees one is threaded — so the caller's gate is this arm's precondition, not a
    // belt-and-braces check.
    if (!ordered || isLocalScope(step)) return null;
    const slice = sliceOf(step);
    const sorted = make.sort({
      id: fresh('so'), input, channels: input.channels, type: input.type,
      terms: [{ expr: col(input.id, 'encounter'), dir: 'asc' }],
    });
    return make.limit({
      id: fresh('li'), input: sorted, channels: input.channels, type: input.type,
      ...(slice.limit === null ? {} : { count: lit(slice.limit, 'int') }),
      ...(slice.offset ? { offset: lit(slice.offset, 'int') } : {}),
    });
  }

  if (step.name !== 'dedup' || (step.args ?? []).length) return null;
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
 * RE-MINT the emission order after a fan-out.
 *
 * A hop is a join: one incoming traverser becomes N outgoing ones, so the incoming positions no
 * longer NUMBER the outgoing rows — several share one. `ROW_NUMBER() OVER (ORDER BY encounter, id)`
 * renumbers them, and the tie-break on `id` is what makes the result deterministic rather than
 * merely ordered: without it the rows sharing an incoming position would be numbered in whatever
 * order SQLite produced them, which is the defect `mise run test:perturbed` exists to find.
 *
 * Two nodes because `Window` may only EXTEND its input (§3.5) — it adds the new column, and the
 * projection is what makes that column the channel and drops the stale one. The assembler fuses
 * them back into one SELECT, which is the division of labour §5 describes: the IR stays normalized
 * and the emitter does the composing.
 */
function remintOrder(rel: Rel, fresh: Minter): Rel {
  const minted = 'rn';
  const windowed = make.window({
    id: fresh('w'), input: rel, channels: rel.channels,
    type: typeOf(...elementCols(true), meta(minted, 'int')),
    specs: [[minted, {
      kind: 'window-expr', fn: 'row_number', args: [],
      spec: { partitionBy: [], orderBy: [{ expr: col(rel.id, 'encounter'), dir: 'asc' }, { expr: col(rel.id, 'id'), dir: 'asc' }] },
    }]],
  });
  return make.project({
    id: fresh('ro'), input: windowed, channels: ORDERED, type: typeOf(...elementCols(true)),
    exprs: [['id', col(windowed.id, 'id')], ['bulk', col(windowed.id, 'bulk')], ['encounter', col(windowed.id, minted)]],
  });
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
 */
const coalesce = (rel: Rel, fresh: Minter): Rel =>
  make.aggregate({
    id: fresh('cl'), input: rel, channels: BULK, type: typeOf(meta('id', 'int'), meta('bulk', 'int')),
    groupBy: [col(rel.id, 'id')],
    aggs: [['bulk', { kind: 'agg', fn: 'sum', args: [col(rel.id, 'bulk')] }]],
  });

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
    const total: Expr = { kind: 'call', fn: 'COALESCE', args: [{ kind: 'agg', fn: 'sum', args: [col(input.id, 'bulk')] }, lit(0, 'int')] };
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
  const first = steps[0];
  if (!first) return null;
  if (first.name !== 'V' && first.name !== 'E') return null;
  // A modulator or an option arm on the source is not a source argument; decline rather than
  // silently ignore it.
  if (first.modulators?.length || first.optionArms) return null;

  const fresh = minter();
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
      rel = collapse ? coalesce(moved.rel, fresh) : moved.rel;
      elem = moved.elem;
      continue;
    }
    const clause = sourceFilter(step, { id: col(rel.id, 'id'), rel }, elem, fresh, ctx);
    if (clause) { rel = make.filter({ id: fresh('f'), input: rel, channels: BULK, type: rel.type, pred: clause }); continue; }
    const row = rowOp(step, rel, ordered, fresh);
    if (!row) break;
    rel = row;
  }

  if (at === steps.length)
    return { plan: nameBindings(rel), framing: { kind: 'elements', elem }, cols: elementCols(ordered).map((c) => c.name), channels };

  const retyped = terminal(steps[at], rel, elem, ordered, fresh);
  if (!retyped) return null;
  const { rel: retypedRel, ...rest } = retyped;

  // Past the shape change the vocabulary is the NEW shape's, and `is(P)` is the whole of it here.
  // It is the same predicate module the source filters use, over the scalar's own `v` — which is
  // the point of having built that module rather than a `has`-shaped helper.
  const vtyped = rest.cols.includes('vtype');
  // A BOUNDARY before the filters, and it is not cosmetic. Fusing a `Filter` into its input's
  // block means the input's outputs are spelled as the EXPRESSIONS that compute them (§5) — SQL
  // has no other option, since a `WHERE` cannot name a select alias. So each `is` re-inlines the
  // whole projection, and with the vtype-aware ordering CASE in play that is ~20 binds apiece:
  // measured 25 / 45 / 65 for one, two and three range predicates, against legacy's 2 / 3 / 4.
  // Four would exceed the DO cap and fail closed where legacy answers — a support regression, not
  // a wall worth shipping. `Materialize` is exactly the declared remedy (§3.3: "a boundary hint …
  // where the planner needs a fence"), and it lands the same CTE-then-filter shape legacy emits.
  let filtered: Rel = steps[at + 1]?.name === 'is'
    ? make.materialize({ id: fresh('m'), input: retypedRel, channels: rest.channels, type: retypedRel.type })
    : retypedRel;
  for (at++; at < steps.length; at++) {
    const step = steps[at];
    if (step.name !== 'is' || step.modulators?.length || step.optionArms) return null;
    const args = step.args ?? [];
    if (args.length !== 1) return null;
    // A per-row `vtype` is in scope only where the value came from a stored property; a `count` is
    // a compile-time long and needs no ordering key. Same distinction `predicateSql` draws as
    // `typeCtx.kind === 'perRow'`.
    const pred2 = predicateExpr(col(filtered.id, 'v'), args[0], vtyped ? storedCompare(filtered.id) : undefined);
    if (!pred2) return null;
    filtered = make.filter({ id: fresh('f'), input: filtered, channels: rest.channels, type: filtered.type, pred: pred2 });
  }
  return { plan: nameBindings(filtered), ...rest };
}
