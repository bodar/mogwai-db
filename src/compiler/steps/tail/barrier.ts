import { derived, empty, list, q, raw, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { perRowColumnOf, staticTypeOf, type ListOf } from '../../../sql/kernel/render.ts';
import { sliceSuffix, typedScalarNode } from '../../plan/plan.ts';
import { isLocalScope, type NumericReducer, type ScalarReducer } from '../../ir/step.ts';

import { cardinalityOf, continueLowering, loweringStateOf, streamColumns, toListStream, toScalarStream, withRelation, type ListStream, type RelationalStream, type ScalarStream, type ShapeTailFn } from '../context/stream.ts';
import { layoutCols, layoutProjection, layoutProjectionMinting, patchLayout, dropLayoutAtBarrier, type ElementStream } from '../context/context.ts';
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
  const bulk = input.traverserLayout.bulk;
  const s = input.rel.as('s');
  const cardinality = cardinalityOf(input);
  const agg = cardinality.kind === 'wholeResult'
    ? q`1`
    : cardinality.kind === 'runsByKey'
      ? q`COUNT(DISTINCT ${s.c[cardinality.key]})`
      : bulk ? q`COALESCE(SUM(${s.c[bulk]}), 0)` : q`COUNT(*)`;
  const rel = cardinality.kind === 'wholeResult'
    ? input.q.cte(q`SELECT ${agg} AS v`, ['v'])
    : input.q.cte(q`SELECT ${agg} AS v FROM ${s}`, ['v']);
  return toScalarStream(dropLayoutAtBarrier(loweringStateOf(input)), rel, 'long', { result: 'count' });
}

/** What a row-preserving re-projection may do beyond re-projecting. `suffix` carries a slice's
 *  `LIMIT/OFFSET`; `distinct` collapses duplicate rows; `orderByEncounter` makes the window
 *  deterministic when — and only when — the chain actually carries emission order. */
export interface RowOpts {
  readonly distinct?: boolean;
  readonly suffix?: Expression;
  readonly orderByEncounter?: boolean;
}

/**
 * A ROW-PRESERVING re-projection of any shaped stream: same traversers, same payload, same carried
 * schema, over a new relation that may drop rows (a slice) or collapse duplicates (a dedup).
 *
 * This is the shared row-op `lowerGlobalCount` above has been the only instance of. The scalar,
 * variant and record tails each had their own near-verbatim copy (`rowPreserving`, `reselect`,
 * `recordSlice`'s global branch) differing in nothing but how they spelled the projected column
 * list — and `streamColumns` already owns that per kind, so there was nothing per-shape left.
 * `withRelation` then rebuilds the stream with every other channel (type, arms, fields, `of`,
 * `result`) intact and asserts the replacement relation against the declared contract.
 *
 * **`cardinalityOf` is the load-bearing part, not decoration.** A row op is only the op the user
 * asked for when one row IS one traverser. A grouped `PathStream` has one row per POSITION and a
 * `GroupStream` is one whole result, so slicing their rows would answer a different question
 * silently — `limit(2)` over a grouped path would take two positions, not two paths. Both fail
 * closed here rather than at each caller, which is what makes registering this into eleven
 * dispatch tables safe instead of a way to spread wrong answers.
 *
 * It deliberately says nothing about `Scope.local`: a local slice addresses a shape's MEMBERS (a
 * list's elements, a record's fields), which is not a row op at all. Callers must route that to
 * their own local builder before reaching this.
 */
export function reprojectRows<T extends RelationalStream>(s: T, opts: RowOpts = {}): T {
  const cardinality = cardinalityOf(s);
  if (cardinality.kind !== 'perRow')
    throw new Error(`a row operation over a ${cardinality.kind} relation is not yet supported (its rows are not its traversers, so slicing them would answer a different question)`);
  const p = s.rel.as('p');
  const cols = streamColumns(s);
  // Keep an unordered relation unordered rather than inventing a SQLite scan order; minting the
  // encounter channel is the source/merge builders' job, and a positional consumer has a canonical
  // answer exactly when the chain asked for one.
  const order = opts.orderByEncounter && s.traverserLayout.encounter ? q` ORDER BY ${p.c[s.traverserLayout.encounter]}` : empty;
  const body = q`SELECT ${opts.distinct ? q`DISTINCT ` : empty}${list(cols.map((c) => p.c[c]), ', ')} FROM ${p}${order}${opts.suffix ?? empty}`;
  return withRelation(s, s.q.cte(body, cols));
}

/**
 * Compose handlers for ONE step name: the first that does not decline wins.
 *
 * `dispatchShapeTail` consults exactly one handler per name, so a shape that already owns a builder
 * for `limit` cannot also take the shared row op by spreading both into the Map — the later entry
 * silently WINS, and the shared op then declines a `Scope.local` step into the fallback throw rather
 * than into the handler that was there before.
 *
 * That is not hypothetical: spreading both is what the first attempt did, and it stopped **42 corpus
 * traversals executing** (`limit()/range()/skip()/dedup() on a list value not yet supported`), which
 * the census caught as its headline "support lost" gate. Compose, never shadow.
 */
export const firstOf = <T>(...fns: readonly ShapeTailFn<T>[]): ShapeTailFn<T> => (s, step, steps, at) => {
  for (const fn of fns) {
    const result = fn(s, step, steps, at);
    if (result) return result;
  }
  return null;
};

/**
 * The GLOBAL row ops as `dispatchShapeTail` entries, for any shape whose rows are its traversers.
 * Spread into a shape's table — `new Map([...globalRowOps<ListStream>(), ['unfold', …]])` — which is
 * what the `dispatchShapeTail` transposition was the precondition for: registering four ops into
 * eleven tables is a spread, editing eleven if-chains is not.
 *
 * Every entry DECLINES (returns null) rather than throwing when it does not apply, so a shape that
 * owns a member-scoped builder for the same step name keeps it:
 *
 *  - a `Scope.local` slice addresses a shape's MEMBERS (a list's elements, a record's fields), which
 *    is a different question from slicing rows, so it falls through to the shape's own handler;
 *  - `reprojectRows` itself fails closed on a non-`perRow` cardinality, so a `GroupStream` (one
 *    whole result) and a grouped `PathStream` (one row per position) get a declared deferral rather
 *    than a silently wrong window.
 *
 * `dedup` carries three guards, and they are shape-INDEPENDENT — they are about carried state and
 * modulators, not about the payload — which is why they belong here rather than being re-derived
 * per shape: a label-scoped or `by()`-scoped dedup is a different collapse key, and carried path or
 * alias state makes a bare `DISTINCT` over the row the wrong question (path-distinct semantics).
 * `bulk` is exempt because it is ≡1 today, so it cannot change what DISTINCT collapses.
 */
export function globalRowOps<T extends RelationalStream>(): [string, ShapeTailFn<T>][] {
  const slice: ShapeTailFn<T> = (s, step, _steps, at) =>
    isLocalScope(step) ? null
      : continueLowering(reprojectRows(s, { suffix: sliceSuffix(step), orderByEncounter: true }), at + 1);
  return [
    ['limit', slice],
    ['skip', slice],
    ['range', slice],
    ['dedup', (s, step, _steps, at) => {
      if (isLocalScope(step)) return null;
      if ((step.args ?? []).length) throw new Error('dedup(label) not yet supported');
      if ((step.modulators ?? []).length) throw new Error(`dedup().by() over a ${s.kind} value not yet supported`);
      if (layoutCols(s.traverserLayout).some((c) => c !== s.traverserLayout.bulk))
        throw new Error(`dedup() over a ${s.kind} value with carried path/label state not yet supported (path-distinct semantics)`);
      return continueLowering(reprojectRows(s, { distinct: true }), at + 1);
    }],
  ];
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
 * reverted attempt (docs/archive/2026-07-25-type-channel-unification.md).
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
  const order = input.traverserLayout.encounter ? q` ORDER BY ${src.c[input.traverserLayout.encounter]}` : empty;
  const { member, of } = foldMember(input, src);
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${member}${order}), json('[]'))) AS list FROM ${src}`,
    ['list'],
  );
  return toListStream(dropLayoutAtBarrier(loweringStateOf(input)), rel, of);
}

/** Child-scoped fold produces exactly one list traverser per parent origin. The
 * domain keeps empty children alive as `[]`; FILTER keys productivity on encounter
 * rather than value so a productive SQL NULL is retained as a list member. */
export function lowerScopedScalarFold(
  input: ScalarStream,
  scope: ChildScope,
): ListStream {
  const { domain, ordinal, traverserLayout: layout } = currentFrame(scope);
  if (!input.traverserLayout.encounter) throw new Error('scoped scalar fold requires explicit encounter order');
  const enc = input.traverserLayout.encounter;
  const d = domain.as('d');
  const s = input.rel.as('s');
  const { member, of } = foldMember(input, s);
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${member} ORDER BY ${s.c[enc]}) FILTER (WHERE ${s.c[enc]} IS NOT NULL), json('[]'))) AS list${layoutProjection(layout, d)} FROM ${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]} GROUP BY ${d.c[ordinal]}`,
    ['list', ...layoutCols(layout)],
  );
  return toListStream(loweringStateOf(input, layout), rel, of);
}

/** Element child fold stores rowids in encounter order; ListStream metadata retains
 * the element kind so unfold rejoins the correct table. The ranked relation gives
 * duplicates a physical order before aggregation, while the domain supplies []. */
export function lowerScopedElementFold(
  input: ElementStream,
  scope: ChildScope,
): ListStream {
  const { domain, ordinal, traverserLayout: layout } = currentFrame(scope);
  const c = input.rel.as('c');
  const r = derived(
    q`SELECT ${c.c.id} AS id, ${c.c[ordinal]} AS ${ordinal}, ROW_NUMBER() OVER (PARTITION BY ${c.c[ordinal]} ORDER BY ${c.c.id}) AS encounter FROM ${c}`,
    ['id', ordinal, 'encounter'],
    'r',
  );
  const d = domain.as('d');
  const rel = input.q.cte(
    q`SELECT jsonb(COALESCE(json_group_array(${r.c.id} ORDER BY ${r.c.encounter}) FILTER (WHERE ${r.c.encounter} IS NOT NULL), json('[]'))) AS list${layoutProjection(layout, d)} FROM ${d} LEFT JOIN ${r} ON ${r.c[ordinal]}=${d.c[ordinal]} GROUP BY ${d.c[ordinal]}`,
    ['list', ...layoutCols(layout)],
  );
  return toListStream(loweringStateOf(input, layout), rel, { kind: 'elem', elem: input.elem });
}

// The reducer NAME types are declared beside their member set in `ir/step.ts` (the set is the
// authority; the type is derived from its member list). Re-exported here because this is where
// every reducer-lowering caller already looks, and moving the imports would be pure churn.
export type { NumericReducer, ScalarReducer } from '../../ir/step.ts';

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
): { value: Expression; type: Expression; productive: Expression } {
  const eligible = reducer === 'min' || reducer === 'max'
    ? q`CASE WHEN typeof(${value}) in ('integer', 'real', 'text') THEN ${value} END`
    : q`CASE WHEN typeof(${value}) in ('integer', 'real') THEN ${value} END`;
  if (bulk && reducer === 'sum') {
    const reduced = q`SUM(${eligible} * ${bulk})`;
    return { value: reduced, type: q`typeof(${reduced})`, productive: q`${reduced} IS NOT NULL` };
  }
  if (bulk && reducer === 'mean')
    // Weighted mean, forced to REAL (avoid integer division): Σ(v·bulk) / Σ(bulk over eligible rows).
    {
      const reduced = q`SUM(${eligible} * ${bulk}) * 1.0 / SUM(CASE WHEN ${eligible} IS NOT NULL THEN ${bulk} END)`;
      return { value: reduced, type: q`'real'`, productive: q`${reduced} IS NOT NULL` };
    }
  const fn = reducer === 'sum' ? 'SUM' : reducer === 'mean' ? 'AVG' : reducer === 'min' ? 'MIN' : 'MAX';
  const reduced = q`${fn}(${eligible})`;
  return { value: reduced, type: reducer === 'mean' ? q`'real'` : q`typeof(${reduced})`, productive: q`${reduced} IS NOT NULL` };
}

/** Scope-aware scalar barrier. The parent domain is the aggregate's left side, so
 * every origin produces one result even when the child row stream is empty. The
 * explicit encounter column is the non-null productivity marker: COUNT(v) would
 * incorrectly ignore productive null traversers.
 *
 * A SCOPED barrier does NOT weight by `bulk`, and that is the axis — the same column means
 * opposite things either side of it:
 *   • an aggregate that COLLAPSES the multiset it reads into one total (the global count/reducers
 *     below; a per-key group total, `valBulk` in group.ts) MUST flatten each row by its
 *     multiplicity — a bulk-N traverser contributes N times. Pinned by P1.1.
 *   • an aggregate that emits one row PER PARENT — this one — must not. `bulk` on these child rows
 *     is the PARENT's multiplicity, inherited: `pushChildScope` projects the parent's whole carried
 *     schema into the child domain, and a movement inside a child scope does not itself collapse.
 *     So a collapsed parent row `(d, bulk=2)` hands every child row `bulk=2`, and those 2
 *     traversers each see the SAME children — the per-traverser answer is 2 neighbours, not 4. The
 *     domain re-projects that same bulk onto the result row, so the outer consumer applies it
 *     exactly once; weighting here applied it TWICE and silently answered `[]` for
 *     `where(__.out().values('age').sum().is(11))` as soon as the outer chain collapsed — a
 *     movementCollapse equivalence violation on the DEFAULT config. Pinned by P1.2.
 * (Both pins: test/L2-sql/repeat-path.sql.test.ts.)
 * Bulk minted INSIDE a child body (a collapse of convergent CHILD walks) would need weighting;
 * nothing can produce one today, so that policy is deliberately absent rather than guessed. */
export function lowerScopedScalarReducer(
  input: ScalarStream,
  reducer: ScalarReducer,
  scope: ChildScope,
): ScalarStream {
  const { domain, ordinal, traverserLayout: layout } = currentFrame(scope);
  const d = domain.as('d');
  const s = input.rel.as('s');
  const join = q`${d} LEFT JOIN ${s} ON ${s.c[ordinal]}=${d.c[ordinal]}`;
  // The PRODUCTIVITY marker: what tells a real child row from the LEFT JOIN's null padding. The
  // carried `encounter` is it when the stream has one — but note this reads it for existence ONLY,
  // never as an ORDER, because every aggregate below is order-insensitive. So a stream carrying no
  // encounter is not a deferral: the child row's own ORDINAL is non-null on exactly the real rows
  // and NULL on the padding, which is the same discrimination. (It cannot stand in for an emission
  // order, and nothing here asks it to — a `first` cardinality policy downstream ranks on the
  // per-origin marker this step MINTS on its own one-row-per-origin output.)
  const productive = input.traverserLayout.encounter ? s.c[input.traverserLayout.encounter] : s.c[ordinal];
  let aggregate: Expression;
  let having: Expression = empty;
  let result: ScalarStream['result'];
  let as = staticTypeOf(input.type);
  if (reducer === 'count') {
    // Count the productive child rows — the LEFT JOIN's null-padded empty-child rows
    // contribute 0. Unweighted: see the bulk rule above.
    aggregate = q`COUNT(${productive}) AS v`;
    result = 'count';
    as = 'long';
  } else {
    const reduced = numericReducerAggregate(s.c.v, reducer);
    aggregate = q`${reduced.value} AS v, ${reduced.type} AS vt`;
    // Numeric reducers are unproductive over an empty (or wholly ineligible) child
    // stream. The domain LEFT JOIN remains required for always-productive count(), but
    // these reducers must remove its null aggregate row so every child consumer observes
    // ordinary apply cardinality.
    having = q` HAVING ${reduced.productive}`;
    result = 'number';
    as = undefined;
  }
  // One result row per origin — mint a constant encounter (1) into its carried slot as the
  // per-origin order marker a following scoped slice/reducer needs.
  const outCarried = patchLayout(layout, { encounter: 'encounter' });
  const rel = input.q.cte(
    q`SELECT ${aggregate}${layoutProjectionMinting(outCarried, d, 'encounter', q`1`)} FROM ${join} GROUP BY ${d.c[ordinal]}${having}`,
    [...(result === 'number' ? ['v', 'vt'] : ['v']), ...layoutCols(outCarried)],
  );
  return toScalarStream(loweringStateOf(input, outCarried), rel, as, { result });
}

/** A numeric/comparable reduction carries SQLite's winning storage class as `vt`.
 * That is part of the physical scalar payload, so a following is()/order()/limit()
 * can remain relational without losing GraphBinary numeric framing.
 *
 * The eligibility guard and the result type come from `numericReducerAggregate` above — the ONE
 * reducer policy — rather than being re-derived here. They were, for 60 lines, with a `WHERE`
 * instead of its `CASE WHEN`; that is equivalent for min/max/mean (a bare aggregate returns one row
 * either way, and AVG ignores NULLs) but NOT for `sum`, which carried no guard at all. So
 * `g.V().values('name').sum()` returned a fabricated **0** — SQLite coerces text to 0 inside SUM —
 * where the other three arms of the same step correctly reported nothing eligible. */
export function lowerGlobalNumericReducer(input: ScalarStream, reducer: NumericReducer): ScalarStream {
  const src = input.rel.as('s');
  const bulk = input.traverserLayout.bulk ? src.c[input.traverserLayout.bulk] : undefined;
  const agg = numericReducerAggregate(src.c.v, reducer, bulk);
  const rel = input.q.cte(q`SELECT ${agg.value} AS v, ${agg.type} AS vt FROM ${src}`, ['v', 'vt']);
  return toScalarStream(dropLayoutAtBarrier(loweringStateOf(input)), rel, undefined, { result: 'number', productiveNull: input.productiveNull });
}
