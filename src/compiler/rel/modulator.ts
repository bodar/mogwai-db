import { col, lit, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import { isOrderArg, isTokenArg } from '../../gremlin/frontend.ts';
import type { IRStep } from '../ir/step.ts';
import type { Elem } from '../plan/plan.ts';
import { and, eq, EDGE_COLS, firstOf, meta, NODE_COLS, PROPERTIES, typeOf, type Minter } from './build.ts';
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
 *  cannot (a sub-traversal, a `Column`, an `Operator`) never becomes a `ByKey` — `modulations`
 *  declines instead, so an unexpressible projection cannot reach a host as a plausible-looking one.
 *
 *  Reachable through `Modulation['key']` and not exported on its own: no host matches on the
 *  projection today (they hand it straight to `byExpr`), and an export nothing imports is a question
 *  `mise run orphans` will keep asking. Export it when a host needs to branch on it. */
type ByKey =
  | { readonly kind: 'identity' }
  | { readonly kind: 'property'; readonly key: string }
  | { readonly kind: 'token'; readonly token: 'id' | 'label' };

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
export function modulations(step: IRStep, max: number): readonly Modulation[] | null {
  const bys = step.modulators ?? [];
  if (bys.length > max) return null;
  const parsed: Modulation[] = [];
  for (const by of bys) {
    let key: ByKey = { kind: 'identity' };
    let order: Modulation['order'];
    for (const arg of by as readonly unknown[]) {
      if (typeof arg === 'string') {
        // A second projection in one `by()` is not a form Gremlin has; declining beats picking one.
        if (key.kind !== 'identity') return null;
        key = { kind: 'property', key: arg };
        continue;
      }
      if (isOrderArg(arg)) {
        if (order !== undefined || !ORDERS.has(arg.order)) return null;
        order = arg.order as Modulation['order'];
        continue;
      }
      if (isTokenArg(arg)) {
        const token = TOKENS[arg.token.toLowerCase()];
        if (!token || key.kind !== 'identity') return null;
        key = { kind: 'token', token };
        continue;
      }
      // Everything else DECLINES, and the default being refusal rather than tolerance is the point.
      // A SUB-TRAVERSAL projection (`by(__.out().count())`) is the one remaining form the language has
      // in this position, and it is a whole child lowering rather than an expression — it belongs to
      // whichever seam grows the correlated child, not to a vocabulary of expressions. A `Column`, an
      // `Operator` or a `GType` in a `by()` belongs to a host this module does not serve at all
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
export function byExpr(modulation: Modulation, host: ByHost, fresh: Minter, ordering = false): Expr | null {
  const { key } = modulation;

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
    pred: and(eq(col(scan.id, owner), host.id), eq(col(scan.id, 'key'), lit(key.key, 'text'))),
  });
  const value = ordering ? storedCompareOn(col(mine.id, 'vtype'))(col(mine.id, 'value')) : col(mine.id, 'value');
  return firstOf(mine, value, col(mine.id, 'id'), fresh);
}

/** TinkerPop's default `by()` productivity, as a predicate: a traverser whose `by()` yielded nothing
 *  is dropped. `undefined` where no filter is owed — the host was handed no projection, or
 *  `ProductiveByStrategy` asked for the null-keeping behaviour. */
export const productivityFilter = (step: IRStep, key: Expr | undefined): Expr | undefined =>
  key && !isProductiveBy(step) ? { kind: 'binary', op: 'is not', left: key, right: lit(null, 'any') } : undefined;
