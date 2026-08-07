import { q, type Expression } from '../sql/kernel/q.ts';
import { type ValueType } from '../sql/kernel/render.ts';
import { isDtArg, isGTypeArg, isNested, parseIsoMs, stepChain, type Step } from './frontend.ts';
import { flatType, type CanonicalType } from './types.ts';

// ---------- scalar value coercion (asBool / asNumber / asDate + date arithmetic) ----------
//
// The compile-time const-fold helpers (over inject() literals) and the runtime SQL
// emitters for the value-cast step family. Const-fold raises TinkerPop's exact
// "Can't parse …" / overflow messages (SQL can't raise them, and every reachable
// const input is an inject() literal); the SQL emitters wrap a runtime scalar in a
// CAST. Shared by renderProjection (runtime path, projection.ts) and compileInject
// (const path, inject.ts).

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
 *  type (`subtype`, from the arg's `Arg.type`) — 5b→byte, 5l→long, 5.0→double, 5.75f→float.
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
      const c = inner[0].args[0]?.value;
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

// ---------- what an inject() literal's DECLARED type says, per argument ----------
//
// A bare `inject(v1, v2, …)` (no leading coercion to retype the stream) carries only what the
// front-end captured on each argument. That fact is NOT derivable from the values: a `char`, a
// `uuid`, a `datetime` and a long past 2^53 all arrive as ordinary JS strings or numbers, so
// framing by inference reframes them as the wrong wire CLASS. Measured — before the RelIR seed
// used this, the census caught four corpus traversals (`inject("a"c)`, `inject(UUID(…))` and
// friends) with right arity, plausible rows, and the wrong GraphBinary type.
//
// PER ARGUMENT is the shape, and it is the whole of build plan §6·7's carrier: what arrives on the
// wire is CARRIED until something changes it, never re-guessed and never DISCARDED because
// modelling its carriage looked like work. The uniform reading is DERIVED below rather than
// computed separately — one authority, a coarse view over it, which is the `ScalarType` pattern
// (`docs/2026-07-28-scalartype-refactoring-pattern.md`).

/** Canonical types whose STORED form does not determine their Gremlin type, so JS-value inference
 *  would get them wrong. Two reasons, both needing the declared type: it rides as decimal/char
 *  TEXT (a long > 2^53 would frame as a string; bigdecimal/char/duration likewise), or it is
 *  storage-ambiguous with another type (a datetime is epoch-millis → Long, a uuid is TEXT →
 *  String). Everything else is recoverable from the value, so declaring it buys nothing. */
const DECLARED_TYPE_REQUIRED = new Set<CanonicalType>([
  'long', 'bigint', 'bigdecimal', 'char', 'duration', 'datetime', 'uuid',
]);

/** The declared framing tag of EACH of a bare inject's first `count` arguments — `null` where the
 *  argument declared nothing, or declared a type inference already recovers, or declared a
 *  COLLECTION (a list/map/set is reached through the list substrate, never framed by a scalar tag,
 *  which is what `ValueType` excludes). */
export function injectValueTypes(steps: readonly Step[], count: number): (ValueType | null)[] {
  const argTypes = steps[0].args.map((a) => a.type);
  return Array.from({ length: count }, (_, i) => {
    const name = flatType(argTypes[i]);
    return name && DECLARED_TYPE_REQUIRED.has(name) ? (name as ValueType) : null;
  });
}

/** The UNIFORM reading of the above: one tag for the whole stream, or `undefined` where the
 *  arguments disagree (or none needed declaring). A coarse view, derived — a caller that can carry
 *  a heterogeneous stream should read `injectValueTypes` and project the tags PER ROW instead,
 *  which is strictly more information and the reason this is the derived half rather than the
 *  authority. */
export function uniformInjectType(steps: readonly Step[], count: number): ValueType | undefined {
  if (!count) return undefined;
  const tags = injectValueTypes(steps, count);
  return tags.every((t) => t !== null && t === tags[0]) ? tags[0]! : undefined;
}

// ---------- the LEADING coercion prefix: the fold that IS the parse ----------

/** The coercion steps that fold at COMPILE TIME when their input is still a JS constant. */
const CONST_COERCIONS = new Set(['asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);

/**
 * Apply the leading coercion prefix while the values are still JS constants, returning the index of
 * the first ordinary step (which enters the relational dispatcher) and the framing tag the fold
 * settled on. Later coercions remain normal scalar transforms, or fail closed there.
 *
 * **The fold IS the parse, and the parse RAISES TinkerPop's exact messages** (`Can't parse string
 * '1,000' as number.`, the per-type overflow wording). SQL cannot raise either, which is why this
 * happens at compile time on BOTH spines and why it is one function rather than two: a second
 * implementation is a second chance to get an overflow boundary or a date format wrong.
 *
 * It MUTATES `vals`, and a caller whose contract is `null` must catch — a value that does not parse
 * throws from here, and that throw belongs to whichever spine owns the message.
 *
 * Typed on `Step`, not the compiler's `IRStep`: the fold reads `name` and `args` only, so it stays
 * on the front-end side of the boundary with the coercion semantics it is made of.
 */
export function foldConstantCoercions(steps: readonly Step[], vals: any[]): { at: number; as?: ValueType } {
  let at = 1;
  let as: ValueType | undefined;
  for (; at < steps.length && CONST_COERCIONS.has(steps[at].name); at++) {
    const step = steps[at];
    // A traversal date is an apply-style child value, not a constant coercion. Leave it
    // for the scalar dispatcher, which provisions the correlated child scope.
    if (step.name === 'dateDiff' && isNested(step.args[0]?.value) && !isDateDiffConstant(step.args[0]?.value, {})) break;
    if (step.name === 'asBool') {
      for (let i = 0; i < vals.length; i++) vals[i] = asBoolConst(vals[i]);
      as = 'boolean';
      continue;
    }
    if (step.name === 'asNumber') {
      const spec = numericSpec(step.args[0]?.value);
      if (spec) {
        for (let i = 0; i < vals.length; i++) vals[i] = asNumberConst(vals[i], spec);
        as = spec.as;
      } else {
        if (as === 'datetime') {
          as = 'long';
          continue;
        }
        const argTypes = at === 1 ? steps[0].args.map((a) => a.type) : [];
        let uniform: ValueType | undefined;
        for (let i = 0; i < vals.length; i++) {
          const out = asNumberBare(vals[i], flatType(argTypes[i]));
          vals[i] = out.val;
          if (uniform === undefined) uniform = out.as;
          else if (uniform !== out.as)
            throw new Error('asNumber() over a stream of mixed numeric subtypes not yet supported');
        }
        as = uniform;
      }
      continue;
    }
    if (step.name === 'asDate') {
      const argTypes = at === 1 ? steps[0].args.map((a) => a.type) : [];
      for (let i = 0; i < vals.length; i++) vals[i] = asDateConst(vals[i], flatType(argTypes[i]));
      as = 'datetime';
      continue;
    }
    if (step.name === 'dateAdd') {
      const delta = Number(step.args[1].value) * dtFactor(step.args[0].value);
      for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) + delta;
      as = 'datetime';
      continue;
    }
    const other = dateDiffOtherMs(step.args[0]?.value, {});
    for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) - other;
    as = 'long';
  }
  return { at, as };
}
