import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseGremlin, stepChain } from '../../src/gremlin/frontend.ts';
import { summary, detail } from '../support/output.ts';

const lines = readFileSync(new URL('./corpus.txt', import.meta.url), 'utf8')
  .split('\n').filter(Boolean);

test('corpus parses and chains at 100%', () => {
  let parsed = 0, chained = 0;
  const parseFails: string[] = [];
  const stepCounts = new Map<string, number>();

  for (const q of lines) {
    let tree;
    try { tree = parseGremlin(q); parsed++; } catch { parseFails.push(q); continue; }
    try {
      for (const s of stepChain(tree, new Proxy({}, { has: () => true, get: () => null }) as any)) {
        stepCounts.set(s.name, (stepCounts.get(s.name) ?? 0) + 1);
      }
      chained++;
    } catch { /* chain extraction failure */ }
  }

  const pct = (n: number) => ((100 * n) / lines.length).toFixed(1) + '%';
  summary(`corpus: ${lines.length} traversals — parse ${pct(parsed)}, chain ${pct(chained)}`);
  // A parse failure is the assertion below going red; naming the first few is diagnosis, not noise.
  if (parseFails.length) {
    summary('first parse failures:\n' + parseFails.slice(0, 5).map((q) => '  ' + q.slice(0, 90)).join('\n'));
  }
  detail(() => 'top 25 steps by corpus frequency (implementation priority order):\n'
    + [...stepCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
        .map(([k, v]) => `  ${String(v).padStart(4)} ${k}`).join('\n'));

  expect(parsed).toBe(lines.length);
  expect(chained).toBe(lines.length);
}, 30_000); // 2,298 parses + one-time ANTLR ATN warm-up; the default 5s times
            // out on cold/slow CI runners (locally ~2.3s).
