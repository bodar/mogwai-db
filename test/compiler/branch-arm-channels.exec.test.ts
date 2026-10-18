// Branch arms of DIFFERENT shapes merge as a VARIANT — a per-row tagged union whose wire vocabulary has ONE
// declared arm per tag (`vk`: scalar / vertex / edge / list). Two defects lived at that one door:
//
// - CHANNELS. A branch whose arms REDUCE (`fold`/`count`/…) drops the input's carried channels in every
//   arm, so the arms agree with EACH OTHER and not with the branch's input. The variant merge compared them
//   against the input and threw the channel core's bare `Error('branch arms disagree on carried channels …')`
//   at the user. The rule lives at ONE door, `mergePeerArms` (`src/channels.ts`): arm-to-arm, and `null`
//   (a decline) — never a throw — where they genuinely disagree.
// - THE DECLARED VOCABULARY. Several arms of one tag were collapsed to the FIRST arm's description, so
//   `choose(p, out().fold(), id().fold())` framed ids as vertices, `union(values('name').fold(),
//   out().fold())` framed vertices as bare ids, `choose(p, out().fold(), values('name').fold())` threw the
//   framer's TypeError, and `union(out(), values('age'), count())` framed the `count()` Long as an Int.
//   `variantVocabulary` (`src/compiler/rel/variant.ts`) is now the one authority: scalar arms MEET (a
//   per-row tag where they disagree), list arms must AGREE on their members or the merge DECLINES.
//
// Everything here goes through the WIRE (`executeQuery` → GraphBinary → the client's decoder), because both
// defects were invisible to raw rows: the mislabel and the TypeError are framing failures.
import { test, expect, describe } from 'bun:test';
import { UnsupportedTraversal } from '../../src/compiler/compiler.ts';
import { mergePeerArms, type Channels } from '../../src/channels.ts';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll, typedAll } from '../support/decode.ts';

describe('mergePeerArms — the arm-to-arm channel merge a lowering asks', () => {
  const bulk: Channels = [{ col: 'bulk', role: 'bulk' }];
  const origin: Channels = [{ col: 'origin', role: 'origin' }];
  test('arms that all dropped every channel merge to none', () => expect(mergePeerArms([[], []])).toEqual([]));
  test('arms that agree merge to their common list', () => expect(mergePeerArms([origin, origin])).toEqual(origin));
  test('a PARTIAL rigid channel declines rather than throwing', () => expect(mergePeerArms([bulk, []])).toBeNull());
  test('no arms declines', () => expect(mergePeerArms([])).toBeNull());
});

const s = seededStore();

/** Answer through the wire and decode, or `null` where the compiler declined. Anything else — a bare
 *  Error, a framer TypeError, a decoder failure — propagates and fails the test. */
const wire = async (g: string): Promise<unknown[] | null> => {
  let bufs: Buffer[];
  try { bufs = executeQuery(s, g); }
  catch (error) {
    if (error instanceof UnsupportedTraversal) return null;
    throw error;
  }
  return decodeAll(bufs);
};

/** Per-row rendering with number classes (`1i`/`1L`/`1d`); an element row as `v[id]`/`e[id]`, and a list
 *  of elements (which `typedAll` does not render) as `[v[id],…]`. */
const typed = async (g: string): Promise<string[]> => {
  const element = (value: any): string => (value?.constructor?.name === 'Edge' ? `e[${value.id}]` : `v[${value.id}]`);
  const out: string[] = [];
  for (const buf of executeQuery(s, g)) {
    let row: string | undefined;
    try { row = typedAll([buf])[0]; } catch { row = undefined; }
    if (row !== undefined && !row.includes('<0x')) { out.push(row); continue; }
    const [value] = await decodeAll([buf]) as any[];
    out.push(Array.isArray(value) ? `[${value.map(element).join(',')}]` : element(value));
  }
  return out;
};

describe('reducing and mixed-shape branch arms answer through the wire or decline — never an internal error — at every depth', () => {
  // Element-membered folds paired with scalar-membered folds and with plain streams: the pairs the variant
  // merge's declared vocabulary must either describe truthfully or refuse.
  const elementFolds = ['out().fold()', 'dedup().fold()', 'outE().fold()'];
  const scalarFolds = ['id().fold()', "values('name').fold()", 'constant(1).fold()', 'count().fold()'];
  const streams = ['out()', "values('age')", 'count()', 'constant(1L)'];
  const pairs = [
    ...elementFolds.flatMap((a) => scalarFolds.flatMap((b) => [[a, b], [b, a]])),
    ...elementFolds.flatMap((a) => streams.map((b) => [a, b])),
    ["values('name').fold()", 'id().fold()'],
    ["values('name').fold()", "values('lang').fold()"],
  ];
  const hosts = [
    (a: string, b: string) => `g.V().choose(hasLabel('person'), ${a}, ${b})`,
    (a: string, b: string) => `g.V().hasLabel('person').choose(hasLabel('person'), ${a}, ${b})`,
    (a: string, b: string) => `g.V().choose(label()).option('person', ${a}).option(none, ${b})`,
    (a: string, b: string) => `g.V().union(${a}, ${b})`,
    (a: string, b: string) => `g.V().union(hasLabel('person').${a}, hasLabel('software').${b})`,
    (a: string, b: string) => `g.V().coalesce(${a}, ${b})`,
    (a: string, b: string) => `g.V().local(choose(hasLabel('person'), ${a}, ${b}))`,
    (a: string, b: string) => `g.V().local(union(${a}, ${b}))`,
    (a: string, b: string) => `g.V().local(choose(label()).option('person', ${a}).option(none, ${b}))`,
    (a: string, b: string) => `g.V().flatMap(choose(hasLabel('person'), ${a}, ${b}))`,
    (a: string, b: string) => `g.V().map(choose(hasLabel('person'), ${a}, ${b}))`,
    (a: string, b: string) => `g.V().optional(choose(hasLabel('person'), ${a}, ${b}))`,
    (a: string, b: string) => `g.V().project('x').by(choose(hasLabel('person'), ${a}, ${b}))`,
    (a: string, b: string) => `g.V().project('x').by(union(${a}, ${b}).fold())`,
    (a: string, b: string) => `g.V().as('s').choose(hasLabel('person'), ${a}, ${b}).as('r').select('s', 'r')`,
    (a: string, b: string) => `g.V().choose(hasLabel('person'), ${a}, ${b}).unfold()`,
    (a: string, b: string) => `g.V().choose(hasLabel('person'), ${a}, ${b}).dedup()`,
    (a: string, b: string) => `g.V().union(${a}, ${b}).limit(3)`,
    (a: string, b: string) => `g.V().repeat(choose(hasLabel('person'), ${a}, ${b})).times(1)`,
    (a: string, b: string) => `g.V().sack(assign).by(constant(1)).choose(hasLabel('person'), ${a}, ${b})`,
  ];
  for (const [a, b] of pairs) {
    for (const host of hosts) {
      const g = host(a!, b!);
      test(g, async () => { await wire(g); });
    }
  }
});

describe('a variant whose list arms disagree on their MEMBERS declines — one declared list arm cannot frame both', () => {
  // Each of these answered a DIFFERENT question (an id list framed as vertices, vertices as bare ids) or
  // threw the framer's TypeError. Lists of different members have no shared descriptor
  // (`variantVocabulary`), so the reference answer is withheld rather than mis-framed.
  const declines = [
    "g.V().choose(hasLabel('person'), out().fold(), id().fold())",
    "g.V().choose(hasLabel('person'), dedup().fold(), id().fold())",
    "g.V().local(choose(hasLabel('person'), out().fold(), id().fold()))",
    "g.V().local(choose(hasLabel('person'), out().fold(), constant(1).fold()))",
    "g.V().choose(hasLabel('person'), out().fold(), values('name').fold())",
    "g.V().choose(label()).option('person', values('name').fold()).option(none, out().fold())",
    "g.V().local(choose(label()).option('person', values('name').fold()).option(none, out().fold()))",
    "g.V().flatMap(choose(hasLabel('person'), outE().fold(), id().fold()))",
    "g.V().union(hasLabel('person').out().fold(), hasLabel('software').values('name').fold())",
    "g.V().union(hasLabel('person').dedup().fold(), hasLabel('software').id().fold())",
    "g.V().union(values('name').fold(), out().fold())",
    "g.V().local(union(values('name').fold(), out().fold()))",
    "g.V().union(out().fold(), outE().fold())",
    "g.V().union(values('name').fold(), valueMap().fold())",
    "g.E().union(values('weight').fold(), inV().fold())",
    "g.E().union(id().fold(), values('weight').fold())",
    "g.V().union(values('age').fold(), constant(1L).fold())",
    "g.V().union(count().fold(), values('name').fold())",
    "g.V().choose(hasLabel('person'), values('name').fold(), id().fold())",
  ];
  for (const g of declines) test(g, () => expect(() => executeQuery(s, g)).toThrow(UnsupportedTraversal));
});

describe('a variant frames every scalar arm by ITS OWN type — the arms\' meet, never the first arm\'s tag', () => {
  // `meetScalarTypes`: one static tag where the scalar arms agree, else a per-row tag each arm fills. The
  // storage class alone cannot say a `count()` is a Long or a stored `1.0` a Double.
  const bag = (rows: string[]) => [...rows].sort();
  test("union(out(), values('age'), count()) — the count is a Long", async () =>
    expect(bag(await typed("g.V().union(out(), values('age'), count())"))).toEqual(
      bag(['v[2]', 'v[3]', 'v[3]', 'v[3]', 'v[4]', 'v[5]', '27i', '29i', '32i', '35i', '6L'])));
  test("union(out(), constant(1L), constant(2)) — each constant keeps its class", async () => {
    const rows = await typed("g.V().union(out(), constant(1L), constant(2))");
    expect(rows.filter((row) => row === '1L')).toHaveLength(6);
    expect(rows.filter((row) => row === '2i')).toHaveLength(6);
  });
  test("E().union(inV(), values('weight')) — a stored 1.0 is a Double", async () =>
    expect(bag((await typed("g.E().union(inV(), values('weight'))")).filter((row) => !row.startsWith('v[')))).toEqual(
      bag(['0.5d', '1d', '0.4d', '1d', '0.4d', '0.2d'])));
  test("E().choose(has('weight', 1.0d), values('weight')) — the implicit identity arm and a per-row Double", async () =>
    expect(bag(await typed("g.E().choose(has('weight', 1.0d), values('weight'))"))).toEqual(
      bag(['1d', '1d', 'e[7]', 'e[9]', 'e[11]', 'e[12]'])));
  test("union(out(), count(), values('name')) — Long and String side by side", async () => {
    const rows = await typed("g.V().union(out(), count(), values('name'))");
    expect(rows).toContain('6L');
    expect(rows).toContain('"marko"');
  });
  test("union(out(), constant(1L), constant(1)).dedup() — a Long 1 and an Int 1 are one value (value plus family)", async () =>
    expect((await typed("g.V().union(out(), constant(1L), constant(1)).dedup()")).filter((row) => !row.startsWith('v['))).toHaveLength(1));
  test("union(out().fold(), values('age'), count()) — a list arm beside a met scalar arm", async () => {
    const rows = await typed("g.V().union(out().fold(), values('age'), count())");
    expect(rows).toContain('6L');
    expect(rows).toContain('29i');
  });
});

describe('variant arms that AGREE still answer exactly', () => {
  test("union(out().fold(), out().fold()) — two element lists of one kind", async () => {
    const rows = await wire("g.V().union(out().fold(), out().fold())") as any[][];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.map((v) => v.id)).toEqual([2, 3, 4, 3, 5, 3]);
  });
  test("choose(hasLabel('person'), constant(1).fold(), id().fold()) — bare Int-or-inferred member lists meet to inference", async () =>
    expect([...await typed("g.V().choose(hasLabel('person'), constant(1).fold(), id().fold())")].sort()).toEqual(['[1i,1i,1i,1i]', '[3i,5i]']));
  test("local(choose(hasLabel('person'), constant(1).fold(), id().fold())) — per start", async () =>
    expect([...await typed("g.V().local(choose(hasLabel('person'), constant(1).fold(), id().fold()))")].sort()).toEqual(['[1i]', '[1i]', '[1i]', '[1i]', '[3i]', '[5i]']));
  test("choose(hasLabel('person'), values('age')) — a per-row scalar arm beside the implicit identity", async () =>
    expect([...await typed("g.V().choose(hasLabel('person'), values('age'))")].sort()).toEqual(['27i', '29i', '32i', '35i', 'v[3]', 'v[5]']));
});
