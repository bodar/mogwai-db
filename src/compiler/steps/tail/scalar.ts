import { derived, empty, list, paren, q, raw, value, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { hasUnresolvedOperand, operandDeps, resolveTraversalOperands } from './operand.ts';
import { compareKey, predicateSql, rangeToOffsetLimit, scalarTx, TYPE_PER_ROW, TYPE_STATIC, TYPE_UNKNOWN } from '../../plan/plan.ts';
import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import { type PStep } from '../../ir/strategies.ts';
import { aliasArmProjection, carryFrag, carryFragMint, carriedCols, carriedWith, mergeAliasMaps, partitionOver, withoutCarried, type Carry } from '../context/context.ts';
import { carryOf, rebuildScalar, toListStream, toMapStream, toScalarStream, type ListStream, type MapStream, type ScalarStream } from '../context/stream.ts';
import { asDateSql, asNumberSql, dateDiffOtherMs, dtFactor, numericSpec } from './coerce.ts';
import { normalizeTypeName } from '../../../gremlin/types.ts';
import { perRowColumnOf, perRowCols, scalarType, staticTypeOf, UNKNOWN, type ScalarType, type ValueType } from '../../../sql/kernel/render.ts';
import { engineOf } from '../../engine/deps.ts';

/** If `step` is `is(typeOf(GType.X))` for a COLLECTION type, the canonical collection name
 *  ('list'|'set'|'map'); else null. list/set RETYPE a scalar value stream into a ListStream
 *  (the stored collection value becomes the `list` column) so the whole list substrate
 *  (unfold/count(local)/range/…) reuses it — see scalarCollectionRetype. MAP stays a plain
 *  scalar vtype filter (no MapStream relational unfold yet — deferred); a bare map value
 *  still frames whole via the per-row vtype path (execute.ts case 'value' → frameStoredValue). */
export function collectionTypeOf(step: PStep): 'list' | 'set' | 'map' | null {
  if (step.name !== 'is') return null;
  const pred = (step.args ?? [])[0];
  if (!pred || typeof pred !== 'object' || pred.op !== 'typeOf') return null;
  const arg = pred.values?.[0];
  const name = (arg && typeof arg === 'object' && 'gtype' in arg) ? String(arg.gtype) : typeof arg === 'string' ? arg : null;
  const c = name ? normalizeTypeName(name) : null;
  return c === 'list' || c === 'set' || c === 'map' ? c : null;
}

/** Retype a scalar value stream at is(typeOf(LIST|SET)): keep only rows whose stored vtype
 *  matches `kind` and expose each stored collection value as the ListStream `list` column
 *  (json() to text so unfold's json_each / reducers / root framing consume the self-
 *  describing {t,v} tree — of.typed). A SET marks the stream so it frames as a GraphBinary
 *  Set. Requires the per-row stored vtype column (values()/properties() of a stored prop);
 *  a computed scalar has no stored collection → null (the generic is() static-folds it). */
export function scalarCollectionRetype(s: ScalarStream, kind: 'list' | 'set'): ListStream | null {
  const vtype = perRowColumnOf(s.type);
  if (!vtype) return null;
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT json(${p.c.v}) AS list${carryFrag(s.carried, p)} FROM ${p} WHERE ${p.c[vtype]} = ${value(kind)}`,
    ['list', ...carriedCols(s.carried)],
  );
  return toListStream(carryOf(s), rel, { kind: 'scalar', typed: true }, kind === 'set');
}

/** Retype a scalar value stream at is(typeOf(MAP)): keep only rows whose stored vtype is 'map'
 *  and expose each stored map value (a [[keyNode,valNode],…] {t,v}-node blob) as the MapStream
 *  `map` column — so unfold()/count(local)/select(Column)/framing reuse the one blob substrate
 *  (mapstream-blob-model). Requires the per-row stored vtype column (values() of a stored prop);
 *  a computed scalar has no stored map → null (the generic is() static-folds it). */
export function scalarMapRetype(s: ScalarStream): MapStream | null {
  const vtype = perRowColumnOf(s.type);
  if (!vtype) return null;
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT json(${p.c.v}) AS map${carryFrag(s.carried, p)} FROM ${p} WHERE ${p.c[vtype]} = ${value('map')}`,
    ['map', ...carriedCols(s.carried)],
  );
  return toMapStream(carryOf(s), rel, { kind: 'scalar' }, { kind: 'scalar' });
}

export const SCALAR_TRANSFORMS = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
  'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff',
]);

export const SACK_OPS = new Set(['assign', 'sum', 'minus', 'mult', 'div', 'min', 'max']);

/** Fold a merge value into the sack under an Operator. assign replaces; the rest
 *  combine with the prior sack (required — via withSack() or a prior assign). div forces
 *  REAL division (SQLite `/` is integer division on integer operands). Shared by the
 *  element sack StepFn (sack.ts) and the scalar-stream sack path below. */
export function combineSack(op: string, byVal: Expression, oldSack: Expression | null): Expression {
  if (op === 'assign') return byVal;
  if (!oldSack) throw new Error(`sack(Operator.${op}) requires withSack() or a prior sack(assign)`);
  return op === 'sum' ? q`(${oldSack} + ${byVal})`
    : op === 'minus' ? q`(${oldSack} - ${byVal})`
    : op === 'mult' ? q`(${oldSack} * ${byVal})`
    : op === 'div' ? q`(CAST(${oldSack} AS REAL) / ${byVal})`
    : op === 'min' ? q`MIN(${oldSack}, ${byVal})`
    : q`MAX(${oldSack}, ${byVal})`;
}

export const SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'limit', 'skip', 'range', 'tail', 'order', 'dedup',
  'count', 'sum', 'min', 'max', 'mean', 'fold', 'unfold', 'inject',
]);

const isLocal = (step: PStep): boolean =>
  (step.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');

// Payload = the value/type projection columns; emission order (encounter) is a CARRIED
// column now, so it rides via carryFrag alongside every other carried column (never here).
const payload = (s: ScalarStream, p: ReturnType<ScalarStream['rel']['as']>): Expression =>
  q`${s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`}${perRowColumnOf(s.type) ? q`, ${p.c[perRowColumnOf(s.type)!]} AS ${perRowColumnOf(s.type)!}` : empty}`;

const cols = (s: ScalarStream): string[] =>
  [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...perRowCols(s.type), ...carriedCols(s.carried)];

function rowPreserving(s: ScalarStream, suffix: Expression, orderByEnc = false): ScalarStream {
  const p = s.rel.as('p');
  // A root slice (limit/skip/range) picks a DETERMINISTIC window only when the chain carries
  // emission order (Stage B); otherwise it stays order-free over incidental row order.
  const order = orderByEnc && s.carried.encounter ? q` ORDER BY ${p.c[s.carried.encounter]}` : empty;
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p}${order}${suffix}`, cols(s));
  return rebuildScalar(s, rel);
}

function scalarTransform(step: PStep, currentAs: ValueType | undefined, expr: Expression, next?: PStep): { expr: Expression; as?: ValueType } {
  let as: ValueType | undefined;
  if (step.name === 'asNumber') {
    const spec = numericSpec(step.args[0]);
    if (spec) { expr = asNumberSql(spec, expr); as = spec.as; }
    else if (currentAs === 'datetime') as = 'long';
    else if (next?.name === 'asDate') { expr = q`CAST(${expr} AS INTEGER)`; as = 'long'; }
    else throw new Error('bare asNumber() over a non-date runtime value not yet supported');
  } else if (step.name === 'asDate') {
    expr = asDateSql(expr); as = 'datetime';
  } else if (step.name === 'dateAdd') {
    expr = q`(${expr} + ${value(Number(step.args[1]) * dtFactor(step.args[0]))})`; as = 'datetime';
  } else if (step.name === 'dateDiff') {
    expr = q`(${expr} - ${value(dateDiffOtherMs(step.args[0], {}))})`; as = 'long';
  } else {
    expr = scalarTx(step.name, step.args ?? [], expr)
      ?? (() => { throw new Error(`scalar transform ${step.name}() not supported`); })();
  }
  return { expr, as };
}

/** Fuse a maximal transform/predicate segment into one SELECT. Predicates capture the
 * expression visible at their exact position, so `tx().is().tx()` remains ordered even
 * though the final SQL has no intermediate CTE. Physical row boundaries are still
 * emitted for order/slice/dedup/barriers, where sequence changes cardinality/order. */
function fuseScalarSegment(s: ScalarStream, steps: readonly PStep[], from: number): { stream: ScalarStream; stop: number } {
  const p = s.rel.as('p');
  let expr: Expression = p.c.v;
  let as = staticTypeOf(s.type);
  let transformed = false;
  const predicates: Expression[] = [];
  let i = from;
  for (; i < steps.length; i++) {
    const step = steps[i];
    // A Scope.local scalar transform ignores scope (a scalar is a one-element list); a
    // non-transform local step ends the fused segment (handled by lowerScalarRows).
    if (isLocal(step) && !SCALAR_TRANSFORMS.has(step.name)) break;
    if (SCALAR_TRANSFORMS.has(step.name)) {
      const out = scalarTransform(step, as, expr, steps[i + 1]);
      expr = out.expr;
      as = out.as;
      transformed = true;
      continue;
    }
    if (step.name === 'is') {
      // typeOf resolves against the value's type at THIS position: a transform has made
      // it compile-time-known (staticAs = the transformed `as`); otherwise the per-row
      // stored vtype column (if any) answers it, else a storage-class fallback.
      const perRow = transformed ? undefined : perRowColumnOf(s.type);
      const typeCtx = as ? TYPE_STATIC(as) : perRow ? TYPE_PER_ROW(p.c[perRow]) : TYPE_UNKNOWN;
      // A re-sourced traversal operand (is(__.V(id).values('age'))) becomes a scalar subquery
      // before the pure SQL layer sees it — see steps/tail/operand.ts.
      predicates.push(predicateSql(expr, resolveTraversalOperands(step.args[0], operandDeps(s), { row: p }), typeCtx));
      continue;
    }
    break;
  }
  // A transform RETYPES its output: the incoming per-row vtype no longer describes the
  // value, so the type channel becomes whatever the transform statically produced (`as`,
  // possibly unknown). A pure is()-only segment is row-preserving and keeps the channel
  // it was handed. This is the one rule; it replaces reasoning about two fields at once.
  const outType = transformed ? scalarType(as) : s.type;
  const keepVtype = perRowColumnOf(outType);
  const valueCols = transformed
    ? q`${expr} AS v`
    : q`${p.c.v} AS v${s.result === 'number' ? q`, ${p.c.vt} AS vt` : empty}`;
  const where = predicates.length ? q` WHERE ${list(predicates, ' AND ')}` : empty;
  const rel = s.q.cte(
    q`SELECT ${valueCols}${keepVtype ? q`, ${p.c[keepVtype]} AS ${keepVtype}` : empty}${carryFrag(s.carried, p)} FROM ${p}${where}`,
    ['v', ...(!transformed && s.result === 'number' ? ['vt'] : []), ...(keepVtype ? [keepVtype] : []), ...carriedCols(s.carried)],
  );
  return {
    stream: toScalarStream(carryOf(s), rel, undefined, {
      type: outType,
      result: transformed ? 'value' : s.result,
      productiveNull: transformed ? undefined : s.productiveNull,
    }),
    stop: i,
  };
}

function partitionedSlice(s: ScalarStream, offset: number, limit: number | null): ScalarStream {
  if (!s.carried.encounter) throw new Error('correlated scalar slice requires explicit encounter order');
  const enc = s.carried.encounter;
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[enc]}` : q`ORDER BY ${p.c[enc]}`;
  const rankedCols = [...cols(s), 'rn'];
  const r = derived(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (${over}) AS rn FROM ${p}`, rankedCols, 'r');
  const hi = limit == null ? empty : q` AND ${r.c.rn}<=${offset + limit}`;
  const rel = derived(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}>${offset}${hi}`, cols(s), 'slice');
  return rebuildScalar(s, rel);
}

function partitionedTail(s: ScalarStream, limit: number): ScalarStream {
  if (!s.carried.encounter) throw new Error('scalar tail requires explicit encounter order');
  const enc = s.carried.encounter;
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length
    ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[enc]} DESC`
    : q`ORDER BY ${p.c[enc]} DESC`;
  const r = derived(
    q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (${over}) AS rn FROM ${p}`,
    [...cols(s), 'rn'],
    'r',
  );
  const rel = derived(
    q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}<=${limit}`,
    cols(s),
    'tail_rows',
  );
  return rebuildScalar(s, rel);
}

/** Root-scope tail(N): the last N rows of the relation's natural order. Unlike a child scope
 *  (partitionedTail, keyed on the explicit encounter), the root stream has no per-origin
 *  partition, so `COUNT(*) OVER ()` + `ROW_NUMBER() OVER ()` select the trailing window
 *  directly — no encounter column required (mirrors the root LIMIT/OFFSET of limit/skip). */
function rootTail(s: ScalarStream, limit: number): ScalarStream {
  const p = s.rel.as('p');
  // With emission order (Stage B) the trailing window is the last N BY encounter; otherwise it
  // is the last N of the relation's incidental order (an empty window).
  const over = s.carried.encounter ? q`ORDER BY ${p.c[s.carried.encounter]}` : empty;
  const r = derived(
    q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (${over}) AS rn, COUNT(*) OVER () AS cnt FROM ${p}`,
    [...cols(s), 'rn', 'cnt'],
    'r',
  );
  const rel = derived(
    q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn} > ${r.c.cnt} - ${limit}`,
    cols(s),
    'tail_rows',
  );
  return rebuildScalar(s, rel);
}

function partitionedOrder(s: ScalarStream, order: Expression): ScalarStream {
  if (!s.carried.encounter) throw new Error('correlated scalar order requires explicit encounter order');
  const enc = s.carried.encounter;
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${order}, ${p.c[enc]}` : q`ORDER BY ${order}, ${p.c[enc]}`;
  // order SUPERSEDES the encounter column (a fresh ROW_NUMBER) in its declared carried slot
  // (carryFragMint), preserving each row's value + stored type. cols(s) = [v,(vt),(vtype),carried].
  const valuePayload = s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`;
  const sPerRow = perRowColumnOf(s.type);
  const vtypeCol = sPerRow ? q`, ${p.c[sPerRow]} AS ${sPerRow}` : empty;
  const rel = s.q.cte(q`SELECT ${valuePayload}${vtypeCol}${carryFragMint(s.carried, p, enc, q`ROW_NUMBER() OVER (${over})`)} FROM ${p}`, cols(s));
  return rebuildScalar(s, rel);
}

function partitionedDedup(s: ScalarStream): ScalarStream {
  if (!s.carried.encounter) throw new Error('correlated scalar dedup requires explicit encounter order');
  const enc = s.carried.encounter;
  const p = s.rel.as('p');
  const partitions = [...s.carried.origins.map((name) => p.c[name]), p.c.v, ...(s.result === 'number' ? [p.c.vt] : [])];
  const r = derived(
    q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[enc]}) AS rn FROM ${p}`,
    [...cols(s), 'rn'],
    'r',
  );
  const rel = derived(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}=1`, cols(s), 'dedup_rows');
  return rebuildScalar(s, rel);
}

/** mean(Scope.local) on a scalar stream: each value is a one-element list whose mean is
 *  the value AS A DOUBLE (mean is always Double, even of one element — d[29.0].d). Drops
 *  the stored vtype (the result is a fresh Double, not the original type). */
function localMeanScalar(s: ScalarStream): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT CAST(${p.c.v} AS REAL) AS v${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, 'double', { result: 'value' });
}

function appendScalar(s: ScalarStream, step: PStep): ScalarStream {
  if (step.args.length === 0) return s;
  if (step.args.some(Array.isArray))
    throw new Error('inject(list) into a scalar stream needs a mixed-shape row discriminant');
  // A carried bulk column is benign: thread it (existing rows keep their multiplicity, each
  // appended constant is one bulk-1 traverser). An emission-order encounter is likewise benign:
  // inject() prepends its values, so each gets a NEGATIVE encounter (sorts before every existing
  // row) — no MAX() subquery needed. Real carried state (aliases/path/origins/…) and a
  // typed/reduced scalar still defer.
  const bulk = s.carried.bulk;
  const enc = s.carried.encounter;
  const benign = new Set([bulk, enc].filter(Boolean) as string[]);
  if (s.result !== 'value' || s.type.kind === 'static' || carriedCols(s.carried).some((c) => !benign.has(c)))
    throw new Error('inject() after typed/reduced/carried scalar state not yet supported');
  const p = s.rel.as('p');
  const n = step.args.length;
  const appended = step.args.map((v, k) =>
    q`SELECT ${value(v)} AS v${bulk ? q`, 1 AS bulk` : empty}${enc ? q`, ${value(k - n)} AS ${enc}` : empty}`);
  const carryCols = [...(bulk ? [bulk] : []), ...(enc ? [enc] : [])];
  const rel = s.q.cte(
    q`SELECT ${p.c.v} AS v${bulk ? q`, ${p.c[bulk]}` : empty}${enc ? q`, ${p.c[enc]}` : empty} FROM ${p} UNION ALL ${list(appended, ' UNION ALL ')}`,
    ['v', ...carryCols],
  );
  return toScalarStream(carryOf(s), rel);
}

// ---------- shape-agnostic filter/branch over a scalar current object ----------
//
// A value-shaped traverser (inject(1), a projected/reduced scalar, …) is a first-class
// traverser whose CURRENT OBJECT is the scalar `v`. The filter family (and/or/not/
// filter/where) and constant() work on it exactly as on an element — the difference is
// only what the "current object" is. Rather than fork the element predicate engine
// (predicate.ts compileInlinePredicate, which reads props/label/adjacency), this reuses the
// PREDICATE LEAF (predicateSql) + the scalar transform ladder (scalarTx) for the one
// case the element engine can't express: a predicate directly over the current scalar.
// Element-only bodies (values/has/out…) fail closed here — a scalar has no properties
// or neighbours.

/**
 * Inline a scalar predicate body → one boolean SQL expression over `current`, the scalar
 * analogue of the element `tryInlinePredicate` (predicate.ts). `is(P)` filters; transforms
 * rewrite the current value; `constant(x)` rebinds it (always productive); and/or/not/filter/
 * where compose recursively. Every `is` ANDs; a bare/constant body is always productive (`1`).
 * Returns `null` when the body is outside the inline vocabulary (a movement/property/branch/
 * reducer step, or an unsupported transform like asBool) — the caller then falls through to the
 * generic child-existence gate (never a throw defining support by vocab exhaustion).
 */
export function tryInlineScalarPredicate(body: PStep[], current: Expression, params: Record<string, any>, vtypeExpr?: Expression): Expression | null {
  let expr = current;
  // The per-row stored type of the CURRENT value, so is(P) compares vtype-aware (a TEXT-stored
  // big long/bigdecimal orders numerically) — matching the generic child path exactly. A
  // transform or constant() changes the value's type, so the stored vtype no longer applies.
  let vtype = vtypeExpr;
  const preds: Expression[] = [];
  const nestedOf = (s: PStep) => s.args.filter(isNested);
  for (const s of body) {
    if (s.name === 'is') {
      // An unresolved traversal operand is outside THIS inliner's vocabulary (resolving one needs
      // the Engine, which a pure inliner has no access to). Decline so the caller falls through,
      // per the contract above — never throw from inside a fast path.
      if (hasUnresolvedOperand(s.args[0])) return null;
      preds.push(predicateSql(expr, s.args[0], vtype ? TYPE_PER_ROW(vtype) : TYPE_UNKNOWN));
      continue;
    }
    if (s.name === 'identity') continue;                 // always productive, no rebind
    if (s.name === 'constant') { expr = value(s.args[0]); vtype = undefined; continue; } // rebind current
    if (s.name === 'and' || s.name === 'or') {
      const arms = nestedOf(s);
      if (!arms.length) return null;
      const sub = arms.map((a: any) => tryInlineScalarPredicate(stepChain(a.nested, params), expr, params, vtype));
      if (sub.some((x) => x === null)) return null;
      preds.push(paren(list(sub.map((x) => paren(x!)), s.name === 'and' ? ' AND ' : ' OR ')));
      continue;
    }
    if (s.name === 'not') {
      const arg = nestedOf(s)[0];
      if (!arg) return null;
      const sub = tryInlineScalarPredicate(stepChain(arg.nested, params), expr, params, vtype);
      if (sub === null) return null;
      preds.push(q`NOT COALESCE((${sub}), 0)`);
      continue;
    }
    if (s.name === 'filter' || s.name === 'where') {
      const arg = nestedOf(s)[0];
      if (!arg) return null;
      const sub = tryInlineScalarPredicate(stepChain(arg.nested, params), expr, params, vtype);
      if (sub === null) return null;
      preds.push(paren(sub));
      continue;
    }
    if (SCALAR_TRANSFORMS.has(s.name)) {
      const tx = scalarTx(s.name, s.args ?? [], expr);
      if (tx === null) return null; // asBool etc — outside the inline transform vocabulary
      expr = tx;
      vtype = undefined; // the value's type has changed; the stored vtype no longer describes it
      continue;
    }
    return null; // movement/property/branch/reducer — no inline scalar form
  }
  return preds.length ? paren(list(preds, ' AND ')) : q`1`;
}

/** Row-preserving WHERE over the scalar value — the shared projection for a filter cond. */
function filterScalarByCond(s: ScalarStream, p: ReturnType<ScalarStream['rel']['as']>, cond: Expression): ScalarStream {
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p} WHERE ${cond}`, cols(s));
  return rebuildScalar(s, rel);
}

/**
 * and/or/not/filter/where over a scalar stream → a WHERE on the value `v` — the INLINE fast
 * path (the scalar twin of the element inline predicate). Returns `null` to decline — when the
 * `scalarPredicateInlining` switch is off, or a traversal arm is outside the inline vocabulary
 * (tryInlineScalarPredicate) — so the caller (SCALAR_TAIL) falls through to the generic
 * child-existence gate. A `where(P)`/`filter(P)` predicate over the value has no child form, so
 * it is always inlined regardless of the switch (`where('a',P)` — an element alias compare —
 * still declines). Row-preserving: only rows drop.
 */
export function lowerScalarFilter(s: ScalarStream, step: PStep): ScalarStream | null {
  const p = s.rel.as('p');
  const cur = p.c.v;
  const vtPerRow = perRowColumnOf(s.type);
  const vt = vtPerRow ? p.c[vtPerRow] : undefined; // per-row stored type → vtype-aware predicates
  const nested = step.args.filter(isNested);
  // where(P)/filter(P): a predicate directly on the value — no traversal child, always inline.
  if ((step.name === 'where' || step.name === 'filter') && !nested.length) {
    const pred = step.args.find((a: any) => a && typeof a === 'object' && 'op' in a);
    if (!pred || step.args.some((a: any) => typeof a === 'string')) return null; // where('a',P) → alias compare, decline
    return filterScalarByCond(s, p, predicateSql(cur, pred, vt ? TYPE_PER_ROW(vt) : TYPE_UNKNOWN));
  }
  // Traversal-child predicate — the scalarPredicateInlining fast path (ScalarPredicateInliningFastPath
  // is its canonical dispatch, in scalar-arm.ts; this leaf reads the same enable flag directly to
  // avoid a scalar ◂ scalar-arm import cycle). Off → decline so the caller falls back to generic.
  if (engineOf(s).fastPaths.scalarPredicateInlining === false) return null;
  let cond: Expression | null;
  if (step.name === 'and' || step.name === 'or') {
    if (!nested.length) return null;
    const sub = nested.map((a: any) => tryInlineScalarPredicate(stepChain(a.nested, s.params), cur, s.params, vt));
    cond = sub.some((x) => x === null) ? null : paren(list(sub.map((x) => paren(x!)), step.name === 'and' ? ' AND ' : ' OR '));
  } else if (step.name === 'not') {
    const arg = nested[0];
    const sub = arg ? tryInlineScalarPredicate(stepChain(arg.nested, s.params), cur, s.params, vt) : null;
    cond = sub === null ? null : q`NOT COALESCE((${sub}), 0)`;
  } else {
    const arg = nested[0];
    cond = arg ? tryInlineScalarPredicate(stepChain(arg.nested, s.params), cur, s.params, vt) : null;
  }
  return cond === null ? null : filterScalarByCond(s, p, cond);
}

/**
 * split(sep) over a SCALAR string → a List of substrings (a scalar→list retype). Three modes:
 * a non-empty separator splits on each occurrence; `""` splits into individual characters;
 * `null` splits on runs of whitespace (empties discarded). A NULL value stays NULL (no list),
 * and a non-string separator raises TinkerPop's "can only take string as argument" error.
 * One multi-row recursive CTE walks every value's string in parallel (keyed by a per-row
 * ROW_NUMBER), collecting parts in order into a JSONB array; a LEFT JOIN restores NULL-value
 * rows as a NULL list. The Scope.local form operates on a list (needs a preceding fold()).
 */
export function lowerScalarSplit(s: ScalarStream, step: PStep): ListStream {
  const args = step.args ?? [];
  if (args.some((a: any) => a && typeof a === 'object' && a.scope === 'local'))
    throw new Error('split(Scope.local) requires a preceding list-producing step (e.g. fold())');
  const sep = args[0];
  if (sep !== null && sep !== undefined && typeof sep !== 'string')
    throw new Error('The split() step can only take string as argument');
  const charMode = sep === '';
  const nullMode = sep === null || sep === undefined;

  const rk = 'rk';
  const cols = carriedCols(s.carried);
  const p0 = s.rel.as('p0');
  const src = s.q.cte(
    q`SELECT ${p0.c.v} AS v${carryFrag(s.carried, p0)}, ROW_NUMBER() OVER () AS ${rk} FROM ${p0}`,
    ['v', ...cols, rk],
  );
  const sa = src.as('s');
  // Java whitespace → a single space, so split(null) is a space-split with empties dropped.
  const wsNorm = (e: Expression) => q`replace(replace(replace(replace(replace(${e}, char(9), ' '), char(10), ' '), char(11), ' '), char(12), ' '), char(13), ' ')`;
  const initRest = nullMode ? wsNorm(sa.c.v) : sa.c.v;

  const parts = s.q.recursiveCte([rk, 'ord', 'part', 'rest'], (self: Relation) => {
    const seed = q`SELECT ${sa.c[rk]} AS ${rk}, 0 AS ord, NULL AS part, ${initRest} AS rest FROM ${sa} WHERE ${sa.c.v} IS NOT NULL`;
    let rec: Expression;
    if (charMode) {
      rec = q`SELECT ${self.c[rk]} AS ${rk}, ${self.c.ord}+1 AS ord, substr(${self.c.rest},1,1) AS part, substr(${self.c.rest},2) AS rest FROM ${self} WHERE ${self.c.rest} <> ''`;
    } else {
      const sepv = nullMode ? q`' '` : value(sep as string);
      const pos = q`instr(${self.c.rest}, ${sepv})`;
      const part = q`CASE WHEN ${pos}>0 THEN substr(${self.c.rest},1,${pos}-1) ELSE ${self.c.rest} END`;
      const next = q`CASE WHEN ${pos}>0 THEN substr(${self.c.rest},${pos}+length(${sepv})) ELSE NULL END`;
      rec = q`SELECT ${self.c[rk]} AS ${rk}, ${self.c.ord}+1 AS ord, ${part} AS part, ${next} AS rest FROM ${self} WHERE ${self.c.rest} IS NOT NULL`;
    }
    return q`${seed} UNION ALL ${rec}`;
  });

  const pa = parts.as('pa');
  const keep = nullMode ? q` FILTER (WHERE ${pa.c.part} <> '')` : empty;
  const grouped = s.q.cte(
    q`SELECT ${pa.c[rk]} AS ${rk}, jsonb(json_group_array(${pa.c.part} ORDER BY ${pa.c.ord})${keep}) AS list FROM ${pa} WHERE ${pa.c.ord}>0 GROUP BY ${pa.c[rk]}`,
    [rk, 'list'],
  );
  const g = grouped.as('g');
  const rel = s.q.cte(
    q`SELECT ${g.c.list} AS list${carryFrag(s.carried, sa)} FROM ${sa} LEFT JOIN ${g} ON ${g.c[rk]}=${sa.c[rk]}`,
    ['list', ...cols],
  );
  return toListStream(carryOf(s), rel, { kind: 'scalar', as: 'string' });
}

// ---------- scalar-parent branch primitives (gate + union) ----------
//
// The scalar analogue of branch.ts's element-parent choose/coalesce/union: over a scalar
// current object every arm is a cardinality-preserving value sub-traversal, so the branch
// consumers (child.ts tryScalar*Child) gate the value rows by a boolean over `v` and
// UNION ALL the arm outputs — the SAME lowerSteps engine lowers each arm (no inline CASE,
// no child-scope machinery). `buildCond` receives the value expression so a caller can
// gate by a P (predicateSql) or by a nested scalar predicate (tryInlineScalarPredicate).

/** Gate a scalar stream by a boolean over its value `v`, preserving the scalar shape/tag/
 *  encounter/carried schema (only rows are dropped). `buildCond` receives the value expression
 *  and its per-row stored-type column (if any) so the gate can be vtype-aware; the caller bakes
 *  in any negation (e.g. `NOT COALESCE((cond), 0)` for a choose else side). */
export function gateScalar(s: ScalarStream, buildCond: (v: Expression, vt: Expression | undefined) => Expression): ScalarStream {
  const p = s.rel.as('p');
  const isPerRow = perRowColumnOf(s.type);
  const vt = isPerRow ? p.c[isPerRow] : undefined;
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p} WHERE ${buildCond(p.c.v, vt)}`, cols(s));
  return rebuildScalar(s, rel);
}

/** UNION ALL a set of scalar arm streams that all descend from `base`'s carried schema
 *  (choose/coalesce/union merge point). Numeric arms keep the `vt` storage-class column;
 *  the framing tag survives only when every arm agrees. The merge SYNTHESIZES the canonical
 *  emission order: arm k is tagged `arm_idx=k` and keeps its own encounter (`arm_encounter`,
 *  or 1 if the arm has none), then a fresh `encounter = ROW_NUMBER() OVER (… ORDER BY
 *  arm_idx, arm_encounter)` is minted into the carried slot (per-origin inside a child scope).
 *  This matches TinkerPop's union order (arm a before arm b) and unblocks take-first after a
 *  branch (map/path() fan-out arm). */
export function unionScalarStreams(base: Carry, arms: readonly ScalarStream[], gateFor?: (a: Relation, k: number) => Expression | undefined): ScalarStream {
  const numeric = arms.every((a) => a.result === 'number');
  // Merge the arms' LABEL SETS onto the base (an arm may bind a NEW as() label), exactly as the
  // element-parent merge does. Without this an arm-grown alias column is absent from the merged
  // relation's declared schema and a later select() reads nothing — a silent empty result. Each
  // arm then projects the CANONICAL alias columns (its own physical column remapped, NULL where it
  // never bound the label) instead of a flat carryFrag of the base's.
  const mergedAliases = mergeAliasMaps(base.carried.aliases, arms.map((a) => a.carried));
  const armsGrewAlias = mergedAliases.size !== base.carried.aliases.size;
  // Forward the base carried EXCEPT any prior encounter — the merge supersedes it.
  const baseNoEnc = carriedWith(base.carried, { encounter: null, aliases: mergedAliases });
  const nonAlias = carriedCols({ ...baseNoEnc, aliases: new Map() });
  const inner = base.q.cte(
    list(arms.map((a, k) => {
      const r = a.rel.as('a');
      const armEnc = a.carried.encounter ? r.c[a.carried.encounter] : q`1`;
      const gate = gateFor?.(r, k);
      // The alias columns come from the ARM (remapped/padded); every other carried column is
      // per-traverser state the arms share with the base, so it rides straight through.
      const aliasFrag = armsGrewAlias
        ? list(aliasArmProjection(a.carried.aliases, mergedAliases, r).map((e: Expression) => q`, ${e}`), '')
        : empty;
      const restFrag = armsGrewAlias
        ? (nonAlias.length ? list(nonAlias.map((c) => q`, ${r.c[c]}`), '') : empty)
        : carryFrag(baseNoEnc, r);
      return q`SELECT ${r.c.v} AS v${numeric ? q`, ${r.c.vt} AS vt` : empty}, ${value(k)} AS arm_idx, ${armEnc} AS arm_encounter${aliasFrag}${restFrag} FROM ${r}${gate ? q` WHERE ${gate}` : empty}`;
    }), ' UNION ALL '),
    ['v', ...(numeric ? ['vt'] : []), 'arm_idx', 'arm_encounter', ...carriedCols(baseNoEnc)],
  );
  const m = inner.as('m');
  const outCarried = carriedWith(baseNoEnc, { encounter: 'encounter' });
  const over = partitionOver(outCarried, m, q`${m.c.arm_idx}, ${m.c.arm_encounter}`);
  const rel = base.q.cte(
    q`SELECT ${m.c.v} AS v${numeric ? q`, ${m.c.vt} AS vt` : empty}${carryFragMint(outCarried, m, 'encounter', q`ROW_NUMBER() OVER (${over})`)} FROM ${m}`,
    ['v', ...(numeric ? ['vt'] : []), ...carriedCols(outCarried)],
  );
  // The merged relation projects only `v` (+ `vt`), so a per-row type column cannot cross
  // the union — an arm carrying one degrades to `unknown` (inferred at the wire) rather than
  // claiming a column that isn't there. A STATIC type survives only if every arm agrees.
  const first = arms[0].type;
  const merged: ScalarType = first.kind === 'static' && arms.every((a) => a.type.kind === 'static' && a.type.type === first.type)
    ? first : UNKNOWN;
  return toScalarStream({ q: base.q, params: base.params, sideEffects: base.sideEffects, carried: outCarried }, rel, undefined, { type: merged, result: numeric ? 'number' : 'value' });
}

/** sack over a scalar stream. The mutate form sack(Operator.x) folds the CURRENT VALUE
 *  (`v`) into the carried sack — a scalar has no properties, so the value itself is the
 *  merge value (no by() modulator). The read form (bare sack()) rebinds the current
 *  object to the sack value. Reuses combineSack (the element sack's operator logic). */
export function lowerScalarSack(s: ScalarStream, step: PStep): ScalarStream {
  if (!s.carried.sack) throw new Error('sack() over a scalar stream requires withSack() or a preceding sack step');
  const sk = s.carried.sack;
  const p = s.rel.as('p');
  const op = (step.args ?? []).find((a: any) => a && typeof a === 'object' && 'operator' in a)?.operator;
  if (!op) {
    // bare sack() read: the sack value becomes the current object.
    if ((step.args ?? []).length) throw new Error('sack(argument) read form not supported (bare sack() only)');
    const rel = s.q.cte(q`SELECT ${p.c[sk]} AS v${carryFrag(s.carried, p)} FROM ${p}`, ['v', ...carriedCols(s.carried)]);
    return toScalarStream(carryOf(s), rel);
  }
  if (!SACK_OPS.has(op)) throw new Error(`sack(Operator.${op}) not yet supported`);
  if (((step as any).bys ?? []).length)
    throw new Error('sack(Operator.x).by() over a scalar stream not yet supported (the scalar value is the merge value)');
  const newSack = combineSack(op, p.c.v, p.c[sk]);
  const carriedProj = carriedCols(s.carried).map((c) => c === sk ? q`${newSack} AS ${sk}` : p.c[c]);
  const rel = s.q.cte(
    q`SELECT ${payload(s, p)}${carriedProj.length ? q`, ${list(carriedProj, ', ')}` : empty} FROM ${p}`,
    cols(s),
  );
  return rebuildScalar(s, rel);
}

/** constant(x) over a SCALAR stream: rebind the value to the literal x while PRESERVING the
 *  carried schema (incl. child-scope origins and the carried encounter). Unlike the
 *  shape-agnostic lowerConstant, this composes inside a child scope — the scalar seed carries
 *  a minted encounter (in carried), so a following partitioned reducer/cardinality policy still
 *  has its order marker. This is what lets `choose(fn).option(k, __.constant(x))` / project
 *  fields / modulation option bodies use constant per origin. */
export function lowerScalarConstant(s: ScalarStream, args: any[]): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT ${value(args[0])} AS v${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, undefined, { result: 'value' });
}

/** constant(x): replace the current object with the literal x, one per input row. Shape-
 *  agnostic — the source relation may be an element or a scalar; only row identity and
 *  the carried schema matter. A child scope (origins live) defers: constant loses the
 *  encounter order downstream partitioned operators require. */
export function lowerConstant(carry: Carry, rel: Relation, args: any[]): ScalarStream {
  if (carry.carried.origins.length)
    throw new Error('constant() inside a child scope not yet supported');
  const p = rel.as('p');
  const out = carry.q.cte(
    q`SELECT ${value(args[0])} AS v${carryFrag(carry.carried, p)} FROM ${p}`,
    ['v', ...carriedCols(carry.carried)],
  );
  return toScalarStream(carry, out, undefined, { result: 'value' });
}

/** Lower the row operators common to every scalar payload. Consecutive transforms and
 * predicates share one relational node; cardinality/order boundaries remain explicit. */
export function lowerScalarRows(
  input: ScalarStream,
  steps: readonly PStep[],
  from: number,
): { stream: ScalarStream; stop: number } {
  let stream = input;
  let i = from;
  for (; i < steps.length; i++) {
    const step = steps[i];
    // Scope.local means "per-element WITHIN a list". Reached on a SCALAR stream, each
    // traverser is a degenerate one-element list, so the local op acts on that single
    // value: sum/min/max/order/dedup are identity, mean coerces to Double (always Double,
    // even of one value), transforms ignore scope (fall through to the fuse branch).
    // count/limit/range/tail/skip(local) have no worked-out scalar-local form → break and
    // fail closed downstream. This is the scalar-pipeline home of the old renderProjection
    // localMean/scalar-local-identity handling.
    if (isLocal(step)) {
      if (step.name === 'sum' || step.name === 'min' || step.name === 'max' || step.name === 'order' || step.name === 'dedup') continue;
      if (step.name === 'mean') { stream = localMeanScalar(stream); continue; }
      if (!SCALAR_TRANSFORMS.has(step.name)) break;
    }
    if (step.name === 'inject') {
      stream = appendScalar(stream, step);
      continue;
    }
    // is(typeOf(LIST)) over a stored-typed stream is a RETYPE (scalar→list), not a value
    // filter — stop so compileFromScalar builds the ListStream. Without a per-row stored
    // vtype (a computed scalar) it stays a fused is() that static-folds to empty.
    if (step.name === 'is' && perRowColumnOf(stream.type) && collectionTypeOf(step) !== null) break;
    if (SCALAR_TRANSFORMS.has(step.name) || step.name === 'is') {
      const fused = fuseScalarSegment(stream, steps, i);
      stream = fused.stream;
      i = fused.stop - 1;
      continue;
    }
    if (step.name === 'limit' || step.name === 'skip' || step.name === 'range') {
      const { offset, limit } = step.name === 'limit'
        ? { offset: 0, limit: Number(step.args[0]) }
        : step.name === 'skip'
          ? { offset: Number(step.args[0]), limit: null }
          : rangeToOffsetLimit(step.args);
      stream = stream.carried.origins.length
        ? partitionedSlice(stream, offset, limit)
        : rowPreserving(stream, q` LIMIT ${limit ?? -1} OFFSET ${offset}`, true);
      continue;
    }
    if (step.name === 'tail') {
      const n = Number(step.args.find((a: any) => typeof a === 'number') ?? 1);
      stream = stream.carried.origins.length ? partitionedTail(stream, n) : rootTail(stream, n);
      continue;
    }
    if (step.name === 'order') {
      // Sort by the vtype-aware compare key when the stream carries a per-row vtype, so a
      // TEXT-stored big long / bigdecimal / duration value sorts NUMERICALLY not lexically
      // (values() of a typed prop). No vtype column → the value is already a native scalar.
      const streamPerRow = perRowColumnOf(stream.type);
      const sortVal: Expression = streamPerRow ? compareKey(q`p.v`, raw(`p.${streamPerRow}`)) : q`p.v`;
      let order: Expression = q`${sortVal} ASC`;
      const bys = step.bys ?? [];
      if (bys.length > 1) throw new Error('multiple order().by() modulators on a scalar stream not yet supported');
      if (bys.length === 1) {
        const by = bys[0];
        if (by.some((a: any) => typeof a === 'string' || (a && typeof a === 'object' && ('nested' in a || 'token' in a))))
          throw new Error('order().by(key/traversal) on a scalar stream not supported (no properties)');
        const dir = by.find((a: any) => a && typeof a === 'object' && 'order' in a)?.order;
        order = dir === 'shuffle' ? q`RANDOM()` : dir === 'desc' ? q`${sortVal} DESC` : q`${sortVal} ASC`;
      }
      // A child scope OR a demanded root chain (carried.encounter live) mints a fresh encounter
      // via partitionedOrder (empty partition at root), so a following fold/limit/tail/materialize
      // orders by THIS sort rather than the stale seed. Each positional consumer then reads
      // carried.encounter on its own iteration.
      if (stream.carried.origins.length || stream.carried.encounter) {
        stream = partitionedOrder(stream, order);
        continue;
      }
      const next = steps[i + 1];
      if (next && !isLocal(next) && (next.name === 'limit' || next.name === 'skip' || next.name === 'range')) {
        const { offset, limit } = next.name === 'limit'
          ? { offset: 0, limit: Number(next.args[0]) }
          : next.name === 'skip'
            ? { offset: Number(next.args[0]), limit: null }
            : rangeToOffsetLimit(next.args);
        stream = rowPreserving(stream, q` ORDER BY ${order} LIMIT ${limit ?? -1} OFFSET ${offset}`);
        i++;
      } else stream = rowPreserving(stream, q` ORDER BY ${order}`);
      continue;
    }
    if (step.name === 'dedup') {
      if (stream.carried.origins.length) {
        stream = partitionedDedup(stream);
        continue;
      }
      const clean = withoutCarried(carryOf(stream));
      const p = stream.rel.as('p');
      // payload/cols (not a hand-rolled projection) so the per-row stored vtype survives the
      // dedup like it does every other row-preserving op. DISTINCT over (v, vtype) is also the
      // correct multiset semantics: equal values of DIFFERENT stored types are distinct
      // Gremlin values and must not collapse into one traverser.
      const rel = stream.q.cte(q`SELECT DISTINCT ${payload(stream, p)} FROM ${p}`, cols({ ...stream, carried: clean.carried }));
      stream = toScalarStream(clean, rel, undefined, { type: stream.type, result: stream.result });
      continue;
    }
    break;
  }
  return { stream, stop: i };
}
