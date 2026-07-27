// The shape table's own tests — what keeps `shape.ts` from silently rotting.
//
// The table is an INDEPENDENT statement of Gremlin's type discipline (see shape.ts's header on why it
// is not reflected out of the compiler's dispatch maps). Independence is what makes it useful and
// also what puts it at risk: a misspelled step name or a mis-typed transition produces traversals
// that always throw, which does not fail anything — it just quietly empties the differential's
// coverage and makes L5 pass by testing nothing. These tests are the guard against that.
//
// The check is BEHAVIOURAL, not structural. "Does every name in the table appear in some dispatch
// Map" would need those Maps exported and would still miss a wrong `to:` shape. "Does every generated
// traversal parse and chain" catches both, and it is exactly L1's bar — 100%, no exceptions — applied
// to generated permutations instead of a fixed corpus.
import { test, expect, describe } from 'bun:test';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { traversal } from './generate.ts';
import { TRANSITIONS, SHAPES, namesByShape, type Shape } from './shape.ts';

const SEED = Number(process.env.L5_SEED ?? 42);
const RUNS = Number(process.env.L5_RUNS ?? 300);
/** The permissive params proxy L1's corpus test uses: every name is "bound", so a traversal
 *  referencing a variable still chains. */
const anyParams = () => new Proxy({}, { has: () => true, get: () => null }) as any;

describe('L5 shape table', () => {
  // ---------- the generator emits valid Gremlin, always ----------
  test('every generated traversal parses and chains', () => {
    const failures: string[] = [];
    fc.assert(
      fc.property(traversal({ steps: 6, depth: 3 }), (g) => {
        try {
          stepChain(parseGremlin(g.query), anyParams());
          return true;
        } catch (e) {
          // A parse/chain failure is a TABLE bug, never a compiler one: the table's whole job is to
          // emit well-typed, well-formed Gremlin. This is the assertion that a bad `render` or a
          // bogus step name cannot hide behind "the compiler threw".
          failures.push(`${g.query}\n    ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      }),
      // Deeper and longer than the differential runs: parse+chain is cheap, so buy depth here.
      { seed: SEED, numRuns: RUNS * 4, verbose: true },
    );
    expect(failures).toEqual([]);
  }, 300_000);

  // ---------- the table has no dead weight ----------
  test('the generator actually exercises (nearly) every transition', () => {
    // A transition never drawn at the default budget is untested table surface — usually a shape the
    // walk can't reach, or one reachable only past the step budget. Reported per shape so a gap is
    // actionable rather than a single opaque percentage.
    const emitted = new Set<string>();
    for (const g of fc.sample(traversal({ steps: 6, depth: 3 }), { seed: SEED, numRuns: RUNS * 10 }))
      for (const s of g.steps) emitted.add(s);

    const missing: string[] = [];
    for (const shape of SHAPES) {
      const names = namesByShape()[shape];
      const unseen = [...names].filter((n) => !emitted.has(n));
      if (unseen.length) missing.push(`  ${shape}: ${unseen.join(', ')}`);
    }
    const total = SHAPES.reduce((n, s) => n + namesByShape()[s].size, 0);
    console.log(`L5 table: ${total} transitions across ${SHAPES.length} shapes; ${emitted.size} distinct step names emitted`);
    if (missing.length) console.log('unexercised transitions:\n' + missing.join('\n'));
    // Not asserted at zero: `steps`/`depth` bound the walk, so a deep-shape transition can be
    // legitimately rare. Asserted as a floor, so a table edit that strands a whole shape fails.
    expect(missing.length).toBeLessThan(3);
  }, 300_000);

  // ---------- coverage against real Gremlin ----------
  test('reports the gap between the table and the corpus vocabulary', () => {
    // Informational, deliberately not a gate. The corpus is the best available inventory of "steps
    // real Gremlin uses"; the table covers a v1 slice of it. Printing the gap turns "what should the
    // table grow next" into a list instead of a guess — and if it ever prints nothing, the table has
    // caught up with the corpus and the generator's vocabulary is the corpus's.
    const corpus = readFileSync(new URL('../L1-corpus/corpus.txt', import.meta.url), 'utf8')
      .split('\n').filter(Boolean);
    const corpusSteps = new Map<string, number>();
    for (const q of corpus) {
      try {
        for (const s of stepChain(parseGremlin(q), anyParams()))
          corpusSteps.set(s.name, (corpusSteps.get(s.name) ?? 0) + 1);
      } catch { /* L1 owns the parse gate; a failure here is not this test's business */ }
    }
    // Names the table emits as part of a COMPOSITE render rather than as a transition of their own —
    // `order().by(k)`, `repeat(b).times(n)`, `project(a,b).by()…`, and the V()/E() sources. Counting
    // them as unmodelled would put `by` and `times` at the top of a "grow the table" list the table
    // already covers.
    const COMPOSITE = ['V', 'E', 'by', 'times'];
    const known = new Set([...SHAPES.flatMap((s) => [...namesByShape()[s]]), ...COMPOSITE]);
    const gap = [...corpusSteps.entries()]
      .filter(([name]) => !known.has(name))
      .sort((a, b) => b[1] - a[1]);

    console.log(`L5 table covers ${known.size} step names; corpus uses ${corpusSteps.size}`);
    console.log('top unmodelled steps (table growth order):');
    for (const [name, n] of gap.slice(0, 20)) console.log(`  ${String(n).padStart(4)} ${name}`);
    expect(corpusSteps.size).toBeGreaterThan(0); // the corpus parsed at all
  }, 120_000);

  // ---------- the table is well-formed ----------
  test('every transition targets a declared shape', () => {
    for (const shape of SHAPES)
      for (const t of TRANSITIONS[shape]) {
        // 'inherit' is the one non-Shape target (unfold restoring what fold consumed).
        if (t.to === 'inherit') continue;
        expect(SHAPES).toContain(t.to as Shape);
        for (const b of t.bodies ?? []) expect(SHAPES).toContain(b);
      }
  });
});
