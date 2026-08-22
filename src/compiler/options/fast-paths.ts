import { EMPTY_REGISTRY } from '../../services/spi/registry.ts';
import type { RegistryProvider } from '../../scopes.ts';
import type { ChainFacts } from '../ir/analyze.ts';

/** Independently switchable optimized lowerings. The generic path remains the
 * semantic authority; these switches exist for equivalence tests and diagnostics. */
export interface FastPathConfig {
  readonly predicateInlining: boolean;
  readonly singleHopOptional: boolean;
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
  /**
   * Expand a recognized `repeat()` BODY inline into the recursive term (movements + `has()` +
   * `sack(op).by()` + a sack-reading `where()`) instead of precompiling it once into a keyed
   * `(from_id, to_id)` relation the recursive term joins. The flat form walks the frontier lazily;
   * the keyed form costs |V|×fanout up front but is the ordinary StepFns, which is what makes it the
   * semantic authority.
   *
   * **This is the SEVENTH specialized lowering and it was the only one no differential could see.**
   * The flat expansion always won where it recognised a body, so its agreement with the generic
   * route was asserted by its own header comment and by nothing else — it is not a `FastPath`
   * object, so it had no flag and no `equivalentWhen`. Disabling it routes every body the keyed
   * relation can express through that relation, which is exactly the equivalence L5's per-switch
   * sweep now runs (`FAST_PATH_NAMES` derives from this object, so the flag enters it for free).
   *
   * Two body shapes are NOT covered by the equivalence and stay flat whatever this says, because the
   * keyed route cannot express them at all rather than expressing them differently: a per-iteration
   * `sack()` fold (the accumulator depends on the running value, not just the hop) and a live path
   * array (positions are recorded per iteration). Both are guarded at the same site.
   */
  readonly repeatBodyExpansion: boolean;
  /**
   * Lift a correlated property `EXISTS` over a bare element scan in front of that scan, as a
   * `DISTINCT` relation of owner ids the plan is DRIVEN from (`src/rel/passes/semijoin.ts`,
   * `indexSeek`). Disabling
   * leaves the predicate where the lowering put it — same rows, checked instead of sought.
   *
   * **The EIGHTH switch, and the first that selects a physical ACCESS PATH rather than a lowering
   * strategy.** That is normally the mark of something RelIR declines rather than implements (the
   * FTS contrast in `compileViaRel`), and the difference is that this one changes no algebra at all:
   * the predicate it lifts stays exactly where it was, so both positions return the same rows out of
   * the same predicate and there is no second semantics to keep in step.
   *
   * It is switchable anyway, and for the reason `repeatBodyExpansion` is: a rewrite whose agreement
   * with the unrewritten form is asserted by its own header comment and by nothing else is a rewrite
   * with no differential. L5's per-switch sweep is the check, and `order` divergence there is
   * telemetry (`test/L5-properties/oracle.ts`) — which it has to be, since driving from a different
   * relation legitimately changes the emission order of a traversal that never called `order()`.
   */
  readonly propertySeek: boolean;
}

export interface CompileOptions {
  readonly fastPaths?: Partial<FastPathConfig>;
  /** The service registry for call(), injected via DI (application → manager → executeFramed
   *  → compile) as a PROVIDER — a function of the app scope, because a service takes its own
   *  dependencies at construction (see scopes.ts RegistryProvider). When absent, the compiler
   *  defaults to EMPTY_REGISTRY — correct for every non-call() traversal; a call() then throws
   *  "unknown service". */
  readonly registry?: RegistryProvider;
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
  /** DETACHED-transfer compile mode. Set ONLY by `raw()` — the federated snapshot path — so the leaf
   *  emits a FULLER property node (`{t, v, vpid, meta?}`) that carries the VertexProperty's own id and
   *  meta-properties, which a bound `properties().id()` / meta read then consumes. Off (the default) for
   *  ordinary wire framing, so base props stay `{t, v}` and the base plan is unchanged by construction. */
  readonly detached?: boolean;
}

export const DEFAULT_FAST_PATHS: FastPathConfig = Object.freeze({
  predicateInlining: true,
  singleHopOptional: true,
  ftsSubstringPredicate: true,
  scalarPredicateInlining: true,
  movementCollapse: true,
  repeatBodyExpansion: true,
  propertySeek: true,
});

export const resolveFastPaths = (options?: CompileOptions): FastPathConfig => ({
  ...(options?.app?.fastPaths ?? DEFAULT_FAST_PATHS),
  ...options?.fastPaths,
});

/** The registry PROVIDER for a compile that brought no app scope — the loose-options path. (When
 *  `options.app` is present the compiler uses that scope directly and never calls this, so there
 *  is no `app.registry` branch to fall back to.) */
export const resolveRegistry = (options?: CompileOptions): RegistryProvider =>
  options?.registry ?? (() => EMPTY_REGISTRY);

/** The federation depth for this compile (0 at the top level). */
export const resolveFederationDepth = (options?: CompileOptions): number =>
  options?.federationDepth ?? 0;

/**
 * The flags that are a SWITCH but not a `FastPath` OBJECT, with the equivalence each one owes.
 *
 * Six of the seven fast paths recognize a sub-shape and lower it to a separable artifact — an
 * Expression, a Compiled, a gate builder, a Stream — which is what makes a `FastPath` object with a
 * `tryLower` the honest model of them. `repeatBodyExpansion` chooses between two BODY PROVIDERS
 * woven through one recursive-CTE construction; there is no separable artifact to return, and giving
 * it a `tryLower` that lowers nothing would model it falsely just to satisfy a registry.
 *
 * So the registry stays TOTAL over the flags — every flag is either an object or listed here, and
 * `test/compiler/fast-paths.exec.test.ts` checks that cover — and an entry here still owes the same
 * `equivalentWhen` the object form owes. What it cannot owe is a `tryLower`, and saying so in one
 * declared place is better than a flag quietly absent from the completeness check.
 */
export const GATE_ONLY_FAST_PATHS: Readonly<Record<string, string>> = Object.freeze({
  repeatBodyExpansion:
    "test/L5-properties/differential.test.ts — the per-switch sweep; every corpus repeat() body the "
    + 'keyed relation can express, compiled both ways. Its first run found exactly one disagreement '
    + '(known.ts: the walk has no emission order, so a positional consumer after it picks a different '
    + 'window from the same multiset), which is what the switch existed to make visible.',
  propertySeek:
    'test/L5-properties/differential.test.ts — the per-switch sweep, over every corpus and generated '
    + 'traversal whose source carries a valued has(). The equivalence is stronger than a differential '
    + 'usually gets, because the rewrite REUSES the predicate rather than restating it: the lifted '
    + "seek is the EXISTS's own sub-plan minus its correlation conjunct, and the EXISTS stays in the "
    + 'filter, so the two positions decide the surviving rows with one expression. What the sweep is '
    + 'actually watching for is the DISTINCT — a Cardinality.list key holding one value twice would '
    + 'multiply a traverser through the seek and not through the filter — and, as telemetry, the '
    + 'emission-order changes that driving from a different relation legitimately causes.',
});

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
