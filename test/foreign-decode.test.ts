import { test, expect, describe, beforeAll } from 'bun:test';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { streamBuffers } from '../src/http.ts';
import { decodeForeignResult } from '../src/foreign-decode.ts';
import type { Executor } from '../src/api.ts';

// The typed GraphBinary RESPONSE decoder, validated against our OWN server's real framing — the
// realistic mogwai peer. We frame a traversal exactly as the client wire path does (`framed` →
// `streamBuffers`, HEADER | value* | trailer), then decode the bytes back to a ForeignResult and
// assert it carries the SAME typed {t,v} nodes the in-process runForeign produces, so a federated hop
// over HTTP is indistinguishable from one over DO RPC (docs/2026-09-02-…-plan.md §8).

const mgr = new BunGraphManager(undefined, extendedRegistry);
const ex = () => mgr.executor('g') as Executor;

/** Frame a traversal as the client wire path does and hand back the raw response bytes a peer sends. */
async function peerBytes(gremlin: string): Promise<Buffer> {
  const framed = ex().framed(gremlin, {});
  const resp = streamBuffers(framed, 64, false); // flat frame, as decodeForeignResult expects
  return Buffer.from(await resp.arrayBuffer());
}

beforeAll(async () => {
  await ex().framedAsync(
    'g.addV("person").property("name","marko").property("age",29).as("a")'
    + '.addV("person").property("name","josh").as("b")'
    + '.addE("knows").from("a").to("b").property("weight",0.5)',
    {},
  );
});

describe('decodeForeignResult — typed peer response decode', () => {
  test('vertices decode WITH typed props (the Phase 0 gate)', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().hasLabel("person")'));
    expect(r.kind).toBe('elements');
    if (r.kind !== 'elements') throw new Error('unreachable');
    const byName = new Map(r.rows.map((row) => [(row as any).props.name[0].v, row]));
    expect([...byName.keys()].sort()).toEqual(['josh', 'marko']);
    const marko = byName.get('marko') as any;
    expect(marko.kind).toBe('vertex');
    expect(marko.label).toBe('person');
    expect(marko.labels).toEqual(['person']);
    expect(marko.props.name[0]).toMatchObject({ t: 'string', v: 'marko' });
    expect(marko.props.age[0]).toMatchObject({ t: 'int', v: 29 }); // Long-vs-Int preserved, not collapsed
    expect(typeof marko.id === 'number' || typeof marko.id === 'string').toBe(true);
  });

  test('an edge decodes with src/tgt and a typed prop', async () => {
    const r = await decodeForeignResult(await peerBytes('g.E()'));
    expect(r.kind).toBe('elements');
    if (r.kind !== 'elements') throw new Error('unreachable');
    const e = r.rows[0] as any;
    expect(e.kind).toBe('edge');
    expect(e.label).toBe('knows');
    expect(e.src).not.toBe(undefined);
    expect(e.tgt).not.toBe(undefined);
    expect(e.props.weight).toMatchObject({ t: 'double', v: 0.5 });
  });

  test('a pushed reducer (count) decodes to a typed scalar under the reduce hint', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().count()'), 'reduce');
    expect(r).toEqual({ kind: 'scalar', value: { t: 'long', v: 2 } });
  });

  test('a values(k) stream decodes to typed value nodes', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().hasLabel("person").values("name")'));
    expect(r.kind).toBe('values');
    if (r.kind !== 'values') throw new Error('unreachable');
    expect(r.values.map((n: any) => n.v).sort()).toEqual(['josh', 'marko']);
    expect(r.values.every((n: any) => n.t === 'string')).toBe(true);
  });

  test('a map terminal decodes to the map arm', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().group().by(T.label).by(__.count())'));
    expect(r.kind).toBe('map');
    if (r.kind !== 'map') throw new Error('unreachable');
    expect(r.value.t).toBe('map');
    const entries = Object.fromEntries((r.value.v as any[]).map(([k, v]) => [k.v, v.v]));
    expect(entries).toEqual({ person: 2 });
  });

  test('nested elements: fold() of vertices keeps typed props at depth', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().hasLabel("person").fold()'));
    expect(r.kind).toBe('values');
    if (r.kind !== 'values') throw new Error('unreachable');
    const list = r.values[0] as any;
    expect(list.t).toBe('list');
    expect(list.v).toHaveLength(2);
    for (const member of list.v) {
      expect(member.t).toBe('vertex');
      expect(member.v.props.name[0].t).toBe('string'); // props survive nesting
    }
  });

  test('an empty result over a reducer yields a null scalar (matches sum-over-empty)', async () => {
    const r = await decodeForeignResult(await peerBytes('g.V().hasLabel("nonesuch").values("age").sum()'), 'reduce');
    expect(r).toEqual({ kind: 'scalar', value: { t: null, v: null } });
  });
});
