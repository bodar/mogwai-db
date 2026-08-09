import type { ChannelRole, Channels } from '../../channels.ts';
import { col, compilerInt, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelId, type RelType, type SortTerm, type SqlType } from '../../rel/types.ts';
import type { Arg } from '../../gremlin/frontend.ts';

/**
 * THE CONSTRUCTION LEAF every RelIR lowering module sits on — the physical schema as the algebra sees
 * it, plus the four helpers that make a node literal readable.
 *
 * All of it grew privately inside `lower.ts`, which was right while that was the only module building
 * RELATIONS: `predicate.ts` builds only expressions, so it never needed a table name or a minter.
 * `modulator.ts` does — a `by('name')` is a correlated scalar subquery over a property side-table — and
 * exporting these from `lower.ts` would make the import graph a cycle. Extracting them keeps it a DAG:
 * `build ◂ {predicate, modulator} ◂ lower ◂ spine`.
 *
 * What belongs here is what more than one module must AGREE on. What stays in `lower.ts` is what only
 * it has an opinion about — the channel lists a chain threads, the element column sets, the hop table.
 */

export const meta = (colName: string, type: SqlType, nullable = false): ColMeta => ({ name: colName, type, nullable });
export const typeOf = (...cols: readonly ColMeta[]): RelType => ({ cols });

/**
 * WHAT A CARRIED CHANNEL'S COLUMN DECLARES — a total `Record<ChannelRole, …>`, so a role this route
 * learns to carry cannot get a column type by accident.
 *
 * It exists because it was `meta(channel.col, 'int')` at NINE sites, which was true only while every
 * channel this route carried was a rowid or a counter. An alias history is a JSONB array and NULL
 * wherever the label is unbound on that row; declaring it `int NOT NULL` would have every node's
 * declared type disagree with the value it actually emits, in the one direction §3.5's obligations
 * cannot see (they check NAMES and channel membership, never storage class).
 */
const CHANNEL_COL: Readonly<Record<ChannelRole, { readonly type: SqlType; readonly nullable: boolean }>> = {
  // A JSONB history array — `jsonb_array` of tagged entries — NULL on a row where nothing bound it.
  alias: { type: 'json', nullable: true },
  // Either regime: a per-position rowid (linear) or one JSONB array (recursive). Neither is produced
  // by this route yet, and `json` is the honest declaration for the one that will come first.
  path: { type: 'json', nullable: true },
  // A per-traverser scalar of whatever the sack's seed was.
  sack: { type: 'any', nullable: true },
  bulk: { type: 'int', nullable: false },
  encounter: { type: 'int', nullable: false },
  origin: { type: 'int', nullable: false },
  branchOrder: { type: 'int', nullable: false },
  fromV: { type: 'int', nullable: true },
};

/** The carried channels' COLUMNS, in the channel list's own order — every relation that carries
 *  state declares these after its payload, and the order IS `ROLE_ORDER` (`src/channels.ts`). */
export const carriedCols = (channels: Channels): readonly ColMeta[] =>
  channels.map((channel) => meta(channel.col, CHANNEL_COL[channel.role].type, CHANNEL_COL[channel.role].nullable));

/** A relation's PAYLOAD columns: everything that is not a carried channel, in emission order. The
 *  payload-then-channels layout is an invariant of every relation this lowering builds, so a step
 *  that rebuilds a relation asks for the halves rather than re-deriving which is which. */
export const payloadCols = (rel: Rel): readonly ColMeta[] =>
  rel.type.cols.filter((column) => !rel.channels.some((channel) => channel.col === column.name));

/**
 * Replace a relation's PAYLOAD columns, keeping every carried channel exactly as it was — the shape
 * every retype into another traverser vocabulary ends with (a list's `count(local)`, a map's size, a
 * map side becoming a list).
 *
 * Here rather than beside any one vocabulary because the halves are this module's own invariant: the
 * payload columns are the caller's to name and the channel columns are never the caller's business,
 * and a projection that spelled the second half itself is one that can forget a channel.
 */
export const withPayload = (
  rel: Rel, exprs: readonly (readonly [string, Expr])[], cols: readonly ColMeta[], fresh: Minter,
): Rel => make.project({
  id: fresh('pl'), input: rel, channels: rel.channels,
  type: typeOf(...cols, ...carriedCols(rel.channels)),
  exprs: [...exprs, ...rel.channels.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
});

/**
 * A FENCE in front of a `json_each` reader, and it is a legality wall rather than a bind-budget hint.
 *
 * `json_each(<collection>)` is a FROM-clause reader, and SQL has no way to name a select alias there —
 * so fused into the block that COMPUTES the collection it re-inlines the whole expression. Where that
 * expression is an aggregate (a `fold()`, a `group()`'s pairs array) SQLite refuses it inside a
 * table-valued function argument outright (`misuse of aggregate function json_group_array()`): a THROW,
 * from a position where legacy answers. The block model already tracks the symmetric fact for windows
 * (`windowed`); this is the same rule one node earlier.
 */
/**
 * MEMBERS BACK INTO ONE JSONB ARRAY — `jsonb(COALESCE(json_group_array(<member> ORDER BY …), '[]'))`,
 * as a correlated scalar subquery.
 *
 * The one spelling, because two of its three parts are NON-DERIVABLE FACTS that were being restated at
 * every site (§12 — a non-derivable fact must not be re-implemented):
 *
 * - **`COALESCE` is not defensive.** `json_group_array` over ZERO rows is NULL, so an empty collection
 *   would come back as a null traverser value rather than as an empty one.
 * - **`json()` around the MEMBER is load-bearing**, and it is the caller's to apply because only the
 *   caller knows whether its member is an envelope: without it `json_group_array` re-encodes a `{t,v}`
 *   object as a JSON STRING, and the framer then sees the text `{"t":"int","v":27}` where a tagged 27
 *   belongs. It shows up as a wire byte diff and nothing else — the COUNT and the VALUES are already
 *   right, which is what makes a byte-level differential the only instrument that sees it.
 *
 * It had reached FOUR copies (a list's members, a group's entries, a `valueMap`'s pairs, a map side),
 * each carrying its own transcription of that warning.
 */
export const collectedArray = (member: Expr, order: readonly SortTerm[]): Expr => ({
  kind: 'call', fn: 'jsonb',
  args: [coalesce({ kind: 'agg', fn: 'json_group_array', args: [member], ...(order.length ? { orderBy: order } : {}) },
    jsonOf(compilerText('[]')))],
});

/** The same collection as a CORRELATED SCALAR — the form a caller uses when the members are a
 *  `json_each` over one traverser's value rather than rows it is already grouping. The EXPRESSION is
 *  what is shared; whether it lands in an `Aggregate` or inside a subquery is the caller's shape. */
export const collectedOf = (
  input: Rel, member: Expr, order: readonly SortTerm[], column: string, fresh: Minter,
): Expr => ({
  kind: 'scalar',
  plan: make.aggregate({
    id: fresh('ca'), input, channels: [], type: typeOf(meta(column, 'json')),
    groupBy: [], aggs: [[column, collectedArray(member, order)]],
  }),
});

export const fenced = (rel: Rel, fresh: Minter): Rel =>
  (rel.kind === 'materialize' ? rel : make.materialize({ id: fresh('fm'), input: rel, channels: rel.channels, type: rel.type }));

/** Physical columns of the two element tables, as `Scan` must declare them. `Scan` is the one node
 *  that names the physical schema (§3.3), so this list IS the algebra's view of storage. */
export const NODE_COLS = [meta('id', 'int'), meta('uid', 'text', true)];
export const EDGE_COLS = [meta('id', 'int'), meta('uid', 'text', true), meta('src', 'int'), meta('label', 'int'), meta('tgt', 'int')];

/** Relation ids, minted PER LOWERING. A module-global counter would make the emitted SQL depend on
 *  how many traversals this process had already compiled — two compiles of one query producing two
 *  different strings, which breaks every snapshot and every cache keyed on the text. */
export type Minter = (hint: string) => RelId;
export const minter = (): Minter => { let n = 0; return (hint) => relId(`${hint}${n++}`); };

/** The two element tables' property side-tables, and the column each keys its owner by. The
 *  asymmetry (`node` vs `edge`) is the physical schema's, so it lives beside the `Scan` tables. */
export const PROPERTIES = {
  vertex: { table: 'vertex_properties', owner: 'node' },
  edge: { table: 'edge_properties', owner: 'edge' },
} as const;

/** `json(x)` / `COALESCE(…)`, as expressions rather than as three transcriptions. Every payload
 *  projection needs both — a JSON value crossing a subquery boundary loses SQLite's json subtype, and
 *  every aggregate over zero rows is NULL. */
export const jsonOf = (arg: Expr): Expr => ({ kind: 'call', fn: 'json', args: [arg] });
export const coalesce = (...args: readonly Expr[]): Expr => ({ kind: 'call', fn: 'COALESCE', args });

/**
 * The EMPTY collection literals, BIND-FREE. A `Lit` renders as a bound parameter (§3.6) and the platform
 * allows a hundred of them, so a compiler-authored constant that has a function spelling takes the
 * function: `json_object()` is `{}` and `json_array()` is `[]`, at zero budget and with the json subtype
 * that a quoted `'{}'` would have to be re-parsed to get.
 */
export const EMPTY_OBJECT: Expr = { kind: 'json-object', entries: [], binary: false };
export const EMPTY_ARRAY: Expr = { kind: 'json-array', items: [], binary: false };

/**
 * THE WIRE'S ROW ORDER — a `Sort` on the carried emission-order channel, or the relation unchanged when
 * there is none.
 *
 * `rootOrder` (legacy's materializer) is the ONE place this was decided, and the comment there records
 * what its absence cost: every root that dropped the carried columns from its projection — correctly, they
 * are internal — dropped the `ORDER BY` with them, so `order().by('name').values('name')` was stable while
 * the same prefix before `.properties()` returned whatever the scan produced. Every payload projection in
 * this route therefore sorts THROUGH this one function and then projects on top: SQL lets `ORDER BY` name a
 * column the SELECT list does not, and the assembler fuses the pair into one block, so the ordering column
 * is still in the FROM where the clause reads it.
 *
 * Shared by every arm for the reason `renumber` is shared: a channel read two ways is a channel two
 * readers can disagree about.
 */
export const byEncounter = (rel: Rel, fresh: Minter): Rel => {
  const encounter = rel.channels.find((channel) => channel.role === 'encounter');
  if (!encounter) return rel;
  return make.sort({
    id: fresh('eo'), input: rel, channels: rel.channels, type: rel.type,
    terms: [{ expr: col(rel.id, encounter.col), dir: 'asc' }],
  });
};

export function and(left: Expr | undefined, right: Expr): Expr;
export function and(left: Expr, right: Expr | undefined): Expr;
export function and(left: Expr | undefined, right: Expr | undefined): Expr {
  if (!left || !right) {
    const only = left ?? right;
    if (!only) throw new Error('RelIR lowering: a conjunction of nothing');
    return only;
  }
  return { kind: 'binary', op: 'and', left, right };
}

export const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });

/** `a OR b`, and `or(undefined, b)` is `b` — `and`'s twin, so a connective folded over N arms needs no
 *  seed value and the two connectives fold the same way. */
export function or(left: Expr | undefined, right: Expr): Expr {
  return left ? { kind: 'binary', op: 'or', left, right } : right;
}

/**
 * "THIS BODY DID NOT TEST TRUE" — the NULL-SAFE negation a filter STEP owes, and it is not `NOT`.
 *
 * `NotStep.filter` is `!TraversalUtil.test(traverser, body)`, and `test` is a two-valued question:
 * the body produced output, or it did not. SQL's `NOT` is three-valued, so `NOT (<unproductive
 * projection> = 29)` is `NOT NULL` = NULL = the row is DROPPED — the exact opposite of TinkerPop's
 * answer, which passes a traverser whose body produced nothing.
 *
 * ⚠️ **MEASURED, as a wrong answer on this route.** `g.V().not(__.values('age').is(P.eq(29)))` lost
 * `lop` and `ripple` (no `age` at all) where legacy and the reference keep them. It went unseen
 * because it is per-PREDICATE: a range comparison is already total — `predicateExpr` wraps it in a
 * `typeof` guard whose ELSE is a false literal, so `gt` was right — while `eq`/`neq`/`within` compare
 * directly and go NULL. So the positive reasoning that "productivity falls out of SQL's own null
 * semantics" is TRUE for a filter and FALSE the moment it is negated, and the fix belongs at the
 * negation rather than in every predicate.
 *
 * `x IS NOT 1` and not `COALESCE(x, 0) = 0`: SQLite's `IS NOT` is the null-safe comparison, so this is
 * one node and reads as the question it asks. Every predicate this module builds is `0`/`1`/NULL —
 * an `Exists`, a comparison, or a connective over those — so testing against `1` is total.
 */
export const notProduced = (pred: Expr): Expr =>
  ({ kind: 'binary', op: 'is not', left: pred, right: compilerInt(1) });

/** `SELECT id FROM labels WHERE name IN (…)` — the name→id indirection every label-aware step
 *  reaches through, and the reason `labels` is a `Scan` table rather than a string in an emitter. */
/**
 * A collection PARAMETER exploded to a one-column relation of its members (`sv`) — the whole array
 * crosses as ONE `jsonb(?)` bind (named, so repeated uses dedup at render) and `json_each` explodes it
 * IN-QUERY, so its data never enters the statement text (root `CLAUDE.md`'s data-sized-set rule). This
 * is the shared kernel behind every "a bound collection is a set membership" site — a `within($list)`
 * predicate (`predicate.ts`), a `V($ids)` id list and a `hasLabel($labels)` name list here.
 *
 * `jsonTypes`, when given, keeps only the members whose json_each `type` is in the set — the seam a
 * `V()`/`E()` id list needs to route a JSON number to the rowid column and a JSON string to `uid`,
 * decided PER MEMBER by json_each's own type rather than at compile time (so a heterogeneous bound id
 * list is faithful without our reading its data).
 */
export function jsonEachSet(name: string, value: readonly unknown[], fresh: Minter, jsonTypes?: readonly string[]): Rel {
  const source: Expr = { kind: 'call', fn: 'jsonb', args: [param(JSON.stringify(value), name)] };
  const exploded = make.explode(jsonTypes
    ? { id: fresh('jes'), channels: [], expr: source, as: { value: 'sv', type: 'st' }, type: typeOf(meta('sv', 'any', true), meta('st', 'text', true)) }
    : { id: fresh('jes'), channels: [], expr: source, as: { value: 'sv' }, type: typeOf(meta('sv', 'any', true)) });
  if (!jsonTypes) return exploded;
  const kept = make.filter({
    id: fresh('jesf'), input: exploded, channels: [], type: exploded.type,
    pred: { kind: 'in-list', expr: col(exploded.id, 'st'), values: jsonTypes.map(compilerText) },
  });
  return make.project({ id: fresh('jesp'), input: kept, channels: [], type: typeOf(meta('sv', 'any', true)), exprs: [['sv', col(kept.id, 'sv')]] });
}

/** The json_each `type` names for a JSON number and a JSON string — a `V()`/`E()` id list routes the
 *  first to the rowid column and the second to `uid`, exactly the asymmetry the inline id path draws. */
export const JSON_NUMERIC_TYPES = ['integer', 'real'] as const;
export const JSON_TEXT_TYPES = ['text'] as const;

/** Is every `Arg` a LABEL — an inline string, a literal list of strings, a string parameter, or a bound
 *  list of strings? Callers validate before building `labelIds`, which then trusts the values are text
 *  (labels are strings by spec; a non-string label is a decline the caller owns). */
export const labelArgsAllStrings = (args: readonly Arg[]): boolean =>
  args.every((a) => (a.name == null
    ? (a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value]).every((v) => typeof v === 'string')
    : Array.isArray(a.value) ? a.value.every((v) => typeof v === 'string') : typeof a.value === 'string'));

/**
 * The `labels` rowids matching a set of label ARGUMENTS — the name filter over the `labels` table each
 * label-restricting step (`hasLabel`, `out('knows')`, `has(label, k, v)`) joins against. An inline
 * label (a parsed literal `'knows'`) INLINES as a `compilerText` name — zero binds; a label PARAMETER
 * BINDS — a scalar `$l` as one `?` on the name, a bound list `$ls` as ONE `jsonb(?)` exploded by
 * `json_each` — so a parameter's data never enters the statement text, the same rule the id and
 * `within` set paths keep. Callers pre-validate with `labelArgsAllStrings`, so every value here is text.
 */
export function labelIds(args: readonly Arg[], fresh: Minter): Rel {
  const scan = make.scan({ id: fresh('lbl'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
  const nameCol = col(scan.id, 'name');
  const inline: string[] = [];
  const clauses: Expr[] = [];
  for (const a of args) {
    if (a.name == null) {
      const members = a.members ? a.members.map((m) => m.value) : Array.isArray(a.value) ? a.value : [a.value];
      for (const v of members) inline.push(v as string);
    } else if (Array.isArray(a.value)) {
      clauses.push({ kind: 'in-query', expr: nameCol, plan: jsonEachSet(a.name, a.value, fresh), negated: false });
    } else {
      clauses.push({ kind: 'binary', op: '=', left: nameCol, right: param(a.value, a.name, 'text') });
    }
  }
  if (inline.length) clauses.unshift({ kind: 'in-list', expr: nameCol, values: inline.map(compilerText) });
  const pred = clauses.reduce<Expr | undefined>((left, right) => (left ? { kind: 'binary', op: 'or', left, right } : right), undefined);
  const matching = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: pred! });
  return make.project({ id: fresh('p'), input: matching, channels: [], type: typeOf(meta('id', 'int')), exprs: [['id', col(matching.id, 'id')]] });
}

const COLLECTION_VTYPES = ['list', 'map', 'set'] as const;

/**
 * Is this vtype a collection, decided at COMPILE time — `true`/`false` where the expression is a
 * compiler-authored literal, `null` where only the rows can say.
 *
 * Only a literal the COMPILER wrote is folded. A `source: 'bound'` literal is query data, and folding
 * on it would make the statement TEXT a function of the parameter's value — the same defect as
 * inlining data, and it defeats statement caching for the one input that exists to be varied.
 */
const literalCollection = (vtype: Expr): boolean | null => {
  if (vtype.kind !== 'lit' || vtype.source === 'bound') return null;
  // A NULL vtype is not a collection: SQL's `NULL IN (…)` is NULL, never true, so the CASE takes ELSE.
  if (vtype.value === null) return false;
  return typeof vtype.value === 'string' && (COLLECTION_VTYPES as readonly string[]).includes(vtype.value);
};

/** The storage-class recovery every stored value goes through on the way out: a JSON-typed value
 *  comes back as JSON, everything else as itself. Shared by `values()` and every other reader of a
 *  property value.
 *
 *  THE TEST IS FOLDED WHERE THE VTYPE IS A COMPILER LITERAL, and that is a bind-budget requirement
 *  rather than tidiness: the `CASE` spells `value` TWICE, so an undecided test DOUBLES a subject that
 *  is routinely a whole correlated subquery. A computed scalar's vtype is `compilerNull()`
 *  (`modulator.ts`), so the `json()` arm was dead and paid for — measured on
 *  `g.V().group().by(__.values("name").substring(0,1)).by(__.constant(1))`, whose 42 binds carried
 *  only FOUR distinct values, `"name"` fourteen times. */
export const storedValueOn = (value: Expr, vtype: Expr): Expr => {
  const collection = literalCollection(vtype);
  if (collection === true) return { kind: 'call', fn: 'json', args: [value] };
  if (collection === false) return value;
  return {
    kind: 'case',
    whens: [[{ kind: 'in-list', expr: vtype, values: COLLECTION_VTYPES.map(compilerText) },
      { kind: 'call', fn: 'json', args: [value] }]],
    else: value,
  };
};

/** The common case: the value and its type are the `value`/`vtype` COLUMNS of a property scan.
 *  Derived from the general form rather than spelled twice — the same relationship
 *  `storedCompare`/`storedCompareOn` already have, and for the same reason. */
export const storedValue = (rel: RelId): Expr => storedValueOn(col(rel, 'value'), col(rel, 'vtype'));

/**
 * A self-describing `{t,v}` member node — `json_object('t', <type>, 'v', <stored value>)`.
 *
 * The encoding `typedScalarNode` (legacy `plan.ts`) produces, re-expressed in the algebra's own
 * vocabulary because it is EMISSION rather than data. What must not diverge is the payload: a
 * collection value rides as embedded JSON, not as a JSON string, which is why it goes through
 * `storedValueOn` rather than naming the column twice.
 */
export const typedNode = (value: Expr, vtype: Expr): Expr => ({
  kind: 'json-object',
  entries: [['t', vtype], ['v', storedValueOn(value, vtype)]],
  binary: false,
});

/**
 * A PAIRS ARRAY under the typed tree's MAP envelope — `typedNode`'s twin for a value that is a map.
 *
 * It is here rather than in `record.ts` because BOTH sides of the `record ◂ modulator` DAG edge add
 * it: `fieldNode` wraps a nested record's pairs, and `byNode` wraps a map-framed child body's. One
 * spelling is what keeps a map member the same shape wherever it was produced — the framer walks
 * `{t:'map', v:[[k,v],…]}` at any depth by a single rule, and a second envelope (or a missing one)
 * frames the map as an untyped value instead.
 */
export const mapNode = (pairs: Expr): Expr =>
  ({ kind: 'json-object', entries: [['t', compilerText('map')], ['v', pairs]], binary: false });

/**
 * The FIRST row of a one-column relation, as an expression — SQL's scalar subquery.
 *
 * Every `by()` projection that reads storage is one of these, and the `ORDER BY … LIMIT 1` is not
 * defensive: a vertex-property key may hold several values and insertion order is what names the
 * first, which is the semantics TinkerPop's `PropertyValueStep` has. An edge key is `UNIQUE(edge,
 * key)` so the pick is vacuous there, and it is emitted anyway — a subquery yielding more than one
 * row without saying which it means is SQLite leniency, and leniency is what `src/cf-limits.ts` exists
 * to keep out of the emitted SQL.
 */
export function firstOf(rel: Rel, value: Expr, order: Expr, fresh: Minter): Expr {
  // PROJECT before sorting, and carry the order key as a column: both expressions are written in
  // `rel`'s scope, and after a `Limit` that scope is gone. Two projections rather than one is what
  // keeps every node's expressions readable in the relation they name — the assembler fuses all four
  // back into one `SELECT … ORDER BY … LIMIT 1`, which is §5's division of labour exactly.
  const projected = make.project({
    id: fresh('bv'), input: rel, channels: [], type: typeOf(meta('v', 'any', true), meta('k', 'any', true)),
    exprs: [['v', value], ['k', order]],
  });
  const sorted = make.sort({ id: fresh('so'), input: projected, channels: [], type: projected.type, terms: [{ expr: col(projected.id, 'k'), dir: 'asc' }] });
  const one = make.limit({ id: fresh('li'), input: sorted, channels: [], type: sorted.type, count: compilerInt(1) });
  const only = make.project({
    id: fresh('p'), input: one, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', col(one.id, 'v')]],
  });
  return { kind: 'scalar', plan: only };
}

/**
 * RENUMBER the emission order — `ROW_NUMBER()` into the `encounter` channel's own column, over
 * whatever order the caller names, leaving every other column exactly as it was.
 *
 * ONE function because every caller asks the identical question of a different order, and reading them
 * side by side is what makes that visible: a fan-out renumbers by *the incoming position* (several
 * outgoing rows share one, so the old numbers no longer number the new rows), a scalar `order()`
 * renumbers by *its own sort key* (the sort SUPERSEDES the arriving order, so a later slice must take
 * its window from the new positions and not the stale seed), and a `mergeV` numbers the
 * cross-joined result, whose order is the incoming position and then the element's. Legacy has these as three
 * hand-rolled window projections; here the difference is the `terms` argument and nothing else.
 *
 * It lives HERE rather than in `lower.ts` for this file's own stated reason: a second module (`write.ts`,
 * which mints a merge's position) has to agree with the first about what "renumber" means, and a channel
 * minted two ways is a channel two readers can disagree about.
 *
 * The last term is a TIE-BREAK, and it is the caller's to supply because only the caller knows what
 * makes its order total. Without one the rows sharing a rank are numbered in whatever order SQLite
 * produced them — right multiset, arbitrary window — which is exactly the defect
 * `mise run test:perturbed` exists to find and which no assertion in the ladder can see.
 *
 * Two nodes because `Window` may only EXTEND its input (§3.5) — it adds the new column, and the
 * projection is what makes that column the channel and drops the stale one. The assembler fuses
 * them back into one SELECT, which is the division of labour §5 describes: the IR stays normalized
 * and the emitter does the composing.
 */
export function renumber(
  rel: Rel, terms: readonly SortTerm[], cols: readonly ColMeta[], channels: Channels, fresh: Minter,
): Rel {
  const minted = 'rn';
  const encounter = channels.find((channel) => channel.role === 'encounter');
  // Renumbering a relation with nowhere to put the number is a lowering bug, not a deferral: every
  // caller checks the channel first, so reaching here means a plan was built whose declared type and
  // whose channels disagree — the class of defect the factory's own width checks catch three nodes
  // later, where the cause is no longer visible.
  if (!encounter) throw new Error('RelIR lowering: renumber() needs an encounter channel to mint into');
  // The window EXTENDS its own input (§3.5), so its declared type is the INPUT's columns plus the
  // minted one — not the output's. The two differ exactly when this is a MINT rather than a re-mint:
  // there `cols` names an emission-order column the input does not have yet, and the projection below
  // is where it comes into existence.
  const windowed = make.window({
    id: fresh('w'), input: rel, channels: rel.channels, type: typeOf(...rel.type.cols, meta(minted, 'int')),
    specs: [[minted, { kind: 'window-expr', fn: 'row_number', args: [], spec: { partitionBy: [], orderBy: terms } }]],
  });
  return make.project({
    id: fresh('ro'), input: windowed, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(windowed.id, column.name === encounter.col ? minted : column.name)] as const),
  });
}
