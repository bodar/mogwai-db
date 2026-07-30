// The TinkerPop 4 "zoo" toy graph — the multi-label showcase, with the exact element ids the
// official Gherkin scenarios reference. Same seeding contract as MODERN_SEED: gremlin write
// traversals through the normal query path, a numeric `T.id` writing the integer rowid directly.
//
// TRANSCRIBED BY HAND, and it has to be. The zoo graph ships in the submodule only as
// `tinkerpop-zoo-v3.kryo`, and that file cannot be its source of truth — `LoadGraphWith.GraphData.ZOO`
// says so outright: "none of the serialization formats used to produce a data file for it (Gryo,
// GraphSON) correctly round-trip multi-label vertices yet. It is only usable via a GraphProvider
// that builds the graph directly, e.g. with TinkerFactory.createTheZoo()." So the authority is
// `TinkerFactory.generateTheZoo` (tinkergraph-gremlin), and this file mirrors it statement for
// statement — 13 vertices (ids 1-13), 20 edges (ids 14-33), in that order.
//
// The graph REQUIRES LabelCardinality.ZERO_OR_MORE (or ONE_OR_MORE): ten of its vertices carry
// several labels and `canopy` deliberately carries only the one. Seed it into a store that
// declares a mutable cardinality or the multi-label addV() is refused.
export const ZOO_SEED: string[] = [
  // Animals. Each is `animal` plus the cross-cutting facets that make this graph the multi-label
  // showcase — `tux` is animal + bird + aquatic + endangered, which is not a hierarchy.
  "g.addV('animal','bird','aquatic','endangered').property(T.id,1).property('name','tux')"
    + ".property('species','african penguin').property('weight',3.7d).property('age',5)"
    + ".property('captiveBorn',true)"
    + ".property(Cardinality.list,'diet','fish').property(Cardinality.list,'diet','krill').property(Cardinality.list,'diet','squid')",
  "g.addV('animal','reptile','aquatic','endangered').property(T.id,2).property('name','atlas')"
    + ".property('species','green sea turtle').property('weight',180.5d).property('age',30)"
    + ".property('captiveBorn',false)"
    + ".property(Cardinality.list,'diet','seagrass').property(Cardinality.list,'diet','algae')",
  "g.addV('animal','mammal','aquatic').property(T.id,3).property('name','ripple')"
    + ".property('species','bottlenose dolphin').property('weight',220.0d).property('age',12)"
    + ".property('captiveBorn',true)"
    + ".property(Cardinality.list,'diet','fish').property(Cardinality.list,'diet','squid')",
  "g.addV('animal','reptile','nocturnal').property(T.id,4).property('name','monty')"
    + ".property('species','ball python').property('weight',1.8d).property('age',8)"
    + ".property('captiveBorn',true).property('venomous',false)"
    + ".property(Cardinality.list,'diet','mice').property(Cardinality.list,'diet','rats')",
  "g.addV('animal','mammal','flying','nocturnal').property(T.id,5).property('name','echo')"
    + ".property('species','fruit bat').property('weight',0.3d).property('age',3)"
    + ".property('captiveBorn',true)"
    + ".property(Cardinality.list,'diet','fruit').property(Cardinality.list,'diet','nectar')",
  "g.addV('animal','mammal','endangered','nocturnal').property(T.id,6).property('name','blaze')"
    + ".property('species','red panda').property('weight',5.4d).property('age',4)"
    + ".property('captiveBorn',false)"
    + ".property(Cardinality.list,'diet','bamboo').property(Cardinality.list,'diet','fruit').property(Cardinality.list,'diet','insects')",
  "g.addV('animal','mammal','endangered').property(T.id,7).property('name','titan')"
    + ".property('species','african elephant').property('weight',4000.0d).property('age',15)"
    + ".property('captiveBorn',false)"
    + ".property(Cardinality.list,'diet','grass').property(Cardinality.list,'diet','leaves').property(Cardinality.list,'diet','bark')",
  "g.addV('animal','mammal','nocturnal').property(T.id,8).property('name','bitsy')"
    + ".property('species','harvest mouse').property('weight',0.006d).property('age',1)"
    + ".property('captiveBorn',true)"
    + ".property(Cardinality.list,'diet','seeds').property(Cardinality.list,'diet','insects')",
  "g.addV('animal','mammal','aquatic','nocturnal','endangered').property(T.id,9).property('name','splash')"
    + ".property('species','fishing cat').property('weight',8.2d).property('age',2)"
    + ".property('captiveBorn',false)"
    + ".property(Cardinality.list,'diet','fish').property(Cardinality.list,'diet','frogs').property(Cardinality.list,'diet','crustaceans')",
  "g.addV('animal','mammal','nocturnal','endangered').property(T.id,10).property('name','tinker')"
    + ".property('species','bengal tiger').property('weight',220.0d).property('age',5)"
    + ".property('captiveBorn',false)"
    + ".property(Cardinality.list,'diet','deer').property(Cardinality.list,'diet','boar').property(Cardinality.list,'diet','snakes')",
  // Habitats. `canopy` carries ONE label where `lagoon` carries two — the single-label case
  // living inside a multi-label graph, which several scenarios lean on.
  "g.addV('habitat','aquatic').property(T.id,11).property('name','lagoon')"
    + ".property('biome','marine').property('capacity',8).property('openAir',true)",
  "g.addV('habitat').property(T.id,12).property('name','canopy')"
    + ".property('biome','tropical').property('capacity',8).property('openAir',false)",
  // People.
  "g.addV('person','veterinarian','keeper').property(T.id,13).property('name','dr_gremlin').property('since',2015)"
    + ".property(Cardinality.list,'specialties','conservation').property(Cardinality.list,'specialties','surgery')"
    + ".property(Cardinality.list,'specialties','nutrition')",
  // livesIn
  "g.V(1).addE('livesIn').to(__.V(11)).property(T.id,14).property('since',2020)",
  "g.V(2).addE('livesIn').to(__.V(11)).property(T.id,15).property('since',2018)",
  "g.V(3).addE('livesIn').to(__.V(11)).property(T.id,16).property('since',2019)",
  "g.V(9).addE('livesIn').to(__.V(11)).property(T.id,17).property('since',2023)",
  "g.V(4).addE('livesIn').to(__.V(12)).property(T.id,18).property('since',2021)",
  "g.V(5).addE('livesIn').to(__.V(12)).property(T.id,19).property('since',2022)",
  "g.V(6).addE('livesIn').to(__.V(12)).property(T.id,20).property('since',2023)",
  "g.V(8).addE('livesIn').to(__.V(12)).property(T.id,21).property('since',2024)",
  "g.V(10).addE('livesIn').to(__.V(12)).property(T.id,22).property('since',2020)",
  "g.V(7).addE('livesIn').to(__.V(12)).property(T.id,23).property('since',2019)",
  // careFor
  "g.V(13).addE('careFor').to(__.V(2)).property(T.id,24).property('specialty','conservation')",
  "g.V(13).addE('careFor').to(__.V(6)).property(T.id,25).property('specialty','conservation')",
  "g.V(13).addE('careFor').to(__.V(9)).property(T.id,26).property('specialty','conservation')",
  "g.V(13).addE('careFor').to(__.V(10)).property(T.id,27).property('specialty','conservation')",
  // friendsWith
  "g.V(1).addE('friendsWith').to(__.V(2)).property(T.id,28).property('since',2020)",
  "g.V(3).addE('friendsWith').to(__.V(1)).property(T.id,29).property('since',2020)",
  "g.V(7).addE('friendsWith').to(__.V(6)).property(T.id,30).property('since',2022)",
  // eats — the food chain tinker → monty → bitsy
  "g.V(10).addE('eats').to(__.V(4)).property(T.id,31)",
  "g.V(4).addE('eats').to(__.V(8)).property(T.id,32)",
  // avoids
  "g.V(5).addE('avoids').to(__.V(8)).property(T.id,33)",
];
