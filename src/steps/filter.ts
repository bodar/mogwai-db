import { q, list } from '../q.ts';
import { stepChain, type Pred } from '../frontend.ts';
import {
  P_OPS, propExtract, labelIn, predicateSql, propAt,
  compileFilterPredicate, combineBranchPreds, type ScalarCtx, type Elem,
} from '../plan.ts';
import { advance, carryFrag, elemRel, prevRel, type AliasMap, type St, type StepFn } from './context.ts';
import { type Expression } from '@bodar/lazyrecords/sql/template/Expression.ts';

// ---------- filter (predicates over the current traverser) ----------

/** `NOT COALESCE((<pred>), 0)` — negate a predicate so a NULL (missing prop)
 *  counts as "no output" → kept, matching not(traversal) semantics. */
const notCoalesce = (expr: Expression): Expression => q`NOT COALESCE((${expr}), 0)`;

/** The SQL expr holding a labelled traverser's id (its carried alias column). */
function aliasIdExpr(label: string, aliases: AliasMap): string {
  const entry = aliases.get(label);
  if (!entry) throw new Error(`where("${label}"): no such label — as("${label}") was not seen`);
  return `p.${entry.col}`;
}

/** The scalar context a current-element predicate correlates on (aliased `n`). */
const currentCtx = (st: St): ScalarCtx =>
  ({ elem: st.elem, idExpr: 'n.id', propsExpr: 'n.props', labelIdExpr: 'n.label', srcExpr: 'n.src', tgtExpr: 'n.tgt' });

/** `SELECT n.id<carry> FROM <elem> n JOIN prev p … WHERE <test>` — the filter CTE
 *  shape shared by has/hasLabel/where/and/or. */
function filterCte(st: St, test: Expression, indexKeys?: Iterable<string>): St {
  const n = elemRel(st);
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${n.c.id}${carryFrag(st, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${test}`, { indexKeys });
}

/** as(): bind each label to the current traverser (rebinds reuse the label's
 *  column, default Pop = last). A pass-through CTE keeps id + all carried alias
 *  columns, (re)setting the bound ones to the current id. */
export const as: StepFn = (s, st) => {
  const labels = s.args.filter((a): a is string => typeof a === 'string');
  const aliases = new Map(st.aliases);
  const rebind: string[] = [];
  for (const lbl of labels) {
    const existing = aliases.get(lbl);
    const col = existing?.col ?? `a${aliases.size}`;
    aliases.set(lbl, { col, elem: st.elem }); // rebind: default Pop = last, re-capture kind
    rebind.push(col);
  }
  const cols = ['id', ...[...aliases.values()].map((a) => rebind.includes(a.col) ? `id AS ${a.col}` : a.col)];
  return advance(st, q`SELECT ${cols.join(', ')} FROM ${prevRel(st)}`, { aliases });
};

export const hasLabel: StepFn = (s, st) => filterCte(st, labelIn('n.label', s.args));

export const has: StepFn = (s, st) => {
  const conds: Expression[] = [];
  const indexKeys: string[] = [];
  let a = s.args;
  // has(label, key, value) — the 3-arg overload folds in a label filter.
  if (a.length === 3 && typeof a[0] === 'string') {
    conds.push(labelIn('n.label', [a[0]]));
    a = a.slice(1);
  }
  const [key, val] = a;
  if (key && typeof key === 'object' && 'token' in key) {
    // has(T.label|T.id, v|P): predicate over the label name / external id. Routing
    // through predicateSql accepts both a bare value (→ equality) and a P/TextP.
    const n = elemRel(st);
    const expr: Expression = key.token === 'label' ? q`(SELECT name FROM labels WHERE id=${n.c.label})`
      : key.token === 'id' ? q`COALESCE(${n.c.uid}, ${n.c.id})`
      : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
    conds.push(predicateSql(expr, val));
  } else {
    const pe = propExtract('n.props', key); // literal path for indexable keys
    // Only node property indexes are auto-built; an edge has() filters correctly
    // but stays unindexed for now.
    if (pe.indexKey && st.elem === 'node') indexKeys.push(pe.indexKey);
    conds.push(predicateSql(pe.expr, val));
  }
  return filterCte(st, list(conds, ' AND '), indexKeys);
};

/** where()/filter()/not(): keep rows satisfying the nested traversal (or an
 *  alias comparison). not() negates via notCoalesce. */
export const where: StepFn = (s, st) => {
  const arg0 = s.args[0];
  if (arg0 && typeof arg0 === 'object' && 'nested' in arg0) {
    const pred = compileFilterPredicate(stepChain(arg0.nested, st.params), currentCtx(st), st.params);
    return filterCte(st, s.name === 'not' ? notCoalesce(pred.expr) : pred.expr, pred.indexKeys);
  }
  // Alias-compare: where("a", P.eq("b")) (label vs label) or where(P.neq("a"))
  // (current traverser vs label), optionally .by(key) (folded onto s.bys) to
  // compare a property instead of element identity.
  if (s.name === 'filter') throw new Error('filter(predicate) not supported; use filter(traversal)');
  const [left, pred, leftElem]: [string, Pred, Elem] = typeof arg0 === 'string'
    ? [aliasIdExpr(arg0, st.aliases), s.args[1] as Pred, st.aliases.get(arg0)!.elem]
    : ['n.id', arg0 as Pred, st.elem];
  if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison not yet supported`);
  const right = aliasIdExpr(pred.values[0], st.aliases);
  const rightElem = st.aliases.get(pred.values[0])!.elem;
  // An alias-compare where() takes at most one by(key). foldByModulators absorbs
  // every contiguous by(); a second one is not a valid modulator here — fail
  // closed rather than silently answer a different question (matches group()'s
  // bys.length>2 guard; the original consumed exactly one by() and let the rest throw).
  if ((s.bys?.length ?? 0) > 1) throw new Error('by() is only supported as an order() or select()/project() modulator');
  const byKey = s.bys?.[0]?.find((x: any) => typeof x === 'string') as string | undefined;
  let testNode: Expression;
  if (byKey !== undefined) {
    // propAt reads the nodes table; an edge-typed operand would silently read a
    // vertex's props (ids collide across spaces) → reject.
    if (leftElem === 'edge' || rightElem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
    testNode = q`${propAt(left, null, byKey).expr} ${P_OPS[pred.op]} ${propAt(right, null, byKey).expr}`;
  } else {
    testNode = q`${left} ${P_OPS[pred.op]} ${right}`;
  }
  return filterCte(st, s.name === 'not' ? notCoalesce(testNode) : testNode);
};

/** and()/or(): keep the traverser when ALL / ANY branch predicates hold. */
export const andOr: StepFn = (s, st) => {
  const pred = combineBranchPreds(s, currentCtx(st), st.params, s.name === 'and' ? 'AND' : 'OR');
  return filterCte(st, pred.expr, pred.indexKeys);
};

/** dedup(): collapse the multiset on the current object. Label-scoped dedup and
 *  dedup with active as() labels (path-distinct) are deferred rather than
 *  silently over-counting. */
export const dedup: StepFn = (s, st) => {
  if (s.args.length > 0) throw new Error('dedup(label) not yet supported');
  if (st.aliases.size > 0) throw new Error('dedup() after as() not yet supported (path-distinct semantics)');
  return advance(st, q`SELECT DISTINCT id FROM ${prevRel(st)}`);
};
