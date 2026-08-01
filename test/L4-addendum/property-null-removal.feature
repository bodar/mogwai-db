Feature: mogwai addendum — a null property value REMOVES the property

  # TinkerPop's rule for a graph that does not declare `supportsNullPropertyValues` — ours does not:
  # `property(k, null)` removes every property under k rather than storing a null. The authority is
  # ElementHelper.attachProperties (gremlin-core), which spells it identically in all three
  # overloads. The official corpus reaches this only through AddEdge.feature's
  # g_V_outE_propertyXweight_nullX; the other hosts (vertex property(), a merge option map, a
  # cardinality-carrying property()) are unpinned upstream, and each is a separate call site here.
  #
  # The @AllowNullPropertyValues scenarios describe the OTHER provider choice (store the null) and
  # are runner-skipped, so they are not the contradiction they look like.

  @gap:property-null-removal
  Scenario: g_V_hasLabelXpersonX_propertyXname_nullX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").property("name", null)
      """
    When iterated to list
    Then the result should have a count of 4
    And the graph should return 2 for count of "g.V().properties(\"name\")"
    And the graph should return 2 for count of "g.V().has(\"lang\",\"java\").values(\"name\")"

  @gap:property-null-removal
  Scenario: g_V_outE_propertyXweight_nullX
    Given the modern graph
    And the traversal of
      """
      g.V().outE().property("weight", null)
      """
    When iterated to list
    Then the result should have a count of 6
    And the graph should return 0 for count of "g.E().properties(\"weight\")"

  # Removal is cardinality-independent: the reference removes EVERY property under the key, so a
  # list-cardinality null does not append a null row and does not leave the earlier rows behind.
  @gap:property-null-removal
  Scenario: g_V_propertyXlist_name_nullX_removes_every_value
    Given the empty graph
    And the graph initializer of
      """
      g.addV("animal").property(Cardinality.list, "name", "mateo").property(Cardinality.list, "name", "gateo")
      """
    And the traversal of
      """
      g.V().property(Cardinality.list, "name", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties(\"name\")"

  # A null on a JUST-CREATED element is a removal of nothing, not a stored null — the same rule,
  # reached through addV/addE's creation path rather than through a mutation.
  @gap:property-null-removal
  Scenario: g_addV_propertyXname_nullX
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property("name", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().hasLabel(\"animal\")"

  @gap:property-null-removal
  Scenario: g_mergeE_optionXonMatch_weight_nullX
    Given the modern graph
    And the traversal of
      """
      g.mergeE([T.label: "knows", Direction.from: 1, Direction.to: 2]).option(Merge.onMatch, ["weight": null])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 5 for count of "g.E().properties(\"weight\")"
