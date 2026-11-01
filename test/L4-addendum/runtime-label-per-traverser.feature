Feature: mogwai addendum — a computed label resolves PER TRAVERSER

  # `addV(<traversal>)` / `addE(<traversal>)` resolve the label against the traverser the creation
  # consumes — `TraversalUtil.apply(traverser, label)` in `AddVertexStep.map`
  # (`step/map/AddVertexStep.java:140-162`), `Parameters.get(traverser, T.label, …)` in `AddEdgeStep`
  # — exactly as a folded `property()` parameter does. So each traverser gets ITS OWN label, and the
  # reference's checks on the resolved value raise before anything is written. Every label resolves
  # against the pre-write snapshot (matrix §17 "Write visibility").

  @gap:runtime-label
  Scenario: g_V_hasLabelXpersonX_addVXvaluesXnameXX_label
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").addV(__.values("name")).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
    And the graph should return 1 for count of "g.V().hasLabel(\"vadas\")"

  @gap:runtime-label
  Scenario: g_V_asXaX_outXcreatedX_addVXselectXaX_valuesXnameXX_label
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out("created").addV(__.select("a").values("name")).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | josh |
      | peter |

  # Each new element keeps the traverser that made it: the label and the carried alias agree.
  @gap:runtime-label
  Scenario: g_V_hasLabelXpersonX_asXpX_addEXvaluesXnameXX_toXlopX_projectXl_pX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").as("p").addE(__.values("name")).to(__.V().has("name", "lop")).project("l", "p").by(T.label).by(__.select("p").values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"l":"marko","p":"marko"}] |
      | m[{"l":"vadas","p":"vadas"}] |
      | m[{"l":"josh","p":"josh"}] |
      | m[{"l":"peter","p":"peter"}] |

  @gap:runtime-label
  Scenario: g_V_hasXname_markoX_addVXvaluesXnameX_labelX_labels
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").addV(__.values("name"), __.label()).labels()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | person |

  @gap:runtime-label
  Scenario: g_addVXV_hasXname_markoX_labelX_label
    Given the modern graph
    And the traversal of
      """
      g.addV(__.V().has("name", "marko").label()).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person |

  # The reference casts the resolved label to String and creates nothing; storing the number as the
  # text "29" would be an element the reference never writes.
  @gap:runtime-label
  Scenario: g_V_hasXname_markoX_addVXvaluesXageXX_error
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").addV(__.values("age"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Label traversal must produce a String"

  @gap:runtime-label
  Scenario: g_V_addVXvaluesXlangXX_error
    Given the modern graph
    And the traversal of
      """
      g.V().addV(__.values("lang"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The provided traverser does not map to a value"

  @gap:runtime-label
  Scenario: g_addVXconstantXemptyXX_error
    Given the empty graph
    And the traversal of
      """
      g.addV(__.constant(""))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Label can not be empty"

  @gap:runtime-label
  Scenario: g_V_hasXname_vadasX_addLabelXvaluesXnameXX_labels
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "vadas").addLabel(__.values("name")).labels()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person |
      | vadas |

  @gap:runtime-label
  Scenario: g_V_hasXname_markoX_addLabelXvaluesXageXX_error
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").addLabel(__.values("age"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Traversal argument must produce a String or Collection<String>"

  @gap:runtime-label
  Scenario: g_V_addLabelXvaluesXlangXX_error_when_some_traversers_have_none
    Given the modern graph
    And the traversal of
      """
      g.V().addLabel(__.values("lang")).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The provided traverser does not map to a value"

  @gap:runtime-label
  Scenario: g_V_hasLabelXsoftwareX_addLabelXvaluesXnameXX_labels
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").addLabel(__.values("name")).labels()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | software |
      | lop |
      | software |
      | ripple |
