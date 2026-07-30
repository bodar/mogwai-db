Feature: mogwai addendum — labelled exploded-edge repeat body

  @gap:repeat-edge-label
  Scenario: g_V_1_repeat_bothE_knows_outV_times_1_values_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.bothE('knows').outV()).times(1).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |
      | marko  |
