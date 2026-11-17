import { compilerInt, type Expr } from '../expr.ts';
import * as make from '../factory.ts';
import { minter } from '../mint.ts';
import type { Rel } from '../rel.ts';
import type { ColMeta, RelId } from '../types.ts';
import {
  exprChildren, exprHasSubquery, exprRels, forEachExpr, forEachRel, freeRelIds, joinSide, mapExprChildren, relChildren, relExprs,
  rewriteExpr, rewriteRels, substRelId,
} from '../walk.ts';

/**
 * `fuse` — the home for SEMANTIC algebraic rewrites on the RelIR tree: adjacent-node transposes that
 * buy something the block assembler and SQLite cannot.
 *
 * TWO rewrites live here: an `Aggregate` FACTORED over a cross `Join` (`factor`, below — Calcite's
 * AggregateJoinTransposeRule), and **a `Filter` pushed below a `ROW_NUMBER()` renumber `Window`** (through
 * a renaming `Project` directly above it), when nothing reads the window's column as a VALUE. Why
 * SQLite cannot do it: a window is an optimisation barrier — a predicate above `ROW_NUMBER()` cannot
 * move below it in general, because the window would then number a DIFFERENT row set. Why the
 * assembler cannot: the filter is a separate SELECT over the windowed one, by the same legality rule.
 * What it buys: `g.V().hasLabel('holder').order().by('name').V().hasLabel('person')` renumbered
 * `|holders| × |V|` rows and THEN kept the persons; transposed, the label membership seeks the
 * persons first and the window sorts `|holders| × |persons|`. Measured 61× from 1k→8k vertices before.
 *
 * SOUNDNESS. `ROW_NUMBER()` with no `PARTITION BY` over a filtered input numbers the SURVIVING rows in
 * the same order as before, only densely: the new number is a strictly increasing function of the old
 * one on the kept rows. So an answer is unchanged exactly when every reader of the minted column uses it
 * as an ORDER POSITION — a `Sort` key, another window's `ORDER BY`, an ordered aggregate's `ORDER BY`,
 * each as the bare column — and never as a value (a `rn <= k` slice, a `lag`, an arithmetic, a group
 * key, a column the user receives). `orderOnly` computes that over the whole plan, following the column
 * through renaming projections and pass-through nodes; anything it cannot classify blocks the push.
 * This relaxes Calcite's `FilterWindowTransposeRule`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/FilterWindowTransposeRule.java`),
 * which admits only a predicate over the PARTITION keys — exact for every window function, but never
 * the case for a renumber, whose partition is empty. We relax it only where order is all that is
 * observed. A PARTITIONED row_number is refused: a strictly increasing map PER partition does not keep
 * a cross-partition order.
 *
 * Encounter VALUES may renumber; the order they define does not. That is not an emulation of anything —
 * it is the same answer.
 *
 * DOES NOT BELONG HERE — each already has a home, so adding it here would be a SECOND implementation:
 *   - Adjacent `Filter`s conjoining into one `WHERE`, or a `Filter` over a `Join`: the EMITTER already
 *     renders both as one block's `WHERE` (`src/rel/emit.ts`), and SQLite pushes from there.
 *   - `Sort` + `Limit`: that is one SELECT's slots, filled by the block assembler (build-plan §5).
 *   - Collapsing a run of nodes into a `Select` mega-node: REFUSED — it would put the SQL surface
 *     inside the IR and hand every pass two forms of one thing (build-plan §5, §7).
 *
 * Design + run-order: `docs/archive/2026-08-01-relir-build-plan.md` §4. Runs BEFORE the physical `semijoin`
 * tier, so a pushed label/property predicate reaches the access-path strategies.
 */
export function fuse(plan: Rel): Rel {
  return fuseAll([plan])[0]!;
}

/**
 * `fuse` over a PROGRAM's relations — its bindings' nodes, then its result — as ONE plan: the census
 * sees every reader in every root (each root's columns leave it, so they are values), and one rewrite
 * memo keeps a node two roots share one node afterwards.
 */
export function fuseAll(plans: readonly Rel[]): readonly Rel[] {
  // Each transpose can expose another (a filter that lands on a second renumber), so to a fixpoint —
  // bounded, because every round moves at least one filter strictly lower or turns an Aggregate over a
  // cross join into one over two grouped sides, which `factor` never matches again.
  let current = plans;
  for (let round = 0; round < 64; round++) {
    const next = transposeRound(current);
    if (next === current) return current;
    current = next;
  }
  return current;
}

type Window = Extract<Rel, { readonly kind: 'window' }>;
type Project = Extract<Rel, { readonly kind: 'project' }>;
type Filter = Extract<Rel, { readonly kind: 'filter' }>;

/** Who reads what, over the whole DAG including correlated subplans — computed once per round. */
interface Census {
  readonly parents: Map<Rel, Rel[]>;
  /** Nodes whose OWN expressions name a column of the relation id. */
  readonly readers: Map<string, Rel[]>;
  /** The plan root and every correlated subplan root — their columns leave the algebra as values. */
  readonly roots: Set<Rel>;
}

function census(plans: readonly Rel[]): Census {
  const parents = new Map<Rel, Rel[]>();
  const readers = new Map<string, Rel[]>();
  const roots = new Set<Rel>(plans);
  forEachRel(plans, (r) => {
    relChildren(r).forEach((child) => parents.set(child, [...(parents.get(child) ?? []), r]));
    const named = new Set<string>();
    relExprs(r).forEach((e) => forEachExpr(e, (node) => {
      if (node.kind === 'col') named.add(node.rel);
      exprRels(node).forEach((sub) => roots.add(sub));
    }));
    named.forEach((id) => readers.set(id, [...(readers.get(id) ?? []), r]));
  });
  return { parents, readers, roots };
}

/** A renumber window: every spec a `ROW_NUMBER()` over the whole relation. */
const isRenumber = (r: Rel): r is Window =>
  r.kind === 'window' && r.specs.every(([, spec]) => spec.fn === 'row_number' && spec.spec.partitionBy.length === 0);

const isCol = (e: Expr, rel: string, name: string): boolean => e.kind === 'col' && e.rel === rel && e.name === name;

/**
 * How `reader`'s own expressions use column `name` of relation `rel`: as a VALUE (blocks), as nothing
 * but ORDER positions, or passed on under new names by a projection (`aliases`).
 */
function classify(reader: Rel, rel: string, name: string): { readonly value: boolean; readonly aliases: readonly string[] } {
  let value = false;
  const aliases: string[] = [];
  const walk = (e: Expr): void => {
    if (isCol(e, rel, name)) { value = true; return; }
    if (e.kind === 'window-expr') {
      e.args.forEach(walk);
      e.spec.partitionBy.forEach(walk);
      // A RANGE frame with an offset measures DISTANCE in the key, so it reads the key as a value.
      const ranged = e.spec.frame?.mode === 'range';
      e.spec.orderBy.forEach((term) => { if (ranged || !isCol(term.expr, rel, name)) walk(term.expr); });
      if (e.spec.frame) for (const bound of [e.spec.frame.start, e.spec.frame.end])
        if (bound.kind === 'preceding' || bound.kind === 'following') walk(bound.count);
      return;
    }
    if (e.kind === 'agg') {
      e.args.forEach(walk);
      if (e.filter) walk(e.filter);
      (e.orderBy ?? []).forEach((term) => { if (!isCol(term.expr, rel, name)) walk(term.expr); });
      return;
    }
    exprChildren(e).forEach(walk);
  };
  if (reader.kind === 'project') {
    reader.exprs.forEach(([out, e]) => { if (isCol(e, rel, name)) aliases.push(out); else walk(e); });
  } else if (reader.kind === 'sort') {
    reader.terms.forEach((term) => { if (!isCol(term.expr, rel, name)) walk(term.expr); });
  } else {
    relExprs(reader).forEach(walk);
  }
  return { value, aliases };
}

/**
 * Is every use of the window's minted columns, anywhere above it, an ORDER position? A worklist over
 * `(relation, column)` pairs carrying a minted value. A node that would mix the value with rows it does
 * not number (`Union`), compare it across rows as a value (`Distinct`), or hide it from this analysis
 * (`Recursive`, `Explode`) blocks, as does any root: a column that leaves the algebra is a value.
 */
function orderOnly(window: Window, { parents, readers, roots }: Census): boolean {
  const seen = new Map<Rel, Set<string>>();
  const work: (readonly [Rel, string])[] = window.specs.map(([name]) => [window, name] as const);
  const carry = (r: Rel, name: string): void => {
    const names = seen.get(r) ?? new Set<string>();
    if (names.has(name)) return;
    names.add(name);
    seen.set(r, names);
    work.push([r, name]);
  };
  while (work.length) {
    const [node, name] = work.pop()!;
    if (roots.has(node)) return false;
    for (const reader of readers.get(node.id) ?? []) {
      const use = classify(reader, node.id, name);
      if (use.value) return false;
      use.aliases.forEach((alias) => carry(reader, alias));
    }
    for (const parent of parents.get(node) ?? []) {
      switch (parent.kind) {
        case 'filter': case 'sort': case 'limit': case 'materialize': case 'window': carry(parent, name); break;
        case 'project': case 'aggregate': break; // their expressions were classified as readers
        case 'join': {
          const index = node.type.cols.findIndex((column) => column.name === name);
          const right = parent.right === node;
          if (right && (parent.join === 'semi' || parent.join === 'anti')) break;
          const out = parent.type.cols[(right ? parent.left.type.cols.length : 0) + index];
          if (index < 0 || !out) return false;
          carry(parent, out.name);
          break;
        }
        case 'distinct': case 'union': case 'recursive': case 'explode':
        case 'scan': case 'values': case 'self-ref': case 'ref': return false;
      }
    }
  }
  return true;
}

/** Every column of `rel` an expression names, including inside its correlated subplans. */
function colsOf(e: Expr, rel: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: Expr): void => forEachExpr(x, (node) => {
    if (node.kind === 'col' && node.rel === rel) out.add(node.name);
    exprRels(node).forEach((sub) => forEachRel(sub, (r) => relExprs(r).forEach(visit)));
  });
  visit(e);
  return out;
}

/** The one shape this pass transposes: `Filter → [Project →] Window(row_number)`, with the predicate
 *  reading the window's INPUT columns only (through bare renames), and the window column order-only. */
interface Transpose { readonly filter: Filter; readonly project?: Project; readonly window: Window; readonly rename: Map<string, string> }

function recognise(f: Filter, c: Census): Transpose | undefined {
  const below = f.input;
  const project = below.kind === 'project' ? below : undefined;
  const window = project ? project.input : below;
  if (!isRenumber(window)) return undefined;
  // Moving a SHARED node would leave its other readers on the old one: two copies of the work.
  const single = (r: Rel): boolean => (c.parents.get(r)?.length ?? 0) === 1;
  if (!single(window) || (project && !single(project))) return undefined;
  const minted = new Set(window.specs.map(([name]) => name));
  const rename = new Map<string, string>();
  for (const name of colsOf(f.pred, below.id)) {
    const source = project ? project.exprs.find(([out]) => out === name)?.[1] : { kind: 'col' as const, rel: window.id, name };
    if (!source || source.kind !== 'col' || source.rel !== window.id || minted.has(source.name)) return undefined;
    rename.set(name, source.name);
  }
  if (project && colsOf(f.pred, window.id).size) return undefined;
  return orderOnly(window, c) ? { filter: f, project, window, rename } : undefined;
}

/**
 * Rebuild `Filter(p) → [Project(q) →] Window(w) → X` as `[Project →] Window → Filter → X`, reusing the
 * three ids so every reference above and inside resolves unchanged: the new top takes the filter's id
 * (what its consumers name), the window keeps its own when a projection names it, and the pushed filter
 * takes the id the top freed, with the window's specs re-pointed at it.
 */
function transpose(mapped: Filter, t: Transpose): Rel {
  const project = t.project ? mapped.input as Project : undefined;
  const window = (project ? project.input : mapped.input) as Window;
  const x = window.input;
  const pushedId: RelId = project ? project.id : window.id;
  const pushed = make.filter({
    id: pushedId, input: x, channels: x.channels, type: x.type,
    pred: substRelId(mapped.pred, (project ?? window).id, x.id, (name) => t.rename.get(name) ?? name),
  });
  const specs = window.specs.map(([name, spec]) => [name, substRelId(spec, x.id, pushedId)] as const) as Window['specs'];
  if (!project) return make.window({ id: mapped.id, input: pushed, channels: mapped.channels, type: mapped.type, specs });
  const windowed = make.window({ id: window.id, input: pushed, channels: window.channels, type: window.type, specs });
  return make.project({ id: mapped.id, input: windowed, channels: mapped.channels, type: mapped.type, exprs: project.exprs });
}

function transposeRound(plans: readonly Rel[]): readonly Rel[] {
  const c = census(plans);
  const found = new Map<Rel, Transpose>();
  forEachRel(plans, (r) => {
    if (r.kind !== 'filter') return;
    const t = recognise(r, c);
    if (t) found.set(r, t);
  });
  if (!found.size) return factorRound(plans, c);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped, original) => {
    const t = found.get(original);
    return t && mapped.kind === 'filter' ? transpose(mapped, t) : mapped;
  }, memo));
}

// ---------- the second rule: an Aggregate factored over a cross Join ----------

type Aggregate = Extract<Rel, { readonly kind: 'aggregate' }>;
type Join = Extract<Rel, { readonly kind: 'join' }>;

/**
 * `Aggregate → Project* → Join(cross)`, with `inline` re-spelling an expression over the aggregate's input
 * as one over the join (each projection's outputs substituted by what computes them). `single` guards the
 * nodes the rewrite drops: a shared one would stay behind for its other reader, the work done twice.
 */
function overCross(a: Aggregate, single: (r: Rel) => boolean): { readonly join: Join; readonly inline: (e: Expr) => Expr } | undefined {
  const chain: Project[] = [];
  let node = a.input;
  for (; node.kind === 'project' && single(node) && !node.exprs.some(([, e]) => exprHasSubquery(e)); node = node.input) chain.push(node);
  if (node.kind !== 'join' || node.join !== 'cross' || !single(node)) return undefined;
  const inline = (e: Expr): Expr => chain.reduce((x, p) =>
    rewriteExpr(x, (n) => (n.kind === 'col' && n.rel === p.id ? p.exprs.find(([out]) => out === n.name)![1] : n)), e);
  return { join: node, inline };
}

/** Is `r` (through filters) an Aggregate grouped on nothing but `keys` — at most one row per key? */
const groupedOn = (r: Rel, keys: readonly string[]): boolean => {
  for (; r.kind === 'filter'; r = r.input);
  return r.kind === 'aggregate' && r.type.cols.slice(0, r.groupBy.length).every((column) => keys.includes(column.name));
};

const aggOf = (fn: 'sum' | 'count', ...args: Expr[]): Expr => ({ kind: 'agg', fn, args });
const times = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '*', left, right });

/**
 * Calcite's `AggregateJoinTransposeRule`
 * (`vendor/calcite/core/src/main/java/org/apache/calcite/rel/rules/AggregateJoinTransposeRule.java`), for a
 * CROSS join and the two splittable functions (`SqlSplittableAggFunction`'s `CountSplitter`/`SumSplitter`):
 * `Aggregate(G; aggs) → Join(cross, L, R)` becomes `Aggregate(G; aggs') → Join(cross, Aggregate(L; G_L; c_L,
 * sums), Aggregate(R; G_R; c_R, sums))`. Why SQLite cannot: it never transposes an aggregate and has no hash
 * join, so a GROUP BY over a cross join materialises |L|×|R| rows — the pooled re-source
 * `g.V().group().by('name').by(V().count())` is |keys|×|V|. Factored, each side is read once.
 *
 * Over a group pair (g_L, g_R) of row counts c_L, c_R: `COUNT(*) = c_L·c_R`; `SUM(x_L) = SUM_L(x)·c_R`;
 * `SUM(f_L·g_R) = SUM_L(f)·SUM_R(g)` (a NULL factor drops the pair on both sides, so an all-NULL group stays
 * NULL). Each side groups by exactly the keys G reads of it, so a pair IS a top group and every sub-total is
 * over ≥ 1 row. An integer sub-total times an integer count stays INTEGER, a REAL stays REAL. A side with NO
 * key is a scalar aggregate — one row even over empty input, where the original has no group at all — so it
 * is guarded `count > 0`. Anything else (DISTINCT, FILTER, ORDER BY, another function, HAVING, a key that is
 * not a bare column, a scalar top aggregate, a carried channel) is left alone; so is a pair whose sides are
 * both grouped on their keys already (Calcite's `uniqueCount == 2`), which is also what stops it re-firing.
 */
function factor(a: Aggregate, mint: () => (hint: string) => RelId): Rel | undefined {
  const shape = overCross(a, () => true);
  if (!shape || a.having || a.channels.length || !a.groupBy.length || a.aggs.some(([, e]) => exprHasSubquery(e))) return undefined;
  const { join: j, inline } = shape;
  const sides = [j.left, j.right] as const;
  const free = freeRelIds(j.right);
  let lateral = false;
  if (free.size) forEachRel(j.left, (r) => { lateral ||= free.has(r.id); });
  if (lateral) return undefined;
  // A cross join's every output column is one side's (`joinSide`, positionally).
  const sideOf = (name: string): 0 | 1 => (joinSide(j, name)!.side === j.left ? 0 : 1);
  /** The side an expression over the join reads (-1 neither, 2 both), and its spelling over that side. */
  const local = (e: Expr): readonly [number, Expr] => {
    let side = -1;
    const expr = rewriteExpr(e, (n) => {
      if (n.kind !== 'col' || n.rel !== j.id) return n;
      const from = joinSide(j, n.name)!;
      const s = from.side === j.left ? 0 : 1;
      side = side === -1 || side === s ? s : 2;
      return { ...n, rel: from.side.id, name: from.name };
    });
    return [side, expr];
  };
  const keys: [string[], string[]] = [[], []];
  const groupBy = a.groupBy.map(inline);
  for (const g of groupBy) {
    if (g.kind !== 'col' || g.rel !== j.id) return undefined;
    if (!keys[sideOf(g.name)].includes(g.name)) keys[sideOf(g.name)].push(g.name);
  }
  if (sides.every((side, s) => groupedOn(side, keys[s].map((name) => (local({ kind: 'col', rel: j.id, name })[1] as { name: string }).name))))
    return undefined;
  const taken = new Set(j.type.cols.map((column) => column.name));
  const pushed: [(readonly [string, Expr])[], (readonly [string, Expr])[]] = [[], []];
  const push = (s: number, agg: Expr): Expr => {
    let n = 0;
    while (taken.has(`fa${n}`)) n++;
    taken.add(`fa${n}`);
    pushed[s]!.push([`fa${n}`, agg]);
    return { kind: 'col', rel: j.id, name: `fa${n}` };
  };
  const counts = [push(0, aggOf('count')), push(1, aggOf('count'))] as const;
  const split = (e: Extract<Expr, { kind: 'agg' }>): Expr | undefined => {
    if (e.distinct || e.filter || e.orderBy?.length) return undefined;
    if (e.fn === 'count' && !e.args.length) return aggOf('sum', times(counts[0], counts[1]));
    if (e.fn !== 'sum' || e.args.length !== 1) return undefined;
    const [side, x] = local(e.args[0]!);
    if (side !== 2) return aggOf('sum', times(push(Math.max(side, 0), aggOf('sum', x)), counts[side === 1 ? 0 : 1]));
    const product = e.args[0]!;
    if (product.kind !== 'binary' || product.op !== '*') return undefined;
    const [l, lx] = local(product.left), [r, rx] = local(product.right);
    if (l === 2 || r === 2 || (l === r)) return undefined;
    const left = l === -1 ? 1 - r : l;
    return aggOf('sum', times(push(left, aggOf('sum', lx)), push(1 - left, aggOf('sum', rx))));
  };
  let failed = false;
  const top = (e: Expr): Expr => {
    if (e.kind === 'agg') return split(e) ?? ((failed = true), e);
    if (e.kind === 'col' && e.rel === j.id && !keys[sideOf(e.name)].includes(e.name)) failed = true;
    return mapExprChildren(e, top);
  };
  const aggs = a.aggs.map(([name, e]) => [name, top(inline(e))] as const);
  if (failed) return undefined;
  const meta = (name: string): ColMeta => j.type.cols.find((column) => column.name === name)!;
  const id = mint();
  const built = sides.map((side, s) => {
    const [count] = pushed[s]![0]!;
    const agg = make.aggregate({
      id: id('fa'), input: side, channels: [], groupBy: keys[s]!.map((name) => local({ kind: 'col', rel: j.id, name })[1]), aggs: pushed[s]!,
      type: { cols: [...keys[s]!.map(meta), ...pushed[s]!.map(([name]): ColMeta => ({ name, type: name === count ? 'int' : 'any', nullable: name !== count }))] },
    });
    return keys[s]!.length ? agg : make.filter({
      id: id('fa'), input: agg, channels: [], type: agg.type,
      pred: { kind: 'binary', op: '>', left: { kind: 'col', rel: agg.id, name: count }, right: compilerInt(0) },
    });
  });
  const joined = make.join({ id: j.id, left: built[0]!, right: built[1]!, join: 'cross', channels: [],
    type: { cols: [...built[0]!.type.cols, ...built[1]!.type.cols] } });
  return make.aggregate({ id: a.id, input: joined, channels: a.channels, type: a.type, groupBy, aggs });
}

function factorRound(plans: readonly Rel[], c: Census): readonly Rel[] {
  const single = (r: Rel): boolean => (c.parents.get(r)?.length ?? 0) === 1 && !c.roots.has(r);
  let mint: ((hint: string) => RelId) | undefined;
  let changed = false;
  const memo = new Map<Rel, Rel>();
  const next = plans.map((plan) => rewriteRels(plan, (mapped, original) => {
    if (mapped.kind !== 'aggregate' || original.kind !== 'aggregate' || !overCross(original, single)) return mapped;
    const factored = factor(mapped, () => (mint ??= minter(...plans).id));
    if (factored) changed = true;
    return factored ?? mapped;
  }, memo));
  return changed ? next : plans;
}
