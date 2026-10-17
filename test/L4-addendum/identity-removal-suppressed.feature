Feature: mogwai addendum — withoutStrategies(IdentityRemovalStrategy) keeps an identity() the slice can see

  # This compiler reads `identity()` as absent, which is the reference only while
  # `IdentityRemovalStrategy` runs. A kept `IdentityStep` is neither a `MapStep` nor a `SideEffectStep`, so
  # `EarlyLimitStrategy` stops at it
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/EarlyLimitStrategy.java:68-98),
  # and the slice pulls one more traverser through the raising `math()` before it can stop — the answer
  # becomes the error. A traversal holding an `identity()` and a slice or an order reader DECLINES
  # (`verifyIdentityRemovalSuppressed`, src/compiler/ir/strategies.ts); every other one answers as before.

  @Unsupported
  Scenario: g_withoutStrategiesXIdentityRemovalStrategyX_injectX1_aX_mathX_plus1X_identity_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.withoutStrategies(IdentityRemovalStrategy).inject(1,"a").math("_+1").identity().limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_withoutStrategiesXIdentityRemovalStrategyX_VX1X_localXvaluesXnameX_mathX_plus1X_identity_limitX0XX
    Given the modern graph
    And the traversal of
      """
      g.withoutStrategies(IdentityRemovalStrategy).V(1).local(__.values("name").math("_+1").identity().limit(0))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

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
