// `asString()` is universal in TinkerPop (`AsStringGlobalStep` = `String.valueOf`): over a SCALAR it is
// the value's string (handled by `VALUE_TX`, `transform.ts`); over a non-scalar traverser it is that
// object's rendering. Each element shape has its own faithful SQL rendering in `terminal()`
// (`lower.ts`) — a vertex `v[<id>]`, and (as they land) an edge, a property. The renderings match
// TinkerPop's `StringFactory` where it is exact; JS/Java divergences (number formatting) are an allowed
// semantic-equivalence deviation, not a defect. See the value-carriage worklist (RelIR §10, §6·7).
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

const values = (rows: any[]) => rows.map((r) => r.v);

describe('asString() over each traverser shape', () => {
  test('over a VERTEX renders v[<id>] (StringFactory.vertexString)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().asString()');
    // The modern graph's six vertices, each rendered by its outward id.
    expect(values(r).sort()).toEqual(['v[1]', 'v[2]', 'v[3]', 'v[4]', 'v[5]', 'v[6]']);
  });

  test('over a SCALAR value stays the value string (unchanged by the element arms)', () => {
    const store = seededStore();
    const r = run(store, 'g.V().hasLabel("person").values("age").asString()');
    expect(values(r).sort()).toEqual(['27', '29', '32', '35']);
  });
});
