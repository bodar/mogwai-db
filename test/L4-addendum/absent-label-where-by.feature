Feature: mogwai addendum — a where().by() operand over an UNBOUND label drops the traverser

  # `where('a', P.eq('b')).by(…)` resolves each operand with `getSafeScopeValue`, which is null for a
  # label the traverser does not carry, and an unproductive `by()` FILTERS the traverser
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java:98-102,131-139).
  # A `by()` that never reads through the element (`by(__.constant(1))`) must still see the label's
  # absence: `g.V().union(__.as("a"), __.identity())` is 12 rows, and only the 6 that took the first arm
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
