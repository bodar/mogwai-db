import { GraphStore } from '../storage.js';
import { application } from '../application.js';
import { BunSqlite } from './BunSqlite.js';

/** Bun entry point: build the store over bun:sqlite, wire the app, serve. */
export function startServer(port = 8182, dbPath = process.env.MOGWAI_DB ?? ':memory:') {
  const store = new GraphStore(new BunSqlite(dbPath));
  const app = application({ store });
  return Bun.serve({ port, fetch: app.handler });
}

if (import.meta.main) {
  const server = startServer();
  console.log(`mogwai-db listening on :${server.port}`);
}
