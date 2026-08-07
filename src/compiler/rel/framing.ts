import type { ListOf, MapOf, ScalarType } from '../../sql/kernel/render.ts';
import type { Elem } from '../plan/plan.ts';

// ---------- what the framing layer must build over a result relation ----------
//
// The shape half of a lowering, in its own leaf so that everything which PRODUCES a relation for the
// fold can name it without reaching into `lower.ts`. That is not a tidiness move: `lower.ts` is the
// fold itself, so a producer that lives outside it — a service contributing a `call()` result — would
// otherwise have to import the fold while the fold imports the producer's type. This module is the
// bottom of that DAG: it imports only `render.ts` and `Elem`, and nothing imports it back.
//
// **It stays INTERNAL to the fold, and that boundary is unchanged by living here.** What crosses to
// `execute.ts` is a `Shape` (`RelLowering.shape`), because the byte framers need exactly one fact and
// the plan's result relation IS the rows they frame. `RelFraming` is the larger question — an arm
// merge and a retype need to know what a relation HOLDS (member encodings, key/value sides, the
// scalar type channel) — so two vocabularies for two questions. The thing that rule guards against is
// concrete and was measured: the translator that used to cross that boundary (`layoutOf`/
// `LAYOUT_FIELD`, `Channels`→`TraverserLayout`) needed a case per channel role and THREW when it
// lacked one, which is what blocked the path channel.

/**
 * WHAT THE FRAMING LAYER MUST BUILD over the result relation — the shape half of a lowering.
 *
 * Shape does not enter the NODE SET (§2) — but this LOWERING both knows it and says so, which is what
 * `RelFraming` is. A lowering hands back a relation plus the minimum needed to build that relation's
 * payload projection and pick its `Shape`. Deliberately a union rather than a widened record: an element
 * stream has no scalar type and a scalar stream has no element kind, and pretending otherwise is how a
 * shape vocabulary starts leaking into `src/rel/`, which is the boundary that matters.
 *
 * It grows one arm per stream kind the spine learns, and every consumer switches on it TOTALLY, so a
 * shape this route learns to produce is a compile error until its projection and its `Shape` are
 * declared. Per §10·10 that projection belongs here rather than in legacy's materializer.
 */
export type RelFraming =
  | { readonly kind: 'elements'; readonly elem: Elem }
  | { readonly kind: 'scalar'; readonly type: ScalarType; readonly result?: 'value' | 'count' | 'number' }
  /** A traverser whose VALUE is a collection — one JSONB `list` column per row (§ the list
   *  vocabulary, `list.ts`). `of` describes the MEMBER encoding, which is what the framing layer
   *  needs to know how to expand each one; `set` is a framing marker only (a SET frames differently,
   *  the member substrate is shared). */
  | { readonly kind: 'list'; readonly of: ListOf; readonly set?: boolean }
  /** A traverser whose value is a PATH — the LIST arm's relation exactly (one JSONB `list` column of
   *  typed-tree positions), and only the wire form differs (`framePath` over the same per-member buffers).
   *  `scalars` says every position is a `by()`-projected value rather than an element, which is what decides
   *  whether the path may RE-ENTER the list vocabulary: a member op decodes to a scalar stream, and that
   *  stream has no element arm (see `pathPositions`). It is a required field, not an optional marker — a
   *  path always knows the answer, and defaulting it either way is how a wrong shape gets framed. */
  | { readonly kind: 'path'; readonly of: ListOf; readonly scalars: boolean }
  /** A traverser whose VALUE is a MAP — one JSONB `map` column per row holding an ordered
   *  `[[keyNode, valNode], …]` pairs array, which is the same self-describing tree a stored map
   *  property uses. The LIST arm's twin, deliberately: `keyOf`/`valOf` describe each side's shape for
   *  the framing layer exactly as `of` does for a list, and a pairs ARRAY rather than a JSON object is
   *  what keeps the entry order ours to state and lets a key be something other than a string. */
  | { readonly kind: 'map'; readonly keyOf: MapOf; readonly valOf: MapOf }
  /** A traverser that IS a property — `properties()`, not `values()`. A VertexProperty on a vertex
   *  (its own id, its own meta-properties) and a Property on an edge, which is neither an Element
   *  nor able to carry meta; `ownerElem` is what decides that, and it is required because the two
   *  differ in the payload's columns rather than only in their values. */
  | { readonly kind: 'property'; readonly ownerElem: Elem }
  /** NOTHING to frame. A write whose Gremlin result is no traverser at all (`drop()`, and `iterate()`
   *  over any of them) ends on a statement with an empty `RETURNING`, so the plan's result relation
   *  has no columns and there is no shape to interpret. It is an arm of this union rather than an
   *  absent framing because `spine.ts` switches TOTALLY: "there is nothing here" has to be something
   *  the lowering can SAY. */
  | { readonly kind: 'discard' };
