import { q, list, empty, type Expression } from '../q.ts';
import { propExtract, labelNameSub, compileNestedScalar, predicateSql, elemCtx } from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { advance, elemRel, prevRel, carriedCols, type St, type StepFn } from './context.ts';

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

const SACK_OPS = new Set(['assign', 'sum', 'minus', 'mult', 'div', 'min', 'max']);

/** The merge value SQL expr over the current element (aliased `n`): a property key,
 *  a T.label/T.id token, or a nested by(__.…) scalar (constant/label/values/…). */
function sackByValue(byArgs: any[] | undefined, st: St): Expression {
  const a = byArgs?.[0];
  if (a === undefined)
    throw new Error('sack(Operator.x) without a by() modulator over an element stream not yet supported');
  if (typeof a === 'string') return propExtract('n.props', a).expr;
  if (a && typeof a === 'object' && 'token' in a) {
    const ctx = elemCtx(elemRel(st), st.elem);
    if (a.token === 'label') return labelNameSub(ctx.labelIdExpr);
    if (a.token === 'id') return ctx.idExpr;
    throw new Error(`sack().by(T.${a.token}) not yet supported`);
  }
  if (a && typeof a === 'object' && 'nested' in a)
    return compileNestedScalar(stepChain(a.nested, st.params), elemCtx(elemRel(st), st.elem)).expr;
  throw new Error('unsupported sack().by() modulator');
}

/** sack(Operator.x).by(v): fold the merge value into the carried sack column. assign
 *  replaces; sum/minus/mult/div/min/max combine with the prior sack (which must exist,
 *  via withSack() or a prior sack(assign)). One by() modulator only (TinkerPop's rule);
 *  div forces REAL division (SQLite `/` is integer division on integer operands). */
export const sack: StepFn = (s, st) => {
  const op = (s.args ?? []).find((a: any) => a && typeof a === 'object' && 'operator' in a)?.operator;
  if (!op) throw new Error('sack() read form should not dispatch as a prefix step'); // guarded in foldBody
  if (!SACK_OPS.has(op)) throw new Error(`sack(Operator.${op}) not yet supported`);
  const bys = (s as any).bys ?? [];
  if (bys.length > 1) throw new Error('Sack step can only have one by modulator');
  if (st.aliases.size || st.path || st.origin)
    throw new Error('sack(Operator.x) after as()/path()/branch state not yet supported');

  const byVal = sackByValue(bys[0], st);
  const p = prevRel(st, 'p');
  const oldSack = st.sack ? p.c[st.sack] : null;
  let newSack: Expression;
  if (op === 'assign') newSack = byVal;
  else {
    if (!oldSack) throw new Error(`sack(Operator.${op}) requires withSack() or a prior sack(assign)`);
    newSack = op === 'sum' ? q`(${oldSack} + ${byVal})`
      : op === 'minus' ? q`(${oldSack} - ${byVal})`
      : op === 'mult' ? q`(${oldSack} * ${byVal})`
      : op === 'div' ? q`(CAST(${oldSack} AS REAL) / ${byVal})`
      : op === 'min' ? q`MIN(${oldSack}, ${byVal})`
      : q`MAX(${oldSack}, ${byVal})`;
  }

  // Carry alias/path/origin columns unchanged; REPLACE the sack column (so exclude it
  // from the carried-forward set and re-project the merged value as `sk`).
  const n = elemRel(st);
  const others = carriedCols(st).filter((c) => c !== st.sack);
  const othersFrag = others.length ? list(others.map((c) => q`, ${p.c[c]}`), '') : empty;
  // A by() that yields nothing (a missing property) drops the traverser (TinkerPop's
  // by-modulator semantics — same as values()); label/id/constant by-values are never
  // null so the guard is a harmless always-true there.
  const body = q`SELECT ${p.c.id}${othersFrag}, ${newSack} AS sk FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${predicateSql(byVal, undefined)}`;
  return advance(st, body, { sack: 'sk' });
};
