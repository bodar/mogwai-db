import { isColumnArg, isNested, isPopArg, isTokenArg, stepChain } from '../../../gremlin/frontend.ts';
import { empty, list, q, value, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { PER_ROW, perRowColumnOf, STATIC, UNKNOWN, type ScalarType } from '../../../sql/kernel/render.ts';
import { isLocalScope, SLICE_STEPS, sliceOf, type Slice } from '../../ir/step.ts';
import { type IRStep } from '../../ir/strategies.ts';
import { elemCtx, elementPayload, elemTable, labelNameFor, limitOffset, propScalarFor, predicateSql, propExtract, storedPropFor } from '../../plan/plan.ts';
import { aliasId, aliasPop, aliasPresent, aliasScalar, entryTypeTag, shapeElem } from '../context/alias.ts';
import { aliasElem, aliasIsElement, layoutCols, layoutProjection, scalarTypeFromAlias, type AliasMap, type ElementStream } from '../context/context.ts';
import { continueLowering, dispatchShapeTail, loweringStateOf, recordFieldColumns, toElementStream, toListStream, toRecordStream, toScalarStream, toVariantStream, type ListOf, type LoweringResult, type RecordField, type RecordStream, type ScalarStream, type ShapeTailFn, type Stream } from '../context/stream.ts';
import { globalRowOps, lowerGlobalCount, reprojectRows, aliasCompareRows } from './barrier.ts';
import { byAt, childCtx, childSteps, classifyBy, classifyElementChild, classifyListChild, classifyRecordChildRows, classifyScalarChild, reuseCurrentFrame, ROOT_SCOPE, type ChildFrameStack, type ChildParent, type ChildUse } from './child-shape.ts';
import { applyChildCardinality, lowerElementBody, mintChildEncounter, pushChildScope, tryCompileElementChild, tryCompileListChild, tryCompileScalarValueChild } from './child.ts';
import { emptyElementLike, historyPropertyValues, historyScalarValues, historyValues, popEnd, popIsListResult, selectKeyFromAlias, selectOneFromAlias } from './labelselect.ts';
import { type TailMods } from './projection.ts';

// ---------- select()/project() ----------

/** `select(__.keyTraversal)` is TinkerPop's TraversalSelectStep, not a malformed
 * multi-key SelectStep. A dynamic label requires a runtime alias lookup whose result
 * shape can vary by key; until that uniform lookup substrate exists, reject it here
 * before any record/single-select builder drops the child and renders an empty SELECT. */
function staticSelectKeys(step: IRStep): string[] {
  if (step.name === 'select' && step.args.some(isNested))
    throw new Error('select() with a traversal key not yet supported (needs dynamic alias lookup)');
  return step.args.filter((a): a is string => typeof a === 'string');
}

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  const by = classifyBy(byArgs);
  if (by.kind === 'none') return { sub: 'vertex' }; // no by() / bare by() → the element itself
  if (by.kind === 'key') return { sub: 'value', key: by.key };
  if (by.kind === 'nested') throw new Error('by(traversal) modulator not yet supported');
  throw new Error(`by(T.${by.token}) modulator not yet supported`);
}

/** Re-name a scalar's per-row type column as it enters a wide record field. Static
 * and unknown channels need no physical column but stay explicit in the metadata. */
function recordScalarType(prefix: string, type: ScalarType): ScalarType {
  return type.kind === 'perRow' ? PER_ROW(`${prefix}_vtype`) : type;
}

function scalarRecordField(key: string, prefix: string, type: ScalarType): Extract<RecordField, { sub: 'value' }> {
  return { key, prefix, sub: 'value', type: recordScalarType(prefix, type) };
}

function scalarRecordCols(rel: Relation, prefix: string, type: ScalarType): Expression[] {
  const perRow = perRowColumnOf(type);
  return [
    q`${rel.c.v} AS ${`${prefix}_v`}`,
    ...(perRow ? [q`${rel.c[perRow]} AS ${`${prefix}_vtype`}`] : []),
  ];
}

function storedPropertyRecordField(key: string, prefix: string): Extract<RecordField, { sub: 'value' }> {
  return { key, prefix, sub: 'value', type: PER_ROW(`${prefix}_vtype`) };
}

/** Re-root the current traverser on an element id held in one of its carried alias
 * columns. The row remains the same traverser: aliases/path/origins/sack all survive.
 * Shared with path.ts (the linear-regime position re-root). */
export function reRootElement(st: ElementStream, p: Relation, id: Expression, elem: ElementStream['elem']): ElementStream {
  const rel = st.q.cte(
    q`SELECT ${id} AS id${layoutProjection(st.traverserLayout, p)} FROM ${p}`,
    ['id', ...layoutCols(st.traverserLayout)],
  );
  return { ...st, rel, elem };
}

/** Lower heterogeneous record fields when at least one by() is a shaped child traversal.
 * One outer origin identifies each multiset-distinct input; scalar children use
 * child `first` cardinality while bare by() branches retain the whole source
 * element. Inner joins implement ordinary productive-by semantics: a missing child
 * drops the record row, while a produced SQL NULL remains a real field value. */
function tryLowerTraversalRecord(st: ElementStream, proj: IRStep, keys: string[]): RecordStream | null {
  if ((proj.name !== 'project' && proj.name !== 'select') || !proj.modulators?.length) return null;
  const isProject = proj.name === 'project';
  const productive = proj.productiveBy === true;
  const args = keys.map((_, i) => byAt(proj.modulators, i));
  const specs = args.map((by) => by?.[0]);
  const nested = args.map((by) => { const c = classifyBy(by); return c.kind === 'nested' ? c.nested : null; });
  if (!nested.some(Boolean)) return null; // leave the mature all-direct path untouched
  // Classify each traversal-valued field ONCE (scalar > list > element, matching the emit
  // dispatch order), keeping the parsed body so emit reuses it — no separate is*Child re-parse.
  // The whole ChildPlan rides through, not just its body: the emitters take one argument so a
  // dropped suffix is impossible rather than merely unlikely.
  const recordChildPlan = (n: any) => {
    const s = classifyScalarChild(n, childCtx(st));
    if (s) return { kind: 'scalar' as const, plan: s };
    const l = classifyListChild(n, childCtx(st));
    if (l) return { kind: 'list' as const, plan: l };
    const e = classifyElementChild(n, childCtx(st));
    return e ? { kind: 'element' as const, body: e.body } : null;
  };
  const plans = nested.map((n) => n ? recordChildPlan(n) : null);
  if (specs.some((a, i) => {
    if (nested[i]) return !plans[i];
    if (a === undefined) return false;
    if (typeof a === 'string') return false;
    return !(isProject && isTokenArg(a) && (a.token === 'id' || a.token === 'label'));
  })) return null;

  const outer = pushChildScope(st);
  const branches = specs.map((spec, i) => {
    const prefix = `e${i}`;
    const p = outer.seed.rel.as(`p${i}`);
    const source = isProject
      ? { id: p.c.id, elem: st.elem }
      : (() => {
          const selected = st.traverserLayout.aliases.get(keys[i]);
          if (!selected) throw new Error(`select("${keys[i]}"): no such label — as("${keys[i]}") was not seen`);
          return { id: aliasId(p.c[selected.col], 'last'), elem: aliasElem(selected) };
        })();
    if (nested[i]) {
      const seed = isProject ? outer.seed : reRootElement(outer.seed, p, source.id, source.elem);
      const plan = plans[i]!;
      if (plan.kind === 'scalar') {
        const child = tryCompileScalarValueChild(seed, nested[i], 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.plan);
        if (!child) return null;
        const rel = child.rel.as(`b${i}`);
        const field = scalarRecordField(keys[i], prefix, child.type);
        return {
          rel,
          field,
          cols: scalarRecordCols(rel, prefix, child.type),
        };
      }
      if (plan.kind === 'list') {
        const child = tryCompileListChild(seed, nested[i], reuseCurrentFrame(outer.scope, outer.frame), plan.plan);
        if (!child) return null;
        const rel = child.rel.as(`b${i}`);
        return {
          rel,
          field: { key: keys[i], prefix, sub: 'list' as const, of: child.of },
          cols: [q`${rel.c.list} AS ${`${prefix}_list`}`],
        };
      }
      const child = tryCompileElementChild(seed, nested[i], 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.body);
      // Classification is deliberately pure and reusable, while emission also
      // checks this concrete frame's carried aliases. A mismatch is unsupported
      // child composition, never permission to dereference a missing stream.
      if (!child) return null;
      const cp = child.stream.rel.as(`cp${i}`);
      const n = elemTable(child.stream.elem).as(`n${i}`);
      const payload = elementPayload(elemCtx(n, child.stream.elem), child.stream.elem, '', true);
      const payloadCols = child.stream.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${layoutProjection(child.stream.traverserLayout, cp)} FROM ${cp} JOIN ${n} ON ${n.c.id}=${cp.c.id}`,
        [...payloadCols, ...layoutCols(child.stream.traverserLayout)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: child.stream.elem, nullable: productive || undefined };
      return {
        rel,
        field,
        cols: recordFieldColumns(field).map((name) => q`${rel.c[name.slice(prefix.length + 1)]} AS ${name}`),
      };
    }

    const n = elemTable(source.elem).as(`n${i}`);
    if (spec === undefined) {
      const payload = elementPayload(elemCtx(n, source.elem), source.elem, '', true);
      const payloadCols = source.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${layoutProjection(outer.seed.traverserLayout, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id}`,
        [...payloadCols, ...layoutCols(outer.seed.traverserLayout)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: source.elem };
      return {
        rel,
        field,
        cols: recordFieldColumns(field).map((name) => {
          const source = name.slice(prefix.length + 1);
          return q`${rel.c[source]} AS ${name}`;
        }),
      };
    }
    if (typeof spec === 'string') {
      // The correlated read keys off the source rowid for BOTH element kinds, so no element-table
      // join is needed here — `n` serves the element/token branches around this one.
      const { value: expr, vtype, stored } = storedPropFor(source.id, source.elem, spec);
      const field = storedPropertyRecordField(keys[i], prefix);
      const rel = st.q.cte(
        q`SELECT ${stored} AS v, ${vtype} AS vtype${layoutProjection(outer.seed.traverserLayout, p)} FROM ${p}${productive ? empty : q` WHERE ${predicateSql(expr, undefined)}`}`,
        ['v', 'vtype', ...layoutCols(outer.seed.traverserLayout)],
      ).as(`b${i}`);
      return { rel, field, cols: scalarRecordCols(rel, prefix, PER_ROW('vtype')) };
    }
    const scalar = spec.token === 'label'
      ? labelNameFor(n, source.elem)
      : q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const rel = st.q.cte(
      q`SELECT ${scalar} AS v${layoutProjection(outer.seed.traverserLayout, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id}`,
      ['v', ...layoutCols(outer.seed.traverserLayout)],
    ).as(`b${i}`);
    const type = spec.token === 'label' ? STATIC('string') : UNKNOWN;
    return { rel, field: scalarRecordField(keys[i], prefix, type), cols: scalarRecordCols(rel, prefix, type) };
  });
  // Every classified child must also emit in this parent frame. Returning null
  // lets the normal projection dispatcher issue its established deferral instead
  // of turning a classification/emission mismatch into a raw TypeError.
  if (branches.some((branch) => branch === null)) return null;
  const fields = branches.map((branch) => branch!.field);
  const cols = branches.flatMap((branch) => branch!.cols);
  const first = branches[0]!.rel;
  const domain = outer.seed.rel.as('prd');
  const from = productive ? domain : first;
  const joins = productive
    ? branches.map((branch) => q` LEFT JOIN ${branch!.rel} ON ${branch!.rel.c[outer.frame.ordinal]}=${domain.c[outer.frame.ordinal]}`)
    : branches.slice(1).map((branch) => q` JOIN ${branch!.rel} ON ${branch!.rel.c[outer.frame.ordinal]}=${first.c[outer.frame.ordinal]}`);
  const rel = st.q.cte(
    q`SELECT ${list(cols, ', ')}${layoutProjection(st.traverserLayout, from)} FROM ${from}${list(joins, '')}`,
    [...fields.flatMap(recordFieldColumns), ...layoutCols(st.traverserLayout)],
  );
  return toRecordStream(loweringStateOf(st), rel, fields);
}

/** A one-label select is not a record: it emits the selected traverser directly.
 * Lower it to the ordinary element/scalar stream model so movement, projections and
 * barriers after select() are handled by the common dispatcher. */
export function lowerSingleSelect(st: ElementStream, proj: IRStep): Stream {
  const pop = proj.args.find(isPopArg);
  const popMode = pop?.pop ?? 'last';
  if (proj.args.some(isColumnArg)) throw new Error('select(Column) not yet supported');
  const keys = staticSelectKeys(proj);
  if (keys.length !== 1) throw new Error('lowerSingleSelect requires exactly one label');
  const selected = st.traverserLayout.aliases.get(keys[0]);
  if (!selected) return emptyElementLike(st); // label bound nowhere → drop every traverser
  // A non-last Pop reads the label's history (first/all/mixed); the by()-less forms lower
  // through the shared shape-agnostic resolver. by()-modulated non-last Pop is uncommon.
  const hasNestedBy = !!(proj.modulators?.[0]?.[0] && typeof proj.modulators[0][0] === 'object' && 'nested' in proj.modulators[0][0]);
  if (popMode !== 'last' && !hasNestedBy && !(proj.modulators?.length))
    return selectOneFromAlias(st, proj, keys[0], popMode);
  if (popMode !== 'last') throw new Error(`select(Pop.${popMode}).by(...) not yet supported`);
  const p = st.rel.as('p');
  const productive = proj.productiveBy === true;
  const nested = proj.modulators?.[0]?.[0];
  if (nested && typeof nested === 'object' && 'nested' in nested) {
    if (productive) throw new Error('ProductiveByStrategy with a traversal-valued single select is not yet supported');
    const seed = reRootElement(st, p, aliasId(p.c[selected.col], 'last'), aliasElem(selected));
    // Classify once (pure) → emit reusing the parsed body; each classify guarantees its
    // emitter succeeds, so no preflight/compiler mismatch throw is possible.
    const scalarPlan = classifyScalarChild(nested.nested, childCtx(st));
    if (scalarPlan) {
      const out = tryCompileScalarValueChild(seed, nested.nested, 'first', ROOT_SCOPE, scalarPlan);
      if (out) return out;
    }
    const listPlan = classifyListChild(nested.nested, childCtx(st));
    if (listPlan) return tryCompileListChild(seed, nested.nested, ROOT_SCOPE, listPlan)!;
    const elemPlan = classifyElementChild(nested.nested, childCtx(st));
    if (elemPlan) return tryCompileElementChild(seed, nested.nested, 'first', ROOT_SCOPE, elemPlan.body)!.stream;
    throw new Error('by(traversal) child shape not yet supported');
  }
  const by = byToEntry(proj.modulators?.[0]);
  // A dynamically-bound label (bound inside a branch arm / repeat) may be UNBOUND on some
  // rows (a traverser through an arm that never bound it) → drop those (aliasPresent). A
  // statically-bound linear label is always present, so no guard (same SQL).
  const present = selected.binds === undefined ? aliasPresent(p.c[selected.col]) : null;
  // A VALUE-history label (a scalar bound with as(), e.g. inject(1).as('a')…V().select('a'))
  // reads its value, not an element — the element path (aliasElem) would reject it.
  if (!aliasIsElement(selected)) {
    if (by.sub !== 'vertex' || by.key) throw new Error('select(value-label).by(key) not yet supported (the label holds a value, not an element)');
    const type = scalarTypeFromAlias(selected.scalarType);
    const vtype = perRowColumnOf(type);
    const rel = st.q.cte(
      q`SELECT ${aliasScalar(p.c[selected.col], 'last')} AS v${vtype ? q`, ${entryTypeTag(aliasPop(p.c[selected.col], 'last'))} AS ${vtype}` : empty}${layoutProjection(st.traverserLayout, p)} FROM ${p}${present ? q` WHERE ${present}` : empty}`,
      ['v', ...(vtype ? [vtype] : []), ...layoutCols(st.traverserLayout)],
    );
    return toScalarStream(loweringStateOf(st), rel, undefined, { type });
  }
  const selElem = aliasElem(selected);
  const selId = aliasId(p.c[selected.col], 'last');
  if (by.sub === 'vertex') {
    const rel = st.q.cte(
      q`SELECT ${selId} AS id${layoutProjection(st.traverserLayout, p)} FROM ${p}${present ? q` WHERE ${present}` : empty}`,
      ['id', ...layoutCols(st.traverserLayout)],
    );
    return { ...st, rel, elem: selElem };
  }
  // The by(key) projection is shape-agnostic — it reads the alias COLUMN, never this stream's
  // element — so it lives in labelselect.ts and is shared with the value-shaped route
  // (`selectOneFromAlias`). Keeping a copy here is what made `select(label).by(key)` answer over an
  // element parent and silently drop the modulator over a scalar one.
  return selectKeyFromAlias(st, selected, by.key!, { productive });
}

/**
 * select(labels…)/project(keys…). select reads previously-labelled traversers
 * from their alias columns; project applies its by() modulators to the current
 * traverser under freshly-named keys. by() modulators cycle across the keys. A
 * single-key select reuses the scalar vertex/value shape; anything else is a Map.
 */
/** project('a','b')… over a SCALAR parent. The current object is the value `_`=v, and a
 *  scalar has no adjacency/properties, so every field's by() is a scalar sub-traversal whose
 *  result is a scalar value — no element framing (joins/labels/props/Pop/Column) is needed.
 *  A bare by() (or no by()) is the value itself. A field body that needs element/list output
 *  (movement) has no meaning here → tryCompileScalarValueChild returns null and the whole
 *  project defers cleanly. Each field reuses ONE pushed scalar domain (reuseCurrentFrame), so
 *  the sibling children rejoin on the shared ordinal into one RecordStream row per value.
 *  (Multi-label select() is alias-based and dispatched before this, never reaching here.) */
/** If a field's by() body is exactly `select(label)` reading an ELEMENT alias from path
 *  history, return that (label, entry) — the one non-scalar field kind a scalar-parent
 *  project supports (e.g. degree.centrality's project("vertex","degree").by(select("v")),
 *  where the vertex is a path-history element and the degree is the scalar). Any other
 *  nested body is a scalar child (handled by the scalar branch). */
function scalarProjectAliasField(nested: any, s: ScalarStream, params: Record<string, any>): { label: string; entry: NonNullable<ReturnType<AliasMap['get']>> } | null {
  if (!nested) return null;
  const body = stepChain(nested, params);
  if (body.length !== 1 || body[0].name !== 'select') return null;
  const strs = body[0].args.filter((a: any): a is string => typeof a === 'string');
  if (strs.length !== 1 || body[0].args.some((a: unknown) => isColumnArg(a) || isPopArg(a))) return null;
  const entry = s.traverserLayout.aliases.get(strs[0]);
  return entry && aliasIsElement(entry) ? { label: strs[0], entry } : null;
}

export function lowerScalarProject(s: ScalarStream, proj: IRStep): RecordStream | null {
  if (proj.name !== 'project') return null;
  if (proj.args.some((a: unknown) => isColumnArg(a) || isPopArg(a))) return null;
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) return null;
  const bys = proj.modulators ?? [];
  const byClasses = keys.map((_, i) => classifyBy(byAt(bys, i)));
  // Only a bare by() (→ the value), a nested scalar-value traversal, or a by(select(elementLabel))
  // reading a path-history ELEMENT alias; a string key / T-token has no scalar meaning → defer.
  if (byClasses.some((c) => c.kind === 'key' || c.kind === 'token')) return null;

  const outer = pushChildScope(s);
  const ord = outer.frame.ordinal;
  const branches = keys.map((key, i) => {
    const c = byClasses[i];
    const nested = c.kind === 'nested' ? c.nested : null;
    // by(select(elementLabel)) — re-root the seed on the path-history element and frame it
    // as an element record field (id/label/props), the SAME framing tryLowerTraversalRecord
    // uses for an element-parent record. The alias column rides on the seed's carried schema.
    const aliasField = nested ? scalarProjectAliasField(nested, s, s.params) : null;
    if (aliasField) {
      const elem = aliasElem(aliasField.entry);
      const p = outer.seed.rel.as(`b${i}`);
      const n = elemTable(elem).as(`n${i}`);
      const idExpr = aliasId(p.c[aliasField.entry.col], 'last');
      const payload = elementPayload(elemCtx(n, elem), elem, `e${i}`, true);
      const field: RecordField = { key, prefix: `e${i}`, sub: elem };
      const rel = s.q.cte(
        q`SELECT ${p.c[ord]} AS ${ord}, ${payload}${layoutProjection(s.traverserLayout, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${idExpr}`,
        [ord, ...recordFieldColumns(field), ...layoutCols(s.traverserLayout)],
      ).as(`j${i}`);
      // The element field's columns are already aliased on this branch's rel.
      return { rel, field, cols: recordFieldColumns(field).map((name) => q`${rel.c[name]} AS ${name}`) };
    }
    // A nested field lowers as a scalar child reusing the shared domain; a bare by() is the
    // value itself — the seed row already carries the value + ordinal + outer carried schema.
    const child = nested
      ? tryCompileScalarValueChild(outer.seed, nested, 'first', reuseCurrentFrame(outer.scope, outer.frame))
      : outer.seed;
    if (!child) return null;
    const rel = child.rel.as(`b${i}`);
    const prefix = `e${i}`;
    const field = scalarRecordField(key, prefix, child.type);
    return { rel, field, cols: scalarRecordCols(rel, prefix, child.type) };
  });
  if (branches.some((b) => !b)) return null;
  const bs = branches as { rel: Relation; field: RecordField; cols: Expression[] }[];

  const first = bs[0].rel;
  const joins = bs.slice(1).map((b) => q` JOIN ${b.rel} ON ${b.rel.c[ord]}=${first.c[ord]}`);
  const fields = bs.map((b) => b.field);
  const selectCols = bs.flatMap((b) => b.cols);
  const rel = s.q.cte(
    q`SELECT ${list(selectCols, ', ')}${layoutProjection(s.traverserLayout, first)} FROM ${first}${list(joins, '')}`,
    [...fields.flatMap(recordFieldColumns), ...layoutCols(s.traverserLayout)],
  );
  return toRecordStream(loweringStateOf(s), rel, fields);
}

export function lowerRecordSelectProject(st: ElementStream, proj: IRStep): Stream {
  const bys = proj.modulators ?? [];
  const isProject = proj.name === 'project';
  const aliases: AliasMap = st.traverserLayout.aliases;
  const curElem = st.elem;

  // A non-last Pop on a multi-label select() reads each label's history; the
  // shared shape-agnostic record builder resolves them. project() (current-object
  // keys) has no Pop dimension. Column args stay rejected below.
  const pop = proj.args.find(isPopArg);
  if (pop && pop.pop !== 'last') {
    if (isProject) throw new Error(`project(Pop.${pop.pop}) is not a valid form`);
    const keys = staticSelectKeys(proj);
    return selectRecordFromAlias(st, proj, [...new Set(keys)], pop.pop);
  }
  if (proj.args.some(isColumnArg)) throw new Error('select(Column) not yet supported');

  const keys = staticSelectKeys(proj);
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);
  if (!isProject && keys.some((k) => !aliases.has(k))) return emptyElementLike(st); // any unbound → drop all
  const traversalRecord = tryLowerTraversalRecord(st, proj, keys);
  if (traversalRecord) return traversalRecord;

  const sourceOf = (k: string): { expr: Expression; elem: 'vertex' | 'edge' } => {
    if (isProject) {
      return { expr: st.rel.as('p').c.id, elem: curElem };
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    return { expr: aliasId(st.rel.as('p').c[entry.col], 'last'), elem: aliasElem(entry) };
  };
  const entryKind = (i: number) => byToEntry(byAt(bys, i));
  const p = st.rel.as('p');

  // Multi-key select / any project → a Map per row.
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const fields: RecordField[] = keys.map((k, i) => {
    const prefix = `e${i}`;
    const e = entryKind(i);
    const src = sourceOf(k);
    const en = elemTable(src.elem).as(`${prefix}n`);
    joins.push(q` JOIN ${en} ON ${en.c.id}=${src.expr}`);
    if (e.sub === 'vertex') {
      cols.push(elementPayload(elemCtx(en, src.elem), src.elem, prefix, true));
    } else {
      const { vtype, stored } = storedPropFor(en.c.id, src.elem, e.key!);
      cols.push(q`${stored} AS ${`${prefix}_v`}, ${vtype} AS ${`${prefix}_vtype`}`);
    }
    return e.sub === 'value' ? storedPropertyRecordField(k, prefix) : { key: k, prefix, sub: src.elem };
  });

  const relCols = [...fields.flatMap(recordFieldColumns), ...layoutCols(st.traverserLayout)];
  const rel = st.q.cte(q`SELECT ${list(cols, ', ')}${layoutProjection(st.traverserLayout, p)} FROM ${p}${list(joins, '')}`, relCols);
  return toRecordStream(loweringStateOf(st), rel, fields);
}

/** `<element movement/filter prefix>.project(k…)|select(k…)` as a child body → one record per
 *  parent traverser. The third non-element child shape, and the cheapest: the record builder
 *  already threaded its carried columns, so the classifier was the only gate, and the per-parent
 *  cardinality rejoin is the shared shape-agnostic one. Null when the body is not that shape, so
 *  the caller keeps its own deferral. */
export function tryCompileRecordChild(
  parent: ChildParent,
  nested: any,
  use: ChildUse = 'first',
  scope: ChildFrameStack = ROOT_SCOPE,
): RecordStream | null {
  if (!nested || parent.kind !== 'elements') return null;
  const shape = classifyRecordChildRows(childSteps(nested, parent.params), childCtx(parent));
  if (!shape) return null;
  const pushed = pushChildScope(parent, scope);
  const end = lowerElementBody(pushed.seed, shape.prefix);
  if (!end) return null;
  // `first` ranks per origin by an encounter; mint one when the prefix carries none (the same
  // mint every other child provider makes).
  const withEnc = end.traverserLayout.encounter ? end : mintChildEncounter(end);
  let lowered: Stream;
  try { lowered = lowerRecordSelectProject(withEnc, shape.proj); }
  catch { return null; } // the builder's own deferrals stay authoritative
  if (lowered.kind !== 'record') return null; // an unbound label → its own empty-stream answer
  return applyChildCardinality(parent, pushed.frame, lowered, use).stream;
}

/** Multi-label select(Pop, "a", "b", …) over a value-shaped stream (scalar/list/variant):
 * a Map per traverser whose fields come from path-history labels, resolved by Pop. A
 * traverser is dropped unless EVERY requested label is bound (select's all-present rule).
 * by() modulators cycle per key (element fields honour by(key); value/list fields ignore it). */
export function selectRecordFromAlias(s: Exclude<Stream, { kind: 'result' }>, step: IRStep, keys: string[], pop: string): Stream {
  if (keys.some((k) => !s.traverserLayout.aliases.has(k))) return emptyElementLike(s); // any unbound → drop all
  const bys = step.modulators ?? [];
  const p = s.rel.as('p');
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const presents: Expression[] = [];
  const fields: RecordField[] = keys.map((k, i) => {
    const entry = s.traverserLayout.aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    const prefix = `e${i}`;
    const col = p.c[entry.col];
    presents.push(aliasPresent(col));
    const by = byToEntry(byAt(bys, i));
    if (popIsListResult(entry, pop)) {
      if (entry.shapes.size !== 1) throw new Error('select(Pop.all/mixed) over a mixed-shape label history not yet supported');
      const shape = [...entry.shapes][0];
      const of: ListOf = shape === 'value' ? { kind: 'scalar', typed: true }
        : (shape === 'vertex' || shape === 'edge') ? { kind: 'elem', elem: shapeElem(shape) }
        : shape === 'property' ? { kind: 'property', elem: entry.propertyElem! }
        : (() => { throw new Error(`select(Pop.all) over a ${shape} label not yet supported`); })();
      // A property list must retain each member's full JSON object (historyPropertyValues,
      // -> extraction) — the scalar historyValues (->> text) would stringify each property so
      // framing reads undefined vpid/pk/pv. Mirrors selectOneFromAlias's single-label path.
      cols.push(q`${(shape === 'property' ? historyPropertyValues : shape === 'value' ? historyScalarValues : historyValues)(col)} AS ${`${prefix}_list`}`);
      return { key: k, prefix, sub: 'list', of };
    }
    const end = popEnd(pop);
    if (aliasIsElement(entry)) {
      const elem = aliasElem(entry);
      const en = elemTable(elem).as(`${prefix}n`);
      joins.push(q` JOIN ${en} ON ${en.c.id}=${aliasId(col, end)}`);
      if (by.sub === 'value') {
        const { vtype, stored } = storedPropFor(en.c.id, elem, by.key!);
        cols.push(q`${stored} AS ${`${prefix}_v`}, ${vtype} AS ${`${prefix}_vtype`}`);
        return storedPropertyRecordField(k, prefix);
      }
      cols.push(elementPayload(elemCtx(en, elem), elem, prefix, true));
      return { key: k, prefix, sub: elem };
    }
    // A scalar value label (by() does not apply to a non-element value).
    const type = scalarTypeFromAlias(entry.scalarType, `${prefix}_vtype`);
    const vtype = perRowColumnOf(type);
    cols.push(q`${aliasScalar(col, end)} AS ${`${prefix}_v`}${vtype ? q`, ${entryTypeTag(aliasPop(col, end))} AS ${vtype}` : empty}`);
    return scalarRecordField(k, prefix, type);
  });
  const where = presents.length ? q` WHERE ${list(presents, ' AND ')}` : empty;
  const relCols = [...fields.flatMap(recordFieldColumns), ...layoutCols(s.traverserLayout)];
  const rel = s.q.cte(q`SELECT ${list(cols, ', ')}${layoutProjection(s.traverserLayout, p)} FROM ${p}${list(joins, '')}${where}`, relCols);
  return toRecordStream(loweringStateOf(s), rel, fields);
}

/** Compatibility adapter for element modifiers accumulated before a terminal record
 * projection. New projection-first chains take the RecordStream path directly. */
export function compileSelectProject(st: ElementStream, proj: IRStep, tail: TailMods): Stream {
  if (tail.orders.length) throw new Error('order() after select()/project() not yet supported');
  const lowered = lowerRecordSelectProject(st, proj);
  if (lowered.kind !== 'record') return lowered; // unbound label → empty stream
  let record = lowered;
  if (tail.distinct || tail.limit !== null || tail.offset > 0) {
    const r = record.rel.as('r');
    const names = record.rel.cols;
    const projected = names.map((name) => q`${r.c[name]} AS ${name}`);
    const suffix = tail.limit !== null || tail.offset > 0 ? q` LIMIT ${tail.limit ?? -1} OFFSET ${tail.offset}` : empty;
    const rel = record.q.cte(
      q`SELECT ${tail.distinct ? 'DISTINCT ' : ''}${list(projected, ', ')} FROM ${r}${suffix}`,
      names,
    );
    record = toRecordStream(loweringStateOf(record), rel, record.fields);
  }
  return record;
}

/** One ORDER BY term per by() modulator over a record's fields. A record has no
 * "current element" to sort by a bare key, so each by() must name a field — either
 * directly (`by("b")`) or as the anonymous `by(__.select("b"))` the suite emits. A value
 * field orders by its scalar column; an element field by its external id (element
 * comparison is by id in TinkerPop). Direction/shuffle honoured; list/variant fields and
 * a select-then-values (`__.select("v").values("name")`) modulator defer. */
function recordOrderTerms(s: RecordStream, r: Relation, bys: any[][]): Expression[] {
  if (!bys.length) throw new Error('order() on a record requires a by(field) / by(__.select(field)) modulator');
  return bys.map((byArgs) => {
    const by = classifyBy(byArgs);
    const dir = by.dir;
    if (dir === 'shuffle') return q`RANDOM()`;
    let key: string;
    let valuesKey: string | undefined; // by(__.select(field).values(key)) → order by that prop
    if (by.kind === 'nested') {
      const chain = stepChain(by.nested, s.params);
      if (!chain.length || chain[0].name !== 'select')
        throw new Error('order().by(traversal) on a record supports only by(__.select(field)[.values(key)])');
      const fk = chain[0].args.filter((a: any): a is string => typeof a === 'string');
      if (fk.length !== 1) throw new Error('order().by(__.select) on a record requires exactly one field');
      key = fk[0];
      if (chain.length === 2 && chain[1].name === 'values') {
        const vk = chain[1].args.filter((a: any): a is string => typeof a === 'string');
        if (vk.length !== 1) throw new Error('order().by(__.select(field).values(key)) requires exactly one property key');
        valuesKey = vk[0];
      } else if (chain.length > 1) {
        throw new Error('order().by(traversal) on a record supports only by(__.select(field)[.values(key)])');
      }
    } else if (by.kind === 'key') {
      key = by.key;
    } else {
      // 'none' (bare by()) and 'token' (by(T.label)) alike: a record has no current element
      // to sort by, so neither names a field. Fail closed rather than sorting by identity.
      throw new Error('order().by() on a record requires a field selector');
    }
    const field = s.fields.find((f) => f.key === key);
    if (!field) throw new Error(`order().by(select("${key}")): record has no such field`);
    let col: Expression;
    if (valuesKey !== undefined) {
      // .values(key) only applies to an element field — read that element's property
      // (first-under-multi for a vertex) via its internal rowid.
      if (field.sub !== 'vertex' && field.sub !== 'edge')
        throw new Error(`order().by(select("${key}").values("${valuesKey}")) requires an element field`);
      col = field.sub === 'edge' ? propExtract(r.c[`${field.prefix}_props`], valuesKey).expr : propScalarFor(r.c[`${field.prefix}_rid`], 'vertex', valuesKey);
    } else {
      col = field.sub === 'value' ? r.c[`${field.prefix}_v`]
        : (field.sub === 'vertex' || field.sub === 'edge') ? r.c[`${field.prefix}_id`]
        : (() => { throw new Error(`order().by(select("${key}")) on a ${field.sub} record field not yet supported`); })();
    }
    return q`${col}${dir === 'desc' ? q` DESC` : q` ASC`}`;
  });
}

/** where("a", P…["b"]) over a record. The record stream carries the alias history columns
 *  (a0, a1, …) exactly as an element stream does, so this is the SHARED comparison over the shared
 *  row re-projection — it used to be a ~28-line copy of `where`'s alias branch (prefix/filter.ts),
 *  down to the `where().by(key) on an edge-typed label` message being written out twice.
 *
 *  A non-string first argument keeps the record's own message, because a record is precisely the
 *  shape for which `where(P…)` and `where(traversal)` have no reading: both would need a child
 *  re-rooted on the map. */
const recordFilter: ShapeTailFn<RecordStream> = (s, step, steps, at) =>
  aliasCompareRows(s, step, steps, at)
  ?? (() => { throw new Error('where() on a record supports only the alias-compare form where("a", P.eq/neq(...)["b"])'); })();

const recordOrder: ShapeTailFn<RecordStream> = (s, step, steps, at) => {
    const r = s.rel.as('r');
    const names = s.rel.cols;
    const terms = recordOrderTerms(s, r, step.modulators ?? []);
    // Fuse a directly-following limit/skip/range so the LIMIT applies AFTER the sort in
    // one query (a following Scope.local limit is a per-field slice, not a row cut → skip).
    const nxt = steps[at + 1];
    const fuse = !!nxt && SLICE_STEPS.has(nxt.name) && !isLocalScope(nxt);
    let suffix: Expression = empty;
    if (fuse) {
      const sl = sliceOf(nxt);
      if (sl.offset < 0 || (sl.limit !== null && sl.limit < 0)) throw new Error(`Not a legal range: [${sl.offset}, ${sl.limit === null ? -1 : sl.offset + sl.limit}]`);
      suffix = limitOffset(sl);
    }
    const rel = s.q.cte(q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r} ORDER BY ${list(terms, ', ')}${suffix}`, names);
    return continueLowering(toRecordStream(loweringStateOf(s), rel, s.fields), fuse ? at + 2 : at + 1);
};

/** `tail` is the one window `sliceOf` cannot decode on its own — "the last n" is an offset only
 *  once you know how many there are. For a RECORD the members are its FIELDS, so the count is
 *  static and the local form becomes an ordinary window right here; every other stream still has
 *  to ask the relation, which is why `tail` stays out of `SLICE_STEPS` (item 17). */
const recordWindow = (step: IRStep, members: number): Slice => {
  if (step.name !== 'tail') return sliceOf(step);
  const limit = Number(step.args.find((a: unknown) => typeof a === 'number') ?? 1);
  return { scope: isLocalScope(step) ? 'local' : 'global', offset: Math.max(0, members - limit), limit };
};

const recordSlice: ShapeTailFn<RecordStream> = (s, step, _steps, at) => {
    const { scope, offset, limit } = recordWindow(step, s.fields.length);
    if (offset < 0 || (limit !== null && limit < 0)) throw new Error(`Not a legal range: [${offset}, ${limit === null ? -1 : offset + limit}]`);
    if (scope === 'local') {
      const fields = s.fields.slice(offset, limit === null ? undefined : offset + limit);
      // A record whose field list is empty has no columns to project, and the guard used to also
      // require an empty carried layout — so `project('n').by('name').skip(Scope.local,1)` (one
      // field, skipped past) slipped through with a `bulk` column still carried and rendered
      // `SELECT  FROM …`, a fail-closed VIOLATION (item 27). The reference answer is an empty map
      // per traverser, which needs a record shape that can carry zero fields all the way to the
      // framer; until then this defers on the field count alone.
      if (!fields.length)
        throw new Error(`${step.name}(Scope.local) slicing a record down to zero fields not yet supported (no empty-map record shape)`);
      const r = s.rel.as('r');
      const names = [...fields.flatMap(recordFieldColumns), ...layoutCols(s.traverserLayout)];
      const rel = s.q.cte(q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r}`, names);
      return continueLowering(toRecordStream(loweringStateOf(s), rel, fields), at + 1);
    }
    if (step.name === 'tail') throw new Error('tail() on a record stream needs explicit encounter-order metadata');
    // Record rows are one traverser each, so a global slice is the SHARED row op — the projection
    // this used to spell out is `streamColumns`, and `cardinalityOf` confirms the rows are the
    // traversers rather than leaving that implicit.
    return continueLowering(
      reprojectRows(s, { suffix: limitOffset({ scope, offset, limit }), orderByEncounter: true }),
      at + 1,
    );
};

const recordSelect: ShapeTailFn<RecordStream> = (s, step, _steps, at) => {
  const pop = step.args.find(isPopArg);
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) on a record not yet supported`);
  const column = step.args.map((a: unknown) => isColumnArg(a) ? a.column : undefined)
    .find((c: any) => c === 'keys' || c === 'values') as 'keys' | 'values' | undefined;
  const r = s.rel.as('r');
  if (column) {
    if (step.modulators?.length) throw new Error('by() after select(Column) on a record not yet supported');
    let expr: Expression;
    let of: ListOf = { kind: 'scalar' };
    if (column === 'keys') expr = q`jsonb(${value(JSON.stringify(s.fields.map((f) => f.key)))})`;
    else {
      if (s.fields.every((f) => f.sub === 'value'))
        expr = q`jsonb_array(${list(s.fields.map((f) => r.c[`${f.prefix}_v`]), ', ')})`;
      else if (s.fields.every((f) => f.sub === 'list')) {
        const fields = s.fields as Extract<RecordField, { sub: 'list' }>[];
        if (fields.some((f) => JSON.stringify(f.of) !== JSON.stringify(fields[0].of)))
          throw new Error('select(Column.values) requires homogeneous list field shapes');
        expr = q`jsonb_array(${list(fields.map((f) => q`json(${r.c[`${f.prefix}_list`]})`), ', ')})`;
        of = { kind: 'list', of: fields[0].of };
      } else throw new Error('select(Column.values) on heterogeneous scalar/element/list fields needs a variant list stream');
    }
    const rel = s.q.cte(
      q`SELECT ${expr} AS list${layoutProjection(s.traverserLayout, r)} FROM ${r}`,
      ['list', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toListStream(loweringStateOf(s), rel, of), at + 1);
  }

  const keys = step.args.filter((a): a is string => typeof a === 'string');
  if (keys.length !== 1) throw new Error('select() on a record requires exactly one key');
  if (step.modulators?.length) throw new Error('by() after selecting a record field not yet supported');
  const field = s.fields.find((f) => f.key === keys[0]);
  if (!field) throw new Error(`select("${keys[0]}"): record has no such key`);
  if (field.sub === 'value') {
    const perRow = perRowColumnOf(field.type);
    const rel = s.q.cte(
      q`SELECT ${r.c[`${field.prefix}_v`]} AS v${perRow ? q`, ${r.c[perRow]} AS ${perRow}` : empty}${layoutProjection(s.traverserLayout, r)} FROM ${r}`,
      ['v', ...(perRow ? [perRow] : []), ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toScalarStream(loweringStateOf(s), rel, undefined, { type: field.type }), at + 1);
  }
  if (field.sub === 'list') {
    const rel = s.q.cte(
      q`SELECT ${r.c[`${field.prefix}_list`]} AS list${layoutProjection(s.traverserLayout, r)} FROM ${r}`,
      ['list', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toListStream(loweringStateOf(s), rel, field.of), at + 1);
  }
  if (field.nullable) {
    const rid = r.c[`${field.prefix}_rid`];
    const rel = s.q.cte(
      q`SELECT CASE WHEN ${rid} IS NULL THEN 0 ELSE 2 END AS vk, NULL AS v, ${rid} AS rid${layoutProjection(s.traverserLayout, r)} FROM ${r}`,
      ['vk', 'v', 'rid', ...layoutCols(s.traverserLayout)],
    );
    return continueLowering(toVariantStream(loweringStateOf(s), rel, field.sub === 'edge' ? { edge: true } : { node: true }), at + 1);
  }
  const rel = s.q.cte(
    q`SELECT ${r.c[`${field.prefix}_rid`]} AS id${layoutProjection(s.traverserLayout, r)} FROM ${r}`,
    ['id', ...layoutCols(s.traverserLayout)],
  );
  return continueLowering(toElementStream(loweringStateOf(s), rel, field.sub === 'edge' ? 'edge' : 'vertex'), at + 1);
};

const RECORD_DISPATCH = new Map<string, ShapeTailFn<RecordStream>>([
  ['where', recordFilter], ['not', recordFilter], ['filter', recordFilter],
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['order', recordOrder],
  // `recordSlice` owns limit/range/skip/tail because it ALSO serves Scope.local (a field slice),
  // which the shared row ops deliberately decline. Only `dedup` comes from the shared set.
  ...globalRowOps<RecordStream>().filter(([name]) => name === 'dedup'),
  ['limit', recordSlice], ['range', recordSlice], ['skip', recordSlice], ['tail', recordSlice],
  ['select', recordSelect],
]);

export function compileFromRecord(s: RecordStream, steps: IRStep[], at: number): LoweringResult {
  return dispatchShapeTail(RECORD_DISPATCH, s, steps, at, () => {
    throw new Error(`${steps[at].name}() on a record value not yet supported`);
  });
}
