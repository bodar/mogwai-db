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

export const CONTENT_TYPE = 'application/vnd.graphbinary-v4.0';
const HEADER = Buffer.from([0x84, 0x00]);         // version, bulked=false (flat frame)
const HEADER_BULKED = Buffer.from([0x84, 0x01]);  // version, bulked=true

/** The GraphBinary V4 bulked-response contract: when the client requested `bulkResults`,
 *  each value is followed by a fully-qualified `Long` multiplicity. Stage A emits a
 *  constant bulk of 1 (behaviour-identical to the flat frame — the client expands
 *  Traverser(v,1) back to v); a later stage threads the real per-value bulk from the store. */
const BULK_ONE = ioc.longSerializer.serialize(1n, true);
const withBulk = (value: Buffer): Buffer => Buffer.concat([value, BULK_ONE]);

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
export function streamBuffers(buffers: Buffer[], batchSize: number, bulked = false): Response {
  // A bulked frame appends a Long multiplicity to each value; batchSize still counts
  // VALUES (one value = value+bulk), so chunk pacing is unchanged.
  const values = bulked ? buffers.map(withBulk) : buffers;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bulked ? HEADER_BULKED : HEADER);
    },
    pull(controller) {
      if (i >= values.length) {
        controller.enqueue(frameTrailer(200, null));
        controller.close();
        return;
      }
      const batch = values.slice(i, i + batchSize);
      i += batch.length;
      controller.enqueue(Buffer.concat(batch));
    },
  });
  return new Response(stream, { headers: { 'Content-Type': CONTENT_TYPE } });
}
