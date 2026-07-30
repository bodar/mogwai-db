// The GraphBinary v4 edge, split into its three concerns (post-refactor):
//   A wire.ts     parseRequest — sniff JSON/GraphBinary, extract gremlin/g/batchSize
//   B execute.ts  executeQuery — compile + run + frame → Buffer[] (in the store tier)
//   C http.ts     streamBuffers — pace the buffers out as ONE chunked frame
// The response is still one logical frame (header | value* | 0xFD 0x00 0x00 | status
// | msg | exc) however it's chunked, so the client reassembles via arrayBuffer().
// Because framing (B) fully completes before streaming (C) begins, an error can no
// longer occur mid-stream: any compile/SQL/framing failure throws out of executeQuery
// and the edge frames a buffered 500 — there is no partial/truncated body.
import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { executeQuery, executeFramed } from './support/executor.ts';
import { streamBuffers, errorResponse } from '../src/http.ts';
import { parseRequest } from '../src/wire.ts';
import { ioc } from '../src/io.ts';
import { seededStore } from './support/harness.ts';

// Drain a Response's ReadableStream body into the list of DISCRETE chunks streamBuffers
// enqueued (header / each batch / trailer), plus the reassembled buffer.
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

describe('C — streamBuffers chunk pacing', () => {
  test('batchSize paces the chunks; every batchSize reassembles to the same frame', async () => {
    const buffers = await executeFramed(seededStore(), 'g.V()', {});
    const big = await drainChunks(streamBuffers(buffers, 64));   // whole result in fewest chunks
    const small = await drainChunks(streamBuffers(buffers, 1));  // same 6 vertices, more chunks

    // Same six vertices either way — byte-identical reassembled frame.
    expect(small.buf.equals(big.buf)).toBe(true);
    // batchSize is observable: batch=1 produces strictly more discrete chunks.
    expect(small.chunks.length).toBeGreaterThan(big.chunks.length);
    // First chunk is always exactly the header [0x84, 0x00] (bulked=false).
    expect(big.chunks[0]).toEqual(Buffer.from([0x84, 0x00]));

    // The reassembled frame decodes as a well-formed 200 with all six vertices.
    const parsed = await ioc.graphBinaryReader.readResponse(small.buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.data.length).toBe(6);
    expect(parsed.result.data.every((v: any) => v.constructor.name === 'Vertex')).toBe(true);
  });

  test('bulked frame: header byte 0x01 + a Long multiplicity per value; client decodes Traversers', async () => {
    const buffers = await executeFramed(seededStore(), 'g.V()', {});
    const flat = await drainChunks(streamBuffers(buffers, 64, false));
    const bulked = await drainChunks(streamBuffers(buffers, 64, true));

    // Header advertises bulking; the frame is strictly larger (a Long per value).
    expect(bulked.chunks[0]).toEqual(Buffer.from([0x84, 0x01]));
    expect(flat.chunks[0]).toEqual(Buffer.from([0x84, 0x00]));
    expect(bulked.buf.length).toBeGreaterThan(flat.buf.length);

    // The real client decodes the bulked frame as {v, bulk} pairs (Stage A: bulk ≡ 1).
    const parsed = await ioc.graphBinaryReader.readResponse(bulked.buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.bulked).toBe(true);
    expect(parsed.result.data.length).toBe(6);
    expect(parsed.result.data.every((d: any) => d.bulk === 1 && d.v.constructor.name === 'Vertex')).toBe(true);
    // Same six vertices as the flat frame (bulk=1 is value-identical).
    const flatParsed = await ioc.graphBinaryReader.readResponse(flat.buf);
    expect(new Set(parsed.result.data.map((d: any) => String(d.v.id))))
      .toEqual(new Set(flatParsed.result.data.map((v: any) => String(v.id))));
  });

  test('movementCollapse element leaf: a collapsed traversal emits (v, N) — RLE on the wire', async () => {
    const store = seededStore();
    // both().both() reaches several vertices via many walks; collapse merges each into ONE
    // (v, bulk) row instead of `bulk` duplicate vertex buffers.
    const framed = await executeFramed(store, 'g.V().both().both()', {});
    const multiset = executeQuery(store, 'g.V().both().both()', {}).length; // the fully expanded count
    const { buf } = await drainChunks(streamBuffers(framed, 64, true));
    const parsed = await ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.result.bulked).toBe(true);
    // Fewer rows on the wire than traversers, and at least one carries a real multiplicity > 1.
    expect(parsed.result.data.length).toBeLessThan(multiset);
    expect(parsed.result.data.some((d: any) => d.bulk > 1)).toBe(true);
    // The client expands Traverser(v, N): the multiplicities sum to the full multiset.
    const total = parsed.result.data.reduce((s: number, d: any) => s + Number(d.bulk), 0);
    expect(total).toBe(multiset);
  });

  test('6 vertices at batch=2 ⇒ header + 3 value-batches + trailer = 5 discrete chunks', async () => {
    const { chunks } = await drainChunks(streamBuffers(await executeFramed(seededStore(), 'g.V()', {}), 2));
    expect(chunks.length).toBe(5);
  });

  test('empty result streams a bare header + 200 trailer (no values)', async () => {
    const buffers = await executeFramed(seededStore(), "g.V().hasLabel('nonesuch')", {});
    expect(buffers.length).toBe(0);
    const { chunks, buf } = await drainChunks(streamBuffers(buffers, 64));
    const parsed = await ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.status.code).toBe(200);
    expect(parsed.result.data.length).toBe(0);
    // Header enqueued in start(), trailer in the terminal pull() — two chunks, no batch.
    expect(chunks[0]).toEqual(Buffer.from([0x84, 0x00]));
  });

  test('cancel() mid-read stops the stream (client disconnect): no further values, no throw', async () => {
    const res = streamBuffers(await executeFramed(seededStore(), 'g.V()', {}), 1);
    const reader = res.body!.getReader();
    const header = await reader.read(); // pull the header (first chunk)
    expect(Buffer.from(header.value!)).toEqual(Buffer.from([0x84, 0x00]));
    await reader.cancel();              // client disconnect — must not throw
    const after = await reader.read();  // stream closed — subsequent read is done
    expect(after.done).toBe(true);
    expect(after.value).toBeUndefined();
  });
});

describe('B — executeQuery errors are buffered 500s (framing completes before any stream)', () => {
  test('a compile failure throws → errorResponse is a well-formed 500, no values', async () => {
    expect(() => executeQuery(seededStore(), 'g.V().madeUpStep()', {})).toThrow();
    const buf = Buffer.from(await errorResponse('unknown step: madeUpStep').arrayBuffer());
    const parsed = await ioc.graphBinaryReader.readResponse(buf);
    expect(parsed.status.code).toBe(500);
    expect(parsed.result.data.length).toBe(0);
    expect(parsed.status.message).toBeTruthy();
  });

  test('a framing error throws from executeQuery too (no partial stream is ever emitted)', () => {
    // Duck-typed store: the first row frames fine, the second has un-parseable props.
    // Pre-refactor this streamed one value then a 500 trailer; now framing is fully
    // materialized up front, so the WHOLE array throws — nothing reaches the wire.
    const brokenStore = {
      query: () => [
        { id: 1, label: 'person', props: '{}' },
        { id: 2, label: 'person', props: '@@ not json @@' },
      ],
    } as unknown as GraphStore;
    expect(() => executeQuery(brokenStore, 'g.V()', {})).toThrow();
  });
});

describe('A — parseRequest', () => {
  const json = (body: Record<string, any>) => parseRequest(Buffer.from(JSON.stringify(body)));

  test('absent / zero / negative / non-numeric batchSize falls back to the default (64)', async () => {
    expect((await json({ gremlin: 'g.V()' })).batchSize).toBe(64);
    for (const batchSize of [0, -5, 'nope']) expect((await json({ gremlin: 'g.V()', batchSize })).batchSize).toBe(64);
  });

  test('honors batchSize / resultIterationBatchSize; batchSize wins', async () => {
    expect((await json({ gremlin: 'g.V()', batchSize: 2 })).batchSize).toBe(2);
    expect((await json({ gremlin: 'g.V()', resultIterationBatchSize: 3 })).batchSize).toBe(3);
    expect((await json({ gremlin: 'g.V()', batchSize: 2, resultIterationBatchSize: 9 })).batchSize).toBe(2);
  });

  test('parses a GraphBinary request body (gremlin + g + resultIterationBatchSize)', async () => {
    const fields = new Map<string, any>([['resultIterationBatchSize', 2], ['g', 'gmodern']]);
    const raw = Buffer.concat([
      Buffer.from([0x84]),
      ioc.mapSerializer.serialize(fields, false),
      ioc.stringSerializer.serialize('g.V()', false),
    ]);
    const p = await parseRequest(raw);
    expect(p.gremlin).toBe('g.V()');
    expect(p.batchSize).toBe(2);
    expect(p.g).toBe('gmodern');
  });
});
