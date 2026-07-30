import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RUNNER_SKIPPED } from './tags.ts';

// The vendored cucumber runner refuses to run some scenarios itself, with
// `Before({tags: "@X"}, () => 'skipped')`. Those can never pass whatever our engine does, so
// `tags.ts` scopes them out to keep the L3 denominator to what the harness can adjudicate.
//
// That reasoning has an expiry date and nothing was watching it. The skip list lives in the
// SUBMODULE, so an upstream bump — or the fork fix item 19b proposes for @MultiLabelDefault —
// can make a tag runnable, and the only symptom would be scenarios silently staying out of scope.
// Measurement integrity, the same concern as item 0e's stale-`parser/` check: an exclusion
// justified by someone else's code has to be checked against that code.
const WORLD = new URL(
  '../../vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/world.js',
  import.meta.url,
).pathname;

/** Tags the runner short-circuits with a 'skipped' return, read straight out of its source. */
function runnerSkippedTags(): string[] {
  const src = readFileSync(WORLD, 'utf8');
  // Before({tags: "@X"}, function() { ... return 'skipped' ... })
  const hooks = [...src.matchAll(/Before\(\{\s*tags:\s*["']([^"']+)["']\s*\}\s*,\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\}\)/g)];
  return hooks.filter(([, , body]) => /return\s+['"]skipped['"]/.test(body)).map(([, tag]) => tag).sort();
}

test('tags.ts excludes exactly what the vendored runner refuses to run', () => {
  const actual = runnerSkippedTags();
  // A non-empty parse is part of the assertion: if the hook syntax changes upstream this test must
  // fail loudly rather than quietly comparing two empty lists and passing.
  expect(actual.length).toBeGreaterThan(0);
  expect(actual).toEqual([...RUNNER_SKIPPED].sort());
});
