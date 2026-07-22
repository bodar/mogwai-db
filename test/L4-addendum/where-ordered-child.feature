Feature: mogwai addendum — ordered child existence

  @gap:where-ordered-child
  Scenario: g_V_where_ordered_child_range
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out().hasLabel('person').order().by('name').range(1,2)).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |

  @gap:where-ordered-child
  Scenario: g_V_not_ordered_child_limit
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.out().hasLabel('person').order().by('name').limit(1)).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh   |
      | lop    |
      | peter  |
      | ripple |
      | vadas  |
