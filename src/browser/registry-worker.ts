// The dedicated-Worker ENTRY for the SINGLETON replicator registry — the control-plane twin of the
// per-graph `worker.ts`. It opens ONE `ReplicatorRegistryHost` over its own opfs-sahpool database and serves
// capnweb sessions on the ports the page's WorkerFactory hands it (one per session — the SW edge, and any
// re-handshake after a cold start). It hosts no graph and needs no http/io: the registry is pure control-plane
// storage; the scheduler that USES it runs at the SW edge.
import './buffer-global.ts'; // MUST be first — installs Buffer before anything wire-adjacent inits
import { newMessagePortRpcSession, RpcPromise } from 'capnweb';
import { ReplicatorRegistryHost } from './ReplicatorRegistryHost.ts';

/** The registry boot message: just the RPC port to serve on (no graphId, no config — the store is
 *  self-contained). The Worker may receive several over its life (one per session) but opens the host
 *  exactly ONCE and serves every session over it. */
interface Boot {
  port: MessagePort;
}

let host: Promise<ReplicatorRegistryHost> | undefined;

self.onmessage = (e: MessageEvent<Boot>) => {
  const { port } = e.data;
  host ??= ReplicatorRegistryHost.open();
  // Exposed as an RpcPromise over the open, so a call before open completes waits, and if open REJECTS every
  // call rejects with the reason (fail closed) — the same shape the graph worker uses.
  newMessagePortRpcSession(port, new RpcPromise(host));
};
