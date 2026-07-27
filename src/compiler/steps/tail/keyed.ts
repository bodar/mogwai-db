import { q, type Relation } from '../../../sql/kernel/q.ts';
import { nodes } from '../../../sql/schema.ts';
import { type Elem } from '../../plan/plan.ts';
import { type PStep } from '../../ir/strategies.ts';
import { type Carried, type ElementStream } from '../context/context.ts';
import { engineOf } from '../../engine/deps.ts';
import { childCtx, isElementChildStep, mentionsLabel } from './child-shape.ts';

// ---------- the KEYED CHILD RELATION: provision once, join on the key ----------
//
// The compiler has three ways to provision a child body, and they differ in WHERE the
// child's input comes from — not in how SQL is rendered (there are exactly two rendering
// modes and both live in the kernel; see `src/sql/CLAUDE.md`):
//
//   • a PARENT STREAM        — `pushChildScope` projects the parent's rows as the child's
//                              domain and `applyChildCardinality` rejoins by ordinal.
//   • an OUTER ROW           — `compileCorrelatedChild` (correlated.ts) seeds from an
//                              expression referencing the row being filtered.
//   • a KEYED RELATION (here) — the body is compiled ONCE over its WHOLE domain, carrying
//                              its origin as a key column, and the consumer JOINS on that
//                              key. Nothing about it is correlated, so it composes where
//                              the other two cannot.
//
// The third exists because of a hard SQLite constraint: a recursive term's FROM cannot
// reference the row being recursed over (no `LATERAL`), so a FAN-OUT body inside a
// recursive CTE cannot be correlated at all. But a recursive term MAY legally reference a
// NON-recursive CTE — so compile the body once, seeded from every vertex, and join. That
// turns `repeat()`'s vocabulary wall into a performance trade-off instead of a `throw`,
// and it is why no third RENDERING mode was ever needed (measured:
// `docs/2026-07-27-hand-rolled-sql-audit.md`).
//
// The COST is the trade-off, not a defect: this materializes the body over the whole vertex
// set (|V| x fanout) where a frontier walk expands lazily. So a caller that HAS a lazy fast
// path keeps it and uses this as the fallback — the fast-path contract the project already
// runs on (`options/fast-paths.ts`).
//
// WHAT MUST STAY OUT, and why each is a semantic wall rather than a missing feature:
//
//   • A PER-ITERATION GLOBAL BARRIER (dedup/limit/range/order/sample/tail/group/aggregate)
//     observes the whole frontier at one iteration. Precomputing it per-origin answers a
//     DIFFERENT question — a global `dedup()` drops a vertex two origins both reach, a
//     per-origin one keeps both. Note the generic StepFns would happily lower it (bare
//     `dedup` emits `SELECT DISTINCT id, <carried>`, and with an origin column in the tuple
//     that silently becomes per-origin), so the gate cannot be "whatever lowerElementSteps
//     accepts" — it is the ROW-LOCAL vocabulary, which already exists as
//     `isElementChildStep` (the same predicate the child seam uses for this property).
//   • A LABEL. The domain is every vertex, not the caller's rows, so there is no outer row
//     to read an alias column FROM — and an absent alias column is indistinguishable from a
//     never-bound label, which `select()` answers as "drop every traverser". That is a
//     silently wrong answer, so a body MENTIONING a label declines here, exactly as the
//     inline correlated renderer does when it has no LabelScope. (Measured before this
//     guard existed: `g.V().as("a").repeat(__.out().where(__.select("a"))).times(1)`
//     returned 0 rows where the same body outside `repeat()` returns 6.)
//   • A BIND made inside the body — per-iteration by definition, so it cannot be precomputed.

/** A child body compiled once over its whole domain, keyed by origin. `key`/`value` are
 *  COLUMN NAMES on `rel` — read them rather than hardcoding, so the projection stays this
 *  module's business. */
export interface KeyedRelation {
  /** Registered in the caller's `Query`, so it shares the outer WITH and a recursive term
   *  may join it. */
  readonly rel: Relation;
  /** Column: the origin element the body started from — what a consumer joins ON. */
  readonly key: string;
  /** Column: the element the body arrived at. */
  readonly value: string;
  /** What `value` is an id OF. */
  readonly elem: Elem;
}

/**
 * Compile a ROW-LOCAL element body ONCE over every vertex, keyed by its origin, so a
 * consumer can JOIN on the key instead of correlating. Returns null — never throws — when
 * the body is outside the row-local vocabulary or would need a label, so the caller keeps
 * its own deferral or falls through to a fast path. See the header for what is excluded and
 * why each exclusion is a wall rather than a gap.
 *
 * `landOn` constrains the element the body must end on (a walk id is a vertex rowid, so
 * `repeat()` passes 'node'); omit it when the consumer only cares that rows exist.
 */
export function keyedChildRelation(
  st: ElementStream,
  body: readonly PStep[],
  opts: { landOn?: Elem } = {},
): KeyedRelation | null {
  // `childCtx(st)` supplies the labels visible at the call site so a body is classified
  // against the real environment; the label DECLINE below is what keeps that honest, since
  // the seed cannot physically carry those columns.
  const ctx = childCtx(st);
  if (!body.length || !body.every((c) => isElementChildStep(c, ctx))) return null;
  if (mentionsLabel(body, st.params)) return null;
  // Seed: one row per vertex, its own id doubling as the origin key. `origins` is the
  // carried slot designed for "which traverser did this row come from" and rides through
  // movement/filter/branch via carryFrag, so nothing here threads it by hand. Column ORDER
  // must match carriedCols (aliases, sack, bulk, origins, …) or assertStreamColumns trips.
  const seedCarried: Carried = { aliases: new Map(), origins: ['o'], bulk: 'bulk' };
  const seed: ElementStream = {
    kind: 'elements', q: st.q, params: st.params, elem: 'node',
    rel: st.q.cte(q`SELECT id, 1 AS bulk, id AS o FROM ${nodes}`, ['id', 'bulk', 'o']),
    carried: seedCarried,
  };
  const { stream, next } = engineOf(st).lowerElementSteps(body as PStep[], seed);
  if (next !== body.length) return null;                            // a step the prefix fold won't take
  if (opts.landOn && stream.elem !== opts.landOn) return null;
  // A body that BINDS a label cannot be precompiled per-origin — the bind is per-iteration.
  if (stream.carried.aliases.size) return null;
  if (stream.carried.origins.length !== 1 || stream.carried.origins[0] !== 'o') return null;
  const b = stream.rel.as('rb');
  // No DISTINCT: traversers are a MULTISET, so two parallel edges must stay two rows. A
  // consumer wanting set semantics asks for it explicitly — see keyedKeySet.
  return {
    rel: st.q.cte(q`SELECT ${b.c.o} AS from_id, ${b.c.id} AS to_id FROM ${b}`, ['from_id', 'to_id']),
    key: 'from_id', value: 'to_id', elem: stream.elem,
  };
}

/** The keyed relation reduced to the set of origins that PRODUCED at least one row — i.e.
 *  the body read as an existence predicate, which is what `until()`/`emit()` and any
 *  `filter`-shaped consumer want. DISTINCT is correct HERE and wrong on the relation itself:
 *  existence is set-valued, whereas a body feeding a walk must preserve the multiset. */
export function keyedKeySet(st: ElementStream, k: KeyedRelation): Relation {
  const r = k.rel.as('ks');
  return st.q.cte(q`SELECT DISTINCT ${r.c[k.key]} AS id FROM ${r}`, ['id']);
}
