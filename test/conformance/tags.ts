// L3 scope: the whole official suite minus what we deliberately don't support —
// io().write() serialization, GraphComputer/OLAP-only, null-property exotica, and
// the non-deterministic sampling steps (random order would make the ratchet flaky).
export const L3_TAGS =
  'not @StepWrite and not @GraphComputerOnly and not @AllowNullPropertyValues' +
  ' and not @StepSample and not @StepCoin';
