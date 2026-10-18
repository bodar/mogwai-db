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

import { exactNumberOf, isExactNumber } from '../../json-exact.ts';
import { RaisedByQuery } from '../../rel/raise.ts';
import { bigDecimalOfCarrier } from '../../gremlin/float.ts';

/** A Double/Float as text — SQLite's own text of the REAL (`CAST(r AS TEXT)`, i.e. `printf('%!.15g')`), so
 *  a value inside a list prints exactly as the same value does alone (`asStringOf`, `receiver.ts`): 15
 *  significant digits, trailing zeros dropped but a `.0` kept, exponent form below 1e-4 or from 1e15
 *  (`1.0e-05`, `1.0e+20`), `Inf` for an infinity. Not Java's `Double.toString` — a deliberate divergence. */
const floatingString = (d: number): string => {
  if (!Number.isFinite(d)) return Number.isNaN(d) ? 'NaN' : d > 0 ? 'Inf' : '-Inf';
  if (d === 0) return '0.0';
  const [mantissa, e] = d.toExponential(14).split('e') as [string, string];
  const exp = Number(e);
  const sign = d < 0 ? '-' : '';
  const digits = mantissa.replace(/[-.]/g, '').replace(/0+$/, '');
  if (exp < -4 || exp > 14)
    return `${sign}${digits[0]}.${digits.slice(1) || '0'}e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  const point = exp + 1;
  const whole = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0');
  const fraction = point < 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  return `${sign}${whole}.${fraction || '0'}`;
};

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
  // A bare number that is not whole can only be a Double.
  if (typeof node === 'number') return Number.isInteger(node) ? String(node) : floatingString(node);
  if (typeof node === 'bigint' || typeof node === 'boolean') return String(node);
  // A number past 2^53 the barrier read exactly (`parseExactJson`, `json-exact.ts`): a `Long` prints its
  // exact decimal text, a `Double` its floating text.
  if (isExactNumber(node)) {
    const { integral, text } = exactNumberOf(node);
    return integral ? text : floatingString(Number(text));
  }
  if (Array.isArray(node)) return `[${node.map(gremlinString).join(', ')}]`;
  if (typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('t' in o && 'v' in o) {
      const t = o.t as string;
      if (t === 'list' || t === 'set') return `[${(o.v as unknown[]).map(gremlinString).join(', ')}]`;
      if (t === 'map') return mapString(o.v as unknown[]);
      if (t === 'vertex' || t === 'edge') return elementString(o.v as Record<string, unknown>);
      // A leaf renders BY ITS TAG, not its storage: a Boolean rides as 0/1 (`Boolean.toString` is
      // `true`/`false`), and a Date/Duration as epoch millis, whose `OffsetDateTime`/`Duration.toString`
      // this renderer does not reproduce — a deferral, never the millis as if they were the answer.
      if (t === 'boolean') return o.v === null ? 'null' : o.v === 0 || o.v === false ? 'false' : 'true';
      if ((t === 'datetime' || t === 'duration') && o.v !== null)
        throw new RaisedByQuery('asString() of a Date or Duration value is not supported yet');
      // A Double or Float is its floating text whatever it was stored as — a Double held
      // whole (the INTEGER 1) is `1.0`.
      // A BigDecimal is the plain decimal text of the value its carrier IS, scale included
      // (`bigDecimalOfCarrier`) — as the SQL rendering prints a carried decimal, never Java's `1.0E-7`.
      if (t === 'bigdecimal' && o.v !== null) return bigDecimalOfCarrier(o.v as string).toString();
      if ((t === 'double' || t === 'float') && o.v !== null) return floatingString(Number(isExactNumber(o.v) ? exactNumberOf(o.v).text : o.v));
      return gremlinString(o.v); // a scalar leaf (string/number/datetime/…) — its own value string
    }
    // An expanded ELEMENT (`{id,label,props[,src,tgt]}`) — a folded vertex/edge member.
    if ('id' in o && 'label' in o) return elementString(o);
    return String(node);
  }
  return String(node);
}
