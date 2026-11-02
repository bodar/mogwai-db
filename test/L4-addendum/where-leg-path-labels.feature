Feature: mogwai addendum — a multi-correlation where()/not() leg reads no outer path label it cannot see

  # A `where(<body>)`/`not(<body>)` leg that constrains a SECOND bound alias lowers as a semi/anti join
  # against a FRESH walk of its body (src/compiler/rel/match.ts `legCorrelated`): the start and each
  # `where(P.eq/neq(label))` become fresh positions the join correlates. That walk is a new relation and
  # holds none of the outer traverser's path — but in the reference the body's traverser CARRIES that path
  # (`WhereTraversalStep` runs its child on a split of the outer traverser,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WhereTraversalStep.java),
  # so a `select('c')` after the lifted constraint reads `c` and produces. A body that still reads an outer
  # label after the lift — the start and the correlated labels included — DECLINES; re-correlating a fresh
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

  # The lifted constraint alone reads no label after the lift, so the fresh walk answers.
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
