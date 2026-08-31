// The postMessage RPC contract between a page-side manager and a graph's dedicated Worker — the
// browser twin of the Durable Object's RPC surface (src/cloudflare/graph-store-do.ts). One Worker hosts
// ONE graph (= one DO); the manager opens it, then runs queries / federated hops / info against it.
//
// The DATA-PLANE payloads (query → Framed[], foreign → ForeignResult) cross as a `RpcResult` so a query
// FAILURE travels as a value and never escapes the Worker's onmessage as an uncaught error (which would
// hang the RPC) — the same failure-as-value contract as the DO boundary (src/rpc.ts). Management ops
// (open/info) carry a plain discriminated `ok`, since GraphInfo is not a data-plane payload.
import type { RpcResult } from '../rpc.ts';
import type { Framed } from '../execute.ts';
import type { ForeignResult, ForeignTerminal } from '../api.ts';
import type { TypeNode } from '../gremlin/types.ts';
import type { GraphInfo } from '../manager.ts';

export type GraphWorkerRequest =
  | { rid: number; op: 'open'; graphId: string }
  | { rid: number; op: 'query'; gremlin: string; params: Record<string, unknown>; paramTypes?: Record<string, TypeNode> }
  | { rid: number; op: 'foreign'; gremlin: string; params: Record<string, unknown>; depth: number; paramTypes?: Record<string, TypeNode>; terminal?: ForeignTerminal }
  | { rid: number; op: 'info' };

export type GraphWorkerReply =
  | { rid: number; op: 'query'; result: RpcResult<Framed[]> }
  | { rid: number; op: 'foreign'; result: RpcResult<ForeignResult> }
  | { rid: number; op: 'open' | 'info'; ok: true; info: GraphInfo }
  | { rid: number; op: 'open' | 'info'; ok: false; error: string; stack?: string };

/** A request without its `rid` (the client assigns it). DISTRIBUTIVE over the union — a plain
 *  `Omit<GraphWorkerRequest, 'rid'>` collapses the union to its common `op` key, dropping each variant's
 *  own fields. */
export type GraphWorkerRequestBody = GraphWorkerRequest extends infer R ? (R extends { rid: number } ? Omit<R, 'rid'> : never) : never;
