Feature: mogwai addendum — property aliases

  @gap:property-alias
  @Unsupported
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
  @Unsupported
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

  @gap:property-alias
  @Unsupported
  Scenario: g_E_properties_as_select_pop_all_unfold_value
    Given the modern graph
    And the traversal of
      """
      g.E(11).properties('weight').as('a').select(Pop.all, 'a').unfold().value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.4].d |

  @gap:property-alias
  @Unsupported
  Scenario: g_E_properties_as_select_pop_mixed_unfold_value
    Given the modern graph
    And the traversal of
      """
      g.E(11).properties('weight').as('a').as('a').select(Pop.mixed, 'a').unfold().value()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.4].d |
      | d[0.4].d |
