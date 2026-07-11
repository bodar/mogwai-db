import { startServer } from '../src/bun/server.js';
import { graphContract } from './contract.js';

let server: ReturnType<typeof startServer> | undefined;

// port 0 → OS-assigned free port; fresh :memory: store per run.
graphContract('bun', {
  async start() {
    server = startServer(0);
    return `http://localhost:${server.port}/`;
  },
  stop() {
    server?.stop(true);
  },
});
