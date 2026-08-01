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
  [
    // A repeat() in a CHILD scope RETYPES the carried path from the linear `cols` regime (p0, p1,
    // …) to its own recursive `array` accumulator, because the live `simplePath()` makes the walk
    // path-tracking. The parent's layout still declares the POSITION columns, and the cardinality
    // rejoin projects the parent's declared carried schema off the CHILD relation — which now
    // carries `path` and no `p0`.
    //
    // It used to SPLICE AN EMPTY STRING there (`c7(…, p0) as (SELECT …, b0.bulk, FROM c6 b0)`) and
    // ship malformed SQL for the database to reject — the one fail-closed VIOLATION in P3. It now
    // DEFERS: `layoutProjection` (steps/context/context.ts) checks that a relation declares each
    // carried column it is asked to project, which is the same rejoin-crossing mismatch nothing
    // else could assert. The capability gap below is unchanged; only its failure mode is.
    //
    // Minimal repro — none of `elementMap`, `filter` or the second `by()` is load-bearing:
    //   g.V(1).simplePath().project('a').by(__.repeat(__.in('knows')).times(2))
    //
    // NOT fixable by declining at the repeat: the same condition (trackArray + a live linear path +
    // a child scope) also holds for `local(__.repeat(…))` and `where(__.repeat(…))` under a
    // `simplePath()`, and BOTH of those execute correctly today — their rejoins do not project the
    // parent's positions off the child. Measured; a guard there regresses two working shapes. The
    // real fix is for a child body to restore the parent's path regime across the rejoin, which is
    // path-history-substrate work. Tracked in docs/outstanding-work.md P3 "Recursive-path tails".
    "g.V(1).simplePath().hasId(2).has('lang').project('a', 'b').by(__.filter(__.elementMap().fold()).repeat(__.in('knows')).times(2)).by(__.not(__.out('knows')).hasId(7).has('age', P.lt(2)))",
    "carried 'p0' is not present on the relation being rejoined — a child body that retypes or drops carried state cannot rejoin at parent cardinality",
  ],
]);
