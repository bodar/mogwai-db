import { barrierChannels, CHANNEL_GROUP_POLICY, channelCols, groupableChannels, mergeChannels, rigidChannels, sameChannels, type Channels } from '../channels.ts';
import type { Rel, RelKind } from './rel.ts';
import { recursiveStep } from './walk.ts';

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
const sameNames = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((name, i) => name === right[i]);

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
  distinct: preserving,
  materialize: preserving,
  window: (node) => extending(node, node.specs.map(([name]) => name)),
  // With an input it EXTENDS (input columns then the member's); source-less it emits exactly the
  // member columns and carries nothing, so it answers for itself like any other source.
  explode: (node) => (node.input ? extending(node as Rel & { readonly input: Rel }, explodeColumns(node.as)) : declares(node)),

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
