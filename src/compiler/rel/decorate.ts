import { col, compilerInt, compilerText, param, type Expr } from '../../rel/expr.ts';
import * as make from '../../rel/factory.ts';
import type { Rel } from '../../rel/rel.ts';
import { carriedCols, elementCols, eq, meta, typeOf, type Minter } from './build.ts';
import { BaseGraph, type GraphSource } from './source.ts';

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
// The relation crosses the segment boundary as ONE `json_each` bind and is declared ONCE as a fenced
// binding (`decorateBinding`); every read references it by name (a `Ref`), so it is computed once
// (materialize-once, exactly `lowerForeignResume`'s model). `id` is the INTERNAL element rowid (the
// correlation key `BaseGraph` uses); `cval` is the algorithm's per-element value.

/** The two columns the landed `(id → value)` relation (and every `Ref` to it) declares. `cval` is
 *  `any` because the value's storage class is the algorithm's (a TEXT component id for WCC, a REAL
 *  score for pageRank). */
const DECORATE_COLS = [meta('id', 'int'), meta('cval', 'any', true)] as const;

/** Land the barrier's `(id, value)` pairs as a fenced Plan binding: an array of `[id, value]` pairs
 *  crosses as ONE `json_each` bind (never one bind per row — the DO 100-bind wall), each row's id and
 *  value recovered by `json_extract`. Returned as the binding NODE; the caller pairs it with `name`. */
export function decorateBinding(pairs: readonly (readonly [number, unknown])[], name: string, fresh: Minter): Rel {
  const source: Expr = { kind: 'call', fn: 'jsonb', args: [param(JSON.stringify(pairs), name)] };
  const exploded = make.explode({
    id: fresh('decx'), channels: [], expr: source, as: { value: 'pair' },
    type: typeOf(meta('pair', 'json', true)),
  });
  const extract = (path: string): Expr => ({ kind: 'call', fn: 'json_extract', args: [col(exploded.id, 'pair'), compilerText(path)] });
  const projected = make.project({
    id: fresh('decp'), input: exploded, channels: [], type: typeOf(...DECORATE_COLS),
    exprs: [['id', extract('$[0]')], ['cval', extract('$[1]')]],
  });
  return make.materialize({ id: fresh('decm'), input: projected, channels: [], type: typeOf(...DECORATE_COLS), name, fenced: true });
}

/** A GraphSource wrapping `BaseGraph`, answering the ONE decorated `key` off the landed relation named
 *  `bindingName` and delegating everything else (and every other key) to the base. `vtype` is the
 *  decorated value's canonical Gremlin type, used only to frame a `values(key)` read. */
export function decorateGraph(bindingName: string, key: string, vtype: string): GraphSource {
  const ref = (fresh: Minter): Rel =>
    make.ref({ id: fresh('dref'), name: bindingName, channels: [], type: typeOf(...DECORATE_COLS) });
  const rowById = (id: Expr, fresh: Minter): Rel => {
    const r = ref(fresh);
    return make.filter({ id: fresh('drow'), input: r, channels: [], type: r.type, pred: eq(col(r.id, 'id'), id) });
  };
  const existsOf = (matched: Rel, fresh: Minter): Expr =>
    ({ kind: 'exists', negated: false, plan: make.project({ id: fresh('dex'), input: matched, channels: [], type: typeOf(meta('one', 'int')), exprs: [['one', compilerInt(1)]] }) });

  return {
    ...BaseGraph,

    // by('key') / order().by('key') / project().by('key') — the decorated value as a correlated scalar.
    // The value is stored under its own storage class (a string component id for WCC), so `ordering`
    // needs no numeric-compare wrap; a numeric-typed score (pageRank) lands this tranche's follow-up.
    propertyScalar(kind, id, k, ordering, fresh) {
      if (k !== key) return BaseGraph.propertyScalar(kind, id, k, ordering, fresh);
      const row = rowById(id, fresh);
      return { kind: 'scalar', plan: make.project({ id: fresh('dps'), input: row, channels: [], type: typeOf(meta('v', 'any', true)), exprs: [['v', col(row.id, 'cval')]] }) };
    },

    // has('key') — EVERY element the algorithm ran over is decorated, so presence is an EXISTS over the
    // landed relation. has('key', value) over a decorated property is not supported yet (fail closed).
    hasPropertyPredicate(kind, id, k, valuePred, fresh) {
      if (k !== key) return BaseGraph.hasPropertyPredicate(kind, id, k, valuePred, fresh);
      if (valuePred) throw new Error(`has("${key}", <value>) over a decorated OLAP property is not supported yet — filter on it after materializing, or use order()/project() by("${key}")`);
      return existsOf(rowById(id, fresh), fresh);
    },

    // values(key) — one traverser per matching value; the decorated property is single-cardinality, so
    // it is a 1:1 JOIN of the stream to the landed relation on id, projected to the base `(v, vtype,
    // pord, channels)` shape so the value tail frames it like any property. `values(name, key)` mixing
    // the decorated key with stored keys is a UNION shape that is not built yet (no scenario needs it).
    propertyValues(input, kind, keys, fresh) {
      if (!keys?.includes(key)) return BaseGraph.propertyValues(input, kind, keys, fresh);
      if (keys.length !== 1)
        throw new Error(`values() mixing the decorated key "${key}" with stored keys is not supported yet`);
      const r = ref(fresh);
      const rp = make.project({ id: fresh('dvr'), input: r, channels: [], type: typeOf(meta('rid', 'int'), meta('rv', 'any', true)),
        exprs: [['rid', col(r.id, 'id')], ['rv', col(r.id, 'cval')]] });
      const joined = make.join({
        id: fresh('dvj'), left: input, right: rp, join: 'inner', ordered: true, channels: input.channels,
        type: typeOf(...elementCols(input.channels), meta('rid', 'int'), meta('rv', 'any', true)),
        on: eq(col(rp.id, 'rid'), col(input.id, 'id')),
      });
      return make.project({
        id: fresh('dvp'), input: joined, channels: input.channels,
        type: typeOf(meta('v', 'any', true), meta('vtype', 'text', true), meta('pord', 'int'), ...carriedCols(input.channels)),
        // A single value per element — `pord` (the multi-value fan-out order) is a constant.
        exprs: [['v', col(joined.id, 'rv')], ['vtype', compilerText(vtype)], ['pord', compilerInt(0)],
          ...input.channels.map((ch) => [ch.col, col(joined.id, ch.col)] as const)],
      });
    },
    valueMapPairs(kind, id, keys, fresh) {
      if (keys?.includes(key)) throw new Error(`valueMap("${key}") over a decorated OLAP property is not supported yet`);
      return BaseGraph.valueMapPairs(kind, id, keys, fresh);
    },
  };
}
