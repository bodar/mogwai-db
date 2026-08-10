import type { Rel } from '../../rel/rel.ts';
import type { IRStep } from '../ir/step.ts';
import type { AliasMap } from '../plan/alias.ts';
import type { Elem } from '../plan/plan.ts';
import type { Minter } from './build.ts';
import type { ChildSeam } from './child.ts';
import type { RelFraming } from './framing.ts';

/** A recursive element walk before the enclosing fold consumes its remaining steps. */
export interface WalkRead {
  readonly rel: Rel;
  readonly framing: Extract<RelFraming, { readonly kind: 'elements' }>;
  readonly aliases: AliasMap;
}

/**
 * `repeat()`'s unbounded `Recursive` regime.
 *
 * This scaffold deliberately declines every shape. Admissions land one at a time (§8.6), each with
 * its own reference argument and executable pin; until then the existing whole-chain router gives
 * legacy exactly the same traversal it received before this hook existed.
 *
 * The eventual counter is the `loops` channel declared in `src/channels.ts`. TinkerPop increments it
 * on `RepeatEndStep` and resets it on exit
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/RepeatStep.java`);
 * like Calcite's `RelNode.getVariablesSet()`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/RelNode.java`), it is state declared at
 * the relational position where it is live.
 */
export function repeatWalk(
  _step: IRStep, _input: Rel, _elem: Elem, _child: ChildSeam, _fresh: Minter, _aliases: AliasMap,
): WalkRead | null {
  return null;
}
