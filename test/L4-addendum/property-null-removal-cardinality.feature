Feature: mogwai addendum — property(k, null) removes under EVERY cardinality, and declares nothing

  # `property(k, null)` is TinkerPop's removal rule on a graph that does not declare
  # `supportsNullPropertyValues`, which ours does not: every property under `k` goes.
  # `ElementHelper.attachProperties` removes BEFORE it resolves a cardinality, which has two
  # consequences the existing `property-null-removal.feature` does not reach:
  #
  #  1. The removal is UNCONDITIONAL. A `list` key with three values loses all three — it is not a
  #     `single` write that happens to displace one row.
  #  2. `property(Cardinality.single, k, null)` writes NO cardinality declaration. A route that
  #     resolved the cardinality first would leave a `single` declaration behind, and the next
  #     undeclared write to that key would then REPLACE instead of appending — a wrong answer one
  #     traversal later, with nothing wrong at the point of the mistake.
  #
  # The second is why this is pinned rather than assumed: the declaration table is invisible to every
  # assertion about the property itself, so the defect only shows up in a LATER write.

  @gap:property-null-removal-cardinality
  Scenario: g_V_property_null_removes_every_value_of_a_list_key
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").
        property(Cardinality.list, "t", 1).
        property(Cardinality.list, "t", 2).
        property(Cardinality.list, "t", 3)
      """
    And the traversal of
      """
      g.V().property("t", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties(\"t\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\")"

  @gap:property-null-removal-cardinality
  Scenario: g_V_propertyXsingle_k_nullX_removes_without_declaring
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").property("age", 29)
      """
    And the traversal of
      """
      g.V().property(Cardinality.single, "age", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties(\"age\")"

  # THE PROBE for "and declared nothing", as its own scenario rather than a write hidden inside a
  # graph-check: the removal runs in the INITIALIZER, then two undeclared writes. With no declaration
  # left behind the graph default (list) applies and both values APPEND, so a count of 2 is what says
  # the `single` did not survive. One value here would mean it had.
  @gap:property-null-removal-cardinality
  Scenario: g_V_undeclared_writes_after_a_null_removal_append
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").property("age", 29).
        property(Cardinality.single, "age", null)
      """
    And the traversal of
      """
      g.V().property("age", 30).property("age", 31)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().properties(\"age\")"

  # An EDGE property, whose table has no cardinality at all — the same removal reaching a different
  # side table, so a route that hardcoded the vertex one is visible here.
  @gap:property-null-removal-cardinality
  Scenario: g_E_property_null_removes_the_edge_property
    Given the empty graph
    And the graph initializer of
      """
      g.addV("a").as("x").addV("b").as("y").addE("k").from("x").to("y").property("w", 0.5d)
      """
    And the traversal of
      """
      g.E().property("w", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.E().properties(\"w\")"
    And the graph should return 1 for count of "g.E()"

  # A removal on an element the SAME traversal just created: the run of property() steps shares one
  # target, so the null must delete what the step before it wrote rather than being reordered around it.
  @gap:property-null-removal-cardinality
  Scenario: g_addV_property_then_null_in_one_run
    Given the empty graph
    And the traversal of
      """
      g.addV("person").property("name", "josh").property("age", 32).property("age", null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"josh\")"
    And the graph should return 0 for count of "g.V().properties(\"age\")"
