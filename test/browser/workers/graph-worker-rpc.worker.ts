// Drives the graph-worker TRANSPORT, now Cap'n Web: this driver worker spawns the dedicated graph-worker
// entry as a nested Worker, hands it a MessageChannel port + graphId (its boot message), holds the
// capnweb stub over the other port, and exercises the RPC — open (first info), seed, read (Framed[]
// crossing the structured-clone boundary as native Uint8Array/bigint), info, and a FAILURE that must come
// back as a value (a bad query rejects the stub; it must not hang). Proves the browser twin of the
// Durable Object clone-boundary the doc flags: a payload that fails to cross the Worker boundary.
import '../../../src/browser/buffer-global.ts'; // first — Buffer for the decode path (streamBuffers/ioc)
import { newMessagePortRpcSession, type RpcStub } from 'capnweb';
import type { GraphWorkerHost } from '../../../src/browser/GraphWorkerHost.ts';
import { streamBuffers } from '../../../src/http.ts';
import { ioc } from '../../../src/io.ts';
import type { Framed } from '../../../src/execute.ts';

async function read(stub: RpcStub<GraphWorkerHost>, gremlin: string): Promise<any[]> {
  // Framed buffers arrive as Uint8Array across the port — rewrap to Buffer for the response framing.
  const framed: Framed[] = (await stub.framed(gremlin, {})).map((f) => ({ buf: Buffer.from(f.buf), bulk: f.bulk }));
  const bytes = Buffer.from(await streamBuffers(framed, Math.max(framed.length, 1), false).arrayBuffer());
  return (await ioc.graphBinaryReader.readResponse(bytes)).result.data;
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e: any) { results.push({ name, ok: false, error: String(e?.stack || e) }); }
}

self.onmessage = async () => {
  try {
    const worker = new Worker('/graph-worker.js', { type: 'module' });
    const channel = new MessageChannel();
    const graphId = `gwrpc-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    worker.postMessage({ port: channel.port2, graphId }, [channel.port2]);
    const stub = newMessagePortRpcSession<GraphWorkerHost>(channel.port1);

    await check('open boots the host with empty counts', async () => {
      const opened = await stub.info();
      if (opened.vertexCount !== 0 || opened.edgeCount !== 0) throw new Error(`opened = ${JSON.stringify(opened)}`);
    });

    await stub.framed("g.addV('person').property('name','marko').property('age',29)", {});
    await stub.framed("g.addV('person').property('name','vadas').property('age',27)", {});

    await check('info reflects the seeded writes', async () => {
      const i = await stub.info();
      if (i.vertexCount !== 2) throw new Error(`info = ${JSON.stringify(i)}`);
    });
    await check('a query result crosses the boundary and decodes', async () => {
      const d = await read(stub, 'g.V().count()');
      if (Number(d[0]) !== 2) throw new Error(`count = ${d[0]}`);
    });
    await check('a filtered value stream crosses and decodes', async () => {
      const d = (await read(stub, "g.V().has('age',gt(28)).values('name')")).map(String);
      if (JSON.stringify(d) !== JSON.stringify(['marko'])) throw new Error(`filtered = ${JSON.stringify(d)}`);
    });
    await check('a failing query rejects as a value (does not hang the RPC)', async () => {
      let threw = false;
      try { await stub.framed('g.V().sack()', {}); } catch { threw = true; }
      if (!threw) throw new Error('an unsupported query did not reject the RPC');
    });

    (self as any).postMessage({ results });
  } catch (e: any) {
    (self as any).postMessage({ results, fatal: String(e?.stack || e) });
  }
};
