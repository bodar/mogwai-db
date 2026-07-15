import { derived, empty, list, q, value, type Expression } from '../q.ts';
import { predicateSql, rangeToOffsetLimit, scalarTx } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, withoutCarried } from './context.ts';
import { carryOf, toScalarStream, type ScalarStream } from './stream.ts';
import { asDateSql, asNumberSql, dateDiffOtherMs, dtFactor, numericSpec } from './coerce.ts';
import { type ValueType } from '../render.ts';

export const SCALAR_TRANSFORMS = new Set([
  'concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace',
  'trim', 'lTrim', 'rTrim', 'reverse', 'asBool', 'asNumber', 'asDate', 'dateAdd', 'dateDiff',
]);

export const SCALAR_ROW_STEPS = new Set([
  ...SCALAR_TRANSFORMS, 'is', 'limit', 'skip', 'range', 'tail', 'order', 'dedup',
  'count', 'sum', 'min', 'max', 'mean', 'fold', 'unfold', 'inject',
]);

const isLocal = (step: PStep): boolean =>
  (step.args ?? []).some((a: any) => a && typeof a === 'object' && a.scope === 'local');

const payload = (s: ScalarStream, p: ReturnType<ScalarStream['rel']['as']>): Expression =>
  q`${s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`}${s.encounter ? q`, ${p.c[s.encounter]} AS ${s.encounter}` : empty}`;

const cols = (s: ScalarStream): string[] =>
  [...(s.result === 'number' ? ['v', 'vt'] : ['v']), ...(s.encounter ? [s.encounter] : []), ...carriedCols(s.carried)];

function rowPreserving(s: ScalarStream, suffix: Expression): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)} FROM ${p}${suffix}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter);
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
    if (isLocal(step)) break;
    if (SCALAR_TRANSFORMS.has(step.name)) {
      const out = scalarTransform(step, as, expr, steps[i + 1]);
      expr = out.expr;
      as = out.as;
      transformed = true;
      continue;
    }
    if (step.name === 'is') {
      predicates.push(predicateSql(expr, step.args[0]));
      continue;
    }
    break;
  }
  const valueCols = transformed
    ? q`${expr} AS v`
    : q`${p.c.v} AS v${s.result === 'number' ? q`, ${p.c.vt} AS vt` : empty}`;
  const where = predicates.length ? q` WHERE ${list(predicates, ' AND ')}` : empty;
  const rel = s.q.cte(
    q`SELECT ${valueCols}${s.encounter ? q`, ${p.c[s.encounter]}` : empty}${carryFrag(s.carried, p)} FROM ${p}${where}`,
    ['v', ...(!transformed && s.result === 'number' ? ['vt'] : []), ...(s.encounter ? [s.encounter] : []), ...carriedCols(s.carried)],
  );
  return {
    stream: toScalarStream(carryOf(s), rel, as, transformed ? 'value' : s.result, s.encounter, transformed ? undefined : s.productiveNull),
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
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter);
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
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter);
}

function partitionedOrder(s: ScalarStream, order: Expression): ScalarStream {
  if (!s.encounter) throw new Error('correlated scalar order requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${order}, ${p.c[s.encounter]}` : q`ORDER BY ${order}, ${p.c[s.encounter]}`;
  const valuePayload = s.result === 'number' ? q`${p.c.v} AS v, ${p.c.vt} AS vt` : q`${p.c.v} AS v`;
  const rel = s.q.cte(q`SELECT ${valuePayload}, ROW_NUMBER() OVER (${over}) AS ${s.encounter}${carryFrag(s.carried, p)} FROM ${p}`, cols(s));
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter);
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
  return toScalarStream(carryOf(s), rel, s.as, s.result, s.encounter);
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
    if (isLocal(step)) break;
    if (step.name === 'inject') {
      stream = appendScalar(stream, step);
      continue;
    }
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
      let order: Expression = q`p.v ASC`;
      const bys = step.bys ?? [];
      if (bys.length > 1) throw new Error('multiple order().by() modulators on a scalar stream not yet supported');
      if (bys.length === 1) {
        const by = bys[0];
        if (by.some((a: any) => typeof a === 'string' || (a && typeof a === 'object' && ('nested' in a || 'token' in a))))
          throw new Error('order().by(key/traversal) on a scalar stream not supported (no properties)');
        const dir = by.find((a: any) => a && typeof a === 'object' && 'order' in a)?.order;
        order = dir === 'shuffle' ? q`RANDOM()` : dir === 'desc' ? q`p.v DESC` : q`p.v ASC`;
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
