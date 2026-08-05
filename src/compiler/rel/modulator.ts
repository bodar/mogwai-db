import { col, compilerNull, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { isNested, isOrderArg, isTokenArg } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/step.ts';
import type { Elem } from '../plan/plan.ts';
import { childSteps } from '../steps/tail/child-shape.ts';
import { and, eq, EDGE_COLS, firstOf, meta, NODE_COLS, PROPERTIES, typedNode, typeOf, type Minter } from './build.ts';
import { storedCompareOn } from './predicate.ts';

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
 * - **It never throws.** A form it cannot express returns `null` and the whole traversal routes to the
 *   legacy spine, which raises the message it owns. A throw here would turn "not learned yet" into a
 *   support regression.
 * - **It never answers a DIFFERENT question.** Every arm below reproduces the legacy semantics
 *   exactly — measured against the SQL legacy emits, not inferred — or declines.
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
 * Legacy spells the difference as a `WHERE <key> IS NOT NULL` present or absent at each host; here it
 * is `productivityFilter`, so a host cannot forget it. A forgotten productivity filter is a wrong
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
  | { readonly kind: 'token'; readonly token: 'id' | 'label' }
  | { readonly kind: 'child'; readonly body: readonly IRStep[] };

/** The injected lowerer for a nested `by()` body. It lives beside the vocabulary while its
 * implementation lives beside the fold, which keeps the module DAG one-way. */
export type ByChild = (body: readonly IRStep[], host: ByHost) => Expr | null;

/** One parsed `by()`. `order` is present only where the modulator named a comparator. */
export interface Modulation {
  readonly key: ByKey;
  readonly order?: 'asc' | 'desc' | 'shuffle';
}

/**
 * The traverser a `by()` projects FROM — a union rather than a bag of optional fields, because the two
 * cases admit DIFFERENT projections and the type is what makes that visible: an element has properties
 * and tokens, a scalar value has neither. `vtype` is present only where the value came from a stored
 * property, which is the same distinction `predicateExpr`'s `compare` parameter draws.
 */
export type ByHost =
  | { readonly kind: 'element'; readonly id: Expr; readonly elem: Elem }
  | { readonly kind: 'scalar'; readonly value: Expr; readonly vtype?: Expr };

const ORDERS = new Set(['asc', 'desc', 'shuffle']);
/** The two `T` tokens that name a value a `by()` can project. `T.key`/`T.value` are a PROPERTY
 *  element's, not an element's, so they are absent here rather than guessed at. */
const TOKENS: Readonly<Record<string, 'id' | 'label'>> = { id: 'id', label: 'label' };

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
 */
export function modulations(step: IRStep, max: number, params: Record<string, any>): readonly Modulation[] | null {
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
      if (isNested(arg)) {
        // A second projection in one `by()` is not a form Gremlin has; declining beats picking one.
        if (projected) return null;
        const body = childSteps(arg.nested, params);
        // `by(__.identity())` is a bare `by()`: both project the element itself. Normalizing it here
        // keeps every host from having to re-derive that semantic identity.
        key = body.length === 1 && body[0]?.name === 'identity'
          ? { kind: 'identity' }
          : { kind: 'child', body };
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

/** Does this host keep a traverser its `by()` yields nothing for? `ProductiveByStrategy` says yes;
 *  TinkerPop's default says no. NOT exported: a host asks `productivityFilter` for the predicate, so
 *  there is nowhere a caller needs the boolean without also needing what to do about it. */
const isProductiveBy = (step: IRStep): boolean => step.productiveBy === true;

/**
 * A `by()`'s projection as an expression over the host traverser, or `null` to decline.
 *
 * `ordering` asks for the value wrapped in the vtype-aware compare key — the same authority the range
 * predicates and scalar `order()` use, and for the same reason: a number too large for SQLite's
 * numeric storage classes is stored as TEXT, so a raw `<` orders it lexically and after every numeric
 * row. It goes INSIDE the scalar subquery, where the property row's own `vtype` is in scope, which is
 * exactly where legacy puts it.
 */
export function byExpr(
  modulation: Modulation, host: ByHost, fresh: Minter, ordering = false, child?: ByChild,
): Expr | null {
  const { key } = modulation;

  if (key.kind === 'child') {
    if (!child) return null;
    // A child projection has no `vtype` column, so an ordering key cannot honestly use the stored-value
    // comparison wrapper. Its expression passes through unchanged and frames by value inference.
    return child(key.body, host);
  }

  if (host.kind === 'scalar') {
    // A value has no properties and no tokens. Legacy THROWS for both ("order().by(key/traversal) on
    // a scalar stream not supported (no properties)"), so declining hands it the message rather than
    // inventing a second one.
    if (key.kind !== 'identity') return null;
    return ordering && host.vtype ? storedCompareOn(host.vtype)(host.value) : host.value;
  }

  if (key.kind === 'identity') return host.id;

  if (key.kind === 'token') {
    // `T.id` is the EXTERNAL id — `COALESCE(uid, id)`, the same projection every materialization uses,
    // so a `by(T.id)` groups on the id a client would see and not on the rowid behind it.
    const table = host.elem === 'edge' ? 'edges' : 'nodes';
    const cols = host.elem === 'edge' ? EDGE_COLS : NODE_COLS;
    if (key.token === 'id') {
      const scan = make.scan({ id: fresh('ei'), table, alias: fresh('re'), channels: [], type: typeOf(...cols) });
      const mine = make.filter({ id: fresh('f'), input: scan, channels: [], type: scan.type, pred: eq(col(scan.id, 'id'), host.id) });
      const external: Expr = { kind: 'call', fn: 'COALESCE', args: [col(mine.id, 'uid'), col(mine.id, 'id')] };
      return firstOf(mine, external, col(mine.id, 'id'), fresh);
    }
    // A LABEL is one indirection for an edge (a column into `labels`) and two for a vertex (a side
    // table, which may hold several — insertion order names the first). Same question, two physical
    // shapes, which is the asymmetry `Scan` exists to make visible.
    //
    // A `Join`'s outputs are addressed through the JOIN, never through its sides — the sides are in
    // scope inside `on` and nowhere else — so the right side's `id` is declared as `lid`. Two columns
    // sharing a name in one declared type would shadow each other in the emitter's scope map, which is
    // the same reason `movement` renames the incoming id to `pid`.
    const labels = make.scan({ id: fresh('lb'), table: 'labels', alias: fresh('rl'), channels: [], type: typeOf(meta('id', 'int'), meta('name', 'text')) });
    if (host.elem === 'edge') {
      const edges = make.scan({ id: fresh('eg'), table: 'edges', alias: fresh('re'), channels: [], type: typeOf(...EDGE_COLS) });
      const joined = make.join({
        id: fresh('j'), left: edges, right: labels, join: 'inner', channels: [],
        type: typeOf(...EDGE_COLS, meta('lid', 'int'), meta('name', 'text')),
        on: and(eq(col(edges.id, 'label'), col(labels.id, 'id')), eq(col(edges.id, 'id'), host.id)),
      });
      return firstOf(joined, col(joined.id, 'name'), col(joined.id, 'lid'), fresh);
    }
    const vl = make.scan({ id: fresh('vl'), table: 'vertex_labels', alias: fresh('rvl'), channels: [], type: typeOf(meta('node', 'int'), meta('label', 'int')) });
    const joined = make.join({
      id: fresh('j'), left: vl, right: labels, join: 'inner', channels: [],
      type: typeOf(meta('node', 'int'), meta('label', 'int'), meta('lid', 'int'), meta('name', 'text')),
      on: and(eq(col(vl.id, 'label'), col(labels.id, 'id')), eq(col(vl.id, 'node'), host.id)),
    });
    // Ordered by the LABEL id, not the join's — a vertex with several labels reports them in label
    // order, which is what the element projection's `json_group_array(… ORDER BY vertex_labels.label)`
    // already does, so `by(T.label)` picks the same first one a client would see first.
    return firstOf(joined, col(joined.id, 'name'), col(joined.id, 'label'), fresh);
  }

  // A property scan declaring `id` as well as the payload: a VERTEX key may hold several values and
  // INSERTION ORDER is what names the first, so the rowid is not an implementation detail here — it is
  // the ordering `PropertyValueStep`'s semantics refer to. (`lower.ts` declares the same table without
  // `id`, and must: there the scan is JOINED to an element relation that already has an `id`, and two
  // columns of one name shadow each other in the emitter's scope.)
  const { table, owner } = PROPERTIES[host.elem];
  const scan = make.scan({
    id: fresh('vp'), table, alias: fresh('rp'), channels: [],
    type: typeOf(meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  const mine = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, owner), host.id), eq(col(scan.id, 'key'), compilerText(key.key))),
  });
  const value = ordering ? storedCompareOn(col(mine.id, 'vtype'))(col(mine.id, 'value')) : col(mine.id, 'value');
  return firstOf(mine, value, col(mine.id, 'id'), fresh);
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
export function byNode(modulation: Modulation, host: ByHost, fresh: Minter, child?: ByChild): Expr | null {
  const { key } = modulation;

  if (key.kind === 'child') {
    if (!child) return null;
    const value = child(key.body, host);
    // For `T.id`'s reason, a child has no recorded type: leave it untagged and let the framer infer.
    // Preserve SQL NULL outside the node: it is how the shared productivity filter distinguishes a
    // child that yielded nothing from a value it can collect or group.
    return value && {
      kind: 'case',
      whens: [[{ kind: 'binary', op: 'is', left: value, right: compilerNull() }, compilerNull()]],
      else: typedNode(value, compilerNull('text')),
    };
  }

  if (host.kind === 'scalar') {
    if (key.kind !== 'identity') return null;
    // A scalar stream carries its own tag where the value came from a stored property; without one the
    // framer infers from the JS value, which is what an untagged node means.
    return host.vtype ? typedNode(host.value, host.vtype) : typedNode(host.value, compilerNull('text'));
  }

  // A bare `by()` over an element projects the ELEMENT — not a value with a tag.
  if (key.kind === 'identity') return null;

  if (key.kind === 'token') {
    // A LABEL is always a string; an `id` is whatever `COALESCE(uid, id)` yields, so it stays untagged
    // and the framer infers — the same answer the element projection gives for an external id.
    const value = byExpr(modulation, host, fresh);
    return value && typedNode(value, key.token === 'label' ? compilerText('string') : compilerNull('text'));
  }

  // ONE subquery for both halves: the tag IS the row the value came from.
  const { table, owner } = PROPERTIES[host.elem];
  const scan = make.scan({
    id: fresh('vp'), table, alias: fresh('rp'), channels: [],
    type: typeOf(meta('id', 'int'), meta(owner, 'int'), meta('key', 'text'), meta('value', 'any', true), meta('vtype', 'text', true)),
  });
  const mine = make.filter({
    id: fresh('f'), input: scan, channels: [], type: scan.type,
    pred: and(eq(col(scan.id, owner), host.id), eq(col(scan.id, 'key'), compilerText(key.key))),
  });
  return firstOf(mine, typedNode(col(mine.id, 'value'), col(mine.id, 'vtype')), col(mine.id, 'id'), fresh);
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
 * (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderGlobalStep.java:82`).
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
