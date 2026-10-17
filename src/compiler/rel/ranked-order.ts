// ---------- a GLOBAL order() SQL cannot compare, RANKED in JS and joined back ----------
//
// TinkerPop 4's `order()` sorts by ORDERABILITY (`Order.asc`/`desc` compare through
// `GremlinValueComparator.ORDERABILITY` — `vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Order.java:85-88`),
// a total order over every type that RECURSES into a collection: a list or a path compares element-wise
// (`iterableComparator`), a map by its sorted entry-set (`mapComparator`). Recursion-free SQL cannot state
// that compare, so a sort whose key is a LIST, a MAP or a PATH (`path().order()`, `order().by(__.labels()
// .order().fold())`) has no `ORDER BY` — the inline `orderRows` declines it.
//
// The value-transform barrier (`order-dedup-local.ts` `buildOrderGlobalSegment`) answers the special case
// where the KEY IS THE WHOLE TRAVERSER: it sorts the values in JS and re-injects them. That cannot serve
// either a `by()` key (the traverser is not its key — an element ordered by a list of its labels must come
// back as the ELEMENT) or a traverser that carries more than its value (`as('head').path().order()
// .select('head')` reads the ALIAS channel, which a re-injected value has lost). So this is the other
// half of the same barrier, and it re-injects a RANK rather than a value:
//
//  1. HEAD — the chain up to the `order()` is lowered with the step marked `keys`; `orderRows`, finding
//     no SQL comparator, hands back the key TUPLE of every traverser as one JSON text (`orderKeyTuple`:
//     each `by()` as the self-describing `{t,v}` node the typed tree already frames, `byNode`).
//  2. JS — the distinct key texts are sorted by the SAME `orderability.ts` comparator `order(Scope.local)`
//     uses (per `by()`, its own direction — `OrderGlobalStep`'s `MultiComparator`), and DENSE-ranked, so
//     two keys ORDERABILITY calls equal share a rank and the arrival tie-break keeps the sort STABLE
//     (`Collections.sort` is).
//  3. RESUME — the WHOLE chain is lowered again with the step marked `ranks`; `orderRows` now computes the
//     same key text, JOINS it to the ranking carried in ONE `json_each` bind (a data-sized set crosses as
//     one value — root `CLAUDE.md`; `rankJoin`), and re-mints the emission order on `(rank, arrival)`.
//     Every carried channel — an alias, the path, a sack — rides through untouched, because the traverser
//     never left SQL.
//
// The key text is compared by BYTE EQUALITY across two statements, which is sound only when both see the
// SAME traversers: both compute it with the one expression over the one graph state, a chain that writes
// declines (`lowerRankHead`) rather than ranking keys a mutation could have moved, and a chain that DRAWS
// (`sample`, `coin`, a `shuffle` — `nondeterministic`) declines rather than ranking one random stream and
// sorting another. Whatever slips past both — a key the resume meets that the head never ranked — fails
// the resume statement (`rankJoin`), never sorts as an unranked NULL.

import { isNested, isOrderArg, stepChain } from '../../gremlin/frontend.ts';
import { col, compilerInt, compilerNull, compilerText, eq, isNot, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { IRStep } from '../ir/strategies.ts';
import type { ChildHost, ChildSeam } from './child.ts';
import { jsonEachSet, jsonOf, listNode, mapNode, meta, typeOf, type Minter } from './build.ts';
import { listNodeExpr } from './list.ts';
import { byNode, orderProductivity, type Modulation } from './modulator.ts';
import { orderabilityCompare } from './orderability.ts';
import { parseExactJson } from '../../json-exact.ts';
import type { GraphSource } from './source.ts';

/** One `order()` step's place in the two-statement protocol — which statement is being lowered. `keys`
 *  is the HEAD's: `orderRows` deposits the keyed relation in `sink`. `ranks` is the RESUME's: the sorted
 *  dense ranks the JS step computed, bound under `param`. */
export type RankedOrder =
  | { readonly kind: 'keys'; readonly sink: RankSink }
  | { readonly kind: 'ranks'; readonly ranks: readonly (readonly [string, number])[]; readonly param: string };

/** What the head's `orderRows` hands back: the relation whose `ORDER_KEY` column holds each traverser's
 *  key text, and each key position's direction (the JS sort needs them; the key text does not carry them). */
export interface RankSink {
  rel?: Rel;
  dirs?: readonly ('asc' | 'desc')[];
}

/** The `order()` steps a lowering is ranking, keyed by STEP IDENTITY — the head and the resume lower the
 *  very same `IRStep[]`, so the object names the step without a position that a rewrite could shift. A
 *  nested (child-body) `order()` is a different object and never matches, so it keeps declining. */
export type RankedOrders = ReadonlyMap<IRStep, RankedOrder>;

/** The column each traverser's key text is projected into. */
export const ORDER_KEY = 'ok';

/** The column the resume projects a traverser's rank into. */
export const ORDER_RANK = 'rk';

/**
 * The key TUPLE of one traverser as a JSON TEXT expression — one `{t,v}` node per `by()` (an identity
 * `order()` is one identity key) — plus each position's direction and the productivity drop, or `null`
 * to decline.
 *
 * A key node is `byNode`'s self-describing member node, the encoding the map/path framers already read,
 * so whatever a `group().by(…)` can key on, this can order on. The identity key over a COLLECTION host is
 * the collection itself (`listNode`/`mapNode`); over an element it is the element node (ORDERABILITY
 * compares elements by `id()` — `elementComparator` — which the node carries as its external id). A RECORD
 * identity declines: it is a `Map` whose entries are fields of mixed shape, and there is no witness yet.
 * `shuffle` declines — it has no key at all, and `sortTerms` already answers it alone.
 */
export function orderKeyTuple(
  step: IRStep, bys: readonly Modulation[], host: ChildHost, source: GraphSource, fresh: Minter, child: ChildSeam,
): { readonly key: Expr; readonly dirs: readonly ('asc' | 'desc')[]; readonly required: readonly number[] } | null {
  const parsed: readonly Modulation[] = bys.length ? bys : [{ key: { kind: 'identity' } }];
  if (parsed.some((modulation) => modulation.order === 'shuffle')) return null;
  const nodes: Expr[] = [];
  const required: number[] = [];
  parsed.forEach((modulation, i) => {
    const node = modulation.key.kind === 'identity' ? identityNode(host, source, fresh) : byNode(modulation, host, source, fresh, child);
    if (!node) return;
    nodes.push(node);
    // The SAME productivity rule the SQL sort applies — `OrderGlobalStep.processAllStarts` keeps a
    // traverser only where every comparator traversal was productive (`orderProductivity`'s citation).
    // Reported as a POSITION in the tuple rather than a predicate over the host, so the caller tests
    // the materialized key text instead of re-evaluating the key's correlated reads.
    if (orderProductivity(step, modulation, node)) required.push(i);
  });
  if (nodes.length !== parsed.length) return null;
  const key: Expr = { kind: 'call', fn: 'json_array', args: nodes.map((node) => jsonOf(node)) };
  return { key, dirs: parsed.map((modulation) => (modulation.order === 'desc' ? 'desc' : 'asc')), required };
}

/** The productivity drop over a MATERIALIZED key text: every `required` position produced a node (a
 *  non-productive `by()` leaves SQL NULL, which `json_array` stores as JSON `null` and `json_extract`
 *  reads back as SQL NULL — a produced node is always an object). `undefined` when nothing can drop. */
export function keyProductive(keyText: Expr, required: readonly number[]): Expr | undefined {
  return required
    .map((i): Expr => ({
      kind: 'binary', op: 'is not',
      left: { kind: 'call', fn: 'json_extract', args: [keyText, compilerText(`$[${i}]`)] },
      right: compilerNull(),
    }))
    .reduce<Expr | undefined>((left, right) => (left ? { kind: 'binary', op: 'and', left, right } : right), undefined);
}

/** A bare `by()`'s key — the traverser itself as a member node. */
function identityNode(host: ChildHost, source: GraphSource, fresh: Minter): Expr | null {
  if (host.kind === 'list') {
    const members = listNodeExpr(host.list, host.of, source, fresh);
    return members && listNode(members);
  }
  if (host.kind === 'map') return mapNode(jsonOf(host.map));
  if (host.kind === 'element') return source.elementNode(host.elem, host.id, fresh);
  if (host.kind === 'record') return null;
  // A scalar/property identity is `byNode`'s own answer (a `{t,v}` node / the VertexProperty node).
  return byNode({ key: { kind: 'identity' } }, host, source, fresh);
}

/**
 * The keyed relation JOINED to its ranks — every input column plus `ORDER_RANK`.
 *
 * The ranking is a RELATION, joined ONCE: the one `json_each` bind exploded into `(key text, rank)` rows,
 * MATERIALIZED, and LEFT-joined on key equality. A correlated scalar lookup per traverser instead
 * re-parses and scans the whole k-key bind for each of n traversers — O(n·k) JSON work (measured: 5.4 s
 * at 1,000 vertices, 406 s at 8,000, against milliseconds for the scalar sort) — where an equi-join over
 * a materialized side is what SQLite builds an automatic index for. It is the rewrite Calcite's
 * `SubQueryRemoveRule.rewriteScalarQuery` makes of the same correlated scalar: a LEFT join on the
 * correlating predicate (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/SubQueryRemoveRule.java:132-143`);
 * the keys are DISTINCT (`rankKeys`), so the join neither duplicates nor drops a traverser.
 *
 * **A traverser whose key the head never ranked FAILS THE STATEMENT, never sorts as NULL** (NULL sorts
 * first, so a silent miss is an unsorted answer). The two statements agree on the key set only when the
 * prefix answers the same traversers twice; a prefix that is visibly random declines up front
 * (`nondeterministic`), and this is the backstop for whatever that syntactic proof cannot see (an
 * unordered slice whose rows SQLite picks per plan). SQL cannot raise a message of its own, so the miss
 * is spent as a JSON PATH: `json_extract` rejects it as `bad JSON path: '<UNRANKED_KEY>'`, which carries
 * the diagnosis. The path reads the row's own key column, so no constant-folding can hoist it out of
 * the `CASE` that guards it.
 */
export function rankJoin(keyed: Rel, ranked: Extract<RankedOrder, { kind: 'ranks' }>, fresh: Minter): Rel {
  const pairs = jsonEachSet(ranked.param, ranked.ranks, fresh);
  const at = (path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [col(pairs.id, 'sv'), compilerText(path)] });
  const rankingType = typeOf(meta(RANKED_KEY, 'text'), meta(RANKED_RANK, 'int'));
  // FENCED: a plain CTE referenced once is flattened back into the join, which re-exposes the per-row
  // `json_each` scan; `AS MATERIALIZED` keeps it one table SQLite can auto-index on `RANKED_KEY`.
  const ranking = make.materialize({
    id: fresh('rkm'), channels: [], type: rankingType, fenced: true,
    input: make.project({ id: fresh('rkp'), input: pairs, channels: [], type: rankingType, exprs: [[RANKED_KEY, at('$[0]')], [RANKED_RANK, at('$[1]')]] }),
  });
  const joined = make.join({
    id: fresh('rkj'), left: keyed, right: ranking, join: 'left', channels: keyed.channels,
    type: typeOf(...keyed.type.cols, meta(RANKED_KEY, 'text', true), meta(RANKED_RANK, 'int', true)),
    on: eq(col(ranking.id, RANKED_KEY), col(keyed.id, ORDER_KEY)),
  });
  const rank = col(joined.id, RANKED_RANK);
  const unranked: Expr = {
    kind: 'call', fn: 'json_extract', args: [compilerText('null'), {
      kind: 'binary', op: '||', left: compilerText(UNRANKED_KEY),
      right: { kind: 'call', fn: 'substr', args: [col(joined.id, ORDER_KEY), compilerInt(1), compilerInt(0)] },
    }],
  };
  return make.project({
    id: fresh('rkr'), input: joined, channels: keyed.channels,
    type: typeOf(...keyed.type.cols, meta(ORDER_RANK, 'int')),
    exprs: [...keyed.type.cols.map((column) => [column.name, col(joined.id, column.name)] as const),
      [ORDER_RANK, { kind: 'case', whens: [[isNot(rank, compilerNull()), rank]], else: unranked }]],
  });
}

/** What a missing rank raises, as `bad JSON path: '<this>'` — exported so a test names the one message. */
export const UNRANKED_KEY = 'order() ranked barrier: a traverser key the head never ranked (the prefix answered differently across its two statements)';

/** The ranking relation's two columns — distinct from every traverser column, all of which the join keeps. */
const RANKED_KEY = 'rkk';
const RANKED_RANK = 'rkv';

/**
 * Does a chain hold a step whose answer is RANDOM — `sample()`, `coin()`, an `Order.shuffle` anywhere
 * (`order().by(shuffle)`, `order(local).by(shuffle)`) — at ANY depth: a `by()` body, a branch arm, a
 * repeat body? Such a prefix answers different traversers in the head and the resume — each draws from
 * an unseeded `java.util.Random` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/CoinStep.java:39,70`,
 * `.../step/filter/SampleGlobalStep.java:51,122`, and `Order.shuffle` is only a marker that
 * `.../step/map/OrderGlobalStep.java:76` answers with `traverserSet.shuffle(random)`) — so ranking its
 * keys in one statement and sorting by them in the other is ranking a different stream. A body that does
 * not normalize is treated as random — fail closed.
 */
export function nondeterministic(steps: readonly IRStep[], params: Record<string, any>): boolean {
  const random = (value: unknown): boolean => {
    if (isOrderArg(value)) return value.order === 'shuffle';
    if (isNested(value)) {
      let body: readonly IRStep[];
      try { body = stepChain(value.nested, params) as IRStep[]; } catch { return true; }
      return nondeterministic(body, params);
    }
    if (value == null || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(random);
    return ('value' in value && random((value as { value: unknown }).value))
      || ('operands' in value && random((value as { operands: unknown }).operands));
  };
  return steps.some((step) => RANDOM_STEPS.has(step.name)
    || (step.args ?? []).some((a) => random(a.value))
    || (step.modulators ?? []).some((m) => m.some(random))
    || nondeterministic([...(step.repeatRegion ?? []), ...(step.optionArms ?? [])] as IRStep[], params));
}

/** The steps that DRAW — their answer is a random choice, not a function of the graph. */
const RANDOM_STEPS: ReadonlySet<string> = new Set(['sample', 'coin']);

/**
 * THE JS STEP — the head's key texts to `[keyText, denseRank]` pairs, sorted. Each text is a JSON array
 * of member nodes (`orderKeyTuple`); position `i` compares by ORDERABILITY under `dirs[i]` (`Order.desc`
 * is `ORDER.compare(second, first)` — `Order.java:74-78`), the first non-zero position deciding, which is
 * `OrderGlobalStep`'s comparator chain. Equal-comparing keys share a rank — a `1` and a `1.0` are one
 * ORDERABILITY class even though their texts differ — so the resume's arrival tie-break, not text order,
 * decides between them.
 */
export function rankKeys(texts: readonly unknown[], dirs: readonly ('asc' | 'desc')[]): (readonly [string, number])[] {
  const distinct = [...new Set(texts.map((text) => String(text)))].map((text) => [text, parseExactJson(text) as unknown[]] as const);
  const compare = (a: readonly unknown[], b: readonly unknown[]): number => {
    for (let i = 0; i < dirs.length; i++) {
      const c = orderabilityCompare(a[i] ?? null, b[i] ?? null);
      if (c !== 0) return dirs[i] === 'desc' ? -c : c;
    }
    return 0;
  };
  distinct.sort((a, b) => compare(a[1], b[1]));
  const ranks: (readonly [string, number])[] = [];
  let rank = 0;
  distinct.forEach(([text, key], i) => {
    if (i > 0 && compare(distinct[i - 1]![1], key) !== 0) rank++;
    ranks.push([text, rank]);
  });
  return ranks;
}
