import type { Channel, ChannelRole, Channels } from '../../../channels.ts';
import type { Binding } from '../../../rel/plan.ts';
import type { AliasMap } from '../../alias.ts';
import type { IRStep } from '../../ir/strategies.ts';
import { childSteps } from '../../ir/passes.ts';
import type { GraphSource } from '../source.ts';
import type { MergePolicy } from '../../../gremlin/frontend.ts';
import type { Service } from '../../../services/spi/types.ts';
import type { Collections } from '../collection.ts';
import type { LabelRegime } from '../../../api.ts';
import type { ChainRead, Subject } from '../child.ts';

// THE SHARED VOCABULARY OF THE CHAIN FOLD — the types every tail returns, the context every tail
// threads, and the carried-channel constants the whole lowering mints and reads. It lives in its own
// leaf module (type-only imports, so no cycle with `lower.ts`) because `lower.ts` is now a family of
// files under `lower/` and every one of them needs this core. It is the channel-list vocabulary the
// `build.ts` header once said "stays in lower.ts" — true while lower.ts was one file; now the fold IS
// this directory, and the shared core sits at its root.

/** A lowered chain BEFORE naming and the budget — the relation, plus the two facts about it that are
 *  not properties of the relation itself. Every tail function returns this shape. */
export type Tail = ChainRead & {
  /**
   * DOES A ROW OF THIS RESULT STAND FOR MORE THAN ONE TRAVERSER — the fold's `bulked`, carried out to
   * the payload projection because the leaf is the last consumer of a multiplicity and the only one
   * that can still lose it.
   *
   * REQUIRED rather than optional, and that is the whole point: only the `elements` framing arm
   * projects a `bulk` column (`framed`), so a site that produced an element result and forgot to say
   * whether it collapsed would answer N traversers as one row. A required field makes that a compile
   * error instead of a silent fail-open.
   */
  readonly bulked: boolean;
  /**
   * THE STATEMENTS THIS CHAIN RUNS BEFORE ITS RESULT IS READ — a write's effects, in execution order
   * (§3.0: effects are legal only at a `Plan` binding).
   *
   * Absent for every read, which is why it is optional rather than an empty list threaded through
   * forty returns. A step that writes appends here and hands back a `Ref` to whichever binding its
   * result is, so the fold's shape does not change and a write remains one step of the same loop.
   */
  readonly effects?: readonly Binding[];
};

/** No label bound yet. One shared value, because an empty Map is the seed at every entry point. */
export const NO_ALIASES: AliasMap = new Map();

/**
 * THE PER-TRAVERSER STATE A CHILD BODY MAY READ, by the channel ROLE each step names.
 *
 * A table rather than two arms because the question is uniform: these steps do not compute anything,
 * they REFERENCE state the parent row already carries. TinkerPop's own vocabulary is the same shape —
 * `LoopsStep`/`SackStep` are both `ScalarMapStep`s whose `map` is one `traverser.x()` call.
 *
 * Roles absent here are absent on purpose: `path` and `encounter` are not scalars, and `bulk` is a
 * multiplicity the language gives no step to read.
 */
export const CARRIED_READ: Readonly<Record<string, ChannelRole>> = { sack: 'sack', loops: 'loops' };

/** The bulk channel every element source seeds: the RLE traverser count a reducer reads as
 *  `SUM(bulk)` and a movement collapse merges convergent walks on. One channel, one column, and the
 *  role vocabulary is the neutral core's — a RelIR node cannot know what a sack is. */
export const BULK: Channels = [{ col: 'bulk', role: 'bulk' }];

/**
 * The EMISSION-ORDER channel, and the second carried role this route models.
 *
 * A chain that slices has an answer depending on which rows come first; `analyzeChain` marks it
 * `demandsEncounter` and the SOURCE seeds a monotone column — but that flag is only ever the seed's
 * question, never the plan's. The channel set is a property of each RELATION, so an `order()` MINTS
 * this channel where none arrived and every reader downstream keys on its presence rather than on a
 * chain-global boolean threaded from the source.
 */
export const ENCOUNTER: Channel = { col: 'encounter', role: 'encounter' };

/**
 * THE ORIGIN CHANNEL — which HOST ROW a traverser descends from, carried through the ordinary fold.
 *
 * It is what makes a GROUP-SCOPED reduction expressible: the child rows of every group member have to
 * pool before the reducer runs, so the value side is a JOIN the grouping aggregates over rather than a
 * scalar subquery per row — and a JOIN drops the parent's payload while keeping its channels.
 */
export const ORIGIN: Channel = { col: 'origin', role: 'origin' };

export const originOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'origin');
export const encounterOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'encounter');

/**
 * THE ENTERING-VERTEX channel — the vertex a traverser was AT when it hopped onto the current edge,
 * retained so `otherV()` can return the edge's OTHER endpoint (`EdgeOtherVertexStep`, which reads the
 * nearest previous vertex out of the traverser's PATH:
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/EdgeOtherVertexStep.java`).
 *
 * It is the edge hop's INCOMING id — the same vertex `path()` history would name — so it is the correct
 * entering vertex in every composition (`outE().otherV()`, but also a branch-merged or child-body edge
 * stream whose members each carry their own incoming vertex). Minted only when an `otherV` will consume
 * it (else a live `fromV` would make a `dedup`/collapse decline — group policy `undefined`), and dropped
 * the moment `otherV` reads it, leaving a plain vertex stream. */
export const FROM_V: Channel = { col: 'fromV', role: 'fromV' };
export const fromVOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'fromV');

/** THE GRAPH CHANNEL — which graph a bound element came from, carried so a multi-graph merge keeps
 *  per-graph identity (`dedup`/`group`/`has(id)` must not collapse A's id 5 with B's id 5). Its value
 *  is the federate call's own graph name, or the `$local` sentinel for the base graph. Consulted as part
 *  of the identity key when present, and absent entirely from every single-graph query. */
export const GRAPH: Channel = { col: 'graph', role: 'graph' };
export const LOCAL_GRAPH = '$local';
export const graphOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'graph');

/** What a filter needs beyond the step and its subject: the bound parameters a nested body parses
 *  against, and whether the correlated-child form is this compile's to emit (see `Lowering`). */
export interface FilterCtx { readonly params: Record<string, any>; readonly correlatedChildren: boolean; }

/** What the ELEMENT loop needs on top of a filter's context: whether this compile asked for the
 *  movement collapse, and the rest of the settled per-compile facts. One record rather than a dozen
 *  positional arguments, because the tails are re-entered from several places and a re-entry that
 *  dropped one would silently pick a different lowering strategy. */
export interface ChainCtx extends FilterCtx {
  readonly collapse: boolean;
  readonly tracksPath: boolean;
  /** Gated labels-on-path: a `from`/`to` on a path-family step (`ChainFacts.demandsPathLabels`). When
   *  set, each path position records its `as()` LABELS so `subPath` can slice by label position. */
  readonly demandsPathLabels: boolean;
  /** Does this chain have an EMISSION ORDER at all — `analyzeChain`'s chain-global answer, threaded
   *  rather than re-derived. A step that MINTS a fresh traverser (`addV`) has to know: it seeds the
   *  position channel exactly where the source would have. */
  readonly ordered: boolean;
  /** Does a POSITIONAL slice read the emission order downstream (`ChainFacts.demandsSlice`)? A branch
   *  merge mints one deterministic fan-out order for a COLLECT/write demand, but DECLINES when a slice
   *  reads its fan-out — a slice pins the reference's traverser-major/arm-major subset, which this
   *  spine does not mint yet. Threaded, not re-derived, for the reason `ordered` is. */
  readonly sliced: boolean;
  /** How a `T.label` ENTRY renders — a set of names or one name. Decided ONLY by an explicit
   *  `with("multilabel")`/`with("singlelabel")`, since storage no longer carries a regime to inherit
   *  from (every vertex holds a set — `src/api.ts`). Settled before a compile starts. */
  readonly labelRegime: LabelRegime;
  /** THE GRAPH SOURCE this chain reads physical rows through — `BaseGraph` (SQLite tables) by default,
   *  a landed `BoundGraph` for a subgraph segment. Threaded here so every physical-access chokepoint
   *  (movement, `values`, `has`, labels, `elementScan`) reads ONE graph abstraction rather than naming
   *  a table inline. See `src/compiler/rel/source.ts`. */
  readonly source: GraphSource;
  /** The `withSideEffect(name, constant)` registry the FRONT END extracted. See `Lowering`. */
  readonly sideEffects: Map<string, any>;
  /** The merge POLICY declared with the REDUCER form of `withSideEffect`, by label. See `Lowering`. */
  readonly sideEffectPolicies: ReadonlyMap<string, MergePolicy>;
  /** The services this chain names, resolved at the DI boundary. See `Lowering.services`. */
  readonly services: ReadonlyMap<string, Service>;
  /** `withSack(seed[, Operator.x])`'s policy, or `null`. See `Lowering.sack`. */
  readonly sack: MergePolicy | null;
  /**
   * THE NAMED COLLECTIONS this chain has filled so far — `aggregate("a")` writes one, `cap("a")` reads
   * it back. The one MUTABLE field here, and deliberately so: a side effect is chain-global state
   * written at one step and read at a LATER one, which is the single thing a fold's return value
   * cannot carry. `Tail` travels backwards out of the recursion; `cap` needs to see forwards.
   */
  readonly collections: Collections;
  /**
   * Does this chain MUTATE the graph? Read once from the step list rather than discovered as the fold
   * proceeds, because the question it answers is about the WHOLE chain: a shared read node is
   * re-evaluated by every statement that names it, so a named collection in a program with effects
   * would see the graph AFTER the write.
   */
  readonly mutating: boolean;
  /** A map-entry child reads `select(Column.values)` from this correlated value cell. */
  readonly entryValue?: import('../../../rel/expr.ts').Expr;
  /**
   * Will the stream THIS scope produces be consumed by an `otherV()` in the enclosing chain? Set by
   * `elementTail` on a VALUE-producing child host (`local`/`flatMap`) when an `otherV()` follows it, so
   * the body's tail edge hop mints its entering vertex (`fromV`) even though the `otherV` is not in the
   * body's own step slice. No body inherits it by default (`inBody` clears it) — an existence gate
   * consumes its child as a boolean, and a branch arm cannot carry a uniformly-minted rigid channel — so
   * the one host that honours it (`flatMapRejoin`) re-injects it through `childRows`'s explicit parameter.
   */
  readonly needsFromV?: boolean;
}

/**
 * THE FOLD RE-ENTERED OVER A BODY rather than over the root chain, and the one thing that changes is
 * that a collapse is OFF.
 *
 * A collapse is legal at a hop only if every consumer behind it reads the multiplicity, and
 * `bulkObservedFrom` answers that by walking the `steps` to their END. For a BODY that end is not the
 * wire — the arm of a `union`, an `option()` arm, a `where()` child or a recursive term all continue
 * into an enclosing context the body cannot see. So: one named narrowing at every body re-entry.
 */
// A body does NOT inherit the enclosing chain's otherV() demand by default: an existence gate consumes
// its child as a boolean, a branch arm cannot carry a uniformly-minted rigid channel through the peer
// merge, and a recursive term cannot mint one either. So `inBody` CLEARS `needsFromV`, and the ONE value
// host that CAN honour it — `flatMapRejoin`, no peer merge — re-injects it through `childRows`'s explicit
// parameter instead of through here.
export const inBody = (ctx: ChainCtx): ChainCtx =>
  (ctx.collapse || ctx.needsFromV ? { ...ctx, collapse: false, needsFromV: false } : ctx);

/** A nested body, normalized — or `null` where normalizing it RAISES. See the call site for why a
 *  throw there is a deferral rather than a bug. */
export const bodyOf = (nested: unknown, params: Record<string, any>, sideEffects?: Map<string, any>): readonly IRStep[] | null => {
  try { return childSteps(nested, params, sideEffects); } catch { return null; }
};

/** The subject of a clause that reads an ELEMENT — a property row, a label row, an id. Named because
 *  three clause builders take it and each would otherwise re-state the narrowing in its signature. */
export type ElementSubject = Extract<Subject, { kind: 'element' }>;

/** The ELEMENT subject, or `null` — the narrowing every element-only clause opens with, spelled once
 *  so an arm states "this question is about an element" rather than repeating a `kind` test. */
export const elementSubject = (subject: Subject): ElementSubject | null =>
  subject.kind === 'element' ? subject : null;
