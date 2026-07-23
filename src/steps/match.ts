import { q, list, empty, type Expression } from '../sql/kernel/q.ts';
import { stepChain, type Step } from '../gremlin/frontend.ts';
import { normalize, type PStep } from '../compiler/ir/strategies.ts';
import { advance, aliasColsOf, prevRel, type AliasEntry, type ElementStream, type StepFn } from './context.ts';
import { aliasId, aliasSeed, nodeEntry } from './alias.ts';
import { engineOf } from '../compiler/engine/deps.ts';

// ---------- match() — declarative conjunctive pattern join ----------
//
// match(p1, p2, …) finds all consistent bindings of its pattern variables. Each
// pattern is `as(start).<element traversal>.as(end)`: navigate from a bound var to bind
// (or constrain) another. We compile it as a prefix step that JOIN-extends the carried
// alias columns — bind the root var (the one start that is never an end) to the incoming
// id, then fold the patterns in dependency order. Each pattern re-roots a fresh element
// stream at its start var's rowid (carrying every bound var column) and lowers its body
// through the SHARED movement/filter StepFns (lowerElementSteps) — NOT a private
// movement/filter compiler — so out/in/both/…E/…V + has/hasLabel/hasId/where all work
// exactly as they do at root. It then re-projects: restore `id` to the root's rowid (an
// invariant of the binding table, recoverable as the root var's last-history id) and
// bind the end var (new col) or constrain it (WHERE equality when already bound). The
// result keeps `id` = the root's id and carries every bound var as an alias column, so a
// downstream select/count/dedup consumes it via the usual rails.
//
// Deferred (clear errors): a scalar-terminal pattern (count/values binds a scalar var —
// the binding table carries node rowids), an edge-typed end var, an intra-pattern as()
// label, or/not/nested-match patterns, and any shape with other than exactly one
// start-only root variable (e.g. mutual a↔b recursion).

interface Pattern { start: string; body: PStep[]; end: string | null; }

/** as(start).<body…>.[as(end)] → its parts. The body is normalized so it crosses the
 *  same seam as a root/child chain before the StepFn fold. */
function parsePattern(chain: Step[]): Pattern {
  if (!chain.length || chain[0].name !== 'as' || typeof chain[0].args[0] !== 'string')
    throw new Error('match() pattern must start with as("x")');
  const start = chain[0].args[0];
  let mid = chain.slice(1);
  let end: string | null = null;
  const last = mid[mid.length - 1];
  if (last?.name === 'as' && typeof last.args[0] === 'string') { end = last.args[0]; mid = mid.slice(0, -1); }
  return { start, body: normalize(mid).steps, end };
}

/** Apply one pattern: re-root a fresh element stream at the start var, fold its body
 *  through the shared StepFns, then re-project the binding table with the end bound. */
function applyPattern(st: ElementStream, p: Pattern, aliases: Map<string, AliasEntry>, rootCol: string, bind: (v: string) => string): ElementStream {
  const prev = prevRel(st, 'p');
  const startCol = aliases.get(p.start)!.col;
  const varCols = aliasColsOf(aliases);

  // Seed: id = the start var's rowid, carrying every bound var column so movement/filter
  // thread them through unchanged. The bound vars ARE the seed's carried aliases.
  const seedRel = st.q.cte(
    q`SELECT ${aliasId(prev.c[startCol], 'last')} AS id${list(varCols.map((c) => q`, ${prev.c[c]}`), '')} FROM ${prev}`,
    ['id', ...varCols]);
  const seed: ElementStream = { ...st, rel: seedRel, elem: 'node', carried: { aliases: new Map(aliases), origins: [] } };

  const { stream: end, next } = engineOf(seed).lowerElementSteps(p.body, seed);
  if (next !== p.body.length)
    throw new Error(`match() pattern step __.${p.body[next].name}() not yet supported`);
  if (end.elem !== 'node')
    throw new Error('match() edge-typed pattern (end var is an edge) not yet supported');
  if (end.carried.aliases.size !== aliases.size || end.carried.path || end.carried.origins.length)
    throw new Error('match() pattern binding an intra-pattern label not yet supported');

  // Re-project: restore id = the root's rowid (== aliasId(rootCol), the binding-table
  // invariant), keep every var column, and bind/constrain the end var.
  const f = end.rel.as('f');
  const proj: Expression[] = [q`${aliasId(f.c[rootCol], 'last')} AS id`, ...varCols.map((c) => q`${f.c[c]}`)];
  const conds: Expression[] = [];
  if (p.end) {
    if (aliases.has(p.end)) conds.push(q`${f.c.id}=${aliasId(f.c[aliases.get(p.end)!.col], 'last')}`);
    else proj.push(q`${aliasSeed(nodeEntry(f.c.id))} AS ${bind(p.end)}`); // bind() mutates `aliases`
  }
  const where = conds.length ? q` WHERE ${list(conds, ' AND ')}` : empty;
  return advance(st, q`SELECT ${list(proj, ', ')} FROM ${f}${where}`,
    { aliases: new Map(aliases), bulk: null, cols: ['id', ...aliasColsOf(aliases)] });
}

export const match: StepFn = (s, st) => {
  if (st.elem !== 'node') throw new Error('match() on edges not yet supported');
  if (st.carried.path) throw new Error('path tracking through match() not yet supported');
  const patArgs = s.args.filter((a) => a && typeof a === 'object' && 'nested' in a);
  if (!patArgs.length) throw new Error('match() needs at least one pattern');
  const pats = patArgs.map((a) => parsePattern(stepChain(a.nested, st.params)));

  // Root = a start var never used as an end (bound to the incoming traverser).
  const ends = new Set(pats.map((p) => p.end).filter((e): e is string => !!e));
  const roots = [...new Set(pats.map((p) => p.start))].filter((v) => !ends.has(v) && !st.carried.aliases.has(v));
  if (roots.length !== 1)
    throw new Error(`match() with ${roots.length} root variables not yet supported (needs exactly one start-only var)`);
  const root = roots[0];

  const aliases = new Map(st.carried.aliases);
  const bind = (v: string): string => {
    let e = aliases.get(v);
    if (!e) { e = { col: `a${aliases.size}`, shapes: new Set(['node' as const]) }; aliases.set(v, e); }
    return e.col;
  };

  // Seed: carry the incoming id + any outer alias columns, and bind the root = id.
  const prev0 = prevRel(st, 'p');
  const rootCol = bind(root);
  const seedProj: Expression[] = [q`${prev0.c.id}`, ...aliasColsOf(st.carried.aliases).map((c) => q`${prev0.c[c]}`), q`${aliasSeed(nodeEntry(prev0.c.id))} AS ${rootCol}`];
  let cur: ElementStream = advance(st, q`SELECT ${list(seedProj, ', ')} FROM ${prev0}`, { aliases: new Map(aliases), cols: ['id', ...aliasColsOf(aliases)] });

  // Greedy dependency order: process a pattern whose start is bound; bind/constrain end.
  const pending = [...pats];
  let guard = pending.length * pending.length + 1;
  while (pending.length) {
    if (guard-- < 0) throw new Error('match() pattern dependency cycle not yet supported');
    const idx = pending.findIndex((p) => aliases.has(p.start));
    if (idx < 0) throw new Error('match() pattern with an unbound start variable not yet supported');
    cur = applyPattern(cur, pending.splice(idx, 1)[0], aliases, rootCol, bind);
  }
  return cur;
};
