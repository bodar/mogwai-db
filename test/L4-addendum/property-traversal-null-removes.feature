Feature: mogwai addendum — a property() traversal that resolves to null removes the key

  # `AddPropertyStep.handleTraversalValue` hands whatever the body resolved to `applyPropertyMutation`, which
  # calls `Vertex.property`/`Edge.property` with it (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/
  # tinkerpop/gremlin/process/traversal/step/sideEffect/AddPropertyStep.java:127-240) — so a null is
  # `property(k, null)`, a REMOVAL of the key under every cardinality, exactly as a constant null is. The map
  # form applies each entry the same way (`:152-160`), so a null entry removes that entry's key.
  #
  # Several traversers on ONE element are the reference's loop run once each, so the element ends as
  # "removed at its latest null, then the values after it written by the ordinary cardinality rules".
  # Previously each of these was REFUSED at run time — a refusal that depended on what the data held.

  @gap:property-traversal-null
  Scenario: g_V_propertyXx_coalesceXvaluesXageX_V_constantXnullX_limitX1XXX_valuesXxX
    Given the modern graph
    And the traversal of
      """
      g.V().property("x", __.coalesce(__.values("age"), __.V().constant(null).limit(1))).values("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
    And the graph should return 2 for count of "g.V().hasLabel(\"software\").not(__.has(\"x\"))"

  @gap:property-traversal-null
  Scenario: g_V_propertyXx_coalesceXvaluesXageX_V_constantXnullX_limitX1XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().property("x", __.coalesce(__.values("age"), __.V().constant(null).limit(1))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A null AFTER a value on one element: the later null wins, so nothing is left.
  @gap:property-traversal-null
  Scenario: g_V_hasXname_markoX_propertyXx_1X_propertyXx_coalesceXvaluesXnopeX_V_constantXnullX_limitX1XXX_valuesXxX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property("x", 1).property("x", __.coalesce(__.values("nope"), __.V().constant(null).limit(1))).values("x")
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 0 for count of "g.V().has(\"x\")"

  # Two traversers on ONE element, the first resolving null and the second a value: the value survives.
  @gap:property-traversal-null
  Scenario: g_injectX27_32X_asXaX_V_hasXname_markoX_propertyXsingle_z_coalesceXselectXaX_isX32X_nullXX
    Given the modern graph
    And the traversal of
      """
      g.inject(27, 32).as("a").V().has("name","marko").property(Cardinality.single, "z", __.coalesce(__.select("a").is(32), __.V().constant(null).limit(1)))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"z\",32)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"z\")"

  # ...and the other way round: the value comes first, the later null removes it.
  @gap:property-traversal-null
  Scenario: g_injectX32_27X_asXaX_V_hasXname_markoX_propertyXsingle_z_coalesceXselectXaX_isX32X_nullXX
    Given the modern graph
    And the traversal of
      """
      g.inject(32, 27).as("a").V().has("name","marko").property(Cardinality.single, "z", __.coalesce(__.select("a").is(32), __.V().constant(null).limit(1)))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 0 for count of "g.V().has(\"z\")"

  # LIST cardinality: a null removes every value the element held, and a value after it is appended.
  @gap:property-traversal-null
  Scenario: g_V_propertyXlist_y_coalesceXvaluesXageX_V_constantXnullX_limitX1XXX_valuesXyX_count
    Given the modern graph
    And the traversal of
      """
      g.V().property(Cardinality.list, "y", __.coalesce(__.values("age"), __.V().constant(null).limit(1))).values("y").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  @gap:property-traversal-null
  Scenario: g_V_hasXname_markoX_propertyXlist_y_1X_propertyXlist_y_2X_unionXconstantX0X_constantX5XX_asXaX_propertyXlist_y_nullThen5X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(Cardinality.list, "y", 1).property(Cardinality.list, "y", 2).
        union(__.constant(0), __.constant(5)).as("a").
        V().has("name","marko").property(Cardinality.list, "y", __.coalesce(__.select("a").is(5), __.V().constant(null).limit(1)))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"y\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"y\",5)"

  # SET cardinality: a null removes every value, held ones included.
  @gap:property-traversal-null
  Scenario: g_V_hasXname_markoX_propertyXset_s_32X_propertyXset_s_7X_propertyXset_s_nullX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(Cardinality.set, "s", 32).property(Cardinality.set, "s", 7).
        property(Cardinality.set, "s", __.coalesce(__.values("nope"), __.V().constant(null).limit(1)))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().has(\"s\")"

  # An EDGE property: the null removes the key on one edge, the other edge takes its value.
  @gap:property-traversal-null
  Scenario: g_V_hasXname_markoX_outEXknowsX_propertyXweight_coalesceXinV_valuesXageX_isX32X_nullXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").outE("knows").property("weight", __.coalesce(__.inV().values("age").is(32), __.V().constant(null).limit(1)))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").outE(\"knows\").has(\"weight\",32)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").outE(\"knows\").not(__.has(\"weight\"))"

  # The MAP FORM: an entry whose value is null removes that entry's key; the other entries are written.
  @gap:property-traversal-null
  Scenario: g_V_hasXname_markoX_propertyXx_0X_asXvX_constantXnullX_asXxX_constantX1X_asXqX_selectXvX_propertyXselectXx_qXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property("x", 0).as("v").constant(null).as("x").constant(1).as("q").select("v").property(__.select("x","q"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().has(\"x\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"q\",1)"
