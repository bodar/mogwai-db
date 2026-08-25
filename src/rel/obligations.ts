import { barrierChannels, CHANNEL_GROUP_POLICY, channelCols, groupableChannels, mergeChannels, rigidChannels, rowUniqueChannels, sameChannels, type Channels } from '../channels.ts';
import type { Rel, RelKind } from './rel.ts';
import { sameNames } from './types.ts';
import { forEachExpr, recursiveStep } from './walk.ts';

/**
 * What every node kind does to the carried CHANNELS — §3.5 of the build plan, as the table it
 * asked for rather than the prose it became.
 *
 * `Record<RelKind, …>` is the enforcement, exactly as the two policy tables in `src/channels.ts`
 * are for roles: **a new node kind fails the build until its obligation is declared here.** Without
 * it a new kind inherits no rule at all, and the defect category this guards is the largest in the
 * repo's history — 33% of diagnosed defects are a carried field dropped at a barrier, merge or
 * rejoin, which is silent at every layer above.
 *
 * Declaring is not implementing, so each obligation below is executable and `check` runs it.
 *
 * It speaks `ChannelRole`, not Gremlin: a RelIR node cannot know what a sack is (§2). That is why
 * `src/rel/` imports nothing from `src/compiler/` — the channel core is the shared vocabulary, and
 * the framing layer's `channelsOf` is the projection onto it.
 */
export type ChannelObligation<K extends RelKind> = (node: Extract<Rel, { readonly kind: K }>) => void;

const names = (node: Rel): readonly string[] => node.type.cols.map((column) => column.name);

/** Every node: a carried channel it CLAIMS must be a column it actually emits. */
const declares = (node: Rel): void => {
  const emitted = new Set(names(node));
  for (const column of channelCols(node.channels)) {
    if (!emitted.has(column)) throw new Error(`RelIR: ${node.kind} declares channel '${column}' but does not emit it`);
  }
};

/** The unary chain: same channels in, same channels out. */
const preserving = (node: Rel & { readonly input: Rel }): void => {
  if (!sameChannels(node.input.channels, node.channels)) throw new Error(`RelIR: ${node.kind} changed its carried channels`);
  declares(node);
};

/** The columns a node adds on top of its input's, in emission order. */
const extending = (node: Rel & { readonly input: Rel }, added: readonly string[]): void => {
  preserving(node);
  const expected = [...names(node.input), ...added];
  if (!sameNames(expected, names(node))) throw new Error(`RelIR: ${node.kind} output must be its input columns followed by ${added.join(', ') || 'nothing'}`);
};

/** `json_each`'s columns a caller asked for, in declaration order. `type` is the member's JSON type
 *  — the only way to tell a `{t,v}` ENVELOPE from a bare value, since `json_each` has already
 *  extracted the member and `json_type()` would error on a bare string. */
export const explodeColumns = (as: { readonly key?: string; readonly value: string; readonly ord?: string; readonly type?: string }): readonly string[] =>
  [...(as.key ? [as.key] : []), as.value, ...(as.ord ? [as.ord] : []), ...(as.type ? [as.type] : [])];

// The one classification of how a unary kind relates to its input's columns — so a new kind is placed
// once, not re-encoded in the pruner's need computation and here. (`check.ts`'s `preservingType` is a
// DIFFERENT question — declared-type identity for the kinds that mint nothing — and stays there.)

/** The columns a node ADDS on top of its input's — a Window's spec names, an Explode's member columns;
 *  empty for the purely column-preserving unary kinds (filter/sort/limit/distinct/materialize). */
export const mintedColumns = (node: Rel): readonly string[] =>
  node.kind === 'window' ? node.specs.map(([name]) => name)
    : node.kind === 'explode' ? explodeColumns(node.as)
      : [];

/** A unary kind whose output IS its input's columns, extended at most by `mintedColumns`. */
export const preservesColumns = (kind: RelKind): boolean =>
  kind === 'filter' || kind === 'sort' || kind === 'limit' || kind === 'distinct'
  || kind === 'window' || kind === 'explode' || kind === 'materialize';

/** The collecting aggregate functions — a `fold`/`cap`/group-VALUE materializes its members into a
 *  JSON array (or object), so their order is part of the answer (a collapsed traverser's members ride
 *  inside its one buffer). The reducers (`count`/`sum`/`min`/…) are absent: they observe no order. */
const COLLECTING_AGG: ReadonlySet<string> = new Set(['json_group_array', 'jsonb_group_array', 'json_group_object', 'jsonb_group_object']);

/**
 * A LINEAR collecting aggregate must ORDER its members by the emission-order `encounter` — the
 * consume-side dual of `CHANNEL_GROUP_POLICY`'s `combine` for a reduction, now a build-time law.
 *
 * A `fold`/`cap` collects the stream in TRAVERSER order (TinkerPop preserves it), so a
 * `json_group_array` over an encounter-carrying input that orders by anything else — or by nothing —
 * takes its members in SQLite's SCAN order: right by luck on a small fixture, reversed under
 * `PRAGMA reverse_unordered_selects` (`mise run test:perturbed`), and unseeable by any assertion in the
 * ladder. `analyze.ts` seeds the encounter so the input carries it; this proves the collection
 * actually CONSUMES it, turning a runtime coincidence into a checked obligation.
 *
 * SCOPED BY MEASUREMENT, not taste (probed over the whole corpus: 168 linear folds satisfy it, 0
 * violate; 15 grouped and 2067 structural are exempt and correctly so):
 *  - a GROUPED aggregate is exempt — its members pool by `origin`, a different, correct mechanism;
 *  - an input carrying NO encounter is exempt — analyze demanded no order, so there is none to consume
 *    (the demand-SIDE miss is a separate, harder question this does not answer);
 *  - a STRUCTURAL collection (element property map, valueMap, path) builds over property/label rows
 *    that carry no encounter, so it is exempt by that same rule.
 */
const collectionConsumesEncounter = (node: Extract<Rel, { readonly kind: 'aggregate' }>): void => {
  if (node.groupBy.length) return;
  const encounter = new Set(node.input.channels.filter((channel) => channel.role === 'encounter').map((channel) => channel.col));
  if (!encounter.size) return;
  for (const [, agg] of node.aggs) forEachExpr(agg, (e) => {
    if (e.kind !== 'agg' || !COLLECTING_AGG.has(e.fn)) return;
    const orderBy = e.orderBy ?? [];
    if (!(orderBy.length && orderBy.every((term) => term.expr.kind === 'col' && encounter.has(term.expr.name))))
      throw new Error(`RelIR: a linear collecting ${e.fn} over an encounter-carrying input must ORDER BY the emission-order encounter, else its members take SQLite's scan order (order-by-luck, reversed under mise run test:perturbed)`);
  });
};

export const CHANNEL_OBLIGATION: { readonly [K in RelKind]: ChannelObligation<K> } = {
  // Sources answer for themselves: nothing flows in, so the only rule is that they emit what they claim.
  scan: declares,
  values: declares,
  'self-ref': declares,
  // A Ref answers for what its binding carries; `check` proves the two agree, which is where the
  // binding is available and here it is not.
  ref: declares,

  // The only node that may DECLARE channel columns, so the rule is subset-of-output, not preservation.
  project: declares,

  filter: preserving,
  sort: preserving,
  limit: preserving,
  /**
   * Preserving, PLUS the one thing a whole-row `DISTINCT` cannot survive: a row-unique channel.
   *
   * Carrying one makes the operator inert — every row differs in that column, so nothing collapses
   * — and inert is the failure no instrument sees: same arity, same plan shape, no throw, more rows
   * than the step means. It is P3's `DISTINCT`-in-a-recursive-term defect one layer up, reachable by
   * a lowering instead of by the engine, which is why it is a checked law and not a comment.
   *
   * The ORDERED `dedup()` is the shape that proves the rule is the right one: it must keep the first
   * occurrence's position, so it is not a `Distinct` at all but a grouping by traverser identity
   * taking `MIN(encounter)` — the per-traverser reduction `CHANNEL_GROUP_POLICY` permits. A lowering
   * that reached for `Distinct` there would now fail closed instead of quietly emitting every row.
   */
  distinct: (node) => {
    preserving(node);
    const unique = rowUniqueChannels(node.channels);
    if (unique.length)
      throw new Error(`RelIR: a whole-row Distinct cannot carry the row-unique channel(s) ${unique.map((c) => `'${c.role}'`).join(', ')} — every row differs there, so the Distinct collapses nothing; group by traverser identity instead`);
  },
  materialize: preserving,
  window: (node) => extending(node, mintedColumns(node)),
  // With an input it EXTENDS (input columns then the member's); source-less it emits exactly the
  // member columns and carries nothing, so it answers for itself like any other source.
  explode: (node) => (node.input ? extending(node as Rel & { readonly input: Rel }, mintedColumns(node)) : declares(node)),

  /**
   * Reducing, and it is TWO contracts rather than one — §3.5 assumed one and left the gap open.
   *
   * A BARRIER emits a new traverser (`count`, `fold`, `group`) and cannot claim per-row state from
   * any one input row, so no channel survives. A grouping by the traverser's own IDENTITY is not
   * that: `dedup()` keeping the first occurrence, or a movement coalescing convergent walks, emits
   * one row per surviving traverser, and its channels have to come out the other side or a later
   * reducer counts the collapse away.
   *
   * **The node declares which it is, and this checks it is allowed to be.** Declaring no channels
   * is a barrier and the barrier contract applies. Declaring its input's channels is a
   * per-traverser reduction, legal only where every role has a defined answer when N rows become
   * one — `CHANNEL_GROUP_POLICY`, the third total table in the channel core. Anything else is
   * neither, and neither is what a dropped carried field looks like.
   *
   * WHICH aggregate is right for a role is Gremlin semantics and stays above this layer (`dedup`
   * takes `MIN(encounter)` because TinkerPop keeps the first occurrence, a collapse takes
   * `SUM(bulk)` because multiplicity adds). This once pattern-matched the sole `SUM(bulk)` shape it
   * had seen, and had to be widened the moment a second legitimate grouping appeared — so the rule
   * now states the policy per ROLE and checks only structure, which is what the two tables beside
   * it already do.
   */
  aggregate: (node) => {
    // A linear fold IS a barrier (the branch below returns early for it), so the emission-order
    // consume law runs FIRST, before the channel-contract branching.
    collectionConsumesEncounter(node);
    if (sameChannels(barrierChannels(node.input.channels), node.channels)) { declares(node); return; }
    if (!node.groupBy.length || !sameChannels(node.input.channels, node.channels))
      throw new Error('RelIR: Aggregate must either apply the barrier channel contract or, grouped, carry its input channels through unchanged');
    if (!groupableChannels(node.channels))
      throw new Error(`RelIR: a grouped Aggregate cannot carry the ${node.channels.filter((c) => CHANNEL_GROUP_POLICY[c.role] !== 'combine').map((c) => `'${c.role}'`).join(', ')} channel(s) — a grouping would take the value from an arbitrary member`);
    declares(node);
  },

  union: (node) => {
    const [first, ...rest] = node.inputs;
    if (!first) throw new Error('RelIR: Union requires at least two inputs');
    if (!sameChannels(mergeChannels(first.channels, rest.map((input) => input.channels), { rigid: 'peer' }), node.channels))
      throw new Error('RelIR: Union output channels must merge its inputs');
    declares(node);
  },

  join: (node) => {
    // The merge is computed only as a fallback: a peer merge of sides that disagree on a rigid
    // role fails closed itself, and that must not pre-empt the more specific rule below.
    if (!sameChannels(node.channels, node.left.channels) && !sameChannels(node.channels, node.right.channels)
      && !sameChannels(node.channels, mergeChannels(node.left.channels, [node.right.channels], { rigid: 'peer' })))
      throw new Error("RelIR: a Join's channels must be one side's or the peer merge of both");
    // An unmatched left-join row has the right side entirely NULL. A rigid role is per-traverser
    // physical state — arriving nullable it is not that state.
    if (node.join === 'left') {
      const fromLeft = new Set(channelCols(rigidChannels(node.left.channels)));
      const carried = new Set(channelCols(rigidChannels(node.channels)));
      for (const column of channelCols(rigidChannels(node.right.channels))) {
        if (!fromLeft.has(column) && carried.has(column))
          throw new Error(`RelIR: a left Join cannot carry rigid channel '${column}' from its nullable right side`);
      }
    }
    declares(node);
  },

  // The CTE header requirement, and the check that catches a body which forgot a carried column.
  recursive: (node) => {
    const step = recursiveStep(node);
    if (!sameChannels(node.seed.channels, step.channels)) throw new Error('RelIR: Recursive seed and step must carry the identical channels');
    if (!sameChannels(node.channels, node.seed.channels)) throw new Error("RelIR: a Recursive node's channels are its seed's");
    declares(node);
  },
};

/** The one cast: TypeScript cannot correlate `node.kind` with the table's per-kind parameter, and
 * the table's totality is what the correlation would have bought. */
export const checkChannels = (node: Rel): void => (CHANNEL_OBLIGATION[node.kind] as (n: Rel) => void)(node);

export type { Channels };
