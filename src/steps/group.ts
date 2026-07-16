import { q, value, list, empty, type Expression } from '../q.ts';
import { edges, labels, nodes, vertexProperties, edgeProperties } from '../schema.ts';
import {
  tryInlineScalar, scalarProp, labelNameSub, framedPropsCtx, extIdOf, propExtract, predicateSql, elemCtx,
  type ScalarCtx,
} from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, elemRel, withoutCarried, type Carry, type ElementStream } from './context.ts';
import { carryOf, continueLowering, groupColumns, toGroupStream, toMapStream, toPropertyStream, toResultStream, toScalarStream, type GroupStream, type LoweringResult, type MapOf, type PropertyStream, type ScalarStream } from './stream.ts';
import { type Compiled, type ElemShape, type GroupKey, type GroupVal } from '../render.ts';
import { lowerGlobalCount, numericReducerAggregate, type NumericReducer } from './barrier.ts';
import { isElementFoldChild, isScalarChild, isScalarFoldChild, pushChildScope, reuseCurrentFrame, tryCompileElementRowsBeforeFold, tryCompileRowsBeforeReducer, tryCompileScalarRowsBeforeFold, tryCompileScalarValueChild } from './child.ts';

/** Movement heads whose property-group compatibility path can use a correlated
 * neighbourhood reduction, and the scalar reducers that terminate one. */
const MOVES_ROOT = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE']);
const SCALAR_REDUCERS = new Set(['sum', 'min', 'max', 'mean']);

/** Property groups do not have a live ElementStream parent yet, so they explicitly
 * require the narrow inline compatibility path. Element-backed groups never call it. */
const requireInlineScalar = (inner: ReturnType<typeof stepChain>, ctx: ScalarCtx, use: string) => {
  const scalar = tryInlineScalar(inner, ctx);
  if (!scalar) throw new Error(`${use} not supported by typed child lowering or the property compatibility path`);
  return scalar;
};

// ---------- group()/groupCount() (barrier → one Map) ----------

/** Describes the row source a group() folds over: the FROM (rows aliased `n`),
 *  the scalar context for nested key/value sub-traversals, and the element kind. */
export interface GroupSource {
  from: string | Expression;
  ctx: ScalarCtx;
  elem: ElemShape;
  /** A generic child-key result already joined one-to-one with each productive
   * source traverser. When present, buildGroupKey need not parse the traversal. */
  keyExpr?: Expression;
  /** Composite project() key parts compiled independently on one outer origin. */
  keyParts?: readonly { key: string; expr: Expression }[];
  /** Productive rows from a non-reducing scalar value child. Multiple rows per
   * source traverser deliberately remain multiple group-list members. */
  valExpr?: Expression;
  /** A terminal reducer to apply across ALL child rows sharing the final group key,
   * never independently per source parent. */
  valReducer?: 'count' | NumericReducer;
  valMarker?: Expression;
  /** Raw rows folded once per final group key. `valOrder` is parent encounter then
   * child encounter, so folding never relies on incidental join order. */
  valFold?: boolean;
  valOrder?: Expression;
  valElement?: { elem: 'vertex' | 'edge'; ctx: ScalarCtx };
  productiveBy?: boolean;
  /** Present only for an inline element group whose source stream is still live.
   * Stashed cap()/property sources omit it and retain their existing fast paths. */
  parent?: ElementStream;
}

/** Columns that frame one element (vertex/edge/property) under `prefix`. label
 *  rides as a subquery so the FROM needs no labels join. */
function elementSelect(elem: ElemShape, prefix: string, ctx: ScalarCtx, internalId = false): Expression {
  const extId = ctx.extIdExpr ?? ctx.idExpr;
  const rid = internalId ? q`${ctx.idExpr} AS ${`${prefix}_rid`}, ` : empty;
  if (elem === 'edge')
    // Endpoints as external ids (see the __element edge projector).
    return q`${rid}${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${extIdOf(ctx.srcExpr!)} AS ${`${prefix}_src`}, ${extIdOf(ctx.tgtExpr!)} AS ${`${prefix}_tgt`}, ${framedPropsCtx(ctx)} AS ${`${prefix}_props`}`;
  if (elem === 'property')
    return q`${ctx.ownerExpr!} AS ${`${prefix}_owner`}, ${ctx.pkExpr!} AS ${`${prefix}_pk`}, ${ctx.pvExpr!} AS ${`${prefix}_pv`}`;
  return q`${rid}${extId} AS ${`${prefix}_id`}, ${labelNameSub(ctx.labelIdExpr)} AS ${`${prefix}_label`}, ${framedPropsCtx(ctx)} AS ${`${prefix}_props`}`;
}

/** The SQL expr to GROUP BY / frame an element by identity. */
const elementIdExpr = (elem: ElemShape, ctx: ScalarCtx): Expression => elem === 'property' ? ctx.pkExpr! : ctx.idExpr;

interface GroupKeyBuild { desc: GroupKey; cols: Expression; group: string | Expression }
const scalarGroupKey = (productive?: boolean): GroupKey => productive
  ? { kind: 'scalar', productive: true }
  : { kind: 'scalar' };

/** Build the key columns for group(). */
function buildGroupKey(keyArgs: any[] | undefined, src: GroupSource, params: Record<string, any>): GroupKeyBuild {
  if (src.keyExpr) return { desc: scalarGroupKey(src.productiveBy), cols: q`${src.keyExpr} AS gk`, group: 'gk' };
  if (src.keyParts) {
    const cols = src.keyParts.map((part, i) => q`${part.expr} AS ${`k${i}_v`}`);
    return {
      desc: { kind: 'map', parts: src.keyParts.map((part) => ({ key: part.key })) },
      cols: list(cols, ', '),
      group: src.keyParts.map((_, i) => `k${i}_v`).join(', '),
    };
  }
  if (!keyArgs || keyArgs.length === 0) { // bare by() → the element itself is the key
    if (src.elem === 'property') throw new Error('group().by() on a property element is not yet supported');
    return { desc: { kind: 'element', elem: src.elem }, cols: elementSelect(src.elem, 'k', src.ctx, true), group: elementIdExpr(src.elem, src.ctx) };
  }
  const a = keyArgs[0];
  if (typeof a === 'string') { // by('name') — first-under-multi for a node
    const pe = scalarProp(src.ctx, a);
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${pe} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'token' in a) { // by(T.label)/by(T.id)
    const expr = a.token === 'label' ? labelNameSub(src.ctx.labelIdExpr) : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project') { // composite Map key
      if (src.parent) throw new Error('element group project key not supported by generic child lowering');
      const keys = inner[0].args.filter((x: any): x is string => typeof x === 'string');
      const partBys = inner.slice(1);
      if (partBys.some((s) => s.name !== 'by')) throw new Error(`step not implemented in group().by(project): ${partBys.find((s) => s.name !== 'by')!.name}()`);
      if (partBys.length !== keys.length) throw new Error('group().by(project) needs one by() per key');
      const cols: Expression[] = [], group: string[] = [];
      keys.forEach((k, idx) => {
        const nb = partBys[idx].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
        if (!nb) throw new Error('group().by(project(...).by(x)) requires a traversal in each by()');
        const sc = requireInlineScalar(stepChain(nb.nested, params), src.ctx, 'property group composite key');
        cols.push(q`${sc.expr} AS ${`k${idx}_v`}`); group.push(`k${idx}_v`);
      });
      return { desc: { kind: 'map', parts: keys.map((k) => ({ key: k })) }, cols: list(cols, ', '), group: group.join(', ') };
    }
    const sc = requireInlineScalar(inner, src.ctx, 'property group key');
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${sc.expr} AS gk`, group: 'gk' };
  }
  throw new Error('unsupported group().by() key modulator');
}

const GROUP_VALUE_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);

/** Lower generic scalar key/value children and join them back to the original
 * element through ONE shared parent origin. Keys consume `first`; non-reducing
 * values consume `all`; reducers expose their raw productive rows so the final
 * GROUP BY owns the barrier. Nothing in this phase reduces independently per parent. */
function tryLowerGroupChildSource(bys: any[][], src: GroupSource): GroupSource | null {
  const parent = src.parent;
  if (!parent) return null;
  const keyArg = bys[0]?.[0];
  const valArg = bys[1]?.[0];
  const genericKey = keyArg && typeof keyArg === 'object' && 'nested' in keyArg
    && isScalarChild(keyArg.nested, parent.params);
  const keySteps = keyArg && typeof keyArg === 'object' && 'nested' in keyArg
    ? stepChain(keyArg.nested, parent.params)
    : [];
  const projectStep = keySteps[0]?.name === 'project' ? keySteps[0] : undefined;
  const projectBys = projectStep ? keySteps.slice(1) : [];
  const projectKeys = projectStep?.args.filter((x: any): x is string => typeof x === 'string') ?? [];
  const genericProjectKey = !!projectStep
    && projectBys.length === projectKeys.length
    && projectBys.every((step, i) => {
      if (step.name !== 'by') return false;
      const nested = step.args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
      return !!nested && isScalarChild(nested.nested, parent.params);
    });
  const valSteps = valArg && typeof valArg === 'object' && 'nested' in valArg
    ? stepChain(valArg.nested, parent.params)
    : [];
  const genericVal = valSteps.length > 0
    && !GROUP_VALUE_REDUCERS.has(valSteps.at(-1)!.name)
    && isScalarChild(valArg.nested, parent.params);
  const genericReducer = valSteps.length > 0
    && GROUP_VALUE_REDUCERS.has(valSteps.at(-1)!.name)
    && isScalarChild(valArg.nested, parent.params);
  const genericFold = valSteps.at(-1)?.name === 'fold'
    && isScalarFoldChild(valArg.nested, parent.params);
  const genericElementFold = valSteps.at(-1)?.name === 'fold'
    && isElementFoldChild(valArg.nested, parent.params);
  if (!genericKey && !genericProjectKey && !genericVal && !genericReducer && !genericFold && !genericElementFold) return null;

  const outer = pushChildScope(parent);
  const p = outer.seed.rel.as('gp');
  const n = elemRel(parent, 'gn');
  const joins: Expression[] = [];
  let keyExpr: Expression | undefined;
  let keyParts: GroupSource['keyParts'];
  let valExpr: Expression | undefined;
  let valReducer: GroupSource['valReducer'];
  let valMarker: Expression | undefined;
  let valFold = false;
  let valOrder: Expression | undefined;
  let valElement: GroupSource['valElement'];
  if (genericKey) {
    const child = tryCompileScalarValueChild(outer.seed, keyArg.nested, 'first', reuseCurrentFrame(outer.scope, outer.frame));
    if (!child) throw new Error('scalar group key failed after successful shape preflight');
    const c = child.rel.as('gk');
    joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    keyExpr = c.c.v;
  }
  if (genericProjectKey) {
    keyParts = projectKeys.map((key, i) => {
      const nested = projectBys[i].args.find((x: any) => x && typeof x === 'object' && 'nested' in x);
      const child = tryCompileScalarValueChild(outer.seed, nested.nested, 'first', reuseCurrentFrame(outer.scope, outer.frame));
      if (!child) throw new Error('composite group key failed after successful shape preflight');
      const c = child.rel.as(`gkp${i}`);
      joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
      return { key, expr: c.c.v };
    });
  }
  if (genericVal) {
    const child = tryCompileScalarValueChild(outer.seed, valArg.nested, 'all', reuseCurrentFrame(outer.scope, outer.frame));
    if (!child) throw new Error('scalar group value failed after successful shape preflight');
    const c = child.rel.as('gv');
    joins.push(q` JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
  }
  if (genericReducer) {
    const rows = tryCompileRowsBeforeReducer(outer.seed, valArg.nested, reuseCurrentFrame(outer.scope, outer.frame));
    if (!rows) throw new Error('group reducer rows failed after successful shape preflight');
    const c = rows.stream.rel.as('gr');
    const join = rows.reducer === 'count' ? ' LEFT JOIN ' : ' JOIN ';
    joins.push(q`${join}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[rows.stream.encounter!];
    valReducer = rows.reducer;
  }
  if (genericFold) {
    const rows = tryCompileScalarRowsBeforeFold(outer.seed, valArg.nested, reuseCurrentFrame(outer.scope, outer.frame));
    if (!rows) throw new Error('group fold rows failed after successful shape preflight');
    const c = rows.stream.rel.as('gf');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[rows.stream.encounter!];
    valFold = true;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${valMarker}`;
  }
  if (genericElementFold) {
    const rows = tryCompileElementRowsBeforeFold(outer.seed, valArg.nested, reuseCurrentFrame(outer.scope, outer.frame));
    if (!rows) throw new Error('group element fold rows failed after successful shape preflight');
    const c = rows.stream.rel.as('gef');
    const e = (rows.stream.elem === 'edge' ? edges : nodes).as('gev');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]} LEFT JOIN ${e} ON ${e.c.id}=${c.c.id}`);
    valMarker = c.c.id;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${c.c.id}`;
    valElement = { elem: rows.stream.elem === 'edge' ? 'edge' : 'vertex', ctx: elemCtx(e, rows.stream.elem) };
  }
  return {
    from: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${list(joins, '')}`,
    ctx: elemCtx(n, parent.elem),
    elem: parent.elem === 'edge' ? 'edge' : 'vertex',
    keyExpr,
    keyParts,
    valExpr,
    valReducer,
    valMarker,
    valFold,
    valOrder,
    valElement,
    productiveBy: src.productiveBy,
  };
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value can't be aggregated in SQL (props must be
 * framed), so we emit rows ORDER BY the key and the handler folds runs into the Map.
 */
export function lowerGroup(st: Carry, isCount: boolean, bys: any[][], src: GroupSource): GroupStream {
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  src = tryLowerGroupChildSource(bys, src) ?? src;
  const key = buildGroupKey(bys[0], src, st.params);

  let val: GroupVal, valNode: Expression, groupBy = true;
  const valArgs = bys[1];
  if (isCount) { val = { kind: 'count' }; valNode = q`COUNT(*) AS gv`; }
  else if (!valArgs || valArgs.length === 0) { val = { kind: 'elementList', elem: src.elem }; groupBy = false; valNode = elementSelect(src.elem, 'v', src.ctx); }
  else if (src.valReducer === 'count') { val = { kind: 'count' }; valNode = q`COUNT(${src.valMarker!}) AS gv`; }
  else if (src.valReducer) {
    const reduced = numericReducerAggregate(src.valExpr!, src.valReducer);
    val = { kind: 'sum' };
    valNode = q`${reduced.value} AS gv, ${reduced.type} AS gvt`;
  }
  else if (src.valFold) {
    val = { kind: 'list' };
    valNode = q`COALESCE(json_group_array(${src.valExpr!} ORDER BY ${src.valOrder!}) FILTER (WHERE ${src.valMarker!} IS NOT NULL), json('[]')) AS gv`;
  }
  else if (src.valElement) {
    val = { kind: 'elementList', elem: src.valElement.elem };
    groupBy = false;
    valNode = elementSelect(src.valElement.elem, 'v', src.valElement.ctx);
  }
  else if (src.valExpr) { val = { kind: 'scalarList' }; valNode = q`json_group_array(${src.valExpr}) AS gv`; }
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
      else if (names[names.length - 1] === 'fold')
        throw new Error('this group fold shape is not yet supported by typed child lowering');
      else if (src.parent)
        throw new Error('element group value not supported by generic child lowering');
      else if (MOVES_ROOT.has(names[0]) && SCALAR_REDUCERS.has(names[names.length - 1])) {
        // A neighbourhood aggregate — e.g. by(__.bothE().values('weight').mean()).
        // The compatibility inline path reduces the WHOLE chain to one scalar per
        // group key; MAX() just satisfies GROUP BY (each such group is one vertex,
        // so the scalar is constant within it). typeof() carries Int/Long/Double.
        const sc = requireInlineScalar(inner, src.ctx, 'property group neighbourhood reducer');
        val = { kind: 'sum' }; valNode = q`MAX(${sc.expr}) AS gv, typeof(MAX(${sc.expr})) AS gvt`;
      } else if (names[names.length - 1] === 'sum') {
        const sc = requireInlineScalar(inner.slice(0, -1), src.ctx, 'property group sum');
        val = { kind: 'sum' }; valNode = q`SUM(${sc.expr}) AS gv, typeof(SUM(${sc.expr})) AS gvt`; // gvt → Int/Long vs Double
      } else { // scalar projection folded to a list
        const sc = requireInlineScalar(inner, src.ctx, 'property group scalar list');
        val = { kind: 'scalarList' }; valNode = q`json_group_array(${sc.expr}) AS gv`;
      }
    } else throw new Error('unsupported group().by() value modulator');
  }

  const order = src.valElement && src.valOrder ? q`${key.group}, ${src.valOrder}` : key.group;
  const node = q`SELECT ${key.cols}, ${valNode} FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${order}`;
  const rel = st.q.cte(node, groupColumns({ key: key.desc, val }));
  return toGroupStream(withoutCarried(st), rel, key.desc, val);
}

/** Continue from the rich group barrier. Terminal framing consumes the same lowered
 * relation; a supported Column selection derives the narrow entry MapStream without
 * recompiling group semantics based on terminal position. */
export function compileFromGroup(s: GroupStream, steps: PStep[], at: number): LoweringResult {
  const step = steps[at];
  const column = step.name === 'select'
    ? step.args.map((a: any) => a && typeof a === 'object' && a.column).find((c: any) => c === 'keys' || c === 'values')
    : undefined;
  if (!column) throw new Error(`${step.name}() on a group value not yet supported`);

  const g = s.rel.as('g');
  let mk: Expression, keyOf: MapOf;
  if (s.key.kind === 'scalar') { mk = g.c.gk; keyOf = { kind: 'scalar' }; }
  else if (s.key.kind === 'element') {
    mk = g.c.k_rid;
    keyOf = { kind: 'elem', elem: s.key.elem === 'edge' ? 'edge' : 'node' };
  } else throw new Error('select(Column) over a composite project() group key not yet supported');

  let mv: Expression, valOf: MapOf;
  if (s.val.kind === 'count') { mv = g.c.gv; valOf = { kind: 'scalar', as: 'long' }; }
  else if (s.val.kind === 'sum') { mv = g.c.gv; valOf = { kind: 'scalar' }; }
  else if (s.val.kind === 'list') { mv = g.c.gv; valOf = { kind: 'list', of: { kind: 'scalar' } }; }
  else if (s.val.kind === 'elementList' || s.val.kind === 'elementLast')
    throw new Error('select(Column) over a group of element values not yet supported');
  else throw new Error('select(Column) over this rich group value layout not yet supported');

  const where = s.key.kind === 'scalar' && !s.key.productive ? q` WHERE ${g.c.gk} IS NOT NULL` : empty;
  const rel = s.q.cte(q`SELECT ${mk} AS mk, ${mv} AS mv FROM ${g}${where}`, ['mk', 'mv']);
  return continueLowering(toMapStream(carryOf(s), rel, keyOf, valOf), at);
}

// ---------- properties() ----------

const PROPERTY_PAYLOAD = ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pmeta'] as const;

/** properties()/properties(keys) is a genuine shape transition. The property row
 * stays relational so filters and projections can consume it one step at a time. */
export function lowerProperties(st: ElementStream, step: PStep): PropertyStream {
  const keys = step.args.filter((a): a is string => typeof a === 'string');
  const n = elemRel(st);
  const p = st.rel.as('p');
  const l = labels.as('l');
  // Node: the property stream IS the vertex_properties rows (one per instance, so a
  // multi-valued key yields several) — vpid is the real VertexProperty id, pmeta its
  // meta bag. Edge: the edge_properties rows (edge Property has no id/meta/multi, so
  // vpid/pmeta are NULL — one row per (edge,key)).
  let propBody: Expression;
  if (st.elem === 'edge') {
    const ep = edgeProperties.as('ep');
    const keyFilter: Expression = keys.length ? q` AND ${ep.c.key} IN (${list(keys.map(value), ',')})` : empty;
    propBody = q`SELECT NULL AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${ep.c.key} AS pk, ${ep.c.value} AS pv, NULL AS pmeta${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label} JOIN ${ep} ON ${ep.c.edge}=${n.c.id}${keyFilter}`;
  } else {
    const vp = vertexProperties.as('vp');
    const keyFilter: Expression = keys.length ? q` AND ${vp.c.key} IN (${list(keys.map(value), ',')})` : empty;
    propBody = q`SELECT ${vp.c.id} AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${vp.c.key} AS pk, ${vp.c.value} AS pv, json(${vp.c.meta}) AS pmeta${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label} JOIN ${vp} ON ${vp.c.node}=${n.c.id}${keyFilter}`;
  }
  const rel = st.q.cte(propBody, [...PROPERTY_PAYLOAD, ...carriedCols(st.carried)]);
  return toPropertyStream(carryOf(st), rel, st.elem);
}

const propertyCtx = (s: PropertyStream): ScalarCtx => {
  const p = s.rel.as('p');
  return {
    elem: 'property', idExpr: p.c.owner,
    labelIdExpr: q`(SELECT label FROM nodes WHERE id=${p.c.owner})`,
    ownerExpr: p.c.owner, pkExpr: p.c.pk, pvExpr: p.c.pv,
  };
};

function filterProperty(s: PropertyStream, step: PStep): PropertyStream {
  const p = s.rel.as('p');
  let test: Expression;
  if (step.name === 'has') {
    const [mk, mv] = step.args;
    if (typeof mk !== 'string') throw new Error('properties().has() requires a meta-property key');
    test = predicateSql(propExtract(p.c.pmeta, mk).expr, step.args.length > 1 ? mv : undefined);
  } else if (step.name === 'hasKey') test = predicateSql(p.c.pk, step.args[0]);
  else test = predicateSql(p.c.pv, step.args[0]);
  const rel = s.q.cte(
    q`SELECT ${list(PROPERTY_PAYLOAD.map((c) => p.c[c]), ', ')}${carryFrag(s.carried, p)} FROM ${p} WHERE ${test}`,
    [...PROPERTY_PAYLOAD, ...carriedCols(s.carried)],
  );
  return toPropertyStream(carryOf(s), rel, s.ownerElem);
}

function propertyScalar(s: PropertyStream, col: 'vpid' | 'pk' | 'pv'): ScalarStream {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT ${p.c[col]} AS v${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel);
}

/** Consume a PropertyStream. Only property-specific operations live here; once a
 * step changes shape it re-enters the same root dispatcher as every other stream. */
export function compileFromProperty(s: PropertyStream, steps: PStep[], at: number): LoweringResult {
  const step = steps[at];

  if (step.name === 'has' || step.name === 'hasKey' || step.name === 'hasValue')
    return continueLowering(filterProperty(s, step), at + 1);

  if (step.name === 'key' || step.name === 'value' || step.name === 'id') {
    const col = step.name === 'key' ? 'pk' : step.name === 'value' ? 'pv' : 'vpid';
    return continueLowering(propertyScalar(s, col), at + 1);
  }

  if (step.name === 'count') return continueLowering(lowerGlobalCount(s), at + 1);

  if (step.name === 'group' || step.name === 'groupCount') {
    const ctx = propertyCtx(s);
    const src: GroupSource = { from: s.rel.as('p'), ctx, elem: 'property', productiveBy: step.productiveBy };
    const isCount = step.name === 'groupCount';
    return continueLowering(lowerGroup(s, isCount, step.bys ?? [], src), at + 1);
  }

  if (step.name === 'valueMap') {
    if (at + 1 < steps.length) throw new Error(`step not implemented after properties().valueMap(): ${steps[at + 1].name}()`);
    const p = s.rel.as('p');
    return continueLowering(toResultStream(s.q, q`SELECT ${p.c.pmeta} AS meta FROM ${p}`, { kind: 'metaMap' }), at + 1);
  }

  if (step.name === 'properties') {
      if (at + 1 < steps.length) throw new Error(`step not implemented after properties().properties(): ${steps[at + 1].name}()`);
      const mkeys = step.args.filter((a): a is string => typeof a === 'string');
      const mkeyFilter = mkeys.length ? q` WHERE je.key IN (${list(mkeys.map(value), ',')})` : empty;
      const p = s.rel.as('p');
      return continueLowering(toResultStream(s.q, q`SELECT je.key AS mk, je.value AS mv FROM ${p}, json_each(COALESCE(${p.c.pmeta}, '{}')) je${mkeyFilter}`, { kind: 'metaProperty' }), at + 1);
  }

  if (step.name === 'element') {
    const p = s.rel.as('p');
    const rel = s.q.cte(
      q`SELECT ${p.c.owner} AS id${carryFrag(s.carried, p)} FROM ${p}`,
      ['id', ...carriedCols(s.carried)],
    );
    const out: ElementStream = { ...carryOf(s), kind: 'elements', rel, elem: s.ownerElem };
    return continueLowering(out, at + 1);
  }

  throw new Error(`step not implemented after properties(): ${step.name}()`);
}
