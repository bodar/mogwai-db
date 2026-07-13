import { type Step } from './frontend.ts';

// ---------- normalization passes (Seam 3) ----------
//
// TinkerPop's TraversalStrategy analogue: pure Step[]→Step[] rewrites applied
// once, up front, so the step compilers see a *canonical* chain and never do
// index arithmetic to gather a multi-step cluster. Keeping these as pure
// transforms (rather than inline rewrites scattered through the compiler) means
// each is independently testable and the compiler's dispatch stays a flat loop.
//
// The range/limit-before-vs-after-order() split is NOT a rewrite — it's the
// dispatch stop-boundary: range/limit/skip are prefix (CTE) steps until the
// prefix loop hits order()/a projection (a name absent from the prefix table),
// after which they fall to the tail as ORDER BY/LIMIT modifiers. So it lives in
// the dispatch itself (src/steps/index.ts), not here.

/**
 * A Step optionally carrying folded modulator data, so no step compiler ever
 * peeks at sibling steps:
 *  - `cluster` — the repeat/emit/times/until run (`foldRepeatClusters`).
 *  - `bys` — the trailing by() modulator arg-lists absorbed onto a host step
 *    (`foldByModulators`): order/select/project/group's by(), and the single
 *    by(key) an alias-compare where()/not() carries.
 * The compilers read these fields instead of re-scanning, so the whole read
 * dispatch is a peek-free fold over the step list.
 */
export type PStep = Step & { cluster?: Step[]; bys?: any[][]; options?: Step[] };

const REPEAT_CLUSTER = new Set(['repeat', 'emit', 'times', 'until']);
/** Steps that absorb trailing by() modulators. Alias-compare where()/not() also
 *  host a single by(key) but are detected structurally (see isAliasCompareWhere). */
const BY_HOSTS = new Set(['order', 'select', 'project', 'group', 'groupCount', 'path']);

/** Run every normalization pass. `discard` rides out-of-band — it's an output
 *  shape (iterate() → return nothing), not a step the compiler dispatches. */
export function normalize(steps: Step[]): { steps: PStep[]; discard: boolean } {
  const stripped = stripTerminal(steps);
  return { steps: foldChooseOptions(foldByModulators(foldRepeatClusters(stripped.steps))), discard: stripped.discard };
}

/** v4 iterate() appends a trailing discard() (or none()): execute, return nothing.
 *  Pop the marker and flag it. */
function stripTerminal(steps: Step[]): { steps: Step[]; discard: boolean } {
  const last = steps[steps.length - 1];
  if (last && (last.name === 'discard' || last.name === 'none'))
    return { steps: steps.slice(0, -1), discard: true };
  return { steps, discard: false };
}

/**
 * Gather each contiguous repeat/emit/times/until run into ONE step carrying the
 * cluster. The modulators can sit either side of repeat(); the run stops at the
 * first REPEATED step name so a second repeat-loop isn't swallowed — it folds as
 * its own cluster, correctly chained on this one's output. The folded step is
 * anchored on repeat() when present (so it dispatches to the branch compiler),
 * else on the first cluster step (so a stray emit()/times()/until() without
 * repeat() still reaches its "without repeat()" throw). Validation and SQL build
 * stay in the branch compiler — this pass only removes the index arithmetic.
 */
function foldRepeatClusters(steps: Step[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    if (!REPEAT_CLUSTER.has(steps[i].name)) { out.push(steps[i]); continue; }
    const cluster: Step[] = [];
    const seen = new Set<string>();
    let j = i;
    while (j < steps.length && REPEAT_CLUSTER.has(steps[j].name) && !seen.has(steps[j].name)) {
      seen.add(steps[j].name); cluster.push(steps[j]); j++;
    }
    const anchor = cluster.find((s) => s.name === 'repeat') ?? cluster[0];
    out.push({ ...anchor, cluster });
    i = j - 1;
  }
  return out;
}

/** An alias-compare where("a", P)/where(P)/not(P) — its arg0 is a label string or
 *  a Pred, NOT a nested traversal. Only these host a by(key) modulator (a
 *  where(__.trav) is modulated by nothing, so a trailing by() there stays a stray
 *  step and reaches its "by() only supported as an order()/select() modulator"
 *  throw — never silently absorbed). */
function isAliasCompareWhere(s: Step): boolean {
  if (s.name !== 'where' && s.name !== 'not') return false;
  const a = s.args[0];
  return typeof a === 'string' || (a != null && typeof a === 'object' && 'op' in a);
}

/** Absorb each host step's trailing contiguous by() steps into `host.bys`. The
 *  order()/select()/project()/group() modulators and an alias-compare where()'s
 *  single by(key) all become a field on their host, so the tail dispatch reads
 *  `.bys` and never looks at the next step. by() validation (token/traversal
 *  modulators still unsupported) stays in the compilers that read `.bys`. */
function foldByModulators(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!BY_HOSTS.has(s.name) && !isAliasCompareWhere(s)) { out.push(s); continue; }
    const bys: any[][] = [];
    let j = i + 1;
    for (; j < steps.length && steps[j].name === 'by'; j++) bys.push(steps[j].args);
    out.push(bys.length ? { ...s, bys } : s);
    i = j - 1;
  }
  return out;
}

/** Absorb each choose()'s trailing contiguous option() steps into `choose.options`
 *  — the option-map form choose(choiceFn).option(key, traversal)…. A choose with no
 *  trailing option() is the predicate form (untouched → the prefix branch compiler).
 *  The compiler reads `.options` and never scans siblings. */
function foldChooseOptions(steps: PStep[]): PStep[] {
  const out: PStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.name !== 'choose') { out.push(s); continue; }
    const options: Step[] = [];
    let j = i + 1;
    for (; j < steps.length && steps[j].name === 'option'; j++) options.push(steps[j]);
    out.push(options.length ? { ...s, options } : s);
    i = j - 1;
  }
  return out;
}
