// `inject()` of an EXACT TAIL — a BigDecimal, a big BigInt (>2^53), or a Duration — used in an
// ORDERING comparison. The tail value inlines as decimal / total-nanos TEXT (exact, framed back as
// its own type) and `ordered`'s static arm casts the TEXT subject to its numeric class, so the
// comparison is NUMERIC.
//
// This is a CORRECTNESS fix, not only coverage: before it, rel DECLINED and the traversal ran on the
// LEGACY spine, which compares the stored decimal TEXT LEXICALLY — a wrong answer, because
// `'9.99' > '10.0'` is TRUE by text order (`'9' > '1'`). The two cases below that legacy gets wrong
// (`gt(10.0)` → [], `lt(10.0)` → [9.99]) are the point of the pin.
//
// The storage class is what disambiguates: `inject(9.99m)` and `asNumber(GType.BIGDECIMAL)` share the
// tag `bigdecimal`, but the first is decimal TEXT (cast in ordering) and the second a native REAL
// (untouched). The `text` flag on the static type, set only where the value stores as TEXT
// (`injectSource`), carries that. See docs/2026-08-05-parameters-are-the-only-binds.md C1.
import { test, expect, describe } from 'bun:test';
import { compile } from '../../src/compiler/compiler.ts';
import { GraphStore } from '../../src/storage.ts';
import { BunSqlite } from '../../src/bun/BunSqlite.ts';
import { executeQuery } from '../support/executor.ts';
import { decodeAll } from '../support/decode.ts';

const store = new GraphStore(new BunSqlite(':memory:'));
/** 'rel' iff the traversal lowers on the RelIR spine rather than declining to legacy. */
const onRel = (g: string) => { const p = compile(g, {}, { spine: 'rel' }); return p.kind === 'read' ? p.spine : 'legacy'; };
const vals = async (g: string) =>
  (await decodeAll(executeQuery(store, g, {}))).map((x: any) => x?.constructor ? `${x.constructor.name}:${x.toString()}` : String(x));

describe('inject() exact-tail ordering — numeric on rel, fixing legacy lexical compare', () => {
  test('BigDecimal subject casts to REAL: gt/lt are numeric, not lexical', async () => {
    expect(onRel('g.inject(9.99m).is(P.gt(9.0))')).toBe('rel');
    expect(await vals('g.inject(9.99m).is(P.gt(9.0))')).toEqual(['BigDecimal:9.99']);
    // Legacy returns [9.99] here ('9.99' > '10.0' lexically) — the wrong answer this fixes.
    expect(await vals('g.inject(9.99m).is(P.gt(10.0))')).toEqual([]);
    // Legacy returns [] here ('9.99' < '10.0' is false lexically) — also wrong.
    expect(await vals('g.inject(9.99m).is(P.lt(10.0))')).toEqual(['BigDecimal:9.99']);
    expect(await vals('g.inject(9.99m).is(P.between(9.0, 10.0))')).toEqual(['BigDecimal:9.99']);
  });

  test('big BigInt (>2^53) subject casts to INTEGER', async () => {
    expect(onRel('g.inject(9007199254740993L).is(P.gt(9007199254740992L))')).toBe('rel');
    expect(await vals('g.inject(9007199254740993L).is(P.gt(9007199254740992L))')).toEqual(['BigInt:9007199254740993']);
    expect(await vals('g.inject(9007199254740993L).is(P.lt(9007199254740992L))')).toEqual([]);
  });

  test('Duration subject casts to INTEGER (total nanos)', async () => {
    expect(onRel('g.inject(Duration(9000,0)).is(P.gt(Duration(3600,0)))')).toBe('rel');
    expect(await vals('g.inject(Duration(9000,0)).is(P.gt(Duration(3600,0)))')).toEqual(['Duration:9000000000000']);
    expect(await vals('g.inject(Duration(9000,0)).is(P.lt(Duration(3600,0)))')).toEqual([]);
  });

  test('native asNumber(BIGDECIMAL) REAL subject (text UNSET) is unaffected', async () => {
    // Same `bigdecimal` tag, but a native REAL — no subject cast, and it already compared correctly.
    expect(await vals('g.inject(99).asNumber(GType.BIGDECIMAL).is(P.gt(0))')).toHaveLength(1);
    expect(await vals('g.inject(99).asNumber(GType.BIGDECIMAL).is(P.gt(100))')).toEqual([]);
  });

  // `constant(9.99m)` is the sibling of `inject(9.99m)`: it too has a declared type, so an exact tail
  // frames STATIC(type, text) and orders numerically, where it used to frame UNKNOWN and decline.
  test('constant() exact tail frames typed + orders numerically (not UNKNOWN)', async () => {
    expect(onRel('g.inject(1).constant(9.99m).is(P.gt(9.0))')).toBe('rel');
    expect(await vals('g.inject(1).constant(9.99m).is(P.gt(9.0))')).toEqual(['BigDecimal:9.99']);
    expect(await vals('g.inject(1).constant(9.99m).is(P.gt(10.0))')).toEqual([]);
    expect(await vals('g.inject(1).constant(9.99m)')).toEqual(['BigDecimal:9.99']);
    expect(await vals('g.inject(1).constant(Duration(9000,0)).is(P.gt(Duration(3600,0)))')).toEqual(['Duration:9000000000000']);
  });
});
