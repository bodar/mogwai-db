// Phase 3 — the GraphQL conformance ORACLES (`docs/2026-08-07-graphql-front-end-plan.md` §7).
//
// There is no portable `.feature`-style execution corpus for GraphQL the way `gremlin-test` is for
// Gremlin, but there are three real oracles that together cover more than one corpus would:
//
//   1. graphql-http `serverAudits` — the GraphQL Foundation's GraphQL-over-HTTP compliance suite, run
//      against our live router in-process. A conformance RATCHET like L3: a fixed external corpus, a
//      pass count that may only go up, and ZERO MUST/SHOULD failures.
//   2. graphql-js DIFFERENTIAL — the reference implementation over a naive resolver set on the same
//      graph is an execution oracle: same document + variables, two engines, compare. Where they
//      disagree, graphql-js is right by definition (§7·2).
//   3. Introspection ROUND-TRIP — `getIntrospectionQuery()` → our endpoint → `buildClientSchema()` →
//      `printSchema()` compared against the reflector's own SDL: one assertion that validates the whole
//      schema layer and everything a GraphQL client tool depends on (§7·3).
import { test, expect, describe } from 'bun:test';
import {
  parse, execute as gqlExecute, printSchema, buildClientSchema, getIntrospectionQuery,
  type IntrospectionQuery,
} from 'graphql';
import { auditServer } from 'graphql-http';
import { GraphStore } from '../src/storage.ts';
import { BunSqlite } from '../src/bun/BunSqlite.ts';
import { BunGraphManager } from '../src/bun/BunGraphManager.ts';
import { makeRouter } from '../src/router.ts';
import { extendedRegistry } from '../src/services/standard.ts';
import { MODERN_SEED } from './fixtures/seed-modern.ts';
import { exec, executeQuery } from './support/executor.ts';
import { decode, decodeAll } from './support/decode.ts';
import { buildSchema, type SchemaRow } from '../src/graphql/schema.ts';
import { buildGraphQLSchema } from '../src/graphql/sdl.ts';
import { translate } from '../src/graphql/translate.ts';
import { readModel, oracleResolvers } from './support/graphql-oracle.ts';
import { summary } from './support/output.ts';

// A seeded store + a router over it, both reused across the file.
const store = new GraphStore(new BunSqlite(':memory:'));
for (const g of MODERN_SEED) executeQuery(store, g, {});
const mgr = new BunGraphManager(undefined, extendedRegistry);
const router = makeRouter(mgr);
const seeded = (async () => { for (const g of MODERN_SEED) await mgr.executor('g').framedAsync(g, {}); })();

/** Reflect the live schema by draining `schema` — what a GraphQL request does before translating
 *  (§5·4). Each GraphBinary map decodes to a `SchemaRow`. */
const reflectRows = async (): Promise<SchemaRow[]> => {
  const rows: SchemaRow[] = [];
  for (const b of exec(store, extendedRegistry).buffers("g.call('schema')", {}))
    rows.push(Object.fromEntries([...(await decode(b))]) as SchemaRow);
  return rows;
};

// ---------- Oracle 1: the graphql-http serverAudits conformance ratchet ----------
describe('§7·1 graphql-http serverAudits — the GraphQL-over-HTTP conformance ratchet', () => {
  // The audit is run against the live router in-process (no socket) — the same in-process `fetch`-handler
  // shape L3 uses for cucumber. `auditServer` drives every compliance test and grades each MUST/SHOULD/MAY.
  const runAudits = async () => {
    await seeded;
    const fetchFn = (input: any, init?: any) => router(new Request(input, init));
    return auditServer({ url: 'http://mogwai.test/graphql/g', fetchFn });
  };

  test('zero MUST/SHOULD failures, and the ok count holds its floor (ratchet)', async () => {
    const results = await runAudits();
    const by: Record<string, number> = { ok: 0, warn: 0, error: 0, notice: 0 };
    const failures: string[] = [];
    for (const r of results) {
      by[r.status] = (by[r.status] ?? 0) + 1;
      if (r.status === 'error' || r.status === 'warn') failures.push(`[${r.status}] ${r.name}: ${(r as any).reason}`);
    }
    summary(`  [graphql-http] ${by.ok} ok · ${by.notice} notice · ${by.warn} warn · ${by.error} error (of ${results.length})`);

    // An `error` is a MUST violation and a `warn` a SHOULD violation — the endpoint is non-conformant if
    // either is non-zero. A `notice` is informational (e.g. "MAY NOT allow mutations on GET" — mutations
    // are Phase 5) and does not fail the ratchet.
    expect(failures, failures.join('\n')).toEqual([]);
    // The floor: the number of passing audits may only RISE. If graphql-http adds audits (the total grows)
    // this still holds; if a change silently drops one from ok to notice, this catches it.
    expect(by.ok).toBeGreaterThanOrEqual(60);
  });
});

// ---------- Oracle 3: the introspection round-trip ----------
describe('§7·3 introspection round-trip — the schema layer, end to end', () => {
  test('reflected SDL → introspection → buildClientSchema → printSchema is identical', async () => {
    const rows = await reflectRows();
    const local = buildGraphQLSchema(buildSchema(rows));
    // Introspect via graphql-js execute (the same path the live edge serves), rebuild a client schema from
    // the result, and print both. Identity proves the endpoint advertises exactly the schema we reflected —
    // what every client tool (codegen, GraphiQL, buildClientSchema) relies on.
    const intro = await gqlExecute({ schema: local, document: parse(getIntrospectionQuery()) });
    const client = buildClientSchema(intro.data as unknown as IntrospectionQuery);
    expect(printSchema(client)).toBe(printSchema(local));
  });

  test('the live edge answers introspection (root __typename and __schema)', async () => {
    await seeded;
    const post = async (query: string) => {
      const res = await router(new Request('http://x/graphql/g', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
      }));
      return res.json() as any;
    };
    expect((await post('{ __typename }')).data).toEqual({ __typename: 'Query' });
    const schemaIntro = await post('{ __schema { queryType { name } types { name } } }');
    expect(schemaIntro.data.__schema.queryType.name).toBe('Query');
    expect(schemaIntro.data.__schema.types.map((t: any) => t.name)).toContain('person');
  });
});

// ---------- Oracle 2: the graphql-js differential ----------
describe('§7·2 graphql-js differential — reference execution over the same graph', () => {
  // The independent oracle: the reflected schema with a NAIVE resolver set over a plain in-memory model of
  // the same graph. For each document we run BOTH the mogwai path (translate → Gremlin → shape) and
  // graphql-js `execute`, and assert the `{data}` matches. Where they disagree graphql-js is right (§7·2).
  const differential = async (query: string, variables: Record<string, unknown> = {}) => {
    const rows = await reflectRows();
    const gschema = buildSchema(rows);
    const model = await readModel(store, extendedRegistry);

    // The oracle side: graphql-js over the naive resolvers.
    const oracleSchema = buildGraphQLSchema(gschema, oracleResolvers(model, gschema));
    const oracle = await gqlExecute({ schema: oracleSchema, document: parse(query), variableValues: variables });
    expect(oracle.errors, `oracle errored: ${oracle.errors?.map((e) => e.message).join('; ')}`).toBeUndefined();

    // The mogwai side: translate → run → shape under the root key (the edge's own toJson shape).
    const t = translate(query, gschema, variables);
    const raw = await decodeAll(exec(store, extendedRegistry).buffers(t.gremlin, t.params));
    const norm = (v: any): any =>
      v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [String(k), norm(x)])) : Array.isArray(v) ? v.map(norm) : typeof v === 'bigint' ? Number(v) : v;
    const mogwai = { [t.rootKey]: raw.map(norm) };

    return { oracle: oracle.data, mogwai };
  };

  // graphql-js returns fields in SELECTION ORDER and objects are compared structurally by bun's `toEqual`,
  // which is order-insensitive for object keys — so the comparison is on VALUES. Lists ARE compared in
  // order, but a graph root / neighbour list is not order-constrained unless the query sorts it, so every
  // list is canonicalised: sort each level by its element's stable JSON form (works for a vertex row and an
  // edge-wrapper row alike — no reliance on a `name` field being present).
  const canon = (obj: any, rootKey: string) => {
    const sortRec = (rows: any[]): any[] => rows.map((r) =>
      (r && typeof r === 'object' && !Array.isArray(r))
        ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Array.isArray(v) ? sortRec(v) : v]))
        : r
    ).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { [rootKey]: sortRec(obj[rootKey]) };
  };

  const cases: Array<{ name: string; query: string; variables?: Record<string, unknown> }> = [
    { name: 'a flat scalar selection', query: `{ person { name age } }` },
    { name: 'an alias', query: `{ person { who: name } }` },
    { name: 'a depth-2 object field (out edge)', query: `{ person { name created { name } } }` },
    { name: 'a depth-2 in edge', query: `{ software { name created_in { name } } }` },
    { name: 'a depth-3 both directions', query: `{ person { name created { name created_in { name } } } }` },
    { name: 'a where filter (gt)', query: `{ person(where: { age: { gt: 30 } }) { name } }` },
    { name: 'a where in-list', query: `{ person(where: { name: { in: ["marko", "josh"] } }) { name } }` },
    { name: 'a where contains', query: `{ person(where: { name: { contains: "a" } }) { name } }` },
    { name: 'sort + limit', query: `{ person(sort: [{ age: DESC }], limit: 2) { name age } }` },
    { name: 'sort + offset + limit', query: `{ person(sort: [{ name: ASC }], offset: 1, limit: 2) { name } }` },
    { name: 'where on a nested edge', query: `{ person(where:{name:{eq:"marko"}}) { name created(where:{lang:{eq:"java"}}) { name } } }` },
    { name: 'a variable bind (gt)', query: `query($m: Int) { person(where: { age: { gt: $m } }) { name } }`, variables: { m: 30 } },
    { name: 'a list variable', query: `query($ns: [String]) { person(where: { name: { in: $ns } }) { name } }`, variables: { ns: ['marko', 'josh'] } },
    { name: 'an edge companion (weight + node)', query: `{ person { name created_edges { weight node { name } } } }` },
    { name: 'an edge-companion where on edge props', query: `{ person { name created_edges(where: { weight: { gt: 0.3 } }) { weight node { name } } } }` },
    // FRAGMENTS against the reference implementation — the strongest check available for them, because
    // graphql-js executes a fragment natively (its own `CollectFields`) while we INLINE it at translation.
    // If the inlining and the spec's collection disagree in field set, order or alias handling, the {data}
    // objects differ and this fails.
    { name: 'an inline fragment on the same type', query: `{ person { name ... on person { age } } }` },
    { name: 'a named fragment spread', query: `{ person { ...P } } fragment P on person { name age }` },
    { name: 'a fragment nested in a fragment', query: `{ person { ...P } } fragment P on person { name ...Q } fragment Q on person { age }` },
    { name: 'a fragment on a nested object field', query: `{ person { name created { ...S } } } fragment S on software { name lang }` },
    { name: 'a fragment carrying an alias', query: `{ person { ...P } } fragment P on person { who: name }` },
    { name: '@skip on a fragment spread', query: `{ person { name ...P @skip(if: true) } } fragment P on person { age }` },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const { oracle, mogwai } = await differential(c.query, c.variables);
      const rootKey = Object.keys(mogwai)[0]!;
      // A root selection's order is not constrained unless the query sorts it; canonicalise both for those
      // cases. A case that sorts the ROOT DOES constrain order, so compare it as-is.
      if (c.query.includes('sort:')) expect(mogwai).toEqual(oracle as any);
      else expect(canon(mogwai, rootKey)).toEqual(canon(oracle as any, rootKey));
    });
  }
});
