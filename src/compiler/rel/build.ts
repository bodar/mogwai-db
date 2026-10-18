import { stringifyExact } from '../../json-exact.ts';
import { CARRIER_BANDS, INEXACT_DECIMAL, outsideExactDecimal } from '../../rel/exact-decimal.ts';
import { deferralExpr } from '../../rel/raise.ts';
import type { Channel, ChannelRole, Channels } from '../../channels.ts';
import { col, compilerInt, compilerNull, compilerReal, compilerText, param, type BinaryOp, type Expr } from '../../rel/expr.ts';
import { inferredVtype, SAFE_INT } from './reducer.ts';
import { MERGED_VTYPE, perRowColumnOf, staticTypeOf, type ScalarType } from '../../sql/kernel/render.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { relId, type ColMeta, type RelId, type RelType, type SortTerm, type SqlType, type WindowSpec } from '../../rel/types.ts';
import type { Arg } from '../../gremlin/frontend.ts';
import type { RootedRead } from './child.ts';
import { containsSelfRef, exprHasSubquery, freeRelIds } from '../../rel/walk.ts';

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
 * What belongs here is what more than one module must AGREE on. What stays in the fold is what only it
 * has an opinion about — the element column sets here, and, since the fold became the `lower/` module,
 * the channel lists a chain threads (`lower/chain.ts`) and the hop table (`lower/movement.ts`). Those
 * two moved out of the single `lower.ts` when it was split into `lower/{chain,movement,slice,filter,
 * reduction,branch}.ts` + the `lower.ts` fold core: once several files in the family needed the channel
 * vocabulary, it stopped being "what only lower.ts has an opinion about" and became the family's shared
 * leaf. The DAG rule still holds at the family boundary (`build ◂ {predicate, modulator} ◂ lower/*`);
 * within the `lower/` family the mutually recursive fold uses function-level import cycles by design.
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
  // The current repeat depth exists on every row while the walk carries it.
  loops: { type: 'int', nullable: false },
  bulk: { type: 'int', nullable: false },
  encounter: { type: 'int', nullable: false },
  origin: { type: 'int', nullable: false },
  fromV: { type: 'int', nullable: true },
  // The graph a bound element came from — the federate call's own graph name (or the `$local` sentinel
  // for the base graph). A TEXT tag, present on every row of a multi-graph merge.
  graph: { type: 'text', nullable: false },
};

/** The carried channels' COLUMNS, in the channel list's own order — every relation that carries
 *  state declares these after its payload, and the order IS `ROLE_ORDER` (`src/channels.ts`). */
export const carriedCols = (channels: Channels): readonly ColMeta[] =>
  channels.map((channel) => meta(channel.col, CHANNEL_COL[channel.role].type, CHANNEL_COL[channel.role].nullable));

/** An element traverser's rowid followed by every carried channel, in canonical channel order. */
export const elementCols = (channels: Channels): readonly ColMeta[] =>
  [meta('id', 'int'), ...carriedCols(channels)];

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

/** A member descriptor: the columns a collection explode mints — the member VALUE, its ORDINAL
 *  (`json_each.key`, a total order only within one row), and, for a heterogeneous collection, its
 *  stored member TYPE. `list.ts`'s `MEMBER` and `map.ts`'s `PAIR` are the two instances. */
export interface MemberAs { readonly value: string; readonly ord: string; readonly type?: string; }

/**
 * EXPLODE a collection column into a member stream, and PROJECT the members back carrying every channel
 * through plus the ordinal — the two byte-identical halves the whole unfold family (`unfoldMembers`'s
 * mixed/elem/typed arms, `unfoldNested`, `unfoldMapMembers`, and `map.ts`'s `unfoldMap`) spelled by
 * hand, differing only in the payload column(s) and their expressions.
 *
 * `make.explode` over `col(rel.id, column)` binding `as` is the identical part (only the fresh tag
 * varied). `project(payload)` lands the caller's payload columns, then carries the channels read OFF THE
 * EXPLODE (not `rel` — the members are its rows) and passes the ordinal, which is what `withPayload`
 * cannot do (it reads channels off its input and adds no passthrough). The ordinal is emission order the
 * caller re-mints, since `json_each.key` totally orders only within one row.
 */
export function explodeMembers(
  rel: Rel, column: string, as: MemberAs, fresh: Minter,
): { readonly exploded: Rel; readonly project: (payload: readonly (readonly [string, Expr])[], cols: readonly ColMeta[]) => Rel } {
  const memberCols: ColMeta[] = [meta(as.value, 'any', true), meta(as.ord, 'int'), ...(as.type ? [meta(as.type, 'text', true)] : [])];
  const exploded = make.explode({
    id: fresh('ex'), input: rel, expr: col(rel.id, column), channels: rel.channels, as,
    type: typeOf(...rel.type.cols, ...memberCols),
  });
  const project = (payload: readonly (readonly [string, Expr])[], cols: readonly ColMeta[]): Rel => make.project({
    id: fresh('em'), input: exploded, channels: rel.channels,
    type: typeOf(...cols, ...carriedCols(rel.channels), meta(as.ord, 'int')),
    exprs: [...payload,
      ...rel.channels.map((channel) => [channel.col, col(exploded.id, channel.col)] as const),
      [as.ord, col(exploded.id, as.ord)]],
  });
  return { exploded, project };
}

/**
 * A FENCE in front of a `json_each` reader, and it is a legality wall rather than a bind-budget hint.
 *
 * `json_each(<collection>)` is a FROM-clause reader, and SQL has no way to name a select alias there —
 * so fused into the block that COMPUTES the collection it re-inlines the whole expression. Where that
 * expression is an aggregate (a `fold()`, a `group()`'s pairs array) SQLite refuses it inside a
 * table-valued function argument outright (`misuse of aggregate function json_group_array()`): a THROW,
 * at a position where the traversal should yield an answer. The block model already tracks the
 * symmetric fact for windows (`windowed`); this is the same rule one node earlier.
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
 *   right, which is what makes a byte-level comparison the only instrument that sees it.
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

/**
 * A projection whose COMPUTED value a presence filter will read (`value IS NOT NULL` — presence is value
 * nullness, `ChildValue.present`), FENCED where the value is a correlated read and the relation is
 * self-contained — the assembler otherwise re-inlines the column as the expression that computes it, and
 * the filter would spell the whole read a second time. Not over a correlated or recursive input, where a
 * fence would hoist to a CTE that cannot see the outer row (`freeRelIds`) or the walk (`containsSelfRef`).
 */
export const presenceFenced = (rel: Rel, value: Expr, fresh: Minter): Rel =>
  (exprHasSubquery(value) && freeRelIds(rel).size === 0 && !containsSelfRef(rel) ? fenced(rel, fresh) : rel);

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

/** The columns `GraphSource.valueMapPairs` yields — one row per property KEY of the element: the key
 *  name, the ordered ARRAY of its `{t,v}` value nodes, and a per-key emission ordinal. `elementValueMap`
 *  (map.ts) reads these to build the `valueMap`/`elementMap` entries, so the physical read (base tables
 *  vs the landed `{t,v}` tree) lives in the source while the map/flat/token shaping stays in one place. */
export const VALUEMAP_PAIR = { key: 'vmk', values: 'vmv', ord: 'vmo' } as const;

/** `json(x)` / `COALESCE(…)`, as expressions rather than as three transcriptions. Every payload
 *  projection needs both — a JSON value crossing a subquery boundary loses SQLite's json subtype, and
 *  every aggregate over zero rows is NULL. */
export const jsonOf = (arg: Expr): Expr => ({ kind: 'call', fn: 'json', args: [arg] });
export const coalesce = (...args: readonly Expr[]): Expr => ({ kind: 'call', fn: 'COALESCE', args });

/** `json_extract(e, '<path>')` — a compiler-authored path constant (never a bind). The one builder for
 *  the call so the shape is not re-transcribed per file; `jsonField` is the common `$.<field>` case. */
export const jsonExtract = (e: Expr, path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [e, compilerText(path)] });
export const jsonField = (node: Expr, field: string): Expr => jsonExtract(node, `$.${field}`);

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
 * This is the ONE place the wire row order is decided, and the cost of its absence was measured:
 * every root that dropped the carried columns from its projection — correctly, they
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
 * `lop` and `ripple` (no `age` at all) where the reference keeps them. It went unseen
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
 *
 * `ordCol`, when given (a SET whose ORDER is meaningful — the value-resume seed, where the array index
 * IS the traverser's stream position), also binds `json_each.key` under that name, so a caller can thread
 * it as an encounter channel and preserve stream order across a later re-explode (`unfold()`). Mutually
 * exclusive with `jsonTypes` (a membership set has no meaningful order) — the resume path never uses both.
 */
export function jsonEachSet(name: string, value: readonly unknown[], fresh: Minter, jsonTypes?: readonly string[], ordCol?: string): Rel {
  const source: Expr = { kind: 'call', fn: 'jsonb', args: [param(stringifyExact(value), name)] };
  const exploded = make.explode(jsonTypes
    ? { id: fresh('jes'), channels: [], expr: source, as: { value: 'sv', type: 'st' }, type: typeOf(meta('sv', 'any', true), meta('st', 'text', true)) }
    : ordCol
      ? { id: fresh('jes'), channels: [], expr: source, as: { value: 'sv', ord: ordCol }, type: typeOf(meta('sv', 'any', true), meta(ordCol, 'int')) }
      : { id: fresh('jes'), channels: [], expr: source, as: { value: 'sv' }, type: typeOf(meta('sv', 'any', true)) });
  if (!jsonTypes) return exploded;
  const kept = make.filter({
    id: fresh('jesf'), input: exploded, channels: [], type: exploded.type,
    pred: { kind: 'in-list', expr: col(exploded.id, 'st'), values: jsonTypes.map(compilerText) },
  });
  return make.project({ id: fresh('jesp'), input: kept, channels: [], type: typeOf(meta('sv', 'any', true)), exprs: [['sv', col(kept.id, 'sv')]] });
}

/**
 * `body(values…)` with each value SPELLED ONCE — SQL has no LET, and a fused projection re-inlines a named
 * column at every read, so an expression that reads an operand five times (a class test over a correlated
 * read) would spell that read five times. The operands ride as one JSON array through a one-row
 * `json_each`, and the body reads each back by position (`json_extract(value, '$[i]')`): a scalar
 * subquery correlated to the row, which a recursive term may hold as well (it names no relation).
 *
 * ⚠️ JSON carries a REAL to 15 significant digits, so the body may read only what survives that — a
 * value's storage class, its sign, its magnitude against a bound — never its exact digits.
 */
export function letValues(values: readonly Expr[], body: (read: readonly Expr[]) => Expr, fresh: Minter): Expr {
  const exploded = make.explode({
    id: fresh('let'), channels: [], type: typeOf(meta('lv', 'any', true)), as: { value: 'lv' },
    expr: { kind: 'call', fn: 'json_array', args: [{ kind: 'call', fn: 'json_array', args: [...values] }] },
  });
  const read = values.map((_, i): Expr => ({ kind: 'call', fn: 'json_extract', args: [col(exploded.id, 'lv'), compilerText(`$[${i}]`)] }));
  return { kind: 'scalar', plan: make.project({ id: fresh('letp'), input: exploded, channels: [], type: typeOf(meta('lr', 'any', true)), exprs: [['lr', body(read)]] }) };
}

/** The json_each `type` names for a JSON number and a JSON string — a `V()`/`E()` id list routes the
 *  first to the rowid column and the second to `uid`, exactly the asymmetry the inline id path draws. */
export const JSON_NUMERIC_TYPES = ['integer', 'real'] as const;
export const JSON_TEXT_TYPES = ['text'] as const;

/**
 * A PROPERTY-KEY ARGUMENT LIST — `properties(k…)` / `values(k…)` / `valueMap(k…)` / `elementMap(k…)`'s key
 * positions — or `null` to decline an argument that is neither a string nor a null.
 *
 * TinkerPop's one rule is `element.properties(keys)`: NO keys means EVERY key, several mean MEMBERSHIP,
 * and a NULL key never matches anything. So a null is INERT beside a real key — `Properties.feature:91`
 * pins `values('name','age',null)` as names AND ages — but it is NOT the same as ABSENT. `values(null)`
 * asks for a set of one key that no property has, i.e. the EMPTY result, and collapsing it to "no keys"
 * would answer *every property* to a traversal that asks for none. **`all` is the flag that keeps those
 * two apart**, and it is the whole reason this is one authority rather than a `filter` at each site: four
 * call sites each spelled `keys.length ? membership : every`, which is right for three of the four
 * inputs and silently wrong for the fourth.
 */
export const propertyKeyArgs = (
  args: readonly unknown[],
): { readonly keys: readonly string[]; readonly all: boolean } | null => {
  const keys = args.filter((a): a is string => typeof a === 'string');
  if (keys.length + args.filter((a) => a === null).length !== args.length) return null;
  return { keys, all: args.length === 0 };
};

/** The key filter for a property scan, from `propertyKeyArgs`' answer: `undefined` where EVERY key
 *  qualifies, an `InList` for a membership set, and NEVER for a legal-but-empty set — which an `InList`
 *  cannot spell, since SQLite rejects `IN ()`. `keys` bounded by the QUERY TEXT is what makes the list
 *  right here rather than the single-JSON-bind rule (that rule is about DATA-sized sets). */
export const keyMembership = (key: Expr, keys: readonly string[] | null): Expr | undefined =>
  keys === null ? undefined
    : keys.length ? { kind: 'in-list', expr: key, values: keys.map(compilerText) }
      : { kind: 'binary', op: '=', left: compilerInt(1), right: compilerInt(0) };

/**
 * A LABEL argument set — `hasLabel(l…)`, `out(l…)`, the label half of `has(label, k, v)` — or `null` to
 * decline a non-label argument.
 *
 * `propertyKeyArgs`' twin, and the same rule for the same reason: a NULL label never matches anything, so
 * it is INERT beside a real label (`hasLabel(null, 'person')` IS `hasLabel('person')`) while an ALL-NULL
 * set matches NOTHING. `given` is whether the chain wrote any argument at all, which is what separates
 * "no labels named, so every label qualifies" (`out()`) from "labels named, none of which can match"
 * (`out(null)`) — the same distinction `propertyKeyArgs.all` draws, and the one a plain `filter(nonNull)`
 * silently loses.
 */
export const labelSetArgs = (
  args: readonly Arg[],
): { readonly labels: readonly Arg[]; readonly given: boolean } | null => {
  const labels = args.filter((a) => a.value !== null);
  return labelArgsAllStrings(labels) ? { labels, given: args.length > 0 } : null;
};

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

/** VTYPE tags that denote a binary64 — SQLite's JSON WRITER serializes these at 15 significant digits
 *  and cannot round-trip one that needs 16-17 (a mean, a `math()` quotient). Both the Gremlin classes
 *  and SQLite's own `real` (what `typeof` reports for a computed reducer) are here. */
const FLOATING_VTYPES: readonly string[] = ['float', 'double', 'real'];
/** `FLOATING_VTYPES` plus `bigdecimal` — every tag whose value MAY be a binary64 REAL. A BigDecimal rides as
 *  decimal TEXT, an INTEGER (scale 0), or the REAL whose `BigDecimal.valueOf` it IS (a whole Double widened at
 *  or past 10^7, `doubleDecimalText` in `rel/float.ts`; read by `bigDecimalOfCarrier`, `src/gremlin/float.ts`).
 *  That REAL crosses SQLite's 15-digit JSON writer like any Double — `json_array(1.0000000000000002E20)` is
 *  `[1.0e+20]`, which reads back as `1.0E20`, another BigDecimal — so it takes `asExactReal` too, which
 *  re-spells a REAL only and leaves the TEXT and INTEGER carriers as they are. */
const REAL_CARRYING_VTYPES: readonly string[] = [...FLOATING_VTYPES, 'bigdecimal'];
/** VTYPE tags whose value can exceed 2^53 — a JS reader's `JSON.parse` ROUNDS an integer past that, so
 *  it must ride as decimal TEXT and be reconstructed via `BigInt` (`frameValue`'s long/bigint arm).
 *  `int`/`short`/`byte` are ≤2^31 and safe; `integer` is SQLite's class for a computed reducer. */
const WIDE_INT_VTYPES: readonly string[] = ['long', 'bigint', 'integer'];

const jsonCall = (value: Expr): Expr => ({ kind: 'call', fn: 'json', args: [value] });
const printf = (fmt: string, value: Expr): Expr => ({ kind: 'call', fn: 'printf', args: [compilerText(fmt), value] });
/** A binary64 as a 17-digit JSON NUMBER — 17 digits round-trip binary64 exactly, and the reader parses
 *  it straight back. Lossy-ONLY: a value already exact at 15 (`0.2`) stays itself rather than becoming
 *  `0.20000000000000001`. `json(...)` keeps the printed text a JSON number rather than a string.
 *
 *  A NULL PASSES THROUGH, and the test is the INEQUALITY to make that so without spelling the value again: a
 *  NULL makes the comparison NULL, which a CASE reads as "no arm", so the ELSE must be the value itself —
 *  with the repair as the ELSE, `printf('%!.17g', NULL)` printed `0.0`, and every productive null tagged
 *  as a binary64 (a `mean()` over an all-null stream: `MeanGlobalStep` seeds null and `getFinal` keeps it,
 *  `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:50-58,80-84`)
 *  entered a map or list as `0.0`. */
const isReal = (value: Expr): Expr => ({ kind: 'binary', op: '=', left: { kind: 'call', fn: 'typeof', args: [value] }, right: compilerText('real') });
/** What a REAL OUTSIDE the exact range becomes where it enters a JSON text (`exact-decimal.ts`). A text SQL
 *  may READ AGAIN (a fold, a map, a history entry) has no decimal spelling that is the value, so the member
 *  DEFERS — the default, `undefined`. A text only the framer reads (an element's property bag, `element.ts`)
 *  passes the WIRE CARRIER (`binary64Carrier`), which spells the value exactly for the wire alone. */
export type OutOfRangeCarrier = ((x: Expr) => Expr) | undefined;

/**
 * THE WIRE CARRIER — a REAL outside the exact range as the JSON string `<w>p<n>` (`x = w × 2^n`), which
 * `binary64OfCarrier` (`rel/exact-decimal.ts`) reads back bit for bit. ONE multiplication by a power of two
 * (exact: it only moves the exponent, and `w` stays normal) lands `w` inside the range, where
 * `printf('%!.17g')` is exact; the three bands and why each fits are `CARRIER_BANDS`'. The band tests need not
 * be exact — any boundary inside the bands' overlap is correct — so they are spelled as in-range decimals.
 * A `CASE` rather than a correlated walk, so the payload stays one plain expression (no `WITH RECURSIVE`
 * inside every element payload, which the walk-shape assertions and the statement-size ratchet both read).
 */
export const binary64Carrier = (x: Expr): Expr => {
  const bin = (op: BinaryOp, left: Expr, right: Expr): Expr => ({ kind: 'binary', op, left, right });
  const magnitude: Expr = { kind: 'call', fn: 'abs', args: [x] };
  const spelled = (n: number): Expr =>
    bin('||', printf('%!.17g', bin('*', x, compilerReal(2 ** -n))), compilerText(`p${n}`));
  return {
    kind: 'case',
    whens: [
      [bin('>', magnitude, compilerReal(1)), spelled(CARRIER_BANDS.large)],
      // |x| ≥ 1e-190, tested as |x|·1e110 ≥ 1e-80 so both decimals sit inside the range.
      [bin('>=', bin('*', magnitude, compilerReal(1e110)), compilerReal(1e-80)), spelled(CARRIER_BANDS.small)],
    ],
    else: spelled(CARRIER_BANDS.tiny),
  };
};


const asExactReal = (value: Expr, realOnly = true, carry: OutOfRangeCarrier = undefined): Expr => {
  // Re-spelled where the 15-digit form does not round-trip — and, `realOnly`, only where the value IS a REAL:
  // a tag that admits a non-REAL carrier (a BigDecimal's decimal TEXT `12.50`) would otherwise have the test
  // read the text as a number and re-spell it `12.5`, losing the scale it carries. A Double/Float tag's value
  // is numeric storage, so its STATIC entry skips the storage-class test (no bytes where it cannot matter).
  const outside: Expr = realOnly ? { kind: 'binary', op: 'and', left: isReal(value), right: outsideExactDecimal(value) } : outsideExactDecimal(value);
  const lossy: Expr = { kind: 'binary', op: '!=', left: { kind: 'cast', arg: printf('%.15g', value), to: 'real' }, right: value };
  return {
    kind: 'case',
    whens: [
      // OUTSIDE the range SQLite's decimal conversion is exact in (`exact-decimal.ts`), no spelling it writes is
      // known to be the value — `printf('%!.17g')` is off by ulps, the 15-digit writer is right only where 15
      // digits suffice, and the `lossy` test that would say so is itself wrong there — and SQLite's own reader
      // misreads the text even where it is right. So the member DEFERS rather than enter as another number.
      // A WIRE text carries it exactly instead (`binary64Carrier`): nothing in SQL reads it back.
      [outside, carry ? carry(value) : deferralExpr(INEXACT_DECIMAL, { kind: 'call', fn: 'random', args: [] })],
      [realOnly ? { kind: 'binary', op: 'and', left: isReal(value), right: lossy } : lossy, jsonCall(printf('%!.17g', value))],
    ],
    // A WHOLE Double the store keeps as INTEGER (a stored `1.0` weight under 'double') is spelled as the REAL
    // it is, so it writes `1.0` exactly as a computed `1.0` does. Every JSON TEXT that is compared — a
    // label's history entry (`dedup('a')`), a map key node (`groupCount()`) — is then one text for one
    // Double: `Double.equals(1.0, 1.0)` (DedupGlobalStep.java:80-88, a HashMap key). `CAST(NULL)` is NULL.
    // Only where the value IS a binary64 (`realOnly` false): a BigDecimal's INTEGER/TEXT carrier and an
    // untagged INTEGER (an Int) stay themselves.
    else: realOnly ? value : { kind: 'cast', arg: value, to: 'real' },
  };
};
/** A wide integer as decimal TEXT past 2^53, reconstructed via `BigInt` at the wire; smaller values
 *  stay numbers. The same `SAFE_INT` boundary `sumTower` uses, so the two cannot disagree. */
const asExactWideInt = (value: Expr): Expr => ({
  kind: 'case',
  whens: [[{ kind: 'binary', op: '>', left: { kind: 'call', fn: 'abs', args: [value] }, right: compilerInt(SAFE_INT) }, { kind: 'cast', arg: value, to: 'text' }]],
  else: value,
});
const inList = (vtype: Expr, tags: readonly string[]): Expr => ({ kind: 'in-list', expr: vtype, values: tags.map(compilerText) });

/**
 * THE SOLE JSON-ENTRY for a stored or computed scalar — how a value crosses INTO a
 * `json_object`/`json_array`/`json_group_array` losslessly, in ONE `CASE` so the subject is spelled
 * once per arm rather than nested. It settles the THREE ways SQLite's JSON channel would otherwise
 * corrupt a value:
 *
 * 1. a stored COLLECTION rides as embedded JSON, not a JSON string (`storedValueOn`'s job, folded in
 *    here so a `{t,v}` member does not nest two CASEs);
 * 2. a binary64 REAL rides as a 17-digit JSON number — SQLite's writer serializes at 15 significant
 *    digits and cannot round-trip a `1/3` or a `math()` quotient (`asExactReal`);
 * 3. an INTEGER past 2^53 rides as decimal TEXT — a JS reader's `JSON.parse` rounds it (`asExactWideInt`).
 *
 * Gated on the TYPE TAG, never `typeof(value)`: the value may be a correlated subquery this would
 * splice (§12 trap 2). A COMPILE-TIME tag folds to a single arm, so a node that knows it is a
 * string/int/element carries NO `CASE` — the repair reaches exactly the members that can lose a bit,
 * at any nesting depth. It is NOT `storedValueOn` itself, which also feeds the ROW path where a
 * `json(printf(...))` becomes text a later `fold()` re-quotes (§12 trap 1); this lives at the entries.
 */
export const jsonMember = (value: Expr, vtype: Expr, carry: OutOfRangeCarrier = undefined): Expr => {
  if (literalCollection(vtype) === true) return jsonCall(value);
  if (vtype.kind === 'lit') {
    if (vtype.source === 'compiler-text' && REAL_CARRYING_VTYPES.includes(vtype.value)) return asExactReal(value, vtype.value === 'bigdecimal', carry);
    if (vtype.source === 'compiler-text' && WIDE_INT_VTYPES.includes(vtype.value)) return asExactWideInt(value);
    return value;
  }
  return {
    kind: 'case',
    whens: [
      [inList(vtype, COLLECTION_VTYPES), jsonCall(value)],
      [binary64Under(vtype, value, false), asExactReal(value, false, carry)],
      [inList(vtype, WIDE_INT_VTYPES), asExactWideInt(value)],
    ],
    else: value,
  };
};

/**
 * `jsonMember` for a value whose type is UNKNOWN at compile time but whose expression is a materialized
 * COLUMN — an inject literal, an untyped fold member. There is no tag to gate on, so it gates on
 * `typeof(value)`, which is safe ONLY because a column is not the spliced subquery §12 trap 2 warns
 * about. It repairs a run-time REAL only — a 17-digit JSON NUMBER the reader infers back as a Double,
 * needing no tag. A wide INTEGER is deliberately NOT touched here: its exact form is decimal TEXT,
 * which a reader can only tell from a String by a `long`/`bigint` TAG, and this arm has none — so a
 * wide integer that arrived UNTYPED stays a bare number (type-correct, magnitude-inferred; the tagged
 * `jsonMember` path is where a wide integer rides as TEXT). Everything else passes through.
 */
export const jsonMemberByTypeof = (value: Expr): Expr => asExactReal(value);

/**
 * A SCALAR result COLUMN as the framer reads it, where the row may be a BigDecimal (`decimal`: the test that
 * it is one, `null` where it never is). A BigDecimal's REAL carrier is `BigDecimal.valueOf(double)`
 * (`gremlin/float.ts` `bigDecimalOfCarrier`: `1.0E7` is (10, −6), `100.0` scale 1), and a scalar row would
 * hand it to the framer as the same bare JS number an integral source's scale-0 INTEGER is. So it crosses
 * HERE, the last SQL position, as the one-member JSON array of its exact spelling (`[10000000.0]`) — through
 * `asExactReal`, the entry a list member takes, so the scalar and the member cannot disagree (an always-17-digit
 * spelling did: `math('_*1.1e300')` of 27, i.e. `2.97E301`, framed 2.9699999999999996E301 at the top level while
 * its member kept `2.97E301`, because SQLite's `printf` 17th digit is not correctly rounded that far out)
 * — which the carrier authority reads as `valueOf`; never as decimal TEXT, which it would read as
 * `new BigDecimal(text)`. Every other row is the column itself.
 */
export const scalarFramedValue = (value: Expr, decimal: Expr | null): Expr => decimal === null ? value : {
  kind: 'case',
  whens: [[{ kind: 'binary', op: 'and',
    left: { kind: 'binary', op: '=', left: { kind: 'call', fn: 'typeof', args: [value] }, right: compilerText('real') }, right: decimal },
  { kind: 'call', fn: 'json_array', args: [asExactReal(value, false)] }]],
  else: value,
};

/**
 * A SCALAR's binary64 repair alone, for a JSON entry whose other members stay as they were (a history
 * entry's `v`, read back by `json_extract`, which keeps a wide integer exact and must not see it as TEXT).
 * Gated on the TAG where there is one — a compile-time tag folds to one arm, a per-row one is read as
 * floating or not, and a NULL per-row tag ("infer") falls back to the storage class — and on the storage
 * class alone (`jsonMemberByTypeof`) for an untagged COLUMN, the one place `typeof` cannot splice a
 * subquery (§12 trap 2). An untagged expression is left as it was.
 *
 * A Float rides as a Double (`src/gremlin/float.ts`), and a BigDecimal may ride as the REAL whose `valueOf`
 * it is (`REAL_CARRYING_VTYPES`) — both take the repair.
 */
export const exactRealEntry = (value: Expr, tag: Expr | undefined): Expr => {
  if (!tag) return value.kind === 'col' ? jsonMemberByTypeof(value) : value;
  if (tag.kind === 'lit') {
    return tag.source === 'compiler-text' && REAL_CARRYING_VTYPES.includes(tag.value)
      ? asExactReal(value, tag.value === 'bigdecimal') : value;
  }
  return { kind: 'case', whens: [[binary64Under(tag, value, true), asExactReal(value, false)]], else: value };
};

/**
 * Is this value a binary64 under its PER-ROW tag — a Double/Float tag (whose whole value the store may keep
 * as INTEGER, which the entry then writes as the REAL it is), or a REAL carrier under a `bigdecimal` tag
 * (whose INTEGER/TEXT carriers are NOT a binary64: `printf('%!.17g')` would round a 17-digit INTEGER and
 * re-read `12.50` as `12.5`), or — `inferred`, for an entry whose NULL tag means "read the value" — a REAL
 * under no tag. ONE condition, so the entry's repair is spelled once rather than once per carrier — and the
 * tag ONCE in it: a per-row tag is routinely a fused class computation (a list reducer's `vt` reads its class
 * pair column twice per mention), so each mention re-inlines it. The tag looks its carrier up in a constant
 * (1 a binary64, 0 a REAL-only carrier, absent anything else); the REAL test adds to it.
 */
const BINARY64_CARRIER = JSON.stringify({ ...Object.fromEntries(FLOATING_VTYPES.map((t) => [t, 1])), bigdecimal: 0 });
const binary64Under = (tag: Expr, value: Expr, inferred: boolean): Expr => {
  const key: Expr = inferred ? { kind: 'call', fn: 'coalesce', args: [tag, compilerText('bigdecimal')] } : tag;
  const carrier: Expr = { kind: 'call', fn: 'json_extract', args: [compilerText(BINARY64_CARRIER), { kind: 'binary', op: '||', left: compilerText('$.'), right: key }] };
  return { kind: 'binary', op: '>=', left: { kind: 'binary', op: '+', left: carrier, right: isReal(value) }, right: compilerInt(1) };
};

/**
 * A self-describing `{t,v}` member node — `json_object('t', <type>, 'v', <lossless value>)`.
 *
 * The `{t,v}` encoding, expressed in the algebra's own vocabulary because it is EMISSION rather than
 * data. The value goes through `jsonMember` — the one JSON-entry authority — so a collection rides as
 * embedded JSON and a numeric value survives SQLite's lossy JSON channel, at every depth a `{t,v}` node
 * reaches.
 */
export const typedNode = (value: Expr, vtype: Expr, carry: OutOfRangeCarrier = undefined): Expr => ({
  kind: 'json-object',
  entries: [['t', vtype], ['v', jsonMember(value, vtype, carry)]],
  binary: false,
});

/**
 * `typedNode` under a PER-ROW tag that may be NULL ("infer"), for a node compared by its JSON TEXT — a
 * map key. Its `t` is the NORMALIZED class (`valueClass`), so a tagged and an untagged row of one class
 * write one key; its `v` is gated on the raw tag exactly as `typedNode`'s, spelling the class once.
 */
export const classedNode = (value: Expr, vtype: Expr): Expr => ({
  kind: 'json-object',
  entries: [['t', valueClass(vtype, value)], ['v', jsonMember(value, vtype)]],
  binary: false,
});

/**
 * `classedNode` for a value or tag that is EXPENSIVE to spell — a correlated read, which `classedNode`'s
 * class term and `jsonMember`'s per-tag `CASE` would repeat once per mention (measured, spelling the
 * full node inline took `group().by(values('name'))` from 1,700 to 5,540 statement bytes). So each is
 * evaluated ONCE, as the one row of a `VALUES` the node is projected over, and the node itself is the
 * full NORMALIZED one. The earlier one-mention spelling dropped a collection, floating or wide-integer
 * tag to "infer", and that was not neutral for a map KEY compared by its JSON text: `Integer(3)`,
 * `Long(3)` and a whole `Float`/`Double` all wrote an Int key, so
 * `g.V().groupCount().by(values('p'))` over p = 3, 3L, 3.0f, 3.0d answered `{3:1, 3:3}` where
 * `GroupCountStep` keys four classes apart (`Integer.equals(Long)` is false).
 */
export const typedNodeOnce = (value: Expr, vtype: Expr, fresh: Minter): Expr => {
  const one = make.values({ id: fresh('tno'), channels: [], type: typeOf(meta('v', 'any', true), meta('t', 'text', true)), rows: [[value, vtype]] });
  return { kind: 'scalar', plan: make.project({
    id: fresh('tnp'), input: one, channels: [], type: typeOf(meta('n', 'json', true)),
    exprs: [['n', classedNode(col(one.id, 'v'), col(one.id, 't'))]],
  }) };
};

/**
 * The DETACHED-transfer member node — `{t, v, vpid, meta}`, the `{t,v}` node plus the two facts a
 * landed subgraph needs to reconstruct a full `DetachedVertexProperty`: the property's own id (`vpid`
 * = the `vertex_properties` rowid, TinkerPop's `Property` handle) and its meta-properties (`meta`).
 *
 * Emitted ONLY on the `detached` compile path (`runForeign()`), so an ordinary read's property stays `{t,v}`.
 * `meta` rides as `json(...)` — a BLOB cannot cross the JSON transport (root `CLAUDE.md`), and a null
 * meta column becomes JSON null, which the decoder reads as no meta-properties.
 */
export const typedNodeDetached = (value: Expr, vtype: Expr, vpid: Expr, metaJson: Expr, carry: OutOfRangeCarrier): Expr => ({
  kind: 'json-object',
  entries: [['t', vtype], ['v', jsonMember(value, vtype, carry)], ['vpid', vpid], ['meta', metaJson]],
  binary: false,
});

/** The per-row tag ONE contributor writes into a met type's `MERGED_VTYPE` column — its own per-row
 *  column, its static tag as a literal, or NULL ("infer this one"). `withMergedVtype`'s cell, shared
 *  with a variant's scalar arm (`variantArm`), which re-projects onto a wider payload than `v` alone. */
export const mergedVtypeOf = (rel: Rel, type: ScalarType): Expr => {
  const existing = perRowColumnOf(type);
  const tag = staticTypeOf(type);
  return existing ? col(rel.id, existing) : tag ? compilerText(tag) : compilerNull('text');
};

/**
 * A SCALAR RELATION RE-PROJECTED ONTO THE MET TYPE's per-row column — its own per-row tag where it
 * has one, its static tag as a literal where it has one, and SQL NULL where it genuinely cannot say.
 *
 * The build half of `meetScalarTypes`, and the two are always used together: the meet says what the
 * shared type IS, this makes one contributor able to honour it. Both of its callers — the branch arm
 * merge and a named collection whose sites disagree on their member type — are the same question
 * asked of different things, which is why neither owns it.
 */
export const withMergedVtype = (rel: Rel, type: ScalarType, fresh: Minter): Rel => {
  const carried = rel.channels;
  const vtype = mergedVtypeOf(rel, type);
  return make.project({
    id: fresh('mv'), input: rel, channels: carried,
    type: typeOf(meta('v', 'any', true), meta(MERGED_VTYPE, 'text', true), ...carriedCols(carried)),
    exprs: [['v', col(rel.id, 'v')], [MERGED_VTYPE, vtype],
      ...carried.map((channel) => [channel.col, col(rel.id, channel.col)] as const)],
  });
};

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
 * A wire ARRAY under the typed tree's LIST envelope — `mapNode`'s twin for a value that is a list.
 *
 * `members` is the already-expanded wire array (`listPayloadExpr`'s output — element rowids turned into
 * payload objects, nested collections rebuilt), so this only adds the `{t:'list', v:…}` envelope the
 * framer reads. One spelling, because the `{t:'list', v:[…]}` node was inlined at four sites
 * (`map.ts`'s collecting value, `history.ts`, the group value side); a list nested in a `project()`
 * field must be the SAME node or `frameTypedNode` frames it as an untyped value.
 */
export const listNode = (members: Expr): Expr =>
  ({ kind: 'json-object', entries: [['t', compilerText('list')], ['v', members]], binary: false });

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
 * THE FIRST VALUE of a ROOTED scalar body (`__.V(2).values(k).order()`), as a correlated scalar
 * subquery — `P.resolve(traverser)` takes the operand's FIRST result (`vendor/tinkerpop/gremlin-core/
 * src/main/java/org/apache/tinkerpop/gremlin/process/traversal/P.java:328-373`, `tv.next()`), so where
 * the operand ends in `order()` the first is the ORDERED first. The read carries that emission order on
 * its `encounter` channel, but projecting only `v` lets `prune` drop the channel and with it the order,
 * so a bare `v` subquery takes a SCAN-order value. Hence ORDER BY the encounter and LIMIT 1; an
 * unordered operand has no encounter channel and yields one arbitrary-but-single row.
 *
 * Declines a body with EFFECTS (a mutation inside a read operand — no scalar arm) or a non-scalar
 * result. ONE authority for the two seams that resolve a rooted operand to its first value — the
 * predicate-operand seam (`nestedFirstValue`, `lower/reduction.ts`) and the list-member-predicate seam
 * (`list.ts`'s rooted `resolveScalar`) — which had drifted: the list copy projected `v` with no
 * order/limit, so `none(P.eq(__.V(x).values(k).order()))` took a scan-order value, the exact
 * non-determinism this rule exists to prevent.
 */
export function firstRootedValue(read: RootedRead, fresh: Minter): Expr | null {
  if (read.effects?.length || read.framing.kind !== 'scalar') return null;
  const encounter = read.rel.channels.find((channel) => channel.role === 'encounter');
  const ordered = encounter
    ? make.limit({
      id: fresh('rfl'),
      input: make.sort({ id: fresh('rfs'), input: read.rel, channels: read.rel.channels, type: read.rel.type,
        terms: [{ expr: col(read.rel.id, encounter.col), dir: 'asc' }] }),
      channels: read.rel.channels, type: read.rel.type, count: compilerInt(1),
    })
    : read.rel;
  return { kind: 'scalar', plan: make.project({
    id: fresh('rfv'), input: ordered, channels: [], type: typeOf(meta('v', 'any', true)),
    exprs: [['v', col(ordered.id, 'v')]],
  }) };
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
 * cross-joined result, whose order is the incoming position and then the element's. Here the
 * difference between the three is the `terms` argument and nothing else.
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
  const windowed = rowNumberWindow(rel, minted, rel.channels, { partitionBy: [], orderBy: terms }, fresh);
  return make.project({
    id: fresh('ro'), input: windowed, channels, type: typeOf(...cols),
    exprs: cols.map((column) => [column.name, col(windowed.id, column.name === encounter.col ? minted : column.name)] as const),
  });
}

/**
 * A BRANCH EMISSION KEY — a `bord_*` column a branch merge freezes so its result can be numbered in the
 * reference's emission order (`BranchKeys`, `lower.ts`). The keys share the `origin` ROLE's policies
 * (identical merge, empty at a barrier, never a group key — `src/channels.ts`), but they are not a
 * PARTITION: a body scoping a slice/dedup/fold/merge "per origin" must never partition by one, because a
 * frozen parent position is copied across every hop of an arm and so names the BRANCH's traverser, not the
 * body's. `originOf` skips them.
 */
export const BRANCH_KEY_PREFIX = 'bord_';
export const isBranchKey = (channel: Channel): boolean => channel.col.startsWith(BRANCH_KEY_PREFIX);

/** The PER-ORIGIN partition key a body scopes by — an `origin`-role channel that is not a branch key. */
export const originOf = (channels: Channels): Channel | undefined =>
  channels.find((channel) => channel.role === 'origin' && !isBranchKey(channel));

/**
 * THE TRAVERSER EQUALITY a merge partitions on — `Objects.equals(t, other.t)`
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/util/AbstractTraverser.java:185-188`),
 * which is TYPED: `Integer(1).equals(Double(1.0))` is false. SQLite's `PARTITION BY` compares by VALUE
 * across storage classes (INTEGER 1 = REAL 1.0), so every key term a value can sit in is widened here, ONCE,
 * for every merge and tie guard, by its storage class (`typeof`, which tells an Integer from a Double where
 * no type tag does — a per-row tag, where carried, is normalized into that class below). A zero has no
 * sign: `-0.0` and `0.0` are one key, as in SQLite (a deliberate divergence, `feature-support-matrix.md`).
 * A term declared `text`/`int`/`real`/`json`/`blob` has one storage class, so it keys as itself: a JSONB collection compares by its BYTES, which carry each member's numeric form
 * (`1` vs `1.0`) — a member type the bare encoding cannot carry is refused where the list is BUILT
 * (`listLiteralBlob`), so equal bytes are equal typed lists.
 */
export function typedEquality(rel: Rel, terms: readonly Expr[]): Expr[] {
  const declared = (term: Expr): SqlType =>
    term.kind === 'col' && term.rel === rel.id ? rel.type.cols.find((column) => column.name === term.name)?.type ?? 'any'
      // A one-column scalar subquery is that column's type.
      : term.kind === 'scalar' && term.plan.type.cols.length === 1 ? term.plan.type.cols[0]!.type : 'any';
  // A PER-ROW TAG, where the relation carries one beside its value column, names that value's class —
  // and names it better than the storage class does: a stored Double may sit as INTEGER `1` beside a
  // computed REAL `1.0` under one `double` tag. But a NULL tag means "read the value" (`perRowSubject`,
  // predicate.ts — the framer's own reading), so neither the raw tag nor `typeof` is the class: a
  // `constant(1)` tagged `int` and an `identity()` arm's untagged INTEGER 1 are ONE Integer. The class
  // term is therefore NORMALIZED — the tag in the Gremlin vocabulary (`reducedVtype`: a reducer's
  // storage-class `real` is a Double, `integer`/`text`/`null` say nothing), else the value's own
  // inference — the reading `memberClass` (list.ts) gives a list member. The tag column itself is then
  // NOT a key: it is subsumed by that class, and keying it raw split a tagged row from an untagged one.
  // A record carries one such pair per field (`f0_v`/`f0_vtype`), so the pairing is by NAME, not one column.
  const names = new Set(rel.type.cols.map((column) => column.name));
  const tagOf = new Map<string, string>();
  for (const name of names) {
    const suffix = TAG_SUFFIXES.find((s) => name.endsWith(s));
    const value = suffix && name.slice(0, -suffix.length) + 'v';
    // Only a value of UNKNOWN storage (`any`) keys by a class term at all; a declared one keeps its tag
    // as a key of its own (a `text` value under `string` and under `uuid` are two classes).
    if (value && names.has(value) && !tagOf.has(value) && declared(col(rel.id, value)) === 'any') tagOf.set(value, name);
  }
  const ownName = (term: Expr): string | undefined => term.kind === 'col' && term.rel === rel.id ? term.name : undefined;
  const keyedValues = new Set(terms.map(ownName).filter((name): name is string => !!name && tagOf.has(name)));
  const subsumedTags = new Set([...keyedValues].map((value) => tagOf.get(value)!));
  return terms.flatMap((term): Expr[] => {
    const name = ownName(term);
    if (name && subsumedTags.has(name)) return [];
    const type = declared(term);
    if (type !== 'any') return [term];
    // Only the value column a tag rides beside is described by it; any other term keys by its own class.
    const tag = name && tagOf.get(name);
    return tag ? typedKeyAs(term, valueClass(col(rel.id, tag), term)) : typedKey(term);
  });
}

/** A per-row tag column is `<p>vtype` (`MERGED_VTYPE`, a stored or merged tag) or `<p>vt` (a mixed
 *  inject's, a reducer's), and it describes the value column `<p>v` beside it. */
const TAG_SUFFIXES: readonly string[] = [MERGED_VTYPE, 'vt'];

/**
 * A VALUE'S GREMLIN CLASS from its per-row tag — the tag where it names a Gremlin type (a reducer's
 * storage-class `real` named `double`, by `reducedVtype`), else the value's own inference
 * (`inferredVtype`, the framer's). Equal for a tagged and an untagged row of one class, which is what
 * makes it a KEY: NULL never stands for "tagged".
 */
export const valueClass = (tag: Expr, value: Expr): Expr =>
  ({ kind: 'call', fn: 'coalesce', args: [reducedVtype(tag), inferredVtype(value)] });

/**
 * `typedEquality`'s key for ONE value of unknown storage class (an `any` term): the value and its
 * storage class. Two values are `Objects.equals` iff every term agrees under `IS` — the form a
 * caller that compares (a set op's membership) rather than partitions spends, through `typedSame`.
 */
export const typedKey = (term: Expr): Expr[] => typedKeyAs(term, { kind: 'call', fn: 'typeof', args: [term] });

/** `typedKey` where the caller already knows a sharper CLASS term than the storage class — a list
 *  member's own Gremlin tag, which tells a `{t:'int'}` from a `{t:'long'}` that share an INTEGER. */
export const typedKeyAs = (term: Expr, cls: Expr): Expr[] => [term, cls];

/**
 * `typedEquality`'s key for ONE value OUTSIDE a relation's own columns — a `by()` projection, a label's
 * history entry — where what is known of its class is handed in rather than read off a sibling column:
 * a STATIC Gremlin type, a PER-ROW tag (normalized by `valueClass`, so a NULL "infer" tag and a named one
 * of one class key together), or nothing (the storage class, `typedKey`). The SAME three terms a merge
 * partitions on, so a `dedup('a')` and a `group().by(select('a'))` key one value one way.
 */
export const classedKey = (term: Expr, known: { readonly static: string } | { readonly tag: Expr } | undefined): Expr[] =>
  !known ? typedKey(term)
    : 'static' in known ? typedKeyAs(term, compilerText(known.static))
      : typedKeyAs(term, valueClass(known.tag, term));

/** `a` and `b` are the same value by the reference's TYPED equality (`typedKey`), null-safe (`IS`). */
export const typedSame = (a: Expr, b: Expr): Expr => {
  const right = typedKey(b);
  return typedKey(a)
    .map((term, i): Expr => ({ kind: 'binary', op: 'is', left: term, right: right[i]! }))
    .reduce((acc, term) => ({ kind: 'binary', op: 'and', left: acc, right: term }));
};

/**
 * A `ROW_NUMBER()` WINDOW — mint one integer rank column `colName` over `(PARTITION BY … ORDER BY …)`,
 * EXTENDING the input by that column (§3.5: a `Window` may only extend, so the declared type is the
 * input's columns plus the one). The bare `row_number` window-expr was spelled out at a dozen-plus sites
 * — every per-origin slice, keyed dedup, argmax, `sample`, emission renumber, write ordinal, valuemap
 * ordinal — and ONE authority is what keeps that window shape from drifting between them; it is also the
 * substrate a per-partition top-N (`dedupOn`/`perOriginWindow`) and `renumber` build on. The FILTER
 * (`rn = 1`, a slice range) and the reprojection stay the caller's: those are genuine per-caller policy,
 * not the window.
 */
export function rowNumberWindow(
  input: Rel, colName: string, channels: Channels, spec: WindowSpec, fresh: Minter,
): Rel {
  return make.window({
    id: fresh('rn'), input, channels, type: typeOf(...input.type.cols, meta(colName, 'int')),
    specs: [[colName, { kind: 'window-expr', fn: 'row_number', args: [], spec }]],
  });
}

/** SQLite storage classes — what `typeof(…)` answers, never a Gremlin type a reader frames by. */
const STORAGE_CLASSES: readonly string[] = ['integer', 'text', 'blob', 'null'];
/**
 * THE STORED TYPE OF A NUMERIC REDUCER'S RESULT — its `vt` (`framingCols`), which is ONE of two
 * vocabularies, decided per row: `min()`/`max()` hand on the WINNING row's own Gremlin `vtype`
 * (`minMaxWinnerVt`), while `sum()`/`mean()` carry the aggregate's storage class (`typeof(…)`, or the
 * literal `'real'` that `mean` always is). Stored untyped, the value frames by its storage class, and an
 * integral Double the store keeps as INTEGER (`1.0`) comes back an Int — where the reference keeps the
 * input's type for `max`/`min` (`MaxGlobalStep`/`MinGlobalStep` return the winning `Number` itself; `Max.feature`
 * pins `d[1.0].d`) and always answers a floating point for `mean` (`MeanNumber.getFinal` is
 * `div(sum, count, true)`, forced floating point —
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:175-177`;
 * `Mean.feature:70` pins `d[1.0].d`).
 * So: a Gremlin name is kept, `real` IS a Double, and any other storage class stays untyped, which is
 * what it framed as before.
 *
 * THE ONE CROSSING from the `vt` vocabulary into a `vtype` one. Only a `result: 'number'` framing reads
 * a storage class (the wire's `sumBuffer`); every per-row `vtype` column — a stored property, a
 * `choose`'s per-branch tag, a merged branch arm (`withMergedVtype`) — is read as a Gremlin type alone,
 * so a reducer's `vt` that lands in one goes through here, or `'real'` names nothing and the Double is
 * framed by inference as an Int.
 *
 * Spelled as ONE evaluation of `vt` — `nullif(…nullif(replace(vt, 'real', 'double'), 'integer')…)` —
 * rather than a `CASE` that names it three times, because `vt` is the reducer's own correlated subquery
 * and a fused projection would run it once per mention. `replace` is exact here: no Gremlin type name
 * contains `real`, so only the storage class itself is rewritten.
 */
export const reducedVtype = (vt: Expr): Expr => STORAGE_CLASSES.reduce<Expr>(
  (inner, storageClass) => ({ kind: 'call', fn: 'nullif', args: [inner, compilerText(storageClass)] }),
  { kind: 'call', fn: 'replace', args: [vt, compilerText('real'), compilerText('double')] },
);
