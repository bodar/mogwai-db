// Chunked GraphBinary v4 streaming: the response body is a ReadableStream that
// emits the header, then value buffers `batchSize` at a time, then the status
// trailer. The wire is still ONE logical frame (header | value* | 0xFD 0x00 0x00 |
// status | msg | exc) however it's chunked, so the client reassembles it via
// arrayBuffer() exactly as before — these tests assert both the observable chunk
// pacing (batchSize) AND that the reassembled frame stays byte-correct.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { makeHandler } from '../src/handler.ts';
import { ioc } from '../src/io.ts';
import { seedModern } from './conformance/seed-modern.ts';

function seededStore() {
  const store = new GraphStore(new BunSqlite(':memory:'));
  seedModern(store);
  return store;
}

const post = (store: any, body: Record<string, any>) =>
  makeHandler(store)(new Request('http://x/', { method: 'POST', body: JSON.stringify(body) }));

// Drain a Response's ReadableStream body into the list of DISCRETE chunks the
// handler enqueued (header / each batch / trailer), plus the reassembled buffer.
async function drainChunks(res: Response): Promise<{ chunks: Buffer[]; buf: Buffer }> {
  const reader = res.body!.getReader();
  const chunks: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return { chunks, buf: Buffer.concat(chunks) };
}

describe('chunked streaming response', () => {
  test('batchSize paces the chunks; every batchSize reassembles to the same frame', async () => {
    // Baseline: whole result in the fewest chunks (default batch >> result size).
    const big = await drainChunks(await post(seededStore(), { gremlin: 'g.V()', batchSize: 64 }));
    // Small batch: the same 6 vertices, but spread across more enqueued chunks.
    const small = await drainChunks(await post(seededStore(), { gremlin: 'g.V()', batchSize: 1 }));

    // Same six vertices either way — byte-identical reassembled frame.
    expect(small.buf.equals(big.buf)).toBe(true);
    // batchSize is observable: batch=1 produces strictly more discrete chunks.
    expect(small.chunks.length).toBeGreaterThan(big.chunks.length);
    // First chunk is always exactly the header [0x84, 0x00] (bulked=false).
    expect(big.chunks[0]).toEqual(Buffer.from([0x84, 0x00]));

    // The reassembled frame decodes as a well-formed 200 with all six vertices.
    const parsed = ioc.graphBinaryReader.readResponse(small.buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.data.length).toBe(6);
    expect(parsed.result.data.every((v: any) => v.constructor.name === 'Vertex')).toBe(true);
  });

  test('an absent / zero / non-numeric batchSize falls back to the default (still correct)', async () => {
    for (const batchSize of [undefined, 0, -5, 'nope' as any]) {
      const { buf } = await drainChunks(await post(seededStore(), { gremlin: 'g.V().count()', ...(batchSize === undefined ? {} : { batchSize }) }));
      const parsed = ioc.graphBinaryReader.readResponse(buf);
      expect(parsed.status.code).toBe(200);
      expect(Number(parsed.result.data[0])).toBe(6);
    }
  });

  test('empty result streams a bare header + 200 trailer (no values)', async () => {
    const { chunks, buf } = await drainChunks(await post(seededStore(), { gremlin: "g.V().hasLabel('nonesuch')" }));
    const parsed = ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.data.length).toBe(0);
    // Header enqueued in start(), trailer in the terminal pull() — two chunks, no batch.
    expect(chunks[0]).toEqual(Buffer.from([0x84, 0x00]));
  });

  test('a pre-stream error (compile failure) is a buffered, well-formed 500 frame', async () => {
    const res = await post(seededStore(), { gremlin: 'g.V().sack()' }); // sack() unsupported → throws at compile/prime
    const buf = Buffer.from(await res.arrayBuffer());
    const parsed = ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.status.code).toBe(500);
    expect(parsed.result.data.length).toBe(0);
    expect(parsed.status.message).toBeTruthy();
  });

  test('a MID-stream error still closes with a well-formed 500 trailer (never a truncated body)', async () => {
    // Duck-typed store: first row frames fine, the second has un-parseable props so
    // rowVertex's JSON.parse throws AFTER the first value has already been streamed.
    let calls = 0;
    const brokenStore = {
      query() {
        return [
          { id: 1, label: 'person', props: '{}' },
          { id: 2, label: 'person', props: '@@ not json @@' },
        ];
      },
      get queryCalls() { return calls; },
    } as unknown as GraphStore;

    // batchSize:1 so the good row flushes as its own chunk before the bad row throws.
    const res = await post(brokenStore, { gremlin: 'g.V()', batchSize: 1 });
    const { buf } = await drainChunks(res);
    const parsed = ioc.graphBinaryReader.readResponse(buf); // parses ⇒ frame is well-formed, not truncated
    expect(parsed.status.code).toBe(500);
    expect(parsed.result.data.length).toBe(1); // the one good vertex made it onto the wire
    expect(parsed.status.message).toBeTruthy();
  });

  test('cancel() mid-read stops the stream (client disconnect): no further values, no throw', async () => {
    const res = await post(seededStore(), { gremlin: 'g.V()', batchSize: 1 });
    const reader = res.body!.getReader();
    const header = await reader.read(); // pull the header (first chunk)
    expect(Buffer.from(header.value!)).toEqual(Buffer.from([0x84, 0x00]));
    await reader.cancel();              // cancel() → gen.return(); must not throw
    // The stream is now closed — a subsequent read yields done, never another value.
    const after = await reader.read();
    expect(after.done).toBe(true);
    expect(after.value).toBeUndefined();
  });

  test('a GraphBinary request carrying resultIterationBatchSize is honored', async () => {
    // Frame a minimal GraphBinary request: 0x84 | map(fields, bare) | string(gremlin, bare).
    const store = seededStore();
    const fields = new Map<string, any>([['resultIterationBatchSize', 2]]);
    const body = Buffer.concat([
      Buffer.from([0x84]),
      ioc.mapSerializer.serialize(fields, false),
      ioc.stringSerializer.serialize('g.V()', false),
    ]);
    const res = await makeHandler(store)(new Request('http://x/', { method: 'POST', body }));
    const { chunks, buf } = await drainChunks(res);
    const parsed = ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.data.length).toBe(6);
    // 6 vertices at batch=2 ⇒ header + 3 value-batches + trailer = 5 discrete chunks.
    expect(chunks.length).toBe(5);
  });
});
