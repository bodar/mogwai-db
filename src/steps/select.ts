import { q, list, empty, value, type Expression } from '../q.ts';
import { nodes, edges, labels, vertexProperties } from '../schema.ts';
import { framedProps, labelNameSub, nodePropScalar, predicateSql, propExtract, extIdOf } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { carryFrag, carriedCols, withoutCarried, type AliasMap, type ElementStream } from './context.ts';
import { carryOf, pathColumns, recordFieldColumns, toListStream, toPathStream, toRecordStream, toScalarStream, type PathStream, type RecordField, type RecordStream, type ScalarStream } from './stream.ts';
import { type Compiled, type PathPos } from '../render.ts';
import { type TailAcc, type TailMods } from './projection.ts';
import { materializeRecordRoot } from './materialize.ts';
import { lowerGlobalCount } from './barrier.ts';
import { dispatchNext } from './index.ts';
import { isScalarChild, pushChildScope, tryCompileScalarValueChild } from './child.ts';

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

/** Project heterogeneous fields when at least one by() is a scalar child traversal.
 * One outer origin identifies each multiset-distinct input; scalar children use
 * child `first` cardinality while bare by() branches retain the whole current
 * element. Inner joins implement ordinary productive-by semantics: a missing child
 * drops the project row, while a produced SQL NULL remains a real field value. */
function tryLowerTraversalProject(st: ElementStream, proj: PStep, keys: string[]): RecordStream | null {
  if (proj.name !== 'project' || !proj.bys?.length) return null;
  const args = keys.map((_, i) => proj.bys![i % proj.bys!.length]);
  const specs = args.map((by) => by?.[0]);
  const nested = specs.map((a) => a && typeof a === 'object' && 'nested' in a ? a.nested : null);
  if (!nested.some(Boolean)) return null; // leave the mature all-direct path untouched
  if (specs.some((a, i) => {
    if (nested[i]) return !isScalarChild(nested[i], st.params);
    if (a === undefined) return false;
    if (typeof a === 'string') return false;
    return !(a && typeof a === 'object' && 'token' in a && (a.token === 'id' || a.token === 'label'));
  })) return null;

  const outer = pushChildScope(st);
  const branches = specs.map((spec, i) => {
    const prefix = `e${i}`;
    if (nested[i]) {
      const child = tryCompileScalarValueChild(outer.seed, nested[i], 'first', outer.scope);
      if (!child) throw new Error('scalar project child failed after successful shape preflight');
      const rel = child.rel.as(`b${i}`);
      return {
        rel,
        field: { key: keys[i], prefix, sub: 'value' as const },
        cols: [q`${rel.c.v} AS ${`${prefix}_v`}`],
      };
    }

    const p = outer.seed.rel.as(`p${i}`);
    const n = (st.elem === 'edge' ? edges : nodes).as(`n${i}`);
    if (spec === undefined) {
      const l = labels.as(`l${i}`);
      const payload = st.elem === 'edge'
        ? q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${extIdOf(n.c.src)} AS src, ${extIdOf(n.c.tgt)} AS tgt, ${framedProps(n, 'edge')} AS props`
        : q`${n.c.id} AS rid, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props`;
      const payloadCols = st.elem === 'edge'
        ? ['rid', 'id', 'label', 'src', 'tgt', 'props']
        : ['rid', 'id', 'label', 'props'];
      const rel = st.q.cte(
        q`SELECT ${payload}${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id} JOIN ${l} ON ${l.c.id}=${n.c.label}`,
        [...payloadCols, ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      const field: RecordField = { key: keys[i], prefix, sub: st.elem === 'edge' ? 'edge' : 'vertex' };
      return {
        rel,
        field,
        cols: recordFieldColumns(field).map((name) => {
          const source = name.slice(prefix.length + 1);
          return q`${rel.c[source]} AS ${name}`;
        }),
      };
    }
    if (typeof spec === 'string' && st.elem === 'node') {
      const vp = vertexProperties.as(`vp${i}`);
      const ranked = st.q.cte(
        q`SELECT ${vp.c.value} AS v${carryFrag(outer.seed.carried, p)}, ROW_NUMBER() OVER (PARTITION BY ${p.c[outer.frame.ordinal]} ORDER BY ${vp.c.id}) AS rn FROM ${p} JOIN ${vp} ON ${vp.c.node}=${p.c.id} AND ${vp.c.key}=${value(spec)}`,
        ['v', ...carriedCols(outer.seed.carried), 'rn'],
      );
      const r = ranked.as(`r${i}`);
      const rel = st.q.cte(
        q`SELECT ${r.c.v} AS v${carryFrag(outer.seed.carried, r)} FROM ${r} WHERE ${r.c.rn}=1`,
        ['v', ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
    }
    if (typeof spec === 'string') {
      const rel = st.q.cte(
        q`SELECT j.value AS v${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id} JOIN json_each(json(${n.c.props})) j ON j.key=${value(spec)}`,
        ['v', ...carriedCols(outer.seed.carried)],
      ).as(`b${i}`);
      return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
    }
    const scalar = spec.token === 'label'
      ? labelNameSub(n.c.label)
      : q`COALESCE(${n.c.uid}, ${n.c.id})`;
    const rel = st.q.cte(
      q`SELECT ${scalar} AS v${carryFrag(outer.seed.carried, p)} FROM ${p} JOIN ${n} ON ${n.c.id}=${p.c.id}`,
      ['v', ...carriedCols(outer.seed.carried)],
    ).as(`b${i}`);
    return { rel, field: { key: keys[i], prefix, sub: 'value' as const }, cols: [q`${rel.c.v} AS ${`${prefix}_v`}`] };
  });
  const first = branches[0].rel;
  const joins = branches.slice(1).map((branch) => q` JOIN ${branch.rel} ON ${branch.rel.c[outer.frame.ordinal]}=${first.c[outer.frame.ordinal]}`);
  const fields = branches.map((branch) => branch.field);
  const cols = branches.flatMap((branch) => branch.cols);
  const rel = st.q.cte(
    q`SELECT ${list(cols, ', ')}${carryFrag(st.carried, first)} FROM ${first}${list(joins, '')}`,
    [...fields.flatMap(recordFieldColumns), ...carriedCols(st.carried)],
  );
  return toRecordStream(carryOf(st), rel, fields);
}

/** A one-label select is not a record: it emits the selected traverser directly.
 * Lower it to the ordinary element/scalar stream model so movement, projections and
 * barriers after select() are handled by the common dispatcher. */
export function lowerSingleSelect(st: ElementStream, proj: PStep): ElementStream | ScalarStream {
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');
  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (keys.length !== 1) throw new Error('lowerSingleSelect requires exactly one label');
  const selected = st.carried.aliases.get(keys[0]);
  if (!selected) throw new Error(`select("${keys[0]}"): no such label — as("${keys[0]}") was not seen`);
  const p = st.rel.as('p');
  const by = byToEntry(proj.bys?.[0]);
  if (by.sub === 'vertex') {
    const rel = st.q.cte(
      q`SELECT ${p.c[selected.col]} AS id${carryFrag(st.carried, p)} FROM ${p}`,
      ['id', ...carriedCols(st.carried)],
    );
    return { ...st, rel, elem: selected.elem };
  }
  const n = (selected.elem === 'edge' ? edges : nodes).as('n');
  const expr = selected.elem === 'edge' ? propExtract(n.c.props, by.key!).expr : nodePropScalar(n.c.id, by.key!);
  const rel = st.q.cte(
    q`SELECT ${expr} AS v${carryFrag(st.carried, p)} FROM ${n} JOIN ${p} ON ${n.c.id}=${p.c[selected.col]}`,
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
export function lowerRecordSelectProject(st: ElementStream, proj: PStep): RecordStream {
  const bys = proj.bys ?? [];
  const isProject = proj.name === 'project';
  const aliases: AliasMap = st.carried.aliases;
  const curElem = st.elem;

  // Reject the deferred long-tail forms explicitly (tokens are captured, not
  // silently dropped) so a Pop/Column arg can never mis-execute as a plain key.
  const pop = proj.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) not yet supported`);
  if (proj.args.some((a) => a && typeof a === 'object' && 'column' in a)) throw new Error('select(Column) not yet supported');

  const keys = proj.args.filter((a): a is string => typeof a === 'string');
  if (!keys.length) throw new Error(`${proj.name}() requires at least one key`);
  const traversalProject = tryLowerTraversalProject(st, proj, keys);
  if (traversalProject) return traversalProject;

  const sourceOf = (k: string): { expr: Expression; elem: 'node' | 'edge' } => {
    if (isProject) {
      return { expr: st.rel.as('p').c.id, elem: curElem };
    }
    const entry = aliases.get(k);
    if (!entry) throw new Error(`select("${k}"): no such label — as("${k}") was not seen`);
    return { expr: st.rel.as('p').c[entry.col], elem: entry.elem };
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
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${en.c.src} AS ${`${prefix}_src`}, ${en.c.tgt} AS ${`${prefix}_tgt`}, json(${en.c.props}) AS ${`${prefix}_props`}`);
      else
        cols.push(q`${en.c.id} AS ${`${prefix}_rid`}, COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'node')} AS ${`${prefix}_props`}`);
    } else {
      const prop = src.elem === 'edge' ? propExtract(en.c.props, e.key!).expr : nodePropScalar(en.c.id, e.key!);
      cols.push(q`${prop} AS ${`${prefix}_v`}`); // first-under-multi; projection, not indexed
    }
    return { key: k, prefix, sub: e.sub === 'value' ? 'value' : src.elem === 'edge' ? 'edge' : 'vertex' };
  });

  const relCols = [...fields.flatMap(recordFieldColumns), ...carriedCols(st.carried)];
  const rel = st.q.cte(q`SELECT ${list(cols, ', ')}${carryFrag(st.carried, p)} FROM ${p}${list(joins, '')}`, relCols);
  return toRecordStream(carryOf(st), rel, fields);
}

/** Compatibility adapter for element modifiers accumulated before a terminal record
 * projection. New projection-first chains take the RecordStream path directly. */
export function compileSelectProject(st: ElementStream, proj: PStep, tail: TailMods): Compiled {
  if (tail.orders.length) throw new Error('order() after select()/project() not yet supported');
  let record = lowerRecordSelectProject(st, proj);
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
  return materializeRecordRoot(record);
}

/** Continue from a per-traverser record. Selecting a named field retypes it to the
 * ordinary scalar/element stream, while Column.keys/values produces one list value
 * per record. This is intentionally distinct from MapStream's whole-group columns. */
export function compileFromRecord(s: RecordStream, steps: PStep[], at: number): Compiled {
  if (at >= steps.length) return materializeRecordRoot(s);
  const step = steps[at];
  if (step.name === 'count')
    return dispatchNext(lowerGlobalCount(s), steps, at + 1);
  if (step.name === 'limit' || step.name === 'range' || step.name === 'skip' || step.name === 'tail') {
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
      return dispatchNext(toRecordStream(carryOf(s), rel, fields), steps, at + 1);
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
    return dispatchNext(toRecordStream(carryOf(s), rel, s.fields), steps, at + 1);
  }
  if (step.name !== 'select') throw new Error(`${step.name}() on a record value not yet supported`);

  const pop = step.args.find((a) => a && typeof a === 'object' && 'pop' in a) as { pop: string } | undefined;
  if (pop && pop.pop !== 'last') throw new Error(`select(Pop.${pop.pop}) on a record not yet supported`);
  const column = step.args.map((a: any) => a && typeof a === 'object' && a.column)
    .find((c: any) => c === 'keys' || c === 'values') as 'keys' | 'values' | undefined;
  const r = s.rel.as('r');
  if (column) {
    if (step.bys?.length) throw new Error('by() after select(Column) on a record not yet supported');
    let expr: Expression;
    if (column === 'keys') expr = q`jsonb(${value(JSON.stringify(s.fields.map((f) => f.key)))})`;
    else {
      if (s.fields.some((f) => f.sub !== 'value'))
        throw new Error('select(Column.values) on a record containing elements needs a variant list stream');
      expr = q`jsonb_array(${list(s.fields.map((f) => r.c[`${f.prefix}_v`]), ', ')})`;
    }
    const rel = s.q.cte(
      q`SELECT ${expr} AS list${carryFrag(s.carried, r)} FROM ${r}`,
      ['list', ...carriedCols(s.carried)],
    );
    return dispatchNext(toListStream(carryOf(s), rel, { kind: 'scalar' }), steps, at + 1);
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
    return dispatchNext(toScalarStream(carryOf(s), rel), steps, at + 1);
  }
  const rel = s.q.cte(
    q`SELECT ${r.c[`${field.prefix}_rid`]} AS id${carryFrag(s.carried, r)} FROM ${r}`,
    ['id', ...carriedCols(s.carried)],
  );
  return dispatchNext({ ...carryOf(s), kind: 'elements', rel, elem: field.sub === 'edge' ? 'edge' : 'node' }, steps, at + 1);
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
  if (st.carried.path.kind === 'array') return compilePathArray(st, acc);
  const pathState = st.carried.path; // narrowed to 'cols'; held in a local so the .map closure keeps the narrowing
  if (acc.orders.length) throw new Error('order() after path() not yet supported');
  if (acc.reducer) throw new Error(`${acc.reducer}() after path() not yet supported`);
  if (acc.isPreds.length) throw new Error('is() after path() not yet supported');
  if (acc.transforms.length) throw new Error(`${acc.transforms[0].name}() after path() not yet supported`);
  if (acc.injects.length) throw new Error('inject() after path() not yet supported');

  const bys = proj.bys ?? [];
  // A branched path (pad-to-max cols) has nullable positions: a shorter arm left them
  // NULL. LEFT JOIN those (an INNER JOIN would drop the whole short-arm path), and the
  // handler (pathBuffer) omits a null-id position. by() can't ride a branched path —
  // a padded NULL is indistinguishable from a missing property, so defer.
  const branched = pathState.cols.some((c) => c.nullable);
  if (branched && bys.length) throw new Error('path().by() through a branch not yet supported (a padded position is indistinguishable from a missing property)');
  const p = st.rel.as('p');
  const joins: Expression[] = [];
  const cols: Expression[] = [];
  const whereParts: Expression[] = [];
  const positions: PathPos[] = pathState.cols.map((pos, i) => {
    const prefix = `x${i}`;
    const tbl = (pos.elem === 'edge' ? edges : nodes).as(`${prefix}n`);
    const jn = pos.nullable ? 'LEFT JOIN' : 'JOIN';
    joins.push(q` ${jn} ${tbl} ON ${tbl.c.id}=${p.c[pos.col]}`);
    const key = pathBy(bys.length ? bys[i % bys.length] : undefined);
    if (key === undefined) {
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
    // by(key): project the element's property (first-under-multi for a vertex); a missing
    // key drops the whole path. Edge → json_extract of the flat blob.
    const pe = pos.elem === 'edge' ? propExtract(tbl.c.props, key).expr : nodePropScalar(tbl.c.id, key);
    cols.push(q`${pe} AS ${`${prefix}_v`}`);
    whereParts.push(predicateSql(pe, undefined)); // <pe> IS NOT NULL (non-productive by → drop)
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
function compilePathArray(st: ElementStream, acc: TailAcc): PathStream {
  if (acc.orders.length || acc.reducer || acc.isPreds.length || acc.transforms.length || acc.injects.length)
    throw new Error('order()/reducer/is()/transform after a recursive repeat().path() not yet supported');
  // dedup() must collapse equal paths BEFORE row-numbering: ROW_NUMBER() is computed
  // with the SELECT list, so a `SELECT DISTINCT path, ROW_NUMBER()…` never removes a
  // row (the unique pk defeats DISTINCT). Distinct-ify in a prior CTE, then number.
  const src = acc.distinct ? st.q.cte(q`SELECT DISTINCT ${st.rel.c.path} AS path FROM ${st.rel}`, ['path']) : st.rel;
  // ROW_NUMBER over the surviving paths → a stable per-path key so equal-id paths
  // stay distinct (multiset) after the json_each explode.
  const limitSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const paths = st.q.cte(q`SELECT ${src.c.path} AS path, ROW_NUMBER() OVER (ORDER BY ${src.c.path}) AS pk FROM ${src}${limitSql}`, ['path', 'pk']);
  const n = nodes.as('n');
  const l = labels.as('l');
  const node = q`SELECT pp.pk, je.key AS ord, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props FROM ${paths} pp, json_each(pp.path) je JOIN ${n} ON ${n.c.id}=je.value JOIN ${l} ON ${l.c.id}=${n.c.label} ORDER BY pp.pk, je.key`;
  const layout = { kind: 'grouped' as const, elem: 'vertex' as const };
  const rel = st.q.cte(node, pathColumns(layout));
  return toPathStream(withoutCarried(carryOf(st)), rel, layout);
}
