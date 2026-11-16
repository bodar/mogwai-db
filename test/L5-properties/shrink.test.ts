// The attribution's shrinker and renderer (`shrink.ts`) — held here so the instrument cannot silently rot.
// Its predicates are SYNTHETIC (text tests), never the compiler's verdict: a reduction asserted against
// what the compiler declines today would break the day that shape lands, which is the point of the work.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { hoist, parses, readTree, renderTree, shrink, signature, violations } from './shrink.ts';

const CORPUS = readFileSync(new URL('../L1-corpus/corpus.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const squash = (s: string) => s.replace(/\s+/g, '');

describe('L5 attribution — shrinker', () => {
  test('renderer round-trips the whole L1 corpus (modulo inter-step whitespace) and re-parses', () => {
    const bad: string[] = [];
    for (const q of CORPUS) {
      const r = renderTree(readTree(q));
      if (squash(r) !== squash(q) || !parses(r) || renderTree(readTree(r)) !== r) bad.push(`${q}\n  → ${r}`);
    }
    expect(bad).toEqual([]);
  }, 60_000); // ~1.5s alone; parse-bound, so it stretches past bun's 5s default beside the other brackets

  test('a mid-chain step that changes the stream shape is kept; filters and a suffix go', () => {
    const r = shrink("g.V().hasLabel('person').out('knows').path().count(local).is(P.gt(1))", (q) => /path\(\)\.count\(local\)/.test(q));
    expect(r.core).toBe('g.V().path().count(local)');
  });

  test('hoisting brings a nested body to the top level', () => {
    const r = shrink("g.V().where(__.out().map(__.values('name').fold()))", (q) => q.includes('fold()'));
    expect(r.core).toBe("g.V().values('name').fold()");
  });

  test('a positional by() is never dropped from in front of another', () => {
    const r = shrink("g.V().group().by(label).by(__.values('name').fold())", (q) => q.includes('by(label).by('));
    expect(r.core).toBe('g.V().group().by(label).by(__.identity())');
  });

  test('the type guard refuses a slip to a Map walked as a vertex', () => {
    expect(violations(readTree("g.V().project('p').by('name').select('p')"))).toBe(0);
    expect(violations(readTree("g.V().project('p').by('name').out()"))).toBe(1);
  });

  test('hoist: a modulator body runs over the input of the step it modulates', () => {
    const h = hoist(readTree("g.V().hasLabel('person').project('x').by(__.out().count())"))!;
    expect(h.hosts).toEqual(['project.by']);
    expect(h.hoisted).toBe("g.V().hasLabel('person').out().count()");
  });

  test('signature drops literals and keeps scope tokens and nesting', () => {
    expect(signature(readTree("g.V().has('age',P.gt(30)).where(__.out('knows').count(local))").root))
      .toBe('V.has.where(out.count(local))');
  });
});
