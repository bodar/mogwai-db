/** Independently switchable optimized lowerings. The generic path remains the
 * semantic authority; these switches exist for equivalence tests and diagnostics. */
export interface FastPathConfig {
  readonly predicateInlining: boolean;
  readonly singleHopOptional: boolean;
  readonly bulkRepeatCount: boolean;
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
}

export const DEFAULT_FAST_PATHS: FastPathConfig = Object.freeze({
  predicateInlining: true,
  singleHopOptional: true,
  bulkRepeatCount: true,
  scalarPredicateInlining: true,
  movementCollapse: true,
});

export const resolveFastPaths = (options?: CompileOptions): FastPathConfig => ({
  ...DEFAULT_FAST_PATHS,
  ...options?.fastPaths,
});
