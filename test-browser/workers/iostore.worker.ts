// A dedicated Worker that exercises OpfsIoStore against REAL OPFS in the browser and posts back a list
// of {name, ok, error} checks. Runs the IoStore contract's browser-specific half — streaming read/write,
// fail-closed absence, prefix listing, re-openable reads, truncation, and abort — the shape neither the
// Bun (FileIoStore) nor Cloudflare (R2IoStore) leaf can prove here.
import { OpfsIoStore } from '../../src/browser/OpfsIoStore.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let len = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    len += value.length;
  }
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return dec.decode(out);
}

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e: any) {
    results.push({ name, ok: false, error: String(e?.stack || e) });
  }
}

self.onmessage = async () => {
  // A base directory unique per run keeps this store's tree isolated (Chrome launches a fresh profile,
  // so OPFS starts empty anyway, but this stays honest if a browser is ever reused).
  const io = new OpfsIoStore([`io-test-${Date.now()}`]);

  await check('write then read round-trips through a stream', async () => {
    const sink = await io.writeStream('a/b.json');
    await sink.write(enc.encode('{"x":1}'));
    await sink.close();
    const got = await drain(await io.readStream('a/b.json'));
    if (got !== '{"x":1}') throw new Error(`round-trip mismatch: ${got}`);
  });

  await check('a multi-chunk write reassembles in order', async () => {
    const sink = await io.writeStream('big.bin');
    for (let i = 0; i < 5; i++) await sink.write(enc.encode(`chunk${i};`));
    await sink.close();
    const got = await drain(await io.readStream('big.bin'));
    if (got !== 'chunk0;chunk1;chunk2;chunk3;chunk4;') throw new Error(`multi-chunk: ${got}`);
  });

  await check('an absent document fails closed', async () => {
    let threw = false;
    try { await io.readStream('missing.json'); } catch (e: any) {
      threw = true;
      if (!/no such document/.test(String(e?.message))) throw new Error(`wrong message: ${e?.message}`);
    }
    if (!threw) throw new Error('reading an absent document did not throw');
  });

  await check('list returns sorted root-relative keys, scoped by prefix', async () => {
    const sink = await io.writeStream('a/c.json');
    await sink.write(enc.encode('2'));
    await sink.close();
    const all = await io.list('');
    if (JSON.stringify(all) !== JSON.stringify(['a/b.json', 'a/c.json', 'big.bin']))
      throw new Error(`list('') = ${JSON.stringify(all)}`);
    const scoped = await io.list('a/');
    if (JSON.stringify(scoped) !== JSON.stringify(['a/b.json', 'a/c.json']))
      throw new Error(`list('a/') = ${JSON.stringify(scoped)}`);
  });

  await check('a read is re-openable (two passes — GraphSON needs it)', async () => {
    const p1 = await drain(await io.readStream('a/b.json'));
    const p2 = await drain(await io.readStream('a/b.json'));
    if (p1 !== '{"x":1}' || p2 !== '{"x":1}') throw new Error(`re-open mismatch: ${p1} / ${p2}`);
  });

  await check('a rewrite truncates (no stale tail)', async () => {
    let s = await io.writeStream('rw.txt');
    await s.write(enc.encode('longer-original-content'));
    await s.close();
    s = await io.writeStream('rw.txt');
    await s.write(enc.encode('short'));
    await s.close();
    const got = await drain(await io.readStream('rw.txt'));
    if (got !== 'short') throw new Error(`stale tail: ${got}`);
  });

  await check('abort leaves no half-graph behind', async () => {
    const s = await io.writeStream('aborted.txt');
    await s.write(enc.encode('partial'));
    await s.abort();
    let threw = false;
    try { await io.readStream('aborted.txt'); } catch { threw = true; }
    if (!threw) throw new Error('aborted document is still readable');
  });

  (self as any).postMessage({ results });
};
