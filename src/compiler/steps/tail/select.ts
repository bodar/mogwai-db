import { q, list, empty, value, type Expression, type Relation } from '../../../sql/kernel/q.ts';
import { nodes, edges, labels } from '../../../sql/schema.ts';
import { framedProps, labelNameSub, nodePropScalar, edgePropScalar, edgePropsAgg, predicateSql, propExtract, extIdOf, P_OPS } from '../../plan/plan.ts';
import { type PStep } from '../../ir/strategies.ts';
import { isNested, stepChain } from '../../../gremlin/frontend.ts';
import { aliasElem, aliasIsElement, carryFrag, carriedCols, type AliasMap, type ElementStream } from '../context/context.ts';
import { aliasId, aliasPresent, aliasScalar, shapeElem } from '../context/alias.ts';
import { emptyElementLike, historyPropertyValues, historyValues, popEnd, popIsListResult, selectOneFromAlias } from './labelselect.ts';
import { carryOf, continueLowering, dispatchShapeTail, recordFieldColumns, toListStream, toRecordStream, toScalarStream, toVariantStream, type ListOf, type ListStream, type LoweringResult, type RecordField, type RecordStream, type ScalarStream, type ShapeTailFn, type Stream } from '../context/stream.ts';
import { type Compiled } from '../../../sql/kernel/render.ts';
import { type TailAcc, type TailMods } from './projection.ts';
import { lowerGlobalCount } from './barrier.ts';
import { applyChildCardinality, lowerElementBody, mintChildEncounter, pushChildScope, tryCompileElementChild, tryCompileListChild, tryCompileScalarValueChild } from './child.ts';
import { byAt, childCtx, childSteps, classifyBy, classifyElementChild, classifyListChild, classifyRecordChildRows, classifyScalarChild, reuseCurrentFrame, ROOT_SCOPE, type ChildParent, type ChildUse, type CompileScope } from './child-shape.ts';

// ---------- select()/project() ----------

/** Interpret one by() modulator's args into a projected sub-value kind. */
function byToEntry(byArgs: any[] | undefined): { sub: 'vertex' | 'value'; key?: string } {
  const by = classifyBy(byArgs);
  if (by.kind === 'none') return { sub: 'vertex' }; // no by() / bare by() → the element itself
  if (by.kind === 'key') return { sub: 'value', key: by.key };
  if (by.kind === 'nested') throw new Error('by(traversal) modulator not yet supported');
  throw new Error(`by(T.${by.token}) modulator not yet supported`);
}

/** Re-root the current traverser on an element id held in one of its carried alias
 * columns. The row remains the same traverser: aliases/path/origins/sack all survive.
 * Shared with path.ts (the linear-regime position re-root). */
export function reRootElement(st: ElementStream, p: Relation, id: Expression, elem: ElementStream['elem']): ElementStream {
  const rel = st.q.cte(
    q`SELECT ${id} AS id${carryFrag(st.carried, p)} FROM ${p}`,
    ['id', ...carriedCols(st.carried)],
  );
  return { ...st, rel, elem };
}

/** Lower heterogeneous record fields when at least one by() is a shaped child traversal.
 * One outer origin identifies each multiset-distinct input; scalar children use
 * child `first` cardinality while bare by() branches retain the whole source
 * element. Inner joins implement ordinary productive-by semantics: a missing child
 * drops the record row, while a produced SQL NULL remains a real field value. */
function tryLowerTraversalRecord(st: ElementStream, proj: PStep, keys: string[]): RecordStream | null {
  if ((proj.name !== 'project' && proj.name !== 'select') || !proj.bys?.length) return null;
  const isProject = proj.name === 'project';
  const productive = proj.productiveBy === true;
  const args = keys.map((_, i) => byAt(proj.bys, i));
  const specs = args.map((by) => by?.[0]);
  const nested = args.map((by) => { const c = classifyBy(by); return c.kind === 'nested' ? c.nested : null; });
  if (!nested.some(Boolean)) return null; // leave the mature all-direct path untouched
  // Classify each traversal-valued field ONCE (scalar > list > element, matching the emit
  // dispatch order), keeping the parsed body so emit reuses it — no separate is*Child re-parse.
  const recordChildPlan = (n: any) => {
    const s0 = classifyScalarChild(n, childCtx(st));
    const s = s0 && !s0.binds ? s0 : null; // a trailing as() has no emitter here — unusable, as before
    if (s) return { kind: 'scalar' as const, body: s.body };
    const l = classifyListChild(n, childCtx(st));
    if (l) return { kind: 'list' as const, body: l.body };
    const e = classifyElementChild(n, childCtx(st));
    return e ? { kind: 'element' as const, body: e.body } : null;
  };
  const plans = nested.map((n) => n ? recordChildPlan(n) : null);
  if (specs.some((a, i) => {
    if (nested[i]) return !plans[i];
    if (a === undefined) return false;
    if (typeof a === 'string') return false;
    return !(isProject && a && typeof a === 'object' && 'token' in a && (a.token === 'id' || a.token === 'label'));
  })) return null;

  const outer = pushChildScope(st);
  const branches = specs.map((spec, i) => {
    const prefix = `e${i}`;
    const p = outer.seed.rel.as(`p${i}`);
    const source = isProject
      ? { id: p.c.id, elem: st.elem }
      : (() => {
          const selected = st.carried.aliases.get(keys[i]);
          if (!selected) throw new Error(`select("${keys[i]}"): no such label — as("${keys[i]}") was not seen`);
          return { id: aliasId(p.c[selected.col], 'last'), elem: aliasElem(selected) };
        })();
    if (nested[i]) {
      const seed = isProject ? outer.seed : reRootElement(outer.seed, p, source.id, source.elem);
      const plan = plans[i]!;
      if (plan.kind === 'scalar') {
        const child = tryCompileScalarValueChild(seed, nested[i], 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.body)!;
        const rel = child.rel.as(`b${i}`);
        return {
          rel,
          field: { key: keys[i], prefix, sub: 'value' as const },
          cols: [q`${rel.c.v} AS ${`${prefix}_v`}`],
        };
      }
      if (plan.kind === 'list') {
        const child = tryCompileListChild(seed, nested[i], reuseCurrentFrame(outer.scope, outer.frame), plan.body)!;
        const rel = child.rel.as(`b${i}`);
        return {
          rel,
          field: { key: keys[i], prefix, sub: 'list' as const, of: child.of },
          cols: [q`${rel.c.list} AS ${`${prefix}_list`}`],
        };
      }
      const child = tryCompileElementChild(seed, nested[i], 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.body)!;
      const cp = child.stream.rel.as(`cp${i}`);
      const n = (child.stream.elem === 'edge' ? edges : nodes).as(`n${i}`);
      const l = labels.as(`l${i}`);
      const payload = child.stream.elem === 'edge'
        ? q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${extIdOf(n.c.src)} AS src, ${extIdOf(n.c.tgt)} AS tgt, ${framedProps(n, 'edge')} AS props`
        : q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'vertex')} AS props`;
      const payloadCols = child.stream.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${carryFrag(child.stream.carried, cp)} FROM ${cp} JOIN ${n} ON ${n.c.id}=${cp.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [...payloadCols, ...carriedCols(child.stream.carried)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: child.stream.elem, nullable: productive || undefined };
      return {
        rel,
        field,
        cols: recordFieldColumns(field).map((name) => q`${rel.c[name.slice(prefix.length + 1)]} AS ${name}`),
      };
    }

    const n = (source.elem === 'edge' ? edges : nodes).as(`n${i}`);
    if (spec === undefined) {
      const l = labels.as(`l${i}`);
      const payload = source.elem === 'edge'
        ? q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${extIdOf(n.c.src)} AS src, ${extIdOf(n.c.tgt)} AS tgt, ${framedProps(n, 'edge')} AS props`
        : q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'vertex')} AS props`;
      const payloadCols = source.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [...payloadCols, ...carriedCols(outer.seed.carried)],
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
    if (typeof spec === 'string' && source.elem === 'vertex') {
      const expr = nodePropScalar(source.id, spec);
      const rel = st.q.cte(
        q`SELECT ${expr} AS v${carryFrag(outer.seed.carried, p)} FROM ${p}${productive ? empty : q` WHERE ${predicateSql(expr, undefined)}`}`,
        ['v', ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
    }
    if (typeof spec === 'string') {
      const expr = edgePropScalar(n.c.id, spec);
      const rel = st.q.cte(
        q`SELECT ${expr} AS v${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id}${productive ? empty : q` WHERE ${predicateSql(expr, undefined)}`}`,
        ['v', ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
    }
    const scalar = spec.token === 'label'
      ? labelNameSub(n.c.label)
      : q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const rel = st.q.cte(
      q`SELECT ${scalar} AS v${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id}`,
      ['v', ...carriedCols(outer.seed.carried)],
    ).as(`b${i}`);
    return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
  });
  const fields = branches.map((branch) => branch.field);
  const cols = branches.flatMap((branch) => branch.cols);
  const first = branches[0].rel;
  const domain = outer.seed.rel.as('prd');
  const from = productive ? domain : first;
  const joins = productive
    ? branches.map((branch) => q` LEFT JOIN ${branch.rel} ON ${branch.rel.c[outer.frame.ordinal]}=${domain.c[outer.frame.ordinal]}`)
    : branches.slice(1).map((branch) => q` JOIN ${branch.rel} ON ${branch.rel.c[outer.frame.ordinal]}=${first.c[outer.frame.ordinal]}`);
  const rel = st.q.cte(
    q`SELECT ${list(cols, ', ')}${carryFrag(st.carried, from)} FROM ${from}${list(joins, '')}`,
    [...fields.flatMap(recordFieldColumns), ...carriedCols(st.carried)],
  );
  return toRecordStream(carryOf(st), rel, fields);
}

/** A one-label select is not a record: it emits the selected traverser directly.
 * Lower it to the ordinary element/scalar stream model so movement, projections and
 * barriers after select() are handled by the common dispatcher. */
export function lowerSingleSelect(st: ElementStream, proj: PStep): Stream {
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  const popMode = pop?.pop ?? 'last';
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (keys.length !== 1) throw new Error('lowerSingleSelect requires exactly one label');
  const selected = st.carried.aliases.get(keys[0]);
  if (!selected) return emptyElementLike(st); // label bound nowhere → drop every traverser
  // A non-last Pop reads the label's history (first/all/mixed); the by()-less forms lower
  // through the shared shape-agnostic resolver. by()-modulated non-last Pop is uncommon.
  const hasNestedBy = !!(proj.bys?.[0]?.[0] && typeof proj.bys[0][0] === 'object' && 'nested' in proj.bys[0][0]);
  if (popMode !== 'last' && !hasNestedBy && !(proj.bys?.length))
    return selectOneFromAlias(st, proj, keys[0], popMode);
  if (popMode !== 'last') throw new Error(`select(Pop.${popMode}).by(...) not yet supported`);
  const p = st.rel.as('p');
  const productive = proj.productiveBy === true;
  const nested = proj.bys?.[0]?.[0];
  if (nested && typeof nested === 'object' && 'nested' in nested) {
    if (productive) throw new Error('ProductiveByStrategy with a traversal-valued single select is not yet supported');
    const seed = reRootElement(st, p, aliasId(p.c[selected.col], 'last'), aliasElem(selected));
    // Classify once (pure) → emit reusing the parsed body; each classify guarantees its
    // emitter succeeds, so no preflight/compiler mismatch throw is possible.
    // A bind-carrying plan (trailing as()) has no emitter here — fall through to the list/element
    // classifiers and then the deferral, as a null classification did before.
    const scalarPlan = classifyScalarChild(nested.nested, childCtx(st));
    if (scalarPlan && !scalarPlan.binds) return tryCompileScalarValueChild(seed, nested.nested, 'first', ROOT_SCOPE, scalarPlan.body)!;
    const listPlan = classifyListChild(nested.nested, childCtx(st));
    if (listPlan) return tryCompileListChild(seed, nested.nested, ROOT_SCOPE, listPlan.body)!;
    const elemPlan = classifyElementChild(nested.nested, childCtx(st));
    if (elemPlan) return tryCompileElementChild(seed, nested.nested, 'first', ROOT_SCOPE, elemPlan.body)!.stream;
    throw new Error('by(traversal) child shape not yet supported');
  }
  const by = byToEntry(proj.bys?.[0]);
  // A dynamically-bound label (bound inside a branch arm / repeat) may be UNBOUND on some
  // rows (a traverser through an arm that never bound it) → drop those (aliasPresent). A
  // statically-bound linear label is always present, so no guard (same SQL).
  const present = selected.binds === undefined ? aliasPresent(p.c[selected.col]) : null;
  // A VALUE-history label (a scalar bound with as(), e.g. inject(1).as('a')…V().select('a'))
  // reads its value, not an element — the element path (aliasElem) would reject it.
  if (!aliasIsElement(selected)) {
    if (by.sub !== 'vertex' || by.key) throw new Error('select(value-label).by(key) not yet supported (the label holds a value, not an element)');
    const rel = st.q.cte(
      q`SELECT ${aliasScalar(p.c[selected.col], 'last')} AS v${carryFrag(st.carried, p)} FROM ${p}${present ? q` WHERE ${present}` : empty}`,
      ['v', ...carriedCols(st.carried)],
    );
    return toScalarStream(carryOf(st), rel);
  }
  const selElem = aliasElem(selected);
  const selId = aliasId(p.c[selected.col], 'last');
  if (by.sub === 'vertex') {
    const rel = st.q.cte(
      q`SELECT ${selId} AS id${carryFrag(st.carried, p)} FROM ${p}${present ? q` WHERE ${present}` : empty}`,
      ['id', ...carriedCols(st.carried)],
    );
    return { ...st, rel, elem: selElem };
  }
  const n = (selElem === 'edge' ? edges : nodes).as('n');
  const expr = selElem === 'edge' ? edgePropScalar(n.c.id, by.key!) : nodePropScalar(n.c.id, by.key!);
  const conds = [...(present ? [present] : []), ...(productive ? [] : [predicateSql(expr, undefined)])];
  const rel = st.q.cte(
    q`SELECT ${expr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${selId}${conds.length ? q` WHERE ${list(conds, ' AND ')}` : empty}`,
    ['v', ...carriedCols(st.carried)],
  );
  return toScalarStream(carryOf(st), rel);
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
  if (strs.length !== 1 || body[0].args.some((a: any) => a && typeof a === 'object' && ('column' in a || 'pop' in a))) return null;
  const entry = s.carried.aliases.get(strs[0]);
  return entry && aliasIsElement(entry) ? { label: strs[0], entry } : null;
}

export function lowerScalarProject(s: ScalarStream, proj: PStep): RecordStream | null {
  if (proj.name !== 'project') return null;
  if (proj.args.some((a) => a && typeof a === 'object' && ('column' in a || 'pop' in a))) return null;
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) return null;
  const bys = proj.bys ?? [];
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
      const n = (elem === 'edge' ? edges : nodes).as(`n${i}`);
      const l = labels.as(`l${i}`);
      const idExpr = aliasId(p.c[aliasField.entry.col], 'last');
      const payload = elem === 'edge'
        ? q`${n.c.id} AS ${`e${i}_rid`}, COALESCE(${n.c.uid}, ${n.c.id}) AS ${`e${i}_id`}, ${l.c.name} AS ${`e${i}_label`}, ${extIdOf(n.c.src)} AS ${`e${i}_src`}, ${extIdOf(n.c.tgt)} AS ${`e${i}_tgt`}, ${framedProps(n, 'edge')} AS ${`e${i}_props`}`
        : q`${n.c.id} AS ${`e${i}_rid`}, COALESCE(${n.c.uid}, ${n.c.id}) AS ${`e${i}_id`}, ${l.c.name} AS ${`e${i}_label`}, ${framedProps(n, 'vertex')} AS ${`e${i}_props`}`;
      const field: RecordField = { key, prefix: `e${i}`, sub: elem };
      const rel = s.q.cte(
        q`SELECT ${p.c[ord]} AS ${ord}, ${payload}${carryFrag(s.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${idExpr} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [ord, ...recordFieldColumns(field), ...carriedCols(s.carried)],
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
    const field: RecordField = { key, prefix: `e${i}`, sub: 'value' };
    return { rel, field, cols: [q`${rel.c.v} AS ${`e${i}_v`}`] };
  });
  if (branches.some((b) => !b)) return null;
  const bs = branches as { rel: Relation; field: RecordField; cols: Expression[] }[];

  const first = bs[0].rel;
  const joins = bs.slice(1).map((b) => q` JOIN ${b.rel} ON ${b.rel.c[ord]}=${first.c[ord]}`);
  const fields = bs.map((b) => b.field);
  const selectCols = bs.flatMap((b) => b.cols);
  const rel = s.q.cte(
    q`SELECT ${list(selectCols, ', ')}${carryFrag(s.carried, first)} FROM ${first}${list(joins, '')}`,
    [...fields.flatMap(recordFieldColumns), ...carriedCols(s.carried)],
  );
  return toRecordStream(carryOf(s), rel, fields);
}

export function lowerRecordSelectProject(st: ElementStream, proj: PStep): Stream {
  const bys = proj.bys ?? [];
  const isProject = proj.name === 'project';
  const aliases: AliasMap = st.carried.aliases;
  const curElem = st.elem;

  // A non-last Pop on a multi-label select() reads each label's history; the
  // shared shape-agnostic record builder resolves them. project() (current-object
  // keys) has no Pop dimension. Column args stay rejected below.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') {
    if (isProject) throw new Error(`project(Pop.${pop.pop}) is not a valid form`);
    const keys = proj.args.filter((a): a is string => typeof a === 'string');
    return selectRecordFromAlias(st, proj, [...new Set(keys)], pop.pop);
  }
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
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
    const en = (src.elem === 'edge' ? edges : nodes).as(`${prefix}n`);
    joins.push(q` JOIN ${en} ON ${en.c.id}=${src.expr}`);
    if (e.sub === 'vertex') {
      const el = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${el} ON ${el.c.id}=${en.c.label}`);
      if (src.elem === 'edge')
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${en.c.src} AS ${`${prefix}_src`}, ${en.c.tgt} AS ${`${prefix}_tgt`}, ${edgePropsAgg(en.c.id)} AS ${`${prefix}_props`}`);
      else
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'vertex')} AS ${`${prefix}_props`}`);
    } else {
      const prop = src.elem === 'edge' ? edgePropScalar(en.c.id, e.key!) : nodePropScalar(en.c.id, e.key!);
      cols.push(q`${prop} AS ${`${prefix}_v`}`); // first-under-multi; projection, not indexed
    }
    return { key: k, prefix, sub: e.sub === 'value' ? 'value' : src.elem };
  });

  const relCols = [...fields.flatMap(recordFieldColumns), ...carriedCols(st.carried)];
  const rel = st.q.cte(q`SELECT ${list(cols, ', ')}${carryFrag(st.carried, p)} FROM ${p}${list(joins, '')}`, relCols);
  return toRecordStream(carryOf(st), rel, fields);
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
  scope: CompileScope = ROOT_SCOPE,
): RecordStream | null {
  if (!nested || parent.kind !== 'elements') return null;
  const shape = classifyRecordChildRows(childSteps(nested, parent.params), childCtx(parent));
  if (!shape) return null;
  const pushed = pushChildScope(parent, scope);
  const end = lowerElementBody(pushed.seed, shape.prefix);
  if (!end) return null;
  // `first` ranks per origin by an encounter; mint one when the prefix carries none (the same
  // mint every other child provider makes).
  const withEnc = end.carried.encounter ? end : mintChildEncounter(end);
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
export function selectRecordFromAlias(s: Exclude<Stream, { kind: 'result' }>, step: PStep, keys: string[], pop: string): Stream {
  if (keys.some((k) => !s.carried.aliases.has(k))) return emptyElementLike(s); // any unbound → drop all
  const bys = step.bys ?? [];
  const p = s.rel.as('p');
  const cols: Expression[] = [];
  const joins: Expression[] = [];
  const presents: Expression[] = [];
  const fields: RecordField[] = keys.map((k, i) => {
    const entry = s.carried.aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    const prefix = `e${i}`;
    const col = p.c[entry.col];
    presents.push(aliasPresent(col));
    const by = byToEntry(byAt(bys, i));
    if (popIsListResult(entry, pop)) {
      if (entry.shapes.size !== 1) throw new Error('select(Pop.all/mixed) over a mixed-shape label history not yet supported');
      const shape = [...entry.shapes][0];
      const of: ListOf = shape === 'value' ? { kind: 'scalar', as: entry.as }
        : (shape === 'vertex' || shape === 'edge') ? { kind: 'elem', elem: shapeElem(shape) }
        : shape === 'property' ? { kind: 'property', elem: entry.propertyElem! }
        : (() => { throw new Error(`select(Pop.all) over a ${shape} label not yet supported`); })();
      // A property list must retain each member's full JSON object (historyPropertyValues,
      // -> extraction) — the scalar historyValues (->> text) would stringify each property so
      // framing reads undefined vpid/pk/pv. Mirrors selectOneFromAlias's single-label path.
      cols.push(q`${(shape === 'property' ? historyPropertyValues : historyValues)(col)} AS ${`${prefix}_list`}`);
      return { key: k, prefix, sub: 'list', of };
    }
    const end = popEnd(pop);
    if (aliasIsElement(entry)) {
      const elem = aliasElem(entry);
      const en = (elem === 'edge' ? edges : nodes).as(`${prefix}n`);
      joins.push(q` JOIN ${en} ON ${en.c.id}=${aliasId(col, end)}`);
      if (by.sub === 'value') {
        const prop = elem === 'edge' ? edgePropScalar(en.c.id, by.key!) : nodePropScalar(en.c.id, by.key!);
        cols.push(q`${prop} AS ${`${prefix}_v`}`);
        return { key: k, prefix, sub: 'value' };
      }
      const el = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${el} ON ${el.c.id}=${en.c.label}`);
      if (elem === 'edge')
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${en.c.src} AS ${`${prefix}_src`}, ${en.c.tgt} AS ${`${prefix}_tgt`}, ${edgePropsAgg(en.c.id)} AS ${`${prefix}_props`}`);
      else
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'vertex')} AS ${`${prefix}_props`}`);
      return { key: k, prefix, sub: elem };
    }
    // A scalar value label (by() does not apply to a non-element value).
    cols.push(q`${aliasScalar(col, end)} AS ${`${prefix}_v`}`);
    return { key: k, prefix, sub: 'value' };
  });
  const where = presents.length ? q` WHERE ${list(presents, ' AND ')}` : empty;
  const relCols = [...fields.flatMap(recordFieldColumns), ...carriedCols(s.carried)];
  const rel = s.q.cte(q`SELECT ${list(cols, ', ')}${carryFrag(s.carried, p)} FROM ${p}${list(joins, '')}${where}`, relCols);
  return toRecordStream(carryOf(s), rel, fields);
}

/** Compatibility adapter for element modifiers accumulated before a terminal record
 * projection. New projection-first chains take the RecordStream path directly. */
export function compileSelectProject(st: ElementStream, proj: PStep, tail: TailMods): Stream {
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
    record = toRecordStream(carryOf(record), rel, record.fields);
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
  return bys.map((by) => {
    const dir = by.find((a) => a && typeof a === 'object' && 'order' in a)?.order;
    if (dir === 'shuffle') return q`RANDOM()`;
    const nested = by.find(isNested)?.nested;
    let key: string;
    let valuesKey: string | undefined; // by(__.select(field).values(key)) → order by that prop
    if (nested) {
      const chain = stepChain(nested, s.params);
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
    } else {
      const direct = by.find((a) => typeof a === 'string') as string | undefined;
      if (direct === undefined) throw new Error('order().by() on a record requires a field selector');
      key = direct;
    }
    const field = s.fields.find((f) => f.key === key);
    if (!field) throw new Error(`order().by(select("${key}")): record has no such field`);
    let col: Expression;
    if (valuesKey !== undefined) {
      // .values(key) only applies to an element field — read that element's property
      // (first-under-multi for a vertex) via its internal rowid.
      if (field.sub !== 'vertex' && field.sub !== 'edge')
        throw new Error(`order().by(select("${key}").values("${valuesKey}")) requires an element field`);
      col = field.sub === 'edge' ? propExtract(r.c[`${field.prefix}_props`], valuesKey).expr : nodePropScalar(r.c[`${field.prefix}_rid`], valuesKey);
    } else {
      col = field.sub === 'value' ? r.c[`${field.prefix}_v`]
        : (field.sub === 'vertex' || field.sub === 'edge') ? r.c[`${field.prefix}_id`]
        : (() => { throw new Error(`order().by(select("${key}")) on a ${field.sub} record field not yet supported`); })();
    }
    return q`${col}${dir === 'desc' ? q` DESC` : q` ASC`}`;
  });
}

/** where("a", P…["b"]) over a record: filter the record rows by an alias comparison
 * of two path labels. The record stream still carries the alias history columns (a0,a1,…),
 * so the labels resolve exactly as on an element stream — element identity by default, or
 * a property with a trailing by(key). P.not unwraps + negates. Traversal-predicate and
 * whole-map single-predicate forms defer (they'd need re-rooting a child on the map). */
function recordWhere(s: RecordStream, step: PStep, at: number): LoweringResult {
  const arg0 = step.args[0];
  if (typeof arg0 !== 'string')
    throw new Error('where() on a record supports only the alias-compare form where("a", P.eq/neq(...)["b"])');
  let negate = step.name === 'not';
  let pred: any = step.args[1];
  if (pred?.op === 'not') { negate = !negate; pred = pred.values[0]; }
  if (!(pred?.op in P_OPS)) throw new Error(`where(P.${pred?.op}) alias comparison on a record not yet supported`);
  const r = s.rel.as('r');
  const resolve = (label: string) => {
    const entry = s.carried.aliases.get(label);
    if (!entry) throw new Error(`where("${label}"): no such label — as("${label}") was not seen`);
    return { id: aliasId(r.c[entry.col], 'last'), elem: aliasElem(entry) };
  };
  const leftRes = resolve(arg0);
  const rightRes = resolve(pred.values[0]);
  if ((step.bys?.length ?? 0) > 1) throw new Error('by() is only supported as an order() or select()/project() modulator');
  const byKey = step.bys?.[0]?.find((x: any) => typeof x === 'string') as string | undefined;
  let test: Expression;
  if (byKey !== undefined) {
    if (leftRes.elem === 'edge' || rightRes.elem === 'edge') throw new Error('where().by(key) on an edge-typed label not yet supported');
    const op = step.productiveBy && pred.op === 'eq' ? 'IS' : step.productiveBy && pred.op === 'neq' ? 'IS NOT' : P_OPS[pred.op];
    test = q`${nodePropScalar(leftRes.id, byKey)} ${op} ${nodePropScalar(rightRes.id, byKey)}`;
  } else {
    test = q`${leftRes.id} ${P_OPS[pred.op]} ${rightRes.id}`;
  }
  const names = s.rel.cols;
  const whereExpr = negate ? q`NOT COALESCE((${test}), 0)` : test;
  const rel = s.q.cte(q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r} WHERE ${whereExpr}`, names);
  return continueLowering(toRecordStream(carryOf(s), rel, s.fields), at + 1);
}

/** Continue from a per-traverser record. Selecting a named field retypes it to the
 * ordinary scalar/element stream, while Column.keys/values produces one list value
 * per record. This is intentionally distinct from MapStream's whole-group columns. */
const recordFilter: ShapeTailFn<RecordStream> = (s, step, _steps, at) => recordWhere(s, step, at);

const recordOrder: ShapeTailFn<RecordStream> = (s, step, steps, at) => {
    const r = s.rel.as('r');
    const names = s.rel.cols;
    const terms = recordOrderTerms(s, r, step.bys ?? []);
    // Fuse a directly-following limit/skip/range so the LIMIT applies AFTER the sort in
    // one query (a following Scope.local limit is a per-field slice, not a row cut → skip).
    const nxt = steps[at + 1];
    const fuse = nxt && (nxt.name === 'limit' || nxt.name === 'skip' || nxt.name === 'range')
      && !nxt.args.some((a: any) => a && typeof a === 'object' && a.scope === 'local');
    let suffix: Expression = empty;
    if (fuse) {
      const nums = nxt.args.filter((a): a is number => typeof a === 'number').map(Number);
      const offset = nxt.name === 'skip' ? nums[0] : nxt.name === 'range' ? nums[0] : 0;
      const limit = nxt.name === 'limit' ? nums[0] : nxt.name === 'range' ? nums[1] - nums[0] : null;
      if (offset < 0 || (limit !== null && limit < 0)) throw new Error(`Not a legal range: [${offset}, ${limit === null ? -1 : offset + limit}]`);
      suffix = q` LIMIT ${limit ?? -1} OFFSET ${offset}`;
    }
    const rel = s.q.cte(q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r} ORDER BY ${list(terms, ', ')}${suffix}`, names);
    return continueLowering(toRecordStream(carryOf(s), rel, s.fields), fuse ? at + 2 : at + 1);
};

const recordSlice: ShapeTailFn<RecordStream> = (s, step, _steps, at) => {
    const local = step.args.some((a: any) => a && typeof a === 'object' && a.scope === 'local');
    const nums = step.args.filter((a): a is number => typeof a === 'number').map(Number);
    if (local) {
      let offset = 0;
      let limit: number | null = null;
      if (step.name === 'limit') limit = nums[0];
      else if (step.name === 'skip') offset = nums[0];
      else if (step.name === 'range') { offset = nums[0]; limit = nums[1] - nums[0]; }
      else { limit = nums[0] ?? 1; offset = Math.max(0, s.fields.length - limit); }
      if (offset < 0 || (limit !== null && limit < 0)) throw new Error(`Not a legal range: [${offset}, ${limit === null ? -1 : offset + limit}]`);
      const fields = s.fields.slice(offset, limit === null ? undefined : offset + limit);
      if (!fields.length && carriedCols(s.carried).length === 0)
        throw new Error(`${step.name}(Scope.local) producing an empty record needs a zero-field record layout`);
      const r = s.rel.as('r');
      const names = [...fields.flatMap(recordFieldColumns), ...carriedCols(s.carried)];
      const rel = s.q.cte(q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r}`, names);
      return continueLowering(toRecordStream(carryOf(s), rel, fields), at + 1);
    }
    if (step.name === 'tail') throw new Error('tail() on a record stream needs explicit encounter-order metadata');
    const offset = step.name === 'skip' ? nums[0] : step.name === 'range' ? nums[0] : 0;
    const limit = step.name === 'limit' ? nums[0] : step.name === 'range' ? nums[1] - nums[0] : null;
    if (offset < 0 || (limit !== null && limit < 0)) throw new Error(`Not a legal range: [${offset}, ${limit === null ? -1 : offset + limit}]`);
    const r = s.rel.as('r');
    const names = s.rel.cols;
    const rel = s.q.cte(
      q`SELECT ${list(names.map((name) => r.c[name]), ', ')} FROM ${r} LIMIT ${limit ?? -1} OFFSET ${offset}`,
      names,
    );
    return continueLowering(toRecordStream(carryOf(s), rel, s.fields), at + 1);
};

const recordSelect: ShapeTailFn<RecordStream> = (s, step, _steps, at) => {
  const pop = step.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) on a record not yet supported`);
  const column = step.args.map((a: any) => a && typeof a === 'object' && a.column)
    .find((c: any) => c === 'keys' || c === 'values') as 'keys' | 'values' | undefined;
  const r = s.rel.as('r');
  if (column) {
    if (step.bys?.length) throw new Error('by() after select(Column) on a record not yet supported');
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
      q`SELECT ${expr} AS list${carryFrag(s.carried, r)} FROM ${r}`,
      ['list', ...carriedCols(s.carried)],
    );
    return continueLowering(toListStream(carryOf(s), rel, of), at + 1);
  }

  const keys = step.args.filter((a): a is string => typeof a === 'string');
  if (keys.length !== 1) throw new Error('select() on a record requires exactly one key');
  if (step.bys?.length) throw new Error('by() after selecting a record field not yet supported');
  const field = s.fields.find((f) => f.key === keys[0]);
  if (!field) throw new Error(`select("${keys[0]}"): record has no such key`);
  if (field.sub === 'value') {
    const rel = s.q.cte(
      q`SELECT ${r.c[`${field.prefix}_v`]} AS v${carryFrag(s.carried, r)} FROM ${r}`,
      ['v', ...carriedCols(s.carried)],
    );
    return continueLowering(toScalarStream(carryOf(s), rel), at + 1);
  }
  if (field.sub === 'list') {
    const rel = s.q.cte(
      q`SELECT ${r.c[`${field.prefix}_list`]} AS list${carryFrag(s.carried, r)} FROM ${r}`,
      ['list', ...carriedCols(s.carried)],
    );
    return continueLowering(toListStream(carryOf(s), rel, field.of), at + 1);
  }
  if (field.nullable) {
    const rid = r.c[`${field.prefix}_rid`];
    const rel = s.q.cte(
      q`SELECT CASE WHEN ${rid} IS NULL THEN 0 ELSE 2 END AS vk, NULL AS v, ${rid} AS rid${carryFrag(s.carried, r)} FROM ${r}`,
      ['vk', 'v', 'rid', ...carriedCols(s.carried)],
    );
    return continueLowering(toVariantStream(carryOf(s), rel, field.sub === 'edge' ? { edge: true } : { node: true }), at + 1);
  }
  const rel = s.q.cte(
    q`SELECT ${r.c[`${field.prefix}_rid`]} AS id${carryFrag(s.carried, r)} FROM ${r}`,
    ['id', ...carriedCols(s.carried)],
  );
  return continueLowering({ ...carryOf(s), kind: 'elements', rel, elem: field.sub === 'edge' ? 'edge' : 'vertex' }, at + 1);
};

const RECORD_TAIL = new Map<string, ShapeTailFn<RecordStream>>([
  ['where', recordFilter], ['not', recordFilter], ['filter', recordFilter],
  ['count', (s, _step, _steps, at) => continueLowering(lowerGlobalCount(s), at + 1)],
  ['order', recordOrder],
  ['limit', recordSlice], ['range', recordSlice], ['skip', recordSlice], ['tail', recordSlice],
  ['select', recordSelect],
]);

export function compileFromRecord(s: RecordStream, steps: PStep[], at: number): LoweringResult {
  return dispatchShapeTail(RECORD_TAIL, s, steps, at, () => {
    throw new Error(`${steps[at].name}() on a record value not yet supported`);
  });
}
