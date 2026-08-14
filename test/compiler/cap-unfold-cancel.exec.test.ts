// Phase 2b — `cap("a").unfold()` CANCELS the fold. `cap` folds the members to a JSONB array and
// `unfold` immediately explodes it back, so the fold is the identity on the member rows. `readUnfolded`
// (collection.ts) hands the member relation straight to the stream, and `capUnfolded` (lower.ts) mints
// the encounter from the site order — so the answer AND its order are exactly what fold+unfold produced,
// minus the JSON round trip. The optimization is proven two ways: the plan no longer folds (no
// json_group_array), and the answers are unchanged (census + the behavioural checks here).
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { emit } from '../../src/rel/emit.ts';
import { seededStore } from '../support/harness.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

/** Every SQL statement a compiled traversal emits, as one string — a plain read is its own `sql`; a
 *  program with side effects is its binding statements plus the result read, which is where a cap's
 *  fold would live. */
const programSql = (g: string): string => {
  const p = compile(g, {}) as any;
  if (p.kind === 'read') return p.sql as string;
  if (p.kind === 'program') return [...emit(p.program).map((s: any) => s.emitted.sql), p.tail?.sql ?? ''].join('\n');
  throw new Error(`unexpected plan kind ${p.kind}`);
};
const names = async (g: string): Promise<any[]> =>
  (await decodeAll(executeQuery(seededStore(), g, {}))) as any[];

describe('cap().unfold() fold-cancel (Phase 2b)', () => {
  test('cap("a").unfold() reads members DIRECTLY — no fold-then-explode', () => {
    // `json_each` is the list EXPLODE — present only when a fold built a list to explode back. The
    // cancel reads the member relation directly, so it is absent (element payloads use
    // `json_group_array` for labels/props, which is why THAT is not the marker to grep).
    expect(programSql('g.V().aggregate("a").cap("a").unfold()')).not.toContain('json_each');
    expect(programSql('g.V().values("name").aggregate("a").cap("a").unfold()')).not.toContain('json_each');
  });

  test('the cancel is transparent — element members re-enter the element loop', async () => {
    expect((await names('g.V().aggregate("a").cap("a").unfold()')).map((v) => v?.constructor?.name))
      .toEqual(Array(6).fill('Vertex'));
    // downstream movement/values/reducers all work over the un-folded stream
    expect((await names("g.V().aggregate('a').cap('a').unfold().values('name')")).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
    const [n] = await names("g.V().aggregate('a').cap('a').unfold().both().count()");
    expect(Number(n)).toBe(12);
  });

  test('scalar members re-enter the scalar loop', async () => {
    expect((await names("g.V().values('name').aggregate('a').cap('a').unfold()")).sort())
      .toEqual(['josh', 'lop', 'marko', 'peter', 'ripple', 'vadas']);
  });

  test('a repeat body fills N sites — the multiset survives the cancel', async () => {
    // two iterations aggregate each vertex twice; the cancel keeps all 12 (no dedup)
    expect((await names("g.V().repeat(__.aggregate('a')).times(2).cap('a').unfold()")).length).toBe(12);
  });

  test('a SEEDED collection is NOT cancelled — the fold is not an identity there', () => {
    // a Set seed dedups and an addAll seed prepends, so the members are not the raw multiset; the
    // ordinary reduce (which still folds) must run, then unfold explodes it — `json_each` present.
    // Guards readUnfolded's merge decline.
    expect(programSql('g.withSideEffect("a",[1,2,3],Operator.addAll).V().aggregate("a").cap("a").unfold()'))
      .toContain('json_each');
  });
});
