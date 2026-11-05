import { type Expr, and, col, compilerText, conjoin, eq, isNot, or } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel, Table } from '../rel.ts';
import { freshCopy, minter, type Minter } from '../mint.ts';
import { rowBounds } from '../bounds.ts';
import type { RelId } from '../types.ts';
import { exprRels, forEachExpr, forEachRel, freeRelIds, mapRelExprs, relChildren, relExprs, rewrite, rewriteExpr, rewriteRels } from '../walk.ts';

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
 * reason the plan must not lean on stats instead is `docs/archive/2026-08-01-relir-build-plan.md` §1 P4.
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
 * WHERE a seek's owner ids land: the column a property `EXISTS` correlates its owner with (`rel.name`,
 * an element id), the element table that id keys, and what the seek's predicate may read besides the
 * property row.
 *
 * `local` is `null` for a SELF-CONTAINED seek — one the pass lifts into the plan's `FROM`, where nothing
 * outside it is in scope. Otherwise it answers whether a column is the element side's OWN: a CORRELATED
 * seek (`has(k, select('e'))`, whose value is read off an OUTER row) may read any column in scope except
 * those, because a value read off the very row being driven cannot drive it.
 */
export interface SeekTarget {
  readonly rel: RelId;
  readonly name: string;
  readonly table: Table;
  readonly local: ((column: { readonly rel: RelId; readonly name: string }) => boolean) | null;
}

/**
 * An access-path STRATEGY: recognise a correlated property `EXISTS` term and return the `DISTINCT`
 * relation of owner ids (projected as `sid`) it seeks — or `null` to decline (this term is not one,
 * or is one this strategy will not lift). The pass builds the join (or the narrowing `IN`) + retarget
 * around it, so a strategy owns only "what matches, and from which physical relation".
 */
export type OwnerSeek = (term: Expr, target: SeekTarget, mint: Minter) => Rel | null;

/**
 * The pass. Tries the given strategies STRATEGY-MAJOR — every term against strategy 0, then every
 * term against strategy 1 — so a term two strategies both accept goes to the earlier one (the caller
 * orders `trigramSeek` before `indexSeek`, so a substring predicate takes the trigram index rather
 * than a base-table `LIKE`). The strategy list IS the enabled-switch read: the pass consults no
 * config and is a total function of `(plan, strategies)`, so a configuration can only change which
 * access paths are OFFERED, never whether the plan exists.
 *
 * It walks with `rewriteRels`, so a `Filter` inside a CORRELATED subplan — a `group().by()` value
 * traversal, a `where`/`local` body, a federated sibling's per-key count — is reached exactly as one on
 * the spine is: depth comes from the walker, never from a list of positions.
 */
export function semijoin(plan: Rel, strategies: readonly OwnerSeek[]): Rel {
  return semijoinAll([plan], strategies)[0]!;
}

/** `semijoin` over a PROGRAM's relations — its bindings' nodes, then its result — as one plan: fresh
 *  names minted against all of them, and one rewrite memo, so a node two roots share stays one node. */
export function semijoinAll(plans: readonly Rel[], strategies: readonly OwnerSeek[]): readonly Rel[] {
  if (strategies.length === 0) return plans;
  const mint = minter(...plans);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped) => (mapped.kind === 'filter' ? semijoinFilter(mapped, strategies, mint) : mapped), memo));
}

/**
 * The one rewrite. Declines — returning the node untouched — on anything no strategy recognises
 * exactly, which is the pass's whole contract: it is an access-path choice, so a shape it half
 * understands must be left to the planner rather than half-optimised.
 *
 * Two placements, one owner relation. Over a BARE element scan a self-contained seek is LIFTED in front
 * as the relation the plan is driven from. Anywhere else — the element is one `FROM` item of a join (a
 * re-source `V()` after a label, `inject(…).unfold()`), or the seek reads an outer row — it NARROWS:
 * `element.id IN (<owner ids>)` is added beside the predicate (`narrowFilter`).
 */
function semijoinFilter(node: Extract<Rel, { readonly kind: 'filter' }>, strategies: readonly OwnerSeek[], mint: Minter): Rel {
  const element = node.input;
  const terms = conjuncts(node.pred);
  // Lifted only over a BARE scan. A scan already narrowed by something else (`V(1,2)` lowers its id
  // list into this same Filter, which is fine — that is a conjunct) is still bare as a RELATION; what
  // this excludes is a Filter over a join/project/union, where "drive from the seek" is a claim about
  // a plan this pass did not build.
  if (element.kind !== 'scan') return narrowFilter(node, terms, strategies, mint) ?? node;
  const target: SeekTarget = { rel: element.id, name: 'id', table: element.table, local: null };
  for (const seek of strategies) {
    for (const term of terms) {
      const lifted = seek(term, target, mint);
      if (!lifted) continue;
      const joined = make.join({
        id: mint.id('sj'), left: lifted, right: element, join: 'inner', ordered: true, channels: [],
        type: { cols: [{ name: 'sid', type: 'int', nullable: false }, ...element.type.cols] },
        on: eq(col(element.id, 'id'), col(lifted.id, 'sid')),
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
  return narrowFilter(node, terms, strategies, mint) ?? node;
}

/**
 * The NARROWING placement: `element.id IN (<owner ids>)` beside the predicate — or `null` where no term
 * gives one.
 *
 * `EXISTS(props WHERE props.owner = X AND P)` and `X IN (SELECT owner FROM props WHERE P)` hold of
 * exactly the same rows, so the conjunct can change which rows SQLite VISITS and never which survive;
 * the original `EXISTS` stays where it is as the semantic authority. What it buys is the access path:
 * SQLite drives an `IN` over a rowid from the subquery's rows, and the subquery reads `vp_key_value
 * (key, value)` — re-evaluated per OUTER row when `P` reads one (a `has(k, select('e'))`), which is
 * the per-outer-row seek a correlated value needs. Without it the `EXISTS` can only CHECK each element
 * after a full scan, which is outer × elements: measured 818 ms at 1k → 3.2 s at 2k vertices on
 * `g.V().values('name').as('e').V().has('name', select('e')).count()`, and 3.6 ms with the conjunct.
 *
 * SELF-CONTAINED seeks are tried before CORRELATED ones, so a constant `has(k, v)` drives in preference
 * to a value read per outer row.
 *
 * THE SEEK IS PINNED AS THE ACCESS PATH, as the lifted form pins it with an order-fenced join. Another
 * membership test on the same column — `hasLabel('p')` after a re-source lowers to `id IN (<every p>)` —
 * is computed ONCE, so SQLite (with no statistics, `docs/archive/2026-08-01-relir-build-plan.md` §1 P4)
 * prefers it to a subquery re-run per outer row and drives the element from EVERY labelled vertex per
 * outer row: measured 1.1 s at 1k → 73 s at 8k. Such a test stays, as a check, under SQLite's documented
 * index fence (`noindex`, unary `+`); the value seek drives. That is the lifted seek's own policy — a
 * property VALUE is the selective access path, a label the coarse one.
 */
function narrowFilter(node: Extract<Rel, { readonly kind: 'filter' }>, terms: readonly Expr[], strategies: readonly OwnerSeek[], mint: Minter): Rel | null {
  for (const correlated of [false, true]) {
    for (const seek of strategies) {
      for (const term of terms) {
        const target = drivenElement(node, term, correlated);
        const owners = target && seek(term, target, mint);
        if (!target || !owners) continue;
        // `IN` is a set test, so the strategy's `DISTINCT` (load-bearing only for a JOIN) is dropped.
        const ids = owners.kind === 'distinct' ? owners.input : owners;
        const element = columnPath(node.input, target.rel, target.name)!.rels.at(-1);
        const sameElement = (e: Expr): boolean => {
          if (e.kind !== 'col') return false;
          const traced = columnPath(node.input, e.rel, e.name);
          return traced?.name === 'id' && traced.rels.at(-1) === element;
        };
        const demote = (e: Expr): Expr => (e.kind === 'in-query' && !e.negated && sameElement(e.expr)
          ? { ...e, expr: { kind: 'unary', op: 'noindex', arg: e.expr } } : e);
        // A competing test may sit in a Filter STACKED beneath this one (the emitter renders the stack
        // as one `WHERE`). The stack is folded into this node to demote it — the same conjunction, so
        // the same rows — rather than rebuilt in place: a beneath Filter may be shared, and a rebuilt
        // copy would be a second relation under its `RelId`.
        const stack: Extract<Rel, { readonly kind: 'filter' }>[] = [];
        let base: Rel = node.input;
        while (base.kind === 'filter') { stack.push(base); base = base.input; }
        // An element the query restricts by its KEY (`hasId(…)`, `has(T.id, lt(4))`, `V(1)` mid-chain) is
        // already reached by that key, which no value seek beats — it stays the access path, and this
        // element is not narrowed at all. Nor is one an earlier narrowing already drives, unless this seek
        // is CONSTANT and that one per-outer-row: a constant seek outranks a correlated one.
        const all = [...stack.flatMap((f) => conjuncts(f.pred)), ...terms];
        if (all.some((e) => keyRestricts(e, sameElement) || seekedBy(e, sameElement, correlated))) continue;
        const competes = (f: Extract<Rel, { readonly kind: 'filter' }>) => conjuncts(f.pred).some((e) => demote(e) !== e);
        const folded = stack.length > 0 && stack.some(competes) ? stack : [];
        const input = folded.length ? base : node.input;
        const rebase = (e: Expr): Expr => folded.reduce((x, f) => retarget(x, f.id, base.id), e);
        const checks = (folded.length ? all : terms).map(demote).map(rebase);
        return make.filter({
          id: node.id, input, channels: node.channels, type: node.type,
          pred: andAll([rebase({ kind: 'in-query', expr: col(target.rel, target.name), plan: ids, negated: false }), ...checks]),
        });
      }
    }
  }
  return null;
}

/**
 * The element a property `EXISTS` term could be DRIVEN into by a narrowing seek, or `null`.
 *
 * Narrowing only pays where the element would otherwise be SCANNED — and costs where it would not: a
 * correlated `IN` is a subquery SQLite re-runs per outer row, so over an element the plan already reaches
 * by key (`out()`'s edge target, `V(1)`, `V('u0')`) it would turn a rowid probe into a seek of every
 * owner holding the value. So the term's owner column must trace (`columnPath`) to an element table's
 * `id`, through filters, renaming projections and joins where each join on the way:
 * - is INNER/CROSS, and its `ON` never reads the element's side (no join condition already drives it);
 * - does not hold the element as the OUTER side of an order fence (`CROSS JOIN` pins it as the outer
 *   loop, so a seek correlated to an inner row would run per pair).
 * And the element's side must be UNBOUNDED by the row-count authority (`rowBounds`, `src/rel/bounds.ts`)
 * — an id membership the query text states, `V(1)` and `V('u0')` alike, is already a bound.
 */
function drivenElement(node: Extract<Rel, { readonly kind: 'filter' }>, term: Expr, correlated: boolean): SeekTarget | null {
  const owner = ownerColumn(term);
  if (!owner) return null;
  const path = columnPath(node.input, owner.rel, owner.name);
  const leaf = path?.rels.at(-1);
  if (!path || leaf?.kind !== 'scan' || path.name !== 'id' || SEEK_PROPERTIES[leaf.table]?.table !== owner.properties) return null;
  // The element's SIDE: the relation under the last join on the way down, or the whole input.
  let side: Rel = node.input;
  for (let i = 0; i < path.rels.length - 1; i++) {
    const at = path.rels[i]!;
    if (at.kind !== 'join') continue;
    const next = path.rels[i + 1]!;
    if (at.join !== 'inner' && at.join !== 'cross') return null;
    if (next === at.left && (at.join === 'cross' || at.ordered === true)) return null;
    if (at.on) { const ids = idsWithin(next); if (readsColumn(at.on, (c) => ids.has(c.rel))) return null; }
    side = next;
  }
  if (rowBounds(side === node.input ? node : side).max !== Infinity) return null;
  if (!correlated) return { rel: owner.rel, name: owner.name, table: leaf.table, local: null };
  const sideIds = idsWithin(side);
  // A column is the element's own when it is read off the side directly, or traces into it through the
  // projections and joins above it. A relation outside the input is an OUTER row — never local.
  const local = (c: { readonly rel: RelId; readonly name: string }): boolean => {
    if (sideIds.has(c.rel)) return true;
    const traced = columnPath(node.input, c.rel, c.name);
    return traced !== null && traced.rels.includes(side);
  };
  return { rel: owner.rel, name: owner.name, table: leaf.table, local };
}

/**
 * Does conjunct `e` restrict the element (`onElement` recognises its id column) by the element's KEY — a
 * literal `=`/`IN` list, a membership the row-count authority bounds, or a membership in ids selected by the
 * element table's own `id`/`uid` (`has(T.id, lt(4))`) or exploded from a set the user sent (`V($ids)`)?
 * Anything else — a label's or another property's membership — is a coarser access path than a value seek.
 */
function keyRestricts(e: Expr, onElement: (x: Expr) => boolean): boolean {
  if (e.kind === 'in-list') return onElement(e.expr);
  if (e.kind === 'binary' && e.op === '=') return (onElement(e.left) && e.right.kind === 'lit') || (onElement(e.right) && e.left.kind === 'lit');
  if (e.kind !== 'in-query' || e.negated || !onElement(e.expr)) return false;
  if (rowBounds(e.plan).max !== Infinity) return true;
  let r: Rel = e.plan;
  while (r.kind === 'project' || r.kind === 'distinct' || r.kind === 'filter') {
    if (r.kind === 'filter' && r.input.kind === 'scan' && SEEK_PROPERTIES[r.input.table]) {
      const scan = r.input.id;
      return readsColumn(r.pred, (c) => c.rel === scan && (c.name === 'id' || c.name === 'uid'));
    }
    r = r.input;
  }
  return r.kind === 'explode';
}

/** Is conjunct `e` a property-value narrowing of the element (`narrowFilter`'s own form) that a new seek —
 *  `correlated` or not — must not displace? Any does when the new one is correlated; only a correlated one
 *  yields to a constant seek. */
function seekedBy(e: Expr, onElement: (x: Expr) => boolean, correlated: boolean): boolean {
  if (e.kind !== 'in-query' || e.negated || !onElement(e.expr)) return false;
  let r: Rel = e.plan;
  while (r.kind === 'project' || r.kind === 'distinct' || r.kind === 'filter') r = r.input;
  if (r.kind !== 'scan' || !PROPERTY_OWNER[r.table]) return false;
  return correlated || freeRelIds(e.plan).size === 0;
}

function readsColumn(e: Expr, match: (c: Extract<Expr, { readonly kind: 'col' }>) => boolean): boolean {
  let reads = false;
  forEachExpr(e, (node) => { if (node.kind === 'col' && match(node)) reads = true; });
  return reads;
}

/** The column a property `EXISTS` correlates its owner with — `props.owner = X` — and the property table. */
function ownerColumn(term: Expr): { readonly rel: RelId; readonly name: string; readonly properties: Table } | null {
  if (term.kind !== 'exists' || term.negated || term.plan.kind !== 'project' || term.plan.input.kind !== 'filter') return null;
  const props = term.plan.input.input;
  if (props.kind !== 'scan') return null;
  const ownerName = PROPERTY_OWNER[props.table];
  if (!ownerName) return null;
  const found = conjuncts(term.plan.input.pred).flatMap((e) => {
    if (e.kind !== 'binary' || e.op !== '=' || e.left.kind !== 'col' || e.right.kind !== 'col') return [];
    const isOwner = (x: Expr): boolean => x.kind === 'col' && x.rel === props.id && x.name === ownerName;
    const other = isOwner(e.left) ? e.right : isOwner(e.right) ? e.left : null;
    return other && other.kind === 'col' && other.rel !== props.id ? [other] : [];
  });
  return found.length === 1 ? { rel: found[0]!.rel, name: found[0]!.name, properties: props.table } : null;
}

/**
 * Where column `rel.name` comes from, seen from `top`: every relation on the way down to the one that
 * DEFINES it — through filters, renaming projections and the join side that carries the name — with its
 * name there. It stops at anything else (that relation computes the column), so the last relation is a
 * scan only when the column is a stored one. `null` when `rel` is not on `top`'s spine — an OUTER row.
 */
function columnPath(top: Rel, rel: RelId, name: string): { readonly rels: readonly Rel[]; readonly name: string } | null {
  const above = spinePath(top, rel);
  if (!above) return null;
  const below = definingPath(above.at(-1)!, name);
  return { rels: [...above.slice(0, -1), ...below.rels], name: below.name };
}

function definingPath(rel: Rel, name: string): { readonly rels: readonly Rel[]; readonly name: string } {
  const through = (rest: { readonly rels: readonly Rel[]; readonly name: string }, ...hops: readonly Rel[]) =>
    ({ rels: [rel, ...hops, ...rest.rels], name: rest.name });
  switch (rel.kind) {
    case 'filter': return through(definingPath(rel.input, name));
    case 'project': {
      const e = rel.exprs.find(([output]) => output === name)?.[1];
      const hops = e?.kind === 'col' ? spinePath(rel.input, e.rel) : null;
      return e?.kind === 'col' && hops ? through(definingPath(hops.at(-1)!, e.name), ...hops.slice(0, -1)) : { rels: [rel], name };
    }
    case 'join': {
      const sides = [rel.left, rel.right].filter((child) => child.type.cols.some((c) => c.name === name));
      return sides.length === 1 ? through(definingPath(sides[0]!, name)) : { rels: [rel], name };
    }
    default: return { rels: [rel], name };
  }
}

/** The relations from `top` down to the one named `id`, along relational children (not subplans). */
function spinePath(top: Rel, id: RelId): readonly Rel[] | null {
  const seen = new Set<Rel>();
  const go = (r: Rel): readonly Rel[] | null => {
    if (r.id === id) return [r];
    if (seen.has(r)) return null;
    seen.add(r);
    for (const child of relChildren(r)) {
      const below = go(child);
      if (below) return [r, ...below];
    }
    return null;
  };
  return go(top);
}

/** Every relation id defined under `rel`, correlated subplans included. */
function idsWithin(rel: Rel): ReadonlySet<RelId> {
  const ids = new Set<RelId>();
  forEachRel(rel, (r) => { ids.add(r.id); });
  return ids;
}

// ---------- shared helpers ----------

/** Flatten an `AND` tree. A conjunct is what may be dropped independently of the rest. */
function conjuncts(e: Expr): readonly Expr[] {
  return e.kind === 'binary' && e.op === 'and' ? [...conjuncts(e.left), ...conjuncts(e.right)] : [e];
}

const andAll = (parts: readonly Expr[]): Expr => parts.reduce(and);

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

/** The owner column of each property table — `SEEK_PROPERTIES` read the other way. */
const PROPERTY_OWNER: Partial<Record<Table, string>> = { vertex_properties: 'node', edge_properties: 'edge' };

/**
 * May a seek's predicate read what `e` reads? A SELF-CONTAINED seek (`local === null`) may read the
 * property row alone, and no subplan — it is lifted into a `FROM`, where nothing else is in scope. A
 * CORRELATED one may read anything in scope EXCEPT the element side (`local`), through subplans too.
 */
function seekable(e: Expr, props: RelId, local: SeekTarget['local']): boolean {
  let ok = true;
  const visit = (node: Expr): void => {
    if (node.kind === 'col' && node.rel !== props && (local === null || local(node))) ok = false;
    for (const plan of exprRels(node)) {
      if (local === null) ok = false;
      // Inside a subplan, a column naming the subplan's own relations is not in the outer scope at all,
      // so `local` (which answers for the scope the seek stands in) cannot claim it.
      else forEachRel(plan, (r) => relExprs(r).forEach((x) => forEachExpr(x, visit)));
    }
  };
  forEachExpr(e, visit);
  return ok;
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
 * - a predicate reading what the target may not (`seekable`): for a lifted seek anything but the
 *   property row, which would be a correlation escaping its subquery; for a narrowing one the element's
 *   own side, which cannot drive the row it is read from.
 *
 * A correlated value may hold a subplan (a federated sibling reads its key through a one-row scalar
 * subquery); it is COPIED (`freshCopy`), since the original stays in the `EXISTS` and two relations may
 * not share a `RelId`.
 */
export const indexSeek: OwnerSeek = (term, target, mint) => {
  const properties = SEEK_PROPERTIES[target.table];
  if (!properties) return null;
  if (term.kind !== 'exists' || term.negated) return null;
  const probe = term.plan;
  if (probe.kind !== 'project') return null;
  const matching = probe.input;
  if (matching.kind !== 'filter') return null;
  const props = matching.input;
  if (props.kind !== 'scan' || props.table !== properties.table) return null;

  const inner = conjuncts(matching.pred);
  const correlations = inner.filter((e) => isCorrelation(e, props.id, properties.owner, target.rel, target.name));
  if (correlations.length !== 1) return null;
  const free = inner.filter((e) => !correlations.includes(e));
  const conjoined = conjoin(free);
  if (!conjoined || free.some((e) => !seekable(e, props.id, target.local))) return null;
  // A VALUE constraint is what makes this a seek rather than a re-read of the whole key.
  let constrainsValue = false;
  for (const e of free) forEachExpr(e, (n) => { if (n.kind === 'col' && n.rel === props.id && n.name === 'value') constrainsValue = true; });
  if (!constrainsValue) return null;
  const pred = freshCopy(conjoined, mint);
  if (!pred) return null;

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
  { name: 'text', type: 'text', nullable: false }, { name: 'rowid', type: 'int', nullable: false },
] } as const;

export const trigramSeek: OwnerSeek = (term, target, mint) => {
  const properties = FTS_PROPERTIES[target.table];
  if (!properties) return null;
  if (term.kind !== 'exists' || term.negated || term.plan.kind !== 'project' || term.plan.input.kind !== 'filter') return null;
  const matching = term.plan.input;
  if (matching.input.kind !== 'scan') return null;
  const props = matching.input;
  const all = conjuncts(matching.pred);
  const corr = all.filter((e) => isCorrelation(e, props.id, properties.owner, target.rel, target.name));
  if (corr.length !== 1) return null;
  const free = all.filter((e) => !corr.includes(e));
  const key = literalEq(free, props.id, 'key');
  if (key == null) return null;
  const atom = necessaryTextAtom(free, props.id);
  if (atom == null || literalTerm(atom.pattern).length < 3) return null;
  if (atom.kind === 'negative') return negativeOwners(props, properties, key, atom.matches, mint);
  return positiveOwners(properties, key, atom.pattern, mint);
};

/**
 * A TextP atom the WHOLE predicate implies, or `null` — the one soundness question a seek answers.
 *
 * The seek's owner set must CONTAIN every owner the predicate admits, so the atom it reads has to be
 * NECESSARY: reached from the conjunct roots through `and` alone. Anything else — an `or` (TextP's `or`, `P.or`, `outside`), a `not`, a comparison — STOPS the walk,
 * because an atom under it is one way of being admitted, not a requirement: seeking the last `like` in
 * `containing('ark').or(containing('osh'))` read the FTS for `'osh'` alone and dropped marko. A
 * positive atom is the `like` itself; a negative one is `<matches> is not 1` (`negated`,
 * `compiler/rel/predicate.ts`), whose `<matches>` the anti-probe re-asks of the FTS text. Several
 * necessary atoms are each sound; a positive one is preferred, because it seeks rather than scans.
 */
function necessaryTextAtom(parts: readonly Expr[], rel: RelId):
  | { readonly kind: 'positive'; readonly pattern: Expr }
  | { readonly kind: 'negative'; readonly pattern: Expr; readonly matches: Expr }
  | null {
  const positive: Expr[] = [];
  const negative: { pattern: Expr; matches: Expr }[] = [];
  const onValue = (e: Expr): e is Extract<Expr, { kind: 'call' }> =>
    e.kind === 'call' && e.fn.toLowerCase() === 'like' && e.args[1]?.kind === 'col' && e.args[1].rel === rel && e.args[1].name === 'value';
  const visit = (e: Expr): void => {
    if (onValue(e)) { positive.push(e.args[0]!); return; }
    if (e.kind === 'binary' && e.op === 'and') { visit(e.left); visit(e.right); return; }
    if (e.kind === 'binary' && e.op === 'is not' && e.right.kind === 'lit' && e.right.value === 1) {
      // The anti-probe drops a row exactly when `<matches>` holds of its FTS text — the very rows this
      // atom rejects — so ANY body is sound provided it reads the value alone and so can be re-asked there.
      const likes: Expr[] = [];
      forEachExpr(e.left, (x) => { if (onValue(x)) likes.push(x.args[0]!); });
      if (likes.length && readsOnlyValue(e.left, rel)) negative.push({ pattern: likes[0]!, matches: e.left });
    }
  };
  parts.forEach(visit);
  if (positive.length) return { kind: 'positive', pattern: positive[0]! };
  if (negative.length) return { kind: 'negative', ...negative[0]! };
  return null;
}
/** Does `e` read nothing but the property value — no other column, no subplan? Such a body can be re-asked
 *  of the FTS copy of that value (`retarget`) and give the same answer. */
function readsOnlyValue(e: Expr, rel: RelId): boolean {
  let only = true;
  forEachExpr(e, (x) => { if ((x.kind === 'col' && !(x.rel === rel && x.name === 'value')) || exprRels(x).length) only = false; });
  return only;
}

/** Positive TextP can start directly from matching FTS rows. */
function positiveOwners(properties: { readonly ownerElem: 'node' | 'edge' }, key: string, pattern: Expr, mint: Minter): Rel {
  const scan = make.scan({ id: mint.id('fs'), table: 'property_fts', alias: mint.alias('rfs'), channels: [], type: FTS_TYPE });
  const pred = andAll([
    eq(col(scan.id, 'owner_elem'), compilerText(properties.ownerElem)), eq(col(scan.id, 'pk'), compilerText(key)),
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
  key: string, matches: Expr, mint: Minter,
): Rel {
  // `hasPropertyClause` needs only owner/key/value/vtype and intentionally leaves the physical
  // property rowid out of its local schema. This pass correlates the FTS row by it (the FTS rowid is the
  // property id, negated for an edge), so its independent scan declares that real storage column
  // explicitly rather than pretending the generic probe carried it.
  const rows = make.scan({ id: mint.id('ns'), table: props.table, alias: mint.alias('rns'), channels: [],
    type: { cols: [{ name: 'id', type: 'int', nullable: false }, ...props.type.cols] } });
  const fts = make.scan({ id: mint.id('nfs'), table: 'property_fts', alias: mint.alias('rnfs'), channels: [], type: FTS_TYPE });
  const matchingFts = make.filter({ id: mint.id('nff'), input: fts, channels: [], type: fts.type, pred: andAll([
    eq(col(fts.id, 'rowid'), properties.ownerElem === 'edge' ? { kind: 'unary', op: 'neg', arg: col(rows.id, 'id') } : col(rows.id, 'id')),
    // The atom's OWN match body re-asked of the FTS text — LIKE (which keeps the trigram index) AND its
    // exact case test — so the probe drops exactly the rows the negative TextP rejects.
    rewriteExpr(matches, (n) => (n.kind === 'col' && n.rel === props.id && n.name === 'value' ? col(fts.id, 'text') : n)),
  ]) });
  const probe = make.project({ id: mint.id('nfp'), input: matchingFts, channels: [], type: { cols: [{ name: 'one', type: 'int', nullable: false }] }, exprs: [['one', compilerText('1')] ] });
  const candidates = make.filter({ id: mint.id('nf'), input: rows, channels: [], type: rows.type, pred: andAll([
    eq(col(rows.id, 'key'), compilerText(key)),
    or(isNot(col(rows.id, 'vtype'), compilerText('string')), { kind: 'exists', plan: probe, negated: true }),
  ]) });
  const owners = make.project({ id: mint.id('np'), input: candidates, channels: [], type: { cols: [{ name: 'sid', type: 'int', nullable: false }] }, exprs: [['sid', col(candidates.id, properties.owner)]] });
  return make.distinct({ id: mint.id('nd'), input: owners, channels: [], type: owners.type });
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
/** Literal-only: parameters deliberately use the generic plan, preserving the old fast-path scope. */
function literalTerm(pattern: Expr): string {
  let raw: string | null = null;
  forEachExpr(pattern, (e) => {
    if (e.kind === 'call' && e.fn.toLowerCase() === 'replace' && e.args[0]?.kind === 'lit' && e.args[0].source === 'compiler-text' && raw == null) raw = e.args[0].value;
  });
  return raw ?? '';
}
