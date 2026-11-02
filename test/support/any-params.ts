import type { ParamEnv } from '../../src/gremlin/param-env.ts';

/** A parameter environment that binds EVERY name to `null` — for a test that walks a corpus or a
 *  generator's output for its step SHAPE and does not care what any `$x` resolves to. The front end
 *  asks `Object.hasOwn(values, name)`, so the proxy answers the own-property trap, not just `has`. */
export const anyParams = (): ParamEnv => ({
  values: new Proxy({}, {
    has: () => true,
    get: () => null,
    getOwnPropertyDescriptor: () => ({ value: null, writable: true, enumerable: true, configurable: true }),
  }),
  types: {},
});
