import { q, list } from '../../sql/kernel/q.ts';
import { edges } from '../../sql/schema.ts';
import { dirsFor, edgeLabelFilter } from '../../compiler/plan/plan.ts';
import { stepChain, type SackSpec } from '../../gremlin/frontend.ts';
import { type PStep } from '../../compiler/ir/strategies.ts';
import { type Compiled } from '../../sql/kernel/render.ts';
import { materializeFinal } from './materialize.ts';
import { type ElementStream } from '../context/context.ts';
import type { Engine } from '../../compiler/engine/deps.ts';
import type { FastPath } from '../../compiler/options/fast-paths.ts';

// ---------- traverser bulking: repeat(...).times(n).<bulk-aware terminal> ----------
//
// TinkerPop bulks equal traversers into one (value, bulk-count) pair, so a
// `repeat(out()).times(n)` stays tractable no matter how many WALKS exist: identical
// vertices at the same depth merge, keeping the frontier bounded by |V|, not by the
// (exponential) walk count. mogwai otherwise materializes every walk as a UNION-ALL row
// (a `WITH RECURSIVE` term is row-at-a-time), so the grateful graph's `times(8)`
// (≈2.5e15 walks) hangs the host.
//
// This module compiles the bulkable shape directly. Because SQLite REJECTS an
// aggregate/GROUP BY inside a recursive CTE's recursive term ("recursive aggregate
// queries not supported" — verified on both runtimes), we do NOT bulk inside a
// `WITH RECURSIVE`. Instead a compile-time-known `times(n)` UNROLLS to n plain
// (non-recursive) GROUP-BY CTEs, each `SELECT tgt, SUM(prev.bulk) … GROUP BY tgt` — the
// SQL mirror of the traverser-merge — producing a bulk-collapsed FRONTIER relation
// (id, bulk). See docs/2026-07-14-traverser-bulking.md.
//
// The collapsed frontier is then handed BACK to the generic lowering engine as an
// ElementStream carrying its `bulk` multiplicity. Every bulk-aware terminal the generic
// tail already knows — count() (SUM(bulk)), groupCount()/group().by(k).by(count())
// (SUM(bulk) per key), sum()/min()/max()/mean() (SUM(v·bulk) etc.), and the bare element
// leaf (framed as (v, bulk) on the wire) — finishes off the collapsed relation with NO
// bulk logic of its own here. This is the fast-path "swap only the middle" law: the fast
// middle is the unrolled bulk collapse; the reused plumbing is the generic reducer/group
// tail; and disabling the switch compiles the SAME traversal through the generic recursive
// walk (enumerate-then-reduce == bulk-then-reduce, verified by the equivalence test).
//
// Bulking only applies when NO per-traverser identity is live: no path()/simplePath(),
// no as()/labels, no sack. Those make two traversers at the same vertex distinct, so the
// GROUP-BY collapse would be wrong — exactly why TinkerPop's LazyBarrierStrategy also
// disables itself under a PATH requirement. Unbounded until()/emit() have no compile-time
// depth to unroll and so cannot bulk in one SQLite statement — they fall through to the
// normal path (and the fail-fast guard).

/** The bulk-preserving post-repeat movements (each is another frontier hop, still bounded
 *  by |V|). Threaded through the generic engine, whose movementCollapse fast path keeps them
 *  collapsed; recognized here only so the suffix gate can walk past them to the terminal. */
const BULK_MOVES = new Set(['out', 'in', 'both']);
/** Global reducers the generic tail already weights by the carried bulk (count → SUM(bulk),
 *  sum/mean → SUM(v·bulk)/Σbulk, min/max bulk-invariant). */
const BULK_REDUCERS = new Set(['count', 'sum', 'min', 'max', 'mean']);

/** A `groupCount()` whose key does NOT fan out (bare element identity, a property key, or a
 *  token key) is bulk-mergeable: lowerGroup weights every group by SUM(bulk), so a collapsed
 *  (element, N) frontier gives the same per-key totals. A by(traversal) key can fan one
 *  traverser to many keys, which the id-merge would corrupt → not bulk-safe. */
function nonFanoutGroupCount(step: PStep): boolean {
  if (step.name !== 'groupCount' || (step.args?.length ?? 0) !== 0) return false;
  const bys = step.bys ?? [];
  if (bys.length === 0) return true;
  if (bys.length !== 1) return false;
  const a = bys[0]?.[0];
  return a === undefined || typeof a === 'string' || (a && typeof a === 'object' && 'token' in a);
}

/** A `group()` whose (optional, non-fan-out) key is paired with a `by(__.count())` value.
 *  The value reducer is count, which lowerGroup weights by the per-child bulk (valBulk), and
 *  the key follows the element's identity, so a collapsed frontier keeps every group total
 *  correct. Any other value shape (element list, numeric-over-values, nested group) is left
 *  to the generic recursive path — correct there, just not bulk-collapsed. */
function bulkCountGroup(step: PStep, params: Record<string, any>): boolean {
  if (step.name !== 'group' || (step.args?.length ?? 0) !== 0) return false;
  const bys = step.bys ?? [];
  if (bys.length === 0 || bys.length > 2) return false;
  // Key by (bys[0]) must be non-fan-out: bare, a property string, or a token.
  const keyArg = bys[0]?.[0];
  const keyOk = keyArg === undefined || typeof keyArg === 'string'
    || (keyArg && typeof keyArg === 'object' && 'token' in keyArg);
  if (!keyOk) return false;
  // Value by (bys[1]) must be exactly __.count().
  const valArg = bys[1]?.[0];
  if (!valArg || typeof valArg !== 'object' || !('nested' in valArg)) return false;
  const vsteps = stepChain(valArg.nested, params);
  return vsteps.length === 1 && vsteps[0].name === 'count' && (vsteps[0].args?.length ?? 0) === 0;
}

/** Whether the whole post-repeat suffix stays bulk-preserving AND ends in a terminal the
 *  generic tail weights by bulk. Two families are admitted:
 *
 *  - the COUNT-terminal cardinality-only form: `(out|in|both | as(labels) | select(labels))*
 *    count()`. count() sums bulk regardless of identity, so naming/relabelling/selecting
 *    intermediate traversers cannot change the total — the frontier stays bounded (the extra
 *    identity turns off per-hop collapse for the tail, but the collapsed repeat frontier is
 *    already |V|-bounded, so one more hop is bounded too, never the exponential walk count).
 *  - the OTHER bulk-aware terminals: `(out|in|both)*` then a global reducer (optionally after ONE
 *    scalar values('k') projection for sum/min/max/mean), a non-fan-out groupCount(), a
 *    group().by(k?).by(count()), or the bare element frontier. These MUST stay identity-free
 *    (no as/select/path): their weighting rides the carried bulk through a live collapse.
 *
 *  Anything else (path/dedup/order/limit/branch/…) → not bulk-safe → fall through to the generic
 *  recursive walk (correct, just enumerated). */
function suffixBulkSafe(suffix: PStep[], params: Record<string, any>): boolean {
  const last = suffix.at(-1);

  // count()-terminal cardinality-only form: movements + as()/select(labels) that count discards.
  if (last && last.name === 'count' && (last.args?.length ?? 0) === 0) {
    return suffix.slice(0, -1).every((s) =>
      BULK_MOVES.has(s.name)
      || (s.name === 'as' && s.args.every((a: any) => typeof a === 'string'))
      || (s.name === 'select' && s.args.length > 0 && s.args.every((a: any) => typeof a === 'string') && !(s.bys?.length)));
  }

  // Bare element frontier (repeat(...).times(n) with nothing after, or only movements).
  let i = 0;
  while (i < suffix.length && BULK_MOVES.has(suffix[i].name)) i++;
  if (i === suffix.length) return true; // pure frontier / movement-only suffix

  const rest = suffix.slice(i);
  const term = rest.at(-1)!;

  // A single scalar projection may precede a numeric reducer: values('k').sum().
  if (rest.length === 2 && rest[0].name === 'values' && (rest[0].args?.length ?? 0) === 1
    && typeof rest[0].args[0] === 'string' && BULK_REDUCERS.has(term.name) && term.name !== 'count'
    && (term.args?.length ?? 0) === 0)
    return true;

  if (rest.length !== 1) return false; // no other multi-step suffix is bulk-collapsible here
  if (BULK_REDUCERS.has(term.name) && (term.args?.length ?? 0) === 0) return true; // sum/min/max/mean
  if (nonFanoutGroupCount(term)) return true;
  if (bulkCountGroup(term, params)) return true;
  return false;
}

interface BulkPlan {
  preLen: number;              // steps[0..preLen) = the source + leading filters (foldable prefix)
  dirs: [string, string][];    // the repeat body's movement directions (out/in/both)
  labels: any[];               // the body movement's edge-label filter args
  times: number;               // the (compile-time) loop depth
  suffixAt: number;            // steps index where the post-repeat suffix begins (repAt + 1)
}

/** Recognize `V()<filters> repeat(<single out/in/both>).times(n) <bulk-safe suffix>` — with
 *  no path/as/sack live. The shape traverser bulking makes tractable. Returns the plan, or null
 *  to fall through to the normal (enumerate-every-walk) compile path. */
function bulkPlan(steps: PStep[], params: Record<string, any>, sackInit?: SackSpec): BulkPlan | null {
  if (sackInit) return null;                              // sack is per-traverser identity
  const n = steps.length;
  if (n < 2) return null;                                 // need a source + the repeat cluster
  const repAt = steps.findIndex((s) => s.name === 'repeat' && s.cluster);
  if (repAt < 1) return null;
  const rep = steps[repAt];
  const cluster = rep.cluster;
  if (!cluster) return null;

  // Path/as BEFORE the repeat defeats bulking because it makes history live. A path()
  // ANYWHERE in the suffix is likewise identity — suffixBulkSafe rejects it below.
  const PATH = new Set(['path', 'simplePath', 'cyclicPath']);
  if (steps.slice(0, repAt).some((s) => s.name === 'as' || PATH.has(s.name))) return null;

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

  // The remaining chain after the repeat cluster must be bulk-preserving and end in a
  // bulk-aware terminal the generic tail reduces (count/groupCount/sum/group-by-count/element).
  if (!suffixBulkSafe(steps.slice(repAt + 1), params)) return null;

  return { preLen: repAt, dirs: dirsFor(mv.name), labels: mv.args, times, suffixAt: repAt + 1 };
}

/** Compile the bulkable repeat. Reuses buildPrefix for the source + leading filters (so
 *  `V().hasLabel('song').repeat(out()).times(n)…` works — the seed is the filtered vertex set),
 *  then unrolls n GROUP-BY-SUM(bulk) CTEs into a collapsed frontier relation (id, bulk). The
 *  frontier is handed back to the generic lowering engine as an ElementStream carrying `bulk`,
 *  which finishes the suffix (movements + a count/groupCount/sum/group-by-count/element terminal)
 *  weighting by that multiplicity — the RLE the wire/reducer expands, instead of enumerating every
 *  (exponential) walk. Returns null (falling back to the normal path) if the prefix carries
 *  alias/path/sack state or isn't vertex-typed. */
function tryBulkRepeat(engine: Engine, steps: PStep[], params: Record<string, any>, sackInit?: SackSpec): Compiled | null {
  const plan = bulkPlan(steps, params, sackInit);
  if (!plan) return null;

  // A fresh child engine owns the Query the unrolled GROUP-BY CTEs (and the generic suffix
  // tail) accumulate into; its buildPrefix seeds the source + leading filters onto that same
  // Query, and every stream built on it reaches the engine via q.engine. movementCollapse is
  // forced ON: the frontier the suffix lowers over is ALREADY collapsed (id, bulk), so the
  // element leaf must frame it as (v, bulk) and any post-repeat movement must stay collapsed —
  // exactly what that flag governs. (suffixBulkSafe already proved the suffix is collapse-safe.)
  const eng = engine.subEngine(params, { ...engine.fastPaths, movementCollapse: true });
  const query = eng.q;
  const pre = steps.slice(0, plan.preLen);
  const { st, stop } = eng.buildPrefix(pre, params);
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

  // Re-enter generic lowering: the collapsed frontier IS a vertex id-relation carrying `bulk`.
  // The generic suffix tail (post-repeat movements + the count/groupCount/sum/group-by-count/
  // element terminal) folds over it exactly as over any other bulk-carrying stream, weighting
  // every reduction by SUM(bulk). No bulk arithmetic lives here — this is the fast MIDDLE only.
  const seed: ElementStream = {
    kind: 'elements', q: query, params, rel: cur, elem: 'node',
    carried: { aliases: new Map(), origins: [], bulk: 'bulk' },
  };
  return materializeFinal(eng.lowerStepsStrict(seed, steps, plan.suffixAt));
}

/** The bulkRepeatCount fast path. Recognition (bulkPlan) and lowering are intertwined — the
 *  definitive gate requires building the prefix (see tryBulkRepeat's stop/elem/identity check) —
 *  so the shape test lives inside tryLower (null = not the bulkable shape), and appliesWhen is the
 *  flag alone, exactly as compileRead dispatched it before. Fires at compileRead, before buildPrefix. */
export const BulkRepeatCountFastPath: FastPath<[Engine, PStep[], Record<string, any>, SackSpec | undefined], Compiled> = {
  name: 'bulkRepeatCount',
  equivalentWhen: 'every disable-safe fast path is result-equivalent to generic lowering',
  appliesWhen: (ctx) => ctx.enabled.bulkRepeatCount,
  tryLower: (_ctx, engine, steps, params, sackInit) => tryBulkRepeat(engine, steps, params, sackInit),
};
