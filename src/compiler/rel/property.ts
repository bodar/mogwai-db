import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta } from '../../rel/types.ts';
import { and, byEncounter, eq, jsonOf, meta, PROPERTIES, storedValueOn, typeOf, type Minter } from './build.ts';
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
 * `properties(keys…)` — one traverser PER matching property, so a JOIN and not an `EXISTS`.
 *
 * The same join `values()` builds, kept at the property row rather than projected down to the value.
 * `keys` is bounded by the QUERY TEXT and never by row count, so an `InList` is right here and a JSON
 * bind is not (the root rule is about data-sized sets).
 *
 * A non-string key DECLINES at the caller rather than being guessed at: answering "every key" for one
 * would be answering a different question.
 */
export function propertyRelation(input: Rel, elem: Elem, keys: readonly string[], fresh: Minter): Rel {
  const { table, owner } = PROPERTIES[elem];
  const hasMeta = elem === 'vertex';
  const cols = propCols(owner, hasMeta);
  const props = make.scan({
    id: fresh('pr'), table, alias: fresh('rpr'), channels: [], type: typeOf(...cols),
  });
  return make.join({
    id: fresh('pj'), left: input, right: props, join: 'inner', channels: input.channels,
    type: typeOf(...input.type.cols, ...cols.map((c) => meta(PROP(c.name), c.type, c.nullable))),
    on: and(eq(col(props.id, owner), col(input.id, 'id')), keys.length
      ? { kind: 'in-list', expr: col(props.id, 'key'), values: keys.map((k) => compilerText(k)) }
      : undefined),
  });
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
