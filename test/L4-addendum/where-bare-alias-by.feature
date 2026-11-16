Feature: mogwai addendum — a bare where(P(label)).by(…) compares the CURRENT traverser's projection

  # With no startKey, WherePredicateStep's left-hand side is the current traverser run through the
  # first by(), and each predicate leaf's label is run through the next by() in the ring
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java,
  # `filter`/`setPredicateValues`). An unproductive by() drops the traverser. Modern graph answers.

  Scenario: g_V_hasXname_markoX_asXmX_outXknowsX_whereXgtXmXX_byXageX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").as("m").out("knows").where(P.gt("m")).by("age").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  # Software has no age: the by() is unproductive and the traverser is dropped, not compared as null.
  Scenario: g_V_asXmX_out_whereXltXmXX_byXageX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("m").out().where(P.lt("m")).by("age").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  Scenario: g_V_asXmX_out_whereXeqXmXX_byXlabelX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("m").out().where(P.eq("m")).by(T.label).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |

  # A compound predicate: each leaf's label takes the next by() in the ring (here the one by(), cycled).
  Scenario: g_V_asXaX_out_whereXgtXaX_andXneqXaXXX_byXageX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().where(P.gt("a").and(P.neq("a"))).by("age").count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |

  # Two by()s: the current traverser takes the first, the label the second.
  Scenario: g_V_hasXname_markoX_asXmX_outXknowsX_whereXltXmXX_byXageX_byXvaluesXageX_mathX_plus3XX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").as("m").out("knows").where(P.lt("m")).by("age").by(__.values("age").math("_+3")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
