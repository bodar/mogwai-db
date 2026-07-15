// ---------- the traverser stream model (list-value substrate) ----------
//
// A traversal's state has more than one SHAPE. The prefix fold works on an
// id-relation of elements (`ElementStream`, context.ts). A projection/inject produces a stream
// of scalars. `fold()` produces a single list value. Historically the tail was
// strictly terminal, so these value shapes had nowhere to go; the `Stream` union +
// the dispatcher (index.ts `dispatchNext`) make the tail RE-ENTERABLE — a step can
// retype the stream (fold: elements→list, unfold: list→elements/scalar) and keep
// compiling. Each arm shares `Carry` (context.ts) so a retype preserves the query
// builder / params / aliases / path.
//
// CRITICAL: `ElementStream.elem` stays 'node'|'edge' only, and the 20+ movement/filter/branch
// StepFns only ever see `ElementStream`. The union lives at the ORCHESTRATION layer, never
// inside a StepFn.

import { type Relation } from '../q.ts';
import { type Elem } from '../plan.ts';
import { type ValueType } from '../render.ts';
import { carriedCols, type Carry, type ElementStream } from './context.ts';

/** What a list stream holds — i.e. the shape `unfold` produces from it. `elem` → bare
 *  rowids (rejoin nodes/edges on unfold) → a fresh `ElementStream`; `scalar` → typed scalars → a
 *  `ScalarStream`; `list` → nested lists (list-of-lists, e.g. select(Column.values) of a
 *  list-valued map) → a ListStream of the inner shape. ('entry' reserved for Map-unfold.) */
export type ListOf =
  | { kind: 'elem'; elem: Elem }
  | { kind: 'scalar'; as?: ValueType }
  | { kind: 'list'; of: ListOf };

/** A stream of scalars in a one-column relation `v` (values/id/label/inject/unfold-
 *  of-scalars). `as` is the compile-time GraphBinary type tag (render.ts ValueType). */
export interface ScalarStream extends Carry {
  readonly kind: 'scalar';
  readonly rel: Relation;
  readonly as?: ValueType;
  /** Root framing semantics carried by the reducer, rather than reconstructed from
   * where the stream happens to become terminal. */
  readonly result?: 'value' | 'count';
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

/** A map value as a `(mk, mv)` row relation — one row per entry (group()/groupCount()
 *  retyped when a follower consumes it: select(Column.values/keys) aggregates a column
 *  into a list; Map-unfold explodes entries). `keyOf`/`valOf` describe each column so
 *  the derived list knows whether to rejoin elements. A TERMINAL group() never becomes
 *  a MapStream — it stays the row-folding groupBuffer path (byte-identical). */
export interface MapStream extends Carry { readonly kind: 'map'; readonly rel: Relation; readonly keyOf: MapOf; readonly valOf: MapOf; }

/** The traverser stream shapes a compile phase can be in. */
export type Stream = ElementStream | ScalarStream | ListStream | MapStream;

/** The physical relation columns promised by a stream. Payload comes first, followed
 * by the stable carried schema. A stream is executable relational state, so metadata
 * may never claim a column that its Relation does not expose. */
export function streamColumns(s: Stream): readonly string[] {
  const payload = s.kind === 'elements' ? ['id']
    : s.kind === 'scalar' ? ['v']
    : s.kind === 'list' ? ['list']
    : ['mk', 'mv'];
  return [...payload, ...carriedCols(s.carried)];
}

/** Development/test guard for the physical stream contract. Relation.cols is the
 * declared CTE layout, so checking it here catches missing or reordered carried
 * columns before SQLite turns the mismatch into corrupt traversal state. */
export function assertStreamColumns<T extends Stream>(s: T): T {
  const expected = streamColumns(s);
  const actual = s.rel.cols;
  if (expected.length !== actual.length || expected.some((col, i) => col !== actual[i]))
    throw new Error(`${s.kind} stream column mismatch: expected [${expected.join(', ')}], got [${actual.join(', ')}]`);
  return s;
}

/** Project a stream's shape-independent state (for building the next phase's stream). */
export const carryOf = (s: Stream): Carry =>
  ({ q: s.q, params: s.params, sideEffects: s.sideEffects, carried: s.carried });

export const toScalarStream = (c: Carry, rel: Relation, as?: ValueType, result: ScalarStream['result'] = 'value'): ScalarStream =>
  assertStreamColumns({ ...c, kind: 'scalar', rel, as, result });
export const toListStream = (c: Carry, rel: Relation, of: ListOf): ListStream =>
  assertStreamColumns({ ...c, kind: 'list', rel, of });
export const toMapStream = (c: Carry, rel: Relation, keyOf: MapOf, valOf: MapOf): MapStream =>
  assertStreamColumns({ ...c, kind: 'map', rel, keyOf, valOf });

/** A map key/value column's shape → the list shape it produces when select(Column.*)
 *  aggregates it: a scalar carries its type tag, an element rejoins on unfold, a
 *  list-valued column becomes a list-of-lists (one nesting level deeper). */
export const mapOfToListOf = (m: MapOf): ListOf =>
  m.kind === 'elem' ? { kind: 'elem', elem: m.elem } : m.kind === 'list' ? { kind: 'list', of: m.of } : { kind: 'scalar', as: m.as };
