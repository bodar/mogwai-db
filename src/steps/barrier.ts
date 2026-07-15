import { q, type Expression, type Relation } from '../q.ts';
import { carryOf, toListStream, toScalarStream, type ListStream, type Stream, type ScalarStream } from './stream.ts';
import { carriedCols, carryFrag, withoutCarried } from './context.ts';

/** Global count is a relational barrier: it consumes any shaped row stream and
 * returns exactly one Long scalar traverser. Row-associated state cannot cross it. */
export function lowerGlobalCount(input: Stream): ScalarStream {
  const rel = input.q.cte(q`SELECT COUNT(*) AS v FROM ${input.rel}`, ['v']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, 'long', 'count');
}

/** Global fold is a genuine shape transition: all scalar traversers become one
 * JSONB list traverser. The uniform compile-time item tag survives on ListOf so a
 * terminal list and a later unfold both retain GraphBinary scalar typing. */
export function lowerGlobalFold(input: ScalarStream): ListStream {
  const src = input.rel.as('s');
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${src.c.v}), json('[]'))) AS list FROM ${src}`,
    ['list'],
  );
  return toListStream(withoutCarried(carryOf(input)), rel, { kind: 'scalar', as: input.as });
}

/** Child-scoped fold produces exactly one list traverser per parent origin. The
 * domain keeps empty children alive as `[]`; FILTER keys productivity on encounter
 * rather than value so a productive SQL NULL is retained as a list member. */
export function lowerScopedScalarFold(
  input: ScalarStream,
  domain: Relation,
  ordinal: string,
): ListStream {
  if (!input.encounter) throw new Error('scoped scalar fold requires explicit encounter order');
  const d = domain.as('d');
  const s = input.rel.as('s');
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${s.c.v} ORDER BY ${s.c[input.encounter]}) FILTER (WHERE ${s.c[input.encounter]} IS NOT NULL), json('[]'))) AS list${carryFrag(input.carried, d)} FROM ${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]} GROUP BY ${d.c[ordinal]}`,
    ['list', ...carriedCols(input.carried)],
  );
  return toListStream(carryOf(input), rel, { kind: 'scalar', as: input.as });
}

export type NumericReducer = 'sum' | 'min' | 'max' | 'mean';
export type ScalarReducer = 'count' | NumericReducer;

/** Scope-aware scalar barrier. The parent domain is the aggregate's left side, so
 * every origin produces one result even when the child row stream is empty. The
 * explicit encounter column is the non-null productivity marker: COUNT(v) would
 * incorrectly ignore productive null traversers. */
export function lowerScopedScalarReducer(
  input: ScalarStream,
  reducer: ScalarReducer,
  domain: Relation,
  ordinal: string,
): ScalarStream {
  if (!input.encounter) throw new Error('scoped scalar reducer requires explicit encounter order');
  const d = domain.as('d');
  const s = input.rel.as('s');
  const join = q`${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]}`;
  let aggregate: Expression;
  let result: ScalarStream['result'];
  let as = input.as;
  if (reducer === 'count') {
    aggregate = q`COUNT(${s.c[input.encounter]}) AS v`;
    result = 'count';
    as = 'long';
  } else {
    const eligible = reducer === 'min' || reducer === 'max'
      ? q`CASE WHEN typeof(${s.c.v}) in ('integer', 'real', 'text') THEN ${s.c.v} END`
      : q`CASE WHEN typeof(${s.c.v}) in ('integer', 'real') THEN ${s.c.v} END`;
    const fn = reducer === 'sum' ? 'SUM' : reducer === 'mean' ? 'AVG' : reducer === 'min' ? 'MIN' : 'MAX';
    aggregate = q`${fn}(${eligible}) AS v, ${reducer === 'mean' ? q`'real'` : q`typeof(${fn}(${eligible}))`} AS vt`;
    result = 'number';
    as = undefined;
  }
  const encounter = 'encounter';
  const rel = input.q.cte(
    q`SELECT ${aggregate}, 1 AS ${encounter}${carryFrag(input.carried, d)} FROM ${join} GROUP BY ${d.c[ordinal]}`,
    [...(result === 'number' ? ['v', 'vt'] : ['v']), encounter, ...carriedCols(input.carried)],
  );
  return toScalarStream(carryOf(input), rel, as, result, encounter);
}

/** A numeric/comparable reduction carries SQLite's winning storage class as `vt`.
 * That is part of the physical scalar payload, so a following is()/order()/limit()
 * can remain relational without losing GraphBinary numeric framing. */
export function lowerGlobalNumericReducer(input: ScalarStream, reducer: NumericReducer): ScalarStream {
  const src = input.rel.as('s');
  let body;
  if (reducer === 'sum') {
    body = q`SELECT SUM(${src.c.v}) AS v, typeof(SUM(${src.c.v})) AS vt FROM ${src}`;
  } else if (reducer === 'mean') {
    body = q`SELECT AVG(${src.c.v}) AS v, 'real' AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real')`;
  } else {
    const fn = reducer === 'min' ? 'MIN' : 'MAX';
    body = q`SELECT ${fn}(${src.c.v}) AS v, typeof(${fn}(${src.c.v})) AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real', 'text')`;
  }
  const rel = input.q.cte(body, ['v', 'vt']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, undefined, 'number');
}
