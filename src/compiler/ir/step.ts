import { type Step } from '../../gremlin/frontend.ts';

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
