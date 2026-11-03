import { declaredParamTypes, mapSlot, storedScalar, type MapEntryType, type TypeNode } from './types.ts';

/**
 * THE PARAMETER ENVIRONMENT — a request's user parameters as ONE value: what each one IS (`values`, a
 * Float or a Binary already on its carrier) and what TYPE it was declared as (`types`, settled by
 * `declaredParamTypes`: the wire's DataType where the channel sent one, the JS value's own otherwise).
 *
 * One value rather than a `params` record with a parallel, optional `paramTypes` beside it, because the
 * optional twin was forgotten at depth: every nested body is re-parsed through `stepChain`, and the
 * re-parses (a `union()` arm, a `local()` body, a strategy's nested criterion) passed `params` alone, so
 * a `Long` parameter written inside a branch was stored — and framed — as the `Int` its JS value spells.
 * With the type inside the env there is nothing separate to forget. A user PARAMETER's type is a
 * first-class IR fact (root `CLAUDE.md`, locked decision 5); this is the one place it is carried.
 */
export interface ParamEnv {
  readonly values: Readonly<Record<string, any>>;
  readonly types: Readonly<Record<string, TypeNode>>;
}

/** The environment of a compile with no user parameters — a param-free analysis, a synthesized body. */
export const NO_PARAMS: ParamEnv = Object.freeze({ values: Object.freeze({}), types: Object.freeze({}) });

/** The scalar types whose JS value a channel delivers is NOT yet the value every other producer of the
 *  type lands on: a Float (a GLV's float32 widening — `floatCanonical`) and a Binary (a `Buffer` —
 *  `binaryCarrier`). `storedScalar` is the one authority for both carriers. */
const LANDED = new Set<TypeNode>(['float', 'binary']);

/** One value, at any depth of a collection, with every LANDED scalar on its carrier — and its type node
 *  with it, because a landed map KEY changes the slot its entry types are filed under (`mapSlot`). */
function land(v: any, t: TypeNode | null | undefined): [any, TypeNode | null | undefined] {
  if (v == null || t == null) return [v, t];
  if (typeof t !== 'object') return [LANDED.has(t) ? storedScalar(v, t) : v, t];
  if (t.t === 'map') {
    if (!(v instanceof Map)) return [v, t];
    const entries: Record<string, MapEntryType | null> = {};
    const out = new Map<any, any>();
    for (const [k, x] of v) {
      const e = t.entries[mapSlot(k)];
      const [lk, kt] = land(k, e?.key);
      const [lx, xt] = land(x, e?.value);
      out.set(lk, lx);
      entries[mapSlot(lk)] = e ? { key: kt ?? null, value: xt ?? null } : null;
    }
    return [out, { t: 'map', entries }];
  }
  if (!Array.isArray(v) && !(v instanceof Set)) return [v, t];
  const landed = [...v].map((x, i) => land(x, t.items[i]));
  const values = landed.map(([x]) => x);
  return [v instanceof Set ? new Set(values) : values, { t: t.t, items: landed.map(([, xt]) => xt ?? null) }];
}

/** Build the environment ONCE from what a channel carried: `wireTypes` completed for every parameter it
 *  left untyped (`declaredParamTypes`), then every Float- or Binary-typed value landed on its carrier
 *  (`land`), before anything reads it. */
export function paramEnv(wireParams: Record<string, any>, wireTypes: Record<string, TypeNode> = {}): ParamEnv {
  const declared = declaredParamTypes(wireParams, wireTypes);
  const typed = Object.keys(declared).filter((k) => k in wireParams);
  if (typed.length === 0) return { values: wireParams, types: declared };
  const values = { ...wireParams };
  const types = { ...declared };
  for (const k of typed) {
    const [v, t] = land(wireParams[k], declared[k]);
    values[k] = v;
    if (t != null) types[k] = t;
  }
  return { values, types };
}
