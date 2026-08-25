import type { IoSink, IoStore } from '../iostore.ts';

/**
 * The Cloudflare half of the IoStore seam: an R2 bucket binding, reachable from INSIDE the Durable
 * Object (bindings are a property of the DO's env exactly as they are a Worker's), so a whole-graph
 * read or write happens where the graph lives and only bytes cross a seam.
 *
 * READ streams straight off the object body: `R2ObjectBody.body` IS a `ReadableStream`, so the
 * loader drains it a page at a time and a 10 GB restore never materializes in the isolate.
 *
 * WRITE is R2 MULTIPART upload, and that is forced rather than chosen: a DO cannot stream a request
 * body out (Workers never implemented streaming `fetch` uploads), and a single `bucket.put` of a
 * 10 GB `ReadableStream` would have to buffer to hash+length it. Multipart is the one API that
 * commits a large object as bounded, independently-uploaded parts — so the sink buffers only up to
 * ONE part (`PART_SIZE`) before flushing it and forgetting it. A small dump that never fills a part
 * skips multipart entirely and goes out as a single `put`, because R2 rejects a multipart upload
 * whose non-final parts are under 5 MiB (and needs at least one part to complete).
 *
 * No rooting guard, unlike the Bun twin: an R2 key is a key. There is no parent directory to walk
 * up into, so `../` is an ordinary (and simply absent) key.
 */
export class R2IoStore implements IoStore {
  constructor(private readonly bucket: R2Bucket) {}

  async readStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const object = await this.bucket.get(path);
    // Fail closed naming the key: an absent object is a fact about the request, not an empty graph.
    if (!object) throw new Error(`io("${path}"): no such object in the bound R2 bucket`);
    return object.body;
  }

  async writeStream(path: string): Promise<IoSink> {
    return new R2MultipartSink(this.bucket, path);
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

/**
 * Every part but the last must be the SAME size and at least 5 MiB (R2's rule); 8 MiB is a round
 * value comfortably over the floor. 10,000 parts is R2's ceiling, so this caps a single object at
 * ~80 GiB — well past a Durable Object's 10 GB storage limit, which is the real bound on a graph.
 */
export const PART_SIZE = 8 * 1024 * 1024;

/**
 * The R2 multipart sink. Buffers incoming chunks until a whole `PART_SIZE` part has accumulated,
 * uploads that part, and keeps only the remainder — so peak memory is one part plus one incoming
 * chunk, whatever the document's size. The multipart upload is created LAZILY on the first part, so
 * a document smaller than one part never opens one and commits as a single `put` on close.
 */
class R2MultipartSink implements IoSink {
  private buffered: Uint8Array[] = [];
  private bufferedLen = 0;
  private mpu: R2MultipartUpload | null = null;
  private nextPart = 1;
  private readonly parts: R2UploadedPart[] = [];

  constructor(private readonly bucket: R2Bucket, private readonly key: string) {}

  async write(chunk: Uint8Array): Promise<void> {
    if (chunk.length === 0) return;
    this.buffered.push(chunk);
    this.bufferedLen += chunk.length;
    if (this.bufferedLen < PART_SIZE) return;
    // Coalesce ONCE, then peel off as many whole parts as have accumulated; the tail (< PART_SIZE)
    // becomes the sole buffered chunk. One copy per write call, never per part.
    const buf = this.coalesce();
    let at = 0;
    while (buf.length - at >= PART_SIZE) {
      await this.uploadPart(buf.slice(at, at + PART_SIZE));
      at += PART_SIZE;
    }
    const rest = buf.subarray(at);
    this.buffered = rest.length ? [rest.slice()] : [];
    this.bufferedLen = rest.length;
  }

  async close(): Promise<void> {
    // Never crossed a part boundary → a single, ordinary object; no multipart upload was opened.
    if (!this.mpu) { await this.bucket.put(this.key, this.coalesce()); return; }
    // The final part carries whatever is left (it alone may be under PART_SIZE). If nothing is left,
    // every byte already went out as an exact part, so just complete.
    if (this.bufferedLen) await this.uploadPart(this.coalesce());
    await this.mpu.complete(this.parts);
  }

  async abort(): Promise<void> {
    if (this.mpu) await this.mpu.abort();
  }

  private async uploadPart(bytes: Uint8Array): Promise<void> {
    if (!this.mpu) this.mpu = await this.bucket.createMultipartUpload(this.key);
    this.parts.push(await this.mpu.uploadPart(this.nextPart++, bytes));
  }

  /** Fuse the buffered chunks into one contiguous `Uint8Array` and reset the buffer. */
  private coalesce(): Uint8Array {
    if (this.buffered.length === 1) {
      const only = this.buffered[0];
      this.buffered = [];
      this.bufferedLen = 0;
      return only;
    }
    const out = new Uint8Array(this.bufferedLen);
    let at = 0;
    for (const c of this.buffered) { out.set(c, at); at += c.length; }
    this.buffered = [];
    this.bufferedLen = 0;
    return out;
  }
}
