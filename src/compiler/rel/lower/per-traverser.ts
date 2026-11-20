import { withChannel } from '../../../channels.ts';
import { isNested } from '../../../gremlin/frontend.ts';
import type { ParamEnv } from '../../../gremlin/param-env.ts';
import { col, eq } from '../../../rel/expr.ts';
import * as make from '../../../rel/factory.ts';
import type { Rel } from '../../../rel/rel.ts';
import type { AliasMap } from '../../alias.ts';
import { optionArms } from '../../ir/option-map.ts';
import { BATCHING_BRANCHES, FAN_OUT_HOSTS, isLocalScope, isStreamBarrier, nondeterministic, ONE_TO_ONE, REDUCERS } from '../../ir/step.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { someStepDeep } from '../../ir/walk.ts';
import { carriedCols, elementCols, meta, payloadCols, renumber, typeOf, type Minter } from '../build.ts';
import type { RelFraming } from '../framing.ts';
import { continueAs, dropPath } from '../lower.ts';
import { extendPath, PATH_CHANNEL, PATH_COL, pathCarried } from '../path.ts';
import { BRANCH_HOSTS } from './branch.ts';
import { bodyOf, encounterOf, noteUnrolled, originOf, type ChainCtx, type Tail } from './chain.ts';
import { childResultPath, childRows, dropOrigin, mintRowOrigin, nestRowOrigin, reductionHost, reductionTail, scalarChild, selfCollapses, shedBodyAliases } from './reduction.ts';

// THE PER-TRAVERSER ROUTE — the ladder's `map`/`flatMap`/`local` lowering (the `correlatedChild` fast path's
// remaining per-traverser family, `docs/2026-11-16-ladder-retirement-plan.md` R4): `perTraverserChild` picks
// between the correlated first-row read (`scalarChild`, `lower/reduction.ts`) and the per-origin rejoin
// (`flatMapRejoin`), and the admission gates only that choice consults. ROUTING only — the substrate it
// routes between is shared with the scoped-relation connector and lives in `lower/reduction.ts`. Split out by
// R1 (measured: line coverage of the L1+L6 pools under the ladder first vs the connector alone) so the ladder's
// real size is this file, which `scripts/ladder-check.ts` ratchets per file.

export function perTraverserChild(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>, steps: readonly IRStep[], at: number,
  bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
): Tail | null {
  if (step.modulators?.length || step.optionArms) return null;
  const nested = step.args[0]?.value, extra = step.args[1]?.value;
  if (extra !== undefined || !isNested(nested)) return null;
  const body = bodyOf(nested.nested, ctx.params);
  if (!body?.length) return null;
  // A repeat() unrolled into this body fuses into the host's ONE relation; the host is map-like, so a
  // decline past a statement limit may suggest moving the repeat() out of it (`noteUnrolled`).
  noteUnrolled(body, ctx, step.name);
  // The body BEGINS a child traversal handed one traverser at a time at bulk 1 — `map`/`flatMap` through
  // `TraversalUtil.apply`, and `local` because `LocalStep.nextStart` SPLITS a merged slot into unit
  // traversers and runs its body once per unit
  // (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88`)
  // — so a bulk-sensitive consumer inside it may read its rows as the reference's traversers
  // (`ChainCtx.traversal`), and a merge before the host changes nothing a per-row body answers.
  const bodyCtx: ChainCtx = { ...ctx, traversal: { steps: body, rooted: false } };

  // A re-source that DRAWS (at any depth of the body) is one shared evaluation on the scalar route
  // (`rootedRead` refuses it), so `local`/`flatMap`, which emit every result, draw per row through the
  // rejoin first (`reSourcedOnce`, GraphStep's product).
  if (step.name !== 'map' && nondeterministic(body, ctx.params)
    && someStepDeep(body, ctx.params, (s) => s.name === 'V' || s.name === 'E', true)) {
    const perRow = flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
    if (perRow) return perRow;
  }
  const produced = scalarChild(body, reductionHost(rel, framing, labels), bodyCtx, fresh);
  if (!produced) return flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
  // THE POLICY, and it is the whole difference between the three steps: `local`/`flatMap` emit EVERY
  // result, so a correlated scalar is their answer only where the body had exactly ONE to give, while
  // `map` takes the first by definition. The seam states which (`ChildValue.yields`) rather than this
  // reading it off the framing — a reducing `result` marker implies one, but so does an endpoint
  // re-root that is not a reducer at all, and inferring it here made `local(__.outV())` decline.
  // A body with more to give falls to the row-producing rejoin, exactly as an unanswered scalar does.
  if (step.name !== 'map' && produced.yields !== 'one') return flatMapRejoin(step, rel, framing, body, steps, at, bulked, ctx, fresh, labels, bodyCtx);
  // An unproductive body DROPS the traverser at all three hosts (`map` by the citation above;
  // `local`/`flatMap` because a body with no results contributes none), so the signal is required
  // rather than assumed — `ChildValue.present`'s own contract.
  if (produced.present === 'unknown') return null;

  // The body's ONE result framed as this stream's payload, presence filtered and shed — see
  // `reductionTail`, shared with the `coalesce`/`optional` reduction arm. The tail then continues.
  const tail = reductionTail(rel, produced, fresh, labels, bulked);
  if (!tail) return null;
  const pathed = childResultPath(tail, step.name !== 'local', fresh);
  return continueAs(pathed.rel, pathed.framing, steps, at + 1, bulked, ctx, fresh, labels);
}

/** The stream barriers that SELF-SCOPE per origin when run inside a per-traverser body — `order()` (a
 *  global sort restricted to a partition IS that origin's order), `dedup()` (per-origin DISTINCT via
 *  `dedupOn`), the slice family including `sample` (`perOriginWindow` via `sliceOp`, a RANDOM collation
 *  for `sample` — or, after a re-source, `reSourcedOnce`'s per-origin draw), and the no-op `barrier`.
 *  Every OTHER `isStreamBarrier` step (`fold`,
 *  `group`/`groupCount`/`aggregate`, a reducer, a nested `local`) either changes the framing or has no
 *  per-origin form, so a body containing one DECLINES — the whitelist twin of `match`'s
 *  `PER_ORIGIN_UNSAFE` blacklist. */
export const PER_ORIGIN_SAFE_BARRIER: ReadonlySet<string> = new Set(['order', 'dedup', 'limit', 'range', 'skip', 'tail', 'sample', 'barrier']);

/** The CARDINALITY-changing barriers that self-scope per origin by GROUPING rather than by a window — a
 *  `fold()` that CONTINUES mid-body (`local(__.out().fold().unfold())`) and a `group()`/`groupCount()`
 *  (`local(__.out().group().by(k))`). Distinct from `PER_ORIGIN_SAFE_BARRIER` on purpose (per its own
 *  comment that set stays a WINDOW-scoping whitelist): these reduce N rows to one PER ORIGIN via
 *  `GROUP BY origin` (`foldPerOrigin` in `list.ts`, `groupMap`'s per-origin path in `map.ts` — the key
 *  spliced not a passenger, the seed LEFT JOINed off the origin DOMAIN so an empty sub-stream still emits
 *  `[]`/`{}`). A TERMINAL `fold()` never reaches here — `scalarChild` answers it as a correlated list
 *  before `flatMapRejoin`. */
export const PER_ORIGIN_GROUPING_BARRIER: ReadonlySet<string> = new Set(['fold', 'group', 'groupCount']);

/**
 * Does every stream barrier of a per-traverser body SELF-SCOPE by the body's ONE origin? The admission
 * gate of the per-row rejoin (`flatMapRejoin`, both its forms).
 *
 * A barrier self-scopes when it is a per-origin window or grouping (the two sets above), or when it is a
 * NESTED per-traverser host that scopes within the enclosing row (`nestedHostScopes`).
 */
export function bodyScopesPerOrigin(body: readonly IRStep[], params: ParamEnv): boolean {
  return body.filter(isStreamBarrier).every((s) =>
    PER_ORIGIN_SAFE_BARRIER.has(s.name) || PER_ORIGIN_GROUPING_BARRIER.has(s.name) || nestedHostScopes(s, params));
}

/** The stream barriers a body NESTED under an enclosing origin may hold: a per-origin WINDOW (scoped by a
 *  nested origin, `nestRowOrigin`) or a further nested host. A GROUPING barrier is not among them — its
 *  `GROUP BY` names one origin, and the enclosing one has no group policy to ride it as a passenger. */
const nestedBarrierScopes = (s: IRStep, params: ParamEnv): boolean =>
  PER_ORIGIN_SAFE_BARRIER.has(s.name) || nestedHostScopes(s, params);

/**
 * A NESTED `local`/`map`/`flatMap` whose body scopes WITHIN one row of the enclosing per-traverser body
 * — it runs once per entering traverser (`LocalStep.java:80-88`, `FlatMapStep.java:42-52` under
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/`), so
 * it composes over the ENCLOSING origin. Two body forms qualify:
 *
 * - a ONE-value body — one ending in a reducer or a `fold()`, which `scalarChild` answers as a correlated
 *   scalar over the row's element (`local(__.count())`, `local(__.out('knows').count())`): whatever
 *   barriers precede the reducer live inside that correlated read and never see an origin;
 * - a FAN-OUT body whose barriers are per-origin windows or further such hosts (`local(__.out())`,
 *   `local(__.out().limit(1))`): `flatMapRejoin` runs it under a NESTED origin (`nestRowOrigin`) where it
 *   holds a window or a branch at any depth, and inlined where it holds neither.
 */
function nestedHostScopes(step: IRStep, params: ParamEnv): boolean {
  if (!FAN_OUT_HOSTS.has(step.name) || step.modulators?.length || step.optionArms || step.args.length !== 1) return false;
  const nested = step.args[0]!.value;
  const body = isNested(nested) ? bodyOf(nested.nested, params) : null;
  if (!body?.length) return false;
  const last = body.at(-1)!;
  if (isStreamBarrier(last) && (REDUCERS.has(last.name) || last.name === 'fold')) return true;
  return body.filter(isStreamBarrier).every((s) => nestedBarrierScopes(s, params));
}

/**
 * Does a per-traverser body give AT MOST ONE result for each traverser it is applied to — so `map()` may
 * share `flatMap()`'s rejoin (`flatMapRejoin`) with no "first" to name?
 *
 * Read off the IR's arity vocabulary rather than a list of its own: the body is a run of steps that each
 * keep "at most one" (`ONE_TO_ONE`, `src/compiler/ir/step.ts` — the always-bound `MapStep`s
 * `EarlyLimitStrategy`'s port crosses — and every `Scope.local` op, a `ScalarMapStep` one-in one-out), after
 * either the traverser itself (the body's start) or a GLOBAL collapse (`selfCollapses` — one row or none
 * over the traverser's sub-stream, whatever precedes it). A branch keeps it where its arms do: `choose`
 * routes each traverser to ONE option, an unwritten `Pick` being the identity its constructor installs
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java`
 * `pickBranches`, and the constructor's pass-throughs); `coalesce` emits one arm's results, `optional` its
 * arm's or the traverser; a nested `map` is one by definition and `local`/`flatMap` are their body's.
 *
 * The correlated-row authority (`atMostOneRow`, `src/rel/bounds.ts`) cannot answer this here: the rejoin
 * lowers the body over EVERY traverser at once, and a `choose`'s arms lower to a `union` whose disjoint gates
 * `rowBounds` does not read. Sufficient, not necessary — an unreadable body answers `false`, and the rejoin
 * then stays closed to `map`.
 */
function atMostOnePerTraverser(body: readonly IRStep[], params: ParamEnv): boolean {
  const one = (raw: unknown): boolean => {
    const inner = bodyOf(raw, params);
    return !!inner && atMostOnePerTraverser(inner, params);
  };
  const each = (value: unknown): boolean => isNested(value) && one(value.nested);
  const keeps = (step: IRStep): boolean => {
    if (step.modulators?.length) return false;
    if (isLocalScope(step)) return true;
    if (step.name === 'constant') return !step.args.some((arg) => isNested(arg.value));
    if (ONE_TO_ONE.has(step.name)) return true;
    if (step.name === 'map') return step.args.length === 1 && isNested(step.args[0]!.value);
    if (step.name === 'local' || step.name === 'flatMap' || step.name === 'optional' || step.name === 'coalesce')
      return step.args.length >= 1 && step.args.every((arg) => each(arg.value));
    if (step.name !== 'choose') return false;
    if (step.optionArms) {
      const arms = optionArms(step, (nested) => bodyOf(nested, params));
      return !!arms && arms.every((arm) => arm.discard || one(arm.nested));
    }
    const arms = step.args.slice(1);
    return arms.length >= 1 && arms.every((arg) => each(arg.value));
  };
  for (let i = body.length - 1; i >= 0; i--) {
    const step = body[i]!;
    if (selfCollapses(step.name) && !isLocalScope(step)) return true;
    if (!keeps(step)) return false;
  }
  return true;
}

/**
 * A FAN-OUT `flatMap`/`local` body, spliced back as a REJOIN — the general child answer
 * `scalarChild`'s movement arm explicitly defers ("fan-out `flatMap(__.V()…)` needs the general child
 * rejoin"). `scalarChild` only produces a body that yields ONE value per traverser; a body that FANS
 * OUT (`__.out()`, `__.out().values('name')`) is not a correlated scalar, it REJOINS.
 *
 * A body with NO stream barrier is TRANSPARENT: `flatMap`/`local` run it per traverser, and with
 * nothing to scope per-origin the answer is the body inlined into the outer chain — `flatMap(__.out())`
 * is `out()`, `local(__.out())` is `out()`. A per-origin-SAFE barrier inside it
 * (`local(__.out().order().by(k).limit(1))`, `local(__.both().dedup())`) is scoped to the ENTERING
 * traverser: the whole body runs through `childRows(perRow: true)` (a per-ROW origin), and `sliceOp`/
 * `dedupOn`/`order` self-scope by it. Then DROP origin: a later `dedup` is whole-row, so leaving origin
 * as a column would distinguish rows by WHICH host they descend from and keep convergent walks that must
 * collapse.
 *
 * `map` takes the body's FIRST result: `TraversalMapStep.processNextStart` is `applyAll(traverser,
 * mapTraversal)` then `traverser.split(iterator.next())`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java`)
 * — `FlatMapStep`'s split from the same head, taken once. So where the body has at most one result per
 * traverser (`atMostOnePerTraverser` — a list- or variant-valued branch the correlated-scalar route cannot
 * carry, `map(choose(k).option(v, values('name').fold())…)`) the first IS every result, and `map` is this
 * rejoin exactly, path and label shedding included. A fan-out body has no "first" to name without a window,
 * so it stays closed. A scalar host has no rowid for `origin` (`childRows`' own limit), so only an element
 * host reaches here.
 */
export function flatMapRejoin(
  step: IRStep, rel: Rel, framing: Extract<RelFraming, { readonly kind: 'elements' } | { readonly kind: 'scalar' }>,
  body: readonly IRStep[], steps: readonly IRStep[], at: number, bulked: boolean, ctx: ChainCtx, fresh: Minter, labels: AliasMap,
  bodyCtx: ChainCtx = ctx,
): Tail | null {
  if (step.name === 'map' ? !atMostOnePerTraverser(body, ctx.params) : step.name !== 'flatMap' && step.name !== 'local') return null;
  if (framing.kind !== 'elements') return null;
  // `map` re-derives from the PRE-child head exactly as `flatMap` does (`head.split`), so below it takes
  // `flatMap`'s path and label treatment; only `local` forwards the child's own traverser.
  const splits = step.name !== 'local';
  // AN ENCLOSING ORIGIN — this host sits inside another per-traverser body (`local(__.out().local(…))`,
  // a `group().by()` reducer body, a `match` pattern), whose origin the input already carries and which
  // that enclosing host still needs back. A body holding a per-origin window or a branch ANYWHERE scopes
  // per INNER row, so it runs under a NESTED origin (`nestRowOrigin`), shed again below; a body holding
  // neither is the body inlined, and runs over the enclosing origin unchanged. A grouping barrier declines
  // (`nestedBarrierScopes`), and so does the path-hide below, whose origin → path join is one-to-one only
  // for an origin minted over THIS input.
  const enclosed = !!originOf(rel.channels);
  const barriers = body.filter(isStreamBarrier);
  if (enclosed && (!barriers.every((s) => nestedBarrierScopes(s, ctx.params)) || (ctx.tracksPath && splits && pathCarried(rel)))) return null;
  // WHETHER to nest is a question about the WHOLE body, not its top level: a per-origin window inside a
  // `union`/`choose` arm (`local(__.union(__.out().limit(1), __.in().limit(1)))`) partitions by
  // `originOf` exactly as a top-level one does, and an arm merge orders by it — so under the ENCLOSING
  // origin either would scope per OUTER traverser where `LocalStep` scopes per entering one
  // (`.../step/branch/LocalStep.java:80-88`). Only a body with no barrier and no branch anywhere is the
  // body inlined.
  const nests = enclosed && someStepDeep(body, ctx.params, (s) => isStreamBarrier(s) || BRANCH_HOSTS.has(s.name), true);
  // PATH: `local` and plain `flatMap` DIVERGE (`vendor/tinkerpop/gremlin-core`). `LocalStep` forwards
  // the child's FULL `Traverser.Admin` (`.../step/branch/LocalStep.java:60-67` →
  // `.../Traversal.java:593-595`), so `local(out().out()).path()` is `[v, mid, end]` — the body's minted
  // positions ARE the answer, and since `inBody` does not clear `tracksPath` the ordinary fold already
  // appends them: nothing to hide, carry through. Plain `flatMap` unwraps to a value and re-derives from
  // the PRE-child head (`.../map/FlatMapStep.java:42-52` → `.../util/DefaultTraversal.java:220-230` →
  // `.../Traverser.java:185-195`), so `flatMap(out().out()).path()` is `[v, end]` — its intermediate
  // objects are HIDDEN (`.../gremlin-test/.../map/FlatMap.feature:56`). The reference is precise:
  // `LP_O_OB_P_S_SE_SL_Traverser.split` (`.../traverser/LP_O_OB_P_S_SE_SL_Traverser.java:65-69`) sets
  // `clone.path = head.path.clone().extend(r, labels)` — the PRE-child head's path extended by exactly ONE
  // position, the emitted value. So the body runs PATH-FREE (a path-hostile body step then composes, as it
  // does in TinkerPop where the body's own paths are invisible), the entering path P is recovered by a
  // per-row origin, and the one output element is appended: P ++ [emitted]. Only an ELEMENT-output body has
  // an id to append; a scalar/list output under `path()` stays its own increment.
  // Only where the INPUT carries a path: a probe of the body's productivity (`coalesce`/`optional`'s
  // exhaustion guard, `childPredicate`) runs it over a path-free subject, which has no P to recover.
  if (ctx.tracksPath && splits && pathCarried(rel)) {
    if (!bodyScopesPerOrigin(body, ctx.params)) return null;
    const numbered = mintRowOrigin(rel, fresh); // a per-row origin BESIDE the entering path P
    const origin = originOf(numbered.channels)!;
    // origin -> P, one row per entering traverser (a fan-out is one-to-many, so recovering P is a real JOIN).
    const pathDomain = make.project({
      id: fresh('pd'), input: numbered, channels: [], type: typeOf(meta('porigin', 'int'), meta(PATH_COL, 'json', true)),
      exprs: [['porigin', col(numbered.id, origin.col)], [PATH_COL, col(numbered.id, PATH_COL)]],
    });
    // Run the body over the numbered input with PATH DROPPED — it appends nothing (`pathCarried` false).
    const rows = childRows(body, dropPath(numbered, fresh), framing.elem, labels, bodyCtx, fresh, true, ctx.needsFromV ?? false);
    if (!rows || rows.framing.kind !== 'elements') return null;
    const bodyChannels = rows.rel.channels; // element id + origin, no path
    const joined = make.join({
      id: fresh('fpj'), left: rows.rel, right: pathDomain, join: 'inner', ordered: true, channels: bodyChannels,
      type: typeOf(...elementCols(bodyChannels), meta('porigin', 'int'), meta(PATH_COL, 'json', true)),
      on: eq(col(pathDomain.id, 'porigin'), col(rows.rel.id, origin.col)),
    });
    // Re-attach the entering path P as the path channel, then extend it by the one emitted element.
    const outChannels = withChannel(bodyChannels, PATH_CHANNEL);
    const withEnteringPath = make.project({
      id: fresh('fp'), input: joined, channels: outChannels, type: typeOf(...elementCols(outChannels)),
      exprs: elementCols(outChannels).map((column) => [column.name, col(joined.id, column.name)] as const),
    });
    const extended = extendPath(withEnteringPath, { kind: 'element', elem: rows.framing.elem, id: col(withEnteringPath.id, 'id') }, fresh, ctx.demandsPathLabels);
    const rejoined = shedBodyAliases(dropOrigin(originMajor(extended, body, ctx.params, fresh), fresh), labels, fresh);
    return continueAs(rejoined, rows.framing, steps, at + 1, bulked, ctx, fresh, labels);
  }
  // A LABEL BOUND INSIDE THE BODY escapes to parent scope for `local` (the full-traverser forward above,
  // so `g.V()…as('a').local(__.out('created').as('b')).select('a','b')` sees `b`) but NOT for plain
  // `flatMap`: `head.split` re-derives from the pre-child head, so a body-bound label is DROPPED. `local`
  // threads the body's outbound `AliasMap` below; `flatMap` SHEDS the body-bound alias channels and keeps
  // the pre-body map, so a downstream `select('b')` is the correct EMPTY result (`Select.feature`), not a
  // decline and not a wrong binding — see the rejoin below.
  // Run the WHOLE body PER TRAVERSER: `local`/`flatMap` apply their body to each traverser
  // independently (TinkerPop's `LocalStep`/`FlatMapStep`), so a slice/`dedup`/`order` inside it scopes
  // to the ENTERING traverser, not globally — the SAME per-origin substrate `match` uses (a pattern body
  // is TinkerPop's flatMap-localized barrier, `MatchStep.java:156-166`). `childRows(perRow: true)` mints
  // a per-ROW origin (NOT the element id — `g.V().both().local(out().limit(1))` has three separate
  // traversers at `marko`, each owed its own `limit(1)`, which the element-id seed collapsed to one), the
  // body's slices/`dedup` self-scope by that origin (`sliceOp`/`dedupOn`) and its `order()` mints the
  // encounter they rank by, then origin is shed. Only per-origin-SAFE barriers compose this way:
  // `fold`/`group`/`aggregate`/a reducer that are not per-origin GROUPINGS (framing-changing, and a
  // reducer is `scalarChild`'s job, tried first in `perTraverserChild`) DECLINE — a wrong answer if run
  // across all origins at once.
  if (!bodyScopesPerOrigin(body, ctx.params)) return null;
  const rows = childRows(body, nests ? nestRowOrigin(rel, fresh) : rel, framing.elem, labels, bodyCtx, fresh, true, ctx.needsFromV ?? false);
  if (!rows) return null;
  // DROP origin — flatMap flattens, so the host a row descended from is internal and must not ride into
  // a downstream whole-row `dedup`/merge. Everything else (payload + carried channels) rides through.
  // An ENCLOSING origin is not this host's to shed (nor to re-rank by — the enclosing host does that); a
  // NESTED one is, which hands the stream back to the enclosing scope.
  const shed = enclosed && !nests ? rows.rel : dropOrigin(originMajor(rows.rel, body, ctx.params, fresh), fresh);
  // `local` carries the body's outbound labels to parent scope (the full-traverser forward); plain
  // `flatMap` sheds the body-bound alias CHANNELS (`shedBodyAliases`) and continues with the pre-body map
  // only — so the channel never rides into a downstream `dedup`/merge as a spurious distinguishing column,
  // and a downstream read of a body-bound label is the correct empty result.
  const out = step.name === 'local' ? rows.aliases : labels;
  const rejoined = step.name === 'local' ? shed : shedBodyAliases(shed, labels, fresh);
  return continueAs(rejoined, rows.framing, steps, at + 1, bulked, ctx, fresh, out);
}

/**
 * A PER-TRAVERSER BODY'S RESULTS IN THE HOST'S ORDER — start-major, then the body's own order within one
 * start. `FlatMapStep`/`LocalStep` take ONE start, emit every result of its body, then take the next
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52`,
 * `…/step/branch/LocalStep.java:80-88`), so a global `order()` in the body sorts ONE start's results. Inside
 * the body that order is minted over every origin at once — exact WITHIN an origin, but it interleaves the
 * starts, and `g.V().flatMap(out().order().by('name')).values('name').fold()` answered the six names sorted
 * where the reference keeps marko's three ahead of josh's two. The origin is numbered in arrival order
 * (`mintRowOrigin`), so re-ranking by `(origin, encounter)` restores the host's order. Only a body holding a
 * step that re-mints the position over the whole stream (a global `order()`, a branch merge) can interleave
 * starts; any other body keeps the origin-major position its movements already numbered.
 */
function originMajor(rel: Rel, body: readonly IRStep[], params: ParamEnv, fresh: Minter): Rel {
  const origin = originOf(rel.channels), enc = encounterOf(rel.channels);
  if (!origin || !enc) return rel;
  if (!someStepDeep(body, params, (s) => (s.name === 'order' && !isLocalScope(s as IRStep)) || BATCHING_BRANCHES.has(s.name), true)) return rel;
  const cols = [...payloadCols(rel), ...carriedCols(rel.channels)];
  return renumber(rel, [{ expr: col(rel.id, origin.col), dir: 'asc' }, { expr: col(rel.id, enc.col), dir: 'asc' }], cols, rel.channels, fresh);
}
