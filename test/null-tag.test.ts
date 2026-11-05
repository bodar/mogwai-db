import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { CfLimitedSql } from '../src/cf-limits.ts';
import { isNullTag, leafTag, NULL_TAG, valueNodeOf } from '../src/gremlin/types.ts';
import { loadGraphson, writeGraphson } from '../src/formats/graphson.ts';
import { writeCsv } from '../src/formats/csv.ts';
import { nodeIsNull } from '../src/compiler/rel/tag.ts';
import { emitQuery } from '../src/rel/emit.ts';
import { planOf } from '../src/rel/plan.ts';
import { col, lit } from '../src/rel/expr.ts';
import { project, values } from '../src/rel/factory.ts';
import { relId } from '../src/rel/types.ts';
import { vertexContent } from '../src/rev.ts';
import { read, run, seededStore } from './support/harness.ts';
import { executeQuery } from './support/executor.ts';

// THE TOTAL TAG (docs/2026-11-05-presence-is-the-tag-plan.md P1): every typed `{t,v}` tree and every
// alias-history entry spells a NULL value with the null tag `'null'`, so a member that IS null is told
// apart from a tag nobody wrote. The spelling is invisible on the wire (a null frames as the one null
// whatever its tag), so these assert the stored and compiled forms, plus the one reader whose answer
// depended on reading the tag: `group()`'s last-wins member.

const fresh = () => new GraphStore(new CfLimitedSql(new BunSqlite(':memory:')));
const storedJson = (store: GraphStore, key: string): unknown =>
  JSON.parse((store.query(`SELECT json(value) AS j FROM vertex_properties WHERE key = '${key}'`)[0] as { j: string }).j);

describe('a null leaf is tagged null — in JS and in SQL, by one rule each', () => {
  test('valueNodeOf tags a null member null whatever its channel declared', () => {
    expect(valueNodeOf(null, null)).toEqual({ t: NULL_TAG, v: null });
    expect(valueNodeOf(null, 'int')).toEqual({ t: NULL_TAG, v: null });
    expect(valueNodeOf([null, 1], null).v).toEqual([{ t: 'null', v: null }, { t: 'int', v: 1 }]);
    // The framers read the spelling back to an untagged null, and leave every other tag alone.
    expect(leafTag(NULL_TAG)).toBeNull();
    expect(leafTag('int')).toBe('int');
    expect(isNullTag('null') && !isNullTag(null) && !isNullTag('string')).toBe(true);
  });

  test('nodeIsNull is true for the null tag, an untagged node and a SQL NULL — and only those', () => {
    // The SQL twin of `isNullTag`: a node with NO tag is a null to every reader too (an untagged child
    // null, an empty reducer), so the one predicate covers both spellings.
    const db = new Database(':memory:');
    const isNull = (node: string | null): unknown => {
      const one = values({
        id: relId('n'), channels: [], type: { cols: [{ name: 'node', type: 'json', nullable: true }] },
        rows: [[lit(node, 'text')]],
      });
      const p = project({
        id: relId('p'), input: one, channels: [], type: { cols: [{ name: 'r', type: 'int', nullable: false }] },
        exprs: [['r', nodeIsNull(col(one.id, 'node'))]],
      });
      const { sql, binds } = emitQuery(planOf(p));
      return (db.query(sql).get(...binds) as { r: number }).r;
    };
    expect(isNull('{"t":"null","v":null}')).toBe(1);
    expect(isNull('{"t":null,"v":null}')).toBe(1);
    expect(isNull(null)).toBe(1);
    expect(isNull('{"t":"int","v":0}')).toBe(0);
    // A String member whose TEXT is "null" is a value, not a null.
    expect(isNull('{"t":"string","v":"null"}')).toBe(0);
  });
});

describe('a stored collection spells its null members with the null tag', () => {
  test("property('l',[null,1]) and property('m',['a':null]) store t:'null'", () => {
    const store = fresh();
    executeQuery(store, "g.addV('x').property('l',[null,1]).property('m',['a':null])");
    expect(storedJson(store, 'l')).toEqual([{ t: 'null', v: null }, { t: 'int', v: 1 }]);
    expect(storedJson(store, 'm')).toEqual([[{ t: 'string', v: 'a' }, { t: 'null', v: null }]]);
  });

  test('a GraphSON round trip of a null member is identical, and CSV still refuses the collection', () => {
    const store = fresh();
    executeQuery(store, "g.addV('x').property(T.id, 1).property('l',[null,1]).property('m',['a':null,'b':2])");
    const document = writeGraphson(store);
    const reloaded = fresh();
    loadGraphson(reloaded, document);
    expect(writeGraphson(reloaded)).toBe(document);
    expect(storedJson(reloaded, 'l')).toEqual(storedJson(store, 'l'));
    expect(storedJson(reloaded, 'm')).toEqual(storedJson(store, 'm'));
    // The null member is a bare JSON null in the file — the tag is the store's spelling, not GraphSON's.
    expect(document).toContain('{"@type":"g:List","@value":[null,{"@type":"g:Int32","@value":1}]}');
    expect(() => writeCsv(store).vertices).toThrow();
  });

  test("a meta-property NAMED t is a meta-key, not a node's tag", () => {
    const store = fresh();
    executeQuery(store, "g.addV('y').property('k',1,'t',null).property('j',2,'t',5)");
    const meta = (s: GraphStore) => s.query("SELECT key, json(meta) AS m FROM vertex_properties ORDER BY key") as { key: string; m: string }[];
    // The meta object is keyed by meta-KEY; a key spelled `t` is data, never read as a node's tag.
    expect(meta(store)).toEqual([{ key: 'j', m: '{"t":5}' }, { key: 'k', m: '{"t":null}' }]);
    expect(run(store, "g.V().hasLabel('y').values('k','j').order()").map((r) => r.v)).toEqual([1, 2]);
    const document = writeGraphson(store);
    const reloaded = fresh();
    loadGraphson(reloaded, document);
    expect(writeGraphson(reloaded)).toBe(document);
    expect(meta(reloaded)).toEqual(meta(store));
  });

  test('the rev hashes content, so the null tag moves no rev', () => {
    const prop = (value: string) => ({ id: 1, owner: 1, key: 'l', value, vtype: 'list', meta: null });
    expect(vertexContent(['x'], [prop('[{"t":"null","v":null},{"t":"int","v":1}]')]))
      .toBe(vertexContent(['x'], [prop('[{"t":null,"v":null},{"t":"int","v":1}]')]));
    // A String member whose text spells a node is content, and is not rewritten.
    const text = prop('[{"t":"string","v":"{\\"t\\":\\"null\\",\\"v\\":null}"}]');
    expect(vertexContent(['x'], [text])).not.toBe(vertexContent(['x'], [prop('[{"t":"string","v":"{\\"t\\":null,\\"v\\":null}"}]')]));
  });
});

describe('an alias entry spells a compile-time null with the null tag', () => {
  test("constant(null).as('k') carries t:'null' and no exact-REAL repair", () => {
    const { sql } = read("g.inject(1).constant(null).as('k').select('k')");
    expect(sql).toContain("jsonb_object('k', 2, 'v', NULL, 't', 'null')");
    expect(sql).not.toContain('typeof(NULL)');
    expect(run(seededStore(), "g.inject(1).constant(null).as('k').select('k')")).toEqual([{ v: null }]);
  });

  test('a stored value entry keeps its bare vtype column — no per-row inference', () => {
    const { sql } = read("g.V().as('v').values('name').as('n').select('v','n')");
    expect(sql).toMatch(/'t', \w+\.vtype\)\) AS a1/);
    expect(sql).not.toContain('COALESCE(rp');
  });
});

describe("group()'s last-wins member reads a null-tagged node as null", () => {
  // `GroupStep.GroupBiOperator` keeps the held value when the arriving one is null
  // (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GroupStep.java:205-216).
  // A map literal's null value is now `{t:'null'}`; a reader that took `t IS NOT NULL` as "not null" let it win.
  const groups = (q: string) => (run(seededStore(), q) as { map: string }[]).map((r) =>
    JSON.parse(r.map, (k, v) => (k === 't' ? leafTag(v) : v)) as unknown);
  test.each([
    ["g.inject(['a':3],['a':null]).unfold().group().by(keys).by(__.select(values))", [[[{ t: 'string', v: 'a' }, { t: 'int', v: 3 }]]]],
    ["g.inject(['a':null],['a':3]).unfold().group().by(keys).by(__.select(values))", [[[{ t: 'string', v: 'a' }, { t: 'int', v: 3 }]]]],
    ["g.inject(['a':null],['a':null]).unfold().group().by(keys).by(__.select(values))", [[[{ t: 'string', v: 'a' }, { t: null, v: null }]]]],
  ])('%s', (q, expected) => expect(groups(q)).toEqual(expected));

  test('a stored map with a null value composes the same way', () => {
    const store = fresh();
    executeQuery(store, "g.addV('x').property('m',['a':3])");
    executeQuery(store, "g.addV('x').property('m',['a':null])");
    const rows = run(store, "g.V().hasLabel('x').order().by(T.id).values('m').is(typeOf(GType.MAP)).unfold().group().by(keys).by(select(values))") as { map: string }[];
    expect(JSON.parse(rows[0]!.map)).toEqual([[{ t: 'string', v: 'a' }, { t: 'int', v: 3 }]]);
  });
});
