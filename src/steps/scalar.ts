import { empty, list, q, value, type Expression } from '../q.ts';
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
  ...SCALAR_TRANSFORMS, 'is', 'limit', 'skip', 'range', 'order', 'dedup',
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

function transformScalar(s: ScalarStream, step: PStep, next?: PStep): ScalarStream {
  const p = s.rel.as('p');
  let expr: Expression = p.c.v;
  let as: ValueType | undefined;
  if (step.name === 'asNumber') {
    const spec = numericSpec(step.args[0]);
    if (spec) { expr = asNumberSql(spec, expr); as = spec.as; }
    else if (s.as === 'date') as = 'long';
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
  const rel = s.q.cte(
    q`SELECT ${expr} AS v${s.encounter ? q`, ${p.c[s.encounter]}` : empty}${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...(s.encounter ? [s.encounter] : []), ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, as, 'value', s.encounter);
}

function partitionedSlice(s: ScalarStream, offset: number, limit: number | null): ScalarStream {
  if (!s.encounter) throw new Error('correlated scalar slice requires explicit encounter order');
  const p = s.rel.as('p');
  const partitions = s.carried.origins.map((name) => p.c[name]);
  const over = partitions.length ? q`PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[s.encounter]}` : q`ORDER BY ${p.c[s.encounter]}`;
  const rankedCols = [...cols(s), 'rn'];
  const ranked = s.q.cte(q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (${over}) AS rn FROM ${p}`, rankedCols);
  const r = ranked.as('r');
  const hi = limit == null ? empty : q` AND ${r.c.rn}<=${offset + limit}`;
  const rel = s.q.cte(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}>${offset}${hi}`, cols(s));
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
  const ranked = s.q.cte(
    q`SELECT ${payload(s, p)}${carryFrag(s.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${list(partitions, ', ')} ORDER BY ${p.c[s.encounter]}) AS rn FROM ${p}`,
    [...cols(s), 'rn'],
  );
  const r = ranked.as('r');
  const rel = s.q.cte(q`SELECT ${payload(s, r)}${carryFrag(s.carried, r)} FROM ${r} WHERE ${r.c.rn}=1`, cols(s));
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

/** Lower the row operators common to every scalar payload one step at a time.
 * Sequential CTEs make order significant (limit().is() is not commuted), while
 * reducer result/type metadata and physically carried columns remain explicit. */
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
    if (SCALAR_TRANSFORMS.has(step.name)) {
      stream = transformScalar(stream, step, steps[i + 1]);
      continue;
    }
    if (step.name === 'is') {
      const p = stream.rel.as('p');
      stream = rowPreserving(stream, q` WHERE ${predicateSql(p.c.v, step.args[0])}`);
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
      stream = stream.carried.origins.length
        ? partitionedOrder(stream, order)
        : rowPreserving(stream, q` ORDER BY ${order}`);
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
