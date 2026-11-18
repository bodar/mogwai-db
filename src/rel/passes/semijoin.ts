import { type Expr, and, col, compilerText, conjoin, conjuncts, eq, isNot, or } from '../expr.ts';
import * as make from '../factory.ts';
import type { Rel, Table } from '../rel.ts';
import { freshCopy, minter, type Minter } from '../mint.ts';
import { rowBounds } from '../bounds.ts';
import type { RelId } from '../types.ts';
import { deepColsRead, exprRels, forEachExpr, forEachRel, mapColsDeep, relExprs, relsBeneath, rewriteExpr, rewriteRels, substRelId } from '../walk.ts';
import { type ColumnPath, columnPath, rowidScan } from '../lineage.ts';

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
  const facts = elementFacts(plans);
  const mint = minter(...plans);
  const memo = new Map<Rel, Rel>();
  return plans.map((plan) => rewriteRels(plan, (mapped, original) =>
    (mapped.kind === 'filter' ? semijoinFilter(mapped, facts.above.get(original) ?? [], strategies, mint, facts) : mapped), memo));
}

/**
 * What the WHOLE plan says about each element scan (by `RelId`) before any narrowing is placed — facts
 * `narrowFilter` must not read off the one `Filter` it stands in, because the query may state them in
 * another: `V().has('country', select('c')).hasLabel('office')` puts the label in a Filter ABOVE the
 * seek's, and an `as()` can put a projection between the two.
 *
 * - `reached`: the query already gives SQLite an access path to the element through a MEMBERSHIP of its
 *   id — a literal `=`/`IN` list (`hasId(…)`, `V(1)` mid-chain), or `id IN (<subquery>)` (`hasLabel(…)`,
 *   `has(T.id, lt(4))`, `V($ids)`). Which of that and a value seek is the more selective is a fact about
 *   the DATA — a label held by 20 offices against a country held by N/10 users, or a label every vertex
 *   holds against a name two do — and with no statistics (`docs/archive/2026-08-01-relir-build-plan.md`
 *   §1 P4) neither SQLite nor this pass knows it. So such an element is not narrowed: the query's own
 *   access path stays, exactly the plan it had before this pass learned to narrow, so no shape can get
 *   slower. A fixed "value beats label" rule was measured turning an ordinary fact-to-dimension join
 *   (`…values('country').as('c').V().hasLabel('office').has('country', select('c'))`) from 7× to 60×
 *   over 1k → 8k users.
 * - `narrowed`: elements a narrowing already drives, filled as the walk places them, so an element gets
 *   ONE — a second correlated `IN` could only be a per-row CHECK re-running its subquery per candidate. A
 *   correlated pick is read ONCE per host (`correlatedFirst`, `src/compiler/rel/lower/scoped.ts`), so no copy
 *   of one query block stands beside it under the same ids for this to have to agree with.
 * - `above`: per (original) `Filter`, the conjuncts of the Filters STACKED over it — each the sole consumer of
 *   the one beneath — which hold of every row the stack keeps, so they narrow the lowest Filter as soundly
 *   as its own do. The walk is bottom-up and an element gets one narrowing, so without them the first Filter
 *   of `V().where(neq('a')).has('kind','person').has('name','zz')` is narrowed by `kind` ALONE, and the
 *   selective `name` above it can never join the intersection (`allOwners`).
 */
interface ElementFacts {
  readonly reached: ReadonlySet<RelId>;
  readonly narrowed: Set<RelId>;
  readonly above: ReadonlyMap<Rel, readonly Expr[]>;
}

/** The conjuncts stacked over each Filter (`ElementFacts.above`). */
function stackedAbove(plans: readonly Rel[]): ReadonlyMap<Rel, readonly Expr[]> {
  const consumers = new Map<Rel, number>(plans.map((plan) => [plan, 1]));
  // Each Filter's nearest Filter above it, and the row-wise relations between them (top first).
  const over = new Map<Rel, { readonly parent: Extract<Rel, { readonly kind: 'filter' }>; readonly hops: readonly Rel[] }>();
  forEachRel([...plans], (r) => {
    for (const child of relsBeneath(r)) consumers.set(child, (consumers.get(child) ?? 0) + 1);
  });
  forEachRel([...plans], (r) => {
    if (r.kind !== 'filter') return;
    const hops: Rel[] = [];
    let below = r.input;
    while (ROW_WISE.has(below.kind) && consumers.get(below) === 1 && 'input' in below && below.input) { hops.push(below); below = below.input; }
    if (below.kind === 'filter') over.set(below, { parent: r, hops });
  });
  const above = new Map<Rel, readonly Expr[]>();
  const of = (r: Rel): readonly Expr[] => {
    const known = above.get(r);
    if (known) return known;
    const stacked = over.get(r);
    // A term over the Filter's OWN columns is re-spelled over its input's, which a Filter passes through unchanged
    // — so every term resolves where the lowest Filter's own do (`drivenElement` traces from `node.input`). Between
    // the two, a `Distinct` passes its input's columns through by name and a row-wise `Project` by its column
    // expression; a term reading a column a Project COMPUTES is dropped, which only narrows less.
    const terms = stacked && consumers.get(r) === 1 && r.kind === 'filter'
      ? [...conjuncts(stacked.parent.pred), ...of(stacked.parent)].flatMap((e) => {
        let ok = true;
        for (const hop of [...stacked.hops, r] as const) {
          if (hop.kind !== 'project') { e = substRelId(e, hop.id, (hop as Rel & { readonly input: Rel }).input.id); continue; }
          e = mapColsDeep(e, hop.id, (name) => {
            const defined = hop.exprs.find(([output]) => output === name)?.[1];
            if (defined?.kind === 'col' && defined.rel === hop.input.id) return defined;
            ok = false;
            return col(hop.input.id, name);
          });
        }
        return ok ? [e] : [];
      })
      : [];
    above.set(r, terms);
    return terms;
  };
  for (const r of over.keys()) of(r);
  return above;
}

/** What `stackedAbove` sees a Filter's terms THROUGH on their way down to the Filter beneath: relations that keep
 *  or drop whole input rows and pass the columns a term reads through unchanged. A predicate on an element's id
 *  commutes with each — a `Distinct` over fewer rows keeps exactly the values the predicate would have kept. */
const ROW_WISE: ReadonlySet<Rel['kind']> = new Set(['distinct', 'project']);

function elementFacts(plans: readonly Rel[]): ElementFacts {
  const reached = new Set<RelId>();
  for (const plan of plans) forEachRel(plan, (r) => {
    if (r.kind !== 'filter') return;
    for (const e of conjuncts(r.pred)) {
      const member = e.kind === 'in-list' || (e.kind === 'in-query' && !e.negated) ? e.expr
        : e.kind === 'binary' && e.op === '=' ? (e.left.kind === 'lit' ? e.right : e.right.kind === 'lit' ? e.left : null) : null;
      const leaf = member?.kind === 'col' ? rowidScan(r.input, member.rel, member.name) : null;
      if (leaf && SEEK_PROPERTIES[leaf.table]) reached.add(leaf.id);
    }
  });
  return { reached, narrowed: new Set(), above: stackedAbove(plans) };
}

/**
 * The one rewrite. Declines — returning the node untouched — on anything no strategy recognises
 * exactly, which is the pass's whole contract: it is an access-path choice, so a shape it half
 * understands must be left to the planner rather than half-optimised.
 *
 * Two placements, one owner relation. Over a BARE element scan a self-contained seek is LIFTED in front
 * as the relation the plan is driven from. Anywhere else — the element is one `FROM` item of a join (a
 * re-source `V()`, `inject(…).unfold()`), or the seek reads an outer row — it NARROWS:
 * `element.id IN (<owner ids>)` is added beside the predicate (`narrowFilter`).
 */
function semijoinFilter(node: Extract<Rel, { readonly kind: 'filter' }>, above: readonly Expr[], strategies: readonly OwnerSeek[], mint: Minter, facts: ElementFacts): Rel {
  const element = node.input;
  const terms = conjuncts(node.pred);
  // Lifted only over a BARE scan. A scan already narrowed by something else (`V(1,2)` lowers its id
  // list into this same Filter, which is fine — that is a conjunct) is still bare as a RELATION; what
  // this excludes is a Filter over a join/project/union, where "drive from the seek" is a claim about
  // a plan this pass did not build.
  if (element.kind !== 'scan') return narrowFilter(node, terms, above, strategies, mint, facts) ?? node;
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
        pred: substRelId(node.pred, element.id, joined.id),
      });
    }
  }
  return narrowFilter(node, terms, above, strategies, mint, facts) ?? node;
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
 * It ADDS an access path to an element the query gives none (`ElementFacts.reached`) and never chooses
 * between two on a selectivity guess. Every SELF-CONTAINED seek on the element is intersected (`allOwners`).
 * A CORRELATED one on the same element is the join predicate — `has('name', select('n'))` says "the elements
 * whose name is this row's" — and the constants are LOCAL filters on that join's output. Neither ORDER of the
 * two as `IN`s is linear: the correlated seek driving reads the whole value group per outer row (outer × |group|:
 * 20 offices among N users by country, 28 ms @1k → 586 ms @8k), the constant driving reads the whole constant
 * set per outer row (outer × |K|: the people among N by name, 606 ms @1k → 2.4 s @2k). So with constants beside
 * it the correlated seek becomes a KEYED JOIN (`keyedJoin`): the equi-join of the outer value with the constant
 * set's `(owner, value)` rows, built once — linear in the rows it produces, with no selectivity guess. That
 * holds where the outer row is an ENCLOSING query's too (`…as('c').where(__.V().has('kind', 'hq')
 * .has('country', select('c'))))`): the join is placed over the Filter's own input, and SQLite builds `kv` and
 * its automatic index once even inside the correlated subquery, since `kv` reads no outer row. Where the join
 * cannot be placed at all (a relation `keyedJoin` cannot widen stands between), the constants drive alone and
 * the correlated `EXISTS` checks each — never the correlated seek driving with the constants under it, which
 * reads the whole value group per outer row (measured on `…values('country').as('c').where(__.V()
 * .has('kind', 'hq').has('country', select('c'))))`, 4 hq among N persons in 20 countries: 16 ms @1k → 543 ms @8k).
 */
function narrowFilter(
  node: Extract<Rel, { readonly kind: 'filter' }>, terms: readonly Expr[], above: readonly Expr[],
  strategies: readonly OwnerSeek[], mint: Minter, facts: ElementFacts,
): Rel | null {
  const stacked = [...terms, ...above];
  // SELF-CONTAINED: EVERY term — this Filter's and those stacked over it (`ElementFacts.above`) — that seeks the
  // first element one does, intersected (`allOwners`): never a choice. A term two strategies both accept goes to
  // the earlier one, as in the lifted placement.
  let driven: { readonly target: SeekTarget; readonly element: RelId } | null = null;
  const constants: Rel[] = [];
  const selfContained = new Set<Expr>();
  for (const term of stacked) {
    const target = drivenElement(node, term, false);
    const element = target && rowidScan(node.input, target.rel, target.name)?.id;
    if (!target || !element || facts.reached.has(element) || facts.narrowed.has(element)) continue;
    if (driven && element !== driven.element) continue;
    const seeked = strategies.reduce<Rel | null>((found, seek) => found ?? seek(term, target, mint), null);
    if (!seeked) continue;
    driven ??= { target, element };
    constants.push(seeked);
    selfContained.add(term);
  }
  // CORRELATED: beside the constants, a keyed join on their element — or, where none can be placed, the constants
  // drive alone below. With no constant, one seek re-run per outer row, on any element.
  for (const seek of strategies) {
    for (const term of stacked) {
      if (selfContained.has(term)) continue;
      const target = drivenElement(node, term, true);
      const element = target && rowidScan(node.input, target.rel, target.name)?.id;
      if (!target || !element || facts.reached.has(element) || facts.narrowed.has(element)) continue;
      if (driven && element !== driven.element) continue;
      const seeked = seek(term, target, mint);
      if (!seeked) continue;
      const keyed = constants.length ? keyedJoin(node, term, target, constants, mint) : null;
      if (keyed) { facts.narrowed.add(element); return keyed; }
      if (!constants.length) return narrowed(node, terms, target, element, allOwners([seeked], mint), facts);
    }
  }
  return driven ? narrowed(node, terms, driven.target, driven.element, allOwners(constants, mint), facts) : null;
}

/** `node` with `target IN (<ids>)` beside its predicate, and the element recorded as narrowed. */
function narrowed(node: Extract<Rel, { readonly kind: 'filter' }>, terms: readonly Expr[], target: SeekTarget, element: RelId, ids: Rel, facts: ElementFacts): Rel {
  facts.narrowed.add(element);
  return make.filter({
    id: node.id, input: node.input, channels: node.channels, type: node.type,
    pred: andAll([{ kind: 'in-query', expr: col(target.rel, target.name), plan: ids, negated: false }, ...terms]),
  });
}

/**
 * The KEYED placement: a correlated value equality AND constant seeks on one element, as a JOIN the outer rows
 * probe by value — or `null` where the shape does not admit one (the caller then narrows by `IN`).
 *
 * `has('country', select('c')).has('kind', 'office')` asks, per outer row, for the elements in `K` (the constant
 * seeks' intersection) whose `country` is the row's. Neither `IN` order is linear: the correlated seek driving reads
 * the whole value group per outer row (outer × |group| — every user of the country, to find its one office), and
 * the constant driving reads all of `K` per outer row (outer × |K| — every person, to find the two named `zz`). The
 * linear plan is the equi-join itself: `kv` — the `(owner, value)` rows of the correlated key over the owners in
 * `K`, built ONCE per statement (an uncorrelated `DISTINCT` subquery SQLite materialises) — joined in front of the
 * element's side, with the correlated equality left in the `WHERE`, where SQLite seeks it through an automatic
 * index on `kv.value` built once. Cost: |K| + |key rows of K| once, then one index probe per outer row plus the
 * rows it matches — the size of the user's own join, never a cross product, and with no selectivity guess.
 * Measured on 20 offices beside N users (`…values('country').as('c').V().has('country', select('c'))
 * .has('kind', 'office')`): correlated-first 10.5 ms @1k → 509 ms @8k; keyed 1.2 → 9.4 ms.
 *
 * It must not duplicate a row, so it is offered only where each candidate matches AT MOST ONE `kv` row per outer
 * row: `kv` is `DISTINCT (owner, value)`, and every conjunct reading the outer row reads the property's `value`
 * alone, one of them `value = <outer expression>` — so every matching row of one owner has the same value and the
 * `DISTINCT` left one. The ORIGINAL `EXISTS`es stay on the Filter as the semantic authority: the join only
 * chooses which candidates SQLite visits.
 *
 * Placement: the element's `side` is replaced by `Join(kv, side)` (pinned, so `kv` is the loop in front of it),
 * every join above it on the way up to the Filter's input re-declared one `kv` column wider, and the Filter
 * re-stated over that input under a Project that restores its columns under its own id — so nothing above it
 * changes. Only `WIDENABLE` relations may stand between the Filter and the side, each re-declared carrying the
 * two `kv` columns up to the `WHERE` that reads `kv.value`. A side that IS the Filter's input — the element is
 * the whole `FROM`, the outer row an enclosing query's (a `where`/`not`/`map` body) — is the same placement with
 * nothing to widen: `Filter(Join(kv, side))`, the outer value read from the enclosing row. `kv` reads no outer
 * row, so SQLite still builds it and its automatic index ONCE for the statement, not per outer row (measured on
 * raw SQL with |K| = N: 0.9 ms @1k → 8.0 ms @8k, against 27 ms → 1.66 s for `id IN (SELECT sid FROM kv WHERE
 * value = <outer>)`, which scans `kv` per row).
 */
/** The relations `keyedJoin` can widen by the two `kv` columns on the way up to the Filter: each keeps its input's
 *  rows and passes columns through by name. */
const WIDENABLE: ReadonlySet<Rel['kind']> = new Set(['join', 'project', 'filter']);

function keyedJoin(
  node: Extract<Rel, { readonly kind: 'filter' }>, term: Expr, target: DrivenTarget, constants: readonly Rel[], mint: Minter,
): Rel | null {
  const { side, path } = target;
  const sideAt = path.rels.indexOf(side);
  const sideId = path.names[sideAt];
  if (sideAt < 0 || !sideId || path.rels.slice(0, sideAt).some((r) => !WIDENABLE.has(r.kind))) return null;
  const properties = SEEK_PROPERTIES[target.table];
  if (!properties || term.kind !== 'exists' || term.plan.kind !== 'project' || term.plan.input.kind !== 'filter') return null;
  const props = term.plan.input.input;
  if (props.kind !== 'scan') return null;
  const valueCol = props.type.cols.find((c) => c.name === 'value');
  if (!valueCol) return null;
  // The property row's own conjuncts go into `kv`; the ones reading the outer row (`seekable` already proved they
  // do not read the element side) stay in the WHERE.
  const inner = conjuncts(term.plan.input.pred).filter((e) => !isCorrelation(e, props.id, properties.owner, target.rel, target.name));
  const own = (e: Expr): boolean => {
    let only = true;
    forEachExpr(e, (x) => { if ((x.kind === 'col' && x.rel !== props.id) || exprRels(x).length) only = false; });
    return only;
  };
  const local = inner.filter(own);
  const outer = inner.filter((e) => !own(e));
  if (!outer.length || outer.some((e) => [...deepColsRead(e, props.id)].some((name) => name !== 'value'))) return null;
  const isValue = (x: Expr): boolean => x.kind === 'col' && x.rel === props.id && x.name === 'value';
  if (!outer.some((e) => e.kind === 'binary' && e.op === '=' && ((isValue(e.left) && !deepColsRead(e.right, props.id).size)
    || (isValue(e.right) && !deepColsRead(e.left, props.id).size)))) return null;
  const outerPred = freshCopy(andAll(outer), mint);
  const localPred = local.length ? freshCopy(andAll(local), mint) : null;
  if (!outerPred || (local.length && !localPred)) return null;

  const scan = make.scan({ id: mint.id('kk'), table: props.table, alias: mint.alias('rkk'), channels: [], type: props.type });
  const rows = make.filter({
    id: mint.id('kf'), input: scan, channels: [], type: scan.type,
    pred: andAll([
      ...(localPred ? [substRelId(localPred, props.id, scan.id)] : []),
      ...constants.map((c): Expr => ({ kind: 'in-query', expr: col(scan.id, properties.owner), plan: c.kind === 'distinct' ? c.input : c, negated: false })),
    ]),
  });
  const pairs = make.project({
    id: mint.id('kp'), input: rows, channels: [],
    type: { cols: [{ name: 'sid', type: 'int', nullable: false }, { ...valueCol, name: 'value' }] },
    exprs: [['sid', col(rows.id, properties.owner)], ['value', col(rows.id, 'value')]],
  });
  const kv = make.distinct({ id: mint.id('kd'), input: pairs, channels: [], type: pairs.type });
  // Fresh output names, so the widened joins above cannot declare a name twice.
  const kvCols = [{ ...pairs.type.cols[0]!, name: mint.id('kvs') }, { ...pairs.type.cols[1]!, name: mint.id('kvv') }];
  let below: Rel = make.join({
    id: mint.id('kj'), left: kv, right: side, join: 'inner', ordered: true, channels: side.channels,
    type: { cols: [...kvCols, ...side.type.cols] },
    on: eq(col(side.id, sideId), col(kv.id, 'sid')),
  });
  // Up to the Filter's input, each relation re-declared over the widened one beneath, carrying the two `kv` columns.
  let offset = 0;
  for (let i = sideAt - 1; i >= 0; i--) {
    const at = path.rels[i]!;
    const was = path.rels[i + 1]!;
    const over = (e: Expr): Expr => substRelId(e, was.id, below.id);
    const id = mint.id('kw');
    if (at.kind === 'join') {
      const isLeft = at.left === was;
      offset += isLeft ? 0 : at.left.type.cols.length;
      const cols = [...at.type.cols.slice(0, offset), ...kvCols, ...at.type.cols.slice(offset)];
      below = make.join({ ...at, id, ...(isLeft ? { left: below } : { right: below }), ...(at.on ? { on: over(at.on) } : {}), type: { cols } });
    } else if (at.kind === 'project') {
      offset = at.type.cols.length;
      below = make.project({
        ...at, id, input: below, type: { cols: [...at.type.cols, ...kvCols] },
        exprs: [...at.exprs.map(([name, e]) => [name, over(e)] as const), ...kvCols.map((c) => [c.name, col(below.id, c.name)] as const)],
      });
    } else if (at.kind === 'filter') {
      below = make.filter({ ...at, id, input: below, type: below.type, pred: over(at.pred) });
    } else return null;
  }
  const input = below;
  const filtered = make.filter({
    id: mint.id('kn'), input, channels: node.channels, type: input.type,
    pred: andAll([
      mapColsDeep(substRelId(outerPred, node.input.id, input.id), props.id, () => col(input.id, kvCols[1]!.name)),
      substRelId(node.pred, node.input.id, input.id),
    ]),
  });
  return make.project({
    id: node.id, input: filtered, channels: node.channels, type: node.type,
    exprs: node.type.cols.map((c) => [c.name, col(filtered.id, c.name)] as const),
  });
}

/**
 * The owners EVERY seek admits — the first seek's ids, each also `IN` every other's — as one relation of `sid`s,
 * without a `DISTINCT` (an `IN` is a set test; the strategy's `DISTINCT` is load-bearing only for a JOIN). Each
 * seek holds of every candidate the body keeps, so their conjunction is still NECESSARY: it narrows no further
 * than the body decides. It is the conjunction rather than a CHOICE of one because which seek is selective is a
 * fact about the DATA, which neither SQLite nor this pass knows (no statistics) — and the narrowing set is read by
 * a body asked PER HOST, so an unselective seek driving hands every host every candidate: `has('kind','person')`
 * beside a selective `values('name').is('zz')` (spelled as a type-dispatching `CASE`, which no spelling rule can
 * rank) went 840 ms @1k → 3.3 s @2k. The intersection is an uncorrelated `IN`, computed once per statement, each
 * seek one read of its index — linear whichever term the query states first. A correlated seek is never one of
 * them: beside constants it is a keyed join (`keyedJoin`), alone it is the only owner relation.
 */
function allOwners(owners: readonly Rel[], mint: Minter): Rel {
  const [first, ...rest] = owners.map((o) => (o.kind === 'distinct' ? o.input : o));
  if (rest.length === 0) return first!;
  return make.filter({
    id: mint.id('si'), input: first!, channels: [], type: first!.type,
    pred: andAll(rest.map((plan): Expr => ({ kind: 'in-query', expr: col(first!.id, 'sid'), plan, negated: false }))),
  });
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
function drivenElement(node: Extract<Rel, { readonly kind: 'filter' }>, term: Expr, correlated: boolean): DrivenTarget | null {
  const owner = ownerColumn(term);
  if (!owner) return null;
  const path = columnPath(node.input, owner.rel, owner.name);
  const leaf = path?.rels.at(-1);
  if (!path || leaf?.kind !== 'scan' || path.name !== 'id' || SEEK_PROPERTIES[leaf.table]?.table !== owner.properties) return null;
  const sideOf = (side: Rel) => ({ side, path });
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
  if (!correlated) return { rel: owner.rel, name: owner.name, table: leaf.table, local: null, ...sideOf(side) };
  const sideIds = idsWithin(side);
  // A column is the element's own when it is read off the side directly, or traces into it through the
  // projections and joins above it. A relation outside the input is an OUTER row — never local.
  const local = (c: { readonly rel: RelId; readonly name: string }): boolean => {
    if (sideIds.has(c.rel)) return true;
    const traced = columnPath(node.input, c.rel, c.name);
    return traced !== null && traced.rels.includes(side);
  };
  return { rel: owner.rel, name: owner.name, table: leaf.table, local, ...sideOf(side) };
}

/** A `SeekTarget` with where it was found: the owner column's defining `path` from the Filter's input, and the
 *  element's `side` on it (the relation under the last join, or the whole input). */
type DrivenTarget = SeekTarget & { readonly side: Rel; readonly path: ColumnPath };


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

/** Every relation id defined under `rel`, correlated subplans included. */
function idsWithin(rel: Rel): ReadonlySet<RelId> {
  const ids = new Set<RelId>();
  forEachRel(rel, (r) => { ids.add(r.id); });
  return ids;
}

// ---------- shared helpers ----------

const andAll = (parts: readonly Expr[]): Expr => parts.reduce(and);

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

/** The column of property table `table` naming its owner element, or `null` for a table that holds no properties —
 *  the one authority for which rows an owner seek reads (`leading` builds its owner-joined candidate filter by it). */
export const propertyOwner = (table: Table): string | null => PROPERTY_OWNER[table] ?? null;

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
    pred: substRelId(pred, props.id, scan.id),
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
 *  of the FTS copy of that value (`substRelId`) and give the same answer. */
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
