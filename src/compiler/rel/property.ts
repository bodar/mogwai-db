import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta, RelId } from '../../rel/types.ts';
import { and, byEncounter, carriedCols, eq, jsonOf, meta, PROPERTIES, storedValueOn, typeOf, type Minter } from './build.ts';
import { PER_ROW, STATIC } from '../../sql/kernel/render.ts';
import type { RelFraming } from './framing.ts';
import type { Elem } from '../plan/plan.ts';

// ---------- the PROPERTY shape: a traverser that IS a property, not its value ----------
//
// `values('name')` yields the VALUE; `properties('name')` yields the property ITSELF — a
// VertexProperty on a vertex, a Property on an edge — which has its own id, its own key, and (on a
// vertex) its own meta-properties. That distinction is TinkerPop's, not ours: a VertexProperty is an
// Element and a Property is not, which is the entire reason `vpid`/`pmeta` are null on the edge side.
//
// The relation and the WIRE PROJECTION are separate on purpose, and it is the same split every other
// shape here makes: `propertyRelation` produces rows the fold can keep operating on (filters, slices,
// and later `element()`/`key()`/`value()` re-types), while `propertyPayload` is the last act that
// turns them into the columns `execute.ts` frames. Merging the two is what would force the payload's
// correlated subqueries to be computed for rows a later filter throws away.

/** The physical property columns a `propertyRelation` carries, beside the input's channels. `meta` is
 *  VERTEX-ONLY — `edge_properties` has no such column, because an edge Property cannot have
 *  meta-properties in the first place (schema-storage: normalize where cardinality is 0..N, keep
 *  inline where it is exactly 1). The edge arm therefore projects a NULL rather than reading one. */
const propCols = (owner: string, hasMeta: boolean): readonly ColMeta[] => [
  meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'),
  meta('value', 'any', true), meta('vtype', 'text', true),
  ...(hasMeta ? [meta('meta', 'json', true)] : []),
];

/** The property columns are PREFIXED in the join's output type, for the reason `elementPayload`'s
 *  `w_` prefix exists: an element relation already carries `id`, and so does a property row, so an
 *  unprefixed join would declare the name twice — which the factory rejects outright rather than
 *  letting one silently shadow the other. The SCAN keeps the real column names (it reads the table);
 *  only the join's declared outputs are renamed. */
const PROP = (name: string): string => `p_${name}`;

/**
 * THE PROPERTY JOIN, with the match left to the caller — one traverser PER matching property, so a
 * JOIN and not an `EXISTS`.
 *
 * The ON is a callback because the two producers match on DIFFERENT things and must not each grow
 * their own copy of the column contract: `properties()` matches the OWNER against an element
 * relation, while `tinker.search` matches the property's own id against an FTS hit and has no element
 * input at all. What they share is what a property ROW is — which is the thing that must have one
 * authority, since `propertyPayload` and the three retypes all read it.
 *
 * The callback is handed the property scan's RelId and spells REAL column names against it; the `p_`
 * prefix applies only to the join's declared OUTPUTS, so a caller never sees it.
 *
 * The same join `values()` builds, kept at the property row rather than projected down to the value.
 * `keys` is bounded by the QUERY TEXT and never by row count, so an `InList` is right here and a JSON
 * bind is not (the root rule is about data-sized sets).
 *
 * A non-string key DECLINES at the caller rather than being guessed at: answering "every key" for one
 * would be answering a different question.
 */
export function propertyJoin(input: Rel, elem: Elem, on: (props: RelId) => Expr, fresh: Minter): Rel {
  const { table, owner } = PROPERTIES[elem];
  const cols = propCols(owner, elem === 'vertex');
  const props = make.scan({
    id: fresh('pr'), table, alias: fresh('rpr'), channels: [], type: typeOf(...cols),
  });
  // `ordered`: the input stream drives and the property table is PROBED. Both producers want that —
  // an element relation probes `vp_node_key(node,key)`, an FTS hit list probes the property rowid —
  // and neither wants the planner leading with a `key=?` scan of every property in the graph, which
  // is what it picks on a graph with no `sqlite_stat1` (see `joinText` in `src/rel/emit.ts`).
  return make.join({
    id: fresh('pj'), left: input, right: props, join: 'inner', ordered: true, channels: input.channels,
    type: typeOf(...input.type.cols, ...cols.map((c) => meta(PROP(c.name), c.type, c.nullable))),
    on: on(props.id),
  });
}

/** `properties(keys…)` off an ELEMENT relation — the join matched on the OWNER. */
export function propertyRelation(input: Rel, elem: Elem, keys: readonly string[], fresh: Minter): Rel {
  const { owner } = PROPERTIES[elem];
  return propertyJoin(input, elem, (props) =>
    and(eq(col(props, owner), col(input.id, 'id')), keys.length
      ? { kind: 'in-list', expr: col(props, 'key'), values: keys.map((k) => compilerText(k)) }
      : undefined), fresh);
}

/**
 * THE WIRE PROJECTION for a property stream — the columns `framePropertyRow` reads, in that order.
 *
 * Deliberately SIX columns and not the seven `PROPERTY_PAYLOAD` names: the framer reads
 * `{vpid, owner, pk, pv, pvtype, pmeta}` and nothing else. `ownerLabel` exists on legacy's tuple for
 * `element()`, which rebuilds the OWNING element and therefore needs its label — a correlated
 * subquery per row. Projecting it here would compute it for every property stream that never asks,
 * so it joins when `element()` lands rather than now.
 *
 * `vpid` is the property's own rowid on a vertex and NULL on an edge, which the framer turns into the
 * synthetic `owner:pk` — an edge Property has no identity of its own to give.
 */
export function propertyPayload(input: Rel, elem: Elem, fresh: Minter): Rel {
  const { owner } = PROPERTIES[elem];
  const ordered = byEncounter(input, fresh);
  const isVertex = elem === 'vertex';
  const payload: readonly (readonly [ColMeta, Expr])[] = [
    [meta('vpid', 'int', true), isVertex ? col(ordered.id, PROP('id')) : compilerNull()],
    [meta('owner', 'int'), col(ordered.id, PROP(owner))],
    [meta('pk', 'text'), col(ordered.id, PROP('key'))],
    [meta('pv', 'any', true), storedValueOn(col(ordered.id, PROP('value')), col(ordered.id, PROP('vtype')))],
    [meta('pvtype', 'text', true), col(ordered.id, PROP('vtype'))],
    [meta('pmeta', 'json', true), isVertex ? jsonOf(col(ordered.id, PROP('meta'))) : compilerNull()],
  ];
  return make.project({
    id: fresh('ppl'), input: ordered, channels: [], type: typeOf(...payload.map(([column]) => column)),
    exprs: payload.map(([column, expression]) => [column.name, expression] as const),
  });
}

// ---------- re-entering a property stream: key() / value() / element() ----------
//
// A property traverser is not terminal — TinkerPop's `PropertiesStep` feeds `key()`, `value()` and
// (for a VertexProperty, which IS an Element) `element()`. Each is a RETYPE: same rows, a different
// shape, so each hands back the relation plus its new `RelFraming` and the fold's one dispatcher
// decides which loop owns the rest of the chain.
//
// They live HERE rather than in the fold because the `p_` prefix is this module's private business.
// Exporting the prefix so `lower.ts` could spell `col(rel, 'p_key')` would put the join's internal
// naming into the caller — the thing that goes wrong the first time the prefix has to change.
//
// Every one preserves the carried channels: a retype changes what a row IS, never how many
// traversers there are or what state they carry.

/** The channel columns, projected through a retype unchanged. */
const carryThrough = (input: Rel) =>
  input.channels.map((channel) => [channel.col, col(input.id, channel.col)] as const);

/** `key()` — the property's KEY as a string scalar. Always a string, so a STATIC tag is honest here
 *  where the VALUE's is not. */
export function propertyKey(input: Rel, fresh: Minter): { rel: Rel; framing: RelFraming } {
  return {
    rel: make.project({
      id: fresh('pk'), input, channels: input.channels,
      type: typeOf(meta('v', 'text'), ...carriedCols(input.channels)),
      exprs: [['v', col(input.id, PROP('key'))], ...carryThrough(input)],
    }),
    framing: { kind: 'scalar', type: STATIC('string') },
  };
}

/** `value()` — the property's VALUE, typed PER ROW off the stored `vtype`. One compile-time tag would
 *  be a lie for an untyped property key, which is `values()`'s reasoning and the same channel. */
export function propertyValue(input: Rel, fresh: Minter): { rel: Rel; framing: RelFraming } {
  return {
    rel: make.project({
      id: fresh('pv'), input, channels: input.channels,
      type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)),
      exprs: [
        ['v', storedValueOn(col(input.id, PROP('value')), col(input.id, PROP('vtype')))],
        ['vtype', col(input.id, PROP('vtype'))],
        ...carryThrough(input),
      ],
    }),
    framing: { kind: 'scalar', type: PER_ROW('vtype') },
  };
}

/** `element()` — the OWNING element, back to an ordinary element stream, so movement and filters
 *  compose after it exactly as they would have before the `properties()`.
 *
 *  The owner column already rides on the join (it is what the join matched on), so this is a
 *  projection and not a second lookup. Multiplicity is deliberately NOT collapsed: three properties
 *  of one vertex yield that vertex three times, because traversers are a multiset and only `dedup()`
 *  collapses one. */
export function propertyElement(input: Rel, elem: Elem, fresh: Minter): { rel: Rel; framing: RelFraming } {
  const { owner } = PROPERTIES[elem];
  return {
    rel: make.project({
      id: fresh('pe'), input, channels: input.channels,
      type: typeOf(meta('id', 'int'), ...carriedCols(input.channels)),
      exprs: [['id', col(input.id, PROP(owner))], ...carryThrough(input)],
    }),
    framing: { kind: 'elements', elem },
  };
}
