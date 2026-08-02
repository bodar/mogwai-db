import type { Expr } from './expr.ts';
import type { RelBase, RelId, SortTerm } from './types.ts';

export type Table = 'nodes' | 'edges' | 'vertex_properties' | 'edge_properties' | 'property_fts' | 'labels';

type RawRel =
  | (RelBase & { readonly kind: 'scan'; readonly id: RelId; readonly table: Table; readonly alias: string })
  | (RelBase & { readonly kind: 'values'; readonly id: RelId; readonly rows: readonly (readonly Expr[])[] })
  | (RelBase & { readonly kind: 'self-ref'; readonly id: RelId; readonly name: string })
  | (RelBase & { readonly kind: 'prior-result'; readonly id: RelId; readonly step: number })
  | (RelBase & { readonly kind: 'project'; readonly id: RelId; readonly input: Rel; readonly exprs: readonly (readonly [string, Expr])[] })
  | (RelBase & { readonly kind: 'filter'; readonly id: RelId; readonly input: Rel; readonly pred: Expr })
  | (RelBase & { readonly kind: 'aggregate'; readonly id: RelId; readonly input: Rel; readonly groupBy: readonly Expr[]; readonly aggs: readonly (readonly [string, Expr])[]; readonly having?: Expr })
  | (RelBase & { readonly kind: 'sort'; readonly id: RelId; readonly input: Rel; readonly terms: readonly SortTerm[] })
  | (RelBase & { readonly kind: 'limit'; readonly id: RelId; readonly input: Rel; readonly count?: Expr; readonly offset?: Expr })
  | (RelBase & { readonly kind: 'distinct'; readonly id: RelId; readonly input: Rel })
  | (RelBase & { readonly kind: 'window'; readonly id: RelId; readonly input: Rel; readonly specs: readonly (readonly [string, Extract<Expr, { kind: 'window-expr' }>])[] })
  | (RelBase & { readonly kind: 'explode'; readonly id: RelId; readonly input: Rel; readonly expr: Expr; readonly as: { readonly key?: string; readonly value: string; readonly ord?: string } })
  | (RelBase & { readonly kind: 'materialize'; readonly id: RelId; readonly input: Rel; readonly name?: string })
  | (RelBase & { readonly kind: 'join'; readonly id: RelId; readonly left: Rel; readonly right: Rel; readonly join: 'inner' | 'left' | 'cross' | 'semi' | 'anti'; readonly on?: Expr })
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
