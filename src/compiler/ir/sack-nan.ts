import type { MergePolicy, Step } from '../../gremlin/frontend.ts';
import { eachStepDeep, rawBodies, valueNodes } from './walk.ts';

// ---------- sack-nan: a NaN literal the sack may fold ----------
//
// SQLite has no NaN — it stores one as NULL — so a NaN that reaches the sack's fold arrives there as a
// NULL, and the fold answers for a NULL: `withSack(1.0).inject(NaN).sack(sum)` would be `1.0` (a NULL
// operand returns the other side, `NumberHelper.java:402`) where the reference adds `1.0 + NaN` and
// answers NaN, and `withSack(NaN).inject(1).sack(max)` would be the Double 1.0 where `NumberHelper.max`
// returns `b` unchanged, the Integer 1, once either side is NaN
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/NumberHelper.java`,
// `max(Number, Number)`). Which literal becomes which operand is a dataflow question this check does not
// try to answer: a traversal that folds or seeds a sack AND names a NaN literal ANYWHERE — the seed, any
// step argument at any depth — declines once, before lowering, for every host (fail closed).

/** Does this argument value hold a NaN anywhere — itself, a list member, a map key or value? */
const holdsNaN = (value: unknown): boolean => {
  for (const node of valueNodes(value)) if (typeof node === 'number' && Number.isNaN(node)) return true;
  return false;
};

/** A traversal whose sack may fold a NaN literal — `true` is a DECLINE (`compiler.ts`). */
export function sackFoldsNaN(steps: readonly Step[], params: Record<string, any>, sack: MergePolicy | null): boolean {
  let folds = sack !== null;
  let nan = sack !== null && holdsNaN(sack.seed.value);
  eachStepDeep(steps, rawBodies(params), (s) => {
    if (s.name === 'sack' && s.args.length) folds = true;
    if (s.args.some((a) => holdsNaN(a.value))) nan = true;
  });
  return folds && nan;
}
