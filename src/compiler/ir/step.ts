import { isScopeArg, type Step } from '../../gremlin/frontend.ts';

// ---------- the compiler's step node ----------
//
// `Step` (gremlin/frontend.ts) is the FRONT-END's node: a flat `{name, args, ctx}` the parser
// produces, and — per locked decision #5 in the root CLAUDE.md — the only thing the compiler is
// allowed to depend on. `IRStep` is the COMPILER's node: the same step after the canonicalize
// passes have absorbed its modulators and folded its multi-step shapes into named fields.
//
// It lives in its own leaf module because both halves of ir/ need it (the rewrite bodies that
// WRITE these fields, and every lowering that READS them) and it must not drag the strategy
// taxonomy along with it.

/**
 * A Step optionally carrying folded modulator data, so no step compiler ever
 * peeks at sibling steps:
 *  - `repeatRegion` — the repeat/emit/times/until run (`formRepeatRegions`).
 *  - `modulators` — the trailing by() modulator arg-lists absorbed onto a host step
 *    (`absorbModulators`): order/select/project/group's by(), and the single
 *    by(key) an alias-compare where()/not() carries.
 *  - `optionArms` — a choose()'s option() arms (`absorbOptionArms`).
 * The compilers read these fields instead of re-scanning, so the whole read
 * dispatch is a peek-free fold over the step list.
 */
export type IRStep = Step & { repeatRegion?: Step[]; modulators?: any[][]; optionArms?: Step[]; productiveBy?: boolean; from?: string; to?: string; withArgs?: [string, any][] };

// ---------- step-name vocabularies: DERIVE with a named difference, never merge ----------
//
// A dozen step-name Sets across the compiler overlap without being interchangeable, and their
// differences are LOAD-BEARING: `COLLAPSE_MOVES` and `VERTEX_PRODUCERS` differ on `otherV` because
// otherV's fromV context is per-traverser identity that a GROUP BY-id collapse would destroy, while
// a partition/subgraph vertex filter must still fire after it. Merging them would silently change
// semantics in at least three places.
//
// So this module exports BASES only. Every consuming set keeps its own name, its own home and its
// own call sites, and spells its membership relative to these — which turns an omission into
// something you can SEE (`COLLAPSE_MOVES` visibly excludes `OTHER_V`) instead of something you have
// to notice is absent. That absence is a real open bug for `POSITION_MOVEMENTS`
// (docs/outstanding-work.md item 0); making it visible is the point, and FIXING it is a separate
// change that needs its own test.
//
// Rule for anything added here: a base is a vocabulary with ONE meaning. If two consumers want
// different members, that is two bases, not one base plus an exception.

/** Union of step-name vocabularies. Named `unionOf`, not `union`, because `union` is a Gremlin
 *  step and a Set of step names is exactly the place that ambiguity would bite. */
export const unionOf = (...sets: readonly ReadonlySet<string>[]): ReadonlySet<string> =>
  new Set(sets.flatMap((s) => [...s]));

/** vertex → vertex (`out`/`in`/`both`). */
export const VERTEX_MOVES: ReadonlySet<string> = new Set(['out', 'in', 'both']);
/** vertex → edge (`outE`/`inE`/`bothE`). */
export const EDGE_MOVES: ReadonlySet<string> = new Set(['outE', 'inE', 'bothE']);
/** edge → its endpoint vertex (`outV`/`inV`/`bothV`). Deliberately EXCLUDES `otherV`, which is
 *  the whole reason it is its own base — see OTHER_V. */
export const ENDPOINT_MOVES: ReadonlySet<string> = new Set(['outV', 'inV', 'bothV']);
/** `otherV` alone. It is separate because it is the member the consuming sets DISAGREE about: it
 *  needs the entering vertex (`fromV`) retained, which makes it per-traverser identity — safe for a
 *  partition filter to follow, unsafe for a bulk collapse or a static path position. */
export const OTHER_V: ReadonlySet<string> = new Set(['otherV']);
/** The graph sources. */
export const VERTEX_SOURCE: ReadonlySet<string> = new Set(['V']);
export const EDGE_SOURCE: ReadonlySet<string> = new Set(['E']);

/** The path-family steps: they thread a path AND host from()/to() scoping modulators. */
export const PATH_FAMILY: ReadonlySet<string> = new Set(['path', 'simplePath', 'cyclicPath']);

/** The numeric reducers — every one a bulk-aware SQL aggregate over a scalar stream. */
const NUMERIC_REDUCER_NAMES = ['sum', 'min', 'max', 'mean'] as const;
export const NUMERIC_REDUCERS: ReadonlySet<string> = new Set(NUMERIC_REDUCER_NAMES);
/** The reducers including `count`. Spelled as a union so the several consumers that admit `count`
 *  and the two that do NOT are telling you which they are. */
export const REDUCERS: ReadonlySet<string> = unionOf(NUMERIC_REDUCERS, new Set(['count']));

/** A reducer by NAME, derived from the same member list as the set above rather than declared
 *  beside it — the set is the authority and the type cannot drift from it. (It could: the type
 *  lived in `tail/barrier.ts` and the set here, two independent spellings of four names.) */
export type NumericReducer = (typeof NUMERIC_REDUCER_NAMES)[number];
export type ScalarReducer = 'count' | NumericReducer;

/** A step that observes the WHOLE stream at once, so it cannot be evaluated per-row without
 *  answering a different question. The canonical example is the one that made this shared: a global
 *  `dedup()` drops a value two origins both reach, a per-origin one keeps both.
 *
 *  **THREE sites need exactly this fact and must not drift apart** — `repeat()`'s body (a barrier
 *  there observes the whole FRONTIER at one iteration), a `match()` pattern body (a barrier there
 *  reduces over the whole BINDING TABLE, not per binding), and a BRANCH ARM (a barrier there
 *  observes every traverser reaching the branch, not one). The first two defer rather than
 *  mis-execute; the third did neither until `verifyBranchArmBarrierScope`.
 *
 *  It lives HERE, in the IR's step vocabulary, and not beside its first consumer, because the
 *  branch-arm site is an `ir/` verify Pass — and `ir/` must not import from `steps/`. `child-shape.ts`
 *  re-exports it so no existing importer moved. */
export const GLOBAL_BARRIER_STEPS: ReadonlySet<string> = new Set([
  'dedup', 'order', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier',
  'group', 'groupCount', 'aggregate', 'local', 'fold', ...REDUCERS,
]);
export const isGlobalBarrier = (s: { readonly name: string }): boolean => GLOBAL_BARRIER_STEPS.has(s.name);

/** Is this step a barrier over the whole stream **as written**? `GLOBAL_BARRIER_STEPS` is by NAME,
 *  and a `Scope.local` argument narrows the same name to one shape's MEMBERS — `order(Scope.local)`
 *  reorders a list value's members and is row-local, where bare `order()` observes every traverser.
 *  Both gates that need this distinction spelled the exemption inline; this is the one predicate. */
export const isStreamBarrier = (s: IRStep): boolean =>
  isGlobalBarrier(s) && !(s.args ?? []).some((a: unknown) => isScopeArg(a) && a.scope === 'local');

/** The four steps that fork a traverser into arms and merge the results. */
export type BranchKind = 'union' | 'choose' | 'coalesce' | 'optional';
export const BRANCH_KINDS: ReadonlySet<string> = new Set<string>(['union', 'choose', 'coalesce', 'optional']);
export const asBranchKind = (name: string): BranchKind | null =>
  BRANCH_KINDS.has(name) ? name as BranchKind : null;
