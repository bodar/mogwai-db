Feature: mogwai addendum — property aliases

  @gap:property-alias
  Scenario: g_E_properties_as_select_byXkeyX
    Given the modern graph
    And the traversal of
      """
      g.E(11).properties('weight').as('a').select('a').by(T.key)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | weight |

  @gap:property-alias
  Scenario: g_E_properties_as_select_byXvalueX
    Given the modern graph
    And the traversal of
      """
      g.E(11).properties('weight').as('a').select('a').by(T.value)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.4].d |
