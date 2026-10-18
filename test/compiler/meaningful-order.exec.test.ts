// THE ORDER A QUERY IMPOSES SURVIVES — the keep-list for dropping the UNNEEDED emission order.
//
// An unordered stream reaching the wire, and an unordered limit/range/skip, come back in SQLite's planner
// order (`computeDemandsEncounter`'s `wireTerminal`, docs/feature-support-matrix.md §17). Everything
// below is order the QUERY asks for, so each answer is pinned exactly — and `mise run test:perturbed`
// (SQLite's `reverse_unordered_selects`) is what proves the SQL, not a lucky scan, holds it.
import { describe, expect, test } from 'bun:test';
import { decodeAll } from '../support/decode.ts';
import { executeQuery } from '../support/executor.ts';
import { seededStore } from '../support/harness.ts';

const store = seededStore();
const answer = async (q: string) => decodeAll(executeQuery(store, q, {}));

describe('an explicit order() and the slices after it', () => {
  test.each([
    ['g.V().order().by("name").values("name")', ['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']],
    ['g.V().order().by("age").limit(2).values("name")', ['vadas', 'marko']],
    ['g.V().order().by("name").range(1,3).values("name")', ['lop', 'marko']],
    ['g.V().order().by("name").skip(4).values("name")', ['ripple', 'vadas']],
    ['g.V().values("name").order().tail(2)', ['ripple', 'vadas']],
    ['g.V().has("name","marko").outE().order().by("weight").inV().values("name")', ['lop', 'vadas', 'josh']],
    ['g.V().hasLabel("person").order().by("age",desc).values("name").fold()', [['peter', 'josh', 'marko', 'vadas']]],
  ] as const)('%s', async (q, want) => expect(await answer(q)).toEqual([...want]));
});

describe('a tail reads the far end of the stream it is given', () => {
  test('g.V().values("name").tail(2)', async () => expect(await answer('g.V().values("name").tail(2)')).toEqual(['ripple', 'peter']));
});

describe('member order inside a collection', () => {
  test.each([
    ['g.V().out().values("name").fold()', [['vadas', 'lop', 'josh', 'lop', 'ripple', 'lop']]],
    ['g.V().hasLabel("person").values("name").fold()', [['marko', 'vadas', 'josh', 'peter']]],
    ['g.V().hasLabel("person").aggregate("x").cap("x").unfold().values("name").fold()', [['marko', 'vadas', 'josh', 'peter']]],
    ['g.V().hasLabel("person").union(__.values("name"), __.values("age")).fold()', [['marko', 29, 'vadas', 27, 'josh', 32, 'peter', 35]]],
    ['g.V().hasLabel("person").coalesce(__.out("created").values("name"), __.constant("none")).fold()', [['lop', 'none', 'lop', 'ripple', 'lop']]],
    ['g.withSack(1).V().hasLabel("person").sack(sum).by("age").sack().fold()', [[30, 28, 33, 36]]],
    ['g.V().as("a").both().as("b").dedup("a").select("b").values("name").fold()', [['vadas', 'marko', 'marko', 'marko', 'josh', 'lop']]],
  ] as const)('%s', async (q, want) => expect(await answer(q)).toEqual([...want]));

  test('a group value list keeps arrival order', async () => {
    const [m] = await answer('g.V().group().by(label).by(__.values("name").fold())') as Map<string, string[]>[];
    expect(m!.get('person')).toEqual(['marko', 'vadas', 'josh', 'peter']);
    expect(m!.get('software')).toEqual(['lop', 'ripple']);
  });

  test('a path keeps its positions in order', async () => {
    const paths = (await answer('g.V(1).out().out().path().by("name")')) as { objects: unknown[] }[];
    expect(paths.map((p) => p.objects).sort()).toEqual([['marko', 'josh', 'lop'], ['marko', 'josh', 'ripple']]);
  });
});

describe('a write assigns ids in the order it consumes its driver rows', () => {
  test('addE from a fan-out', async () => {
    const s = seededStore();
    executeQuery(s, 'g.V().as("a").out("knows").addE("k2").from("a")', {});
    expect(await decodeAll(executeQuery(s, 'g.E().hasLabel("k2").order().by(T.id).inV().values("name").fold()', {})))
      .toEqual([['vadas', 'josh']]);
  });
});
