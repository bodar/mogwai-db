// A branch whose arms REDUCE (`fold`/`count`/…) drops the input's carried channels in every arm, so the
// arms agree with EACH OTHER and not with the branch's input. The variant merge (arms of different shapes)
// compared them against the input and threw the channel core's bare `Error('branch arms disagree on
// carried channels …')` at the user. The rule now lives at ONE door, `mergePeerArms` (`src/channels.ts`),
// which both `mergeArms` and `variantMerge` go through: arm-to-arm, and `null` (a decline) — never a throw —
// where they genuinely disagree. The sweep pins the fail-closed half at every depth: each shape either
// ANSWERS or raises `UnsupportedTraversal`, and never an internal error. The exact answers live in
// `test/L4-addendum/branch-arm-reduction-channels.feature`.
import { test, expect, describe } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { mergePeerArms, type Channels } from '../../src/channels.ts';
import { seededStore, run } from '../support/harness.ts';

describe('mergePeerArms — the arm-to-arm channel merge a lowering asks', () => {
  const bulk: Channels = [{ col: 'bulk', role: 'bulk' }];
  const origin: Channels = [{ col: 'origin', role: 'origin' }];
  test('arms that all dropped every channel merge to none', () => expect(mergePeerArms([[], []])).toEqual([]));
  test('arms that agree merge to their common list', () => expect(mergePeerArms([origin, origin])).toEqual(origin));
  test('a PARTIAL rigid channel declines rather than throwing', () => expect(mergePeerArms([bulk, []])).toBeNull());
  test('no arms declines', () => expect(mergePeerArms([])).toBeNull());
});

describe('reducing branch arms answer or decline — never an internal error — at every depth', () => {
  const s = seededStore();
  const arms = "hasLabel('person'), values('name').fold(), id().fold()";
  const shapes = [
    `g.V().choose(${arms})`,
    `g.V().hasLabel('person').choose(${arms})`,
    "g.V().choose(hasLabel('person'), values('age').fold(), id().fold())",
    "g.V().hasLabel('person').out().choose(hasLabel('software'), values('name').fold(), id().fold())",
    `g.V().local(choose(${arms}))`,
    `g.V().flatMap(choose(${arms}))`,
    `g.V().map(choose(${arms}))`,
    `g.V().local(choose(${arms}).unfold())`,
    `g.V().local(choose(${arms}).fold())`,
    `g.V().project('x').by(choose(${arms}))`,
    `g.V().project('x').by(choose(${arms}).fold())`,
    `g.V().group().by(label).by(choose(${arms}))`,
    `g.V().where(choose(${arms}).unfold())`,
    `g.V().coalesce(choose(${arms}), constant('z'))`,
    `g.V().optional(choose(${arms}))`,
    `g.V().union(choose(${arms}), constant('z'))`,
    `g.V().repeat(choose(${arms})).times(1)`,
    `g.V().as('a').choose(${arms}).select('a')`,
    `g.V().choose(${arms}).count()`,
    `g.V().choose(${arms}).unfold()`,
    `g.V().choose(${arms}).limit(1)`,
    "g.V().local(out().choose(hasLabel('software'), values('name').fold(), id().fold()))",
    "g.V().map(out().choose(hasLabel('software'), values('name').fold(), id().fold()))",
    "g.V().flatMap(out().choose(hasLabel('software'), values('name').fold(), id().fold()))",
    "g.V().local(out().choose(label()).option('software', values('name').fold()).option(none, id().fold()))",
    "g.V().choose(label()).option('person', values('name').fold()).option(none, id().fold())",
    "g.V().local(choose(label()).option('person', values('name').fold()).option(none, id().fold()))",
    "g.V().choose(label()).option('person', values('name').fold()).option('software', id().fold())",
    "g.V().choose(hasLabel('person'), values('name').fold(), id().fold().unfold())",
    "g.V().choose(hasLabel('person'), values('name').count(), id().fold())",
    "g.V().choose(hasLabel('person'), groupCount().by('name'), id().fold())",
    "g.V().union(values('name').fold(), id().fold())",
    "g.V().union(values('name').fold(), id().count())",
    "g.V().local(union(values('name').fold(), id().fold()))",
    "g.V().coalesce(values('age').fold(), id().fold())",
    "g.V().union(values('age').fold().as('x'), id().fold()).select('x')",
    "g.V().choose(hasLabel('person'), values('age').fold().as('x'), id().fold().as('x')).select('x')",
    "g.V().sack(assign).by(constant(1)).choose(hasLabel('person'), values('name').fold(), id().fold())",
  ];
  for (const g of shapes) {
    test(g, () => {
      try { run(s, g); }
      catch (error) { expect(error).toBeInstanceOf(UnsupportedTraversal); }
    });
  }
});
