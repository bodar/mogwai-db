import type { Expr } from './expr.ts';
import type { RelBase, RelId, SortTerm } from './types.ts';

/** Every physical table in `src/storage.ts`'s schema. `Scan` is the ONE node that names one (§3.3),
 * so a table absent here is a shape the algebra cannot express at all — `vertex_labels` was, which
 * is `hasLabel()`, and the Phase-1 gate over real L2 families is what found it. */
export type Table = 'nodes' | 'edges' | 'vertex_labels' | 'vertex_properties' | 'edge_properties'
  | 'vertex_property_cardinality' | 'property_fts' | 'labels';

type RawRel =
  | (RelBase & { readonly kind: 'scan'; readonly id: RelId; readonly table: Table; readonly alias: string })
  | (RelBase & { readonly kind: 'values'; readonly id: RelId; readonly rows: readonly (readonly Expr[])[] })
  | (RelBase & { readonly kind: 'self-ref'; readonly id: RelId; readonly name: string })
  | (RelBase & { readonly kind: 'ref'; readonly id: RelId; readonly name: string })
  | (RelBase & { readonly kind: 'project'; readonly id: RelId; readonly input: Rel; readonly exprs: readonly (readonly [string, Expr])[] })
  | (RelBase & { readonly kind: 'filter'; readonly id: RelId; readonly input: Rel; readonly pred: Expr })
  | (RelBase & { readonly kind: 'aggregate'; readonly id: RelId; readonly input: Rel; readonly groupBy: readonly Expr[]; readonly aggs: readonly (readonly [string, Expr])[]; readonly having?: Expr })
  | (RelBase & { readonly kind: 'sort'; readonly id: RelId; readonly input: Rel; readonly terms: readonly SortTerm[] })
  | (RelBase & { readonly kind: 'limit'; readonly id: RelId; readonly input: Rel; readonly count?: Expr; readonly offset?: Expr })
  | (RelBase & { readonly kind: 'distinct'; readonly id: RelId; readonly input: Rel })
  | (RelBase & { readonly kind: 'window'; readonly id: RelId; readonly input: Rel; readonly specs: readonly (readonly [string, Extract<Expr, { kind: 'window-expr' }>])[] })
  /** `json_each(expr)` — the members of a JSON value as rows. `input` is OPTIONAL, and its absence is
   *  the SOLE-FROM form (`FROM json_each(c.list) x`): the expression then references a relation in the
   *  OUTER scope, which is what makes a per-member computation a correlated scalar subquery rather
   *  than a join. Every list member op is that shape — a transform, a predicate, a local reducer or a
   *  local slice over one traverser's members, not over the stream's rows. */
  | (RelBase & { readonly kind: 'explode'; readonly id: RelId; readonly input?: Rel; readonly expr: Expr; readonly as: { readonly key?: string; readonly value: string; readonly ord?: string; readonly type?: string } })
  | (RelBase & { readonly kind: 'materialize'; readonly id: RelId; readonly input: Rel; readonly name?: string })
  /** `ordered` pins the LEFT side as the outer loop. It is not an algebraic property — the join
   *  means the same thing either way — but a PHYSICAL one, and the only place the algebra states a
   *  fact about execution rather than about rows. It exists because a traversal already fixes the
   *  order its steps run in and SQLite does not know that: with the order left free the planner
   *  re-derives it from cardinality guesses, and on a graph with no `sqlite_stat1` those guesses put
   *  the most selective seek LAST (measured: 1 492 ms vs 0.3 ms on a 4 000-vertex 1-hop). Only an
   *  `inner` join may carry it — a `left` join's order is already fixed by its semantics, and a
   *  `cross` join has no ON to reorder around. */
  | (RelBase & { readonly kind: 'join'; readonly id: RelId; readonly left: Rel; readonly right: Rel; readonly join: 'inner' | 'left' | 'cross' | 'semi' | 'anti'; readonly on?: Expr; readonly ordered?: boolean })
  | (RelBase & { readonly kind: 'union'; readonly id: RelId; readonly inputs: readonly Rel[]; readonly all: boolean })
  | (RelBase & { readonly kind: 'recursive'; readonly id: RelId; readonly name: string; readonly cols: readonly string[]; readonly seed: Rel; readonly step: (self: Rel) => Rel });

const relBrand: unique symbol = Symbol('RelIR.Rel');
type Branded<T> = T extends unknown ? T & { readonly [relBrand]: true } : never;

/** A checked construction token. Only the kind-specific functions in factory.ts mint one. */
export type Rel = Branded<RawRel>;
export type RelKind = RawRel['kind'];
export type RelNode<K extends RelKind> = Extract<RawRel, { readonly kind: K }>;
export type RelInit<K extends RelKind> = Omit<RelNode<K>, 'kind' | 'id'>;

/** Factory implementation seam; deliberately not re-exported from a public surface. */
export const brandRel = <K extends RelKind>(node: RelNode<K>): Extract<Rel, { readonly kind: K }> =>
  Object.freeze({ ...node, [relBrand]: true }) as Extract<Rel, { readonly kind: K }>;

export const isRel = (value: unknown): value is Rel =>
  typeof value === 'object' && value !== null && (value as { readonly [relBrand]?: unknown })[relBrand] === true;
