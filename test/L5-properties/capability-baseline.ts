// Known raw failures reached by the independent shape-table witnesses. These are
// deliberately separate from the corpus census: this table covers generated,
// well-typed compositions the corpus may never contain. Additions require a
// diagnosis; removals are improvements.
export const KNOWN_RAW_WITNESSES: ReadonlyMap<string, string> = new Map([
  [
    "g.V(1).where(__.identity()).has('age').hasId(2).repeat(__.both('created').in('created')).times(1).dedup()",
    'no such column: edges.label',
  ],
]);
