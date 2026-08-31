// The dedicated-Worker ENTRY the manager spawns, one per graph — now just OPEN the host then EXPOSE it
// as a Cap'n Web session over a MessagePort. It hosts ONE graph (= one DO). The page (spawner) creates a
// MessageChannel and sends `{ port, graphId }` as the worker's first message (transferring `port`); this
// worker opens the graph's host over its opfs-sahpool database and serves RPC on that port.
//
// The host is exposed as an `RpcPromise` over the OPEN promise, so pipelined calls (info/framed/runForeign)
// wait for open, and if open REJECTS every call rejects with the reason — fail closed, straight through
// capnweb's exception support (no hand-rolled failure-as-value wrapper, and no separate open RPC). A query
// FAILURE likewise crosses back as a stub rejection with its message. (src/rpc.ts stays — it is the
// Cloudflare DO boundary, a different transport.)
import './buffer-global.ts'; // MUST be first — installs Buffer before the wire (http.ts/io.ts) inits
import { newMessagePortRpcSession, RpcPromise } from 'capnweb';
import { GraphWorkerHost } from './GraphWorkerHost.ts';
import { OpfsIoStore } from './OpfsIoStore.ts';

/** The boot message: the RPC port to serve on plus which graph this Worker hosts. The Worker may receive
 *  SEVERAL over its life — one per capnweb session it should serve (the page-side manager, or the Service
 *  Worker edge after a cold-start re-handshake) — but it opens the host exactly ONCE and serves every
 *  session over that same host. */
interface Boot {
  port: MessagePort;
  graphId: string;
}

let host: Promise<GraphWorkerHost> | undefined;

self.onmessage = (e: MessageEvent<Boot>) => {
  const { port, graphId } = e.data;
  host ??= GraphWorkerHost.open(graphId, { io: new OpfsIoStore(['io']) });
  newMessagePortRpcSession(port, new RpcPromise(host));
};
