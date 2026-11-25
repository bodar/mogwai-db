// A LIST NESTED IN A MAP OR RECORD VALUE KEEPS ITS STATIC MEMBER TYPE.
//
// `project().by(…fold())`, `select(a,b).by(…fold())` and a `group()` value put a list inside a map, and the
// tree framer (`frameTypedNode`, `untyped`) reads its members. A bare member infers its type from its storage
// class, so a Boolean read back as `1` and a `count()` as an Int. The list node now states its static member
// type once (`m`, `listNodeExpr` → `staticMemberTag`), and both walkers apply it through `listMembers`
// (`src/gremlin/types.ts`), the rule the root list framer (`listMemberNodes`) already used. `ProjectStep` puts
// the `by()` value into the map as is (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/
// gremlin/process/traversal/step/map/ProjectStep.java`), and `CountGlobalStep` yields a Long, so `[3L]` and
// `[true]` are the answers.
import { describe, expect, test } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { exec } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';
import { bagOf, seededStore } from '../support/harness.ts';

const store = seededStore();
const typed = (q: string): string[] => bagOf(typedAll(exec(store).buffers(q, {})));

describe('a nested list frames its members by their static type (GraphBinary)', () => {
  const cases: [string, string[]][] = [
    ["g.inject(true).project('b').by(fold())", ['{"b":[true]}']],
    ["g.inject(1L).project('b').by(fold())", ['{"b":[1L]}']],
    ["g.inject(1.0d).project('b').by(fold())", ['{"b":[1d]}']],
    ["g.V().hasLabel('person').project('c').by(out().count().fold())", ['{"c":[0L]}', '{"c":[1L]}', '{"c":[2L]}', '{"c":[3L]}']],
    ["g.V().hasLabel('person').as('a').out('created').as('b').select('a','b').by(out().count().fold())",
      ['{"a":[1L],"b":[0L]}', '{"a":[2L],"b":[0L]}', '{"a":[2L],"b":[0L]}', '{"a":[3L],"b":[0L]}']],
    ["g.inject(true).map(project('b').by(fold()))", ['{"b":[true]}']],
    ["g.inject(true).project('b').by(fold().fold())", ['{"b":[[true]]}']],
    // At depth: a by() of a by(), a local body, a union arm, a list of records.
    ["g.V().hasLabel('person').has('name','marko').project('a').by(project('b').by(out().count().fold()))", ['{"a":{"b":[3L]}}']],
    ["g.V().hasLabel('person').has('name','marko').local(project('c').by(out().count().fold()))", ['{"c":[3L]}']],
    ["g.V().has('name','marko').union(project('c').by(out().count().fold()), project('d').by(constant(true).fold()))", ['{"c":[3L]}', '{"d":[true]}']],
    ["g.V().has('name','marko').project('c').by(out().count().fold()).fold()", ['[{"c":[3L]}]']],
    // The group value: the same list-level tag, not a per-member rebuild.
    ["g.V().group().by(label).by(out().count().fold())", ['{"person":[6L],"software":[0L]}']],
    ["g.V().hasLabel('software').group().by(label).by(constant(true).fold())", ['{"software":[true,true]}']],
    // The payload readers of the record field read the members, not the node.
    ["g.inject(true).project('b').by(fold()).select('b').unfold()", ['true']],
    ["g.inject(true).project('b').by(fold()).select('b').count(local)", ['1L']],
    ["g.V().has('name','marko').project('c').by(out().count().fold()).select('c').unfold()", ['3L']],
    ["g.V().group().by(label).by(out().count().fold()).select(values).unfold().unfold()", ['0L', '6L']],
  ];
  for (const [q, want] of cases) test(q, () => expect(typed(q)).toEqual(bagOf(want)));

  test('a datetime member frames as a Date', async () => {
    const [m] = await decodeAll(exec(store).buffers("g.inject(datetime('2020-01-01T00:00:00Z')).project('b').by(fold())", {}));
    const b = (m as Map<string, unknown[]>).get('b')!;
    expect(b[0]).toBeInstanceOf(Date);
    expect((b[0] as Date).toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });
});

describe('the untyped JSON response reads the same member type', () => {
  for (const [q, want] of [
    ["g.inject(true).project('b').by(fold())", [{ b: [true] }]],
    ["g.inject(true).project('b').by(fold().fold())", [{ b: [[true]] }]],
    ["g.V().has('name','marko').project('c').by(out().count().fold())", [{ c: [3] }]],
  ] as const) test(q, async () => expect(JSON.parse((await exec(store).jsonAsync!(q, {}))!)).toEqual(want));
});

describe('a list whose storage class implies its member type is unchanged', () => {
  test('a string list node carries no member tag', () => {
    const p = compile("g.V().project('n').by(values('name').fold())", {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.sql).not.toContain("'m'");
  });
  test('a long list node carries its tag once', () => {
    const p = compile("g.V().project('c').by(out().count().fold())", {});
    if (p.kind !== 'read') throw new Error('expected a read plan');
    expect(p.sql.match(/'m', 'long'/g)?.length).toBe(1);
  });
});
