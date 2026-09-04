import { test, expect, describe } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { standardRegistry } from '../src/services/standard.ts';
import { makeRouter } from '../src/router.ts';
import { ReplicatorStore, storeRegistry, type ReplicationConfig } from '../src/replicator-registry.ts';
import { buildOpenApiSpec } from '../src/docs.ts';
import type { Http } from '../src/api.ts';

// Phase 5b (docs/archive/2026-09-02-replication-and-http-interop-plan.md §9/§9·2): the ReplicatorRegistry seam +
// top-level `_replicator` CRUD. Ongoing replication is a standalone `{source, target}` job persisted in a
// singleton control-plane store (a DO on CF, native sqlite here), CouchDB's node-global `_replicator`. The
// scheduler (5c) enumerates due jobs from it; 5b is just the CRUD + its OpenAPI surface.

const setup = () => {
  const mgr = new BunGraphManager(undefined, standardRegistry);
  const registry = storeRegistry(new ReplicatorStore(new BunSqlite(':memory:')));
  const router: Http = makeRouter(mgr, undefined, undefined, registry);
  const noRegistry: Http = makeRouter(mgr); // a runtime without a registry yet (browser edge pre-5c)
  return { router, noRegistry };
};

const jsonReq = (url: string, method: string, body?: unknown) =>
  new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}) });

describe('replicator config CRUD (Phase 5b)', () => {
  test('POST creates a job (id generated), GET lists and reads it', async () => {
    const s = setup();
    const created = await s.router(jsonReq('http://h/_replicator', 'POST', { source: 'http://peer/gremlin/prod', target: 'local' }));
    expect(created.status).toBe(201);
    const { id, ok } = (await created.json()) as { id: string; ok: boolean };
    expect(ok).toBe(true);
    expect(id).toBeTruthy();

    const list = (await (await s.router(new Request('http://h/_replicator'))).json()) as { configs: ReplicationConfig[] };
    expect(list.configs).toHaveLength(1);
    expect(list.configs[0]).toMatchObject({ id, source: 'http://peer/gremlin/prod', target: 'local', continuous: false, useCheckpoints: true });

    const one = (await (await s.router(new Request(`http://h/_replicator/${id}`))).json()) as ReplicationConfig;
    expect(one).toMatchObject({ id, source: 'http://peer/gremlin/prod', target: 'local' });
  });

  test('POST with a chosen id; PUT upserts it (fields update)', async () => {
    const s = setup();
    await s.router(jsonReq('http://h/_replicator', 'POST', { id: 'nightly', source: 'local', target: 'http://peer/gremlin/backup' }));
    const put = await s.router(jsonReq('http://h/_replicator/nightly', 'PUT',
      { source: 'local', target: 'http://peer/gremlin/backup', continuous: true, checkpoint_interval: 60000 }));
    expect(put.status).toBe(201);
    const one = (await (await s.router(new Request('http://h/_replicator/nightly'))).json()) as ReplicationConfig;
    expect(one).toMatchObject({ id: 'nightly', continuous: true, checkpointInterval: 60000 });
  });

  test('DELETE is idempotent; GET of an absent job is 404', async () => {
    const s = setup();
    await s.router(jsonReq('http://h/_replicator', 'POST', { id: 'gone', source: 'a', target: 'b' }));
    expect((await s.router(jsonReq('http://h/_replicator/gone', 'DELETE'))).status).toBe(204);
    expect((await s.router(jsonReq('http://h/_replicator/gone', 'DELETE'))).status).toBe(204); // idempotent
    expect((await s.router(new Request('http://h/_replicator/gone'))).status).toBe(404);
    const list = (await (await s.router(new Request('http://h/_replicator'))).json()) as { configs: unknown[] };
    expect(list.configs).toHaveLength(0);
  });

  test('a job missing source/target is rejected 400', async () => {
    const s = setup();
    expect((await s.router(jsonReq('http://h/_replicator', 'POST', { source: 'only-source' }))).status).toBe(400);
    expect((await s.router(jsonReq('http://h/_replicator', 'POST', { source: '', target: '' }))).status).toBe(400);
  });

  test('a runtime without a registry returns 501 on the replicator routes', async () => {
    const s = setup();
    const res = await s.noRegistry(new Request('http://h/_replicator'));
    expect(res.status).toBe(501);
    expect(((await res.json()) as { error: string }).error).toMatch(/registry/);
  });

  test('unknown method on the collection is 405', async () => {
    const s = setup();
    expect((await s.router(jsonReq('http://h/_replicator', 'DELETE'))).status).toBe(405);
  });

  test('the store round-trips a full config', () => {
    const store = new ReplicatorStore(new BunSqlite(':memory:'));
    const cfg: ReplicationConfig = { id: 'x', source: 's', target: 't', continuous: true, createTarget: true, filter: 'g.V().hasLabel("keep")', checkpointInterval: 5000, useCheckpoints: false };
    store.putConfig(cfg);
    expect(store.getConfig('x')).toEqual(cfg);
    expect(store.getConfig('missing')).toBeNull();
    expect(store.deleteConfig('x')).toBe(true);
    expect(store.deleteConfig('x')).toBe(false);
  });

  test('OpenAPI documents the replicator endpoints (the UI falls out for free)', () => {
    const spec = buildOpenApiSpec('gremlin');
    expect(spec.paths['/_replicator']).toBeDefined();
    expect(spec.paths['/_replicator/{configId}']).toBeDefined();
    expect(spec.paths['/_replicator'].get).toBeDefined();
    expect(spec.paths['/_replicator'].post).toBeDefined();
  });
});
