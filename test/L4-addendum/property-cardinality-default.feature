Feature: mogwai addendum — the default vertex-property cardinality is list, and a declaration sticks

  # TinkerPop asks the graph what cardinality a key takes when `property()` names none
  # (`Graph.Features.VertexFeatures.getCardinality(key)`), and the interface default is `list` — so a
  # repeated undeclared `property(k, v)` APPENDS. We answer it from a per-(node, key) declaration
  # recorded by an explicit `property(Cardinality.x, …)`, falling back to that `list` default; the
  # reasoning, and the two official scenarios that pin it in opposite directions, are in the
  # `vertex_property_cardinality` DDL comment (src/storage.ts).
  #
  # The official corpus reaches the default itself only through @MultiProperties scenarios and the
  # remembered-declaration case only through one AddVertex scenario. Neither pins the interaction,
  # which is where the wrong answers live.

  @gap:property-cardinality-default
  Scenario: g_addV_repeated_undeclared_property_appends
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property("name", "mateo").property("name", "gateo").property("name", "cateo")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 3 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"mateo\").has(\"name\",\"gateo\").has(\"name\",\"cateo\")"

  @gap:property-cardinality-default
  Scenario: g_addV_propertyXsingle_nameX_then_undeclared_replaces
    Given the empty graph
    And the graph initializer of
      """
      g.addV("animal").property(Cardinality.single, "name", "mateo")
      """
    And the traversal of
      """
      g.V().property("name", "gateo")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"gateo\")"

  # The declaration is scoped to the ELEMENT that carries it, not to the key across the graph:
  # declaring `single` on one vertex must not change how an undeclared write behaves on another.
  @gap:property-cardinality-default
  Scenario: g_addV_propertyXsingleX_declaration_is_per_element
    Given the empty graph
    And the graph initializer of
      """
      g.addV("animal").property("id0", 0).property(Cardinality.single, "name", "mateo").
        addV("animal").property("id0", 1).property("name", "gateo")
      """
    And the traversal of
      """
      g.V().property("name", "cateo")
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"id0\",0).properties(\"name\")"
    And the graph should return 2 for count of "g.V().has(\"id0\",1).properties(\"name\")"

  # An explicit cardinality WINS over whatever is recorded, and re-declares for later writes.
  @gap:property-cardinality-default
  Scenario: g_V_explicit_cardinality_overrides_the_declaration
    Given the empty graph
    And the graph initializer of
      """
      g.addV("animal").property(Cardinality.single, "name", "mateo")
      """
    And the traversal of
      """
      g.V().property(Cardinality.list, "name", "gateo").property("name", "cateo")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 3 for count of "g.V().properties(\"name\")"
