// L3 scope: the whole official suite minus what we deliberately don't support —
// io().write() serialization, GraphComputer/OLAP-only, null-property exotica, and
// the non-deterministic sampling steps (random order would make the ratchet flaky).
// NB @StepWrite is the io().write() graph-SERIALIZATION step (sideEffect/Write.feature:
// kryo/graphson to file), NOT the data-write steps. The data-write steps carry
// @StepAddV/@StepAddE/@StepMergeV/@StepMergeE (AddVertex/AddEdge/MergeVertex/MergeEdge)
// — untagged here, so they are already IN scope and the ratchet guards them.
// @SingleLabelDefault / @MultiLabelDefault are MUTUALLY EXCLUSIVE provider declarations, not a
// capability we are missing: upstream ships both variants of each default-label-rendering scenario
// over the same initializer and the same traversal, differing only in the expected shape, and a
// provider runs whichever matches what it declares. mogwai-db declares MULTI-LABEL default (a
// vertex genuinely holds a set, so rendering one of them by default would be the lossy answer —
// see `labelRegime` in src/api.ts), so the 7 @SingleLabelDefault scenarios describe a different
// provider and can never pass here. Excluding them is a feature-requirement exclusion of the same
// kind as @GraphComputerOnly — NOT descoping a gap to improve the number, which is why
// @MultiLabel itself stays firmly in scope.
export const L3_TAGS =
  'not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues' +
  ' and not @StepSample and not @StepCoin and not @SingleLabelDefault';
