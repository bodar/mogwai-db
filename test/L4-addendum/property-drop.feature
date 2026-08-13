Feature: mogwai addendum — drop() over a property stream removes property rows, not elements

  # `g.V().properties().drop()` leaves every vertex standing and removes their properties. Because
  # the prefix compiles through the ordinary read spine, every filter a property stream admits
  # narrows the drop for free — which is the part worth pinning, since none of it is a case in the
  # drop compiler.
  #
  # The official corpus covers the bare vertex and edge forms. A FILTERED property drop, and the fact
  # that the elements survive it, are unpinned upstream.

  @gap:property-drop
  Scenario: g_V_propertiesXnameX_hasValue_drop
    Given the modern graph
    And the traversal of
      """
      g.V().properties("name").hasValue("marko").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 6 for count of "g.V()"
    And the graph should return 11 for count of "g.V().properties()"
    And the graph should return 0 for count of "g.V().has(\"name\",\"marko\")"

  # A key argument narrows it the same way, and the OTHER keys survive.
  @gap:property-drop
  Scenario: g_V_hasLabelXpersonX_propertiesXageX_drop
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").properties("age").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 0 for count of "g.V().properties(\"age\")"
    And the graph should return 6 for count of "g.V().properties(\"name\")"
    And the graph should return 6 for count of "g.V()"

  # An edge property is addressed by (edge, key) rather than by a row id — TinkerPop's edge
  # `Property` has no id — so the edge form is its own delete and gets its own pin.
  @gap:property-drop
  Scenario: g_E_hasLabelXcreatedX_properties_drop
    Given the modern graph
    And the traversal of
      """
      g.E().hasLabel("created").properties().drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 2 for count of "g.E().properties()"
    And the graph should return 6 for count of "g.E()"

  # A meta-property drop is a key inside the owning property's bag rather than a row, and the
  # metaProperty stream does not project its owner — so it fails CLOSED rather than dropping the
  # wrong thing. Pinned so the refusal cannot quietly become a wrong answer.
  @gap:property-drop
  @Unsupported
  Scenario: g_V_properties_propertiesXstartTimeX_drop_is_deferred
    Given the modern graph
    And the traversal of
      """
      g.V().properties().properties("startTime").drop()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "meta-property"
