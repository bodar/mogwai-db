// The ONE `node:util` export the browser bundle is missing. The core reuses the vendored gremlin
// client's GraphBinary serializers (locked decision 4), and the client's `gremlin-lang.js` imports
// `isDeepStrictEqual` from `node:util` — which Bun's browser `node:util` polyfill does not provide
// (Buffer, the client's only other node builtin, IS polyfilled). The server's Gremlin-string path
// almost never reaches this comparator at runtime (it builds no client-side bytecode), but the bundle
// must still LINK the export, so `browserBundlePlugin` (bundle.ts) aliases `node:util` here.
//
// A faithful structural deep-equal: strict type equality (no coercion), `Object.is` semantics for
// primitives (so `NaN` equals `NaN`), and recursion through Arrays, TypedArrays, Map, Set, Date,
// RegExp, and plain objects by own enumerable keys — the shapes the client compares.

function tag(x: object): string {
  return Object.prototype.toString.call(x);
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;

  const ta = tag(a);
  if (ta !== tag(b)) return false;

  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return a.source === (b as RegExp).source && a.flags === (b as RegExp).flags;

  if (ArrayBuffer.isView(a) || a instanceof ArrayBuffer) {
    const ua = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const ub = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset, (b as ArrayBufferView).byteLength);
    if (ua.byteLength !== ub.byteLength) return false;
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }

  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (!isDeepStrictEqual(a[i], bb[i])) return false;
    return true;
  }

  if (a instanceof Map) {
    const bm = b as Map<unknown, unknown>;
    if (a.size !== bm.size) return false;
    for (const [k, v] of a) {
      if (!bm.has(k)) return false;
      if (!isDeepStrictEqual(v, bm.get(k))) return false;
    }
    return true;
  }

  if (a instanceof Set) {
    const bs = b as Set<unknown>;
    if (a.size !== bs.size) return false;
    for (const v of a) if (!bs.has(v)) return false;
    return true;
  }

  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!isDeepStrictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}
