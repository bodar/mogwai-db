// The cucumber `--tags` expression that scopes the L3 suite to the step set
// mogwai-db implements. This IS the ratchet lever: widen it as new steps land
// (P2+/W*), never narrow it. `@StepWrite` is the io().write() graph-serialization
// feature (out of scope), NOT our element writes (those are @StepAddV/@StepAddE/
// @StepMergeV/@StepMergeE). @GraphComputerOnly/@AllowNullPropertyValues are
// upstream-skipped exotica.
export const L3_TAGS =
  '(@StepCount or @StepHasLabel or @StepHas or @StepValues or @StepId or @StepLabel' +
  ' or @StepDedup or @StepLimit or @StepRange or @StepOrder or @StepValueMap or @StepElementMap' +
  ' or @StepDrop or @StepInject or @StepSelect or @StepProject or @StepOut or @StepIn or @StepBoth' +
  ' or @StepHasId or @StepMin or @StepMax or @StepMean' +
  ' or @StepProperties or @StepGroup or @StepGroupCount or @StepFold or @StepSum or @StepIs' +
  ' or @StepWhere or @StepNot or @StepFilter or @StepAnd or @StepOr or @StepUnion or @StepOptional' +
  ' or @StepRepeat or @StepAddV or @StepAddE or @StepMergeV or @StepMergeE)' +
  ' and not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues';
