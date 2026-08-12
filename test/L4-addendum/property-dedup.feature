Feature: mogwai addendum — property stream deduplication

  @gap:property-dedup
  @Unsupported
  Scenario: g_V_both_properties_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().both().properties().dedup().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  @gap:property-dedup
  @Unsupported
  Scenario: g_V_properties_dedup_byXvalueX_count
    Given the modern graph
    And the traversal of
      """
      g.V().bothE().properties().dedup().by(value).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
