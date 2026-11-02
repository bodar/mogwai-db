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

  # A mid-traversal V() SPLITS the host traverser (`head.split(element, this)`,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/GraphStep.java:196),
  # so the re-sourced body sees the HOST's sack, loops, path and path labels. The rooted read is computed once
  # for every host and cannot hold them, so a body that reads one REFUSES rather than answering with the
  # withSack seed or a one-element path. The rows below are the reference's answers.
  @gap:resourced-host-state
  @Unsupported
  Scenario: g_withSackX1X_V_sackXsumX_byXconstantX2XX_mapXV_sackX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(sum).by(__.constant(2)).map(__.V().sack())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |
      | d[3].i |
      | d[3].i |
      | d[3].i |
      | d[3].i |
      | d[3].i |

  @gap:resourced-host-state
  @Unsupported
  Scenario: g_withSackX1X_V_sackXsumX_byXconstantX2XX_mapXV_sack_sumX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(sum).by(__.constant(2)).map(__.V().sack().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[18].i |
      | d[18].i |
      | d[18].i |
      | d[18].i |
      | d[18].i |
      | d[18].i |

  @gap:resourced-host-state
  @Unsupported
  Scenario: g_withSackX1X_V_sackXsumX_byXconstantX2XX_projectXsX_byXV_sackX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(sum).by(__.constant(2)).project("s").by(__.V().sack())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"s":"d[3].i"}] |
      | m[{"s":"d[3].i"}] |
      | m[{"s":"d[3].i"}] |
      | m[{"s":"d[3].i"}] |
      | m[{"s":"d[3].i"}] |
      | m[{"s":"d[3].i"}] |

  @gap:resourced-host-state
  @Unsupported
  Scenario: g_withSackX1X_V_sackXsumX_byXconstantX2XX_whereXV_sack_isX3XX_count
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(sum).by(__.constant(2)).where(__.V().sack().is(3)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:resourced-host-state
  @Unsupported
  Scenario: g_V_out_mapXV_simplePath_countX
    Given the modern graph
    And the traversal of
      """
      g.V().out().map(__.V().simplePath().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
      | d[4].l |
      | d[4].l |
      | d[4].l |
      | d[4].l |
      | d[4].l |

  @gap:resourced-host-state
  @Unsupported
  Scenario: g_V_asXxX_mapXV_asXyX_selectXxX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").map(__.V().as("y").select("x").count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  # A SOURCE union's arm starts from a fresh traverser, which holds the withSack seed.
  Scenario: g_withSackX1X_unionXV_sackX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).union(__.V().sack())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
