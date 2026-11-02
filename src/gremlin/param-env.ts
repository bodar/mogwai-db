import { declaredParamTypes, type TypeNode } from './types.ts';
import { canonicalFloatParams } from './float.ts';

/**
 * THE PARAMETER ENVIRONMENT — a request's user parameters as ONE value: what each one IS (`values`, a
 * Float already on its carrier) and what TYPE it was declared as (`types`, settled by
 * `declaredParamTypes`: the wire's DataType where the channel sent one, the JS value's own otherwise).
 *
 * One value rather than a `params` record with a parallel, optional `paramTypes` beside it, because the
 * optional twin was forgotten at depth: every nested body is re-parsed through `stepChain`, and the
 * re-parses (a `union()` arm, a `local()` body, a strategy's nested criterion) passed `params` alone, so
 * a `Long` parameter written inside a branch was stored — and framed — as the `Int` its JS value spells.
 * With the type inside the env there is nothing separate to forget. A user PARAMETER's type is a
 * first-class IR fact (root `CLAUDE.md`, locked decision 5); this is the one place it is carried.
 */
export interface ParamEnv {
  readonly values: Readonly<Record<string, any>>;
  readonly types: Readonly<Record<string, TypeNode>>;
}

/** The environment of a compile with no user parameters — a param-free analysis, a synthesized body. */
export const NO_PARAMS: ParamEnv = Object.freeze({ values: Object.freeze({}), types: Object.freeze({}) });

/** Build the environment ONCE from what a channel carried: `wireTypes` completed for every parameter it
 *  left untyped (`declaredParamTypes`), then every Float-typed value landed on its carrier
 *  (`canonicalFloatParams`), before anything reads it. */
export function paramEnv(wireParams: Record<string, any>, wireTypes: Record<string, TypeNode> = {}): ParamEnv {
  const types = declaredParamTypes(wireParams, wireTypes);
  return { values: canonicalFloatParams(wireParams, types), types };
}
