import type { Rel, RelKind } from './rel.ts';

/**
 * WHERE A NODE LANDS IN THE ASSEMBLED SELECT — the emitter's fusion rules, stated once, as facts
 * about STRUCTURE alone.
 *
 * §5's assembler walks down from a node filling `SELECT`'s slots and opens a nested SELECT only when
 * the slot it needs is already occupied. That decision reads nothing but slot OCCUPANCY, so it is
 * answerable without rendering a single expression — and two callers need the answer:
 *
 * - the emitter itself (`emit.ts`), which asks it of the block it is holding;
 * - `check`, which must decide whether a `Recursive` step's self-reference will land UNWRAPPED in
 *   the term's `FROM` (P1's law), and must decide it before anything is rendered.
 *
 * The rules therefore live here rather than in either caller. A second copy of `needNewSubQuery` in
 * the checker would be a copy that drifts, and the failure it would produce is the worst kind
 * available: a plan the checker admits and the emitter then wraps in a derived table, which SQLite
 * answers with `circular reference` — or, for the shapes where it does not, with wrong rows.
 *
 * Prior art, same algorithm and same reason —
 * `vendor/calcite/core/src/main/java/org/apache/calcite/rel/rel2sql/SqlImplementor.java:2167`
 * (`needNewSubQuery`, the slot-occupied test itself).
 */

/**
 * The slots of a `SELECT` a built block has already filled. `emit.ts`'s `Block` satisfies this
 * structurally — it carries the same fields holding rendered expressions — so the predicates below
 * take either without a conversion, which is what keeps ONE definition honest.
 */
export interface Slots {
  readonly distinct: boolean;
  readonly windowed: boolean;
  /** Present (even empty) once the block aggregates: `[]` is a whole-relation aggregate, which emits
   *  no GROUP BY clause but still occupies the slot. */
  readonly groupBy?: readonly unknown[];
  readonly having?: unknown;
  readonly orderBy?: readonly unknown[];
  readonly limit?: unknown;
  readonly offset?: unknown;
}

/** Slots whose occupancy means a node cannot be fused into this block. */
export const tailUsed = (b: Slots): boolean => b.orderBy !== undefined || b.limit !== undefined || b.offset !== undefined || b.distinct;
export const grouped = (b: Slots): boolean => b.groupBy !== undefined;
/** A side of a join may be spliced into the join's own FROM only when it fills nothing else. */
export const spliceable = (b: Slots): boolean => !grouped(b) && b.having === undefined && !tailUsed(b) && !b.windowed;

/**
 * No alias this side would lift collides with one the other side already took. Splicing lifts a
 * side's own FROM items into the join's own FROM, so two sides reading the SAME shared relation lift
 * the same alias twice — measured: `FROM r0 x INNER JOIN r0 x` → `ambiguous column name`. A collision
 * is not an error (the sides are genuinely different relations); it just means the side keeps its own
 * SELECT, where its aliases are private again.
 */
export const free = (aliases: readonly string[], taken: ReadonlySet<string>): boolean =>
  !aliases.some((alias) => taken.has(alias));

/**
 * THE JOIN-SPLICE DECISION, stated once for both readers (§5).
 *
 * The emitter holds a rendered `Block` (itself a `Slots`) and this analysis a `BlockShape`; both ask
 * the identical question of a join side — may it fuse into the join's own FROM? — so it lives here
 * rather than inlined in each. A side splices only when the join permits it (`mayFuse`: not a LEFT
 * join's right side), it fills nothing but FROM/WHERE (`spliceable`), and its aliases are `free` of
 * the other side's. A copy that drifts is the P1 hazard `check` guards against — see the header.
 */
export const maySplice = (mayFuse: boolean, slots: Slots, aliases: readonly string[], taken: ReadonlySet<string>): boolean =>
  mayFuse && spliceable(slots) && free(aliases, taken);

/** A kind that fuses no input of its own: the leaves, and the two whose children are not blocks it
 *  fills (a `Join` asks `spliceable` of each side, a `Recursive` renders its own statement). */
const fusesNothing = (): boolean => false;

/**
 * Which ALREADY-OCCUPIED slots force this kind's input into a nested SELECT. TOTAL over `RelKind`,
 * so a new node kind must declare its rule rather than silently inheriting one.
 *
 * `union` is the arm rule: SQLite's compound arms are select-CORES, and an arm may not carry its own
 * `ORDER BY`/`LIMIT` — those belong to the compound as a whole. `DISTINCT` is legal in an arm, which
 * is why this is not `tailUsed`.
 */
export const NEEDS_SUBQUERY: { readonly [K in RelKind]: (input: Slots) => boolean } = {
  scan: fusesNothing, values: fusesNothing, 'self-ref': fusesNothing, ref: fusesNothing,
  join: fusesNothing, recursive: fusesNothing,
  // A projection may overwrite the select list except over DISTINCT, or over a whole-relation
  // aggregate: replacing the latter with constants would erase the aggregate's one-row shape.
  project: (b) => b.distinct || (grouped(b) && b.groupBy?.length === 0),
  // Over an aggregate a Filter IS `HAVING` — one of §3's declared collapses, not a second node.
  filter: (b) => b.windowed || tailUsed(b) || b.having !== undefined,
  aggregate: (b) => b.windowed || grouped(b) || tailUsed(b),
  // An `ORDER BY` cannot name a select alias, so fusing re-inlines the expression that computes its
  // subject — and over a windowed input that expression is a whole window function.
  sort: (b) => tailUsed(b) || b.windowed,
  limit: (b) => b.limit !== undefined || b.offset !== undefined,
  distinct: (b) => tailUsed(b),
  // A window's own `OVER (…)` may never reference a window function, so a spec reading a column its
  // input computed with one has no legal spelling in the same SELECT.
  window: (b) => tailUsed(b) || b.windowed,
  explode: (b) => b.windowed || grouped(b) || tailUsed(b),
  // The one whose whole purpose is a boundary — but the boundary is a CTE the `Name` pass makes, not
  // a derived table here, so as a block it fuses like anything else.
  materialize: fusesNothing,
  union: (b) => b.orderBy !== undefined || b.limit !== undefined || b.offset !== undefined,
};

/**
 * A block as this analysis sees it: what it has filled, what aliases it occupies, and — the question
 * P1 asks — which relations stand UNWRAPPED in its `FROM` join tree.
 *
 * `closed` is a compound (`Union`) or a statement of its own (`Recursive`): whatever is inside it is
 * a different SELECT, so it exposes neither aliases to collide with nor sources at this level.
 */
export interface BlockShape {
  readonly slots: Slots;
  /** Every FROM-item alias in this block — what a join's side-splice must not collide with. */
  readonly aliases: readonly string[];
  /** The relations standing unwrapped in this block's FROM join tree, in order. A DERIVED table
   *  contributes none: what is inside it is a different SELECT. */
  readonly sources: readonly Rel[];
  /** Every node whose operator lands in THIS `SELECT`, outermost first — what a law about "this
   *  SELECT" applies to. A node behind a derived table or a correlated subquery is in a different
   *  SELECT and contributes none. */
  readonly fused: readonly Rel[];
}
export type Shape = BlockShape | 'closed';

const EMPTY: Slots = { distinct: false, windowed: false };

/**
 * WHICH RELATION KINDS STAND IN A `FROM` WITHOUT A WRAPPING SELECT — the classification the emitter's
 * `directSource` CONSTRUCTS and this analysis PREDICTS, single-sourced so the two cannot drift over
 * which kinds are table sources. TOTAL over `RelKind` (like `NEEDS_SUBQUERY`), so a new kind must
 * declare whether it is one rather than silently inheriting `false` here and a missing switch arm
 * there — the divergence that makes `check` admit a P1 plan the emitter then wraps.
 */
export const DIRECT_SOURCE: { readonly [K in RelKind]: boolean } = {
  scan: true, values: true, 'self-ref': true, ref: true,
  join: false, recursive: false, project: false, filter: false,
  aggregate: false, sort: false, limit: false, distinct: false,
  window: false, explode: false, materialize: false, union: false,
};
/** A relation that can stand in a FROM clause without a wrapping SELECT. */
export const isDirectSource = (r: Rel): boolean => DIRECT_SOURCE[r.kind];
/** How the emitter aliases a FROM item: a `Scan` carries its own, everything else uses its `RelId`. */
export const aliasOf = (r: Rel): string => (r.kind === 'scan' ? r.alias : r.id);
/** A relation the block reaches only through a derived table: a fresh SELECT, one alias, no sources
 *  — and nothing of what is inside it belongs to this SELECT. */
const derived = (r: Rel): BlockShape => ({ slots: EMPTY, aliases: [r.id], sources: [], fused: [] });
const leaf = (r: Rel): BlockShape => ({ slots: EMPTY, aliases: [aliasOf(r)], sources: [r], fused: [r] });
/** A unary node's own block: its operator lands in the block its input gave it. */
const over = (r: Rel, b: BlockShape, slots: Slots = b.slots): BlockShape => ({ ...b, slots, fused: [r, ...b.fused] });

const cache = new WeakMap<Rel, Shape>();

/**
 * The block the emitter will assemble for this relation — slots, aliases and unwrapped sources.
 *
 * Pure in the node (a `Rel` is frozen), so it is memoised across the DAG: without that a diamond
 * costs exponentially, and a plan with shared subtrees is the normal case here (§3.4).
 */
export function shapeOf(r: Rel): Shape {
  const seen = cache.get(r);
  if (seen) return seen;
  const out = compute(r);
  cache.set(r, out);
  return out;
}

/** The input of a unary node, as the block that node fills a slot in. */
const inputShape = (input: Rel, kind: RelKind): BlockShape => {
  const shape = shapeOf(input);
  return shape === 'closed' || NEEDS_SUBQUERY[kind](shape.slots) ? derived(input) : shape;
};

/**
 * One side of a join. Splicing lifts the side's own FROM items into this join's — which is what puts
 * a self-reference two nodes down at the term's top level — and it happens only when the side fills
 * nothing else and its aliases do not collide with what the other side already took.
 */
const sideShape = (r: Rel, mayFuse: boolean, taken: ReadonlySet<string>): BlockShape => {
  const shape = shapeOf(r);
  if (shape !== 'closed' && maySplice(mayFuse, shape.slots, shape.aliases, taken)) return shape;
  return isDirectSource(r) && free([aliasOf(r)], taken) ? leaf(r) : derived(r);
};

function compute(r: Rel): Shape {
  switch (r.kind) {
    case 'scan': case 'values': case 'self-ref': case 'ref': return leaf(r);
    case 'project': case 'materialize': return over(r, inputShape(r.input, r.kind));
    case 'filter': {
      const b = inputShape(r.input, 'filter');
      // Over a grouped block the predicate is a HAVING; otherwise it is a WHERE, which occupies no
      // slot this analysis tracks (nothing is ever blocked by one).
      return over(r, b, grouped(b.slots) ? { ...b.slots, having: r.pred } : b.slots);
    }
    case 'aggregate': {
      const b = inputShape(r.input, 'aggregate');
      return over(r, b, { ...b.slots, groupBy: r.groupBy, having: r.having });
    }
    case 'sort': {
      const b = inputShape(r.input, 'sort');
      return over(r, b, { ...b.slots, orderBy: r.terms });
    }
    case 'limit': {
      const b = inputShape(r.input, 'limit');
      return over(r, b, { ...b.slots, limit: r.count, offset: r.offset });
    }
    case 'distinct': {
      const b = inputShape(r.input, 'distinct');
      return over(r, b, { ...b.slots, distinct: true });
    }
    case 'window': {
      const b = inputShape(r.input, 'window');
      return over(r, b, { ...b.slots, windowed: true });
    }
    case 'explode': {
      // `json_each(…)` is a table-valued FROM item, never a relation of the algebra — so it takes an
      // alias and contributes no source. Source-less, it IS the whole FROM (the correlated form).
      if (!r.input) return { slots: EMPTY, aliases: [r.id], sources: [], fused: [r] };
      const b = inputShape(r.input, 'explode');
      return { ...over(r, b), aliases: [...b.aliases, r.id] };
    }
    case 'join': {
      const left = sideShape(r.left, true, new Set());
      const taken = new Set(left.aliases);
      // A semi/anti join's right side is an `EXISTS` in the WHERE — a nested SELECT, so it adds
      // neither a FROM item, nor a source, nor a fused operator to THIS block.
      if (r.join === 'semi' || r.join === 'anti')
        return { slots: EMPTY, aliases: left.aliases, sources: left.sources, fused: [r, ...left.fused] };
      // Only an inner/cross join may splice its right side: a LEFT join's right-side predicate must
      // stay inside the subquery, or an unmatched row is filtered instead of null-padded.
      const right = sideShape(r.right, r.join === 'inner' || r.join === 'cross', taken);
      return {
        slots: EMPTY,
        aliases: [...left.aliases, ...right.aliases],
        sources: [...left.sources, ...right.sources],
        fused: [r, ...left.fused, ...right.fused],
      };
    }
    case 'union': case 'recursive': return 'closed';
  }
}

/**
 * THE RELATIONS STANDING UNWRAPPED IN A RELATION'S OWN `FROM` JOIN TREE.
 *
 * ⚠️ **SQL's `FROM` is a join TREE and everything in it is top-level** — however many algebra nodes
 * sit above it. P1's law is that the recursive reference is not wrapped in a DERIVED TABLE, which is
 * a different question from depth, and answering it by matching one level of shape refused the most
 * common `repeat()` body there is: `project(join(self, edges))` denotes the canonical recursive walk
 * (measured, bun:sqlite 3.53.0 — `WITH RECURSIVE w(id) AS (SELECT 1 UNION ALL SELECT e.dst FROM w
 * INNER JOIN edges e ON w.id = e.src) SELECT * FROM w` returns `1,2,3,4` over a 3-edge chain).
 */
export const fromTree = (r: Rel): readonly Rel[] => {
  const shape = shapeOf(r);
  return shape === 'closed' ? [] : shape.sources;
};

/**
 * THE NODES WHOSE OPERATORS LAND IN THIS RELATION'S OWN `SELECT`, outermost first.
 *
 * ⚠️ **A law about "this SELECT" applies to exactly these, and a node behind a DERIVED TABLE is in a
 * different SELECT — the same fact P2 established for a correlated subquery.** Measured, bun:sqlite
 * 3.53.0: an aggregate, a window function, a `DISTINCT` and an `ORDER BY … LIMIT` each run and
 * return the right rows inside a derived table joined into a recursive term, while the same two
 * fused into the term proper are `recursive aggregate queries not supported` and `cannot use window
 * functions in recursive queries`. Walking node children instead refuses the first four.
 */
export const fusedInto = (r: Rel): readonly Rel[] => {
  const shape = shapeOf(r);
  return shape === 'closed' ? [r] : shape.fused;
};
