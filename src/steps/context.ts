import { q, list, empty, Query, Relation, type Expression } from '../q.ts';
import { nodes, edges } from '../schema.ts';
import { type Elem } from '../plan.ts';
import { type PStep } from '../strategies.ts';

// ---------- prefix-compilation state (Seam 2) ----------
//
// The movement/filter/branch step compilers are a *functional fold*: each is a
// StepFn `(step, St) => St` that appends its CTE and returns a NEW state pointing
// at it. Nothing mutates in place — the dispatch threads `St` immutably (see
// src/steps/index.ts). The one piece of essential state, minting unique CTE names
// and collecting their bodies for the final WITH, is encapsulated in the `Query`
// builder (src/q.ts): a StepFn calls `st.q.cte(body)` and gets back a Relation
// handle it references downstream exactly like a base table.

/** Bound as() labels: label → its carried column (a0, a1, … — user strings never
 *  enter SQL identifiers) + the element kind it holds at bind time (so a later
 *  select/where knows whether the label is a vertex or an edge). */
export type AliasMap = ReadonlyMap<string, { col: string; elem: Elem }>;

/** Path tracking (linear regime): the ordered path elements, each remembered as a
 *  carried column (p0, p1, … — one per emitting step) + the element kind at that
 *  position. Present only when the chain contains path()/simplePath()/cyclicPath()
 *  (seeded at V()); movement appends a position, filters carry them unchanged. */
export interface PathState { readonly cols: readonly { col: string; elem: Elem }[]; }

/** The carried path columns, in order (p0, p1, …). */
export const pathColsOf = (p?: PathState): string[] => p ? p.cols.map((x) => x.col) : [];

/** Append a new path position holding the current id, kind `elem`. Returns the new
 *  PathState and the freshly-minted column name (p{k}). */
export function appendPathPos(p: PathState, elem: Elem): { path: PathState; col: string } {
  const col = `p${p.cols.length}`;
  return { path: { cols: [...p.cols, { col, elem }] }, col };
}

/** Immutable prefix state threaded through the step fold. Everything the dispatch
 *  reasons about is replaced wholesale by each StepFn's return; `q` is the shared
 *  append-only CTE builder. */
export interface St {
  readonly q: Query;
  readonly last: Relation;               // the current id-relation (a CTE handle)
  readonly aliases: AliasMap;
  readonly elem: Elem;
  readonly indexKeys: ReadonlySet<string>;
  readonly params: Record<string, any>;
  readonly path?: PathState;             // present iff the chain tracks a linear path
}

/** A prefix step compiler: consume the step, return the next state. */
export type StepFn = (s: PStep, st: St) => St;

/** The carried alias columns, in bind order (a0, a1, …). */
export const aliasColsOf = (a: AliasMap): string[] => [...a.values()].map((x) => x.col);

/** The current id-relation, optionally aliased. Its columns are id + every carried
 *  alias column, so `prevRel(st,'p').c.a0` resolves downstream. */
export const prevRel = (st: St, alias?: string): Relation => alias ? st.last.as(alias) : st.last;

/** The current element's table aliased `n` (nodes/edges by elem). */
export const elemRel = (st: St, alias = 'n'): Relation => (st.elem === 'edge' ? edges : nodes).as(alias);

/** Every column carried UNCHANGED across a hop: the as() alias columns plus the
 *  path-position columns (when path tracking is active). */
export const carriedCols = (st: St): string[] => [...aliasColsOf(st.aliases), ...pathColsOf(st.path)];

/** `, p.a0, p.p0, …` — the carried columns qualified by `p`; empty when nothing is
 *  live. Movement/filter CTEs splice this after the moved id so labelled traversers
 *  and path positions ride forward. */
export function carryFrag(st: St, p: Relation): Expression {
  const cols = carriedCols(st);
  return cols.length ? list(cols.map((c) => q`, ${p.c[c]}`), '') : empty;
}

/**
 * Append `body` as the new id-relation and advance to it. `cols` defaults to
 * id + the currently-bound alias columns (what movement/filter carry); as()
 * passes a widened alias set. `elem`/`indexKeys` override when a step changes the
 * element kind (…E/…V) or reports a hot key. The returned St is a fresh object —
 * the old one is untouched.
 */
export function advance(
  st: St, body: Expression,
  opts: { aliases?: AliasMap; elem?: Elem; cols?: readonly string[]; indexKeys?: Iterable<string>; path?: PathState } = {},
): St {
  const aliases = opts.aliases ?? st.aliases;
  const path = opts.path ?? st.path;
  const cols = opts.cols ?? ['id', ...aliasColsOf(aliases), ...pathColsOf(path)];
  return {
    ...st,
    aliases,
    path,
    elem: opts.elem ?? st.elem,
    last: st.q.cte(body, cols),
    indexKeys: opts.indexKeys ? new Set([...st.indexKeys, ...opts.indexKeys]) : st.indexKeys,
  };
}
