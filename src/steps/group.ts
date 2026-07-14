import { q, value, list, empty, raw, type Expression } from '../q.ts';
import { labels, vertexProperties } from '../schema.ts';
import {
  compileNestedScalar, compileNestedList, scalarProp, labelNameSub, framedPropsCtx, vertexPropsAgg, extIdOf, propExtract, predicateSql, nodePropScalar,
  type ScalarCtx,
} from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { elemRel, type St } from './context.ts';
import { carryOf, toMapStream, type MapOf, type MapStream } from './stream.ts';
import { readCompiled, type Compiled, type Shape, type ElemShape, type GroupKey, type GroupVal } from '../render.ts';

/** Movement heads whose nested-by() aggregate is a correlated neighbourhood
 *  reduction (handled by compileNestedScalar), and the scalar reducers that terminate one. */
const MOVES_ROOT = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const SCALAR_REDUCERS = new Set(['sum', 'min', 'max', 'mean']);

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind. */
export interface GroupSource { from: string; ctx: ScalarCtx; elem: ElemShape; }

/** Columns that frame one element (vertex/edge/property) under `prefix`. label
 *  rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx): Expression {
  const extId = ctx.extIdExpr ?? ctx.idExpr;
  if (elem === 'edge')
    // Endpoints as external ids (see the __element edge projector).
    return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${extIdOf(ctx.srcExpr!)} AS ${`${prefix}_src`}, ${extIdOf(ctx.tgtExpr!)} AS ${`${prefix}_tgt`}, ${framedPropsCtx(ctx)} AS ${`${prefix}_props`}`;
  if (elem === 'property')
    return q`${ctx.ownerExpr!} AS ${`${prefix}_owner`}, ${ctx.pkExpr!} AS ${`${prefix}_pk`}, ${ctx.pvExpr!} AS ${`${prefix}_pv`}`;
  return q`${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${framedPropsCtx(ctx)} AS ${`${prefix}_props`}`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx): Expression => elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string | Expression }

/** Build the key columns for group(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, params: Record<string, any>): GroupKeyBuild {
  if (!keyArgs || keyArgs.length === 0) { // bare by() → the element itself is the key
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx), group: elementIdExpr(src.elem, src.ctx) };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name') — first-under-multi for a node
    const pe = scalarProp(src.ctx, a);
    return { desc: { kind: 'scalar' }, cols: q`${pe} AS gk`, group: 'gk' };
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
export function compileGroup(st: St, isCount: boolean, bys: any[][], src: GroupSource): Compiled {
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const key = buildGroupKey(bys[0], src, st.params);

  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
  else {
    const a = valArgs[0];
    if (typeof a === 'string') { // by('age') → list of scalars (first-under-multi per member)
      const pe = scalarProp(src.ctx, a);
      val = { kind: 'scalarList' }; valNode = q`json_group_array(${pe}) AS gv`;
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
  return readCompiled(st.q, node, { kind: 'group', key: key.desc, val });
}

/**
 * group()/groupCount() retyped to a MapStream (stream.ts) — reached only when a
 * follower (select(Column.*), unfold) consumes the map, so the tail stays re-enterable.
 * Emits one `(mk, mv)` row per entry via a real SQL GROUP BY. Element keys carry their
 * rowid (rejoined on select(Column.keys)→unfold); values are single scalars (count/sum/
 * neighbourhood-reduction). The multi-column shapes the terminal groupBuffer frames —
 * element VALUE lists, scalar-LIST values (by('age')/by(__.fold())), composite project
 * keys — can't be one `mv`/`mk` column, so they defer here with a clear message (the
 * terminal group() path still handles them; only the re-enterable form is scoped). */
export function groupToMapStream(st: St, isCount: boolean, bys: any[][], src: GroupSource): MapStream {
  if (st.carried.aliases.size || st.carried.path || st.carried.origin)
    throw new Error('group() carrying as()/path()/branch state into a map value not yet supported');
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');

  // KEY column mk + its GROUP BY expr.
  const keyArgs = bys[0];
  let mk: Expression, keyGroup: Expression, keyOf: MapOf;
  if (!keyArgs || keyArgs.length === 0) { // bare by() → the element itself keys the map
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    mk = elementIdExpr(src.elem, src.ctx); keyGroup = mk; keyOf = { kind: 'elem', elem: src.elem === 'edge' ? 'edge' : 'node' };
  } else {
    const a = keyArgs[0];
    if (typeof a === 'string') { mk = scalarProp(src.ctx, a); keyGroup = mk; keyOf = { kind: 'scalar' }; }
    else if (a && typeof a === 'object' && 'token' in a) {
      const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
      if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
      mk = expr; keyGroup = expr; keyOf = { kind: 'scalar' };
    } else if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, st.params);
      if (inner[0]?.name === 'project') throw new Error('select(Column) over a composite project() group key not yet supported');
      mk = compileNestedScalar(inner, src.ctx).expr; keyGroup = mk; keyOf = { kind: 'scalar' };
    } else throw new Error('unsupported group().by() key modulator');
  }

  // VALUE column mv — a single scalar (count/sum/neighbourhood-reduction). Element-list
  // and scalar-list values can't collapse to one column → defer.
  const valArgs = bys[1];
  let mv: Expression, valOf: MapOf;
  if (isCount) { mv = q`COUNT(*)`; valOf = { kind: 'scalar', as: 'long' }; }
  else if (!valArgs || valArgs.length === 0) throw new Error('select(Column) over a group of element values not yet supported');
  else {
    const a = valArgs[0];
    if (a && typeof a === 'object' && 'nested' in a) {
      const inner = stepChain(a.nested, st.params);
      const names = inner.map((s) => s.name);
      if (names.length === 1 && names[0] === 'count') { mv = q`COUNT(*)`; valOf = { kind: 'scalar', as: 'long' }; }
      else if (MOVES_ROOT.has(names[0]) && SCALAR_REDUCERS.has(names[names.length - 1])) {
        mv = q`MAX(${compileNestedScalar(inner, src.ctx).expr})`; valOf = { kind: 'scalar' };
      } else if (names[names.length - 1] === 'sum') {
        mv = q`SUM(${compileNestedScalar(inner.slice(0, -1), src.ctx).expr})`; valOf = { kind: 'scalar' };
      } else if (names[names.length - 1] === 'fold' && MOVES_ROOT.has(names[0])) {
        // by(__.<move>().<proj>()…fold()) → one correlated neighbour-list per key. The
        // list is per-member, so MAX (which satisfies GROUP BY) is only the value when
        // each group is ONE element — i.e. the key is the element itself. A multi-member
        // key would need the fold over ALL members' neighbours (a UNION over the group),
        // so defer it. The nesting rides valOf so select(Column.values) yields a
        // list-of-lists that unfold explodes into per-list rows.
        if (keyOf.kind !== 'elem') throw new Error('select(Column) over a group with a non-element key and a neighbour-list value not yet supported');
        const nl = compileNestedList(inner.slice(0, -1), src.ctx);
        mv = q`MAX(${nl.expr})`; valOf = { kind: 'list', of: nl.of };
      } else throw new Error('select(Column) over this group() value modulator not yet supported');
    } else throw new Error('select(Column) over this group() value modulator not yet supported');
  }

  // A scalar key over a missing property is SQL NULL — by(key) uses values(key), which
  // yields nothing, so such elements form NO group (mirrors the terminal groupBuffer's
  // null-key drop). Element/token keys are never null, so the filter only guards scalars.
  const keyWhere: Expression = keyOf.kind === 'scalar' ? q` WHERE ${keyGroup} IS NOT NULL` : empty;
  const rel = st.q.cte(q`SELECT ${mk} AS mk, ${mv} AS mv FROM ${src.from}${keyWhere} GROUP BY ${keyGroup}`, ['mk', 'mv']);
  return toMapStream(carryOf(st), rel, keyOf, valOf);
}

// ---------- properties() ----------

/**
 * properties()/properties(keys) on the current element, plus an optional single
 * follow-on: key()/value()/count(), or element()[.values/.id/.label/.count]. The
 * traverser is a property — a json_each expansion over the owner's props.
 */
export function compileProperties(st: St, tail: PStep[]): Compiled {
  const elem = st.elem;
  const keys = tail[0].args.filter((a): a is string => typeof a === 'string');
  const n = elemRel(st);
  const p = st.last.as('p');
  const l = labels.as('l');
  // Node: the property stream IS the vertex_properties rows (one per instance, so a
  // multi-valued key yields several) — vpid is the real VertexProperty id, pmeta its
  // meta bag. Edge: json_each the flat blob (edge Property has no id/meta/multi).
  let propBody: Expression;
  if (elem === 'edge') {
    const keyFilter: Expression = keys.length ? q` WHERE je.key IN (${list(keys.map(value), ',')})` : empty;
    propBody = q`SELECT NULL AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, je.key AS pk, je.value AS pv, NULL AS pmeta FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}, json_each(json(${n.c.props})) je${keyFilter}`;
  } else {
    const vp = vertexProperties.as('vp');
    const keyFilter: Expression = keys.length ? q` AND ${vp.c.key} IN (${list(keys.map(value), ',')})` : empty;
    propBody = q`SELECT ${vp.c.id} AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${vp.c.key} AS pk, ${vp.c.value} AS pv, json(${vp.c.meta}) AS pmeta FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label} JOIN ${vp} ON ${vp.c.node}=${n.c.id}${keyFilter}`;
  }
  const pc = st.q.cte(propBody, ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pmeta']);

  // properties().group()/.groupCount() — group over the property stream.
  const next1 = tail[1]?.name;
  if (next1 === 'group' || next1 === 'groupCount') {
    if (2 < tail.length) throw new Error(`step not implemented after properties().${next1}(): ${tail[2].name}()`);
    const ctx: ScalarCtx = { elem: 'property', idExpr: pc.c.owner, labelIdExpr: q`(SELECT label FROM nodes WHERE id=${pc.c.owner})`, ownerExpr: pc.c.owner, pkExpr: pc.c.pk, pvExpr: pc.c.pv };
    const src: GroupSource = { from: pc.name, ctx, elem: 'property' };
    return compileGroup(st, next1 === 'groupCount', tail[1].bys ?? [], src);
  }

  // Consume leading property-stream filters:
  //   has(metaKey[, pred]) → a meta-property filter over the pmeta blob;
  //   hasKey(k|P)          → filter on the property's own key (pk);
  //   hasValue(v|P)        → filter on the property's own value (pv).
  let ti = 1;
  const metaConds: Expression[] = [];
  for (; ; ti++) {
    const s = tail[ti];
    if (s?.name === 'has') {
      const [mk, mv] = s.args;
      if (typeof mk !== 'string') throw new Error('properties().has() requires a meta-property key');
      metaConds.push(predicateSql(propExtract('pmeta', mk).expr, s.args.length > 1 ? mv : undefined));
    } else if (s?.name === 'hasKey') {
      metaConds.push(predicateSql(raw('pk'), s.args[0]));
    } else if (s?.name === 'hasValue') {
      metaConds.push(predicateSql(raw('pv'), s.args[0]));
    } else break;
  }
  const metaWhere: Expression = metaConds.length ? q` WHERE ${list(metaConds, ' AND ')}` : empty;

  const done = (node: Expression, shape: Shape, termSteps: number): Compiled => {
    if (tail.length > ti + termSteps) throw new Error(`step not implemented after properties(): ${tail[ti + termSteps].name}()`);
    return readCompiled(st.q, node, shape);
  };

  const next = tail[ti]?.name;
  switch (next) {
    case undefined: // properties() terminal → VertexProperty elements (with meta framed)
      return done(q`SELECT vpid, owner, pk, pv, pmeta FROM ${pc}${metaWhere}`, { kind: 'property' }, 0);
    case 'key':
      return done(q`SELECT pk AS v FROM ${pc}${metaWhere}`, { kind: 'value' }, 1);
    case 'value':
      return done(q`SELECT pv AS v FROM ${pc}${metaWhere}`, { kind: 'value' }, 1);
    case 'id': // the real VertexProperty id
      return done(q`SELECT vpid AS v FROM ${pc}${metaWhere}`, { kind: 'value' }, 1);
    case 'count':
      return done(q`SELECT COUNT(*) AS v FROM ${pc}${metaWhere}`, { kind: 'count' }, 1);
    case 'valueMap': // a VertexProperty's meta-properties as a flat {metaKey: value} map
      return done(q`SELECT pmeta AS meta FROM ${pc}${metaWhere}`, { kind: 'metaMap' }, 1);
    case 'properties': { // meta-properties of the VertexProperty → Property elements
      const mkeys = tail[ti].args.filter((a): a is string => typeof a === 'string');
      const mkeyFilter = mkeys.length ? q` WHERE je.key IN (${list(mkeys.map(value), ',')})` : empty;
      return done(q`SELECT je.key AS mk, je.value AS mv FROM (SELECT pmeta FROM ${pc}${metaWhere}) x, json_each(COALESCE(x.pmeta, '{}')) je${mkeyFilter}`, { kind: 'metaProperty' }, 1);
    }
    case 'element': {
      const after = tail[ti + 1]?.name;
      if (elem === 'edge' && after === undefined) throw new Error('element() of an edge property not yet supported');
      switch (after) {
        case undefined:
          return done(q`SELECT owner AS id, ownerLabel AS label, ${vertexPropsAgg(raw('owner'))} AS props FROM ${pc}${metaWhere}`, { kind: 'vertex' }, 1);
        case 'id':
          return done(q`SELECT owner AS v FROM ${pc}${metaWhere}`, { kind: 'value' }, 2);
        case 'label':
          return done(q`SELECT ownerLabel AS v FROM ${pc}${metaWhere}`, { kind: 'value' }, 2);
        case 'values': {
          const pe = nodePropScalar(raw('owner'), tail[ti + 1].args[0]);
          const w = metaConds.length ? q` WHERE ${list([...metaConds, predicateSql(pe, undefined)], ' AND ')}` : q` WHERE ${predicateSql(pe, undefined)}`;
          return done(q`SELECT ${pe} AS v FROM ${pc}${w}`, { kind: 'value' }, 2);
        }
        case 'count':
          return done(q`SELECT COUNT(*) AS v FROM ${pc}${metaWhere}`, { kind: 'count' }, 2);
        default:
          throw new Error(`step not implemented after element(): ${after}()`);
      }
    }
    default:
      throw new Error(`step not implemented after properties(): ${next}()`);
  }
}
