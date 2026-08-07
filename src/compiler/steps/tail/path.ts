import { isNested, argValues } from '../../../gremlin/frontend.ts';
import { empty, list, q, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { type PathPos } from '../../../sql/kernel/render.ts';
import { nodes } from '../../../sql/schema.ts';
import { EDGE_MOVES, ENDPOINT_MOVES, OTHER_V, PATH_LIST_OPS, REDUCERS, VERTEX_MOVES, unionOf } from '../../ir/step.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { aliasCtx, elemCtx, elemTable, elementPayload, predicateSql, scalarProp, type ScalarCtx, tokenExpr } from '../../plan/plan.ts';
import { dropLayoutAtBarrier, layoutCols, layoutProjection, scopePathCols, withoutPath, type ElementStream, type TraverserLayout } from '../context/context.ts';
import { continueLowering, dispatchShapeTail, loweringStateOf, pathColumns, toListStream, toPathStream, type ListStream, type LoweringResult, type PathStream, type ScalarStream, type ShapeTailFn } from '../context/stream.ts';
import { tryLowerScalarChoose, tryLowerScalarCoalesce } from '../prefix/branch.ts';
import { lowerGlobalCount, aliasCompareRows } from './barrier.ts';
import { byAt, childCtx, childSteps, classifyBy, classifyScalarChild, reuseCurrentFrame, typeOfAssert, type ChildFrame, type ChildScope } from './child-shape.ts';
import { pushChildScope, tryCompileScalarValueChild } from './child.ts';
import { compileFromList } from './list.ts';
import { type TailAcc } from './projection.ts';
import { reRootElement } from './select.ts';

// ---------- path() (linear regime) ----------

/**
 * The scalar value for ONE path position under a `by(key)`/`by(T.token)` modulator, or
 * undefined for a bare/absent `by()` (→ the whole element). A `by(__.trav)` position is not
 * handled here; each regime lowers it through the child seam.
 *
 * ONE projector for BOTH path regimes, which is the point: the LINEAR regime passes an
 * `elemCtx` over its joined position table (values read as direct columns), the GROUPED
 * regime an `aliasCtx` over the exploded `je.value` (values read back by correlated
 * subquery). Same `by()` ⇒ same answer. Previously these were two hand-rolled switches and
 * the grouped one hardcoded the vertex-property read, so `by(T.id)`/`by(T.label)` worked on a
 * linear path and threw on a recursive one — the same modulator, two answers.
 */
function positionScalar(ctx: ScalarCtx, byArgs: any[] | undefined): Expression | undefined {
  const by = classifyBy(byArgs);
  if (by.kind === 'none') return undefined; // no by()/bare by() → the element
  if (by.kind === 'key') return scalarProp(ctx, by.key);
  if (by.kind === 'token') {
    const expr = tokenExpr(ctx, by.token);
    if (!expr) throw new Error(`path().by(T.${by.token}) modulator not yet supported`);
    return expr;
  }
  throw new Error('unsupported path().by() modulator');
}

// `otherV()` is an endpoint movement too, but is deliberately separate from ENDPOINT_MOVES:
// unlike outV/inV/bothV it consumes the carried entering-vertex context. Position fan-out must
// nevertheless recognize it exactly like every other path-appending movement; otherwise
// bothE().otherV() projects the edge position instead of the reached vertex while path tracking
// is live.
export const POSITION_MOVEMENTS = unionOf(VERTEX_MOVES, EDGE_MOVES, ENDPOINT_MOVES, OTHER_V);
const ELEMENT_POSITION_BRANCH = new Set(['choose', 'coalesce', 'union']);

/** PURE. Does this branch-arm body produce MORE than one value per input element? A path
 *  position holds exactly ONE value, so the branch route (which has no `first`-collapse — the
 *  value route's `tryCompileScalarValueChild('first')` does, the element-parent branch compilers
 *  do NOT) must reject any fan-out arm or it would silently multiply whole path rows through the
 *  ordinal LEFT JOIN. Fan-out inducers: element movement (>1 neighbour), a `V()`/`E()` re-source,
 *  a `union()` (every arm emits), or a nested `choose`/`coalesce` whose own THEN/ELSE (choose) or
 *  any arm (coalesce) fans out. A terminal reducer/`fold()` collapses the body back to one. A
 *  choose predicate is a gate (collapses to a boolean), so it is NOT recursed — only the value
 *  arms are. `values()` is treated as ≤1 here (single-cardinality is the norm; a genuinely
 *  multi-value property in a branch arm is the residual take-first case, matching the value
 *  route/by(key) which both take first). */
function positionArmFansOut(body: IRStep[], params: Record<string, any>): boolean {
  const last = body.at(-1);
  if (last && (REDUCERS.has(last.name) || last.name === 'fold')) return false; // a terminal reducer/fold collapses the body back to one
  return body.some((s) => {
    if (POSITION_MOVEMENTS.has(s.name) || s.name === 'V' || s.name === 'E' || s.name === 'union') return true;
    if ((s.name === 'choose' || s.name === 'coalesce') && !(s as IRStep).optionArms) {
      const kids = argValues(s).filter(isNested);
      // choose(pred, then, else): the predicate (kids[0]) gates, only then/else can fan out.
      const arms = s.name === 'choose' && kids.length === 3 ? kids.slice(1) : kids;
      return arms.some((a: any) => positionArmFansOut(childSteps(a.nested, params), params));
    }
    return false;
  });
}

/** A `path().by(__.trav)` position → ONE scalar per position, joined back by ordinal. The
 *  re-rooted, path-stripped position seed keeps the outer ordinal (`outer.frame.ordinal`) as
 *  its innermost origin, carried through every route so the caller's ordinal join is identical:
 *   - value/transform/reducer body → the generic scalar child seam, reusing the pushed frame.
 *     Its `first` cardinality (encounter = ROW_NUMBER PARTITION BY ordinal) collapses a
 *     fan-out prefix (`by(__.out().values(…))`) to one value per position.
 *   - a bare choose()/coalesce() over the position → the element-parent scalar-branch compilers.
 *     These have NO first-collapse, so a fan-out arm (movement/re-source/union/nested-fan-out)
 *     would multiply the path row — `positionArmFansOut` rejects those up front (fail-closed,
 *     matching the locked take-first-of-fan-out non-goal). Non-fan-out arms (value/constant/
 *     reducer) yield exactly one value per position, which the ordinal LEFT JOIN needs.
 *  Deferred, fail-closed (never mis-executed): union() at a position (always fan-out); any
 *  branch whose arms fan out; a movement/filter PREFIX before the branch (a fan-out prefix
 *  makes the branch multi-valued and needs the value seam's encounter-threaded first-collapse
 *  the branch compilers don't carry). */
function lowerPathPositionChild(
  seed: ElementStream, nested: any, outer: { scope: ChildScope; frame: ChildFrame }, params: Record<string, any>,
): ScalarStream {
  const body = childSteps(nested, params);
  const armDesc = () => body.map((s) => s.name + '()').join('.');
  // A branch body (choose/coalesce/union — incl. one nested in an arm) must use the branch route,
  // NOT the value route: the branch compilers have no `first`-collapse, so the fan-out guard is
  // the position's 1-to-1 safety. (classifyScalarChild now ACCEPTS nested-branch bodies, so the
  // value route below would grab them and hit applyScalarChildCardinality's encounter throw.)
  const hasBranch = body.some((s) => ELEMENT_POSITION_BRANCH.has(s.name) && !(s as IRStep).optionArms);
  const branch = body.length === 1 && hasBranch ? body[0] : undefined;
  if (branch) {
    if (branch.name === 'union')
      throw new Error(`path().by(__.${armDesc()}): union() at a path position fans out to multiple values but a position holds one — take-first-of-fan-out is a deferred non-goal; use choose()/coalesce()`);
    if (positionArmFansOut(body, params))
      throw new Error(`path().by(__.${armDesc()}): a ${branch.name}() arm fans out (movement/re-source/union) but a path position holds one value — take-first-of-fan-out is a deferred non-goal`);
    const s = branch.name === 'choose' ? tryLowerScalarChoose(branch, seed) : tryLowerScalarCoalesce(branch, seed);
    if (s) return s;
    throw new Error(`path().by(traversal) position ${branch.name}() not yet supported (arms must be scalar children)`);
  }
  // A branch with a movement/filter prefix or suffix (`by(__.out().choose(…))`) isn't a bare
  // position branch: a fan-out prefix makes it multi-valued and needs the value seam's
  // encounter-threaded first-collapse the branch route lacks. Defer cleanly (classifyScalarChild
  // would otherwise accept it and hit applyScalarChildCardinality's encounter throw).
  if (hasBranch)
    throw new Error(`path().by(traversal): a branch (choose/coalesce/union) at a path position must be the whole by() body; a movement/filter around it is not yet supported (needs first-collapse)`);
  // Flat value/transform/reducer body → the generic scalar child seam with `first` cardinality
  // (encounter = ROW_NUMBER PARTITION BY ordinal) collapses a fan-out prefix to one value.
  const plan = classifyScalarChild(nested, childCtx(seed));
  if (plan) {
    const out = tryCompileScalarValueChild(seed, nested, 'first', reuseCurrentFrame(outer.scope, outer.frame), plan);
    if (out) return out;
    // A suffix the generic loop cannot lower here declines, and falls to the deferral below.
  }
  throw new Error(`path().by(traversal) position must be a scalar child (value/transform/reducer, or a bare choose()/coalesce()); __.${armDesc()} not yet supported`);
}

/**
 * path(): frame each tracked path position (p0..pN, seeded at V(), one appended per
 * hop) as one Path per row. Without by(), each position is the whole element (joined
 * to its table for id/label/props); a by(key) projects that element's property as a
 * scalar and cycles the modulators round-robin across positions. A non-productive
 * by(key) (missing property) drops the whole path (TinkerPop's default — only
 * ProductiveByStrategy would emit null). order()/reducers/from()/to() defer.
 */
export function lowerPath(st: ElementStream, proj: IRStep, acc: TailAcc): PathStream {
  // The chain reached path() with no path state carried. `analyze` seeds tracking at the SOURCE
  // from the chain's own text, so this means the stream was re-typed by a barrier that consumed
  // the positions (a cap()/unfold() re-entry) rather than walked to here. Mid-chain
  // union()/optional()/repeat() are caught earlier by their own path guards.
  if (!st.traverserLayout.path) throw new Error('path() after a barrier that consumed the path positions is not yet supported');
  if (st.traverserLayout.path.kind === 'array') return compilePathArray(st, proj, acc);
  const pathState = st.traverserLayout.path; // narrowed to 'cols'; held in a local so the .map closure keeps the narrowing
  if (acc.orders.length) throw new Error('order() after path() not yet supported');
  if (acc.reducer) throw new Error(`${acc.reducer}() after path() not yet supported`);
  if (acc.isPreds.length) throw new Error('is() after path() not yet supported');

  // from(l)/to(l): scope the Path to the positions between two as() labels, resolved to
  // their static linear positions (recorded on the alias entry at bind time). Inclusive
  // of both endpoints; an unbound label / empty range fails closed.
  const scopedCols = scopePathCols(pathState.cols, proj.from, proj.to, st.traverserLayout.aliases);
  const bys = proj.modulators ?? [];
  const productive = proj.productiveBy === true;
  // A branched path (pad-to-max cols) has nullable positions: a shorter arm left them
  // NULL. LEFT JOIN those (an INNER JOIN would drop the whole short-arm path), and the
  // handler (pathBuffer) omits a null-id position. A by() over such a position needs one
  // extra distinction, since its value column NULLs for two different reasons: the position
  // is ABSENT (this arm's path is shorter — omit it) vs the by() value is MISSING (drop the
  // whole path, TinkerPop's default). The raw position id decides, so an optional position
  // projects it as a presence column and the drop predicate is gated on it.
  const byOf = (i: number) => byAt(bys, i);
  const dropIfMissing = (pos: { col: string; nullable?: boolean }, v: Expression): Expression =>
    pos.nullable ? q`(${p.c[pos.col]} IS NULL OR ${predicateSql(v, undefined)})` : predicateSql(v, undefined);
  // A by(__.trav) position lowers through the SAME generic scalar child seam group/
  // select/dedup/order use: push ONE child scope over the path rows, re-root each such
  // position on its element, and join the child's FIRST value back by ordinal. Positions
  // are then structurally a record of per-position children (tryLowerTraversalRecord's
  // template). A path with no by(traversal) keeps the flat fast path — no scope, no ordinal.
  const anyTraversal = scopedCols.some((_, i) => classifyBy(byOf(i)).kind === 'nested');
  const outer = anyTraversal ? pushChildScope(st) : null;
  const p = (outer ? outer.seed.rel : st.rel).as('p');
  const joins: Expression[] = [];
  const cols: Expression[] = [];
  const whereParts: Expression[] = [];
  const positions: PathPos[] = scopedCols.map((pos, i) => {
    const prefix = `x${i}`;
    const byClass = classifyBy(byOf(i));
    // by(__.trav): re-root on this position's element and lower a scalar child via the seam.
    if (byClass.kind === 'nested') {
      // The child computes ONE scalar for this position — it must NOT extend the outer path
      // (its own movement would append a path column, corrupting the carried schema). Strip
      // path from the child seed; the ordinal (for the ordinal join) is preserved.
      const childParent = withoutPath(outer!.seed);
      const seed = reRootElement(childParent, p, p.c[pos.col], pos.elem);
      const child = lowerPathPositionChild(seed, byClass.nested, outer!, st.params);
      const b = child.rel.as(`b${i}`);
      joins.push(q` LEFT JOIN ${b} ON ${b.c[outer!.frame.ordinal]}=${p.c[outer!.frame.ordinal]}`);
      cols.push(q`${b.c.v} AS ${`${prefix}_v`}`);
      if (pos.nullable) cols.push(q`${p.c[pos.col]} AS ${`${prefix}_at`}`);
      if (!productive) whereParts.push(dropIfMissing(pos, b.c.v));
      return pos.nullable ? { render: 'value', prefix, optional: true } : { render: 'value', prefix };
    }
    const tbl = elemTable(pos.elem).as(`${prefix}n`);
    const jn = pos.nullable ? 'LEFT JOIN' : 'JOIN';
    joins.push(q` ${jn} ${tbl} ON ${tbl.c.id}=${p.c[pos.col]}`);
    const pe = positionScalar(elemCtx(tbl, pos.elem), byOf(i));
    if (pe === undefined) {
      cols.push(elementPayload(elemCtx(tbl, pos.elem), pos.elem, prefix));
      return { render: 'element', elem: pos.elem, prefix };
    }
    // by(key/T.token): one scalar per position. A missing value drops the whole path
    // (ProductiveBy retains an explicit NULL position instead).
    cols.push(q`${pe} AS ${`${prefix}_v`}`);
    if (pos.nullable) cols.push(q`${p.c[pos.col]} AS ${`${prefix}_at`}`);
    if (!productive) whereParts.push(dropIfMissing(pos, pe));
    return pos.nullable ? { render: 'value', prefix, optional: true } : { render: 'value', prefix };
  });

  const dist = acc.distinct ? 'DISTINCT ' : '';
  const whereNode = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;
  // A SLICE HERE OBEYS THE SAME RULE AS EVERY OTHER SLICE: deterministic when the chain carries
  // emission order, order-free when it does not (`prefix/passthrough.ts` orderByEncounter, Stage B).
  // This site was the one place that spelled the LIMIT WITHOUT the ORDER BY while `encounter` was
  // live, so `path().limit(n)` took whichever n rows the scan happened to yield — and since the
  // whereExists fast path and the generic filter drive that scan differently, the two answered with
  // different paths. Found by L5 on a HEAD-derived seed CI drew; the divergence is only how it
  // SURFACED, not what it was: BOTH routes were unordered, so this is the both-paths class the
  // differential is documented to be blind to.
  const sliced = acc.limit !== null || acc.offset > 0;
  const orderSql = sliced && st.traverserLayout.encounter ? q` ORDER BY ${p.c[st.traverserLayout.encounter]}` : empty;
  const tailSql = sliced ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  // A LINEAR path is ROW-PRESERVING — one row in, one Path row out — so unlike a reducing
  // barrier it can honestly carry the incoming as() label history forward, and `select(label)`
  // after path() must resolve (TinkerPop Select.feature
  // g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold). Only the
  // path/origin state this barrier genuinely CONSUMES is dropped; the alias columns ride through
  // via layoutProjection. The recursive/grouped regime (compilePathArray) explodes one path into
  // (pk, ord) rows and so is NOT row-preserving — it keeps dropping them.
  const outCarried: TraverserLayout = {
    aliases: st.traverserLayout.aliases, origins: [], branchOrders: [], trackFromV: st.traverserLayout.trackFromV,
    ...(st.traverserLayout.consumedAliases ? { consumedAliases: st.traverserLayout.consumedAliases } : {}),
  };
  const aliasCols = layoutCols(outCarried);
  const carryCols = aliasCols.length ? list(aliasCols.map((c) => q`, ${p.c[c]}`), '') : empty;
  const node = q`SELECT ${dist}${list(cols, ', ')}${carryCols} FROM ${p}${list(joins, '')}${whereNode}${orderSql}${tailSql}`;
  const layout = { kind: 'linear' as const, positions };
  const rel = st.q.cte(node, [...pathColumns(layout), ...aliasCols]);
  return toPathStream(loweringStateOf(st, outCarried), rel, layout);
}

/**
 * path() over a recursive repeat() walk (the `array` regime). The walk (branch.ts)
 * accumulated a JSONB array of visited ids per surviving traverser (`st.rel` =
 * `(id, path)`). Give each path a row number (`pk`), explode the array with
 * `json_each` (`.key` = ordinal), materialize each element, and emit ONE ROW PER
 * PATH ELEMENT ordered by `(pk, ord)` — the handler folds each pk-run into one Path.
 * All elements are vertices (out/in/both bodies); edge-inclusive bodies defer.
 */
/**
 * `path().by(__.trav)` over a RECURSIVE (grouped) path — the positional child the linear regime
 * has always had, now over `json_each` instead of over static position columns.
 *
 * The trick that unlocks it: the explode is naturally `(id, pk, ord)`, and an ElementStream's
 * physical schema is `['id', ...layoutCols]`, so `pk`/`ord` cannot just ride alongside. They ride
 * as **`origins`** — which is precisely what that slot means ("which parent did this row come
 * from"), and for a path element the answer literally is "path `pk`, position `ord`". So the
 * exploded relation is an ordinary element stream, `pushChildScope` mints its ordinal after them,
 * and the rejoin is the same `LEFT JOIN … ON b.<ordinal> = d.<ordinal>` the linear regime does.
 *
 * The child itself is `lowerPathPositionChild`, UNCHANGED and shared: the fan-out guards, the
 * branch route (`choose`/`coalesce`) and the `first` collapse are one implementation for both
 * regimes rather than two. That is the whole point — a grouped path is easier than a linear one
 * here, because a single uniform `by()` means ONE child rather than one per position.
 */
function groupedPositionChild(st: ElementStream, paths: Relation, nested: any, productive: boolean): Expression {
  const elemRows = st.q.cte(
    q`SELECT je.value AS id, pp.pk AS pk, je.key AS ord FROM ${paths} pp, json_each(pp.path) je`,
    ['id', 'pk', 'ord']);
  // No aliases and no path: a position's child must not extend the walk's path (its movement
  // would append a column and corrupt the carried schema), and the walk's label history is
  // consumed by this barrier — the same reason the linear regime strips `path` from its child seed.
  const elemStream: ElementStream = {
    ...st, rel: elemRows, elem: 'vertex',
    traverserLayout: { aliases: new Map(), origins: ['pk', 'ord'], branchOrders: [] },
  };
  const outer = pushChildScope(elemStream);
  const child = lowerPathPositionChild(outer.seed, nested, outer, st.params);
  const ord = outer.frame.ordinal;
  const d = outer.frame.domain.as('d');
  const b = child.rel.as('b');
  const vals = st.q.cte(
    q`SELECT ${d.c.pk} AS pk, ${d.c.ord} AS ord, ${b.c.v} AS v FROM ${d} LEFT JOIN ${b} ON ${b.c[ord]}=${d.c[ord]}`,
    ['pk', 'ord', 'v']);
  // Non-productive by(): a MISSING value drops the WHOLE path — the same rule the flat projector
  // applies with a pre-numbering NOT EXISTS, expressed group-wise because the value only exists
  // now. ProductiveBy keeps the path with an explicit NULL position.
  const v = vals.as('v');
  const drop = productive ? empty
    : q` WHERE ${v.c.pk} NOT IN (SELECT ${vals.c.pk} FROM ${vals} WHERE ${vals.c.v} IS NULL)`;
  return q`SELECT ${v.c.pk} AS pk, ${v.c.ord} AS ord, ${v.c.v} AS v FROM ${v}${drop} ORDER BY ${v.c.pk}, ${v.c.ord}`;
}

function compilePathArray(st: ElementStream, proj: IRStep, acc: TailAcc): PathStream {
  if (acc.orders.length || acc.reducer || acc.isPreds.length)
    throw new Error('order()/reducer/is() after a recursive repeat().path() not yet supported');
  // from()/to() need static per-position labels; a recursive walk has dynamic length.
  if (proj.from !== undefined || proj.to !== undefined)
    throw new Error('path().from()/to() over a recursive repeat().path() not yet supported');
  // path().by(key): every position projects the same property (a repeat path has dynamic
  // length, so a single by() applies uniformly; multiple by()s would round-robin over an
  // unknown length → defer). A by(traversal)/by(T.token) also defers via pathBy.
  const bys = proj.modulators ?? [];
  if (bys.length > 1) throw new Error('path().by() with multiple modulators over a recursive repeat().path() not yet supported');
  const by = bys.length ? bys[0] : undefined;
  const nested = classifyBy(by).kind === 'nested' ? (classifyBy(by) as { nested: any }).nested : undefined;
  // Every KEY/TOKEN position projects through the SAME projector the linear regime uses, over an
  // `aliasCtx` on the exploded element id. `posValue` is a function of the id expression
  // because it is needed at two sites over two different `je` scopes (here and the
  // non-productive drop guard below) — one projector, no second hardcode. A by(TRAVERSAL)
  // position is not a flat expression at all; it runs the positional child below.
  const posValue = (idExpr: Expression) => positionScalar(aliasCtx(idExpr, 'vertex'), by);
  // Whether this by() projects a SCALAR per position (key or T.token) or leaves the whole
  // element. Drives both the emitted columns and the wire framing (pathColumns / execute.ts
  // pathGroupedBuffers read `byKey` as exactly this question), so a T.token position needs no
  // wire change — it is a scalar like any other.
  const scalarPos = nested !== undefined || positionScalar(aliasCtx(q`je.value`, 'vertex'), by) !== undefined;
  const productive = proj.productiveBy === true;
  // dedup() must collapse equal paths BEFORE row-numbering: ROW_NUMBER() is computed
  // with the SELECT list, so a `SELECT DISTINCT path, ROW_NUMBER()…` never removes a
  // row (the unique pk defeats DISTINCT). Distinct-ify in a prior CTE, then number.
  let src = acc.distinct ? st.q.cte(q`SELECT DISTINCT ${st.rel.c.path} AS path FROM ${st.rel}`, ['path']) : st.rel;
  // A non-productive by(key) drops the WHOLE path if ANY element lacks the property
  // (mirrors the linear path()'s per-position IS NOT NULL guard); ProductiveBy keeps it
  // with an explicit NULL position.
  // A by(TRAVERSAL) value does not exist until the path is exploded and the child joined, so its
  // drop guard cannot run here — it runs group-wise inside groupedPositionChild instead. Same
  // rule, different point in the pipeline.
  if (scalarPos && !nested && !productive) {
    const fp = src.as('fp');
    src = st.q.cte(
      q`SELECT ${fp.c.path} AS path FROM ${fp} WHERE NOT EXISTS (SELECT 1 FROM json_each(${fp.c.path}) je WHERE ${posValue(q`je.value`)!} IS NULL)`,
      ['path'],
    );
  }
  // ROW_NUMBER over the surviving paths → a stable per-path key so equal-id paths
  // stay distinct (multiset) after the json_each explode.
  const limitSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const paths = st.q.cte(q`SELECT ${src.c.path} AS path, ROW_NUMBER() OVER (ORDER BY ${src.c.path}) AS pk FROM ${src}${limitSql}`, ['path', 'pk']);
  const layout = { kind: 'grouped' as const, elem: 'vertex' as const, byKey: scalarPos };
  // by(traversal) → a real positional CHILD per exploded element; by(key)/by(T.token) → one
  // scalar `v` read back off the exploded id; otherwise the whole vertex framed from nodes/labels.
  const node = nested
    ? groupedPositionChild(st, paths, nested, productive)
    : scalarPos
    ? q`SELECT pp.pk, je.key AS ord, ${posValue(q`je.value`)!} AS v FROM ${paths} pp, json_each(pp.path) je ORDER BY pp.pk, je.key`
    : (() => {
        const n = nodes.as('n');
        return q`SELECT pp.pk, je.key AS ord, ${elementPayload(elemCtx(n, 'vertex'), 'vertex')} FROM ${paths} pp, json_each(pp.path) je JOIN ${n} ON ${n.c.id}=je.value ORDER BY pp.pk, je.key`;
      })();
  const rel = st.q.cte(node, pathColumns(layout));
  return toPathStream(dropLayoutAtBarrier(loweringStateOf(st)), rel, layout);
}

/** Coerce a homogeneous scalar linear path (every position a by(key) value) into one
 *  list value per row, so the list-value engine (set-ops / reverse / unfold / reducers)
 *  composes over it. Returns null when the path isn't list-representable — element
 *  positions or the recursive-repeat grouped layout — so the caller fails closed. */
function linearScalarList(s: PathStream): ListStream | null {
  if (s.layout.kind !== 'linear') return null;
  if (!s.layout.positions.every((p) => p.render === 'value')) return null;
  const p = s.rel.as('p');
  const vals = s.layout.positions.map((pos) => p.c[`${pos.prefix}_v`]);
  const rel = s.q.cte(
    q`SELECT jsonb(json_array(${list(vals, ', ')})) AS list${layoutProjection(s.traverserLayout, p)} FROM ${p}`,
    ['list', ...layoutCols(s.traverserLayout)],
  );
  return toListStream(loweringStateOf(s), rel, { kind: 'scalar' });
}

/** The path arm of lowerSteps — steps AFTER path() over a PathStream (P3 Stage A).
 * A PathStream is a terminal-island no longer: count()/is(typeOf(PATH)) re-enter the
 * loop, and a homogeneous scalar path (path().by(key)) retypes into the list-value
 * engine for the collection ops (set-ops/reverse/unfold/…). select(Column)/whole-stream
 * order still defer (they need the path's as()-label history — separate slices). */
const PATH_DISPATCH = new Map<string, ShapeTailFn<PathStream>>([
  // where("a", P…("b")) — the ONE alias comparison (barrier.ts `aliasCompareRows`), which any
  // per-row stream carrying the alias columns takes unchanged. Only `where`: `not`/`filter`
  // have no string-argument spelling in the grammar, so registering them would be a handler
  // that can only ever decline.
  ['where', aliasCompareRows],
  // count() is a relational barrier over any shaped row stream. It reads `cardinalityOf`, so a
  // GROUPED (recursive) path counts its runs rather than its positions.
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['is', (s, step, _steps, at) => {
    const assert = typeOfAssert(step);
    if (assert.kind === 'none')
      throw new Error('is() after path() supports only is(typeOf(GType.PATH))');
    // A path IS a Path → is(typeOf(PATH)) is identity; any other type matches nothing. (The group
    // arm THROWS on the same non-matching assert; both are deliberate — see `typeOfAssert`.)
    if (assert.kind === 'gtype' && assert.gtype === 'PATH') return continueLowering(s, at + 1);
    const p = s.rel.as('p');
    const cols = pathColumns(s.layout);
    const rel = s.q.cte(q`SELECT ${list(cols.map((c) => p.c[c]), ', ')} FROM ${p} WHERE 0`, cols);
    return continueLowering(toPathStream(loweringStateOf(s), rel, s.layout), at + 1);
  }],
]);

export function compileFromPath(s: PathStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(PATH_DISPATCH, s, steps, at, (_s, ss, i) => {
    // A homogeneous scalar path coerces to a list for the collection ops — reuse the whole
    // list-value engine (set-ops, reverse, unfold, conjoin, all/any/none). This stays in the
    // FALLBACK rather than becoming |PATH_LIST_OPS| Map entries: it is one retype covering a
    // whole vocabulary the list arm owns, not a per-step lowering, so registering it per name
    // would duplicate `PATH_LIST_OPS` as a second membership list.
    const listForm = PATH_LIST_OPS.has(ss[i].name) ? linearScalarList(s) : null;
    if (listForm) return compileFromList(listForm, ss, i);
    throw new Error(`${ss[i].name}() on a path value not yet supported`);
  });
}
