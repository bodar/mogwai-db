// `asString()` is universal in TinkerPop (`AsStringGlobalStep` = `String.valueOf`): over a SCALAR it is
// the value's string (handled by `VALUE_TX`, `transform.ts`); over a non-scalar traverser it is that
// object's rendering. Each element shape has its own faithful SQL rendering in `terminal()`
// (`lower.ts`) — a vertex `v[<id>]`, and (as they land) an edge, a property. The renderings match
// TinkerPop's `StringFactory` where it is exact; JS/Java divergences (number formatting) are an allowed
// semantic-equivalence deviation, not a defect. See the value-carriage worklist (RelIR §10, §6·7).
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';
import { executeFramed } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const values = (rows: any[]) => rows.map((r) => r.v);
/** A collection `asString()` lowers to a value-transform BARRIER (a segment), which the SQL-only `run`
 *  helper cannot execute — so these go through the full `executeFramed` path and decode the wire. */
const framed = (q: string) => decodeAll(executeFramed(seededStore(), q).map((f) => f.buf));

describe('asString() over each traverser shape', () => {
  test('over a VERTEX renders v[<id>] (StringFactory.vertexString)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().asString()');
    // The modern graph's six vertices, each rendered by its outward id.
    expect(values(r).sort()).toEqual(['v[1]', 'v[2]', 'v[3]', 'v[4]', 'v[5]', 'v[6]']);
  });

  test('over an EDGE renders e[<id>][<src>-<label>-><tgt>] (StringFactory.edgeString)', () => {
    const store = seededStore();
    const r = run(store, 'g.E().asString()');
    expect(values(r).sort()).toEqual([
      'e[10][4-created->5]', 'e[11][4-created->3]', 'e[12][6-created->3]',
      'e[7][1-knows->2]', 'e[8][1-knows->4]', 'e[9][1-created->3]',
    ]);
  });

  test('over a VERTEX PROPERTY renders vp[<key>-><value>] (StringFactory.vertexPropertyString)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().properties().asString()');
    expect(values(r).sort()).toEqual([
      'vp[age->27]', 'vp[age->29]', 'vp[age->32]', 'vp[age->35]',
      'vp[lang->java]', 'vp[lang->java]',
      'vp[name->josh]', 'vp[name->lop]', 'vp[name->marko]', 'vp[name->peter]',
      'vp[name->ripple]', 'vp[name->vadas]',
    ]);
  });

  test('over a SCALAR value stays the value string (unchanged by the element arms)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().hasLabel("person").values("age").asString()');
    expect(values(r).sort()).toEqual(['27', '29', '32', '35']);
  });

  // The collection forms escape to a JS value-transform barrier (`gremlinString` / `asstring-barrier.ts`).
  test('global over a MAP renders {k=[v]} (AbstractMap.toString)', async () => {
    const r = await framed('g.V().valueMap("name").asString()');
    expect(r.sort()).toEqual([
      '{name=[josh]}', '{name=[lop]}', '{name=[marko]}', '{name=[peter]}', '{name=[ripple]}', '{name=[vadas]}',
    ]);
  });

  test('local over a folded ELEMENT list stringifies each member, keeping the list', async () => {
    const r = await framed('g.V().fold().asString(Scope.local)');
    expect(r.length).toBe(1);
    expect([...r[0]].sort()).toEqual(['v[1]', 'v[2]', 'v[3]', 'v[4]', 'v[5]', 'v[6]']);
  });

  test('a following order(local) sorts the barrier-produced string list', async () => {
    const r = await framed('g.V().fold().asString(Scope.local).order(local)');
    expect(r.length).toBe(1);
    expect([...r[0]]).toEqual(['v[1]', 'v[2]', 'v[3]', 'v[4]', 'v[5]', 'v[6]']);
  });
});
