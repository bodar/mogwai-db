import { type Expr, col } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel, Table } from '../rel.ts';
import { minter, type Minter } from '../mint.ts';
import type { RelId } from '../types.ts';
import { exprRels, forEachExpr, mapRelExprs, rewrite, rewriteExpr } from '../walk.ts';

/**
 * `seek` — a PHYSICAL rewrite: turn a property predicate that can only be CHECKED into the relation
 * the plan is DRIVEN FROM. Same rows, same algebra, different access path.
 *
 * ## Why it is a pass, and why it is not in `fuse`
 *
 * `fuse` is the reserved home for SEMANTIC rewrites — collapses that simplify the algebra. This is
 * the other kind, and Calcite draws the same line (`vendor/calcite`, at the pin: logical rules
 * rewrite what a plan MEANS, physical rules choose how it RUNS). Sharing a module would put two
 * different questions behind one name, and `fuse`'s own header already refuses that.
 *
 * It also has to be a pass rather than a decision inside the lowering, and that is the drift
 * argument rather than a tidiness one. The lowering knows this shape as "a `has(key, value)` in the
 * source position's filter run", which needs a list of which STEP NAMES fold into that run — a
 * second copy of what `sourceFilter` accepts. Add a filter step and forget the list and the seek
 * silently stops firing; add a non-filter to it and the answer is wrong. Recognising the ALGEBRA
 * has no such list: the shape below is what a correlated property filter over a bare element scan
 * looks like however it got there, so the pass cannot disagree with how `has` lowers.
 *
 * ## The shape, and what it becomes
 *
 * ```
 * Filter(Scan nodes, … EXISTS(Project(Filter(Scan vertex_properties,
 *                                            props.node = nodes.id AND props.key = k AND P(value)))) …)
 * ```
 * becomes
 * ```
 * Filter(Join(Distinct(Project(Filter(Scan vertex_properties, props.key = k AND P(value)), node)),
 *             Scan nodes, ordered, ON nodes.id = seek.sid),
 *        … the ORIGINAL predicate, unchanged …)
 * ```
 *
 * A bare `V()` is the whole table and the property predicate is usually the only selective thing the
 * traversal says about it, but as a correlated `EXISTS` in the `WHERE` there is no way to drive from
 * it — SQLite can only ask it once it already has a candidate row. Lifting it in front seeks
 * `vp_key_value(key, value)` and probes the element scan by rowid: on a 4 000-vertex graph, starting
 * at one vertex instead of at 4 000 (measured 6.2 ms → 0.3 ms, with the join order already pinned;
 * `docs/2026-08-07-query-plan-stability.md` §3·2).
 *
 * Three properties make it safe rather than clever:
 *
 * - **The predicate is REUSED, not rebuilt.** The seek is the `EXISTS`'s own sub-plan with the
 *   correlation conjunct dropped, so "what matches" is the same expression in both places by
 *   construction. A rebuilt seek even slightly narrower than the filter in front of which it stands
 *   would drop rows.
 * - **It NARROWS and never decides.** The original predicate stays on the `Filter` untouched, so this
 *   can only change which rows SQLite visits, never which rows survive.
 * - **`DISTINCT` is load-bearing.** A `Cardinality.list` key may hold the same value twice on one
 *   element, and a traverser must not be duplicated by the way we chose to FIND it.
 */
export function seek(plan: Rel): Rel {
  const mint = minter(plan);
  return rewrite(plan, (mapped) => (mapped.kind === 'filter' ? seekFilter(mapped, mint) : mapped));
}

/** The property table that holds an element table's properties, and the column naming its owner. */
const PROPERTIES: Partial<Record<Table, { readonly table: Table; readonly owner: string }>> = {
  nodes: { table: 'vertex_properties', owner: 'node' },
  edges: { table: 'edge_properties', owner: 'edge' },
};

/** Flatten an `AND` tree. A conjunct is what may be dropped independently of the rest. */
function conjuncts(e: Expr): readonly Expr[] {
  return e.kind === 'binary' && e.op === 'and' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

const conjoin = (terms: readonly Expr[]): Expr | undefined =>
  terms.reduce<Expr | undefined>((left, right) => (left ? { kind: 'binary', op: 'and', left, right } : right), undefined);

/** Does this expression name a relation other than `only` — including through a correlated subplan? */
function referencesBeyond(e: Expr, only: RelId): boolean {
  let beyond = false;
  forEachExpr(e, (node) => {
    if (node.kind === 'col' && node.rel !== only) beyond = true;
    // A nested subplan would have to be CLONED to appear in two places (two relations may not share
    // a RelId), so its presence is a decline rather than a case: `has(k, v)` and `has(k, gt(30))`
    // carry none, and inventing a general subplan clone to serve a shape nothing produces would be
    // machinery ahead of its use.
    if (exprRels(node).length) beyond = true;
  });
  return beyond;
}

/** `a = b` where one side is `col(left, leftName)` and the other `col(right, rightName)`. */
function isCorrelation(e: Expr, left: RelId, leftName: string, right: RelId, rightName: string): boolean {
  if (e.kind !== 'binary' || e.op !== '=') return false;
  const pair = [e.left, e.right];
  return pair.every((side) => side.kind === 'col')
    && pair.some((side) => side.kind === 'col' && side.rel === left && side.name === leftName)
    && pair.some((side) => side.kind === 'col' && side.rel === right && side.name === rightName);
}

/**
 * The one rewrite. Declines — returning the node untouched — on anything it does not recognise
 * exactly, which is the pass's whole contract: it is an access-path choice, so a shape it half
 * understands must be left to the planner rather than half-optimised.
 */
function seekFilter(node: Extract<Rel, { readonly kind: 'filter' }>, mint: Minter): Rel {
  const element = node.input;
  // Only over a BARE scan. A scan already narrowed by something else (`V(1,2)` lowers its id list
  // into this same Filter, which is fine — that is a conjunct) is still bare as a RELATION; what
  // this excludes is a Filter over a join/project/union, where "drive from the seek" is a claim
  // about a plan this pass did not build.
  if (element.kind !== 'scan') return node;
  const properties = PROPERTIES[element.table];
  if (!properties) return node;

  const terms = conjuncts(node.pred);
  for (const term of terms) {
    const lifted = liftSeek(term, element.id, properties, mint);
    if (!lifted) continue;
    const joined = make.join({
      id: mint.id('sj'), left: lifted, right: element, join: 'inner', ordered: true, channels: [],
      type: { cols: [{ name: 'sid', type: 'int', nullable: false }, ...element.type.cols] },
      on: { kind: 'binary', op: '=', left: col(element.id, 'id'), right: col(lifted.id, 'sid') },
    });
    // The predicate now filters the JOIN, so every reference to the scan is re-pointed at it — a
    // `Filter`'s expressions resolve against its INPUT alone (`check.ts`), and that includes the
    // correlations inside the very `EXISTS` this seek was lifted out of. The scan's columns are all
    // still there, under the same names, one position later.
    return make.filter({
      id: node.id, input: joined, channels: node.channels, type: joined.type,
      pred: retarget(node.pred, element.id, joined.id),
    });
  }
  return node;
}

/**
 * A correlated property `EXISTS`, as a free-standing relation of owner ids — or `null` if this term
 * is not one, or is one the pass declines to lift.
 *
 * The declines are the interesting part:
 * - a NEGATED exists is `hasNot`, which admits everything the seek would exclude;
 * - a predicate that constrains only `key` seeks `vp_key_value(key=?)` alone, which for a key most
 *   elements carry reads the whole table through an index instead of scanning it — that is us
 *   overruling the planner with nothing to justify it, so it stays a check;
 * - anything left referencing a relation other than the property scan is not free-standing, so
 *   lifting it would be a correlation escaping its subquery.
 */
function liftSeek(term: Expr, element: RelId, properties: { table: Table; owner: string }, mint: Minter): Rel | null {
  if (term.kind !== 'exists' || term.negated) return null;
  const probe = term.plan;
  if (probe.kind !== 'project') return null;
  const matching = probe.input;
  if (matching.kind !== 'filter') return null;
  const props = matching.input;
  if (props.kind !== 'scan' || props.table !== properties.table) return null;

  const inner = conjuncts(matching.pred);
  const correlations = inner.filter((e) => isCorrelation(e, props.id, properties.owner, element, 'id'));
  if (correlations.length !== 1) return null;
  const free = inner.filter((e) => !correlations.includes(e));
  const pred = conjoin(free);
  if (!pred || free.some((e) => referencesBeyond(e, props.id))) return null;
  // A VALUE constraint is what makes this a seek rather than a re-read of the whole key.
  let constrainsValue = false;
  for (const e of free) forEachExpr(e, (n) => { if (n.kind === 'col' && n.rel === props.id && n.name === 'value') constrainsValue = true; });
  if (!constrainsValue) return null;

  // The scan is REBUILT with a fresh id and alias rather than reused: it now appears in two places
  // (inside the EXISTS, and here), and two relations may not share a RelId.
  const scan = make.scan({ id: mint.id('sk'), table: props.table, alias: mint.alias('rsk'), channels: [], type: props.type });
  const filtered = make.filter({
    id: mint.id('sf'), input: scan, channels: [], type: scan.type,
    pred: retarget(pred, props.id, scan.id),
  });
  const owners = make.project({
    id: mint.id('sp'), input: filtered, channels: [], type: { cols: [{ name: 'sid', type: 'int', nullable: false }] },
    exprs: [['sid', col(filtered.id, properties.owner)]],
  });
  return make.distinct({ id: mint.id('sd'), input: owners, channels: [], type: owners.type });
}

/** Re-point every `Col` naming `from` at `to`, THROUGH correlated subplans — a correlation inside an
 *  `EXISTS` names the enclosing relation, so leaving it behind would resolve to a relation that is no
 *  longer the input. */
function retarget(e: Expr, from: RelId, to: RelId): Expr {
  const swap = (node: Expr): Expr => (node.kind === 'col' && node.rel === from ? col(to, node.name) : node);
  const go = (expression: Expr): Expr =>
    rewriteExpr(expression, swap, (nested) => rewrite(nested, (mapped) => mapRelExprs(mapped, go)));
  return go(e);
}
