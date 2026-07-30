// A deliberately test-only probe for the proposed IR shape annotation. It is
// conservative by construction: unknown is preferable to an invented claim.
// The pre-committed adoption bar is zero disagreement with L5's independently
// generated shape and <=10% unknown roots across L1 + L5. If that bar is missed,
// this test records negative evidence; it must not motivate production IR typing.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { parseGremlin, stepChain, type Step } from '../../src/gremlin/frontend.ts';
import { runPasses } from '../../src/compiler/ir/passes.ts';
import { extractStrategies } from '../../src/gremlin/frontend.ts';
import { traversal } from './generate.ts';
import type { Shape } from './shape.ts';

type Annotation = Shape | 'unknown';
type State = { shape: Annotation; folded?: Annotation };
const SAME = new Set(['hasLabel', 'has', 'hasId', 'identity', 'dedup', 'where', 'filter', 'not', 'and', 'or', 'union', 'coalesce', 'optional', 'local', 'order', 'limit', 'skip', 'range', 'tail', 'repeat']);
const anyParams = () => new Proxy({}, { has: () => true, get: () => null }) as any;

function advance(state: State, step: Step): State {
  const s = state.shape;
  if (s === 'unknown') return state;
  if (SAME.has(step.name)) return state;
  if (step.name === 'values' || step.name === 'id' || step.name === 'label' || step.name === 'count' || step.name === 'sum' || step.name === 'min' || step.name === 'max' || step.name === 'mean') return { shape: 'scalar' };
  if (step.name === 'fold') return { shape: 'list', folded: s };
  if (step.name === 'unfold') return state.folded === undefined ? { shape: 'unknown' } : { shape: state.folded };
  if (step.name === 'path') return { shape: 'path' };
  if (step.name === 'valueMap' || step.name === 'elementMap' || step.name === 'project') return { shape: 'record' };
  if (step.name === 'group' || step.name === 'groupCount') return { shape: 'group' };
  if (s === 'vertex' && ['out', 'in', 'both'].includes(step.name)) return { shape: 'vertex' };
  if (s === 'vertex' && ['outE', 'inE', 'bothE'].includes(step.name)) return { shape: 'edge' };
  if (s === 'edge' && ['outV', 'inV', 'bothV', 'otherV'].includes(step.name)) return { shape: 'vertex' };
  if (s === 'scalar' && ['is'].includes(step.name)) return state;
  if (s === 'list' && step.name === 'order') return state;
  if (s === 'record' && ['select', 'count'].includes(step.name)) return { shape: 'scalar' };
  if (s === 'record' && ['dedup', 'limit'].includes(step.name)) return state;
  if (s === 'group' && step.name === 'unfold') return { shape: 'record' };
  if (s === 'group' && ['count', 'select'].includes(step.name)) return { shape: 'scalar' };
  if (s === 'path' && ['limit', 'dedup'].includes(step.name)) return state;
  if (s === 'path' && step.name === 'unfold') return { shape: 'scalar' };
  return { shape: 'unknown' };
}

function annotate(query: string): Annotation {
  const tree = parseGremlin(query);
  const raw = stepChain(tree, anyParams());
  const { steps } = runPasses(raw, extractStrategies(tree, anyParams()), anyParams());
  if (!steps.length) return 'unknown';
  const first = steps[0].name;
  let state: State = first === 'V' ? { shape: 'vertex' } : first === 'E' ? { shape: 'edge' } : { shape: 'unknown' };
  for (const step of steps.slice(1)) state = advance(state, step);
  return state.shape;
}

describe('L5 test-only root shape annotation experiment', () => {
  test('records the pre-committed adoption criteria', () => {
    const generated = fc.sample(traversal({ steps: 6, depth: 3 }), { seed: 42, numRuns: 600 });
    const unsound = generated.filter((g) => {
      const got = annotate(g.query);
      return got !== 'unknown' && got !== g.shape;
    });
    const corpus = readFileSync(new URL('../L1-corpus/corpus.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
    const measured = [...corpus, ...generated.map((g) => g.query)];
    let unknown = 0;
    for (const query of measured) {
      try { if (annotate(query) === 'unknown') unknown++; }
      catch { unknown++; }
    }
    const rate = unknown / measured.length;
    console.log(`IR shape annotation probe: ${unknown}/${measured.length} unknown (${(rate * 100).toFixed(1)}%), ${unsound.length} L5 disagreements`);
    expect(unsound).toEqual([]);
    // This assertion deliberately captures the experiment's expected negative result:
    // the root chain has no existing total classifier, so the conservative probe is
    // far above the 10% adoption threshold. Keep lowering as shape owner.
    expect(rate).toBeGreaterThan(0.10);
  }, 120_000);
});
