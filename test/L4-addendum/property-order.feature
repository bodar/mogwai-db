Feature: mogwai addendum — property stream ordering

  @gap:property-order
  Scenario: g_V_properties_order_byXkey_descX_key
    Given the modern graph
    And the traversal of
      """
      g.V().properties().order().by(T.key, Order.desc).key()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | name |
      | name |
      | name |
      | name |
      | name |
      | name |
      | lang |
      | lang |
      | age |
      | age |
      | age |
      | age |

  @gap:property-order
  Scenario: g_E_properties_order_byXdescX_value
    Given the modern graph
    And the traversal of
      """
      g.E().properties().order().by(Order.desc).value()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1.0].d |
      | d[1.0].d |
      | d[0.5].d |
      | d[0.4].d |
      | d[0.4].d |
      | d[0.2].d |
