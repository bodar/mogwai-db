import { q, list, empty, value, type Expression, type Relation } from '../q.ts';
import { nodes, edges, labels } from '../schema.ts';
import { framedProps, labelNameSub, nodePropScalar, edgePropScalar, edgePropsAgg, predicateSql, propExtract, extIdOf, elemCtx, P_OPS, type Elem } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { stepChain } from '../frontend.ts';
import { aliasElem, aliasIsElement, carryFrag, carriedCols, scopePathCols, withoutCarried, type AliasMap, type ElementStream } from './context.ts';
import { aliasId, aliasPresent, aliasScalar, shapeElem } from './alias.ts';
import { emptyElementLike, historyValues, popEnd, popIsListResult, selectOneFromAlias } from './labelselect.ts';
import { carryOf, continueLowering, dispatchShapeTail, pathColumns, recordFieldColumns, toListStream, toPathStream, toRecordStream, toScalarStream, toVariantStream, type ListOf, type ListStream, type LoweringResult, type PathStream, type RecordField, type RecordStream, type ScalarStream, type ShapeTailFn, type Stream } from './stream.ts';
import { compileFromList } from './list.ts';
import { type Compiled, type PathPos } from '../render.ts';
import { type TailAcc, type TailMods } from './projection.ts';
import { lowerGlobalCount } from './barrier.ts';
import { childSteps, classifyElementChild, classifyListChild, classifyScalarChild, pushChildScope, reuseCurrentFrame, ROOT_SCOPE, tryCompileElementChild, tryCompileListChild, tryCompileScalarValueChild, type ChildFrame, type ChildScope } from './child.ts';
import { tryLowerScalarChoose, tryLowerScalarCoalesce } from './branch.ts';

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

/** Re-root the current traverser on an element id held in one of its carried alias
 * columns. The row remains the same traverser: aliases/path/origins/sack all survive. */
function reRootElement(st: ElementStream, p: Relation, id: Expression, elem: ElementStream['elem']): ElementStream {
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
  const args = keys.map((_, i) => proj.bys![i % proj.bys!.length]);
  const specs = args.map((by) => by?.[0]);
  const nested = specs.map((a) => a && typeof a === 'object' && 'nested' in a ? a.nested : null);
  if (!nested.some(Boolean)) return null; // leave the mature all-direct path untouched
  // Classify each traversal-valued field ONCE (scalar > list > element, matching the emit
  // dispatch order), keeping the parsed body so emit reuses it — no separate is*Child re-parse.
  const recordChildPlan = (n: any) => {
    const s = classifyScalarChild(n, st.params);
    if (s) return { kind: 'scalar' as const, body: s.body };
    const l = classifyListChild(n, st.params);
    if (l) return { kind: 'list' as const, body: l.body };
    const e = classifyElementChild(n, st.params);
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
        : q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props`;
      const payloadCols = child.stream.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${carryFrag(child.stream.carried, cp)} FROM ${cp} JOIN ${n} ON ${n.c.id}=${cp.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [...payloadCols, ...carriedCols(child.stream.carried)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: child.stream.elem === 'edge' ? 'edge' : 'vertex', nullable: productive || undefined };
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
        : q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props`;
      const payloadCols = source.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${source.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [...payloadCols, ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: source.elem === 'edge' ? 'edge' : 'vertex' };
      return {
        rel,
        field,
        cols: recordFieldColumns(field).map((name) => {
          const source = name.slice(prefix.length + 1);
          return q`${rel.c[source]} AS ${name}`;
        }),
      };
    }
    if (typeof spec === 'string' && source.elem === 'node') {
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
    const scalarPlan = classifyScalarChild(nested.nested, st.params);
    if (scalarPlan) return tryCompileScalarValueChild(seed, nested.nested, 'first', ROOT_SCOPE, scalarPlan.body)!;
    const listPlan = classifyListChild(nested.nested, st.params);
    if (listPlan) return tryCompileListChild(seed, nested.nested, ROOT_SCOPE, listPlan.body)!;
    const elemPlan = classifyElementChild(nested.nested, st.params);
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
export function lowerScalarProject(s: ScalarStream, proj: PStep): RecordStream | null {
  if (proj.name !== 'project') return null;
  if (proj.args.some((a) => a && typeof a === 'object' && ('column' in a || 'pop' in a))) return null;
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) return null;
  const bys = proj.bys ?? [];
  const specs = keys.map((_, i) => (bys.length ? bys[i % bys.length]?.[0] : undefined));
  // Only a bare by() (→ the value) or a nested scalar-value traversal; a string key / T-token
  // has no scalar meaning (a scalar has no property/label/id) → defer the whole project.
  if (specs.some((a) => a != null && !(typeof a === 'object' && 'nested' in a))) return null;

  const outer = pushChildScope(s);
  const ord = outer.frame.ordinal;
  const branches = keys.map((key, i) => {
    const spec = specs[i];
    const nested = spec && typeof spec === 'object' && 'nested' in spec ? spec.nested : null;
    // A nested field lowers as a scalar child reusing the shared domain; a bare by() is the
    // value itself — the seed row already carries the value + ordinal + outer carried schema.
    const child = nested
      ? tryCompileScalarValueChild(outer.seed, nested, 'first', reuseCurrentFrame(outer.scope, outer.frame))
      : outer.seed;
    if (!child) return null;
    const rel = child.rel.as(`b${i}`);
    const field: RecordField = { key, prefix: `e${i}`, sub: 'value' };
    return { rel, field, col: q`${rel.c.v} AS ${`e${i}_v`}` };
  });
  if (branches.some((b) => !b)) return null;
  const bs = branches as { rel: Relation; field: RecordField; col: Expression }[];

  const first = bs[0].rel;
  const joins = bs.slice(1).map((b) => q` JOIN ${b.rel} ON ${b.rel.c[ord]}=${first.c[ord]}`);
  const fields = bs.map((b) => b.field);
  const rel = s.q.cte(
    q`SELECT ${list(bs.map((b) => b.col), ', ')}${carryFrag(s.carried, first)} FROM ${first}${list(joins, '')}`,
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

  const sourceOf = (k: string): { expr: Expression; elem: 'node' | 'edge' } => {
    if (isProject) {
      return { expr: st.rel.as('p').c.id, elem: curElem };
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    return { expr: aliasId(st.rel.as('p').c[entry.col], 'last'), elem: aliasElem(entry) };
  };
  const entryKind = (i: number) => byToEntry(bys.length ? bys[i % bys.length] : undefined);
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
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'node')} AS ${`${prefix}_props`}`);
    } else {
      const prop = src.elem === 'edge' ? edgePropScalar(en.c.id, e.key!) : nodePropScalar(en.c.id, e.key!);
      cols.push(q`${prop} AS ${`${prefix}_v`}`); // first-under-multi; projection, not indexed
    }
    return { key: k, prefix, sub: e.sub === 'value' ? 'value' : src.elem === 'edge' ? 'edge' : 'vertex' };
  });

  const relCols = [...fields.flatMap(recordFieldColumns), ...carriedCols(st.carried)];
  const rel = st.q.cte(q`SELECT ${list(cols, ', ')}${carryFrag(st.carried, p)} FROM ${p}${list(joins, '')}`, relCols);
  return toRecordStream(carryOf(st), rel, fields);
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
    const by = byToEntry(bys.length ? bys[i % bys.length] : undefined);
    if (popIsListResult(entry, pop)) {
      if (entry.shapes.size !== 1) throw new Error('select(Pop.all/mixed) over a mixed-shape label history not yet supported');
      const shape = [...entry.shapes][0];
      const of: ListOf = shape === 'value' ? { kind: 'scalar', as: entry.as }
        : (shape === 'node' || shape === 'edge') ? { kind: 'elem', elem: shapeElem(shape) }
        : (() => { throw new Error(`select(Pop.all) over a ${shape} label not yet supported`); })();
      cols.push(q`${historyValues(col)} AS ${`${prefix}_list`}`);
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
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'node')} AS ${`${prefix}_props`}`);
      return { key: k, prefix, sub: elem === 'edge' ? 'edge' : 'vertex' };
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
    const nested = by.find((a) => a && typeof a === 'object' && 'nested' in a)?.nested;
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
  return continueLowering({ ...carryOf(s), kind: 'elements', rel, elem: field.sub === 'edge' ? 'edge' : 'node' }, at + 1);
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

// ---------- path() (linear regime) ----------

/** Interpret one path().by() modulator: undefined → the whole element; a string →
 *  a property-key projection; token/traversal by()s defer. */
function pathBy(byArgs: any[] | undefined): string | undefined {
  if (!byArgs || byArgs.length === 0) return undefined; // no by()/bare by() → the element
  const a = byArgs[0];
  if (typeof a === 'string') return a;
  if (a && typeof a === 'object' && 'nested' in a) throw new Error('path().by(traversal) modulator not yet supported');
  if (a && typeof a === 'object' && 'token' in a) throw new Error(`path().by(T.${a.token}) modulator not yet supported`);
  throw new Error('unsupported path().by() modulator');
}

/** The inline value expression for one linear path position under a by('key')/by(T.token)
 *  modulator, or undefined for a bare by()/no by() (→ the whole element). A by(__.trav)
 *  position is NOT handled here — lowerPath lowers it through the generic scalar child seam. */
function pathPositionValue(_st: ElementStream, tbl: Relation, elem: Elem, byArgs: any[] | undefined): Expression | undefined {
  if (!byArgs || byArgs.length === 0) return undefined; // the whole element
  const a = byArgs[0];
  if (typeof a === 'string') return elem === 'edge' ? edgePropScalar(tbl.c.id, a) : nodePropScalar(tbl.c.id, a);
  if (a && typeof a === 'object' && 'token' in a) {
    if (a.token === 'label') return labelNameSub(tbl.c.label);
    if (a.token === 'id') return elemCtx(tbl, elem).extIdExpr!;
    throw new Error(`path().by(T.${a.token}) modulator not yet supported`);
  }
  throw new Error('unsupported path().by() modulator');
}

const POSITION_MOVEMENTS = new Set(['out', 'in', 'both', 'outE', 'inE', 'bothE', 'outV', 'inV', 'bothV']);

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
      const kids = (s.args ?? []).filter((a: any) => a && typeof a === 'object' && 'nested' in a);
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
  const plan = classifyScalarChild(nested, params);
  if (plan) return tryCompileScalarValueChild(seed, nested, 'first', reuseCurrentFrame(outer.scope, outer.frame), plan.body)!;
  const body = childSteps(nested, params);
  const armDesc = () => body.map((s) => s.name + '()').join('.');
  const branch = body.length === 1 ? body[0] : undefined;
  if (branch?.name === 'union')
    throw new Error(`path().by(__.${armDesc()}): union() at a path position fans out to multiple values but a position holds one — take-first-of-fan-out is a deferred non-goal; use choose()/coalesce()`);
  if (branch?.name === 'choose' || branch?.name === 'coalesce') {
    if (positionArmFansOut(body, params))
      throw new Error(`path().by(__.${armDesc()}): a ${branch.name}() arm fans out (movement/re-source/union) but a path position holds one value — take-first-of-fan-out is a deferred non-goal`);
    const s = branch.name === 'choose' ? tryLowerScalarChoose(branch, seed) : tryLowerScalarCoalesce(branch, seed);
    if (s) return s;
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
  const byOf = (i: number) => (bys.length ? bys[i % bys.length] : undefined);
  const isTraversalBy = (a: any) => a && typeof a === 'object' && 'nested' in a;
  // A by(__.trav) position lowers through the SAME generic scalar child seam group/
  // select/dedup/order use: push ONE child scope over the path rows, re-root each such
  // position on its element, and join the child's FIRST value back by ordinal. Positions
  // are then structurally a record of per-position children (tryLowerTraversalRecord's
  // template). A path with no by(traversal) keeps the flat fast path — no scope, no ordinal.
  const anyTraversal = scopedCols.some((_, i) => isTraversalBy(byOf(i)?.[0]));
  const outer = anyTraversal ? pushChildScope(st) : null;
  const p = (outer ? outer.seed.rel : st.rel).as('p');
  const joins: Expression[] = [];
  const cols: Expression[] = [];
  const whereParts: Expression[] = [];
  const positions: PathPos[] = scopedCols.map((pos, i) => {
    const prefix = `x${i}`;
    const spec = byOf(i)?.[0];
    // by(__.trav): re-root on this position's element and lower a scalar child via the seam.
    if (isTraversalBy(spec)) {
      // The child computes ONE scalar for this position — it must NOT extend the outer path
      // (its own movement would append a path column, corrupting the carried schema). Strip
      // path from the child seed; the ordinal (for the ordinal join) is preserved.
      const childParent = { ...outer!.seed, carried: { ...outer!.seed.carried, path: undefined } };
      const seed = reRootElement(childParent, p, p.c[pos.col], pos.elem);
      const child = lowerPathPositionChild(seed, spec.nested, outer!, st.params);
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
  const node = q`SELECT ${dist}${list(cols, ', ')} FROM ${p}${list(joins, '')}${whereNode}${tailSql}`;
  const layout = { kind: 'linear' as const, positions };
  const rel = st.q.cte(node, pathColumns(layout));
  return toPathStream(withoutCarried(carryOf(st)), rel, layout);
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
    return continueLowering(toScalarStream(withoutCarried(carryOf(s)), rel, 'long', 'count'), at + 1);
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
