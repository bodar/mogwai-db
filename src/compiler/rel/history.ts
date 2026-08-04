import { lit, type Expr } from '../../rel/expr.ts';
import type { ListOf, ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';
import { SHAPE_K, elemShape, type AliasShape } from '../steps/context/alias.ts';

/**
 * ONE TRAVERSER-OBJECT HISTORY ENCODING, shared by the LABEL channel and the PATH channel.
 *
 * A history is a JSONB array of tagged entries, appended to as the traverser moves. It exists once rather
 * than twice because `as('a')` and a tracked `path()` ask the identical question — *remember the object this
 * traverser is on, cheaply, so a later step can read it back* — and TinkerPop says so outright: a label
 * history IS a `Path` (`select(Pop.first/last/all)` reads positions off one), and our path is a history whose
 * label is the traverser itself. It was `alias.ts`-private while only labels had a producer; the path channel
 * is the second consumer, and the alternative was the same three expressions written twice.
 *
 * The TAG is what makes one array hold objects of different shapes — a vertex, an edge, a scalar value with
 * its type, a folded list — so neither channel needs a per-position descriptor and a heterogeneous history is
 * not a special case. `SHAPE_K` is IMPORTED from the legacy encoding rather than restated: the tag numbers are
 * DATA, and a second copy of them is a second chance for the two spines to drift silently (§10·8 — share data
 * and pure computation, re-express only the emission). What IS re-expressed here is the emission — legacy
 * builds `q` templates, this builds `Expr` nodes.
 */

/** What one history position holds. A value carries its type through the entry's own `t` field,
 * which is the only place a per-row `vtype` column can survive becoming JSON. */
export type TraverserObject =
  | { readonly kind: 'element'; readonly elem: Elem; readonly id: Expr }
  | { readonly kind: 'value'; readonly value: Expr; readonly type: ScalarType; readonly vtype?: Expr }
  | { readonly kind: 'list'; readonly list: Expr; readonly of: ListOf };

export const shapeOf = (object: TraverserObject): AliasShape =>
  object.kind === 'element' ? elemShape(object.elem) : object.kind === 'list' ? 'list' : 'value';

/**
 * ONE tagged history entry — `jsonb_object('k', <k>, 'v', <value>[, 't', <type>])`.
 *
 * A list's payload goes through `json()` so SQLite stores it AS json rather than as a quoted string.
 */
export const objectEntry = (object: TraverserObject): Expr => {
  const k = lit(SHAPE_K[shapeOf(object)], 'int');
  if (object.kind === 'element')
    return { kind: 'json-object', entries: [['k', k], ['v', object.id]], binary: true };
  if (object.kind === 'list')
    return {
      kind: 'json-object', binary: true,
      entries: [['k', k], ['v', { kind: 'call', fn: 'json', args: [object.list] }]],
    };
  // A STATIC tag is a compile-time string; a PER-ROW one is the stream's own `vtype` column. An
  // unknown type has nothing honest to record, so the entry carries no tag and readers infer it.
  const tag = object.type.kind === 'static' ? lit(object.type.type, 'text') : object.vtype;
  return {
    kind: 'json-object', binary: true,
    entries: [['k', k], ['v', object.value], ...(tag ? [['t', tag] as const] : [])],
  };
};

/** A one-position history (array-ALWAYS, even for one object). */
export const historySeed = (entry: Expr): Expr => ({ kind: 'json-array', items: [entry], binary: true });

/**
 * Append an entry while referencing `prev` exactly once, so fused Projects do not duplicate the
 * re-inlined history expression at every hop. `COALESCE` keeps the operation total on NULL, and the
 * binary zero-item JSON array spells the empty history without consuming a bind parameter.
 */
export const historyAppend = (prev: Expr, entry: Expr): Expr => ({
  kind: 'call', fn: 'jsonb_insert', args: [
    {
      kind: 'call', fn: 'COALESCE',
      args: [prev, { kind: 'json-array', items: [], binary: true }],
    },
    lit('$[#]', 'text'), entry,
  ],
});
