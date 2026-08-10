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
 * Admissions land one at a time (§8.6). This increment admits a predicate `until` and a BARE
 * `emit()`, each before or after `repeat`, in ALL FOUR position combinations; `times`, `emit(pred)`,
 * named loops, path state, body effects, shape changes and carried state changes still decline to
 * the whole-chain fallback.
 *
 * **OUTPUT POSITIONS — why three of the four combinations are one filter and the fourth is not.**
 * `emit()` is a constant-true predicate (`TrueTraversal.instance()`, `GraphTraversal.java:4460`) and
 * `emitFirst`/`untilFirst` are independent flags, each set iff its modulator was written before
 * `repeat` (`RepeatStep.java:89,100`); `doUntil`/`doEmit` then fire only at the MATCHING position
 * (`:125-131`). At the head, a until-first exit RETURNS before the emit-first check (`:265-278`);
 * at the end, the emit-last check sits in the ELSE of the until-last check (`:339-352`). So at a
 * SHARED position the two suppress each other and every output row leaves once — `exit OR emit`.
 * At OPPOSITE positions neither can, and `until` before with `emit` after is the one order where
 * emit runs FIRST in a traverser's journey: the row is emitted at `RepeatEndStep` and then exits at
 * the head, leaving the walk TWICE. That is traverser MULTIPLICITY, not another disjunct, so it
 * lowers as a `UNION ALL` of two arms over the one walk. The corpus states the difference as a
 * measurement rather than a rule: `repeat(…).emit().values("lang")` answers `java` while
 * `until(constant(true)).repeat(…).emit().values("lang")` answers `java, java`
 * (`vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/branch/Repeat.feature:258-284`).
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
  const emit = named('emit');

  if (!repeat || named('times')) return null;
  // A walk with NEITHER modulator never returns anything: `RepeatEndStep` re-loops until the body is
  // unproductive and `processTraverser` answers `EmptyTraverser` throughout, so the specified answer
  // is the EMPTY result. Neither spine gives it — both raise "repeat() requires times(), until(), or
  // emit()" — so this decline preserves a known-wrong deferral rather than a working route, and
  // closing it is tracked in §8 rather than folded in here.
  if (!until && !emit) return null;
  if ((repeat.args ?? []).length !== 1 || repeat.loopName) return null;
  if (until && (until.args ?? []).length !== 1) return null;
  // Bare `emit()` only; `emit(pred)` is the next cell.
  if (emit && (emit.args ?? []).length !== 0) return null;
  for (const clustered of region) if (clustered.modulators?.length || clustered.optionArms) return null;

  const untilFirst = !!until && region.indexOf(until) < region.indexOf(repeat);
  const emitFirst = !!emit && region.indexOf(emit) < region.indexOf(repeat);
  /** The one combination whose two output routes cannot suppress each other. See `OUTPUT POSITIONS`. */
  const twice = !!until && !!emit && untilFirst && !emitFirst;

  const body = child.body(repeat.args[0]?.value?.nested, 'child');
  if (!body?.length) return null;
  const predicate = until ? child.body(until.args[0]?.value?.nested, 'child') : undefined;
  if (until && !predicate?.length) return null;

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
  const deeper = (rel: Rel): Expr => ({
    kind: 'binary', op: '>', left: loops(rel), right: compilerInt(0),
  });
  /** The `until` exit condition at `rel` — `null` where the predicate does not lower, `undefined`
   *  where there is no `until` at all and the walk therefore never exits early. */
  const exits = (rel: Rel): Expr | null | undefined => {
    if (!predicate) return undefined;
    const tested = child.predicate(predicate, subject(rel), false);
    if (!tested) return null;
    // `untilFirst` tests the traverser as it ARRIVES, so the seed can exit untouched (while-do).
    // After `repeat` the test follows `incrLoops`, so the body always runs once (do-while).
    return untilFirst ? tested : and(deeper(rel), tested);
  };
  /**
   * WHICH ROWS LEAVE THE WALK — `undefined` for "all of them", so the common case emits no filter.
   *
   * With no `emit` this is the exit condition alone. Bare `emit` BEFORE `repeat` admits every row
   * the walk holds, seed included. Bare `emit` AFTER admits depth ≥ 1 — and that SUBSUMES an
   * `until`-after exit, which is literally `and(deeper, …)`, so the disjunction reduces to `deeper`
   * rather than being spelled as one. `twice` takes neither branch: its two routes are separate
   * ARMS, not one predicate.
   */
  const leaves = (rel: Rel): Expr | null | undefined =>
    (emit ? (emitFirst ? undefined : deeper(rel)) : exits(rel));

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
      if (stop === null) { termValid = false; return self; }
      // An unproductive until predicate is NOT an exit. `NOT NULL` would be NULL and would wrongly
      // discard the traverser, so use the shared two-valued answer. With no `until` nothing is
      // filtered: an emit-only walk expands every row and stops when the BODY is unproductive.
      const guarded = stop === undefined ? self : make.filter({
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

  const arm = (tag: string, pred: Expr): Rel =>
    make.filter({ id: fresh(tag), input: walk, channels: carried, type: walkType, pred });

  let surviving: Rel;
  if (twice) {
    // The two routes fire independently, so a row satisfying both leaves TWICE — a MULTISET sum,
    // which is a `UNION ALL` of the two arms (Calcite's `RepeatUnion.all`,
    // `vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/RepeatUnion.java`), never a
    // disjunction. Both arms read the SAME walk node and `name.ts` binds it once, so the walk is one
    // CTE the two arms share rather than a block spelled per reference.
    const exited = exits(walk);
    if (!exited) return null;
    surviving = make.union({
      id: fresh('wu'), channels: carried, type: walkType, all: true,
      inputs: [exited, deeper(walk)].map((pred, i) => arm(i === 0 ? 'wf' : 'we', pred)),
    });
  } else {
    const leaving = leaves(walk);
    if (leaving === null) return null;
    surviving = leaving === undefined ? walk : arm('wf', leaving);
  }
  // RepeatEndStep resets the counter on exit, so it never escapes the walk relation.
  const out = make.project({
    id: fresh('wo'), input: surviving, channels: input.channels,
    type: typeOf(meta('id', 'int'), ...carriedCols(input.channels)),
    exprs: [['id', col(surviving.id, 'id')],
      ...input.channels.map((channel) => [channel.col, col(surviving.id, channel.col)] as const)],
  });
  return { rel: out, framing: { kind: 'elements', elem }, aliases };
}
