// ---------- a bounded least-recently-used cache ----------
//
// One primitive for every in-isolate memo whose keys come from users (the parse cache, the plan cache).
// A long-lived Durable Object isolate has about 128 MB, so each such cache is bounded three ways:
//  - by ENTRY COUNT (`maxEntries`);
//  - by total WEIGHT (`maxWeight`) — the caller's own size unit, given by `weigh`;
//  - by the weight of ONE entry (`maxEntryWeight`): an entry past it is simply not held, so one large
//    request cannot evict every hot entry. A refused entry is never a decline — the caller recomputes it.
//
// A JS `Map` iterates in insertion order, so delete-then-set moves an entry to the most-recently-used
// end, and the first key is the least recently used. No dependency: a weigher, as Caffeine has one.

export interface BoundedLruOptions<K, V> {
  readonly maxEntries: number;
  /** The most total weight held. Default: no bound. */
  readonly maxWeight?: number;
  /** The most weight one entry may have and still be held. Default: `maxWeight`. */
  readonly maxEntryWeight?: number;
  /** The weight of one entry, in the caller's unit. Default: 1 per entry. */
  readonly weigh?: (key: K, value: V) => number;
}

export interface BoundedLruStats { readonly hits: number; readonly misses: number; readonly size: number; readonly weight: number }

interface Entry<V> { readonly value: V; readonly weight: number }

export class BoundedLru<K, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private readonly maxEntries: number;
  private readonly maxWeight: number;
  private readonly maxEntryWeight: number;
  private readonly weigh: (key: K, value: V) => number;
  private hits = 0;
  private misses = 0;
  private weight = 0;

  constructor(options: BoundedLruOptions<K, V>) {
    this.maxEntries = options.maxEntries;
    this.maxWeight = options.maxWeight ?? Infinity;
    this.maxEntryWeight = Math.min(options.maxEntryWeight ?? Infinity, this.maxWeight);
    this.weigh = options.weigh ?? (() => 1);
  }

  /** The value for `key`, which becomes the most recently used; counts a hit or a miss. */
  get(key: K): V | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) { this.misses++; return undefined; }
    this.hits++;
    this.entries.delete(key); this.entries.set(key, hit);
    return hit.value;
  }

  /** Hold `value` under `key` as the most recently used. An entry heavier than `maxEntryWeight` is not
   *  held, and any older entry for its key goes. Then the least recently used go until both bounds hold. */
  set(key: K, value: V): void {
    const weight = this.weigh(key, value);
    this.remove(key);
    if (weight > this.maxEntryWeight) return;
    this.entries.set(key, { value, weight });
    this.weight += weight;
    for (const k of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.weight <= this.maxWeight) break;
      this.remove(k);
    }
  }

  stats(): BoundedLruStats {
    return { hits: this.hits, misses: this.misses, size: this.entries.size, weight: this.weight };
  }

  private remove(key: K): void {
    const old = this.entries.get(key);
    if (old === undefined) return;
    this.entries.delete(key);
    this.weight -= old.weight;
  }
}
