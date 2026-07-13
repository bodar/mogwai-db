import { q, value, list, empty, Relation, Query, type Expression } from '../q.ts';
import { nodes, edges, labels } from '../schema.ts';
import {
  propExtract, propAt, predicateSql, compileNestedScalar, labelNameSub, rangeToOffsetLimit, elemCtx, aliasCtx, scalarTx, extIdOf,
  type ScalarCtx,
} from '../plan.ts';
import { mathToSql, mathVars } from '../math.ts';
import { stepChain, parseIsoMs, type Step } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { elemRel, type AliasMap, type St } from './context.ts';
import {
  readCompiled, type Compiled, type Shape, type ValueType, type MapEntry, type ElemShape, type GroupKey, type GroupVal, type PathPos,
} from '../render.ts';

/** Movement heads whose nested-by() aggregate is a correlated neighbourhood
 *  reduction (handled by edgeAggFrom), and the scalar reducers that terminate one. */
const MOVES_ROOT = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const SCALAR_REDUCERS = new Set(['sum', 'min', 'max', 'mean']);

// ---------- tail: projection + barriers + modifiers ----------
//
// After the prefix fold lands the id-relation, the tail applies an optional
// projection (values/id/label/…/select/project) plus order()/range()/limit() and
// terminal reducers. group()/groupCount()/properties() are barriers that consume
// the whole stream into one shape, so they short-circuit before the generic tail.

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

/** The tail modifiers accumulated left-to-right (a pure fold — no sibling peeking;
 *  by() modulators already live on their host step via strategies.foldByModulators). */
interface TailAcc {
  projStep: PStep | null;
  orders: OrderClause[];
  offset: number;
  limit: number | null;
  distinct: boolean;
  reducer: 'fold' | 'sum' | 'min' | 'max' | 'mean' | null; // terminal stream reducer applied after the projection
  isPreds: any[];                  // is(P) filters on the projected scalar (AND'd)
  transforms: PStep[];             // scalar string/cast transforms wrapping the projected scalar, in order
  injects: any[];                  // constants appended to the value stream (values(k).inject(c))
}

const PROJECTION_NAMES = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project', 'path']);
// Per-value transform steps gathered into acc.transforms. Most are SQL scalar
// expressions (scalarTx). `asBool` is a typed cast: compileInject resolves it over
// inject constants (see asBoolConst); on a V/E-rooted stream it falls through to
// scalarTx → undefined → a clean "not supported" defer (needs local()/sack()).
const SCALAR_TX_NAMES = new Set(['concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff']);
const isMapProj = (p: PStep | null) => p?.name === 'select' || p?.name === 'project';

/** A tail modifier: fold the step into the accumulator. `at` gives position so a
 *  terminal reducer (fold/sum) can reject anything following it. */
type ModFn = (s: PStep, acc: TailAcc, at: { last: boolean; next?: string }) => void;

const MODIFIERS = new Map<string, ModFn>([
  ['order', (s, acc) => {
    // Each folded by() → one order clause; a bare order() sorts by identity.
    const bys = s.bys ?? [];
    if (bys.length === 0) { acc.orders.push({ key: null, dir: 'asc' }); return; }
    for (const byArgs of bys) {
      // Reject deferred modulators rather than let a {token}/{nested} arg fall
      // through to key=null and silently sort by id.
      const bad = byArgs.find((a: any) => a && typeof a === 'object' && ('token' in a || 'nested' in a));
      if (bad) throw new Error('token' in bad ? `by(T.${bad.token}) modulator not yet supported` : 'by(traversal) modulator not yet supported');
      const key = byArgs.find((a: any) => typeof a === 'string') ?? null;
      const ord = byArgs.find((a: any) => a && typeof a === 'object' && 'order' in a);
      acc.orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
    }
  }],
  ['range', (s, acc) => { ({ offset: acc.offset, limit: acc.limit } = rangeToOffsetLimit(s.args)); }],
  ['skip', (s, acc) => { acc.offset = Number(s.args[0]); }],
  ['limit', (s, acc) => { acc.limit = Number(s.args[0]); }],
  ['dedup', (_s, acc) => { acc.distinct = true; }],
  ['is', (s, acc) => {
    // is() folds into the projection WHERE (before ORDER BY/LIMIT). Only correct
    // if no limit/range/skip preceded it — filtering commutes with order() but NOT
    // with a limit that already truncated the stream.
    if (acc.limit !== null || acc.offset > 0) throw new Error('is() after limit()/range()/skip() not yet supported');
    acc.isPreds.push(s.args[0]);
  }],
  ['fold', reducerMod('fold')],
  ['sum', reducerMod('sum')],
  ['min', reducerMod('min')],
  ['max', reducerMod('max')],
  ['mean', reducerMod('mean')],
  ['by', () => { throw new Error('by() is only supported as an order() or select()/project() modulator'); }],
]);

function reducerMod(name: NonNullable<TailAcc['reducer']>): ModFn {
  return (_s, acc, at) => {
    // Scope.local (a per-list reduction) always arrives after fold()/aggregate()
    // in the suite, so the reducer-after-reducer / step-after-reducer guards below
    // already defer it — no separate Scope handling needed here.
    if (acc.reducer) throw new Error(`${name}() after ${acc.reducer}() not yet supported`);
    if (!at.last) throw new Error(`step not implemented after ${name}(): ${at.next}()`);
    acc.reducer = name;
  };
}

/** Fold the tail steps from `from` into a TailAcc: one optional projection step,
 *  scalar transforms, inject-appends, and the value-shape modifiers (MODIFIERS).
 *  Shared by compileTail (element-rooted) and compileInject (scalar-stream-rooted)
 *  so both consume one modifier vocabulary — add a value-tail step once, here. */
export function foldTailAcc(steps: PStep[], from: number): TailAcc {
  const acc: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, reducer: null, isPreds: [], transforms: [], injects: [] };
  for (let i = from; i < steps.length; i++) {
    const s = steps[i];
    if (PROJECTION_NAMES.has(s.name)) {
      if (acc.projStep) throw new Error('only one projection step is supported per traversal');
      acc.projStep = s;
      continue;
    }
    // inject(c…) after a value projection appends constants to the value stream.
    if (s.name === 'inject') { acc.injects.push(...s.args); continue; }
    // A scalar string/cast transform (concat/length/…) wraps the projected scalar.
    if (SCALAR_TX_NAMES.has(s.name)) { acc.transforms.push(s); continue; }
    const mod = MODIFIERS.get(s.name);
    if (!mod) throw new Error(`step not implemented: ${s.name}()`);
    mod(s, acc, { last: i === steps.length - 1, next: steps[i + 1]?.name });
  }
  return acc;
}

/** Compile the tail: `st` is the finished prefix state, `steps[stop]` the first
 *  step the prefix dispatch didn't consume. */
export function compileTail(st: St, steps: PStep[], stop: number): Compiled {
  const indexKeys = new Set(st.indexKeys);

  // properties() turns the traverser into a property (owner+key+value) — a shape
  // the id-relation can't carry, so it and its follow-ons compile in their own fn.
  if (steps[stop]?.name === 'properties')
    return compileProperties(st, steps.slice(stop), indexKeys);

  // option-map choose (choose().option()…) → a CASE over a correlated choice scalar.
  if (steps[stop]?.name === 'choose' && steps[stop].options)
    return compileChooseOptions(st, steps, stop, indexKeys);

  // map(__.<scalar>) → a per-traverser scalar projection (out-degree, a property, a
  // label). Element-body map (first-result-only) and select/fold bodies defer.
  if (steps[stop]?.name === 'map')
    return compileMapScalar(st, steps, stop, indexKeys);

  // math("<formula>") → one SQL arithmetic scalar (always Double). Its variables
  // (`_` / as()-bound names) resolve through the by() modulators folded onto it.
  if (steps[stop]?.name === 'math')
    return compileMath(st, steps, stop, indexKeys);

  // group()/groupCount() is a barrier over the current element stream → one Map.
  if (steps[stop]?.name === 'group' || steps[stop]?.name === 'groupCount') {
    if (stop + 1 < steps.length) throw new Error(`step not implemented after ${steps[stop].name}(): ${steps[stop + 1].name}()`);
    const tbl = st.elem === 'edge' ? 'edges' : 'nodes';
    const ctx = elemCtx(elemRel(st), st.elem);
    const src: GroupSource = { from: `${tbl} n JOIN ${st.last.name} p ON n.id=p.id`, ctx, elem: st.elem === 'edge' ? 'edge' : 'vertex' };
    return compileGroup(st, steps[stop].name === 'groupCount', steps[stop].bys ?? [], src, indexKeys);
  }

  // Tail fold: accumulate the projection + modifiers.
  const acc = foldTailAcc(steps, stop);

  if (acc.projStep?.name === 'path')
    return compilePath(st, acc.projStep, acc, indexKeys);

  if (isMapProj(acc.projStep))
    return compileSelectProject(st, acc.projStep!, acc, indexKeys);

  return buildProjection(st, acc, indexKeys);
}

interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

// ---------- projection resolution (values/id/label/valueMap/elementMap/element) ----------

interface ProjCtx {
  st: St; n: Relation; l: Relation; extId: Expression;
  vJoin: Expression; vlJoin: Expression;
  projStep: PStep | null; indexKeys: Set<string>; hasIs: boolean;
}
interface ProjResult { shape: Shape; colsNode: Expression; fromNode: Expression; scalarExpr?: Expression | null; baseWhere?: Expression | null; }
type ProjFn = (c: ProjCtx) => ProjResult;

const PROJECTORS = new Map<string, ProjFn>([
  ['values', (c) => {
    const pe = propExtract('n.props', c.projStep!.args[0]);
    // values(k).is(P) is a filter-position use → auto-index the key (like has());
    // a bare values() projection is deliberately NOT indexed (bounds proliferation).
    if (c.hasIs && pe.indexKey && c.st.elem === 'node') c.indexKeys.add(pe.indexKey);
    return {
      shape: { kind: 'value' }, colsNode: q`${pe.expr} AS v`, fromNode: c.vJoin,
      scalarExpr: pe.expr, baseWhere: predicateSql(pe.expr, undefined), // <pe> IS NOT NULL (shared node → binds fall out per occurrence)
    };
  }],
  ['id', (c) => ({
    // Join the element table even though the id lives in `last`, so a preceding
    // order().by(key) — which references n.props — has the alias in scope.
    shape: { kind: 'value' }, colsNode: q`${c.extId} AS v`, fromNode: c.vJoin, scalarExpr: c.extId,
  })],
  ['label', (c) => ({
    shape: { kind: 'value' }, colsNode: q`${c.l.c.name} AS v`, fromNode: c.vlJoin, scalarExpr: c.l.c.name,
  })],
  ['valueMap', (c) => {
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'valueMap', keys: keys.length ? keys : null, tokens: c.projStep!.args.includes(true) },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin,
    };
  }],
  ['elementMap', (c) => {
    if (c.st.elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'elementMap', keys: keys.length ? keys : null },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin,
    };
  }],
  ['__element', (c) => c.st.elem === 'edge'
    // Endpoints resolve to external ids (COALESCE(uid,id)) so a materialized edge
    // reports the SAME src/tgt as the write path — not the raw rowid.
    ? { shape: { kind: 'edge' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${extIdOf(c.n.c.src)} AS src, ${extIdOf(c.n.c.tgt)} AS tgt, ${c.n.c.props}`, fromNode: c.vlJoin }
    : { shape: { kind: 'vertex' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin }],
]);

/** An order().by(key) resolver over the element's props (context `n`): a property
 *  expression, auto-indexing the key on node streams. Shared by buildProjection and
 *  compileMath — both render a value tail whose identity/keyed order sorts node props. */
const nodePropOrderKey = (st: St, indexKeys: Set<string>) => (key: string): Expression => {
  const pe = propExtract('n.props', key);
  if (pe.indexKey && st.elem === 'node') indexKeys.add(pe.indexKey);
  return pe.expr;
};

function buildProjection(st: St, acc: TailAcc, indexKeys: Set<string>): Compiled {
  const { distinct, offset, limit, isPreds, reducer } = acc;
  const projName = acc.projStep?.name ?? '__element';

  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    const inner = q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${st.last}`;
    const innerLim = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(q`v`, pr)), ' AND ')}`;
    return readCompiled(st.q, countNode, { kind: 'count' }, [...indexKeys]);
  }

  const n = elemRel(st);
  const p = st.last.as('p');
  const l = labels.as('l');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projName)!({ st, n, l, extId, vJoin, vlJoin, projStep: acc.projStep, indexKeys, hasIs: isPreds.length > 0 });

  // order().by(key) sorts by a property expression (element context) — auto-index it.
  return renderProjection(st.q, proj, acc, indexKeys, nodePropOrderKey(st, indexKeys));
}

/** Render a resolved projection + the value-shape tail (scalar transforms, is()
 *  filter, dedup, order, range/limit, inject-append, terminal reducer) into a
 *  Compiled. The single tail renderer shared by element projections (buildProjection)
 *  and the inject scalar stream (compileInject) — so a new value-tail behaviour is
 *  written once. `orderKey(key)` resolves an order().by(key) to a SQL expression in
 *  the caller's context (a property lookup for elements; a throw for a scalar stream
 *  that has no properties). Identity order uses `v` (value shape) or `n.id`. */
function renderProjection(
  Q: Query, proj: ProjResult, acc: TailAcc, indexKeys: Set<string>,
  orderKey: (key: string) => Expression,
): Compiled {
  const { orders, distinct, offset, limit, isPreds, reducer, injects } = acc;
  let { shape, colsNode, scalarExpr } = proj;

  // Scalar string/cast transforms (values('name').concat('X').toUpper()) wrap the
  // projected scalar; is()/order() then see the transformed value. Only a scalar
  // stream (values/id/label/inject) has a scalarExpr to transform. asNumber(GType.X)
  // is a typed cast: it wraps the scalar in a SQL CAST and tags the value shape so the
  // handler frames the right numeric subtype (a runtime value, e.g. values('float');
  // inject constants resolve in compileInject with overflow checks instead).
  if (acc.transforms.length) {
    if (!scalarExpr) throw new Error(`${acc.transforms[0].name}() requires a scalar stream (values/id/label)`);
    for (let i = 0; i < acc.transforms.length; i++) {
      const s = acc.transforms[i];
      if (s.name === 'asNumber') {
        const spec = numericSpec(s.args[0]); // throws on a non-numeric GType; null = bare
        if (spec) { scalarExpr = asNumberSql(spec, scalarExpr); shape = { kind: 'value', as: spec.as }; continue; }
        // bare asNumber() over a runtime scalar. A date → its epoch-millis (Long,
        // identity). Otherwise only valid as the ms-value leg of a date round-trip —
        // i.e. immediately feeding an asDate() (which overwrites the tag), where a
        // CAST to INTEGER is right. A standalone bare asNumber() over a runtime value
        // can't recover its subtype (fractional vs integral), so fail closed.
        if (shape.kind === 'value' && shape.as === 'date') { shape = { kind: 'value', as: 'long' }; continue; }
        if (acc.transforms[i + 1]?.name === 'asDate') { scalarExpr = q`CAST(${scalarExpr} AS INTEGER)`; shape = { kind: 'value', as: 'long' }; continue; }
        throw new Error('bare asNumber() over a non-date runtime value not yet supported');
      }
      if (s.name === 'asDate') { scalarExpr = asDateSql(scalarExpr); shape = { kind: 'value', as: 'date' }; continue; }
      if (s.name === 'dateAdd') { scalarExpr = q`(${scalarExpr} + ${value(Number(s.args[1]) * dtFactor(s.args[0]))})`; shape = { kind: 'value', as: 'date' }; continue; }
      if (s.name === 'dateDiff') { scalarExpr = q`(${scalarExpr} - ${value(dateDiffOtherMs(s.args[0], {}))})`; shape = { kind: 'value', as: 'long' }; continue; }
      scalarExpr = scalarTx(s.name, s.args, scalarExpr) ?? (() => { throw new Error(`scalar transform ${s.name}() not supported`); })();
    }
    colsNode = q`${scalarExpr} AS v`;
  }
  // A typed-cast tag can't survive a terminal reducer (wrapReducer only sees
  // shape.kind) — sum()/fold() after asNumber() would wire the wrong subtype, so defer.
  if (shape.kind === 'value' && shape.as && reducer)
    throw new Error(`${reducer}() after asNumber() not yet supported`);

  // WHERE: the values() existence check + any is(P) on the projected scalar, AND'd.
  const whereParts: Expression[] = [];
  if (proj.baseWhere) whereParts.push(proj.baseWhere);
  if (isPreds.length) {
    if (!scalarExpr) throw new Error('is() requires a scalar stream (values/label/id/count)');
    for (const pr of isPreds) whereParts.push(predicateSql(scalarExpr, pr));
  }
  const whereNode: Expression = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;

  let orderNode: Expression = empty;
  if (orders.length) {
    const keyNodes = orders.map((o) => {
      if (o.dir === 'shuffle') return q`RANDOM()`;
      const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
      if (o.key !== null) return q`${orderKey(o.key)}${dir}`;
      return q`${shape.kind === 'value' ? 'v' : 'n.id'}${dir}`;
    });
    orderNode = q` ORDER BY ${list(keyNodes, ', ')}`;
  }
  const limitNode: Expression = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;

  let tailNode: Expression = q`SELECT ${distinct ? 'DISTINCT ' : ''}${colsNode} FROM ${proj.fromNode}${whereNode}${orderNode}${limitNode}`;

  // values(k).inject(c…): append the constants as extra value rows before any
  // reducer. Only meaningful on a scalar stream (the injected value shares `v`).
  if (injects.length) {
    if (shape.kind !== 'value') throw new Error('inject() after a non-scalar projection not yet supported');
    tailNode = q`SELECT v FROM (${tailNode}) UNION ALL ${list(injects.map((c) => q`SELECT ${value(c)} AS v`), ' UNION ALL ')}`;
  }

  // Terminal reducers wrap the projected select.
  if (reducer) ({ tailNode, shape } = wrapReducer(tailNode, reducer, shape));

  return readCompiled(Q, tailNode, shape, [...indexKeys]);
}

/** g.inject(v1, v2, …) — an inject-rooted read: a scalar `v` stream seeded from
 *  constants, then the SAME value tail every projection uses (foldTailAcc +
 *  renderProjection). All inject() args across the chain seed one VALUES union (so
 *  dedup/order/reducer see the whole stream); the shared tail applies the rest.
 *  Only reaches here for pure inject-rooted chains (addV/addE/mergeV/mergeE match
 *  earlier in WRITE_RULES). A bare inject() is an empty stream. */
/** asBool() over a compile-time constant — TinkerPop's parse semantics. Its
 *  per-value errors (null / non-bool string / list → "Can't parse …") can't be
 *  raised from SQL, and every reachable input is an inject() literal, so evaluate
 *  here. Number: NaN/0/-0 → false, else true. String: "true"/"false"
 *  (case-insensitive); anything else throws. */
function asBoolConst(v: any): boolean {
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
};
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** asNumber's GType arg → its numeric spec. `null` = bare asNumber() (no arg — needs
 *  the input subtype, which the frontend flattens away, so it defers). A non-numeric
 *  token (e.g. GType.VERTEX) raises TinkerPop's error. */
function numericSpec(arg: any): (typeof NUMERIC_GTYPES[string] & { name: string }) | null {
  const name = arg && typeof arg === 'object' && 'gtype' in arg ? String(arg.gtype) : null;
  if (name === null) return null;
  const spec = NUMERIC_GTYPES[name];
  if (!spec) throw new Error(`asNumber() requires a numeric type token, got ${name.toUpperCase()}`);
  return { ...spec, name };
}

/** asNumber(GType.X) over a compile-time constant: parse/convert + overflow-check,
 *  raising TinkerPop's exact messages (SQL can't raise these; inject inputs are
 *  literals). Integer targets truncate toward zero. */
function asNumberConst(v: any, spec: NonNullable<ReturnType<typeof numericSpec>>): number {
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
 *  (integer targets truncate; float/double stay real). Overflow isn't range-checked
 *  (unreachable for the runtime inputs the suite exercises). */
const asNumberSql = (spec: { int: boolean }, e: Expression): Expression =>
  spec.int ? q`CAST(${e} AS INTEGER)` : q`CAST(${e} AS REAL)`;

/** Bare asNumber() over a constant: the output subtype is the INPUT literal's declared
 *  type (`subtype`, from Step.argTypes) — 5b→byte, 5l→long, 5.0→double, 5.75f→float.
 *  A numeric string parses to int/double by value; a non-numeric string / non-number
 *  throws. Returns the numeric value + its framing tag. */
function asNumberBare(v: any, subtype: string | null): { val: number; as: ValueType } {
  if (subtype === 'bigdecimal') throw new Error('asNumber() to BigDecimal not yet supported'); // no GraphBinary serializer
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
// JS Date (handler.ts frameValue). second/minute/hour/day are fixed-width, so date
// arithmetic is pure integer — no SQLite date functions needed for datetime literals;
// only a runtime ISO-string asDate() calls unixepoch(). All GraphBinary offsets fold
// into the instant, so only the instant is carried (matching the client's UTC wire).
const DT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000, day: 86400000 };

/** dateAdd's DT unit token → its millisecond factor. */
function dtFactor(arg: any): number {
  const u = arg && typeof arg === 'object' && 'dt' in arg ? String(arg.dt) : null;
  const f = u ? DT_MS[u] : undefined;
  if (!f) throw new Error(`dateAdd() requires a DT unit (second/minute/hour/day), got ${u ?? arg}`);
  return f;
}

/** asDate() over a compile-time constant → epoch-millis. An ISO-8601 string (offset
 *  folds into the instant) or an integer/long epoch; a float epoch, non-ISO string,
 *  list, or null raises TinkerPop's "Can't parse" (SQL can't raise it, and every
 *  reachable inject input is a literal). */
function asDateConst(v: any, subtype: string | null): number {
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
function dateDiffOtherMs(arg: any, params: Record<string, any>): number {
  if (typeof arg === 'number') return arg;
  if (arg && typeof arg === 'object' && 'nested' in arg) {
    const inner = stepChain(arg.nested, params);
    if (inner.length === 1 && inner[0].name === 'constant') {
      const c = inner[0].args[0];
      return c === null || c === undefined ? 0 : Number(c);
    }
    throw new Error('dateDiff(): only a datetime literal or constant(datetime) argument is supported');
  }
  throw new Error('dateDiff() requires a datetime literal or constant(datetime) argument');
}

/** asDate() over a runtime scalar → epoch-millis. An integer/real value is already
 *  millis; a text value is an ISO-8601 string (unixepoch resolves any offset into the
 *  instant; ×1000 → millis). */
const asDateSql = (e: Expression): Expression =>
  q`(CASE WHEN typeof(${e}) IN ('integer', 'real') THEN CAST(${e} AS INTEGER) ELSE unixepoch(${e}) * 1000 END)`;

export function compileInject(steps: PStep[]): Compiled {
  const Q = new Query();
  const acc = foldTailAcc(steps, 1);
  // Fold every inject() value (the source args + any later inject appends) into one
  // VALUES-backed `v` seed, so the tail's dedup/order/limit/reducer act on the full
  // stream — matching the pre-unification inline-UNION semantics.
  // Typed casts over the inject constants — asBool() and asNumber(GType.X). Their
  // per-value errors (parse/overflow) can't be raised from SQL, and every reachable
  // input is a literal, so resolve each constant now; the value shape then carries the
  // `as` tag so SQLite's plain numeric/0-1 value frames as the right GraphBinary type.
  // Only the bare form (cast [+ value-preserving dedup/order/range]) is supported: a
  // reducer, count(), or trailing inject() would need the tag threaded per-position
  // (fold→List<T>) or mix types into the stream — defer rather than miscompute. Bare
  // asNumber() (no GType) recovers each input's subtype from Step.argTypes (5b→byte,
  // 5l→long, 5.0→double); V-rooted casts need local()/sack().
  let valueAs: ValueType | undefined;
  const cast = acc.transforms.length === 1 ? acc.transforms[0] : undefined;
  const spec = cast?.name === 'asNumber' ? numericSpec(cast.args[0]) : null; // throws on a non-numeric GType
  const bareNum = cast?.name === 'asNumber' && !spec; // asNumber() with no GType arg
  const dateCast = cast?.name === 'asDate' || cast?.name === 'dateAdd' || cast?.name === 'dateDiff';
  const constCast = cast?.name === 'asBool' || (cast?.name === 'asNumber' && spec) || bareNum || dateCast;
  if (constCast && (acc.reducer || acc.projStep || acc.injects.length))
    throw new Error(`${cast!.name}() composed with a reducer/count()/trailing inject() not yet supported`);

  const vals = [...steps[0].args, ...acc.injects];
  acc.injects.length = 0; // consumed into the seed, not appended after the tail

  if (cast?.name === 'asBool') {
    for (let i = 0; i < vals.length; i++) vals[i] = asBoolConst(vals[i]);
    acc.transforms.length = 0;
    valueAs = 'bool';
  } else if (spec) {
    for (let i = 0; i < vals.length; i++) vals[i] = asNumberConst(vals[i], spec);
    acc.transforms.length = 0;
    valueAs = spec.as;
  } else if (bareNum) {
    // Each value keeps its declared subtype; a uniform tag frames the whole `v` column,
    // so a stream mixing subtypes (rare, unreachable) defers rather than mis-frame.
    const argTypes = steps[0].argTypes ?? [];
    for (let i = 0; i < vals.length; i++) {
      const { val, as } = asNumberBare(vals[i], argTypes[i] ?? null);
      vals[i] = val;
      if (valueAs === undefined) valueAs = as;
      else if (valueAs !== as) throw new Error('asNumber() over a stream of mixed numeric subtypes not yet supported');
    }
    acc.transforms.length = 0;
  } else if (cast?.name === 'asDate') {
    const at = steps[0].argTypes ?? [];
    for (let i = 0; i < vals.length; i++) vals[i] = asDateConst(vals[i], at[i] ?? null);
    acc.transforms.length = 0;
    valueAs = 'date';
  } else if (cast?.name === 'dateAdd') {
    const delta = Number(cast.args[1]) * dtFactor(cast.args[0]); // fixed-width unit → ms
    for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) + delta;
    acc.transforms.length = 0;
    valueAs = 'date';
  } else if (cast?.name === 'dateDiff') {
    const other = dateDiffOtherMs(cast.args[0], {}); // datetime literals carry no bound params
    for (let i = 0; i < vals.length; i++) vals[i] = Number(vals[i]) - other;
    acc.transforms.length = 0;
    valueAs = 'long';
  }
  // A numeric asNumber(GType) NOT const-folded above (composed with another transform)
  // would flow into renderProjection's runtime CAST, which skips the overflow check —
  // over an inject constant that may be out of range, framing then throws a raw
  // serializer RangeError instead of TinkerPop's clean message. Defer that here.
  else if (acc.transforms.some((t) => t.name === 'asNumber' && numericSpec(t.args[0])))
    throw new Error('asNumber(GType) composed with other transforms over inject() not yet supported');
  // The seed is a FROM source directly (the VALUES CTE relation, or an empty select)
  // — renderProjection wraps it, so no extra subquery here.
  const from: Expression = vals.length
    ? Q.cte(q`VALUES ${list(vals.map((v) => q`(${value(v)})`), ', ')}`, ['v'])
    : q`(SELECT NULL AS v WHERE 0)`;

  // count() is the only projection valid on a scalar stream (values/id/label/… need
  // an element). COUNT the (dedup/is/range-applied) rows. A step AFTER count() would
  // operate on the count value, not the stream (e.g. count().is(P) filters the count)
  // — a different semantics the acc's position-free fold can't express, so defer it
  // (the pre-unification inject compiler deferred everything after count() too). Any
  // is()/dedup/range here is therefore pre-count and correctly filters the stream.
  if (acc.projStep) {
    if (acc.projStep.name !== 'count') throw new Error(`${acc.projStep.name}() requires element input (a scalar stream has no ${acc.projStep.name})`);
    const countIdx = steps.findIndex((s) => s.name === 'count');
    if (countIdx !== steps.length - 1) throw new Error(`step not implemented after count(): ${steps[countIdx + 1].name}()`);
    const dist = acc.distinct ? 'DISTINCT ' : '';
    const whereNode = acc.isPreds.length ? q` WHERE ${list(acc.isPreds.map((p) => predicateSql(q`v`, p)), ' AND ')}` : empty;
    const limitNode = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
    return readCompiled(Q, q`SELECT COUNT(*) AS v FROM (SELECT ${dist}v FROM ${from}${whereNode}${limitNode})`, { kind: 'count' });
  }

  const proj: ProjResult = { shape: { kind: 'value', as: valueAs }, colsNode: q`v AS v`, fromNode: from, scalarExpr: q`v`, baseWhere: null };
  const orderKey = (): Expression => { throw new Error('inject().order().by(key) not supported (scalar stream has no properties)'); };
  return renderProjection(Q, proj, acc, new Set(), orderKey);
}

/** Wrap a `v`-projecting select in a terminal reducer (fold/sum/min/max/mean),
 *  returning the new node + result shape. Shared by the element tail here and the
 *  inject value stream (write.ts) so both reduce identically. fold() keeps the
 *  stream as a List (element or scalar); sum/min/max/mean collapse to one scalar
 *  (min/max/mean over numeric values only → empty stream on non-numeric input). */
export function wrapReducer(
  tailNode: Expression, reducer: NonNullable<TailAcc['reducer']>, shape: Shape,
): { tailNode: Expression; shape: Shape } {
  if (reducer === 'fold') {
    const fe: ElemShape | 'scalar' =
      shape.kind === 'vertex' ? 'vertex' : shape.kind === 'edge' ? 'edge' :
      shape.kind === 'value' ? 'scalar' : (() => { throw new Error(`fold() of ${shape.kind} not yet supported`); })();
    return { tailNode, shape: { kind: 'list', elem: fe } };
  }
  if (shape.kind !== 'value') throw new Error(`${reducer}() of ${shape.kind} not yet supported`);
  if (reducer === 'sum')
    // typeof(SUM) is 'integer' or 'real' → handler frames Int/Long vs Double.
    return { tailNode: q`SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (${tailNode})`, shape: { kind: 'scalar' } };
  // min/max/mean reduce over NUMERIC values only: a non-numeric or absent stream
  // yields nothing (SQL aggregate over the empty filtered set → NULL → the handler
  // drops it). Matches TinkerPop, where min() of strings produces no result. mean()
  // is always a Double; min/max keep the element's storage class via typeof().
  const nums = q`SELECT v FROM (${tailNode}) WHERE typeof(v) in ('integer', 'real')`;
  const node = reducer === 'mean'
    ? q`SELECT AVG(v) AS v, 'real' AS vt FROM (${nums})`
    : q`SELECT ${reducer === 'min' ? 'MIN' : 'MAX'}(v) AS v, typeof(${reducer === 'min' ? 'MIN' : 'MAX'}(v)) AS vt FROM (${nums})`;
  return { tailNode: node, shape: { kind: 'scalar' } };
}

// ---------- select()/project() ----------

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  if (!byArgs || byArgs.length === 0) return { sub: 'vertex' }; // no by() / bare by() → the element itself
  const a = byArgs[0];
  if (typeof a === 'string') return { sub: 'value', key: a };
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported by() modulator');
}

/**
 * select(labels…)/project(keys…). select reads previously-labelled traversers
 * from their alias columns; project applies its by() modulators to the current
 * traverser under freshly-named keys. by() modulators cycle across the keys. A
 * single-key select reuses the scalar vertex/value shape; anything else is a Map.
 */
function compileSelectProject(st: St, proj: PStep, tail: TailMods, indexKeys: Set<string>): Compiled {
  const bys = proj.bys ?? [];
  const { orders, distinct, offset, limit } = tail;
  if (orders.length) throw new Error('order() after select()/project() not yet supported');
  const isProject = proj.name === 'project';
  const aliases: AliasMap = st.aliases;
  const curElem = st.elem;

  // Reject the deferred long-tail forms explicitly (tokens are captured, not
  // silently dropped) so a Pop/Column arg can never mis-execute as a plain key.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);

  const sourceOf = (k: string): string => {
    if (isProject) {
      if (curElem === 'edge') throw new Error('project() of an edge is not yet supported');
      return 'p.id';
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    if (entry.elem === 'edge') throw new Error(`select("${k}") of an edge-typed label is not yet supported`);
    return `p.${entry.col}`;
  };
  const entryKind = (i: number) => byToEntry(bys.length ? bys[i % bys.length] : undefined);

  const tailSql = (limit !== null || offset > 0) ? ` LIMIT ${limit ?? -1} OFFSET ${offset}` : '';
  const dist = distinct ? 'DISTINCT ' : '';
  const p = st.last.as('p');

  // Single-key select → the labelled element directly (not wrapped in a Map).
  if (!isProject && keys.length === 1) {
    const src = sourceOf(keys[0]);
    const e = entryKind(0);
    const n = nodes.as('n');
    if (e.sub === 'vertex') {
      const l = labels.as('l');
      return readCompiled(st.q, q`SELECT ${dist}COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${n.c.props} FROM ${n} JOIN ${p} ON ${n.c.id}=${src} JOIN ${l} ON ${l.c.id}=${n.c.label}${tailSql}`, { kind: 'vertex' }, [...indexKeys]);
    }
    const pe = propExtract('n.props', e.key); // projection, not indexed (matches values())
    return readCompiled(st.q, q`SELECT ${dist}${pe.expr} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${src}${tailSql}`, { kind: 'value' }, [...indexKeys]);
  }

  // Multi-key select / any project → a Map per row.
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const entries: MapEntry[] = keys.map((k, i) => {
    const prefix = `e${i}`;
    const e = entryKind(i);
    const src = sourceOf(k);
    const en = nodes.as(`${prefix}n`);
    joins.push(q` JOIN ${en} ON ${en.c.id}=${src}`);
    if (e.sub === 'vertex') {
      const el = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${el} ON ${el.c.id}=${en.c.label}`);
      cols.push(q`COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${en.c.props} AS ${`${prefix}_props`}`);
    } else {
      cols.push(q`${propExtract(`${prefix}n.props`, e.key).expr} AS ${`${prefix}_v`}`); // projection, not indexed
    }
    return { key: k, prefix, sub: e.sub };
  });

  const node = q`SELECT ${dist}${list(cols, ', ')} FROM ${p}${list(joins, '')}${tailSql}`;
  return readCompiled(st.q, node, { kind: 'map', entries }, [...indexKeys]);
}

// ---------- path() (linear regime) ----------

/** Interpret one path().by() modulator: undefined → the whole element; a string →
 *  a property-key projection; token/traversal by()s defer. */
function pathBy(byArgs: any[] | undefined): string | undefined {
  if (!byArgs || byArgs.length === 0) return undefined; // no by()/bare by() → the element
  const a = byArgs[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('path().by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`path().by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported path().by() modulator');
}

/**
 * path(): frame each tracked path position (p0..pN, seeded at V(), one appended per
 * hop) as one Path per row. Without by(), each position is the whole element (joined
 * to its table for id/label/props); a by(key) projects that element's property as a
 * scalar and cycles the modulators round-robin across positions. A non-productive
 * by(key) (missing property) drops the whole path (TinkerPop's default — only
 * ProductiveByStrategy would emit null). order()/reducers/from()/to() defer.
 */
function compilePath(st: St, proj: PStep, acc: TailAcc, indexKeys: Set<string>): Compiled {
  // Reachable only from a union() SOURCE step: seedUnion doesn't seed p0 (unlike
  // seedSource, which handles V()/E()), so path tracking never starts. Mid-chain
  // union()/optional()/repeat() are caught earlier by their own path guards.
  if (!st.path) throw new Error('path() over a union() source step is not yet supported');
  if (st.path.kind === 'array') return compilePathArray(st, acc, indexKeys);
  const pathState = st.path; // narrowed to 'cols'; held in a local so the .map closure keeps the narrowing
  if (acc.orders.length) throw new Error('order() after path() not yet supported');
  if (acc.reducer) throw new Error(`${acc.reducer}() after path() not yet supported`);
  if (acc.isPreds.length) throw new Error('is() after path() not yet supported');
  if (acc.transforms.length) throw new Error(`${acc.transforms[0].name}() after path() not yet supported`);
  if (acc.injects.length) throw new Error('inject() after path() not yet supported');

  const bys = proj.bys ?? [];
  const p = st.last.as('p');
  const joins: Expression[] = [];
  const cols: Expression[] = [];
  const whereParts: Expression[] = [];
  const positions: PathPos[] = pathState.cols.map((pos, i) => {
    const prefix = `x${i}`;
    const tbl = (pos.elem === 'edge' ? edges : nodes).as(`${prefix}n`);
    joins.push(q` JOIN ${tbl} ON ${tbl.c.id}=${p.c[pos.col]}`);
    const key = pathBy(bys.length ? bys[i % bys.length] : undefined);
    if (key === undefined) {
      const l = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${l} ON ${l.c.id}=${tbl.c.label}`);
      const extId = q`COALESCE(${tbl.c.uid}, ${tbl.c.id})`;
      if (pos.elem === 'edge') {
        // Endpoints as external ids (see the __element edge projector).
        cols.push(q`${extId} AS ${`${prefix}_id`}, ${l.c.name} AS ${`${prefix}_label`}, ${extIdOf(tbl.c.src)} AS ${`${prefix}_src`}, ${extIdOf(tbl.c.tgt)} AS ${`${prefix}_tgt`}, ${tbl.c.props} AS ${`${prefix}_props`}`);
        return { render: 'element', elem: 'edge', prefix };
      }
      cols.push(q`${extId} AS ${`${prefix}_id`}, ${l.c.name} AS ${`${prefix}_label`}, ${tbl.c.props} AS ${`${prefix}_props`}`);
      return { render: 'element', elem: 'vertex', prefix };
    }
    // by(key): project the element's property; a missing key drops the whole path.
    const pe = propExtract(`${prefix}n.props`, key);
    cols.push(q`${pe.expr} AS ${`${prefix}_v`}`);
    whereParts.push(predicateSql(pe.expr, undefined)); // <pe> IS NOT NULL (non-productive by → drop)
    return { render: 'value', prefix };
  });

  const dist = acc.distinct ? 'DISTINCT ' : '';
  const whereNode = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;
  const tailSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const node = q`SELECT ${dist}${list(cols, ', ')} FROM ${p}${list(joins, '')}${whereNode}${tailSql}`;
  return readCompiled(st.q, node, { kind: 'path', positions }, [...indexKeys]);
}

/**
 * path() over a recursive repeat() walk (the `array` regime). The walk (branch.ts)
 * accumulated a JSONB array of visited ids per surviving traverser (`st.last` =
 * `(id, path)`). Give each path a row number (`pk`), explode the array with
 * `json_each` (`.key` = ordinal), materialize each element, and emit ONE ROW PER
 * PATH ELEMENT ordered by `(pk, ord)` — the handler folds each pk-run into one Path.
 * All elements are vertices (out/in/both bodies); edge-inclusive bodies defer.
 */
function compilePathArray(st: St, acc: TailAcc, indexKeys: Set<string>): Compiled {
  if (acc.orders.length || acc.reducer || acc.isPreds.length || acc.transforms.length || acc.injects.length)
    throw new Error('order()/reducer/is()/transform after a recursive repeat().path() not yet supported');
  // dedup() must collapse equal paths BEFORE row-numbering: ROW_NUMBER() is computed
  // with the SELECT list, so a `SELECT DISTINCT path, ROW_NUMBER()…` never removes a
  // row (the unique pk defeats DISTINCT). Distinct-ify in a prior CTE, then number.
  const src = acc.distinct ? st.q.cte(q`SELECT DISTINCT ${st.last.c.path} AS path FROM ${st.last}`, ['path']) : st.last;
  // ROW_NUMBER over the surviving paths → a stable per-path key so equal-id paths
  // stay distinct (multiset) after the json_each explode.
  const limitSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const paths = st.q.cte(q`SELECT ${src.c.path} AS path, ROW_NUMBER() OVER (ORDER BY ${src.c.path}) AS pk FROM ${src}${limitSql}`, ['path', 'pk']);
  const n = nodes.as('n');
  const l = labels.as('l');
  const node = q`SELECT pp.pk, je.key AS ord, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${n.c.props} AS props FROM ${paths} pp, json_each(pp.path) je JOIN ${n} ON ${n.c.id}=je.value JOIN ${l} ON ${l.c.id}=${n.c.label} ORDER BY pp.pk, je.key`;
  return readCompiled(st.q, node, { kind: 'pathGrouped', elem: 'vertex' }, [...indexKeys]);
}

// ---------- map (scalar body → per-traverser scalar projector) ----------

/**
 * map(__.<scalar>) → one correlated scalar per traverser (shape value), reusing
 * compileNestedScalar (values/label/id/constant/out().count()/edge-aggregate). An
 * element-body map is first-result-only (needs a per-input row-number) and an alias/
 * select/fold body isn't a plain scalar — both defer via compileNestedScalar's throw.
 * A trailing step defers.
 */
function compileMapScalar(st: St, steps: PStep[], stop: number, indexKeys: Set<string>): Compiled {
  if (stop + 1 < steps.length) throw new Error(`step not implemented after map(): ${steps[stop + 1].name}()`);
  const arg = steps[stop].args[0];
  if (!arg || typeof arg !== 'object' || !('nested' in arg)) throw new Error('map(traversal) required');
  const ctx = elemCtx(elemRel(st), st.elem);
  const sc = compileNestedScalar(stepChain(arg.nested, st.params), ctx);
  const n = elemRel(st);
  const p = st.last.as('p');
  const node = q`SELECT ${sc.expr} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const keys = sc.indexKey ? new Set([...indexKeys, sc.indexKey]) : indexKeys;
  return readCompiled(st.q, node, { kind: 'value' }, [...keys]);
}

// ---------- math (scalar arithmetic projector) ----------

/**
 * math("<formula>") → a per-traverser Double scalar. The formula (src/math.ts)
 * becomes one SQL arithmetic expression; its variables resolve here:
 *   - `_`        → the current traverser (elemCtx).
 *   - an alias   → an as()-bound traverser (aliasCtx over the carried rowid column).
 * Each variable's scalar value comes from its by() modulator (a property key or a
 * nested traversal, via compileNestedScalar) — positional/round-robin over the
 * folded by()s in first-seen variable order, so a single by() feeds every variable
 * and N by()s feed N variables (matching project()). A missing by() value makes the
 * arithmetic NULL, so the traverser is filtered (a by() that produces nothing drops
 * the traverser, per TinkerPop). The result routes through the shared value tail, so
 * a trailing asNumber()/is()/order()/dedup()/limit() composes (renderProjection).
 * Deferred (clear throws): a variable with no by() (bare incoming value — needs
 * local()/sack()), withSideEffect-bound variables, and reading project()/select()
 * map columns (math inside order().by(__.math(...))).
 */
function compileMath(st: St, steps: PStep[], stop: number, indexKeys: Set<string>): Compiled {
  const s = steps[stop];
  const formula = s.args[0];
  if (typeof formula !== 'string') throw new Error('math(string) required');
  const bys = s.bys ?? [];
  const varOrder = mathVars(formula);

  const p = st.last.as('p');
  const cache = new Map<string, Expression>();
  const resolveVar = (name: string): Expression => {
    const hit = cache.get(name);
    if (hit) return hit;
    if (!bys.length) throw new Error(`math("${formula}"): variable "${name}" needs a by() modulator`);
    const byArgs = bys[varOrder.indexOf(name) % bys.length];
    let ctx: ScalarCtx;
    if (name === '_') ctx = elemCtx(elemRel(st), st.elem);
    else {
      const entry = st.aliases.get(name);
      if (!entry) throw new Error(`math("${formula}"): no such variable "${name}" — as("${name}") was not seen`);
      ctx = aliasCtx(p.c[entry.col], entry.elem);
    }
    const nested = byArgs.find((a: any) => a && typeof a === 'object' && 'nested' in a);
    const strKey = byArgs.find((a: any) => typeof a === 'string');
    let sc;
    if (nested) sc = compileNestedScalar(stepChain(nested.nested, st.params), ctx);
    else if (strKey !== undefined) sc = propAt(ctx.idExpr, ctx.propsExpr, strKey); // by(key): a plain property read
    else throw new Error(`math("${formula}"): by() modulator must be a property key or a traversal`);
    if (sc.indexKey && ctx.elem === 'node') indexKeys.add(sc.indexKey);
    cache.set(name, sc.expr);
    return sc.expr;
  };

  const mathExpr = mathToSql(formula, resolveVar);

  // math() always yields a Double; route through the shared value tail.
  const acc = foldTailAcc(steps, stop + 1);
  const n = elemRel(st);
  const proj: ProjResult = {
    shape: { kind: 'value', as: 'double' }, colsNode: q`${mathExpr} AS v`,
    fromNode: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`, scalarExpr: mathExpr,
    // Drop rows a non-productive by() left NULL (a missing property/empty traversal
    // filters the traverser, per MathStep). NULL propagates through every op, so this
    // one check on the result subsumes a per-variable NULL guard. It ALSO drops a SQL
    // domain-error result (X/0, sqrt(neg), log(0) → NULL in SQLite, never Inf/NaN):
    // fail-closed (no row), since GraphBinary Double framing has no Inf/NaN path — a
    // known, unreachable-in-corpus divergence, deliberately not emitting a wrong 0.0.
    baseWhere: predicateSql(mathExpr, undefined),
  };
  return renderProjection(st.q, proj, acc, indexKeys, nodePropOrderKey(st, indexKeys));
}

// ---------- option-map choose (scalar CASE projector) ----------

/**
 * option-map choose(choiceFn).option(key, body)… → one CASE over a correlated choice
 * scalar. The choice is a T token or a nested scalar traversal (values/label/id/
 * out().count()); each keyed option → `WHEN predicateSql(choice, key) THEN <body>`
 * (a P key → its predicate, a literal → equality); the key-less option (Pick.none) →
 * the ELSE. Requires a Pick.none default with a scalar body: without one, unmatched
 * inputs pass through as the element itself (TinkerPop identity) → a mixed vertex/
 * scalar result the one-shape framing can't carry, so that defers. Scalar bodies only
 * (constant/values/label/id via compileNestedScalar); element bodies, Pick.
 * unproductive/any, and any trailing step defer. Shape: value.
 */
function compileChooseOptions(st: St, steps: PStep[], stop: number, indexKeys: Set<string>): Compiled {
  const cs = steps[stop];
  if (stop + 1 < steps.length) throw new Error(`step not implemented after choose().option(): ${steps[stop + 1].name}()`);
  const ctx = elemCtx(elemRel(st), st.elem);

  const a0 = cs.args[0];
  let choice: Expression;
  if (a0 && typeof a0 === 'object' && 'token' in a0)
    choice = a0.token === 'label' ? labelNameSub(ctx.labelIdExpr)
      : a0.token === 'id' ? ctx.extIdExpr!
      : (() => { throw new Error(`choose(T.${a0.token}) not yet supported`); })();
  else if (a0 && typeof a0 === 'object' && 'nested' in a0)
    choice = compileNestedScalar(stepChain(a0.nested, st.params), ctx).expr;
  else throw new Error('choose() choice must be a traversal or a T token');

  const whens: Expression[] = [];
  let elseExpr: Expression = q`NULL`;
  let sawNone = false;
  for (const opt of cs.options!) {
    const bodyArg = opt.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
    if (!bodyArg) throw new Error('option() requires a traversal body');
    const bodyScalar = compileNestedScalar(stepChain(bodyArg.nested, st.params), ctx).expr;
    const keyArg = opt.args.find((x: any) => x !== bodyArg);
    if (keyArg === undefined || (keyArg && typeof keyArg === 'object' && 'pick' in keyArg)) {
      const pick = keyArg && typeof keyArg === 'object' && 'pick' in keyArg ? keyArg.pick : 'none';
      if (pick !== 'none') throw new Error(`option(Pick.${pick}) not yet supported`);
      if (!sawNone) { elseExpr = bodyScalar; sawNone = true; } // first Pick.none wins
    } else {
      whens.push(q`WHEN ${predicateSql(choice, keyArg)} THEN ${bodyScalar}`);
    }
  }
  if (!whens.length) throw new Error('choose().option() needs at least one keyed option');
  // No Pick.none → unmatched inputs are the element itself (mixed vertex/scalar): defer.
  if (!sawNone) throw new Error('choose().option() without a Pick.none default not yet supported (unmatched pass-through is mixed-shape)');
  const n = elemRel(st);
  const p = st.last.as('p');
  const node = q`SELECT CASE ${list(whens, ' ')} ELSE ${elseExpr} END AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  return readCompiled(st.q, node, { kind: 'value' }, [...indexKeys]);
}

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind. */
interface GroupSource { from: string; ctx: ScalarCtx; elem: ElemShape; }

/** Columns that frame one element (vertex/edge/property) under `prefix`. label
 *  rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx): Expression {
  const extId = ctx.extIdExpr ?? ctx.idExpr;
  if (elem === 'edge')
    // Endpoints as external ids (see the __element edge projector).
    return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${extIdOf(ctx.srcExpr!)} AS ${`${prefix}_src`}, ${extIdOf(ctx.tgtExpr!)} AS ${`${prefix}_tgt`}, ${ctx.propsExpr} AS ${`${prefix}_props`}`;
  if (elem === 'property')
    return q`${ctx.ownerExpr!} AS ${`${prefix}_owner`}, ${ctx.pkExpr!} AS ${`${prefix}_pk`}, ${ctx.pvExpr!} AS ${`${prefix}_pv`}`;
  return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${ctx.propsExpr} AS ${`${prefix}_props`}`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx): Expression => elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string | Expression }

/** Build the key columns for group(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, indexKeys: Set<string>, params: Record<string, any>): GroupKeyBuild {
  if (!keyArgs || keyArgs.length === 0) { // bare by() → the element itself is the key
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx), group: elementIdExpr(src.elem, src.ctx) };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name')
    const pe = propExtract(src.ctx.propsExpr, a);
    if (pe.indexKey && src.elem === 'vertex') indexKeys.add(pe.indexKey);
    return { desc: { kind: 'scalar' }, cols: q`${pe.expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'token' in a) { // by(T.label)/by(T.id)
    const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: { kind: 'scalar' }, cols: q`${expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project') { // composite Map key
      const keys = inner[0].args.filter((x: any): x is string => typeof x === 'string');
      const partBys = inner.slice(1);
      if (partBys.some((s) => s.name !== 'by')) throw new Error(`step not implemented in group().by(project): ${partBys.find((s) => s.name !== 'by')!.name}()`);
      if (partBys.length !== keys.length) throw new Error('group().by(project) needs one by() per key');
      const cols: Expression[] = [], group: string[] = [];
      keys.forEach((k, idx) => {
        const nb = partBys[idx].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
        if (!nb) throw new Error('group().by(project(...).by(x)) requires a traversal in each by()');
        const sc = compileNestedScalar(stepChain(nb.nested, params), src.ctx);
        cols.push(q`${sc.expr} AS ${`k${idx}_v`}`); group.push(`k${idx}_v`);
      });
      return { desc: { kind: 'map', parts: keys.map((k) => ({ key: k })) }, cols: list(cols, ', '), group: group.join(', ') };
    }
    const sc = compileNestedScalar(inner, src.ctx); // by(__.label()) etc → scalar
    return { desc: { kind: 'scalar' }, cols: q`${sc.expr} AS gk`, group: 'gk' };
  }
  throw new Error('unsupported group().by() key modulator');
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value can't be aggregated in SQL (props must be
 * framed), so we emit rows ORDER BY the key and the handler folds runs into the Map.
 */
function compileGroup(st: St, isCount: boolean, bys: any[][], src: GroupSource, indexKeys: Set<string>): Compiled {
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const key = buildGroupKey(bys[0], src, indexKeys, st.params);

  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
  else {
    const a = valArgs[0];
    if (typeof a === 'string') { // by('age') → list of scalars
      const pe = propExtract(src.ctx.propsExpr, a);
      val = { kind: 'scalarList' }; valNode = q`json_group_array(${pe.expr}) AS gv`;
    } else if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, st.params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'tail') { val = { kind: 'elementLast', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'fold') { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'count') { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
      else if (MOVES_ROOT.has(names[0]) && SCALAR_REDUCERS.has(names[names.length - 1])) {
        // A neighbourhood aggregate — e.g. by(__.bothE().values('weight').mean()).
        // compileNestedScalar reduces the WHOLE chain to one correlated scalar per
        // group key; MAX() just satisfies GROUP BY (each such group is one vertex,
        // so the scalar is constant within it). typeof() carries Int/Long/Double.
        const sc = compileNestedScalar(inner, src.ctx);
        val = { kind: 'sum' }; valNode = q`MAX(${sc.expr}) AS gv, typeof(MAX(${sc.expr})) AS gvt`;
      } else if (names[names.length - 1] === 'sum') {
        const sc = compileNestedScalar(inner.slice(0, -1), src.ctx);
        val = { kind: 'sum' }; valNode = q`SUM(${sc.expr}) AS gv, typeof(SUM(${sc.expr})) AS gvt`; // gvt → Int/Long vs Double
      } else { // scalar projection folded to a list
        const sc = compileNestedScalar(inner, src.ctx);
        val = { kind: 'scalarList' }; valNode = q`json_group_array(${sc.expr}) AS gv`;
      }
    } else throw new Error('unsupported group().by() value modulator');
  }

  const node = q`SELECT ${key.cols}, ${valNode} FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${key.group}`;
  return readCompiled(st.q, node, { kind: 'group', key: key.desc, val }, [...indexKeys]);
}

// ---------- properties() ----------

/**
 * properties()/properties(keys) on the current element, plus an optional single
 * follow-on: key()/value()/count(), or element()[.values/.id/.label/.count]. The
 * traverser is a property — a json_each expansion over the owner's props.
 */
function compileProperties(st: St, tail: PStep[], indexKeys: Set<string>): Compiled {
  const elem = st.elem;
  const keys = tail[0].args.filter((a): a is string => typeof a === 'string');
  const keyFilter: Expression = keys.length ? q` WHERE je.key IN (${list(keys.map(value), ',')})` : empty;
  const n = elemRel(st);
  const p = st.last.as('p');
  const l = labels.as('l');
  const propBody = q`SELECT ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${n.c.props} AS ownerProps, je.key AS pk, je.value AS pv FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}, json_each(${n.c.props}) je${keyFilter}`;
  const pc = st.q.cte(propBody, ['owner', 'ownerLabel', 'ownerProps', 'pk', 'pv']);

  const done = (node: Expression, shape: Shape, consumed: number): Compiled => {
    if (tail.length > consumed) throw new Error(`step not implemented after properties(): ${tail[consumed].name}()`);
    return readCompiled(st.q, node, shape, [...indexKeys]);
  };

  const next = tail[1]?.name;

  // properties().group()/.groupCount() — group over the property stream.
  if (next === 'group' || next === 'groupCount') {
    if (2 < tail.length) throw new Error(`step not implemented after properties().${next}(): ${tail[2].name}()`);
    const ctx: ScalarCtx = { elem: 'property', idExpr: pc.c.owner, propsExpr: pc.c.ownerProps, labelIdExpr: q`(SELECT label FROM nodes WHERE id=${pc.c.owner})`, ownerExpr: pc.c.owner, ownerPropsExpr: pc.c.ownerProps, pkExpr: pc.c.pk, pvExpr: pc.c.pv };
    const src: GroupSource = { from: pc.name, ctx, elem: 'property' };
    return compileGroup(st, next === 'groupCount', tail[1].bys ?? [], src, indexKeys);
  }

  switch (next) {
    case undefined: // properties() terminal → VertexProperty elements
      return done(q`SELECT owner, pk, pv FROM ${pc}`, { kind: 'property' }, 1);
    case 'key':
      return done(q`SELECT pk AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'value':
      return done(q`SELECT pv AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'count':
      return done(q`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 2);
    case 'element': {
      const after = tail[2]?.name;
      if (elem === 'edge' && after === undefined) throw new Error('element() of an edge property not yet supported');
      switch (after) {
        case undefined:
          return done(q`SELECT owner AS id, ownerLabel AS label, ownerProps AS props FROM ${pc}`, { kind: 'vertex' }, 2);
        case 'id':
          return done(q`SELECT owner AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'label':
          return done(q`SELECT ownerLabel AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'values': {
          const pe = propExtract('ownerProps', tail[2].args[0]);
          return done(q`SELECT ${pe.expr} AS v FROM ${pc} WHERE ${predicateSql(pe.expr, undefined)}`, { kind: 'value' }, 3);
        }
        case 'count':
          return done(q`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 3);
        default:
          throw new Error(`step not implemented after element(): ${after}()`);
      }
    }
    default:
      throw new Error(`step not implemented after properties(): ${next}()`);
  }
}
