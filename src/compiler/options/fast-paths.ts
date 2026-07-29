import { EMPTY_REGISTRY } from '../../services/spi/registry.ts';
import type { ServiceRegistry } from '../../services/spi/types.ts';
import type { ChainFacts } from '../ir/analyze.ts';

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

// ---------- the FastPath contract ----------
//
// The prose contract CLAUDE.md states for a fast path, turned into a TYPE. A FastPath recognizes a
// sub-shape and lowers it to SPECIALIZED SQL, with the generic path retained as both the fallback
// and the semantic authority. That retention is the whole definition: a lowering required for
// correctness is not a fast path, which is why `equivalentWhen` below is mandatory. It is NOT a Pass
// (it does not rewrite Step[]) and NOT a ChainFacts (it does not annotate) — the third sibling. Dispatch stays FAMILY-LOCAL: each FastPath object is defined in its own family file next
// to its tryLower body, and fires at its own natural lowering site. This interface + the shared
// FastPathContext give the six a common SHAPE, not a single call point.
//
// R is generic because the six lower to genuinely different artifacts (an Expression, a terminal
// Compiled, a ScalarGate builder, an ElementStream) — forcing one result type would be the false
// unification. `appliesWhen` is the HOME for a fast path's recognition logic (its enable-flag check
// AND its structural/shape gate), so a fast path that today welds "does it match" to "emit the SQL"
// gets those two concerns pulled into two methods.

/** Ambient info every FastPath consults, beyond its own explicit per-site args. Kept minimal and
 *  structural — the Engine/Stream/carried a site needs are passed as tryLower/appliesWhen varargs,
 *  not smuggled here. */
export interface FastPathContext {
  readonly enabled: FastPathConfig;
  /** Present only where chain-level facts are in scope (the movementCollapse chain gate is already
   *  folded into `enabled.movementCollapse` via collapseSafeFastPaths, so most sites omit this). */
  readonly facts?: ChainFacts;
}

export interface FastPath<Args extends unknown[], R> {
  /** Matches the FastPathConfig flag this path is switched by. */
  readonly name: keyof FastPathConfig;
  /** Cheap structural gate: reads ctx.enabled[name] AND the shape test this path's recognition
   *  performs. Pure; builds no SQL. false → skip straight to the generic middle. */
  appliesWhen(ctx: FastPathContext, ...args: Args): boolean;
  /** Try the specialized lowering. Called only when appliesWhen held. May STILL return null when a
   *  two-stage recognizer fails on an internal "not yet supported" leaf after the shape gate passed
   *  (e.g. predicate inlining) — recognition failure is ALWAYS null, never a throw, never a support
   *  boundary. null → fall through to the generic path. */
  tryLower(ctx: FastPathContext, ...args: Args): R | null;
  /** The equivalence obligation as a machine-checkable reference: the name of the committed test
   *  proving enabled ≡ disabled. Required — a FastPath without it fails the registry test. This is
   *  the "prove it's result-equivalent" law turned into a declaration a reviewer can check. */
  readonly equivalentWhen: string;
}

/** The shared dispatch shape: try the fast path at its OWN site, else null-to-generic. This is the
 *  common shape, NOT a central dispatcher — each family calls it for its own FastPath at the site
 *  that already owns that lowering (family-locality is the hard constraint). */
export function runFastPath<Args extends unknown[], R>(fp: FastPath<Args, R>, ctx: FastPathContext, ...args: Args): R | null {
  return fp.appliesWhen(ctx, ...args) ? fp.tryLower(ctx, ...args) : null;
}

/** Build the ambient FastPathContext from a resolved FastPathConfig (+ optional ChainFacts). */
export const fastPathContext = (enabled: FastPathConfig, facts?: ChainFacts): FastPathContext => ({ enabled, facts });
