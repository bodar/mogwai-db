// Concern C — GraphBinary v4 HTTP response framing + chunk pacing, at the edge.
// The response is ONE logical frame — `HEADER | value* | trailer` — however many
// HTTP chunks carry it (v4 chunking splits this same byte stream; the client
// reassembles via arrayBuffer() and reads it once). `streamBuffers` takes the
// already-framed value buffers (concern B, executeQuery) and paces them out; it
// can no longer fail on a value (framing already happened behind the seam), so the
// only mid-flight event is client cancel. Pre-flight failures (parse/compile/SQL)
// surface as a thrown error the router turns into `errorResponse` — one buffered
// HEADER + status trailer, HTTP always 200 with the error on the trailer.
import { ioc } from './io.ts';
import { type Framed } from './execute.ts';

export const CONTENT_TYPE = 'application/vnd.graphbinary-v4.0';
const HEADER = Buffer.from([0x84, 0x00]);         // version, bulked=false (flat frame)
const HEADER_BULKED = Buffer.from([0x84, 0x01]);  // version, bulked=true

/** The GraphBinary V4 bulked-response contract: when the client requested `bulkResults`,
 *  each value is followed by a fully-qualified `Long` multiplicity (the store's per-value
 *  bulk — the client expands Traverser(v,N) back to N copies). A bulk of 1 is byte-for-byte
 *  the flat frame, so an un-collapsed stream is unchanged. */
const withBulk = (f: Framed): Buffer => Buffer.concat([f.buf, ioc.longSerializer.serialize(f.bulk, true)]);

function frameTrailer(status = 200, message: string | null = null): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0xfd, 0x00, 0x00]),            // end-of-stream marker
    ioc.intSerializer.serialize(status, false), // status code, bare int
  ];
  if (message !== null) {
    parts.push(Buffer.from([0x00]), ioc.stringSerializer.serialize(message, false));
  } else {
    parts.push(Buffer.from([0x01])); // null message
  }
  parts.push(Buffer.from([0x01])); // null exception
  return Buffer.concat(parts);
}

/** A pre-stream failure: HEADER + status trailer, no values. HTTP stays 200; the
 *  message rides the GraphBinary trailer and the client raises ResponseError. */
export function errorResponse(message: string): Response {
  return new Response(Buffer.concat([HEADER, frameTrailer(500, message)]), {
    headers: { 'Content-Type': CONTENT_TYPE },
  });
}

/**
 * Stream the already-framed value buffers out as one chunked GraphBinary v4 frame:
 * HEADER first, then the values `batchSize` at a time (chunk pacing only — NOT a
 * protocol boundary), then the 200 trailer. `batchSize` must already be a positive
 * integer (resolved in wire.ts). Framing is complete before we start, so a value
 * can't throw here; a client disconnect just stops further pulls.
 */
export function streamBuffers(framed: Framed[], batchSize: number, bulked = false): Response {
  // Two response contracts over the SAME collapsed input. A store row is a `(value, bulk)`
  // pair (the compiler RLE-merges convergent traversers), and how the multiplicity is carried
  // is the whole difference between the frames:
  //   - BULKED: emit one value followed by its `Long` multiplicity; the client expands
  //     Traverser(v,N) back to N. One output value per store row.
  //   - FLAT: the un-bulked frame IS the full multiset, so a collapsed `(value, N)` row must
  //     be emitted as N identical values. Dropping the count here silently under-returns a
  //     collapsed stream (a `repeat(both())` fan-out would report its distinct rows, not its
  //     traversers) — the sync `Executor.buffers` expands for exactly this reason.
  // `values()` yields the OUTPUT value buffers for whichever contract; `pull` paces `batchSize`
  // of them per HTTP chunk (pacing only, not a protocol boundary), so peak memory is the input
  // array plus one batch — never the expanded multiset. (`f.buf` is shared across a row's copies,
  // so an expanded batch is N references to one Buffer, not N copies.)
  function* values(): Generator<Buffer> {
    if (bulked) { for (const f of framed) yield withBulk(f); return; }
    for (const f of framed) for (let k = f.bulk; k > 0n; k--) yield f.buf;
  }
  const it = values();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bulked ? HEADER_BULKED : HEADER);
    },
    pull(controller) {
      const batch: Buffer[] = [];
      for (let n = 0; n < batchSize; n++) {
        const next = it.next();
        if (next.done) break;
        batch.push(next.value);
      }
      if (batch.length > 0) controller.enqueue(Buffer.concat(batch));
      if (batch.length < batchSize) {
        controller.enqueue(frameTrailer(200, null));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'Content-Type': CONTENT_TYPE } });
}
