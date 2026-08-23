import { test, expect, describe } from 'bun:test';
import { seeded } from '../support/graph.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { loadGraphson } from '../../src/formats/graphson.ts';
import { readFileSync } from 'node:fs';
import { MODERN_SEED } from '../fixtures/seed-modern.ts';
import { relaxWeighted } from '../../src/services/catalog/graph-algorithms.ts';

// The BSP half of weighted shortestPath (docs/2026-08-23-barrier-substrate-reshape-plan.md §5): a
// Bellman-Ford relaxation writing dist per (source, node) into barrier_state (scope = source, channel 0).
// This pins the relaxation itself — dist correctness on modern, and TERMINATION on the dense grateful
// `followedBy` graph that the recursive-CTE walk hangs on (9b77dd5). Path reconstruction is a later step.

const idByName = (store: GraphStore, name: string): number =>
  store.query<{ node: number }>(`SELECT node FROM vertex_properties WHERE key = 'name' AND value = ?`, [name])[0].node;

const dist = (store: GraphStore, run: number, slot: number, scope: number, id: number): number | undefined =>
  store.query<{ cval: number }>(
    `SELECT cval FROM barrier_state WHERE run = ? AND round = ? AND scope = ? AND id = ? AND channel = 0`,
    [run, slot, scope, id])[0]?.cval;

describe('weighted shortest distance — Bellman-Ford relaxation (barrier_state, scope=source)', () => {
  test('modern, source marko, bothE, weight: dist to josh is 0.8 (marko-lop-josh beats marko-knows-josh 1.0)', () => {
    const store = seeded(MODERN_SEED);
    const marko = idByName(store, 'marko');
    const run = store.allocBarrierRun();
    const slot = relaxWeighted(store, run, [marko], { direction: 'both', labels: [] }, 'weight');
    // marko→lop 0.4 + lop-josh 0.4 (josh created lop, undirected) = 0.8; direct marko-knows-josh = 1.0.
    expect(dist(store, run, slot, marko, idByName(store, 'josh'))).toBeCloseTo(0.8, 5);
    expect(dist(store, run, slot, marko, idByName(store, 'marko'))).toBe(0); // self
    store.dropBarrierRun(run);
  });

  test('grateful weighted followedBy TERMINATES (the walk hangs here) and reaches the target', () => {
    const GRAPHSON = 'vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/structure/io/graphson';
    const store = new GraphStore(new BunSqlite(':memory:'));
    loadGraphson(store, readFileSync(new URL(`../../${GRAPHSON}/grateful-dead-v3.json`, import.meta.url).pathname, 'utf8'));
    const src = store.query<{ node: number }>(`SELECT node FROM vertex_properties WHERE key = 'name' AND value = 'MIGHT AS WELL'`)[0].node;
    const tgt = store.query<{ node: number }>(`SELECT node FROM vertex_properties WHERE key = 'name' AND value = 'MAYBE YOU KNOW HOW I FEEL'`)[0].node;
    const run = store.allocBarrierRun();
    const t = performance.now();
    const slot = relaxWeighted(store, run, [src], { direction: 'out', labels: ['followedBy'] }, 'weight');
    const ms = performance.now() - t;
    expect(ms).toBeLessThan(30_000); // the recursive-CTE walk never finished here
    expect(dist(store, run, slot, src, tgt)).toBeGreaterThan(0); // reachable, finite
    store.dropBarrierRun(run);
  });
});
