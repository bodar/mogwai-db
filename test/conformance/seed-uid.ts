// A tiny graph with USER-SUPPLIED string ids, to exercise UserSuppliedIds
// end-to-end. A STRING `T.id` writes the `uid` column (write.ts insertRow); rowids
// stay the internal PKs. "alice"/"bob"/"e1" are the outward-facing ids the client
// sees — proving read-path edge endpoints report the external id, like the write path.
// Seeded via gremlin through the query path (see seed-modern.ts).
export const UID_SEED: string[] = [
  "g.addV('person').property(T.id,'alice').property('name','alice')",
  "g.addV('person').property(T.id,'bob').property('name','bob')",
  "g.V('alice').addE('knows').to(__.V('bob')).property(T.id,'e1').property('weight',0.5)",
];
