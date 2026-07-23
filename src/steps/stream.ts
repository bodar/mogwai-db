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

import { type Expression, type Query, type Relation } from '../sql/kernel/q.ts';
import { type PStep } from '../strategies.ts';
import { type Elem } from '../plan.ts';
import { type ElemShape, type GroupKey, type GroupVal, type ListOf, type MapEntry, type MapOf, type PathPos, type Shape, type ValueType } from '../sql/kernel/render.ts';
import { carriedCols, type Carry, type ElementStream } from './context.ts';

/** What a list stream holds — i.e. the shape `unfold` produces from it. `elem` → bare
 *  rowids (rejoin nodes/edges on unfold) → a fresh `ElementStream`; `scalar` → typed scalars → a
 *  `ScalarStream`; `list` → nested lists (list-of-lists, e.g. select(Column.values) of a
 *  list-valued map) → a ListStream of the inner shape. ('entry' reserved for Map-unfold.) */
export type { ListOf } from '../sql/kernel/render.ts';

/** A stream of scalars in a one-column relation `v` (values/id/label/inject/unfold-
 *  of-scalars). `as` is the compile-time GraphBinary type tag (render.ts ValueType). */
export interface ScalarStream extends Carry {
  readonly kind: 'scalar';
  readonly rel: Relation;
  readonly as?: ValueType;
  /** Root framing semantics carried by the reducer, rather than reconstructed from
   * where the stream happens to become terminal. */
  readonly result?: 'value' | 'count' | 'number';
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
export interface ListStream extends Carry {
  readonly kind: 'list';
  readonly rel: Relation;
  readonly of: ListOf;
  /** This list value is a Set (from is(typeOf(SET)) or a set-op) — frames as a GraphBinary
   *  SET, not a LIST. Purely a framing marker; the list substrate (unfold/reducers) is shared. */
  readonly set?: boolean;
}

/** How a map stream's key/value columns are shaped (defined at the render boundary so a
 *  mapEntry Shape can name it). A key/value is a bare scalar (mk/mv hold the value, `as`
 *  its GraphBinary tag) or an element rowid (rejoined to nodes/edges when the column is
 *  projected out via select(Column) → unfold, or framed out at a terminal Map.Entry). */
export type { MapOf };

/** A map VALUE — one whole map per row, in a single JSONB `map` column holding an ordered
 * `[[keyNode, valNode], …]` pairs array (the same self-describing shape a stored map property
 * uses). This mirrors ListStream (one `list` blob per row): the map stays a first-class value
 * through the core, and the conversion to a per-entry Map.Entry stream (+ its size-1-MAP wire
 * framing) is pushed to unfold() / the root, never baked into the stream. Every producer
 * (group/groupCount/valueMap/is(typeOf(MAP))) builds this one shape. `keyOf`/`valOf` describe
 * each side's shape (scalar/element/list) so unfold/select(Column)/framing know how to read it. */
export interface MapStream extends Carry { readonly kind: 'map'; readonly rel: Relation; readonly keyOf: MapOf; readonly valOf: MapOf; }

/** The per-entry stream unfold() produces FROM a MapStream — a `(mk, mv)` row relation, one
 * row per Map.Entry. It exists only between unfold() and its consumer (select(Column.keys/
 * values), map(__.select(…)), or the root, where each entry frames as a size-1 MAP). Keeping
 * it distinct from MapStream is the point: a map is a blob VALUE in the core; entries are a
 * near-wire shape that appears only once you explode the map. `keyOf`/`valOf` carry over. */
export interface MapEntryStream extends Carry { readonly kind: 'mapEntry'; readonly rel: Relation; readonly keyOf: MapOf; readonly valOf: MapOf; }

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

/** The physical payload columns of a PropertyStream relation, in order. One row per
 *  VertexProperty/edge-Property instance: `vpid` the VertexProperty id (NULL for edge
 *  props), `owner` the owning element rowid, `pk`/`pv` key/value, `pvtype` the value's
 *  canonical stored type (so materialization frames it exactly), `pmeta` a meta bag. */
export const PROPERTY_PAYLOAD = ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pvtype', 'pmeta'] as const;

/** One field of a per-traverser select()/project() record. Unlike MapStream, whose
 * two columns describe an entry stream for a global group barrier, a RecordStream
 * is one wide row per incoming traverser and may have heterogeneous field shapes. */
export type RecordField = MapEntry;

export interface RecordStream extends Carry {
  readonly kind: 'record';
  readonly rel: Relation;
  readonly fields: readonly RecordField[];
}

/** A stream of DETACHED foreign elements — the result of a federated call() that merged a
 * sibling graph's rows back into this traversal. Deliberately NOT an ElementStream: a foreign
 * element has NO local nodes/edges row (its id/label/props are pre-landed as literal columns
 * on a VALUES CTE, id being the sibling's EXTERNAL id, not a local rowid), so the movement/
 * filter StepFns — which only ever see ElementStream and join local tables on a rowid — must
 * never receive one. Being a distinct kind is the fail-closed mechanism: movement over a
 * detached reference is structurally unreachable (no StepFn is handed a ForeignStream), and
 * compileFromForeign's fallback turns any unsupported follow-on into a clear deferral rather
 * than a silent local-table join. Reads that need only the landed columns — id()/label()/
 * values()/valueMap() and root framing — read them directly, no join. `elem` says which
 * element kind the landed rows are (so root framing picks vertex vs edge). */
export interface ForeignStream extends Carry {
  readonly kind: 'foreign';
  readonly rel: Relation;
  readonly elem: Elem;
}

/** The physical payload columns of a ForeignStream relation, in order. `fid`/`flabel`/`fprops`
 *  for a vertex; edges add `fsrc`/`ftgt`. `fprops` is JSON text in the SAME per-key {t,v}-node
 *  shape vertexBuffer/edgeBuffer consume, so root framing reuses the vertex/edge path verbatim. */
export const foreignPayload = (elem: Elem): string[] =>
  elem === 'edge' ? ['fid', 'flabel', 'fsrc', 'ftgt', 'fprops'] : ['fid', 'flabel', 'fprops'];

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

export type RelationalStream = ElementStream | ScalarStream | VariantStream | ListStream | MapStream | MapEntryStream | PropertyStream | RecordStream | GroupStream | PathStream | ForeignStream;
export type Stream = RelationalStream | ResultStream;

/** A shape compiler yields this token when lowering should continue with a new
 * relational stream. The central lowerSteps loop consumes it; leaves never recurse
 * into orchestration or materialize an intermediate result. */
export interface LoweringContinuation {
  readonly kind: 'continue-lowering';
  readonly stream: Stream;
  readonly at: number;
}

/** A compile SUSPENDED mid-chain at a barrier call() (Phase 6b — the V().call(federate) twin of
 *  a source-form BarrierPoint). Unlike a 'continue' (which hands the loop a fresh Stream), a
 *  suspension says "this segment's rows arrive from an awaited external call; stop lowering here
 *  and hand `point` back up to compileRead, which resumes once the rows land." lowerSteps RELAYS
 *  it unchanged — it never interprets it, keeping the "no second orchestrator" invariant. `point`
 *  is opaque here (stream.ts is a leaf and must not import call.ts's MidBarrierPoint — that would
 *  cycle); compileRead (index.ts, which already imports call.ts) narrows it back. */
export interface LoweringSuspension {
  readonly kind: 'suspend-lowering';
  readonly point: unknown;
}

/** A shape handler's outcome: continue with a new stream, or suspend at a barrier. A handler that
 *  declines still returns `null` (dispatchShapeTail's fallback), unchanged. */
export type LoweringResult = LoweringContinuation | LoweringSuspension;

export const continueLowering = (stream: Stream, at: number): LoweringContinuation =>
  ({ kind: 'continue-lowering', stream, at });

export const suspendLowering = (point: unknown): LoweringSuspension =>
  ({ kind: 'suspend-lowering', point });

export const isSuspension = (r: LoweringResult | Stream): r is LoweringSuspension =>
  (r as { kind?: string }).kind === 'suspend-lowering';

/**
 * A shape-tail handler for one step name: gets the current stream, the peeked step
 * (`steps[at]`), and the whole chain + cursor (so a handler may look ahead — e.g.
 * order().dedup()). Returning `null` means "not mine" — an internal guard/fall-through
 * declined, so dispatch falls to the fallback. This is what lets one Map entry own a
 * step whose recognition is conditional (a Scope.local guard, a mixed-shape peek).
 */
export type ShapeTailFn<S> = (s: S, step: PStep, steps: PStep[], at: number) => LoweringResult | null;

/**
 * Per-shape tail dispatch: a `Map<stepName, handler>` + a fallback. This is the CLAUDE.md
 * "register in a Map, don't grow a switch" law applied to the shape dispatchers
 * (compileTail / compileFromScalar / …). Look the step name up; if a handler matches and
 * returns a result, use it; otherwise run the fallback (a clear throw, or — for the
 * element tail — the foldTailAcc projection path).
 */
export function dispatchShapeTail<S>(
  table: Map<string, ShapeTailFn<S>>,
  s: S,
  steps: PStep[],
  at: number,
  fallback: (s: S, steps: PStep[], at: number) => LoweringResult,
): LoweringResult {
  const handler = table.get(steps[at]?.name);
  if (handler) {
    const res = handler(s, steps[at], steps, at);
    if (res) return res;
  }
  return fallback(s, steps, at);
}

const elemColumns = (prefix: string, elem: ElemShape): string[] => elem === 'edge'
  ? [`${prefix}_id`, `${prefix}_label`, `${prefix}_src`, `${prefix}_tgt`, `${prefix}_props`]
  : elem === 'property'
    ? [`${prefix}_owner`, `${prefix}_pk`, `${prefix}_pv`]
    : [`${prefix}_id`, `${prefix}_label`, `${prefix}_props`];

export const groupColumns = (s: Pick<GroupStream, 'key' | 'val'>): string[] => {
  const key = s.key.kind === 'scalar' ? ['gk']
    : s.key.kind === 'map' ? s.key.parts.map((_, i) => `k${i}_v`)
    : ['k_rid', ...elemColumns('k', s.key.elem)];
  // Node/edge element values carry an internal rowid (v_rid), mirroring the element key's
  // k_rid, so a later select(Column.values)/unfold() can rejoin the value elements. A
  // property element value has no rowid column (elementSelect emits none).
  const val = s.val.kind === 'elementList' || s.val.kind === 'elementLast'
    ? [...(s.val.elem === 'property' ? [] : ['v_rid']), ...elemColumns('v', s.val.elem)]
    : s.val.kind === 'sum' ? ['gv', 'gvt'] : ['gv'];
  return [...key, ...val];
};

/** Root-visible group columns omit the internal element rowids (key k_rid / value v_rid)
 * used only when a later Column.keys/values selection re-enters an ElementStream. */
export const groupResultColumns = (s: Pick<GroupStream, 'key' | 'val'>): string[] =>
  groupColumns(s).filter((name) => name !== 'k_rid' && name !== 'v_rid');

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
    : s.kind === 'scalar' ? [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...(s.vtype ? [s.vtype] : [])]
    : s.kind === 'variant' ? ['vk', 'v', 'rid', ...(s.listOf ? ['list'] : [])]
    : s.kind === 'list' ? ['list']
    : s.kind === 'map' ? ['map']
    : s.kind === 'mapEntry' ? ['mk', 'mv']
    : s.kind === 'property' ? [...PROPERTY_PAYLOAD]
    : s.kind === 'record' ? s.fields.flatMap(recordFieldColumns)
    : s.kind === 'group' ? groupColumns(s)
    : s.kind === 'foreign' ? foreignPayload(s.elem)
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
    : ({ q: s.q, params: s.params, sideEffects: s.sideEffects, carried: s.carried });

export const toResultStream = (q: Query, tail: Expression, shape: Shape): ResultStream =>
  ({ kind: 'result', q, tail, shape });

/** The non-payload scalar-stream facets, as an options bag. Emission order is NOT here —
 *  it lives in `carried.encounter` (the one unified slot), threaded via carryFrag like every
 *  other carried column. */
export interface ScalarOpts {
  readonly result?: ScalarStream['result'];
  readonly productiveNull?: boolean;
  readonly vtype?: string;
}
export const toScalarStream = (c: Carry, rel: Relation, as?: ValueType, opts: ScalarOpts = {}): ScalarStream =>
  assertStreamColumns({ ...c, kind: 'scalar', rel, as, result: opts.result ?? 'value', productiveNull: opts.productiveNull, vtype: opts.vtype });
export const toVariantStream = (c: Carry, rel: Relation, arms: VariantArms, result: VariantStream['result'] = 'rows'): VariantStream =>
  assertStreamColumns({ ...c, kind: 'variant', rel, scalarAs: arms.scalarAs, node: arms.node, edge: arms.edge, listOf: arms.listOf, result });
export const toListStream = (c: Carry, rel: Relation, of: ListOf, set?: boolean): ListStream =>
  assertStreamColumns({ ...c, kind: 'list', rel, of, set });
export const toMapStream = (c: Carry, rel: Relation, keyOf: MapOf, valOf: MapOf): MapStream =>
  assertStreamColumns({ ...c, kind: 'map', rel, keyOf, valOf });
export const toMapEntryStream = (c: Carry, rel: Relation, keyOf: MapOf, valOf: MapOf): MapEntryStream =>
  assertStreamColumns({ ...c, kind: 'mapEntry', rel, keyOf, valOf });
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
  m.kind === 'elem' ? { kind: 'elem', elem: m.elem } : m.kind === 'list' ? { kind: 'list', of: m.of } : { kind: 'scalar', typed: true };
