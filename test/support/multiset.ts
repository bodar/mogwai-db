import type { Framed } from '../../src/execute.ts';

/**
 * A traverser multiset, keyed by the GraphBinary encoding of the value and valued by total bulk.
 *
 * This is the ONLY comparison that can hold across the movement-collapse switch. Collapse emits one
 * row carrying `SUM(bulk)`; the generic UNION-ALL form emits `bulk` separate rows ("same result, more
 * rows", per the flag's own comment). Both denote the same multiset of traversers, so summing bulk per
 * distinct value is what makes them comparable — and it is also just what a traverser multiset IS
 * (root `CLAUDE.md`: "Traversers are multisets"). Expanding bulk into literal copies would be
 * equivalent but is not an option: collapse exists precisely because the walk count it folds up can be
 * exponential.
 *
 * ## Why it lives in `test/support/` and not in either caller
 *
 * L5's differential oracle (`L5-properties/oracle.ts`) and the census (`census/census.ts`) both need
 * it, so it lives in neither — the same rule `test/support/graph.ts` already follows for the shared
 * seeds.
 *
 * That is not tidiness. The census had its own answer digest which folded bulk in **per row**
 * (`hex[i]*bulk`, sorted) under a comment claiming it "denotes the traverser MULTISET, exactly what
 * oracle.ts's `weigh()` compares". It did not: `{a, b, b, b}` emitted as four bulk-1 rows and the same
 * multiset emitted as `(a,1),(b,3)` hash differently, so the answer-change gate — the one instrument
 * §7.5 of `docs/archive/2026-08-09-repeat-two-regimes-plan.md` names as THE gate for collapse work — reported a
 * changed answer for every traversal that merely started collapsing. Two readings of one fact, and the
 * wrong one was load-bearing.
 */
export function weigh(framed: readonly Framed[]): ReadonlyMap<string, bigint> {
  const m = new Map<string, bigint>();
  for (const f of framed) {
    const k = f.buf.toString('hex');
    m.set(k, (m.get(k) ?? 0n) + f.bulk);
  }
  return m;
}

/** The multiset as a stable string — sorted `value*totalBulk` pairs. What a digest hashes. */
export const multisetKey = (framed: readonly Framed[]): string =>
  [...weigh(framed)].map(([hex, bulk]) => `${hex}*${bulk}`).sort().join('|');

// ---------- the same fact one layer lower: a RAW SQL ROW set ----------
//
// `weigh` compares FRAMED results, keyed by GraphBinary bytes. Several compiler tests compare the rows
// a plan returns BEFORE framing — either across the two spines or against a law — and they need the
// identical rule, because a row is not a traverser: a collapsed row carries `bulk: N` and denotes N of
// them. §7.5 of `docs/archive/2026-08-09-repeat-two-regimes-plan.md` states the consequence directly — *"`n`
// (the row count) legitimately moves under a collapse and is deliberately NOT gated; `ms` is what the
// answer gate reads"* — so a test that counts ROWS is asserting a lowering decision, not an answer.
//
// It lives here for the reason the header already gives: two callers, so it belongs to neither. RelIR
// now decides the collapse per POSITION, which makes the spelling differ between spines far more often
// than it used to, and every such difference reads as a broken test until the comparison is stated in
// traversers.

/** A raw row's traverser weight. NO `bulk` column means ONE traverser — what the framer does with an
 *  uncollapsed row, and the ordinary case for most plans on either spine. */
export const rowBulk = (row: { readonly bulk?: number | bigint }): bigint =>
  row.bulk === undefined ? 1n : BigInt(row.bulk);

/** How many TRAVERSERS a raw row set denotes — the count a law about cardinality means. */
export const traverserCount = (rows: readonly { readonly bulk?: number | bigint }[]): number =>
  Number(rows.reduce((total, row) => total + rowBulk(row), 0n));

/** A raw row set as a traverser multiset: sorted `value*totalBulk`, with `bulk` excluded from the
 *  value so the same traversers compare equal however the plan spelled them. Summing per distinct
 *  value is not a weakening — it is what a multiset IS (root `CLAUDE.md`: "Traversers are
 *  multisets") — and it keeps every real multiplicity under assertion, which is what the
 *  trimmed-bulk slices depend on: a total of 2 against 3 still fails. */
export const rowMultiset = (rows: readonly any[]): readonly string[] => {
  const weighed = new Map<string, bigint>();
  for (const row of rows) {
    const { bulk: _bulk, ...value } = row as { readonly bulk?: number | bigint };
    const key = JSON.stringify(value);
    weighed.set(key, (weighed.get(key) ?? 0n) + rowBulk(row));
  }
  return [...weighed].map(([key, total]) => `${key}*${total}`).sort();
};
