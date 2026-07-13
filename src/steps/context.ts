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

/** Path tracking. Two regimes (see docs/2026-07-12-path-tracking-prior-art.md):
 *  - `cols` (linear): each emitted element is a carried column (p0, p1, … — one per
 *    mapping step, statically known length). Movement appends a position; filters
 *    carry them unchanged. Backs path()/simplePath()/cyclicPath() over plain movement.
 *  - `array` (recursive): the repeat() walk accumulates a single JSONB array column
 *    (dynamic length). Backs repeat(...).path() — `col` is the array column, `elem`
 *    the walk's element kind (node for out/in/both). */
export type PathState =
  | { readonly kind: 'cols'; readonly cols: readonly { col: string; elem: Elem }[] }
  | { readonly kind: 'array'; readonly col: string; readonly elem: Elem };

/** The carried path columns: the p0,p1,… positions (linear) or the single array
 *  column (recursive). */
export const pathColsOf = (p?: PathState): string[] =>
  !p ? [] : p.kind === 'cols' ? p.cols.map((x) => x.col) : [p.col];

/** Append a new linear path position holding the current id, kind `elem`. Only the
 *  `cols` regime appends per hop; a recursive `array` path is terminal (movement
 *  after it isn't supported). Returns the new PathState + the minted column (p{k}). */
export function appendPathPos(p: PathState, elem: Elem): { path: PathState; col: string } {
  if (p.kind !== 'cols') throw new Error('movement after recursive repeat().path() not yet supported');
  const col = `p${p.cols.length}`;
  return { path: { kind: 'cols', cols: [...p.cols, { col, elem }] }, col };
}

/** A named side-effect collection (aggregate()/store()/group('a')) — the registry
 *  value threaded through Carry.sideEffects. Registered where the step appears (may be
 *  mid-chain), read back at cap('name'). A `list` def is a materialized JSONB list CTE
 *  (aggregate: element rowids or a by()-projected scalar); a `group` def is a stashed
 *  group-spec re-run by cap (see steps/group.ts, Stage 3). Unlike the id-relation,
 *  this state outlives the current traverser stream. */
export type SideEffectDef =
  | { kind: 'list'; rel: Relation; of: { kind: 'elem'; elem: Elem } | { kind: 'scalar' } }
  | { kind: 'group'; from: string; ctx: import('../plan.ts').ScalarCtx; elem: import('../render.ts').ElemShape; isCount: boolean; bys: any[][] };
export type SideEffectMap = ReadonlyMap<string, SideEffectDef>;

/** The context every traverser stream carries, independent of its shape (elements
 *  vs a scalar/list value stream — see stream.ts). Carved out of `St` so a retype
 *  at a tail boundary (fold→list, unfold→elements/scalar) preserves the shared state
 *  — the query builder, bound params, live aliases, path, coalesce ordinal, sack, and
 *  the named side-effect registry — without the elements-only `last`/`elem`. */
export interface Carry {
  readonly q: Query;
  readonly aliases: AliasMap;
  readonly params: Record<string, any>;
  readonly path?: PathState;             // present iff the chain tracks a linear path
  readonly origin?: string;              // coalesce/optional: the carried input-ordinal column
  readonly sack?: string;                // sack: the carried per-traverser scalar column (e.g. 'sk')
  readonly sideEffects?: SideEffectMap;  // named side-effect collections (aggregate/store/group('a'))
}

/** Immutable prefix state threaded through the step fold. Everything the dispatch
 *  reasons about is replaced wholesale by each StepFn's return; `q` is the shared
 *  append-only CTE builder. The `elements` arm of the `Stream` union (stream.ts):
 *  movement/filter/branch StepFns are ONLY ever handed this shape. */
export interface St extends Carry {
  readonly kind: 'elements';
  readonly last: Relation;               // the current id-relation (a CTE handle)
  readonly elem: Elem;
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

/** Every column carried UNCHANGED across a hop: the as() alias columns, the
 *  path-position columns (when path tracking is active), and the coalesce/optional
 *  input-ordinal (when set) — so a branch body's results stay tagged with which
 *  input traverser produced them. */
export const carriedCols = (st: St): string[] =>
  [...aliasColsOf(st.aliases), ...pathColsOf(st.path), ...(st.origin ? [st.origin] : []), ...(st.sack ? [st.sack] : [])];

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
 * passes a widened alias set. `elem` overrides when a step changes the element kind
 * (…E/…V). The returned St is a fresh object — the old one is untouched.
 */
export function advance(
  st: St, body: Expression,
  opts: { aliases?: AliasMap; elem?: Elem; cols?: readonly string[]; path?: PathState; origin?: string | null; sack?: string | null } = {},
): St {
  const aliases = opts.aliases ?? st.aliases;
  const path = opts.path ?? st.path;
  // origin: opts.origin === null clears it (a branch step dropping the ordinal at
  // its output); undefined keeps st's; a string sets it. sack rides the same tri-state.
  const origin = opts.origin === null ? undefined : (opts.origin ?? st.origin);
  const sack = opts.sack === null ? undefined : (opts.sack ?? st.sack);
  const cols = opts.cols ?? ['id', ...aliasColsOf(aliases), ...pathColsOf(path), ...(origin ? [origin] : []), ...(sack ? [sack] : [])];
  return {
    ...st,
    aliases,
    path,
    origin,
    sack,
    elem: opts.elem ?? st.elem,
    last: st.q.cte(body, cols),
  };
}
