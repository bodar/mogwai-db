import { q, value, type Expression } from '../../../sql/kernel/q.ts';
import { type ValueType } from '../../../sql/kernel/render.ts';
import { isDtArg, isGTypeArg, isNested, parseIsoMs, stepChain } from '../../../gremlin/frontend.ts';

// ---------- scalar value coercion (asBool / asNumber / asDate + date arithmetic) ----------
//
// The compile-time const-fold helpers (over inject() literals) and the runtime SQL
// emitters for the value-cast step family. Const-fold raises TinkerPop's exact
// "Can't parse …" / overflow messages (SQL can't raise them, and every reachable
// const input is an inject() literal); the SQL emitters wrap a runtime scalar in a
// CAST. Shared by renderProjection (runtime path, projection.ts) and compileInject
// (const path, inject.ts).

/** The syntax-only scalar transform vocabulary. It lives in this cycle-free leaf
 * because child-shape classification must consult it without importing the scalar
 * emitter (which reaches the engine and therefore the classifier). */
export const SCALAR_TRANSFORMS = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
  'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff',
]);

/** asBool() over a compile-time constant — TinkerPop's parse semantics. Its
 *  per-value errors (null / non-bool string / list → "Can't parse …") can't be
 *  raised from SQL, and every reachable input is an inject() literal, so evaluate
 *  here. Number: NaN/0/-0 → false, else true. String: "true"/"false"
 *  (case-insensitive); anything else throws. */
export function asBoolConst(v: any): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return !Number.isNaN(v) && v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase(); // AsBoolStep trims before the case-insensitive match
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  throw new Error(`Can't parse ${v === null || v === undefined ? 'null' : v} as Boolean.`);
}

// asNumber(GType.X): GType token → framing tag + integer range (for overflow) / real
// flag. The subtype is a COMPILE-TIME property (the explicit arg) — SQLite carries the
// numeric value, frameValue picks the serializer from the tag. (bigdecimal has no
// GraphBinary serializer in the client → intentionally absent, defers.)
// `disp` is the boxed Java type name TinkerPop uses in its overflow message (e.g.
// GType.INT → "Integer", GType.BIGINT → "BigInteger") — NOT derivable from `as`.
const NUMERIC_GTYPES: Record<string, { as: ValueType; disp: string; int: boolean; min?: number; max?: number }> = {
  byte: { as: 'byte', disp: 'Byte', int: true, min: -128, max: 127 },
  short: { as: 'short', disp: 'Short', int: true, min: -32768, max: 32767 },
  int: { as: 'int', disp: 'Integer', int: true, min: -2147483648, max: 2147483647 },
  integer: { as: 'int', disp: 'Integer', int: true, min: -2147483648, max: 2147483647 },
  long: { as: 'long', disp: 'Long', int: true },
  bigint: { as: 'bigint', disp: 'BigInteger', int: true },
  biginteger: { as: 'bigint', disp: 'BigInteger', int: true },
  float: { as: 'float', disp: 'Float', int: false },
  double: { as: 'double', disp: 'Double', int: false },
  // bigdecimal completes the numeric asNumber family. Now that we ship a BigDecimal
  // serializer + exact TEXT storage, a cast to BigDecimal is representable (framed via
  // the value's canonical text; `int:false` skips the integer truncation/overflow path).
  bigdecimal: { as: 'bigdecimal', disp: 'BigDecimal', int: false },
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** asNumber's GType arg → its numeric spec. `null` = bare asNumber() (no arg — needs
 *  the input subtype, which the frontend flattens away, so it defers). A non-numeric
 *  token (e.g. GType.VERTEX) raises TinkerPop's error. */
export function numericSpec(arg: any): (typeof NUMERIC_GTYPES[string] & { name: string }) | null {
  const name = isGTypeArg(arg) ? arg.gtype : null;
  if (name === null) return null;
  const spec = NUMERIC_GTYPES[name];
  if (!spec) throw new Error(`asNumber() requires a numeric type token, got ${name.toUpperCase()}`);
  return { ...spec, name };
}

/** asNumber(GType.X) over a compile-time constant: parse/convert + overflow-check,
 *  raising TinkerPop's exact messages (SQL can't raise these; inject inputs are
 *  literals). Integer targets truncate toward zero. */
export function asNumberConst(v: any, spec: NonNullable<ReturnType<typeof numericSpec>>): number {
  let n: number;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'bigint') n = Number(v);
  // Number('') / Number('  ') are 0, not NaN — reject blank strings explicitly so they
  // raise the parse error like any other non-numeric string rather than becoming 0.
  else if (typeof v === 'string') { n = v.trim() === '' ? NaN : Number(v); if (Number.isNaN(n)) throw new Error(`Can't parse string '${v}' as number.`); }
  else throw new Error(`Can't parse type ${v === null || v === undefined ? 'null' : cap(typeof v)} as number.`);
  if (spec.int) {
    n = Math.trunc(n);
    if (spec.min !== undefined && (n < spec.min || n > spec.max!))
      throw new Error(`Can't convert number of type ${Number.isInteger(v) ? 'Integer' : 'Double'} to ${spec.disp} due to overflow.`);
  }
  return n;
}

/** asNumber(GType.X) over a runtime scalar: a SQL CAST to the target's storage class
 *  (integer targets truncate; float/double stay real). BigDecimal keeps the value
 *  unchanged — it is framed from its canonical TEXT by the BigDecimal serializer, so a
 *  REAL cast would only risk formatting artifacts; the `as:'bigdecimal'` tag drives
 *  framing. Overflow isn't range-checked (unreachable for the runtime inputs the suite
 *  exercises). */
export const asNumberSql = (spec: { int: boolean; as: ValueType }, e: Expression): Expression =>
  spec.as === 'bigdecimal' ? e : spec.int ? q`CAST(${e} AS INTEGER)` : q`CAST(${e} AS REAL)`;

/** Bare asNumber() over a constant: the output subtype is the INPUT literal's declared
 *  type (`subtype`, from Step.argTypes) — 5b→byte, 5l→long, 5.0→double, 5.75f→float.
 *  A numeric string parses to int/double by value; a non-numeric string / non-number
 *  throws. Returns the numeric value + its framing tag. */
export function asNumberBare(v: any, subtype: string | null): { val: any; as: ValueType } {
  // A bigdecimal input keeps its exact carrier (a BigDecimal instance / decimal text) —
  // framed via the BigDecimal serializer's canonical text, no lossy numeric coercion.
  if (subtype === 'bigdecimal') return { val: v, as: 'bigdecimal' };
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = Number(v);
    return { val: n, as: (subtype ?? (Number.isInteger(n) ? 'int' : 'double')) as ValueType };
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || Number.isNaN(Number(t))) throw new Error(`Can't parse string '${v}' as number.`);
    // int vs double is decided by the STRING's form (a '.'/'e'/'E' → floating point),
    // like AsNumberStep — NOT by whether the value is whole ("5.0" is double, not int).
    return { val: Number(t), as: /[.eE]/.test(t) ? 'double' : 'int' };
  }
  throw new Error(`Can't parse type ${v === null || v === undefined ? 'null' : cap(typeof v)} as number.`);
}

// ---------- date casts (asDate / dateAdd / dateDiff) ----------
//
// Internal datetime = epoch-millis (INTEGER); the 'date' shape tag frames it back to a
// JS Date (execute.ts frameValue). second/minute/hour/day are fixed-width, so date
// arithmetic is pure integer — no SQLite date functions needed for datetime literals;
// only a runtime ISO-string asDate() calls unixepoch(). All GraphBinary offsets fold
// into the instant, so only the instant is carried (matching the client's UTC wire).
const DT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

/** dateAdd's DT unit token → its millisecond factor. */
export function dtFactor(arg: any): number {
  const u = isDtArg(arg) ? arg.dt : null;
  const f = u ? DT_MS[u] : undefined;
  if (!f) throw new Error(`dateAdd() requires a DT unit (second/minute/hour/day), got ${u ?? arg}`);
  return f;
}

/** asDate() over a compile-time constant → epoch-millis. An ISO-8601 string (offset
 *  folds into the instant) or an integer/long epoch; a float epoch, non-ISO string,
 *  list, or null raises TinkerPop's "Can't parse" (SQL can't raise it, and every
 *  reachable inject input is a literal). */
export function asDateConst(v: any, subtype: string | null): number {
  if (typeof v === 'number') {
    if (subtype === 'float' || subtype === 'double' || subtype === 'bigdecimal' || !Number.isInteger(v))
      throw new Error(`Can't parse ${v} as a Date: a floating-point epoch is not allowed.`);
    return v;
  }
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const ms = parseIsoMs(v); // UTC-normalized so Bun and the DO agree on the instant
    if (Number.isNaN(ms)) throw new Error(`Can't parse '${v}' as an ISO-8601 Date.`);
    return ms;
  }
  throw new Error(`Can't parse ${v === null || v === undefined ? 'null' : cap(typeof v)} as a Date.`);
}

/** dateDiff's other operand in millis (result = self − other). A datetime literal
 *  (epoch-ms number) or a `constant(datetime|null)` nested traversal (null → epoch 0,
 *  = new Date(null)). A nested inject()/movement defers. */
export function dateDiffOtherMs(arg: any, params: Record<string, any>): number {
  if (typeof arg === 'number') return arg;
  if (isNested(arg)) {
    const inner = stepChain(arg.nested, params);
    if (inner.length === 1 && inner[0].name === 'constant') {
      const c = inner[0].args[0];
      return c === null || c === undefined ? 0 : Number(c);
    }
    throw new Error('dateDiff(): only a datetime literal or constant(datetime) argument is supported');
  }
  throw new Error('dateDiff() requires a datetime literal or constant(datetime) argument');
}

/** Whether dateDiff's nested operand is the constant form the fused transform can fold
 * without a child scope. Every other nested body belongs to the apply-contract seam. */
export const isDateDiffConstant = (arg: any, params: Record<string, any>): boolean =>
  isNested(arg) && (() => {
    const inner = stepChain(arg.nested, params);
    return inner.length === 1 && inner[0].name === 'constant';
  })();

/** asDate() over a runtime scalar → epoch-millis. An integer/real value is already
 *  millis; a text value is an ISO-8601 string (unixepoch resolves any offset into the
 *  instant; ×1000 → millis). */
export const asDateSql = (e: Expression): Expression =>
  q`(CASE WHEN typeof(${e}) IN ('integer', 'real') THEN CAST(${e} AS INTEGER) ELSE unixepoch(${e}) * 1000 END)`;
