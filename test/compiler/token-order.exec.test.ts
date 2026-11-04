// A `T`/`Direction` key orders by its NAME (`orderability.ts` `kindOf` puts a token on the String rung),
// end to end — and the JS comparator behind `order(Scope.local).by(keys)` must AGREE with the SQL
// `ORDER BY` an unfolded entry's key gets (`elementMap().unfold().order().by(keys)`), or the same
// question would answer two ways depending on which side of the barrier it was asked.
// Reference: `vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/map/Order.feature`,
// `g_VX1X_elementMap_orderXlocalX_byXkeys_ascXunfold` (`age, id, label, name`) and its `desc` twin.
import { test, expect, describe } from 'bun:test';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const store = seededStore();
/** A decoded key by name — a token as `T.id`/`Direction.OUT`, a String as itself. */
const name = (k: any): string => (k && typeof k === 'object' && 'elementName' in k ? `${k.typeName}.${k.elementName}` : String(k));
/** Each one-entry map's key, in result order. */
const keysOf = async (q: string): Promise<string[]> =>
  (await decodeAll(executeQuery(store, q))).map((m: Map<unknown, unknown>) => name([...m.keys()][0]));
const listOf = async (q: string): Promise<string[]> => {
  const [list] = await decodeAll(executeQuery(store, q));
  return [...(list as Iterable<unknown>)].map(name);
};

describe('T / Direction keys order by name', () => {
  test('a vertex elementMap, order(local).by(keys) — both corpus directions', async () => {
    expect(await keysOf('g.V(1).elementMap().order(Scope.local).by(Column.keys, Order.asc).unfold()'))
      .toEqual(['age', 'T.id', 'T.label', 'name']);
    expect(await keysOf('g.V(1).elementMap().order(Scope.local).by(Column.keys, Order.desc).unfold()'))
      .toEqual(['name', 'T.label', 'T.id', 'age']);
  });

  test('an edge elementMap — Direction keys are upper case, so they lead in code-point order', async () => {
    expect(await keysOf('g.E(7).elementMap().order(Scope.local).by(Column.keys).unfold()'))
      .toEqual(['Direction.IN', 'Direction.OUT', 'T.id', 'T.label', 'weight']);
    expect(await keysOf('g.E(7).elementMap().order(Scope.local).by(Column.keys, Order.desc).unfold()'))
      .toEqual(['weight', 'T.label', 'T.id', 'Direction.OUT', 'Direction.IN']);
  });

  test('the JS comparator AGREES with the SQL order of the same keys', async () => {
    for (const [source, dir] of [['V(1)', 'asc'], ['V(1)', 'desc'], ['E(7)', 'asc'], ['E(7)', 'desc'], ['V(3)', 'asc']] as const) {
      const local = await keysOf(`g.${source}.elementMap().order(Scope.local).by(Column.keys, Order.${dir}).unfold()`);
      const global = await keysOf(`g.${source}.elementMap().unfold().order().by(Column.keys, Order.${dir})`);
      expect(global).toEqual(local);
    }
    // ... and with a key LIST sorted in SQL (`select(keys).order(local)`)
    expect(await listOf('g.E(7).elementMap().select(Column.keys).order(Scope.local)'))
      .toEqual(['Direction.IN', 'Direction.OUT', 'T.id', 'T.label', 'weight']);
  });

  test('composes: over every vertex, after a repeat, and with a second by()', async () => {
    const all = await decodeAll(executeQuery(store, "g.V().hasLabel('person').elementMap().order(Scope.local).by(Column.keys)"));
    for (const m of all as Map<unknown, unknown>[]) expect([...m.keys()].map(name)).toEqual(['age', 'T.id', 'T.label', 'name']);
    expect(await keysOf("g.V(1).repeat(out('created')).times(1).elementMap().order(Scope.local).by(Column.keys).unfold()"))
      .toEqual(['T.id', 'T.label', 'lang', 'name']);
    expect(await keysOf('g.V(1).elementMap().order(Scope.local).by(Column.keys).by(Column.values).unfold()'))
      .toEqual(['age', 'T.id', 'T.label', 'name']);
  });
});
