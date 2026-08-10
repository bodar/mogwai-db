import { sameChannels, withChannel, type Channel, type Channels } from '../../channels.ts';
import { col, compilerInt, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { IRStep } from '../ir/step.ts';
import type { AliasMap } from '../plan/alias.ts';
import type { Elem } from '../plan/plan.ts';
import { and, carriedCols, elementCols, meta, notProduced, typeOf, type Minter } from './build.ts';
import type { ChildSeam, Subject } from './child.ts';
import type { RelFraming } from './framing.ts';

/** A recursive element walk before the enclosing fold consumes its remaining steps. */
interface WalkRead {
  readonly rel: Rel;
  readonly framing: Extract<RelFraming, { readonly kind: 'elements' }>;
  readonly aliases: AliasMap;
}

/**
 * `repeat()`'s unbounded `Recursive` regime.
 *
 * Admissions land one at a time (§8.6). This increment admits only predicate `until`, before or
 * after `repeat`; `times`, `emit`, named loops, path state, body effects, shape changes and carried
 * state changes still decline to the whole-chain fallback.
 *
 * The eventual counter is the `loops` channel declared in `src/channels.ts`. TinkerPop increments it
 * on `RepeatEndStep` and resets it on exit
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/RepeatStep.java`);
 * like Calcite's `RelNode.getVariablesSet()`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/RelNode.java`), it is state declared at
 * the relational position where it is live.
 */
export function repeatWalk(
  step: IRStep, input: Rel, elem: Elem, child: ChildSeam, fresh: Minter, aliases: AliasMap,
): WalkRead | null {
  const region: readonly IRStep[] = step.repeatRegion ?? [step];
  const named = (name: string): IRStep | undefined => region.find((candidate) => candidate.name === name);
  const repeat = named('repeat');
  const until = named('until');

  // This admission is intentionally one cell: one anonymous repeat plus one predicate until.
  if (!repeat || !until || named('times') || named('emit')) return null;
  if ((repeat.args ?? []).length !== 1 || repeat.loopName) return null;
  if ((until.args ?? []).length !== 1) return null;
  for (const clustered of region) if (clustered.modulators?.length || clustered.optionArms) return null;

  const body = child.body(repeat.args[0]?.value?.nested, 'child');
  const predicate = child.body(until.args[0]?.value?.nested, 'child');
  if (!body?.length || !predicate?.length) return null;

  // Encounter is a unique position that cannot repeat at every depth; path needs its own append
  // regime; sack folding is its own later admission. Keep all three explicit rather than carrying
  // state through a regime whose update law this increment has not reviewed.
  for (const channel of input.channels)
    if (channel.role === 'encounter' || channel.role === 'path' || channel.role === 'sack') return null;

  const depth: Channel = {
    col: `lp${input.channels.filter((channel) => channel.role === 'loops').length}`,
    role: 'loops',
  };
  const carried: Channels = withChannel(input.channels, depth);
  const header = elementCols(carried);
  const walkType = typeOf(...header);
  const loops = (rel: Rel): Expr => col(rel.id, depth.col);
  const subject = (rel: Rel): Subject => ({ kind: 'element', id: col(rel.id, 'id'), rel, elem });
  const untilFirst = region.indexOf(until) < region.indexOf(repeat);
  const deeper = (rel: Rel): Expr => ({
    kind: 'binary', op: '>', left: loops(rel), right: compilerInt(0),
  });
  const exits = (rel: Rel): Expr | null => {
    const tested = child.predicate(predicate, subject(rel), false);
    if (!tested) return null;
    return untilFirst ? tested : and(deeper(rel), tested);
  };

  const seed = make.project({
    id: fresh('ws'), input, channels: carried, type: walkType,
    exprs: [['id', col(input.id, 'id')], ...carried.map((channel) => [channel.col,
      channel === depth ? compilerInt(0) : col(input.id, channel.col),
    ] as const)],
  });

  let termValid = true;
  const walkId = fresh('w');
  const walk = make.recursive({
    id: walkId, name: `wk_${walkId}`, channels: carried, type: walkType,
    cols: header.map((column) => column.name), seed,
    step: (self) => {
      const stop = exits(self);
      if (!stop) { termValid = false; return self; }
      // An unproductive until predicate is NOT an exit. `NOT NULL` would be NULL and would wrongly
      // discard the traverser, so use the shared two-valued answer.
      const guarded = make.filter({
        id: fresh('wg'), input: self, channels: carried, type: walkType, pred: notProduced(stop),
      });
      const term = child.chain(guarded, { kind: 'elements', elem }, body, aliases);
      if (!term || term.effects?.length || term.framing.kind !== 'elements'
        || term.framing.elem !== elem || !sameChannels(term.rel.channels, carried)
        || term.aliases !== aliases) {
        termValid = false;
        return self;
      }
      return make.project({
        id: fresh('wi'), input: term.rel, channels: carried, type: walkType,
        exprs: [['id', col(term.rel.id, 'id')], ...carried.map((channel) => [channel.col,
          channel === depth
            ? { kind: 'binary', op: '+', left: col(term.rel.id, channel.col), right: compilerInt(1) } as Expr
            : col(term.rel.id, channel.col),
        ] as const)],
      });
    },
  });

  // The lowering and checker share one authority for SQLite's recursive-term laws. Calling it also
  // constructs the memoized step, so `termValid` reports any fold-level decline above.
  if (recursiveViolation(walk) || !termValid) return null;

  const leaves = exits(walk);
  if (!leaves) return null;
  const surviving = make.filter({
    id: fresh('wf'), input: walk, channels: carried, type: walkType, pred: leaves,
  });
  // RepeatEndStep resets the counter on exit, so it never escapes the walk relation.
  const out = make.project({
    id: fresh('wo'), input: surviving, channels: input.channels,
    type: typeOf(meta('id', 'int'), ...carriedCols(input.channels)),
    exprs: [['id', col(surviving.id, 'id')],
      ...input.channels.map((channel) => [channel.col, col(surviving.id, channel.col)] as const)],
  });
  return { rel: out, framing: { kind: 'elements', elem }, aliases };
}
