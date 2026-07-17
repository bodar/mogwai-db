import { q, raw, value, list, empty, type Expression, type Relation } from '../q.ts';
import { edges, labels, nodes, vertexProperties, edgeProperties } from '../schema.ts';
import {
  scalarProp, labelNameSub, framedPropsCtx, extIdOf, propExtract, predicateSql, elemCtx, valueMapProps, dirsFor,
  storedValueExpr, type ScalarCtx,
} from '../plan.ts';
import { stepChain } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, carriedWith, elemRel, withoutCarried, type Carry, type ElementStream } from './context.ts';
import { carryOf, continueLowering, dispatchShapeTail, groupColumns, toGroupStream, toMapStream, toPropertyStream, toResultStream, toScalarStream, type GroupStream, type LoweringResult, type MapOf, type MapStream, type PropertyStream, type ScalarStream, type ShapeTailFn } from './stream.ts';
import { type Compiled, type ElemShape, type GroupKey, type GroupVal } from '../render.ts';
import { lowerGlobalCount, numericReducerAggregate, type NumericReducer } from './barrier.ts';
import { childSteps, classifyCountChild, classifyElementChildRows, classifyScalarChildRows, pushChildScope, reuseCurrentFrame, tryCompileElementImplicitFoldRows, tryCompileElementRowsBeforeFold, tryCompileRowsBeforeReducer, tryCompileScalarRowsBeforeFold, tryCompileScalarValueChild, type ChildParent } from './child.ts';

/** The scalar reducers that terminate a numeric neighbourhood reduction (reused by the
 * nested-MAP group's inner reduce). */
const SCALAR_REDUCERS = new Set(['sum', 'min', 'max', 'mean']);

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
  /** The live parent traverser stream the group folds over — an element (node/edge) OR
   * a property (properties().group()). Its by() sub-traversals lower through the generic
   * child seam (tryLowerGroupChildSource). Only stashed cap() group sources omit it. */
  parent?: ChildParent;
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
    // A VertexProperty's T.label is its key (pk); its T.id is vpid (ctx.idExpr). For an
    // element, T.label resolves the interned label id to its name.
    const expr = a.token === 'label'
      ? (src.elem === 'property' ? src.ctx.pkExpr! : labelNameSub(src.ctx.labelIdExpr))
      : a.token === 'id' ? src.ctx.idExpr : null;
    if (!expr) throw new Error(`group().by(T.${a.token}) not yet supported`);
    return { desc: scalarGroupKey(src.productiveBy), cols: q`${expr} AS gk`, group: 'gk' };
  }
  if (a && typeof a === 'object' && 'nested' in a) {
    // A traversal key lowers through the generic child seam (tryLowerGroupChildSource →
    // keyExpr/keyParts). Reaching here means it did not — a genuine deferral, not an
    // inline reader fallback.
    const inner = stepChain(a.nested, params);
    if (inner[0]?.name === 'project')
      throw new Error('group().by(project(...)) composite key not supported by generic child lowering');
    throw new Error('group().by(traversal) key not supported by generic child lowering');
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
  // The child-body vocabulary depends on the parent SHAPE: an element parent's children
  // are movement/filter/values (isScalarChild); a property parent's children are
  // key()/value()/element().… (isPropertyScalarChild). Element-valued (fold) children are
  // element-parent-only — a property has no adjacency to collect.
  const isProp = parent.kind === 'property';
  const pk = isProp ? 'property' : 'element';
  const isByArg = (a: any) => a && typeof a === 'object' && 'nested' in a;
  // Shape gates classify the NORMALIZED child body — the exact body tryCompile* compiles —
  // so gating and emit share ONE parse (the body is threaded into emit as preParsed) and
  // the old is*Child re-parse is gone. Raw stepChain still drives STRUCTURE detection
  // (project() head, value terminal), which needs the un-normalized shape.
  const scalarShape = (body: ReturnType<typeof stepChain>) => isProp
    ? classifyScalarChildRows('property', body) !== null
    : body.at(-1)?.name === 'count' ? classifyCountChild(body) !== null : classifyScalarChildRows('element', body) !== null;
  const scalarFoldShape = (body: ReturnType<typeof stepChain>) =>
    body.at(-1)?.name === 'fold' && classifyScalarChildRows(pk, body.slice(0, -1)) !== null;

  const keyArg = bys[0]?.[0];
  const valArg = bys[1]?.[0];
  const keySteps = isByArg(keyArg) ? stepChain(keyArg.nested, parent.params) : [];
  const keyBody = isByArg(keyArg) ? childSteps(keyArg.nested, parent.params) : [];
  const valSteps = isByArg(valArg) ? stepChain(valArg.nested, parent.params) : [];
  const valBody = isByArg(valArg) ? childSteps(valArg.nested, parent.params) : [];
  const valTerminal = valSteps.at(-1)?.name;

  const genericKey = isByArg(keyArg) && scalarShape(keyBody);

  const projectStep = keySteps[0]?.name === 'project' ? keySteps[0] : undefined;
  const projectBys = projectStep ? keySteps.slice(1) : [];
  const projectKeys = projectStep?.args.filter((x: any): x is string => typeof x === 'string') ?? [];
  const projectByNested = projectBys.map((step) => step.name === 'by'
    ? step.args.find((x: any) => x && typeof x === 'object' && 'nested' in x)?.nested
    : undefined);
  const projectKeyBodies = projectByNested.map((n) => n ? childSteps(n, parent.params) : null);
  const genericProjectKey = !!projectStep
    && projectBys.length === projectKeys.length
    && projectByNested.every((n, i) => !!n && scalarShape(projectKeyBodies[i]!));

  const genericVal = valSteps.length > 0
    && !GROUP_VALUE_REDUCERS.has(valTerminal!)
    && scalarShape(valBody);
  const genericReducer = valSteps.length > 0
    && GROUP_VALUE_REDUCERS.has(valTerminal!)
    && scalarShape(valBody);
  const genericFold = valTerminal === 'fold' && scalarFoldShape(valBody);
  const genericElementFold = !isProp && valTerminal === 'fold'
    && classifyElementChildRows(valBody, 'fold', false) !== null;
  // An unreduced element value traversal (by(__.out()), by(__.out().order())) collects
  // into a list — TinkerPop's implicit fold. Same relational path as genericElementFold.
  const genericElementImplicitFold = !isProp && !genericElementFold
    && valSteps.length > 0
    && classifyElementChildRows(valBody, undefined, false) !== null;
  if (!genericKey && !genericProjectKey && !genericVal && !genericReducer && !genericFold && !genericElementFold && !genericElementImplicitFold) return null;

  const outer = pushChildScope(parent);
  const p = outer.seed.rel.as('gp');
  const joins: Expression[] = [];
  let keyExpr: Expression | undefined;
  let keyParts: GroupSource['keyParts'];
  let valExpr: Expression | undefined;
  let valReducer: GroupSource['valReducer'];
  let valMarker: Expression | undefined;
  let valFold = false;
  let valOrder: Expression | undefined;
  let valElement: GroupSource['valElement'];
  const reuse = () => reuseCurrentFrame(outer.scope, outer.frame);
  if (genericKey) {
    const child = tryCompileScalarValueChild(outer.seed, keyArg.nested, 'first', reuse(), keyBody)!;
    const c = child.rel.as('gk');
    joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    keyExpr = c.c.v;
  }
  if (genericProjectKey) {
    keyParts = projectKeys.map((key, i) => {
      const child = tryCompileScalarValueChild(outer.seed, projectByNested[i], 'first', reuse(), projectKeyBodies[i]!)!;
      const c = child.rel.as(`gkp${i}`);
      joins.push(q`${src.productiveBy ? ' LEFT JOIN ' : ' JOIN '}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
      return { key, expr: c.c.v };
    });
  }
  if (genericVal) {
    const child = tryCompileScalarValueChild(outer.seed, valArg.nested, 'all', reuse(), valBody)!;
    const c = child.rel.as('gv');
    joins.push(q` JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
  }
  if (genericReducer) {
    const rows = tryCompileRowsBeforeReducer(outer.seed, valArg.nested, reuse(), valBody)!;
    const c = rows.stream.rel.as('gr');
    const join = rows.reducer === 'count' ? ' LEFT JOIN ' : ' JOIN ';
    joins.push(q`${join}${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[rows.stream.encounter!];
    valReducer = rows.reducer;
  }
  if (genericFold) {
    const rows = tryCompileScalarRowsBeforeFold(outer.seed, valArg.nested, reuse(), valBody)!;
    const c = rows.stream.rel.as('gf');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]}`);
    valExpr = c.c.v;
    valMarker = c.c[rows.stream.encounter!];
    valFold = true;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${valMarker}`;
  }
  if (genericElementFold || genericElementImplicitFold) {
    const rows = (genericElementFold
      ? tryCompileElementRowsBeforeFold(outer.seed, valArg.nested, reuse(), valBody)
      : tryCompileElementImplicitFoldRows(outer.seed, valArg.nested, reuse(), valBody))!;
    const c = rows.stream.rel.as('gef');
    const e = (rows.stream.elem === 'edge' ? edges : nodes).as('gev');
    joins.push(q` LEFT JOIN ${c} ON ${c.c[outer.frame.ordinal]}=${p.c[outer.frame.ordinal]} LEFT JOIN ${e} ON ${e.c.id}=${c.c.id}`);
    valMarker = c.c.id;
    valOrder = q`${p.c[outer.frame.ordinal]}, ${c.c.id}`;
    valElement = { elem: rows.stream.elem === 'edge' ? 'edge' : 'vertex', ctx: elemCtx(e, rows.stream.elem) };
  }
  const common = { keyExpr, keyParts, valExpr, valReducer, valMarker, valFold, valOrder, valElement, productiveBy: src.productiveBy };
  // Property parent: the pushed domain `p` already carries owner/pk/pv, so the source is
  // `p` itself (plus the child joins) — no element table to rejoin. Element parent rejoins
  // nodes/edges `n` on the domain id so key/value ctx reads its columns.
  if (parent.kind === 'property')
    return { from: q`${p}${list(joins, '')}`, ctx: propertyCtx(p), elem: 'property', ...common };
  const n = elemRel(parent, 'gn');
  return {
    from: q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id}${list(joins, '')}`,
    ctx: elemCtx(n, parent.elem),
    elem: parent.elem === 'edge' ? 'edge' : 'vertex',
    ...common,
  };
}

/**
 * group()/groupCount(): fold the whole stream into one Map. Dual-path (locked
 * decision #3): a scalar-reducing value (count/sum) or scalar list becomes a SQL
 * GROUP BY aggregate; an element value can't be aggregated in SQL (props must be
 * framed), so we emit rows ORDER BY the key and the handler folds runs into the Map.
 */
/** Nested-MAP group value: group().by(k).by(__.<movement>.groupCount()/group().by(ik)
 *  .by(__.values(x).<reduce>())). An unreduced inner group is a Map per outer key.
 *  Compiled as a TWO-LEVEL aggregation reusing the ordinary key/reduce machinery:
 *  lvl1 groups the outer members' movement-expansion by (outerKey, innerKey) and reduces;
 *  the result json_group_object()s each outer key's (innerKey→value) pairs into one Map.
 *  Returns null (fall through) for shapes not yet covered — never a support-definer throw. */
function tryLowerNestedMapGroup(st: Carry, isCount: boolean, bys: any[][], src: GroupSource): GroupStream | null {
  if (isCount || !src.parent) return null;
  const valArg = bys[1]?.[0];
  if (!valArg || typeof valArg !== 'object' || !('nested' in valArg)) return null;
  const vsteps = childSteps(valArg.nested, st.params);
  const gi = vsteps.findIndex((s) => s.name === 'group' || s.name === 'groupCount');
  if (gi < 0 || gi !== vsteps.length - 1) return null; // inner group must terminate the value
  const innerGroup = vsteps[gi] as PStep;
  const move = vsteps.slice(0, gi);
  const innerBys: any[][] = innerGroup.bys ?? [];
  const innerKeyArg = innerBys[0]?.[0];

  // Outer key — scalar/token only (nested-map element keys deferred).
  const outerKey = buildGroupKey(bys[0], src, st.params);
  if (outerKey.desc.kind !== 'scalar') return null;

  // Movement expansion off the outer element (aliased `n` in src.from) → the inner
  // element rows + how to read the inner key. `properties()` rows ARE VertexProperties,
  // whose T.label is the property key; edge movement joins edges for elemCtx-based keys.
  const nId = raw('n.id');
  let join: Expression;
  let ik: Expression | null = null;      // T.label inner key
  let innerCtx: ScalarCtx | null = null; // for a property-key / values() inner key/reduce
  const head = move[0]?.name;
  const bareMove = move.length === 1 && ((move[0] as any).args ?? []).length === 0;
  if (bareMove && head === 'properties') {
    const vp = vertexProperties.as('vpn');
    join = q` JOIN ${vp} ON ${vp.c.node}=${nId}`;
    if (innerKeyArg && typeof innerKeyArg === 'object' && innerKeyArg.token === 'label') ik = vp.c.key;
  } else if (bareMove && (head === 'outE' || head === 'inE' || head === 'bothE')) {
    const ie = edges.as('ie');
    const dirs = dirsFor(head === 'outE' ? 'out' : head === 'inE' ? 'in' : 'both');
    join = q` JOIN ${ie} ON (${list(dirs.map(([from]) => q`${ie.c[from]}=${nId}`), ' OR ')})`;
    innerCtx = elemCtx(ie, 'edge');
    if (innerKeyArg && typeof innerKeyArg === 'object' && innerKeyArg.token === 'label') ik = labelNameSub(ie.c.label);
  } else return null;
  if (!ik && innerCtx && typeof innerKeyArg === 'string') ik = scalarProp(innerCtx, innerKeyArg);
  if (!ik) return null; // unsupported inner key shape

  // Inner reduce: groupCount → COUNT(*); group().by().by(__.values(x).<reduce>()).
  let iv: Expression, innerVal: 'count' | 'number';
  if (innerGroup.name === 'groupCount') { iv = q`COUNT(*)`; innerVal = 'count'; }
  else {
    const reduceArg = innerBys[1]?.[0];
    if (!reduceArg || typeof reduceArg !== 'object' || !('nested' in reduceArg) || !innerCtx) return null;
    const rsteps = childSteps(reduceArg.nested, st.params);
    const reducer = rsteps.at(-1)?.name;
    if (rsteps.length !== 2 || rsteps[0].name !== 'values' || !SCALAR_REDUCERS.has(reducer!)) return null;
    iv = numericReducerAggregate(scalarProp(innerCtx, rsteps[0].args[0]), reducer as NumericReducer).value;
    innerVal = 'number';
  }

  const lvl1 = st.q.cte(
    q`SELECT ${outerKey.cols}, ${ik} AS ik, ${iv} AS iv FROM ${src.from}${join} GROUP BY ${outerKey.group}, ik`,
    ['gk', 'ik', 'iv'],
  );
  const l = lvl1.as('l');
  const rel = st.q.cte(
    q`SELECT ${l.c.gk} AS gk, json_group_object(${l.c.ik}, ${l.c.iv}) AS gv FROM ${l} WHERE ${l.c.ik} IS NOT NULL GROUP BY ${l.c.gk}`,
    ['gk', 'gv'],
  );
  return toGroupStream(withoutCarried(st), rel, outerKey.desc, { kind: 'nestedMap', innerVal });
}

export function lowerGroup(st: Carry, isCount: boolean, bys: any[][], src: GroupSource): GroupStream {
  if (bys.length > 2) throw new Error('group() with more than two by() modulators not yet supported');
  const nestedMap = tryLowerNestedMapGroup(st, isCount, bys, src);
  if (nestedMap) return nestedMap;
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
      else
        // A scalar/reducer value traversal lowers through the generic child seam
        // (tryLowerGroupChildSource → valExpr/valReducer/valFold); reaching here means it
        // did not — a genuine deferral, not an inline reader fallback.
        throw new Error('group().by(traversal) value not supported by generic child lowering');
    } else throw new Error('unsupported group().by() value modulator');
  }

  const order = src.valElement && src.valOrder ? q`${key.group}, ${src.valOrder}` : key.group;
  const node = q`SELECT ${key.cols}, ${valNode} FROM ${src.from} ${groupBy ? 'GROUP BY' : 'ORDER BY'} ${order}`;
  const rel = st.q.cte(node, groupColumns({ key: key.desc, val }));
  return toGroupStream(withoutCarried(st), rel, key.desc, val);
}

/**
 * valueMap()/elementMap() as a re-enterable, per-element MapStream — one map per input
 * element (an origin ordinal `o0`, unlike group's single global map). Each property is a
 * `(mk=key, mv=value-list)` entry row tagged with its element origin; compileFromMap then
 * aggregates per origin. Reached ONLY with a follower — terminal valueMap keeps the
 * unchanged buildProjection ResultStream. Tokens (valueMap(true)/id/label) and a
 * carried alias/path/branch/sack state defer (the origin ordinal would collide / tokens
 * need extra entry keys).
 */
export function lowerValueMap(st: ElementStream, proj: PStep): MapStream {
  if (proj.name === 'elementMap') throw new Error('elementMap() re-entry not yet supported');
  if (proj.args.includes(true)) throw new Error('valueMap(true)/token re-entry not yet supported');
  if (st.carried.aliases.size || st.carried.path || st.carried.origins.length || st.carried.sack || st.carried.fromV)
    throw new Error('valueMap() re-entry carrying as()/path()/branch/sack state not yet supported');
  const keys = proj.args.filter((a: any) => typeof a === 'string') as string[];
  const p = st.rel.as('p');
  const n = elemRel(st);
  const l = labels.as('l');
  const vlJoin = q`${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`;
  // One row per element: its {key:[values]} JSON + a per-element origin ordinal.
  const base = st.q.cte(q`SELECT ROW_NUMBER() OVER () AS o0, ${valueMapProps(n, st.elem)} AS props FROM ${vlJoin}`, ['o0', 'props']);
  const b = base.as('b');
  const keyFilter = keys.length ? q` WHERE je.key IN (${list(keys.map((k) => value(k)), ', ')})` : empty;
  // props values are self-describing {t,v} nodes (plan.ts propNodeExpr, for whole-map framing).
  // This re-entry treats a valueMap value list as BARE scalars (select(Column.values) feeds the
  // untyped list substrate — set-ops/order/conjoin), so unwrap each element to its `v` payload
  // (element-type re-tagging through select(values) is deferred, matching the list-op scope).
  const mv = q`(SELECT json_group_array(x.value ->> '$.v' ORDER BY x.key) FROM json_each(je.value) x)`;
  const rel = st.q.cte(q`SELECT je.key AS mk, ${mv} AS mv, ${b.c.o0} AS o0 FROM ${b}, json_each(${b.c.props}) je${keyFilter}`, ['mk', 'mv', 'o0']);
  const carry: Carry = { ...carryOf(st), carried: carriedWith(st.carried, { origins: ['o0'] }) };
  // key = a bare string; value = the property's value list (json array per entry).
  return toMapStream(carry, rel, { kind: 'scalar' }, { kind: 'list', of: { kind: 'scalar' } });
}

/** groupCount() over a SCALAR value stream — a barrier grouping by the value itself:
 * V().values('name').groupCount() → Map{name: count}. Bare form only (a by()/name-key
 * defers to the caller). null keys ARE counted (groupCount productive); a typed scalar's
 * compile-time tag (asNumber(BYTE).groupCount()) frames the key, else inference. */
export function lowerScalarGroupCount(s: ScalarStream): GroupStream {
  const c = s.rel.as('c');
  const rel = s.q.cte(q`SELECT ${c.c.v} AS gk, COUNT(*) AS gv FROM ${c} GROUP BY ${c.c.v}`, ['gk', 'gv']);
  return toGroupStream(withoutCarried(carryOf(s)), rel, { kind: 'scalar', productive: true, as: s.as }, { kind: 'count' });
}

/** Continue from the rich group barrier. Terminal framing consumes the same lowered
 * relation; a supported Column selection derives the narrow entry MapStream without
 * recompiling group semantics based on terminal position. */
export function compileFromGroup(s: GroupStream, steps: PStep[], at: number): LoweringResult {
  const step = steps[at];
  // is(typeOf(MAP)) — a group IS a Map → identity.
  if (step.name === 'is') {
    const pred = (step.args ?? [])[0];
    const tn = pred && typeof pred === 'object' && pred.op === 'typeOf'
      ? (() => { const a = pred.values?.[0]; return (a && typeof a === 'object' && 'gtype' in a) ? String(a.gtype) : typeof a === 'string' ? a : null; })()
      : null;
    if (tn && tn.toUpperCase() === 'MAP') return continueLowering(s, at + 1);
    throw new Error('is() on a group value supports only is(typeOf(GType.MAP))');
  }
  // count()/count(Scope.local) — the number of map entries (distinct keys). Scope.local
  // on a Map counts its size, same value.
  if (step.name === 'count') {
    if (s.key.kind !== 'scalar') throw new Error('count() over a non-scalar-key group not yet supported');
    const g = s.rel.as('g');
    const rel = s.q.cte(q`SELECT COUNT(DISTINCT ${g.c.gk}) AS v FROM ${g}`, ['v']);
    return continueLowering(toScalarStream(withoutCarried(carryOf(s)), rel, 'long', 'count'), at + 1);
  }
  // unfold() → Map.Entry stream: the SAME (mk,mv) entry rows, but per-entry (a following
  // select(Column.keys/values) projects one row's key/value, not the aggregate).
  if (step.name === 'unfold') {
    const { rel, keyOf, valOf } = deriveGroupEntries(s);
    return continueLowering(toMapStream(carryOf(s), rel, keyOf, valOf, true), at + 1);
  }
  const column = step.name === 'select'
    ? step.args.map((a: any) => a && typeof a === 'object' && a.column).find((c: any) => c === 'keys' || c === 'values')
    : undefined;
  if (!column) throw new Error(`${step.name}() on a group value not yet supported`);
  const { rel, keyOf, valOf } = deriveGroupEntries(s);
  return continueLowering(toMapStream(carryOf(s), rel, keyOf, valOf), at);
}

/** Derive the `(mk, mv)` entry relation of a rich group barrier — shared by the
 * whole-map select(Column) consumer (aggregate) and the per-entry unfold() consumer. */
function deriveGroupEntries(s: GroupStream): { rel: Relation; keyOf: MapOf; valOf: MapOf } {
  const g = s.rel.as('g');
  let mk: Expression, keyOf: MapOf;
  if (s.key.kind === 'scalar') { mk = g.c.gk; keyOf = { kind: 'scalar', as: s.key.as }; }
  else if (s.key.kind === 'element') {
    mk = g.c.k_rid;
    keyOf = { kind: 'elem', elem: s.key.elem === 'edge' ? 'edge' : 'node' };
  } else throw new Error('select(Column)/unfold() over a composite project() group key not yet supported');

  let mv: Expression, valOf: MapOf;
  if (s.val.kind === 'count') { mv = g.c.gv; valOf = { kind: 'scalar', as: 'long' }; }
  else if (s.val.kind === 'sum') { mv = g.c.gv; valOf = { kind: 'scalar' }; }
  else if (s.val.kind === 'list' || s.val.kind === 'scalarList') { mv = g.c.gv; valOf = { kind: 'list', of: { kind: 'scalar' } }; }
  else if (s.val.kind === 'elementList' || s.val.kind === 'elementLast')
    throw new Error('select(Column)/unfold() over a group of element values not yet supported');
  else throw new Error('select(Column)/unfold() over this rich group value layout not yet supported');

  const where = s.key.kind === 'scalar' && !s.key.productive ? q` WHERE ${g.c.gk} IS NOT NULL` : empty;
  const rel = s.q.cte(q`SELECT ${mk} AS mk, ${mv} AS mv FROM ${g}${where}`, ['mk', 'mv']);
  return { rel, keyOf, valOf };
}

// ---------- properties() ----------

const PROPERTY_PAYLOAD = ['vpid', 'owner', 'ownerLabel', 'pk', 'pv', 'pvtype', 'pmeta'] as const;

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
    propBody = q`SELECT NULL AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${ep.c.key} AS pk, ${storedValueExpr(ep.c.value, ep.c.vtype)} AS pv, ${ep.c.vtype} AS pvtype, NULL AS pmeta${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label} JOIN ${ep} ON ${ep.c.edge}=${n.c.id}${keyFilter}`;
  } else {
    const vp = vertexProperties.as('vp');
    const keyFilter: Expression = keys.length ? q` AND ${vp.c.key} IN (${list(keys.map(value), ',')})` : empty;
    propBody = q`SELECT ${vp.c.id} AS vpid, ${n.c.id} AS owner, ${l.c.name} AS ownerLabel, ${vp.c.key} AS pk, ${storedValueExpr(vp.c.value, vp.c.vtype)} AS pv, ${vp.c.vtype} AS pvtype, json(${vp.c.meta}) AS pmeta${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label} JOIN ${vp} ON ${vp.c.node}=${n.c.id}${keyFilter}`;
  }
  const rel = st.q.cte(propBody, [...PROPERTY_PAYLOAD, ...carriedCols(st.carried)]);
  return toPropertyStream(carryOf(st), rel, st.elem);
}

/** A property framing/scalar ctx built from an (already-aliased) PropertyStream/domain
 *  relation. `idExpr` is the VertexProperty's OWN id (vpid) — its Gremlin T.id — NOT the
 *  owner; `pk` is its T.label; `pmeta` backs by(String) meta-property reads. owner/pk/pv
 *  frame the VertexProperty as a group value. (labelIdExpr resolves the owner's label,
 *  retained only for the element-framing helpers; a property's T.label is pk, see
 *  buildGroupKey.) */
const propertyCtx = (p: Relation): ScalarCtx => ({
  elem: 'property', idExpr: p.c.vpid,
  labelIdExpr: q`(SELECT label FROM nodes WHERE id=${p.c.owner})`,
  ownerExpr: p.c.owner, pkExpr: p.c.pk, pvExpr: p.c.pv, metaExpr: p.c.pmeta,
});

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
  // In a child scope (a property-group by(__.key()/value())) the correlated cardinality
  // policy needs a per-origin encounter marker, exactly as lowerScalarProjection mints for
  // element().values(). key()/value() are 1:1 with the property, so any deterministic order
  // suffices. At root (no live origin) the projection stays unchanged.
  const origin = s.carried.origins.at(-1);
  const enc = origin ? q`, ROW_NUMBER() OVER (PARTITION BY ${p.c[origin]} ORDER BY ${p.c[origin]}) AS encounter` : empty;
  const rel = s.q.cte(
    q`SELECT ${p.c[col]} AS v${enc}${carryFrag(s.carried, p)} FROM ${p}`,
    ['v', ...(origin ? ['encounter'] : []), ...carriedCols(s.carried)],
  );
  return toScalarStream(carryOf(s), rel, undefined, 'value', origin ? 'encounter' : undefined);
}

/** Consume a PropertyStream. Only property-specific operations live here; once a
 * step changes shape it re-enters the same root dispatcher as every other stream. */
const PROPERTY_SCALAR_COL = { key: 'pk', value: 'pv', id: 'vpid' } as const;

const propertyFilter: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(filterProperty(s, step), at + 1);

const propertyScalarStep: ShapeTailFn<PropertyStream> = (s, step, _steps, at) =>
  continueLowering(propertyScalar(s, PROPERTY_SCALAR_COL[step.name as keyof typeof PROPERTY_SCALAR_COL]), at + 1);

const propertyGroup: ShapeTailFn<PropertyStream> = (s, step, _steps, at) => {
  // A live property parent — its by() sub-traversals lower through the generic child
  // seam (tryLowerGroupChildSource), exactly as an element group does.
  const p = s.rel.as('p');
  const src: GroupSource = { from: p, ctx: propertyCtx(p), elem: 'property', parent: s, productiveBy: step.productiveBy };
  const isCount = step.name === 'groupCount';
  return continueLowering(lowerGroup(s, isCount, step.bys ?? [], src), at + 1);
};

const propertyValueMap: ShapeTailFn<PropertyStream> = (s, _step, steps, at) => {
  if (at + 1 < steps.length) throw new Error(`step not implemented after properties().valueMap(): ${steps[at + 1].name}()`);
  const p = s.rel.as('p');
  return continueLowering(toResultStream(s.q, q`SELECT ${p.c.pmeta} AS meta FROM ${p}`, { kind: 'metaMap' }), at + 1);
};

const propertyMetaProperties: ShapeTailFn<PropertyStream> = (s, step, steps, at) => {
  if (at + 1 < steps.length) throw new Error(`step not implemented after properties().properties(): ${steps[at + 1].name}()`);
  const mkeys = step.args.filter((a): a is string => typeof a === 'string');
  const mkeyFilter = mkeys.length ? q` WHERE je.key IN (${list(mkeys.map(value), ',')})` : empty;
  const p = s.rel.as('p');
  return continueLowering(toResultStream(s.q, q`SELECT je.key AS mk, je.value AS mv FROM ${p}, json_each(COALESCE(${p.c.pmeta}, '{}')) je${mkeyFilter}`, { kind: 'metaProperty' }), at + 1);
};

const propertyElement: ShapeTailFn<PropertyStream> = (s, _step, _steps, at) => {
  const p = s.rel.as('p');
  const rel = s.q.cte(
    q`SELECT ${p.c.owner} AS id${carryFrag(s.carried, p)} FROM ${p}`,
    ['id', ...carriedCols(s.carried)],
  );
  const out: ElementStream = { ...carryOf(s), kind: 'elements', rel, elem: s.ownerElem };
  return continueLowering(out, at + 1);
};

const PROPERTY_TAIL = new Map<string, ShapeTailFn<PropertyStream>>([
  ['has', propertyFilter], ['hasKey', propertyFilter], ['hasValue', propertyFilter],
  ['key', propertyScalarStep], ['value', propertyScalarStep], ['id', propertyScalarStep],
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['group', propertyGroup], ['groupCount', propertyGroup],
  ['valueMap', propertyValueMap],
  ['properties', propertyMetaProperties],
  ['element', propertyElement],
]);

export function compileFromProperty(s: PropertyStream, steps: PStep[], at: number): LoweringResult {
  return dispatchShapeTail(PROPERTY_TAIL, s, steps, at, () => {
    throw new Error(`step not implemented after properties(): ${steps[at].name}()`);
  });
}
