import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/bun/server.ts';
import { graphContract } from './contract.ts';

let server: ReturnType<typeof startServer> | undefined;

// port 0 → OS-assigned free port; fresh in-memory registry per run.
graphContract('bun', {
  async start() {
    // A temp io root, the Bun half of the IoStore seam (the Worker's is an R2 binding declared in
    // wrangler.jsonc). Without it io() would fail closed naming the missing binding, and the shared
    // contract's io test would be asserting only that.
    server = startServer(0, undefined, undefined, mkdtempSync(join(tmpdir(), 'mogwai-io-contract-')));
    return `http://localhost:${server.port}`;
  },
  stop() {
    server?.stop(true);
  },
});
