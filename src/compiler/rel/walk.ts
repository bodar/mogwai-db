import { sameChannels, withChannel, type Channel, type Channels } from '../../channels.ts';
import { col, compilerInt, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { RelId } from '../../rel/types.ts';
import { containsSelfRef, mapRelChildren, mapRelExprs, rewriteExpr } from '../../rel/walk.ts';
import type { IRStep } from '../ir/step.ts';
import { isNested } from '../../gremlin/frontend.ts';
import type { AliasMap } from '../alias.ts';
import type { Elem } from '../elem.ts';
import { and, carriedCols, elementCols, meta, notProduced, or, typeOf, type Minter } from './build.ts';
import type { ChildSeam, Subject } from './child.ts';
import { CONSTANT } from './predicate.ts';
import type { RelFraming } from './framing.ts';

/** "Every row the walk holds" — an output condition that needs no filter, distinct from the absence
 *  of a condition. */
const ALL = Symbol('walk.all');

/** A recursive element walk before the enclosing fold consumes its remaining steps. */
interface WalkRead {
  readonly rel: Rel;
  readonly framing: Extract<RelFraming, { readonly kind: 'elements' }>;
  readonly aliases: AliasMap;
}

/**
 * `repeat()`'s unbounded `Recursive` regime.
 *
 * Admissions land one at a time (§8.6). Predicate `until` and `emit()` in both bare and predicate
 * form, each before or after `repeat`, in ALL FOUR position combinations; a carried PATH (seeded at
 * the source, appended per hop by the body, framed by a later `path()` — and read in-body by
 * `simplePath()`/`cyclicPath()`). `times`, named loops, an ENCOUNTER demand, body effects, shape
 * changes and other carried-state changes still decline to the whole-chain fallback.
 *
 * **OUTPUT POSITIONS — why three of the four combinations are one filter and the fourth is not.**
 * Bare `emit()` is a constant-true predicate (`TrueTraversal.instance()`, `GraphTraversal.java:4460`) and
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
/** Substitute one relation id for another throughout an expression, INCLUDING correlated subplans —
 *  a `simplePath()` filter's `COUNT(DISTINCT)` reads the body's path column through a scalar subquery,
 *  so distributing (below) that reparents the filter must follow the reference into that subquery, or
 *  the pushed-down copy still reads a column from the relation it was lifted off of. */
function substRelId(e: Expr, from: RelId, to: RelId): Expr {
  const inSubplan = (plan: Rel): Rel =>
    mapRelExprs(mapRelChildren(plan, inSubplan), (x) => substRelId(x, from, to));
  return rewriteExpr(e, (node) => (node.kind === 'col' && node.rel === from ? { ...node, rel: to } : node), inSubplan);
}

/** Rebuild a unary `Project`/`Filter` over a NEW input, remapping every reference to its OLD input's
 *  id onto the new one. The new input carries the same columns (it is one arm of the UNION ALL the
 *  node sat over), so the remap is total. A fresh node id keeps the two distributed copies distinct. */
function reparent(unary: Extract<Rel, { readonly kind: 'project' | 'filter' }>, input: Rel, fresh: Minter): Rel {
  const from = unary.input.id;
  return unary.kind === 'project'
    ? make.project({ id: fresh('wt'), input, channels: unary.channels, type: unary.type,
        exprs: unary.exprs.map(([name, e]) => [name, substRelId(e, from, input.id)] as const) })
    : make.filter({ id: fresh('wt'), input, channels: unary.channels, type: unary.type,
        pred: substRelId(unary.pred, from, input.id) });
}

/**
 * Project/Filter distribute over UNION ALL — Calcite's `Project`/`FilterSetOpTransposeRule` — pushing
 * the unary nodes a recursive body stacked over its hop-union DOWN into the arms, so each arm becomes
 * its own recursive term referencing the walk EXACTLY ONCE.
 *
 * ⚠️ **This is why a `both()`-bodied `repeat()` composes with anything above the hop.** A projection
 * (the path append, the loops bump) or a filter (`simplePath()`) left ABOVE the union takes a DERIVED
 * TABLE over a compound (the emitter's fusion rule, `src/rel/block.ts`), and a derived table collects
 * every arm's `SelfRef` into ONE SELECT — `circular reference`, P1/§6 of the build plan. Distributed,
 * each arm is a single recursive term SQLite accepts, which is also what makes a self-loop yield the
 * vertex twice. It is the same transpose the loops bump did by hand; generalizing it lets the body's
 * OWN path-append and `simplePath` nodes ride through the identical mechanism.
 *
 * A no-op wherever there is no self-referencing UNION ALL underneath — an ordinary `union` over a
 * non-recursive relation stays for the emitter to derived-table as before.
 */
function distributeThroughUnion(rel: Rel, name: string, fresh: Minter): Rel {
  const selfUnion = (r: Rel): r is Extract<Rel, { readonly kind: 'union' }> =>
    r.kind === 'union' && r.all && r.inputs.some((arm) => containsSelfRef(arm, name));
  if (rel.kind === 'union')
    return selfUnion(rel)
      ? make.union({ id: fresh('wd'), all: true, channels: rel.channels, type: rel.type,
          inputs: rel.inputs.map((arm) => distributeThroughUnion(arm, name, fresh)) })
      : rel;
  // A JOIN over a self-referencing UNION-ALL side — Calcite's `JoinUnionTransposeRule`, the shape a
  // `bothE().inV()` recursive body makes (`inV()` re-joins the edge table to read `tgt`, so the term is
  // `project(join(union(edge-arms), edges), …)`). Push the join INTO the union's arms so each arm is a
  // single recursive reference. The OTHER side (the plain edge scan) is SHARED across the arms — legal,
  // because the arms are distinct UNION-ALL SELECTs whose aliases are scoped per-SELECT (the `check`
  // that forbids a shared id is about the TWO SIDES of one join, which stay distinct here). The `on`
  // references the union side by its id, remapped to the arm's; the shared side's references are
  // untouched, and its schema — hence the join's positional output — is identical in every arm.
  if (rel.kind === 'join') {
    const left = distributeThroughUnion(rel.left, name, fresh);
    const right = distributeThroughUnion(rel.right, name, fresh);
    const distribute = (arms: readonly Rel[], onSide: 'left' | 'right'): Rel =>
      make.union({ id: fresh('wd'), all: true, channels: rel.channels, type: rel.type,
        inputs: arms.map((arm) => make.join({
          id: fresh('wj'), join: rel.join, ordered: rel.ordered,
          left: onSide === 'left' ? arm : left, right: onSide === 'left' ? right : arm,
          on: rel.on ? substRelId(rel.on, onSide === 'left' ? rel.left.id : rel.right.id, arm.id) : undefined,
          channels: rel.channels, type: rel.type,
        })) });
    if (selfUnion(left) && !containsSelfRef(right, name)) return distribute(left.inputs, 'left');
    if (selfUnion(right) && !containsSelfRef(left, name)) return distribute(right.inputs, 'right');
    return left === rel.left && right === rel.right ? rel
      : make.join({ id: fresh('wj'), left, right, on: rel.on, join: rel.join, ordered: rel.ordered, channels: rel.channels, type: rel.type });
  }
  if (rel.kind !== 'project' && rel.kind !== 'filter') return rel;
  const inner = distributeThroughUnion(rel.input, name, fresh);
  if (selfUnion(inner))
    return make.union({ id: fresh('wd'), all: true, channels: rel.channels, type: rel.type,
      inputs: inner.inputs.map((arm) => reparent(rel, arm, fresh)) });
  return inner === rel.input ? rel : reparent(rel, inner, fresh);
}

export function repeatWalk(
  step: IRStep, input: Rel, elem: Elem, child: ChildSeam, fresh: Minter, aliases: AliasMap,
): WalkRead | null {
  const region: readonly IRStep[] = step.repeatRegion ?? [step];
  const named = (name: string): IRStep | undefined => region.find((candidate) => candidate.name === name);
  const repeat = named('repeat');
  const until = named('until');
  const emit = named('emit');

  if (!repeat || named('times')) return null;
  if ((repeat.args ?? []).length !== 1 || repeat.loopName) return null;
  if (until && (until.args ?? []).length !== 1) return null;
  if (emit && (emit.args ?? []).length > 1) return null;
  for (const clustered of region) if (clustered.modulators?.length || clustered.optionArms) return null;

  const untilFirst = !!until && region.indexOf(until) < region.indexOf(repeat);
  const emitFirst = !!emit && region.indexOf(emit) < region.indexOf(repeat);
  /** The one combination whose two output routes cannot suppress each other. See `OUTPUT POSITIONS`. */
  const twice = !!until && !!emit && untilFirst && !emitFirst;

  const repeatBody = repeat.args[0]?.value;
  if (!isNested(repeatBody)) return null;
  const body = child.body(repeatBody.nested, 'child');
  if (!body?.length) return null;
  const untilBody = until?.args[0]?.value;
  if (until && !isNested(untilBody)) return null;
  const predicate = until && isNested(untilBody) ? child.body(untilBody.nested, 'child') : undefined;
  if (until && !predicate?.length) return null;
  // `emit(pred)` carries a nested traversal. The `emit(P)` overload wraps a raw predicate in
  // `__.filter(P)` upstream and does not reach us as one, so it declines here exactly as `until(P)`
  // already does rather than being silently read as a traversal.
  const emitBody = emit?.args[0]?.value;
  if (emit && (emit.args ?? []).length === 1 && !isNested(emitBody)) return null;
  const emitted = emit && (emit.args ?? []).length === 1
    && isNested(emitBody) ? child.body(emitBody.nested, 'child') : undefined;
  if (emit && (emit.args ?? []).length === 1 && !emitted?.length) return null;

  // Encounter is a unique position that cannot repeat at every depth, so it stays explicit rather than
  // being carried through a regime whose update law this route has not reviewed.
  //
  // A PATH now rides through, and its update law is exactly the recursive term's own. The channel is
  // seeded at the source (position 0) and rides in `input.channels`; the body re-enters our fold with
  // it live, so a movement APPENDS the arrived object (`extendPath` in `movement`) and `simplePath()`
  // reads it as an ordinary body filter — no path-specific machinery here. The one structural fact is
  // that an append is a `Project` and `simplePath` a `Filter`, and in a `both()` body those sit over
  // the hop-union; `distributeThroughUnion` (above) pushes them into the arms so each stays a single
  // recursive term. `path()` after the walk frames the carried column (`pathPositions`).
  //
  // A SACK does ride through, and it needs no rule here beyond the ones already holding. Its update
  // law is the recursive term's own — read the previous row's column, write the folded value — which
  // is exactly what `loops` already does one line down, and `sackMutate` builds only `Project` and
  // `Filter`, neither of which `BARRIER_IN_TERM` refuses. The dangerous case is a body that MINTS the
  // channel (`sack(assign)` with no `withSack`): that lengthens the channel list, and the
  // `sameChannels` round-trip below rejects it. Fan-out needs no split operator either — TinkerPop
  // applies one only when `withSack` declares it (`O_OB_S_SE_SL_Traverser.split`), and the Gremlin
  // string grammar can only supply an `Operator.*`, which is a merge; with none, the sack is copied
  // to every fan-out row, which is what the term's projection does by construction.
  for (const channel of input.channels)
    if (channel.role === 'encounter') return null;

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
   * The `emit` condition at `rel`, or `null` where its predicate does not lower. `ALL` is the whole
   * walk with no filter at all — a BARE `emit` is a constant-true predicate, so before `repeat` it
   * admits every row the walk holds, seed included. After `repeat` it follows `incrLoops`, so both
   * forms carry the depth test.
   */
  const emits = (rel: Rel): Expr | typeof ALL | null => {
    if (!emitted) return emitFirst ? ALL : deeper(rel);
    const tested = child.predicate(emitted, subject(rel), false);
    if (!tested) return null;
    return emitFirst ? tested : and(deeper(rel), tested);
  };
  /**
   * WHICH ROWS LEAVE THE WALK, as ONE predicate — the three position combinations whose two checks
   * suppress each other, so a qualifying row leaves exactly once. `twice` takes neither branch: its
   * routes are separate ARMS, not a disjunction.
   *
   * The one simplification is BARE `emit` after `repeat`: it is exactly `deeper`, which SUBSUMES an
   * `until`-after exit because that exit is literally `and(deeper, …)`. With `emit(pred)` the two
   * conditions are independent and the disjunction is spelled.
   */
  const leaves = (rel: Rel): Expr | typeof ALL | null => {
    if (!emit) return exits(rel) ?? null;
    const emitting = emits(rel);
    if (emitting === null || emitting === ALL) return emitting;
    const exiting = exits(rel);
    if (exiting === null) return null;
    if (exiting === undefined) return emitting;
    return emitted ? or(exiting, emitting) : emitting;
  };

  const seed = make.project({
    id: fresh('ws'), input, channels: carried, type: walkType,
    exprs: [['id', col(input.id, 'id')], ...carried.map((channel) => [channel.col,
      channel === depth ? compilerInt(0) : col(input.id, channel.col),
    ] as const)],
  });

  let termValid = true;
  const walkId = fresh('w');
  const walkName = `wk_${walkId}`;
  const walk = make.recursive({
    id: walkId, name: walkName, channels: carried, type: walkType,
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
      /** The counter bump — one projection incrementing `loops`, carrying every other column and
       *  channel (the path column the body just appended to included) through unchanged. */
      const bump = make.project({
        id: fresh('wi'), input: term.rel, channels: carried, type: walkType,
        exprs: [['id', col(term.rel.id, 'id')], ...carried.map((channel) => [channel.col,
          channel === depth
            ? { kind: 'binary', op: '+', left: col(term.rel.id, channel.col), right: compilerInt(1) } as Expr
            : col(term.rel.id, channel.col),
        ] as const)],
      });
      /**
       * ⚠️ **A TERM IS A COMPOUND, so the bump — and every per-iteration node the body stacked over
       * its hop-union (a path append, a `simplePath` filter) — DISTRIBUTES over the arms rather than
       * sitting above them.** `both()`/`bothE()`/`bothV()` are two `HOPS` entries unioned `ALL`, each
       * arm joining the frontier, which in a walk IS the `SelfRef`. A projection over that compound
       * takes a DERIVED TABLE that collects both references into one subquery: `circular reference`
       * (§6). `distributeThroughUnion` pushes the unary chain down into the arms so each becomes its
       * own recursive term referencing the walk once — the textbook `Project`/`Filter` through
       * `UNION ALL` transpose (Calcite's `Project`/`FilterSetOpTransposeRule`), and what makes a
       * self-loop yield the vertex twice. A non-`ALL` compound would dedup the whole walk, which
       * `recursiveViolation` refuses by name rather than letting this quietly rebuild it.
       */
      return distributeThroughUnion(bump, walkName, fresh);
    },
  });

  // The lowering and checker share one authority for SQLite's recursive-term laws. Calling it also
  // constructs the memoized step, so `termValid` reports any fold-level decline above.
  if (recursiveViolation(walk) || !termValid) return null;

  /**
   * A WALK WITH NEITHER MODULATOR EMITS NOTHING, so the walk itself is dead code.
   *
   * `RepeatEndStep` increments the counter, finds no `until`, re-adds the traverser, finds no `emit`
   * and returns nothing; `processTraverser` answers `EmptyTraverser` at the head. Traversers circulate
   * until the body is unproductive and not one of them ever leaves. It is a LEGAL traversal — upstream
   * verifies `repeat()` only for a missing BODY ("prevents silly stuff like `g.V().emit()`",
   * `StandardVerificationStrategy.java:83-85`) and imposes no modulator requirement — so answering it
   * is closing a legality gap, not adding a special case.
   *
   * ⚠️ **EMPTY IS NOT "no output": the rest of the chain still runs over an empty stream.**
   * `repeat(__.out()).count()` is `0`, because `count()` is a reducing barrier with a seed. So this
   * yields an empty ELEMENT relation for the fold to continue over, never a short circuit.
   *
   * The walk above is built and then DISCARDED, and that is the point: constructing it is what proves
   * the body lowers through our own fold, carries no effects and changes no shape — and the emptiness
   * argument holds only for a body with nothing observable in it. A body with effects is refused by
   * `termValid` before reaching here, so the traversal it stands for genuinely has no other outcome.
   *
   * Replacing a provably empty relation with an empty one, rather than evaluating it, is Calcite's
   * `PruneEmptyRules` (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/PruneEmptyRules.java`).
   * It is NOT the depth cap the root `CLAUDE.md` forbids: a cap truncates a PRODUCTIVE traversal and
   * changes its answer, while this changes no answer at all — only whether a query that provably
   * returns nothing spins to prove it. On a cyclic body that difference is observable as termination,
   * and terminating is the better half of it in a Durable Object with a per-request limit.
   */
  if (!until && !emit) return {
    rel: make.filter({ id: fresh('wn'), input, channels: input.channels, type: input.type, pred: CONSTANT.false }),
    framing: { kind: 'elements', elem },
    aliases,
  };

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
    const emitting = emits(walk);
    // `ALL` cannot arise here — it needs `emitFirst`, which `twice` excludes — but the walk declines
    // rather than assuming that, because an unfiltered arm would double every row in the walk.
    if (!exited || emitting === null || emitting === ALL) return null;
    surviving = make.union({
      id: fresh('wu'), channels: carried, type: walkType, all: true,
      inputs: [arm('wf', exited), arm('we', emitting)],
    });
  } else {
    const leaving = leaves(walk);
    if (leaving === null) return null;
    surviving = leaving === ALL ? walk : arm('wf', leaving);
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
