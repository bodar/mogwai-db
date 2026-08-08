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
//   @GraphComputerOnly (6) — and this is NOT an architectural wall, which is what this file used to
//     imply. `docs/2026-07-24-graph-algorithms-plan.md` verified that GraphComputer is not removed
//     in TinkerPop 4, that the v4 LANGUAGE carries the four OLAP step names with no execution
//     surface, and that "that gap is exactly what we fill" by giving them an OLTP compile-to-SQL
//     execution. Four of the six ARE those four steps — g_V_pageRank_hasXpageRankX,
//     g_V_peerPressure_hasXclusterX, g_V_connectedComponent_hasXcomponentX, g_V_shortestPath — and
//     that doc explicitly expects them back "as a give-back" when item 8 lands. The runner does not
//     skip this tag (it sets isGraphComputer and calls .withComputer()), so the exclusion is
//     load-bearing today and should be NARROWED, not deleted, when item 8 lands: the remaining two
//     are @WithVertexProgramStrategy, which do need a real VertexProgram surface.
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
  '@GraphComputerOnly', '@StepSample', '@StepCoin', '@SingleLabelDefault',
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
