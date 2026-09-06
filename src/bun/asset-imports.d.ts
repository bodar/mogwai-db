// A `with { type: 'file' }` import (Bun's file loader) evaluates to the asset's on-disk PATH — a string —
// at runtime, but tsc has no notion of that import attribute and would otherwise resolve the module itself
// and flag it implicit-`any` (TS7016). Declare the shape here: every embedded asset (see BunAssetStore.ts —
// the Scalar standalone, plus the committed favicon + logo) imports as a default-exported string path.
declare module '*/standalone.js' {
  const path: string;
  export default path;
}
declare module '*.ico' {
  const path: string;
  export default path;
}
declare module '*.png' {
  const path: string;
  export default path;
}
// The `/examples/` reference-graph datasets, binary-embedded the same way (BunAssetStore.ts). The staged
// copies carry a `.graphson` extension precisely so this ambient wins: they are newline-delimited GraphSON,
// and a `.json` import would instead hit tsc's `resolveJsonModule` loader (which parses the file as a single
// JSON document and chokes on the JSONL) rather than resolving to a file-path string. See
// scripts/copy-examples.ts for why the served name stays `.json` while the embed source is `.graphson`.
declare module '*.graphson' {
  const path: string;
  export default path;
}
