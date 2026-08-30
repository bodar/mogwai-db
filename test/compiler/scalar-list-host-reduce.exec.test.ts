// A `by()` body over a LIST host whose members are SCALARS — `select('a').by(__.unfold().<reducer>)`.
// `correlatedListMembers` already framed a scalar member re-entry; `listHostChild`/`correlatedReduce`
// only accepted an ELEMENT root, so a scalar-membered list host declined where an element one worked.
// A scalar member re-enters the scalar loop, so `count`/`sum`/`max`/`fold` reduce through the SAME
// `correlatedReduce` collapse arms. ⚠️ The member re-entry carries the member POSITION as the ENCOUNTER
// channel, so `fold()` preserves LIST order rather than value-sorting (`foldScalars`' no-encounter
// fallback) — the determinism `mise run test:perturbed` guards. See list.ts / reduction.ts.
import { test, expect, describe } from 'bun:test';
import { run, seededStore } from '../support/harness.ts';

describe('a by() body over a SCALAR-membered list host', () => {
  const one = (store: ReturnType<typeof seededStore>, g: string) => (run(store, g) as any[])[0];

  // The person ages on the modern graph in vertex-encounter order: marko 29, vadas 27, josh 32, peter 35.
  const AGES = "g.V().values('age').fold().as('a').select('a')";

  test('count / sum / max reduce over the members', () => {
    const store = seededStore();
    expect(one(store, `${AGES}.by(__.unfold().count())`).v).toBe(4);
    expect(one(store, `${AGES}.by(__.unfold().sum())`).v).toBe(123); // 29+27+32+35
    expect(one(store, `${AGES}.by(__.unfold().max())`).v).toBe(35);
    expect(one(store, `${AGES}.by(__.unfold().min())`).v).toBe(27);
  });

  test('fold re-collects the members in LIST ORDER, not value order', () => {
    const store = seededStore();
    // Encounter order is [29,27,32,35]; a value-sort would give [27,29,32,35] — the bug the encounter
    // channel prevents.
    expect(one(store, `${AGES}.by(__.unfold().fold())`).list).toBe('[29,27,32,35]');
  });
});

describe('a TYPED-membered list host carries the member type into the reduction', () => {
  // A typed member re-enters the scalar loop with its own `vtype` (mirroring unfoldList's typed branch),
  // so a comparison is TYPE-AWARE and the result frames by its true Gremlin type — not the SQLite storage
  // class. Two wrong answers this prevents: a datetime max framed as a bare Long, and a bigdecimal (stored
  // as decimal TEXT) compared LEXICOGRAPHICALLY ('9.99' > '10.5') rather than numerically.
  const one = (store: ReturnType<typeof seededStore>, g: string) => (run(store, g) as any[])[0];
  const DT = "g.inject(datetime('2021-06-01T00:00:00Z'), datetime('2020-01-01T00:00:00Z')).fold().as('a').select('a')";
  const BD = "g.inject(9.99M, 10.5M, 2.1M).fold().as('a').select('a')";

  test('a datetime member max frames as a DateTime, not a Long', () => {
    const store = seededStore();
    const r = one(store, `${DT}.by(__.unfold().max())`);
    expect(r.vt).toBe('datetime');
    expect(r.v).toBe(1622505600000); // 2021-06-01, the later of the two
  });

  test('a bigdecimal member max compares NUMERICALLY, not lexicographically', () => {
    const store = seededStore();
    const r = one(store, `${BD}.by(__.unfold().max())`);
    expect(r.vt).toBe('bigdecimal');
    expect(r.v).toBe('10.5'); // numeric max; a text compare would wrongly pick '9.99'
  });
});

describe('MAP and nested-LIST members over a list host reduce too', () => {
  // correlatedListMembers frames a map member into mapTail and a nested-list member into listTail (the
  // correlated twins of unfoldMapMembers/unfoldNested), so a shape-agnostic count() and a re-collecting
  // fold() work whatever the members are. The member position rides as the encounter channel, so fold()
  // is order-preserving (unfold+fold is the identity).
  const one = (store: ReturnType<typeof seededStore>, g: string) => (run(store, g) as any[])[0];
  // A list of the four person {name:[...]} maps.
  const MAPS = "g.V().hasLabel('person').valueMap('name').fold()";
  // group().by(T.label).by(values('name').fold()) -> values() is [ [person names], [software names] ].
  const LISTS = "g.V().group().by(T.label).by(__.values('name').fold()).select(Column.values)";

  test('count over a list-of-maps counts the maps', () => {
    const store = seededStore();
    expect(one(store, `${MAPS}.as('a').select('a').by(__.unfold().count())`).v).toBe(4);
  });

  test('count over a list-of-lists counts the inner lists', () => {
    const store = seededStore();
    expect(one(store, `${LISTS}.as('a').select('a').by(__.unfold().count())`).v).toBe(2);
  });

  test('fold over a list-of-maps re-collects in order (unfold+fold is identity)', () => {
    const store = seededStore();
    const base = one(store, MAPS).list;
    const refolded = one(store, `${MAPS}.as('a').select('a').by(__.unfold().fold())`).list;
    expect(refolded).toBe(base);
  });
});
