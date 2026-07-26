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
  // A bulked frame appends a Long multiplicity to each value; batchSize still counts
  // VALUES (one value = value+bulk), so chunk pacing is unchanged. Each value is encoded
  // AS ITS BATCH IS PULLED rather than mapping the whole array up front: the encoded copy
  // of the result set no longer coexists with the framed one, so peak memory is the input
  // plus one batch instead of two full sets. (The input array itself is still fully
  // materialized — GraphStore.query() returns T[] — so this bounds the copy, not the rows.)
  const encode = bulked ? withBulk : (f: Framed) => f.buf;
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bulked ? HEADER_BULKED : HEADER);
    },
    pull(controller) {
      if (i >= framed.length) {
        controller.enqueue(frameTrailer(200, null));
        controller.close();
        return;
      }
      const end = Math.min(i + batchSize, framed.length);
      const batch: Buffer[] = [];
      for (; i < end; i++) batch.push(encode(framed[i]));
      controller.enqueue(Buffer.concat(batch));
    },
  });
  return new Response(stream, { headers: { 'Content-Type': CONTENT_TYPE } });
}
