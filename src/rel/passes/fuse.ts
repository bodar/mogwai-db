import type { Expr } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel } from '../rel.ts';
import type { RelId } from '../types.ts';
import { exprChildren, exprRels, forEachExpr, forEachRel, relChildren, relExprs, rewriteRels, substRelId } from '../walk.ts';

/**
 * `fuse` — the home for SEMANTIC algebraic rewrites on the RelIR tree: adjacent-node transposes that
 * buy something the block assembler and SQLite cannot.
 *
 * ONE rewrite lives here today: **a `Filter` pushed below a `ROW_NUMBER()` renumber `Window`** (through
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
  // bounded, because every round moves at least one filter strictly lower.
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
  if (!found.size) return plans;
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped, original) => {
    const t = found.get(original);
    return t && mapped.kind === 'filter' ? transpose(mapped, t) : mapped;
  }, memo));
}
