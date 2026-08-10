// Known raw failures reached by the independent shape-table witnesses. These are
// deliberately separate from the corpus census: this table covers generated,
// well-typed compositions the corpus may never contain. Additions require a
// diagnosis; removals are improvements.
//
// Every entry is a FIXED QUERY STRING and `capability.test.ts` runs all of them unconditionally,
// which is what makes "this no longer reproduces" a statement the ratchet can actually make. It
// used to check the list only against the queries the SEED happened to draw, so a fixed entry and
// an undrawn one were the same observation — and one entry sat here fixed while every run printed
// the ambiguous "not drawn by this seed". That entry
// ("no such column: edges.label" on a repeat().dedup() witness) is deleted with this note as its
// only trace: it also carried no diagnosis, which the header above already forbade.
export const KNOWN_RAW_WITNESSES: ReadonlyMap<string, string> = new Map([
  // EMPTY. The removed witness was a bounded repeat in a child scope retyping a live linear path to
  // the recursive array regime, then failing its parent cardinality rejoin. The rolled diagnosis was
  // correct but is now unreachable: bounded times(n) unrolls to ordinary movement, so no walk exists
  // to retype the path. The mismatch itself is not claimed fixed; an unbounded child walk may earn a
  // new witness when that regime grows path-channel support.
]);
