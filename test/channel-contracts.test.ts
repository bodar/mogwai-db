import { describe, expect, test } from 'bun:test';
import {
    gtypeName, isCardinalityArg, isColumnArg, isDirectionArg, isDtArg, isGTypeArg,
    isMergeArg, isOperatorArg, isOrderArg, isPickArg, isPopArg, isScopeArg,
    isTokenArg, isWithOptionArg,
} from '../src/gremlin/frontend.ts';
import { cardinalityOf } from '../src/compiler/steps/context/stream.ts';
import {
    LAYOUT_ROLE_POLICY, layoutCols, layoutGrewAliases, layoutOverAliases, mergeArmRelation, mergeLayouts, nonAliasCols, rigidCols,
    type AliasEntry, type TraverserLayout,
} from '../src/compiler/steps/context/context.ts';
import { Query, q } from '../src/sql/kernel/q.ts';

describe('channel contracts', () => {
  test('front-end tagged arguments narrow only through their declared tag', () => {
    const cases: readonly [unknown, (v: unknown) => boolean][] = [
      [{ order: 'asc' }, isOrderArg], [{ pop: 'first' }, isPopArg],
      [{ column: 'keys' }, isColumnArg], [{ token: 'id' }, isTokenArg],
      [{ direction: 'out' }, isDirectionArg], [{ merge: 'oncreate' }, isMergeArg],
      [{ cardinality: 'single' }, isCardinalityArg], [{ gtype: 'string' }, isGTypeArg],
      [{ pick: 'none' }, isPickArg], [{ withOption: 'tokens' }, isWithOptionArg],
      [{ dt: 'day' }, isDtArg], [{ operator: 'sum' }, isOperatorArg], [{ scope: 'local' }, isScopeArg],
    ];
    for (const [value, guard] of cases) {
      expect(guard(value)).toBe(true);
      expect(guard({ unrelated: true })).toBe(false);
    }
    expect(gtypeName({ gtype: 'UUID' })).toBe('UUID');
    expect(gtypeName('STRING')).toBe('STRING');
    expect(gtypeName({ token: 'id' })).toBeNull();
  });

  test('relational cardinality distinguishes rows, whole results, and path runs', () => {
    expect(cardinalityOf({ kind: 'scalar', rel: { cols: [] }, traverserLayout: {} } as any)).toEqual({ kind: 'perRow' });
    expect(cardinalityOf({ kind: 'group', rel: { cols: [] }, traverserLayout: {} } as any)).toEqual({ kind: 'wholeResult' });
    expect(cardinalityOf({ kind: 'path', layout: { kind: 'grouped', elem: 'vertex' }, rel: { cols: ['pk', 'ord'] }, traverserLayout: {} } as any))
      .toEqual({ kind: 'runsByKey', key: 'pk' });
    expect(() => cardinalityOf({ kind: 'path', layout: { kind: 'grouped', elem: 'vertex' }, rel: { cols: ['ord'] }, traverserLayout: {} } as any))
      .toThrow('requires its pk run key');
  });
});

// ---------- the arm-merge authority (channel-preservation Phase 1) ----------
//
// These pin the STRUCTURE the four arm merges now share, which the execution-level tests
// (test/compiler/branch.exec.test.ts) can only observe indirectly. The plan's exit gate asks for
// both a same-scope arm and a CHILD-SCOPED arm at every migrated merge: the first must fail closed
// when a rigid role diverges, the second must merge label sets without ever comparing an ordinal
// the parent does not have.

const alias = (col: string): AliasEntry => ({ col, shapes: new Set(['vertex']), binds: 1 });

const layout = (over: Partial<TraverserLayout> = {}): TraverserLayout =>
  ({ aliases: new Map(), origins: [], ...over });

describe('arm-merge authority', () => {
  test('the peer policy fails closed when an arm diverges on a rigid role', () => {
    const seed = layout({ aliases: new Map([['a', alias('a0')]]) });
    // A CHILD-SCOPED arm: the child pushed its own ordinal, so it carries a rigid column the seed
    // does not. As a same-scope PEER that is unreconcilable per-traverser state → deferral.
    const childScoped = layout({ aliases: new Map([['a', alias('a0')]]), origins: ['o0'] });
    expect(() => mergeLayouts(seed, [childScoped], { rigid: 'peer' }))
      .toThrow('branch arms disagree on carried columns');
    // …and a genuine peer arm merges. Same rigid roles, so nothing to reconcile.
    expect(rigidCols(mergeLayouts(seed, [layout({ aliases: new Map([['a', alias('a0')]]) })], { rigid: 'peer' })))
      .toEqual([]);
  });

  test('the rehomed policy merges label sets without comparing the ordinal a child minted', () => {
    const seed = layout({ aliases: new Map([['a', alias('a0')]]) });
    const childScoped = layout({ aliases: new Map([['a', alias('a0')]]), origins: ['o0'] });
    const merged = mergeLayouts(seed, [childScoped], { rigid: 'rehomed' });
    // The SEED's rigid roles survive — a re-homed merge must never inherit the child-only ordinal.
    expect(merged.origins).toEqual([]);
    expect([...merged.aliases.keys()]).toEqual(['a']);
    expect(layoutGrewAliases(seed, merged)).toBe(false);
  });

  test('an arm-minted label joins the merged set and reports as grown', () => {
    const seed = layout({ aliases: new Map([['a', alias('a0')]]) });
    // Each arm mints columns independently from the same seed size, so both spell the new label
    // `a1`; the merge assigns ONE canonical column and each arm remaps onto it.
    const armWithX = layout({ aliases: new Map([['a', alias('a0')], ['x', alias('a1')]]) });
    const merged = mergeLayouts(seed, [armWithX, seed], { rigid: 'rehomed' });
    expect([...merged.aliases.keys()]).toEqual(['a', 'x']);
    expect(layoutGrewAliases(seed, merged)).toBe(true);
    // Only ONE arm binds it, so the bind count is not static — Pop must resolve off the array.
    expect(merged.aliases.get('x')!.binds).toBeUndefined();
    // The canonical column lands after the seed's, so layoutCols(seed) stays a PREFIX.
    expect(layoutCols(merged).slice(0, 1)).toEqual(layoutCols(seed));
  });

  test('nonAliasCols and rigidCols differ by exactly the path positions', () => {
    const c = layout({
      aliases: new Map([['a', alias('a0')]]),
      sack: 'sk', origins: ['o0'], encounter: 'encounter',
      path: { kind: 'cols', cols: [{ col: 'p0', elem: 'vertex' }] },
    });
    expect(layoutCols(c)).toEqual(['a0', 'sk', 'o0', 'encounter', 'p0']);
    expect(nonAliasCols(c)).toEqual(['sk', 'o0', 'encounter', 'p0']);
    expect(rigidCols(c)).toEqual(['sk', 'o0', 'encounter']);
  });

  test('a binding-table drop keeps the labels and states every role it loses', () => {
    const c = layout({
      aliases: new Map([['a', alias('a0')]]),
      sack: 'sk', bulk: 'bulk', origins: ['o0'], fromV: 'fv', encounter: 'encounter',
      path: { kind: 'cols', cols: [{ col: 'p0', elem: 'vertex' }] },
      trackFromV: true, consumedAliases: ['gone'],
    });
    const bound = new Map([['a', alias('a0')], ['b', alias('a1')]]);
    const dropped = layoutOverAliases(c, bound);
    // `match()`'s seed projects id + the bound variables and nothing else, so the layout must
    // declare exactly that — claiming `bulk` here is what made rel.c.bulk undefined.
    expect(layoutCols(dropped)).toEqual(['a0', 'a1']);
    expect(rigidCols(dropped)).toEqual([]);
    // The labels ARE the binding table, so they survive and a barrier's diagnosis rides along;
    // trackFromV is a chain requirement, not a column.
    expect([...dropped.aliases.keys()]).toEqual(['a', 'b']);
    expect(dropped.trackFromV).toBe(true);
    expect(dropped.consumedAliases).toEqual(['gone']);
  });

  test('every role the column accessors emit agrees with its declared merge policy', () => {
    // The table is kept TOTAL by the type checker; this ties it to the three accessors, so a policy
    // recorded there and a column list that disagrees cannot both survive.
    const c = layout({
      aliases: new Map([['a', alias('a0')]]),
      sack: 'sk', bulk: 'bulk', origins: ['o0'], fromV: 'fv', encounter: 'encounter',
      path: { kind: 'cols', cols: [{ col: 'p0', elem: 'vertex' }] },
      trackFromV: true, consumedAliases: ['gone'],
    });
    const identical = Object.entries(LAYOUT_ROLE_POLICY).filter(([, p]) => p === 'identical').map(([r]) => r);
    expect(identical.sort()).toEqual(['bulk', 'encounter', 'fromV', 'origins', 'sack']);
    // `rigidCols` IS the identical set: same size, and every column belongs to one of those roles.
    expect(rigidCols(c)).toEqual(['sk', 'bulk', 'o0', 'fv', 'encounter']);
    expect(rigidCols(c).length).toBe(identical.length);
    // The two non-identical COLUMN roles are exactly what layoutCols adds beyond the rigid set:
    // `union` contributes the alias columns, `pad` the path positions.
    const extra = layoutCols(c).filter((col) => !rigidCols(c).includes(col));
    expect(extra).toEqual(['a0', 'p0']);
    // `metadata` roles are never columns — set on `c` above, absent from every accessor.
    const metadata = Object.entries(LAYOUT_ROLE_POLICY).filter(([, p]) => p === 'metadata').map(([r]) => r);
    expect(metadata.sort()).toEqual(['consumedAliases', 'trackFromV']);
    for (const role of metadata) expect(layoutCols(c)).not.toContain(role);
    // nonAliasCols is the same set minus the `union` role, which is what an arm merge remaps.
    expect(nonAliasCols(c)).toEqual([...rigidCols(c), 'p0']);
  });

  test('the shared merge core declares the minted encounter in its layoutCols slot', () => {
    const base = { q: new Query(), params: {}, traverserLayout: layout({ sack: 'sk', encounter: 'e0' }) };
    const parts = [q`SELECT 1 AS v, 0 AS arm_idx, 1 AS arm_encounter, 2 AS sk`];
    const minted = mergeArmRelation(base, layout({ sack: 'sk' }), ['v'], parts, true);
    // The mint SUPERSEDES the incoming encounter rather than adding a second slot, and lands in
    // the position layoutCols declares — after sack, never appended past it.
    expect(minted.traverserLayout.encounter).toBe('encounter');
    expect(minted.rel.cols).toEqual(['v', 'sk', 'encounter']);
    expect(layoutCols(minted.traverserLayout)).toEqual(['sk', 'encounter']);

    // Not minting is a plain UNION ALL over the declared schema, and the parts must NOT carry the
    // tag columns — the declared list is what assertStreamColumns checks at the caller.
    const plain = mergeArmRelation(base, layout({ sack: 'sk' }), ['v'], [q`SELECT 1 AS v, 2 AS sk`], false);
    expect(plain.traverserLayout.encounter).toBeUndefined();
    expect(plain.rel.cols).toEqual(['v', 'sk']);
  });
});
