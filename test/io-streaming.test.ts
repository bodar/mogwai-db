import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { BatchingLoader } from '../src/bulk.ts';
import { loadGraphsonStreaming, writeGraphson, writeGraphsonToSink } from '../src/formats/graphson.ts';
import { loadCsvStreaming } from '../src/formats/csv.ts';
import { linesOf } from '../src/formats/drain.ts';
import { PART_SIZE, R2IoStore } from '../src/cloudflare/R2IoStore.ts';

// The STREAMING io path — the property the whole-string tests (io/graphson/csv) cannot show, because
// their documents are kilobytes and everything materializes trivially. Here: that the reader is a
// TWO-PASS memory-bounded stream (a forward-referencing edge still resolves), that the loader lands
// in bounded BATCHES with cross-batch endpoint resolution, that the R2 write path is a real multipart
// upload (bounded parts, single-put fallback, exact reassembly), and that the byte→line/record
// reframers survive chunk boundaries splitting a multibyte char, a CRLF, and a quoted field.

const fresh = () => new GraphStore(new BunSqlite(':memory:'));
const enc = (s: string) => new TextEncoder().encode(s);

/** A ReadableStream that hands out `bytes` in fixed-size chunks — the small chunk size is the point:
 *  it forces the reframers to reassemble across boundaries that a whole-buffer read never exposes. */
function streamOf(bytes: Uint8Array, chunk = 8): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, Math.min(at + chunk, bytes.length)));
      at += chunk;
    },
  });
}
const stringStream = (s: string, chunk?: number) => streamOf(enc(s), chunk);
const gInt = (v: number) => ({ '@type': 'g:Int32', '@value': v });

/** Drain a read stream to bytes — a TEST-only convenience (production never materializes a whole
 *  document; the io seam is stream-only for exactly that reason). Fine here: the objects are tiny. */
async function drainToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

describe('GraphSON streaming read is two-pass — a forward-referencing edge resolves', () => {
  test('an edge on the FIRST line targeting the LAST vertex lands correctly', async () => {
    const store = fresh();
    // Vertex 1 (first line) has an edge to vertex 3 (last line): a single memory-bounded pass could
    // not resolve it without buffering. Two passes (all vertices, then all edges) make it trivial.
    const doc = [
      JSON.stringify({ id: gInt(1), label: ['person'], outE: { knows: [{ id: gInt(10), inV: gInt(3) }] } }),
      JSON.stringify({ id: gInt(2), label: ['person'] }),
      JSON.stringify({ id: gInt(3), label: ['person'] }),
    ].join('\n');

    const stats = await loadGraphsonStreaming(store, async () => stringStream(doc, 8));
    expect(stats.vertices).toBe(3);
    expect(stats.edges).toBe(1);
    expect(store.query('SELECT count(*) AS c FROM nodes')[0].c).toBe(3);
    expect(store.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges')).toEqual([{ src: 1, tgt: 3 }]);
  });

  test('string (uid) endpoints resolve against the store in the edge pass', async () => {
    const store = fresh();
    const doc = [
      JSON.stringify({ id: 'a', label: ['person'], outE: { knows: [{ id: 'e1', inV: 'c' }] } }),
      JSON.stringify({ id: 'b', label: ['person'] }),
      JSON.stringify({ id: 'c', label: ['person'] }),
    ].join('\n');
    await loadGraphsonStreaming(store, async () => stringStream(doc, 5));
    // A string id becomes a minted rowid + a uid; the edge's endpoints are looked up by uid.
    const edge = store.query<{ s: string; t: string }>(
      `SELECT (SELECT uid FROM nodes WHERE id = e.src) AS s, (SELECT uid FROM nodes WHERE id = e.tgt) AS t
       FROM edges e`)[0];
    expect(edge).toEqual({ s: 'a', t: 'c' });
  });

  test('a streamed dump reads back into an empty graph, byte-for-byte the same document', async () => {
    const src = fresh();
    // Build a small graph the ordinary way, dump it to the in-memory string form, then load THAT
    // document through the streaming reader — the two forms must agree.
    const doc = ((): string => {
      const g = fresh();
      const bl = new BatchingLoader(g, {}, 3);
      for (const id of [1, 2, 3, 4]) bl.vertex({ id, labels: ['person'], properties: [{ key: 'n', value: `v${id}` }] });
      bl.edge({ id: 7, label: 'knows', src: 1, tgt: 4 });
      bl.edge({ id: 8, label: 'knows', src: 4, tgt: 2 });
      bl.done();
      return writeGraphson(g);
    })();
    await loadGraphsonStreaming(src, async () => stringStream(doc, 16));
    expect(writeGraphson(src)).toBe(doc);
  });
});

describe('BatchingLoader lands in bounded batches and resolves endpoints across them', () => {
  test('edges resolve against vertices flushed in EARLIER batches', () => {
    const store = fresh();
    const bl = new BatchingLoader(store, {}, 2);            // tiny batch → many cuts
    for (const id of [1, 2, 3, 4, 5]) bl.vertex({ id, labels: ['n'] });
    bl.edge({ label: 'e', src: 1, tgt: 5 });                // 1 flushed long ago, 5 in the live batch
    bl.edge({ label: 'e', src: 5, tgt: 1 });
    const stats = bl.done();
    expect(stats.vertices).toBe(5);
    expect(stats.edges).toBe(2);
    expect(store.query<{ src: number; tgt: number }>('SELECT src, tgt FROM edges ORDER BY id'))
      .toEqual([{ src: 1, tgt: 5 }, { src: 5, tgt: 1 }]);
  });

  test('onCollision:"replace" is refused — it cannot span streamed batches', () => {
    expect(() => new BatchingLoader(fresh(), { onCollision: 'replace' })).toThrow(/does not support onCollision/);
  });
});

// ---------- the R2 multipart write path, on a fake bucket (no workerd needed) ----------

/** The subset of `R2Bucket` the io path touches, recording enough to prove the sink's behavior:
 *  `parts` captures the last multipart upload's parts in order, `objects` holds committed bytes. */
class FakeR2 {
  readonly objects = new Map<string, Uint8Array>();
  parts: Uint8Array[] = [];
  putCalls = 0;
  private u8(v: unknown): Uint8Array {
    if (v instanceof Uint8Array) return v;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    if (typeof v === 'string') return enc(v);
    throw new Error(`FakeR2: unexpected value type ${typeof v}`);
  }
  async get(key: string): Promise<unknown> {
    const b = this.objects.get(key);
    return b ? { body: streamOf(b, 1024) } : null;
  }
  async put(key: string, value: unknown): Promise<unknown> {
    this.putCalls++;
    this.objects.set(key, this.u8(value));
    return {};
  }
  async createMultipartUpload(key: string): Promise<unknown> {
    const collected: { n: number; b: Uint8Array }[] = [];
    this.parts = [];
    const self = this;
    return {
      key, uploadId: 'up',
      async uploadPart(n: number, value: unknown) {
        const b = self.u8(value);
        collected.push({ n, b });
        self.parts.push(b);
        return { partNumber: n, etag: `e${n}` };
      },
      async complete(uploaded: { partNumber: number; etag: string }[]) {
        const ordered = [...uploaded].sort((a, b) => a.partNumber - b.partNumber)
          .map((u) => collected.find((p) => p.n === u.partNumber)!.b);
        const total = ordered.reduce((n, b) => n + b.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const b of ordered) { out.set(b, at); at += b.length; }
        self.objects.set(key, out);
        return {};
      },
      async abort() { /* discarded */ },
    };
  }
  async list(): Promise<unknown> { return { objects: [], truncated: false }; }
}

const asR2 = (f: FakeR2) => new R2IoStore(f as unknown as R2Bucket);

describe('R2IoStore write is a bounded multipart upload', () => {
  test('a small document goes out as a single put — no multipart', async () => {
    const bucket = new FakeR2();
    const sink = await asR2(bucket).writeStream('small.json');
    await sink.write(enc('hello '));
    await sink.write(enc('world'));
    await sink.close();
    expect(bucket.putCalls).toBe(1);
    expect(bucket.parts.length).toBe(0);
    expect(new TextDecoder().decode(bucket.objects.get('small.json'))).toBe('hello world');
  });

  test('a document larger than one part uploads uniform parts and reassembles exactly', async () => {
    const bucket = new FakeR2();
    const sink = await asR2(bucket).writeStream('big.bin');
    // 2.5 parts' worth, fed in awkward chunks so a part boundary falls mid-chunk.
    const total = PART_SIZE * 2 + PART_SIZE / 2;
    const payload = new Uint8Array(total);
    for (let i = 0; i < total; i++) payload[i] = i & 0xff;
    for (let at = 0; at < total; at += 777_777) await sink.write(payload.subarray(at, Math.min(at + 777_777, total)));
    await sink.close();

    expect(bucket.putCalls).toBe(0);                        // multipart, not a single put
    expect(bucket.parts.length).toBe(3);                    // two full parts + a final remainder
    expect(bucket.parts[0].length).toBe(PART_SIZE);         // non-final parts are exactly PART_SIZE
    expect(bucket.parts[1].length).toBe(PART_SIZE);
    expect(bucket.parts[2].length).toBe(PART_SIZE / 2);
    expect(bucket.objects.get('big.bin')).toEqual(payload);
  });

  test('a graph dump through the R2 sink is the same bytes as the in-memory writer', async () => {
    const store = fresh();
    const bl = new BatchingLoader(store, {}, 100);
    for (const id of [1, 2, 3]) bl.vertex({ id, labels: ['person'], properties: [{ key: 'n', value: `v${id}` }] });
    bl.edge({ id: 7, label: 'knows', src: 1, tgt: 2 });
    bl.done();

    const bucket = new FakeR2();
    const sink = await asR2(bucket).writeStream('dump.json');
    await writeGraphsonToSink(store, sink);
    await sink.close();

    const bytes = await drainToBytes(await asR2(bucket).readStream('dump.json'));
    expect(new TextDecoder().decode(bytes)).toBe(writeGraphson(store));
  });
});

describe('the byte reframers survive chunk boundaries', () => {
  test('linesOf reassembles a multibyte char split across chunks', async () => {
    const lines: string[] = [];
    for await (const line of linesOf(streamOf(enc('héllo\nwörld\n€nd'), 3))) lines.push(line);
    expect(lines).toEqual(['héllo', 'wörld', '€nd']);
  });

  test('loadCsvStreaming handles a quoted newline and a "" escape split across chunks', async () => {
    const store = fresh();
    // note column on vertex 1 contains a newline (quoted); vertex 2 contains a literal quote (`""`).
    const csv = '~id,~label,note:String\n1,person,"line1\nline2"\n2,person,"a""b"';
    await loadCsvStreaming(store, stringStream(csv, 4));    // 4-byte chunks split the quotes/newline
    const note = (id: number) => store.query<{ value: string }>(
      `SELECT value FROM vertex_properties WHERE node = ? AND key = 'note'`, [id])[0].value;
    expect(note(1)).toBe('line1\nline2');
    expect(note(2)).toBe('a"b');
  });
});
