/** Independently switchable optimized lowerings. The generic path remains the
 * semantic authority; these switches exist for equivalence tests and diagnostics. */
export interface FastPathConfig {
  readonly predicateInlining: boolean;
  readonly singleHopOptional: boolean;
  readonly bulkRepeatCount: boolean;
}

export interface CompileOptions {
  readonly fastPaths?: Partial<FastPathConfig>;
}

export const DEFAULT_FAST_PATHS: FastPathConfig = Object.freeze({
  predicateInlining: true,
  singleHopOptional: true,
  bulkRepeatCount: true,
});

export const resolveFastPaths = (options?: CompileOptions): FastPathConfig => ({
  ...DEFAULT_FAST_PATHS,
  ...options?.fastPaths,
});
