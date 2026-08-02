/**
 * THE CHANNEL CORE — the neutral vocabulary for per-traverser carried state.
 *
 * It exists because two layers need the same guarantee and only one of them may speak Gremlin.
 * The guarantee is the one `LAYOUT_ROLE_POLICY`/`BARRIER_ROLE_POLICY` encode, and it is worth
 * protecting for a measured reason: **a carried field dropped at a barrier, merge or rejoin is 33%
 * of this repo's diagnosed defects**, the largest single category in its history. What makes those
 * tables work is not their content but their TOTALITY — `Record<role, policy>`, so a new role fails
 * the build until its policies are declared — and that property is what this module keeps.
 *
 * Measured, a relational IR needs exactly two things about carried state: which output columns are
 * channels and in what order, and per channel its merge policy and its barrier policy. It does not
 * need alias shape histories or path element types (`.shapes` is read only by
 * `match`/`filter`/`labelselect`/`select`/`child-shape`, and `PathState`'s `Elem` only by
 * `branch`/`movement`). So the boundary between the framing layer and the algebra is a VOCABULARY
 * boundary: this core carries no Gremlin words at all, `TraverserLayout` is this core plus the
 * role-specific detail the framing layer owns, and a RelIR node cannot know what a sack is.
 *
 * The two metadata roles (`trackFromV`, `consumedAliases`) are deliberately absent: they are never
 * physical columns, so they are not channels — they are framing-layer bookkeeping, and keeping them
 * out is what makes "a channel is a column" true without exception.
 */

/** What a carried column IS, from the algebra's point of view — never what it means to Gremlin. */
export type ChannelRole = 'alias' | 'path' | 'origin' | 'branchOrder' | 'sack' | 'fromV' | 'encounter' | 'bulk';

export interface Channel { readonly col: string; readonly role: ChannelRole; }
export type Channels = readonly Channel[];

/** What an arm merge does with one role. `metadata` is only reachable at the framing layer, where
 * a role may be something other than a column. */
export type MergePolicy = 'union' | 'pad' | 'identical' | 'metadata';
/** What a global barrier does with one role. `keep` likewise: no CHANNEL survives a barrier. */
export type BarrierPolicy = 'consumed' | 'empty' | 'drop' | 'keep';

/**
 * - `union` — the arms' values COMBINE. Only aliases: a label bound in one arm NULL-pads in the
 *   others, so a consumer of it drops that arm's traversers rather than failing.
 * - `pad` — the arms' values combine by padding to the LONGEST. Only the path: a shorter arm's
 *   path genuinely is shorter, so its trailing positions are NULL.
 * - `identical` — per-traverser physical state a fork cannot reconcile, so a same-scope merge
 *   requires every arm to agree and fails closed otherwise.
 */
export const CHANNEL_MERGE_POLICY: Readonly<Record<ChannelRole, Exclude<MergePolicy, 'metadata'>>> = {
  alias: 'union',
  path: 'pad',
  origin: 'identical',
  branchOrder: 'identical',
  sack: 'identical',
  fromV: 'identical',
  encounter: 'identical',
  bulk: 'identical',
};

/**
 * Every channel loses its COLUMN at a global barrier, and the three ways it can are a distinction
 * the framing layer needs rather than the algebra: `consumed` remembers that the role existed
 * (so a later `select` can tell "a barrier ate it" from "never bound"), `empty` leaves an empty
 * value where absence would be a different type, and `drop` is simple absence. The table stays
 * total anyway — a role added tomorrow that DOES survive a barrier must say so here, and
 * `barrierChannels` will then carry it without any other change.
 */
export const CHANNEL_BARRIER_POLICY: Readonly<Record<ChannelRole, BarrierPolicy>> = {
  alias: 'consumed',
  origin: 'empty',
  branchOrder: 'empty',
  path: 'drop',
  sack: 'drop',
  fromV: 'drop',
  encounter: 'drop',
  bulk: 'drop',
};

/** Same-scope peer arms must agree on the rigid roles; re-homed child arms cannot be compared with
 * the parent by construction, so only the forkable roles merge. A caller states which boundary it
 * is at and never picks the lenient one to make a call type-check. */
export type RigidPolicy = 'peer' | 'rehomed';

/**
 * The order carried columns are emitted in. It is an INVARIANT of a `Channels` list, not a
 * suggestion: a merge rebuilds in this order, so a producer that emits its roles in another one
 * would see a merge silently reorder its columns. The framing layer's own column accessor is the
 * tie — `test/channel-contracts.test.ts` pins the two against each other.
 */
export const ROLE_ORDER: readonly ChannelRole[] = ['alias', 'sack', 'bulk', 'origin', 'branchOrder', 'fromV', 'encounter', 'path'];

export const channelCols = (channels: Channels): readonly string[] => channels.map((channel) => channel.col);
const withRole = (channels: Channels, role: ChannelRole): Channels => channels.filter((channel) => channel.role === role);
const forkable = (role: ChannelRole): boolean => CHANNEL_MERGE_POLICY[role] !== 'identical';

/** Per-traverser physical state a fork cannot reconcile — the roles whose merge policy is
 * `identical`, derived from the table rather than listed a second time. */
export const rigidChannels = (channels: Channels): Channels => channels.filter((channel) => !forkable(channel.role));

/** What survives a global barrier: nothing, today, and the table above is why that is a derivation
 * and not an assertion. */
export const barrierChannels = (channels: Channels): Channels =>
  channels.filter((channel) => CHANNEL_BARRIER_POLICY[channel.role] === 'keep');

/**
 * The MULTIPLICITY channel — the one whose value is a count of traversers rather than a property
 * of one, and therefore the only one a grouping may combine without changing the answer.
 *
 * This is what distinguishes a BARRIER from a RE-ENCODING, and the distinction is not a detail of
 * SQL. A barrier consumes the stream and emits a NEW traverser (`count`, `fold`, `group`), so no
 * per-row state can honestly survive it. Summing `bulk` under a grouping by traverser identity
 * emits the SAME traverser multiset, run-length encoded — it reduces ROWS, not TRAVERSERS, and it
 * is how a movement keeps its frontier bounded by reachable |V| instead of by the (exponential)
 * walk count.
 *
 * `isReEncoding` states the whole condition, and every clause is load-bearing:
 *
 *  - **bulk must be the ONLY channel.** A grouping discards per-row identity, so an alias, a path
 *    position or a sack riding alongside would be silently picked from an arbitrary member of the
 *    group. At the Gremlin level that is `collapseSafe`'s "no path/as/sack/branch/order"; here it
 *    falls out of the channel list, with no second vocabulary to keep in step.
 *  - **the grouping must be non-empty.** `groupBy: []` is a whole-relation reduction: one row out,
 *    which is a new traverser however the aggregate is spelled.
 *  - **the aggregate must be exactly `SUM(bulk)` into bulk's own column.** Anything else computes
 *    something the traversers did not previously say.
 *
 * It answers the question §3.5 of the RelIR build plan left open ("bulk coalescing must KEEP
 * carrying bulk while every reducing aggregate is a barrier") as a RULE rather than an exception,
 * and it lives here rather than in `src/rel/` because it is a fact about channel ROLES.
 */
export const MULTIPLICITY_ROLE: ChannelRole = 'bulk';

export const isMultiplicityOnly = (channels: Channels): boolean =>
  channels.length === 1 && channels[0]!.role === MULTIPLICITY_ROLE;

/** A LIST EQUALITY, which is the whole tell that this decomposition is the right one: the layout
 * comparison it replaces was a `JSON.stringify` of a struct whose alias shapes it had no reason to
 * touch beyond their being in the same object. */
export const sameChannels = (left: Channels, right: Channels): boolean =>
  left.length === right.length && left.every((channel, i) => channel.col === right[i]!.col && channel.role === right[i]!.role);

const prefixOf = (short: Channels, long: Channels): boolean =>
  short.length <= long.length && short.every((channel, i) => channel.col === long[i]!.col && channel.role === long[i]!.role);

/**
 * The channel-level arm merge.
 *
 * Arms fork from a common seed, so at the COLUMN level a forkable role can only ever be extended:
 * every arm's alias columns are a prefix of the merged result's, and so are its path positions.
 * That is the whole of the merge here — which label sits at which column is the framing layer's
 * business (it remaps each arm's physical column onto the canonical one), and reproducing that
 * label algebra in the algebra would be exactly the Gremlin leak this module exists to prevent.
 */
export function mergeChannels(seed: Channels, arms: readonly Channels[], opts: { readonly rigid: RigidPolicy }): Channels {
  if (opts.rigid === 'peer') {
    const want = rigidChannels(seed);
    for (const arm of arms) {
      if (!sameChannels(rigidChannels(arm), want))
        throw new Error('branch arms disagree on carried channels (a step binding new rigid state inside an arm is not supported)');
    }
  }
  const longest = (role: ChannelRole): Channels =>
    [seed, ...arms].map((channels) => withRole(channels, role)).reduce((best, candidate) => {
      const [shorter, longer] = best.length <= candidate.length ? [best, candidate] : [candidate, best];
      if (!prefixOf(shorter, longer)) throw new Error(`branch arms disagree on the '${role}' channels they carry`);
      return longer;
    }, [] as Channels);
  return ROLE_ORDER.flatMap((role) => (forkable(role) ? longest(role) : withRole(seed, role)));
}
