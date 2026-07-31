// Known raw failures reached by the independent shape-table witnesses. These are
// deliberately separate from the corpus census: this table covers generated,
// well-typed compositions the corpus may never contain. Additions require a
// diagnosis; removals are improvements.
export const KNOWN_RAW_WITNESSES: ReadonlyMap<string, string> = new Map([
  [
    "g.V(1).where(__.identity()).has('age').hasId(2).repeat(__.both('created').in('created')).times(1).dedup()",
    'no such column: edges.label',
  ],
  [
    // A repeat() in a CHILD scope RETYPES the carried path from the linear `cols` regime (p0, p1,
    // …) to its own recursive `array` accumulator, because the live `simplePath()` makes the walk
    // path-tracking. The parent's layout still declares the POSITION columns, and the cardinality
    // rejoin projects the parent's declared carried schema off the CHILD relation — which now
    // carries `path` and no `p0`. `rel.c.p0` resolves to `undefined`, splicing an empty string into
    // the record rejoin: `c7(…, p0) as (SELECT …, b0.bulk, FROM c6 b0)`.
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
    'near "FROM": syntax error',
  ],
]);
