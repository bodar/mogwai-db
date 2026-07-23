import { EMPTY_REGISTRY } from '../../services/spi/registry.ts';
import type { ServiceRegistry } from '../../services/spi/types.ts';

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
  /** Federation recursion depth for THIS compile (request-scoped DI context, rides the same
   *  channel as `registry` — read where a barrier's apply closure is built, so it captures the
   *  starting depth and recurses at depth+1). 0 at the top-level query; each federated hop
   *  re-compiles the sibling one deeper. Guarded against MAX_FEDERATION_DEPTH at each hop. */
  readonly federationDepth?: number;
  /** The app-scope dependencies (registry + fastPaths + federation source), as a DI scope.
   *  When present it is the source of truth for registry/fastPaths — the loose fields above
   *  are the legacy path (still honoured for callers that haven't adopted the scope). The
   *  store tier builds this once per Executor; see src/scopes.ts. */
  readonly app?: import('../../scopes.ts').AppScope;
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
  ...(options?.app?.fastPaths ?? DEFAULT_FAST_PATHS),
  ...options?.fastPaths,
});

export const resolveRegistry = (options?: CompileOptions): ServiceRegistry =>
  options?.registry ?? options?.app?.registry ?? EMPTY_REGISTRY;

/** The federation depth for this compile (0 at the top level). */
export const resolveFederationDepth = (options?: CompileOptions): number =>
  options?.federationDepth ?? 0;
