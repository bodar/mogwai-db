import { q, value, list, empty, Relation, type Expression } from '../q.ts';
import { nodes, edges, labels } from '../schema.ts';
import {
  propExtract, predicateSql, compileNestedScalar, labelNameSub, rangeToOffsetLimit, elemCtx, scalarTx,
  type ScalarCtx,
} from '../plan.ts';
import { stepChain, type Step } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { elemRel, type AliasMap, type St } from './context.ts';
import {
  readCompiled, type Compiled, type Shape, type MapEntry, type ElemShape, type GroupKey, type GroupVal,
} from '../render.ts';

/** Movement heads whose nested-by() aggregate is a correlated neighbourhood
 *  reduction (handled by edgeAggFrom), and the scalar reducers that terminate one. */
const MOVES_ROOT = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const SCALAR_REDUCERS = new Set(['sum', 'min', 'max', 'mean']);

// ---------- tail: projection + barriers + modifiers ----------
//
// After the prefix fold lands the id-relation, the tail applies an optional
// projection (values/id/label/…/select/project) plus order()/range()/limit() and
// terminal reducers. group()/groupCount()/properties() are barriers that consume
// the whole stream into one shape, so they short-circuit before the generic tail.

interface OrderClause { key: string | null; dir: 'asc' | 'desc' | 'shuffle'; }

/** The tail modifiers accumulated left-to-right (a pure fold — no sibling peeking;
 *  by() modulators already live on their host step via strategies.foldByModulators). */
interface TailAcc {
  projStep: PStep | null;
  orders: OrderClause[];
  offset: number;
  limit: number | null;
  distinct: boolean;
  reducer: 'fold' | 'sum' | 'min' | 'max' | 'mean' | null; // terminal stream reducer applied after the projection
  isPreds: any[];                  // is(P) filters on the projected scalar (AND'd)
  transforms: PStep[];             // scalar string/cast transforms wrapping the projected scalar, in order
  injects: any[];                  // constants appended to the value stream (values(k).inject(c))
}

const PROJECTION_NAMES = new Set(['values', 'id', 'label', 'count', 'valueMap', 'elementMap', 'select', 'project']);
const SCALAR_TX_NAMES = new Set(['concat', 'length', 'toUpper', 'toLower', 'asString', 'substring', 'replace']);
const isMapProj = (p: PStep | null) => p?.name === 'select' || p?.name === 'project';

/** A tail modifier: fold the step into the accumulator. `at` gives position so a
 *  terminal reducer (fold/sum) can reject anything following it. */
type ModFn = (s: PStep, acc: TailAcc, at: { last: boolean; next?: string }) => void;

const MODIFIERS = new Map<string, ModFn>([
  ['order', (s, acc) => {
    // Each folded by() → one order clause; a bare order() sorts by identity.
    const bys = s.bys ?? [];
    if (bys.length === 0) { acc.orders.push({ key: null, dir: 'asc' }); return; }
    for (const byArgs of bys) {
      // Reject deferred modulators rather than let a {token}/{nested} arg fall
      // through to key=null and silently sort by id.
      const bad = byArgs.find((a: any) => a && typeof a === 'object' && ('token' in a || 'nested' in a));
      if (bad) throw new Error('token' in bad ? `by(T.${bad.token}) modulator not yet supported` : 'by(traversal) modulator not yet supported');
      const key = byArgs.find((a: any) => typeof a === 'string') ?? null;
      const ord = byArgs.find((a: any) => a && typeof a === 'object' && 'order' in a);
      acc.orders.push({ key, dir: (ord?.order ?? 'asc') as OrderClause['dir'] });
    }
  }],
  ['range', (s, acc) => { ({ offset: acc.offset, limit: acc.limit } = rangeToOffsetLimit(s.args)); }],
  ['skip', (s, acc) => { acc.offset = Number(s.args[0]); }],
  ['limit', (s, acc) => { acc.limit = Number(s.args[0]); }],
  ['dedup', (_s, acc) => { acc.distinct = true; }],
  ['is', (s, acc) => {
    // is() folds into the projection WHERE (before ORDER BY/LIMIT). Only correct
    // if no limit/range/skip preceded it — filtering commutes with order() but NOT
    // with a limit that already truncated the stream.
    if (acc.limit !== null || acc.offset > 0) throw new Error('is() after limit()/range()/skip() not yet supported');
    acc.isPreds.push(s.args[0]);
  }],
  ['fold', reducerMod('fold')],
  ['sum', reducerMod('sum')],
  ['min', reducerMod('min')],
  ['max', reducerMod('max')],
  ['mean', reducerMod('mean')],
  ['by', () => { throw new Error('by() is only supported as an order() or select()/project() modulator'); }],
]);

function reducerMod(name: NonNullable<TailAcc['reducer']>): ModFn {
  return (_s, acc, at) => {
    // Scope.local (a per-list reduction) always arrives after fold()/aggregate()
    // in the suite, so the reducer-after-reducer / step-after-reducer guards below
    // already defer it — no separate Scope handling needed here.
    if (acc.reducer) throw new Error(`${name}() after ${acc.reducer}() not yet supported`);
    if (!at.last) throw new Error(`step not implemented after ${name}(): ${at.next}()`);
    acc.reducer = name;
  };
}

/** Compile the tail: `st` is the finished prefix state, `steps[stop]` the first
 *  step the prefix dispatch didn't consume. */
export function compileTail(st: St, steps: PStep[], stop: number): Compiled {
  const indexKeys = new Set(st.indexKeys);

  // properties() turns the traverser into a property (owner+key+value) — a shape
  // the id-relation can't carry, so it and its follow-ons compile in their own fn.
  if (steps[stop]?.name === 'properties')
    return compileProperties(st, steps.slice(stop), indexKeys);

  // group()/groupCount() is a barrier over the current element stream → one Map.
  if (steps[stop]?.name === 'group' || steps[stop]?.name === 'groupCount') {
    if (stop + 1 < steps.length) throw new Error(`step not implemented after ${steps[stop].name}(): ${steps[stop + 1].name}()`);
    const tbl = st.elem === 'edge' ? 'edges' : 'nodes';
    const ctx = elemCtx(elemRel(st), st.elem);
    const src: GroupSource = { from: `${tbl} n JOIN ${st.last.name} p ON n.id=p.id`, ctx, elem: st.elem === 'edge' ? 'edge' : 'vertex' };
    return compileGroup(st, steps[stop].name === 'groupCount', steps[stop].bys ?? [], src, indexKeys);
  }

  // Tail fold: accumulate the projection + modifiers.
  const acc: TailAcc = { projStep: null, orders: [], offset: 0, limit: null, distinct: false, reducer: null, isPreds: [], transforms: [], injects: [] };
  for (let i = stop; i < steps.length; i++) {
    const s = steps[i];
    if (PROJECTION_NAMES.has(s.name)) {
      if (acc.projStep) throw new Error('only one projection step is supported per traversal');
      acc.projStep = s;
      continue;
    }
    // inject(c…) after a value projection appends constants to the value stream.
    if (s.name === 'inject') { acc.injects.push(...s.args); continue; }
    // A scalar string/cast transform (concat/length/…) wraps the projected scalar.
    if (SCALAR_TX_NAMES.has(s.name)) { acc.transforms.push(s); continue; }
    const mod = MODIFIERS.get(s.name);
    if (!mod) throw new Error(`step not implemented: ${s.name}()`);
    mod(s, acc, { last: i === steps.length - 1, next: steps[i + 1]?.name });
  }

  if (isMapProj(acc.projStep))
    return compileSelectProject(st, acc.projStep!, acc, indexKeys);

  return buildProjection(st, acc, indexKeys);
}

interface TailMods { orders: OrderClause[]; distinct: boolean; offset: number; limit: number | null; }

// ---------- projection resolution (values/id/label/valueMap/elementMap/element) ----------

interface ProjCtx {
  st: St; n: Relation; l: Relation; extId: Expression;
  vJoin: Expression; vlJoin: Expression;
  projStep: PStep | null; indexKeys: Set<string>; hasIs: boolean;
}
interface ProjResult { shape: Shape; colsNode: Expression; fromNode: Expression; scalarExpr?: Expression | null; baseWhere?: Expression | null; }
type ProjFn = (c: ProjCtx) => ProjResult;

const PROJECTORS = new Map<string, ProjFn>([
  ['values', (c) => {
    const pe = propExtract('n.props', c.projStep!.args[0]);
    // values(k).is(P) is a filter-position use → auto-index the key (like has());
    // a bare values() projection is deliberately NOT indexed (bounds proliferation).
    if (c.hasIs && pe.indexKey && c.st.elem === 'node') c.indexKeys.add(pe.indexKey);
    return {
      shape: { kind: 'value' }, colsNode: q`${pe.expr} AS v`, fromNode: c.vJoin,
      scalarExpr: pe.expr, baseWhere: predicateSql(pe.expr, undefined), // <pe> IS NOT NULL (shared node → binds fall out per occurrence)
    };
  }],
  ['id', (c) => ({
    // Join the element table even though the id lives in `last`, so a preceding
    // order().by(key) — which references n.props — has the alias in scope.
    shape: { kind: 'value' }, colsNode: q`${c.extId} AS v`, fromNode: c.vJoin, scalarExpr: c.extId,
  })],
  ['label', (c) => ({
    shape: { kind: 'value' }, colsNode: q`${c.l.c.name} AS v`, fromNode: c.vlJoin, scalarExpr: c.l.c.name,
  })],
  ['valueMap', (c) => {
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'valueMap', keys: keys.length ? keys : null, tokens: c.projStep!.args.includes(true) },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin,
    };
  }],
  ['elementMap', (c) => {
    if (c.st.elem === 'edge') throw new Error('elementMap() on edges not yet supported'); // needs IN/OUT direction tokens
    const keys = c.projStep!.args.filter((a) => typeof a === 'string') as string[];
    return {
      shape: { kind: 'elementMap', keys: keys.length ? keys : null },
      colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin,
    };
  }],
  ['__element', (c) => c.st.elem === 'edge'
    ? { shape: { kind: 'edge' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.src}, ${c.n.c.tgt}, ${c.n.c.props}`, fromNode: c.vlJoin }
    : { shape: { kind: 'vertex' }, colsNode: q`${c.extId} AS id, ${c.l.c.name} AS label, ${c.n.c.props}`, fromNode: c.vlJoin }],
]);

function buildProjection(st: St, acc: TailAcc, indexKeys: Set<string>): Compiled {
  const { orders, distinct, offset, limit, isPreds, reducer } = acc;
  const projName = acc.projStep?.name ?? '__element';

  if (reducer && projName === 'count') throw new Error(`${reducer}() after count() not yet supported`);

  // count folds any tail limit/offset/distinct into the counted id-relation.
  if (projName === 'count') {
    const inner = q`SELECT ${distinct ? 'DISTINCT ' : ''}id FROM ${st.last}`;
    const innerLim = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;
    let countNode: Expression = q`SELECT COUNT(*) AS v FROM (${inner}${innerLim})`;
    // count().is(P): filter the single count value (0 or 1 result rows).
    if (isPreds.length)
      countNode = q`SELECT v FROM (${countNode}) WHERE ${list(isPreds.map((pr) => predicateSql(q`v`, pr)), ' AND ')}`;
    return readCompiled(st.q, countNode, { kind: 'count' }, [...indexKeys]);
  }

  const n = elemRel(st);
  const p = st.last.as('p');
  const l = labels.as('l');
  const vJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}`;
  const vlJoin = q`${vJoin} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  const extId = q`COALESCE(${n.c.uid}, ${n.c.id})`;
  const proj = PROJECTORS.get(projName)!({ st, n, l, extId, vJoin, vlJoin, projStep: acc.projStep, indexKeys, hasIs: isPreds.length > 0 });
  let { shape } = proj;

  // Scalar string/cast transforms (values('name').concat('X').toUpper()) wrap the
  // projected scalar; is()/order() then see the transformed value. Only a scalar
  // stream (values/id/label) has a scalarExpr to transform.
  if (acc.transforms.length) {
    if (!proj.scalarExpr) throw new Error(`${acc.transforms[0].name}() requires a scalar stream (values/id/label)`);
    const txExpr = acc.transforms.reduce<Expression>(
      (e, s) => scalarTx(s.name, s.args, e) ?? (() => { throw new Error(`scalar transform ${s.name}() not supported`); })(), proj.scalarExpr);
    proj.colsNode = q`${txExpr} AS v`;
    proj.scalarExpr = txExpr;
  }

  // WHERE: the values() existence check + any is(P) on the projected scalar, AND'd.
  const whereParts: Expression[] = [];
  if (proj.baseWhere) whereParts.push(proj.baseWhere);
  if (isPreds.length) {
    if (!proj.scalarExpr) throw new Error('is() requires a scalar stream (values/label/id/count)');
    for (const pr of isPreds) whereParts.push(predicateSql(proj.scalarExpr, pr));
  }
  const whereNode: Expression = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;

  let orderNode: Expression = empty;
  if (orders.length) {
    const keyNodes = orders.map((o) => {
      if (o.dir === 'shuffle') return q`RANDOM()`;
      const dir = o.dir === 'desc' ? ' DESC' : ' ASC';
      if (o.key !== null) {
        const pe = propExtract('n.props', o.key);
        if (pe.indexKey && st.elem === 'node') indexKeys.add(pe.indexKey); // order().by(key) sorts via the index
        return q`${pe.expr}${dir}`;
      }
      return q`${shape.kind === 'value' ? 'v' : 'n.id'}${dir}`;
    });
    orderNode = q` ORDER BY ${list(keyNodes, ', ')}`;
  }
  const limitNode: Expression = (limit !== null || offset > 0) ? q` LIMIT ${limit ?? -1} OFFSET ${offset}` : empty;

  let tailNode: Expression = q`SELECT ${distinct ? 'DISTINCT ' : ''}${proj.colsNode} FROM ${proj.fromNode}${whereNode}${orderNode}${limitNode}`;

  // values(k).inject(c…): append the constants as extra value rows before any
  // reducer. Only meaningful on a scalar stream (the injected value shares `v`).
  if (acc.injects.length) {
    if (shape.kind !== 'value') throw new Error('inject() after a non-scalar projection not yet supported');
    tailNode = q`SELECT v FROM (${tailNode}) UNION ALL ${list(acc.injects.map((c) => q`SELECT ${value(c)} AS v`), ' UNION ALL ')}`;
  }

  // Terminal reducers wrap the projected select.
  if (reducer) ({ tailNode, shape } = wrapReducer(tailNode, reducer, shape));

  return readCompiled(st.q, tailNode, shape, [...indexKeys]);
}

/** Wrap a `v`-projecting select in a terminal reducer (fold/sum/min/max/mean),
 *  returning the new node + result shape. Shared by the element tail here and the
 *  inject value stream (write.ts) so both reduce identically. fold() keeps the
 *  stream as a List (element or scalar); sum/min/max/mean collapse to one scalar
 *  (min/max/mean over numeric values only → empty stream on non-numeric input). */
export function wrapReducer(
  tailNode: Expression, reducer: NonNullable<TailAcc['reducer']>, shape: Shape,
): { tailNode: Expression; shape: Shape } {
  if (reducer === 'fold') {
    const fe: ElemShape | 'scalar' =
      shape.kind === 'vertex' ? 'vertex' : shape.kind === 'edge' ? 'edge' :
      shape.kind === 'value' ? 'scalar' : (() => { throw new Error(`fold() of ${shape.kind} not yet supported`); })();
    return { tailNode, shape: { kind: 'list', elem: fe } };
  }
  if (shape.kind !== 'value') throw new Error(`${reducer}() of ${shape.kind} not yet supported`);
  if (reducer === 'sum')
    // typeof(SUM) is 'integer' or 'real' → handler frames Int/Long vs Double.
    return { tailNode: q`SELECT SUM(v) AS v, typeof(SUM(v)) AS vt FROM (${tailNode})`, shape: { kind: 'scalar' } };
  // min/max/mean reduce over NUMERIC values only: a non-numeric or absent stream
  // yields nothing (SQL aggregate over the empty filtered set → NULL → the handler
  // drops it). Matches TinkerPop, where min() of strings produces no result. mean()
  // is always a Double; min/max keep the element's storage class via typeof().
  const nums = q`SELECT v FROM (${tailNode}) WHERE typeof(v) in ('integer', 'real')`;
  const node = reducer === 'mean'
    ? q`SELECT AVG(v) AS v, 'real' AS vt FROM (${nums})`
    : q`SELECT ${reducer === 'min' ? 'MIN' : 'MAX'}(v) AS v, typeof(${reducer === 'min' ? 'MIN' : 'MAX'}(v)) AS vt FROM (${nums})`;
  return { tailNode: node, shape: { kind: 'scalar' } };
}

// ---------- select()/project() ----------

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  if (!byArgs || byArgs.length === 0) return { sub: 'vertex' }; // no by() / bare by() → the element itself
  const a = byArgs[0];
  if (typeof a === 'string') return { sub: 'value', key: a };
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported by() modulator');
}

/**
 * select(labels…)/project(keys…). select reads previously-labelled traversers
 * from their alias columns; project applies its by() modulators to the current
 * traverser under freshly-named keys. by() modulators cycle across the keys. A
 * single-key select reuses the scalar vertex/value shape; anything else is a Map.
 */
function compileSelectProject(st: St, proj: PStep, tail: TailMods, indexKeys: Set<string>): Compiled {
  const bys = proj.bys ?? [];
  const { orders, distinct, offset, limit } = tail;
  if (orders.length) throw new Error('order() after select()/project() not yet supported');
  const isProject = proj.name === 'project';
  const aliases: AliasMap = st.aliases;
  const curElem = st.elem;

  // Reject the deferred long-tail forms explicitly (tokens are captured, not
  // silently dropped) so a Pop/Column arg can never mis-execute as a plain key.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);

  const sourceOf = (k: string): string => {
    if (isProject) {
      if (curElem === 'edge') throw new Error('project() of an edge is not yet supported');
      return 'p.id';
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    if (entry.elem === 'edge') throw new Error(`select("${k}") of an edge-typed label is not yet supported`);
    return `p.${entry.col}`;
  };
  const entryKind = (i: number) => byToEntry(bys.length ? bys[i % bys.length] : undefined);

  const tailSql = (limit !== null || offset > 0) ? ` LIMIT ${limit ?? -1} OFFSET ${offset}` : '';
  const dist = distinct ? 'DISTINCT ' : '';
  const p = st.last.as('p');

  // Single-key select → the labelled element directly (not wrapped in a Map).
  if (!isProject && keys.length === 1) {
    const src = sourceOf(keys[0]);
    const e = entryKind(0);
    const n = nodes.as('n');
    if (e.sub === 'vertex') {
      const l = labels.as('l');
      return readCompiled(st.q, q`SELECT ${dist}COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${n.c.props} FROM ${n} JOIN ${p} ON ${n.c.id}=${src} JOIN ${l} ON ${l.c.id}=${n.c.label}${tailSql}`, { kind: 'vertex' }, [...indexKeys]);
    }
    const pe = propExtract('n.props', e.key); // projection, not indexed (matches values())
    return readCompiled(st.q, q`SELECT ${dist}${pe.expr} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${src}${tailSql}`, { kind: 'value' }, [...indexKeys]);
  }

  // Multi-key select / any project → a Map per row.
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const entries: MapEntry[] = keys.map((k, i) => {
    const prefix = `e${i}`;
    const e = entryKind(i);
    const src = sourceOf(k);
    const en = nodes.as(`${prefix}n`);
    joins.push(q` JOIN ${en} ON ${en.c.id}=${src}`);
    if (e.sub === 'vertex') {
      const el = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${el} ON ${el.c.id}=${en.c.label}`);
      cols.push(q`COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${en.c.props} AS ${`${prefix}_props`}`);
    } else {
      cols.push(q`${propExtract(`${prefix}n.props`, e.key).expr} AS ${`${prefix}_v`}`); // projection, not indexed
    }
    return { key: k, prefix, sub: e.sub };
  });

  const node = q`SELECT ${dist}${list(cols, ', ')} FROM ${p}${list(joins, '')}${tailSql}`;
  return readCompiled(st.q, node, { kind: 'map', entries }, [...indexKeys]);
}

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind. */
interface GroupSource { from: string; ctx: ScalarCtx; elem: ElemShape; }

/** Columns that frame one element (vertex/edge/property) under `prefix`. label
 *  rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx): Expression {
  const extId = ctx.extIdExpr ?? ctx.idExpr;
  if (elem === 'edge')
    return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${ctx.srcExpr!} AS ${`${prefix}_src`}, ${ctx.tgtExpr!} AS ${`${prefix}_tgt`}, ${ctx.propsExpr} AS ${`${prefix}_props`}`;
  if (elem === 'property')
    return q`${ctx.ownerExpr!} AS ${`${prefix}_owner`}, ${ctx.pkExpr!} AS ${`${prefix}_pk`}, ${ctx.pvExpr!} AS ${`${prefix}_pv`}`;
  return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${ctx.propsExpr} AS ${`${prefix}_props`}`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx): Expression => elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string | Expression }

/** Build the key columns for group(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, indexKeys: Set<string>, params: Record<string, any>): GroupKeyBuild {
  if (!keyArgs || keyArgs.length === 0) { // bare by() → the element itself is the key
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx), group: elementIdExpr(src.elem, src.ctx) };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name')
    const pe = propExtract(src.ctx.propsExpr, a);
    if (pe.indexKey && src.elem === 'vertex') indexKeys.add(pe.indexKey);
    return { desc: { kind: 'scalar' }, cols: q`${pe.expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'token' in a) { // by(T.label)/by(T.id)
    const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: { kind: 'scalar' }, cols: q`${expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project') { // composite Map key
      const keys = inner[0].args.filter((x: any): x is string => typeof x === 'string');
      const partBys = inner.slice(1);
      if (partBys.some((s) => s.name !== 'by')) throw new Error(`step not implemented in group().by(project): ${partBys.find((s) => s.name !== 'by')!.name}()`);
      if (partBys.length !== keys.length) throw new Error('group().by(project) needs one by() per key');
      const cols: Expression[] = [], group: string[] = [];
      keys.forEach((k, idx) => {
        const nb = partBys[idx].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
        if (!nb) throw new Error('group().by(project(...).by(x)) requires a traversal in each by()');
        const sc = compileNestedScalar(stepChain(nb.nested, params), src.ctx);
        cols.push(q`${sc.expr} AS ${`k${idx}_v`}`); group.push(`k${idx}_v`);
      });
      return { desc: { kind: 'map', parts: keys.map((k) => ({ key: k })) }, cols: list(cols, ', '), group: group.join(', ') };
    }
    const sc = compileNestedScalar(inner, src.ctx); // by(__.label()) etc → scalar
    return { desc: { kind: 'scalar' }, cols: q`${sc.expr} AS gk`, group: 'gk' };
  }
  throw new Error('unsupported group().by() key modulator');
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value can't be aggregated in SQL (props must be
 * framed), so we emit rows ORDER BY the key and the handler folds runs into the Map.
 */
function compileGroup(st: St, isCount: boolean, bys: any[][], src: GroupSource, indexKeys: Set<string>): Compiled {
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const key = buildGroupKey(bys[0], src, indexKeys, st.params);

  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
  else {
    const a = valArgs[0];
    if (typeof a === 'string') { // by('age') → list of scalars
      const pe = propExtract(src.ctx.propsExpr, a);
      val = { kind: 'scalarList' }; valNode = q`json_group_array(${pe.expr}) AS gv`;
    } else if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, st.params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'tail') { val = { kind: 'elementLast', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'fold') { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
      else if (names.length === 1 && names[0] === 'count') { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
      else if (MOVES_ROOT.has(names[0]) && SCALAR_REDUCERS.has(names[names.length - 1])) {
        // A neighbourhood aggregate — e.g. by(__.bothE().values('weight').mean()).
        // compileNestedScalar reduces the WHOLE chain to one correlated scalar per
        // group key; MAX() just satisfies GROUP BY (each such group is one vertex,
        // so the scalar is constant within it). typeof() carries Int/Long/Double.
        const sc = compileNestedScalar(inner, src.ctx);
        val = { kind: 'sum' }; valNode = q`MAX(${sc.expr}) AS gv, typeof(MAX(${sc.expr})) AS gvt`;
      } else if (names[names.length - 1] === 'sum') {
        const sc = compileNestedScalar(inner.slice(0, -1), src.ctx);
        val = { kind: 'sum' }; valNode = q`SUM(${sc.expr}) AS gv, typeof(SUM(${sc.expr})) AS gvt`; // gvt → Int/Long vs Double
      } else { // scalar projection folded to a list
        const sc = compileNestedScalar(inner, src.ctx);
        val = { kind: 'scalarList' }; valNode = q`json_group_array(${sc.expr}) AS gv`;
      }
    } else throw new Error('unsupported group().by() value modulator');
  }

  const node = q`SELECT ${key.cols}, ${valNode} FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${key.group}`;
  return readCompiled(st.q, node, { kind: 'group', key: key.desc, val }, [...indexKeys]);
}

// ---------- properties() ----------

/**
 * properties()/properties(keys) on the current element, plus an optional single
 * follow-on: key()/value()/count(), or element()[.values/.id/.label/.count]. The
 * traverser is a property — a json_each expansion over the owner's props.
 */
function compileProperties(st: St, tail: PStep[], indexKeys: Set<string>): Compiled {
  const elem = st.elem;
  const keys = tail[0].args.filter((a): a is string => typeof a === 'string');
  const keyFilter: Expression = keys.length ? q` WHERE je.key IN (${list(keys.map(value), ',')})` : empty;
  const n = elemRel(st);
  const p = st.last.as('p');
  const l = labels.as('l');
  const propBody = q`SELECT ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${n.c.props} AS ownerProps, je.key AS pk, je.value AS pv FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}, json_each(${n.c.props}) je${keyFilter}`;
  const pc = st.q.cte(propBody, ['owner', 'ownerLabel', 'ownerProps', 'pk', 'pv']);

  const done = (node: Expression, shape: Shape, consumed: number): Compiled => {
    if (tail.length > consumed) throw new Error(`step not implemented after properties(): ${tail[consumed].name}()`);
    return readCompiled(st.q, node, shape, [...indexKeys]);
  };

  const next = tail[1]?.name;

  // properties().group()/.groupCount() — group over the property stream.
  if (next === 'group' || next === 'groupCount') {
    if (2 < tail.length) throw new Error(`step not implemented after properties().${next}(): ${tail[2].name}()`);
    const ctx: ScalarCtx = { elem: 'property', idExpr: pc.c.owner, propsExpr: pc.c.ownerProps, labelIdExpr: q`(SELECT label FROM nodes WHERE id=${pc.c.owner})`, ownerExpr: pc.c.owner, ownerPropsExpr: pc.c.ownerProps, pkExpr: pc.c.pk, pvExpr: pc.c.pv };
    const src: GroupSource = { from: pc.name, ctx, elem: 'property' };
    return compileGroup(st, next === 'groupCount', tail[1].bys ?? [], src, indexKeys);
  }

  switch (next) {
    case undefined: // properties() terminal → VertexProperty elements
      return done(q`SELECT owner, pk, pv FROM ${pc}`, { kind: 'property' }, 1);
    case 'key':
      return done(q`SELECT pk AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'value':
      return done(q`SELECT pv AS v FROM ${pc}`, { kind: 'value' }, 2);
    case 'count':
      return done(q`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 2);
    case 'element': {
      const after = tail[2]?.name;
      if (elem === 'edge' && after === undefined) throw new Error('element() of an edge property not yet supported');
      switch (after) {
        case undefined:
          return done(q`SELECT owner AS id, ownerLabel AS label, ownerProps AS props FROM ${pc}`, { kind: 'vertex' }, 2);
        case 'id':
          return done(q`SELECT owner AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'label':
          return done(q`SELECT ownerLabel AS v FROM ${pc}`, { kind: 'value' }, 3);
        case 'values': {
          const pe = propExtract('ownerProps', tail[2].args[0]);
          return done(q`SELECT ${pe.expr} AS v FROM ${pc} WHERE ${predicateSql(pe.expr, undefined)}`, { kind: 'value' }, 3);
        }
        case 'count':
          return done(q`SELECT COUNT(*) AS v FROM ${pc}`, { kind: 'count' }, 3);
        default:
          throw new Error(`step not implemented after element(): ${after}()`);
      }
    }
    default:
      throw new Error(`step not implemented after properties(): ${next}()`);
  }
}
