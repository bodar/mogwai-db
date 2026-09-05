Feature: mogwai addendum — a traversal-valued property() yields EVERY result, and the cardinality decides

  # `AddPropertyStep.handleTraversalValue` collects ALL results of a traversal-valued property() and
  # then branches on the effective cardinality: list/set apply one mutation per result, `single`
  # rejects more than one outright, and an EMPTY result skips the mutation entirely (no property, not
  # a null). A non-Vertex element has no cardinality at all, so an edge falls through to the first
  # result. We used to take the first result in every case, which is right only for `single`.
  #
  # The official corpus reaches the list and single arms; the set arm, the empty arm and the edge
  # fall-through are unpinned upstream, and each is a separate branch here.

  @gap:property-traversal-multivalue
  Scenario: g_VX1X_propertyXlist_friends_outXknowsX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.list, "friends", __.out("knows").values("name"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V(1).properties(\"friends\")"
    And the graph should return 1 for count of "g.V(1).has(\"friends\",\"vadas\").has(\"friends\",\"josh\")"

  # set dedups by value, so a traversal that yields a repeat stores it once.
  @gap:property-traversal-multivalue
  Scenario: g_VX1X_propertyXset_langs_bothXcreatedX_valuesXlangXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.set, "langs", __.out("created").values("lang"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V(1).properties(\"langs\")"

  # An empty traversal writes NOTHING — distinct from `property(k, null)`, which removes, and from
  # storing a null, which this graph never does.
  @gap:property-traversal-multivalue
  Scenario: g_VX1X_propertyXlist_nothing_outXnosuchX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.list, "nothing", __.out("nosuch").values("name"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V(1).properties(\"nothing\")"
    And the graph should return 2 for count of "g.V(1).properties()"

  # An EDGE has no cardinality, so a multi-result traversal value takes the first result rather than
  # raising the single-cardinality error a vertex would.
  @gap:property-traversal-multivalue
  @Unsupported
  Scenario: g_EX7X_propertyXnames_outV_bothXknowsX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.E(7).property("names", __.outV().out("knows").values("name"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.E(7).properties(\"names\")"
