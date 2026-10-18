Feature: mogwai addendum — withoutStrategies(IdentityRemovalStrategy) runs identity() as the no-op it is

  # A kept `IdentityStep` changes no answer: it only changes where Java's lazy pull stops, which decides
  # WHEN an error fires — an execution detail (docs/feature-support-matrix.md §17).

  Scenario: g_withoutStrategiesXIdentityRemovalStrategyX_V_identity_outXknowsX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.withoutStrategies(IdentityRemovalStrategy).V().identity().out("knows").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
