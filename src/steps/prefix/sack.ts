import { derived, q, list, type Expression } from '../../sql/kernel/q.ts';
import { scalarProp, labelNameSub, predicateSql, elemCtx } from '../../compiler/plan/plan.ts';
import { advance, elemRel, prevRel, carriedCols, type ElementStream, type StepFn } from '../context/context.ts';
import { tryCompileScalarValueRows } from '../tail/child.ts';
import { SACK_OPS, combineSack } from '../tail/scalar.ts';

// ---------- sack (per-traverser carried scalar) ----------
//
// sack is a carried column on Carry (context.ts), threaded through movement/filter
// CTEs by carryFrag exactly like origin/path. This module is the MUTATE form
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
  if (a && typeof a === 'object' && 'token' in a) {
    const ctx = elemCtx(elemRel(st), st.elem);
    if (a.token === 'label') return labelNameSub(ctx.labelIdExpr);
    if (a.token === 'id') return ctx.idExpr;
    throw new Error(`sack().by(T.${a.token}) not yet supported`);
  }
  if (a && typeof a === 'object' && 'nested' in a)
    throw new Error('sack().by(traversal) not supported by generic scalar child lowering');
  throw new Error('unsupported sack().by() modulator');
}

/** sack(Operator.x).by(v): fold the merge value into the carried sack column. assign
 *  replaces; sum/minus/mult/div/min/max combine with the prior sack (which must exist,
 *  via withSack() or a prior sack(assign)). One by() modulator only (TinkerPop's rule);
 *  div forces REAL division (SQLite `/` is integer division on integer operands). */
export const sack: StepFn = (s, st) => {
  const op = (s.args ?? []).find((a: any) => a && typeof a === 'object' && 'operator' in a)?.operator;
  if (!op) throw new Error('sack() read form should not dispatch as a prefix step'); // guarded in lowerElementSteps
  if (!SACK_OPS.has(op)) throw new Error(`sack(Operator.${op}) not yet supported`);
  const bys = (s as any).bys ?? [];
  if (bys.length > 1) throw new Error('Sack step can only have one by modulator');
  if (st.carried.aliases.size || st.carried.path || st.carried.origins.length)
    throw new Error('sack(Operator.x) after as()/path()/branch state not yet supported');

  const combine = (byVal: Expression, oldSack: Expression | null): Expression => combineSack(op, byVal, oldSack);

  const nested = bys[0]?.find((a: any) => a && typeof a === 'object' && 'nested' in a);
  if (nested) {
    const rows = tryCompileScalarValueRows(st, nested.nested);
    if (rows) {
      const r = rows.stream.rel.as('r');
      if (!rows.stream.carried.encounter) throw new Error('sack().by(traversal) requires child encounter order');
      const f = derived(
        q`SELECT ${r.c.v} AS v, ${r.c[rows.frame.ordinal]} AS ${rows.frame.ordinal}, ROW_NUMBER() OVER (PARTITION BY ${r.c[rows.frame.ordinal]} ORDER BY ${r.c[rows.stream.carried.encounter]}) AS rn FROM ${r}`,
        ['v', rows.frame.ordinal, 'rn'],
        'f',
      );
      const d = rows.frame.domain.as('d');
      const newSack = combine(f.c.v, st.carried.sack ? d.c[st.carried.sack] : null);
      const proj = carriedCols({ ...st.carried, sack: 'sk' }).map((c) => c === 'sk' ? q`${newSack} AS sk` : d.c[c]);
      return advance(st,
        q`SELECT ${d.c.id}, ${list(proj, ', ')} FROM ${d} JOIN ${f} ON ${f.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]} AND ${f.c.rn}=1`,
        { sack: 'sk' },
      );
    }
  }

  const byVal = sackByValue(bys[0], st);
  const p = prevRel(st, 'p');
  const newSack = combine(byVal, st.carried.sack ? p.c[st.carried.sack] : null);

  // Re-project id + every carried column in carriedCols ORDER, computing the new sack
  // value in the `sk` SLOT (NOT appended last). carriedCols orders sk before fromV/path,
  // so appending sk would desync the CTE's declared vs physical columns whenever another
  // column is co-carried — e.g. sack + otherV() (fromV): sk would silently get fromV.
  const n = elemRel(st);
  const proj = carriedCols({ ...st.carried, sack: 'sk' }).map((c) => (c === 'sk' ? q`${newSack} AS sk` : p.c[c]));
  // A by() that yields nothing (a missing property) drops the traverser (TinkerPop's
  // by-modulator semantics — same as values()); label/id/constant by-values are never
  // null so the guard is a harmless always-true there.
  const body = q`SELECT ${p.c.id}, ${list(proj, ', ')} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(byVal, undefined)}`;
  return advance(st, body, { sack: 'sk' });
};
