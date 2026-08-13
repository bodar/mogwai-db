import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { ColMeta, RelId } from '../../rel/types.ts';
import { and, byEncounter, carriedCols, eq, jsonOf, keyMembership, meta, PROPERTIES, storedValueOn, typeOf, type Minter } from './build.ts';
import { PER_ROW, STATIC } from '../../sql/kernel/render.ts';
import { storedCompareOn, valueSet } from './predicate.ts';
import type { Arg } from '../../gremlin/frontend.ts';
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

/** `properties(keys…)` off an ELEMENT relation — the join matched on the OWNER. `keys` is `null` for
 *  EVERY key and `[]` for a legal set that matches nothing; `keyMembership` owns that distinction. */
export function propertyRelation(input: Rel, elem: Elem, keys: readonly string[] | null, fresh: Minter): Rel {
  const { owner } = PROPERTIES[elem];
  return propertyJoin(input, elem, (props) =>
    and(eq(col(props, owner), col(input.id, 'id')), keyMembership(col(props, 'key'), keys)), fresh);
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

/**
 * `hasKey(…)` / `hasValue(…)` — a filter on the property's own KEY or VALUE.
 *
 * Both are ONE `HasContainer` upstream, on `T.key` / `T.value`, so both are one predicate over one
 * column here and the arm that differs is only WHICH column and WHAT is known about its type. The key is
 * a string statically; the value's type is the row's own `vtype`, which is what makes
 * `hasValue(P.lt(0.3))` compare a decimal-TEXT-carried exact number numerically rather than lexically —
 * the same authority `has('age', gt(30))` spends on an element.
 *
 * The vararg-with-nulls reduction is `valueSet`'s, cited there. This is deliberately NOT the place a
 * meta-property read lands: `has(k, v)` over a VertexProperty asks about its META-properties, a different
 * question on a different row, and it declines rather than being answered off this one.
 */
export function propertyHasClause(
  props: Rel, on: 'key' | 'value', args: readonly Arg[], fresh: Minter,
): Expr | null {
  const vtype = col(props.id, PROP('vtype'));
  return on === 'key'
    ? valueSet(col(props.id, PROP('key')), args, { kind: 'static', type: 'string' }, fresh)
    : valueSet(storedValueOn(col(props.id, PROP('value')), vtype), args, { kind: 'perRow', vtype }, fresh);
}

// ---------- a property traverser's NATURAL ORDER and its IDENTITY ----------
//
// Both questions are answered by the OWNER KIND, and it is the same two-way split for both, because
// upstream draws it once: a `VertexProperty` IS an `Element` and a `Property` is not.
//
// - ORDER. `GremlinValueComparator` dispatches per type
//   (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:166-175`):
//   `Type.VertexProperty` takes the `elementComparator` — `Comparator.comparing(Element::id, this)` —
//   while `Type.Property` takes the `propertyComparator`, "sort first by key, then by value".
// - IDENTITY. `ElementHelper.hashCode(Element)` is `element.id().hashCode()`, and
//   `ElementHelper.hashCode(Property)` is `key().hashCode() + value().hashCode()`
//   (`.../structure/util/ElementHelper.java`); `areEqual(Property, Object)` compares key and value and
//   deliberately does NOT look at the owning element. So `g.V().bothE().properties().dedup().count()`
//   is 4 on the modern graph and not 6 — the two `0.4` weights and the two `1.0` weights collapse
//   ACROSS their edges (`gremlin-test/.../features/filter/Dedup.feature:283-292`).
//
// A term list rather than one expression, and that is the whole reason these are not `byExpr` arms: an
// edge `Property`'s order is TWO terms and its identity THREE columns, which a single projection cannot
// state. They are here because the `p_` prefix is this module's private business.

/** A property traverser's natural sort key(s), in term order — `GremlinValueComparator`'s per-type
 *  comparator, spelled over the join's own columns. */
export function propertyOrderTerms(props: Rel, ownerElem: Elem): readonly Expr[] {
  const own = (name: string): Expr => col(props.id, PROP(name));
  // A VertexProperty sorts by its id, which for us IS the stored rowid — the same thing `id()` frames.
  if (ownerElem === 'vertex') return [own('id')];
  // An edge Property sorts by KEY then VALUE, and the value goes through the one compare authority so a
  // number carried as decimal TEXT sorts numerically (the reason `order().by('age')` spends it too).
  return [own('key'), storedCompareOn(own('vtype'))(storedValueOn(own('value'), own('vtype')))];
}

/** A property traverser's IDENTITY columns — what a bare `dedup()` groups by. */
export function propertyIdentityKey(props: Rel, ownerElem: Elem): readonly Expr[] {
  const own = (name: string): Expr => col(props.id, PROP(name));
  if (ownerElem === 'vertex') return [own('id')];
  // `vtype` IS part of the key and not decoration: Java's `Integer(1).equals(Double(1.0))` is false,
  // while SQLite compares INTEGER 1 and REAL 1.0 as EQUAL — so a key of value alone would merge two
  // properties upstream keeps apart. ⚠️ A row whose `vtype` is NULL (the raw-insert path documented in
  // `src/storage.ts`) therefore stands apart from a typed row holding the same value; that is the
  // fail-closed direction, and every property written through the write channel carries one.
  return [own('key'), storedValueOn(own('value'), own('vtype')), own('vtype')];
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

/**
 * THE PROPERTY ROW'S OWN rowid, for a consumer that has to address the STORED row rather than frame it.
 *
 * Exported as an accessor rather than by exporting `PROP`, so the prefixed-column contract stays in
 * this file — the reason the prefix exists at all is that a join carrying both an element `id` and a
 * property `id` would declare the name twice.
 *
 * **It is present for BOTH element kinds**, which is worth stating because the PAYLOAD deliberately
 * nulls it on an edge: a Gremlin edge `Property` has no identity to give the wire. Physically the row
 * has one either way (`edge_properties.id`), and a delete addresses the row, not the Property.
 */
export const propertyRowId = (props: Rel): Expr => col(props.id, PROP('id'));

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

/** `id()` — a VertexProperty's OWN id, which for us IS the stored rowid (the same thing `propertyPayload`
 *  frames as `vpid`, and the same thing `propertyOrderTerms` sorts a VertexProperty by). A `long` on the
 *  wire, so a STATIC tag is honest: this is a rowid, never a user-supplied `uid` — `vertex_properties` has
 *  no such column, which is why there is no `COALESCE` here and there is one for an element. Reached only
 *  for a VERTEX owner: an edge `Property` is not an Element and has no id to give. */
export function propertyId(input: Rel, fresh: Minter): { rel: Rel; framing: RelFraming } {
  return {
    rel: make.project({
      id: fresh('pi'), input, channels: input.channels,
      type: typeOf(meta('v', 'int'), ...carriedCols(input.channels)),
      exprs: [['v', col(input.id, PROP('id'))], ...carryThrough(input)],
    }),
    framing: { kind: 'scalar', type: STATIC('long') },
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

// ---------- a property addressed by its ROWID: the correlated reads a child body needs ----------
//
// The retypes above project COLUMNS off the property join, which is what a chain-position `key()` /
// `value()` / `element()` gets. A property reached as a `by()` HOST has only its rowid — the same
// standing an element `ChildHost` has — so the same three questions become correlated reads of the
// stored row. They are here rather than in `modulator.ts` for `propertyRelation`'s reason: what a
// property ROW is has one authority, and a second spelling of the `vertex_properties` / `edge_properties`
// column contract is what would let a value and its `vtype` describe two different rows.

/** The property row, filtered to ONE rowid — the correlated reads below all start here, so the column
 *  contract is stated once. */
function propertyRow(rowid: Expr, ownerElem: Elem, fresh: Minter): { readonly rel: Rel; readonly owner: string } {
  const { table, owner } = PROPERTIES[ownerElem];
  const cols = propCols(owner, ownerElem === 'vertex');
  const scan = make.scan({ id: fresh('pn'), table, alias: fresh('rpn'), channels: [], type: typeOf(...cols) });
  return { rel: make.filter({ id: fresh('pnf'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'id'), rowid) }), owner };
}

/**
 * A PROPERTY AS A SELF-DESCRIBING `{t,v}` NODE — `elementNode`'s third kind (`element.ts`).
 *
 * `v` is exactly the tuple `framePropertyRow` (`execute.ts`) already reads for a top-level property
 * stream and for a property-membered list, so the wire needed one arm in `frameTypedNode` and no new
 * payload vocabulary: the typed tree is SELF-DESCRIBING, so a property as a group key, a group member
 * or a record field all frame by that one rule at whatever depth they appear.
 *
 * `vpid` is NULL on an edge exactly as `propertyPayload` nulls it — a Gremlin edge `Property` has no
 * identity of its own to give, and the framer synthesises `owner:pk` for it.
 */
export function propertyNode(rowid: Expr, ownerElem: Elem, fresh: Minter): Expr {
  const { rel, owner } = propertyRow(rowid, ownerElem, fresh);
  const isVertex = ownerElem === 'vertex';
  const own = (name: string): Expr => col(rel.id, name);
  const payload: Expr = {
    kind: 'json-object',
    entries: [
      ['vpid', isVertex ? own('id') : compilerNull()],
      ['owner', own(owner)],
      ['pk', own('key')],
      ['pv', storedValueOn(own('value'), own('vtype'))],
      ['pvtype', own('vtype')],
      ['pmeta', isVertex ? jsonOf(own('meta')) : compilerNull()],
    ],
    binary: false,
  };
  const only = make.project({
    id: fresh('pnp'), input: rel, channels: [], type: typeOf(meta('n', 'json', true)),
    exprs: [['n', { kind: 'json-object', entries: [['t', compilerText('property')], ['v', payload]], binary: false }]],
  });
  return { kind: 'scalar', plan: only };
}

/** WHICH single column of the stored property row a child body asks for. Named rather than passed as a
 *  raw string so a caller cannot spell a column this module does not carry. */
export type PropertyRead = 'key' | 'value' | 'vtype' | 'owner';

/**
 * ONE stored column of the property at `rowid`, as a correlated expression.
 *
 * `value` arrives through `storedValueOn` — the same decode `propertyValue` applies to the join — so a
 * property read from a rowid and one read from the join cannot disagree about a text-carried long.
 */
export function propertyReadOf(rowid: Expr, ownerElem: Elem, read: PropertyRead, fresh: Minter): Expr {
  const { rel, owner } = propertyRow(rowid, ownerElem, fresh);
  const value = read === 'owner' ? col(rel.id, owner)
    : read === 'value' ? storedValueOn(col(rel.id, 'value'), col(rel.id, 'vtype'))
      : col(rel.id, read);
  const only = make.project({
    id: fresh('prp'), input: rel, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', value]],
  });
  return { kind: 'scalar', plan: only };
}
