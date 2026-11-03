import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { RUNNER_SKIPPED, IGNORED_SCENARIOS, GLV_LOSSY, deriveGlvLossy, gremlinJsEntries, isOutOfScope, type GlvLoss } from './tags.ts';

const GREMLIN_JS = new URL('../../vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/gremlin.js', import.meta.url);

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

test('IGNORED_SCENARIOS parses the runner IgnoreError map (auto-tracked, non-empty)', () => {
  // Sourced from feature-steps.js at load, so it cannot drift — but a broken parse regex would
  // silently empty it and re-admit float/uuid-unstable scenarios as false failures. Assert it stays
  // non-empty and includes a known member (the pageRank float-unstable scenario 8).
  expect(IGNORED_SCENARIOS.size).toBeGreaterThan(0);
  expect(IGNORED_SCENARIOS.has('g_V_hasLabelXsoftwareX_hasXname_rippleX_pageRankX1X_withXedges_inEXcreatedX_withXtimes_1X_withXpropertyName_priorsX_inXcreatedX_unionXboth__identityX_valueMapXname_priorsX')).toBe(true);
});

// ── GLV-lossy scenarios: derived from upstream's text, and they must stay derivable ─────────────────
//
// `GLV_LOSSY` is not a list anyone maintains — `deriveGlvLossy` reads the generated `gremlin.js` and the
// `.feature` corpus. These tests pin the derivation in both directions: today's witnesses ARE derived
// (a broken parse cannot silently re-admit them as our failures), and an upstream FIX un-derives them
// (so a pin bump that ships `patches/upstream/tinkerpop-01`/`-08` brings them back into scope unedited).

const WITNESSES: Record<string, GlvLoss> = {
  g_V_valuesXuuidX_isXtypeOfXGType_UUIDXX: 'uuid-unimported',
  g_injectXUUIDX47af10b_58cc_4372_a567_0f02b2f3d479XX: 'uuid-unimported',
  g_V_valuesXlongX_isXtypeOfXGType_LONGXX: 'long-literal-bare',
  g_V_hasXlong_typeOfXGType_LONGXX_valuesXnameX: 'long-literal-bare',
};

test('GLV_LOSSY derives the uuid and Long witnesses from the vendored gremlin.js', () => {
  for (const [name, loss] of Object.entries(WITNESSES)) expect(GLV_LOSSY.get(name)).toBe(loss);
  // Every derived name really is a scenario of the generated client, and it leaves scope through the
  // one predicate the live count, the scenario rows and the recorded floor all filter by.
  const entries = gremlinJsEntries(readFileSync(GREMLIN_JS, 'utf8'));
  for (const name of GLV_LOSSY.keys()) {
    expect(entries.has(name)).toBe(true);
    expect(isOutOfScope(name)).toBe(true);
  }
});

test('a GLV-lossy exclusion never removes a PASS from the floor', () => {
  // The Long rule is narrow precisely so this holds: `V(1L)` renders as `V(1)` and passes, and must stay
  // counted. A derived name in the committed `passed` list would shrink the floor silently.
  const { passed } = JSON.parse(readFileSync(new URL('./l3-state.json', import.meta.url), 'utf8')) as { passed: string[] };
  expect(passed.filter((n) => GLV_LOSSY.has(n))).toEqual([]);
});

test('an upstream fix un-derives the scenario — no edit here brings it back into scope', () => {
  const docs = new Map([
    ['u', 'g.inject(UUID("f47af10b-58cc-4372-a567-0f02b2f3d479"))'],
    ['l', 'g.addV("data").property("long", 1L)\ng.V().values("long").is(P.typeOf(GType.LONG))'],
    ['l2', 'g.V(1L).values("name")'],
  ]);
  const lossy = (js: string) => Object.fromEntries(deriveGlvLossy(js, docs));
  const line = (name: string, body: string) => `    ${name}: [${body}], \n`;
  const broken = line('u', 'function({g}) { return g.inject(uuid.parse("f47af10b-58cc-4372-a567-0f02b2f3d479")) }')
    + line('l', 'function({g}) { return g.addV("data").property("long", 1) }, function({g}) { return g.V().values("long").is(P.typeOf(GType.long)) }')
    + line('l2', 'function({g}) { return g.V(1).values("name") }');
  // `l2` writes a Long but never asks for its type: harmless, so it stays in scope.
  expect(lossy(broken)).toEqual({ u: 'uuid-unimported', l: 'long-literal-bare' });
  // 01 lands: gremlin.js imports uuid. 08 lands: the translator emits `toLong(1)`.
  const fixed = "import * as uuid from 'uuid';\n" + broken.replace('property("long", 1)', 'property("long", toLong(1))');
  expect(lossy(fixed)).toEqual({});
});
