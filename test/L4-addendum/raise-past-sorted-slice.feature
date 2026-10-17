Feature: mogwai addendum — a raising step after a sorted slice is evaluated over the sliced rows only

  # `inject()` adds its starts through `ExpandableStepIterator.add`, which drains them into a
  # `TraverserSet` (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/util/ExpandableStepIterator.java:60-62):
  # `inject(1,0,1)` is `1×2, 0`. `EarlyLimitStrategy` moves the `limit` before the one-to-one `math()`, so
  # the slice keeps `1×2` and `1/_` never meets the `0`. The merge is stated as an `ORDER BY` over the
  # first-arrival position, and SQLite computes a SELECT's whole select list into the sorter before its
  # `LIMIT` cuts — so a raise fused there fired on the dropped row (`Division by zero!`). A raising
  # projection over a sorted slice now gets its own SELECT (`NEEDS_SUBQUERY.project`, src/rel/block.ts).

  Scenario: g_injectX1_0_1X_mathX1_div_X_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(1,0,1).math("1/_").limit(1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |

  Scenario: g_injectX1_0_1X_mathX1_div_X_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject(1,0,1).math("1/_").limit(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |
      | d[1.0].d |

  Scenario: g_injectX1_1_0X_mapXmathX1_div_XX_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(1,1,0).map(__.math("1/_")).limit(1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |

  # The first start IS the zero: the reference meets it on the first pull.
  Scenario: g_injectX0_1X_mathX1_div_X_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(0,1).math("1/_").limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Division by zero!"
