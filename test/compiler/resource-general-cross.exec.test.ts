// GRAPHSTEP'S CROSS — a mid-traversal `V()`/`E()`. `head.split(element, this)` keeps the traverser's labels and
// sack and extends its path:
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:193-221.
//
// In a child body (`lower/scoped.ts` `reSourcedBody`) the read after the re-source stays ONE shared read, by the
// host's REJOIN CONTRACT: under `first` (`map`/`by()`/a filter) and `split` (`flatMap`/`coalesce`) the emitted
// traverser is split from the HOST, so a tracked host path crosses unchanged (the child's positions never leave
// it); under `split` and `forward` (`local`) the rest splits only where it first reads the host, and the fold
// continues over the cross from there — under `forward` a label the read binds rides out of the shared read as an
// alias channel. At the ROOT the fold's cross (`lower/movement.ts` `reSource`) extends a carried path and keeps a sack.
//
// A FIRST-row host whose rest reads the host traverser is the fold's cross, which the host's correlated-first
// policy reads per host row and stops at its first row (a `by()` value too: `landValues`' `correlatedValue`).
// A `forward` host on a traverser whose path is tracked, and a body reading a tracked path itself, decline from
// the query text, naming the shape.
import { test, expect, describe } from 'bun:test';
import { seededStore, run, bare, bagOf } from '../support/harness.ts';

const s = seededStore();
const rows = (g: string): any[] => bare(run(s, g));
const scalars = (g: string): unknown[] => rows(g).map((r) => r.v);
const count = (g: string): number => Number(scalars(g)[0]);
/** A path row as its members: a vertex by id, anything else by value. */
const members = (row: any): unknown[] => JSON.parse(row.list).map((m: any) => (m.t === 'vertex' ? `v${m.v.id}` : m.v));

describe('a path crosses a re-source: the split extends it', () => {
  test('map(V().count()).path() is [v, 6] per vertex', () => {
    expect(bagOf(rows('g.V().map(V().count()).path()').map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([1, 2, 3, 4, 5, 6].map((id) => JSON.stringify([`v${id}`, 6]))));
  });
  test('out().map(V().count()).path() is [v, w, 6] per edge', () => {
    const got = rows('g.V().out().map(V().count()).path()').map(members);
    expect(got).toHaveLength(6);
    expect(got.every((p) => p.length === 3 && p[2] === 6)).toBe(true);
  });
  test('under repeat().times(1)', () => expect(count('g.V().repeat(out()).times(1).map(V().count()).path().count()')).toBe(6));
  test('after simplePath()', () => expect(count('g.V().both().simplePath().map(V().count()).count()')).toBe(12));
  test('a root mid-traversal V() appends its element', () => {
    expect(bagOf(rows("g.V(1).out('knows').V().has('name','lop').path().by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([JSON.stringify(['marko', 'vadas', 'lop']), JSON.stringify(['marko', 'josh', 'lop'])]));
  });
  test('a split element is a path position simplePath() sees', () => {
    // [1, x, v] is simple where v is neither 1 nor x: 3 × 4.
    expect(count('g.V(1).out().simplePath().V().simplePath().count()')).toBe(12);
  });
  test('path labels gated on by from()', () => {
    expect(bagOf(rows("g.V(1).as('a').out().as('b').V(3).as('c').path().from('b').by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf([['vadas', 'lop'], ['josh', 'lop'], ['lop', 'lop']].map((p) => JSON.stringify(p))));
  });
  test('inside a filter', () => {
    expect(count("g.V().where(map(V().count()).path().count(local).is(2)).count()")).toBe(6);
  });
});

describe('a re-sourced read that binds its own label', () => {
  test('local(V().as(x).out().select(x))', () => expect(count("g.V().local(V().as('x').out().select('x')).count()")).toBe(36));
  test('local(V().as(x).out().where(neq(x)))', () => expect(count("g.V().local(V().as('x').out().where(neq('x'))).count()")).toBe(36));
  test('local(V().values(name).as(n).select(n))', () => expect(count("g.V().local(V().values('name').as('n').select('n')).count()")).toBe(36));
  test('the label rides out of local()', () => expect(count("g.V().local(V().has('name','lop').as('x')).select('x').count()")).toBe(6));
  test('under map() the read is shared and its label shed', () => {
    expect(scalars("g.V().map(V().has('name','marko').as('m').out().select('m').values('name'))")).toEqual(Array(6).fill('marko'));
  });
  test('inside a repeat body', () => expect(count("g.V().repeat(local(V().has('name','lop').as('x').select('x'))).times(1).count()")).toBe(6));
});

describe('an all-rows host whose rest reads the host traverser', () => {
  test('as(a).local(V().as(b).select(a,b)) is N × G', () => expect(count("g.V().as('a').local(V().as('b').select('a','b')).count()")).toBe(36));
  test('each pair keeps its own host', () => {
    expect(count("g.V().as('a').local(V().as('b').select('a','b')).select('a').dedup().count()")).toBe(6);
  });
});

describe('a sack crosses a root re-source', () => {
  test('sack(assign).V().sack()', () => expect(count('g.V().sack(assign).by(constant(1)).V().sack().count()')).toBe(36));
  test('the split keeps each traverser\'s own sack', () => {
    expect(count('g.withSack(1).V().sack(sum).by(constant(2)).V().sack().sum()')).toBe(108);
  });
});

describe('a first-row host whose rest reads the host traverser answers through the cross, kept correlated', () => {
  // GraphStep's cross in the fold (`movement.ts` `reSource`); the host's correlated-first policy reads it per
  // host row and stops at the first row (`TraversalMapStep` one `next()`, `TraversalFilterStep` one `hasNext()`).
  const names = ['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas'];
  test('map(V().where(neq(a)).values(name)): the first OTHER vertex', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).values('name'))"))).toEqual(bagOf(['vadas', ...Array(5).fill('marko')]));
  });
  test('map(V().as(x).out().where(neq(a)).count()) is a barrier over the whole cross', () => {
    // Per host: the out-edges of every vertex whose target is not the host (6 edges, minus the host's in-degree).
    expect(bagOf(scalars("g.V().as('a').map(V().as('x').out().where(neq('a')).count())").map(Number))).toEqual(bagOf([6, 5, 3, 5, 5, 6]));
  });
  test('where(V().has(age,gt(30)).where(neq(a))): another such vertex exists for every host', () => {
    expect(count("g.V().as('a').where(V().has('age',gt(30)).where(neq('a'))).count()")).toBe(6);
  });
  test('where(V().has(age,gt(32)).where(neq(a))): peter alone matches, so only peter fails', () => {
    expect(count("g.V().as('a').where(V().has('age',gt(32)).where(neq('a'))).count()")).toBe(5);
  });
  test('not(V().has(age,gt(32)).where(neq(a))) keeps only peter', () => {
    expect(scalars("g.V().as('a').not(V().has('age',gt(32)).where(neq('a'))).values('name')")).toEqual(['peter']);
  });
  test('project(n).by(V().where(neq(a)).count())', () => {
    expect(rows("g.V().as('a').project('n').by(V().where(neq('a')).count())").map((r) => JSON.parse(r.map)[0][1].v)).toEqual(Array(6).fill(5));
  });
  test('map(V().where(neq(a)).values(name).fold()) is every other name', () => {
    expect(bagOf(rows("g.V().as('a').map(V().where(neq('a')).values('name').fold())").map((r) => JSON.parse(r.list).length))).toEqual(Array(6).fill(5));
  });
  test('a self-join idiom: the first vertex sharing the host name is itself', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().as('b').where(eq('a')).by('name')).values('name')"))).toEqual(names);
  });
  test('a sack the rest reads is the host\'s', () => expect(scalars("g.withSack(1).V().map(V().sack())")).toEqual(Array(6).fill(1)));
  test('order().by(V().where(neq(a)).values(name)): marko sorts last', () => {
    expect(scalars("g.V().as('a').order().by(V().where(neq('a')).values('name')).values('name')").at(-1)).toBe('marko');
  });
  test('dedup().by(...) keys on the first other name', () => {
    expect(count("g.V().as('a').dedup().by(V().where(neq('a')).values('name')).count()")).toBe(2);
  });
  test('groupCount().by(...)', () => {
    expect(rows("g.V().as('a').groupCount().by(V().where(neq('a')).values('name'))").map((r) => JSON.parse(r.map).map(([k, v]: any) => [k.v, v.v]).sort())[0])
      .toEqual([['marko', 5], ['vadas', 1]]);
  });
  test('two host labels', () => {
    expect(count("g.V().as('a').out().as('b').map(V().where(neq('a')).where(neq('b')).count()).dedup().count()")).toBe(1);
  });
  test('inside local(), a filter and a repeat body', () => {
    expect(bagOf(scalars("g.V().as('a').local(map(V().where(neq('a')).values('name')))"))).toEqual(bagOf(['vadas', ...Array(5).fill('marko')]));
    expect(count("g.V().as('a').where(map(V().where(neq('a')).count()).is(5)).count()")).toBe(6);
    // An unordered limit(1) is the planner's pick (§17); every pick is another vertex than the host's label.
    expect(count("g.V().as('a').repeat(map(V().where(neq('a')).limit(1))).times(2).where(neq('a')).count()")).toBe(6);
  });
  test('a discarded re-source under select(a) is the host itself', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().select('a')).values('name')"))).toEqual(names);
  });
});

describe('a first-row read over the cross stops at the leading element the body keeps', () => {
  // `src/rel/passes/leading.ts`: the first scanned element whose body has a row is found first (one rowid-ordered
  // read with an EXISTS per element), then the body is read at that element alone. These pin the ANSWERS of the
  // shapes it rewrites — a hop, a property row, a lookup keyed on a host value, a has() the seek drives.
  test('map(V().where(neq(a)).out().values(name)): the first other vertex WITH an out-edge', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).out().values('name'))"))).toEqual(bagOf(['lop', ...Array(5).fill('vadas')]));
  });
  test('two hops', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).out().out().values('name'))"))).toEqual(Array(5).fill('lop'));
  });
  test('a lookup keyed on a host value: the first vertex of the same age', () => {
    // Ages are distinct, so each person finds itself; a software vertex has no age, so by('age') is unproductive.
    expect(bagOf(scalars("g.V().as('a').map(V().where(eq('a')).by('age').values('name'))"))).toEqual(bagOf(['josh', 'marko', 'peter', 'vadas']));
    expect(bagOf(rows("g.V().as('a').project('m').by(V().where(eq('a')).by('age').values('name'))").map((r) => JSON.parse(r.map).length)))
      .toEqual(bagOf([1, 1, 1, 1, 0, 0]));
  });
  test('a has() after the re-source: a match, and none', () => {
    expect(scalars("g.V().as('a').map(V().has('name','josh').where(neq('a')).values('name'))")).toEqual(Array(5).fill('josh'));
    expect(count("g.V().as('a').map(V().has('name','zzz').where(neq('a')).values('name')).count()")).toBe(0);
    expect(count("g.V().as('a').order().by(V().has('name','zzz').where(neq('a')).values('name')).count()")).toBe(0);
    expect(bagOf(scalars("g.V().as('a').map(V().has('age',gt(30)).where(neq('a')).out().values('name'))"))).toEqual(Array(6).fill('lop'));
  });
  test('project().by() of a non-barrier body', () => {
    expect(bagOf(rows("g.V().as('a').project('n').by(V().where(neq('a')).values('name'))").map((r) => JSON.parse(r.map)[0][1].v)))
      .toEqual(bagOf(['vadas', ...Array(5).fill('marko')]));
  });
  test('an existence test over a hop', () => {
    expect(bagOf(scalars("g.V().as('a').where(V().where(neq('a')).out().has('name','josh')).values('name')")))
      .toEqual(bagOf(['josh', 'lop', 'peter', 'ripple', 'vadas']));
  });
  // The rewrite is a pass over the finished algebra, so it reaches every host that reads a correlated re-source's
  // first row or existence, at any depth.
  test('an existence test whose has() the seek drives, and its negation', () => {
    expect(count("g.V().as('a').where(V().where(neq('a')).has('name','peter')).count()")).toBe(5);
    expect(scalars("g.V().as('a').not(V().where(neq('a')).has('name','peter')).values('name')")).toEqual(['peter']);
  });
  test('a pick nested in a pick', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).map(V().where(neq('a')).values('name')))")))
      .toEqual(bagOf(['vadas', ...Array(5).fill('marko')]));
  });
  test('under flatMap, a where(map(...)) and two project().by() picks', () => {
    // An unordered limit(1) keeps one member, whichever SQLite reads first (§17): one per host.
    expect(count("g.V().as('a').flatMap(V().where(neq('a')).out().values('name').limit(1)).count()")).toBe(6);
    expect(count("g.V().as('a').where(map(V().where(neq('a')).out().values('name')).is('lop')).count()")).toBe(1);
    expect(bagOf(rows("g.V().as('a').project('x','y').by(V().where(neq('a')).out().values('name')).by(V().where(neq('a')).values('age'))")
      .map((r) => JSON.parse(r.map).map(([, v]: any) => v.v).join('/')))).toEqual(bagOf(['lop/27', ...Array(5).fill('vadas/29')]));
  });
});

describe('a slice inside a correlated body reads its position\'s keys (`scoped.ts` `slicesByKeys`)', () => {
  test('limit(1)', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).limit(1).values('name'))"))).toEqual(bagOf(['vadas', ...Array(5).fill('marko')]));
  });
  test('range(2,4): the third other vertex', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).range(2,4).values('name'))"))).toEqual(bagOf([...Array(3).fill('josh'), ...Array(3).fill('lop')]));
  });
  test('tail(1) and tail(2): the last others', () => {
    expect(bagOf(scalars("g.V().as('a').map(V().where(neq('a')).tail(1).values('name'))"))).toEqual(bagOf(['ripple', ...Array(5).fill('peter')]));
    expect(bagOf(rows("g.V().as('a').map(V().where(neq('a')).tail(2).values('name').fold())").map((r) => r.list)))
      .toEqual(bagOf(['["josh","peter"]', '["josh","ripple"]', ...Array(4).fill('["ripple","peter"]')]));
  });
});

describe('a first-row host keeps ONE shared read under a tracked path: the host path crosses unchanged', () => {
  // `map`/`where` emit a traverser split from the HOST, so the child's GraphStep positions never leave it
  // (`TraversalMapStep`): the path is the host's plus map's own result — never a graph cross per host.
  test('out().map(V().values(age).max()).path() is [v, w, 35]', () => {
    const got = rows("g.V().out().map(V().values('age').max()).path().by('name').by('name').by()").map(members);
    expect(got).toHaveLength(6);
    expect(got.every((p) => p.length === 3 && p[2] === 35)).toBe(true);
  });
  test('out().where(V().has(lop)).path() keeps the host path', () => {
    expect(bagOf(rows("g.V().out().where(V().has('name','lop')).path().by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf(rows("g.V().out().path().by('name')").map((r) => JSON.stringify(members(r)))));
  });
  test('an empty where() read filters every host', () => expect(count("g.V().out().where(V().out().has('name','zzz')).path().count()")).toBe(0));
  test('after simplePath()', () => expect(count("g.V().both().simplePath().map(V().values('age').max()).count()")).toBe(12));
  test('a first-row pick of a multi-row read', () => expect(count("g.V().out().map(V().limit(1).values('name')).path().count()")).toBe(6));
});

describe("a first-row pick is a member of its host's own body", () => {
  // The pick must lie in the multiset the same body folds for that host: which member is first follows the
  // body's emission order, but a value outside the body is a wrong answer. `project('n','x').by('name')` keys
  // each host's pick by its name, against `by(<body>.fold())` over the same hosts.
  const picked = (host: string, body: string): [string, unknown][] =>
    rows(`${host}.project('n','x').by('name').by(${body})`).map((r) => {
      const entries = JSON.parse(r.map) as [{ v: string }, { v: unknown }][];
      return [entries[0]![1].v as string, entries[1]?.[1].v];
    });
  const folded = (host: string, body: string): Map<string, unknown[]> =>
    new Map(rows(`${host}.project('n','x').by('name').by(${body}.fold())`).map((r): [string, unknown[]] => {
      const entries = JSON.parse(r.map) as [{ v: string }, { v: any }][];
      return [entries[0]![1].v as string, (entries[1]![1].v as unknown[]).map((m: any) => (m !== null && typeof m === 'object' && 'v' in m ? m.v : m))];
    }));
  test.each([
    // A second both() read its direction off the first one's position column (a join side's key columns were
    // declared at the end, not where the side put them): a vertex outside the friend-of-friend set.
    ['g.V()', 'both().both().values(\'name\')'],
    ["g.V().as('a')", "both().both().where(neq('a')).values('name')"],
    ["g.V().as('a')", "both().both().simplePath().values('name')"],
    ["g.V().hasLabel('person').as('a')", "both('knows').both('knows').where(neq('a')).values('name')"],
    ["g.V().as('a')", "V().has('name','lop').where(neq('a')).both().values('name')"],
    ["g.V().as('a')", "V().where(neq('a')).both().values('name')"],
    ["g.V().as('a')", "V().where(neq('a')).id()"],
    ["g.V().as('a')", "V().hasLabel('software').where(neq('a')).values('name')"],
    ["g.V().hasLabel('person').as('p')", "V().hasLabel('person').where(gt('p')).by('age').values('name')"],
    ["g.V().as('a')", "V().not(where(eq('a'))).values('name')"],
    ["g.V().as('a')", "E().where(outV().where(neq('a'))).values('weight')"],
  ])('%s.by(%s)', (host, body) => {
    const all = folded(host, body);
    const got = picked(host, body);
    expect(got.map(([n]) => n).sort()).toEqual([...all.keys()].sort());
    for (const [n, x] of got) {
      const members = all.get(n)!;
      if (members.length) expect(members).toContain(x);
      else expect(x).toBeUndefined();
    }
  });
  test('the friend-of-friend picks', () => {
    // marko knows vadas and josh, who know only marko: no friend-of-friend but marko himself, so no key.
    expect(new Map(picked("g.V().hasLabel('person').as('a')", "both('knows').both('knows').where(neq('a')).values('name')")))
      .toEqual(new Map([['marko', undefined], ['vadas', 'josh'], ['josh', 'vadas'], ['peter', undefined]]));
  });
});

describe('a first-row host the correlated read cannot hold declines, naming the shape', () => {
  // Its decorrelated fallback would cross every host with the graph ahead of the pick (N × G for one row per
  // host), so a re-source whose rest reads the host declines there rather than answer quadratically.
  test("choose(V().has(lop).where(neq('a')), …)", () => {
    expect(() => run(s, "g.V().as('a').choose(V().has('name','lop').where(neq('a')), constant('y'), constant('n'))"))
      .toThrow('this V()/E() inside map(), by() or a filter, whose later steps read the incoming traverser');
  });
});

describe('a label the shared read binds rides out of an all-rows host, never a cut', () => {
  // The read's own label reads nothing of the host, so it stays inside the ONE shared read and rides out of
  // the cross as an alias channel: the reducer, slice or filter after it is computed once, not per host.
  test('local(V().as(x).values(age).max())', () => expect(scalars("g.V().local(V().as('x').values('age').max())")).toEqual(Array(6).fill(35)));
  test('local(V().as(x).limit(1)).select(x)', () => {
    // An unordered limit: one shared pick, so every host selects the same vertex (which one is the planner's).
    const names = scalars("g.V().local(V().as('x').limit(1)).select('x').values('name')");
    expect(names).toHaveLength(6);
    expect(new Set(names).size).toBe(1);
  });
  test('local(V().as(x).has(lop)).select(x)', () => {
    expect(scalars("g.V().local(V().as('x').has('name','lop')).select('x').values('name')")).toEqual(Array(6).fill('lop'));
  });
  test('two read labels beside a host label', () => {
    expect(count("g.V().as('h').local(V().has('age').as('x').values('age').as('y').limit(1)).select('h','x','y').count()")).toBe(6);
  });
  test('a read label beside a host label of another name keeps both', () => {
    expect(bagOf(rows("g.V().as('a').local(V().has('name','lop').as('b').limit(1)).select('a','b').by('name')").map((r) => r.map)))
      .toHaveLength(6);
  });
  test('the read label does not leave flatMap() (head.split)', () => {
    expect(count("g.V().flatMap(V().as('x').has('name','lop')).select('x').count()")).toBe(0);
  });
  test('nested: local(local(V().as(x).limit(2)).select(x))', () => {
    expect(count("g.V().local(local(V().as('x').limit(2)).select('x')).count()")).toBe(12);
  });
  test('under where()', () => {
    expect(count("g.V().where(local(V().as('x').has('name','lop')).select('x').values('name').is('lop')).count()")).toBe(6);
  });
  test('a read label of a host label\'s name extends the host\'s history', () => {
    expect(scalars("g.V().as('x').local(V().has('name','lop').as('x')).select(first,'x').values('name').dedup().count()")).toEqual([6]);
    expect(scalars("g.V().as('x').local(V().has('name','lop').as('x')).select(last,'x').values('name').dedup()")).toEqual(['lop']);
  });
});

describe('an all-rows host splits its rest where it first reads the host', () => {
  test('a slice before the bind is shared: local(V().order().limit(1).as(x))', () => {
    expect(scalars("g.V().local(V().order().by('name').limit(1).as('x')).select('x').values('name')")).toEqual(Array(6).fill('josh'));
  });
  test('a slice before the host read is shared: as(a).local(V().order().limit(1).select(a))', () => {
    expect(bagOf(scalars("g.V().as('a').local(V().order().by('name').limit(1).select('a')).values('name')")))
      .toEqual(bagOf(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']));
  });
  test('a host compare after the split', () => expect(count("g.V().as('a').local(V().as('b').where('a',neq('b'))).count()")).toBe(30));
  test('flatMap(V().has().select(a)) answers each host', () => {
    expect(bagOf(scalars("g.V().as('a').flatMap(V().has('name','lop').select('a')).values('name')")))
      .toEqual(bagOf(['marko', 'vadas', 'lop', 'josh', 'ripple', 'peter']));
  });
  test('a rebind of a host label inside local()', () => {
    expect(scalars("g.V().as('a').local(V().as('a')).select(all,'a').count(local).dedup()")).toEqual([2]);
  });
});

describe('flatMap() splits the HOST: a tracked path crosses the shared read and gains the result alone', () => {
  // `FlatMapStep` emits `head.split(r)` per result
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52),
  // so the path is the host's plus r — the child's GraphStep positions never leave it.
  const paths = (g: string): string[] => bagOf(rows(g).map((r) => JSON.stringify(members(r))));
  const hostPaths = paths('g.V().out().path()');
  test('out().flatMap(V().has(marko)).path() is [v, w, marko] per edge', () => {
    expect(paths("g.V().out().flatMap(V().has('name','marko')).path()"))
      .toEqual(bagOf(hostPaths.map((p) => JSON.stringify([...JSON.parse(p), 'v1']))));
  });
  test('out().flatMap(V().has(marko).out()).path() is [v, w, x] per edge × marko\'s out', () => {
    expect(paths("g.V().out().flatMap(V().has('name','marko').out()).path()"))
      .toEqual(bagOf(hostPaths.flatMap((p) => ['v2', 'v3', 'v4'].map((x) => JSON.stringify([...JSON.parse(p), x])))));
  });
  test('the count', () => expect(count("g.V().out().flatMap(V().has('name','marko')).path().count()")).toBe(6));
  test('a value result is its value position', () => {
    expect(paths("g.V().out().flatMap(V().has('name','marko').values('name')).path()"))
      .toEqual(bagOf(hostPaths.map((p) => JSON.stringify([...JSON.parse(p), 'marko']))));
  });
  test('a host label read after the split', () => {
    expect(bagOf(rows("g.V().as('a').out().flatMap(V().has('name','lop').select('a')).path().by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf(rows("g.V().as('a').out().path().by('name')").map((r) => JSON.stringify([...members(r), members(r)[0]]))));
  });
  test("the read's own label, selected past a host read", () => {
    expect(bagOf(rows("g.V().as('a').out().flatMap(V().as('x').has('name','lop').select('a').select('x')).path().by('name')").map((r) => JSON.stringify(members(r)))))
      .toEqual(bagOf(rows("g.V().as('a').out().path().by('name')").map((r) => JSON.stringify([...members(r), 'lop']))));
  });
  test('coalesce() splits the host too', () => {
    expect(paths("g.V().out().coalesce(V().has('name','zzz'), V().has('name','marko')).path()"))
      .toEqual(bagOf(hostPaths.map((p) => JSON.stringify([...JSON.parse(p), 'v1']))));
  });
  test('at depth: under local(), where(), map() and repeat()', () => {
    expect(count("g.V().local(out().flatMap(V().has('name','marko')).path()).count()")).toBe(6);
    expect(count("g.V().out().where(flatMap(V().has('name','marko')).path().count(local).is(3)).count()")).toBe(6);
    expect(scalars("g.V().out().map(flatMap(V().has('name','marko')).path()).count(local)")).toEqual(Array(6).fill(3));
    expect(count("g.V().repeat(flatMap(V().has('name','lop'))).times(2).path().count()")).toBe(6);
  });
  test('the read label still does not leave flatMap()', () => {
    expect(count("g.V().flatMap(V().has('name','marko').as('x')).select('x').count()")).toBe(0);
  });
  test('a path read INSIDE the body still declines, naming it', () => {
    expect(() => run(s, "g.V().out().flatMap(V().has('name','marko').simplePath()).count()"))
      .toThrow('a path(), simplePath() or cyclicPath() inside a flatMap() body that starts with V()/E()');
  });
});

describe('tree() folds the paths a split or forward rejoin emits, in traverser order', () => {
  // `TreeStep.projectTraverser` reads each traverser's path
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TreeStep.java),
  // so its members are exactly the `path()` stream; the rejoin threads an emission-order encounter, and the
  // collection must consume it (src/rel/obligations.ts `collectionConsumesEncounter`) — it once leaked a bare Error.
  const treePaths = (g: string): string[] => {
    const [row] = run(s, g);
    return bagOf(JSON.parse(row.node).v.map((p: any[]) => JSON.stringify(bare(p).map((m: any) => (m && typeof m === 'object' && 'id' in m ? `v${m.id}` : m)))));
  };
  const pathsBy = (g: string): string[] => bagOf(rows(g).map((r) => JSON.stringify(members(r))));
  for (const body of [
    "out().flatMap(V().has('name','marko'))",
    "out().flatMap(V().has('name','marko').out())",
    "out().flatMap(V().has('name','marko')).out()",
    "has('name','marko').out().flatMap(V().has('name','lop'))",
    'out().flatMap(out())',
    'flatMap(out())',
    'out().local(out())',
    'union(out(), in())',
    'coalesce(out())',
    'optional(out())',
  ]) {
    test(`${body}.tree() is its path() stream`, () => {
      expect(treePaths(`g.V().${body}.tree()`)).toEqual(pathsBy(`g.V().${body}.path()`));
      expect(treePaths(`g.V().${body}.tree().by('name')`)).toEqual(pathsBy(`g.V().${body}.path().by('name')`));
    });
  }
});

describe('a forward (local()) host on a traverser whose path is tracked', () => {
  // `LocalStep` emits the CHILD's own traverser, whose path the read's GraphStep extends: GraphStep's own cross in
  // the fold (`reSource`) extends it, so these answer — the connector's shared read only notes its reason.
  const names = (q: string): string[][] => bare(run(s, q)).map((row: { list: string }) => JSON.parse(row.list).map((e: { v: string }) => e.v));
  test('out().local(V().has(marko)).path() is each out() path extended by marko', () => {
    expect(names("g.V().out().local(V().has('name','marko')).path().by('name')").map((p) => p[2])).toEqual(Array(6).fill('marko'));
    expect(names("g.V().out().local(V().has('name','marko')).path().by('name')").every((p) => p.length === 3)).toBe(true);
  });
  test('out().local(V().order().limit(1)).path() slices per local() start', () => {
    expect(names("g.V().out().local(V().order().by('name').limit(1)).path().by('name')").map((p) => p[2])).toEqual(Array(6).fill('josh'));
  });
  test('a path read INSIDE the local() body sees the host path extended by the read', () => {
    // [origin, v]: simple unless v is the origin, cyclic only then.
    expect(bare(run(s, 'g.V().local(V().simplePath().count())')).map((row: { v: number }) => row.v)).toEqual(Array(6).fill(5));
    expect(bare(run(s, 'g.V().local(V().cyclicPath().count())')).map((row: { v: number }) => row.v)).toEqual(Array(6).fill(1));
  });
  test('a reducer after the re-source still declines, naming the shape', () => {
    expect(() => run(s, "g.V().local(V().hasLabel('software').count()).path()"))
      .toThrow('a V()/E() inside local() on a traverser whose path is tracked');
  });
  // Where the path is asked for INSIDE a flatMap() body, the message says so, and names the host it fired under.
  for (const [q, host] of [['g.V().flatMap(V().path())', 'flatMap']] as const) {
    test(q, () => {
      expect(() => run(s, q)).toThrow(`a path(), simplePath() or cyclicPath() inside a ${host}() body that starts with V()/E()`);
    });
  }
});
