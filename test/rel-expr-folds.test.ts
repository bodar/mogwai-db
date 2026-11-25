import { describe, expect, test } from 'bun:test';
import { and, col, compilerNull, conjoin, conjuncts, disjoin, disjuncts, or, type Expr } from '../src/rel/expr.ts';
import { allNullGuard } from '../src/compiler/rel/transform.ts';
import type { RelId } from '../src/rel/types.ts';

// The two connective folds and their inverses are ONE authority in `src/rel/expr.ts`. Every lowering that
// builds an AND/OR chain goes through them, so their fold ORDER is what keeps the emitted SQL byte-stable.
const [a, b, c] = (['a', 'b', 'c'] as const).map((name): Expr => col('r' as RelId, name));

describe('connective folds', () => {
  test('no terms is an absent predicate', () => {
    expect(conjoin([])).toBeUndefined();
    expect(disjoin([])).toBeUndefined();
  });

  test('one term is the term itself', () => {
    expect(conjoin([a!])).toBe(a!);
    expect(disjoin([a!])).toBe(a!);
  });

  test('a left fold: ((a op b) op c)', () => {
    expect(conjoin([a!, b!, c!])).toEqual(and(and(a!, b!), c!));
    expect(disjoin([a!, b!, c!])).toEqual(or(or(a!, b!), c!));
  });

  test('conjuncts and disjuncts invert the folds', () => {
    expect(conjuncts(conjoin([a!, b!, c!])!)).toEqual([a!, b!, c!]);
    expect(disjuncts(disjoin([a!, b!, c!])!)).toEqual([a!, b!, c!]);
    // Each inverse flattens only its own connective.
    expect(disjuncts(conjoin([a!, b!])!)).toHaveLength(1);
    expect(conjuncts(disjoin([a!, b!])!)).toHaveLength(1);
  });
});

describe('the shared concat all-null guard', () => {
  test('CASE WHEN every part IS NULL THEN NULL ELSE body', () => {
    const body: Expr = { kind: 'call', fn: 'concat_ws', args: [a!, b!] };
    const isNull = (e: Expr): Expr => ({ kind: 'binary', op: 'is', left: e, right: compilerNull() });
    expect(allNullGuard([a!, b!], body)).toEqual({ kind: 'case', whens: [[and(isNull(a!), isNull(b!)), compilerNull()]], else: body });
  });
});

// The witness that the folds stay ONE authority: no seedless `.reduce` that builds an AND/OR chain lives
// outside `src/rel/expr.ts`. A seeded fold (`.reduce(and, always)`) is a different expression and is allowed.
describe('no private connective folds', () => {
  test('every seedless AND/OR fold in src/ goes through conjoin/disjoin', async () => {
    const root = new URL('../src/', import.meta.url).pathname;
    const pair = String.raw`\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*`;
    const fold = new RegExp([
      String.raw`\.reduce\(\s*(?:and|or)\s*\)`,
      String.raw`\.reduce\(\s*${pair}\(?\s*(?:and|or)\(\s*\w+\s*,\s*\w+\s*\)\s*\)`,
      String.raw`\.reduce\(\s*${pair}\(?\s*\{[^}]*op:\s*'(?:and|or)'[^}]*\}\s*\)?\s*\)`,
      String.raw`\.reduce\(\s*${pair}\([^()]*\?\s*(?:and|or)\([^)]*\)\s*:\s*(?:and|or)\([^)]*\)\)\s*\)`,
    ].join('|'), 'g');
    const offenders: string[] = [];
    for await (const file of new Bun.Glob('**/*.ts').scan({ cwd: root })) {
      if (file.startsWith('parser/') || file === 'rel/expr.ts') continue;
      const text = await Bun.file(root + file).text();
      for (const hit of text.matchAll(fold)) offenders.push(`${file}: ${hit[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});
