import { col, compilerInt, compilerText, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { Elem } from '../plan/plan.ts';
import { and, eq, meta, typeOf, VALUEMAP_PAIR, type Minter } from './build.ts';
import { FOREIGN_ORD, foreignPayloadCols } from './foreign.ts';
import { boundPropertyRelation } from './property.ts';
import { storedCompareOn } from './predicate.ts';
import type { GraphSource } from './source.ts';

/** The columns a landed relation's Plan binding (and every `Ref` to it) declares: the wire payload plus
 *  the `ord` emission-order column (`foreignRelation(withOrder)`), from which the seed and `.V()`/`.E()`
 *  re-root mint the `encounter` channel. Every read projects the subset it needs and ignores `ord`. */
export const landedCols = (kind: Elem): readonly import('../../rel/types.ts').ColMeta[] =>
  [...foreignPayloadCols(kind), meta(FOREIGN_ORD, 'int')];

// ---------- BoundGraph — a GraphSource over an INJECTED graph, id-carry + rejoin ----------
//
// The `GraphSource` implementation for a LANDED graph (a federate subgraph, an `io()`/`subgraph()`
// import). It is the id-carry model, confirmed against both vendored references (see the plan doc's
// "bound-stream model" section):
//
//   - TinkerPop traverses a graph by re-reading STRUCTURE, keyed on the element id
//     (`GraphStep.convertElementsToIds` → `.id()`; `VertexStep` re-reads adjacency; `Attachable` =
//     `hostGraph.vertices(id)`). Payload-carry is its DETACHED/inert form, doc'd "not traversable".
//   - Calcite binds a source ONLY at the leaf (`RelOptTable`); every operator re-derives columns by
//     ordinal reference and re-fetch is a `Correlate` join by key — no payload-carry anywhere.
//
// So a bound element travels as an ID (plus channels), exactly as a base element does over the SQLite
// tables. Every read (`values`, `hasLabel`, `has`, `label`, and the terminal leaf) REJOINS the landed
// relation by id — the same act `BaseGraph` performs against `nodes`/`edges`, differing only in the
// physical shape (a landed `{t,v}` JSON tree / JSON label array vs. the base side tables).
//
// Each read builds its OWN copy of the landed relation from the rows (see `cteOf`): the landed relation
// is referenced from many EXISTS/join subtrees, and a structurally SHARED node is duplicated by a
// tree-rebuild pass — the RelIR scope check refuses that. TODO(materialize-once): hoist the landed
// relation into a NAMED `AS MATERIALIZED` Plan binding (Calcite's `RelOptMaterialization` — the planner
// move) so N reads share ONE CTE rather than re-exploding the JSON literal per read.
//
// The physical column shapes are `foreignRelation`'s (`foreign.ts`): a landed VERTEX carries
// `(id, label: JSON name array, props: JSON {t,v} tree)`; a landed EDGE carries
// `(id, label: TEXT name, src, tgt, props: JSON)`.

const jsonExtract = (e: Expr, path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [e, compilerText(path)] });
const jsonKeyPath = (key: string): string => `$."${key.replace(/"/g, '""')}"`;

/** The inline string label names in a movement/label-arg set — the ONLY form a landed edge's TEXT
 *  `label` column matches (`label IN (names)`). A bound label PARAMETER is not modelled and the caller
 *  (`detachedTail`) pre-validates against it, so a non-inline arg here is a caller bug, not a user one. */
const inlineNames = (labels: readonly Arg[]): string[] =>
  labels.flatMap((a) => (a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value]))
    .filter((v): v is string => typeof v === 'string');

/** A single landed row of `cte`, correlated on an OUTER element id — the rejoin every point-of-use read
 *  opens with. `cte` is this read's own fresh copy of the landed relation. */
const rowById = (cte: Rel, id: Expr, fresh: Minter): Rel =>
  make.filter({ id: fresh('brow'), input: cte, channels: [], type: cte.type, pred: eq(col(cte.id, 'id'), id) });

/** Wrap a member-matching relation as a correlated `EXISTS` over the landed row — the shared tail of the
 *  `has`/`hasLabel` rejoins. */
const existsOf = (matched: Rel, fresh: Minter): Expr =>
  ({ kind: 'exists', negated: false, plan: make.project({ id: fresh('bex'), input: matched, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] }) });

export function boundGraph(vertexBinding: string | null, edgeBinding: string | null): GraphSource {
  // Each read REFERENCES the landed relation by NAME — a `Ref` to its Plan binding, which
  // `lowerForeign` declares ONCE as a `fenced` (`AS MATERIALIZED`) CTE over the landed rows. This is
  // Calcite's materialize-once (`RelOptMaterialization`): N reads share one CTE and its ONE `json_each`
  // bind, computed once, rather than re-exploding the JSON literal per read. A structurally SHARED
  // landed NODE would instead be duplicated by a tree-rebuild pass (the RelIR scope check refuses it),
  // which a `Ref` (a named leaf) sidesteps.
  const cteOf = (kind: Elem, fresh: Minter): Rel => {
    const name = kind === 'edge' ? edgeBinding : vertexBinding;
    if (!name) throw new Error(`boundGraph: no landed ${kind} relation to traverse`); // detachedTail pre-checks; a throw is a clear query failure, not a silent wrong answer
    return make.ref({ id: fresh('bref'), name, channels: [], type: typeOf(...landedCols(kind)) });
  };

  return {
    // ---- element sourcing: `.V()` / `.E()` re-root at the landed relation, narrowed by inline id ----
    elementScan(kind, args, fresh) {
      const scan = cteOf(kind, fresh);
      const ids: unknown[] = [];
      for (const a of args) {
        if (a.name != null) return null; // a bound id PARAMETER is not modelled over a landed relation
        const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
        for (const v of members) ids.push(v);
      }
      const pred = ids.length
        ? { kind: 'in-list' as const, expr: col(scan.id, 'id'), values: ids.map((v) => lit(v)) }
        : undefined;
      return { scan, pred };
    },

    // ---- adjacency: the landed EDGES relation, re-exposed so a hop joins it by src/tgt/id ----
    adjacencyEdges(fresh) {
      const e = cteOf('edge', fresh);
      return make.project({
        id: fresh('bae'), input: e, channels: [],
        type: typeOf(meta('id', 'any', true), meta('src', 'any', true), meta('label', 'text', true), meta('tgt', 'any', true)),
        exprs: [['id', col(e.id, 'id')], ['src', col(e.id, 'src')], ['label', col(e.id, 'label')], ['tgt', col(e.id, 'tgt')]],
      });
    },

    // ---- the label restriction: a plain `IN` over the landed edge's TEXT label column ----
    edgeLabelMatch(labelCol, labels) {
      return { kind: 'in-list', expr: labelCol, values: inlineNames(labels).map(compilerText) };
    },

    // ---- values(keys…): rejoin the landed relation by id, explode its `{t,v}` tree per key ----
    propertyValues(input, kind, keys, fresh) {
      const cte = cteOf(kind, fresh);
      const P = { id: 'bvid', props: 'bvprops' } as const;
      const pref = make.project({
        id: fresh('bvp'), input: cte, channels: [],
        type: typeOf(meta(P.id, 'any', true), meta(P.props, 'json', true)),
        exprs: [[P.id, col(cte.id, 'id')], [P.props, col(cte.id, 'props')]],
      });
      const j = make.join({
        id: fresh('bvj'), left: input, right: pref, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...input.type.cols, meta(P.id, 'any', true), meta(P.props, 'json', true)),
        on: eq(col(pref.id, P.id), col(input.id, 'id')),
      });
      // Per-key explode of the landed props tree — the same shape `foreignValues` reads, sourced from the
      // rejoined `props`. A vertex key holds an ARRAY of `{t,v}` nodes; an edge key holds one.
      const KEY = { value: 'bkv', key: 'bkk' } as const;
      const perKey = make.explode({
        id: fresh('bke'), input: j, channels: input.channels, expr: col(j.id, P.props), as: { key: KEY.key, value: KEY.value },
        type: typeOf(...j.type.cols, meta(KEY.key, 'text', true), meta(KEY.value, 'any', true)),
      });
      const wanted = keys && keys.length
        ? make.filter({ id: fresh('bkf'), input: perKey, channels: input.channels, type: perKey.type,
          pred: { kind: 'in-list', expr: col(perKey.id, KEY.key), values: keys.map(compilerText) } })
        : perKey;
      const NODE = 'bkn';
      const nodes = kind === 'edge' ? wanted : make.explode({
        id: fresh('bkx'), input: wanted, channels: input.channels, expr: col(wanted.id, KEY.value), as: { value: NODE },
        type: typeOf(...wanted.type.cols, meta(NODE, 'any', true)),
      });
      const node = kind === 'edge' ? col(wanted.id, KEY.value) : col(nodes.id, NODE);
      return make.project({
        id: fresh('bvv'), input: nodes, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...input.channels.map((c) => meta(c.col, 'int'))),
        exprs: [['v', jsonExtract(node, '$.v')], ['vtype', jsonExtract(node, '$.t')],
          ...input.channels.map((c) => [c.col, col(nodes.id, c.col)] as const)],
      });
    },

    // ---- hasLabel(names…): EXISTS over the landed label array / TEXT column, correlated on id ----
    hasLabelPredicate(kind, id, _labelCol, labels, fresh) {
      const names = inlineNames(labels);
      const row = rowById(cteOf(kind, fresh), id, fresh);
      if (kind === 'edge') {
        // The landed edge label is a bare name string.
        return existsOf(make.filter({ id: fresh('blm'), input: row, channels: [], type: row.type,
          pred: { kind: 'in-list', expr: col(row.id, 'label'), values: names.map(compilerText) } }), fresh);
      }
      // A vertex holds a JSON ARRAY of label names — membership is any-of.
      const ex = make.explode({ id: fresh('blx'), input: row, channels: [], expr: col(row.id, 'label'), as: { value: 'lv' },
        type: typeOf(...row.type.cols, meta('lv', 'any', true)) });
      return existsOf(make.filter({ id: fresh('blf'), input: ex, channels: [], type: ex.type,
        pred: { kind: 'in-list', expr: col(ex.id, 'lv'), values: names.map(compilerText) } }), fresh);
    },

    // ---- has(key[,v]): EXISTS over the landed property tree at `key`, correlated on id ----
    hasPropertyPredicate(kind, id, key, valuePred, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      const at = jsonExtract(col(row.id, 'props'), jsonKeyPath(key));
      if (kind === 'edge') {
        // An edge key holds a single `{t,v}` node.
        const value = jsonExtract(at, '$.v');
        const matches = valuePred ? valuePred(value, jsonExtract(at, '$.t')) : undefined;
        if (valuePred && !matches) return null;
        const present: Expr = { kind: 'binary', op: '!=', left: at, right: lit(null) };
        return existsOf(make.filter({ id: fresh('bhe'), input: row, channels: [], type: row.type,
          pred: matches ? and(present, matches) : present }), fresh);
      }
      // A vertex key holds an ARRAY of `{t,v}` nodes — any-member membership.
      const ex = make.explode({ id: fresh('bhx'), input: row, channels: [], expr: at, as: { value: 'hv' },
        type: typeOf(...row.type.cols, meta('hv', 'any', true)) });
      const matches = valuePred ? valuePred(jsonExtract(col(ex.id, 'hv'), '$.v'), jsonExtract(col(ex.id, 'hv'), '$.t')) : undefined;
      if (valuePred && !matches) return null;
      const matched = matches ? make.filter({ id: fresh('bhf'), input: ex, channels: [], type: ex.type, pred: matches }) : ex;
      return existsOf(matched, fresh);
    },

    // ---- has(T.id/T.label): the id compares directly; the label rejoins ----
    hasTokenPredicate(kind, id, token, valuePred, fresh) {
      // The landed id IS the external id — `has(T.id, P)` compares it directly, no rejoin.
      if (token === 'id') return valuePred(id);
      const row = rowById(cteOf(kind, fresh), id, fresh);
      if (kind === 'edge') {
        const matches = valuePred(col(row.id, 'label'));
        return matches && existsOf(make.filter({ id: fresh('bti'), input: row, channels: [], type: row.type, pred: matches }), fresh);
      }
      const ex = make.explode({ id: fresh('btx'), input: row, channels: [], expr: col(row.id, 'label'), as: { value: 'tv' },
        type: typeOf(...row.type.cols, meta('tv', 'any', true)) });
      const matches = valuePred(col(ex.id, 'tv'));
      return matches && existsOf(make.filter({ id: fresh('btf'), input: ex, channels: [], type: ex.type, pred: matches }), fresh);
    },

    // ---- id() / label() scalar reads ----
    externalId(_kind, id) {
      return id; // the landed id is already the external id
    },
    labelScalar(kind, id, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      // A vertex's label set is a JSON array — `label()` is its FIRST member; an edge's is the bare name.
      const value: Expr = kind === 'edge' ? col(row.id, 'label') : jsonExtract(col(row.id, 'label'), '$[0]');
      return { kind: 'scalar', plan: make.project({ id: fresh('bls'), input: row, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', value]] }) };
    },

    // ---- by('key'): the FIRST property value at key, rejoined by id ----
    propertyScalar(kind, id, key, ordering, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      // A vertex key holds an ARRAY of `{t,v}` nodes (first = insertion order); an edge key holds one.
      const node = jsonExtract(col(row.id, 'props'), kind === 'edge' ? jsonKeyPath(key) : `${jsonKeyPath(key)}[0]`);
      const raw = jsonExtract(node, '$.v');
      const value = ordering ? storedCompareOn(jsonExtract(node, '$.t'))(raw) : raw;
      return { kind: 'scalar', plan: make.project({ id: fresh('bps'), input: row, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', value]] }) };
    },

    // ---- properties(): the property-row stream, exploded from the landed {t,v} tree ----
    propertyStream(input, kind, keys, fresh) {
      return boundPropertyRelation(input, cteOf(kind, fresh), kind, keys, fresh);
    },

    // ---- valueMap()/elementMap(): the per-key value arrays, from the landed {t,v} tree ----
    valueMapPairs(kind, id, keys, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      // json_each over the props OBJECT yields (key = the property name, value = its {t,v} nodes). A
      // vertex key holds an ARRAY of nodes; an edge key holds ONE, so wrap it to match the base shape
      // (`elementValueMap` takes `$[#-1]` of the array for a flat map).
      const ex = make.explode({
        id: fresh('bvmx'), input: row, channels: [], expr: col(row.id, 'props'),
        as: { key: VALUEMAP_PAIR.key, value: VALUEMAP_PAIR.values },
        type: typeOf(...row.type.cols, meta(VALUEMAP_PAIR.key, 'text', true), meta(VALUEMAP_PAIR.values, 'json', true)),
      });
      const wanted = keys && keys.length
        ? make.filter({ id: fresh('bvmf'), input: ex, channels: [], type: ex.type,
          pred: { kind: 'in-list', expr: col(ex.id, VALUEMAP_PAIR.key), values: keys.map(compilerText) } })
        : ex;
      // A deterministic per-key ordinal — `json_each` over an object gives no numeric index, so rank the
      // keys (the map is order-independent when compared, and this pins it under perturbation).
      const ranked = make.window({
        id: fresh('bvmw'), input: wanted, channels: [], type: typeOf(...wanted.type.cols, meta(VALUEMAP_PAIR.ord, 'int')),
        specs: [[VALUEMAP_PAIR.ord, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: [{ expr: col(wanted.id, VALUEMAP_PAIR.key), dir: 'asc' }] } }]],
      });
      // `json()` keeps the array's JSON subtype when it is nested into the `{t:'list', v:[…]}` node —
      // without it json_each's value lands as TEXT and `frameTypedNode` sees a string, not a list.
      const valuesArray: Expr = kind === 'edge'
        ? { kind: 'call', fn: 'json_array', args: [col(ranked.id, VALUEMAP_PAIR.values)] }
        : { kind: 'call', fn: 'json', args: [col(ranked.id, VALUEMAP_PAIR.values)] };
      return make.project({
        id: fresh('bvmp'), input: ranked, channels: [],
        type: typeOf(meta(VALUEMAP_PAIR.key, 'text'), meta(VALUEMAP_PAIR.values, 'json'), meta(VALUEMAP_PAIR.ord, 'int')),
        exprs: [[VALUEMAP_PAIR.key, col(ranked.id, VALUEMAP_PAIR.key)], [VALUEMAP_PAIR.values, valuesArray], [VALUEMAP_PAIR.ord, col(ranked.id, VALUEMAP_PAIR.ord)]],
      });
    },

    // ---- labels(): fan out the landed label set, rejoined by id ----
    labelNames(input, kind, fresh) {
      const cte = cteOf(kind, fresh);
      const P = { id: 'blnid', label: 'blnl' } as const;
      const pref = make.project({
        id: fresh('blnp'), input: cte, channels: [],
        type: typeOf(meta(P.id, 'any', true), meta(P.label, kind === 'edge' ? 'text' : 'json', true)),
        exprs: [[P.id, col(cte.id, 'id')], [P.label, col(cte.id, 'label')]],
      });
      const j = make.join({
        id: fresh('blnj'), left: input, right: pref, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...input.type.cols, meta(P.id, 'any', true), meta(P.label, kind === 'edge' ? 'text' : 'json', true)),
        on: eq(col(pref.id, P.id), col(input.id, 'id')),
      });
      const carried = input.channels.map((c) => [c.col, meta(c.col, 'int')] as const);
      // An edge's landed label is a bare name — one row, order key 0. A vertex's is a JSON array — explode
      // it, and json_each's KEY (the array index) IS the emission order the landing preserved.
      if (kind === 'edge') {
        return make.project({
          id: fresh('blnv'), input: j, channels: input.channels,
          type: typeOf(meta('v', 'any', true), meta('lord', 'int'), ...carried.map(([, m]) => m)),
          exprs: [['v', col(j.id, P.label)], ['lord', compilerInt(0)], ...input.channels.map((c) => [c.col, col(j.id, c.col)] as const)],
        });
      }
      const ex = make.explode({
        id: fresh('blnx'), input: j, channels: input.channels, expr: col(j.id, P.label), as: { value: 'blnv', ord: 'blno' },
        type: typeOf(...j.type.cols, meta('blnv', 'any', true), meta('blno', 'int')),
      });
      return make.project({
        id: fresh('blnr'), input: ex, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('lord', 'int'), ...carried.map(([, m]) => m)),
        exprs: [['v', col(ex.id, 'blnv')], ['lord', col(ex.id, 'blno')], ...input.channels.map((c) => [c.col, col(ex.id, c.col)] as const)],
      });
    },

    // ---- the zero-label gate: the landed label array (vertex) / bare name (edge) is non-empty ----
    hasAnyLabel(kind, id, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      const nonEmpty: Expr = kind === 'edge'
        ? { kind: 'binary', op: '!=', left: col(row.id, 'label'), right: lit(null) }
        : { kind: 'binary', op: '>', left: { kind: 'call', fn: 'json_array_length', args: [col(row.id, 'label')] }, right: compilerInt(0) };
      return existsOf(make.filter({ id: fresh('bha'), input: row, channels: [], type: row.type, pred: nonEmpty }), fresh);
    },

    // ---- id/edge-label read off an anchor row — the landed id IS external; the landed edge label the
    //      bare name ----
    externalIdOf(row) {
      return col(row.id, 'id');
    },
    edgeLabelOf(row) {
      return col(row.id, 'label');
    },

    // ---- the single correlated row an id names (token/endpoint anchor) — the landed row rejoined ----
    elementRow(kind, id, fresh) {
      return rowById(cteOf(kind, fresh), id, fresh);
    },

    // ---- an element's labels as a JSON array — a landed vertex label IS already an array; an edge's is
    //      the one bare name wrapped as a single-element array (edges are single-label) ----
    labelArray(kind, id, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      const value: Expr = kind === 'edge'
        ? { kind: 'call', fn: 'json_array', args: [col(row.id, 'label')] }
        : { kind: 'call', fn: 'json', args: [col(row.id, 'label')] };
      return { kind: 'scalar', plan: make.project({ id: fresh('bla'), input: row, channels: [], type: typeOf(meta('v', 'json', true)), exprs: [['v', value]] }) };
    },

    // ---- a path position: rejoin by id, rebuild the {t,v} node from the landed columns ----
    elementNode(kind, id, fresh) {
      const row = rowById(cteOf(kind, fresh), id, fresh);
      // The landed columns ARE the wire payload — a vertex's `label` is a JSON name array and its
      // `props` the {t,v} tree; wrap those in json() so they NEST as JSON rather than a quoted TEXT
      // string (frameTypedNode reads a string otherwise), exactly as valueMapPairs does. An edge's
      // label is a bare name and needs no wrap.
      const asJson = (e: Expr): Expr => ({ kind: 'call', fn: 'json', args: [e] });
      const payload: Expr = {
        kind: 'json-object',
        entries: [
          ['id', col(row.id, 'id')],
          ['label', kind === 'edge' ? col(row.id, 'label') : asJson(col(row.id, 'label'))],
          ...(kind === 'edge'
            ? [['src', col(row.id, 'src')] as const, ['tgt', col(row.id, 'tgt')] as const]
            : []),
          ['props', asJson(col(row.id, 'props'))],
        ],
        binary: false,
      };
      const node: Expr = { kind: 'json-object', entries: [['t', compilerText(kind)], ['v', payload]], binary: false };
      return { kind: 'scalar', plan: make.project({ id: fresh('ben'), input: row, channels: [], type: typeOf(meta('n', 'json', true)), exprs: [['n', node]] }) };
    },

    // ---- leaf (Mechanism B): rejoin to reconstitute the wire payload for a terminal bound element ----
    leafPayload(input, kind, opts, fresh) {
      const cte = cteOf(kind, fresh);
      const payload = foreignPayloadCols(kind);
      // Prefix the landed columns before the join so they cannot collide with the id-stream's own `id`.
      const B = (name: string): string => `bl_${name}`;
      const pref = make.project({
        id: fresh('blp'), input: cte, channels: [],
        type: typeOf(...payload.map((c) => meta(B(c.name), c.type, c.nullable))),
        exprs: payload.map((c) => [B(c.name), col(cte.id, c.name)] as const),
      });
      const j = make.join({
        id: fresh('blj'), left: input, right: pref, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...input.type.cols, ...pref.type.cols),
        on: eq(col(pref.id, B('id')), col(input.id, 'id')),
      });
      // A COLLAPSED bound element carries the surviving `bulk` (`SUM(bulk)`), which the wire framer reads
      // to re-emit the row that many times — exactly as `elementPayload` carries it over the base graph.
      // Without it a `…out()` element-terminal after a collapse would answer N traversers as one row.
      const bulk = opts.bulk ? input.channels.find((channel) => channel.role === 'bulk') : undefined;
      return make.project({
        id: fresh('blr'), input: j, channels: [], type: typeOf(...payload, ...(bulk ? [meta('bulk', 'int')] : [])),
        exprs: [
          ...payload.map((c) => [c.name, col(j.id, B(c.name))] as const),
          ...(bulk ? [['bulk', col(j.id, bulk.col)] as const] : []),
        ],
      });
    },
  };
}
