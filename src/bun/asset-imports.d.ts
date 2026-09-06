// A `with { type: 'file' }` import (Bun's file loader) evaluates to the asset's on-disk PATH — a string —
// at runtime, but tsc has no notion of that import attribute and would otherwise resolve the `.js` module
// itself and flag it implicit-`any` (TS7016). Declare the shape here: the embedded Scalar standalone (see
// BunAssetStore.ts) imports as a default-exported string path.
declare module '*/standalone.js' {
  const path: string;
  export default path;
}
