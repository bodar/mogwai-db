// ---------- serializing a nested-traversal call() param back to Gremlin ----------
//
// A federated call() carries its sub-traversal as a nested __.-traversal PARAM VALUE
// (`call("mogwai.graph.federate", {graph:'orders', traversal: __.V().out('placed')})`). To run
// it on the sibling graph we hand it to the existing string-based data-plane seam
// (query(id, gremlin, params)), so the nested traversal must become a canonical Gremlin STRING.
//
// We do NOT hand-roll an un-parser: the gremlin client (a dependency already, locked decision
// #4 reuse-first) ships a grammar-complete parse-tree -> canonical-Gremlin visitor
// (Translator.CANONICAL, in the `gremlin/language` package). It consumes the SAME antlr4ng +
// Gremlin.g4 nodes our own parser produces, so we feed it the parsed NestedTraversalContext we
// already hold — no new grammar knowledge to maintain, no drift as steps are added. Reused by
// deep RELATIVE import for the same reason io.ts does (the package `exports` map doesn't expose
// the subpath in a way wrangler/esbuild follows for the Worker bundle; a bare specifier would).
//
// The visitor emits an ANONYMOUS traversal (`__.V().out(...)`). A federated call always runs as
// a fresh SOURCE query on the sibling (a different DO's rowids mean nothing here — see the
// prior-art doc's "no cross-DO edge traversal"), so we need a ROOTED `g.`-traversal. Swapping
// the leading `__` for `g` produces exactly that WHEN the sub-traversal is rooted (starts with
// V()/E()); an unrooted anonymous body (`__.out(...)`) would swap to invalid `g.out(...)`, so we
// require rootedness and fail closed otherwise (never guess a source to prepend).

// @ts-ignore - deep import, no shipped type declarations for this subpath
import { Translator } from '../../node_modules/gremlin/build/esm/language/index.js';

/** Render a parsed nested traversal (an antlr NestedTraversalContext) to a canonical, ROOTED
 *  Gremlin string suitable for the sibling's query(gremlin) seam. Throws a clear deferral if
 *  the sub-traversal is not source-rooted (V()/E()). Returns the string; bound params ride the
 *  caller's own `params` channel (the visitor preserves xxN variable references verbatim). */
export function nestedTraversalToGremlin(nested: any): string {
  const v = Translator.CANONICAL('g');
  v.visit(nested);
  const anon = v.getTranslated() as string; // e.g. __.V().out("knows")
  if (!anon.startsWith('__.V(') && !anon.startsWith('__.E('))
    throw new Error(`federated traversal must be source-rooted (start with V() or E()), got: ${anon.replace(/^__\./, '')}`);
  return 'g' + anon.slice(2); // __.V()... -> g.V()...
}
