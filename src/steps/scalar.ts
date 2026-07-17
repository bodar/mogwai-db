import { derived, empty, list, paren, q, raw, value, type Expression, type Relation } from '../q.ts';
import { compareKey, predicateSql, rangeToOffsetLimit, scalarTx } from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, withoutCarried, type Carry } from './context.ts';
import { carryOf, toListStream, toScalarStream, type ListStream, type ScalarStream } from './stream.ts';
import { asDateSql, asNumberSql, dateDiffOtherMs, dtFactor, numericSpec } from './coerce.ts';
import { normalizeTypeName } from '../gremlin-types.ts';
import { type ValueType } from '../render.ts';

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
  if (!s.vtype) return null;
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT json(${p.c.v}) AS list${carryFrag(s.carried, p)} FROM ${p} WHERE ${p.c[s.vtype]} = ${value(kind)}`,
    ['list', ...carriedCols(s.carried)],
  );
  return toListStream(carryOf(s), rel, { kind: 'scalar', typed: true }, kind === 'set');
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

const payload = (s: ScalarStream, p: ReturnType<ScalarStream['rel']['as']>): Expression =>
  q`${s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`}${s.encounter ? q`, ${p.c[s.encounter]} AS ${s.encounter}` : empty}${s.vtype ? q`, ${p.c[s.vtype]} AS ${s.vtype}` : empty}`;

const cols = (s: ScalarStream): string[] =>
  [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...(s.encounter ? [s.encounter] : []), ...(s.vtype ? [s.vtype] : []), ...carriedCols(s.carried)];

function rowPreserving(s: ScalarStream, suffix: Expression): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p}${suffix}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
}

function scalarTransform(step: PStep, currentAs: ValueType | undefined, expr: Expression, next?: PStep): { expr: Expression; as?: ValueType } {
  let as: ValueType | undefined;
  if (step.name === 'asNumber') {
    const spec = numericSpec(step.args[0]);
    if (spec) { expr = asNumberSql(spec, expr); as = spec.as; }
    else if (currentAs === 'date') as = 'long';
    else if (next?.name === 'asDate') { expr = q`CAST(${expr} AS INTEGER)`; as = 'long'; }
    else throw new Error('bare asNumber() over a non-date runtime value not yet supported');
  } else if (step.name === 'asDate') {
    expr = asDateSql(expr); as = 'date';
  } else if (step.name === 'dateAdd') {
    expr = q`(${expr} + ${value(Number(step.args[1]) * dtFactor(step.args[0]))})`; as = 'date';
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
  let as = s.as;
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
      const typeCtx = { staticAs: as, vtypeExpr: (!transformed && s.vtype) ? p.c[s.vtype] : undefined };
      predicates.push(predicateSql(expr, step.args[0], typeCtx));
      continue;
    }
    break;
  }
  // A transform changes the value's type → the per-row vtype no longer describes it
  // (framing follows the new `as`); a pure is()-only segment preserves it.
  const keepVtype = !transformed && s.vtype;
  const valueCols = transformed
    ? q`${expr} AS v`
    : q`${p.c.v} AS v${s.result === 'number' ? q`, ${p.c.vt} AS vt` : empty}`;
  const where = predicates.length ? q` WHERE ${list(predicates, ' AND ')}` : empty;
  const rel = s.q.cte(
    q`SELECT ${valueCols}${s.encounter ? q`, ${p.c[s.encounter]}` : empty}${keepVtype ? q`, ${p.c[s.vtype!]} AS ${s.vtype}` : empty}${carryFrag(s.carried, p)} FROM ${p}${where}`,
    ['v', ...(!transformed && s.result === 'number' ? ['vt'] : []), ...(s.encounter ? [s.encounter] : []), ...(keepVtype ? [s.vtype!] : []), ...carriedCols(s.carried)],
  );
  return {
    stream: toScalarStream(carryOf(s), rel, as, transformed ? 'value' : s.result, s.encounter, transformed ? undefined : s.productiveNull, keepVtype ? s.vtype : undefined),
    stop: i,
  };
}

function partitionedSlice(s: ScalarStream, offset: number, limit: number | null): ScalarStream {
  if (!s.encounter) throw new Error('correlated scalar slice requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[s.encounter]}` : q`ORDER BY ${p.c[s.encounter]}`;
  const rankedCols = [...cols(s), 'rn'];
  const r = derived(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (${over}) AS rn FROM ${p}`, rankedCols, 'r');
  const hi = limit == null ? empty : q` AND ${r.c.rn}<=${offset + limit}`;
  const rel = derived(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}>${offset}${hi}`, cols(s), 'slice');
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
}

function partitionedTail(s: ScalarStream, limit: number): ScalarStream {
  if (!s.encounter) throw new Error('scalar tail requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length
    ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[s.encounter]} DESC`
    : q`ORDER BY ${p.c[s.encounter]} DESC`;
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
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
}

function partitionedOrder(s: ScalarStream, order: Expression): ScalarStream {
  if (!s.encounter) throw new Error('correlated scalar order requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${order}, ${p.c[s.encounter]}` : q`ORDER BY ${order}, ${p.c[s.encounter]}`;
  // order re-projects the encounter column (ROW_NUMBER) but preserves each row's value +
  // stored type. Column order must match cols(s) = [v,(vt),encounter,(vtype),carried].
  const valuePayload = s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`;
  const vtypeCol = s.vtype ? q`, ${p.c[s.vtype]} AS ${s.vtype}` : empty;
  const rel = s.q.cte(q`SELECT ${valuePayload}, ROW_NUMBER() OVER (${over}) AS ${s.encounter}${vtypeCol}${carryFrag(s.carried, p)} FROM ${p}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
}

function partitionedDedup(s: ScalarStream): ScalarStream {
  if (!s.encounter) throw new Error('correlated scalar dedup requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = [...s.carried.origins.map((name) => p.c[name]), p.c.v, ...(s.result === 'number' ? [p.c.vt] : [])];
  const r = derived(
    q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[s.encounter]}) AS rn FROM ${p}`,
    [...cols(s), 'rn'],
    'r',
  );
  const rel = derived(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}=1`, cols(s), 'dedup_rows');
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
}

/** mean(Scope.local) on a scalar stream: each value is a one-element list whose mean is
 *  the value AS A DOUBLE (mean is always Double, even of one element — d[29.0].d). Drops
 *  the stored vtype (the result is a fresh Double, not the original type). */
function localMeanScalar(s: ScalarStream): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT CAST(${p.c.v} AS REAL) AS v${s.encounter ? q`, ${p.c[s.encounter]}` : empty}${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...(s.encounter ? [s.encounter] : []), ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, 'double', 'value', s.encounter);
}

function appendScalar(s: ScalarStream, step: PStep): ScalarStream {
  if (step.args.length === 0) return s;
  if (step.args.some(Array.isArray))
    throw new Error('inject(list) into a scalar stream needs a mixed-shape row discriminant');
  if (s.result !== 'value' || s.as || carriedCols(s.carried).length)
    throw new Error('inject() after typed/reduced/carried scalar state not yet supported');
  const p = s.rel.as('p');
  const appended = step.args.map((v) => q`SELECT ${value(v)} AS v`);
  const rel = s.q.cte(
    q`SELECT ${p.c.v} AS v FROM ${p} UNION ALL ${list(appended, ' UNION ALL ')}`,
    ['v'],
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

/** Does a child sub-traversal produce a result, evaluated against the current scalar
 *  `current`? A boolean SQL expression. is(P) filters; transforms rewrite the current
 *  value; constant(x) rebinds it (and is always productive); and/or/not/filter/where
 *  compose recursively. Every `is` along a linear body ANDs; a bare/constant body is
 *  always productive (`1`). Movement/property bodies throw (defer). */
function scalarChildProduces(body: PStep[], current: Expression, params: Record<string, any>): Expression {
  let expr = current;
  const preds: Expression[] = [];
  const nestedOf = (s: PStep) => s.args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  for (const s of body) {
    if (s.name === 'is') { preds.push(predicateSql(expr, s.args[0])); continue; }
    if (s.name === 'identity') continue;                 // always productive, no rebind
    if (s.name === 'constant') { expr = value(s.args[0]); continue; } // rebind current
    if (s.name === 'and' || s.name === 'or') {
      const arms = nestedOf(s);
      if (!arms.length) throw new Error(`${s.name}() needs a traversal branch`);
      preds.push(paren(list(arms.map((a: any) => paren(scalarChildProduces(stepChain(a.nested, params), expr, params))), s.name === 'and' ? ' AND ' : ' OR ')));
      continue;
    }
    if (s.name === 'not') {
      const arg = nestedOf(s)[0];
      if (!arg) throw new Error('not() requires a traversal');
      preds.push(q`NOT COALESCE((${scalarChildProduces(stepChain(arg.nested, params), expr, params)}), 0)`);
      continue;
    }
    if (s.name === 'filter' || s.name === 'where') {
      const arg = nestedOf(s)[0];
      if (!arg) throw new Error(`${s.name}(predicate) inside a scalar filter not yet supported (traversal only)`);
      preds.push(paren(scalarChildProduces(stepChain(arg.nested, params), expr, params)));
      continue;
    }
    if (SCALAR_TRANSFORMS.has(s.name)) {
      expr = scalarTx(s.name, s.args ?? [], expr)
        ?? (() => { throw new Error(`scalar filter transform ${s.name}() not supported`); })();
      continue;
    }
    throw new Error(`${s.name}() in a scalar filter body not yet supported (a scalar has no properties or neighbours)`);
  }
  return preds.length ? paren(list(preds, ' AND ')) : q`1`;
}

/** and/or/not/filter/where over a scalar stream → a WHERE on the value `v`. The arms are
 *  child predicates against the current scalar (scalarChildProduces). Row-preserving:
 *  the scalar shape/tag/encounter are unchanged, only rows are dropped. */
export function lowerScalarFilter(s: ScalarStream, step: PStep): ScalarStream {
  const p = s.rel.as('p');
  const cur = p.c.v;
  const nested = step.args.filter((a: any) => a && typeof a === 'object' && 'nested' in a);
  let cond: Expression;
  if (step.name === 'and' || step.name === 'or') {
    if (!nested.length) throw new Error(`${step.name}() needs at least one traversal branch`);
    cond = paren(list(nested.map((a: any) => paren(scalarChildProduces(stepChain(a.nested, s.params), cur, s.params))), step.name === 'and' ? ' AND ' : ' OR '));
  } else if (step.name === 'not') {
    const arg = nested[0];
    if (!arg) throw new Error('not() requires a traversal');
    cond = q`NOT COALESCE((${scalarChildProduces(stepChain(arg.nested, s.params), cur, s.params)}), 0)`;
  } else {
    const arg = nested[0];
    if (!arg) throw new Error(`${step.name}(predicate) on a scalar stream not yet supported (traversal only)`);
    cond = scalarChildProduces(stepChain(arg.nested, s.params), cur, s.params);
  }
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p} WHERE ${cond}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
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
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter, s.productiveNull, s.vtype);
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
  return toScalarStream(carry, out, undefined, 'value');
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
    if (step.name === 'is' && stream.vtype && (collectionTypeOf(step) === 'list' || collectionTypeOf(step) === 'set')) break;
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
        : rowPreserving(stream, q` LIMIT ${limit ?? -1} OFFSET ${offset}`);
      continue;
    }
    if (step.name === 'tail') {
      stream = partitionedTail(stream, Number(step.args.find((a: any) => typeof a === 'number') ?? 1));
      continue;
    }
    if (step.name === 'order') {
      // Sort by the vtype-aware compare key when the stream carries a per-row vtype, so a
      // TEXT-stored big long / bigdecimal / duration value sorts NUMERICALLY not lexically
      // (values() of a typed prop). No vtype column → the value is already a native scalar.
      const sortVal: Expression = stream.vtype ? compareKey(q`p.v`, raw(`p.${stream.vtype}`)) : q`p.v`;
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
      if (stream.carried.origins.length) {
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
      const typeCol = stream.result === 'number' ? q`, ${p.c.vt} AS vt` : empty;
      const rel = stream.q.cte(q`SELECT DISTINCT ${p.c.v} AS v${typeCol} FROM ${p}`,
        stream.result === 'number' ? ['v', 'vt'] : ['v']);
      stream = toScalarStream(clean, rel, stream.as, stream.result);
      continue;
    }
    break;
  }
  return { stream, stop: i };
}
