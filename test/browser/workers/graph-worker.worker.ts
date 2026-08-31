// Drives a GraphWorkerHost in the browser over the REAL opfs-sahpool VFS: seeds a graph and reads it
// back through the full compiler → executor → GraphBinary wire, decoding each result with the vendored
// gremlin client's own reader (so the whole wire path — encode in the worker, decode in the worker —
// is proven to run in a browser). This is the browser twin of the gremlin data-plane contract, and the
// proof that the entire core runs in a dedicated Worker on the production storage VFS.
import '../../../src/browser/buffer-global.ts'; // MUST be first — installs Buffer before http.ts/io.ts init
import { GraphWorkerHost } from '../../../src/browser/GraphWorkerHost.ts';
import { streamBuffers } from '../../../src/http.ts';
import { ioc } from '../../../src/io.ts';

async function read(host: GraphWorkerHost, gremlin: string): Promise<any[]> {
  const framed = await host.framed(gremlin, {});
  // Frame a full GraphBinary response (one batch) and decode it exactly as a client would over HTTP.
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
    const host = await GraphWorkerHost.open(`gw-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);

    // Seed over the wire (writes go through the same compile+execute path).
    await host.framed("g.addV('person').property('name','marko').property('age',29)", {});
    await host.framed("g.addV('person').property('name','vadas').property('age',27)", {});
    await host.framed("g.addV('software').property('name','lop')", {});
    await host.framed("g.V().has('name','marko').addE('knows').to(V().has('name','vadas'))", {});
    await host.framed("g.V().has('name','marko').addE('created').to(V().has('name','lop'))", {});

    await check('count() over the opfs-sahpool store', async () => {
      const d = await read(host, 'g.V().count()');
      if (Number(d[0]) !== 3) throw new Error(`count = ${d[0]}`);
    });
    await check('hasLabel + values (property read from WASM SQLite)', async () => {
      const d = (await read(host, "g.V().hasLabel('person').values('name')")).map(String).sort();
      if (JSON.stringify(d) !== JSON.stringify(['marko', 'vadas'])) throw new Error(`names = ${JSON.stringify(d)}`);
    });
    await check('has(age, gt(28)) filters', async () => {
      const d = (await read(host, "g.V().has('age',gt(28)).values('name')")).map(String);
      if (JSON.stringify(d) !== JSON.stringify(['marko'])) throw new Error(`filtered = ${JSON.stringify(d)}`);
    });
    await check('out(knows) traverses an edge', async () => {
      const d = (await read(host, "g.V().has('name','marko').out('knows').values('name')")).map(String);
      if (JSON.stringify(d) !== JSON.stringify(['vadas'])) throw new Error(`out = ${JSON.stringify(d)}`);
    });
    await check('order().by(age) sorts', async () => {
      const d = (await read(host, "g.V().hasLabel('person').order().by('age').values('name')")).map(String);
      if (JSON.stringify(d) !== JSON.stringify(['vadas', 'marko'])) throw new Error(`ordered = ${JSON.stringify(d)}`);
    });
    await check('label() reads the interned label', async () => {
      const d = (await read(host, "g.V().has('name','lop').label()")).map(String);
      if (JSON.stringify(d) !== JSON.stringify(['software'])) throw new Error(`label = ${JSON.stringify(d)}`);
    });
    await check('a vertex round-trips id, label, and materialized properties', async () => {
      const d = await read(host, "g.V().has('name','vadas')");
      const v = d[0];
      if (v?.label !== 'person') throw new Error(`label = ${v?.label}`);
      const props = Object.fromEntries((v.properties ?? []).map((p: any) => [p.key, p.value]));
      if (props.name !== 'vadas' || Number(props.age) !== 27) throw new Error(`props = ${JSON.stringify(props)}`);
    });

    (self as any).postMessage({ results });
  } catch (e: any) {
    (self as any).postMessage({ results, fatal: String(e?.stack || e) });
  }
};
