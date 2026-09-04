// Shared browser plumbing for a graph's dedicated Worker: spawning it, bootstrapping a fresh capnweb
// session port to it, and removing its OPFS database. Used by both the LocalWorkerSource (a context that
// spawns its own Workers) and the WorkerFactory (the page that spawns on the Service Worker's behalf).
//
// It also declares the ONE native message class the browser port uses: the capnweb `Bootstrap` — a
// MessagePort hand-off. capnweb's own MessagePortTransport posts with no transfer list, so it cannot
// itself carry a port; a port must be delivered natively before any typed capnweb call is possible. These
// messages carry ONLY a port (+ a tag) or nothing, so there is no application payload to grow — everything
// with meaning is a typed capnweb call.

import type { MogwaiConfig } from '../config.ts';

/** The native messages between the Service Worker edge and a WorkerFactory page. All are transport
 *  bootstraps: `*-port` hands a MessagePort over (transferred), `need-control` is the SW re-soliciting a
 *  control session after it (or its ports) was reaped. */
export type BootstrapMessage =
  | { kind: 'mogwai-control-port'; port: MessagePort } // factory → SW: a port to the WorkerFactory RPC session
  | { kind: 'mogwai-graph-port'; graphId: string; port: MessagePort } // factory → SW: a port to a graph's Worker
  | { kind: 'mogwai-registry-port'; port: MessagePort } // factory → SW: a port to the singleton registry Worker
  | { kind: 'mogwai-need-control' }; // SW → factory: (re)open a control session

/** Boot a NEW capnweb session on an already-spawned graph Worker: make a channel, hand the Worker one end
 *  (it serves `newMessagePortRpcSession(port, host)` over it), and return the other end for the caller to
 *  wrap or forward. The Worker opens its host once and serves every session over that one host. `config`
 *  rides the boot message so the Worker can build its allowlisted Http seam (io()/federate over http);
 *  it is consumed only on the FIRST boot (the one that opens the host), harmless on later sessions. */
export function bootSession(worker: Worker, graphId: string, config?: MogwaiConfig): MessagePort {
  const channel = new MessageChannel();
  worker.postMessage({ port: channel.port1, graphId, config }, [channel.port1]);
  return channel.port2;
}

/** Spawn graph `graphId`'s dedicated Worker and boot its first session. Only a Window can spawn a
 *  dedicated Worker, and the Worker dies with its owner document — so the spawner is also the owner. */
export function spawnGraphWorker(workerUrl: string | URL, graphId: string, config?: MogwaiConfig): { worker: Worker; port: MessagePort } {
  const worker = new Worker(workerUrl, { type: 'module', name: graphId });
  return { worker, port: bootSession(worker, graphId, config) };
}

/** Boot a NEW capnweb session on the singleton REGISTRY Worker: it takes only a port (the registry store is
 *  self-contained — no graphId, no config). Serves every session over its one host, so this is safe to call
 *  again for a re-handshake. */
export function bootRegistrySession(worker: Worker): MessagePort {
  const channel = new MessageChannel();
  worker.postMessage({ port: channel.port1 }, [channel.port1]);
  return channel.port2;
}

/** Spawn the singleton registry Worker and boot its first session. */
export function spawnRegistryWorker(workerUrl: string | URL): { worker: Worker; port: MessagePort } {
  const worker = new Worker(workerUrl, { type: 'module', name: '_replicator' });
  return { worker, port: bootRegistrySession(worker) };
}

/** Remove a graph's OPFS database directory (recursively) if present; a missing directory is a no-op.
 *  Navigates to the PARENT and removes only the leaf, so `.mogwai/<id>` never wipes the whole `.mogwai`
 *  tree. Best-effort: a still-releasing SAH handle is not retried here — the schema DDL on the next open
 *  restores a clean empty graph regardless. */
export async function removeOpfsDir(path: string): Promise<void> {
  const segs = path.split('/').filter((s) => s.length > 0);
  const leaf = segs.pop();
  if (leaf === undefined) return;
  try {
    let dir = await navigator.storage.getDirectory();
    for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create: false });
    await dir.removeEntry(leaf, { recursive: true });
  } catch (e) {
    if (!(e instanceof DOMException && e.name === 'NotFoundError')) throw e;
  }
}
