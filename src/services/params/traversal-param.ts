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
// The visitor emits an ANONYMOUS traversal (`__.V().out(...)`). Two kinds of consumer read the result
// and they want different shapes, so this renders each faithfully and lets the CONSUMER validate:
//   · a SOURCE-ROOTED body (`__.V()…`/`__.E()…`) → a rooted `g.V()…` string. `federate` runs it as a
//     fresh source query on a sibling (a different DO's rowids mean nothing there), so it REQUIRES this
//     rooted form — and now enforces that itself (`federate.ts` `traversalOf`), the one consumer that
//     needs it. Swapping the leading `__` for `g` produces the rooted form exactly.
//   · an ANONYMOUS body (`__.outE("knows")`) → returned verbatim. An OLAP edge scope
//     (`~tinkerpop.<algo>.edges`) is inherently anonymous (a per-vertex adjacency traversal, never
//     source-rooted); the algorithm service reads it back to a `{direction, labels}` descriptor. This
//     is why the rooted check moved OUT of here: it is federate's need, not a property of carrying a
//     sub-traversal, and refusing anonymous here walled every OLAP edge scope.

// @ts-ignore - deep import, no shipped type declarations for this subpath
import { Translator } from '../../../node_modules/gremlin/build/esm/language/index.js';

/** Render a parsed nested traversal (an antlr NestedTraversalContext) to a canonical Gremlin string:
 *  a source-rooted body to `g.V()…`, an anonymous body to its `__.…` form verbatim. Never throws on
 *  shape — the consumer decides what it accepts (federate requires rooted; an OLAP edge scope reads the
 *  anonymous form). Bound params ride the caller's own `params` channel (the visitor preserves xxN
 *  variable references verbatim). */
export function nestedTraversalToGremlin(nested: any): string {
  const v = Translator.CANONICAL('g');
  v.visit(nested);
  const anon = v.getTranslated() as string; // e.g. __.V().out("knows") or __.outE("knows")
  return anon.startsWith('__.V(') || anon.startsWith('__.E(')
    ? 'g' + anon.slice(2)  // __.V()… -> g.V()… (the rooted form federate needs)
    : anon;                // an anonymous body (an OLAP edge scope) travels verbatim
}
