import { q, list, empty, raw, Query, Relation, type Expression } from '../../../sql/kernel/q.ts';
import { nodes, edges } from '../../../sql/schema.ts';
import { type Elem } from '../../plan/plan.ts';
import { type AliasShape } from './alias.ts';
import { type PStep } from '../../ir/strategies.ts';
import type { ValueType, ListOf } from '../../../sql/kernel/render.ts';

// ---------- prefix-compilation state (Seam 2) ----------
//
// The movement/filter/branch step compilers are a *functional fold*: each is a
// StepFn `(step, ElementStream) => ElementStream` that appends its CTE and returns a NEW state pointing
// at it. Nothing mutates in place — the dispatch threads `ElementStream` immutably (see
// src/compiler/engine/engine.ts). The one piece of essential state, minting unique CTE names
// and collecting their bodies for the final WITH, is encapsulated in the `Query`
// builder (src/sql/kernel/q.ts): a StepFn calls `st.q.cte(body)` and gets back a Relation
// handle it references downstream exactly like a base table.

/** Bound as() labels: label → its carried column (a0, a1, … — user strings never
 *  enter SQL identifiers) + the SET of shapes the label has held across its bindings
 *  (a label's history can be heterogeneous, e.g. [vertex, string]). The column holds
 *  a JSONB history array (see src/compiler/steps/context/alias.ts); `shapes` is the compile-time
 *  summary a consumer uses to decide framing (homogeneous element → fast concrete
 *  path; heterogeneous/list → variant). */
export type AliasEntry = {
  col: string;
  shapes: ReadonlySet<AliasShape>;
  as?: ValueType;
  /** Compile-time binding count along the traverser's path: 1 for a once-bound label,
   *  >1 after rebinds. `undefined` = dynamic depth (bound inside repeat()/a branch arm),
   *  where the count is only known at runtime and Pop must resolve via SQL. Lets Pop.all/
   *  mixed/first/last resolve statically for the common linear case. */
  binds?: number;
  /** Linear path position index this label attached to (the current element's position
   *  at bind time — `path.cols.length - 1`). Set only while path tracking is active on a
   *  linear chain, so path().from(l)/to(l) can resolve a label to a static position slice.
   *  A rebind overwrites with the latest; `undefined` = no path / dynamic position. */
  pathPos?: number;
  /** Owner element kind when the label holds a PropertyStream payload. */
  propertyElem?: Elem;
};
export type AliasMap = ReadonlyMap<string, AliasEntry>;

/** The element kind of a homogeneously-element label (node/edge). Throws if the
 *  label is a value/list/map or a mixed-shape history — callers that need a single
 *  element kind must have already established the label is element-homogeneous. */
export function aliasElem(entry: AliasEntry): Elem {
  if (entry.shapes.size !== 1) throw new Error('alias with mixed-shape history has no single element kind');
  const [s] = entry.shapes;
  if (s !== 'node' && s !== 'edge') throw new Error(`alias holds a ${s}, not an element`);
  return s;
}

/** True iff every binding of the label is the same element kind (node XOR edge). */
export const aliasIsElement = (entry: AliasEntry): boolean =>
  entry.shapes.size === 1 && (entry.shapes.has('node') || entry.shapes.has('edge'));

/** Merge a shape into a label's shape set (rebind may add a new shape). */
export const withShape = (prev: ReadonlySet<AliasShape> | undefined, shape: AliasShape): Set<AliasShape> =>
  new Set([...(prev ?? []), shape]);

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

/** Scope a linear path's position columns to `path().from(l)/to(l)`: each label resolves
 *  to the static position it was bound at (AliasEntry.pathPos), and the slice is inclusive
 *  of both endpoints. Shared by path() (select.ts) and simplePath()/cyclicPath() distinctness
 *  (filter.ts). No from/to → the full path. Unbound/non-path label or empty range → fail
 *  closed with a clear deferral. */
export function scopePathCols<C extends { col: string }>(
  cols: readonly C[], from: string | undefined, to: string | undefined, aliases: AliasMap,
): readonly C[] {
  if (from === undefined && to === undefined) return cols;
  const posOf = (lbl: string): number => {
    const e = aliases.get(lbl);
    if (!e || e.pathPos === undefined) throw new Error(`path().from()/to() label "${lbl}" is not bound to a path position`);
    return e.pathPos;
  };
  const lo = from === undefined ? 0 : posOf(from);
  const hi = to === undefined ? cols.length - 1 : posOf(to);
  if (lo > hi || lo < 0 || hi >= cols.length) throw new Error('path().from()/to() scope is empty or out of range');
  return cols.slice(lo, hi + 1);
}

/** A named side-effect collection (aggregate()/store()/group('a')) — the registry
 *  value threaded through Carry.sideEffects. Registered where the step appears (may be
 *  mid-chain), read back at cap('name'). A `list` def is a materialized JSONB list CTE
 *  (aggregate: element rowids or a by()-projected scalar); a `group` def is a stashed
 *  group-spec re-run by cap (see steps/group.ts, Stage 3). Unlike the id-relation,
 *  this state outlives the current traverser stream. */
export type SideEffectDef =
  | { kind: 'list'; rel: Relation; of: ListOf }
  | { kind: 'variant'; rel: Relation; scalarAs?: ValueType; elem?: Elem }
  | { kind: 'group'; isCount: boolean; bys: any[][]; parent: ElementStream; productiveBy?: boolean };
export type SideEffectMap = ReadonlyMap<string, SideEffectDef>;

/** The per-traverser CARRIED SCHEMA: the columns physically present on the id-relation
 *  beyond `id`, threaded UNCHANGED across every hop and REQUIRED to agree across a
 *  branch merge. These roles travel together as ONE unit — grouping them here (rather than
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
  readonly encounter?: string;           // explicit provider order retained across a barrier/dedup boundary
  readonly bulk?: string;                // traverser multiplicity (e.g. 'bulk'): SUM(bulk) is the RLE traverser count. Seeded =1 at an element source, carried unchanged across every hop, consumed (SUM) + dropped at a barrier
  readonly trackFromV?: boolean;         // seeded true iff the chain uses otherV() — gates fromV emission (hot-path: no extra column otherwise)
  /** Labels a REDUCING barrier consumed (`fold`/`count`/`sum`/… collapsed N rows to 1, so no
   *  single input row's binding survives). METADATA ONLY — never a physical column, so it cannot
   *  affect carriedCols/carryFrag or any CTE schema. It exists so `select(label)` can tell
   *  "this label was never bound" (TinkerPop's drop-every-traverser rule) apart from "this label
   *  existed but a barrier ate it" (a deferral we must NOT answer as an empty result). Without it
   *  both look like a missing alias entry and the second silently returns []. */
  readonly consumedAliases?: readonly string[];
}

/** The context every traverser stream carries, independent of its shape (elements vs a
 *  scalar/list value stream — see stream.ts). Carved out of `ElementStream` so a retype at a tail
 *  boundary (fold→list, unfold→elements/scalar) preserves the shared state. PURE per-query STATE:
 *  the CTE-accumulator `q` + bound `params`, the named side-effect registry (`sideEffects` — CTEs
 *  that OUTLIVE the traverser), and the per-traverser carried column schema (`carried`). The
 *  ambient compile DEPENDENCIES (fastPaths/registry/federationDepth) are NOT here — they live on
 *  the lowering Engine (steps/engine.ts), reached via `q.engine`; keeping them off Carry is what
 *  separates dependency from state (see docs/2026-07-23-directory-restructure-plan.md, Movement 1). */
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

/** Union a set of branch ARMS' alias maps onto the shared pre-branch seed → the merged label set.
 *  A label bound before the branch keeps its seed column (every arm inherited it); a label first
 *  bound INSIDE an arm gets a fresh canonical column appended after the seed columns (arms mint
 *  columns independently from the same seed size, so their raw a{n} collide — the caller's
 *  per-arm projection remaps each arm's PHYSICAL column onto the canonical one and NULL-pads a
 *  label the arm never bound). `shapes` unions across arms. `binds` stays static only when every
 *  arm binds the label the same known number of times; a label bound in only some arms, a
 *  differing count, or a dynamic (repeat/arm) bind → undefined, so Pop resolves at runtime off
 *  the array.
 *
 *  Lives HERE, not in branch.ts, because every branch merge needs it — element (branch.ts),
 *  scalar (tail/scalar.ts) and variant (tail/variant.ts) — and variant.ts cannot import from
 *  branch.ts (branch.ts imports variant.ts; that direction would cycle). Pure Map algebra, no
 *  SQL, so context.ts is the right leaf. */
export function mergeAliasMaps(seed: AliasMap, arms: readonly Carried[]): AliasMap {
  const order: string[] = [...seed.keys()];
  for (const a of arms) for (const lbl of a.aliases.keys()) if (!order.includes(lbl)) order.push(lbl);
  const merged = new Map<string, AliasEntry>();
  order.forEach((lbl, i) => {
    const col = seed.get(lbl)?.col ?? `a${i}`; // seed labels keep a{i} (== their mint order)
    const perArm = arms.map((a) => a.aliases.get(lbl));
    const shapes = new Set<AliasShape>();
    for (const e of perArm) if (e) for (const sh of e.shapes) shapes.add(sh);
    const counts = perArm.map((e) => e?.binds ?? 0); // absent in an arm → 0 bindings on that path
    const defined = perArm.every((e) => !e || e.binds !== undefined);
    const binds = defined && counts.every((c) => c === counts[0]) ? counts[0] : undefined;
    merged.set(lbl, { col, shapes, binds });
  });
  return merged;
}

/** One arm's projection of the MERGED alias columns: the arm's own physical column aliased onto
 *  the canonical name, or NULL where the arm never bound that label (a `select()` of it then
 *  drops that arm's rows via aliasPresent — TinkerPop's drop-not-throw). The alias half of
 *  branch.ts's armProjection, lifted so the scalar/variant/list merges share it verbatim. */
export function aliasArmProjection(armAliases: AliasMap, out: AliasMap, p: Relation): Expression[] {
  return [...out].map(([label, entry]) => {
    const got = armAliases.get(label);
    return !got ? q`NULL AS ${raw(entry.col)}`
      : got.col === entry.col ? q`${p.c[entry.col]}`
      : q`${p.c[got.col]} AS ${raw(entry.col)}`;
  });
}

/** The current id-relation, optionally aliased. Its columns are id + every carried
 *  alias column, so `prevRel(st,'p').c.a0` resolves downstream. */
export const prevRel = (st: ElementStream, alias?: string): Relation => alias ? st.rel.as(alias) : st.rel;

/** The current element's table aliased `n` (nodes/edges by elem). */
export const elemRel = (st: ElementStream, alias = 'n'): Relation => (st.elem === 'edge' ? edges : nodes).as(alias);

/** Every column carried UNCHANGED across a hop, in a STABLE order: alias columns and
 *  source-seeded state (sack, bulk) first, then the columns a LATER hop appends
 *  (origins pushed by a child scope, fromV/encounter set by movement/barriers), then the
 *  path-position columns LAST. THE single source of truth for "what columns are on the
 *  id-relation" — movement/filter thread it, and a branch merge MUST reproduce it
 *  (armProjection).
 *
 *  ORDER RULE — a column appended later must sort later. `bulk` is seeded at the element
 *  source (like sack), so it sits BEFORE origins: pushChildScope emits carryFrag(parent)
 *  then appends the new ordinal at the very end, so the newest origin has to be the last
 *  carried column of the child — which only holds if bulk precedes every origin. Path MUST
 *  be last for the same reason: movement APPENDS each new path position after carryFrag of
 *  the old set, so carriedCols(old) has to stay a prefix of carriedCols(new). Any column
 *  ordered after the site that physically appends it desyncs declared vs physical columns
 *  (the coalesce/optional+path() / +bulk bug). */
export const carriedCols = (c: Carried): string[] =>
  [...aliasColsOf(c.aliases), ...(c.sack ? [c.sack] : []), ...(c.bulk ? [c.bulk] : []), ...c.origins, ...(c.fromV ? [c.fromV] : []), ...(c.encounter ? [c.encounter] : []), ...pathColsOf(c.path)];

/** `, p.a0, p.p0, …` — the carried columns qualified by `p`; empty when nothing is
 *  live. Movement/filter CTEs splice this after the moved id so labelled traversers
 *  and path positions ride forward. */
export function carryFrag(c: Carried, p: Relation): Expression {
  const cols = carriedCols(c);
  return cols.length ? list(cols.map((x) => q`, ${p.c[x]}`), '') : empty;
}

/** Like carryFrag, but ONE named carried column is computed fresh (`mint`) rather than
 *  projected unchanged from `p` — the generalization of the ordinal special-case already
 *  inline in pushChildScope's carriedSelect. Used at every encounter mint/supersede site
 *  so the replacement lands in its DECLARED carriedCols slot, never duplicated or
 *  reordered. `col` MUST already be present in carriedCols(c) (i.e. the patched carried
 *  that declares it) — the mint replaces the forward, it does not add a column. */
export function carryFragMint(c: Carried, p: Relation, col: string, mint: Expression): Expression {
  const cols = carriedCols(c);
  return cols.length ? list(cols.map((x) => (x === col ? q`, ${mint} AS ${col}` : q`, ${p.c[x]}`)), '') : empty;
}

/** The window frame for minting an emission-order encounter: a GLOBAL sequence at root
 *  scope (`ORDER BY <key>`), or a PER-ORIGIN sequence inside a child scope
 *  (`PARTITION BY <ordinal stack> ORDER BY <key>`). The full origins stack partitions
 *  correctly under nested child scopes. Shared by every fan-out mint (branch merges,
 *  movement refine, re-source). `p` qualifies the origin columns. */
export function partitionOver(c: Carried, p: Relation, orderKey: Expression): Expression {
  const parts = c.origins.map((o) => p.c[o]);
  return parts.length ? q`PARTITION BY ${list(parts, ', ')} ORDER BY ${orderKey}` : q`ORDER BY ${orderKey}`;
}

type CarriedOpts = { aliases?: AliasMap; path?: PathState; origins?: readonly string[]; sack?: string | null; fromV?: string | null; encounter?: string | null; bulk?: string | null };

/** Apply a carried-column patch: aliases/path/origins — a value overrides, undefined
 *  keeps; sack/fromV/encounter — `null` CLEARS, undefined keeps, a string sets. `origins` is the
 *  whole ordinal stack (a branch push/pop passes the new array explicitly). trackFromV is
 *  chain-global (never changed by advance). */
export function carriedWith(c: Carried, o: CarriedOpts): Carried {
  return {
    aliases: o.aliases ?? c.aliases,
    path: o.path ?? c.path,
    origins: o.origins ?? c.origins,
    sack: o.sack === null ? undefined : (o.sack ?? c.sack),
    fromV: o.fromV === null ? undefined : (o.fromV ?? c.fromV),
    encounter: o.encounter === null ? undefined : (o.encounter ?? c.encounter),
    bulk: o.bulk === null ? undefined : (o.bulk ?? c.bulk),
    trackFromV: c.trackFromV,
    // Diagnosis-only, never patched by a step: a barrier's consumed-label record must survive
    // every carried patch downstream of it, or select() loses the ability to explain itself.
    consumedAliases: c.consumedAliases,
  };
}

/** Return a new stream state with its carried schema shallow-patched (explicit undefined
 *  CLEARS — for the branch/local seeds that reset aliases/path). The escape hatch for the
 *  few sites that rebuild carried directly rather than through advance. */
export const withCarried = <T extends Carry>(st: T, patch: Partial<Carried>): T =>
  ({ ...st, carried: { ...st.carried, ...patch } });

/** Drop row-associated state at a global barrier while retaining ambient compile
 * context and chain requirements. A barrier result is a new traverser and cannot
 * honestly claim aliases/origins/path/sack/fromV/encounter/bulk from any one input row
 * (a barrier CONSUMES bulk via SUM, then emits one fresh bulk-1 traverser).
 *
 * The dropped LABEL NAMES are remembered in `consumedAliases` (metadata, never a column) so a
 * downstream `select(label)` throws a clear deferral instead of silently returning an empty
 * result — the two are indistinguishable from the alias Map alone, and `selectOneFromAlias`'s
 * drop-not-throw rule is only correct for a label that was genuinely never bound. Labels already
 * consumed upstream stay recorded, so the diagnosis survives a second barrier. */
export const withoutCarried = <T extends Carry>(st: T): T => {
  const consumed = [...st.carried.consumedAliases ?? [], ...st.carried.aliases.keys()];
  return {
    ...st,
    carried: {
      aliases: new Map(),
      origins: [],
      trackFromV: st.carried.trackFromV,
      ...(consumed.length ? { consumedAliases: [...new Set(consumed)] } : {}),
    },
  };
};

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
