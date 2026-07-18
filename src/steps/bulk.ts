import { q, list, Query, type Expression } from '../q.ts';
import { edges, nodes, labels } from '../schema.ts';
import { dirsFor, edgeLabelFilter, framedProps } from '../plan.ts';
import { stepChain, type SackSpec } from '../frontend.ts';
import { type PStep } from '../strategies.ts';
import { type Compiled } from '../render.ts';
import { materializeRoot } from './materialize.ts';
import { buildPrefix } from './index.ts';

// ---------- traverser bulking: repeat(...).times(n).count() ----------
//
// TinkerPop bulks equal traversers into one (value, bulk-count) pair, so a
// `repeat(out()).times(n).count()` stays tractable no matter how many WALKS exist:
// identical vertices at the same depth merge, keeping the frontier bounded by |V|,
// not by the (exponential) walk count. mogwai otherwise materializes every walk as a
// UNION-ALL row, so the grateful graph's `times(8)` (≈2.5e15 walks) hangs the host.
//
// This module compiles the bulkable shape directly. Because SQLite REJECTS an
// aggregate/GROUP BY inside a recursive CTE's recursive term ("recursive aggregate
// queries not supported" — verified on both runtimes; the recursive engine is
// row-at-a-time and cannot collapse a generation), we do NOT bulk inside a
// `WITH RECURSIVE`. Instead a compile-time-known `times(n)` UNROLLS to n plain
// (non-recursive) GROUP-BY CTEs, each `SELECT tgt, SUM(prev.bulk) … GROUP BY tgt` —
// the SQL mirror of the traverser-merge. This is standard SQL (identical on Bun 3.53
// and DO 3.47) and computes 6e10 walks in ~1ms. See docs/2026-07-14-traverser-bulking.md.
//
// Bulking only applies when NO per-traverser identity is live: no path()/simplePath(),
// no as()/labels, no sack. Those make two traversers at the same vertex distinct, so
// the GROUP-BY collapse would be wrong — exactly why TinkerPop's LazyBarrierStrategy
// also disables itself under a PATH requirement. Unbounded until()/emit() have no
// compile-time depth to unroll and so cannot bulk in one SQLite statement (they'd need
// a JS depth-loop) — they fall through to the normal path (and the fail-fast guard).

const BULKABLE_REDUCERS = new Set(['count']);

interface BulkPlan {
  preLen: number;              // steps[0..preLen) = the source + leading filters (foldable prefix)
  dirs: [string, string][];    // the repeat body's movement directions (out/in/both)
  labels: any[];               // the body movement's edge-label filter args
  times: number;               // the (compile-time) loop depth
  postMoves: { dirs: [string, string][]; labels: any[] }[];
  reducer: 'count' | null;     // 'count' → SUM(bulk); null → materialize the frontier as (v, bulk)
}

/** Recognize `V()<filters> repeat(<single out/in/both>).times(n)` — either terminal in `count()`
 *  (→ SUM(bulk)) or ELEMENT-terminal (→ the frontier framed as (vertex, bulk) on the wire) — with
 *  no path/as/sack live. The shape traverser bulking makes tractable. Returns the plan, or null to
 *  fall through to the normal (enumerate-every-walk) compile path. */
function bulkPlan(steps: PStep[], params: Record<string, any>, sackInit?: SackSpec): BulkPlan | null {
  if (sackInit) return null;                              // sack is per-traverser identity
  const n = steps.length;
  if (n < 2) return null;                                 // need a source + the repeat cluster
  const last = steps[n - 1];
  // Terminal is count() (a reducer) or the repeat/movement frontier itself (element-returning).
  const reducer: 'count' | null = (BULKABLE_REDUCERS.has(last.name) && (last.args?.length ?? 0) === 0) ? 'count' : null;
  const repAt = steps.findIndex((s) => s.name === 'repeat' && s.cluster);
  if (repAt < 1) return null;
  const rep = steps[repAt];
  const cluster = rep.cluster;
  if (!cluster) return null;

  // Path/as BEFORE the repeat defeats bulking because it makes history live. Labels
  // bound AFTER a fixed-depth repeat may be erased when the only eventual consumer is
  // a bare select(...).count(): neither building that record nor naming its fields
  // changes cardinality. Post-repeat movements still multiply bulk and are folded below.
  const PATH = new Set(['path', 'simplePath', 'cyclicPath']);
  if (steps.slice(0, repAt).some((s) => s.name === 'as' || PATH.has(s.name))) return null;
  if (steps.slice(repAt + 1).some((s) => PATH.has(s.name))) return null;

  if (cluster.some((c) => c.name === 'until' || c.name === 'emit')) return null; // no compile-time depth
  const timesStep = cluster.find((c) => c.name === 'times');
  if (!timesStep || typeof timesStep.args[0] !== 'number') return null;
  const times = Number(timesStep.args[0]);
  if (times < 0) return null;

  // Body: a single out/in/both. simplePath()/multi-step bodies are per-traverser or
  // otherwise not a plain frontier hop → not bulkable here.
  const repStep = cluster.find((c) => c.name === 'repeat');
  const body = stepChain(repStep?.args[0]?.nested, params);
  if (body.length !== 1 || !['out', 'in', 'both'].includes(body[0].name)) return null;
  const mv = body[0];

  // Suffix accepted by the bulk engine:
  //   count() :  as()* (out|in|both as*)* [select(bound labels...)] count()   — cardinality-only
  //   element : (out|in|both)*                                                — bulk-preserving hops
  // The count form may name/build values (as/select) that count() immediately discards; the
  // element form must stay a plain frontier (as() would make identity live, a projection would
  // change the shape). Both are deliberately narrow and fail-closed.
  const suffix = steps.slice(repAt + 1, reducer === 'count' ? -1 : undefined);
  const bound = new Set<string>();
  const postMoves: BulkPlan['postMoves'] = [];
  let sawSelect = false;
  for (let i = 0; i < suffix.length; i++) {
    const s = suffix[i];
    if (['out', 'in', 'both'].includes(s.name)) {
      if (sawSelect) return null;
      postMoves.push({ dirs: dirsFor(s.name), labels: s.args });
      continue;
    }
    if (reducer !== 'count') return null; // element-terminal: only frontier hops in the suffix
    if (s.name === 'as') {
      if (sawSelect || s.args.some((a) => typeof a !== 'string')) return null;
      for (const a of s.args) bound.add(a);
      continue;
    }
    if (s.name === 'select' && i === suffix.length - 1) {
      if (s.bys?.length || s.args.length === 0 || s.args.some((a) => typeof a !== 'string' || !bound.has(a))) return null;
      sawSelect = true;
      continue;
    }
    return null;
  }

  return { preLen: repAt, dirs: dirsFor(mv.name), labels: mv.args, times, postMoves, reducer };
}

/** Compile the bulkable repeat. Reuses buildPrefix for the source + leading filters (so
 *  `V().hasLabel('song').repeat(out()).times(n)…` works — the seed is the filtered vertex set),
 *  then unrolls n GROUP-BY-SUM(bulk) CTEs. A count() terminal sums the final frontier's bulk; an
 *  element terminal frames each frontier vertex as (v, bulk) — the RLE the wire expands, instead of
 *  enumerating every (exponential) walk. Returns null (falling back to the normal path) if the
 *  prefix carries alias/path/sack state or isn't vertex-typed. */
export function tryBulkRepeat(steps: PStep[], params: Record<string, any>, sackInit?: SackSpec): Compiled | null {
  const plan = bulkPlan(steps, params, sackInit);
  if (!plan) return null;

  const query = new Query();
  const pre = steps.slice(0, plan.preLen);
  const { st, stop } = buildPrefix(pre, params, query);
  // The prefix must fold completely to a bare vertex id-relation. Anything else
  // (an unconsumed tail, an edge type, or live alias/path/sack) is not bulkable —
  // fall back rather than emit wrong SQL.
  if (stop !== pre.length || st.elem !== 'node' || st.carried.aliases.size > 0 || st.carried.path || st.carried.sack) return null;

  // f0: the seed frontier, one row per distinct vertex with its multiplicity (a
  // pre-movement multiset like V().out() collapses here — COUNT(*) per id = its bulk).
  let cur = query.cte(q`SELECT id, CAST(COUNT(*) AS INTEGER) AS bulk FROM ${st.rel} GROUP BY id`, ['id', 'bulk']);
  // f1..fn: each hop merges all walks landing on a vertex into one (id, SUM(bulk)) row,
  // so the frontier stays bounded by reachable |V|, not the walk count.
  for (let d = 1; d <= plan.times; d++) {
    const w = cur.as('w');
    const e = edges.as('e');
    const legs = plan.dirs.map(([from, to]) =>
      q`SELECT ${e.c[to]} AS nb, ${w.c.bulk} AS b FROM ${w} JOIN ${e} ON ${e.c[from]}=${w.c.id}${edgeLabelFilter(plan.labels)}`);
    cur = query.cte(q`SELECT nb AS id, SUM(b) AS bulk FROM (${list(legs, ' UNION ALL ')}) GROUP BY nb`, ['id', 'bulk']);
  }
  // A post-repeat movement is another bulk-preserving frontier hop. The ignored
  // as()/select() steps only name/build values immediately discarded by count().
  for (const move of plan.postMoves) {
    const w = cur.as('w');
    const e = edges.as('e');
    const legs = move.dirs.map(([from, to]) =>
      q`SELECT ${e.c[to]} AS nb, ${w.c.bulk} AS b FROM ${w} JOIN ${e} ON ${e.c[from]}=${w.c.id}${edgeLabelFilter(move.labels)}`);
    cur = query.cte(q`SELECT nb AS id, SUM(b) AS bulk FROM (${list(legs, ' UNION ALL ')}) GROUP BY nb`, ['id', 'bulk']);
  }

  // count() = the total traverser count at the final depth = SUM(bulk). (SUM past i64
  // raises SQLite's native `integer overflow` — fail loud, matching TinkerPop's own
  // `long` bulk overflowing at the same point.)
  if (plan.reducer === 'count')
    return materializeRoot(query, q`SELECT COALESCE(SUM(bulk), 0) AS v FROM ${cur}`, { kind: 'count' });

  // Element terminal: frame each frontier vertex ONCE, carrying its bulk column, so the wire
  // emits (v, N) instead of N copies (framedResults reads the `bulk` column, the client expands).
  // The frontier is bulk (out/in/both hops), so it is always vertices.
  const c = cur.as('c');
  const nn = nodes.as('n');
  const ll = labels.as('l');
  return materializeRoot(
    query,
    q`SELECT COALESCE(${nn.c.uid}, ${nn.c.id}) AS id, ${ll.c.name} AS label, ${framedProps(nn, 'node')} AS props, ${c.c.bulk} AS bulk FROM ${c} JOIN ${nn} ON ${nn.c.id}=${c.c.id} JOIN ${ll} ON ${ll.c.id}=${nn.c.label}`,
    { kind: 'vertex' },
  );
}
