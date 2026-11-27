Feature: mogwai addendum — a computed property value is visible to a range has()

  # A property value computed by a traversal that states no type (`id()`, `values('name').length()`,
  # a branch arm that could not say) must still carry its type when it is stored. A range `has()`
  # compares by that type, so an untyped row was invisible to it: the count was 0.

  Scenario: g_V_propertyXw_idX_V_hasXw_gtX1XX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas").addV("software").property("name", "lop").V().property("w", __.id())
      """
    And the traversal of
      """
      g.V().has("w", P.gt(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  Scenario: g_V_propertyXw_valuesXnameX_lengthX_V_hasXw_gteX4XX_valuesXnameX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas").addV("software").property("name", "lop").V().property("w", __.values("name").length())
      """
    And the traversal of
      """
      g.V().has("w", P.gte(4)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |

  Scenario: g_V_propertyXw_coalesceXvaluesXageX_constantXnameX_lengthXX_V_hasXw_ltX10XX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").property("age", 29).addV("software").property("name", "lop").V().property("w", __.coalesce(__.values("age"), __.values("name").length()))
      """
    And the traversal of
      """
      g.V().has("w", P.lt(10)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
