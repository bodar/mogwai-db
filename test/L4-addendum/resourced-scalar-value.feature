Feature: mogwai addendum — a re-sourcing scalar child value carries its row's own type

  # A mid-traversal GraphStep inside a per-traverser child (`map(__.V()…)`) re-reads the graph per host
  # traverser (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java),
  # and `map()` takes the body's FIRST result (step/map/TraversalMapStep.java). Where the body's type rides
  # per row (a stored property, a reducer's numeric class) that type must reach the host beside the value:
  # it was named as the ROOTED relation's own `vtype`/`vt` column, which is not in the host's scope, and
  # leaked a bare RelIR Error. Only order-pinned or host-independent answers are asserted here (L8 runs
  # this file under reverse_unordered_selects); the unordered first value is asserted as a multiset of
  # one repeated member in test/compiler/resourced-scalar-value.exec.test.ts.

  Scenario: g_V_mapXV_valuesXnameX_order_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.V().values("name").order().limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | josh |
      | josh |
      | josh |
      | josh |
      | josh |

  Scenario: g_V_mapXV_valuesXageX_orderX_isX27X_count
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.V().values("age").order()).is(27).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_V_valuesXageX_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").V().values("age").sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[123].i |
      | d[123].i |
      | d[123].i |
      | d[123].i |
      | d[123].i |
      | d[123].i |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_E_valuesXweightX_maxX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").E().values("weight").max())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |
      | d[1.0].d |
      | d[1.0].d |
      | d[1.0].d |
      | d[1.0].d |
      | d[1.0].d |

  Scenario: g_V_unionXmapXV_valuesXageX_orderX_constantX5XX_order_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.map(__.V().values("age").order()), __.constant(5)).order().dedup()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[5].i |
      | d[27].i |

  Scenario: g_V_coalesceXvaluesXnopeX_mapXV_valuesXnameX_orderXX_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.values("nope"), __.map(__.V().values("name").order())).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  Scenario: g_V_projectXxX_byXV_valuesXageX_order_byXdescXX_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.V().values("age").order().by(desc)).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[35].i"}] |

  Scenario: g_V_localXmapXV_chooseXhasLabelXpersonX_valuesXageX_valuesXnameXX_order_byXdescXXX_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.map(__.V().choose(__.hasLabel("person"), __.values("age"), __.values("name")).order().by(desc))).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
