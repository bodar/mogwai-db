Feature: mogwai addendum — a where().by() operand over an UNBOUND label drops the traverser

  # `where('a', P.eq('b')).by(…)` and `dedup('a','b')` resolve each key with `getSafeScopeValue`, which
  # RAISES `IllegalArgumentException` for a label the traverser does not carry
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java,
  # step/filter/WherePredicateStep.java:98-102,131-139, step/filter/DedupGlobalStep.java:80-88). We DROP that
  # traverser instead — the answer `select()` gives — a deliberate divergence
  # (docs/feature-support-matrix.md §17). A `by()` that never reads through the element
  # (`by(__.constant(1))`) or that produces over nothing (`by(__.outE().count())` counts 0) must still see
  # the label's absence, and `ProductiveByStrategy` does not waive it (a scope miss is not an unproductive
  # `by()`): `g.V().union(__.as("a"), __.identity())` is 12 rows, and only the 6 that took the first arm
  # carry `a`.

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXa_eqXbXX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXb_eqXaXX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("b", P.eq("a")).by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXa_eqXbX_orXneqXbXXX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("a", P.eq("b").or(P.neq("b"))).by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXa_eqXbXX_byXnameX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("a", P.eq("b")).by("name").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_chooseXhasLabelXpersonX_asXaX_identityX_asXbX_whereXa_eqXbXX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  Scenario: g_V_coalesceXout_asXaX_identityX_asXbX_whereXa_eqXbXX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_unionXwhereXa_eqXbXX_byXconstantX1XX_constantX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").union(__.where("a", P.eq("b")).by(__.constant(1)), __.constant(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[18].l |

  Scenario: g_V_localXunionXasXaX_identityX_asXbX_whereXa_eqXbXX_byXconstantX1XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.constant(1))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_matchXasXaX_out_count_asXcXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").match(__.as("a").out().count().as("c")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXa_eqXbXX_byXoutE_countX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.outE().count()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_whereXa_eqXbX_orXneqXbXXX_byXoutE_countX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").where("a", P.eq("b").or(P.neq("b"))).by(__.outE().count()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_localXunionXasXaX_identityX_asXbX_whereXa_eqXbXX_byXoutE_countXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.as("a"), __.identity()).as("b").where("a", P.eq("b")).by(__.outE().count())).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_dedupXa_bX_byXidX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").dedup("a", "b").by(__.id()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_dedupXa_bX_byXconstantX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").dedup("a", "b").by(__.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_unionXasXaX_identityX_asXbX_dedupXa_bX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.as("a"), __.identity()).as("b").dedup("a", "b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_mapXunionXasXaX_identityX_asXbX_dedupXa_bX_byXconstantX1XX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.union(__.as("a"), __.identity()).as("b").dedup("a", "b").by(__.constant(1)).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  # Under ProductiveByStrategy the out-degree pairs of the 6 rows carrying `a` are (3,3),(0,0),(0,0),
  # (2,2),(0,0),(1,1) — 4 distinct keys; the 6 rows without `a` still drop.
  Scenario: g_withStrategiesXProductiveByStrategyX_V_unionXasXaX_identityX_asXbX_dedupXa_bX_byXoutE_countX_count
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().union(__.as("a"), __.identity()).as("b").dedup("a", "b").by(__.outE().count()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
