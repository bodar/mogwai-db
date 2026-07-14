// Seed a reference graph from its canonical GraphSON v3 adjacency file (one vertex
// per line, each with embedded inE/outE), turning it into the same gremlin write
// traversals the modern/crew seeds use — so seeding stays "talk to the graph", works
// identically on Bun and the DO, and preserves the canonical integer ids (a numeric
// T.id writes the rowid directly). Used for the big reference graphs (grateful ~808
// vertices / ~8000 edges, sink) whose data is impractical to hand-author. The file
// lives in the pinned submodule, so this is a dev-only host convenience (never bundled
// into the production worker).
import { readFileSync } from 'node:fs';

/** Unwrap a GraphSON v3 value ({"@type":"g:Int32","@value":5} | "str" | 5) to a JS
 *  primitive. */
function gv(x: any): any {
  if (x !== null && typeof x === 'object' && '@value' in x) return x['@value'];
  return x;
}

/** A JS value → a gremlin literal: numbers bare, strings double-quoted (JSON escaping
 *  handles apostrophes/quotes/backslashes in song titles). */
function lit(v: any): string {
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v)); // valid double-quoted gremlin string literal
}

/** Build the write-traversal seed for a GraphSON v3 file. Vertices first (so every
 *  edge endpoint resolves via V(id)), then edges from each vertex's outE (inE is the
 *  redundant mirror — skipped). One statement per element keeps it simple and lets a
 *  bad line fail loudly; the host runs them sequentially through the normal query path. */
export function graphsonSeed(absPath: string): string[] {
  const lines = readFileSync(absPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const verts: string[] = [];
  const edges: string[] = [];
  for (const line of lines) {
    const v = JSON.parse(line);
    const id = gv(v.id);
    let stmt = `g.addV(${lit(v.label)}).property(T.id,${id})`;
    for (const [key, vals] of Object.entries(v.properties ?? {})) {
      for (const vp of vals as any[]) stmt += `.property(${lit(key)},${lit(gv(vp.value))})`;
    }
    verts.push(stmt);
    for (const [label, es] of Object.entries(v.outE ?? {})) {
      for (const e of es as any[]) {
        let est = `g.V(${id}).addE(${lit(label)}).to(__.V(${gv(e.inV)})).property(T.id,${gv(e.id)})`;
        for (const [key, val] of Object.entries(e.properties ?? {})) est += `.property(${lit(key)},${lit(gv(val))})`;
        edges.push(est);
      }
    }
  }
  return [...verts, ...edges];
}
