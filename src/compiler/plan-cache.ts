import type { Plan } from './segment.ts';
import type { ParamEnv } from '../gremlin/param-env.ts';

// ---------- the compiled-plan cache ----------
//
// A compile is a PURE function of its request: the Gremlin text, the user parameters (value AND
// declared type), the federation depth and the detached mode, under one app scope (its registry and
// fast paths are fixed for the scope's life). It never reads the store — the Worker edge compiles with
// no store at all (`createCompileScope`) — so a plan stays right across writes. That is why the cache
// lives on the APP scope (`scopes.ts`): per graph on a Durable Object, per manager on the edge, one
// implementation for Bun, the DO and the edge.
//
// WHAT IS CACHED is only a `{kind:'sql'}` plan: a read or a rendered write program, which is plain data
// (it already crosses an RPC by structured clone). Never cached, by `compilePlan`:
//  - a failed compile (it throws before the insert);
//  - a SEGMENT plan — its resume compiles against the rows the head landed, which is execution;
//  - a compile with a caller-held budget (the caller reads the meter, so the compile must run);
//  - a compile without an app scope (there is no scope to hold the entry);
//  - a params value this module cannot spell canonically, or whose spelling is large (a bulk-upsert
//    list parameter) — simply not cached, never a decline;
//  - a VOLATILE query: one whose text reads the clock (`datetime()`, `isVolatileQuery`).
//
// SCOPE OF v1: the key holds every parameter VALUE, so it serves a repeated IDENTICAL request (a
// latency lane, polling, a dashboard). One text sent with varying parameters gets no hit; that is the
// deferred "pin-on-read parameters" item in `docs/2026-11-25-ldbc-findings-plan.md`.

/** The most entries one app scope holds. The same bound as the parse cache (`parseGremlin`). */
export const PLAN_CACHE_MAX_ENTRIES = 512;
/** The most rendered text one app scope holds — a Durable Object isolate has about 128 MB. */
export const PLAN_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/** A parameter spelling past this is not cached: it would pin its size in the key for no likely hit. */
export const PLAN_CACHE_MAX_PARAM_KEY = 4096;

export interface PlanCacheStats { readonly hits: number; readonly misses: number; readonly size: number; readonly bytes: number }

interface Entry { readonly plan: Plan; readonly bytes: number }

/** A bounded LRU of compiled plans, by entry count AND by total text size. A JS `Map` iterates in
 *  insertion order, so delete-then-set moves an entry to the most-recently-used end. */
export class PlanCache {
  private readonly entries = new Map<string, Entry>();
  private hitCount = 0;
  private missCount = 0;
  private totalBytes = 0;

  constructor(readonly maxEntries = PLAN_CACHE_MAX_ENTRIES, readonly maxBytes = PLAN_CACHE_MAX_BYTES) {}

  get(key: string): Plan | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) { this.missCount++; return undefined; }
    this.hitCount++;
    this.entries.delete(key); this.entries.set(key, hit);
    return hit.plan;
  }

  /** Insert a plan, deep-frozen so a caller that mutates a shared plan fails at once. A plan larger
   *  than the whole byte budget is not held. */
  set(key: string, plan: Plan): void {
    const bytes = key.length + freezeAndMeasure(plan);
    const old = this.entries.get(key);
    if (old !== undefined) { this.entries.delete(key); this.totalBytes -= old.bytes; }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { plan, bytes });
    this.totalBytes += bytes;
    for (const [k, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.totalBytes <= this.maxBytes) break;
      this.entries.delete(k); this.totalBytes -= e.bytes;
    }
  }

  stats(): PlanCacheStats {
    return { hits: this.hitCount, misses: this.missCount, size: this.entries.size, bytes: this.totalBytes };
  }
}

/** Deep-freeze a plan's plain data and return the length of the text it holds (its SQL and string
 *  binds — the part that grows). A typed array cannot be frozen and is counted by its byte length. */
function freezeAndMeasure(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (value === null || typeof value !== 'object') return 0;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Object.isFrozen(value)) return 0;
  let bytes = 0;
  if (value instanceof Map) for (const [k, v] of value) bytes += freezeAndMeasure(k) + freezeAndMeasure(v);
  else if (value instanceof Set) for (const v of value) bytes += freezeAndMeasure(v);
  else for (const v of Object.values(value)) bytes += freezeAndMeasure(v);
  Object.freeze(value);
  return bytes;
}

/**
 * The cache key of one request, or `null` when the request is not cacheable: a parameter value with
 * no canonical spelling, or parameters whose spelling passes `PLAN_CACHE_MAX_PARAM_KEY`.
 *
 * Parameters are spelled in name order, each with its declared type, so two requests share a key only
 * when the compile reads the same values under the same types. Every distinction the compile can see
 * is kept: a number's sign of zero and NaN (`Object.is`), a bigint from a number, a Map from an
 * object, the order of a Map's, a Set's and an array's members.
 */
export function planCacheKey(gremlin: string, params: ParamEnv, federationDepth: number, detached: boolean): string | null {
  const speller = new Speller(PLAN_CACHE_MAX_PARAM_KEY);
  const parts: string[] = [];
  for (const name of Object.keys(params.values).sort()) {
    const value = speller.spell(params.values[name]);
    if (value === null) return null;
    const part = `${JSON.stringify(name)}:${JSON.stringify(params.types[name] ?? null)}=${value}`;
    if (!speller.charge(part.length - value.length)) return null;
    parts.push(part);
  }
  return `${federationDepth}|${detached ? 1 : 0}|${parts.join(',')}|${gremlin}`;
}

/** A map's entries as one flat key, value, key, value… sequence, read lazily so a spelling that runs
 *  out of budget stops reading. */
function* pairs(entries: Iterable<readonly [unknown, unknown]>): Iterable<unknown> {
  for (const [k, v] of entries) { yield k; yield v; }
}

/** Spells parameter values canonically within a length budget, so a large value stops being spelled
 *  as soon as it is known to be too large to cache. */
class Speller {
  constructor(private remaining: number) {}

  charge(n: number): boolean { this.remaining -= n; return this.remaining >= 0; }

  /** One value's canonical spelling, or `null` when it has none (a class instance this module does not
   *  know, a function, a symbol) or the budget ran out. */
  spell(v: unknown): string | null {
    const leaf = this.leaf(v);
    if (leaf !== undefined) return leaf === null || !this.charge(leaf.length) ? null : leaf;
    if (Array.isArray(v)) return this.list('A', v);
    if (v instanceof Set) return this.list('S', v);
    if (v instanceof Map) return this.list('M', pairs(v));
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null;
    return this.list('O', pairs(Object.entries(v as Record<string, unknown>)));
  }

  /** A leaf's spelling; `null` for a value with none; `undefined` for a collection. */
  private leaf(v: unknown): string | null | undefined {
    if (v === undefined) return 'u';
    if (v === null) return 'n';
    switch (typeof v) {
      case 'string': return v.length > this.remaining ? null : `s${JSON.stringify(v)}`;
      case 'boolean': return v ? 't' : 'f';
      case 'number': return Object.is(v, -0) ? 'd-0' : `d${String(v)}`;
      case 'bigint': return `b${v}`;
      case 'object': break;
      default: return null;
    }
    if (v instanceof Date) return `D${v.getTime()}`;
    if (ArrayBuffer.isView(v)) {
      if (v.byteLength * 2 > this.remaining) return null;
      const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      return `B${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
    }
    return undefined;
  }

  private list(tag: string, items: Iterable<unknown>): string | null {
    const out: string[] = [];
    for (const x of items) {
      const s = this.spell(x);
      if (s === null || !this.charge(1)) return null;
      out.push(s);
    }
    return this.charge(tag.length + 2) ? `${tag}[${out.join(',')}]` : null;
  }
}
