// The dedicated-Worker ENTRY the coordinator spawns, one per graph — the postMessage transport that
// fronts a GraphWorkerHost. It hosts ONE graph (= one DO): `open` boots the host over that graph's
// opfs-sahpool database, then `query`/`foreign`/`info` run against it. A DATA-PLANE failure crosses back
// as a `RpcResult` value (rpcTry) so a bad query never escapes onmessage as an uncaught error that would
// hang the caller — the same contract as the DO boundary (src/rpc.ts).
import './buffer-global.ts'; // MUST be first — installs Buffer before the wire (http.ts/io.ts) inits
import { GraphWorkerHost } from './GraphWorkerHost.ts';
import { OpfsIoStore } from './OpfsIoStore.ts';
import { rpcTry } from '../rpc.ts';
import type { GraphWorkerRequest, GraphWorkerReply } from './graph-worker-protocol.ts';

let host: GraphWorkerHost | undefined;

function requireHost(): GraphWorkerHost {
  if (!host) throw new Error('graph worker received a data request before `open`');
  return host;
}

async function handle(req: GraphWorkerRequest): Promise<GraphWorkerReply> {
  switch (req.op) {
    case 'open':
      try {
        host = await GraphWorkerHost.open(req.graphId, { io: new OpfsIoStore(['io']) });
        return { rid: req.rid, op: 'open', ok: true, info: host.info() };
      } catch (e: any) {
        return { rid: req.rid, op: 'open', ok: false, error: String(e?.message ?? e), stack: e?.stack };
      }
    case 'query':
      return { rid: req.rid, op: 'query', result: await rpcTry(() => requireHost().framed(req.gremlin, req.params, req.paramTypes)) };
    case 'foreign':
      return { rid: req.rid, op: 'foreign', result: await rpcTry(() => requireHost().runForeign(req.gremlin, req.params, req.depth, req.paramTypes, req.terminal)) };
    case 'info':
      try {
        return { rid: req.rid, op: 'info', ok: true, info: requireHost().info() };
      } catch (e: any) {
        return { rid: req.rid, op: 'info', ok: false, error: String(e?.message ?? e), stack: e?.stack };
      }
  }
}

self.onmessage = async (e: MessageEvent<GraphWorkerRequest>) => {
  (self as unknown as Worker).postMessage(await handle(e.data));
};
