import { EMPTY_REGISTRY } from './services/registry.ts';
import type { ServiceRegistry } from './services/types.ts';

/** Independently switchable optimized lowerings. The generic path remains the
 * semantic authority; these switches exist for equivalence tests and diagnostics. */
export interface FastPathConfig {
  readonly predicateInlining: boolean;
  readonly singleHopOptional: boolean;
  readonly bulkRepeatCount: boolean;
  /** For a substring predicate (containing/startingWith/endingWith + not*) whose term is
   *  >= 3 chars over a STORED property, route through the property_fts trigram index instead
   *  of a base-table LIKE scan. Disabling routes through the generic (semantically identical,
   *  case-insensitive) LIKE path — the equivalence-test fallback. A < 3-char term, or a
   *  substring over a COMPUTED scalar / injected list (no stored property to index), ALWAYS
   *  uses the LIKE path regardless of this flag: same case-insensitive result, an unindexed
   *  (documented) scan. */
  readonly ftsSubstringPredicate: boolean;
  /** Inline a scalar predicate body (and/or/not/filter/where over a scalar) to one boolean
   *  `WHERE` over the value, instead of the generic child-existence gate (a correlated EXISTS
   *  per parent row). Disabling routes through the generic path — result-equivalent. */
  readonly scalarPredicateInlining: boolean;
  /** Collapse convergent walks at each movement (`SELECT id, SUM(bulk) … GROUP BY id`) so the
   *  frontier stays bounded by reachable |V| instead of the (exponential) walk count. Only
   *  active on a chain the scan proves collapse-safe (reducer-terminal, pure movement/filter,
   *  no path/as/sack/branch/order/limit) — the reducer's SUM(bulk) makes it result-equivalent to
   *  the enumerated form. Disabling emits the plain UNION-ALL movement (same result, more rows). */
  readonly movementCollapse: boolean;
}

export interface CompileOptions {
  readonly fastPaths?: Partial<FastPathConfig>;
  /** The service registry for call(), injected via DI (application → manager → executeFramed
   *  → compile). When absent, the compiler defaults to EMPTY_REGISTRY — correct for every
   *  non-call() traversal; a call() then throws "unknown service". */
  readonly registry?: ServiceRegistry;
}

export const DEFAULT_FAST_PATHS: FastPathConfig = Object.freeze({
  predicateInlining: true,
  singleHopOptional: true,
  bulkRepeatCount: true,
  ftsSubstringPredicate: true,
  scalarPredicateInlining: true,
  movementCollapse: true,
});

export const resolveFastPaths = (options?: CompileOptions): FastPathConfig => ({
  ...DEFAULT_FAST_PATHS,
  ...options?.fastPaths,
});

export const resolveRegistry = (options?: CompileOptions): ServiceRegistry =>
  options?.registry ?? EMPTY_REGISTRY;
