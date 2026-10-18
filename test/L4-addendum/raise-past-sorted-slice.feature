Feature: mogwai addendum — a raising step after a sorted slice is evaluated over the sliced rows only

  # SQLite computes a SELECT's whole select list into the sorter before its `LIMIT` cuts, so a raise fused
  # into an `ORDER BY … LIMIT` fired on a row the slice drops (`Division by zero!` for the `0`). A raising
  # projection over a sorted slice gets its own SELECT (`NEEDS_SUBQUERY.project`, src/rel/block.ts).

  Scenario: g_injectX0_2_1X_order_byXdescX_limitX2X_mathX1_div_X
    Given the empty graph
    And the traversal of
      """
      g.inject(0,2,1).order().by(Order.desc).limit(2).math("1/_")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
      | d[1.0].d |
