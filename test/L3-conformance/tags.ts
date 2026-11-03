import { readFileSync } from 'node:fs';

// L3 scope. Every exclusion below is one of THREE kinds, and they are different claims — the file
// used to state them all as "what we deliberately don't support", which read as a capability
// decision even where we had made none.
//
// ── 1. WE REFUSE — a real decision about mogwai-db ─────────────────────────────────────────────
//
//   @StepSample, @StepCoin — non-deterministic by construction (random sampling / a coin flip), so
//     a ratchet over them would flake. Not a capability gap; a measurement one.
//   @SingleLabelDefault — we declare the OTHER provider default. `elementMap()`/`valueMap(true)`
//     render T.label as a SET (`labelRegime`, src/api.ts), because a vertex genuinely holds one and
//     rendering a single label by default would be the lossy answer. These scenarios describe a
//     provider that chose differently.
//
// ── 2. NOT YET — in scope the moment the work lands, so revisit with it ────────────────────────
//
//   @GraphComputerOnly — NO LONGER EXCLUDED (2026-08-22). These scenarios run the four OLAP steps
//     (pageRank/connectedComponent/peerPressure/shortestPath), which now have an OLTP compile-to-SQL
//     execution (`docs/archive/2026-07-24-graph-algorithms-plan.md`). The runner sets isGraphComputer and calls
//     `.withComputer()`, which the JS GLV serializes to `withStrategies(VertexProgramStrategy(...))`;
//     that parses (withStrategies is grammar) and `VertexProgramStrategy` is now a NO_OP_STRATEGIES
//     entry (the graph-computer choice is inert for compile-to-SQL OLAP), so the query runs. The
//     scenarios whose algorithm is LANDED pass and raise the floor (connectedComponent's default-edge
//     forms today); the rest fail CLOSED (a clear deferral — pageRank/peerPressure/shortestPath compute,
//     connectedComponent's custom edge scope) and are simply not in the floor, exactly the "in scope,
//     failing deliberately" stance io()'s source scenarios take. Nothing here is an architectural wall.
//
// ── 3. THE HARNESS NEVER ASKS — nothing to do with us ──────────────────────────────────────────
//
//   @StepWrite, @AllowNullPropertyValues, @MultiLabelDefault, @DataChar, @DataDuration.
//   The vendored cucumber runner hard-skips each of these itself (`Before({tags: …}, () =>
//   'skipped')` in gremlin-js's world.js). A skipped scenario never issues its traversal, so our
//   harness — which counts a scenario as passing only if every step reports `passed` — would carry
//   it as a permanent zero. Excluding them keeps the denominator to what the harness can actually
//   adjudicate; counting them as gaps in OUR engine would be a lie either way.
//   `runner-skips.test.ts` asserts this list stays equal to the runner's, so if a fork fix or an
//   upstream bump makes one of them runnable we hear about it instead of silently keeping it out.
//   NB @MultiLabelDefault is skipped by ALL THREE GLVs, and gremlin-go says why: "The GLV suite does
//   not test against a graph that defaults to multi-label output." That is a fixable upstream gap
//   (a multi-label-default traversal source in the test server config), tracked as item 19b — not,
//   as this file previously said, a stub deletable in four lines.
//
//   By NAME, two more of the same standing: upstream's `IgnoreError` map (`IGNORED_SCENARIOS`) and
//   the GLV-lossy scenarios (`GLV_LOSSY`), whose generated client traversal is not the `.feature`'s
//   question — both derived from upstream's own files, never listed by hand.
//
// ── Everything else in scope that fails is LEDGERED ────────────────────────────────────────────
//
// `expected-outcomes.ts` names every remaining failure with its kind (divergence / wall / decline /
// defect) and the document that authorizes it, and the ledger must equal the failing set exactly. A
// wall stays IN the denominator there — it is our capability, so it counts against us, named.
//
// ── Not excluded, and a standing trap ──────────────────────────────────────────────────────────
//
// @StepWrite is io().write() graph SERIALIZATION (sideEffect/Write.feature: kryo/graphson to file),
// NOT the data-write steps. Those carry @StepAddV/@StepAddE/@StepMergeV/@StepMergeE and are IN
// scope, guarded by the ratchet. The io() SOURCE (`io(...).read()`, 6 scenarios) is also in scope
// and currently failing — deliberately, because we want to support it; do not descope it to tidy
// the number.
//
// @MultiLabel itself stays firmly in scope — 60 of its 67 in-scope scenarios pass.

/** Tags whose scenarios the vendored cucumber runner refuses to run at all. Kept as data so
 *  `runner-skips.test.ts` can compare it against world.js and fail when the two drift. */
export const RUNNER_SKIPPED = [
  '@StepWrite', '@AllowNullPropertyValues', '@MultiLabelDefault', '@DataChar', '@DataDuration',
] as const;

/** Tags we exclude by our own decision — see categories 1 and 2 above. */
export const OUR_EXCLUSIONS = [
  '@StepSample', '@StepCoin', '@SingleLabelDefault',
] as const;

export const L3_TAGS = [...OUR_EXCLUSIONS, ...RUNNER_SKIPPED].map((t) => `not ${t}`).join(' and ');

/**
 * SCENARIOS EXCLUDED BY NAME, because they assert a capability this graph DECLARES IT DOES NOT HAVE.
 *
 * **mogwai-db is multi-label only** (`src/api.ts`): a vertex carries a SET of labels, always. That is
 * the property graph everyone else means — a Neo4j node holds a set — and exactly-one-vertex-label is
 * the TinkerPop 3 constraint that v4's `LabelCardinality` exists to lift. We declare `ZERO_OR_MORE`
 * and carry no other regime.
 *
 * Every scenario below provisions a single-label graph and asserts the refusal that follows from it.
 * They cannot pass, and that is a DECLARED WALL rather than a regression — the same standing as the
 * 128-bit arithmetic and 32-bit float walls. Counting them as gaps in our engine would be a lie in
 * the same way `@MultiLabelDefault` would be.
 *
 * BY NAME rather than by tag because upstream does not tag them: the regime is expressed in the
 * scenario NAME (`*_single_label_graph`) and in which graph the step routes to. A cucumber tag
 * expression cannot say that, so the filter lives where the report is read — it removes them from
 * the DENOMINATOR as well, exactly as a tag exclusion does, rather than parking them as permanent
 * failures.
 */
export const EXCLUDED_SCENARIOS: ReadonlySet<string> = new Set([
  'g_V_addLabelXa_bX_single_label_graph',
  'g_V_addLabelXemployeeX_single_label_graph',
  'g_V_dropLabelXpersonX_single_label_graph',
  'g_V_dropLabels_single_label_graph',
  'g_mergeVXlabel_ab_name_markoX_single_label_graph',
  'g_mergeVXlabel_person_name_markoX_optionXonCreate_label_abX_single_label_graph',
  'g_mergeVXlabel_person_name_markoX_optionXonMatch_label_managerX_single_label_graph',
]);

/** Whether the report should ignore this scenario entirely — see `EXCLUDED_SCENARIOS`. */
export const isExcludedScenario = (name: string): boolean => EXCLUDED_SCENARIOS.has(name);

/**
 * SCENARIOS THE UPSTREAM RUNNER ITSELF IGNORES — gremlin-js's `IgnoreError` map (float- and
 * uuid-serialization-unstable scenarios the reference refuses to adjudicate). Category 3, like the
 * runner-skipped TAGS: our engine may well produce the right answer (the instability is in the
 * corpus's own expected value — e.g. a pageRank(1.0) whose .feature float noise upstream flags), so
 * counting one as OUR failure would be a lie.
 *
 * Sourced DIRECTLY from `feature-steps.js` (parsed, not copied) so it cannot drift from upstream: a pin
 * bump that adds or drops an IgnoreError is reflected on the next run. Our own cucumber runner does not
 * replay gremlin-js's scenario-map path (it reads the docstring — `test/CLAUDE.md`), so the map's own
 * `'skipped'` return never fires; excluding by name is the equivalent, and it is deterministic.
 */
export const IGNORED_SCENARIOS: ReadonlySet<string> = (() => {
  const src = readFileSync(new URL('../../vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/feature-steps.js', import.meta.url), 'utf8');
  return new Set([...src.matchAll(/'([^']+)':\s*new IgnoreError/g)].map((m) => m[1]));
})();

/** Why a scenario's GENERATED CLIENT TRAVERSAL cannot ask the question its `.feature` asks. */
export type GlvLoss =
  /** `gremlin.js` calls `uuid.parse(…)`/`uuid.v4()` but never imports `uuid`, so the scenario dies
   *  CLIENT-side with `uuid is not defined` before a query is sent (patches/upstream 01). */
  | 'uuid-unimported'
  /** The `.feature` writes a Long literal (`1L`) and asks for its TYPE (`GType.LONG`), but the JS
   *  translator renders it as a bare `1`, so the server receives an Int (patches/upstream 08). */
  | 'long-literal-bare';

const GREMLIN_JS = new URL('../../vendor/tinkerpop/gremlin-js/gremlin-javascript/test/cucumber/gremlin.js', import.meta.url);
const FEATURES_DIR = new URL('../../vendor/tinkerpop/gremlin-test/src/main/resources/org/apache/tinkerpop/gremlin/test/features/', import.meta.url);

/** `gremlin.js` → scenario name → its translated traversal(s), one entry per generated line. */
export function gremlinJsEntries(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/^ {4}(\w+): \[(.*)\], *$/gm)) out.set(m[1], m[2]);
  return out;
}

/** `.feature` text → scenario name → the concatenated docstrings (initializer + traversal). Repeated
 *  names concatenate, since the exclusion is by name either way. */
export function featureDocstrings(texts: Iterable<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const text of texts) for (const block of text.split(/\n\s*Scenario(?: Outline)?: /).slice(1)) {
    const name = block.slice(0, block.indexOf('\n')).trim();
    const docs = [...block.matchAll(/"""([\s\S]*?)"""/g)].map((m) => m[1]).join('\n');
    out.set(name, (out.get(name) ?? '') + docs);
  }
  return out;
}

/**
 * Derive the GLV-lossy scenarios from upstream's own text — the generated `gremlin.js` and the
 * `.feature` corpus — rather than listing them. Each rule names a defect in the GENERATED CLIENT, so
 * an upstream fix (an `import … uuid`, a translator that emits `toLong(1)`) empties its rule on the
 * next pin bump and the scenarios come back into scope with no edit here.
 *
 * `long-literal-bare` is NARROW on purpose: a bare `1` for `1L` is harmless wherever the query never
 * observes the class (`V(1L)`, `limit(2L)` all pass), and excluding a passing scenario would shrink
 * the floor. The one observer is `GType.LONG`, so only a scenario that both writes the literal and
 * asks for that type is unadjudicable.
 */
export function deriveGlvLossy(gremlinJs: string, docstrings: ReadonlyMap<string, string>): Map<string, GlvLoss> {
  const out = new Map<string, GlvLoss>();
  const importsUuid = /^\s*import\b[^\n]*\buuid\b/m.test(gremlinJs);
  for (const [name, translated] of gremlinJsEntries(gremlinJs)) {
    if (!importsUuid && /\buuid\.\w+\(/.test(translated)) { out.set(name, 'uuid-unimported'); continue; }
    const docs = docstrings.get(name);
    if (!docs || !/\bGType\.LONG\b/.test(docs)) continue;
    const longs = [...docs.matchAll(/(?<![\w.])(-?\d+)[lL]\b/g)].map((m) => m[1]);
    // Bare = the digits as a number token of their own: not inside a string or a longer number, and
    // not already wrapped as `toLong(…)`/`new Long(…)` (the fixed translator's spelling).
    if (longs.some((n) => new RegExp(`(?<![\\w.'"])(?<!Long\\()${n}(?![\\w.])`).test(translated))) out.set(name, 'long-literal-bare');
  }
  return out;
}

/**
 * SCENARIOS THE GENERATED JS CLIENT CANNOT ASK — category 3 again, beside `IGNORED_SCENARIOS` and with
 * the same standing: the traversal that reaches the server is not the one the `.feature` describes
 * (or none reaches it at all), so its verdict says nothing about our engine. Derived, not listed —
 * see `deriveGlvLossy`; `runner-skips.test.ts` re-derives every name. The two upstream fixes are
 * `patches/upstream/tinkerpop-01-…` and `…-08-…`.
 */
export const GLV_LOSSY: ReadonlyMap<string, GlvLoss> = (() => {
  const features = [...new Bun.Glob('**/*.feature').scanSync(FEATURES_DIR.pathname)]
    .map((f) => readFileSync(new URL(f, FEATURES_DIR), 'utf8'));
  return deriveGlvLossy(readFileSync(GREMLIN_JS, 'utf8'), featureDocstrings(features));
})();

/** Whether the harness cannot adjudicate this scenario — upstream's `IgnoreError` map, or a GLV-lossy
 *  translation (`GLV_LOSSY`). It leaves the L3 denominator, exactly as a runner-skipped tag does. */
export const isIgnoredScenario = (name: string): boolean => IGNORED_SCENARIOS.has(name) || GLV_LOSSY.has(name);

/** Whether a scenario is outside the L3 report altogether — a DECLARED WALL (`EXCLUDED_SCENARIOS`) or
 *  one the harness cannot adjudicate (`isIgnoredScenario`). The ONE predicate the live count, the
 *  scenario rows and the recorded floor all filter by, so the three cannot disagree on scope. */
export const isOutOfScope = (name: string): boolean => isExcludedScenario(name) || isIgnoredScenario(name);
