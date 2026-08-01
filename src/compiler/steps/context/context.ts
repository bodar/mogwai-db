import { q, list, empty, raw, Query, Relation, type Expression } from '../../../sql/kernel/q.ts';
import { aliasCtx, type Elem, type ScalarCtx, elemTable } from '../../plan/plan.ts';
import { aliasId, aliasPresent, type AliasShape } from './alias.ts';
import { type IRStep } from '../../ir/strategies.ts';
import type { ValueType, ListOf, ScalarType } from '../../../sql/kernel/render.ts';

// ---------- prefix-compilation state ----------
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
  /** The scalar type channel after it has crossed into JSON history. A per-row
   * stream no longer has its original relation column, so it is represented by
   * the entry's own `t` field and restored into a fresh `vtype` column on select. */
  scalarType?: AliasScalarType;
  /** Member descriptor for a list value held in history. This is deliberately
   * alias-local: it says how to re-enter THIS JSON list, not what a Stream is. */
  listOf?: ListOf;
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

export type AliasScalarType =
  | { readonly kind: 'static'; readonly type: ValueType }
  | { readonly kind: 'perRow' }
  | { readonly kind: 'unknown' };

export const aliasScalarTypeOf = (type: ScalarType): AliasScalarType =>
  type.kind === 'static' ? { kind: 'static', type: type.type }
    : type.kind === 'perRow' ? { kind: 'perRow' }
      : { kind: 'unknown' };

/** Restore an alias history type to a scalar relation. `perRow` deliberately
 * names the NEW projection column, not the source relation's vanished column. */
export const scalarTypeFromAlias = (type: AliasScalarType | undefined, vtype = 'vtype'): ScalarType =>
  type?.kind === 'static' ? { kind: 'static', type: type.type }
    : type?.kind === 'perRow' ? { kind: 'perRow', column: vtype }
      : { kind: 'unknown' };

const mergeAliasScalarTypes = (types: readonly (AliasScalarType | undefined)[]): AliasScalarType | undefined => {
  const present = types.filter((type): type is AliasScalarType => type !== undefined);
  if (!present.length) return undefined;
  if (present.every((type) => type.kind === 'static' && type.type === (present[0] as any).type)) return present[0];
  if (present.every((type) => type.kind === 'unknown')) return { kind: 'unknown' };
  // Different static tags and branch-local types are all faithfully represented by
  // the JSON entry's `t`; a selected relation must expose that per-row channel.
  return { kind: 'perRow' };
};

/** The element kind of a homogeneously-element label (node/edge). Throws if the
 *  label is a value/list/map or a mixed-shape history — callers that need a single
 *  element kind must have already established the label is element-homogeneous. */
export function aliasElem(entry: AliasEntry): Elem {
  if (entry.shapes.size !== 1) throw new Error('alias with mixed-shape history has no single element kind');
  const [s] = entry.shapes;
  if (s !== 'vertex' && s !== 'edge') throw new Error(`alias holds a ${s}, not an element`);
  return s;
}

/** True iff every binding of the label is the same element kind (node XOR edge). */
export const aliasIsElement = (entry: AliasEntry): boolean =>
  entry.shapes.size === 1 && (entry.shapes.has('vertex') || entry.shapes.has('edge'));

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
 *  value threaded through LoweringState.sideEffects. Registered where the step appears (may be
 *  mid-chain), read back at cap('name'). A `list` def is a materialized JSONB list CTE
 *  (aggregate: element rowids or a by()-projected scalar); a `group` def is a stashed
 *  group-spec re-run by cap (see steps/group.ts, Stage 3). Unlike the id-relation,
 *  this state outlives the current traverser stream. */
export type SideEffectDef =
  | { kind: 'list'; rel: Relation; of: ListOf }
  | { kind: 'variant'; rel: Relation; scalarAs?: ValueType; elem?: Elem }
  | { kind: 'group'; isCount: boolean; modulators: any[][]; parent: ElementStream; productiveBy?: boolean };
export type SideEffectMap = ReadonlyMap<string, SideEffectDef>;

/** The per-traverser CARRIED SCHEMA: the columns physically present on the id-relation
 *  beyond `id`, threaded UNCHANGED across every hop and REQUIRED to agree across a
 *  branch merge. These roles travel together as ONE unit — grouping them here (rather than
 *  as loose siblings on LoweringState) is what makes a branch/tail step that silently drops them
 *  structurally obvious, and keeps layoutCols/layoutProjection/mergeLayouts the single source
 *  of truth. A struct of TYPED ROLES on purpose, NOT a flat column list: aliases is a
 *  name→col Map (select/where lookup), path a two-regime union, sack is mutable, fromV
 *  clears on landing, origin drops at a branch output — homogenising them would re-lose
 *  the structure each reader needs. */
export interface TraverserLayout {
  readonly aliases: AliasMap;
  readonly path?: PathState;             // present iff the chain tracks a linear path
  readonly origins: readonly string[];   // coalesce/optional input-ordinal columns — a STACK (nested branches each push their own unique ordinal; the innermost is last)
  /** The emission order of the traverser that entered each enclosing BRANCH, frozen at entry — a
   *  STACK, exactly like `origins` (nested branches each push their own; the innermost is last).
   *
   *  It exists because a branch merge's canonical key is `(input traverser, arm, arm encounter)`
   *  and the first term is otherwise unrecoverable: `encounter` is ONE slot which every fan-out
   *  inside an arm re-mints in place (`finishMove`), so an arm's encounter is a RANK, and two arms
   *  rank independently. `origins` identifies an input traverser (`ROW_NUMBER() OVER ()`) without
   *  ORDERING them. Frozen at branch entry, threaded through the arms like any carried column,
   *  consumed and dropped by the merge.
   *
   *  NOT a second `encounter`, and the distinction is load-bearing (the one-slot decision is
   *  `docs/2026-07-19-canonical-emission-order.md` Stage C + outstanding-work item 4): this is an
   *  OUTER scope's order, and it is only ever read as a merge sort key — never as "what order is
   *  THIS stream in". A consumer that wants both for the same purpose is the reconciliation that
   *  was refused. */
  readonly branchOrders: readonly string[];
  readonly sack?: string;                // sack: the carried per-traverser scalar column (e.g. 'sk')
  readonly fromV?: string;               // edge context: the vertex an edge was entered from (for otherV())
  readonly encounter?: string;           // explicit provider order retained across a barrier/dedup boundary
  readonly bulk?: string;                // traverser multiplicity (e.g. 'bulk'): SUM(bulk) is the RLE traverser count. Seeded =1 at an element source, carried unchanged across every hop, consumed (SUM) + dropped at a barrier
  readonly trackFromV?: boolean;         // seeded true iff the chain uses otherV() — gates fromV emission (hot-path: no extra column otherwise)
  /** Labels a REDUCING barrier consumed (`fold`/`count`/`sum`/… collapsed N rows to 1, so no
   *  single input row's binding survives). METADATA ONLY — never a physical column, so it cannot
   *  affect layoutCols/layoutProjection or any CTE schema. It exists so `select(label)` can tell
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
 *  the lowering Engine (steps/engine.ts), reached via `q.engine`; keeping them off LoweringState is what
 *  separates dependency from state (see docs/archive/2026-07-23-directory-restructure-plan.md, Movement 1). */
export interface LoweringState {
  readonly q: Query;
  readonly params: Record<string, any>;
  readonly sideEffects?: SideEffectMap;  // named side-effect collections (aggregate/store/group('a'))
  readonly traverserLayout: TraverserLayout;             // the per-traverser carried column schema
}

/** Immutable prefix state threaded through the step fold. Everything the dispatch
 *  reasons about is replaced wholesale by each StepFn's return; `q` is the shared
 *  append-only CTE builder. The `elements` arm of the `Stream` union (stream.ts):
 *  movement/filter/branch StepFns are ONLY ever handed this shape. */
export interface ElementStream extends LoweringState {
  readonly kind: 'elements';
  readonly rel: Relation;               // the current id-relation (a CTE handle)
  readonly elem: Elem;
  /** This stream was re-sourced by a mid-traversal V()/E(). The incoming traverser
   * remains only as carried state, so a child-scope barrier may safely operate per
   * origin after this point rather than treating the projection encounter as its input. */
  readonly reSourced?: boolean;
}

/** A prefix step compiler: consume the step, return the next state. */
export type StepFn = (s: IRStep, st: ElementStream) => ElementStream;

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
 *  MODULE-LOCAL on purpose: `mergeLayouts` below is the ONE route to it, so a merge cannot take
 *  the alias half of the contract while skipping the rigid-role policy. It was exported and called
 *  directly by the scalar/list/variant merges, which is how those three grew three copies of one
 *  algorithm that then disagreed. Pure Map algebra, no SQL, so context.ts is the right leaf. */
function mergeAliasMaps(seed: AliasMap, arms: readonly TraverserLayout[]): AliasMap {
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
    const entries = perArm.filter((entry): entry is AliasEntry => !!entry);
    const listOf = entries.length && entries.every((entry) => JSON.stringify(entry.listOf) === JSON.stringify(entries[0].listOf))
      ? entries[0].listOf : undefined;
    merged.set(lbl, { col, shapes, binds, scalarType: mergeAliasScalarTypes(entries.map((entry) => entry.scalarType)), listOf });
  });
  return merged;
}

/** The RIGID carried columns — sack/bulk/origins/fromV/encounter (everything but aliases and
 *  path). These are per-traverser physical state a branch cannot fork or reconcile, so they must
 *  be identical across arms; aliases fork and merge, path pads. Equivalently: the roles whose
 *  `LAYOUT_ROLE_POLICY` is `'identical'` — derived here by EXCLUDING the two that are not, since
 *  each needs its own empty value and a generic clear would be more machinery than the table saves.
 *
 *  The spread is a deliberate CONSTRUCTION of a throwaway layout to ask layoutCols a narrower
 *  question, not a preservation route — `patchLayout` cannot express it, because clearing `path`
 *  there means "keep". */
export const rigidCols = (c: TraverserLayout): string[] => layoutCols({ ...c, aliases: new Map(), path: undefined });

/** Every carried column EXCEPT the alias columns — including the path positions, unlike
 *  `rigidCols`. This is the half an arm merge projects STRAIGHT THROUGH from each arm while the
 *  alias half is remapped per arm, and the scalar and list merges each derived it inline. */
export const nonAliasCols = (c: TraverserLayout): string[] => layoutCols(patchLayout(c, { aliases: new Map() }));

/** What an arm merge does with one carried role.
 *
 *  - `union` — the arms' values COMBINE. Only `aliases`: a label bound in one arm NULL-pads in the
 *    others, so `select()` of it drops that arm's traversers (TinkerPop's drop-not-throw).
 *  - `pad` — the arms' values combine by padding to the LONGEST. Only `path`: a shorter arm's path
 *    genuinely is shorter, so its trailing positions are NULL and nullable.
 *  - `identical` — per-traverser physical state a fork cannot reconcile. A same-scope `peer` merge
 *    requires every arm to agree and fails closed otherwise; a `rehomed` merge takes the SEED's,
 *    because a child arm's copy describes the child's scope rather than this one.
 *  - `metadata` — never a physical column, so there is nothing to merge: it rides through
 *    unchanged. `trackFromV` is a chain-level requirement; `consumedAliases` is a barrier's
 *    diagnosis, which must survive every downstream patch or `select()` loses the ability to tell
 *    "never bound" from "a barrier ate it". */
export type LayoutRolePolicy = 'union' | 'pad' | 'identical' | 'metadata';

/** The merge policy of EVERY carried role — the explicit classification Phase 1's design section
 *  asks for, as a table the type checker keeps total rather than prose that goes stale.
 *
 *  `Record<keyof TraverserLayout, …>` is the enforcement: adding a role to `TraverserLayout` fails
 *  the build until its policy is declared here. Without that, a new role falls into `identical` by
 *  ACCIDENT — `rigidCols` derives the rigid set by exclusion (everything `layoutCols` emits that is
 *  not an alias or a path position), so omission silently means "a branch must fail closed on it",
 *  which is the safe default but not necessarily the intended one.
 *
 *  `test/channel-contracts.test.ts` ties the table to the three column accessors, so a policy
 *  recorded here and a column list that disagrees cannot both survive. */
export const LAYOUT_ROLE_POLICY: Readonly<Record<keyof TraverserLayout, LayoutRolePolicy>> = {
  aliases: 'union',
  path: 'pad',
  origins: 'identical',
  // Every arm forked from the same branch entry, so they carry the same frozen column; a merge
  // that finds them disagreeing is looking at arms from different branches and must fail closed.
  branchOrders: 'identical',
  sack: 'identical',
  fromV: 'identical',
  encounter: 'identical',
  bulk: 'identical',
  trackFromV: 'metadata',
  consumedAliases: 'metadata',
};

/** What a global BARRIER does with one carried role — the other half of the carried-role contract,
 *  and the half that had no table.
 *
 *  - `consumed` — the role's columns go, and the fact that they EXISTED is remembered. Only
 *    `aliases`: a downstream `select(label)` must be able to tell "a barrier ate it" from "never
 *    bound", which the alias Map alone cannot express, so the names move to `consumedAliases`.
 *  - `empty` — the role has an empty VALUE rather than an absence. Only `origins`: a barrier result
 *    sits in no child scope, and `[]` says that where `undefined` would be a different type.
 *  - `drop` — the role is simply absent afterwards. A barrier result is a NEW traverser and cannot
 *    honestly claim per-row state from any one input row; `bulk` is here for a sharper reason still
 *    — the barrier CONSUMES it (SUM) and emits one fresh bulk-1 traverser.
 *  - `keep` — never a physical column, so a barrier has nothing to drop. `trackFromV` is a
 *    chain-level requirement and `consumedAliases` is the diagnosis this very table writes.
 */
export type BarrierRolePolicy = 'consumed' | 'empty' | 'drop' | 'keep';

/** The barrier policy of EVERY carried role, and the reason it exists is the same one
 *  `LAYOUT_ROLE_POLICY` gives from the merge side — except that omission is not safe here.
 *
 *  `dropLayoutAtBarrier` builds its result as a LITERAL, and every role but `aliases`/`origins`/the
 *  two metadata ones is optional on `TraverserLayout` — so a role added tomorrow compiles clean and
 *  is silently dropped at all fifteen barrier sites. Silently dropping happens to be the right answer
 *  for most roles, which is exactly what makes it dangerous: the one role for which it is wrong would
 *  produce a wrong answer with nothing to notice it. `Record<keyof TraverserLayout, …>` turns that
 *  into a build failure until the new role's policy is DECLARED.
 *
 *  Declaring is not implementing, so `test/channel-contracts.test.ts` runs `dropLayoutAtBarrier` over
 *  a fully-populated layout and checks the result against this table role by role — the same tie
 *  `LAYOUT_ROLE_POLICY` has to the column accessors. A policy recorded here and a literal that
 *  disagrees cannot both survive.
 */
export const BARRIER_ROLE_POLICY: Readonly<Record<keyof TraverserLayout, BarrierRolePolicy>> = {
  aliases: 'consumed',
  origins: 'empty',
  // Same reading as `origins`, one scope out: a barrier result is a fresh traverser that no
  // longer stands for any one of the branch's inputs, so there is no input order to hold. `[]`
  // rather than absent, because the role is a stack.
  branchOrders: 'empty',
  path: 'drop',
  sack: 'drop',
  fromV: 'drop',
  encounter: 'drop',
  bulk: 'drop',
  trackFromV: 'keep',
  consumedAliases: 'keep',
};

/** How an arm merge treats the RIGID roles (sack/bulk/origins/fromV/encounter). This is a
 *  POLICY, not a strictness dial: the two cases describe genuinely different boundaries, so a
 *  caller states which one it is at and never picks the lenient one to make a call type-check.
 *
 *  - `'peer'` — SAME-SCOPE peer arms, forked from the seed and rejoined in the seed's own scope.
 *    The rigid roles are per-traverser physical state a fork cannot reconcile, so a disagreement
 *    FAILS CLOSED rather than emitting SQL that references a column one arm lacks.
 *  - `'rehomed'` — CHILD-SCOPED arms already re-homed onto the parent (`rehomeLayout`). A child
 *    scope minted an ordinal the parent does not have, so the arms' rigid roles are not
 *    comparable with the parent's by construction and only the label sets merge. Asserting here
 *    would reject valid `coalesce`/`optional` forms outright — see `tail/variant.ts`. */
export type RigidRolePolicy = 'peer' | 'rehomed';

/**
 * THE merge authority — the one `context.ts:122` and `prefix/branch.ts:234` have cited all along
 * while it did not exist. Every arm merge routes through this.
 *
 * It does two things and refuses to guess at a third. It UNIONS the arms' label sets onto the seed
 * (an arm may bind an `as()` label the seed never saw), and it applies the caller's declared
 * `rigid` policy to the roles a fork cannot reconcile (see `RigidRolePolicy`).
 *
 * What it deliberately does NOT do: mint or clear `encounter` (each merge re-mints it in its own
 * window, and `layoutProjectionMinting` requires the column to be already declared), and merge `path` (the
 * pad-to-max is branch-specific; every other merge declines a live path outright). The caller
 * hands in an already-merged path or nothing.
 *
 * Why this had to exist: the element merge and the scalar merge each grew the alias union
 * independently, and the list and variant merges never grew it at all — they projected the SEED's
 * alias columns off each arm by name, so a label an arm minted itself was silently unread.
 * `g.V(1).union(__.as("x").out().fold(), __.as("x").in().fold()).select("x")` returned 0 rows
 * where the element-shaped twin returns 3. A silent empty result, which is the failure mode this
 * project treats as worse than a crash.
 *
 * `rigid` and `path` are ONE options argument, and `rigid` is REQUIRED: a second optional
 * parameter with a default is exactly how a caller hands off half a contract and silently drops
 * the rest (the plan's constitution, point 7).
 */
export function mergeLayouts(
  seed: TraverserLayout,
  arms: readonly TraverserLayout[],
  opts: { readonly rigid: RigidRolePolicy; readonly path?: PathState },
): TraverserLayout {
  if (opts.rigid === 'peer') {
    const want = rigidCols(seed);
    for (const a of arms) {
      const got = rigidCols(a);
      if (got.length !== want.length || got.some((x, i) => x !== want[i]))
        throw new Error('branch arms disagree on carried columns (a step binding new sack/origin state inside a branch arm not yet supported)');
    }
  }
  return { ...seed, aliases: mergeAliasMaps(seed.aliases, arms), path: opts.path ?? seed.path };
}

/** Did the arm merge APPEND a canonical alias column the seed did not carry? A merge that only
 *  inherited the seed's labels can project them flat (`layoutProjection`); one that GREW must
 *  remap each arm's own physical column onto the canonical name and NULL-pad the labels that arm
 *  never bound (`aliasArmProjection`). The three value-shaped merges each spelled this comparison
 *  inline, and the copy that never made it is the one that returned a silent `[]`. */
export const layoutGrewAliases = (seed: TraverserLayout, merged: TraverserLayout): boolean =>
  merged.aliases.size !== seed.aliases.size;

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

/** ONE arm's projection of the MERGED carried schema, as the `, col, col, …` fragment an arm
 *  SELECT splices after its payload.
 *
 *  Resolved per COLUMN, and that is load-bearing rather than tidy. Three cases, and an arm can be in
 *  more than one at once:
 *
 *  - an ALIAS the arm bound under a different physical name → remapped onto the canonical one;
 *  - an ALIAS the arm never bound → NULL, so a `select()` of it drops that arm's traversers via
 *    `aliasPresent` (TinkerPop's drop-not-throw);
 *  - a NON-ALIAS role the arm no longer has, because a COLLAPSING barrier in it ran
 *    `dropLayoutAtBarrier` → filled with what the reference's freshly generated reducer traverser
 *    carries, which for `bulk` is the literal 1.
 *
 *  The third case is why this cannot be decided per ARM. A batched collapsing arm that then binds a
 *  label (`union(__.out().count().as("x"), …)`) has LOST `bulk` and GAINED `a0`, so "is this arm
 *  collapsed?" has no answer — asking it produced `SELECT a.v, ?, 1, a.a0,  FROM …`, a trailing comma
 *  where `a.bulk` resolved to nothing. Asking per column cannot reach that state.
 *
 *  Any other missing role throws: a live `path`/`sack`/`fromV`/origin is per-traverser state a
 *  collapse destroyed, and NULL-padding it would hand a consumer a channel reading "absent" when the
 *  truth is "unanswerable". The caller must decline before lowering such an arm
 *  (`collapsedArmAdmissible`) — a deferral has to happen before any CTE is appended.
 *
 *  When neither an alias remap nor a fill is needed, a flat `layoutProjection` is the same relation
 *  and the cheaper hot path. The scalar, list and variant merges each spelled this out, and the
 *  branch that skipped the remap is where a label an arm minted itself went silently unread. */
export function layoutArmProjection(out: TraverserLayout, arm: TraverserLayout, a: Relation, grew: boolean): Expression {
  const have = new Set(layoutCols(arm));
  const missing = nonAliasCols(out).filter((c) => !have.has(c));
  if (!grew && !missing.length) return layoutProjection(out, a);
  const nonAlias = nonAliasCols(out).map((c) => {
    if (have.has(c)) return a.c[c];
    if (c === out.bulk) return q`1 AS ${raw(c)}`;
    throw new Error(`a branch arm that dropped its carried '${c}' cannot be merged — the caller must decline before lowering it`);
  });
  const cols = [...aliasArmProjection(arm.aliases, out.aliases, a), ...nonAlias];
  return cols.length ? list(cols.map((e) => q`, ${e}`), '') : empty;
}

/** Can a BATCHED arm be lowered over this branch's input at all? Only when that input IS the whole
 *  stream. Inside a child scope it is one parent's SHARE of the stream, and a barrier applied across
 *  the shares answers a different question — which is the same fact `isStreamBarrier` encodes for the
 *  `repeat()`/`match()` gates, seen from the branch side. */
export const armBatchAdmissible = (input: TraverserLayout): boolean => !input.origins.length;

/** A COLLAPSING arm needs more than `armBatchAdmissible`: `dropLayoutAtBarrier` destroys its
 *  per-traverser state, so a live `path`/`sack`/`fromV` has no honest value on the other side — and
 *  those are exactly the roles `layoutArmProjection` refuses to invent. A SLICE arm keeps all of
 *  them, which is why the two predicates are not one. Asked of the branch's INPUT, before any arm is
 *  lowered, because that is the only place a decline is still free. */
export const collapsedArmAdmissible = (input: TraverserLayout): boolean =>
  armBatchAdmissible(input) && !input.path && !input.sack && !input.fromV;

/** The relation an arm merge produces, plus the carried schema it declares.
 *  `mergeArmRelation` owns both, so a caller cannot take one without the other. */
export interface ArmMergeRelation {
  readonly rel: Relation;
  readonly traverserLayout: TraverserLayout;
}

/**
 * The UNION-ALL core of an arm merge, over per-arm SELECTs the caller has already built. The
 * scalar, list and variant merges were three copies of exactly this — per-arm payload plus an
 * `arm_idx`/`arm_encounter` tag, an inner CTE, then `ROW_NUMBER() OVER (<partition> ORDER BY
 * arm_idx, arm_encounter)` re-minted into the carried `encounter` slot so arm a lands wholly before
 * arm b (TinkerPop's union/coalesce/choose order). Only the PAYLOAD column list differed between
 * them, and `streamPayloadCols` already owns that per shape.
 *
 * `out` is the merged carried schema with `encounter` ALREADY CLEARED: the mint supersedes any
 * incoming encounter rather than adding a second one, and `layoutProjectionMinting` requires the
 * replacement column to be declared, so the two halves have to be sequenced this way.
 *
 * `mint` is the CALLER's decision, not derived from `out`, because the three disagree for a real
 * reason: the scalar merge always establishes emission order (its positional consumers —
 * `limit()`/`range()` over a scalar stream — are reachable today), while the list and variant
 * merges mint only when an encounter is already live, since a list-valued `limit()` still throws
 * and minting would be dead SQL. When `mint` is true every `part` MUST carry trailing
 * `arm_idx, arm_encounter` columns, and when it is false none may — `assertStreamColumns` at the
 * caller's stream constructor trips immediately either way.
 */
export function mergeArmRelation(
  base: LoweringState,
  out: TraverserLayout,
  payload: readonly string[],
  parts: readonly Expression[],
  mint: boolean,
): ArmMergeRelation {
  const body = list(parts, ' UNION ALL ');
  if (!mint) return { rel: base.q.cte(body, [...payload, ...layoutCols(out)]), traverserLayout: out };
  const m = base.q.cte(body, [...payload, 'arm_idx', 'arm_encounter', ...layoutCols(out)]).as('m');
  // The frozen input order (when this branch pushed one) LEADS the key — traverser-major,
  // arm-minor, which is what the reference emits unless the branch batched — and is consumed here,
  // so the merged schema pops back to the enclosing stack.
  const branchOrder = out.branchOrders.length > base.traverserLayout.branchOrders.length ? out.branchOrders[out.branchOrders.length - 1] : undefined;
  const merged = patchLayout(out, { encounter: 'encounter', branchOrders: base.traverserLayout.branchOrders });
  const armKey = q`${m.c.arm_idx}, ${m.c.arm_encounter}`;
  const over = partitionOver(out, m, branchOrder ? q`${m.c[branchOrder]}, ${armKey}` : armKey);
  const projected = list(payload.map((c) => q`${m.c[c]} AS ${c}`), ', ');
  return {
    rel: base.q.cte(
      q`SELECT ${projected}${layoutProjectionMinting(merged, m, 'encounter', q`ROW_NUMBER() OVER (${over})`)} FROM ${m}`,
      [...payload, ...layoutCols(merged)],
    ),
    traverserLayout: merged,
  };
}

/** The current id-relation, optionally aliased. Its columns are id + every carried
 *  alias column, so `prevRel(st,'p').c.a0` resolves downstream. */
export const prevRel = (st: ElementStream, alias?: string): Relation => alias ? st.rel.as(alias) : st.rel;

/** The outer row's path-history LABELS made readable from a CORRELATED sub-render: the label
 *  map plus the relation whose columns physically hold those histories at the point the
 *  correlated SQL is spliced in. It is what lets a correlated predicate re-root on a label
 *  (`where(__.as("b").out())`) and lets the inline correlated child SEED real alias columns
 *  instead of declining every label-mentioning body.
 *
 *  Supply it ONLY where `rel` is genuinely in scope at the splice point — a site that has no
 *  such relation (until()/emit(), whose predicate rides a recursive term's walk row) passes
 *  nothing, and the label-mentioning bodies there keep failing closed. */
export interface LabelScope {
  readonly aliases: AliasMap;
  readonly rel: Relation;
}

/** The LabelScope of a site that joins `prevRel(st,'p')` alongside the current element — the
 *  `SELECT n.id … FROM <elem> n JOIN <prev> p … WHERE <test>` shape shared by filter.ts's
 *  filterCte and branch.ts's choose() gate, which is where every correlated predicate lands. */
export const labelScope = (st: ElementStream): LabelScope => ({ aliases: st.traverserLayout.aliases, rel: prevRel(st, 'p') });

/** RE-ROOT on a label: the ScalarCtx of the element it currently (Pop.last) holds, correlating
 *  on the carried alias column. This is how `where(__.as("b").out())`, `dedup("a","b")` and any
 *  other label-rooted correlated read resolve — one reading, so they cannot drift. */
export function labelCtx(labels: LabelScope, label: string): ScalarCtx {
  const entry = labels.aliases.get(label);
  if (!entry) throw new Error(`no such label "${label}" — as("${label}") was not seen`);
  return aliasCtx(aliasId(labels.rel.c[entry.col], 'last'), aliasElem(entry));
}

/** Is `label` bound on this row at all? Note this is a DIFFERENT question from labelCtx's, and
 *  unbound resolves differently at each: a re-root has no element to correlate on, so it is a
 *  clear deferral, while a bound-test is simply false — TinkerPop drops the traverser for a
 *  label bound nowhere, never errors. */
export const labelIsBound = (labels: LabelScope, label: string): Expression => {
  const entry = labels.aliases.get(label);
  return entry ? aliasPresent(labels.rel.c[entry.col]) : q`0`;
};

/** The current element's table aliased `n` (nodes/edges by elem). */
export const elemRel = (st: ElementStream, alias = 'n'): Relation => elemTable(st.elem).as(alias);

/** Every column carried UNCHANGED across a hop, in a STABLE order: alias columns and
 *  source-seeded state (sack, bulk) first, then the columns a LATER hop appends
 *  (origins pushed by a child scope, fromV/encounter set by movement/barriers), then the
 *  path-position columns LAST. THE single source of truth for "what columns are on the
 *  id-relation" — movement/filter thread it, and a branch merge MUST reproduce it
 *  (armProjection).
 *
 *  ORDER RULE — a column appended later must sort later. `bulk` is seeded at the element
 *  source (like sack), so it sits BEFORE origins: pushChildScope emits layoutProjection(parent)
 *  then appends the new ordinal at the very end, so the newest origin has to be the last
 *  carried column of the child — which only holds if bulk precedes every origin. Path MUST
 *  be last for the same reason: movement APPENDS each new path position after layoutProjection of
 *  the old set, so layoutCols(old) has to stay a prefix of layoutCols(new). Any column
 *  ordered after the site that physically appends it desyncs declared vs physical columns
 *  (the coalesce/optional+path() / +bulk bug). */
export const layoutCols = (c: TraverserLayout): string[] =>
  [...aliasColsOf(c.aliases), ...(c.sack ? [c.sack] : []), ...(c.bulk ? [c.bulk] : []), ...c.origins, ...c.branchOrders, ...(c.fromV ? [c.fromV] : []), ...(c.encounter ? [c.encounter] : []), ...pathColsOf(c.path)];

/** `, p.a0, p.p0, …` — the carried columns qualified by `p`; empty when nothing is
 *  live. Movement/filter CTEs splice this after the moved id so labelled traversers
 *  and path positions ride forward. */
export function layoutProjection(c: TraverserLayout, p: Relation): Expression {
  const cols = layoutCols(c);
  return cols.length ? list(cols.map((x) => q`, ${p.c[x]}`), '') : empty;
}

/** Like layoutProjection, but ONE named carried column is computed fresh (`mint`) rather than
 *  projected unchanged from `p` — the generalization of the ordinal special-case already
 *  inline in pushChildScope's carriedSelect. Used at every encounter mint/supersede site
 *  so the replacement lands in its DECLARED layoutCols slot, never duplicated or
 *  reordered. `col` MUST already be present in layoutCols(c) (i.e. the patched carried
 *  that declares it) — the mint replaces the forward, it does not add a column. */
export function layoutProjectionMinting(c: TraverserLayout, p: Relation, col: string, mint: Expression): Expression {
  return layoutProjectionMintingMany(c, p, new Map([[col, mint]]));
}

/** Like layoutProjectionMinting, but for a step that creates multiple carried values at
 * once. The projection is still driven by layoutCols, so a newly-created rigid column
 * (fromV) lands before an also-new path position even though both values originate at
 * the same movement. This is the multi-column form of the same schema-preservation
 * contract; callers must only name columns already declared by `c`. */
export function layoutProjectionMintingMany(
  c: TraverserLayout,
  p: Relation,
  mints: ReadonlyMap<string, Expression>,
): Expression {
  const cols = layoutCols(c);
  return cols.length ? list(cols.map((x) => {
    const mint = mints.get(x);
    return mint ? q`, ${mint} AS ${x}` : q`, ${p.c[x]}`;
  }), '') : empty;
}

/** The window frame for minting an emission-order encounter: a GLOBAL sequence at root
 *  scope (`ORDER BY <key>`), or a PER-ORIGIN sequence inside a child scope
 *  (`PARTITION BY <ordinal stack> ORDER BY <key>`). The full origins stack partitions
 *  correctly under nested child scopes. Shared by every fan-out mint (branch merges,
 *  movement refine, re-source). `p` qualifies the origin columns. */
export function partitionOver(c: TraverserLayout, p: Relation, orderKey: Expression): Expression {
  const parts = c.origins.map((o) => p.c[o]);
  return parts.length ? q`PARTITION BY ${list(parts, ', ')} ORDER BY ${orderKey}` : q`ORDER BY ${orderKey}`;
}

type LayoutPatch = { aliases?: AliasMap; path?: PathState; origins?: readonly string[]; branchOrders?: readonly string[]; sack?: string | null; fromV?: string | null; encounter?: string | null; bulk?: string | null };

/** Apply a carried-column patch: aliases/path/origins — a value overrides, undefined
 *  keeps; sack/fromV/encounter — `null` CLEARS, undefined keeps, a string sets. `origins` is the
 *  whole ordinal stack (a branch push/pop passes the new array explicitly). trackFromV is
 *  chain-global (never changed by advance). */
export function patchLayout(c: TraverserLayout, o: LayoutPatch): TraverserLayout {
  return {
    aliases: o.aliases ?? c.aliases,
    path: o.path ?? c.path,
    origins: o.origins ?? c.origins,
    branchOrders: o.branchOrders ?? c.branchOrders,
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

/** DROP to a relation that carries only `id` plus the given alias columns — a fresh BINDING TABLE.
 *  Every other carried role goes, explicitly, because the relation does not have the column:
 *  `match()`'s seed and each of its pattern seeds project `id` + the bound variables and nothing
 *  else.
 *
 *  A `drop`, not a barrier: the LABELS survive (they ARE the binding table), so `consumedAliases`
 *  is untouched and `select()` still resolves every variable. `trackFromV` is a chain-level
 *  requirement rather than a column, so it rides through.
 *
 *  The role this drops that a caller might want back is `bulk`. A traverser reaching `match()` with
 *  multiplicity > 1 (a collapsed movement) loses it, so a reducer after the match counts ROWS
 *  rather than traversers. That was already true physically — the seed has never projected `bulk`;
 *  what is new is that the declaration says so instead of claiming a column the relation lacks. */
export const layoutOverAliases = (c: TraverserLayout, aliases: AliasMap): TraverserLayout =>
  ({ aliases, origins: [], branchOrders: [], trackFromV: c.trackFromV, consumedAliases: c.consumedAliases });

/**
 * The fork point as the ARMS see it, plus the frozen input order this merge owes its sort key —
 * both DERIVED from the arms rather than threaded down from the branch that froze it.
 *
 * `base` is the state before the branch; `arm` is any arm's finished layout. An arm carries exactly
 * one more branch order than `base` when this branch called `freezeBranchOrder`, and never more than
 * one: a nested branch inside the arm pushes its own and its own merge pops it again, so an arm's
 * END layout is always back at the fork's stack.
 *
 * Derived because the alternative is the same argument threaded through four merge families and
 * their ~18 call sites, every one of which would be a place to forget it. The two questions a merge
 * asks — "what schema did the arms fork from" and "is there an input order to lead with" — have one
 * answer each, and the arms already carry it.
 */
export function branchFork(base: TraverserLayout, arm: TraverserLayout): { fork: TraverserLayout; branchOrder?: string } {
  const bos = arm.branchOrders;
  if (bos.length <= base.branchOrders.length) return { fork: base };
  return { fork: patchLayout(base, { branchOrders: bos }), branchOrder: bos[bos.length - 1] };
}

/** The carried schema of a traverser that carries NOTHING — a root seed (`V()`/`E()`/`inject()`),
 *  a correlated sub-render with no labels in scope, a service's own row source. Eleven sites spelled
 *  this literal out, so each of them was a place a newly-added role could be forgotten; the two
 *  scope STACKS have exactly one empty value and it belongs here, next to the roles themselves.
 *  A seed that carries something (bulk, a label map, `path()`'s pk/ord pair) still builds its own
 *  literal — those say something, and the type checker keeps them total. */
export const rootLayout = (): TraverserLayout => ({ aliases: new Map(), origins: [], branchOrders: [] });

/** Re-home child-scoped carried state onto its parent schema. This is deliberately
 * narrower than `mergeLayouts`: a child ordinal is meaningful only inside the child
 * relation, so a caller restores the parent origin stack before any peer-arm merge. */
export const rehomeLayout = (child: TraverserLayout, parentOrigins: readonly string[]): TraverserLayout =>
  patchLayout(child, { origins: parentOrigins });

/** Return a new stream state with its carried schema shallow-patched (explicit undefined
 *  CLEARS — for the branch/local seeds that reset aliases/path). The escape hatch for the
 *  few sites that rebuild carried directly rather than through advance. */
export const withLayout = <T extends LoweringState>(st: T, patch: Partial<TraverserLayout>): T =>
  ({ ...st, traverserLayout: { ...st.traverserLayout, ...patch } });

/** Chain-level capability marker: otherV() needs the entering vertex retained by
 * every preceding edge movement. It changes no physical schema until that movement. */
export const trackFromV = <T extends LoweringState>(st: T): T =>
  withLayout(st, { trackFromV: true });

/** A child derived from a path position must not inherit the outer path history:
 * its movements are implementation detail, not new positions in the output path. */
export const withoutPath = <T extends LoweringState>(st: T): T =>
  withLayout(st, { path: undefined });

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
export const dropLayoutAtBarrier = <T extends LoweringState>(st: T): T =>
  ({ ...st, traverserLayout: barrierLayout(st.traverserLayout) });

/** `dropLayoutAtBarrier`'s layout half, split out so the contract test can run it on a layout
 *  without inventing a whole `LoweringState` around one. Every line below is one row of
 *  `BARRIER_ROLE_POLICY`; the `drop` roles appear as their own ABSENCE, which is precisely why the
 *  table has to be checked against this rather than merely read beside it. */
export function barrierLayout(c: TraverserLayout): TraverserLayout {
  const consumed = [...c.consumedAliases ?? [], ...c.aliases.keys()];
  return {
    aliases: new Map(),                                              // 'consumed' — names kept below
    origins: [],                                                     // 'empty'
    branchOrders: [],                                                // 'empty'
    trackFromV: c.trackFromV,                                        // 'keep'
    ...(consumed.length ? { consumedAliases: [...new Set(consumed)] } : {}), // 'keep' (+ the consumed names)
    // path / sack / fromV / encounter / bulk are 'drop' — absent by omission.
  };
}

/**
 * Append `body` as the new id-relation and advance to it. Layout-column opts route through
 * patchLayout (same tri-state as before); `elem` overrides when a step changes the element kind
 * (…E/…V). Returns a fresh ElementStream.
 *
 * The declared column list is DERIVED from the resulting layout and there is no override, so the
 * physical contract holds by construction rather than by assertion. It used to accept a `cols`
 * option, and the single caller that used it (`match()`'s seed) declared a binding table while its
 * layout still claimed `bulk` — a role the relation did not have. That survived only because the
 * next step rebuilt the layout from scratch. A layout claiming a column the relation lacks makes
 * `rel.c[role]` `undefined`, and an `undefined` spliced into a `q` template is a type error at no
 * layer, so removing the override closes the hole rather than merely reporting it: a site that
 * genuinely carries fewer roles must now say which ones it dropped (`layoutOverAliases`,
 * `dropLayoutAtBarrier`).
 */
export function appendCte(
  st: ElementStream, body: Expression,
  opts: LayoutPatch & { elem?: Elem } = {},
): ElementStream {
  const layout = patchLayout(st.traverserLayout, opts);
  return { ...st, traverserLayout: layout, elem: opts.elem ?? st.elem, rel: st.q.cte(body, ['id', ...layoutCols(layout)]) };
}
