import { col, compilerInt, compilerText, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { Elem } from '../plan/plan.ts';
import { and, eq, meta, typeOf, type Minter } from './build.ts';
import { foreignPayloadCols } from './foreign.ts';
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
    return make.ref({ id: fresh('bref'), name, channels: [], type: typeOf(...foreignPayloadCols(kind)) });
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

    // ---- leaf (Mechanism B): rejoin to reconstitute the wire payload for a terminal bound element ----
    leafPayload(input, kind, _opts, fresh) {
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
      return make.project({
        id: fresh('blr'), input: j, channels: [], type: typeOf(...payload),
        exprs: payload.map((c) => [c.name, col(j.id, B(c.name))] as const),
      });
    },
  };
}
