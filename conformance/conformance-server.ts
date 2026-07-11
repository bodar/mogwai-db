// L3 conformance host: one Bun server that fronts the several named toy graphs
// the official TinkerPop cucumber suite opens. The suite connects to a single
// URL (http://localhost:45940/gremlin by default) and selects a graph by the
// traversal-source name in the request `g` field:
//
//   modern -> gmodern   classic -> gclassic   crew -> gcrew
//   grateful -> ggrateful   sink -> gsink   empty -> ggraph
//
// We map that name to a per-graph GraphStore. `gmodern` is seeded with the
// canonical ids; `ggraph` is empty and writable (the runner resets it with
// g.V().drop() before each @StepWrite-style scenario). The other reference
// graphs start empty until their seeds land — run narrow with cucumber --tags.
//
// This is a DEV harness only. It routes on the `g` field on purpose, which the
// production Worker must NOT do (locked decision: tenancy is the URL path).
// Here there is one tenant and many named graphs, exactly the two-level model.
import { GraphStore } from '../src/storage.ts';
import { seedModern } from './seed-modern.ts';
import { makeHandler } from '../src/handler.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';

const SEEDS: Record<string, (s: GraphStore) => void> = {
  gmodern: seedModern,
  // gclassic/gcrew/ggrateful/gsink: add seeds as their scenarios come online.
};

const stores = new Map<string, GraphStore>();
function storeFor(g: string): GraphStore {
  let store = stores.get(g);
  if (!store) {
    store = new GraphStore(new BunSqlite(':memory:'));
    SEEDS[g]?.(store);
    stores.set(g, store);
  }
  return store;
}

const handler = makeHandler(storeFor);

export function startConformanceServer(port = 45940) {
  return Bun.serve({
    port,
    async fetch(req) {
      // The runner posts to /gremlin; accept any path for robustness.
      return handler(req);
    },
  });
}

if (import.meta.main) {
  const server = startConformanceServer();
  console.log(`mogwai-db conformance host on :${server.port}/gremlin (graphs: gmodern seeded, others empty)`);
}
