import { type Expr, col, conjoin, conjuncts } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel } from '../rel.ts';
import { atMostOneRow, rowBounds } from '../bounds.ts';
import { minter, freshCopy, type Minter } from '../mint.ts';
import { exprDraws, picks, unpicked } from '../copies.ts';
import { perHostWork, readInFull } from '../work.ts';
import { decorrelate, semiJoinPerDistinct } from '../decorrelate.ts';
import type { RelId } from '../types.ts';
import { deepColsRead, exprHasSubquery, forEachRel, freeRelIds, isSelfContained, mapRelChildren, mapRelExprs, relExprs, relsBeneath, rewriteExpr, rewriteRels, substRelId } from '../walk.ts';

/**
 * `magic` — a PHYSICAL rewrite: a correlated test of ONE element, asked inside a body evaluated per host row, is
 * asked once per DISTINCT element across every host. Same rows; the test's work moves from per row to per value.
 *
 * ## The shape
 *
 * A child body (`local`/`map`/`project().by`/… — a scalar or `EXISTS` subquery a Filter or Project holds over its
 * input) that the connector kept CORRELATED holds a Filter `F` with a conjunct `[NOT] EXISTS B(x)`: a test reading
 * nothing of `F`'s input but one never-NULL column `x`. Evaluated per host row, `B(x)` is asked once per row of `F`
 * — and at a hub, many hosts reach the same `x`, so the hub's whole neighbourhood is read once per host reaching
 * it: quadratic in the rows flowing (`g.V().local(out().out().where(in().has('age',gt(50))).count()).sum()`, 41×
 * per 8× on the hub graph of `test/compiler/walk-condition-hub-scale.exec.test.ts`). At the root the same chain is
 * already linear — the movement collapse groups by the element, so the test is asked per distinct `x` — but a
 * host's scope keeps every host's rows apart.
 *
 * ## What it becomes
 *
 * The MAGIC SET (Bancilhon et al., *Magic Sets and Other Strange Ways to Implement Logic Programs*, PODS 1986;
 * Seshadri et al., *Cost-Based Optimization for Magic*, SIGMOD 1996): the set of bindings the subquery is actually
 * invoked with, computed once, and the subquery asked of it. Here that set is the DOMAIN of `x` — `F`'s input under
 * `F`'s subquery-free conjuncts, for every row the host asks its body of, decorrelated by the general rule
 * (`decorrelate`, Neumann & Kemper's domain: linear in the rows flowing) — and the test is asked of its distinct
 * values, the passing set fenced, `F`'s row kept by a semi-join on `x` (an anti-join for `NOT EXISTS`) —
 * `semiJoinPerDistinct`, the one builder `perState` (`src/compiler/rel/walk.ts`) builds a walk condition's form
 * with. `B(x)` holds of a row iff its `x` is in that set: every `x` the body tests is in the domain and `B` reads
 * nothing else. The body itself is still read per host; only the test is shared.
 *
 * ## When — the domain must be work the plan does anyway
 *
 * The domain is every row `F` WOULD read for every host — so it is built only where they ARE all read
 * (`readInFull`'s spine mode, `src/rel/work.ts`): `F` is consumed in full by its body (under a barrier —
 * `readsInputInFull` — or at most one row), and the host's rows are all asked (likewise up to the plan root). An `EXISTS` body or a first-row pick stops at its
 * first row instead, and there the domain would be the whole un-short-circuited work: measured on a uniform graph
 * of out-degree 20, `g.V().where(out().out().where(in().has('age',gt(20)))).count()` went 10.6 ms → 505 ms at 8k
 * vertices with the rewrite, because every host passes on its first two-hop row. Without statistics
 * (`docs/archive/2026-08-01-relir-build-plan.md` §1 P4) neither form wins there, so the existence probe keeps its
 * short-circuit (`docs/archive/2026-11-16-ladder-retirement-plan.md` T3(b) carries the measured trade).
 *
 * ## When — and only where there is something to share
 *
 * - ONE call of the test reads an unbounded input to its end (`perHostWork(…).exhausts`, `src/rel/work.ts`): a
 *   failing probe reads a hub's whole neighbourhood. A test that stops at its first index seek
 *   (`local(out().where(out()).count())`) costs per host what the semi-join probe replacing it would, so the domain
 *   is pure overhead (measured 2× slower at 8k). Static, from the algebra: no statistics, no decline.
 * - The outermost host is not a POINT (`atMostOneRow`): `V(1)` asks its body once. A `limit(k)` is NOT a point —
 *   `k` is a page size or a safety cap the data may well stay under, and leaving it per host put a hub's
 *   neighbourhood back per host reaching it (measured 2.4× → 16.5× per 8× on `limit(100000)`). A nested host is
 *   asked across every enclosing host, so only the outermost bound counts. A selective but unbounded host
 *   (`hasLabel('software').local(…)`) is still rewritten — no static fact tells it
 *   from a hub's hosts (statistics residue, R6-1 in `docs/archive/2026-11-16-ladder-retirement-plan.md`); it stays linear.
 *
 * - The host's rows are SELF-CONTAINED (`isSelfContained`): at the outermost host its input reads no outer row and
 *   no walk's self-reference (so never inside a recursive term); a host nested inside a body is reached through
 *   the enclosing host's rows (`overHosts` of its input), so the domain is always one CTE. It is never a whole base
 *   table standing in for a selective host — on SQLite, a nested-loop engine, the domain decides the work
 *   (`decorrelate.ts`, "The domain that IS its input's key projection").
 * - The domain covers every `x` the body tests although it is a SECOND evaluation of the host's input and `F`'s,
 *   where a pick (`picks`, `src/rel/copies.ts`: a draw, an unordered `limit`, a first-row window) leaves its rows
 *   to SQLite's plan, which a copy need not repeat. So an outermost host that picks is read ONCE (`spooled`: one
 *   fenced CTE the host and the domain both read, `V().limit(50).out().local(…)`), and a pick inside a correlated
 *   input is WIDENED away (`unpicked`: a superset, `out().limit(5).where(…)`) — the semi-join needs only a domain
 *   holding every tested `x`. A pick neither can handle (a draw in the body, a pick under an aggregate) leaves the
 *   body as it is. That is also why the pass may tell `decorrelate` it owns nothing.
 * - Each body reads its host through ONE column (the domain's key is that column's distinct values).
 *
 * It recognises the ALGEBRA, so every host and every depth gets it with no list of positions. It runs after
 * `leading` and before `semijoin`, so the property seek still drives the test inside the passing set.
 */
export function magicAll(plans: readonly Rel[]): readonly Rel[] {
  const whole = readInFull(plans, 'spine').full;
  const mint = minter(...plans);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped, original) => (whole.has(original) ? atHost(mapped, null, mint) : mapped), memo));
}

/** Where a body's rows come from: the host relation its columns name (`outer`), and that host's rows over every
 *  row asked of it, as a self-contained relation (`reached`, built on first use). */
interface Hosts {
  readonly outer: RelId;
  readonly reached: () => Rel | null;
}

/** A Filter or Project whose expressions hold a body correlated to its input alone: each such body rewritten.
 *  `within` is the enclosing body's hosts, `null` at the outermost host. */
function atHost(r: Rel, within: Hosts | null, mint: Minter): Rel {
  if (r.kind !== 'filter' && r.kind !== 'project') return r;
  // A POINT host (`V(1)`) asks its body once: nothing to share across hosts, and the domain would only add a spool
  // to a point query. Only ONE row is a fact of the query text; a `limit(k)` is a page size or a safety cap that may
  // well exceed the data, so it is no reason to leave a hub's neighbourhood read per host. Only the OUTERMOST host's
  // bound counts: a nested host's input is bounded per enclosing row (one row, inside `local(local(…))`), but it is
  // asked across every enclosing host, and an unbounded enclosing host was already let through here.
  if (!within && atMostOneRow(r.input)) return r;
  const free = freeRelIds(r.input);
  if (within ? [...free].some((id) => id !== within.outer) : !isSelfContained(r.input)) return r;
  // An outermost host whose rows a second evaluation could re-pick (`picks`: `V().limit(50).out()`) is read ONCE:
  // its input becomes one fenced CTE the host and the domain both read, so the domain holds exactly the rows the
  // bodies are asked of. A nested host is correlated and cannot be spooled; its domain widens instead (`hostRows`).
  // Named only once a body is rewritten (`spool`): a long chain holds a host at every step, and most rewrite nothing.
  let spool: string | undefined;
  const read = !within && picks(r.input)
    ? (): Rel => make.ref({ id: mint.id('mgf'), name: (spool ??= mint.id('mgn')), channels: r.input.channels, type: r.input.type })
    : undefined;
  let reached: Rel | null | undefined;
  const hosts: Hosts = { outer: r.input.id, reached: () => (reached === undefined ? (reached = hostRows(r, within, mint, read)) : reached) };
  let changed = false;
  const out = mapRelExprs(r, (e) => rewriteExpr(e, (node) => node, (plan) => {
    const reads = freeRelIds(plan);
    if (reads.size !== 1 || !reads.has(hosts.outer)) return plan;
    const body = inBody(plan, hosts, mint);
    if (body !== plan) changed = true;
    return body;
  }));
  if (!changed) return r;
  return spool ? spooled(out, r.input, spool, mint) : out;
}

/** `host` reading `input` through ONE fenced materialization named `name` — the binding its bodies' domains read by
 *  that name (a `Ref` is a leaf, so it sits inside a body without capturing the body's correlation to the host's
 *  input). `name` binds it once, before the host that reads it; every read of `input`'s id moves to it. */
function spooled(host: Rel, input: Rel, name: string, mint: Minter): Rel {
  const once = make.materialize({ id: mint.id('mgs'), input, channels: input.channels, type: input.type, name, fenced: true });
  return mapRelChildren(mapRelExprs(host, (e) => substRelId(e, input.id, once.id)), () => once);
}

/** `body` with every Filter it reads in full that tests one element by a subquery asking it once per element, and
 *  every host it reads in full rewritten in turn. */
function inBody(body: Rel, hosts: Hosts, mint: Minter): Rel {
  const whole = readInFull([body], 'spine', false).full;
  return rewriteRels(body, (mapped, original) => {
    const hosted = whole.has(original) ? atHost(mapped, hosts, mint) : mapped;
    const out = hosted.kind === 'filter' && whole.has(original) ? atFilter(hosted, hosts, mint) : hosted;
    return out === mapped && unchanged(mapped, original) ? original : out;
  });
}

/** Is `mapped` — `original` rebuilt by `rewriteRels` — the same relation: every relation beneath it the original's
 *  own? Then the ORIGINAL node is kept, so a relation the body shares with the rest of the plan (a fenced first-row
 *  read both the value and its presence test hold) stays ONE node, and `name` binds it once. A walk's term is never
 *  rewritten here (`readInFull` does not enter it on the spine), so a walk is the same when its seed is. */
function unchanged(mapped: Rel, original: Rel): boolean {
  if (mapped.kind === 'recursive' && original.kind === 'recursive') return mapped.seed === original.seed;
  const now = relsBeneath(mapped), before = relsBeneath(original);
  return now.length === before.length && now.every((r, i) => r === before[i]);
}

/** The rows a host asks its bodies of, as a self-contained relation the domain is built from, or `null`. A Filter's
 *  subquery-free conjuncts restrict it (the body is asked of no other row); a nested host's rows are its input over
 *  the enclosing host's rows (`overHosts`). Always a FRESH COPY (`freshCopy`), never the host's own input node: the
 *  domain sits INSIDE the body, which reads the host's input by id as an outer row, and a relation of that id defined
 *  beneath the body would capture the reference (`freeRelIds` would call the body uncorrelated and `name` would
 *  bind it as a CTE). An input a copy cannot hold (a walk, a named materialization) leaves the body as it is. */
function hostRows(r: Extract<Rel, { kind: 'filter' | 'project' }>, within: Hosts | null, mint: Minter, spool?: () => Rel): Rel | null {
  const input = r.input;
  const rest = r.kind === 'filter' ? conjuncts(r.pred).filter((e) => !exprHasSubquery(e)) : [];
  const restricted = (base: Rel): Rel => {
    const pred = conjoin(rest.map((e) => substRelId(e, input.id, base.id)));
    return pred ? make.filter({ id: mint.id('mgh'), input: base, channels: input.channels, type: input.type, pred }) : base;
  };
  if (spool) return restricted(spool());
  // A pick in a nested host's input (`out().limit(5)` per enclosing row) is WIDENED away (`unpicked`): the domain
  // need only hold every row the host could have asked of, and a copy of the pick might hold others.
  const widened = unpicked(input);
  if (!widened) return null;
  const copy = freshCopy({ kind: 'scalar', plan: restricted(widened) }, mint);
  if (copy?.kind !== 'scalar') return null;
  if (!within) return copy.plan;
  const outer = within.reached();
  return outer && overHosts(copy.plan, outer, within.outer, mint);
}

function atFilter(f: Extract<Rel, { kind: 'filter' }>, hosts: Hosts, mint: Minter): Rel {
  // A test asked of at most one row per host is asked at most once per host already: nothing to share but a
  // repeated host, and the domain would cost as much as the rows it saves.
  if (rowBounds(f.input).max <= 1) return f;
  const all = conjuncts(f.pred);
  const at =all.findIndex((e) => elementTest(e, f.input.id) !== null);
  if (at < 0) return f;
  const test = all[at] as Extract<Expr, { kind: 'exists' }>;
  // Sharing pays only where ONE call of the test reads an unbounded input to its end (`perHostWork`'s `exhausts`):
  // a hub's whole neighbourhood behind a failing probe. A test that stops at its first index seek
  // (`out().where(out())`) costs the same per host as the semi-join probe that would replace it, plus the domain.
  if (!perHostWork(test.plan).exhausts) return f;
  const x = elementTest(test, f.input.id)!;
  const xMeta = f.input.type.cols.find((c) => c.name === x);
  // A NULL `x` matches no passing row, while the test may hold of it: only a column that is never NULL.
  if (!xMeta || xMeta.nullable) return f;
  const others = all.filter((_, i) => i !== at);
  if (others.some(exprDraws)) return f;
  // THE DOMAIN: `x` over `F`'s input under its subquery-free conjuncts, for every host row — a fresh copy, so it
  // may stand beside the body it was read from. A pick in that input (`out().limit(5).where(…)`) is WIDENED away
  // (`unpicked`): the domain is a superset of the `x` the body tests, which is all the semi-join needs, where a copy
  // of the pick might hold other rows than the body read. Ids are kept, so `restricting` still names `F`'s input.
  const widened = unpicked(f.input);
  if (!widened) return f;
  const restricting = others.filter((e) => !exprHasSubquery(e));
  const restriction = conjoin(restricting);
  const rows = withoutDistinct(restriction
    ? make.filter({ id: mint.id('mgr'), input: widened, channels: f.input.channels, type: f.input.type, pred: restriction })
    : widened);
  const free = freeRelIds(rows);
  // Rows that read no host row are one relation for every host: nothing to share.
  if (free.size !== 1 || !free.has(hosts.outer)) return f;
  const projected = make.project({ id: mint.id('mgx'), input: rows, channels: [], type: { cols: [xMeta] }, exprs: [[x, col(rows.id, x)]] });
  const copied = freshCopy({ kind: 'scalar', plan: projected }, mint);
  if (copied?.kind !== 'scalar') return f;
  const reached = hosts.reached();
  if (!reached) return f;
  const domain = overHosts(copied.plan, reached, hosts.outer, mint);
  if (!domain || !isSelfContained(domain)) return f;
  const tested = freshCopy({ ...test, negated: false }, mint);
  if (!tested) return f;
  const keys = make.project({ id: mint.id('mgk'), input: domain, channels: [], type: { cols: [xMeta] }, exprs: [[x, col(domain.id, x)]] });
  const joined = semiJoinPerDistinct(f.input, keys, (states) => substRelId(tested, f.input.id, states.id), mint.id, 'mg', test.negated ? 'anti' : 'semi');
  if (!joined) return f;

  const pred = conjoin(others.map((e) => substRelId(e, f.input.id, joined.id)));
  if (!pred) {
    return make.project({ id: f.id, input: joined, channels: f.channels, type: f.type, exprs: f.type.cols.map((c) => [c.name, col(joined.id, c.name)] as const) });
  }
  return make.filter({ id: f.id, input: joined, channels: f.channels, type: f.type, pred });
}

/** `plan` (correlated to `outer`) for every row of `reached`, decorrelated: its own columns, self-contained, or
 *  `null` where the plan reads more than one column of the host, or does not decorrelate. */
function overHosts(plan: Rel, reached: Rel, outer: RelId, mint: Minter): Rel | null {
  const read = new Set<string>();
  forEachRel(plan, (r) => relExprs(r).forEach((e) => deepColsRead(e, outer).forEach((c) => read.add(c))));
  if (read.size !== 1) return null;
  const [key] = [...read] as [string];
  const keyMeta = reached.type.cols.find((c) => c.name === key);
  if (!keyMeta) return null;
  // The host rows' DISTINCT values of the one column the body reads: the domain's key is unique per row.
  const values = make.distinct({
    id: mint.id('mgo'), channels: [], type: { cols: [keyMeta] },
    input: make.project({ id: mint.id('mgv'), input: reached, channels: [], type: { cols: [keyMeta] }, exprs: [[key, col(reached.id, key)]] }),
  });
  const moved = substRelId({ kind: 'scalar', plan }, outer, values.id);
  if (moved.kind !== 'scalar') return null;
  // The pass built every node of `moved` and none draws (its callers check), so it owns no draw needing a key.
  const out = decorrelate(moved.plan, values, key, mint.id, undefined, () => false);
  if (!out) return null;
  return make.project({
    id: mint.id('mgq'), input: out.rel, channels: [], type: { cols: plan.type.cols },
    exprs: plan.type.cols.map((c) => [c.name, col(out.rel.id, c.name)] as const),
  });
}

/** The column `x` of `input` a conjunct `[NOT] EXISTS B(x)` tests, or `null`: `B` reads nothing outside itself but
 *  `input`, and of `input` the one column `x` — so its answer is a function of `x` alone. */
function elementTest(e: Expr, input: RelId): string | null {
  if (e.kind !== 'exists' || exprDraws(e)) return null;
  const free = freeRelIds(e.plan);
  if (free.size !== 1 || !free.has(input)) return null;
  const cols = deepColsRead(e, input);
  return cols.size === 1 ? [...cols][0]! : null;
}

/** `r` with every `DISTINCT` on its row-wise spine (projections and filters) dropped: the domain is the SET of `x`
 *  it holds, which a `DISTINCT` beneath does not change — and keyed per host it would be one sort of the whole
 *  domain (`local(out().out().dedup().where(…))` measured 1.5× slower than per row on an out-degree-20 graph). */
function withoutDistinct(r: Rel): Rel {
  if (r.kind === 'distinct') return withoutDistinct(r.input);
  if (r.kind !== 'project' && r.kind !== 'filter') return r;
  const input = withoutDistinct(r.input);
  if (input === r.input) return r;
  const moved = mapRelExprs(r, (e) => substRelId(e, r.input.id, input.id));
  return mapRelChildren(moved, () => input);
}
