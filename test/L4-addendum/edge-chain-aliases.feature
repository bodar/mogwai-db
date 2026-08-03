Feature: mogwai addendum — a SECOND addE() reads the labels the first one carried

  # The corpus's dominant write shape is a seeder: N `addV()`s each binding an `as()`, then N `addE()`s
  # reading those labels. Every one of them exercises two properties the official scenarios only ever
  # assert the END STATE of, so a route that got either wrong still builds the right graph for a
  # one-edge chain and the wrong one from the second edge on.
  #
  #  1. An `addE()` CARRIES its INPUT's aliases. Its own output is an edge stream, and the labels bound
  #     over the vertices before it are still live — so the next `addE().from("a")` must find them.
  #  2. An input whose element kind is EDGE is legal as long as both ends are named. An implicit end is
  #     the incoming traverser, so an edge stream would be one for neither side; with both named the
  #     input is only a multiplier and its kind does not matter.
  #
  # Pinned here because the official seeders are graph INITIALIZERS: when one is wrong the scenario
  # using it fails for a reason that names the traversal under test, never the seeder. These assert the
  # seeder itself.

  @gap:edge-chain-aliases
  Scenario: g_addV_addV_addE_addE_second_edge_reads_the_same_labels
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name","marko").as("a").
        addV("person").property("name","vadas").as("b").
        addE("knows").from("a").to("b").property("weight", 0.5d).
        addE("likes").from("a").to("b").property("weight", 1.0d)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V()"
    And the graph should return 2 for count of "g.E()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").outE(\"knows\").inV().has(\"name\",\"vadas\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").outE(\"likes\").inV().has(\"name\",\"vadas\")"

  # The REVERSED second edge, because a carry that produced the right pair by accident of both labels
  # holding the same row would pass the scenario above and fail this one.
  @gap:edge-chain-aliases
  Scenario: g_addV_addV_addE_addE_reversed_endpoints
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name","marko").as("a").
        addV("person").property("name","vadas").as("b").
        addE("knows").from("a").to("b").
        addE("knows").from("b").to("a")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.E()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").out(\"knows\").has(\"name\",\"vadas\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"vadas\").out(\"knows\").has(\"name\",\"marko\")"

  # THE SEEDER ITSELF, whole — six vertices, six edges, three labels bound and read across the join.
  # This is the modern reference graph's own initializer, asserted as a traversal rather than trusted as
  # setup.
  @gap:edge-chain-aliases
  Scenario: g_modern_graph_seeder_builds_the_reference_graph
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name","marko").property("age",29).as("marko").
        addV("person").property("name","vadas").property("age",27).as("vadas").
        addV("software").property("name","lop").property("lang","java").as("lop").
        addV("person").property("name","josh").property("age",32).as("josh").
        addV("software").property("name","ripple").property("lang","java").as("ripple").
        addV("person").property("name","peter").property("age",35).as("peter").
        addE("knows").from("marko").to("vadas").property("weight",0.5d).
        addE("knows").from("marko").to("josh").property("weight",1.0d).
        addE("created").from("marko").to("lop").property("weight",0.4d).
        addE("created").from("josh").to("ripple").property("weight",1.0d).
        addE("created").from("josh").to("lop").property("weight",0.4d).
        addE("created").from("peter").to("lop").property("weight",0.2d)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 6 for count of "g.V()"
    And the graph should return 6 for count of "g.E()"
    And the graph should return 2 for count of "g.V().has(\"name\",\"marko\").out(\"knows\")"
    And the graph should return 2 for count of "g.V().has(\"name\",\"josh\").out(\"created\")"
    And the graph should return 3 for count of "g.V().has(\"name\",\"lop\").in(\"created\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").outE(\"created\").has(\"weight\",0.4d)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"peter\").outE(\"created\").has(\"weight\",0.2d)"

  # A SELF edge repeated: one label, both ends, six times. The input of each `addE` after the first is
  # the previous edge, so this is the edge-kind input with both ends named — the case the kind check
  # used to refuse outright.
  @gap:edge-chain-aliases
  Scenario: g_addV_repeated_self_addE_over_an_edge_input
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name","alice").as("a").
        addE("self").from("a").to("a").property("weight", 0.5d).
        addE("self").from("a").to("a").property("weight", 1.0d).
        addE("self").from("a").to("a").property("weight", 0.4d)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V()"
    And the graph should return 3 for count of "g.E()"
    And the graph should return 3 for count of "g.V().has(\"name\",\"alice\").outE(\"self\")"
    And the graph should return 1 for count of "g.E().has(\"weight\", 0.5d)"
    And the graph should return 1 for count of "g.E().has(\"weight\", 1.0d)"
    And the graph should return 1 for count of "g.E().has(\"weight\", 0.4d)"
