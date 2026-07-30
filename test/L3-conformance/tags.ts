// L3 scope: the whole official suite minus what we deliberately don't support —
// io().write() serialization, GraphComputer/OLAP-only, null-property exotica, and
// the non-deterministic sampling steps (random order would make the ratchet flaky).
// NB @StepWrite is the io().write() graph-SERIALIZATION step (sideEffect/Write.feature:
// kryo/graphson to file), NOT the data-write steps. The data-write steps carry
// @StepAddV/@StepAddE/@StepMergeV/@StepMergeE (AddVertex/AddEdge/MergeVertex/MergeEdge)
// — untagged here, so they are already IN scope and the ratchet guards them.
// @SingleLabelDefault / @MultiLabelDefault are MUTUALLY EXCLUSIVE provider declarations of how
// elementMap()/valueMap(true) render T.label by DEFAULT. Upstream ships both variants of each such
// scenario over the same initializer and the same traversal, differing only in the expected shape.
// BOTH are out of scope here, for two different reasons:
//
//   @SingleLabelDefault — mogwai-db declares MULTI-LABEL default (a vertex genuinely holds a set,
//     so rendering one of them by default would be the lossy answer — `labelRegime`, src/api.ts).
//     These describe a different provider, so they are a feature-requirement exclusion of the same
//     kind as @GraphComputerOnly.
//   @MultiLabelDefault — the VENDORED JS runner hard-skips them itself:
//     `Before({tags: "@MultiLabelDefault"}, () => 'skipped')` in gremlin-js's world.js, alongside
//     @StepWrite/@DataChar/@DataDuration. A skipped scenario never issues its traversal, so it can
//     never pass no matter what we declare — counting it as a gap in OUR engine would be a lie.
//     That skip looks like an upstream stub rather than a real limitation (the other three are
//     genuinely unsupported); it is tracked as fork work in docs/outstanding-work.md.
//
// @MultiLabel itself stays firmly in scope — this is not descoping a gap to improve the number.
export const L3_TAGS =
  'not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues' +
  ' and not @StepSample and not @StepCoin' +
  ' and not @SingleLabelDefault and not @MultiLabelDefault';
