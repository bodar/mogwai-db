// ---------- the traverser stream model (list-value substrate) ----------
//
// A traversal's state has more than one SHAPE. The prefix fold works on an
// id-relation of elements (`St`, context.ts). A projection/inject produces a stream
// of scalars. `fold()` produces a single list value. Historically the tail was
// strictly terminal, so these value shapes had nowhere to go; the `Stream` union +
// the dispatcher (index.ts `dispatchNext`) make the tail RE-ENTERABLE — a step can
// retype the stream (fold: elements→list, unfold: list→elements/scalar) and keep
// compiling. Each arm shares `Carry` (context.ts) so a retype preserves the query
// builder / params / aliases / path.
//
// CRITICAL: `St.elem` stays 'node'|'edge' only, and the 20+ movement/filter/branch
// StepFns only ever see `St`. The union lives at the ORCHESTRATION layer, never
// inside a StepFn.

import { type Relation } from '../q.ts';
import { type Elem } from '../plan.ts';
import { type ValueType } from '../render.ts';
import { type Carry, type St } from './context.ts';

/** What a list stream holds — i.e. the shape `unfold` produces from it. A one-field
 *  description: `elem` → bare rowids (rejoin nodes/edges on unfold) → a fresh `St`;
 *  `scalar` → typed scalars → a `ScalarStream`. ('entry' reserved for Map-unfold.) */
export type ListOf =
  | { kind: 'elem'; elem: Elem }
  | { kind: 'scalar'; as?: ValueType };

/** A stream of scalars in a one-column relation `v` (values/id/label/inject/unfold-
 *  of-scalars). `as` is the compile-time GraphBinary type tag (render.ts ValueType). */
export interface ScalarStream extends Carry { readonly kind: 'scalar'; readonly rel: Relation; readonly as?: ValueType; }

/** A single list value in a one-row relation with a JSONB `list` column (fold /
 *  inject-of-a-list / select(Column.values)), plus any carried columns. `of` says
 *  what the list holds so unfold/framing knows how to explode it. */
export interface ListStream extends Carry { readonly kind: 'list'; readonly rel: Relation; readonly of: ListOf; }

/** The three traverser stream shapes a compile phase can be in. */
export type Stream = St | ScalarStream | ListStream;

/** Project a stream's shape-independent state (for building the next phase's stream). */
export const carryOf = (s: Stream): Carry =>
  ({ q: s.q, aliases: s.aliases, indexKeys: s.indexKeys, params: s.params, path: s.path, origin: s.origin, sack: s.sack, sideEffects: s.sideEffects });

export const toScalarStream = (c: Carry, rel: Relation, as?: ValueType): ScalarStream => ({ ...c, kind: 'scalar', rel, as });
export const toListStream = (c: Carry, rel: Relation, of: ListOf): ListStream => ({ ...c, kind: 'list', rel, of });
