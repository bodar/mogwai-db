import { q, list, empty, Query, Relation, type Expression } from '../q.ts';
import { nodes, edges } from '../schema.ts';
import { type Elem } from '../plan.ts';
import { type PStep } from '../strategies.ts';

// ---------- prefix-compilation state (Seam 2) ----------
//
// The movement/filter/branch step compilers are a *functional fold*: each is a
// StepFn `(step, ElementStream) => ElementStream` that appends its CTE and returns a NEW state pointing
// at it. Nothing mutates in place — the dispatch threads `ElementStream` immutably (see
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
  | { readonly kind: 'cols'; readonly cols: readonly { col: string; elem: Elem; nullable?: boolean }[] }
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
  | { kind: 'list'; rel: Relation; of: import('../render.ts').ListOf }
  | { kind: 'variant'; rel: Relation; scalarAs?: import('../render.ts').ValueType; elem?: Elem }
  | { kind: 'group'; from: string; ctx: import('../plan.ts').ScalarCtx; elem: import('../render.ts').ElemShape; isCount: boolean; bys: any[][]; parent: ElementStream; productiveBy?: boolean };
export type SideEffectMap = ReadonlyMap<string, SideEffectDef>;

/** The per-traverser CARRIED SCHEMA: the columns physically present on the id-relation
 *  beyond `id`, threaded UNCHANGED across every hop and REQUIRED to agree across a
 *  branch merge. These six travel together as ONE unit — grouping them here (rather than
 *  as loose siblings on Carry) is what makes a branch/tail step that silently drops them
 *  structurally obvious, and keeps carriedCols/carryFrag/mergeCarried the single source
 *  of truth. A struct of TYPED ROLES on purpose, NOT a flat column list: aliases is a
 *  name→col Map (select/where lookup), path a two-regime union, sack is mutable, fromV
 *  clears on landing, origin drops at a branch output — homogenising them would re-lose
 *  the structure each reader needs. */
export interface Carried {
  readonly aliases: AliasMap;
  readonly path?: PathState;             // present iff the chain tracks a linear path
  readonly origins: readonly string[];   // coalesce/optional input-ordinal columns — a STACK (nested branches each push their own unique ordinal; the innermost is last)
  readonly sack?: string;                // sack: the carried per-traverser scalar column (e.g. 'sk')
  readonly fromV?: string;               // edge context: the vertex an edge was entered from (for otherV())
  readonly trackFromV?: boolean;         // seeded true iff the chain uses otherV() — gates fromV emission (hot-path: no extra column otherwise)
}

/** The context every traverser stream carries, independent of its shape (elements vs a
 *  scalar/list value stream — see stream.ts). Carved out of `ElementStream` so a retype at a tail
 *  boundary (fold→list, unfold→elements/scalar) preserves the shared state. Three
 *  DELIBERATELY-distinguished kinds of thing: ambient compile context (`q`/`params`),
 *  the named side-effect registry (`sideEffects` — CTEs that OUTLIVE the traverser), and
 *  the per-traverser carried column schema (`carried`). */
export interface Carry {
  readonly q: Query;
  readonly params: Record<string, any>;
  readonly sideEffects?: SideEffectMap;  // named side-effect collections (aggregate/store/group('a'))
  readonly carried: Carried;             // the per-traverser carried column schema
}

/** Immutable prefix state threaded through the step fold. Everything the dispatch
 *  reasons about is replaced wholesale by each StepFn's return; `q` is the shared
 *  append-only CTE builder. The `elements` arm of the `Stream` union (stream.ts):
 *  movement/filter/branch StepFns are ONLY ever handed this shape. */
export interface ElementStream extends Carry {
  readonly kind: 'elements';
  readonly rel: Relation;               // the current id-relation (a CTE handle)
  readonly elem: Elem;
}

/** A prefix step compiler: consume the step, return the next state. */
export type StepFn = (s: PStep, st: ElementStream) => ElementStream;

/** The carried alias columns, in bind order (a0, a1, …). */
export const aliasColsOf = (a: AliasMap): string[] => [...a.values()].map((x) => x.col);

/** The current id-relation, optionally aliased. Its columns are id + every carried
 *  alias column, so `prevRel(st,'p').c.a0` resolves downstream. */
export const prevRel = (st: ElementStream, alias?: string): Relation => alias ? st.rel.as(alias) : st.rel;

/** The current element's table aliased `n` (nodes/edges by elem). */
export const elemRel = (st: ElementStream, alias = 'n'): Relation => (st.elem === 'edge' ? edges : nodes).as(alias);

/** Every column carried UNCHANGED across a hop, in a STABLE order: alias columns,
 *  then origin/sack/fromV, then the path-position columns LAST. THE single source of
 *  truth for "what columns are on the id-relation" — movement/filter thread it, and a
 *  branch merge MUST reproduce it (armProjection).
 *
 *  Path MUST be last: movement physically APPENDS each new path position at the end of
 *  its SELECT (after carryFrag of the old carried set), so carriedCols(old) has to be a
 *  prefix of carriedCols(new) for the appended column to land in the right slot. Any
 *  carried column ordered AFTER path would desync the CTE's declared columns from its
 *  physical SELECT once a hop appends a position (the coalesce/optional+path() bug). */
export const carriedCols = (c: Carried): string[] =>
  [...aliasColsOf(c.aliases), ...c.origins, ...(c.sack ? [c.sack] : []), ...(c.fromV ? [c.fromV] : []), ...pathColsOf(c.path)];

/** `, p.a0, p.p0, …` — the carried columns qualified by `p`; empty when nothing is
 *  live. Movement/filter CTEs splice this after the moved id so labelled traversers
 *  and path positions ride forward. */
export function carryFrag(c: Carried, p: Relation): Expression {
  const cols = carriedCols(c);
  return cols.length ? list(cols.map((x) => q`, ${p.c[x]}`), '') : empty;
}

type CarriedOpts = { aliases?: AliasMap; path?: PathState; origins?: readonly string[]; sack?: string | null; fromV?: string | null };

/** Apply a carried-column patch: aliases/path/origins — a value overrides, undefined
 *  keeps; sack/fromV — `null` CLEARS, undefined keeps, a string sets. `origins` is the
 *  whole ordinal stack (a branch push/pop passes the new array explicitly). trackFromV is
 *  chain-global (never changed by advance). */
export function carriedWith(c: Carried, o: CarriedOpts): Carried {
  return {
    aliases: o.aliases ?? c.aliases,
    path: o.path ?? c.path,
    origins: o.origins ?? c.origins,
    sack: o.sack === null ? undefined : (o.sack ?? c.sack),
    fromV: o.fromV === null ? undefined : (o.fromV ?? c.fromV),
    trackFromV: c.trackFromV,
  };
}

/** Return a new stream state with its carried schema shallow-patched (explicit undefined
 *  CLEARS — for the branch/local seeds that reset aliases/path). The escape hatch for the
 *  few sites that rebuild carried directly rather than through advance. */
export const withCarried = <T extends Carry>(st: T, patch: Partial<Carried>): T =>
  ({ ...st, carried: { ...st.carried, ...patch } });

/** Drop row-associated state at a global barrier while retaining ambient compile
 * context and chain requirements. A barrier result is a new traverser and cannot
 * honestly claim aliases/origins/path/sack/fromV from any one input row. */
export const withoutCarried = <T extends Carry>(st: T): T => ({
  ...st,
  carried: { aliases: new Map(), origins: [], trackFromV: st.carried.trackFromV },
});

/**
 * Append `body` as the new id-relation and advance to it. Carried-column opts route
 * through carriedWith (same tri-state as before); `cols` defaults to id + the resulting
 * carried columns; `elem` overrides when a step changes the element kind (…E/…V). Flat
 * opts kept identical, so every call site is unchanged. Returns a fresh ElementStream.
 */
export function advance(
  st: ElementStream, body: Expression,
  opts: CarriedOpts & { elem?: Elem; cols?: readonly string[] } = {},
): ElementStream {
  const carried = carriedWith(st.carried, opts);
  const cols = opts.cols ?? ['id', ...carriedCols(carried)];
  return { ...st, carried, elem: opts.elem ?? st.elem, rel: st.q.cte(body, cols) };
}
