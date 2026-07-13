import { q, list, empty, raw, type Expression } from '../q.ts';
import { labelIn, predicateSql, nodeHasProp, dirsFor } from '../plan.ts';
import { stepChain, type Step } from '../frontend.ts';
import { advance, aliasColsOf, prevRel, type AliasMap, type St, type StepFn } from './context.ts';

// ---------- match() — declarative conjunctive pattern join ----------
//
// match(p1, p2, …) finds all consistent bindings of its pattern variables. Each
// pattern is `as(start).<out/in([label])>*[.has/hasLabel].as(end)`: navigate from a
// bound var to bind (or constrain) another. We compile it as a prefix step that
// JOIN-extends the carried alias columns — bind the root var (the one start that is
// never an end) to the incoming id, then fold the patterns in dependency order, each
// pattern one join CTE that adds its end column (or a WHERE equality when the end is
// already bound). The result keeps `id` = the root's id and carries every bound var as
// an alias column, so a downstream select/count/dedup consumes it via the usual rails.
//
// Deferred (clear errors): both()/edge/scalar-terminal (count/values) patterns, or/
// not/where/nested-match patterns, repeat/order/map in a pattern, and any shape with
// other than exactly one start-only root variable (e.g. mutual a↔b recursion).

interface Pattern { start: string; hops: Step[]; filters: Step[]; end: string | null; }

/** as(start).<out/in>*[.has/hasLabel].as(end) → its parts. */
function parsePattern(chain: Step[]): Pattern {
  if (!chain.length || chain[0].name !== 'as' || typeof chain[0].args[0] !== 'string')
    throw new Error('match() pattern must start with as("x")');
  const start = chain[0].args[0];
  let mid = chain.slice(1);
  let end: string | null = null;
  const last = mid[mid.length - 1];
  if (last?.name === 'as' && typeof last.args[0] === 'string') { end = last.args[0]; mid = mid.slice(0, -1); }
  const hops: Step[] = [];
  let i = 0;
  for (; i < mid.length && (mid[i].name === 'out' || mid[i].name === 'in'); i++) hops.push(mid[i]);
  const filters = mid.slice(i);
  const bad = filters.find((f) => f.name !== 'has' && f.name !== 'hasLabel');
  if (bad) throw new Error(`match() pattern step __.${bad.name}() not yet supported`);
  return { start, hops, filters, end };
}

/** ` AND <alias>.label IN (…)` for a hop's edge-label filter (per-alias, unlike the
 *  fixed-`e` edgeLabelFilter). */
const hopLabel = (e: string, args: any[]): Expression => (args.length ? q` AND ${labelIn(`${e}.label`, args)}` : empty);

/** Apply one pattern as a join CTE extending the carried columns. */
function applyPattern(st: St, p: Pattern, aliases: Map<string, { col: string; elem: 'node' | 'edge' }>, bind: (v: string) => string): St {
  const prev = prevRel(st, 'p');
  const sCol = aliases.get(p.start)!.col;
  const carried: Expression[] = ['id', ...aliasColsOf(aliases)].map((c) => q`${prev.c[c]}`);

  const joins: Expression[] = [];
  const conds: Expression[] = [];
  let lastNode: string;
  if (p.hops.length === 0) {
    lastNode = 'mn'; // filter-only constraint on the start var's element
    joins.push(q`JOIN nodes mn ON mn.id=${prev.c[sCol]}`);
  } else {
    let prevId: Expression = prev.c[sCol];
    p.hops.forEach((h, k) => {
      const [from, to] = dirsFor(h.name)[0];
      const e = `me${k}`, n = `mn${k}`;
      joins.push(q`JOIN edges ${e} ON ${e}.${from}=${prevId}${hopLabel(e, h.args)} JOIN nodes ${n} ON ${n}.id=${e}.${to}`);
      prevId = q`${n}.id`;
    });
    lastNode = `mn${p.hops.length - 1}`;
  }

  for (const f of p.filters) {
    if (f.name === 'hasLabel') { conds.push(labelIn(`${lastNode}.label`, f.args)); continue; }
    let a = f.args; // has(label,key,value) 3-arg folds in a label filter
    if (a.length === 3 && typeof a[0] === 'string') { conds.push(labelIn(`${lastNode}.label`, [a[0]])); a = a.slice(1); }
    if (a[0] && typeof a[0] === 'object' && 'token' in a[0]) {
      const expr = a[0].token === 'label' ? q`(SELECT name FROM labels WHERE id=${lastNode}.label)`
        : a[0].token === 'id' ? q`COALESCE(${lastNode}.uid, ${lastNode}.id)`
        : (() => { throw new Error(`match() pattern has(T.${a[0].token}) not yet supported`); })();
      conds.push(predicateSql(expr, a[1]));
    } else {
      // has(key,val) on the pattern's node → ANY-match EXISTS over vertex_properties.
      conds.push(nodeHasProp(raw(`${lastNode}.id`), a[0], a[1]));
    }
  }

  const proj = [...carried];
  if (p.end) {
    if (aliases.has(p.end)) conds.push(q`${lastNode}.id=${prev.c[aliases.get(p.end)!.col]}`);
    else { const col = bind(p.end); proj.push(q`${lastNode}.id AS ${col}`); }
  }
  const where = conds.length ? q` WHERE ${list(conds, ' AND ')}` : empty;
  return advance(st, q`SELECT ${list(proj, ', ')} FROM ${prev} ${list(joins, ' ')}${where}`,
    { aliases: new Map(aliases), cols: ['id', ...aliasColsOf(aliases)] });
}

export const match: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('match() on edges not yet supported');
  if (st.path) throw new Error('path tracking through match() not yet supported');
  const patArgs = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (!patArgs.length) throw new Error('match() needs at least one pattern');
  const pats = patArgs.map((a) => parsePattern(stepChain(a.nested, st.params)));

  // Root = a start var never used as an end (bound to the incoming traverser).
  const ends = new Set(pats.map((p) => p.end).filter((e): e is string => !!e));
  const roots = [...new Set(pats.map((p) => p.start))].filter((v) => !ends.has(v) && !st.aliases.has(v));
  if (roots.length !== 1)
    throw new Error(`match() with ${roots.length} root variables not yet supported (needs exactly one start-only var)`);
  const root = roots[0];

  const aliases = new Map(st.aliases);
  const bind = (v: string): string => {
    let e = aliases.get(v);
    if (!e) { e = { col: `a${aliases.size}`, elem: 'node' as const }; aliases.set(v, e); }
    return e.col;
  };

  // Seed: carry the incoming id + any outer alias columns, and bind the root = id.
  const prev0 = prevRel(st, 'p');
  const rootCol = bind(root);
  const seedProj: Expression[] = [q`${prev0.c.id}`, ...aliasColsOf(st.aliases).map((c) => q`${prev0.c[c]}`), q`${prev0.c.id} AS ${rootCol}`];
  let cur: St = advance(st, q`SELECT ${list(seedProj, ', ')} FROM ${prev0}`, { aliases: new Map(aliases), cols: ['id', ...aliasColsOf(aliases)] });

  // Greedy dependency order: process a pattern whose start is bound; bind/constrain end.
  const pending = [...pats];
  let guard = pending.length * pending.length + 1;
  while (pending.length) {
    if (guard-- < 0) throw new Error('match() pattern dependency cycle not yet supported');
    const idx = pending.findIndex((p) => aliases.has(p.start));
    if (idx < 0) throw new Error('match() pattern with an unbound start variable not yet supported');
    cur = applyPattern(cur, pending.splice(idx, 1)[0], aliases, bind);
  }
  return cur;
};
