import { q, list, empty, type Expression } from '../q.ts';
import { nodes, edges, labels } from '../schema.ts';
import { framedProps, nodePropScalar, predicateSql, propExtract, extIdOf } from '../plan.ts';
import { type PStep } from '../strategies.ts';
import { type AliasMap, type St } from './context.ts';
import { readCompiled, type Compiled, type MapEntry, type PathPos } from '../render.ts';
import { type TailAcc, type TailMods } from './projection.ts';

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
export function compileSelectProject(st: St, proj: PStep, tail: TailMods): Compiled {
  const bys = proj.bys ?? [];
  const { orders, distinct, offset, limit } = tail;
  if (orders.length) throw new Error('order() after select()/project() not yet supported');
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
      return readCompiled(st.q, q`SELECT ${dist}COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props FROM ${n} JOIN ${p} ON ${n.c.id}=${src} JOIN ${l} ON ${l.c.id}=${n.c.label}${tailSql}`, { kind: 'vertex' });
    }
    const pe = nodePropScalar(n.c.id, e.key!); // first-under-multi; projection, not indexed (matches values())
    return readCompiled(st.q, q`SELECT ${dist}${pe} AS v FROM ${n} JOIN ${p} ON ${n.c.id}=${src}${tailSql}`, { kind: 'value' });
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
      cols.push(q`COALESCE(${en.c.uid}, ${en.c.id}) AS ${`${prefix}_id`}, ${el.c.name} AS ${`${prefix}_label`}, ${framedProps(en, 'node')} AS ${`${prefix}_props`}`);
    } else {
      cols.push(q`${nodePropScalar(en.c.id, e.key!)} AS ${`${prefix}_v`}`); // first-under-multi; projection, not indexed
    }
    return { key: k, prefix, sub: e.sub };
  });

  const node = q`SELECT ${dist}${list(cols, ', ')} FROM ${p}${list(joins, '')}${tailSql}`;
  return readCompiled(st.q, node, { kind: 'map', entries });
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
export function compilePath(st: St, proj: PStep, acc: TailAcc): Compiled {
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
  const p = st.last.as('p');
  const joins: Expression[] = [];
  const cols: Expression[] = [];
  const whereParts: Expression[] = [];
  const positions: PathPos[] = pathState.cols.map((pos, i) => {
    const prefix = `x${i}`;
    const tbl = (pos.elem === 'edge' ? edges : nodes).as(`${prefix}n`);
    joins.push(q` JOIN ${tbl} ON ${tbl.c.id}=${p.c[pos.col]}`);
    const key = pathBy(bys.length ? bys[i % bys.length] : undefined);
    if (key === undefined) {
      const l = labels.as(`${prefix}l`);
      joins.push(q` JOIN ${l} ON ${l.c.id}=${tbl.c.label}`);
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
  return readCompiled(st.q, node, { kind: 'path', positions });
}

/**
 * path() over a recursive repeat() walk (the `array` regime). The walk (branch.ts)
 * accumulated a JSONB array of visited ids per surviving traverser (`st.last` =
 * `(id, path)`). Give each path a row number (`pk`), explode the array with
 * `json_each` (`.key` = ordinal), materialize each element, and emit ONE ROW PER
 * PATH ELEMENT ordered by `(pk, ord)` — the handler folds each pk-run into one Path.
 * All elements are vertices (out/in/both bodies); edge-inclusive bodies defer.
 */
function compilePathArray(st: St, acc: TailAcc): Compiled {
  if (acc.orders.length || acc.reducer || acc.isPreds.length || acc.transforms.length || acc.injects.length)
    throw new Error('order()/reducer/is()/transform after a recursive repeat().path() not yet supported');
  // dedup() must collapse equal paths BEFORE row-numbering: ROW_NUMBER() is computed
  // with the SELECT list, so a `SELECT DISTINCT path, ROW_NUMBER()…` never removes a
  // row (the unique pk defeats DISTINCT). Distinct-ify in a prior CTE, then number.
  const src = acc.distinct ? st.q.cte(q`SELECT DISTINCT ${st.last.c.path} AS path FROM ${st.last}`, ['path']) : st.last;
  // ROW_NUMBER over the surviving paths → a stable per-path key so equal-id paths
  // stay distinct (multiset) after the json_each explode.
  const limitSql = (acc.limit !== null || acc.offset > 0) ? q` LIMIT ${acc.limit ?? -1} OFFSET ${acc.offset}` : empty;
  const paths = st.q.cte(q`SELECT ${src.c.path} AS path, ROW_NUMBER() OVER (ORDER BY ${src.c.path}) AS pk FROM ${src}${limitSql}`, ['path', 'pk']);
  const n = nodes.as('n');
  const l = labels.as('l');
  const node = q`SELECT pp.pk, je.key AS ord, COALESCE(${n.c.uid}, ${n.c.id}) AS id, ${l.c.name} AS label, ${framedProps(n, 'node')} AS props FROM ${paths} pp, json_each(pp.path) je JOIN ${n} ON ${n.c.id}=je.value JOIN ${l} ON ${l.c.id}=${n.c.label} ORDER BY pp.pk, je.key`;
  return readCompiled(st.q, node, { kind: 'pathGrouped', elem: 'vertex' });
}
