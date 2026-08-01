import { test, expect, describe } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { FileIoStore } from '../src/bun/FileIoStore.ts';
import { NO_IO_STORE } from '../src/iostore.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { createAppScope } from '../src/scopes.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { writeGraphson } from '../src/formats/graphson.ts';
import { exec } from './support/executor.ts';
import { decode, decodeAll } from './support/decode.ts';
import { parseGremlin, stepChain } from '../src/gremlin/frontend.ts';
import { runPasses } from '../src/compiler/ir/passes.ts';

// io() over the REAL stack: a rooted FileIoStore, the internal mogwai.io service, and the barrier
// seam it desugars onto. `io()` is TinkerPop's own step; what makes it work here is entirely DI —
// the service takes the IoStore and this graph's store at construction, so the barrier contract
// (`apply(rows)`) never widened. See docs/archive/2026-07-31-di-scopes-and-services-plan.md.

/** A temp io namespace holding one typed-GraphSON dump of the modern graph. */
function ioDir(): string {
  const src = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) exec(src).buffers(g, {});
  const dir = mkdtempSync(join(tmpdir(), 'mogwai-io-'));
  writeFileSync(join(dir, 'modern.json'), writeGraphson(src));
  return dir;
}

const managerOn = (dir: string) => new BunGraphManager(undefined, standardRegistry, undefined, new FileIoStore(dir));

const steps = (gremlin: string) =>
  runPasses(stepChain(parseGremlin(gremlin), {}), { with: [], without: [] } as any, {}).steps;

describe('io() desugars to a call() on the internal service', () => {
  test('io(path).read() becomes one call step carrying path + direction', () => {
    const [call, ...rest] = steps('g.io("data/modern.json").read()');
    expect(rest).toEqual([]);                       // read() is consumed — it WAS the direction
    expect(call.name).toBe('call');
    expect(call.args[0]).toBe('mogwai.io');
    expect(call.args[1]).toEqual(new Map<string, any>([['path', 'data/modern.json'], ['direction', 'read']]));
  });

  test('io(path).write() carries direction=write', () => {
    const [call] = steps('g.io("x.json").write()');
    expect((call.args[1] as Map<string, any>).get('direction')).toBe('write');
  });

  test('an io().with(k,v) modulator folds onto the minted call, as a hand-written call()"s would', () => {
    // desugarIo re-emits the with() steps AFTER the call so absorbCallWith folds them — the whole
    // reason it runs first. Nothing io-specific handles with().
    const [call] = steps('g.io("x.json").with("~tinkerpop.io.registry","r").read()');
    expect(call.withArgs).toEqual([['~tinkerpop.io.registry', 'r']]);
  });

  test('IO.reader/IO.graphson resolve to the strings a GLV puts on the wire', () => {
    // The front-end emits the canonical string rather than a tagged token, so a query typed at our
    // server and the same query from a client become the SAME chain. Before this, the enum
    // constants were dropped entirely and with() saw no argument at all.
    const [call] = steps('g.io("x.json").with(IO.reader, IO.graphson).read()');
    expect(call.withArgs).toEqual([['~tinkerpop.io.reader', 'graphson']]);
  });

  test('io() with no read()/write() fails closed — an unstated direction is not a no-op', () => {
    expect(() => steps('g.io("x.json")')).toThrow(/must be followed by read\(\) or write\(\)/);
  });
});

describe('io().read() over the real stack', () => {
  test('loads the document into THIS graph and returns no traversers', async () => {
    const ex = managerOn(ioDir()).executor('target');
    const result = await ex.framedAsync('g.io("modern.json").read()', {});
    expect(result).toEqual([]);                     // the official scenarios assert an empty result

    const [count] = await ex.framedAsync('g.V().count()', {});
    expect(Number(await decode(count.buf))).toBe(6);
    const names = await decodeAll((await ex.framedAsync('g.V().values("name")', {})).map((f) => f.buf));
    expect(names.sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a nested path resolves under the io root', async () => {
    const dir = ioDir();
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'nested.json'), readFileSync(join(dir, 'modern.json')));
    const ex = managerOn(dir).executor('g');
    await ex.framedAsync('g.io("data/nested.json").read()', {});
    const [count] = await ex.framedAsync('g.V().count()', {});
    expect(Number(await decode(count.buf))).toBe(6);
  });

  test('the SYNC path refuses it, exactly as it refuses a federated traversal', () => {
    // io() in source position makes an otherwise-synchronous traversal async. That is not a new
    // failure mode — framed()/buffers() already throw for a barrier.
    const ex = managerOn(ioDir()).executor('g');
    expect(() => (ex as any).framed('g.io("modern.json").read()', {})).toThrow(/async path/);
  });
});

describe('io().write() over the real stack', () => {
  test('dumps this graph out, and the dump reads back into an empty graph', async () => {
    const dir = ioDir();
    const mgr = managerOn(dir);
    const src = mgr.executor('src');
    await src.framedAsync('g.io("modern.json").read()', {});
    expect(await src.framedAsync('g.io("out/dump.json").write()', {})).toEqual([]);

    const round = mgr.executor('round');
    await round.framedAsync('g.io("out/dump.json").read()', {});
    const [count] = await round.framedAsync('g.V().count()', {});
    expect(Number(await decode(count.buf))).toBe(6);
    const [edges] = await round.framedAsync('g.E().count()', {});
    expect(Number(await decode(edges.buf))).toBe(6);
  });
});

describe('io() over CSV — one file in, two files out', () => {
  test('write() emits the vertex and edge documents at the derived keys, and each reads back', async () => {
    // The format's shape, not a choice: a vertex file and an edge file have different system columns,
    // so they cannot share a header. The derived keys are ordinary readable paths (csvPaths), which is
    // what keeps the round trip two plain read()s.
    const dir = ioDir();
    const store = new FileIoStore(dir);
    const mgr = managerOn(dir);
    const src = mgr.executor('src');
    await src.framedAsync('g.io("modern.json").read()', {});
    expect(await src.framedAsync('g.io("out/graph.csv").write()', {})).toEqual([]);
    expect(await store.list('out/')).toEqual(['out/graph-edges.csv', 'out/graph-vertices.csv']);

    const round = mgr.executor('round');
    await round.framedAsync('g.io("out/graph-vertices.csv").read()', {});
    await round.framedAsync('g.io("out/graph-edges.csv").read()', {});
    const [count] = await round.framedAsync('g.V().count()', {});
    expect(Number(await decode(count.buf))).toBe(6);
    const [edges] = await round.framedAsync('g.E().count()', {});
    expect(Number(await decode(edges.buf))).toBe(6);
    const names = await decodeAll((await round.framedAsync('g.V().values("name")', {})).map((f) => f.buf));
    expect(names.sort()).toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a DECLARED writer selects CSV over the extension', async () => {
    const dir = ioDir();
    const mgr = managerOn(dir);
    await mgr.executor('src').framedAsync('g.io("modern.json").read()', {});
    await mgr.executor('src').framedAsync('g.io("out/dump.txt").with(IO.writer, "csv").write()', {});
    expect(await new FileIoStore(dir).list('out/')).toEqual(['out/dump-edges.txt', 'out/dump-vertices.txt']);
  });
});

describe('io() fails closed', () => {
  test('with no binding, naming what is missing rather than doing nothing', async () => {
    const ex = new BunGraphManager(undefined, standardRegistry).executor('g');
    await expect(ex.framedAsync('g.io("modern.json").read()', {}))
      .rejects.toThrow(/no io binding is configured/);
  });

  test('on a format we deliberately do not serve, naming the format', async () => {
    const ex = managerOn(ioDir()).executor('g');
    await expect(ex.framedAsync('g.io("x.xml").read()', {})).rejects.toThrow(/GraphML is not supported/);
    await expect(ex.framedAsync('g.io("x.kryo").read()', {})).rejects.toThrow(/Gryo is not supported/);
    await expect(ex.framedAsync('g.io("x.parquet").read()', {})).rejects.toThrow(/unrecognized format "\.parquet"/);
  });

  test('a DECLARED reader overrides the extension, in both directions', async () => {
    const ex = managerOn(ioDir()).executor('g');
    // .with(IO.reader, IO.gryo) on a .json path: the declaration wins, and Gryo is a wall.
    await expect(ex.framedAsync('g.io("modern.json").with(IO.reader, IO.gryo).read()', {}))
      .rejects.toThrow(/Gryo is not supported/);
    // and the reference form the official g_io_read_withXreader_graphsonX scenario uses works
    await ex.framedAsync('g.io("modern.json").with(IO.reader, IO.graphson).read()', {});
    const [count] = await ex.framedAsync('g.V().count()', {});
    expect(Number(await decode(count.buf))).toBe(6);
  });

  test('the format check happens BEFORE any io — an unsupported format costs no read', async () => {
    // NO_IO_STORE would report the missing binding; the format error winning proves the order.
    const mgr = new BunGraphManager(undefined, standardRegistry);
    await expect(mgr.executor('g').framedAsync('g.io("x.kryo").read()', {}))
      .rejects.toThrow(/Gryo is not supported/);
  });
});

describe('FileIoStore is ROOTED', () => {
  test('a path that escapes the root is rejected, resolved-final not textually', async () => {
    const store = new FileIoStore(ioDir());
    await expect(store.read('../../etc/passwd')).rejects.toThrow(/escapes the configured io directory/);
    // leaves and re-enters: textually contains "..", but lands inside, so it is legal
    await expect(store.read('data/../modern.json')).resolves.toBeInstanceOf(Uint8Array);
    // A LEADING SLASH is not an absolute path — a path is a KEY under the root, which is what it
    // is on R2 too, so `/etc/passwd` names a (missing) key rather than the host's file.
    await expect(store.read('/etc/passwd')).rejects.toThrow(/ENOENT/);
  });

  test('list() returns root-relative, /-separated keys under a prefix', async () => {
    const dir = ioDir();
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'a.json'), '{}');
    const store = new FileIoStore(dir);
    expect(await store.list('data/')).toEqual(['data/a.json']);
    expect(await store.list('')).toEqual(['data/a.json', 'modern.json']);
  });
});

describe('the io service is INTERNAL', () => {
  test('resolvable by name, absent from --list, in BOTH registries', async () => {
    const registry = createAppScope({ registry: standardRegistry }).registry;
    expect(registry.get('mogwai.io')?.name).toBe('mogwai.io');
    // the reference surface the official g_call/g_callXlistX scenarios assert is unchanged
    expect(registry.list().map((s) => s.name).sort()).toEqual(['tinker.degree.centrality', 'tinker.search']);
  });

  test('NO_IO_STORE rejects every operation, naming the binding', async () => {
    await expect(NO_IO_STORE.read('x')).rejects.toThrow(/no io binding is configured/);
    await expect(NO_IO_STORE.write('x', new Uint8Array())).rejects.toThrow(/no io binding is configured/);
    await expect(NO_IO_STORE.list('')).rejects.toThrow(/no io binding is configured/);
  });
});
