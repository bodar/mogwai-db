Feature: mogwai addendum — a multi-correlation where()/not() leg reads no outer path label it cannot see

  # A `where(<body>)`/`not(<body>)` leg that constrains a SECOND bound alias lowers as a correlated
  # [NOT] EXISTS over a walk of its body ANCHORED at the start element (src/compiler/rel/match.ts
  # `legCorrelated`): each `where(P.eq/neq(label))` becomes a fresh position the probe correlates. That walk
  # holds none of the outer traverser's path — but in the reference the body's traverser CARRIES that path
  # (`WhereTraversalStep` runs its child on a split of the outer traverser,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WhereTraversalStep.java),
  # so a `select('c')` after the lifted constraint reads `c` and produces. A body that still reads an outer
  # label after the lift — the start and the correlated labels included — DECLINES; re-correlating the
  # walk with outer path labels is unbuilt. Each @Unsupported scenario carries the REFERENCE answer.

  @Unsupported
  Scenario: g_V_asXbX_out_asXaX_in_asXcX_whereXselectXaX_in_whereXeqXcXX_selectXcXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").out().as("a").in().as("c").where(__.select("a").in().where(P.eq("c")).select("c")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  @Unsupported
  Scenario: g_V_asXbX_out_asXaX_in_asXcX_notXselectXaX_in_whereXeqXcXX_selectXcXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").out().as("a").in().as("c").not(__.select("a").in().where(P.eq("c")).select("c")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  # The same leg nested in a branch arm declines the same way: the guard is the leg's, not the host's.
  @Unsupported
  Scenario: g_V_asXbX_out_asXaX_in_asXcX_unionXwhereXselectXaX_in_whereXeqXcXX_selectXcXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").out().as("a").in().as("c").union(__.where(__.select("a").in().where(P.eq("c")).select("c"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  # The lifted constraint alone reads no label after the lift, so the anchored walk answers.
  Scenario: g_V_asXbX_out_asXaX_in_asXcX_whereXselectXaX_in_whereXeqXcXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").out().as("a").in().as("c").where(__.select("a").in().where(P.eq("c"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  # A VALUE argument is no label read: `has('name','b')` does not read the outer `b`.
  Scenario: g_V_asXaX_out_asXbX_whereXasXaX_out_hasXname_bXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").where(__.as("a").out().has("name", "b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_asXaX_out_asXbX_whereXasXaX_out_whereXeqXbXX_hasXname_bXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").where(__.as("a").out().where(P.eq("b")).has("name", "b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  # A VALUE argument spelling a live outer label that the leg does NOT correlate is no scope key either.
  # It used to decline for COST, not correctness: the walk was an UNANCHORED `V()` walk joined back on the
  # start per outer row (~N²). Anchored at the start, the walk costs the start's own fan-out per row.
  Scenario: g_V_asXaX_out_asXbX_in_asXcX_whereXasXaX_out_whereXeqXbXX_hasXname_cXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").in().as("c").where(__.as("a").out().where(P.eq("b")).has("name", "c")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_asXxX_asXaX_out_asXbX_whereXasXaX_out_whereXeqXbXX_hasXname_neqXxXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").as("a").out().as("b").where(__.as("a").out().where(P.eq("b")).has("name", P.neq("x"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_asXaX_out_asXbX_matchXasXaX_out_asXcX__whereXasXaX_out_whereXeqXcXX_hasXname_neqXbXXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").match(__.as("a").out().as("c"), __.where(__.as("a").out().where(P.eq("c")).has("name", P.neq("b")))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[14].l |

  # A RECORD host (`project`) reads its where-leg guard by SCOPE KEY (`scopeKeyReads`): a record FIELD
  # named like a VALUE argument (`project('lop')` beside `has('name','lop')`) is no field read, so the leg
  # answers rather than declining on the name collision. Both reach the anchored walk.
  Scenario: g_V_asXaX_out_asXbX_projectXlopX_byXnameX_whereXselectXaX_out_whereXeqXbXX_hasXname_lopXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").project("lop").by("name").where(__.select("a").out().where(P.eq("b")).has("name", "lop")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_asXaX_out_asXbX_projectXlopX_byXnameX_notXselectXaX_out_whereXeqXbXX_hasXname_lopXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").project("lop").by("name").not(__.select("a").out().where(P.eq("b")).has("name", "lop")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  # A bounded `repeat` body walks from the same anchor (marko's two-hop lop is also his one-hop b).
  Scenario: g_V_asXaX_out_asXbX_whereXasXaX_repeatXoutX_timesX2X_whereXeqXbXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").where(__.as("a").repeat(__.out()).times(2).where(P.eq("b"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
