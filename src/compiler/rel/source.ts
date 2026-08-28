import { col, compilerInt, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Binding } from '../../rel/plan.ts';
import { arg, type Arg } from '../../gremlin/frontend.ts';
import type { Elem } from '../elem.ts';
import { constLit } from './const.ts';
import { edgeLabel, elementNode, elementObject, elementPayload, externalId as elementExternalId, vertexLabels } from './element.ts';
import { storedCompareOn } from './predicate.ts';
import { propertyRelation } from './property.ts';
import { and, carriedCols, EDGE_COLS, elementCols, eq, firstOf, jsonEachSet, JSON_NUMERIC_TYPES, JSON_TEXT_TYPES, jsonOf, keyMembership, labelIds, meta, NODE_COLS, PROPERTIES, renumber, storedValue, typedNode, typeOf, VALUEMAP_PAIR, type Minter } from './build.ts';

// ---------- GraphSource: one traversal vocabulary over two physical graph shapes ----------
//
// The traversal ALGEBRA (`movement`, `values`, `has`, `hasLabel`, `label`, `id`, `V()`/`E()`) is a
// vocabulary written against a graph's LOGICAL operations. It historically read the BASE graph's
// physical SQLite schema (`nodes`/`edges`/`vertex_properties`/`labels`) inline, so an INJECTED graph
// (a federate subgraph, an `io()`/`subgraph()` import) — which arrives in a different physical shape
// (properties as an inline JSON `{t,v}` tree, labels as JSON name arrays, edge labels as name
// strings) — needed a SECOND hand-written vocabulary over the JSON (`foreign.ts`). That is the smell
// this interface retires: the physical access becomes an ABSTRACTION, so one vocabulary flows over
// either shape.
//
// `GraphSource` is what the algebra reads a graph THROUGH. It exposes the LOGICAL operations; each
// implementation emits its own physical SQL. `BaseGraph` (below) is the SQLite tables; `BoundGraph`
// (`foreign.ts`, folded in later) is the landed CTEs/JSON. The vocabulary threads a `GraphSource` on
// `ChainCtx` (default `BaseGraph`); a subgraph segment sets `BoundGraph`.
//
// **Load-bearing boundary decision — labels stay a PREDICATE the source supplies, never a forced
// name.** The base `edges.label` is an interned INT id inside the `e_out(src,label,tgt)` /
// `e_in(tgt,label,src)` covering indexes; forcing labels to names everywhere would add a `labels`
// join to every hop and deoptimise the base. So `edgeLabelMatch` returns the id-set subquery on the
// indexed column for `BaseGraph` (movement's seek is UNCHANGED) and `label IN (names)` for
// `BoundGraph`. The movement JOIN STRUCTURE stays in the vocabulary; only the edge relation + the
// label predicate come from the source.
//
// **Channels are orthogonal — they live on the STREAM, not the graph.** `bulk`/`encounter`/`path` are
// traverser facts the vocabulary threads; `GraphSource` abstracts only the PHYSICAL ROWS. So once the
// vocabulary is source-parameterised the bound graph GAINS collapse/path/order for free.

/** The interface the traversal algebra reads a graph through. Grows one method per rerouted chokepoint
 *  (movement first); each method is a LOGICAL operation whose physical SQL the implementation owns. */
export interface GraphSource {
  /** The edge RELATION a hop joins — the frontier ⋈ edges probe. `BaseGraph` scans the `edges` table
   *  (`id`/`src`/`label`/`tgt`); a landed graph projects its bound-edges CTE to the same logical
   *  columns. The JOIN structure and `ordered` seek stay in `movement`; only this relation comes from
   *  the source. */
  adjacencyEdges(fresh: Minter): Rel;

  /** The label restriction on a hop's edge, as a predicate over `labelCol` (the edge relation's label
   *  column). `labels` is the pre-validated NON-EMPTY label-arg set (movement owns the empty / all-null
   *  cases). `BaseGraph` returns the id-set subquery over the `labels` table on the indexed INT column;
   *  a landed graph returns `label IN (names)` over its name-string column — which is why the boundary
   *  is a predicate, not a shared representation. */
  edgeLabelMatch(labelCol: Expr, labels: readonly Arg[], fresh: Minter): Expr;

  /** `values(keys…)` — one traverser PER matching property VALUE off an element relation, as a
   *  relation carrying `(v, vtype)` plus the input's channels (a JOIN, so the multiset multiplies).
   *  `keys` is `null` for EVERY key and a name list otherwise (`keyMembership`'s distinction). The
   *  value's Gremlin type is PER ROW off `vtype`, so the CALLER wraps `PER_ROW('vtype')` framing —
   *  the source owns the ROWS, the vocabulary the framing. `BaseGraph` joins `vertex_properties` /
   *  `edge_properties`; a landed graph explodes the inline `{t,v}` tree. */
  propertyValues(input: Rel, kind: Elem, keys: readonly string[] | null, fresh: Minter): Rel;

  /** `V(…)`/`E(…)` — the element SOURCE: one row per element at bulk 1, narrowed by an id list bounded
   *  by the QUERY TEXT (`args`). Returns the physical scan plus the id predicate (or none for the whole
   *  graph); `null` where an id is a shape the source cannot narrow by. `BaseGraph` scans `nodes`/`edges`
   *  and matches numeric ids on the rowid, string ids on the `uid` (a bound collection as one
   *  `jsonb(?)` exploded by `json_each`); a landed graph scans its bound CTE and filters its single
   *  `id` column. The caller derives the element KIND from the step name. */
  elementScan(kind: Elem, args: readonly Arg[], fresh: Minter): { scan: Rel; pred?: Expr } | null;

  /** `hasLabel(names…)` (and the label half of `has(label, k, v)`), as a predicate CORRELATED on the
   *  element `id`. `labels` is the pre-validated NON-EMPTY label-arg set (the caller owns the null /
   *  all-null / empty cases). `labelCol` is the edge's inline label column when the physical row is in
   *  scope (the source position), letting `BaseGraph` read the covering index directly instead of a
   *  correlated id-membership subquery. `BaseGraph` resolves names→ids through `labels` and tests the
   *  side tables (`edges.label` / `vertex_labels`); a landed graph tests membership of its JSON label
   *  array. */
  hasLabelPredicate(kind: Elem, id: Expr, labelCol: Expr | undefined, labels: readonly Arg[], fresh: Minter): Expr;

  /** `has(key[, value-or-predicate])` over a stored property, as a predicate CORRELATED on the element
   *  `id` — an EXISTS, because a property FILTER asks whether a row is there (a JOIN would multiply the
   *  traverser once per matching property). `valuePred` is the vocabulary's value comparison: the source
   *  hands it the graph's own value + vtype expressions (so the Gremlin `P` semantics live in the
   *  caller while the physical columns stay the source's), and it returns the comparison Expr, or `null`
   *  where the predicate could not be built (which declines the whole clause). `valuePred` is `undefined`
   *  for a bare `has(key)` presence test. The `BaseGraph` EXISTS shape is what `semijoin.ts`'s
   *  `indexSeek`/`trigramSeek` recognise, so it is preserved exactly. */
  hasPropertyPredicate(
    kind: Elem, id: Expr, key: string,
    valuePred: ((value: Expr, vtype: Expr) => Expr | null) | undefined, fresh: Minter,
  ): Expr | null;

  /** `has(T.id, …)` / `has(T.label, …)` — a TOKEN key, which reads the element itself rather than a
   *  property row, CORRELATED on the element `id` as an EXISTS. `T.id` is the EXTERNAL id
   *  (`COALESCE(uid, id)`); `T.label` is ANY label (a multi-label vertex matches on any). The value
   *  comparison is the vocabulary's callback, handed the token EXPRESSION (the external id, or the label
   *  name) so the caller owns the `P` semantics; `null` from it declines. `BaseGraph` reads
   *  `nodes`/`edges` and the `labels` side tables; a landed graph reads its landed id / JSON label
   *  array. */
  hasTokenPredicate(
    kind: Elem, id: Expr, token: 'id' | 'label',
    valuePred: (tokenExpr: Expr) => Expr | null, fresh: Minter,
  ): Expr | null;

  /** `id()` / `label()` as SCALAR reads over an element relation. `externalId` is `COALESCE(uid, id)`
   *  for `BaseGraph` (the id a client sees) and the landed id for a bound graph (already external);
   *  `labelScalar` is the element's label — one indirection into the `labels` side tables for the base,
   *  a rejoin of the landed label array/name for a bound graph. Both are CORRELATED on the element `id`.
   *  Reached through the shared `by()` token machinery, so they compose in `label()`/`by(T.label)`/
   *  `group().by(id)` alike. */
  externalId(kind: Elem, id: Expr, fresh: Minter): Expr;
  labelScalar(kind: Elem, id: Expr, fresh: Minter): Expr;

  /** `by('key')` — the FIRST value of a property, as a scalar CORRELATED on the element `id`. A vertex
   *  key may hold several values; INSERTION ORDER names the first (`PropertyValueStep`). `ordering`
   *  wraps the value in the vtype-aware compare (`order().by('age')` sorts a decimal-TEXT number
   *  numerically). `BaseGraph` reads `vertex_properties`/`edge_properties`; a bound graph reads the
   *  first `{t,v}` node at the key in the landed tree. Reached through `byExpr`'s property arm, so it
   *  composes in `group().by(k)`/`order().by(k)`/`project().by(k)` over either graph. */
  propertyScalar(kind: Elem, id: Expr, key: string, ordering: boolean, fresh: Minter): Expr;

  /** `valueMap(keys…)` / `elementMap()` — one row per property KEY of the element at `id`, carrying the
   *  key name, the ordered ARRAY of its `{t,v}` value nodes, and a per-key ordinal (`VALUEMAP_PAIR`).
   *  Correlated on `id`. `BaseGraph` groups `vertex_properties`/`edge_properties` by key; a bound graph
   *  explodes the landed `{t,v}` tree. The caller (`elementValueMap`) shapes these into the map entries
   *  (list-vs-flat, tokens), so only the physical read differs by source. */
  valueMapPairs(kind: Elem, id: Expr, keys: readonly string[] | null, fresh: Minter): Rel;

  /** `properties(keys…)` — the PROPERTY-ROW stream off an element relation (one traverser per matching
   *  property), in the `PROP`-prefixed shape `propertyPayload`/`propertyValue`/`propertyKey` read.
   *  `BaseGraph` joins `vertex_properties`/`edge_properties`; a bound graph explodes the landed `{t,v}`
   *  tree (with a NULL `p_id`/`p_meta` — no landed VertexProperty identity, so the caller declines
   *  `properties().id()` and meta reads over a bound element). */
  propertyStream(input: Rel, kind: Elem, keys: readonly string[] | null, fresh: Minter): Rel;

  /** `labels()` — the FAN-OUT of an element's labels, one row per label. Returns a relation carrying `v`
   *  (the label name) and `lord` (the per-element order key the caller renumbers by — the label-dictionary
   *  id for `BaseGraph`, the JSON-array index for a bound graph) plus the input's channels. The emission
   *  ORDER (the `encounter` mint) is the caller's, since it is a STREAM fact; the source owns only the
   *  physical rows and their per-element order key. `BaseGraph` joins the `vertex_labels`/`labels` (or
   *  `edges`/`labels`) side tables; a bound graph explodes the landed JSON label array. */
  labelNames(input: Rel, kind: Elem, fresh: Minter): Rel;

  /** The external id read DIRECTLY off an anchor row (`elementRow`), reusing its own columns rather than
   *  re-correlating on an id — the element's own `T.id` token value, kept off the shared scan so
   *  `valueMap(true)`/`elementMap()` do not re-scan the element once per token. `BaseGraph` is
   *  `COALESCE(uid, id)`; a bound row's `id` is already the external id. (An ENDPOINT id, which arrives as
   *  a bare `tgt`/`src` column and not a row, still uses the correlated `externalId`.) */
  externalIdOf(row: Rel): Expr;

  /** An edge's label read DIRECTLY off an anchor row — the edge's `T.label` token, off the row's own
   *  `label` column rather than a re-scan. `BaseGraph` resolves the FK through `labels`; a bound row
   *  carries the bare name. */
  edgeLabelOf(row: Rel, fresh: Minter): Expr;

  /** THE ONE CORRELATED ROW an element id names — the single-row anchor `valueMap(true)`/`elementMap()`
   *  project their `T.id`/`T.label`/endpoint token pairs off (`tokenRow`/`endpointRow`). `BaseGraph`
   *  scans `nodes`/`edges` filtered by rowid; a bound graph rejoins the landed relation by id. The token
   *  VALUES themselves come from `externalId`/`labelScalar`/`labelArray` (self-correlated), so the only
   *  columns a caller reads off this row are an edge's `src`/`tgt` endpoints — present on both graphs. */
  elementRow(kind: Elem, id: Expr, fresh: Minter): Rel;

  /** Does this element have AT LEAST ONE label — the zero-label gate that omits a `single`-regime
   *  `T.label` entry for a label-less vertex. Cheap BY DESIGN (an EXISTS probe / an array-length test),
   *  NOT the whole label array: it is a filter, not a value. `BaseGraph` probes the `vertex_labels` side
   *  table; a bound graph tests the landed array's length. */
  hasAnyLabel(kind: Elem, id: Expr, fresh: Minter): Expr;

  /** AN ELEMENT'S LABELS as a JSON ARRAY of names, correlated on `id` — the `set`-regime `T.label` token
   *  value, and (via `json_array_length`) the zero-label gate that omits the token for a label-less vertex
   *  in the `single` regime. `BaseGraph` groups the `vertex_labels`/`labels` side tables (or wraps the one
   *  edge name); a bound graph reads the landed JSON label array (or wraps the one landed edge name). */
  labelArray(kind: Elem, id: Expr, fresh: Minter): Expr;

  /** A PATH POSITION — one element in a `path()` array, as the self-describing `{t, v: payload}` node
   *  `pathPositions` appends, a SCALAR correlated on the position's id. `BaseGraph` reads the base tables
   *  by rowid (`elementNode`); a bound graph REJOINS the landed relation by id to reconstitute the same
   *  node (Mechanism B, the leaf's per-position twin). The id arrives as the raw `json_extract($.v)` off
   *  the stored path entry — an INT rowid for the base, a possibly-string external id for a bound graph —
   *  so neither side casts it. */
  elementNode(kind: Elem, id: Expr, fresh: Minter): Expr;

  /** AN ELEMENT AS A BARE PAYLOAD OBJECT — `{id, label, props[, src, tgt]}` with NO `{t,v}` envelope,
   *  correlated on an id. `elementNode`'s twin (the two serve different framers — see `element.ts`): this
   *  targets the top-level `listItemBuffers` `elem` arm (`execute.ts`), which maps `rowVertex`/`rowEdge`
   *  straight over bare objects. `BaseGraph` reads the base tables by rowid (`elementObject`); a bound
   *  graph REJOINS the landed relation by id to reconstitute the same object. */
  elementObject(kind: Elem, id: Expr, fresh: Minter): Expr;

  /** THE LEAF FRAMING — a terminal element relation → the wire PAYLOAD tuple (id, label, props[, src,
   *  tgt]). `BaseGraph` reads `nodes`/`edges`/`vertex_properties`/`labels` by id (`elementPayload`); a
   *  bound graph REJOINS the landed relation by id to reconstitute the detached payload (Mechanism B).
   *  The `bulk` option carries a surviving multiplicity column for a collapsed base stream (a bound
   *  stream carries none). */
  leafPayload(input: Rel, kind: Elem, opts: { readonly bulk: boolean; readonly detached: boolean }, fresh: Minter): Rel;

  /** THE PLAN BINDINGS this source needs declared in every statement that reads through it — a
   *  `decorateGraph` layer's landed `(id → value)` CTE, one per stacked OLAP algorithm. Collected ONCE
   *  at `lowered()` and prepended to the chain's effects, so a source that carries state declares it
   *  itself rather than every entry point remembering to. `BaseGraph`/`BoundGraph` carry none (the
   *  method is absent). A STACK returns the whole stack's bindings (base first), each under a
   *  `run`-derived name so the same statement can hold several and two independent lowerings that both
   *  read a layer agree on its CTE name. */
  bindings?(fresh: Minter): readonly Binding[];
}

/** THE BASE GRAPH — the SQLite physical schema. Every method is the CURRENT inline SQL the traversal
 *  algebra used to spell, moved behind the interface so the vocabulary no longer names a table. */
export const BaseGraph: GraphSource = {
  adjacencyEdges: (fresh) => make.scan({
    id: fresh('mv'), table: 'edges', alias: fresh('rme'), channels: [],
    type: typeOf(meta('id', 'int'), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')),
  }),

  edgeLabelMatch: (labelCol, labels, fresh) =>
    ({ kind: 'in-query', expr: labelCol, plan: labelIds(labels, fresh), negated: false }),

  propertyValues: (input, kind, keys, fresh) => {
    const { table, owner } = PROPERTIES[kind];
    // The property ROW id (`vertex_properties.id` — an INTEGER PRIMARY KEY assigned at write time) is
    // the multi-valued FAN-OUT's insertion order, which is the order a Vertex `PropertyValueStep`
    // iterates (TinkerPop stores a key's values in an insertion-ordered set). Carried as `pord` so the
    // `values` step can refine the arriving `encounter` by it — see `lower.ts`. When no encounter is
    // arriving the assembler fuses this projection away, so an ordinary `values()` is byte-unchanged.
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), meta('id', 'int')),
    });
    // A JOIN, not an EXISTS: `values()` emits one traverser PER matching property, so multiplying the
    // row is the answer. `ordered` so the stream drives and `vp_node_key(node,key)` is probed rather
    // than the planner leading with a whole-graph `key=?` scan. `pord` maps positionally to the props
    // scan's last column (`id`) — the emitter's join select is `[left…, right…]` by position.
    const joined = make.join({
      id: fresh('j'), left: input, right: props, join: 'inner', ordered: true, channels: input.channels,
      type: typeOf(...elementCols(input.channels), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true), meta('pord', 'int')),
      on: and(eq(col(props.id, owner), col(input.id, 'id')), keyMembership(col(props.id, 'key'), keys)),
    });
    const base = make.project({
      id: fresh('sv'), input: joined, channels: input.channels,
      type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), meta('pord', 'int'), ...carriedCols(input.channels)),
      exprs: [['v', storedValue(joined.id)], ['vtype', col(joined.id, 'vtype')], ['pord', col(joined.id, 'pord')],
        ...input.channels.map((channel) => [channel.col, col(joined.id, channel.col)] as const)],
    });
    // REFINE the emission order: within one parent (its arriving `encounter`) the fan-out is ordered by
    // `pord` (property insertion order). Without this, a multi-valued `values(k).fold()` collects in the
    // scan's order — right by luck, reversed under `mise run test:perturbed`. Only where an encounter is
    // ALREADY live (the chain demands one): a bare `values()` with no order demand keeps `pord` unread
    // and the fusion drops it, so its SQL does not change.
    const arriving = input.channels.find((channel) => channel.role === 'encounter');
    if (!arriving) {
      return make.project({
        id: fresh('sv'), input: base, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)),
        exprs: [['v', col(base.id, 'v')], ['vtype', col(base.id, 'vtype')],
          ...input.channels.map((channel) => [channel.col, col(base.id, channel.col)] as const)],
      });
    }
    return renumber(
      base,
      [{ expr: col(base.id, arriving.col), dir: 'asc' }, { expr: col(base.id, 'pord'), dir: 'asc' }],
      [meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)],
      input.channels, fresh,
    );
  },

  elementScan: (kind, args, fresh) => {
    // A `r`-prefixed alias, so a RelIR scan can never SHADOW one of the framing layer's (`n`/`e`/`p`/
    // `s`/`v`/`g`/`j`/`l`). The plan is spliced in as a derived table, so shadowing would be legal SQL
    // and silently resolve an outer correlation to the inner table.
    const scan = make.scan({
      id: fresh('src'), table: kind === 'edge' ? 'edges' : 'nodes', alias: kind === 'edge' ? 're' : 'rn', channels: [],
      type: typeOf(...(kind === 'edge' ? EDGE_COLS : NODE_COLS)),
    });

    // Ids span two provenances and two columns. PROVENANCE decides bind-vs-inline: a parsed LITERAL id
    // is a constant bounded by the QUERY TEXT and INLINES (a rowid `int`, a uid `text`); a wire
    // PARAMETER (`V($x)`) BINDS, so its value never enters the statement text — a scalar as one `?`, a
    // bound collection (`V($ids)`) as ONE `jsonb(?)` exploded by `json_each`. COLUMN follows the value's
    // type: a number matches the rowid `id`, a string the `uid`.
    const idCol = col(scan.id, 'id');
    const uidCol = col(scan.id, 'uid');
    const inlineNums: number[] = [];
    const inlineStrs: string[] = [];
    const paramClauses: Expr[] = [];
    const inlineOne = (v: unknown): boolean => {
      if (typeof v === 'number') { inlineNums.push(v); return true; }
      if (typeof v === 'string') { inlineStrs.push(v); return true; }
      return false; // an id that is neither declines — a hard error, not a value this route can inline
    };
    for (const a of args) {
      if (a.name == null) {
        // A CONSTANT — a bare scalar id or a bracketed list literal (`V(1, [2,3])` ≡ `V(1,2,3)`); the
        // grammar forbids a param member, so every member is itself a literal that inlines.
        const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
        for (const v of members) if (!inlineOne(v)) return null;
      } else if (Array.isArray(a.value)) {
        // A bound COLLECTION of ids → ONE `jsonb(?)` bind, exploded and routed per member by its json
        // type. The two clauses share the parameter NAME, so the render dedups them to a single bind.
        paramClauses.push({ kind: 'in-query', expr: idCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_NUMERIC_TYPES), negated: false });
        paramClauses.push({ kind: 'in-query', expr: uidCol, plan: jsonEachSet(a.name, a.value, fresh, JSON_TEXT_TYPES), negated: false });
      } else if (typeof a.value === 'number') {
        paramClauses.push(eq(idCol, param(a.value, a.name)));
      } else if (typeof a.value === 'string') {
        paramClauses.push(eq(uidCol, param(a.value, a.name, 'text')));
      } else return null; // a bound id of another shape declines, as its inline sibling does
    }

    // Inline lists first so a param-free `V(...)` renders byte-for-byte as before; `constLit` never
    // declines a number/string, so its assertion cannot fire.
    const clauses: Expr[] = [];
    if (inlineNums.length) clauses.push({ kind: 'in-list', expr: idCol, values: inlineNums.map((n) => constLit(arg(n, 'long'))!) });
    if (inlineStrs.length) clauses.push({ kind: 'in-list', expr: uidCol, values: inlineStrs.map((s) => compilerText(s)) });
    clauses.push(...paramClauses);
    const pred = clauses.reduce<Expr | undefined>((left, right) =>
      left ? { kind: 'binary', op: 'or', left, right } : right, undefined);
    return { scan, pred };
  },

  hasLabelPredicate: (kind, id, labelCol, labels, fresh) => {
    const ids = labelIds(labels, fresh);
    if (kind === 'edge') {
      // Direct where the column is physically present (the source scan), and a membership test on the
      // edge id where it is not (after a movement, the relation is `id` + channels). Same question, and
      // the first form keeps the covering-index read the source position deserves.
      if (labelCol) return { kind: 'in-query', expr: labelCol, plan: ids, negated: false };
      const e = make.scan({ id: fresh('el'), table: 'edges', alias: fresh('rel'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
      const matching = make.filter({ id: fresh('f'), input: e, channels: [], type: e.type, pred: { kind: 'in-query', expr: col(e.id, 'label'), plan: ids, negated: false } });
      const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
      return { kind: 'in-query', expr: id, plan: owners, negated: false };
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const matching = make.filter({ id: fresh('f'), input: vl, channels: [], type: vl.type, pred: { kind: 'in-query', expr: col(vl.id, 'label'), plan: ids, negated: false } });
    const owners = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('node', 'int')), exprs: [['node', col(matching.id, 'node')]] });
    return { kind: 'in-query', expr: id, plan: owners, negated: false };
  },

  hasPropertyPredicate: (kind, id, key, valuePred, fresh) => {
    const { table, owner } = PROPERTIES[kind];
    const props = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    // The property row's own `vtype` is in scope here, so an ordering comparison gets the vtype-aware
    // key — the whole reason the value predicate is a callback the caller supplies.
    const matches = valuePred ? valuePred(col(props.id, 'value'), col(props.id, 'vtype')) : undefined;
    if (valuePred && !matches) return null;
    const base = and(eq(col(props.id, owner), id), eq(col(props.id, 'key'), compilerText(key)));
    const matching = make.filter({
      id: fresh('f'), input: props, channels: [], type: props.type,
      pred: matches ? and(base, matches) : base,
    });
    const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return { kind: 'exists', plan: probe, negated: false };
  },

  hasTokenPredicate: (kind, id, token, valuePred, fresh) => {
    if (token === 'id') {
      const cols = kind === 'edge' ? EDGE_COLS : NODE_COLS;
      const scan = make.scan({ id: fresh('ti'), table: kind === 'edge' ? 'edges' : 'nodes', alias: fresh('rti'), channels: [], type: typeOf(...cols) });
      const external: Expr = { kind: 'call', fn: 'COALESCE', args: [col(scan.id, 'uid'), col(scan.id, 'id')] };
      const matches = valuePred(external);
      if (!matches) return null;
      const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: and(eq(col(scan.id, 'id'), id), matches) });
      const probe = make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
      return { kind: 'exists', plan: probe, negated: false };
    }
    const labels = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
    const matches = valuePred(col(labels.id, 'name'));
    if (!matches) return null;
    if (kind === 'edge') {
      // An edge's label is a COLUMN, so the join is against the correlated edge row.
      const edges = make.scan({ id: fresh('eg'), table: 'edges', alias: fresh('re'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
      const joined = make.join({
        id: fresh('j'), left: edges, right: labels, join: 'inner', channels: [],
        type: typeOf(meta('id', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
        on: and(and(eq(col(edges.id, 'label'), col(labels.id, 'id')), eq(col(edges.id, 'id'), id)), matches),
      });
      const probe = make.project({ id: fresh('p'), input: joined, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
      return { kind: 'exists', plan: probe, negated: false };
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const joined = make.join({
      id: fresh('j'), left: vl, right: labels, join: 'inner', channels: [],
      type: typeOf(meta('node', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
      on: and(and(eq(col(vl.id, 'label'), col(labels.id, 'id')), eq(col(vl.id, 'node'), id)), matches),
    });
    const probe = make.project({ id: fresh('p'), input: joined, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return { kind: 'exists', plan: probe, negated: false };
  },

  // The COMPACT correlated external id (`nodeExternalId`/the edge scalar) — an id is unique, so the
  // `firstOf` order/limit would be a no-op. Shared with the endpoint token reads through the interface.
  externalId: (kind, id, fresh) => elementExternalId(id, kind, fresh),

  labelScalar: (kind, id, fresh) => {
    const labels = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
    if (kind === 'edge') {
      const edges = make.scan({ id: fresh('eg'), table: 'edges', alias: fresh('re'), channels: [], type: typeOf(...EDGE_COLS) });
      const joined = make.join({
        id: fresh('j'), left: edges, right: labels, join: 'inner', channels: [],
        type: typeOf(...EDGE_COLS, meta('lid', 'int'), meta('name', 'text')),
        on: and(eq(col(edges.id, 'label'), col(labels.id, 'id')), eq(col(edges.id, 'id'), id)),
      });
      return firstOf(joined, col(joined.id, 'name'), col(joined.id, 'lid'), fresh);
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const joined = make.join({
      id: fresh('j'), left: vl, right: labels, join: 'inner', channels: [],
      type: typeOf(meta('node', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
      on: and(eq(col(vl.id, 'label'), col(labels.id, 'id')), eq(col(vl.id, 'node'), id)),
    });
    return firstOf(joined, col(joined.id, 'name'), col(joined.id, 'label'), fresh);
  },

  labelNames: (input, kind, fresh) => {
    const names = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
    // A vertex holds its labels in the `vertex_labels` side table; an edge inlines the FK on the row.
    const owned = kind === 'edge'
      ? (() => {
        const e = make.scan({ id: fresh('el'), table: 'edges', alias: fresh('re'), channels: [], type: typeOf(meta('id', 'int'), meta('label', 'int')) });
        return make.join({
          id: fresh('j'), left: input, right: e, join: 'inner', ordered: true, channels: input.channels,
          type: typeOf(...elementCols(input.channels), meta('eid', 'int'), meta('label', 'int')),
          on: eq(col(e.id, 'id'), col(input.id, 'id')),
        });
      })()
      : (() => {
        const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
        return make.join({
          id: fresh('j'), left: input, right: vl, join: 'inner', ordered: true, channels: input.channels,
          type: typeOf(...elementCols(input.channels), meta('node', 'int'), meta('label', 'int')),
          on: eq(col(vl.id, 'node'), col(input.id, 'id')),
        });
      })();
    // `lid` and not a second `id`: a Join's declared names are POSITIONAL and must be unique.
    const named = make.join({
      id: fresh('j'), left: owned, right: names, join: 'inner', ordered: true, channels: owned.channels,
      type: typeOf(...owned.type.cols, meta('lid', 'int'), meta('name', 'text')),
      on: eq(col(names.id, 'id'), col(owned.id, 'label')),
    });
    // `lord` is the label-dictionary id (`vertex_labels.label` / `edges.label`), the interning order the
    // element payload's `json_group_array(name ORDER BY lid)` and `by(T.label)`'s first-label pick use —
    // so a vertex's labels read identically wherever they are read. The caller mints the emission order.
    return make.project({
      id: fresh('lv'), input: named, channels: named.channels,
      type: typeOf(meta('v', 'text'), meta('lord', 'int'), ...carriedCols(named.channels)),
      exprs: [['v', col(named.id, 'name')], ['lord', col(named.id, 'label')],
        ...named.channels.map((channel) => [channel.col, col(named.id, channel.col)] as const)],
    });
  },

  propertyScalar: (kind, id, key, ordering, fresh) => {
    // A property scan declaring `id` as well as the payload: a VERTEX key may hold several values and
    // INSERTION ORDER (the rowid) names the first — `PropertyValueStep`'s semantics.
    const { table, owner } = PROPERTIES[kind];
    const scan = make.scan({
      id: fresh('vp'), table, alias: fresh('rp'), channels: [],
      type: typeOf(meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    const mine = make.filter({
      id: fresh('f'), input: scan, channels: [], type: scan.type,
      pred: and(eq(col(scan.id, owner), id), eq(col(scan.id, 'key'), compilerText(key))),
    });
    const value = ordering ? storedCompareOn(col(mine.id, 'vtype'))(col(mine.id, 'value')) : col(mine.id, 'value');
    return firstOf(mine, value, col(mine.id, 'id'), fresh);
  },

  valueMapPairs: (kind, id, keys, fresh) => {
    const { table, owner } = PROPERTIES[kind];
    const props = make.scan({
      id: fresh('vm'), table, alias: fresh('rvm'), channels: [],
      type: typeOf(meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
    });
    const mine = make.filter({
      id: fresh('vf'), input: props, channels: [], type: props.type,
      pred: and(eq(col(props.id, owner), id), keyMembership(col(props.id, 'key'), keys)),
    });
    // The key's values as an ordered array of `{t,v}` nodes (insertion order = rowid), and the key's
    // ordinal as the earliest rowid — the shape `elementValueMap` turns into a list value or takes the
    // last of for a flat map.
    const values: Expr = { kind: 'agg', fn: 'json_group_array', args: [jsonOf(typedNode(col(mine.id, 'value'), col(mine.id, 'vtype')))], orderBy: [{ expr: col(mine.id, 'id'), dir: 'asc' }] };
    return make.aggregate({
      id: fresh('vk'), input: mine, channels: [],
      type: typeOf(meta(VALUEMAP_PAIR.key, 'text'), meta(VALUEMAP_PAIR.values, 'json'), meta(VALUEMAP_PAIR.ord, 'int')),
      groupBy: [col(mine.id, 'key')],
      aggs: [[VALUEMAP_PAIR.values, values], [VALUEMAP_PAIR.ord, { kind: 'agg', fn: 'min', args: [col(mine.id, 'id')] }]],
    });
  },

  propertyStream: (input, kind, keys, fresh) => propertyRelation(input, kind, keys, fresh),

  externalIdOf: (row) => ({ kind: 'call', fn: 'COALESCE', args: [col(row.id, 'uid'), col(row.id, 'id')] }),

  edgeLabelOf: (row, fresh) => edgeLabel(col(row.id, 'label'), fresh),

  elementRow: (kind, id, fresh) => {
    const cols = kind === 'edge' ? EDGE_COLS : NODE_COLS;
    const scan = make.scan({ id: fresh('er'), table: kind === 'edge' ? 'edges' : 'nodes', alias: fresh('rer'), channels: [], type: typeOf(...cols) });
    return make.filter({ id: fresh('ef'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'id'), id) });
  },

  hasAnyLabel: (_kind, id, fresh) => {
    // vertex only in practice; mirror the old `labelled` EXISTS probe exactly so the gate stays cheap.
    const vl = make.scan({ id: fresh('lx'), table: 'vertex_labels', alias: fresh('rlx'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const mine = make.filter({ id: fresh('lf'), input: vl, channels: [], type: vl.type, pred: eq(col(vl.id, 'node'), id) });
    const probe = make.project({ id: fresh('lp'), input: mine, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] });
    return { kind: 'exists', plan: probe, negated: false };
  },

  // Always called for a VERTEX (a set-regime `T.label`, or the zero-label gate); the edge arm is for
  // totality — an edge is single-label, so its "array" is the one name.
  labelArray: (kind, id, fresh) => kind === 'vertex'
    ? vertexLabels(id, fresh)
    : { kind: 'call', fn: 'json_array', args: [BaseGraph.labelScalar('edge', id, fresh)] },

  // A path position IS the base element node — `elementNode` already builds the `{t,v}` scalar over the
  // physical tables, so the source method is that call with the vocabulary's argument order.
  elementNode: (kind, id, fresh) => elementNode(id, kind, fresh),

  elementObject: (kind, id, fresh) => elementObject(id, kind, fresh),

  leafPayload: (input, kind, opts, fresh) => elementPayload(input, kind, opts, fresh),
};
