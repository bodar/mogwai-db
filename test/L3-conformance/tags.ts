// L3 scope: the whole official suite minus what we deliberately don't support —
// io().write() serialization, GraphComputer/OLAP-only, null-property exotica, and
// the non-deterministic sampling steps (random order would make the ratchet flaky).
// NB @StepWrite is the io().write() graph-SERIALIZATION step (sideEffect/Write.feature:
// kryo/graphson to file), NOT the data-write steps. The data-write steps carry
// @StepAddV/@StepAddE/@StepMergeV/@StepMergeE (AddVertex/AddEdge/MergeVertex/MergeEdge)
// — untagged here, so they are already IN scope and the ratchet guards them.
export const L3_TAGS =
  'not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues' +
  ' and not @StepSample and not @StepCoin';
