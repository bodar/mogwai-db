// The canonical TinkerPop "crew" graph (TinkerFactory.generateTheCrew) — the
// multi/meta-property showcase: `location` is a list-cardinality property whose each
// value carries startTime[/endTime] meta-properties. Element ids match the official
// scenarios. Seeded via gremlin through the query path (see seed-modern.ts):
// `property(Cardinality.list, k, v, mk, mv, …)` appends one list value with meta.
export const CREW_SEED: string[] = [
  "g.addV('person').property(T.id,1).property('name','marko')" +
    ".property(Cardinality.list,'location','san diego','startTime',1997,'endTime',2001)" +
    ".property(Cardinality.list,'location','santa cruz','startTime',2001,'endTime',2004)" +
    ".property(Cardinality.list,'location','brussels','startTime',2004,'endTime',2005)" +
    ".property(Cardinality.list,'location','santa fe','startTime',2005)",
  "g.addV('person').property(T.id,7).property('name','stephen')" +
    ".property(Cardinality.list,'location','centreville','startTime',1990,'endTime',2000)" +
    ".property(Cardinality.list,'location','dulles','startTime',2000,'endTime',2006)" +
    ".property(Cardinality.list,'location','purcellville','startTime',2006)",
  "g.addV('person').property(T.id,8).property('name','matthias')" +
    ".property(Cardinality.list,'location','bremen','startTime',2004,'endTime',2007)" +
    ".property(Cardinality.list,'location','baltimore','startTime',2007,'endTime',2011)" +
    ".property(Cardinality.list,'location','oakland','startTime',2011,'endTime',2014)" +
    ".property(Cardinality.list,'location','seattle','startTime',2014)",
  "g.addV('person').property(T.id,9).property('name','daniel')" +
    ".property(Cardinality.list,'location','spremberg','startTime',1982,'endTime',2005)" +
    ".property(Cardinality.list,'location','kaiserslautern','startTime',2005,'endTime',2009)" +
    ".property(Cardinality.list,'location','aachen','startTime',2009)",
  "g.addV('software').property(T.id,10).property('name','gremlin')",
  "g.addV('software').property(T.id,11).property('name','tinkergraph')",
  "g.V(1).addE('develops').to(__.V(10)).property(T.id,13).property('since',2009)",
  "g.V(1).addE('develops').to(__.V(11)).property(T.id,14).property('since',2010)",
  "g.V(1).addE('uses').to(__.V(10)).property(T.id,15).property('skill',4)",
  "g.V(1).addE('uses').to(__.V(11)).property(T.id,16).property('skill',5)",
  "g.V(7).addE('develops').to(__.V(10)).property(T.id,17).property('since',2010)",
  "g.V(7).addE('develops').to(__.V(11)).property(T.id,18).property('since',2011)",
  "g.V(7).addE('uses').to(__.V(10)).property(T.id,19).property('skill',5)",
  "g.V(7).addE('uses').to(__.V(11)).property(T.id,20).property('skill',4)",
  "g.V(8).addE('develops').to(__.V(10)).property(T.id,21).property('since',2012)",
  "g.V(8).addE('uses').to(__.V(10)).property(T.id,22).property('skill',3)",
  "g.V(8).addE('uses').to(__.V(11)).property(T.id,23).property('skill',3)",
  "g.V(9).addE('uses').to(__.V(10)).property(T.id,24).property('skill',5)",
  "g.V(9).addE('uses').to(__.V(11)).property(T.id,25).property('skill',3)",
  "g.V(10).addE('traverses').to(__.V(11)).property(T.id,26)",
];
