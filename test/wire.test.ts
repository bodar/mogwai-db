import { test, expect } from 'bun:test';
import { parseRequest } from '../src/wire.ts';
import { ioc } from '../src/io.ts';

// Hand-build a GraphBinary request whose bindings carry a MAP param with a UUID-typed
// value — the shape a TYPED client (Java/Python/…) sends but a JS client can't produce
// (JS can't distinguish a uuid from a string). Proves decodeTyped recurses into a
// map-valued binding and captures the inner value's wire DataType ("all the way down").
const MAP = 0x0a;
const fqStr = (s: string) => ioc.stringSerializer.serialize(s, true);
const bareInt = (n: number) => ioc.intSerializer.serialize(n, false);
const fqUuid = (s: string) => ioc.uuidSerializer.serialize(s, true);
const fqMap = (entries: [Buffer, Buffer][]) =>
  Buffer.concat([Buffer.from([MAP, 0x00]), bareInt(entries.length), ...entries.flatMap(([k, v]) => [k, v])]);

test('parseRequest captures nested bound-map value types deeply (typed client)', () => {
  const uuid = '0263f28b-eff9-4c17-8e33-0b41c74b6d4c';
  const inner = fqMap([[fqStr('gid'), fqUuid(uuid)]]);        // {gid: UUID(…)}
  const bindings = fqMap([[fqStr('xx1'), inner]]);            // {xx1: {gid: UUID(…)}}
  const fields = Buffer.concat([bareInt(1), fqStr('bindings'), bindings]); // bare fields map
  const gremlin = ioc.stringSerializer.serialize('g.mergeV(xx1)', false);
  const req = Buffer.concat([Buffer.from([0x84]), fields, gremlin]);

  const parsed = parseRequest(req);
  expect(parsed.gremlin).toBe('g.mergeV(xx1)');
  expect(parsed.params.xx1 instanceof Map).toBe(true);
  expect((parsed.params.xx1 as Map<any, any>).get('gid')).toBe(uuid);
  // the wire type survives one level deep into the map-valued binding
  expect(parsed.paramTypes.xx1).toEqual({ t: 'map', entries: { gid: 'uuid' } });
});
