import { derived, q, list, raw, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { isNested, stepChain, type Pred } from '../../../gremlin/frontend.ts';
import {
  P_OPS, labelIn, predicateSql, nodePropScalar, hasProp, elemCtx, aliasCtx,
  idPredFromArgs, scalarProp, labelNameSub, FtsSubstringFastPath, type Elem, type ScalarCtx,
} from '../../plan/plan.ts';
import { runFastPath } from '../../options/fast-paths.ts';
import { tryInlinePredicate, combineBranchPreds, PredicateInliningFastPath } from './predicate.ts';
import { appendCte, aliasElem, layoutCols, patchLayout, layoutProjection, elemRel, labelCtx, labelScope, pathColsOf, prevRel, scopePathCols, withShape, type AliasEntry, type AliasMap, type ElementStream, type StepFn } from '../context/context.ts';
import { aliasAppend, aliasId, aliasSeed, elemEntry, elemShape } from '../context/alias.ts';
import { tryCombineByChildExistence, tryCompileScalarValueRows, tryFilterByChildExistence } from '../tail/child.ts';
import { operandDeps, resolveTraversalOperands } from '../tail/operand.ts';
import { directElementModulation, elementOrderSql } from '../tail/modulation.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { isInjectionMarker, injectedValues } from '../injection.ts';
import { engineOf, fastPathContextOf } from '../../engine/deps.ts';

// ---------- filter (predicates over the current traverser) ----------

/** `NOT COALESCE((<pred>), 0)` — negate a predicate so a NULL (missing prop)
 *  counts as "no output" → kept, matching not(traversal) semantics. */
const notCoalesce = (expr: Expression): Expression => q`NOT COALESCE((${expr}), 0)`;

/** The SQL expr holding a labelled traverser's id — the last element in its carried
 *  JSONB history column (default Pop = last). */
function aliasIdExpr(label: string, aliases: AliasMap, p: Relation): { id: Expression; elem: Elem } {
  const entry = aliases.get(label);
  if (!entry) throw new Error(`where("${label}"): no such label — as("${label}") was not seen`);
  return { id: aliasId(p.c[entry.col], 'last'), elem: aliasElem(entry) };
}

/** The scalar context a current-element predicate correlates on (aliased `n`). */
const currentCtx = (st: ElementStream) => elemCtx(elemRel(st), st.elem);

/** `SELECT n.id<carry> FROM <elem> n JOIN prev p … WHERE <test>` — the filter CTE
 *  shape shared by has/hasLabel/where/and/or. Note it joins `p`, which is what makes
 *  `labelScope(st)` legitimate at every site below: the carried alias columns really are
 *  in scope for the test expression these splice in. */
function filterCte(st: ElementStream, test: Expression): ElementStream {
  const n = elemRel(st);
  const p = prevRel(st, 'p');
  return appendCte(st, q`SELECT ${n.c.id}${layoutProjection(st.traverserLayout, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} WHERE ${test}`);
}

/** as(): bind each label to the current traverser (rebinds reuse the label's
 *  column, default Pop = last). A pass-through CTE keeps id + all carried alias
 *  columns, (re)setting the bound ones to the current id. */
export const as: StepFn = (s, st) => {
  const labels = s.args.filter((a): a is string => typeof a === 'string');
  const aliases = new Map<string, AliasEntry>(st.traverserLayout.aliases);
  const shape = elemShape(st.elem);
  const p = prevRel(st, 'p');
  const entry = elemEntry(st.elem, p.c.id); // the current object, tagged
  const setExpr = new Map<string, Expression>();
  // On a linear tracked path, this as() attaches to the current element, whose position
  // is the most-recently appended path column (statically known) — record it so
  // path().from(l)/to(l) can resolve a label to a position slice (Piece A, path-history).
  const pathPos = st.traverserLayout.path?.kind === 'cols' ? st.traverserLayout.path.cols.length - 1 : undefined;
  for (const lbl of labels) {
    const existing = aliases.get(lbl);
    const col = existing?.col ?? `a${aliases.size}`;
    // Rebind APPENDS to the label's path history (never overwrites); a fresh label
    // seeds a one-element array. shapes accumulates every binding's kind.
    aliases.set(lbl, { col, shapes: withShape(existing?.shapes, shape), binds: (existing?.binds ?? 0) + 1, pathPos });
    setExpr.set(col, existing ? aliasAppend(p.c[col], entry) : aliasSeed(entry));
  }
  // Rebuild from the ONE carried schema so origins/sack/fromV/encounter/path cannot
  // be dropped when as() rebinds alias columns. Only (re)bound aliases change value.
  const layout = patchLayout(st.traverserLayout, { aliases });
  const proj = ['id', ...layoutCols(layout)].map((c) => {
    if (c === 'id') return q`${p.c.id}`;
    const e = setExpr.get(c);
    return e ? q`${e} AS ${raw(c)}` : q`${p.c[c]}`;
  });
  return appendCte(st, q`SELECT ${list(proj, ', ')} FROM ${p}`, { aliases });
};

/** simplePath()/cyclicPath(): a whole-path object-identity filter. simplePath keeps
 *  traversers whose path has NO repeated element; cyclicPath keeps those with at
 *  least one repeat (the exact negation). Objects only, all pairs — and only pairs
 *  of the SAME element kind can be equal (a vertex rowid and an edge rowid collide
 *  numerically but are distinct objects), so cross-kind pairs are skipped. The path
 *  positions are known at compile time, so the test is a static conjunction. from()/to()
 *  scope the pair loop to the positions between two as() labels; by() scoping is deferred. */
function pathDistinctTest(st: ElementStream, simple: boolean, from?: string, to?: string): Expression {
  const name = simple ? 'simplePath' : 'cyclicPath';
  if (!st.traverserLayout.path) throw new Error(`${name}() requires a tracked path`);
  // A standalone filter reads the linear per-position columns; over a recursive
  // repeat() walk, simplePath belongs INSIDE the repeat body (folded into the walk's
  // cycle guard), not as a post-filter.
  if (st.traverserLayout.path.kind !== 'cols') throw new Error(`${name}() over a recursive repeat().path() is not yet supported (put simplePath() inside the repeat body)`);
  const p = prevRel(st, 'p');
  const cols = scopePathCols(st.traverserLayout.path.cols, from, to, st.traverserLayout.aliases);
  const pairs: Expression[] = [];
  for (let i = 0; i < cols.length; i++)
    for (let j = i + 1; j < cols.length; j++)
      if (cols[i].elem === cols[j].elem) pairs.push(q`${p.c[cols[i].col]} = ${p.c[cols[j].col]}`);
  if (!pairs.length) return simple ? q`1` : q`0`; // no comparable pair → every path is simple
  const anyEqual = list(pairs, ' OR ');
  return simple ? q`NOT (${anyEqual})` : q`(${anyEqual})`;
}

export const simplePath: StepFn = (s, st) => filterCte(st, pathDistinctTest(st, true, s.from, s.to));
export const cyclicPath: StepFn = (s, st) => filterCte(st, pathDistinctTest(st, false, s.from, s.to));

export const hasLabel: StepFn = (s, st) => filterCte(st, labelIn('n.label', s.args));

/** hasId(id…|P): filter the current element by its external id (COALESCE(uid,id)).
 *  A lone predicate passes through; bare ids become a `within` set. */
export const hasId: StepFn = (s, st) => {
  const n = elemRel(st);
  // hasId(__.V(id).id()) / hasId(P.eq(__.V(id).id())): idPredFromArgs wraps a bare arg into a
  // within(), so resolving operands on the RESULT covers both spellings in one place.
  const pred = resolveTraversalOperands(idPredFromArgs(s.args), operandDeps(st), { ctx: currentCtx(st), row: prevRel(st, 'p'), labels: labelScope(st) });
  return filterCte(st, predicateSql(q`COALESCE(${n.c.uid}, ${n.c.id})`, pred));
};

export const has: StepFn = (s, st) => {
  const conds: Expression[] = [];
  let a = s.args;
  // has(label, key, value) — the 3-arg overload folds in a label filter.
  if (a.length === 3 && typeof a[0] === 'string') {
    conds.push(labelIn('n.label', [a[0]]));
    a = a.slice(1);
  }
  let [key, val] = a;
  // has(key, <traversal>) / has(key, P(<traversal>)): the operand resolves to an Expression here,
  // where the Engine is reachable; predicateSql/hasProp then see an ordinary operand. Passing the
  // current element's ScalarCtx also admits the TRAVERSER-DEPENDENT forms
  // (has('name', __.values('other')), has('name', __.out().values('name'))) as correlated
  // subqueries; without it only the re-sourced ones resolve.
  val = resolveTraversalOperands(val, operandDeps(st), { ctx: currentCtx(st), row: prevRel(st, 'p'), labels: labelScope(st) });
  // Mid-traversal federate injection: a `T.value` marker in the VALUE-operand position of
  // has(key, T.value) is replaced by a within() over the distinct injected values supplied in
  // params (federate.ts's sibling hop). The marker is inert as a real value operand, so this is
  // zero-cost for every ordinary query; only a federate hop supplies INJECT_VALUES_KEY. Missing
  // values (marker present but no injection) falls through to the generic path → no match, a clear
  // (empty) result rather than a mis-execution.
  if (isInjectionMarker(val)) {
    const vals = injectedValues(st.params);
    if (vals) val = { op: 'within', values: vals } as Pred;
  }
  if (key && typeof key === 'object' && 'token' in key) {
    // has(T.label|T.id, v|P): predicate over the label name / external id. Routing
    // through predicateSql accepts both a bare value (→ equality) and a P/TextP.
    const n = elemRel(st);
    const expr: Expression = key.token === 'label' ? q`(SELECT name FROM labels WHERE id=${n.c.label})`
      : key.token === 'id' ? q`COALESCE(${n.c.uid}, ${n.c.id})`
      : (() => { throw new Error(`has(T.${key.token}) not supported`); })();
    conds.push(predicateSql(expr, val));
  } else {
    // ANY-match EXISTS over the element's normalized properties table (vertex_properties
    // for a node, edge_properties for an edge). hasProp dispatches on elem (current
    // traverser aliased `n`). A >= 3-char positive substring predicate over this STORED
    // property routes through the property_fts trigram index (FtsSubstringFastPath, default
    // on) — result-equivalent to the generic LIKE hasProp fall-through.
    const ctx = currentCtx(st);
    const fts = runFastPath(FtsSubstringFastPath, fastPathContextOf(st), ctx, key, val);
    conds.push(fts ?? hasProp(ctx, key, val));
  }
  return filterCte(st, list(conds, ' AND '));
};

/** where()/filter()/not(): keep rows satisfying the nested traversal (or an
 *  alias comparison). not() negates via notCoalesce. */
export const where: StepFn = (s, st) => {
  const arg0 = s.args[0];
  if (arg0 && typeof arg0 === 'object' && 'nested' in arg0) {
    const pred = runFastPath(PredicateInliningFastPath, fastPathContextOf(st),
      () => tryInlinePredicate(engineOf(st), stepChain(arg0.nested, st.params), currentCtx(st), st.params, labelScope(st)));
    if (pred)
      return filterCte(st, s.name === 'not' ? notCoalesce(pred) : pred);
    const generic = tryFilterByChildExistence(st, arg0.nested, s.name === 'not');
    if (generic) return generic;
    throw new Error(`${s.name}() traversal not supported by inline predicate or generic child existence lowering`);
  }
  // Alias-compare: where("a", P.eq("b")) (label vs label) or where(P.neq("a"))
  // (current traverser vs label), optionally .by(key) (folded onto s.bys) to
  // compare a property instead of element identity.
  if (s.name === 'filter') throw new Error('filter(predicate) not supported; use filter(traversal)');
  const pw = prevRel(st, 'p');
  const [left, rawPred, leftElem]: [Expression, Pred, Elem] = typeof arg0 === 'string'
    ? [aliasIdExpr(arg0, st.traverserLayout.aliases, pw).id, s.args[1] as Pred, aliasIdExpr(arg0, st.traverserLayout.aliases, pw).elem]
    : [q`n.id`, arg0 as Pred, st.elem];
  // P.not(<inner>) negates the alias comparison — unwrap it and flip the outer negation
  // (composing with a not() step). The inner predicate then resolves normally.
  let negate = s.name === 'not';
  let pred = rawPred;
  if (pred?.op === 'not') { negate = !negate; pred = pred.values[0] as Pred; }
  if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison not yet supported`);
  const rightRes = aliasIdExpr(pred.values[0], st.traverserLayout.aliases, pw);
  const right = rightRes.id;
  const rightElem = rightRes.elem;
  // An alias-compare where() takes at most one by(key). absorbModulators absorbs
  // every contiguous by(); a second one is not a valid modulator here — fail
  // closed rather than silently answer a different question (matches group()'s
  // bys.length>2 guard; the original consumed exactly one by() and let the rest throw).
  if ((s.modulators?.length ?? 0) > 1) throw new Error('by() is only supported as an order() or select()/project() modulator');
  const byKey = s.modulators?.[0]?.find((x: any) => typeof x === 'string') as string | undefined;
  let testNode: Expression;
  if (byKey !== undefined) {
    // nodePropScalar reads vertex_properties; an edge-typed operand would silently read
    // a vertex's props (ids collide across spaces) → reject.
    if (leftElem === 'edge' || rightElem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
    const op = (s as any).productiveBy && pred.op === 'eq' ? 'IS'
      : (s as any).productiveBy && pred.op === 'neq' ? 'IS NOT'
      : P_OPS[pred.op];
    testNode = q`${nodePropScalar(left, byKey)} ${op} ${nodePropScalar(right, byKey)}`;
  } else {
    testNode = q`${left} ${P_OPS[pred.op]} ${right}`;
  }
  return filterCte(st, negate ? notCoalesce(testNode) : testNode);
};

/** and()/or(): keep the traverser when ALL / ANY branch predicates hold. The inline
 *  correlated predicate is a disable-safe fast path (honours predicateInlining);
 *  when it's off or a branch is beyond inline lowering, fall through to the generic
 *  shared-domain child-existence combiner — same result, no support-definer. */
export const andOr: StepFn = (s, st) => {
  const op = s.name === 'and' ? 'AND' : 'OR';
  const branches = s.args.filter(isNested);
  const pred = runFastPath(PredicateInliningFastPath, fastPathContextOf(st),
    () => combineBranchPreds(engineOf(st), s, currentCtx(st), st.params, op, labelScope(st)));
  if (pred) return filterCte(st, pred);
  const generic = tryCombineByChildExistence(st, branches.map((b: any) => b.nested), op);
  if (generic) return generic;
  throw new Error(`${s.name}() not supported by inline predicate or generic child existence lowering`);
};

/** dedup(): collapse the multiset on the current object. Label-scoped dedup and
 *  dedup with active as() labels (path-distinct) are deferred rather than
 *  silently over-counting. */
export const dedup: StepFn = (s, st) => {
  return lowerElementDedup(st, s);
};

/** dedup(labels[, by()]): keep the first traverser per distinct tuple of the labels'
 *  current (Pop.last) values. Each label resolves to a correlated ScalarCtx through the shared
 *  label re-root (labelCtx, the same reading where(__.as("b")…) uses); the optional single by()
 *  projects a property / T.token off each label's element (bare → element identity). Layout
 *  state (path, other aliases) rides through, so `as(a)…as(b)…dedup("a","b").path()` composes. */
function dedupByLabels(st: ElementStream, s: IRStep, labels: string[]): ElementStream {
  const modulators = s.modulators ?? [];
  if (modulators.length > 1) throw new Error('dedup(labels) supports at most one by() modulator');
  const by = modulators[0]?.[0];
  const scope = labelScope(st);
  const keyOf = (label: string): Expression => {
    const ctx = labelCtx(scope, label);
    if (by === undefined) return ctx.idExpr; // dedup by element identity
    if (typeof by === 'string') return scalarProp(ctx, by);
    if (by && typeof by === 'object' && 'token' in by) {
      if (by.token === 'label') return labelNameSub(ctx.labelIdExpr);
      if (by.token === 'id') return ctx.extIdExpr!;
      throw new Error(`dedup(labels).by(T.${by.token}) not yet supported`);
    }
    throw new Error('dedup(labels).by(traversal) not yet supported');
  };
  const p = prevRel(st, 'p');
  const existing = layoutCols(st.traverserLayout);
  // "First per key" = first-in-emission when the chain carries a canonical encounter
  // (Stage C), else lowest id (a deterministic fallback).
  const firstBy = st.traverserLayout.encounter ? p.c[st.traverserLayout.encounter] : p.c.id;
  const r = derived(
    q`SELECT ${p.c.id} AS id${layoutProjection(st.traverserLayout, p)}, ROW_NUMBER() OVER (PARTITION BY ${list(labels.map(keyOf), ', ')} ORDER BY ${firstBy}) AS rn FROM ${p}`,
    ['id', ...existing, 'rn'],
    'r',
  );
  return appendCte(st, q`SELECT ${r.c.id} AS id${layoutProjection(st.traverserLayout, r)} FROM ${r} WHERE ${r.c.rn}=1`);
}

/** Element dedup is a key-cardinality consumer. Ordinary by() drops an
 * unproductive modulation; ProductiveBy retains one NULL-key representative.
 * When preceded by order().barrier(), two windows encode both observations:
 * first row per dedup key and the retained stream's explicit encounter order. */
export function lowerElementDedup(st: ElementStream, s: IRStep, order?: IRStep): ElementStream {
  // dedup(labels): dedup by the tuple of the given as() labels' current values (optional
  // single by() modulator applied to each). Explicit-scope, so unlike bare dedup it is
  // well-defined under as()/path tracking — the kept traverser rides its carried state.
  const labelArgs = s.args.filter((a): a is string => typeof a === 'string');
  if (labelArgs.length) return dedupByLabels(st, s, labelArgs);
  if (s.args.length > 0) throw new Error('dedup(Scope.local, …) over an element stream not yet supported');
  if (st.traverserLayout.aliases.size > 0) throw new Error('dedup() after as() not yet supported (path-distinct semantics)');
  if (st.traverserLayout.path) throw new Error('dedup() with path tracking not yet supported (path-distinct semantics)');
  const modulators = s.modulators ?? [];
  if (modulators.length > 1) throw new Error('dedup() supports at most one by() modulator');
  if (!order && !modulators.length) {
    const p = prevRel(st, 'p');
    // dedup yields ONE traverser per distinct id → RESET bulk to 1: a collapsed (v, N) becomes
    // (v, 1). Every other carried column rides through unchanged. At bulk≡1 this is identical to
    // carrying p.bulk, so a non-collapsed dedup is unaffected.
    const cols = layoutCols(st.traverserLayout).map((c) => c === st.traverserLayout.bulk ? q`1 AS bulk` : q`${p.c[c]}`);
    const cf = cols.length ? q`, ${list(cols, ', ')}` : q``;
    return appendCte(st, q`SELECT DISTINCT ${p.c.id} AS id${cf} FROM ${p}`);
  }

  const p = prevRel(st, 'p');
  const n = elemRel(st);
  // A new ordered barrier supersedes, rather than physically duplicating, any
  // encounter role inherited from an earlier ordered boundary.
  const layout = order ? patchLayout(st.traverserLayout, { encounter: null }) : st.traverserLayout;
  const key = directElementModulation(st, n, modulators[0]);
  if (!key) {
    const nested = modulators[0]?.[0]?.nested;
    const rows = nested ? tryCompileScalarValueRows(st, nested) : null;
    if (!rows?.stream.traverserLayout.encounter) throw new Error('dedup().by(traversal) requires a scalar child with encounter order');
    const childEnc = rows.stream.traverserLayout.encounter;
    const c = rows.stream.rel.as('c');
    const childRank = st.q.cte(
      q`SELECT ${c.c.v} AS k, ${c.c[rows.frame.ordinal]} AS ${rows.frame.ordinal}, ROW_NUMBER() OVER (PARTITION BY ${c.c[rows.frame.ordinal]} ORDER BY ${c.c[childEnc]}) AS child_rn FROM ${c}`,
      ['k', rows.frame.ordinal, 'child_rn'],
    );
    const d = rows.frame.domain.as('d');
    const f = childRank.as('f');
    const en = elemRel(st);
    const source = s.productiveBy
      ? q`${d} LEFT JOIN ${f} ON ${f.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]} AND ${f.c.child_rn}=1 JOIN ${en} ON ${en.c.id}=${d.c.id}`
      : q`${d} JOIN ${f} ON ${f.c[rows.frame.ordinal]}=${d.c[rows.frame.ordinal]} AND ${f.c.child_rn}=1 JOIN ${en} ON ${en.c.id}=${d.c.id}`;
    const orderSql = elementOrderSql(st, en, order);
    const existing = layoutCols(layout);
    const encounter = order ? 'encounter' : undefined;
    const encounterExpr = order ? q`, ROW_NUMBER() OVER (ORDER BY ${orderSql}, ${d.c.id}) AS encounter` : q``;
    const r = derived(
      q`SELECT ${d.c.id} AS id${layoutProjection(layout, d)}, ROW_NUMBER() OVER (PARTITION BY ${f.c.k} ORDER BY ${orderSql}, ${d.c.id}) AS rn${encounterExpr} FROM ${source}`,
      ['id', ...existing, 'rn', ...(encounter ? [encounter] : [])],
      'r',
    );
    const body = q`SELECT ${r.c.id} AS id${layoutProjection(layout, r)}${encounter ? q`, ${r.c[encounter]} AS ${encounter}` : q``} FROM ${r} WHERE ${r.c.rn}=1`;
    return appendCte(st, body, encounter ? { encounter } : {});
  }
  const orderSql = elementOrderSql(st, n, order);
  const where = modulators.length && !s.productiveBy ? q` WHERE ${predicateSql(key, undefined)}` : q``;
  const existing = layoutCols(layout);
  const encounter = order ? 'encounter' : undefined;
  const encounterExpr = order ? q`, ROW_NUMBER() OVER (ORDER BY ${orderSql}, ${p.c.id}) AS encounter` : q``;
  const r = derived(
    q`SELECT ${p.c.id} AS id${layoutProjection(layout, p)}, ROW_NUMBER() OVER (PARTITION BY ${key} ORDER BY ${orderSql}, ${p.c.id}) AS rn${encounterExpr} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}${where}`,
    ['id', ...existing, 'rn', ...(encounter ? [encounter] : [])],
    'r',
  );
  const body = q`SELECT ${r.c.id} AS id${layoutProjection(layout, r)}${encounter ? q`, ${r.c[encounter]} AS ${encounter}` : q``} FROM ${r} WHERE ${r.c.rn}=1`;
  return appendCte(st, body, encounter ? { encounter } : {});
}
