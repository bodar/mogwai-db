// ---------- federation over HTTP — mogwai as an outbound client of another graph ----------
//
// docs/archive/2026-09-02-replication-and-http-interop-plan.md §8. `federate()` depends only on a
// `FederationSource` — `executor(id).runForeign(gremlin, params, depth, …)` — and the CF/Bun managers
// ARE that source (a sibling is just another graph they resolve by id, `src/api.ts`). When the `graph`
// id is a fully-qualified `http(s)` URI, the manager resolves it to THIS executor instead of a local
// graph / a sibling DO: it is exactly "point the Gremlin client at a different URL and let the whole
// traversal machinery run" — the sub-traversal runs on the remote peer, its results land through the
// same detached-row / BatchingLoader path a DO-RPC hop uses (`foreign.ts`). Nothing in `federate.ts`
// changes; the dispatch is entirely here.
//
// TRANSPORT — a GraphBinary REQUEST built by hand, not the vendored `Client`. Three reasons, each
// load-bearing for how the federate barrier actually works:
//   1. `inject($map)` — the mid-traversal correlation the barrier synthesizes
//      (`g.inject($map).unfold().group().by(Column.keys).by(…)`) only parses because of our carried
//      grammar patch (`inject` admitting a bound `genericArgument`). The gremlin string must reach the
//      peer VERBATIM; the vendored client builds/validates the request client-side (and encodes params
//      as a gremlin-lang string) and could reject it. We send the string untouched.
//   2. the `$map` binding is a real `Map` (parent-ordinal → injected value) — JSON cannot carry a typed
//      Map, but a GraphBinary MAP does (nested Maps and all), decoded faithfully by the peer's
//      `wire.ts` `parseRequest`. So the request is the exact inverse of that decoder.
//   3. the response must keep exact Gremlin types (a Long count, a UUID prop) so a LOCAL tail over the
//      detached result is correct at depth — `decodeForeignResult` owns that (the stock client reader
//      type-collapses). Building the request with the same `ioc` serializers keeps both directions
//      symmetric and PORTABLE: the transport is the injected `Http` seam (`(Request)=>Promise<Response>`),
//      so it runs identically on Bun, a Worker/DO, and the browser with no undici/dispatcher to bundle,
//      AND a test can hand it a server's own router handler to run the hop entirely in memory.
//
// This reuses the client's GraphBinary SERIALIZERS (decision #4, reuse-first) while hand-rolling the
// thin request/response framing our wire layer already owns for the deficient parts.

import type { Executor, ForeignResult, ForeignTerminal, Http, RemoteExecutor } from './api.ts';
import type { Framed } from './execute.ts';
import type { TypeNode } from './gremlin/types.ts';
import { ioc } from './io.ts';
import { decodeForeignResult } from './foreign-decode.ts';

const GRAPHBINARY_MIME = 'application/vnd.graphbinary-v4.0';

/** A fully-qualified `http(s)` URL. Used two ways: a federate `graph` id that is one names a REMOTE
 *  peer (not a local sibling), and an `io()` path that is one names a document to fetch over HTTP (not
 *  a local io-store key). A relative string is local in both. */
export const isHttpUrl = (s: string): boolean => /^https?:\/\//i.test(s);

/** The production `Http`: the platform's global `fetch` (native on Bun, a Worker/DO, and the browser).
 *  THE ONE sanctioned place an outbound call touches global `fetch` — everything else takes an injected
 *  `Http` so it stays in-memory-testable and uniform with the server handler. */
export const defaultHttp: Http = (request) => fetch(request);

/**
 * Build a GraphBinary v4 REQUEST — the exact inverse of `wire.ts`'s `parseRequest` binary path:
 * `0x84`, then a BARE fields map (`int32 count` then `{key fq}{value fq}` pairs — NO leading MAP
 * byte), then the gremlin string BARE. The `bindings` value is a fq typed `Map`, so a nested `Map`
 * (the `inject($map)` payload) rides through with its structure and element types intact. Serialized
 * with our shared `ioc` serializers, so it is byte-compatible with what the server already decodes.
 */
export function encodeGraphBinaryRequest(gremlin: string, params: Record<string, unknown>): Buffer {
  const fields = new Map<string, unknown>([
    ['bindings', new Map(Object.entries(params))],
    ['bulkResults', false], // flat frame — one value per traverser, as decodeForeignResult expects
  ]);
  const parts: Buffer[] = [Buffer.from([0x84]), ioc.intSerializer.serialize(fields.size, false)];
  for (const [k, v] of fields) {
    parts.push(ioc.anySerializer.serialize(k, true)); // {key} fully qualified
    parts.push(ioc.anySerializer.serialize(v, true)); // {value} fully qualified (bindings = a typed MAP)
  }
  parts.push(ioc.stringSerializer.serialize(gremlin, false)); // {gremlin} bare
  return Buffer.concat(parts);
}

/**
 * The executor for a REMOTE peer graph reached over HTTP. Only `runForeign` is meaningful — it is the
 * one method a federated hop calls. The client-wire (`framedAsync`) and sync (`framed`/`buffers`)
 * surfaces are never reached for a URI graph id (the router selects graphs by URL path, never a URI,
 * and federation uses `runForeign`), so they fail closed rather than pretend to run a query against a
 * peer we can only reach as a client. Implementing the full `Executor` lets both managers hand it back
 * from `executor(id)` without widening their return types.
 */
export class HttpForeignExecutor implements Executor {
  /** `url` is the peer endpoint (the federate `graph` URI); `http` is the transport seam it runs the
   *  request through — global `fetch` in production, a server's own router handler in an in-memory test. */
  constructor(private readonly url: string, private readonly http: Http) {}

  async runForeign(
    gremlin: string,
    params: Record<string, any>,
    _depth: number,
    _paramTypes?: Record<string, TypeNode>,
    terminal?: ForeignTerminal,
  ): Promise<ForeignResult> {
    // `_depth` is the LOCAL chain's federation depth (guarded by federate.apply before this call). It is
    // not yet threaded to the peer, which compiles a fresh request at depth 0 — a cyclic cross-server
    // federate is therefore only bounded per-server, not globally. Hardening (a `federationDepth`
    // request field the peer honours) is tracked in the plan doc; the sub-traversals the barrier sends
    // today (source `V()…`, `inject($map)…`) never re-federate.
    const request = new Request(this.url, {
      method: 'POST',
      headers: { 'Content-Type': GRAPHBINARY_MIME, Accept: GRAPHBINARY_MIME },
      // A plain Uint8Array view is a `BodyInit`; a Node `Buffer` is not, in the DOM/undici typings.
      body: new Uint8Array(encodeGraphBinaryRequest(gremlin, params)),
    });
    const resp = await this.http(request);
    // mogwai always answers HTTP 200 with a GraphBinary trailer (a query failure rides the trailer, not
    // the HTTP status — decodeForeignResult rethrows it). A non-200 is a genuine transport/peer fault.
    if (!resp.ok) throw new Error(`federate(http): peer ${this.url} returned HTTP ${resp.status} ${resp.statusText}`);
    return decodeForeignResult(Buffer.from(await resp.arrayBuffer()), terminal);
  }

  framedAsync(): Promise<Framed[]> {
    return Promise.reject(new Error(`federate(http): a client-wire query cannot be run against a remote peer (${this.url}); a URI graph id is reachable only as a federation target`));
  }
  framed(): Framed[] {
    throw new Error(`federate(http): a synchronous query cannot be run against a remote peer (${this.url})`);
  }
  buffers(): Buffer[] {
    throw new Error(`federate(http): a synchronous query cannot be run against a remote peer (${this.url})`);
  }
}

/** Dispatch a `graph` id: a remote `http(s)` URI → an {@link HttpForeignExecutor} over the injected
 *  `http` transport; anything else → the manager's local resolver. The one line both managers share. */
export const remoteOrLocal = <T extends RemoteExecutor>(id: string, http: Http, local: () => T): T | HttpForeignExecutor =>
  isHttpUrl(id) ? new HttpForeignExecutor(id, http) : local();
