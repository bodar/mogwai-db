Feature: mogwai addendum — a predicate body that LEADS with a filter and then moves

  # A child body is run on a split of the traverser (TraversalUtil.test,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
  # and a filter step never moves it, so `where(F.rest)` holds exactly when F holds of the subject AND
  # `rest` produces from it. `bodyPredicate` (src/compiler/rel/lower/filter.ts) used to try the
  # moving/projecting shapes only on the WHOLE body, so a filter-led body that then moved declined at
  # every predicate position. These scenarios pin the conjunction at each position the one seam serves.
  @gap:filter-led-predicate-body

  Scenario: g_V_whereXhasLabelXpersonX_outXcreatedXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.hasLabel("person").out("created")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_notXhasLabelXpersonX_outX_name
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.hasLabel("person").out()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | ripple |

  Scenario: g_V_outE_whereXhasLabelXcreatedX_inV_hasXname_rippleXX_outV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().where(__.hasLabel("created").inV().has("name", "ripple")).outV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  Scenario: g_V_chooseXhasLabelXpersonX_outXcreatedX_constantXcX_constantXnXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person").out("created"), __.constant("c"), __.constant("n"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | c |
      | c |
      | c |
      | n |
      | n |
      | n |

  Scenario: g_V_whereXorXhasLabelXsoftwareX_hasXage_ltX30XX_outXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.or(__.hasLabel("software"), __.has("age", P.lt(30)).out())).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | lop |
      | ripple |

  Scenario: g_V_whereXandXhasLabelXpersonX_outXknowsX_hasXage_ltX30XX_outXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.and(__.hasLabel("person").out("knows"), __.has("age", P.lt(30)).out())).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  Scenario: g_V_whereXwhereXhasLabelXpersonX_outXknowsXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.where(__.hasLabel("person").out("knows"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  Scenario: g_V_notXnotXhasLabelXpersonX_outXcreatedXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.not(__.hasLabel("person").out("created"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  # A filter-led body whose suffix PROJECTS and tests a value, rather than moving.
  Scenario: g_V_whereXhasLabelXpersonX_outXcreatedX_count_isXgtX1XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.hasLabel("person").out("created").count().is(P.gt(1))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  Scenario: g_V_repeatXoutX_untilXhasLabelXsoftwareX_inXcreatedX_hasXname_peterXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.hasLabel("software").in("created").has("name", "peter")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |
      | lop |

  Scenario: g_V_repeatXoutX_emitXhasLabelXpersonX_outEXcreatedXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).emit(__.hasLabel("person").outE("created")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  Scenario: g_V_localXwhereXhasLabelXpersonX_outXcreatedXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.where(__.hasLabel("person").out("created"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  Scenario: g_withStrategiesXSubgraphStrategyXvertices_hasLabelXpersonX_outXcreatedXXX_V_name
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(new SubgraphStrategy(vertices: __.hasLabel("person").out("created"))).V().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  Scenario: g_withStrategiesXSubgraphStrategyXedges_hasLabelXcreatedX_inV_hasXname_lopXXX_V_hasXname_joshX_outE_inV_name
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(new SubgraphStrategy(edges: __.hasLabel("created").inV().has("name", "lop"))).V().has("name", "josh").outE().inV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
