Feature: mogwai addendum — nested local child lowering

  @gap:nested-local
  Scenario: g_V_local_out_local_out_order_limit
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.out().local(__.out().order().by('name').limit(1))).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop    |
