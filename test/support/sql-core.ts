import type { GraphStore } from '../../src/storage.ts';

/**
 * The two mechanical halves of the RelIR equivalence gate (§5a of
 * `docs/2026-08-01-relir-build-plan.md`): **same results, same access path, never spelling.**
 *
 * They live in `test/support/` rather than beside one test because the gate is declared for
 * Phases 2–3 as well as for Phase 1's exit criterion, and a comparison two levels need that lives
 * inside one of them is how a third consumer ends up hand-rolling a copy.
 */

/**
 * The RELATIONAL CORE of a compiled read plan: its CTE chain, with the result-framing `SELECT`
 * replaced by `SELECT * FROM <last cte>`.
 *
 * A compiled plan is `with c0(…) as (…), c1(…) as (…) <framing SELECT>`, where the CTE chain is
 * the traverser stream and the trailing SELECT materializes Gremlin's shape (labels, property
 * maps, typed envelopes). RelIR sits BELOW that framing — §2 keeps shape out of the algebra
 * entirely — so the core is the part a hand-built plan is answerable for, and taking it by
 * structure rather than by hand is what stops the gate degrading into a transcription of the
 * emitter's own output — which is exactly what an earlier "gate" was, and why §5a's two properties
 * (same results, same access path) replaced byte-identity.
 *
 * Returns `undefined` for a plan with no CTE chain (nothing to isolate) or a `WITH RECURSIVE` one
 * (the recursive families are Phase 3's, and their core is the CTE itself).
 */
export function relationalCore(sql: string): string | undefined {
  if (!/^with\s/i.test(sql) || /^with\s+recursive\b/i.test(sql)) return undefined;
  let i = 4;
  let last: { name: string; end: number } | undefined;
  const skipSpace = (): void => { while (i < sql.length && /\s/.test(sql[i]!)) i++; };
  const skipBalanced = (): boolean => {
    if (sql[i] !== '(') return false;
    let depth = 0;
    for (; i < sql.length; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')' && --depth === 0) { i++; return true; }
    }
    return false;
  };
  for (;;) {
    skipSpace();
    const start = i;
    while (i < sql.length && sql[i] !== '(') i++;
    const name = sql.slice(start, i).trim();
    if (!name || !skipBalanced()) return undefined;
    skipSpace();
    if (!/^as\b/i.test(sql.slice(i))) return undefined;
    i += 2;
    skipSpace();
    if (!skipBalanced()) return undefined;
    last = { name, end: i };
    skipSpace();
    if (sql[i] === ',') { i++; continue; }
    break;
  }
  return last && `${sql.slice(0, last.end)} SELECT * FROM ${last.name}`;
}

/**
 * The INDEX DECISIONS in a query's `EXPLAIN QUERY PLAN`, as a sorted multiset.
 *
 * Object names are dropped and CTE-materialization lines (`CO-ROUTINE`, `MATERIALIZE`, and the
 * scan OF a materialized CTE) are excluded, for one reason each: an alias is spelling, and
 * CTE-versus-inline is the `Name` pass's declared decision (§4.6), so neither is a change of
 * access path. What survives is exactly what §5a is protecting — which index SQLite chose, whether
 * it scanned or searched, and every sort or dedup it had to materialize a B-tree for.
 */
export function accessPaths(store: GraphStore, sql: string, binds: readonly any[]): readonly string[] {
  const rows = store.query(`EXPLAIN QUERY PLAN ${sql}`, [...binds]) as readonly { readonly detail: string }[];
  const paths: string[] = [];
  const ctes = new Set<string>();
  for (const { detail } of rows) {
    const coroutine = /^(?:CO-ROUTINE|MATERIALIZE)\s+(\S+)/.exec(detail);
    if (coroutine) { ctes.add(coroutine[1]!); continue; }
    const search = /^(SEARCH|SCAN)\s+(\S+)(?:\s+\S+)?\s+USING\s+(COVERING\s+)?(?:INDEX\s+(\S+)|INTEGER PRIMARY KEY)/.exec(detail);
    if (search) { paths.push(`${search[1]} ${search[3] ? 'COVERING ' : ''}${search[4] ?? 'ROWID'}`); continue; }
    const scan = /^SCAN\s+(\S+)$/.exec(detail);
    if (scan) { if (!ctes.has(scan[1]!)) paths.push('SCAN'); continue; }
    if (detail.startsWith('USE TEMP B-TREE')) paths.push(detail);
  }
  return paths.sort();
}
