import { type Expr, col, compilerText } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel, Table } from '../rel.ts';
import { minter, type Minter } from '../mint.ts';
import type { RelId } from '../types.ts';
import { exprRels, forEachExpr, mapRelExprs, rewrite, rewriteExpr } from '../walk.ts';

/**
 * `semijoin` — a PHYSICAL rewrite: turn a property predicate that can only be CHECKED into the
 * relation the plan is DRIVEN FROM. Same rows, same algebra, different access path.
 *
 * ## One rewrite, several access-path STRATEGIES
 *
 * The rewrite is always the same: a correlated property `EXISTS` in a `WHERE` cannot drive the plan
 * (SQLite can only ask it once it already has a candidate row), so lift it in front as a `DISTINCT`
 * relation of owner ids and INNER JOIN the element scan to it — a semi-join — leaving the ORIGINAL
 * predicate on the `Filter` untouched as the semantic authority. What VARIES is only the physical
 * relation the owner ids are seeked from: a `has(k, v)` reads `vp_key_value` (`indexSeek`); a
 * `has(k, containing(t))` reads the `property_fts` trigram index (`trigramSeek`). That is a single
 * DECORRELATION over the finished algebra with the ACCESS PATH as a pluggable sub-decision, which is
 * the split Calcite draws too (`vendor/calcite`, at the pin — a logical rewrite changes what a plan
 * MEANS, a physical rule chooses how it RUNS; a driving semi-join is `SubQueryRemoveRule` +
 * access-path selection). Each strategy is an `OwnerSeek`; the pass builds the join and retargets the
 * predicate around whichever one fires.
 *
 * ## Why it is a pass, and why it is not in `fuse`
 *
 * `fuse` is the reserved home for SEMANTIC rewrites — collapses that simplify the algebra. This is
 * the other kind, and Calcite draws the same line: logical rules rewrite what a plan MEANS, physical
 * rules choose how it RUNS. Sharing a module would put two different questions behind one name.
 *
 * It also has to be a pass rather than a decision inside the lowering, and that is the drift argument
 * rather than a tidiness one. The lowering knows this shape as "a `has(key, value)` in the source
 * position's filter run", which needs a list of which STEP NAMES fold into that run — a second copy
 * of what `sourceFilter` accepts. Add a filter step and forget the list and the seek silently stops
 * firing; add a non-filter to it and the answer is wrong. Recognising the ALGEBRA has no such list:
 * the shape below is what a correlated property filter over a bare element scan looks like however it
 * got there, so the pass cannot disagree with how `has` lowers.
 *
 * ## The shape, and what it becomes
 *
 * ```
 * Filter(Scan nodes, … EXISTS(Project(Filter(Scan vertex_properties,
 *                                            props.node = nodes.id AND props.key = k AND P(value)))) …)
 * ```
 * becomes
 * ```
 * Filter(Join(Distinct(Project(Filter(<owner rows>, props.key = k AND P(value)), owner)),
 *             Scan nodes, ordered, ON nodes.id = seek.sid),
 *        … the ORIGINAL predicate, unchanged …)
 * ```
 * where `<owner rows>` is `vertex_properties` (`indexSeek`) or the `property_fts` index
 * (`trigramSeek`). On a 4 000-vertex graph this starts at the matching vertices instead of at 4 000
 * (measured 6.2 ms → 0.3 ms for the value seek, with the join order already pinned). The platform
 * reason the plan must not lean on stats instead is `relir-build-plan` §1 P4.
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

/**
 * An access-path STRATEGY: recognise a correlated property `EXISTS` term and return the `DISTINCT`
 * relation of owner ids (projected as `sid`) it seeks — or `null` to decline (this term is not one,
 * or is one this strategy will not lift). The pass builds the join + retarget around it, so a
 * strategy owns only "what matches, and from which physical relation".
 */
export type OwnerSeek = (term: Expr, element: RelId, elementTable: Table, mint: Minter) => Rel | null;

/**
 * The pass. Tries the given strategies STRATEGY-MAJOR — every term against strategy 0, then every
 * term against strategy 1 — so a term two strategies both accept goes to the earlier one (the caller
 * orders `trigramSeek` before `indexSeek`, so a substring predicate takes the trigram index rather
 * than a base-table `LIKE`). The strategy list IS the enabled-switch read: the pass consults no
 * config and is a total function of `(plan, strategies)`, so a configuration can only change which
 * access paths are OFFERED, never whether the plan exists.
 */
export function semijoin(plan: Rel, strategies: readonly OwnerSeek[]): Rel {
  if (strategies.length === 0) return plan;
  const mint = minter(plan);
  return rewrite(plan, (mapped) => (mapped.kind === 'filter' ? semijoinFilter(mapped, strategies, mint) : mapped));
}

/**
 * The one rewrite. Declines — returning the node untouched — on anything no strategy recognises
 * exactly, which is the pass's whole contract: it is an access-path choice, so a shape it half
 * understands must be left to the planner rather than half-optimised.
 */
function semijoinFilter(node: Extract<Rel, { readonly kind: 'filter' }>, strategies: readonly OwnerSeek[], mint: Minter): Rel {
  const element = node.input;
  // Only over a BARE scan. A scan already narrowed by something else (`V(1,2)` lowers its id list
  // into this same Filter, which is fine — that is a conjunct) is still bare as a RELATION; what this
  // excludes is a Filter over a join/project/union, where "drive from the seek" is a claim about a
  // plan this pass did not build.
  if (element.kind !== 'scan') return node;

  const terms = conjuncts(node.pred);
  for (const seek of strategies) {
    for (const term of terms) {
      const lifted = seek(term, element.id, element.table, mint);
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
  }
  return node;
}

// ---------- shared helpers ----------

/** Flatten an `AND` tree. A conjunct is what may be dropped independently of the rest. */
function conjuncts(e: Expr): readonly Expr[] {
  return e.kind === 'binary' && e.op === 'and' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

const conjoin = (terms: readonly Expr[]): Expr | undefined =>
  terms.reduce<Expr | undefined>((left, right) => (left ? { kind: 'binary', op: 'and', left, right } : right), undefined);

const andAll = (parts: readonly Expr[]): Expr => parts.reduce((left, right) => ({ kind: 'binary', op: 'and', left, right }));
const eq = (left: Expr, right: Expr): Expr => ({ kind: 'binary', op: '=', left, right });

/** Re-point every `Col` naming `from` at `to`, THROUGH correlated subplans — a correlation inside an
 *  `EXISTS` names the enclosing relation, so leaving it behind would resolve to a relation that is no
 *  longer the input. */
function retarget(e: Expr, from: RelId, to: RelId): Expr {
  const swap = (node: Expr): Expr => (node.kind === 'col' && node.rel === from ? col(to, node.name) : node);
  const go = (expression: Expr): Expr =>
    rewriteExpr(expression, swap, (nested) => rewrite(nested, (mapped) => mapRelExprs(mapped, go)));
  return go(e);
}

/** `a = b` where one side is `col(left, leftName)` and the other `col(right, rightName)`. */
function isCorrelation(expr: Expr, left: RelId, leftName: string, right: RelId, rightName: string): boolean {
  if (expr.kind !== 'binary' || expr.op !== '=') return false;
  const pair = [expr.left, expr.right];
  return pair.every((side) => side.kind === 'col')
    && pair.some((side) => side.kind === 'col' && side.rel === left && side.name === leftName)
    && pair.some((side) => side.kind === 'col' && side.rel === right && side.name === rightName);
}

// ---------- indexSeek: the base property index (`propertySeek`) ----------

/** The property table that holds an element table's properties, and the column naming its owner. */
const SEEK_PROPERTIES: Partial<Record<Table, { readonly table: Table; readonly owner: string }>> = {
  nodes: { table: 'vertex_properties', owner: 'node' },
  edges: { table: 'edge_properties', owner: 'edge' },
};

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

/**
 * A correlated property `EXISTS` over the base property table, as a `DISTINCT` relation of owner ids
 * — or `null` if this term is not one, or is one the strategy declines to lift.
 *
 * The declines are the interesting part:
 * - a NEGATED exists is `hasNot`, which admits everything the seek would exclude;
 * - a predicate that constrains only `key` seeks `vp_key_value(key=?)` alone, which for a key most
 *   elements carry reads the whole table through an index instead of scanning it — that is us
 *   overruling the planner with nothing to justify it, so it stays a check;
 * - anything left referencing a relation other than the property scan is not free-standing, so
 *   lifting it would be a correlation escaping its subquery.
 */
export const indexSeek: OwnerSeek = (term, element, elementTable, mint) => {
  const properties = SEEK_PROPERTIES[elementTable];
  if (!properties) return null;
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
};

// ---------- trigramSeek: the property_fts trigram index (`ftsSubstringPredicate`) ----------

/** A physical TextP access path. The generic correlated EXISTS remains above the join and is the
 * semantic authority; this only drives a bare element scan from matching FTS owner ids. */
const FTS_PROPERTIES: Partial<Record<Table, { readonly owner: string; readonly ownerElem: 'node' | 'edge' }>> = {
  nodes: { owner: 'node', ownerElem: 'node' }, edges: { owner: 'edge', ownerElem: 'edge' },
};
const FTS_TYPE = { cols: [
  { name: 'owner_elem', type: 'text', nullable: false }, { name: 'pid', type: 'int', nullable: false },
  { name: 'owner', type: 'int', nullable: false }, { name: 'pk', type: 'text', nullable: false },
  { name: 'kind', type: 'text', nullable: false }, { name: 'text', type: 'text', nullable: false },
] } as const;

export const trigramSeek: OwnerSeek = (term, element, elementTable, mint) => {
  const properties = FTS_PROPERTIES[elementTable];
  if (!properties) return null;
  if (term.kind !== 'exists' || term.negated || term.plan.kind !== 'project' || term.plan.input.kind !== 'filter') return null;
  const matching = term.plan.input;
  if (matching.input.kind !== 'scan') return null;
  const props = matching.input;
  const all = conjuncts(matching.pred);
  const corr = all.filter((e) => ftsCorrelation(e, props.id, properties.owner, element));
  if (corr.length !== 1) return null;
  const free = all.filter((e) => !corr.includes(e));
  const key = literalEq(free, props.id, 'key');
  const pattern = likePattern(free, props.id);
  if (key == null || pattern == null || literalTerm(pattern).length < 3) return null;
  if (hasNegativeText(free)) return negativeOwners(props, properties, key, pattern, mint);
  return positiveOwners(properties, key, pattern, mint);
};

/** Positive TextP can start directly from matching FTS rows. */
function positiveOwners(properties: { readonly ownerElem: 'node' | 'edge' }, key: string, pattern: Expr, mint: Minter): Rel {
  const scan = make.scan({ id: mint.id('fs'), table: 'property_fts', alias: mint.alias('rfs'), channels: [], type: FTS_TYPE });
  const pred = andAll([
    eq(col(scan.id, 'owner_elem'), compilerText(properties.ownerElem)), eq(col(scan.id, 'pk'), compilerText(key)),
    eq(col(scan.id, 'kind'), compilerText('value')),
    { kind: 'call', fn: 'like', args: [pattern, col(scan.id, 'text'), compilerText('\\')] },
  ]);
  const filtered = make.filter({ id: mint.id('ff'), input: scan, channels: [], type: scan.type, pred });
  const owners = make.project({ id: mint.id('fp'), input: filtered, channels: [], type: { cols: [{ name: 'sid', type: 'int', nullable: false }] }, exprs: [['sid', col(filtered.id, 'owner')]] });
  return make.distinct({ id: mint.id('fd'), input: owners, channels: [], type: owners.type });
}

/**
 * Negative TextP has existential property semantics: a multi-property owner survives when ANY value
 * does not match, not only when NONE match. FTS is positive-only, so the complementary access path
 * begins at keyed property rows and anti-probes the matching FTS entry for each typed string. A
 * non-string (or legacy untagged) row is deliberately retained as a candidate — it may satisfy the
 * negative predicate — and the untouched generic EXISTS still makes the final decision.
 *
 * This is a physical narrowing, never an alternate meaning: a missing/stale index merely leaves more
 * candidates, while it cannot remove an actual negative match.
 */
function negativeOwners(
  props: Extract<Rel, { readonly kind: 'scan' }>, properties: { readonly owner: string; readonly ownerElem: 'node' | 'edge' },
  key: string, pattern: Expr, mint: Minter,
): Rel {
  // `hasPropertyClause` needs only owner/key/value/vtype and intentionally leaves the physical
  // property rowid out of its local schema. This pass joins FTS by `pid`, so its independent scan
  // declares that real storage column explicitly rather than pretending the generic probe carried it.
  const rows = make.scan({ id: mint.id('ns'), table: props.table, alias: mint.alias('rns'), channels: [],
    type: { cols: [{ name: 'id', type: 'int', nullable: false }, ...props.type.cols] } });
  const fts = make.scan({ id: mint.id('nfs'), table: 'property_fts', alias: mint.alias('rnfs'), channels: [], type: FTS_TYPE });
  const matchingFts = make.filter({ id: mint.id('nff'), input: fts, channels: [], type: fts.type, pred: andAll([
    eq(col(fts.id, 'owner_elem'), compilerText(properties.ownerElem)),
    eq(col(fts.id, 'pid'), col(rows.id, 'id')), eq(col(fts.id, 'pk'), compilerText(key)),
    eq(col(fts.id, 'kind'), compilerText('value')),
    { kind: 'call', fn: 'like', args: [pattern, col(fts.id, 'text'), compilerText('\\')] },
  ]) });
  const probe = make.project({ id: mint.id('nfp'), input: matchingFts, channels: [], type: { cols: [{ name: 'one', type: 'int', nullable: false }] }, exprs: [['one', compilerText('1')] ] });
  const candidates = make.filter({ id: mint.id('nf'), input: rows, channels: [], type: rows.type, pred: andAll([
    eq(col(rows.id, 'key'), compilerText(key)),
    { kind: 'binary', op: 'or', left: { kind: 'binary', op: 'is not', left: col(rows.id, 'vtype'), right: compilerText('string') }, right: { kind: 'exists', plan: probe, negated: true } },
  ]) });
  const owners = make.project({ id: mint.id('np'), input: candidates, channels: [], type: { cols: [{ name: 'sid', type: 'int', nullable: false }] }, exprs: [['sid', col(candidates.id, properties.owner)]] });
  return make.distinct({ id: mint.id('nd'), input: owners, channels: [], type: owners.type });
}

function ftsCorrelation(e: Expr, props: RelId, owner: string, element: RelId): boolean {
  if (e.kind !== 'binary' || e.op !== '=') return false;
  const p = (x: Expr): boolean => x.kind === 'col' && x.rel === props && x.name === owner;
  const el = (x: Expr): boolean => x.kind === 'col' && x.rel === element && x.name === 'id';
  return (p(e.left) && el(e.right)) || (p(e.right) && el(e.left));
}
function literalEq(parts: readonly Expr[], rel: RelId, name: string): string | null {
  for (const e of parts) if (e.kind === 'binary' && e.op === '=') {
    const pair = [e.left, e.right];
    if (pair.some((x) => x.kind === 'col' && x.rel === rel && x.name === name)) {
      const lit = pair.find((x): x is Extract<Expr, { kind: 'lit' }> => x.kind === 'lit' && x.source === 'compiler-text');
      if (lit) return lit.value as string;
    }
  }
  return null;
}
function likePattern(parts: readonly Expr[], rel: RelId): Expr | null {
  let found: Expr | null = null;
  for (const part of parts) forEachExpr(part, (e) => {
    if (e.kind === 'call' && e.fn.toLowerCase() === 'like' && e.args[1]?.kind === 'col' && e.args[1].rel === rel && e.args[1].name === 'value') found = e.args[0];
  });
  return found;
}
function hasNegativeText(parts: readonly Expr[]): boolean {
  let found = false;
  for (const part of parts) forEachExpr(part, (e) => { found ||= e.kind === 'binary' && e.op === 'is not'; });
  return found;
}
/** Literal-only: parameters deliberately use the generic plan, preserving the old fast-path scope. */
function literalTerm(pattern: Expr): string {
  let raw: string | null = null;
  forEachExpr(pattern, (e) => {
    if (e.kind === 'call' && e.fn.toLowerCase() === 'replace' && e.args[0]?.kind === 'lit' && e.args[0].source === 'compiler-text' && raw == null) raw = e.args[0].value;
  });
  return raw ?? '';
}
