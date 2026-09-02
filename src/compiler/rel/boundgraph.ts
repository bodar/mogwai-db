import { col, compilerInt, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { Elem } from '../elem.ts';
import { and, eq, jsonExtract, meta, rowNumberWindow, typeOf, VALUEMAP_PAIR, type Minter } from './build.ts';
import type { Binding } from '../../rel/plan.ts';
import { foreignPayloadCols, landedCols } from './foreign.ts';
import { boundPropertyRelation } from './property.ts';
import { storedCompareOn } from './predicate.ts';
import type { GraphSource } from './source.ts';

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
// Each read REFERENCES the landed relation by NAME (a `Ref`, see `cteOf`) rather than rebuilding it: a
// structurally SHARED node would be duplicated by a tree-rebuild pass — the RelIR scope check refuses
// that — so `lowerForeign` declares the landed relation ONCE as a `fenced` (`AS MATERIALIZED`) Plan
// binding and every read points a `Ref` at it. That is Calcite's materialize-once
// (`RelOptMaterialization` — the planner move): N reads share ONE CTE and its ONE `json_each` bind,
// computed once, rather than re-exploding the JSON literal per read.
//
// The physical column shapes are `foreignRelation`'s (`foreign.ts`): a landed VERTEX carries
// `(id, label: JSON name array, props: JSON {t,v} tree)`; a landed EDGE carries
// `(id, label: TEXT name, src, tgt, props: JSON)`.

const jsonKeyPath = (key: string): string => `$."${key.replace(/"/g, '""')}"`;

/** An element id from a NON-parameter V()/E()/hasId() arg (a parameter is declined by the caller) — a
 *  parsed LITERAL, so it INLINES as a typed SQL literal rather than spending a bind (the Golden Rule: a
 *  bind serves a user parameter, nothing else). An integer rowid inlines INTEGER; any other id form
 *  inlines as text — the same match the bound `?` produced, at zero parameter-budget cost. */
const idLit = (v: unknown): Expr =>
  typeof v === 'number' && Number.isSafeInteger(v) ? compilerInt(v) : compilerText(String(v));

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

  // The rejoined landed row + its bare wire payload `{id, label, props[, src, tgt]}`, shared by
  // `elementNode` (which adds the `{t,v}` envelope) and `elementObject` (which returns it bare).
  const boundPayload = (kind: Elem, id: Expr, fresh: Minter): { row: Rel; payload: Expr } => {
    const row = rowById(cteOf(kind, fresh), id, fresh);
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
    return { row, payload };
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
        ? { kind: 'in-list' as const, expr: col(scan.id, 'id'), values: ids.map(idLit) }
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
      // A bound EDGE's `has()` is served by the `boundPropertyRelation` JOIN path, so this correlated
      // EXISTS form is only ever reached for a VERTEX — proven: an unconditional throw here leaves the
      // whole federation suite green. So an edge is declined (fail-closed) rather than carrying a dead
      // branch that duplicated the vertex scaffold below.
      if (kind === 'edge') return null;
      const row = rowById(cteOf(kind, fresh), id, fresh);
      const at = jsonExtract(col(row.id, 'props'), jsonKeyPath(key));
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
      const ranked = rowNumberWindow(wanted, VALUEMAP_PAIR.ord, [],
        { partitionBy: [], orderBy: [{ expr: col(wanted.id, VALUEMAP_PAIR.key), dir: 'asc' }] }, fresh);
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
      // Only ever called for a VERTEX (the multi-label group gate, `map.ts`); a vertex's label set is a
      // JSON array, non-empty when it carries any label. `cteOf(kind)` keeps the parameter honest.
      const row = rowById(cteOf(kind, fresh), id, fresh);
      const nonEmpty: Expr = { kind: 'binary', op: '>', left: { kind: 'call', fn: 'json_array_length', args: [col(row.id, 'label')] }, right: compilerInt(0) };
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

    // ---- a member/position element, rejoined by id and rebuilt from the landed columns ----
    // The landed columns ARE the wire payload — a vertex's `label` is a JSON name array and its `props`
    // the {t,v} tree; wrap those in json() so they NEST as JSON rather than a quoted TEXT string
    // (frameTypedNode reads a string otherwise), exactly as valueMapPairs does. An edge's label is a bare
    // name and needs no wrap. `elementNode` adds the `{t,v}` envelope the typed-tree framer reads;
    // `elementObject` returns the bare payload the `listItemBuffers` `elem` arm maps `rowVertex` over —
    // the same `elementNode`/`elementObject` split the base graph draws in `element.ts`.
    elementNode(kind, id, fresh) {
      const { row, payload } = boundPayload(kind, id, fresh);
      const node: Expr = { kind: 'json-object', entries: [['t', compilerText(kind)], ['v', payload]], binary: false };
      return { kind: 'scalar', plan: make.project({ id: fresh('ben'), input: row, channels: [], type: typeOf(meta('n', 'json', true)), exprs: [['n', node]] }) };
    },

    elementObject(kind, id, fresh) {
      const { row, payload } = boundPayload(kind, id, fresh);
      return { kind: 'scalar', plan: make.project({ id: fresh('beo'), input: row, channels: [], type: typeOf(meta('n', 'json', true)), exprs: [['n', payload]] }) };
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

// ---------- unifiedBoundGraph — the POST-MERGE source over SEVERAL landed graphs (Phase 3) ----------
//
// A multi-graph merge (`union(federate(A).V(), federate(B).V())`) leaves a stream whose rows carry an
// `id` from disjoint landed id-spaces plus a `graph` channel (Phase 2's discriminator) naming which one.
// A post-merge element READ (`values(k)`, a bare element return) must rejoin the right graph's payload,
// so a single-CTE `boundGraph` (which rejoins by id alone) would silently read the wrong graph. This
// source is the discriminator PROMOTED from a channel into a relation: the arms' landed CTEs are unioned
// under a `graph` tag, and every read rejoins by the COMPOSITE `(graph, id)`, reading the graph value off
// the stream row's own `graph` channel.
//
// It implements ONLY the INPUT-CARRYING reads — `propertyValues` and `leafPayload` take the whole stream
// `input`, so they can read its `graph` channel and add it to their join. The correlated id-only reads
// (`hasLabelPredicate`, `propertyScalar`, movement, …) receive only an `id` and cannot see the graph, so
// they stay unsupported here and `postMergeTail` (`segment.ts`) admits only the input-carrying tail —
// anything else fails closed as `UnsupportedTraversal` rather than misjoining one graph.

/** One landed arm of a multi-graph merge: its graph identity, the CTE binding names holding its landed
 *  vertices/edges, and those bindings' Plan declarations. `unifiedBoundGraph` tags each arm's rows with
 *  `graph` and unions them into the relation a post-merge read rejoins. */
export interface MergedGraph {
  readonly graph: string;
  readonly vertexBinding: string | null;
  readonly edgeBinding: string | null;
  readonly bindings: readonly Binding[];
}

export function unifiedBoundGraph(mergedGraphs: readonly MergedGraph[]): GraphSource {
  const first = mergedGraphs[0]!;
  // The base carries the interface shape and the SAFE id-only reads (`externalId`/`externalIdOf`/edge
  // label — they return the stream's own column, no rejoin, so they are correct unified). Every rejoin
  // read is overridden below or gated out; `postMergeTail` is the fail-closed boundary.
  const base = boundGraph(first.vertexBinding, first.edgeBinding);

  /** The value of the stream row's `graph` channel — the graph half of the composite identity. */
  const graphColOf = (input: Rel): Expr => {
    const channel = input.channels.find((c) => c.role === 'graph');
    if (!channel) throw new Error('unifiedBoundGraph: the merged stream carries no graph channel to rejoin by');
    return col(input.id, channel.col);
  };

  /** The graph-TAGGED union of every arm's landed relation of this kind: `SELECT '<g>' AS graph, <cols>
   *  FROM <bgv_g> UNION ALL …`. A fresh copy per read (like `boundGraph.cteOf`) so a structurally shared
   *  node is never rebuilt by a pass. */
  const unifiedCte = (kind: Elem, fresh: Minter): Rel => {
    const arms: Rel[] = [];
    for (const g of mergedGraphs) {
      const binding = kind === 'edge' ? g.edgeBinding : g.vertexBinding;
      if (!binding) continue; // this graph landed no rows of this kind
      const ref = make.ref({ id: fresh('uref'), name: binding, channels: [], type: typeOf(...landedCols(kind)) });
      arms.push(make.project({
        id: fresh('utag'), input: ref, channels: [], type: typeOf(meta('graph', 'text'), ...landedCols(kind)),
        exprs: [['graph', compilerText(g.graph)], ...landedCols(kind).map((c) => [c.name, col(ref.id, c.name)] as const)],
      }));
    }
    if (arms.length === 0) throw new Error(`unifiedBoundGraph: no landed ${kind} relation across the merged graphs`);
    return arms.length === 1 ? arms[0]! : make.union({ id: fresh('uunion'), inputs: arms, all: true, channels: [], type: arms[0]!.type });
  };

  return {
    ...base,

    // The per-arm landed CTEs the reads reference by name — declared once at `lowered()` through the
    // source, exactly as a `decorateGraph` stack declares its layers.
    bindings: () => mergedGraphs.flatMap((g) => g.bindings),

    // ---- values(keys…): rejoin the UNIFIED relation by (graph, id), explode its `{t,v}` tree per key ----
    propertyValues(input, kind, keys, fresh) {
      const cte = unifiedCte(kind, fresh);
      const P = { id: 'uvid', props: 'uvprops', graph: 'uvg' } as const;
      const pref = make.project({
        id: fresh('uvp'), input: cte, channels: [],
        type: typeOf(meta(P.id, 'any', true), meta(P.props, 'json', true), meta(P.graph, 'text', true)),
        exprs: [[P.id, col(cte.id, 'id')], [P.props, col(cte.id, 'props')], [P.graph, col(cte.id, 'graph')]],
      });
      const j = make.join({
        id: fresh('uvj'), left: input, right: pref, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...input.type.cols, meta(P.id, 'any', true), meta(P.props, 'json', true), meta(P.graph, 'text', true)),
        on: and(eq(col(pref.id, P.id), col(input.id, 'id')), eq(col(pref.id, P.graph), graphColOf(input))),
      });
      const KEY = { value: 'ukv', key: 'ukk' } as const;
      const perKey = make.explode({
        id: fresh('uke'), input: j, channels: input.channels, expr: col(j.id, P.props), as: { key: KEY.key, value: KEY.value },
        type: typeOf(...j.type.cols, meta(KEY.key, 'text', true), meta(KEY.value, 'any', true)),
      });
      const wanted = keys && keys.length
        ? make.filter({ id: fresh('ukf'), input: perKey, channels: input.channels, type: perKey.type,
          pred: { kind: 'in-list', expr: col(perKey.id, KEY.key), values: keys.map(compilerText) } })
        : perKey;
      const NODE = 'ukn';
      const nodes = kind === 'edge' ? wanted : make.explode({
        id: fresh('ukx'), input: wanted, channels: input.channels, expr: col(wanted.id, KEY.value), as: { value: NODE },
        type: typeOf(...wanted.type.cols, meta(NODE, 'any', true)),
      });
      const node = kind === 'edge' ? col(wanted.id, KEY.value) : col(nodes.id, NODE);
      return make.project({
        id: fresh('uvv'), input: nodes, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...input.channels.map((c) => meta(c.col, 'int'))),
        exprs: [['v', jsonExtract(node, '$.v')], ['vtype', jsonExtract(node, '$.t')],
          ...input.channels.map((c) => [c.col, col(nodes.id, c.col)] as const)],
      });
    },

    // ---- leaf: reconstitute the wire payload for a terminal merged element, rejoined by (graph, id) ----
    leafPayload(input, kind, opts, fresh) {
      const cte = unifiedCte(kind, fresh);
      const payload = foreignPayloadCols(kind);
      const B = (name: string): string => `ul_${name}`;
      const pref = make.project({
        id: fresh('ulp'), input: cte, channels: [],
        type: typeOf(...payload.map((c) => meta(B(c.name), c.type, c.nullable)), meta(B('graph'), 'text', true)),
        exprs: [...payload.map((c) => [B(c.name), col(cte.id, c.name)] as const), [B('graph'), col(cte.id, 'graph')]],
      });
      const j = make.join({
        id: fresh('ulj'), left: input, right: pref, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...input.type.cols, ...pref.type.cols),
        on: and(eq(col(pref.id, B('id')), col(input.id, 'id')), eq(col(pref.id, B('graph')), graphColOf(input))),
      });
      const bulk = opts.bulk ? input.channels.find((channel) => channel.role === 'bulk') : undefined;
      return make.project({
        id: fresh('ulr'), input: j, channels: [], type: typeOf(...payload, ...(bulk ? [meta('bulk', 'int')] : [])),
        exprs: [
          ...payload.map((c) => [c.name, col(j.id, B(c.name))] as const),
          ...(bulk ? [['bulk', col(j.id, bulk.col)] as const] : []),
        ],
      });
    },
  };
}
