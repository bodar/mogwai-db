// The canonical TinkerPop "modern" graph, with the exact element ids the official
// Gherkin scenarios reference. Seeded by running gremlin write traversals through
// the normal query path (identical on Bun and Cloudflare — a graph is seeded by
// talking to it, no runtime-specific store hook). A NUMERIC `T.id` writes the
// integer rowid directly (write.ts insertRow), so ids 1–6 / 7–12 land exactly as
// the reference graph; edge `from` defaults to the V()-rooted incoming vertex.
export const MODERN_SEED: string[] = [
  "g.addV('person').property(T.id,1).property('name','marko').property('age',29)",
  "g.addV('person').property(T.id,2).property('name','vadas').property('age',27)",
  "g.addV('software').property(T.id,3).property('name','lop').property('lang','java')",
  "g.addV('person').property(T.id,4).property('name','josh').property('age',32)",
  "g.addV('software').property(T.id,5).property('name','ripple').property('lang','java')",
  "g.addV('person').property(T.id,6).property('name','peter').property('age',35)",
  "g.V(1).addE('knows').to(__.V(2)).property(T.id,7).property('weight',0.5)",
  "g.V(1).addE('knows').to(__.V(4)).property(T.id,8).property('weight',1.0)",
  "g.V(1).addE('created').to(__.V(3)).property(T.id,9).property('weight',0.4)",
  "g.V(4).addE('created').to(__.V(5)).property(T.id,10).property('weight',1.0)",
  "g.V(4).addE('created').to(__.V(3)).property(T.id,11).property('weight',0.4)",
  "g.V(6).addE('created').to(__.V(3)).property(T.id,12).property('weight',0.2)",
];
