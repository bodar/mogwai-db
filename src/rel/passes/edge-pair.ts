import { type Expr, col, conjuncts } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel } from '../rel.ts';
import { columnPath, definingPath, type ColumnPath } from '../lineage.ts';
import { minter, type Minter } from '../mint.ts';
import type { RelId } from '../types.ts';
import { exprRels, forEachExpr, forEachRel, relChildren, rewriteRels } from '../walk.ts';

/**
 * `edgePair` — a PHYSICAL rewrite: an `edges` read whose BOTH endpoints are pinned by equality is a point
 * lookup, so give SQLite an index prefix it can seek as one. Same rows; a different access path.
 *
 * ## The shape, and why SQLite does not find it
 *
 * Adjacency is covered by two indexes, `e_out(src, label, tgt)` and `e_in(tgt, label, src)` (`src/storage.ts`).
 * A test "is there an edge between THESE two vertices" with no label — the cycle-closing `where(in().as('a'))`,
 * `as('c').select('a').out().where(eq('c'))`, the triangle's `repeat(both()).times(2).where(out().as('a'))`, a
 * walk condition testing adjacency to its start label — pins `src` and `tgt` and leaves `label` free, so neither
 * index has both pinned columns as a prefix: the planner seeks ONE endpoint and filters the other, reading that
 * endpoint's whole neighbourhood per probe. One probe per traverser at a hub is the hub's degree per row, so the
 * cost grows as traversers × degree — measured 24–46× per 8× on the hub graph
 * (`test/compiler/walk-condition-hub-scale.exec.test.ts`; `edge-pair.exec.test.ts` the answers and the plan), an
 * outage no six-vertex fixture shows.
 *
 * ## What it becomes
 *
 * The scan is read through `label IN (SELECT id FROM labels)`. Every edge's label is an interned `labels` id
 * (the writers intern before they insert; `label()` reads the name back through the same table), so the
 * conjunct is TRUE of every edge row and changes no answer. What it changes is that every column of either
 * index is now constrained by an equality or a constant `IN`, so a probe is `|labels|` index seeks — the
 * skip-scan SQLite would choose itself if it had `sqlite_stat1`, which a graph here does not
 * (`docs/archive/2026-08-01-relir-build-plan.md` §1 P4). Its cost per probe is bounded by the graph's label
 * VOCABULARY, a property of its schema, not by how many edges a vertex has.
 *
 * ## When
 *
 * Both endpoints are compared, in a `Filter` or a join's `ON` anywhere in the plan, to a value FIXED for the block
 * (`fixed`: a constant or an outer row's column) — the endpoint traced through any renaming projection, join or
 * `UNION ALL` arm by `columnPath`, the lineage authority `semijoin` and `leading` share. A join key between two
 * relations of one block (a movement's next hop) is not a lookup, nor is a `src = tgt` self-loop test; a scan whose `label` a conjunct already constrains (`in('knows')` lowers to a `label IN (…)` of its
 * own) has its index prefix already. The conjunct is a tautology, so a wrong guess here could cost only a plan,
 * never a row. A total identity on every other shape, like `semijoin` and `leading`; it recognises the ALGEBRA,
 * so every host — `where`, a walk condition, a `match`, any depth — gets it with no list of positions.
 */
export function edgePairAll(plans: readonly Rel[]): readonly Rel[] {
  const pinned = pinnedScans(plans);
  if (pinned.size === 0) return plans;
  const mint = minter(...plans);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped) => (mapped.kind === 'scan' && pinned.has(mapped.id) ? throughLabels(mapped, mint) : mapped), memo));
}

type Endpoint = 'src' | 'tgt' | 'label';

/** The `edges` scans the plan pins at both endpoints and leaves `label` free. */
function pinnedScans(plans: readonly Rel[]): ReadonlySet<RelId> {
  const seen = new Map<RelId, Set<Endpoint>>();
  const note = (scan: RelId, what: Endpoint): void => { const s = seen.get(scan) ?? new Set(); s.add(what); seen.set(scan, s); };
  /** The `edges` scans and columns `top`'s column `rel.name` is read from — one per arm where the way down crosses
   *  a `UNION ALL` (`both()` is one: SQLite pushes a `WHERE` over a compound subquery into each arm, so an arm's
   *  endpoint is pinned by a test stated above the union). Empty for anything else. */
  const edgeColumns = (top: Rel, rel: RelId, name: string): readonly { readonly scan: RelId; readonly name: string }[] => {
    const path = pathFrom(top, rel, name);
    const leaf = path?.rels.at(-1);
    if (leaf?.kind === 'scan') return leaf.table === 'edges' ? [{ scan: leaf.id, name: path!.name }] : [];
    if (leaf?.kind !== 'union' || !leaf.all) return [];
    const at = leaf.type.cols.findIndex((c) => c.name === path!.name);
    return leaf.inputs.flatMap((arm) => { const armCol = arm.type.cols[at]; return armCol ? edgeColumns(arm, arm.id, armCol.name) : []; });
  };
  const columnsRead = (top: Rel, e: Expr) => {
    const out: { readonly scan: RelId; readonly name: string }[] = [];
    forEachExpr(e, (node) => { if (node.kind === 'col') out.push(...edgeColumns(top, node.rel, node.name)); });
    return out;
  };
  const visit = (top: Rel, pred: Expr | undefined): void => {
    if (!pred) return;
    for (const term of conjuncts(pred)) {
      for (const at of columnsRead(top, term)) if (at.name === 'label') note(at.scan, 'label');
      if (term.kind !== 'binary' || term.op !== '=') continue;
      for (const [side, other] of [[term.left, term.right], [term.right, term.left]] as const) {
        if (side.kind !== 'col') continue;
        const ends = edgeColumns(top, side.rel, side.name).filter((at) => at.name === 'src' || at.name === 'tgt');
        if (ends.length && fixed(top, other)) for (const at of ends) note(at.scan, at.name as Endpoint);
      }
    }
  };
  forEachRel(plans, (r) => {
    if (r.kind === 'filter') visit(r.input, r.pred);
    else if (r.kind === 'join') visit(r, r.on);
  });
  return new Set([...seen].filter(([, s]) => s.has('src') && s.has('tgt') && !s.has('label')).map(([id]) => id));
}

/**
 * Is `e`, seen from `top`, ONE value per evaluation of `top` — a constant, an OUTER row's column, or a projection of
 * those (a correlated body's seed row, `lower/scoped.ts` `seedRow`, re-projects the host's columns; a union arm
 * projects them per arm)? Only then is an endpoint equated with it a POINT lookup. An endpoint equated with a
 * column another relation of the same block produces (`rme12.src = u10.id` — the next hop of a movement) is a join
 * KEY: the planner drives it from one side and seeks the other by that key's prefix, and reading the scan through
 * the label vocabulary would turn each such seek into `|labels|` seeks.
 */
function fixed(top: Rel, e: Expr): boolean {
  let ok = true;
  forEachExpr(e, (node) => {
    if (!ok) return;
    if (exprRels(node).length) { ok = false; return; }
    if (node.kind !== 'col') return;
    const path = pathFrom(top, node.rel, node.name);
    if (!path) return; // an outer row
    const leaf = path.rels.at(-1)!;
    const at = leaf.type.cols.findIndex((c) => c.name === path.name);
    switch (leaf.kind) {
      case 'project': {
        const defined = leaf.exprs.find(([name]) => name === path.name)?.[1];
        ok = defined !== undefined && fixed(leaf.input, defined);
        return;
      }
      case 'values': ok = at >= 0 && leaf.rows.every((row) => row[at] !== undefined && fixed(leaf, row[at]!)); return;
      case 'union': ok = at >= 0 && leaf.inputs.every((arm) => { const c = arm.type.cols[at]; return c !== undefined && fixed(arm, col(arm.id, c.name)); }); return;
      default: ok = false;
    }
  });
  return ok;
}

/** `scan` read through the label membership, under the scan's own id so every column that names it still resolves. */
function throughLabels(scan: Extract<Rel, { readonly kind: 'scan' }>, mint: Minter): Rel {
  const base = make.scan({ ...scan, id: mint.id('epe') });
  const labels = make.scan({
    id: mint.id('lbl'), table: 'labels', alias: mint.alias('rl'), channels: [],
    type: { cols: [{ name: 'id', type: 'int', nullable: false }, { name: 'name', type: 'text', nullable: false }] },
  });
  const ids = make.project({
    id: mint.id('lbi'), input: labels, channels: [], type: { cols: [{ name: 'id', type: 'int', nullable: false }] },
    exprs: [['id', col(labels.id, 'id')]],
  });
  return make.filter({
    id: scan.id, input: base, channels: scan.channels, type: scan.type,
    pred: { kind: 'in-query', expr: col(base.id, 'label'), plan: ids, negated: false },
  });
}

/**
 * `columnPath`, without searching the spine when the column names `top` or one of its direct inputs — the common
 * case, and the one a long chain of joins makes costly: `spinePath` walks the left subtree before the right, so
 * asking each link of a K-link chain for its right side's column costs every link beneath it (K² over the chain;
 * the same ordering `freeRelIds` was fixed for, `test/compiler/host-unroll-width.exec.test.ts`).
 */
function pathFrom(top: Rel, rel: RelId, name: string): ColumnPath | null {
  if (top.id === rel) return definingPath(top, name);
  const direct = relChildren(top).find((child) => child.id === rel);
  if (!direct) return columnPath(top, rel, name);
  const below = definingPath(direct, name);
  return { rels: [top, ...below.rels], names: [null, ...below.names], name: below.name };
}
