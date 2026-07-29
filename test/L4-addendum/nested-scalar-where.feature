Feature: mogwai addendum — nested scalar child existence

  @gap:nested-scalar-where
  Scenario: g_V_id_where_nested_where_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).id().where(__.where(__.is(P.gt(0)).count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
