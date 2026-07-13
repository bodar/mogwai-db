import { startServer } from '../src/bun/server.ts';
import { graphContract } from './contract.ts';

let server: ReturnType<typeof startServer> | undefined;

// port 0 → OS-assigned free port; fresh in-memory registry per run.
graphContract('bun', {
  async start() {
    server = startServer(0);
    return `http://localhost:${server.port}`;
  },
  stop() {
    server?.stop(true);
  },
});
