// The GraphQL front end (Phase 2): document + reflected schema → Gremlin string → the compiler.
// Two layers — the translator over a hand-built schema (unit), and the full reflect→translate→run
// path over a live seeded store (integration), which is what a GraphQL request actually does.
import { test, expect, describe } from 'bun:test';
import { translate, buildSchema, GraphQLTranslationError } from '../src/graphql/translate.ts';
import type { SchemaRow } from '../src/graphql/schema.ts';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { exec, executeQuery } from './support/executor.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { decode, decodeAll } from './support/decode.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { makeRouter } from '../src/router.ts';

// The modern graph's reflected schema, hand-built for the translator unit tests.
const MODERN_SCHEMA: SchemaRow[] = [
  { kind: 'vertexLabel', name: 'person', count: 4 },
  { kind: 'vertexLabel', name: 'software', count: 2 },
  { kind: 'property', label: 'person', key: 'name', type: 'string' },
  { kind: 'property', label: 'person', key: 'age', type: 'int' },
  { kind: 'property', label: 'software', key: 'name', type: 'string' },
  { kind: 'property', label: 'software', key: 'lang', type: 'string' },
  { kind: 'edge', label: 'knows', src: 'person', tgt: 'person' },
  { kind: 'edge', label: 'created', src: 'person', tgt: 'software' },
];
const schema = buildSchema(MODERN_SCHEMA);
const norm = (v: any): any =>
  v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, norm(x)])) : Array.isArray(v) ? v.map(norm) : v;

describe('translate — a GraphQL document to a Gremlin string', () => {
  test('a scalar leaf → values(); a root type → V().hasLabel', () => {
    expect(translate(`{ person { name } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').project('name').by(__.values('name'))");
  });

  test('an alias becomes the project() key', () => {
    expect(translate(`{ person { fullName: name } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').project('fullName').by(__.values('name'))");
  });

  test('an object field → the edge movement + a folded nested projection', () => {
    expect(translate(`{ person { name created { name } } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').project('name', 'created')"
        + ".by(__.values('name')).by(__.out('created').project('name').by(__.values('name')).fold())");
  });

  test('an IN edge is reached under its `_in` field name', () => {
    // `created` is person→software, so software gets a `created_in` field back to person.
    expect(translate(`{ software { name created_in { name } } }`, schema).gremlin)
      .toBe("g.V().hasLabel('software').project('name', 'created_in')"
        + ".by(__.values('name')).by(__.in('created').project('name').by(__.values('name')).fold())");
  });

  describe('fail closed — an unsupported document raises, never a half-Gremlin string', () => {
    const refuses = (q: string, match: RegExp) => expect(() => translate(q, schema)).toThrow(match);
    test('a field the schema does not declare', () => refuses(`{ person { bogus } }`, /no field 'bogus'/));
    test('a scalar field with a selection set', () => refuses(`{ person { name { x } } }`, /cannot have a selection set/));
    test('an object field with no selection set', () => refuses(`{ person { created } }`, /needs a selection set/));
    test('an unrecognised argument name', () => refuses(`{ person(id: 1) { name } }`, /expected where\/sort\/limit\/offset/));
    test('a mutation operation', () => refuses(`mutation { addPerson { name } }`, /only 'query'/));
    test('a fragment', () => refuses(`{ person { ...F } }`, /fragments are not supported/));
    test('a query that declares variables (dropping them would be a wrong answer)', () =>
      refuses(`query($id: Int) { person { name } }`, /variables are not supported/));
    test('several root fields', () => refuses(`{ person { name } software { name } }`, /one root field/));
    test('an unknown root type', () => refuses(`{ animal { name } }`, /no type 'animal'/));
    test('the error type is GraphQLTranslationError', () => {
      expect(() => translate(`{ person { bogus } }`, schema)).toThrow(GraphQLTranslationError);
    });
  });
});

describe('the where filter — { field: { op: value } }, the graph-native convention', () => {
  const run = async (q: string) => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const g of MODERN_SEED) executeQuery(store, g, {});
    return (await decodeAll(exec(store).buffers(translate(q, schema).gremlin, {}))).map(norm);
  };
  const names = (rows: any[]) => rows.map((r: any) => r.name).sort();

  test('eq → has(k, P.eq(v))', () => {
    expect(translate(`{ person(where: { name: { eq: "marko" } }) { name } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').has('name', P.eq('marko')).project('name').by(__.values('name'))");
  });

  test('a comparison operator filters — age gt 30', async () => {
    expect(names(await run(`{ person(where: { age: { gt: 30 } }) { name } }`))).toEqual(['josh', 'peter']);
  });

  test('in → within(...)', async () => {
    expect(names(await run(`{ person(where: { name: { in: ["marko", "josh"] } }) { name } }`))).toEqual(['josh', 'marko']);
  });

  test('a substring operator → TextP', () => {
    expect(translate(`{ person(where: { name: { contains: "ark" } }) { name } }`, schema).gremlin)
      .toContain("has('name', TextP.containing('ark'))");
  });

  test('where on an object field filters the far endpoint', async () => {
    const rows = await run(`{ person(where:{name:{eq:"marko"}}) { name created(where:{lang:{eq:"java"}}) { name } } }`);
    expect(rows).toEqual([{ name: 'marko', created: [{ name: 'lop' }] }]);
  });

  test('an Int value is bare; a Float forces a decimal so it parses as a double', () => {
    expect(translate(`{ person(where: { age: { eq: 29 } }) { name } }`, schema).gremlin).toContain('P.eq(29)');
    expect(translate(`{ person(where: { age: { gt: 30.0 } }) { name } }`, schema).gremlin).toContain('P.gt(30.0)');
  });

  describe('fail closed', () => {
    const refuses = (q: string, m: RegExp) => expect(() => translate(q, schema)).toThrow(m);
    test('an unknown operator', () => refuses(`{ person(where: { name: { bogus: "x" } }) { name } }`, /unknown filter operator 'bogus'/));
    test('a non-property key', () => refuses(`{ person(where: { nope: { eq: "x" } }) { name } }`, /cannot filter on 'nope'/));
    test('a bare value with no operator object', () => refuses(`{ person(where: { name: "marko" }) { name } }`, /operator object/));
    test('an unrecognised argument', () => refuses(`{ person(first: 2) { name } }`, /expected where\/sort\/limit\/offset/));
    test('a scalar field taking an argument', () => refuses(`{ person { name(where: {}) } }`, /takes no arguments/));
  });
});

describe('sort / limit / offset — ordering and pagination args', () => {
  const run = async (q: string) => {
    const store = new GraphStore(new BunSqlite(':memory:'));
    for (const g of MODERN_SEED) executeQuery(store, g, {});
    return (await decodeAll(exec(store).buffers(translate(q, schema).gremlin, {}))).map((r: any) => norm(r).name);
  };

  test('sort ASC → order().by(k, asc)', () => {
    expect(translate(`{ person(sort: [{ name: ASC }]) { name } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').order().by('name', asc).project('name').by(__.values('name'))");
  });

  test('sort DESC orders descending', async () => {
    expect(await run(`{ person(sort: [{ age: DESC }]) { name } }`)).toEqual(['peter', 'josh', 'marko', 'vadas']);
  });

  test('limit slices; offset skips (skip.limit, in that order)', async () => {
    expect(await run(`{ person(sort: [{ name: ASC }], limit: 2) { name } }`)).toEqual(['josh', 'marko']);
    expect(await run(`{ person(sort: [{ name: ASC }], offset: 1, limit: 2) { name } }`)).toEqual(['marko', 'peter']);
  });

  test('where + sort + limit compose in the semantic order (filter → order → slice)', async () => {
    expect(await run(`{ person(where: { age: { gt: 20 } }, sort: [{ age: DESC }], limit: 2) { name } }`)).toEqual(['peter', 'josh']);
    expect(translate(`{ person(where: { age: { gt: 20 } }, sort: [{ age: DESC }], limit: 2) { name } }`, schema).gremlin)
      .toBe("g.V().hasLabel('person').has('age', P.gt(20)).order().by('age', desc).limit(2).project('name').by(__.values('name'))");
  });

  test('a single sort object (not a list) is accepted for the one-key case', () => {
    expect(translate(`{ person(sort: { name: ASC }) { name } }`, schema).gremlin).toContain("order().by('name', asc)");
  });

  describe('fail closed', () => {
    const refuses = (q: string, m: RegExp) => expect(() => translate(q, schema)).toThrow(m);
    test('a bad sort direction', () => refuses(`{ person(sort: [{ name: SIDEWAYS }]) { name } }`, /must be ASC or DESC/));
    test('sorting on a non-property', () => refuses(`{ person(sort: [{ nope: ASC }]) { name } }`, /cannot sort on 'nope'/));
    test('a non-integer limit', () => refuses(`{ person(limit: "two") { name } }`, /'limit' must be an integer/));
    test('a negative offset', () => refuses(`{ person(offset: -1) { name } }`, /'offset' must be >= 0/));
    test('a duplicate argument', () => refuses(`{ person(limit: 1, limit: 2) { name } }`, /given twice/));
  });
});

describe('reflect → translate → run — the full path over a live graph', () => {
  const store = new GraphStore(new BunSqlite(':memory:'));
  for (const g of MODERN_SEED) executeQuery(store, g, {});

  /** Reflect the live schema by draining `mogwai.schema` — each GraphBinary map decodes to a
   *  `SchemaRow` (the service's row shape IS the row model), then `buildSchema` folds it. This is what
   *  a GraphQL request does before translating (§5·4). */
  const reflect = async () => {
    const rows: SchemaRow[] = [];
    for (const b of exec(store, extendedRegistry).buffers("g.call('mogwai.schema')", {})) {
      rows.push(Object.fromEntries([...(await decode(b))]) as SchemaRow);
    }
    return buildSchema(rows);
  };

  const run = async (q: string) => {
    const live = await reflect();
    return (await decodeAll(exec(store).buffers(translate(q, live).gremlin, {}))).map(norm);
  };

  test('a reflected schema translates and runs a depth-2 selection', async () => {
    const rows = await run(`{ person { name created { name } } }`);
    expect(rows.find((r: any) => r.name === 'marko')).toEqual({ name: 'marko', created: [{ name: 'lop' }] });
    expect(rows.find((r: any) => r.name === 'josh')).toEqual({ name: 'josh', created: [{ name: 'lop' }, { name: 'ripple' }] });
    expect(rows.find((r: any) => r.name === 'vadas')).toEqual({ name: 'vadas', created: [] });
  });

  test('a depth-3 selection navigating both edge directions', async () => {
    const rows = await run(`{ person { name created { name created_in { name } } } }`);
    const josh: any = rows.find((r: any) => r.name === 'josh');
    // josh created ripple (only josh) and lop (josh, marko, peter).
    expect(josh.created.find((s: any) => s.name === 'ripple').created_in).toEqual([{ name: 'josh' }]);
    expect(josh.created.find((s: any) => s.name === 'lop').created_in.map((p: any) => p.name).sort())
      .toEqual(['josh', 'marko', 'peter']);
  });
});

describe('the HTTP edge — POST/GET /graphql/{g} over the real router', () => {
  const mgr = new BunGraphManager(undefined, extendedRegistry);
  const router = makeRouter(mgr);
  const seeded = (async () => { for (const g of MODERN_SEED) await mgr.executor('g').framedAsync(g, {}); })();

  const post = async (body: unknown) => {
    await seeded;
    const res = await router(new Request('http://x/graphql/g', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() as any };
  };

  test('a query returns a spec-shaped {data} keyed by the root field', async () => {
    const { status, body } = await post({ query: `{ person { name created { name } } }` });
    expect(status).toBe(200);
    const marko = body.data.person.find((p: any) => p.name === 'marko');
    expect(marko).toEqual({ name: 'marko', created: [{ name: 'lop' }] });
    expect(body.data.person.find((p: any) => p.name === 'vadas')).toEqual({ name: 'vadas', created: [] });
    expect(body.errors).toBeUndefined();
  });

  test('an alias keys the response under the alias', async () => {
    const { body } = await post({ query: `{ people: person { who: name } }` });
    expect(body.data.people.map((p: any) => p.who).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('the scoped extensions explain flag returns the compiled Gremlin', async () => {
    const { body } = await post({ query: `{ person { name } }`, extensions: { 'mogwai:explain': true } });
    expect(body.extensions['mogwai:explain'].gremlin)
      .toBe("g.V().hasLabel('person').project('name').by(__.values('name'))");
    expect(body.data.person.length).toBe(4);
  });

  test('a translation refusal is a 200 with {errors} and no data (well-formed request, bad op)', async () => {
    const { status, body } = await post({ query: `{ person { bogus } }` });
    expect(status).toBe(200);
    expect(body.data).toBeUndefined();
    expect(body.errors[0].message).toMatch(/no field 'bogus'/);
  });

  test('a malformed transport (no query) is a 400', async () => {
    const { status, body } = await post({ notAQuery: true });
    expect(status).toBe(400);
    expect(body.errors[0].message).toMatch(/string `query`/);
  });

  test('supplying `variables` is refused, not accepted-and-ignored', async () => {
    const { body } = await post({ query: `{ person { name } }`, variables: { x: 1 } });
    expect(body.data).toBeUndefined();
    expect(body.errors[0].message).toMatch(/variables are not supported/);
  });

  test('supplying `operationName` is refused, not silently dropped', async () => {
    const { body } = await post({ query: `{ person { name } }`, operationName: 'Q' });
    expect(body.data).toBeUndefined();
    expect(body.errors[0].message).toMatch(/operationName is not supported/);
  });

  test('GET runs a query from the ?query= param — GraphQL-over-HTTP GET, not a page', async () => {
    await seeded;
    const res = await router(new Request('http://x/graphql/g?query=' + encodeURIComponent('{ person { name } }'), { method: 'GET' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    const body = await res.json() as any;
    expect(body.data.person.map((p: any) => p.name).sort()).toEqual(['josh', 'marko', 'peter', 'vadas']);
  });

  test('GET with no query is a 400 (never a server-rendered HTML page)', async () => {
    await seeded;
    const res = await router(new Request('http://x/graphql/g', { method: 'GET' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
  });

  test('an untrusted graph id in the path is never reflected into a response body', async () => {
    // The edge serves JSON only, never HTML, so a crafted path id has no reflection surface — the id
    // only ever selects a graph, never appears in output.
    await seeded;
    const res = await router(new Request(`http://x/graphql/${encodeURIComponent('<script>alert(1)</script>')}?query=${encodeURIComponent('{ person { name } }')}`, { method: 'GET' }));
    const text = await res.text();
    expect(text).not.toContain('<script>');
  });
});
