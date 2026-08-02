import { barrierChannels, channelCols, isMultiplicityOnly, mergeChannels, rigidChannels, sameChannels, type Channels } from '../channels.ts';
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

/**
 * Is this `Aggregate` a MULTIPLICITY RE-ENCODING rather than a barrier? See `MULTIPLICITY_ROLE` in
 * `src/channels.ts` for why the distinction is semantic and not a spelling.
 *
 * Every clause is required. The grouping must be non-empty (`groupBy: []` is one row out, a new
 * traverser however it is spelled); the input must carry the multiplicity channel and NOTHING else
 * (a grouping discards the per-row identity any other channel belongs to); and the sole aggregate
 * must be exactly `SUM(<that column>)` written back into it.
 */
export function isReEncoding(node: Extract<Rel, { readonly kind: 'aggregate' }>): boolean {
  if (!node.groupBy.length || !isMultiplicityOnly(node.input.channels)) return false;
  const [only, ...rest] = node.aggs;
  if (!only || rest.length) return false;
  const [name, agg] = only;
  const [column] = channelCols(node.input.channels);
  return name === column && agg.kind === 'agg' && agg.fn === 'sum' && !agg.distinct && !agg.orderBy?.length
    && agg.args.length === 1 && agg.args[0]!.kind === 'col' && agg.args[0]!.rel === node.input.id && agg.args[0]!.name === column;
}

export const explodeColumns = (as: { readonly key?: string; readonly value: string; readonly ord?: string }): readonly string[] =>
  [...(as.key ? [as.key] : []), as.value, ...(as.ord ? [as.ord] : [])];

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
  explode: (node) => extending(node, explodeColumns(node.as)),

  /**
   * Reducing — with ONE exception that is not an exception, and §3.5 left it open.
   *
   * A barrier result is a NEW traverser and cannot claim per-row state from any one input row, so
   * the default is `barrierChannels`. But summing the MULTIPLICITY channel under a grouping by
   * traverser identity emits the SAME traverser multiset, run-length encoded: it reduces ROWS, not
   * TRAVERSERS. That is a re-encoding, and it must keep carrying `bulk` or a following reducer's
   * `SUM(bulk)` would count the collapse away.
   *
   * The build plan guessed this would have to be a `recognize` rewrite (§4.7) — a rule that fires
   * outside the algebra. It does not: `isReEncoding` is decidable from the node alone, so it is a
   * clause of the obligation like every other, and the totality that makes this table worth having
   * is preserved. `isMultiplicityOnly` carries the reason a grouping is legal at all — no other
   * channel may be riding, because a grouping discards the per-row identity each one belongs to.
   */
  aggregate: (node) => {
    const expected = isReEncoding(node) ? node.input.channels : barrierChannels(node.input.channels);
    if (!sameChannels(expected, node.channels))
      throw new Error(`RelIR: Aggregate must apply the ${isReEncoding(node) ? 'multiplicity re-encoding' : 'barrier'} channel contract to its input channels`);
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
