import type { IoStore } from '../iostore.ts';

/**
 * The Cloudflare half of the IoStore seam: an R2 bucket binding, reachable from INSIDE the Durable
 * Object (bindings are a property of the DO's env exactly as they are a Worker's), so a whole-graph
 * read or write happens where the graph lives and only bytes cross a seam.
 *
 * No rooting guard, unlike the Bun twin: an R2 key is a key. There is no parent directory to walk
 * up into, so `../` is an ordinary (and simply absent) key.
 */
export class R2IoStore implements IoStore {
  constructor(private readonly bucket: R2Bucket) {}

  async read(path: string): Promise<Uint8Array> {
    const object = await this.bucket.get(path);
    // Fail closed naming the key: an absent object is a fact about the request, not an empty graph.
    if (!object) throw new Error(`io("${path}"): no such object in the bound R2 bucket`);
    return new Uint8Array(await object.arrayBuffer());
  }

  async write(path: string, bytes: Uint8Array): Promise<void> {
    await this.bucket.put(path, bytes);
  }

  async list(prefix: string): Promise<string[]> {
    // R2 list is PAGINATED and silently truncates at the page limit — so follow the cursor rather
    // than return a first page that looks like the whole bucket.
    const keys: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.bucket.list({ prefix, cursor });
      for (const o of page.objects) keys.push(o.key);
      if (!page.truncated) return keys;
      cursor = page.cursor;
    }
  }
}
