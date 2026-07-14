import { q, value, list, empty, Query, type Expression } from '../q.ts';
import { predicateSql, jsonbArrayOf } from '../plan.ts';
import { flattenListArgs } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { type Carry } from './context.ts';
import { toListStream } from './stream.ts';
import { dispatchNext } from './index.ts';
import { readCompiled, type Compiled, type ValueType } from '../render.ts';
import { foldTailAcc, renderProjection, type ProjResult } from './projection.ts';
import { numericSpec, asBoolConst, asNumberConst, asNumberBare, asDateConst, dtFactor, dateDiffOtherMs } from './coerce.ts';

/** g.inject(v1, v2, …) — an inject-rooted read: a scalar `v` stream seeded from
 *  constants, then the SAME value tail every projection uses (foldTailAcc +
 *  renderProjection). All inject() args across the chain seed one VALUES union (so
 *  dedup/order/reducer see the whole stream); the shared tail applies the rest.
 *  Only reaches here for pure inject-rooted chains (addV/addE/mergeV/mergeE match
 *  earlier in WRITE_RULES). A bare inject() is an empty stream. */
export function compileInject(steps: PStep[]): Compiled {
  // inject of ALL-array args → a stream of LIST VALUES (the list substrate): each
  // bracket arg is ONE list traverser (inject([1,2,3]) = one list; inject([1,2],[3,4])
  // = two). Route to the list phase (dispatchNext → compileFromList): unfold explodes,
  // Scope.local reducers reduce per-list, a terminal inject frames each list. A mixed
  // (some scalar) or all-scalar inject stays the flat `v`-stream path below.
  if (steps[0].args.length >= 1 && steps[0].args.every((a: any) => Array.isArray(a))) {
    const Q = new Query();
    const rows = steps[0].args.map((a: any[]) => q`(${jsonbArrayOf(a)})`);
    const rel = Q.cte(q`VALUES ${list(rows, ', ')}`, ['list']);
    const carry: Carry = { q: Q, params: {}, carried: { aliases: new Map() } };
    return dispatchNext(toListStream(carry, rel, { kind: 'scalar' }), steps, 1);
  }

  const Q = new Query();
  const { acc, stop } = foldTailAcc(steps, 1);
  // A retype boundary after inject (inject([..]).unfold(), a non-terminal fold) needs
  // the inject-as-list-value substrate — deferred (inject still flattens for now).
  if (stop !== steps.length) throw new Error(`${steps[stop].name}() after inject() not yet supported`);
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

  // TEMPORARY (removed when inject-list becomes a real list value, commit 4): a lone
  // collection-literal arg spreads back to varargs so inject([a,b]) keeps its current
  // flattened stream semantics. TinkerPop's inject([a,b]) is actually ONE list object;
  // that lands with the list substrate — until then, preserve the existing behavior.
  const vals = [...flattenListArgs(steps[0].args), ...acc.injects];
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
  return renderProjection(Q, proj, acc, orderKey);
}
