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
// (`execute.ts` readSegmentHead): a BARE scalar (`3`, `"marko"` — a fold of untyped members), a
// self-describing `{t,v}` NODE (a typed member), and — for an element-membered nested list — the element's
// bare ROWID (an integer), because the `order`/`dedup(Scope.local)` barrier carries element members as raw
// rowids and materializes only at the edge (`order-dedup-local.ts`, `rawListElements`). A rowid compares as
// a plain number, which IS the flat-case element convention (`Comparator.comparing(Element::id)`, sorting
// by rowid). The expanded-object case (`{id,label,props}`) can still arrive from an `out().fold()` inside a
// map VALUE and is handled for completeness.

import { UnsupportedTraversal } from '../compiler.ts';
import { exactNumberOf, isExactNumber, parseExactJson } from '../../json-exact.ts';
import { RaisedByQuery } from '../../rel/raise.ts';

/** ORDERABILITY's type-priority ladder (`Type` enum order). A cross-type compare is decided by these
 *  alone; same-type falls to the per-type comparator below. */
const PRIORITY = {
  null: 0, boolean: 1, number: 2, date: 3, string: 4, uuid: 5,
  vertex: 6, edge: 7, vertexproperty: 8, property: 9, path: 10,
  set: 11, list: 12, map: 13, mapentry: 14, unknown: 15,
} as const;
type Kind = keyof typeof PRIORITY;

/** The tags that map to `Type.Number` — a numeric compare, not the lexical `naturalOrder`. The Gremlin
 *  vtypes, plus SQLite's own storage classes `integer`/`real`, which a member tagged by its storage class
 *  carries and `frameTypedNode` frames as a `Long`/`Double` — so they are numbers here too, never the
 *  `unknown` rung (which compared a wide sum's decimal TEXT lexically and ranked every sum after every
 *  `int`). A reducer's own `vt` is a Gremlin type name (`reducer.ts` `REDUCED_TYPE`). */
const NUMERIC = new Set(['byte', 'short', 'int', 'long', 'bigint', 'float', 'double', 'bigdecimal', 'integer', 'real']);

/** The kind of a delivered member — off its `{t}` tag where it has one, else inferred from the JS value
 *  (a bare fold member), the same inference `frameTypedNode` does for an untagged member. An ELEMENT object
 *  is recognised by its `id`+`label` shape (never a `{t,v}` node). */
function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number' || typeof v === 'bigint' || isExactNumber(v)) return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('t' in o && 'v' in o) {
      // A typed NULL leaf (`{t:'double', v:null}` — a non-productive typed value) is a null: ORDERABILITY's
      // `Type.Null` rung, never a number with no value.
      if (o.v === null) return 'null';
      const t = o.t as string;
      if (t === 'vertex' || t === 'edge') return t;
      if (t === 'set' || t === 'list' || t === 'map') return t;
      if (t === 'boolean') return 'boolean';
      if (t === 'string' || t === 'char') return 'string';
      if (t === 'datetime') return 'date';
      if (t === 'uuid') return 'uuid';
      if (NUMERIC.has(t)) return 'number';
      // A `T`/`Direction` TOKEN is a Java enum — none of the ladder's classes, so `Type.Unknown`
      // (`GremlinValueComparator.java:243-255`, `type()` falls through to `Object.class`).
      if (t in TOKEN_ORDINALS) return 'unknown';
      throw unclassified(`a '${t}' member`);
    }
    // An expanded ELEMENT (`{id,label,props}`) — `out().fold()` inside a map value.
    if ('id' in o && 'label' in o) return Array.isArray((o as { label: unknown }).label) ? 'vertex' : 'edge';
  }
  throw unclassified('a member of no recognised encoding');
}

/**
 * The tokens whose `Type.Unknown` order this comparator CAN state, in DECLARATION order — `T` is
 * `label, id, key, value`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/T.java:36-84`),
 * `Direction` is `OUT, IN, BOTH` (`.../structure/Direction.java:42-56`). Lexical order is NOT that (`id`
 * would sort before `label`); `tokenClass` says how the two enums interleave.
 */
const TOKEN_ORDINALS: Readonly<Record<string, readonly string[]>> = {
  T: ['label', 'id', 'key', 'value'],
  D: ['OUT', 'IN', 'BOTH'],
};

/** The decline for a member ORDERABILITY cannot place on its ladder — an `UnsupportedTraversal`, never a
 *  silent tie (a tie keeps arrival order, which is a plausible WRONG order) and never an invented rung. */
const unclassified = (what: string): UnsupportedTraversal =>
  new UnsupportedTraversal(`an ORDERABILITY comparison of ${what}, whose GremlinValueComparator type this comparator cannot classify`);

/**
 * A member with its UNTAGGED envelope removed. A `{t:null, v}` node is a value whose producer did not
 * know its type (a computed group KEY — `group().by(__.coalesce(__.values('age').sum(), __.values('name')))`
 * writes `{t:null, v:27}` and `{t:null, v:'lop'}` side by side), and the null tag means exactly what it
 * means to the framer: infer from `v` (`execute.ts` `frameTypedNode`, the `tag == null` arm). So the
 * comparator classifies `v` as the BARE member it is — the same inference a bare fold member gets —
 * rather than sending the node to a rung of its own.
 */
function untagged(v: unknown): unknown {
  let member = v;
  while (member !== null && typeof member === 'object' && !Array.isArray(member) && !isExactNumber(member)) {
    const o = member as Record<string, unknown>;
    if (!('t' in o && 'v' in o) || o.t != null) break;
    member = o.v;
  }
  return member;
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

/**
 * A numeric member as `NumberHelper` sees it: its CLASS (the width `getHighestCommonNumberInfo` reads —
 * `bits`, and whether it is floating point) and its value, EXACT. A wide integer (a `long` past 2^53, a
 * `bigint`) and a `bigdecimal` ride as decimal TEXT precisely because a JS number cannot hold them
 * (`build.ts` `jsonMember`), so they stay text here and compare by `BigInt`/exact decimal — never through
 * `Number`, which would round `9007199254740993` onto `9007199254740992` and call two different longs
 * equal. A BARE member carries no tag, so it takes the class `frameValue` would frame it as (an integral
 * value a `Long`, else a `Double`).
 */
interface Numeric { readonly bits: 8 | 16 | 32 | 64 | 128; readonly fp: boolean; readonly value: number | bigint | string; }

const NUMERIC_CLASS: Record<string, Pick<Numeric, 'bits' | 'fp'>> = {
  byte: { bits: 8, fp: false }, short: { bits: 16, fp: false }, int: { bits: 32, fp: false }, long: { bits: 64, fp: false },
  bigint: { bits: 128, fp: false }, float: { bits: 32, fp: true }, double: { bits: 64, fp: true }, bigdecimal: { bits: 128, fp: true },
  // SQLite's storage classes — an INTEGER is an int64 (a `Long`), a REAL a binary64 (a `Double`).
  integer: { bits: 64, fp: false }, real: { bits: 64, fp: true },
};

function numeric(member: unknown): Numeric {
  if (typeof member === 'bigint') return { bits: 128, fp: false, value: member };
  // A number `parseExactJson` kept as its source text (`json-exact.ts`): an integral spelling is SQLite's
  // INTEGER — an int64, a `Long`, compared exactly off its decimal text — any other a `Double`.
  if (isExactNumber(member)) {
    const { integral, text } = exactNumberOf(member);
    return integral ? { bits: 64, fp: false, value: text } : { bits: 64, fp: true, value: Number(text) };
  }
  // A bare number is a `Long` while it is a SAFE integer, a `Double` while it is fractional or non-finite.
  // A bare INTEGRAL number past 2^53 is neither knowably: it is the rounding of either a `Long` an untyped
  // column carried (`jsonMemberByTypeof` leaves a wide integer bare — a `sum()` past 2^53, folded) or a
  // whole-valued `Double` (`math('_ * 1e18')`), and the two compare differently — two distinct Longs that
  // round together must NOT tie. A reader that still has the JSON TEXT resolves it (`parseExactJson`); one
  // reaching here has lost it, so this DECLINES rather than pick one.
  if (typeof member === 'number') {
    if (Number.isInteger(member) && !Number.isSafeInteger(member)) throw lostInteger(member);
    return { bits: 64, fp: !Number.isInteger(member), value: member };
  }
  const node = member as { t: string; v: unknown };
  // The tag names the class; a value kept as its source text compares from that text.
  const value = isExactNumber(node.v) ? node.v.rawJSON : node.v;
  if (typeof value !== 'number' && typeof value !== 'bigint' && typeof value !== 'string')
    throw new UnsupportedTraversal(`an ORDERABILITY comparison of a '${node.t}' member carrying no numeric value`);
  return { ...NUMERIC_CLASS[node.t]!, value };
}

/** An exact decimal `m · 10^e` — `BigDecimal`'s value, scale-free (`compareTo` ignores scale). */
interface Decimal { readonly m: bigint; readonly e: number; }

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

function decimalOf(text: string): Decimal {
  const match = DECIMAL.exec(text.trim());
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) throw new UnsupportedTraversal(`an ORDERABILITY comparison of '${text}', which is not a decimal number`);
  const fraction = match[3] ?? '';
  const m = BigInt(`${match[1]}${match[2]}${fraction}` || '0');
  return { m, e: Number(match[4] ?? 0) - fraction.length };
}

function cmpDecimal(a: Decimal, b: Decimal): number {
  const e = Math.min(a.e, b.e);
  const x = a.m * 10n ** BigInt(a.e - e);
  const y = b.m * 10n ** BigInt(b.e - e);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** A JS number that is the EXACT integer it claims — past 2^53 a bare one is already a rounding of some
 *  other value, and comparing the rounding would answer for a number nobody stored. */
function exactInteger(value: number | bigint | string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string') return BigInt(value.trim());
  if (!Number.isSafeInteger(value)) throw lostInteger(value);
  return BigInt(value);
}

/** The decline for an integer whose exact value was lost before this comparator saw it — an
 *  `UnsupportedTraversal` (a deferral, never an internal assertion), naming what could not be compared. */
const lostInteger = (value: number): UnsupportedTraversal =>
  new UnsupportedTraversal(`an ORDERABILITY comparison of the integer ${value}, whose exact value was rounded past 2^53 before it reached the comparator`);

const asDouble = (value: number | bigint | string): number => (typeof value === 'number' ? value : Number(value));

/** `Double.compare` / `Float.compare` — a TOTAL order where `-0.0 < 0.0` (NaN is settled before this). */
function cmpFloating(x: number, y: number): number {
  if (x < y) return -1;
  if (x > y) return 1;
  if (x === 0 && y === 0) return Object.is(x, -0) === Object.is(y, -0) ? 0 : Object.is(x, -0) ? -1 : 1;
  return 0;
}

/** A floating member's `BigDecimal` — `BigDecimal.valueOf(double)` for a double (its shortest decimal,
 *  which is JS's `String(number)`), `new BigDecimal(Float.toString(f))` for a float (the shortest decimal
 *  that rounds back to the same FLOAT — `NumberHelper.bigDecimalValue`). An infinity has no `BigDecimal`:
 *  Java's `valueOf` parses `Double.toString` (`"Infinity"`/`"-Infinity"`) and its `NumberFormatException`
 *  names the first non-numeric character, `I` either way — this raises that same message rather than
 *  inventing an order. */
function decimalOfFloating(value: number, bits: number): Decimal {
  if (!Number.isFinite(value)) throw new RaisedByQuery('Character I is neither a decimal digit number, decimal point, nor "e" notation exponential mark.');
  if (bits <= 32) {
    for (let p = 1; p <= 9; p++) {
      const text = value.toPrecision(p);
      if (Math.fround(Number(text)) === value) return decimalOf(text);
    }
  }
  return decimalOf(String(value));
}

const isNaNValue = (n: Numeric): boolean => n.fp && (typeof n.value === 'number' ? Number.isNaN(n.value) : String(n.value).trim() === 'NaN');

/**
 * `NumberHelper.compare` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java:670-681`):
 * NaN sorts after every number and equals NaN; otherwise both sides are compared in their HIGHEST COMMON
 * CLASS (`getHighestCommonNumberInfo`, `:362-390`, `determineNumberClass`, `:861-873`) — exact `long` /
 * `BigInteger` compare for integers, `Float.compare`/`Double.compare` once a float/double is involved
 * (so a long past 2^53 vs a double IS rounded, as Java rounds it), and exact `BigDecimal.compareTo` once
 * a `BigInteger` meets a floating member or a `BigDecimal` is involved (`bigDecimalValue`, `:851-859`).
 */
function cmpNumber(f: unknown, s: unknown): number {
  const a = numeric(f);
  const b = numeric(s);
  const an = isNaNValue(a);
  const bn = isNaNValue(b);
  if (an || bn) return an && bn ? 0 : an ? 1 : -1;
  const bits = Math.max(a.bits, b.bits);
  const fp = a.fp || b.fp;
  if (!fp) {
    const x = exactInteger(a.value);
    const y = exactInteger(b.value);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (bits <= 32) return cmpFloating(Math.fround(asDouble(a.value)), Math.fround(asDouble(b.value)));
  if (bits <= 64) {
    // A `long` widens to double by round-to-nearest — `Number(BigInt)` is that same rounding.
    const widen = (n: Numeric): number => (n.fp ? asDouble(n.value) : Number(exactInteger(n.value)));
    return cmpFloating(widen(a), widen(b));
  }
  const decimal = (n: Numeric): Decimal => {
    if (!n.fp) return { m: exactInteger(n.value), e: 0 };
    if (n.bits === 128) return decimalOf(String(n.value));
    return decimalOfFloating(asDouble(n.value), n.bits);
  };
  return cmpDecimal(decimal(a), decimal(b));
}

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
export function orderabilityCompare(first: unknown, second: unknown): number {
  const f = untagged(first);
  const s = untagged(second);
  const fk = kindOf(f);
  const sk = kindOf(s);
  if (fk !== sk) return PRIORITY[fk] - PRIORITY[sk];
  const fp = payload(f, fk);
  const sp = payload(s, sk);
  switch (fk) {
    case 'null': return 0;
    // The whole MEMBER, not its payload — the comparison class lives on the tag.
    case 'number': return cmpNumber(f, s);
    case 'boolean': case 'date': case 'string': case 'uuid': return cmpNatural(fp, sp);
    // An element/property orders by its id — `Comparator.comparing(Element::id, this)`.
    case 'vertex': case 'edge': case 'vertexproperty': case 'property': return orderabilityCompare(fp, sp);
    case 'list': return cmpIterable(fp as unknown[], sp as unknown[]);
    case 'set': case 'map': return cmpUnordered(fp as unknown[], sp as unknown[]);
    // Unknown: the only members `kindOf` lets onto this rung are TOKENS (`tokenClass`).
    default: {
      const a = tokenClass(f as { t: string }, fp);
      const b = tokenClass(s as { t: string }, sp);
      return a.name < b.name ? -1 : a.name > b.name ? 1 : a.ordinal - b.ordinal;
    }
  }
}

/**
 * A token's place under `unknownTypeComparator` (`GremlinValueComparator.java:223-226`): two members of
 * ONE class compare naturally — an enum by ordinal — and two of different classes by CLASS NAME (then
 * `toString`). `Direction`'s constants share its class. `T`'s do NOT: each constant has a body, so each is
 * its own anonymous class `T$1`…`T$4` in declaration order (`T.java:36-84`), which makes the class-name
 * compare agree with the ordinal one. Every `Direction` therefore sorts before every `T`
 * (`…structure.Direction` < `…structure.T$n`). An ordinal it does not know DECLINES.
 */
function tokenClass(node: { t: string }, value: unknown): { readonly name: string; readonly ordinal: number } {
  const ordinal = TOKEN_ORDINALS[node.t]!.indexOf(String(value));
  if (ordinal < 0) throw unclassified(`the token ${node.t}.${String(value)}`);
  return node.t === 'T'
    ? { name: `org.apache.tinkerpop.gremlin.structure.T$${ordinal + 1}`, ordinal }
    : { name: 'org.apache.tinkerpop.gremlin.structure.Direction', ordinal };
}

/** ORDERABILITY equality — `dedup(Scope.local)`'s member identity (`DedupLocalStep`'s `LinkedHashSet`,
 *  first occurrence wins). Two members are equal iff they compare 0 under the total order. */
export const orderabilityEqual = (a: unknown, b: unknown): boolean => orderabilityCompare(a, b) === 0;

/**
 * The value a value transform READS — the head's JSON `text` re-parsed by `parseExactJson` where the
 * barrier delivered one (`BarrierInput.injectedText`), else the value `readSegmentHead` already parsed.
 * The exact parse keeps a number past 2^53 as its source text (`json-exact.ts`), which ORDERABILITY
 * compares exactly AND which re-stringifies exactly — so a transform both decides and EMITS from it, and
 * the re-injected seed carries the number the traverser held. Off the plain parse, a `sum()` past 2^53,
 * folded, reached the comparator already rounded: two distinct Longs tied, `dedup(Scope.local)` merged
 * them, and the re-inject wrote the rounding back into the stream.
 */
export const exactOf = (value: unknown, text?: string): unknown => (text === undefined ? value : parseExactJson(text));

/** `items` STABLY sorted by `compare` — the original index breaks ties (`Array.prototype.sort` is not
 *  guaranteed stable across every member count on every engine, and the reference keeps input order on
 *  ties: `Collections.sort` is stable). */
function stableSort<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return items.map((item, i) => [item, i] as const).sort((a, b) => compare(a[0], b[0]) || a[1] - b[1]).map(([item]) => item);
}

/** `order(Scope.local)` (identity comparator) over one list: a STABLE sort by ORDERABILITY. A non-list
 *  passes through (`OrderLocalStep.map` returns a non-Collection start unchanged). */
export function orderLocalValue(value: unknown, text?: string): unknown {
  const list = exactOf(value, text);
  return Array.isArray(list) ? stableSort(list, orderabilityCompare) : value;
}

/** `order()` (GLOBAL, identity comparator) over a STREAM of values: a STABLE sort of the whole stream by
 *  ORDERABILITY. `orderLocalValue` sorts WITHIN one list; this reorders the TRAVERSER STREAM itself —
 *  each `values[i]` is one traverser's whole value (a list, compared to the others by `cmpIterable`), and
 *  the sorted array position becomes the emission order. Recursion-free SQL cannot express the recursive
 *  compare, so this runs in the SAME sync value-transform barrier `order(Scope.local)` uses, only over the
 *  whole stream rather than per row. Stable by an original-index tie-break, as the reference's
 *  `Collections.sort` is. `texts[i]` is `values[i]`'s head JSON text (`exactOf`). */
export function orderStreamValue(values: readonly unknown[], texts: readonly (string | undefined)[] = []): readonly unknown[] {
  return stableSort(values.map((value, i) => exactOf(value, texts[i])), orderabilityCompare);
}

/** `order()` (GLOBAL) over a STREAM OF MAPS. Each `maps[i]` is a map's PAIRS array `[[keyNode,valNode],…]`
 *  (`mapValue` head). A map orders by its SORTED ENTRY-SET compared element-wise (`mapComparator` —
 *  order-independent, each entry by key then value), which `orderabilityCompare` already does for a `map`
 *  node, so each pairs array is compared as a `{t:'map'}` node and the pairs themselves are what the
 *  re-inject seeds `MAP_COL` with. Stable, like `orderStreamValue`. */
export function orderMapStreamValue(maps: readonly unknown[], texts: readonly (string | undefined)[] = []): readonly unknown[] {
  const asMap = (pairs: unknown) => ({ t: 'map', v: pairs });
  return stableSort(maps.map((pairs, i) => exactOf(pairs, texts[i])), (a, b) => orderabilityCompare(asMap(a), asMap(b)));
}

/** One `by()` of an `order(Scope.local)` over a MAP's entries — which SIDE of the entry it reads
 *  (`Column.keys`/`Column.values`; absent = the whole entry) and its direction. */
export interface EntryComparator {
  readonly side?: 'keys' | 'values';
  readonly dir: 'asc' | 'desc';
}

/**
 * `order(Scope.local)` over ONE MAP — its entries re-sorted into a new `LinkedHashMap`
 * (`OrderLocalStep.map`'s `Map` arm sorts `entrySet()` and re-inserts in order —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderLocalStep.java:77-82`).
 * `pairs` is the map's PAIRS array (`[[keyNode,valNode],…]`, the `mapValue` head). Each comparator reads
 * its side of the entry — `Column.keys`/`Column.values` apply to a `Map.Entry` as `getKey`/`getValue`
 * (`.../structure/Column.java`) — and compares it by ORDERABILITY under its own direction (`Order.asc`/
 * `desc` — `.../traversal/Order.java:57-88`), the first non-zero deciding; no `by()` at all is the
 * identity `Order.asc` over the whole ENTRY, which ORDERABILITY compares key-then-value
 * (`entryComparator`, `GremlinValueComparator.java:219-220`) — exactly `cmpIterable` over the `[k,v]`
 * pair. Stable, as `Collections.sort` is. A non-array value passes through unchanged.
 */
export function orderMapLocalValue(comparators: readonly EntryComparator[]): (pairs: unknown, text?: string) => unknown {
  const chain: readonly EntryComparator[] = comparators.length ? comparators : [{ dir: 'asc' }];
  const sideOf = (entry: unknown, side: EntryComparator['side']): unknown => {
    const pair = entry as readonly unknown[];
    return side === 'keys' ? pair[0] : side === 'values' ? pair[1] : pair;
  };
  const compare = (a: unknown, b: unknown): number => {
    for (const { side, dir } of chain) {
      const c = orderabilityCompare(sideOf(a, side), sideOf(b, side));
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  };
  return (pairs, text) => {
    const entries = exactOf(pairs, text);
    return Array.isArray(entries) ? stableSort(entries, compare) : pairs;
  };
}

/** `dedup(Scope.local)` over one list: FIRST occurrence wins, surviving order preserved
 *  (`DedupLocalStep`'s `LinkedHashSet`), members compared by ORDERABILITY over the exact parse
 *  (`exactOf`). O(n²) on the member count, which is fine for a local list. */
export function dedupLocalValue(value: unknown, text?: string): unknown {
  const list = exactOf(value, text);
  if (!Array.isArray(list)) return value;
  const kept: unknown[] = [];
  for (const v of list) if (!kept.some((k) => orderabilityEqual(k, v))) kept.push(v);
  return kept;
}
