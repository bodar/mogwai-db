import { isArgExtremum, type Expr } from './expr.ts';
import { shapeOf, spliceable } from './block.ts';
import { isAbort } from './raise.ts';
import { atMostOneRow } from './bounds.ts';
import type { Rel } from './rel.ts';
import * as make from './factory.ts';
import { deepColsRead, exprChildren, exprHasSubquery, exprRels, forEachExpr, forEachRel, isSelfContained, mapColsDeep, nodeFact, relChildren, relExprs, relsBeneath, substRelId } from './walk.ts';
import type { RelId } from './types.ts';

/**
 * WHAT IT COSTS TO SPELL A RELATION MORE THAN ONCE — three node facts, for the consumers that name one
 * relation at two places (a per-direction `both()`, a branch's arms over one frontier).
 *
 * SQLite has no LATERAL and expands every reference to a derived table or CTE into its own copy of the
 * definition. A self-contained relation reached twice becomes ONE named CTE (`name`,
 * `src/rel/passes/name.ts`), and SQLite evaluates that CTE once only when it cannot FLATTEN it into its
 * readers — when its top SELECT is a barrier (an aggregate, a window, DISTINCT, ORDER BY or LIMIT); a CTE
 * whose top is a plain projection or filter is flattened into each reader, under a plain compound and a
 * MERGE UNION ALL alike, and whatever barrier lies beneath that top runs once per reader as a co-routine
 * (measured; `copyRepeatsWork`). A CORRELATED relation cannot move out to a CTE, so the emitter spells it
 * at every reference and SQLite evaluates every copy on its own (measured: even an `AS MATERIALIZED` CTE
 * written inside a correlated subquery is re-evaluated per reference). Three costs follow:
 *
 * - TEXT (`doubledReads`) — a chain of k nodes that each read their input twice is 2^k copies of the first.
 * - TIME (`copyRepeatsWork`) — a copy SQLite does not share re-runs its per-row work: a barrier, a
 *   computed carried column.
 * - THE ANSWER (`draws`) — a copy of a random draw draws again. Two copies of
 *   `out().order().by(shuffle).limit(1)` pick two different vertices, so a both() over it read the out-arm
 *   of one pick and the in-arm of another (`g.V(1).local(out().order().by(shuffle).limit(1).both().count())`
 *   answered 5, which no single out-neighbour of v1 has).
 */

/**
 * DOES EVALUATING THIS RELATION DRAW — is there a `RANDOM()` anywhere in it: in its own expressions, in a
 * subplan they correlate, or beneath it (`order().by(shuffle)`, `sample()`'s collation, any `RANDOM()`).
 * Two evaluations of a relation that draws are two different relations, so it may be READ twice only
 * when it is evaluated once.
 *
 * A raise or deferral arm's `random()` is not a draw: it is only there so SQLite cannot hoist the arm out
 * of its CASE (`raiseInRow`, `src/rel/raise.ts`), and an arm that is evaluated aborts the statement, so
 * its value never reaches an answer. The whole arm is skipped (`isAbort`). Counting it would decline a
 * valid query through `name`.
 *
 * Memoized per node (`nodeFact`), on relations and expressions alike, so it is O(DAG).
 */
export const draws: (r: Rel) => boolean = nodeFact((r: Rel): boolean =>
  relExprs(r).some(exprDraws) || relChildren(r).some(draws));
export const exprDraws: (e: Expr) => boolean = nodeFact((e: Expr): boolean => {
  if (isAbort(e)) return false;
  if (isRandom(e)) return true;
  return exprChildren(e).some(exprDraws) || exprRels(e).some(draws);
});
const isRandom = (e: Expr): boolean => e.kind === 'call' && e.fn.toUpperCase() === 'RANDOM';

/** `draws` and its expression half, cut at the nodes a caller does not own (`ownDraws`). */
export interface OwnDraws {
  readonly rel: (r: Rel) => boolean;
  readonly expr: (e: Expr) => boolean;
}

/**
 * DOES EVALUATING THIS RELATION DRAW, counting only its OWN draws — `draws` cut at every FOREIGN subtree: one
 * holding no node `owns` claims. A relation is immutable and built bottom-up, so a subtree that existed before
 * the caller began cannot hold a node the caller built; a foreign subtree is therefore a relation built
 * elsewhere that the caller only reads — a VALUE drawn elsewhere, not a draw of this relation's own. A node
 * the caller built over its own nodes without claiming it (a wrapper) is still the caller's.
 *
 * The decorrelator asks this (`src/rel/decorrelate.ts`): a child body's OWN draw (`local(out().sample(1))`) is
 * one draw per scope row and must be keyed by the scope, but a drawn relation the body only READS — a side
 * effect collected upstream of the host (`g.V().sample(1).aggregate('x').V().local(cap('x').unfold())`), a
 * shared binding — was drawn ONCE, before the body, and every scope reads that one pick. Keying it would redraw
 * it per scope: a wrong answer (a 1-member collection read as up to |V| distinct members), and an N×N cross of
 * the domain with the whole re-drawn source.
 *
 * Memoized per call, so one decorrelation pays O(DAG).
 */
export function ownDraws(owns: (r: Rel) => boolean): OwnDraws {
  const mine = new Map<Rel, boolean>();
  /** Is this subtree the caller's: a node it claims, or one built over such a node. */
  const own = (r: Rel): boolean => {
    let hit = mine.get(r);
    if (hit === undefined) mine.set(r, hit = owns(r) || relsBeneath(r).some(own));
    return hit;
  };
  const rels = new Map<Rel, boolean>();
  const exprs = new Map<Expr, boolean>();
  const rel = (r: Rel): boolean => {
    let hit = rels.get(r);
    if (hit === undefined) rels.set(r, hit = own(r) && (relExprs(r).some(expr) || relChildren(r).some(rel)));
    return hit;
  };
  const expr = (e: Expr): boolean => {
    let hit = exprs.get(e);
    if (hit === undefined) exprs.set(e, hit = !isAbort(e) && (isRandom(e) || exprChildren(e).some(expr) || exprRels(e).some(rel)));
    return hit;
  };
  return { rel, expr };
}

/**
 * HOW MANY DOUBLED READS LIE BENEATH THIS RELATION — the most nodes, along any one path from `r` to a
 * leaf, that each read two non-base inputs. So 2^`doubledReads(r)` bounds how many copies of any one
 * relation beneath `r` SQLite spells when it prepares `r`.
 *
 * Naming a relation twice copies everything beneath it, and a chain of k operators that each read their
 * input twice is 2^k copies of the first (the `both()` UNION ALL wall: `g.V().both()×16` refused,
 * `local(both()×8.count())` 46 KB). A consumer about to read an input twice bounds this fact first
 * (`hopJoin`, `src/compiler/rel/lower/movement.ts`), which caps the text at a CONSTANT factor of the plan.
 *
 * - A `Scan`/`Values` is 0.
 * - A single-input node is the max over its input and the subplans its expressions correlate.
 * - A join or union is that max PLUS ONE when two or more of its inputs are not base reads
 *   (`isBaseRead`). A copy of a base read is one more scan of the same index, a constant that cannot
 *   compound, so only a non-base pair counts. Two DIFFERENT non-base inputs count too: over-counting
 *   costs only the faster form, never an answer or text.
 * - A `Ref`, a `SelfRef` and a `Recursive` are UNBOUNDED: each can stand for an arbitrarily deep
 *   definition this fact cannot see. So is any node kind not named here, because UNDER-counting is the
 *   dangerous direction — it re-enables 2^k.
 * - A relation that DRAWS (`draws`) is UNBOUNDED too: a second copy is not a copy at all, so a consumer
 *   that would spell it twice must read it once.
 *
 * Memoized per node (`nodeFact`), so a fold that re-asks it after every step pays only for the nodes
 * built since: O(DAG) in total.
 */
export const doubledReads: (r: Rel) => number = nodeFact((r: Rel): number => {
  if (draws(r)) return Infinity;
  switch (r.kind) {
    case 'scan': case 'values':
    case 'project': case 'filter': case 'aggregate': case 'sort': case 'limit': case 'window':
    case 'distinct': case 'materialize': case 'explode':
      return beneathMax(r, 0);
    case 'join': case 'union':
      return beneathMax(r, relChildren(r).filter((input) => !isBaseRead(input)).length >= 2 ? 1 : 0);
    default: return Infinity;
  }
});
/** The most `doubledReads` beneath `r` — over its children and the subplans its expressions correlate
 *  (`relsBeneath`) — plus what `r` itself adds. */
const beneathMax = (r: Rel, adds: number): number =>
  relsBeneath(r).reduce((most, beneath) => Math.max(most, doubledReads(beneath) + adds), adds);

/**
 * WOULD A SECOND COPY OF THIS RELATION REPEAT PER-ROW WORK BEYOND AN INDEX SEEK? — the RUNTIME cost of a
 * second read, beside `doubledReads`' TEXT cost. A consumer that may read its input once or twice
 * (`hopJoin`'s direction row against two per-direction seeks) asks both: two seeks measured faster only
 * while a copy of the frontier is one more seek of the same index.
 *
 * Whether a copy is evaluated again is SQLite's choice, so this follows its planner, measured (8 000
 * vertices, two edges each, a frontier read by the two arms of a UNION ALL that each join it to `edges`):
 *
 * - **A self-contained relation becomes a CTE named twice** (`name`, `src/rel/passes/name.ts`). Whether
 *   SQLite evaluates it once depends on its TOP, not on the compound around it: a CTE whose top is a
 *   barrier (a window, an aggregate, a DISTINCT, a LIMIT) cannot be flattened into a reader that joins
 *   it, so it is MATERIALIZED once (`out().order().by('name')`, `out().dedup()`, `out().limit(4000)`);
 *   a CTE whose top is a row-wise projection or filter IS flattened into each reader, under a plain
 *   compound and a MERGE UNION ALL alike, and every barrier beneath that top is re-run as a co-routine
 *   per reader (`out().order().by('name').limit(500)`, whose top is the limit's bulk projection over a
 *   running-sum window; `out().dedup().by('name')`, whose top keeps `rn = 1` of a partition window).
 * - **A correlated relation cannot become a CTE**, so the emitter spells it at every reference and every
 *   copy is evaluated in full, its top included (`local(out().order().by('name').limit(1).both())`).
 *
 * So it is the per-row work of the part SQLite would COPY (`copiedWork`): a barrier beneath a flattened
 * top, or a COMPUTED carried column — an `as()` label's `jsonb_array`, a path, a projected value: any
 * projected expression that is not a column or a constant. A base read is a seek either way; a `Ref` and a
 * fenced `Materialize` are evaluated once whoever reads them.
 *
 * Measured at 8 000 vertices, two seeks → one read: `out().order().by('name').limit(500).both().count()`
 * 27 → 15 ms, `out().dedup().by('name').both().count()` 36 → 27, `local(out().order().by('name').limit(1)
 * .both().count())` 85 → 59, `as('a').both().both().where(neq('a')).count()` 93 → 72,
 * `as('a').out().out().both().where(neq('a')).count()` 109 → 72. A computed carrier that is carried but
 * never READ downstream measured the other way (`optional(out().as('x').both()).count()` 13 → 16,
 * `out().out().both().path().count()` 25 → 28): this fact cannot see the consumer, and a carried label is
 * there to be read, so it takes the read case.
 *
 * Getting this wrong costs only time, never an answer or text — the one-read form is always correct and
 * linear — so an unknown node kind answers YES, the side that keeps the pre-two-seek behaviour.
 */
export const copyRepeatsWork = (r: Rel): boolean => !(isSelfContained(r) && barrierTop(r)) && copiedWork(r);
/**
 * Is `r`'s SQL a SELECT SQLite will not flatten into a reader that joins it? That is the emitter's own
 * block for `r` (`shapeOf`, `src/rel/block.ts` — the analysis that predicts what `emit` assembles) filling
 * a slot past FROM/WHERE: a GROUP BY or HAVING, a window, DISTINCT, ORDER BY or LIMIT (`spliceable`, the
 * same test a join side is spliced by). A CTE with such a top is materialized once when it is read twice:
 * `order()`'s frontier is a column-only projection the emitter writes into its window's SELECT, and
 * `has()` after a collapsed hop is a HAVING on its GROUP BY. A compound (`closed`) is not: SQLite
 * evaluates a UNION ALL CTE once per reader.
 */
const barrierTop = (r: Rel): boolean => {
  const shape = shapeOf(r);
  return shape !== 'closed' && !spliceable(shape.slots);
};
/** A projected expression that computes something per row — anything but a column or a constant. */
const computed = (e: Expr): boolean => e.kind !== 'col' && e.kind !== 'lit';
/** Does evaluating `r` do per-row work beyond index seeks — a barrier, or a computed column? Memoized per
 *  node, so O(DAG). */
const copiedWork: (r: Rel) => boolean = nodeFact((r: Rel): boolean => {
  switch (r.kind) {
    case 'scan': case 'values': case 'ref': return false;
    case 'materialize': return r.fenced ? false : copiedWork(r.input);
    case 'project':
      return r.exprs.some(([, e]) => computed(e)) || copiedWork(r.input);
    case 'filter': case 'join': case 'union':
      return !relExprs(r).every(exprIsBaseRead) || relChildren(r).some(copiedWork);
    default: return true;
  }
});

/**
 * IS A COPY OF THIS RELATION ONE MORE INDEX SCAN? — a base-table read: a `Scan` or `Values` under nothing
 * but row-wise `Project`/`Filter`, whose expressions correlate only against relations of the same kind.
 * `doubledReads` counts a join's or union's inputs by it. A `Ref` (a named CTE), a `SelfRef` and every
 * multi-input or barrier node answer NO: each can stand for an arbitrarily deep definition.
 */
const isBaseRead: (r: Rel) => boolean = nodeFact((r: Rel): boolean => {
  if (r.kind === 'scan' || r.kind === 'values') return true;
  if (r.kind !== 'project' && r.kind !== 'filter') return false;
  return isBaseRead(r.input) && relExprs(r).every(exprIsBaseRead);
});
const exprIsBaseRead = (e: Expr): boolean => exprRels(e).every(isBaseRead) && exprChildren(e).every(exprIsBaseRead);

/**
 * IS COLUMN `name` OF `r` A STORED VALUE — a base-table column or a constant, carried up through row-wise
 * operators only? A correlated subplan that reads an outer column has the emitter SPELL that column's
 * definition inside it (a correlated plan cannot read a name a CTE gave it), so a COMPUTED outer column —
 * an `as()` label's `jsonb_array`, a path, a normalized value — is computed again per inner row, where a
 * stored one costs nothing to re-read. `copiedWork`'s rule, asked of one column instead of a whole relation;
 * an aggregate's, a window's or an explode's output is not stored (NO, the side that keeps a correlated read
 * off it).
 */
export const columnIsStored = (r: Rel, name: string): boolean => {
  switch (r.kind) {
    case 'scan': case 'values': return true;
    // A WALK's row — the recursive CTE outside its term, its self-reference inside — is only ever READ by name
    // (a recursive relation is never inlined, and a correlated subquery may read the self-reference: P2,
    // `recursive.ts`), so no column of it is spelled again per inner row.
    case 'recursive': case 'self-ref': return true;
    case 'project': {
      const e = r.exprs.find(([column]) => column === name)?.[1];
      if (!e) return false;
      if (e.kind === 'lit') return true;
      if (e.kind !== 'col') return false;
      // A column of an ENCLOSING row (a correlated seed's read of its host) is that row's to have been
      // stored — the enclosing correlated read was admitted on exactly this question, and a decorrelated
      // scope is read by name — so it is re-read, never recomputed, here.
      return e.rel !== r.input.id || columnIsStored(r.input, e.name);
    }
    case 'filter': case 'sort': case 'limit': case 'distinct': return columnIsStored(r.input, name);
    case 'materialize': return r.fenced === true || columnIsStored(r.input, name);
    // A window's input columns pass through it unchanged; only what it numbers is computed.
    case 'window': return !r.specs.some(([minted]) => minted === name) && columnIsStored(r.input, name);
    case 'join': {
      const at = r.type.cols.findIndex((column) => column.name === name);
      const leftN = r.left.type.cols.length;
      if (at < 0) return false;
      return at < leftN ? columnIsStored(r.left, r.left.type.cols[at]!.name) : columnIsStored(r.right, r.right.type.cols[at - leftN]!.name);
    }
    default: return false;
  }
};

/**
 * IS COLUMN `name` OF `r` A KEY OF `r` — one scanned table's rowid, carried up through operators that keep or
 * drop rows but never repeat one (a `Project`, a `Filter`, a `Sort`, a `Limit`, a `Distinct`, a window)? Then no
 * two rows of `r` share it, and a sort term after it orders nothing. Conservative: a join, a union or an explode
 * on the way answers no.
 */
const ROWID_TABLES: ReadonlySet<string> = new Set(['nodes', 'edges', 'vertex_properties', 'edge_properties', 'labels', 'tombstones']);
export const columnIsRowKey = (r: Rel, name: string): boolean => {
  switch (r.kind) {
    case 'scan': return name === 'id' && ROWID_TABLES.has(r.table);
    case 'project': {
      const e = r.exprs.find(([column]) => column === name)?.[1];
      return e?.kind === 'col' && e.rel === r.input.id && columnIsRowKey(r.input, e.name);
    }
    case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize': return columnIsRowKey(r.input, name);
    case 'window': {
      // A ROW_NUMBER over the whole relation (no partition) numbers every row differently: a key.
      const spec = r.specs.find(([minted]) => minted === name)?.[1];
      if (spec) return spec.fn === 'row_number' && !spec.spec.partitionBy.length;
      return columnIsRowKey(r.input, name);
    }
    case 'join': {
      // A side's key stays a key where the OTHER side has at most one row (a correlated seed row joined to
      // the relation it starts): no row of this side is repeated.
      if (r.join === 'semi' || r.join === 'anti') return columnIsRowKey(r.left, name);
      const at = r.type.cols.findIndex((column) => column.name === name);
      const leftN = r.left.type.cols.length;
      if (at < 0) return false;
      return at < leftN
        ? atMostOneRow(r.right) && columnIsRowKey(r.left, r.left.type.cols[at]!.name)
        : atMostOneRow(r.left) && columnIsRowKey(r.right, r.right.type.cols[at - leftN]!.name);
    }
    default: return false;
  }
};

/**
 * COLUMN `name` OF `r` SPELLED OVER THE ROWS IT IS COMPUTED FROM — its defining expression with every read of a
 * relation on `r`'s spine replaced by what THAT column is defined as, down to its LEAVES (`leaves`, filled with
 * each relation the walk stopped at), so the answer reads only leaf columns, outer columns `r` is correlated
 * against, and the relations of its own subplans (a lookup's `(SELECT … FROM nodes WHERE id = e.tgt)` reads
 * `e.tgt`).
 *
 * The functional-dependency question `columnIsRowKey` asks of one column, asked of a computed one: a column whose
 * lineage reads only the columns of ONE stored row is a function of that row, so the row's key determines it; one
 * whose lineage reads ONE leaf column is a function of that column's value. It follows the operators that pass a
 * row through unchanged — a `Project` (substituting), a `Filter`/`Sort`/`Limit`/`Distinct`, a window's input
 * columns, an inner or cross join's sides, a semi/anti join's left, a LEFT join's left side — and stops anywhere
 * else at the column itself as a leaf: a scan (storage), and an operator whose column no single input row defines
 * (an aggregate's, a union's, a window's number, a LEFT join's right side, NULL where unmatched).
 *
 * `winners` asks it to follow one more operator: an ARG-EXTREMUM aggregate's column (`arg_min(value, key)`, the
 * min/max reducer's `argExtremum`). Every arg-extremum of one Aggregate reads the SAME winning row (the bare-column
 * law, `structure.ts` `checkArgExtremumLaw`), so such a column is its `value` spelled over that row — a key read off
 * the winner determines the others. It is opt-in because it holds only for a reader that asks per winning row:
 * a scalar aggregate over NO rows still emits one row whose arg-extrema are NULL, which no input row defines, so
 * the reader must take its presence from the aggregate's own row (the keyed pick does — `exactlyOneRow`, or the
 * key's nullness under the reducer's empty-input Filter), never from the lineage.
 */
export function columnLineage(r: Rel, name: string, leaves: Map<RelId, Rel>, winners = false): Expr | null {
  if (!r.type.cols.some((column) => column.name === name)) return null;
  const leaf = (): Expr => {
    leaves.set(r.id, r);
    return { kind: 'col', rel: r.id, name };
  };
  /** `e`, an expression over `input`'s columns, with each read replaced by that column's lineage. */
  const over = (e: Expr, input: Rel): Expr | null => {
    const defined = new Map<string, Expr>();
    for (const read of deepColsRead(e, input.id)) {
      const d = columnLineage(input, read, leaves, winners);
      if (!d) return null;
      defined.set(read, d);
    }
    return defined.size ? mapColsDeep(e, input.id, (read) => defined.get(read)!) : e;
  };
  switch (r.kind) {
    case 'scan': return leaf();
    case 'project': {
      const e = r.exprs.find(([column]) => column === name)?.[1];
      return e ? over(e, r.input) : null;
    }
    case 'aggregate': {
      const e = winners ? r.aggs.find(([column]) => column === name)?.[1] : undefined;
      return e?.kind === 'agg' && isArgExtremum(e.fn) ? over(e.args[0]!, r.input) : leaf();
    }
    case 'filter': case 'sort': case 'limit': case 'distinct': return columnLineage(r.input, name, leaves, winners);
    case 'window': return r.specs.some(([minted]) => minted === name) ? leaf() : columnLineage(r.input, name, leaves, winners);
    case 'join': {
      if (r.join === 'semi' || r.join === 'anti') return columnLineage(r.left, name, leaves, winners);
      const at = r.type.cols.findIndex((column) => column.name === name);
      const leftN = r.left.type.cols.length;
      if (at < 0) return null;
      if (at < leftN) return columnLineage(r.left, r.left.type.cols[at]!.name, leaves, winners);
      return r.join === 'left' ? leaf() : columnLineage(r.right, r.right.type.cols[at - leftN]!.name, leaves, winners);
    }
    default: return leaf();
  }
}

/**
 * `rows` rebuilt to ALSO carry, as column `as`, the rowid of the stored row `leaf` — the one row a caller's payload
 * columns are a function of (`columnLineage` with `winners`) — threaded up its spine from the first relation that
 * has it as a column: through a `Project` (one more passthrough), a `Filter`/`Sort`/`Limit` (retyped), and an
 * ARG-EXTREMUM `Aggregate` (one more arg-extremum over the SAME key, so the rowid is the winner's — the bare-column
 * law, `structure.ts` `checkArgExtremumLaw`). `null` where the spine holds any other operator before the rowid is
 * found. Every rebuilt node takes a fresh id; what lies below the first carrier is shared, unchanged.
 *
 * Built only for a reader that asks for the key (`lower/scoped.ts` `pickKey`): a reducer's winner then becomes ONE
 * key searched per host, its value and tag read back off the stored row, rather than one correlated scalar per
 * column — so the column costs nothing in a plan that never reads it.
 */
export function threadingRowKey(rows: Rel, leaf: Rel, as: string, mint: (hint: string) => RelId): Rel | null {
  if (!columnIsRowKey(leaf, 'id') || rows.type.cols.some((column) => column.name === as)) return null;
  const carrier = (r: Rel): string | undefined => r.type.cols.find((column) => {
    const lineage = columnLineage(r, column.name, new Map(), true);
    return lineage?.kind === 'col' && lineage.rel === leaf.id && lineage.name === 'id';
  })?.name;
  const keyMeta = { name: as, type: 'int' as const, nullable: true };
  /** `r` widened, and the name its rowid column has there. */
  const widen = (r: Rel): { readonly rel: Rel; readonly col: string } | null => {
    const has = carrier(r);
    if (has) return { rel: r, col: has };
    if (r.kind !== 'project' && r.kind !== 'filter' && r.kind !== 'sort' && r.kind !== 'limit' && r.kind !== 'aggregate') return null;
    const below = widen(r.input);
    if (!below) return null;
    const input = below.rel;
    const moved = (e: Expr): Expr => (input === r.input ? e : substRelId(e, r.input.id, input.id));
    const read: Expr = { kind: 'col', rel: input.id, name: below.col };
    switch (r.kind) {
      case 'project':
        return { rel: make.project({ id: mint('rkp'), input, channels: r.channels, type: { cols: [...r.type.cols, keyMeta] },
          exprs: [...r.exprs.map(([name, e]) => [name, moved(e)] as const), [as, read]] }), col: as };
      case 'filter':
        return { rel: make.filter({ id: mint('rkf'), input, channels: r.channels, type: input.type, pred: moved(r.pred) }), col: below.col };
      case 'sort':
        return { rel: make.sort({ id: mint('rks'), input, channels: r.channels, type: input.type, terms: r.terms.map((term) => ({ ...term, expr: moved(term.expr) })) }), col: below.col };
      case 'limit':
        return { rel: make.limit({ id: mint('rkl'), input, channels: r.channels, type: input.type,
          ...(r.count ? { count: moved(r.count) } : {}), ...(r.offset ? { offset: moved(r.offset) } : {}) }), col: below.col };
      case 'aggregate': {
        const winner = r.aggs.map(([, e]) => e).find((e): e is Extract<Expr, { readonly kind: 'agg' }> => e.kind === 'agg' && isArgExtremum(e.fn));
        if (!winner) return null;
        return { rel: make.aggregate({
          id: mint('rka'), input, channels: r.channels, type: { cols: [...r.type.cols, keyMeta] },
          groupBy: r.groupBy.map(moved), ...(r.having ? { having: moved(r.having) } : {}),
          aggs: [...r.aggs.map(([name, e]) => [name, moved(e)] as const), [as, { kind: 'agg', fn: winner.fn, args: [read, moved(winner.args[1]!)] }]],
        }), col: as };
      }
    }
  };
  const widened = widen(rows);
  if (!widened || widened.rel === rows) return null;
  // The key leaves under the caller's name: a Filter/Sort/Limit on top keeps its input's column name.
  return widened.col === as ? widened.rel : make.project({
    id: mint('rkp'), input: widened.rel, channels: rows.channels, type: { cols: [...rows.type.cols, keyMeta] },
    exprs: [...rows.type.cols.map((column) => [column.name, { kind: 'col', rel: widened.rel.id, name: column.name }] as const),
      [as, { kind: 'col', rel: widened.rel.id, name: widened.col }]],
  });
}

/**
 * DOES COLUMN `name` OF `r` COMPUTE WITH A SUBQUERY — is a scalar/`EXISTS`/`IN` subplan anywhere in the
 * expressions that DEFINE it, followed down through the operators that carry it? The question a correlated
 * `ORDER BY` asks of its terms: SQLite resolves a sort term's subquery without the scopes beyond its own query
 * (measured, bun:sqlite 3.51 — "no such column" for an outer column read there), so a term that is, or
 * flattens to, a subquery cannot sort a correlated body; a subquery that only FILTERS the body (an arm's
 * priority guard) or is only carried can. Conservative: a node this does not follow answers yes.
 *
 * MEMOIZED per (relation, column): a relation is immutable, and a value run whose every step reads its input
 * more than once (`substring`'s bounds read `length(v)` three times) otherwise asks the same column of the
 * same input once per READ — exponential in the run (measured: twelve `substring(0,4)` under a `by()`, 20 s).
 */
const readsSubqueryMemo = new WeakMap<Rel, Map<string, boolean>>();
export const columnReadsSubquery = (r: Rel, name: string): boolean => {
  let known = readsSubqueryMemo.get(r);
  if (!known) readsSubqueryMemo.set(r, known = new Map());
  const hit = known.get(name);
  if (hit !== undefined) return hit;
  const answer = readsSubqueryOf(r, name);
  known.set(name, answer);
  return answer;
};
const readsSubqueryOf = (r: Rel, name: string): boolean => {
  const exprReads = (e: Expr, input: Rel | undefined): boolean => {
    let hit = false;
    forEachExpr(e, (node) => {
      if (hit) return;
      if (exprRels(node).length) hit = true;
      else if (node.kind === 'col' && input && node.rel === input.id) hit = columnReadsSubquery(input, node.name);
    });
    return hit;
  };
  switch (r.kind) {
    case 'scan': case 'ref': case 'self-ref': return false;
    case 'values': {
      const at = r.type.cols.findIndex((column) => column.name === name);
      return at < 0 || r.rows.some((row) => !row[at] || exprReads(row[at]!, undefined));
    }
    case 'project': {
      const e = r.exprs.find(([column]) => column === name)?.[1];
      return !e || exprReads(e, r.input);
    }
    case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize': return columnReadsSubquery(r.input, name);
    case 'window': {
      const spec = r.specs.find(([minted]) => minted === name)?.[1];
      if (!spec) return columnReadsSubquery(r.input, name);
      return [...spec.args, ...spec.spec.partitionBy, ...spec.spec.orderBy.map((term) => term.expr)].some((e) => exprReads(e, r.input));
    }
    case 'union': {
      const at = r.type.cols.findIndex((column) => column.name === name);
      return at < 0 || r.inputs.some((input) => columnReadsSubquery(input, input.type.cols[at]!.name));
    }
    case 'join': {
      const at = r.type.cols.findIndex((column) => column.name === name);
      const leftN = r.left.type.cols.length;
      if (at < 0) return true;
      return at < leftN ? columnReadsSubquery(r.left, r.left.type.cols[at]!.name) : columnReadsSubquery(r.right, r.right.type.cols[at - leftN]!.name);
    }
    default: return true;
  }
};

/**
 * WHICH COLUMNS OF AN OUTER ROW A CORRELATED PLAN SPELLS, read as `outputs` — the outer columns some
 * expression of the plan COMPUTES WITH, as opposed to merely carrying. A column copied unchanged through a
 * projection, a filter or a join is a pass-through the emitter writes as a name (or not at all where nothing
 * reads it); a column an expression reads — a predicate, a sort term, a computed projection, an aggregate's
 * argument, a correlated subplan's read — is spelled there, and an outer column spelled inside a correlated
 * subplan is spelled as its DEFINITION (`columnIsStored`). `null` where the plan holds a node this does not
 * follow (a walk), which a caller reads as "every column".
 */
export function spelledOuterColumns(plan: Rel, outer: RelId, outputs: readonly string[]): ReadonlySet<string> | null {
  const NONE: ReadonlySet<string> = new Set();
  const alias = new Map<RelId, Map<string, ReadonlySet<string>>>();
  const reads = new Set<string>();
  let opaque = false;
  const of = (rel: RelId, name: string): ReadonlySet<string> =>
    rel === outer ? new Set([name]) : alias.get(rel)?.get(name) ?? NONE;
  const read = (e: Expr): void => forEachExpr(e, (node) => {
    if (node.kind === 'col') of(node.rel, node.name).forEach((c) => reads.add(c));
    for (const sub of exprRels(node)) {
      visit(sub);
      // A scalar or `IN` subplan's own output is read where it is compared or returned.
      if (node.kind !== 'exists') sub.type.cols.forEach((column) => of(sub.id, column.name).forEach((c) => reads.add(c)));
    }
  });
  const set = (r: Rel, name: string, from: ReadonlySet<string>): void => {
    const cols = alias.get(r.id) ?? new Map<string, ReadonlySet<string>>();
    cols.set(name, from);
    alias.set(r.id, cols);
  };
  const passes = (r: Rel, input: Rel): void => r.type.cols.forEach((column) => set(r, column.name, of(input.id, column.name)));
  const seen = new Set<Rel>();
  const visit = (r: Rel): void => {
    if (seen.has(r)) return;
    seen.add(r);
    relChildren(r).forEach(visit);
    switch (r.kind) {
      case 'scan': case 'ref': case 'self-ref': return;
      case 'values':
        r.rows.forEach((row) => row.forEach((e, i) => {
          if (e.kind === 'col') set(r, r.type.cols[i]!.name, of(e.rel, e.name));
          else read(e);
        }));
        return;
      case 'project':
        r.exprs.forEach(([name, e]) => { if (e.kind === 'col') set(r, name, of(e.rel, e.name)); else read(e); });
        return;
      case 'filter': case 'sort': case 'limit': case 'distinct': case 'materialize': case 'window':
        passes(r, r.input);
        relExprs(r).forEach(read);
        return;
      case 'explode':
        if (r.input) passes(r, r.input);
        read(r.expr);
        return;
      case 'aggregate':
        relExprs(r).forEach(read);
        return;
      case 'join': {
        const sides = [...r.left.type.cols.map((column) => of(r.left.id, column.name)), ...r.right.type.cols.map((column) => of(r.right.id, column.name))];
        r.type.cols.forEach((column, i) => set(r, column.name, sides[i] ?? NONE));
        if (r.on) read(r.on);
        return;
      }
      case 'union':
        r.type.cols.forEach((column, i) => set(r, column.name, new Set(r.inputs.flatMap((input) => [...of(input.id, input.type.cols[i]!.name)]))));
        return;
      case 'recursive': opaque = true; return;
    }
  };
  visit(plan);
  outputs.forEach((name) => of(plan.id, name).forEach((c) => reads.add(c)));
  return opaque ? null : reads;
}

/**
 * DOES A RELATION NEST ITS CORRELATED SUBPLANS — does a subplan it correlates hold a subplan of its own? A read that
 * spells a body more than once (a first-row pick's scalar per column, `leading`'s first-hit read once to find the
 * element and once to read it) would then COMPOUND: `2^depth` spellings. A subplan that is itself flat (an arm's
 * priority guard, one seek) is repeated once and no further; nor does an UNCORRELATED subplan count (a
 * `hasLabel()`'s label-id membership) — SQLite evaluates it once per statement.
 */
export function nestsCorrelatedSubplans(r: Rel): boolean {
  let deep = false;
  forEachRel(r, (node) => {
    for (const e of relExprs(node)) forEachExpr(e, (x) => {
      for (const sub of exprRels(x)) {
        if (!isSelfContained(sub)) forEachRel(sub, (s) => { if (relExprs(s).some(exprHasSubquery)) deep = true; });
      }
    });
  });
  return deep;
}
