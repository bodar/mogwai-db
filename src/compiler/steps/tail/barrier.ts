import { derived, empty, q, raw, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { perRowColumnOf, staticTypeOf, type ListOf } from '../../../sql/kernel/render.ts';
import { typedScalarNode } from '../../plan/plan.ts';
import { carryOf, toListStream, toScalarStream, type ListStream, type RelationalStream, type ScalarStream } from '../context/stream.ts';
import { carriedCols, carryFrag, carryFragMint, carriedWith, withoutCarried, type ElementStream } from '../context/context.ts';
import { type ChildScope } from './child-shape.ts';

const currentFrame = (scope: ChildScope) => {
  const frame = scope.frames.at(-1);
  if (!frame) throw new Error('scoped barrier requires a child frame');
  return frame;
};

/** Global count is a relational barrier: it consumes any shaped row stream and
 * returns exactly one Long scalar traverser. Row-associated state cannot cross it.
 * count() is the RLE traverser total: SUM(bulk) when the stream carries a multiplicity
 * (a collapse merged convergent walks into (row, N) pairs), else the plain row COUNT
 * (identical while bulk≡1). */
export function lowerGlobalCount(input: RelationalStream): ScalarStream {
  const bulk = input.carried.bulk;
  const s = input.rel.as('s');
  const agg = bulk ? q`COALESCE(SUM(${s.c[bulk]}), 0)` : q`COUNT(*)`;
  const rel = input.q.cte(q`SELECT ${agg} AS v FROM ${s}`, ['v']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, 'long', { result: 'count' });
}

/** The canonical types a bare member round-trips WITHOUT an envelope — i.e. the types the
 *  READER (execute.ts anySerializer, via frameTypedNode's bare fallback) infers back
 *  identically from the JS value. That is a stricter bar than what SQL's `inferVtypeSql` can
 *  recover, and the difference is `long`: SQL distinguishes int from long by the int32 range,
 *  but the framer's JS inference does not, so a bare long > 2^53 would come back INT. Keeping
 *  `long` OUT here is what makes the round-trip lossless; everything else (datetime/uuid/
 *  bigint/bigdecimal/char/duration/boolean/byte/short/float) is lossy for the obvious reason. */
const LOSSLESS_VTYPES = raw(`('string', 'double', 'int')`);

/**
 * THE fold encoding decision — the one place a scalar stream's type channel becomes a
 * list's member encoding, shared by every fold barrier (global, scoped, aggregate).
 *
 * Carry the type explicitly exactly when the storage class does not already determine it,
 * never redundantly, never omitted when the projection is lossy:
 *
 *   perRow  — the members' types live in a column, so they may be HETEROGENEOUS and are
 *             unknown at compile time. Only a self-describing {t,v} node per member can
 *             express that, so the whole list is typed. This is the runtime-derived,
 *             uniform-per-list decision the barrier-local fix could not make.
 *   static  — one compile-time type for every member; it rides on ListOf.as (one tag for
 *             the list) and the members stay bare. No per-member envelope needed.
 *   unknown — nothing to carry; bare members, inferred per value at the wire.
 *
 * Uniform per list is the invariant: mixing encodings within one list is what broke the
 * reverted attempt (docs/2026-07-25-type-channel-unification.md).
 */
export function foldMember(input: ScalarStream, src: Relation): { member: Expression; of: ListOf } {
  const perRow = perRowColumnOf(input.type);
  if (!perRow) return { member: src.c.v, of: { kind: 'scalar', as: staticTypeOf(input.type) } };
  // The types are per-ROW, so "is an envelope needed?" is a RUNTIME question about the whole
  // list — exactly the decision the reverted barrier-local fix could not make. Wrap iff SOME
  // member's type is lossy under its storage class, asked ONCE for the whole relation: that
  // is what keeps the encoding uniform (a list is wholly typed or wholly bare, never mixed —
  // mixing is what broke the reverted attempt). `typed` therefore means "self-describing IF
  // wrapped", and the readers detect the envelope per member.
  //
  // A SECOND alias over the same relation, so the EXISTS asks "does ANY row need an
  // envelope?" rather than self-correlating to the current row. (A `MAX(…) OVER ()` window
  // would say the same thing but cannot nest inside the json_group_array aggregate.)
  const probe = src.as(`${src.name}_vt`);
  const anyLossy = q`EXISTS (SELECT 1 FROM ${probe} WHERE ${probe.c[perRow]} IS NOT NULL AND ${probe.c[perRow]} NOT IN ${LOSSLESS_VTYPES})`;
  return {
    member: q`CASE WHEN ${anyLossy} THEN ${typedScalarNode(src.c.v, { vtypeExpr: src.c[perRow] })} ELSE ${src.c.v} END`,
    of: { kind: 'scalar', typed: true },
  };
}

/** Global fold is a genuine shape transition: all scalar traversers become one
 * JSONB list traverser. The uniform compile-time item tag survives on ListOf so a
 * terminal list and a later unfold both retain GraphBinary scalar typing. */
export function lowerGlobalFold(input: ScalarStream): ListStream {
  const src = input.rel.as('s');
  // Order the folded list by the carried emission encounter when the chain tracks one
  // (canonical emission order, Stage B); otherwise the list keeps incidental row order.
  const order = input.carried.encounter ? q` ORDER BY ${src.c[input.carried.encounter]}` : empty;
  const { member, of } = foldMember(input, src);
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${member}${order}), json('[]'))) AS list FROM ${src}`,
    ['list'],
  );
  return toListStream(withoutCarried(carryOf(input)), rel, of);
}

/** Child-scoped fold produces exactly one list traverser per parent origin. The
 * domain keeps empty children alive as `[]`; FILTER keys productivity on encounter
 * rather than value so a productive SQL NULL is retained as a list member. */
export function lowerScopedScalarFold(
  input: ScalarStream,
  scope: ChildScope,
): ListStream {
  const { domain, ordinal, carried } = currentFrame(scope);
  if (!input.carried.encounter) throw new Error('scoped scalar fold requires explicit encounter order');
  const enc = input.carried.encounter;
  const d = domain.as('d');
  const s = input.rel.as('s');
  const { member, of } = foldMember(input, s);
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${member} ORDER BY ${s.c[enc]}) FILTER (WHERE ${s.c[enc]} IS NOT NULL), json('[]'))) AS list${carryFrag(carried, d)} FROM ${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]} GROUP BY ${d.c[ordinal]}`,
    ['list', ...carriedCols(carried)],
  );
  return toListStream({ ...carryOf(input), carried }, rel, of);
}

/** Element child fold stores rowids in encounter order; ListStream metadata retains
 * the element kind so unfold rejoins the correct table. The ranked relation gives
 * duplicates a physical order before aggregation, while the domain supplies []. */
export function lowerScopedElementFold(
  input: ElementStream,
  scope: ChildScope,
): ListStream {
  const { domain, ordinal, carried } = currentFrame(scope);
  const c = input.rel.as('c');
  const r = derived(
    q`SELECT ${c.c.id} AS id, ${c.c[ordinal]} AS ${ordinal}, ROW_NUMBER() OVER (PARTITION BY ${c.c[ordinal]} ORDER BY ${c.c.id}) AS encounter FROM ${c}`,
    ['id', ordinal, 'encounter'],
    'r',
  );
  const d = domain.as('d');
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${r.c.id} ORDER BY ${r.c.encounter}) FILTER (WHERE ${r.c.encounter} IS NOT NULL), json('[]'))) AS list${carryFrag(carried, d)} FROM ${d} LEFT JOIN ${r} ON ${r.c[ordinal]}=${d.c[ordinal]} GROUP BY ${d.c[ordinal]}`,
    ['list', ...carriedCols(carried)],
  );
  return toListStream({ ...carryOf(input), carried }, rel, { kind: 'elem', elem: input.elem });
}

export type NumericReducer = 'sum' | 'min' | 'max' | 'mean';
export type ScalarReducer = 'count' | NumericReducer;

/** One numeric/comparable reducer policy shared by root, child-scoped, and group-
 * scoped barriers. Callers decide the domain and productivity join; this helper owns
 * eligible SQLite storage classes and the dynamic GraphBinary result type. When the
 * stream carries a per-row `bulk` multiplicity, sum/mean weight by it (a value present
 * with bulk N counts N times); min/max are bulk-invariant. Identical to the unweighted
 * form while bulk≡1 (SUM(v*1)=SUM(v), the weighted mean = AVG). */
export function numericReducerAggregate(
  value: Expression,
  reducer: NumericReducer,
  bulk?: Expression,
): { value: Expression; type: Expression } {
  const eligible = reducer === 'min' || reducer === 'max'
    ? q`CASE WHEN typeof(${value}) in ('integer', 'real', 'text') THEN ${value} END`
    : q`CASE WHEN typeof(${value}) in ('integer', 'real') THEN ${value} END`;
  if (bulk && reducer === 'sum')
    return { value: q`SUM(${eligible} * ${bulk})`, type: q`typeof(SUM(${eligible} * ${bulk}))` };
  if (bulk && reducer === 'mean')
    // Weighted mean, forced to REAL (avoid integer division): Σ(v·bulk) / Σ(bulk over eligible rows).
    return { value: q`SUM(${eligible} * ${bulk}) * 1.0 / SUM(CASE WHEN ${eligible} IS NOT NULL THEN ${bulk} END)`, type: q`'real'` };
  const fn = reducer === 'sum' ? 'SUM' : reducer === 'mean' ? 'AVG' : reducer === 'min' ? 'MIN' : 'MAX';
  const reduced = q`${fn}(${eligible})`;
  return { value: reduced, type: reducer === 'mean' ? q`'real'` : q`typeof(${reduced})` };
}

/** Scope-aware scalar barrier. The parent domain is the aggregate's left side, so
 * every origin produces one result even when the child row stream is empty. The
 * explicit encounter column is the non-null productivity marker: COUNT(v) would
 * incorrectly ignore productive null traversers. */
export function lowerScopedScalarReducer(
  input: ScalarStream,
  reducer: ScalarReducer,
  scope: ChildScope,
): ScalarStream {
  const { domain, ordinal, carried } = currentFrame(scope);
  if (!input.carried.encounter) throw new Error('scoped scalar reducer requires explicit encounter order');
  const inEnc = input.carried.encounter;
  const d = domain.as('d');
  const s = input.rel.as('s');
  const join = q`${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]}`;
  const bulk = input.carried.bulk ? s.c[input.carried.bulk] : undefined;
  let aggregate: Expression;
  let result: ScalarStream['result'];
  let as = staticTypeOf(input.type);
  if (reducer === 'count') {
    // Count the productive (non-null encounter) child rows, weighted by bulk when present
    // — the LEFT JOIN's null-padded empty-child rows contribute 0.
    aggregate = bulk
      ? q`COALESCE(SUM(CASE WHEN ${s.c[inEnc]} IS NOT NULL THEN ${bulk} END), 0) AS v`
      : q`COUNT(${s.c[inEnc]}) AS v`;
    result = 'count';
    as = 'long';
  } else {
    const reduced = numericReducerAggregate(s.c.v, reducer, bulk);
    aggregate = q`${reduced.value} AS v, ${reduced.type} AS vt`;
    result = 'number';
    as = undefined;
  }
  // One result row per origin — mint a constant encounter (1) into its carried slot as the
  // per-origin order marker a following scoped slice/reducer needs.
  const outCarried = carriedWith(carried, { encounter: 'encounter' });
  const rel = input.q.cte(
    q`SELECT ${aggregate}${carryFragMint(outCarried, d, 'encounter', q`1`)} FROM ${join} GROUP BY ${d.c[ordinal]}`,
    [...(result === 'number' ? ['v', 'vt'] : ['v']), ...carriedCols(outCarried)],
  );
  return toScalarStream({ ...carryOf(input), carried: outCarried }, rel, as, { result });
}

/** A numeric/comparable reduction carries SQLite's winning storage class as `vt`.
 * That is part of the physical scalar payload, so a following is()/order()/limit()
 * can remain relational without losing GraphBinary numeric framing. */
export function lowerGlobalNumericReducer(input: ScalarStream, reducer: NumericReducer): ScalarStream {
  const src = input.rel.as('s');
  const bulk = input.carried.bulk ? src.c[input.carried.bulk] : undefined;
  let body;
  if (reducer === 'sum') {
    const sum = bulk ? q`SUM(${src.c.v} * ${bulk})` : q`SUM(${src.c.v})`;
    body = q`SELECT ${sum} AS v, typeof(${sum}) AS vt FROM ${src}`;
  } else if (reducer === 'mean') {
    // Weighted mean over the numeric rows (WHERE already restricts to them): Σ(v·bulk)/Σbulk,
    // forced REAL. bulk absent → AVG. Both = AVG while bulk≡1.
    body = bulk
      ? q`SELECT SUM(${src.c.v} * ${bulk}) * 1.0 / SUM(${bulk}) AS v, 'real' AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real')`
      : q`SELECT AVG(${src.c.v}) AS v, 'real' AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real')`;
  } else {
    const fn = reducer === 'min' ? 'MIN' : 'MAX';
    body = q`SELECT ${fn}(${src.c.v}) AS v, typeof(${fn}(${src.c.v})) AS vt FROM ${src} WHERE typeof(${src.c.v}) in ('integer', 'real', 'text')`;
  }
  const rel = input.q.cte(body, ['v', 'vt']);
  return toScalarStream(withoutCarried(carryOf(input)), rel, undefined, { result: 'number', productiveNull: input.productiveNull });
}
