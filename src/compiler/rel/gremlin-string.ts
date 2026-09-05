// ---------- asString() over a non-scalar — Java's toString, in JS (the value-transform barrier) ----------
//
// `asString()` is `String.valueOf(object)` (`AsStringGlobalStep`/`AsStringLocalStep`), and over a
// COLLECTION or an ELEMENT that is the object's `toString()`. SQL cannot compose those renderings — a
// map's `{k=[v]}`, a list's `[a, b]`, a vertex's `v[id]` — so, like `reverse()`/`split()`/order, it runs
// in the SYNC value-transform barrier (`barrier-value.ts`), reading the member encodings the barrier
// delivers after a `jsonbList`/`mapValue` head is `JSON.parse`d (`execute.ts` readSegmentHead): a BARE
// scalar, a self-describing `{t,v}` NODE, an expanded ELEMENT object (`{id,label,props[,src,tgt]}`), and
// a map's PAIRS array (`[[keyNode,valNode],…]`).
//
// The formats are `StringFactory`'s
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/util/StringFactory.java`)
// and Java's collection `toString` (`AbstractCollection`/`AbstractMap`: `[a, b]`, `{k=v}`, comma-SPACE
// separators). Where a JS rendering diverges from Java's — a whole-number double is `29` here and `29.0`
// there — that is an allowed semantic-equivalence deviation, not a defect (the element/scalar/string/list
// forms the corpus exercises are exact).

/** A vertex `v[<id>]`, an edge `e[<id>][<src>-<label>-><tgt>]` — `StringFactory.vertexString`/`edgeString`,
 *  off an expanded element object whose ids are already the OUTWARD ids. An edge is the one carrying
 *  endpoints; a vertex's multi-label array plays no part in its `toString`. */
function elementString(o: Record<string, unknown>): string {
  if ('src' in o && 'tgt' in o) {
    const label = Array.isArray(o.label) ? (o.label as unknown[]).join('::') : String(o.label);
    return `e[${String(o.id)}][${String(o.src)}-${label}->${String(o.tgt)}]`;
  }
  return `v[${String(o.id)}]`;
}

/** A map's `{k1=v1, k2=v2}` from its pairs array — `AbstractMap.toString`, each side rendered by the same
 *  recursion, comma-SPACE separated. */
function mapString(pairs: readonly unknown[]): string {
  const entries = pairs.map((pair) => {
    const [k, v] = pair as [unknown, unknown];
    return `${gremlinString(k)}=${gremlinString(v)}`;
  });
  return `{${entries.join(', ')}}`;
}

/**
 * ONE delivered member (or whole traverser) → its Java `String.valueOf`, recursing through collections.
 *
 * The dispatch is the delivered vocabulary: a bare JS scalar is its own string, a `{t,v}` node renders by
 * its tag (a collection recurses, a leaf unwraps to `v`), an expanded element is its `StringFactory`
 * rendering, and a bare array is `[a, b]`. A map arrives EITHER as a `{t:'map', v:pairs}` node (a list
 * member) or, from a `mapValue` head, as the pairs array itself — the caller wraps the latter, so both
 * reach `mapString` and a bare pairs array is never mistaken for a plain list.
 */
export function gremlinString(node: unknown): string {
  if (node === null || node === undefined) return 'null';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'bigint' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return `[${node.map(gremlinString).join(', ')}]`;
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('t' in o && 'v' in o) {
      const t = o.t as string;
      if (t === 'list' || t === 'set') return `[${(o.v as unknown[]).map(gremlinString).join(', ')}]`;
      if (t === 'map') return mapString(o.v as unknown[]);
      if (t === 'vertex' || t === 'edge') return elementString(o.v as Record<string, unknown>);
      return gremlinString(o.v); // a scalar leaf (string/number/datetime/…) — its own value string
    }
    // An expanded ELEMENT (`{id,label,props[,src,tgt]}`) — a folded vertex/edge member.
    if ('id' in o && 'label' in o) return elementString(o);
    return String(node);
  }
  return String(node);
}
