import { isNested } from '../../../gremlin/frontend.ts';
import { q, list, empty, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { nodes, edges, labels } from '../../../sql/schema.ts';
import { framedProps, labelNameSub, nodePropScalar, edgePropScalar, predicateSql, extIdOf, elemCtx, type Elem } from '../../plan/plan.ts';
import { type PStep } from '../../ir/strategies.ts';
import { carryFrag, carriedCols, scopePathCols, withoutCarried, type Carried, type ElementStream } from '../context/context.ts';
import { carryOf, continueLowering, pathColumns, toListStream, toPathStream, toScalarStream, type ListStream, type LoweringResult, type PathStream, type ScalarStream } from '../context/stream.ts';
import { compileFromList } from './list.ts';
import { type PathPos } from '../../../sql/kernel/render.ts';
import { type TailAcc } from './projection.ts';
import { reRootElement } from './select.ts';
import { pushChildScope, tryCompileScalarValueChild } from './child.ts';
import { byAt, classifyBy, childSteps, classifyScalarChild, reuseCurrentFrame, type ChildFrame, type ChildScope } from './child-shape.ts';
import { tryLowerScalarChoose, tryLowerScalarCoalesce } from '../prefix/branch.ts';

// ---------- path() (linear regime) ----------

/** Interpret one path().by() modulator: undefined → the whole element; a string →
 *  a property-key projection; token/traversal by()s defer. */
function pathBy(byArgs: any[] | undefined): string | undefined {
  const by = classifyBy(byArgs);
  if (by.kind === 'none') return undefined; // no by()/bare by() → the element
  if (by.kind === 'key') return by.key;
  if (by.kind === 'nested') throw new Error('path().by(traversal) modulator not yet supported');
  throw new Error(`path().by(T.${by.token}) modulator not yet supported`);
}

/** The inline value expression for one linear path position under a by('key')/by(T.token)
 *  modulator, or undefined for a bare by()/no by() (→ the whole element). A by(__.trav)
 *  position is NOT handled here — lowerPath lowers it through the generic scalar child seam. */
function pathPositionValue(_st: ElementStream, tbl: Relation, elem: Elem, byArgs: any[] | undefined): Expression | undefined {
  const by = classifyBy(byArgs);
  if (by.kind === 'none') return undefined; // the whole element
  if (by.kind === 'key') return elem === 'edge' ? edgePropScalar(tbl.c.id, by.key) : nodePropScalar(tbl.c.id, by.key);
  if (by.kind === 'token') {
    if (by.token === 'label') return labelNameSub(tbl.c.label);
    if (by.token === 'id') return elemCtx(tbl, elem).extIdExpr!;
    throw new Error(`path().by(T.${by.token}) modulator not yet supported`);
  }
  throw new Error('unsupported path().by() modulator');
}

const POSITION_MOVEMENTS = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV']);
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
function positionArmFansOut(body: PStep[], params: Record<string, any>): boolean {
  const last = body.at(-1);
  if (last && (last.name === 'count' || last.name === 'sum' || last.name === 'min' || last.name === 'max' || last.name === 'mean' || last.name === 'fold')) return false;
  return body.some((s) => {
    if (POSITION_MOVEMENTS.has(s.name) || s.name === 'V' || s.name === 'E' || s.name === 'union') return true;
    if ((s.name === 'choose' || s.name === 'coalesce') && !(s as any).options) {
      const kids = (s.args ?? []).filter(isNested);
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
  const hasBranch = body.some((s) => ELEMENT_POSITION_BRANCH.has(s.name) && !(s as any).options);
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
  const plan = classifyScalarChild(nested, params);
  if (plan) return tryCompileScalarValueChild(seed, nested, 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.body)!;
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
export function lowerPath(st: ElementStream, proj: PStep, acc: TailAcc): PathStream {
  // Reachable only from a union() SOURCE step: seedUnion doesn't seed p0 (unlike
  // seedSource, which handles V()/E()), so path tracking never starts. Mid-chain
  // union()/optional()/repeat() are caught earlier by their own path guards.
  if (!st.carried.path) throw new Error('path() over a union() source step is not yet supported');
  if (st.carried.path.kind === 'array') return compilePathArray(st, proj, acc);
  const pathState = st.carried.path; // narrowed to 'cols'; held in a local so the .map closure keeps the narrowing
  if (acc.orders.length) throw new Error('order() after path() not yet supported');
  if (acc.reducer) throw new Error(`${acc.reducer}() after path() not yet supported`);
  if (acc.isPreds.length) throw new Error('is() after path() not yet supported');

  // from(l)/to(l): scope the Path to the positions between two as() labels, resolved to
  // their static linear positions (recorded on the alias entry at bind time). Inclusive
  // of both endpoints; an unbound label / empty range fails closed.
  const scopedCols = scopePathCols(pathState.cols, proj.from, proj.to, st.carried.aliases);
  const bys = proj.bys ?? [];
  const productive = proj.productiveBy === true;
  // A branched path (pad-to-max cols) has nullable positions: a shorter arm left them
  // NULL. LEFT JOIN those (an INNER JOIN would drop the whole short-arm path), and the
  // handler (pathBuffer) omits a null-id position. by() can't ride a branched path —
  // a padded NULL is indistinguishable from a missing property, so defer.
  const branched = scopedCols.some((c) => c.nullable);
  if (branched && bys.length) throw new Error('path().by() through a branch not yet supported (a padded position is indistinguishable from a missing property)');
  const byOf = (i: number) => byAt(bys, i);
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
      const childParent = { ...outer!.seed, carried: { ...outer!.seed.carried, path: undefined } };
      const seed = reRootElement(childParent, p, p.c[pos.col], pos.elem);
      const child = lowerPathPositionChild(seed, byClass.nested, outer!, st.params);
      const b = child.rel.as(`b${i}`);
      joins.push(q` LEFT JOIN ${b} ON ${b.c[outer!.frame.ordinal]}=${p.c[outer!.frame.ordinal]}`);
      cols.push(q`${b.c.v} AS ${`${prefix}_v`}`);
      if (!productive) whereParts.push(predicateSql(b.c.v, undefined));
      return { render: 'value', prefix };
    }
    const tbl = (pos.elem === 'edge' ? edges : nodes).as(`${prefix}n`);
    const jn = pos.nullable ? 'LEFT JOIN' : 'JOIN';
    joins.push(q` ${jn} ${tbl} ON ${tbl.c.id}=${p.c[pos.col]}`);
    const pe = pathPositionValue(st, tbl, pos.elem, byOf(i));
    if (pe === undefined) {
      const l = labels.as(`${prefix}l`);
      joins.push(q` ${jn} ${l} ON ${l.c.id}=${tbl.c.label}`);
      const extId = q`COALESCE(${tbl.c.uid}, ${tbl.c.id})`;
      if (pos.elem === 'edge') {
        // Endpoints as external ids (see the __element edge projector).
        cols.push(q`${extId} AS ${`${prefix}_id`}, ${l.c.name} AS ${`${prefix}_label`}, ${extIdOf(tbl.c.src)} AS ${`${prefix}_src`}, ${extIdOf(tbl.c.tgt)} AS ${`${prefix}_tgt`}, ${framedProps(tbl, 'edge')} AS ${`${prefix}_props`}`);
        return { render: 'element', elem: 'edge', prefix };
      }
      cols.push(q`${extId} AS ${`${prefix}_id`}, ${l.c.name} AS ${`${prefix}_label`}, ${framedProps(tbl, 'node')} AS ${`${prefix}_props`}`);
      return { render: 'element', elem: 'vertex', prefix };
    }
    // by(key/T.token): one scalar per position. A missing value drops the whole path
    // (ProductiveBy retains an explicit NULL position instead).
    cols.push(q`${pe} AS ${`${prefix}_v`}`);
    if (!productive) whereParts.push(predicateSql(pe, undefined));
    return { render: 'value', prefix };
  });

  const dist = acc.distinct ? 'DISTINCT ' : '';
  const whereNode = whereParts.length ? q` WHERE ${list(whereParts, ' AND ')}` : empty;
  const tailSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  // A LINEAR path is ROW-PRESERVING — one row in, one Path row out — so unlike a reducing
  // barrier it can honestly carry the incoming as() label history forward, and `select(label)`
  // after path() must resolve (TinkerPop Select.feature
  // g_V_hasXperson_name_markoX_path_asXaX_unionXidentity_identityX_selectXaX_unfold). Only the
  // path/origin state this barrier genuinely CONSUMES is dropped; the alias columns ride through
  // via carryFrag. The recursive/grouped regime (compilePathArray) explodes one path into
  // (pk, ord) rows and so is NOT row-preserving — it keeps dropping them.
  const outCarried: Carried = {
    aliases: st.carried.aliases, origins: [], trackFromV: st.carried.trackFromV,
    ...(st.carried.consumedAliases ? { consumedAliases: st.carried.consumedAliases } : {}),
  };
  const aliasCols = carriedCols(outCarried);
  const carryCols = aliasCols.length ? list(aliasCols.map((c) => q`, ${p.c[c]}`), '') : empty;
  const node = q`SELECT ${dist}${list(cols, ', ')}${carryCols} FROM ${p}${list(joins, '')}${whereNode}${tailSql}`;
  const layout = { kind: 'linear' as const, positions };
  const rel = st.q.cte(node, [...pathColumns(layout), ...aliasCols]);
  return toPathStream({ ...carryOf(st), carried: outCarried }, rel, layout);
}

/**
 * path() over a recursive repeat() walk (the `array` regime). The walk (branch.ts)
 * accumulated a JSONB array of visited ids per surviving traverser (`st.rel` =
 * `(id, path)`). Give each path a row number (`pk`), explode the array with
 * `json_each` (`.key` = ordinal), materialize each element, and emit ONE ROW PER
 * PATH ELEMENT ordered by `(pk, ord)` — the handler folds each pk-run into one Path.
 * All elements are vertices (out/in/both bodies); edge-inclusive bodies defer.
 */
function compilePathArray(st: ElementStream, proj: PStep, acc: TailAcc): PathStream {
  if (acc.orders.length || acc.reducer || acc.isPreds.length)
    throw new Error('order()/reducer/is() after a recursive repeat().path() not yet supported');
  // from()/to() need static per-position labels; a recursive walk has dynamic length.
  if (proj.from !== undefined || proj.to !== undefined)
    throw new Error('path().from()/to() over a recursive repeat().path() not yet supported');
  // path().by(key): every position projects the same property (a repeat path has dynamic
  // length, so a single by() applies uniformly; multiple by()s would round-robin over an
  // unknown length → defer). A by(traversal)/by(T.token) also defers via pathBy.
  const bys = proj.bys ?? [];
  if (bys.length > 1) throw new Error('path().by() with multiple modulators over a recursive repeat().path() not yet supported');
  const key = pathBy(bys.length ? bys[0] : undefined);
  const productive = proj.productiveBy === true;
  // dedup() must collapse equal paths BEFORE row-numbering: ROW_NUMBER() is computed
  // with the SELECT list, so a `SELECT DISTINCT path, ROW_NUMBER()…` never removes a
  // row (the unique pk defeats DISTINCT). Distinct-ify in a prior CTE, then number.
  let src = acc.distinct ? st.q.cte(q`SELECT DISTINCT ${st.rel.c.path} AS path FROM ${st.rel}`, ['path']) : st.rel;
  // A non-productive by(key) drops the WHOLE path if ANY element lacks the property
  // (mirrors the linear path()'s per-position IS NOT NULL guard); ProductiveBy keeps it
  // with an explicit NULL position.
  if (key !== undefined && !productive) {
    const fp = src.as('fp');
    src = st.q.cte(
      q`SELECT ${fp.c.path} AS path FROM ${fp} WHERE NOT EXISTS (SELECT 1 FROM json_each(${fp.c.path}) je WHERE ${nodePropScalar(q`je.value`, key)} IS NULL)`,
      ['path'],
    );
  }
  // ROW_NUMBER over the surviving paths → a stable per-path key so equal-id paths
  // stay distinct (multiset) after the json_each explode.
  const limitSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const paths = st.q.cte(q`SELECT ${src.c.path} AS path, ROW_NUMBER() OVER (ORDER BY ${src.c.path}) AS pk FROM ${src}${limitSql}`, ['path', 'pk']);
  const layout = { kind: 'grouped' as const, elem: 'vertex' as const, byKey: key !== undefined };
  // by(key) → one scalar `v` per position (correlated on the exploded id); otherwise the
  // whole vertex framed from nodes/labels.
  const node = key !== undefined
    ? q`SELECT pp.pk, je.key AS ord, ${nodePropScalar(q`je.value`, key)} AS v FROM ${paths} pp, json_each(pp.path) je ORDER BY pp.pk, je.key`
    : (() => {
        const n = nodes.as('n');
        const l = labels.as('l');
        return q`SELECT pp.pk, je.key AS ord, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props FROM ${paths} pp, json_each(pp.path) je JOIN ${n} ON ${n.c.id}=je.value JOIN ${l} ON ${l.c.id}=${n.c.label} ORDER BY pp.pk, je.key`;
      })();
  const rel = st.q.cte(node, pathColumns(layout));
  return toPathStream(withoutCarried(carryOf(st)), rel, layout);
}

/** Collection ops with unambiguous list semantics when applied to a Path: the Path is
 *  coerced to its element sequence (a list) and the op reshapes/filters/explodes it.
 *  order/dedup/limit/count are deliberately NOT here — those are whole-stream path ops
 *  (count() handled below; order/reducer as whole-stream is a separate slice). */
const PATH_LIST_OPS = new Set(['combine', 'intersect', 'difference', 'disjunct', 'product', 'merge', 'reverse', 'conjoin', 'all', 'any', 'none', 'unfold']);

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
    q`SELECT jsonb(json_array(${list(vals, ', ')})) AS list${carryFrag(s.carried, p)} FROM ${p}`,
    ['list', ...carriedCols(s.carried)],
  );
  return toListStream(carryOf(s), rel, { kind: 'scalar' });
}

/** The path arm of lowerSteps — steps AFTER path() over a PathStream (P3 Stage A).
 * A PathStream is a terminal-island no longer: count()/is(typeOf(PATH)) re-enter the
 * loop, and a homogeneous scalar path (path().by(key)) retypes into the list-value
 * engine for the collection ops (set-ops/reverse/unfold/…). select(Column)/whole-stream
 * order still defer (they need the path's as()-label history — separate slices). */
export function compileFromPath(s: PathStream, steps: PStep[], at: number): LoweringResult {
  const step = steps[at];
  if (step.name === 'count') {
    // One path per row (linear) vs one row per path ELEMENT (grouped, recursive repeat):
    // count paths, so grouped counts DISTINCT path keys, not exploded elements.
    const p = s.rel.as('p');
    const countExpr = s.layout.kind === 'grouped' ? q`COUNT(DISTINCT ${p.c.pk})` : q`COUNT(*)`;
    const rel = s.q.cte(q`SELECT ${countExpr} AS v FROM ${p}`, ['v']);
    return continueLowering(toScalarStream(withoutCarried(carryOf(s)), rel, 'long', { result: 'count' }), at + 1);
  }
  if (step.name === 'is') {
    const pred = (step.args ?? [])[0];
    if (pred && typeof pred === 'object' && pred.op === 'typeOf') {
      const arg = pred.values?.[0];
      const name = (arg && typeof arg === 'object' && 'gtype' in arg) ? String(arg.gtype) : typeof arg === 'string' ? arg : null;
      // A path IS a Path → is(typeOf(PATH)) is identity; any other type matches nothing.
      if (name && name.toUpperCase() === 'PATH') return continueLowering(s, at + 1);
      const p = s.rel.as('p');
      const cols = pathColumns(s.layout);
      const rel = s.q.cte(q`SELECT ${list(cols.map((c) => p.c[c]), ', ')} FROM ${p} WHERE 0`, cols);
      return continueLowering(toPathStream(carryOf(s), rel, s.layout), at + 1);
    }
    throw new Error('is() after path() supports only is(typeOf(GType.PATH))');
  }
  // A homogeneous scalar path coerces to a list for the collection ops — reuse the
  // whole list-value engine (set-ops, reverse, unfold, conjoin, all/any/none).
  const listForm = PATH_LIST_OPS.has(step.name) ? linearScalarList(s) : null;
  if (listForm) return compileFromList(listForm, steps, at);
  throw new Error(`${step.name}() on a path value not yet supported`);
}
