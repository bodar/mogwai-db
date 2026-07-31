import { test, expect, describe } from 'bun:test';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { landForeignElements } from '../src/compiler/steps/tail/foreign.ts';
import { executeQuery, exec } from './support/executor.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { LoweringEngine } from '../src/compiler/engine/engine.ts';
import { createAppScope, createRequestScope } from '../src/scopes.ts';
import { materializeRootStream } from '../src/compiler/steps/tail/materialize.ts';
import { normalize } from '../src/compiler/ir/passes.ts';
import { stepChain, parseGremlin } from '../src/gremlin/frontend.ts';
import type { ForeignRow } from '../src/services/spi/types.ts';
import type { LoweringState } from '../src/compiler/steps/context/context.ts';
import type { Elem } from '../src/compiler/plan/plan.ts';
import type { ForeignStream } from '../src/compiler/steps/context/stream.ts';

// Foreign (detached) element stream, tested in ISOLATION — no federation plumbing yet.
// A federated call() will feed landForeignElements the sibling's rows; here we hand it
// synthetic ForeignRow[] and prove the landing + read-tail + root framing round-trips, and
// that local movement over a detached element fails closed.

const store = new GraphStore(new BunSqlite(':memory:')); // empty — foreign rows are literals, no join
// A fresh lowering engine per call — it attaches itself to its Query, which the carry rides, so
// landForeignElements' seed reaches lowering via q.engine (the object-model wiring).
const freshEngine = (): LoweringEngine =>
  new LoweringEngine(createRequestScope(createAppScope(), { params: {} }));

// The {t,v} node shape vertexBuffer/edgeBuffer consume (one per key; vertex is multi-valued).
const vprops = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [{ t: typeof v === 'number' ? 'int' : 'string', v }]]));
const eprops = (o: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { t: typeof v === 'number' ? 'int' : 'string', v }]));

const vrow = (id: number | string, label: string, props: Record<string, unknown> = {}, labels: string[] = [label]): ForeignRow =>
  ({ kind: 'vertex', id, label, labels, props: vprops(props) });
const erow = (id: number, label: string, src: number, tgt: number, props: Record<string, unknown> = {}): ForeignRow =>
  ({ kind: 'edge', id, label, src, tgt, props: eprops(props) });

// Land rows, run the given trailing gremlin steps (empty = terminal element), materialize,
// execute against the empty store, return raw rows.
function landAndRun(rows: readonly ForeignRow[], elem: Elem, trailing = '') {
  const engine = freshEngine();
  const c: LoweringState = { q: engine.q, params: {}, traverserLayout: { aliases: new Map(), origins: [] } };
  const seed: ForeignStream = landForeignElements(c, rows, elem);
  const steps = trailing ? normalize(stepChain(parseGremlin(`g.V()${trailing}`), {})).steps.slice(1) : [];
  const plan = materializeRootStream(engine.lowerStepsStrict(seed, steps, 0));
  if (plan.kind !== 'read') throw new Error('expected read plan');
  return { plan, rows: store.query(plan.sql, plan.binds) as any[] };
}

describe('foreign element landing + root framing', () => {
  test('vertices land with id/label/props columns (no local join)', () => {
    const { plan, rows } = landAndRun([vrow(1, 'person', { name: 'marko', age: 29 }), vrow(2, 'software', { name: 'lop' })], 'vertex');
    expect(plan.shape.kind).toBe('vertex');
    // A vertex's landed `label` column is the PAYLOAD form — a JSON array of every label — because
    // GraphBinary's {label} field is a list. The scalar pick rides separately as `flabel`.
    expect(rows.map((r) => [r.id, r.label])).toEqual([['1', '["person"]'], ['2', '["software"]']]);
    // props is JSON text in the {key:[{t,v}]} shape rowVertex parses
    expect(JSON.parse(rows[0].props)).toEqual({ name: [{ t: 'string', v: 'marko' }], age: [{ t: 'int', v: 29 }] });
  });

  test('edges land with id/label/src/tgt/props', () => {
    const { plan, rows } = landAndRun([erow(9, 'created', 1, 2, { weight: 1 })], 'edge');
    expect(plan.shape.kind).toBe('edge');
    expect(rows.map((r) => [r.id, r.label, r.src, r.tgt])).toEqual([['9', 'created', '1', '2']]);
    expect(JSON.parse(rows[0].props)).toEqual({ weight: { t: 'int', v: 1 } });
  });

  test('empty landing yields zero rows, right shape', () => {
    const { plan, rows } = landAndRun([], 'vertex');
    expect(plan.shape.kind).toBe('vertex');
    expect(rows).toEqual([]);
  });

  test('string uid ids survive as-is', () => {
    const { rows } = landAndRun([vrow('u-42', 'person')], 'vertex');
    expect(rows[0].id).toBe('u-42');
  });
});

describe('foreign read tail (no local join)', () => {
  test('id() reads the landed fid', () => {
    const { rows } = landAndRun([vrow(1, 'person'), vrow(2, 'software')], 'vertex', '.id()');
    expect(rows.map((r) => r.v)).toEqual(['1', '2']);
  });

  test('label() reads the landed flabel', () => {
    const { rows } = landAndRun([vrow(1, 'person'), vrow(2, 'software')], 'vertex', '.label()');
    expect(rows.map((r) => r.v)).toEqual(['person', 'software']);
  });

  test('values(k) reads straight from the landed props JSON', () => {
    const { rows } = landAndRun([vrow(1, 'person', { name: 'marko', age: 29 })], 'vertex', ".values('name')");
    expect(rows.map((r) => r.v)).toEqual(['marko']);
  });

  test('values() with no key returns all property values', () => {
    const { rows } = landAndRun([vrow(1, 'person', { name: 'marko', age: 29 })], 'vertex', '.values()');
    expect(rows.map((r) => r.v).sort()).toEqual([29, 'marko']);
  });

  test('edge values(k) reads the single-node edge prop', () => {
    const { rows } = landAndRun([erow(9, 'created', 1, 2, { weight: 1 })], 'edge', ".values('weight')");
    expect(rows.map((r) => r.v)).toEqual([1]);
  });
});

describe('Executor.raw — the internal raw-row transfer (no GraphBinary)', () => {
  const seeded = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) executeQuery(seeded, g, {});
  const raw = (g: string) => exec(seeded).raw(g, {}, 0); // depth 0: a top-level raw read

  test('g.V() returns detached vertex rows with decoded props', async () => {
    const rows = await raw('g.V()');
    expect(rows.every((r) => r.kind === 'vertex')).toBe(true);
    const marko = rows.find((r) => (r.props as any).name?.[0]?.v === 'marko')!;
    expect(marko.label).toBe('person');
    expect((marko.props as any).age?.[0]?.v).toBe(29);
  });

  test('g.E() returns detached edge rows with src/tgt and props', async () => {
    const rows = await raw('g.E()');
    expect(rows.every((r) => r.kind === 'edge')).toBe(true);
    const r0 = rows[0] as Extract<ForeignRow, { kind: 'edge' }>;
    expect(r0.src).toBeDefined();
    expect(r0.tgt).toBeDefined();
  });

  test('a filtered/moved traversal still yields elements', async () => {
    const rows = await raw("g.V().has('name','marko').out('knows')");
    expect(rows.length).toBe(2); // marko knows vadas + josh
    expect(rows.every((r) => r.kind === 'vertex')).toBe(true);
  });

  test('a non-element terminal fails closed (detached ELEMENT references only)', async () => {
    await expect(raw("g.V().values('name')")).rejects.toThrow(/must yield vertices or edges/);
    await expect(raw('g.V().count()')).rejects.toThrow(/must yield vertices or edges/);
  });

  test('a write fails closed', async () => {
    await expect(raw("g.addV('x')")).rejects.toThrow(/must be a read/);
  });
});

describe('foreign element fails closed on local movement', () => {
  const attempt = (trailing: string) => () => landAndRun([vrow(1, 'person')], 'vertex', trailing);
  test('out() over a detached reference throws a clear deferral', () => {
    expect(attempt(".out('knows')")).toThrow(/detached federated element/);
  });
  test('both() over a detached reference throws', () => {
    expect(attempt('.both()')).toThrow(/detached federated element/);
  });
  test('has() over a detached reference throws (no local filter)', () => {
    expect(attempt(".has('name','marko')")).toThrow(/detached federated element/);
  });
});
