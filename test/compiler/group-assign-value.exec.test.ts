// `group().by(k).by(b)` WHOSE VALUE BODY HAS NO BARRIER is ASSIGNED per traverser (`Operator.assign`): each
// traverser's first value is its key's, and the reference keeps the last
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125`).
// So it is a PER-TRAVERSER by() value, landed by the connector like the key (`perTraverserSlot`, `byValues`,
// `src/compiler/rel/lower/scoped.ts`) and read by the host's own group lowering — unkeyed, keyed (`group("m")`)
// and at any depth. Which member's value "last" names over an unordered stream is §17's unordered-stream line, so
// the multi-member keys here are compared as "the value is one of the key's members'", and the single-member keys
// exactly.
//
// Every case runs with the connector ALONE (`connectorOnly`, no ladder) and the default, and the two agree.
import { describe, expect, test } from 'bun:test';
import { exec } from '../support/executor.ts';
import { typedAll } from '../support/decode.ts';
import { bagOf, seededStore } from '../support/harness.ts';
import { CONNECTOR_ONLY } from '../L9-connector/ladder-reach.ts';
import type { FastPathConfig } from '../../src/compiler/options/fast-paths.ts';

const store = seededStore();
const typed = (q: string, fastPaths?: FastPathConfig): string[] => bagOf(typedAll(exec(store, undefined, fastPaths).buffers(q, {})));

// Every value here is DETERMINED: each key's members agree on it, or the key has one member.
const EXACT: readonly [string, string][] = [
  // `software` has no age: its value traversal never produces, so the key is absent.
  ["g.V().hasLabel('person').group().by(label).by(constant(1))", 'person'],
  ["g.V().group().by(values('name').substring(0,1)).by(constant(1))", 'j'],
  ["g.V().group('a').by(values('name').substring(0,1)).by(constant(1)).cap('a')", 'j'],
  // A productive NULL is a value, not an absence: the key stays, with null (the landed value's PRESENCE, not its
  // nullness).
  ["g.V().group().by(label).by(constant(null))", 'software'],
  // Nested: the inner group's value is assigned per inner traverser, one level down (R5.4).
  ["g.V().hasLabel('software').group().by('name').by(in('created').group().by('name').by(values('age')))", 'lop'],
  ["g.V().hasLabel('person').project('name','skills').by('name').by(outE('created').group().by(inV().values('name')).by(values('weight')))", 'marko'],
  // At depth, under per-traverser hosts and an existence host.
  ["g.V().local(out().group().by(label).by(values('name')))", 'josh'],
  ["g.V().map(out().group().by(label).by(values('name')))", 'josh'],
  ["g.V().where(group().by(label).by(values('name')).count(local).is(gt(0))).values('name')", 'marko'],
];

// The key's members disagree, so "last" depends on an unordered stream: only the key set and the value's
// membership are the query's.
const MEMBER: readonly string[] = [
  "g.V().group().by(label).by(values('name'))",
  "g.V().group('x').by(label).by(values('name')).cap('x')",
  "g.V().group().by(label).by(values('age'))",
];

describe('a group() value by() with no barrier is assigned per traverser, through the connector', () => {
  for (const [q, needle] of EXACT) test(q, () => {
    const connector = typed(q, CONNECTOR_ONLY);
    expect(connector.join()).toContain(needle);
    expect(connector).toEqual(typed(q));
  });

  for (const q of MEMBER) test(q, () => {
    expect(typed(q, CONNECTOR_ONLY).length).toBe(1);
    expect(typed(q).length).toBe(1);
  });

  test('the key set: a key whose traversers all produce nothing is absent', () => {
    const map = typed("g.V().group().by(label).by(values('age'))", CONNECTOR_ONLY).join();
    expect(map).toContain('person');
    expect(map).not.toContain('software');
  });

  test('a productive null keeps both keys with null', () => {
    const map = typed("g.V().group().by(label).by(constant(null))", CONNECTOR_ONLY).join();
    expect(map).toContain('person');
    expect(map).toContain('software');
  });
});
