import { CHANNEL_GROUP_POLICY, sameChannels, withChannel, type Channel, type ChannelRole, type Channels } from '../../channels.ts';
import { col, compilerInt, eq, type Expr } from '../../rel/expr.ts';
import { exprRels, forEachExpr, forEachRel, freeRelIds } from '../../rel/walk.ts';
import * as make from '../../rel/factory.ts';
import { recursiveViolation } from '../../rel/recursive.ts';
import type { Rel } from '../../rel/rel.ts';
import type { RelType } from '../../rel/types.ts';
import { columnIsStored, spelledOuterColumns } from '../../rel/copies.ts';
import { TRAVERSER_STATE_READS, type IRStep } from '../ir/step.ts';
import { someStepDeep } from '../ir/walk.ts';
import { scopeKeyReads } from '../ir/labels.ts';
import { isNested } from '../../gremlin/frontend.ts';
import type { AliasMap } from '../alias.ts';
import type { Elem } from '../elem.ts';
import { and, carriedCols, elementCols, meta, notProduced, or, typeOf, type Minter } from './build.ts';
import type { ChildSeam, Subject } from './child.ts';
import { CONSTANT } from './predicate.ts';
import type { RelFraming } from './framing.ts';

/**
 * Does a condition read a NEIGHBOURHOOD — a subquery over `edges`? That is the work a hub multiplies: a per-row
 * read of the element's own labels or properties is one index seek whatever the graph's shape, so a condition
 * that reads only those stays per row (no spool, no semi-join); one that moves is asked per distinct state.
 */
function readsAdjacency(e: Expr): boolean {
  let moves = false;
  forEachExpr(e, (node) => {
    for (const plan of exprRels(node)) forEachRel(plan, (r) => { if (r.kind === 'scan' && r.table === 'edges') moves = true; });
  });
  return moves;
}

/** "Every row the walk holds" — an output condition that needs no filter, distinct from the absence
 *  of a condition. */
const ALL = Symbol('walk.all');

/** The walk's `until` answer column (`repeatWalk`'s `walkType`). Never escapes the walk: its output projection
 *  carries the traverser's own columns only. */
const EXIT = 'wx';

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
  // reads it as an ordinary body filter — no path-specific machinery here. An append is a `Project` and
  // `simplePath` a `Filter` over the hop's one join, so the term stays a single recursive reference
  // (`both()` included — `hopJoin`). `path()` after the walk frames the carried column (`pathPositions`).
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
  /** The traverser's own columns — what the body reads and the walk hands on. */
  const traverserType = typeOf(...elementCols(carried));
  /**
   * THE `until` TEST IS SPELLED ONCE, as a column of the walk (`EXIT`): each row the walk produces asks it
   * once, as it is produced, and everything downstream READS the answer — the term's stop test, the exit arm,
   * and the not-exiting rows an `emit` arm takes. Spelled at each use, a hub-reading `until` was evaluated
   * three times per walk row (term, exit arm, emit arm), the compute-once rule in the root `CLAUDE.md`.
   * Raw, not two-valued: a NULL (unproductive) test is not an exit, which `notProduced` and a `WHERE` both read
   * correctly. No `until`, no column.
   *
   * Landed only where the test reads STORED columns of the produced row (`columnIsStored`) or the counter.
   * SQL cannot name a sibling output column, so the test is written over the row's DEFINITIONS: over a value
   * the body COMPUTES — a folded sack, an appended path — it would re-spell that computation inside itself, the
   * very repetition it removes. There the walk is rebuilt unlanded and the test is asked where it is used,
   * of the stored walk row, as before (`landed`).
   */
  let landed = !!predicate;
  const walkTypeOf = (): RelType => landed ? typeOf(...traverserType.cols, meta(EXIT, 'int', true)) : traverserType;
  const loops = (rel: Rel): Expr => col(rel.id, depth.col);
  const subject = (rel: Rel): Subject => ({ kind: 'element', id: col(rel.id, 'id'), rel, elem });
  const deeper = (rel: Rel): Expr => ({
    kind: 'binary', op: '>', left: loops(rel), right: compilerInt(0),
  });
  /**
   * A CONDITION OVER THE FINISHED WALK IS ASKED ONCE PER DISTINCT TRAVERSER STATE, not once per walk row.
   *
   * A walk row is not a distinct element: every frontier row reaching a hub is another row FOR the hub, so a
   * condition evaluated per row repeats the hub's whole neighbourhood once per row reaching it — quadratic in
   * the walk exactly where the graph has hubs (measured: `emit(union(in('created'),out('knows')).has(…))`
   * 24× per 8× growth). The condition's answer is a function of what the traverser HOLDS and the condition
   * READS — its element, plus the per-traverser state a grouping cannot merge (`CHANNEL_GROUP_POLICY`
   * `undefined`) that the body can observe — never of its multiplicity (`TraversalUtil.test` sets the split's
   * bulk to 1, `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java`).
   * The KEY is therefore only what the body reads: the path, loops and sack where it reads split-inherited state
   * (`TRAVERSER_STATE_READS`), the labels where it reads a scope key (`scopeKeyReads`). The enclosing host's
   * scoping keys (`origin`, `branchKey`) are this compiler's, never visible to a condition — keyed on them, a
   * walk under `where`/`local` asked a hub's condition once per START (measured 19× per 8×), and keyed on a path
   * every state is a row. The graph tag and an edge's `fromV` are identity and stay.
   * So the states are DISTINCTED, the condition is asked of each (`child.predicate`, any head), and a walk row
   * passes iff its state passed: one semi-join, a hub's condition evaluated once per distinct state it is
   * reached in — a DISTINCT pushed below a semi-join, Calcite's `SemiJoinRule` family
   * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/SemiJoinRule.java`).
   *
   * Only the `emit` condition, and only one that reads adjacency (`readsAdjacency`: a condition over the row's
   * own columns, labels or properties — `loops()`, `has(k,v)` — costs one seek per row as it is). Inside the term (`self`) the frontier row is all there
   * is — a recursive SELECT may not DISTINCT or aggregate (`src/rel/recursive.ts` `BARRIER_IN_TERM`) — so the
   * `until` test stays per row there, and the output side READS its answer (`EXIT`) rather than asking again.
   * What keeps the term's per-row work bounded is `correlatedExistence`'s rule (`lower/scoped.ts`).
   *
   * ONLY OVER AN UNCORRELATED WALK (`freeRelIds(walk)` empty). A walk that reads an outer relation runs under a
   * host that keeps it correlated (an `EXISTS` re-evaluated per outer row) or that the decorrelator keys by scope
   * — either way the state is per outer row, so the DISTINCT merges nothing and its spool and semi-join are pure
   * cost (measured ≈2.4× slower than per row under `where`). There the condition stays per row. Per row and per
   * state answer the same rows; the choice is cost alone.
   */
  /** `rows` restricted to those whose STATE passes `body`, asked once per distinct state; `null` where `body`
   *  does not lower over a state row. */
  const perState = (rows: Rel, body: readonly IRStep[]): Rel | null => {
    const readsState = someStepDeep(body, child.params, (s) => TRAVERSER_STATE_READS.has(s.name), true);
    const labelReads = scopeKeyReads(body, child.params);
    const readsLabels = labelReads.all || labelReads.labels.size > 0;
    const observed = (role: ChannelRole): boolean => {
      switch (role) {
        case 'path': case 'loops': case 'sack': return readsState;
        case 'alias': return readsLabels;
        case 'origin': case 'branchKey': return false;
        default: return true;
      }
    };
    const stateChannels = carried.filter((channel) => CHANNEL_GROUP_POLICY[channel.role] === 'undefined' && observed(channel.role));
    const stateType = typeOf(...elementCols(stateChannels));
    const keys = make.project({
      id: fresh('wsk'), input: rows, channels: stateChannels, type: stateType,
      exprs: [['id', col(rows.id, 'id')], ...stateChannels.map((channel) => [channel.col, col(rows.id, channel.col)] as const)],
    });
    const states = make.distinct({ id: fresh('wsd'), input: keys, channels: stateChannels, type: stateType });
    const tested = child.predicate(body, subject(states), false);
    if (!tested) return null;
    // FENCED (`AS MATERIALIZED`): the passing states are ONE relation computed once. Unfenced, SQLite flattens
    // the condition into the semi-join's probe and asks it again per walk row — the quadratic form this replaces.
    const passing = make.materialize({
      id: fresh('wsp'), channels: stateChannels, type: stateType, fenced: true,
      input: make.filter({ id: fresh('wst'), input: states, channels: stateChannels, type: stateType, pred: tested }),
    });
    return make.join({
      id: fresh('wsj'), left: rows, right: passing, join: 'semi', channels: rows.channels, type: rows.type,
      on: stateType.cols.map((column) => eq(col(rows.id, column.name), col(passing.id, column.name))).reduce((all, one) => and(all, one)),
    });
  };
  /** The `until` predicate asked of `rel`'s row — `null` where it does not lower. */
  const tests = (rel: Rel): Expr | null => predicate ? child.predicate(predicate, subject(rel), false) ?? null : null;
  /** The `until` exit condition at a walk row — its `EXIT` column where `landed`, else the test asked of the
   *  row; `null` where the predicate does not lower, `undefined` where there is no `until` at all and the walk
   *  therefore never exits early. */
  const exits = (rel: Rel): Expr | null | undefined => {
    if (!predicate) return undefined;
    if (landed) return col(rel.id, EXIT);
    const tested = tests(rel);
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
   * `until`-after exit because that exit never holds on a seed row (`EXIT` is `0` there). With `emit(pred)` the two
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

  /** The traverser columns of `rel`, unchanged — `id` and every carried channel. */
  const traverserExprs = (rel: Rel): readonly (readonly [string, Expr])[] =>
    [['id', col(rel.id, 'id')], ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)];
  /** `rel` with its `EXIT` answer landed beside it; `null` where the `until` predicate does not lower. */
  const withExit = (rel: Rel, exit: Expr | null): Rel | null => !landed ? rel : !exit ? null : make.project({
    id: fresh('wx'), input: rel, channels: carried, type: walkTypeOf(), exprs: [...traverserExprs(rel), [EXIT, exit]],
  });

  const start = make.project({
    id: fresh('ws'), input, channels: carried, type: traverserType,
    exprs: [['id', col(input.id, 'id')], ...carried.map((channel) => [channel.col,
      channel === depth ? compilerInt(0) : col(input.id, channel.col),
    ] as const)],
  });

  /** The recursive walk, landed or not; `null` where it does not lower. `cheap` is false where a landed test
   *  would re-spell a computed column of the produced row. */
  const build = (): { readonly walk: Extract<Rel, { readonly kind: 'recursive' }>; readonly cheap: boolean } | null => {
    const walkType = walkTypeOf();
    // `untilFirst` tests the traverser as it ARRIVES, so the seed can exit untouched (while-do). After `repeat`
    // the test follows `incrLoops`, so the body always runs once (do-while): a seed row never exits, and every
    // row the term produces has run the body, so the term's test needs no depth guard.
    const seed = withExit(start, untilFirst ? tests(start) : compilerInt(0));
    if (!seed) return null;
    let termValid = true;
    let cheap = true;
    const walkId = fresh('w');
    const walk = make.recursive({
      id: walkId, name: `wk_${walkId}`, channels: carried, type: walkType,
      cols: walkType.cols.map((column) => column.name), seed,
      step: (self) => {
        const stop = exits(self);
        if (stop === null) { termValid = false; return self; }
        // An unproductive until predicate is NOT an exit. `NOT NULL` would be NULL and would wrongly
        // discard the traverser, so use the shared two-valued answer. With no `until` nothing is
        // filtered: an emit-only walk expands every row and stops when the BODY is unproductive.
        // The body reads the traverser's own columns, never `EXIT`.
        const staying = stop === undefined ? self
          : make.filter({ id: fresh('wg'), input: self, channels: carried, type: walkType, pred: notProduced(stop) });
        const guarded = !landed ? staying : make.project({
          id: fresh('wt'), input: staying, channels: carried, type: traverserType, exprs: traverserExprs(staying),
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
          id: fresh('wi'), input: term.rel, channels: carried, type: traverserType,
          exprs: [['id', col(term.rel.id, 'id')], ...carried.map((channel) => [channel.col,
            channel === depth
              ? { kind: 'binary', op: '+', left: col(term.rel.id, channel.col), right: compilerInt(1) } as Expr
              : col(term.rel.id, channel.col),
          ] as const)],
        });
        /**
         * ⚠️ **THE TERM REFERENCES THE WALK ONCE, and nothing here has to make it so.** A projection over
         * a compound whose arms each read the `SelfRef` would take a DERIVED TABLE collecting both
         * references into one subquery — `circular reference` (§6). That used to be every `both()` body
         * (two `HOPS` arms unioned `ALL`), and a `Project`/`Filter`/`Join`-through-`UNION ALL` transpose
         * (Calcite's `*SetOpTransposeRule`s) pushed the bump into the arms. A multi-direction hop now
         * reads its frontier ONCE through a direction row (`hopJoin`, `lower/movement.ts` — a `SelfRef` is
         * never free to read twice), so no body this route admits builds a self-referencing compound
         * (measured: zero over the L1 corpus and the repeat tests), and the transpose was deleted with
         * it. A body that ever did would be refused by name by `recursiveViolation` below, never
         * mis-executed; a `union()` body declines before reaching here.
         */
        if (!landed) return bump;
        const produced = withExit(bump, tests(bump));
        if (!produced) { termValid = false; return self; }
        const spelled = spelledOuterColumns(produced, bump.id, [EXIT]);
        cheap = !!spelled && [...spelled].every((name) => name === depth.col || columnIsStored(bump, name));
        return produced;
      },
    });
    // The lowering and checker share one authority for SQLite's recursive-term laws. Calling it also
    // constructs the memoized step, so `termValid` reports any fold-level decline above.
    if (recursiveViolation(walk) || !termValid) return null;
    return { walk, cheap };
  };
  let built = build();
  if (landed && !built?.cheap) { landed = false; built = build(); }
  if (!built) return null;
  const { walk } = built;
  const walkType = walkTypeOf();

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
  const emitting = emits(walk);
  if (emitted && emitting !== null && emitting !== ALL && readsAdjacency(emitting) && !freeRelIds(walk).size) {
    // An `emit` condition that reads ADJACENCY over an UNCORRELATED walk is asked once per distinct STATE
    // (`perState`): the rows past the depth test, semi-joined to the states that pass. With an `until` it is the
    // rows that do NOT exit — `exit ∪ (¬exit ∧ emit)` is the disjunction `leaves` spells, as two disjoint arms —
    // or, `twice`, every emitting row beside every exiting one (a multiset sum).
    const base = emitFirst ? walk : arm('wd', deeper(walk));
    const exiting = exits(walk);
    if (exiting === null) return null;
    const staying = exiting === undefined || twice ? undefined : exits(base);
    if (staying === null) return null;
    const emitArm = perState(!staying ? base
      : make.filter({ id: fresh('wn'), input: base, channels: carried, type: walkType, pred: notProduced(staying) }), emitted);
    if (!emitArm) return null;
    surviving = exiting === undefined ? emitArm : make.union({
      id: fresh('wu'), channels: carried, type: walkType, all: true, inputs: [arm('wf', exiting), emitArm],
    });
  } else if (twice) {
    // The two routes fire independently, so a row satisfying both leaves TWICE — a MULTISET sum,
    // which is a `UNION ALL` of the two arms (Calcite's `RepeatUnion.all`,
    // `vendor/calcite/core/src/main/java/org/apache/calcite/rel/core/RepeatUnion.java`), never a
    // disjunction. Both arms read the SAME walk node and `name.ts` binds it once, so the walk is one
    // CTE the two arms share rather than a block spelled per reference.
    const exited = exits(walk);
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
