// ---------- Gremlin ORDERABILITY, in JS — the value-transform barrier's comparator ----------
//
// A faithful transcription of `GremlinValueComparator.ORDERABILITY`
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java`)
// — the total order `order(Scope.local)` sorts by and `dedup(Scope.local)` collapses on. It runs in the
// SYNC value-transform barrier (`barrier-value.ts`), the SAME escape-to-JS `reverse()`/`split()`/regex use:
// the reference comparator is RECURSIVE (a list orders element-wise, a set/map sorts its members first),
// which JS expresses directly and recursion-free SQL cannot. We reproduce it here rather than call it
// because the GLV is remote-only (it never sorts — ordering is server-side), so there is no JS comparator
// to reuse; this IS that comparator, checked against the vendored Java it copies.
//
// It reads the member encodings the barrier delivers after a `jsonbList` head is `JSON.parse`d
// (`execute.ts` readSegmentHead): a BARE scalar (`3`, `"marko"` — a fold of untyped members) and a
// self-describing `{t,v}` NODE (a typed member). The ELEMENT-member case (an expanded vertex object) is
// handled ONLY at framing depth for completeness — the order/dedup BARRIER declines an element-membered
// nested list (`order-dedup-local.ts`), because a post-barrier element has lost its rowid and cannot
// re-enter the graph; so in practice this comparator sees scalars and typed nodes.

/** ORDERABILITY's type-priority ladder (`Type` enum order). A cross-type compare is decided by these
 *  alone; same-type falls to the per-type comparator below. */
const PRIORITY = {
  null: 0, boolean: 1, number: 2, date: 3, string: 4, uuid: 5,
  vertex: 6, edge: 7, vertexproperty: 8, property: 9, path: 10,
  set: 11, list: 12, map: 13, mapentry: 14, unknown: 15,
} as const;
type Kind = keyof typeof PRIORITY;

/** The Gremlin vtypes that map to `Type.Number` — a numeric compare, not the lexical `naturalOrder`. */
const NUMERIC = new Set(['byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal']);

/** The kind of a delivered member — off its `{t}` tag where it has one, else inferred from the JS value
 *  (a bare fold member), the same inference `frameTypedNode` does for an untagged member. An ELEMENT object
 *  is recognised by its `id`+`label` shape (never a `{t,v}` node). */
function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || typeof v === 'bigint') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('t' in o && 'v' in o) {
      const t = o.t as string;
      if (t === 'vertex' || t === 'edge') return t;
      if (t === 'set' || t === 'list' || t === 'map') return t;
      if (t === 'boolean') return 'boolean';
      if (t === 'string' || t === 'char') return 'string';
      if (t === 'datetime') return 'date';
      if (t === 'uuid') return 'uuid';
      if (NUMERIC.has(t)) return 'number';
      return 'unknown';
    }
    // An expanded ELEMENT (`{id,label,props}`) — `out().fold()` inside a map value.
    if ('id' in o && 'label' in o) return Array.isArray((o as { label: unknown }).label) ? 'vertex' : 'edge';
    return 'unknown';
  }
  return 'unknown';
}

/** The comparable PAYLOAD of a member — the value its per-type comparator reads. A `{t,v}` node unwraps to
 *  `v`; an element to its id; a bare value is itself. */
function payload(v: unknown, k: Kind): unknown {
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('t' in o && 'v' in o) return o.v;
    if ((k === 'vertex' || k === 'edge') && 'id' in o) return o.id;
  }
  return v;
}

const cmpNumber = (a: unknown, b: unknown): number => {
  const x = typeof a === 'bigint' ? a : Number(a);
  const y = typeof b === 'bigint' ? b : Number(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

const cmpNatural = (a: unknown, b: unknown): number => {
  const x = a as string | number;
  const y = b as string | number;
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Two iterables compared element-wise, the shorter-as-prefix sorting first — `iterableComparator`. */
function cmpIterable(a: readonly unknown[], b: readonly unknown[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = orderabilityCompare(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

/** A set/map member is order-INDEPENDENT, so both sides sort by ORDERABILITY before the element-wise
 *  compare (`setComparator`/`mapComparator`). The members are already the raw arrays a `set`/`map` node
 *  carries (`v`), so this reads them one container in. */
function cmpUnordered(a: readonly unknown[], b: readonly unknown[]): number {
  const l1 = [...a].sort(orderabilityCompare);
  const l2 = [...b].sort(orderabilityCompare);
  return cmpIterable(l1, l2);
}

/**
 * The ORDERABILITY total order over two delivered members. Cross-type → the priority ladder; same type →
 * the per-type comparator, recursing for collections. This is `ORDERABILITY.compare`'s two lines
 * (`ft != st ? ft.priority() - st.priority() : comparator(ft).compare(f, s)`) with the comparator table
 * inlined.
 */
export function orderabilityCompare(f: unknown, s: unknown): number {
  const fk = kindOf(f);
  const sk = kindOf(s);
  if (fk !== sk) return PRIORITY[fk] - PRIORITY[sk];
  const fp = payload(f, fk);
  const sp = payload(s, sk);
  switch (fk) {
    case 'null': return 0;
    case 'number': return cmpNumber(fp, sp);
    case 'boolean': case 'date': case 'string': case 'uuid': return cmpNatural(fp, sp);
    // An element/property orders by its id — `Comparator.comparing(Element::id, this)`.
    case 'vertex': case 'edge': case 'vertexproperty': case 'property': return orderabilityCompare(fp, sp);
    case 'list': return cmpIterable(fp as unknown[], sp as unknown[]);
    case 'set': case 'map': return cmpUnordered(fp as unknown[], sp as unknown[]);
    // Unknown: only naturally-comparable values have an order; otherwise treat as equal (stable).
    default: return typeof fp === typeof sp && (typeof fp === 'number' || typeof fp === 'string') ? cmpNatural(fp, sp) : 0;
  }
}

/** ORDERABILITY equality — `dedup(Scope.local)`'s member identity (`DedupLocalStep`'s `LinkedHashSet`,
 *  first occurrence wins). Two members are equal iff they compare 0 under the total order. */
export const orderabilityEqual = (a: unknown, b: unknown): boolean => orderabilityCompare(a, b) === 0;

/** `order(Scope.local)` (identity comparator) over one list: a STABLE sort by ORDERABILITY. A non-list
 *  passes through (`OrderLocalStep.map` returns a non-Collection start unchanged). */
export function orderLocalValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  // Stable: decorate with the original index and break ties by it (Array.prototype.sort is not
  // guaranteed stable across every member count on every engine, and the reference keeps input order
  // on ties — `Collections.sort` is stable).
  return value
    .map((v, i) => [v, i] as const)
    .sort((a, b) => orderabilityCompare(a[0], b[0]) || a[1] - b[1])
    .map(([v]) => v);
}

/** `dedup(Scope.local)` over one list: FIRST occurrence wins, surviving order preserved
 *  (`DedupLocalStep`'s `LinkedHashSet`). O(n²) on the member count, which is fine for a local list. */
export function dedupLocalValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const kept: unknown[] = [];
  for (const v of value) if (!kept.some((k) => orderabilityEqual(k, v))) kept.push(v);
  return kept;
}
