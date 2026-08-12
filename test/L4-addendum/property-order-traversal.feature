Feature: mogwai addendum — property order by traversal

  @gap:property-order-traversal
  @Unsupported
  Scenario: g_V_person_properties_name_order_by_value
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel('person').properties('name').order().by(__.value()).value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh   |
      | marko  |
      | peter  |
      | vadas  |

  @gap:property-order-traversal
  @Unsupported
  Scenario: g_V_person_properties_age_order_by_value_desc
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel('person').properties('age').order().by(__.value(), Order.desc).value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[35].i |
      | d[32].i |
      | d[29].i |
      | d[27].i |
