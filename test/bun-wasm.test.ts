import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { application } from '../src/application.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { FileIoStore } from '../src/bun/FileIoStore.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { memoryWasmSqlFactory } from '../src/browser/WasmSqlite.ts';
import { ReplicatorStore, storeRegistry } from '../src/replicator-registry.ts';
import { runDueReplications } from '../src/scheduler.ts';
import { defaultHttp } from '../src/http-federation.ts';
import { graphContract } from './contract.ts';

// The browser SQL leaf (`WasmSqlite`, src/browser/WasmSqlite.ts) run against the WHOLE conformance
// contract — the same assertions that prove Bun and Cloudflare, driven through the real gremlin GLV
// over GraphBinary. It earns that coverage IN-PROCESS: `@sqlite.org/sqlite-wasm`'s OO1 API is
// synchronous and runs a real WASM SQLite (3.53.0, FTS5 + JSON) in this Bun process, so the store
// leaf is proven deeply here without a browser. Only the VFS differs in a real browser — `opfs-sahpool`
// instead of `:memory:` — and that is what the Playwright lane (test/browser/) covers; the
// SQL the compiler emits, exercised end to end here (movement, group, io formats, and the `barrier_state`
// OLAP SQL — WITHOUT ROWID, `INSERT … RETURNING`, per-round `WITH … INSERT`), is identical on both VFSes.
//
// The reuse is the point: `BunGraphManager`'s graph-lifecycle logic is storage-agnostic, so injecting a
// `WasmSqlite` factory through its `makeSql` seam runs the identical manager the Bun server uses, with
// only the SQLite runtime swapped — isolating the variable under test to the WASM engine.
let server: ReturnType<typeof Bun.serve> | undefined;

graphContract('bun-wasm', {
  async start() {
    const makeSql = await memoryWasmSqlFactory();
    // A temp io root so the contract's io() round-trip has somewhere to read/write (the Bun twin of the
    // browser's OPFS IoStore, which the Playwright lane will cover); without it io() fails closed and
    // the io test would assert only that. extendedRegistry turns federation on for the federation test.
    const io = new FileIoStore(mkdtempSync(join(tmpdir(), 'mogwai-wasm-io-')));
    const manager = new BunGraphManager(undefined, extendedRegistry, io, undefined, makeSql);
    // The replicator control-plane registry on the WASM SQL leaf too, so the shared contract exercises
    // `/_replicator` CRUD AND the scheduler on the browser's engine (parity for the whole feature).
    const registry = storeRegistry(new ReplicatorStore(makeSql(':memory:')));
    const runTick = () => runDueReplications({ registry, manager, http: defaultHttp });
    const app = application({ manager, registry, runTick });
    server = Bun.serve({ port: 0, fetch: app.router });
    return `http://localhost:${server.port}`;
  },
  stop() {
    server?.stop(true);
  },
});
