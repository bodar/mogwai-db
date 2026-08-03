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
 * What a GROUPING does to one role — the third policy table, and the one that distinguishes a
 * BARRIER from a per-traverser REDUCTION.
 *
 * The distinction is not about SQL. A barrier consumes the stream and emits a NEW traverser
 * (`count`, `fold`, `group`), so no per-row state can honestly survive it. A grouping by the
 * traverser's own IDENTITY emits one row per surviving traverser — `dedup()` keeping the first
 * occurrence, a movement coalescing convergent walks — so the traversers are still the same kind of
 * thing and their channels have to come out the other side.
 *
 * What the CORE can say is which roles have a defined answer when N rows become one:
 *
 * - `combine` — the value is a property of the GROUP, not of a member. A multiplicity ADDS; an
 *   emission position is the earliest of them. Which aggregate is right for a given STEP is Gremlin
 *   semantics and stays above this layer (`dedup` takes `MIN(encounter)` because TinkerPop keeps the
 *   first occurrence); what this table settles is that an answer exists at all.
 * - `undefined` — the value belongs to ONE member and picking one is arbitrary. An alias binding, a
 *   path history and a sack are all per-traverser facts that a grouping would silently take from
 *   whichever row SQLite reached first. Fail closed.
 *
 * Total, like the other two: a role added tomorrow must declare whether it survives a grouping
 * before anything can group over it. That totality is the whole reason these are tables.
 *
 * NOTE this REPLACED a narrower rule (`isReEncoding`) that recognised exactly one shape — a sole
 * `SUM(bulk)` — and therefore had to be widened the moment a second legitimate grouping appeared.
 * The lesson is the one the two tables above already encode: state the POLICY per role and let the
 * obligation check structure, rather than pattern-matching the one expression you have seen.
 */
export const CHANNEL_GROUP_POLICY: Readonly<Record<ChannelRole, 'combine' | 'undefined'>> = {
  bulk: 'combine',
  encounter: 'combine',
  alias: 'undefined',
  path: 'undefined',
  origin: 'undefined',
  branchOrder: 'undefined',
  sack: 'undefined',
  fromV: 'undefined',
};

/** May a grouping carry this whole channel list through? See `CHANNEL_GROUP_POLICY`. */
export const groupableChannels = (channels: Channels): boolean =>
  channels.every((channel) => CHANNEL_GROUP_POLICY[channel.role] === 'combine');

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
