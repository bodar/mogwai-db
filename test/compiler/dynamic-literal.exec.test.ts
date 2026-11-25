// A DYNAMIC LITERAL — a no-argument `UUID()` or `datetime()` — is drawn when the request runs, not
// written in the text (`GenericLiteralVisitor.visitUuidLiteral`/`visitDateLiteral`,
// vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/language/grammar/GenericLiteralVisitor.java).
// It is drawn ONCE per request: a nested body is extracted again from the shared parse tree at every
// site that reads it, and each extraction must read the same value (`ParamEnv.dynamicLiterals`).
// The plan-cache half (never served from the cache) is in plan-cache.exec.test.ts.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { seededStore, run } from '../support/harness.ts';
import { executeFramed, executeQuery } from '../support/executor.ts';
import { decode } from '../support/decode.ts';

const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
/** GraphBinary's type code for a UUID. */
const UUID_TYPE_CODE = 0x0c;

const answer = (q: string) => Promise.all(executeQuery(seededStore(), q).map((b) => decode(b)));
/** Every uuid the compiled plan holds, as written. */
const uuidsIn = (q: string): string[] => JSON.stringify(compile(q, {})).match(UUID_V4) ?? [];

describe('UUID() is a random v4 uuid', () => {
  test('g.inject(UUID()) gives one uuid-typed value', async () => {
    const frames = executeFramed(seededStore(), 'g.inject(UUID())');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.buf[0]).toBe(UUID_TYPE_CODE);
    const [u] = await answer('g.inject(UUID())');
    expect(String(u)).toMatch(new RegExp(`^${UUID_V4.source}$`));
  });

  test('g.inject(UUID()).count() is 1', async () => {
    expect(await answer('g.inject(UUID()).count()')).toEqual([1]);
  });

  test('two UUID() literals are two values', async () => {
    const [a, b] = await answer('g.inject(UUID(), UUID())');
    expect(a).not.toEqual(b);
  });

  test('a written UUID() is stored as a uuid', () => {
    const store = seededStore();
    const [written] = run(store, "g.addV('p').property('k', UUID()).values('k')");
    expect(written.vtype).toBe('uuid');
    const read = executeFramed(store, "g.V().hasLabel('p').values('k')");
    expect(read).toHaveLength(1);
    expect(read[0]!.buf[0]).toBe(UUID_TYPE_CODE);
  });

  test('a selected UUID() is the value the inject produced', async () => {
    const q = "g.inject(UUID()).as('u').where(select('u').is(neq(null))).select('u')";
    expect(await answer(q)).toHaveLength(1);
    expect(new Set(uuidsIn(q)).size).toBe(1);
  });
});

describe('one value per request, across re-extraction', () => {
  // `emit(…)` is read twice from the parse tree (the emit test before the first iteration and inside
  // the loop), so without the per-request memo its one UUID() becomes two different values (measured).
  // The other shapes spell one value at several sites today; they hold that as the lowering changes.
  test.each([
    "g.V().emit(has('name',neq(UUID()))).repeat(out()).times(2)",
    "g.V().coalesce(out().has('name', UUID()), constant(1))",
    "g.V().repeat(out().has('name', neq(UUID()))).times(2)",
    "g.inject(1).mergeV([name: UUID()])",
  ])('%s holds one uuid', (q) => {
    const all = uuidsIn(q);
    expect(all.length).toBeGreaterThan(0);
    expect(new Set(all).size).toBe(1);
  });

  test('two compiles of one text draw two values', () => {
    const q = "g.V().emit(has('name',neq(UUID()))).repeat(out()).times(2)";
    expect(uuidsIn(q)[0]).not.toBe(uuidsIn(q)[0]);
  });
});
