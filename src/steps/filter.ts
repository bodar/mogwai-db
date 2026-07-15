import { q, list, raw, type Expression } from '../q.ts';
import { stepChain, type Pred } from '../frontend.ts';
import {
  P_OPS, labelIn, predicateSql, nodePropScalar, hasProp, elemCtx, aliasCtx,
  compileFilterPredicate, combineBranchPreds, idPredFromArgs, type Elem, type ScalarCtx,
} from '../plan.ts';
import { advance, carryFrag, elemRel, pathColsOf, prevRel, type AliasMap, type ElementStream, type StepFn } from './context.ts';
import { tryFilterByChildExistence } from './child.ts';

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
const currentCtx = (st: ElementStream) => elemCtx(elemRel(st), st.elem);

/** Re-root a where()/and()/or() sub-traversal that begins with as('x')/select('x')
 *  onto the aliased traverser: its correlation becomes the carried alias column
 *  (`p.a{k}`), read back via aliasCtx. Throws for an unseen label. */
const aliasResolver = (st: ElementStream) => (label: string): ScalarCtx => {
  const entry = st.carried.aliases.get(label);
  if (!entry) throw new Error(`where(__.as("${label}")): no such label — as("${label}") was not seen`);
  return aliasCtx(prevRel(st, 'p').c[entry.col], entry.elem);
};

/** `SELECT n.id<carry> FROM <elem> n JOIN prev p … WHERE <test>` — the filter CTE
 *  shape shared by has/hasLabel/where/and/or. */
function filterCte(st: ElementStream, test: Expression): ElementStream {
  const n = elemRel(st);
  const p = prevRel(st, 'p');
  return advance(st, q`SELECT ${n.c.id}${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${test}`);
}

/** as(): bind each label to the current traverser (rebinds reuse the label's
 *  column, default Pop = last). A pass-through CTE keeps id + all carried alias
 *  columns, (re)setting the bound ones to the current id. */
export const as: StepFn = (s, st) => {
  const labels = s.args.filter((a): a is string => typeof a === 'string');
  const aliases = new Map(st.carried.aliases);
  const rebind: string[] = [];
  for (const lbl of labels) {
    const existing = aliases.get(lbl);
    const col = existing?.col ?? `a${aliases.size}`;
    aliases.set(lbl, { col, elem: st.elem }); // rebind: default Pop = last, re-capture kind
    rebind.push(col);
  }
  // Path-position columns pass through untouched (labels-on-path is deferred, so
  // as() only rebinds alias columns here — the path element set is unchanged).
  const cols = ['id', ...[...aliases.values()].map((a) => rebind.includes(a.col) ? `id AS ${a.col}` : a.col), ...pathColsOf(st.carried.path)];
  return advance(st, q`SELECT ${cols.join(', ')} FROM ${prevRel(st)}`, { aliases });
};

/** simplePath()/cyclicPath(): a whole-path object-identity filter. simplePath keeps
 *  traversers whose path has NO repeated element; cyclicPath keeps those with at
 *  least one repeat (the exact negation). Objects only, all pairs — and only pairs
 *  of the SAME element kind can be equal (a vertex rowid and an edge rowid collide
 *  numerically but are distinct objects), so cross-kind pairs are skipped. The path
 *  positions are known at compile time, so the test is a static conjunction. by()/
 *  from()/to() scoping is deferred (they arrive as their own steps → clear error). */
function pathDistinctTest(st: ElementStream, simple: boolean): Expression {
  const name = simple ? 'simplePath' : 'cyclicPath';
  if (!st.carried.path) throw new Error(`${name}() requires a tracked path`);
  // A standalone filter reads the linear per-position columns; over a recursive
  // repeat() walk, simplePath belongs INSIDE the repeat body (folded into the walk's
  // cycle guard), not as a post-filter.
  if (st.carried.path.kind !== 'cols') throw new Error(`${name}() over a recursive repeat().path() is not yet supported (put simplePath() inside the repeat body)`);
  const p = prevRel(st, 'p');
  const cols = st.carried.path.cols;
  const pairs: Expression[] = [];
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++)
      if (cols[i].elem === cols[j].elem) pairs.push(q`${p.c[cols[i].col]} = ${p.c[cols[j].col]}`);
  if (!pairs.length) return simple ? q`1` : q`0`; // no comparable pair → every path is simple
  const anyEqual = list(pairs, ' OR ');
  return simple ? q`NOT (${anyEqual})` : q`(${anyEqual})`;
}

export const simplePath: StepFn = (_s, st) => filterCte(st, pathDistinctTest(st, true));
export const cyclicPath: StepFn = (_s, st) => filterCte(st, pathDistinctTest(st, false));

export const hasLabel: StepFn = (s, st) => filterCte(st, labelIn('n.label', s.args));

/** hasId(id…|P): filter the current element by its external id (COALESCE(uid,id)).
 *  A lone predicate passes through; bare ids become a `within` set. */
export const hasId: StepFn = (s, st) => {
  const n = elemRel(st);
  return filterCte(st, predicateSql(q`COALESCE(${n.c.uid}, ${n.c.id})`, idPredFromArgs(s.args)));
};

export const has: StepFn = (s, st) => {
  const conds: Expression[] = [];
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
    // Node → ANY-match EXISTS over vertex_properties; edge → json_extract of the flat
    // blob. hasProp dispatches on elem (the current traverser is aliased `n`).
    conds.push(hasProp(currentCtx(st), key, val));
  }
  return filterCte(st, list(conds, ' AND '));
};

/** where()/filter()/not(): keep rows satisfying the nested traversal (or an
 *  alias comparison). not() negates via notCoalesce. */
export const where: StepFn = (s, st) => {
  const arg0 = s.args[0];
  if (arg0 && typeof arg0 === 'object' && 'nested' in arg0) {
    try {
      const pred = compileFilterPredicate(stepChain(arg0.nested, st.params), currentCtx(st), st.params, aliasResolver(st));
      return filterCte(st, s.name === 'not' ? notCoalesce(pred) : pred);
    } catch (error) {
      if (!(error instanceof Error)
          || !error.message.includes('not yet supported')
          || !(error.message.startsWith('where') || error.message.startsWith('filter'))) throw error;
      const generic = tryFilterByChildExistence(st, arg0.nested, s.name === 'not');
      if (generic) return generic;
      throw error;
    }
  }
  // Alias-compare: where("a", P.eq("b")) (label vs label) or where(P.neq("a"))
  // (current traverser vs label), optionally .by(key) (folded onto s.bys) to
  // compare a property instead of element identity.
  if (s.name === 'filter') throw new Error('filter(predicate) not supported; use filter(traversal)');
  const [left, pred, leftElem]: [string, Pred, Elem] = typeof arg0 === 'string'
    ? [aliasIdExpr(arg0, st.carried.aliases), s.args[1] as Pred, st.carried.aliases.get(arg0)!.elem]
    : ['n.id', arg0 as Pred, st.elem];
  if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison not yet supported`);
  const right = aliasIdExpr(pred.values[0], st.carried.aliases);
  const rightElem = st.carried.aliases.get(pred.values[0])!.elem;
  // An alias-compare where() takes at most one by(key). foldByModulators absorbs
  // every contiguous by(); a second one is not a valid modulator here — fail
  // closed rather than silently answer a different question (matches group()'s
  // bys.length>2 guard; the original consumed exactly one by() and let the rest throw).
  if ((s.bys?.length ?? 0) > 1) throw new Error('by() is only supported as an order() or select()/project() modulator');
  const byKey = s.bys?.[0]?.find((x: any) => typeof x === 'string') as string | undefined;
  let testNode: Expression;
  if (byKey !== undefined) {
    // nodePropScalar reads vertex_properties; an edge-typed operand would silently read
    // a vertex's props (ids collide across spaces) → reject.
    if (leftElem === 'edge' || rightElem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
    const op = (s as any).productiveBy && pred.op === 'eq' ? 'IS'
      : (s as any).productiveBy && pred.op === 'neq' ? 'IS NOT'
      : P_OPS[pred.op];
    testNode = q`${nodePropScalar(raw(left), byKey)} ${op} ${nodePropScalar(raw(right), byKey)}`;
  } else {
    testNode = q`${left} ${P_OPS[pred.op]} ${right}`;
  }
  return filterCte(st, s.name === 'not' ? notCoalesce(testNode) : testNode);
};

/** and()/or(): keep the traverser when ALL / ANY branch predicates hold. */
export const andOr: StepFn = (s, st) => {
  const pred = combineBranchPreds(s, currentCtx(st), st.params, s.name === 'and' ? 'AND' : 'OR', aliasResolver(st));
  return filterCte(st, pred);
};

/** dedup(): collapse the multiset on the current object. Label-scoped dedup and
 *  dedup with active as() labels (path-distinct) are deferred rather than
 *  silently over-counting. */
export const dedup: StepFn = (s, st) => {
  if (s.args.length > 0) throw new Error('dedup(label) not yet supported');
  if (st.carried.aliases.size > 0) throw new Error('dedup() after as() not yet supported (path-distinct semantics)');
  if (st.carried.path) throw new Error('dedup() with path tracking not yet supported (path-distinct semantics)');
  return advance(st, q`SELECT DISTINCT id FROM ${prevRel(st)}`);
};
