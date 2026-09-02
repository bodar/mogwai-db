import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import type { Rel } from '../../rel/rel.ts';
import * as make from '../../rel/factory.ts';
import { isColumnArg, isNested, isOrderArg, isTokenArg } from '../../gremlin/frontend.ts';
import { listNodeExpr } from './list.ts';
import { PER_ROW, STATIC, staticTypeOf, UNKNOWN, type ScalarType } from '../../sql/kernel/render.ts';
import type { IRStep } from '../ir/step.ts';
import { ALWAYS_PRODUCTIVE, type ChildHost, type ChildSeam } from './child.ts';
import { fieldCol, fieldNamed, framingCols, type RelFraming } from './framing.ts';
import { and, eq, firstOf, jsonField, listNode, mapNode, meta, PROPERTIES, typedNode, typeOf, type Minter } from './build.ts';
import type { GraphSource } from './source.ts';
import { storedCompareOn } from './predicate.ts';
import { aliasProjection, readFraming, type Pop } from './alias.ts';
import type { ColMeta } from '../../rel/types.ts';
import { propertyNode, propertyReadOf } from './property.ts';

/**
 * `by()` AS ONE VOCABULARY — the modulator seam.
 *
 * Chosen on FAMILY CLOSURE, not on marginal coverage, and the shape of the problem is what makes that
 * the right criterion. `if (step.modulators?.length || step.optionArms) return null` guarded six
 * handlers in `lower.ts`: that is ONE concept declined six times, and no single-step increment will
 * ever motivate fixing it — each host only ever needs its own `by()`, so each would re-derive the
 * parse, the projection and the productivity rule locally. `order`, `dedup`, `group`, `groupCount`,
 * `select`, `project`, `path` and `sack` all gain `by()` by this module existing, the same way every
 * filter position gained `P`/`TextP` by `predicate.ts` existing.
 *
 * The two rules are `predicate.ts`'s, unchanged:
 *
 * - **It never throws.** A form it cannot express returns `null` and the whole traversal is not
 *   covered (a miss the caller raises as `UnsupportedTraversal`). A throw here would turn "not learned
 *   yet" into a support regression.
 * - **It never answers a DIFFERENT question.** Every arm below reproduces the semantics exactly or
 *   declines.
 *
 * ## A `by()` is TWO things sharing a spelling
 *
 * TinkerPop's `ByModulating` conflates them, and so does the syntax; keeping them apart is what stops
 * a lowering sorting by the wrong value:
 *
 * - a **projection** — WHICH value of the traverser the host operates on: `by()` the traverser itself,
 *   `by('name')` a property, `by(T.label)` a token, `by(__.out().count())` a sub-traversal;
 * - a **comparator** — for `order()` the DIRECTION (`by(Order.desc)`), for `sack()` an `Operator`.
 *   A comparator alone leaves the projection at identity, which is why `order().by(Order.desc)` is a
 *   complete `by()` and not a malformed one.
 *
 * So one `by()` parses to a (projection, comparator) pair and each host reads the halves it has a
 * meaning for. `order()` reads both. `dedup()` reads the projection and could not accept a comparator
 * — that is `BY_MODULATOR_ARITY`'s business, upstream of here, and already checked before a chain
 * reaches any lowering.
 *
 * ## PRODUCTIVITY is part of the vocabulary, not part of each host
 *
 * TinkerPop's default `by()` DROPS a traverser it yields nothing for — `order().by('age')` over a
 * vertex with no `age` emits nothing for that vertex — and `ProductiveByStrategy` turns that off.
 * The difference is a `WHERE <key> IS NOT NULL` present or absent at each host; here it is
 * `productivityFilter`, so a host cannot forget it. A forgotten productivity filter is a wrong
 * answer with the right arity, which is the census's blind spot when the extra rows sort last.
 */

/** WHAT a `by()` projects out of the traverser. Total over the forms the algebra can state; a form it
 *  cannot (a `Column`, an `Operator`) never becomes a `ByKey` — `modulations`
 *  declines instead, so an unexpressible projection cannot reach a host as a plausible-looking one.
 *
 *  Reachable through `Modulation['key']` and not exported on its own: no host matches on the
 *  projection today (they hand it straight to `byExpr`), and an export nothing imports is a question
 *  `mise run orphans` will keep asking. Export it when a host needs to branch on it. */
type ByKey =
  | { readonly kind: 'identity' }
  | { readonly kind: 'property'; readonly key: string }
  | { readonly kind: 'token'; readonly token: TokenKey }
  | { readonly kind: 'column'; readonly column: 'keys' | 'values' }
  /** `by(__.select(label))` — an ALIAS read, not a correlated child. Spelled as a nested traversal and
   *  therefore parsed as one, but the answer is a column on the host's own row rather than a subquery
   *  over the traverser, so it is its own projection kind. Recognized HERE so every by() host gains it
   *  at once — `Scoping.getScopeValue` makes no distinction between a `select()` in a by() and one in
   *  the chain, and neither should the vocabulary. */
  | { readonly kind: 'alias'; readonly label: string; readonly pop: Pop }
  | { readonly kind: 'child'; readonly body: readonly IRStep[] };

/** One parsed `by()`. `order` is present only where the modulator named a comparator. */
export interface Modulation {
  readonly key: ByKey;
  readonly order?: 'asc' | 'desc' | 'shuffle';
}

const ORDERS = new Set(['asc', 'desc', 'shuffle']);

/** The `T` tokens that name a value a `by()` can project.
 *
 *  ⚠️ **A token is legal per HOST, not per grammar, and the split is TinkerPop's:** `T.id`/`T.label` are
 *  an ELEMENT's and `T.key`/`T.value` are a PROPERTY's, so each host's arm answers exactly its own two
 *  and DECLINES the other pair. Parsing all four here rather than one pair is what lets a property host
 *  gain them without a second parse; the decline lives where the host is known, which is the only place
 *  it can be right. */
type TokenKey = 'id' | 'label' | 'key' | 'value';
const TOKENS: Readonly<Record<string, TokenKey>> = { id: 'id', label: 'label', key: 'key', value: 'value' };

/** The two tokens a PROPERTY traverser answers — `Property.key()` and `Property.value()`. */
const PROPERTY_TOKENS = new Set<TokenKey>(['key', 'value']);

/**
 * Parse a host step's absorbed `by()` modulators, or `null` to decline.
 *
 * `max` is the host's SLOT COUNT, not an arity check — `verifyByModulatorArity` (a Pass) has already
 * raised for invalid Gremlin, so a count past `max` here means a host this module knows fewer slots
 * for than the host does, and declining is the honest answer.
 *
 * An empty result means the host was handed no `by()` at all; the host's own default applies, and the
 * distinction matters because it is not always identity — bare `dedup()` is a whole-row `Distinct`,
 * a genuinely different lowering from `dedup().by()`.
 *
 * The child seam is what a nested `by()` body is NORMALIZED through, not merely what lowers it later:
 * normalizing re-runs the Pass pipeline and can legitimately RAISE, and this module's contract is
 * `null` (§12). Calling `childSteps` directly here let that throw escape.
 */
export function modulations(step: IRStep, max: number, child: ChildSeam): readonly Modulation[] | null {
  const bys = step.modulators ?? [];
  if (bys.length > max) return null;
  const parsed: Modulation[] = [];
  for (const by of bys) {
    let key: ByKey = { kind: 'identity' };
    let projected = false;
    let order: Modulation['order'];
    for (const arg of by as readonly unknown[]) {
      if (typeof arg === 'string') {
        // A second projection in one `by()` is not a form Gremlin has; declining beats picking one.
        if (projected) return null;
        key = { kind: 'property', key: arg };
        projected = true;
        continue;
      }
      if (isOrderArg(arg)) {
        if (order !== undefined || !ORDERS.has(arg.order)) return null;
        order = arg.order as Modulation['order'];
        continue;
      }
      if (isTokenArg(arg)) {
        const token = TOKENS[arg.token.toLowerCase()];
        if (!token || projected) return null;
        key = { kind: 'token', token };
        projected = true;
        continue;
      }
      if (isColumnArg(arg)) {
        if (projected || (arg.column !== 'keys' && arg.column !== 'values')) return null;
        key = { kind: 'column', column: arg.column };
        projected = true;
        continue;
      }
      if (isNested(arg)) {
        // A second projection in one `by()` is not a form Gremlin has; declining beats picking one.
        if (projected) return null;
        const body = child.body(arg.nested, 'child');
        if (!body) return null;
        // `by(__.identity())` is a bare `by()`: both project the element itself. Normalizing it here
        // keeps every host from having to re-derive that semantic identity.
        key = body.length === 1 && body[0]?.name === 'identity'
          ? { kind: 'identity' }
          : aliasKey(body) ?? { kind: 'child', body };
        projected = true;
        continue;
      }
      // Everything else DECLINES, and the default being refusal rather than tolerance is the point.
      // A `Column`, an `Operator` or a `GType` in a `by()` belongs to a host this module does not serve at all
      // (`group`'s key/value split, `sack`'s reducer, `valueMap`'s).
      return null;
    }
    parsed.push(order === undefined ? { key } : { key, order });
  }
  return parsed;
}

/**
 * A nested body that is EXACTLY one `select(label)` — the alias projection, or `undefined` to leave it
 * a correlated child.
 *
 * Only the single-label form: a multi-label `select('a','b')` in a `by()` is a RECORD-valued projection
 * and a `select(Column.keys)` a map re-entry, both of which belong to hosts this arm does not serve.
 * They stay `child` bodies, which decline — the honest answer rather than a plausible one.
 */
function aliasKey(body: readonly IRStep[]): Extract<ByKey, { kind: 'alias' }> | undefined {
  const step = body.length === 1 ? body[0]! : undefined;
  if (!step || step.name !== 'select' || step.modulators?.length || step.optionArms) return undefined;
  const args = (step.args ?? []).map((a) => a.value);
  const pops = args.filter((arg): arg is { readonly pop: string } =>
    typeof arg === 'object' && arg !== null && typeof (arg as { pop?: unknown }).pop === 'string');
  const labels = args.filter((arg): arg is string => typeof arg === 'string');
  if (labels.length !== 1 || pops.length + labels.length !== args.length) return undefined;
  return { kind: 'alias', label: labels[0]!, pop: (pops[0]?.pop ?? 'last') as Pop };
}

/** Does this host keep a traverser its `by()` yields nothing for? `ProductiveByStrategy` says yes;
 *  TinkerPop's default says no. NOT exported: a host asks `productivityFilter` for the predicate, so
 *  there is nowhere a caller needs the boolean without also needing what to do about it. */
export const isProductiveBy = (step: IRStep): boolean => step.productiveBy === true;

/**
 * A `by()`'s projection as an expression over the host traverser, or `null` to decline.
 *
 * `ordering` asks for the value wrapped in the vtype-aware compare key — the same authority the range
 * predicates and scalar `order()` use, and for the same reason: a number too large for SQLite's
 * numeric storage classes is stored as TEXT, so a raw `<` orders it lexically and after every numeric
 * row. It goes INSIDE the scalar subquery, where the property row's own `vtype` is in scope.
 */
export function byExpr(
  modulation: Modulation, host: ChildHost, source: GraphSource, fresh: Minter, ordering = false, child?: ChildSeam,
): Expr | null {
  const { key } = modulation;

  if (key.kind === 'column') return null;

  if (key.kind === 'child') {
    if (!child) return null;
    // A child projection has no `vtype` column, so an ordering key cannot honestly use the stored-value
    // comparison wrapper. Its expression passes through unchanged and frames by value inference.
    // The seam's framing is the FIELD vocabulary's business (`byField`); a bare ordering/grouping key
    // only ever needed the value.
    //
    // ONLY A SCALAR RESULT, and the guard is the seam's contract read honestly: `ChildValue.framing` is
    // the full `RelFraming` and a consumer that can only use a VALUE narrows it itself. A body whose one
    // result is an ELEMENT hands back a rowid and one that is a RECORD hands back a map node — neither
    // is a comparable value, and ordering by either would be a plausible-looking answer to a traversal
    // TinkerPop rejects.
    const produced = child.scalar(key.body, host);
    return produced && produced.framing.kind === 'scalar' ? produced.expr : null;
  }

  if (key.kind === 'alias') {
    // A VALUE yields its stored scalar and, where the source recorded a per-row type, the ordering
    // wrapper reads that recorded tag rather than a column — which is what makes `as('a')` on a big
    // long still compare as a number after `select('a')`. An ELEMENT or LIST has no comparable value
    // here: ordering by a rowid is not what `order().by(__.select('a'))` means, so it declines.
    const scoped = scopeValue(key, host);
    if (!scoped || scoped.framing.kind !== 'scalar') return null;
    const [value, type] = [scoped.payload[0]![1], scoped.payload[1]?.[1]];
    return ordering && type ? storedCompareOn(type)(value) : value;
  }

  if (host.kind === 'scalar') {
    // A value has no properties and no tokens, so `order().by(key/traversal)` over a scalar stream is
    // not supported (no properties); this declines rather than inventing an answer off the wrong row.
    if (key.kind !== 'identity') return null;
    return ordering && host.vtype ? storedCompareOn(host.vtype)(host.value) : host.value;
  }

  // A RECORD's only projections are its FIELDS, which the alias arm above answered. A bare `by()` over
  // one is the whole map — not a comparable value and not a property source — so everything left here
  // declines rather than picking a field.
  if (host.kind === 'record') return null;

  // A LIST host has no `byExpr` projection either: a bare `by()` over a collection is the whole list
  // (the identity arm reads it off the host framing), and a `by(key)`/`by(token)` over a collection has
  // no value to read — the by()-over-a-list vocabulary is `unfold()` in the CHILD arm, not this one.
  if (host.kind === 'list') return null;
  if (host.kind === 'map') return null;

  if (host.kind === 'property') {
    // `T.key` / `T.value` — a property's OWN two tokens, read off the stored row through the one
    // authority for that row's columns (`propertyReadOf`, `property.ts`), so a key read here and a
    // `key()` STEP cannot disagree. The value takes the ordering wrapper from its own `vtype` for the
    // reason every stored value does: an exact number carried as decimal TEXT would otherwise sort
    // lexically and after every numeric row.
    if (key.kind === 'token' && PROPERTY_TOKENS.has(key.token)) {
      const read = propertyReadOf(host.id, host.ownerElem, key.token === 'key' ? 'key' : 'value', fresh);
      return ordering && key.token === 'value'
        ? storedCompareOn(propertyReadOf(host.id, host.ownerElem, 'vtype', fresh))(read)
        : read;
    }
    // What is left is the vocabulary an ELEMENT has and a property does not: a bare `by()` over one is
    // the VertexProperty itself (not a comparable value), `by('x')` would be a meta-property read, and
    // `element()` is a STEP and therefore the child arm's. All three decline rather than being answered
    // off the wrong row.
    return null;
  }

  if (key.kind === 'identity') return host.id;

  if (key.kind === 'token') {
    // `T.key`/`T.value` are a PROPERTY's tokens, not an element's — an element has no key and no value —
    // so they decline here rather than being answered off the wrong row.
    if (PROPERTY_TOKENS.has(key.token)) return null;
    // `T.id` is the EXTERNAL id (`COALESCE(uid, id)` — the id a client sees, not the rowid); `T.label`
    // is the element's label (one indirection into `labels` for an edge, the first of the side-table set
    // for a vertex, in label-interning order — our multi-label extension of TinkerPop's single-valued
    // `Element.label()`). Both are PHYSICAL reads, so they come from the GRAPH SOURCE — the SAME
    // `externalId`/`labelScalar` the `label()`/`id()` steps and a bound `by(T.label)` reach, which is
    // what lets `group().by(T.label)` and friends compose over a bound graph.
    return key.token === 'id'
      ? source.externalId(host.elem, host.id, fresh)
      : source.labelScalar(host.elem, host.id, fresh);
  }

  // `by('key')` over an element — the FIRST value of the property, a PHYSICAL read through the GRAPH
  // SOURCE (the same `propertyScalar` the base tables and a bound `{t,v}` tree both answer), so
  // `group().by(k)`/`order().by(k)` compose over either graph. INSERTION ORDER names the first value
  // (`PropertyValueStep`); `ordering` wraps it in the vtype-aware compare.
  return key.kind === 'property' ? source.propertyScalar(host.elem, host.id, key.key, ordering, fresh) : null;
}

/**
 * A SCOPE KEY resolved against the host — MAP SCOPE FIRST, then the path labels.
 *
 * That order is `Scoping.getScopeValue`'s and not a preference: the traverser's own Map is tried
 * before the side effects and before the path labels
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:117-131`),
 * so `project('a','b').order().by(__.select('a'))` reads the FIELD even where an `as('a')` label is
 * also bound. One function so the three by() answers cannot disagree about which scope won.
 *
 * `null` where the host carries no row (a path position projects from a rowid, not from a relation)
 * or the key is readable in neither scope.
 */
function scopeValue(
  key: Extract<ByKey, { kind: 'alias' }>, host: ChildHost,
): { readonly payload: readonly (readonly [ColMeta, Expr])[]; readonly framing: RelFraming; readonly optional: boolean } | null {
  const row = host.row;
  const field = host.kind === 'record' ? fieldNamed(host.fields, key.label) : undefined;
  if (field && row) {
    // A `Pop` names a position in a path HISTORY; a map key has no history, so a Pop-qualified read
    // of a field is a form Gremlin does not have and declining beats picking an end.
    if (key.pop !== 'last') return null;
    const cols = framingCols(field.framing);
    if (!cols) return null;
    return {
      payload: cols.map((column) => [column, col(row.rel.id, fieldCol(field.prefix, column.name))] as const),
      framing: field.framing,
      optional: field.optional,
    };
  }
  if (!row) return null;
  const projected = aliasProjection(row.rel, row.aliases, key.label, key.pop);
  return projected && {
    payload: projected.payload,
    framing: readFraming(projected.read),
    optional: projected.entry.binds === undefined,
  };
}

/**
 * A SCOPE KEY re-rooted as a HOST — the traverser a nested projection runs AGAINST, rather than the
 * value it yields.
 *
 * `byExpr`/`byNode`/`byField` all answer "what does this `by()` project out of the host". This is the
 * other half of `Scoping`: `math("a + b").by("age")` resolves `a` to the labelled traverser and THEN
 * applies the ring's `by()` to it (`MathStep.processNextStart` —
 * `TraversalUtil.produce(getNullableScopeValue(Pop.last, var, traverser), traversalRing.next())`,
 * `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:70-73`).
 * So the label names a HOST and the modulator names a projection over it, and expressing that as
 * `scopedHost` + the existing `byExpr` is what stops a scope-resolving host growing its own copy of
 * the by() vocabulary. `format()`'s named tokens and `where(label, …)` want the identical thing.
 *
 * `null` where the key resolves in neither scope, or where what it holds is not a traverser a nested
 * projection can run against (a LIST, a MAP, a nested RECORD): declining beats picking an element of
 * one, which would answer a different question.
 */
export function scopedHost(label: string, host: ChildHost): ChildHost | null {
  const scoped = scopeValue({ kind: 'alias', label, pop: 'last' }, host);
  if (!scoped) return null;
  const row = host.row ? { row: host.row } : {};
  if (scoped.framing.kind === 'elements')
    return { kind: 'element', id: scoped.payload[0]![1], elem: scoped.framing.elem, ...row };
  if (scoped.framing.kind === 'scalar') {
    // The recorded per-row type rides along: it is what makes an ordering/comparison over the scoped
    // value read as its Gremlin type rather than as its storage class, exactly as the host's own does.
    const vtype = scoped.payload[1]?.[1];
    return { kind: 'scalar', value: scoped.payload[0]![1], ...(vtype ? { vtype } : {}), ...row };
  }
  return null;
}

/**
 * A `by()` projection as a SELF-DESCRIBING `{t,v}` NODE rather than a bare value — what a MAP entry
 * needs, because a map's sides are framed per entry from their own tags (§ the map shape) and a
 * heterogeneous map has to round-trip each one exactly.
 *
 * It is `byExpr`'s twin and shares its scans deliberately: a property key's value and its `vtype` come
 * out of the SAME `firstOf` subquery, so the tag cannot disagree with the value it describes. Written
 * here rather than in the map module because it is the `by()` vocabulary answering a question about
 * itself — the second consumer (`valueMap`'s per-element map) wants the identical thing.
 *
 * `null` declines the two hosts whose node this cannot build: an ELEMENT key (the node would have to be
 * a framed element, which the materializer expands per pair rather than tagging) and anything `byExpr`
 * already refuses.
 */
/** A `{t,v}` node's tag from a scalar type: the STATIC class as a literal where the type names one,
 *  else SQL NULL (an UNKNOWN or a per-row type the framer must infer — a per-row column cannot ride a
 *  map side, so it is dropped here). A literal, so it never duplicates a correlated read. */
const staticTagExpr = (type: ScalarType): Expr => {
  const tag = staticTypeOf(type);
  return tag ? compilerText(tag) : compilerNull('text');
};

/**
 * A CHILD BODY'S RESULT AS A SELF-DESCRIBING `{t,v}` MEMBER NODE — the encoding a value `by()` puts in a
 * map, and (via `groupCollected`) the one a `by(__.…​.fold())` collects into a list, or `null` for a
 * shape a node cannot carry.
 *
 * Factored out of `byNode` because the pooled fold-collect asks exactly this question of an
 * already-lowered ROW rather than a re-lowered child expression: given a value and what it IS, wrap it
 * as the member node the typed tree frames at any depth. An ELEMENT rowid becomes `{t:'vertex', v:{…}}`,
 * a MAP its pairs array, a scalar its `{t,v}` node tagged where the type is STATIC (a literal `t`, no
 * correlated read duplicated) and untagged where it is per-row (a stored value's tag is a second read a
 * member position has no room for). The `null`-preserving CASE outside the node is how the shared
 * productivity filter tells a child that yielded nothing from a value worth collecting.
 */
export function producedMemberNode(value: Expr, framing: RelFraming, source: GraphSource, fresh: Minter): Expr | null {
  const member = framing.kind === 'elements' ? source.elementNode(framing.elem, value, fresh)
    : framing.kind === 'map' ? mapNode(value)
      : framing.kind === 'list' ? (() => {
        const members = listNodeExpr(value, framing.of, source, fresh);
        return members && listNode(members);
      })()
      : framing.kind === 'scalar' ? typedNode(value, staticTagExpr(framing.type))
        : null;
  if (!member) return null;
  return {
    kind: 'case',
    whens: [[{ kind: 'binary', op: 'is', left: value, right: compilerNull() }, compilerNull()]],
    else: member,
  };
}

export function byNode(modulation: Modulation, host: ChildHost, source: GraphSource, fresh: Minter, child?: ChildSeam): Expr | null {
  const { key } = modulation;

  if (key.kind === 'column') {
    if (host.kind !== 'scalar' || !host.entry) return null;
    if (key.column === 'keys') return host.entry.key;
    // A retained element list carries rowids for re-entry.  Here it becomes a member of ANOTHER
    // typed tree, so expand only this framing copy; the entry relation itself remains rowid-backed.
    // Column/Select pass the live value through (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/structure/Column.java:57-68`,
    // `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectStep.java:66-89`).
    if (host.entry.valOf.kind === 'list') {
      const members = listNodeExpr(jsonField(host.entry.val, 'v'), host.entry.valOf.of, source, fresh);
      return members && listNode(members);
    }
    return host.entry.val;
  }

  if (key.kind === 'child') {
    if (!child) return null;
    const produced = child.scalar(key.body, host);
    if (!produced) return null;
    // WHAT THE BODY PRODUCED decides the member encoding, and the three answers are the same three the
    // ALIAS arm below gives — a child body and a labelled read are the same question about a different
    // scope, so they must not encode their results two ways.
    return producedMemberNode(produced.expr, produced.framing, source, fresh);
  }

  if (key.kind === 'alias') {
    const scoped = scopeValue(key, host);
    if (!scoped) return null;
    // An ELEMENT becomes a `{t:'vertex', v:{…}}` member, which is the encoding the typed tree already
    // frames at any depth — so a map keyed or valued by a labelled element needs nothing new.
    if (scoped.framing.kind === 'elements')
      return source.elementNode(scoped.framing.elem, scoped.payload[0]![1], fresh);
    // Anything else — a LIST, a nested RECORD — needs a member encoding a `{t,v}` node cannot carry
    // from here, so it declines and stays the FIELD vocabulary's business.
    if (scoped.framing.kind !== 'scalar') return null;
    // A VALUE carries its recorded type in the history entry's own `t` field — the one place a per-row
    // `vtype` COLUMN survives becoming JSON.
    return typedNode(scoped.payload[0]![1], scoped.payload[1]?.[1] ?? compilerNull('text'));
  }

  if (host.kind === 'scalar') {
    if (key.kind !== 'identity') return null;
    // A scalar stream carries its own tag where the value came from a stored property; without one the
    // framer infers from the JS value, which is what an untagged node means.
    return host.vtype ? typedNode(host.value, host.vtype) : typedNode(host.value, compilerNull('text'));
  }

  // A RECORD as a `{t:'map', v:[…]}` node is `recordValue`'s (`record.ts`) and reachable only through
  // the FIELD vocabulary, which is on the other side of this module's DAG edge. A non-field projection
  // over one declines here.
  if (host.kind === 'record') return null;

  // A LIST as a map-value node is the FIELD vocabulary's business too (`fieldNode`'s list arm, reached
  // through `byField`'s child path); this non-field node projection over a collection declines.
  if (host.kind === 'list') return null;
  if (host.kind === 'map') return null;

  if (host.kind === 'property') {
    // A bare `by()` over a PROPERTY projects the VertexProperty itself, and unlike the element case
    // below it is answered rather than declined: the element arm declines because `groupBarrier` has a
    // cheaper spelling for that key (the ROWID, expanded once per surviving group), and a property key
    // has no such spelling in this route yet. So the node IS the answer here, and a bare
    // `g.V().properties().group()` groups by the property's own JSON rather than by an integer — a
    // correct answer at a plan cost, which is the honest trade while the rowid spelling needs a
    // `MapOf` that can name a property side.
    // `T.key` is always a string; `T.value` carries the stored row's own `vtype`, so the node is TAGGED
    // rather than left to value inference — which is the only thing that keeps a datetime from framing as
    // a long (§6·7: what arrives is CARRIED until something naturally changes it).
    if (key.kind === 'token' && PROPERTY_TOKENS.has(key.token)) {
      const value = byExpr(modulation, host, source, fresh);
      return value && typedNode(value, key.token === 'key'
        ? compilerText('string')
        : propertyReadOf(host.id, host.ownerElem, 'vtype', fresh));
    }
    if (key.kind !== 'identity') return null;
    return propertyNode(host.id, host.ownerElem, fresh);
  }

  // A bare `by()` over an element projects the ELEMENT — not a value with a tag.
  if (key.kind === 'identity') return null;

  if (key.kind === 'token') {
    // A LABEL is always a string; an `id` is whatever `COALESCE(uid, id)` yields, so it stays untagged
    // and the framer infers — the same answer the element projection gives for an external id.
    const value = byExpr(modulation, host, source, fresh);
    return value && typedNode(value, key.token === 'label' ? compilerText('string') : compilerNull('text'));
  }

  // ONE subquery for both halves: the tag IS the row the value came from.
  if (key.kind !== 'property') return null;
  const mine = propertyRowFor(host, key.key, fresh);
  return firstOf(mine, typedNode(col(mine.id, 'value'), col(mine.id, 'vtype')), col(mine.id, 'id'), fresh);
}

/**
 * A `by()` AS A RECORD FIELD — its payload COLUMNS, what they hold, and whether it can be absent.
 *
 * `byExpr`'s and `byNode`'s third sibling, and the one that keeps the SHAPE. The other two collapse a
 * projection to one thing on purpose — an ordering key wants a comparable value, a map entry wants a
 * self-describing node — and both therefore lose what the projection IS. A record's field must not:
 * `project('v','n').by().by('name')` has an ELEMENT in one field and a stored value in the other, and
 * a following `select('v')` re-roots to a vertex stream, which is only possible while the field is
 * still a rowid rather than an expanded payload blob.
 *
 * So this is not a third spelling of one question — it is the question the other two answer by
 * discarding. It lives here for `byNode`'s reason: the `by()` vocabulary answering about itself, once,
 * for every host that grows a record (`project`, multi-label `select`, and `valueMap`'s per-element map
 * after it).
 */
export interface ByField {
  /** The field's payload, keyed by the CANONICAL column names `framingCols(framing)` declares — the
   *  record builder prefixes them, the field re-entry strips the prefix back off. */
  readonly exprs: readonly (readonly [string, Expr])[];
  readonly framing: RelFraming;
  /** May this field be ABSENT from the map on some row (§ `RecordField.optional`)? */
  readonly optional: boolean;
}

/**
 * One `by()` slot as a record field, or `null` to decline.
 *
 * `hostFraming`/`hostCol` are what make the IDENTITY arm total over every host at once: a bare `by()`
 * projects the traverser unchanged, so the field's columns ARE the host relation's payload columns and
 * its framing IS the host's framing. That is why identity needs no per-host arm and why a host this
 * module has no `ChildHost` for (a LIST traverser) still gets a working `project('a').by()`.
 */
export function byField(
  step: IRStep, modulation: Modulation, host: ChildHost | null, hostFraming: RelFraming,
  hostCol: (name: string) => Expr, source: GraphSource, fresh: Minter, child?: ChildSeam,
): ByField | null {
  const { key } = modulation;
  // A comparator in a record slot is not a form Gremlin has — `project(…).by(Order.desc)` names no
  // value — so it declines rather than being read as a bare `by()`.
  if (modulation.order !== undefined) return null;
  // `optional` is the INTRINSIC question ANDed with the strategy: `ProductiveByStrategy` keeps the
  // traverser and the key, so nothing is ever absent under it. Asked through the same predicate every
  // other host asks, so the two cannot drift.
  const droppable = (): boolean => !isProductiveBy(step);

  if (key.kind === 'identity') {
    const cols = framingCols(hostFraming);
    // A PROPERTY or a DISCARD host has no field-shaped payload (`framingCols`), so a bare `by()` over
    // one declines here rather than in the record builder — the by() vocabulary is where "this
    // projection cannot be a field" belongs.
    if (!cols) return null;
    return { exprs: cols.map((column) => [column.name, hostCol(column.name)] as const), framing: hostFraming, optional: false };
  }

  if (!host) return null;

  if (key.kind === 'alias') {
    // The ALIAS ARM IS THE ONE A RECORD MOST NEEDS, and the reason is `Scoping`'s precedence: a
    // labelled ELEMENT beside a computed value is the ordinary shape of `project('vertex','degree')
    // .by(__.select('v')).by()`. Because the payload keeps the rowid, the field re-enters as a vertex
    // stream — which a `{t,v}` node could not do.
    const scoped = scopeValue(key, host);
    if (!scoped) return null;
    return {
      exprs: scoped.payload.map(([column, expr]) => [column.name, expr] as const),
      framing: scoped.framing,
      // A STATICALLY bound label (or a non-optional field) is present on every row that reached here;
      // one first bound inside a branch arm or a repeat body may be missing, and then the key is
      // absent from the map. Same distinction `aliasGuard` draws for a presence filter.
      optional: scoped.optional && droppable(),
    };
  }

  if (key.kind === 'child') {
    if (!child) return null;
    const produced = child.scalar(key.body, host);
    if (!produced) return null;
    // THE SEAM'S ONE EXPRESSION IS THE FRAMING'S FIRST PAYLOAD COLUMN, whatever the framing is — a
    // rowid for an element, `v` for a value, `map` for a collapsed record. That is the same convention
    // `presence` reads to ask whether a field is there, so stating it here is reading one rule rather
    // than adding an arm per shape, and it is what makes `project('v').by(__.outV())` re-enter as a
    // VERTEX stream instead of declining.
    //
    // EVERY OTHER column the framing declares must also have an expression, and only `vtype` does —
    // the second correlated read a stored-value body supplies. A numeric reducer's `vt` (the
    // aggregate's runtime `typeof`) has none, and recomputing the aggregate a second time is the
    // duplication a shaped seam exists to avoid, so it DECLINES rather than dropping the type.
    // `count()` is unaffected: its type is the compile-time `long`.
    const cols = framingCols(produced.framing);
    const [payload, ...rest] = cols ?? [];
    if (!payload) return null;
    const exprs: (readonly [string, Expr])[] = [[payload.name, produced.expr]];
    for (const column of rest) {
      // The one extra column a scalar framing declares is its TYPE column — `vtype` for a stored
      // value, `vt` for a numeric reducer's dynamic `typeof`. The seam supplies it as `produced.vtype`
      // under whichever name `framingCols` gave it, so landing it here is what lets `by(sum())` carry
      // its type into a record field exactly as `by('age')` does, rather than declining for want of a
      // column it has already computed. Without one the field cannot carry the type, so it declines.
      if (!produced.vtype) return null;
      exprs.push([column.name, produced.vtype]);
    }
    // A body the seam PROVES always-productive (a `fold()` seeds `[]`, a `count()` seeds 0) is never
    // absent, so the field carries NO presence guard — which matters for more than tidiness: `presence`
    // re-emits the field's whole value expression inside a `CASE WHEN … IS NOT NULL`, so a nested
    // `by(__.…fold())` would spell its entire correlated subquery TWICE. `ALWAYS_PRODUCTIVE` is the same
    // shared object the seam fills `present` with, so this is the reference-equality test every other
    // productivity consumer uses.
    const alwaysProductive = produced.present === ALWAYS_PRODUCTIVE;
    return { exprs, framing: produced.framing, optional: droppable() && !alwaysProductive };
  }

  if (host.kind === 'record') return null;

  if (key.kind === 'token') {
    const value = byExpr(modulation, host, source, fresh);
    if (!value) return null;
    // A `T` token is ALWAYS present, so a token field is never absent — `orderProductivity` says the
    // same thing for the same reason. A LABEL and a property KEY are strings; an external id is whatever
    // `COALESCE(uid, id)` yields, so it stays unknown and the framer infers. A property's `T.value` is
    // the one token with a STORED type, so it projects its `vtype` beside the value exactly as a property
    // FIELD does below — a field that dropped the tag would frame a datetime as a long.
    if (host.kind === 'property' && key.token === 'value') {
      return {
        exprs: [['v', value], ['vtype', propertyReadOf(host.id, host.ownerElem, 'vtype', fresh)]],
        framing: { kind: 'scalar', type: PER_ROW('vtype') },
        optional: false,
      };
    }
    return {
      exprs: [['v', value]],
      framing: { kind: 'scalar', type: key.token === 'label' || key.token === 'key' ? STATIC('string') : UNKNOWN },
      optional: false,
    };
  }

  // A SCALAR, PROPERTY and LIST host all stop here for the same reason: what is left below is the
  // ELEMENT vocabulary (a stored property of the traverser), and none of the three has one. A property's
  // own three projections are STEPS reached through the child arm above; a list's `by(key)` is likewise
  // not a stored-property read.
  if (host.kind === 'scalar' || host.kind === 'property' || host.kind === 'list' || host.kind === 'map') return null;

  // A PROPERTY FIELD keeps its stored type, so it is TWO correlated reads of the same property row —
  // the value and its `vtype`. They cannot share one subquery (SQL's scalar subquery yields one
  // column) and they cannot disagree: both take the same `WHERE owner = … AND key = …` and the same
  // `ORDER BY id LIMIT 1`, which is the insertion-order "first" `PropertyValueStep` means. The cheaper
  // shape is a LEFT JOIN carrying both columns, and it is a later optimization rather than this
  // increment's: every other `by()` host already emits the correlated form, so this matches the SQL
  // the spine already produces instead of introducing a second access path for one caller.
  if (key.kind !== 'property') return null;
  const value = byExpr(modulation, host, source, fresh);
  const vtype = propertyVtype(key.key, host, fresh);
  if (!value) return null;
  return {
    exprs: [['v', value], ['vtype', vtype]],
    framing: { kind: 'scalar', type: PER_ROW('vtype') },
    optional: droppable(),
  };
}

/** The `vertex_properties` / `edge_properties` rows at `key` for one host element — the scan filtered to
 *  `owner = host.id AND key = …`, stated ONCE. `byNode`'s `{t,v}` node, `propertyVtype` and
 *  `propertyExists` are the same rows read three ways (value+vtype, vtype, presence); each projects off
 *  this relation so the three cannot disagree about WHICH rows they describe — the drift a second
 *  spelling of the column contract would open (`propertyRow` in `property.ts` is the sibling keyed by
 *  ROWID rather than `(owner, key)`). */
function propertyRowFor(host: Extract<ChildHost, { kind: 'element' }>, key: string, fresh: Minter): Rel {
  const { table, owner } = PROPERTIES[host.elem];
  const scan = make.scan({
    id: fresh('vp'), table, alias: fresh('rp'), channels: [],
    type: typeOf(meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  return make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, owner), host.id), eq(col(scan.id, 'key'), compilerText(key))),
  });
}

/** The stored `vtype` of the FIRST value at `key` — `byExpr`'s property arm with the other column
 *  projected, sharing its filter and its insertion-order pick so the tag cannot describe a different
 *  row than the value does. Exported because the child seam needs the identical read for a body that
 *  LEADS with `values(k)`: the same question, and a second spelling of it is a second chance for the
 *  tag to describe a row the value did not come from. */
export function propertyVtype(key: string, host: Extract<ChildHost, { kind: 'element' }>, fresh: Minter): Expr {
  const mine = propertyRowFor(host, key, fresh);
  return firstOf(mine, col(mine.id, 'vtype'), col(mine.id, 'id'), fresh);
}

/**
 * DOES A PROPERTY ROW EXIST at `key` for this host — the productivity of a property read, as a
 * predicate.
 *
 * `propertyVtype`'s sibling and `byExpr`'s third read of the same rows, and it exists because a
 * property's PRESENCE is not the same question as its value's nullness: `TraversalProduct` calls a
 * productive null a value, so a consumer that tested `value IS NULL` would answer "unproductive" for
 * a property that is genuinely there. An `Exists` says exactly what is being asked.
 */
export function propertyExists(key: string, host: Extract<ChildHost, { kind: 'element' }>, fresh: Minter): Expr {
  return { kind: 'exists', plan: propertyRowFor(host, key, fresh), negated: false };
}

/** TinkerPop's default `by()` productivity, as a predicate: a traverser whose `by()` yielded nothing
 *  is dropped. `undefined` where no filter is owed — the host was handed no projection, or
 *  `ProductiveByStrategy` asked for the null-keeping behaviour. */
export const productivityFilter = (step: IRStep, key: Expr | undefined): Expr | undefined =>
  key && !isProductiveBy(step) ? { kind: 'binary', op: 'is not', left: key, right: compilerNull() } : undefined;

/**
 * `order()`'s productivity, which is NARROWER than `dedup()`'s — and the difference is the reference's,
 * not a simplification.
 *
 * **A property KEY or a CHILD can be unproductive; a token, a bare `by()` and `shuffle` cannot.** A `T`
 * token is always present, a bare `by()` is the element itself, and `shuffle` projects nothing at all.
 * `dedup()` deliberately drops for any `by()` at all (`modulators.length && !productiveBy`), so the two
 * hosts still differ — but they differ in the token/bare/shuffle cases, not in the child one.
 *
 * **The `child` arm was ADDED when the by()-traversal seam made it reachable, and the reference is what
 * says so rather than an inference.** `OrderGlobalStep.processAllStarts()` is
 * `this.createProjectedTraverser(this.starts.next()).ifPresent(traverserSet::add)` under TinkerPop's own
 * comment "only add the traverser if the comparator traversal was productive"
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderGlobalStep.java:85`; `:82` is the method signature, `:84` the comment).
 * So a child that yields nothing drops the traverser exactly as a missing property does. Before the seam
 * this comment read "only a property KEY can be unproductive", which was TRUE only because no other
 * projection could yield nothing — the narrowing was accidental, and a reducing child body
 * (`by(__.outE().values('weight').sum())` over a vertex with no out-edges, which
 * `SumGlobalStep` emits NO traverser for) is exactly the case it left answering 6 rows where the
 * reference answers 3.
 */
export const orderProductivity = (step: IRStep, modulation: Modulation, key: Expr): Expr | undefined =>
  modulation.key.kind === 'property' || modulation.key.kind === 'child'
    ? productivityFilter(step, key)
    : undefined;
