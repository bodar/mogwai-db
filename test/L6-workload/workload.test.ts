// L6 — the realistic-workload ratchet. What fraction of what a real application asks does mogwai answer,
// and answer CORRECTLY? Corpus: ./corpus.ts. Goldens: ./goldens.json (TinkerGraph, generated offline by
// scripts/workload-goldens/generate.ts; hand-derived where that has not run yet). Baseline:
// ./baseline.json, re-recorded with `mise run workload-record` — never by this test.
//
// The gates, in the order they matter:
//   1. NO NEW WRONG ANSWER. A query whose answer differs from its golden fails the build unless
//      baseline.json lists it under `wrong` with a reason a human wrote (an UNTRIAGED reason fails too).
//   2. NO NEW FAST-PATH DIVERGENCE (the L5 differential, run over every answered workload query).
//   3. NO NEW INTERNAL ERROR (a throw that is not `UnsupportedTraversal`).
//   4. NOTHING STOPS WORKING: a baselined `pass` must still pass; a baselined answered query must still answer.
// An improvement (a decline that now passes) is not a failure — it prints a re-record hint.
import { beforeAll, describe, expect, test } from 'bun:test';
import { CORPUS } from './corpus.ts';
import { ANSWERED, UNTRIAGED, readBaseline, readGoldens, report, runWorkload, shapeOf, type Baseline, type Result } from './workload.ts';
import { VERBOSE, detail, summary, verboseHint } from '../support/output.ts';

describe('L6 workload', () => {
  let results: Result[] = [];
  let baseline: Baseline;

  beforeAll(() => {
    baseline = readBaseline();
    results = runWorkload();
    const n = (o: string) => results.filter((r) => r.outcome === o).length;
    const byDepth = [...new Set(results.map((r) => r.depth))].sort().map((d) => {
      const rs = results.filter((r) => r.depth === d);
      return `d${d} ${rs.filter((r) => ANSWERED.has(r.outcome)).length}/${rs.length}`;
    }).join(' · ');
    summary(`L6 workload: ${results.length} queries — ${n('pass')} pass · ${n('wrong')} wrong · ${n('unverified')} unverified · ` +
      `${n('declined')} declined · ${n('error')} error · answered by nesting depth: ${byDepth}`);
    detail(() => report(results));
    const improved = results.filter((r) => {
      const was = baseline.outcomes[r.entry.id];
      return was && was !== r.outcome && (r.outcome === 'pass' || (ANSWERED.has(r.outcome) && !ANSWERED.has(was)));
    });
    if (improved.length)
      summary(`  ${improved.length} workload query(ies) improved on the baseline (${improved.slice(0, 5).map((r) => r.entry.id).join(', ')}` +
        `${improved.length > 5 ? ', …' : ''}) — run \`mise run workload-record\` to bank them`);
    else if (!VERBOSE) summary(verboseHint('the L6 report by source, graph, depth and idiom'));
  }, 300_000);

  test('the corpus is well-formed: unique ids, every query parses', () => {
    const ids = CORPUS.map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
    for (const e of CORPUS) expect(() => shapeOf(e.query), e.id).not.toThrow();
  });

  test('every golden belongs to a corpus query and was computed for its current text', () => {
    const byId = new Map(CORPUS.map((e) => [e.id, e]));
    const stale = Object.entries(readGoldens().goldens)
      .filter(([id, g]) => byId.get(id)?.query !== g.query)
      .map(([id]) => id);
    expect(stale, 'a golden whose query no longer exists or has been edited — regenerate it').toEqual([]);
  });

  test('the baseline covers exactly the corpus', () => {
    expect(Object.keys(baseline.outcomes).sort(), 're-record with `mise run workload-record`').toEqual(CORPUS.map((e) => e.id).sort());
  });

  test('no WRONG answer outside the baseline, and every recorded one carries a written reason', () => {
    const fresh = results.filter((r) => r.outcome === 'wrong' && !(r.entry.id in baseline.wrong))
      .map((r) => `${r.entry.id}: ${r.entry.query}\n  ${r.message}\n  expected ${JSON.stringify(r.expected)}\n  actual   ${JSON.stringify(r.actual)}`);
    expect(fresh, 'NEW WRONG ANSWER(S) — the most important failure this suite can report').toEqual([]);
    const untriaged = Object.entries(baseline.wrong).filter(([, why]) => !why.trim() || why.startsWith(UNTRIAGED)).map(([id]) => id);
    expect(untriaged, 'a baselined wrong answer needs a human-written reason in baseline.json').toEqual([]);
  });

  test('no fast-path differential divergence outside the baseline', () => {
    const fresh = results.filter((r) => r.divergence && !(r.entry.id in baseline.divergent))
      .map((r) => `${r.entry.id}: ${r.entry.query}\n  ${r.divergence}`);
    expect(fresh).toEqual([]);
    const untriaged = Object.entries(baseline.divergent).filter(([, why]) => !why.trim() || why.startsWith(UNTRIAGED)).map(([id]) => id);
    expect(untriaged, 'a baselined divergence needs a human-written reason in baseline.json').toEqual([]);
  });

  test('no internal error outside the baseline', () => {
    const fresh = results.filter((r) => r.outcome === 'error' && baseline.outcomes[r.entry.id] !== 'error')
      .map((r) => `${r.entry.id}: ${r.entry.query}\n  ${r.message}`);
    expect(fresh, 'an internal error is a fail-closed violation (a decline must be UnsupportedTraversal)').toEqual([]);
  });

  test('ratchet: nothing that passed or answered stops doing so', () => {
    const lost = results.filter((r) => {
      const was = baseline.outcomes[r.entry.id];
      if (was === 'pass') return r.outcome !== 'pass';
      if (was && ANSWERED.has(was)) return !ANSWERED.has(r.outcome);
      return false;
    }).map((r) => `${r.entry.id}: was ${baseline.outcomes[r.entry.id]}, now ${r.outcome}${r.message ? ` — ${r.message.slice(0, 200)}` : ''}`);
    expect(lost).toEqual([]);
  });
});
