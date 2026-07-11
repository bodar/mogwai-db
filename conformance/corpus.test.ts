import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseGremlin, stepChain } from '../src/frontend.ts';

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
  console.log(`corpus: ${lines.length} traversals`);
  console.log(`parse:  ${parsed} (${pct(parsed)})`);
  console.log(`chain:  ${chained} (${pct(chained)})`);
  if (parseFails.length) {
    console.log('\nfirst parse failures:');
    parseFails.slice(0, 5).forEach((q) => console.log('  ' + q.slice(0, 90)));
  }
  console.log('\ntop 25 steps by corpus frequency (implementation priority order):');
  [...stepCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([k, v]) => console.log(`  ${String(v).padStart(4)} ${k}`));

  expect(parsed).toBe(lines.length);
  expect(chained).toBe(lines.length);
}, 30_000); // 2,177 parses + one-time ANTLR ATN warm-up; the default 5s times
            // out on cold/slow CI runners (locally ~2.3s).
