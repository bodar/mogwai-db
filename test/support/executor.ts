import { Executor, type Framed } from '../../src/execute.ts';
import { standardRegistry } from '../../src/services/standard.ts';
import type { GraphStore } from '../../src/storage.ts';
import type { RegistryProvider } from '../../src/scopes.ts';
import type { FederationSource } from '../../src/compiler/segment.ts';
import type { TypeNode } from '../../src/gremlin/types.ts';
import type { FastPathConfig } from '../../src/compiler/compiler.ts';

// Shared test fixture — the ONE place tests get an Executor. Most tests run non-federated
// traversals against a single in-memory store, so they use the SYNC path (framed/buffers) and
// don't need a manager: `exec(store)` binds an Executor to that store + the reference registry +
// a no-sibling federation source. Federation tests use a real BunGraphManager instead
// (test/federation.test.ts). This replaces the old free executeQuery/executeFramed helpers with a
// single bound object so no test threads store/registry through per-call args.
//
// `exec(...).raw(...)` (the async federation path) is unavailable here (no siblings); a test that
// needs it uses a BunGraphManager. Calling the sync helpers on a FEDERATED traversal throws a
// clear "use the async path" error (correct — this fixture is the sync, non-federated seam).

const NO_SIBLINGS: FederationSource = {
  executor: (id) => { throw new Error(`test executor has no sibling graph "${id}" (use a BunGraphManager for federation tests)`); },
};

/** An Executor bound to `store` + `registry` (default: the reference services) + a no-sibling
 *  source. The sync framed/buffers methods are the store-tier data plane for tests. `fastPaths`
 *  overrides the ambient config (L5's differential runs the same traversal with them off). */
export const exec = (store: GraphStore, registry: RegistryProvider = standardRegistry, fastPaths?: FastPathConfig): Executor =>
  new Executor(store, registry, NO_SIBLINGS, fastPaths);

/** SYNC flat Buffer[] — the drop-in for the old `executeQuery(store, g, p)` (same signature,
 *  same synchronous result). Throws if the traversal federates (use a manager). */
export const executeQuery = (store: GraphStore, gremlin: string, params: Record<string, any> = {}, paramTypes: Record<string, TypeNode> = {}, registry?: RegistryProvider): Buffer[] =>
  exec(store, registry).buffers(gremlin, params, paramTypes);

/** SYNC Framed[] — the drop-in for the old `executeFramed(store, g, p)`. */
export const executeFramed = (store: GraphStore, gremlin: string, params: Record<string, any> = {}, paramTypes: Record<string, TypeNode> = {}, registry?: RegistryProvider): Framed[] =>
  exec(store, registry).framed(gremlin, params, paramTypes);
