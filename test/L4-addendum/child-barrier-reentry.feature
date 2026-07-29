Feature: mogwai addendum — child barrier re-entry

  @gap:child-barrier-reentry
  Scenario: g_V_where_out_dedup_hasLabel
    Given the modern graph
    And the traversal of
      """
      g.V(1).where(__.out().dedup().hasLabel('person')).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |
