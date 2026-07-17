// ---------- the traverser stream model (list-value substrate) ----------
//
// A traversal's state has more than one SHAPE. The prefix fold works on an
// id-relation of elements (`ElementStream`, context.ts). A projection/inject produces a stream
// of scalars. `fold()` produces a single list value. Historically the tail was
// strictly terminal, so these value shapes had nowhere to go; the `Stream` union +
// the dispatcher (index.ts `lowerSteps`) make the tail RE-ENTERABLE — a step can
// retype the stream (fold: elements→list, unfold: list→elements/scalar) and keep
// compiling. Each arm shares `Carry` (context.ts) so a retype preserves the query
// builder / params / aliases / path.
//
// CRITICAL: `ElementStream.elem` stays 'node'|'edge' only, and the 20+ movement/filter/branch
// StepFns only ever see `ElementStream`. The union lives at the ORCHESTRATION layer, never
// inside a StepFn.

import { type Expression, type Query, type Relation } from '../q.ts';
import { type Elem } from '../plan.ts';
import { type ElemShape, type GroupKey, type GroupVal, type ListOf, type MapEntry, type PathPos, type Shape, type ValueType } from '../render.ts';
import { carriedCols, type Carry, type ElementStream } from './context.ts';

/** What a list stream holds — i.e. the shape `unfold` produces from it. `elem` → bare
 *  rowids (rejoin nodes/edges on unfold) → a fresh `ElementStream`; `scalar` → typed scalars → a
 *  `ScalarStream`; `list` → nested lists (list-of-lists, e.g. select(Column.values) of a
 *  list-valued map) → a ListStream of the inner shape. ('entry' reserved for Map-unfold.) */
export type { ListOf } from '../render.ts';

/** A stream of scalars in a one-column relation `v` (values/id/label/inject/unfold-
 *  of-scalars). `as` is the compile-time GraphBinary type tag (render.ts ValueType). */
export interface ScalarStream extends Carry {
  readonly kind: 'scalar';
  readonly rel: Relation;
  readonly as?: ValueType;
  /** Root framing semantics carried by the reducer, rather than reconstructed from
   * where the stream happens to become terminal. */
  readonly result?: 'value' | 'count' | 'number';
  /** Optional physical encounter-order column. Child traversal barriers use this
   * instead of relying on SQLite relation order, which is not preserved across CTEs. */
  readonly encounter?: string;
  /** A NULL row is a real traverser rather than an empty numeric reduction. Set by
   * ProductiveBy-backed list streams and preserved through their reducers. */
  readonly productiveNull?: boolean;
  /** Optional physical per-row stored-type column (its name, conventionally 'vtype')
   * carrying the canonical Gremlin type of each value (from values()/properties() reading
   * vertex_properties/edge_properties.vtype). typeOf tests it per row; row-preserving ops
   * carry it; transforms/reducers that change the type drop it. Distinct from `as` (a
   * single compile-time framing tag) and from the reducer `vt` (a storage-class string). */
  readonly vtype?: string;
}

/** A runtime-discriminated value stream (P4 dynamic-tag row). `vk` is a per-row
 * payload-shape tag — 0=null, 1=scalar (`v`), 2=node (`rid`), 3=edge (`rid`),
 * 4=list (`list`) — so one relation can carry genuinely heterogeneous traversers
 * (a scalar OR a node OR an edge OR a list, per row), not just a narrow
 * null/scalar/one-element-kind sum. `node`/`edge`/`listOf` say which arms can
 * appear (and thus which physical columns + root joins exist); `scalarAs` is the
 * uniform GraphBinary type of scalar rows (undefined → infer per JS value; a
 * genuinely heterogeneous-TYPE scalar arm would need a per-row vtype column, the
 * documented extension point, not built until a scenario needs it). Row existence
 * keeps null distinct from an unproductive child. */
export interface VariantStream extends Carry {
  readonly kind: 'variant';
  readonly rel: Relation;
  readonly scalarAs?: ValueType;
  readonly node?: boolean;
  readonly edge?: boolean;
  readonly listOf?: ListOf;
  /** A named aggregate side effect is one collection traverser at cap(); explicit
   * unfold() changes it back to member rows without rewriting the relation. */
  readonly result?: 'rows' | 'list';
}

/** Which arms a widened variant relation carries. Producers describe the union of
 * possible per-row shapes; streamColumns/materializeVariantRoot/the handler derive
 * columns, joins and framing from it. */
export interface VariantArms {
  readonly scalarAs?: ValueType;
  readonly node?: boolean;
  readonly edge?: boolean;
  readonly listOf?: ListOf;
}

/** A single list value in a one-row relation with a JSONB `list` column (fold /
 *  inject-of-a-list / select(Column.values)), plus any carried columns. `of` says
 *  what the list holds so unfold/framing knows how to explode it. */
export interface ListStream extends Carry { readonly kind: 'list'; readonly rel: Relation; readonly of: ListOf; }

/** How a map stream's key/value columns are shaped. A key/value is a bare scalar
 *  (mk/mv hold the value, `as` its GraphBinary tag) or an element rowid (rejoined to
 *  nodes/edges when the column is projected out via select(Column) → unfold). */
export type MapOf =
  | { kind: 'scalar'; as?: ValueType }
  | { kind: 'elem'; elem: Elem }
  | { kind: 'list'; of: ListOf };

/** A map value as a `(mk, mv)` row relation — one row per entry. A simple GroupStream
 * derives this layout when select(Column.values/keys) consumes it; Map-unfold will
 * eventually use the same form. `keyOf`/`valOf` describe re-entry shape. */
export interface MapStream extends Carry { readonly kind: 'map'; readonly rel: Relation; readonly keyOf: MapOf; readonly valOf: MapOf; readonly entries?: boolean; }

/** The traverser stream shapes a compile phase can be in. */
/** A stream of Property/VertexProperty traversers. Properties are element-like at
 * the Gremlin level but deliberately are not ElementStream: movement/filter StepFns
 * only understand node/edge rowids. The payload keeps the owner and property fields
 * relational until key/value/id/element/materialization chooses the next shape. */
export interface PropertyStream extends Carry {
  readonly kind: 'property';
  readonly rel: Relation;
  readonly ownerElem: Elem;
}

/** One field of a per-traverser select()/project() record. Unlike MapStream, whose
 * two columns describe an entry stream for a global group barrier, a RecordStream
 * is one wide row per incoming traverser and may have heterogeneous field shapes. */
export type RecordField = MapEntry;

export interface RecordStream extends Carry {
  readonly kind: 'record';
  readonly rel: Relation;
  readonly fields: readonly RecordField[];
}

/** The rich relational result of a global group()/groupCount() barrier. This keeps
 * terminal element/composite/list layouts honest; simple key/value layouts may later
 * derive the narrow `(mk,mv)` MapStream used by select(Column.*). */
export interface GroupStream extends Carry {
  readonly kind: 'group';
  readonly rel: Relation;
  readonly key: GroupKey;
  readonly val: GroupVal;
}

export type PathLayout =
  | { readonly kind: 'linear'; readonly positions: readonly PathPos[] }
  // A recursive repeat().path(): one row per path element. `byKey` (from a path().by(key)
  // modulator) projects each position to a scalar `v` instead of the whole element.
  | { readonly kind: 'grouped'; readonly elem: ElemShape; readonly byKey?: boolean };

/** A fully lowered Path value. Linear paths carry one wide row per path; recursive
 * paths carry `(pk,ord,element...)` rows that root framing groups by path key. */
export interface PathStream extends Carry {
  readonly kind: 'path';
  readonly rel: Relation;
  readonly layout: PathLayout;
}

/** A fully lowered legacy tail awaiting the one root materialization boundary. It is
 * intentionally not relational/re-enterable: producers may only yield it at the end
 * of the chain. New step families should prefer a physical typed stream. */
export interface ResultStream {
  readonly kind: 'result';
  readonly q: Query;
  readonly tail: Expression;
  readonly shape: Shape;
}

export type RelationalStream = ElementStream | ScalarStream | VariantStream | ListStream | MapStream | PropertyStream | RecordStream | GroupStream | PathStream;
export type Stream = RelationalStream | ResultStream;

/** A shape compiler yields this token when lowering should continue with a new
 * relational stream. The central lowerSteps loop consumes it; leaves never recurse
 * into orchestration or materialize an intermediate result. */
export interface LoweringContinuation {
  readonly kind: 'continue-lowering';
  readonly stream: Stream;
  readonly at: number;
}

export type LoweringResult = LoweringContinuation;

export const continueLowering = (stream: Stream, at: number): LoweringContinuation =>
  ({ kind: 'continue-lowering', stream, at });

const elemColumns = (prefix: string, elem: ElemShape): string[] => elem === 'edge'
  ? [`${prefix}_id`, `${prefix}_label`, `${prefix}_src`, `${prefix}_tgt`, `${prefix}_props`]
  : elem === 'property'
    ? [`${prefix}_owner`, `${prefix}_pk`, `${prefix}_pv`]
    : [`${prefix}_id`, `${prefix}_label`, `${prefix}_props`];

export const groupColumns = (s: Pick<GroupStream, 'key' | 'val'>): string[] => {
  const key = s.key.kind === 'scalar' ? ['gk']
    : s.key.kind === 'map' ? s.key.parts.map((_, i) => `k${i}_v`)
    : ['k_rid', ...elemColumns('k', s.key.elem)];
  const val = s.val.kind === 'elementList' || s.val.kind === 'elementLast'
    ? elemColumns('v', s.val.elem)
    : s.val.kind === 'sum' ? ['gv', 'gvt'] : ['gv'];
  return [...key, ...val];
};

/** Root-visible group columns omit the internal element-key rowid used only when a
 * later Column.keys selection re-enters an ElementStream. */
export const groupResultColumns = (s: Pick<GroupStream, 'key' | 'val'>): string[] =>
  groupColumns(s).filter((name) => name !== 'k_rid');

export const pathColumns = (layout: PathLayout): string[] => {
  if (layout.kind === 'grouped') return layout.byKey ? ['pk', 'ord', 'v'] : ['pk', 'ord', ...elemColumns('', layout.elem).map((c) => c.slice(1))];
  return layout.positions.flatMap((p) => p.render === 'value'
    ? [`${p.prefix}_v`]
    : elemColumns(p.prefix, p.elem));
};

export const recordFieldColumns = (f: RecordField): string[] => f.sub === 'value'
  ? [`${f.prefix}_v`]
  : f.sub === 'list'
    ? [`${f.prefix}_list`]
  : f.sub === 'edge'
    ? [`${f.prefix}_rid`, `${f.prefix}_id`, `${f.prefix}_label`, `${f.prefix}_src`, `${f.prefix}_tgt`, `${f.prefix}_props`]
    : [`${f.prefix}_rid`, `${f.prefix}_id`, `${f.prefix}_label`, `${f.prefix}_props`];

/** Root-visible record columns omit the internal rowid retained solely so selecting
 * an element field can re-enter movement even when its external id is a string uid. */
export const recordResultColumns = (f: RecordField): string[] =>
  recordFieldColumns(f).filter((name) => name !== `${f.prefix}_rid`);

/** The physical relation columns promised by a stream. Payload comes first, followed
 * by the stable carried schema. A stream is executable relational state, so metadata
 * may never claim a column that its Relation does not expose. */
export function streamColumns(s: Stream): readonly string[] {
  if (s.kind === 'result') return [];
  const payload = s.kind === 'elements' ? ['id']
    : s.kind === 'scalar' ? [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...(s.encounter ? [s.encounter] : []), ...(s.vtype ? [s.vtype] : [])]
    : s.kind === 'variant' ? ['vk', 'v', 'rid', ...(s.listOf ? ['list'] : [])]
    : s.kind === 'list' ? ['list']
    : s.kind === 'map' ? ['mk', 'mv']
    : s.kind === 'property' ? ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pmeta']
    : s.kind === 'record' ? s.fields.flatMap(recordFieldColumns)
    : s.kind === 'group' ? groupColumns(s)
    : pathColumns(s.layout);
  return [...payload, ...carriedCols(s.carried)];
}

/** Development/test guard for the physical stream contract. Relation.cols is the
 * declared CTE layout, so checking it here catches missing or reordered carried
 * columns before SQLite turns the mismatch into corrupt traversal state. */
export function assertStreamColumns<T extends Stream>(s: T): T {
  if (s.kind === 'result') return s;
  const expected = streamColumns(s);
  const actual = s.rel.cols;
  if (expected.length !== actual.length || expected.some((col, i) => col !== actual[i]))
    throw new Error(`${s.kind} stream column mismatch: expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
  return s;
}

/** Project a stream's shape-independent state (for building the next phase's stream). */
export const carryOf = (s: Stream): Carry =>
  s.kind === 'result'
    ? (() => { throw new Error('a terminal result stream has no traverser carry'); })()
    : ({ q: s.q, params: s.params, fastPaths: s.fastPaths, sideEffects: s.sideEffects, carried: s.carried });

export const toResultStream = (q: Query, tail: Expression, shape: Shape): ResultStream =>
  ({ kind: 'result', q, tail, shape });

export const toScalarStream = (c: Carry, rel: Relation, as?: ValueType, result: ScalarStream['result'] = 'value', encounter?: string, productiveNull?: boolean, vtype?: string): ScalarStream =>
  assertStreamColumns({ ...c, kind: 'scalar', rel, as, result, encounter, productiveNull, vtype });
export const toVariantStream = (c: Carry, rel: Relation, arms: VariantArms, result: VariantStream['result'] = 'rows'): VariantStream =>
  assertStreamColumns({ ...c, kind: 'variant', rel, scalarAs: arms.scalarAs, node: arms.node, edge: arms.edge, listOf: arms.listOf, result });
export const toListStream = (c: Carry, rel: Relation, of: ListOf): ListStream =>
  assertStreamColumns({ ...c, kind: 'list', rel, of });
export const toMapStream = (c: Carry, rel: Relation, keyOf: MapOf, valOf: MapOf, entries?: boolean): MapStream =>
  assertStreamColumns({ ...c, kind: 'map', rel, keyOf, valOf, entries });
export const toPropertyStream = (c: Carry, rel: Relation, ownerElem: Elem): PropertyStream =>
  assertStreamColumns({ ...c, kind: 'property', rel, ownerElem });
export const toRecordStream = (c: Carry, rel: Relation, fields: readonly RecordField[]): RecordStream =>
  assertStreamColumns({ ...c, kind: 'record', rel, fields });
export const toGroupStream = (c: Carry, rel: Relation, key: GroupKey, val: GroupVal): GroupStream =>
  assertStreamColumns({ ...c, kind: 'group', rel, key, val });
export const toPathStream = (c: Carry, rel: Relation, layout: PathLayout): PathStream =>
  assertStreamColumns({ ...c, kind: 'path', rel, layout });

/** A map key/value column's shape → the list shape it produces when select(Column.*)
 *  aggregates it: a scalar carries its type tag, an element rejoins on unfold, a
 *  list-valued column becomes a list-of-lists (one nesting level deeper). */
export const mapOfToListOf = (m: MapOf): ListOf =>
  m.kind === 'elem' ? { kind: 'elem', elem: m.elem } : m.kind === 'list' ? { kind: 'list', of: m.of } : { kind: 'scalar', as: m.as };
