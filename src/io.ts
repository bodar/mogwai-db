// Reuse the Apache-2.0 GraphBinary serializers shipped in the gremlin client
// package (locked decision #4 — we never write serializers). These live at a
// deep path the package's `exports` map doesn't expose, so we import by
// RELATIVE path rather than a bare specifier: `exports` only gates bare
// specifiers, so this resolves in Bun and — crucially — is followed and
// bundled by wrangler/esbuild for the Worker build. Both runtimes share this
// one module; there is no per-runtime divergence in the io layer.
//
// TODO(upstream): filed apache/tinkerpop#3511 to add a `gremlin/io` export.
// Once released, switch to `import ioc from 'gremlin/io'` and drop the
// node_modules path.

// @ts-ignore - deep import, no shipped type declarations for this subpath
import ioc from '../node_modules/gremlin/build/esm/structure/io/binary/GraphBinary.js';
// @ts-ignore - deep import, no shipped type declarations for this subpath
import { Vertex, VertexProperty, Edge } from '../node_modules/gremlin/build/esm/structure/graph.js';

export { ioc, Vertex, VertexProperty, Edge };
