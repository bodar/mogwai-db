import * as make from '../../rel/factory.ts';
import { col, compilerText, type Expr } from '../../rel/expr.ts';
import { jsonMember, meta, typeOf, type Minter } from '../../compiler/rel/build.ts';
import type { Service, RelCallSite, RelContribution } from '../spi/types.ts';
import type { Rel, Table } from '../../rel/rel.ts';

// ---------- mogwai.schema — reflect the implicit schema as a map stream (pure, Start) ----------
//
// `g.call('mogwai.schema')` reflects a schemaless graph's IMPLICIT schema — the labels, properties
// and edge shapes the data actually holds — as a STREAM of one self-describing map per schema element.
// It is the reflection source the GraphQL front end reads to build SDL/introspection
// (`docs/2026-08-07-graphql-front-end-plan.md` §4), reachable from Gremlin like any other source so the
// GraphQL layer gets no private back door into storage.
//
// ## Why a STREAM of one map per element, not a single document
//
// Decided by the prior art, not preference (root CLAUDE.md's "read the reference" rule). TinkerPop's
// own `Service` contract is stream-native — every `execute` returns a `CloseableIterator<R>` and its
// ONLY shipped meta-service, `--list`/`DirectoryService`, emits one record per service
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/service/{Service,ServiceRegistry}.java`).
// Neo4j — the closest analogue, a property graph whose `CALL` mirrors our `call()` — exposes schema
// through row-per-element procedures (`db.labels()`, `db.propertyKeys()`, and the direct parallel
// `db.schema.nodeTypeProperties()` = one row per (label, property)); its single-document forms
// (`db.schema.visualization()`, `apoc.meta.schema()`) exist only as a secondary, drawing-oriented
// convenience. Calcite codifies the same instinct at the type level — a field IS a `(name, type)`
// `Map.Entry` (`RelDataTypeField`) and `INFORMATION_SCHEMA.COLUMNS` is one row per column. So a stream
// composes with the ordinary map vocabulary (`g.call('mogwai.schema').where(…).groupCount()`), where a
// blob is opaque to every downstream step. An aggregate `visualization`-style document, if ever wanted,
// is a SEPARATE service (or a `with('aggregate', true)`), never the default.
//
// ## The three element kinds, one uniform stream
//
// Each row is a map with a `kind` discriminator so heterogeneous records share one stream — the shape
// `db.schema.nodeTypeProperties` takes:
//
//   - `{ kind: 'vertexLabel', name, count }`      — one per vertex label + how many carry it.
//   - `{ kind: 'property', label, key, type }`    — one per (label, property key), with its Gremlin vtype.
//   - `{ kind: 'edge', label, src, tgt }`         — one per DISTINCT (srcLabel, edgeLabel, tgtLabel) triple.
//
// ## Reflection is a handful of GROUP BYs over the schema tables
//
// `labels`/`vertex_labels`/`vertex_properties`/`edges`/`edge_properties` (`src/storage.ts`). One DO is
// one graph, so this is per-graph and cheap; a write-counter cache is a later optimisation. Every value
// is a stored string/int the compiler holds — nothing binds (root CLAUDE.md's bind rule), so the whole
// stream spends zero of the DO's 100 parameters.

/** A `{t,v}` node whose type is a compile-time TEXT tag — a schema field is a known string/int, so its
 *  tag is a literal and `jsonMember` folds to a single arm (no correlated re-read, the map-side rule). */
const node = (value: Expr, type: 'string' | 'int'): Expr => ({
  kind: 'json-object', entries: [['t', compilerText(type)], ['v', jsonMember(value, compilerText(type))]], binary: false,
});

/** A map ROW's `MAP_COL` — the `[[key, valueNode], …]` pairs array a map-valued relation carries,
 *  built from named `(key, node)` entries in declaration order. `jsonb` for the relational form the map
 *  vocabulary reads (mirrors `injectMap`/`mapOfGroups`); the framer decodes each entry through the one
 *  `{t:'map'}` rule. A bare key STRING is deliberate — `frameTypedNode` reads a non-object member as an
 *  inferred value, exactly the String a map key must be (`recordPairs`' own convention). */
const mapRow = (entries: readonly (readonly [string, Expr])[]): Expr => ({
  kind: 'call', fn: 'jsonb',
  args: [{ kind: 'json-array', items: entries.map(([k, v]) => ({ kind: 'json-array', items: [compilerText(k), v], binary: false })), binary: false }],
});

const MAP_COL = 'map';
/** Project one relation's rows to a single `MAP_COL` holding the given per-row map. */
const asMapRows = (input: Rel, map: Expr, fresh: Minter): Rel =>
  make.project({ id: fresh('smr'), input, channels: [], type: typeOf(meta(MAP_COL, 'json')), exprs: [[MAP_COL, map]] });

/**
 * A table scan whose columns are RENAMED to unique names up front — a `Join` emits both sides'
 * columns POSITIONALLY and REFUSES a duplicate output name (`§3.3`), so the same physical column
 * (`node`, `label`, `id`, `name`) read from two tables in one join tree would collide. Renaming at the
 * scan is the collision-free discipline: every edge-triple join reads three `labels` and two
 * `vertex_labels`, and each gets its own prefix. `cols` maps `physical → output` name; the scan reads
 * the physical columns and the projection emits the output ones.
 */
const scanAs = (
  table: Table, cols: readonly (readonly [physical: string, out: string, type: 'int' | 'text'])[], fresh: Minter,
): Rel => {
  const s = make.scan({ id: fresh('ssc'), table, alias: fresh('rsc'), channels: [], type: typeOf(...cols.map(([p, , t]) => meta(p, t, t === 'text'))) });
  return make.project({
    id: fresh('ssp'), input: s, channels: [], type: typeOf(...cols.map(([, o, t]) => meta(o, t, t === 'text'))),
    exprs: cols.map(([p, o]) => [o, col(s.id, p)] as const),
  });
};

/** An inner join over two collision-free relations, carrying both sides' columns. */
const innerJoin = (left: Rel, right: Rel, on: Expr, fresh: Minter): Rel =>
  make.join({ id: fresh('sj'), left, right, join: 'inner', on, channels: [], type: typeOf(...left.type.cols, ...right.type.cols) });

const eqExpr = (a: Expr, b: Expr): Expr => ({ kind: 'binary', op: '=', left: a, right: b });

/** VERTEX LABELS — one `{kind:'vertexLabel', name, count}` per label that at least one vertex carries.
 *  `vertex_labels` GROUP BY label, joined to `labels` for the name. */
function vertexLabels(fresh: Minter): Rel {
  const vl = scanAs('vertex_labels', [['node', 'vlNode', 'int'], ['label', 'vlLabel', 'int']], fresh);
  // The GROUP KEY is the first type column, its value supplied by `groupBy`; `aggs` lists only the
  // aggregates (never the key again — the type's leading N columns ARE the N group keys, positionally).
  const grouped = make.aggregate({
    id: fresh('svg'), input: vl, channels: [], groupBy: [col(vl.id, 'vlLabel')],
    type: typeOf(meta('vlLabel', 'int'), meta('count', 'int')),
    aggs: [['count', { kind: 'agg', fn: 'count', args: [col(vl.id, 'vlNode')] }]],
  });
  const lbl = scanAs('labels', [['id', 'lId', 'int'], ['name', 'lName', 'text']], fresh);
  const joined = innerJoin(grouped, lbl, eqExpr(col(grouped.id, 'vlLabel'), col(lbl.id, 'lId')), fresh);
  // Collapse the join to ONE relation before the map, so the map builder references a single
  // relation id — the same shape `properties`/`edgeTriples` take through their `Distinct`. Referencing
  // a join's fused CHILD ids from a grandchild project is not in scope; its OUTPUT is.
  const row = make.project({
    id: fresh('vlp'), input: joined, channels: [], type: typeOf(meta('name', 'text'), meta('count', 'int')),
    exprs: [['name', col(joined.id, 'lName')], ['count', col(joined.id, 'count')]],
  });
  return asMapRows(row, mapRow([
    ['kind', node(compilerText('vertexLabel'), 'string')],
    ['name', node(col(row.id, 'name'), 'string')],
    ['count', node(col(row.id, 'count'), 'int')],
  ]), fresh);
}

/** PROPERTIES — one `{kind:'property', label, key, type}` per DISTINCT (label, key, vtype). A property
 *  value's Gremlin type is its stored `vtype`; a NULL vtype (a raw/legacy insert) reports `'unknown'`,
 *  the honest answer for a value whose type the storage class alone decides. */
function properties(fresh: Minter): Rel {
  const vp = scanAs('vertex_properties', [['node', 'vpNode', 'int'], ['key', 'vpKey', 'text'], ['vtype', 'vpType', 'text']], fresh);
  const vl = scanAs('vertex_labels', [['node', 'vlNode', 'int'], ['label', 'vlLabel', 'int']], fresh);
  const lbl = scanAs('labels', [['id', 'lId', 'int'], ['name', 'lName', 'text']], fresh);
  // vp → vl, FLATTENED so the next join reads one relation's columns (the file's discipline — see
  // `edgeTriples`), then → labels for the label name. A parent reads a join's OUTPUT columns through the
  // JOIN's id (its spliced children's ids are not exposed upward — the emitter's join scope rule).
  const vpVl = innerJoin(vp, vl, eqExpr(col(vp.id, 'vpNode'), col(vl.id, 'vlNode')), fresh);
  const onVl = make.project({
    id: fresh('pvj'), input: vpVl,
    channels: [], type: typeOf(meta('vpKey', 'text'), meta('vpType', 'text', true), meta('vlLabel', 'int')),
    exprs: [['vpKey', col(vpVl.id, 'vpKey')], ['vpType', col(vpVl.id, 'vpType')], ['vlLabel', col(vpVl.id, 'vlLabel')]],
  });
  const joined = innerJoin(onVl, lbl, eqExpr(col(onVl.id, 'vlLabel'), col(lbl.id, 'lId')), fresh);
  // DISTINCT (label, key, vtype): the same key on many vertices is ONE schema field. Whole-row distinct
  // over exactly the three columns the map reads, so it is a `Project` of them then `Distinct`.
  const triple = make.project({
    id: fresh('ppp'), input: joined, channels: [], type: typeOf(meta('name', 'text'), meta('key', 'text'), meta('type', 'text')),
    exprs: [['name', col(joined.id, 'lName')], ['key', col(joined.id, 'vpKey')],
      ['type', { kind: 'call', fn: 'COALESCE', args: [col(joined.id, 'vpType'), compilerText('unknown')] }]],
  });
  const distinct = make.distinct({ id: fresh('ppd'), input: triple, channels: [], type: triple.type });
  return asMapRows(distinct, mapRow([
    ['kind', node(compilerText('property'), 'string')],
    ['label', node(col(distinct.id, 'name'), 'string')],
    ['key', node(col(distinct.id, 'key'), 'string')],
    ['type', node(col(distinct.id, 'type'), 'string')],
  ]), fresh);
}

/** EDGE TRIPLES — one `{kind:'edge', label, src, tgt}` per DISTINCT (srcLabel, edgeLabel, tgtLabel). The
 *  edge label is on `edges`; the endpoint labels come from `vertex_labels` on each end. Each of the
 *  three `labels` and two `vertex_labels` scans is renamed (`scanAs`) so the five-way join carries no
 *  duplicate output name. */
function edgeTriples(fresh: Minter): Rel {
  // Resolve each endpoint's label NAME locally first — `vertex_labels` JOIN `labels`, flattened to one
  // relation carrying (node, name) — so the edge join references one id per end, never a deep child.
  // Flattening after each join is the collision-free discipline the whole file follows: a later join's
  // ON reads the immediate input's OWN columns, so no reference reaches through an intermediate that the
  // emitter may have closed into a subquery.
  const endpoint = (nodeOut: string, nameOut: string): Rel => {
    const vl = scanAs('vertex_labels', [['node', 'vNode', 'int'], ['label', 'vLabel', 'int']], fresh);
    const lbl = scanAs('labels', [['id', 'lId', 'int'], ['name', 'lName', 'text']], fresh);
    const j = innerJoin(vl, lbl, eqExpr(col(vl.id, 'vLabel'), col(lbl.id, 'lId')), fresh);
    return make.project({
      id: fresh('ep'), input: j, channels: [], type: typeOf(meta(nodeOut, 'int'), meta(nameOut, 'text')),
      exprs: [[nodeOut, col(j.id, 'vNode')], [nameOut, col(j.id, 'lName')]],
    });
  };
  const e = scanAs('edges', [['src', 'eSrc', 'int'], ['label', 'eLabel', 'int'], ['tgt', 'eTgt', 'int']], fresh);
  const eLbl = scanAs('labels', [['id', 'elId', 'int'], ['name', 'elName', 'text']], fresh);
  const src = endpoint('sNode', 'sName');
  const tgt = endpoint('tNode', 'tName');
  // edge → its label name, then → src endpoint, then → tgt endpoint. Flatten after each join: a parent
  // reads a join's OUTPUT columns through the JOIN's id (its spliced children's ids are not exposed
  // upward), so each step binds its join and projects from `<join>.id` by the output column names.
  const eLblJoin = innerJoin(e, eLbl, eqExpr(col(e.id, 'eLabel'), col(eLbl.id, 'elId')), fresh);
  const withELabel = make.project({
    id: fresh('ewl'), input: eLblJoin,
    channels: [], type: typeOf(meta('eSrc', 'int'), meta('eTgt', 'int'), meta('label', 'text')),
    exprs: [['eSrc', col(eLblJoin.id, 'eSrc')], ['eTgt', col(eLblJoin.id, 'eTgt')], ['label', col(eLblJoin.id, 'elName')]],
  });
  const srcJoin = innerJoin(withELabel, src, eqExpr(col(withELabel.id, 'eSrc'), col(src.id, 'sNode')), fresh);
  const withSrc = make.project({
    id: fresh('ews'), input: srcJoin,
    channels: [], type: typeOf(meta('eTgt', 'int'), meta('label', 'text'), meta('src', 'text')),
    exprs: [['eTgt', col(srcJoin.id, 'eTgt')], ['label', col(srcJoin.id, 'label')], ['src', col(srcJoin.id, 'sName')]],
  });
  const tgtJoin = innerJoin(withSrc, tgt, eqExpr(col(withSrc.id, 'eTgt'), col(tgt.id, 'tNode')), fresh);
  const triple = make.project({
    id: fresh('etp'), input: tgtJoin,
    channels: [], type: typeOf(meta('label', 'text'), meta('src', 'text'), meta('tgt', 'text')),
    exprs: [['label', col(tgtJoin.id, 'label')], ['src', col(tgtJoin.id, 'src')], ['tgt', col(tgtJoin.id, 'tName')]],
  });
  const distinct = make.distinct({ id: fresh('etd'), input: triple, channels: [], type: triple.type });
  return asMapRows(distinct, mapRow([
    ['kind', node(compilerText('edge'), 'string')],
    ['label', node(col(distinct.id, 'label'), 'string')],
    ['src', node(col(distinct.id, 'src'), 'string')],
    ['tgt', node(col(distinct.id, 'tgt'), 'string')],
  ]), fresh);
}

export const schemaService: Service = {
  name: 'mogwai.schema',
  type: 'start',
  describeParams: () => ({}),
  resolve: () => ({
    kind: 'rel',
    buildRel: (c: RelCallSite): RelContribution => ({
      // The three element kinds as one map stream. Each arm is a self-contained relation over the
      // schema tables, UNIONed — the map vocabulary reads a `MAP_COL` and frames each row through the
      // one `{t:'map'}` rule, so the stream is `.where()`/`.groupCount()`/`.fold()`-composable.
      kind: 'relation',
      rel: make.union({ id: c.fresh('smu'), all: true, inputs: [vertexLabels(c.fresh), properties(c.fresh), edgeTriples(c.fresh)], channels: [], type: typeOf(meta(MAP_COL, 'json')) }),
      framing: { kind: 'map', keyOf: { kind: 'scalar' }, valOf: { kind: 'scalar' } },
    }),
  }),
};
