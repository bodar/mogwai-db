// `project().by()` over a PROPERTY traverser — the connector's record (`recordLeft`, `src/compiler/rel/lower/scoped.ts`)
// over the ONE host builder (`reductionHost`, `src/compiler/rel/lower/reduction.ts`), which now answers the property
// framing. `propertyTail`'s own `project` record is deleted, so the connector ALONE answers what it used to, and a
// child `by()` over the property (`by(__.values('startTime').count())`) composes as it does over any host.
//
// `ProjectStep` reads each `by()` of the VertexProperty traverser
// (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:64-67`);
// a key `by('startTime')` reads the meta-property, `by(T.value)`/`by(T.key)` the property's own value and key. CREW
// (`test/fixtures/seed-crew.ts`) is the fixture with multi-valued `location` and `startTime` meta-properties.
import { describe, expect, test } from 'bun:test';
import { CREW_SEED } from '../fixtures/seed-crew.ts';
import { bagOf, bare, runWith, storeSeededWith } from '../support/harness.ts';

// One lowering since the ladder was deleted; the loop keeps the mode label in a failure.
const MODES = [['default', undefined]] as const;
const crew = storeSeededWith(CREW_SEED);

/** A record row as `key=value,…`, in field order. */
const fields = (row: Record<string, unknown>): string =>
  (JSON.parse(row.map as string) as [{ v: unknown }, { v: unknown }][]).map(([k, v]) => `${k.v}=${v.v}`).join(',');

const LOCATIONS = [
  ['aachen', 2009], ['baltimore', 2007], ['bremen', 2004], ['brussels', 2004], ['centreville', 1990], ['dulles', 2000],
  ['kaiserslautern', 2005], ['oakland', 2011], ['purcellville', 2006], ['san diego', 1997], ['santa cruz', 2001],
  ['santa fe', 2005], ['seattle', 2014], ['spremberg', 1982],
] as const;

const ANSWERS: readonly (readonly [string, readonly string[]])[] = [
  [`g.V().properties('location').project('v','s').by(T.value).by('startTime')`, LOCATIONS.map(([v, s]) => `v=${v},s=${s}`)],
  [`g.V().properties('location').project('k').by(T.key)`, LOCATIONS.map(() => 'k=location')],
  // Each person's alphabetically first location, then its record: the property host under a per-traverser body.
  [`g.V().hasLabel('person').map(__.properties('location').order().by(T.value)).project('v','s').by(T.value).by('startTime')`,
    ['v=aachen,s=2009', 'v=baltimore,s=2007', 'v=brussels,s=2004', 'v=centreville,s=1990']],
  // A CHILD by() over the property host — the slot the deleted `propertyTail` record could not lower.
  [`g.V().properties('location').project('v','n').by(T.value).by(__.values('startTime').count())`, LOCATIONS.map(([v]) => `v=${v},n=1`)],
  // A SHAPE-KEEPING step BEFORE `project()` — a meta-property `has`, an order + slice. `propertyTail` hands each on
  // through `continueAs`, so the `project` after it still reaches the connector (a direct recursion skipped it).
  [`g.V().properties('location').has('startTime',P.gt(2008)).project('v','s').by(T.value).by('startTime')`,
    ['v=aachen,s=2009', 'v=oakland,s=2011', 'v=seattle,s=2014']],
  [`g.V().properties('location').order().by(T.value).limit(3).project('v','s').by(T.value).by('startTime')`,
    ['v=aachen,s=2009', 'v=baltimore,s=2007', 'v=bremen,s=2004']],
  [`g.V().properties().hasKey('location').hasValue('seattle').project('k','v').by(T.key).by(T.value)`, ['k=location,v=seattle']],
  [`g.V().properties('location').hasNot('endTime').dedup().project('v').by(T.value)`, ['v=aachen', 'v=purcellville', 'v=santa fe', 'v=seattle']],
  [`g.V().local(__.properties('location').has('startTime',P.gt(2008)).project('v').by(T.value))`, ['v=aachen', 'v=oakland', 'v=seattle']],
  // The owner through `element()`, after a meta-property filter.
  [`g.V().properties('location').where(__.has('startTime',P.gt(2008))).project('v','e').by(T.value).by(__.element().values('name'))`,
    ['v=aachen,e=daniel', 'v=oakland,e=matthias', 'v=seattle,e=matthias']],
];

describe('project().by() over a property host — the connector answers alone', () => {
  for (const [q, expected] of ANSWERS) test(q, () => {
    for (const [mode, options] of MODES)
      expect(bagOf((bare(runWith(crew, q, options)) as Record<string, unknown>[]).map(fields)), mode).toEqual(bagOf([...expected]));
  });

  // The property group barrier reads the same consolidated host: unchanged.
  const GROUP = `g.V().properties('location').group().by(T.value)`;
  test(GROUP, () => {
    for (const [mode, options] of MODES) {
      const [row] = bare(runWith(crew, GROUP, options)) as Record<string, unknown>[];
      const entries = (JSON.parse(row!.map as string) as [{ v: string }, { v: { v: { pv: string; pmeta: { startTime: number } } }[] }][])
        .map(([k, members]) => `${k.v}:${members.v.map((m) => `${m.v.pv}@${m.v.pmeta.startTime}`).join('|')}`);
      expect(bagOf(entries), mode).toEqual(bagOf(LOCATIONS.map(([v, s]) => `${v}:${v}@${s}`)));
    }
  });
});
