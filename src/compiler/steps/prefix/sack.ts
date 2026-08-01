import { isNested, isOperatorArg, isTokenArg } from '../../../gremlin/frontend.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { derived, q, list, type Expression } from '../../../sql/kernel/q.ts';
import { scalarProp, predicateSql, elemCtx, tokenExpr } from '../../plan/plan.ts';
import { appendCte, elemRel, prevRel, layoutCols, patchLayout, type ElementStream, type StepFn } from '../context/context.ts';
import { tryCompileScalarValueRows } from '../tail/child.ts';
import { SACK_OPS, combineSack } from '../tail/scalar.ts';

// ---------- sack (per-traverser carried scalar) ----------
//
// sack is a carried column on LoweringState (context.ts), threaded through movement/filter
// CTEs by layoutProjection exactly like origin/path. This module is the MUTATE form
// `sack(Operator.x).by(<value>)` (a prefix StepFn: element→element, replacing the
// carried column). The READ form (bare `sack()`) is a tail projection in
// projection.ts (compileSackRead). withSack() seeds the column at the source
// (index.ts seedSource). Deferred (clear throws): no-by() over an element stream
// (bare-incoming merge — needs the inject/local scalar substrate), sack through
// repeat()/barrier/local, split/merge-on-fork, the sack(BiFunction) lambda form.


/** The merge value SQL expr over the current element (aliased `n`): a property key,
 *  a T.label/T.id token, or a nested by(__.…) scalar (constant/label/values/…). */
function sackByValue(byArgs: any[] | undefined, st: ElementStream): Expression {
  const a = byArgs?.[0];
  if (a === undefined)
    throw new Error('sack(Operator.x) without a by() modulator over an element stream not yet supported');
  if (typeof a === 'string') return scalarProp(elemCtx(elemRel(st), st.elem), a);
  if (isTokenArg(a)) {
    const expr = tokenExpr(elemCtx(elemRel(st), st.elem), a.token);
    if (!expr) throw new Error(`sack().by(T.${a.token}) not yet supported`);
    return expr;
  }
  if (isNested(a))
    throw new Error('sack().by(traversal) not supported by generic scalar child lowering');
  throw new Error('unsupported sack().by() modulator');
}

/** sack(Operator.x).by(v): fold the merge value into the carried sack column. assign
 *  replaces; sum/minus/mult/div/min/max combine with the prior sack (which must exist,
 *  via withSack() or a prior sack(assign)). One by() modulator only (TinkerPop's rule);
 *  div forces REAL division (SQLite `/` is integer division on integer operands). */
export const sack: StepFn = (s, st) => {
  const op = (s.args ?? []).find(isOperatorArg)?.operator;
  if (!op) throw new Error('sack() read form should not dispatch as a prefix step'); // guarded in lowerElementSteps
  if (!SACK_OPS.has(op)) throw new Error(`sack(Operator.${op}) not yet supported`);
  const modulators = (s as IRStep).modulators ?? [];
  if (modulators.length > 1) throw new Error('Sack step can only have one by modulator');
  // aliases/path + a mutable sack still defer (fork/merge over as()/path history unverified).
  // A pushed child-scope ORIGIN is fine: the layoutCols-ordered re-projection below copies
  // every origin column through unchanged, so a scoped sack (local(__.sack(op).by(...))) folds
  // correctly per parent traverser — the origin is bookkeeping, not branch state.
  if (st.traverserLayout.aliases.size || st.traverserLayout.path)
    throw new Error('sack(Operator.x) after as()/path() state not yet supported');

  const combine = (byVal: Expression, oldSack: Expression | null): Expression => combineSack(op, byVal, oldSack);

  const nested = modulators[0]?.find(isNested);
  if (nested) {
    const rows = tryCompileScalarValueRows(st, nested.nested);
    if (rows) {
      const r = rows.stream.rel.as('r');
      if (!rows.stream.traverserLayout.encounter) throw new Error('sack().by(traversal) requires child encounter order');
      const f = derived(
        q`SELECT ${r.c.v} AS v, ${r.c[rows.frame.ordinal]} AS ${rows.frame.ordinal}, ROW_NUMBER() OVER (PARTITION BY ${r.c[rows.frame.ordinal]} ORDER BY ${r.c[rows.stream.traverserLayout.encounter]}) AS rn FROM ${r}`,
        ['v', rows.frame.ordinal, 'rn'],
        'f',
      );
      const d = rows.frame.domain.as('d');
      const newSack = combine(f.c.v, st.traverserLayout.sack ? d.c[st.traverserLayout.sack] : null);
      const proj = layoutCols(patchLayout(st.traverserLayout, { sack: 'sk' })).map((c) => c === 'sk' ? q`${newSack} AS sk` : d.c[c]);
      return appendCte(st,
        q`SELECT ${d.c.id}, ${list(proj, ', ')} FROM ${d} JOIN ${f} ON ${f.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]} AND ${f.c.rn}=1`,
        { sack: 'sk' },
      );
    }
  }

  const byVal = sackByValue(modulators[0], st);
  const p = prevRel(st, 'p');
  const newSack = combine(byVal, st.traverserLayout.sack ? p.c[st.traverserLayout.sack] : null);

  // Re-project id + every carried column in layoutCols ORDER, computing the new sack
  // value in the `sk` SLOT (NOT appended last). layoutCols orders sk before fromV/path,
  // so appending sk would desync the CTE's declared vs physical columns whenever another
  // column is co-carried — e.g. sack + otherV() (fromV): sk would silently get fromV.
  const n = elemRel(st);
  const proj = layoutCols(patchLayout(st.traverserLayout, { sack: 'sk' })).map((c) => (c === 'sk' ? q`${newSack} AS sk` : p.c[c]));
  // A by() that yields nothing (a missing property) drops the traverser (TinkerPop's
  // by-modulator semantics — same as values()); label/id/constant by-values are never
  // null so the guard is a harmless always-true there.
  const body = q`SELECT ${p.c.id}, ${list(proj, ', ')} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(byVal, undefined)}`;
  return appendCte(st, body, { sack: 'sk' });
};
