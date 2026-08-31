// The page-side half of the graph-worker transport: a promise-based RPC client over one graph's
// dedicated Worker. The manager holds one of these per graph (spawn the Worker, wrap it here), and
// so does the browser test lane. Matches replies to requests by a monotonic `rid`, and turns a
// data-plane `RpcResult` back into a value-or-throw with `rpcUnwrap` (the far-side stack travels with a
// failure, so a query error thrown here reads as if it were thrown locally).
import { rpcUnwrap } from '../rpc.ts';
import type { GraphWorkerRequest, GraphWorkerReply, GraphWorkerRequestBody } from './graph-worker-protocol.ts';
import type { Framed } from '../execute.ts';
import type { ForeignResult, ForeignTerminal } from '../api.ts';
import type { TypeNode } from '../gremlin/types.ts';
import type { GraphInfo } from '../manager.ts';

export class GraphWorkerClient {
  private nextRid = 0;
  private readonly pending = new Map<number, { resolve: (r: GraphWorkerReply) => void; reject: (e: unknown) => void }>();

  constructor(private readonly worker: Worker) {
    worker.addEventListener('message', (e: MessageEvent<GraphWorkerReply>) => {
      const reply = e.data;
      const p = this.pending.get(reply.rid);
      if (p) {
        this.pending.delete(reply.rid);
        p.resolve(reply);
      }
    });
    // A hard Worker crash (not a query failure — those come back as values) rejects everything in flight
    // rather than leaving callers hung; the manager treats it as the graph worker going away.
    worker.addEventListener('error', (e) => {
      const err = new Error(`graph worker crashed: ${e.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  private send(req: GraphWorkerRequestBody): Promise<GraphWorkerReply> {
    const rid = ++this.nextRid;
    return new Promise((resolve, reject) => {
      this.pending.set(rid, { resolve, reject });
      this.worker.postMessage({ ...req, rid } as GraphWorkerRequest);
    });
  }

  /** Boot the host over `graphId`'s store; the reply carries its current counts. */
  async open(graphId: string): Promise<GraphInfo> {
    return infoOf(await this.send({ op: 'open', graphId }));
  }

  /** Compile + run + frame a query to GraphBinary value buffers. The buffers arrive as `Uint8Array`
   *  after the structured clone, so re-wrap each as `Buffer` here — that restores the `Framed` contract
   *  (`buf: Buffer`) the response framer (`streamBuffers` → `Buffer.concat`) relies on, at the one seam. */
  async framed(gremlin: string, params: Record<string, unknown>, paramTypes?: Record<string, TypeNode>): Promise<Framed[]> {
    const r = await this.send({ op: 'query', gremlin, params, paramTypes });
    if (r.op !== 'query') throw new Error(`unexpected reply op ${r.op} for query`);
    return rpcUnwrap(r.result).map((f) => ({ buf: Buffer.from(f.buf), bulk: f.bulk }));
  }

  /** A federated hop landing INTO this graph (the manager routes a sibling's federate here). */
  async runForeign(gremlin: string, params: Record<string, unknown>, depth: number, paramTypes?: Record<string, TypeNode>, terminal?: ForeignTerminal): Promise<ForeignResult> {
    const r = await this.send({ op: 'foreign', gremlin, params, depth, paramTypes, terminal });
    if (r.op !== 'foreign') throw new Error(`unexpected reply op ${r.op} for foreign`);
    return rpcUnwrap(r.result);
  }

  async info(): Promise<GraphInfo> {
    return infoOf(await this.send({ op: 'info' }));
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/** Narrow an open/info reply to its GraphInfo, rethrowing a captured failure with its stack. */
function infoOf(reply: GraphWorkerReply): GraphInfo {
  if (reply.op !== 'open' && reply.op !== 'info') throw new Error(`unexpected reply op ${reply.op} for open/info`);
  if (reply.ok) return reply.info;
  const e = new Error(reply.error);
  if (reply.stack) e.stack = reply.stack;
  throw e;
}
