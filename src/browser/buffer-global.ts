// Install `Buffer` as an ambient global for the browser, BEFORE any core module that touches it. The
// wire layer uses `Buffer` ambiently (locked decision 4 reuses the client's serializers, and modules
// like http.ts build `Buffer.from(...)` constants at MODULE-INIT time). ESM evaluates imports in source
// order, before the importing module's body — so a body-level `globalThis.Buffer = Buffer` runs too
// late. A browser worker/entry therefore imports THIS module FIRST, so the global is set before http.ts
// / io.ts initialize.
//
// `import { Buffer } from 'buffer'` resolves to Bun's `buffer` browser polyfill in a browser bundle;
// on Bun/Cloudflare Buffer is already a global, so this file is browser-only and never imported there.
import { Buffer } from 'buffer';

(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
