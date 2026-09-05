import { col, compilerInt, compilerText, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import type { Binding } from '../../rel/plan.ts';
import { and, carriedCols, elementCols, eq, jsonOf, meta, renumber, typedNode, typeOf, VALUEMAP_PAIR, type Minter } from './build.ts';
import { type GraphSource } from './source.ts';

// ---------- DecorateGraph — a GraphSource that answers ONE synthetic property off a landed relation ----------
//
// The element-preserving tail of an OLAP algorithm (pageRank/connectedComponent/peerPressure). The
// native step runs a GLOBAL compute (a barrier) whose product is an `(id → value)` relation, then
// DECORATES each incoming element with its value under a canonical property key and passes the element
// THROUGH — so `has(key)`, `order().by(key)`, `project().by(key)`, `values(key)` all compose over the
// live stream. The value is NOT a stored property; it is read from the barrier's landed relation,
// correlated on the element id — exactly as `BoundGraph` rejoins a landed graph, but wrapping the base
// graph and intercepting ONE key rather than replacing the whole source.
//
// The relation lives in SQL — the algorithm's `apply` computed it into `barrier_state` under a
// per-query `run` token (`src/storage.ts`), so `decorateBinding` READS it there rather than crossing the
// vector as a bind. It is declared ONCE as a fenced binding; every read references it by name (a `Ref`),
// so it is materialized once (materialize-once, exactly `lowerForeignResume`'s model). `id` is the
// INTERNAL element rowid (the correlation key `BaseGraph` uses); `cval` is the algorithm's per-element value.

/** The two columns the landed `(id → value)` relation (and every `Ref` to it) declares. `cval` is
 *  `any` because the value's storage class is the algorithm's (a TEXT component id for WCC, a REAL
 *  score for pageRank). */
const DECORATE_COLS = [meta('id', 'int'), meta('cval', 'any', true)] as const;

/** The CTE name a decorate layer's landed relation is declared under — DERIVED from the globally-unique
 *  barrier `run` token (`store.allocBarrierRun()`), not minted per lowering. That determinism is what
 *  lets TWO independent statements (a second barrier's head and the final resume) each declare the SAME
 *  layer's binding and have `decorateGraph`'s `Ref`s resolve to it, and what keeps two STACKED layers'
 *  names distinct (their runs differ) so both CTEs coexist in one statement. */
const decorateName = (run: number, channel: number): string => `_mogwai_decorate_r${run}_c${channel}`;

/** Land the barrier's `(id → value)` relation as a fenced Plan binding: a SCAN of `barrier_state`
 *  (the OLAP scratch table — `src/storage.ts`) filtered to this query's `run`, its final `round` slot,
 *  and the NODE-KEYED SINGLE-SCALAR cell (`scope = 0 AND channel = 0`), projected to `(id, cval)`.
 *  `run`/`round` are compiler-held constants, inlined as SQL literals (never binds), so the plan's bind
 *  count and text size are O(1) regardless of |V| — the whole point of keeping the vector SQL-resident.
 *  Returned as the binding NODE; the caller pairs it with `name`.
 *
 *  **The `scope=0 AND channel=<channel>` pin is load-bearing, not decoration.** `(run, round)` alone
 *  selects EVERY channel/scope a run holds, so a multi-channel algorithm (HITS hub+auth) or a non-zero
 *  scope would return several rows per id and the decorate join would silently multiply the stream.
 *  Pinned to the ONE `(scope=0, channel)` cell, it reads exactly that property — the same shape `VEC`
 *  carries. A multi-channel decorate is one binding PER channel (the resume stacks a layer each). */
function decorateBinding(run: number, round: number, channel: number, name: string, fresh: Minter): Rel {
  const scan = make.scan({
    id: fresh('decs'), table: 'barrier_state', alias: fresh('rbr'), channels: [],
    type: typeOf(meta('run', 'int'), meta('round', 'int'), meta('scope', 'int'), meta('id', 'int'), meta('channel', 'int'), meta('cval', 'any', true)),
  });
  const filtered = make.filter({
    id: fresh('decf'), input: scan, channels: [], type: scan.type,
    pred: and(
      and(eq(col(scan.id, 'run'), compilerInt(run)), eq(col(scan.id, 'round'), compilerInt(round))),
      and(eq(col(scan.id, 'scope'), compilerInt(0)), eq(col(scan.id, 'channel'), compilerInt(channel))),
    ),
  });
  const projected = make.project({
    id: fresh('decp'), input: filtered, channels: [], type: typeOf(...DECORATE_COLS),
    exprs: [['id', col(filtered.id, 'id')], ['cval', col(filtered.id, 'cval')]],
  });
  return make.materialize({ id: fresh('decm'), input: projected, channels: [], type: typeOf(...DECORATE_COLS), name, fenced: true });
}

/** A GraphSource STACKING one decorated `key` over an arbitrary `base` source: it answers `key` off its
 *  own landed `(run, round)` relation and delegates everything else — every other key, and the base's own
 *  decorated keys when `base` is itself a `decorateGraph` — to `base`. So `pageRank().connectedComponent()`
 *  wraps the pageRank layer around the wcc layer around `BaseGraph`, and both scores read on the live
 *  stream. It DECLARES its own binding (and, transitively, the whole stack's) via `bindings()`, collected
 *  once at `lowered()` — the caller no longer threads the binding into effects by hand. `vtype` is the
 *  decorated value's canonical Gremlin type, used only to frame a `values(key)` read. */
export function decorateGraph(base: GraphSource, run: number, round: number, channel: number, key: string, vtype: string): GraphSource {
  const bindingName = decorateName(run, channel);
  const ref = (fresh: Minter): Rel =>
    make.ref({ id: fresh('dref'), name: bindingName, channels: [], type: typeOf(...DECORATE_COLS) });
  const rowById = (id: Expr, fresh: Minter): Rel => {
    const r = ref(fresh);
    return make.filter({ id: fresh('drow'), input: r, channels: [], type: r.type, pred: eq(col(r.id, 'id'), id) });
  };
  const existsOf = (matched: Rel, fresh: Minter): Expr =>
    ({ kind: 'exists', negated: false, plan: make.project({ id: fresh('dex'), input: matched, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] }) });

  return {
    ...base,

    // The stack's bindings: the base's (if it is itself a decorateGraph) then THIS layer's landed
    // relation, so `lowered()` declares every OLAP algorithm's CTE the statement reads through.
    bindings(fresh: Minter): readonly Binding[] {
      const own: Binding = { name: bindingName, node: decorateBinding(run, round, channel, bindingName, fresh) };
      return [...(base.bindings?.(fresh) ?? []), own];
    },

    // by('key') / order().by('key') / project().by('key') — the decorated value as a correlated scalar.
    // The value is stored under its own storage class (a string component id for WCC), so `ordering`
    // needs no numeric-compare wrap; a numeric-typed score (pageRank) lands this tranche's follow-up.
    propertyScalar(kind, id, k, ordering, fresh) {
      if (k !== key) return base.propertyScalar(kind, id, k, ordering, fresh);
      const row = rowById(id, fresh);
      return { kind: 'scalar', plan: make.project({ id: fresh('dps'), input: row, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', col(row.id, 'cval')]] }) };
    },

    // has('key') — EVERY element the algorithm ran over is decorated, so presence is an EXISTS over the
    // landed relation. has('key', value) filters that EXISTS by the value comparison, exactly as
    // `BaseGraph` does over a stored property's row: the value is single-cardinality (`cval`), so
    // `EXISTS(cval matches pred)` is the whole test.
    hasPropertyPredicate(kind, id, k, valuePred, fresh) {
      if (k !== key) return base.hasPropertyPredicate(kind, id, k, valuePred, fresh);
      const row = rowById(id, fresh);
      if (!valuePred) return existsOf(row, fresh);
      // `vtype` is the decorated value's canonical Gremlin type — a compile-time CONSTANT, because a
      // decorate layer holds one type for its key (there is no per-row `vtype` column as the stored
      // property tables have). Handing it to the caller's callback gives the same vtype-aware compare a
      // stored property's per-row `vtype` gives — so `has(pageRankKey, P.gt(0.15))` compares the REAL
      // score numerically and `has(componentKey, "lop")` the TEXT id as text. A predicate the caller
      // cannot build DECLINES the whole clause (`null`), never a silent presence-only fallback —
      // the `GraphSource` contract (`source.ts`), and fail-closed per the root CLAUDE.md.
      const matches = valuePred(col(row.id, 'cval'), compilerText(vtype));
      if (!matches) return null;
      return existsOf(make.filter({ id: fresh('dhf'), input: row, channels: [], type: row.type, pred: matches }), fresh);
    },

    // values(key) — one traverser per matching value; the decorated property is single-cardinality, so
    // it is a 1:1 JOIN of the stream to the landed relation on id, projected to the base source's
    // `(v, vtype, …channels)` shape so the value tail frames it like any property AND it can UNION with
    // the base's stored-key values for a mixed `values(key, storedKey)`.
    propertyValues(input, kind, keys, fresh) {
      // `keys === null` is EVERY key, which INCLUDES this decorated one (the score persists into the
      // continuation — `VertexComputeKey.of(property, /*transient*/ false)`, `PageRankVertexProgram`), so
      // only a non-null list that omits our key delegates wholesale — the `valueMapPairs` guard exactly.
      if (keys !== null && !keys.includes(key)) return base.propertyValues(input, kind, keys, fresh);

      // This layer's one decorated value per element, in the base source's value shape (no `pord`: a
      // single-cardinality value has no fan-out to order, and matching the base shape is what lets the
      // two UNION positionally).
      const r = ref(fresh);
      const rp = make.project({ id: fresh('dvr'), input: r, channels: [], type: typeOf(meta('rid', 'int'), meta('rv', 'any', true)),
        exprs: [['rid', col(r.id, 'id')], ['rv', col(r.id, 'cval')]] });
      const joined = make.join({
        id: fresh('dvj'), left: input, right: rp, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...elementCols(input.channels), meta('rid', 'int'), meta('rv', 'any', true)),
        on: eq(col(rp.id, 'rid'), col(input.id, 'id')),
      });
      const dec = make.project({
        id: fresh('dvp'), input: joined, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)),
        exprs: [['v', col(joined.id, 'rv')], ['vtype', compilerText(vtype)],
          ...input.channels.map((ch) => [ch.col, col(joined.id, ch.col)] as const)],
      });

      // `null` stored keys → EVERY stored key (bare `values()`); else the asked keys minus ours.
      const baseKeys = keys === null ? null : keys.filter((k) => k !== key);
      if (baseKeys !== null && baseKeys.length === 0) return dec; // values(key) alone — the decorated key only.

      // MIXED with stored keys: the answer is the base's stored-key values UNIONed with this one
      // decorated value. `values(k1,k2)` is ORDER-FREE across keys — TinkerPop `Element.values` maps over
      // the provider's own `properties()` iteration and `PropertiesStep` hashes key-order-insensitively
      // (`vendor/tinkerpop/gremlin-core/.../map/{PropertiesStep,Element}.java`), and the cucumber harness
      // compares bags — so the correct answer is the MULTISET and any DETERMINISTIC emission is valid.
      const baseVals = base.propertyValues(input, kind, baseKeys, fresh);
      const arriving = input.channels.find((ch) => ch.role === 'encounter');
      if (!arriving) return make.union({ id: fresh('dvu'), inputs: [baseVals, dec], all: true, channels: input.channels, type: baseVals.type });

      // A terminal `values()` DEMANDS an encounter (`computeDemandsEncounter`), and the base fan-out was
      // renumbered into a fresh dense encounter while this 1:1 arm carries the parent's — so their
      // encounters OVERLAP and a bare UNION is order-unstable (`test:perturbed`). Tag each side and
      // re-mint ONE total order: stored values first in their refined order (`dord` 0), the single
      // decorated value last (`dord` 1) — the `valueMapPairs` slot convention, one deterministic pick
      // among the order-free options. `(dord, encounter)` is unique per row, so the rank is total.
      const withDord = typeOf(meta('v', 'any', true), meta('vtype', 'text', true), meta('dord', 'int'), ...carriedCols(input.channels));
      const tagged = (rel: Rel, dord: number): Rel => make.project({
        id: fresh('dvt'), input: rel, channels: input.channels, type: withDord,
        exprs: [['v', col(rel.id, 'v')], ['vtype', col(rel.id, 'vtype')], ['dord', compilerInt(dord)],
          ...input.channels.map((ch) => [ch.col, col(rel.id, ch.col)] as const)],
      });
      const unioned = make.union({ id: fresh('dvu'), inputs: [tagged(baseVals, 0), tagged(dec, 1)], all: true, channels: input.channels, type: withDord });
      return renumber(
        unioned,
        [{ expr: col(unioned.id, 'dord'), dir: 'asc' }, { expr: col(unioned.id, arriving.col), dir: 'asc' }],
        [meta('v', 'any', true), meta('vtype', 'text', true), ...carriedCols(input.channels)],
        input.channels, fresh,
      );
    },
    // valueMap(…keys…) — one (key, values[], ord) row per key. The decorated key contributes ONE row:
    // its value as a single-element typed list `[{t: vtype, v: cval}]` (so a REAL score frames as a
    // Double, not the raw json number), correlated on the element id. Mixed with stored keys → a UNION
    // of the base pairs and this row; other keys alone → the base.
    valueMapPairs(kind, id, keys, fresh) {
      if (keys !== null && !keys.includes(key)) return base.valueMapPairs(kind, id, keys, fresh);
      const r = ref(fresh);
      const row = make.filter({ id: fresh('dvmf'), input: r, channels: [], type: r.type, pred: eq(col(r.id, 'id'), id) });
      const decorateRow = make.project({
        id: fresh('dvmp'), input: row, channels: [],
        type: typeOf(meta(VALUEMAP_PAIR.key, 'text'), meta(VALUEMAP_PAIR.values, 'json'), meta(VALUEMAP_PAIR.ord, 'int')),
        exprs: [
          [VALUEMAP_PAIR.key, compilerText(key)],
          [VALUEMAP_PAIR.values, { kind: 'call', fn: 'json_array', args: [jsonOf(typedNode(col(row.id, 'cval'), compilerText(vtype)))] }],
          // valueMap is an unordered map; a fixed ord past any stored key's rank is a stable, harmless slot.
          [VALUEMAP_PAIR.ord, compilerInt(1_000_000)],
        ],
      });
      const baseKeys = keys ? keys.filter((k) => k !== key) : null;
      if (baseKeys && baseKeys.length === 0) return decorateRow;
      const basePairs = base.valueMapPairs(kind, id, baseKeys, fresh);
      // Distinct keys on each side (the decorate key is not stored) — UNION ALL, no dedup.
      const unioned = make.union({ id: fresh('dvmu'), inputs: [basePairs, decorateRow], all: true, channels: [], type: basePairs.type });
      // A UNION strips SQLite's JSON subtype from the `values` column, so the caller's `{t:'list', v:…}`
      // wrap would embed it as TEXT (and `frameTypedNode` would do `.map` on a string). Re-apply `json()`
      // to restore the subtype — the values array embeds as a nested array again.
      return make.project({
        id: fresh('dvmr'), input: unioned, channels: [], type: unioned.type,
        exprs: [
          [VALUEMAP_PAIR.key, col(unioned.id, VALUEMAP_PAIR.key)],
          [VALUEMAP_PAIR.values, jsonOf(col(unioned.id, VALUEMAP_PAIR.values))],
          [VALUEMAP_PAIR.ord, col(unioned.id, VALUEMAP_PAIR.ord)],
        ],
      });
    },
  };
}
