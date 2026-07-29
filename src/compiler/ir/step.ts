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
