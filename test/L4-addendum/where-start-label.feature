Feature: mogwai addendum — a where() START label no as() binds resolves per traverser

  # `where(__.as("a")…)` re-roots on what `a` holds, read per traverser by `WhereStartStep` through
  # `getSafeScopeValue` — the traverser's own map key, then a side effect, then the path — and raises
  # `KeyNotFoundException` only for a traverser that REACHES it with the key in none of them
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WhereTraversalStep.java:175,
  # …/traversal/step/Scoping.java:119-145). So these answer in the reference; a compile-time error was not the
  # reference, and neither is reading the label as a bind or a dropping select(). Each @Unsupported scenario
  # states the reference answer and must refuse.

  @gap:where-start-label
  @Unsupported
  Scenario: g_V_projectXaX_byXidentityX_whereXasXaX_outX_count
    Given the modern graph
    And the traversal of
      """
      g.V().project("a").by(__.identity()).where(__.as("a").out()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:where-start-label
  @Unsupported
  Scenario: g_V_hasLabelXnothingX_whereXasXaX_both_asXbXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("nothing").where(__.as("a").both().as("b"))
      """
    When iterated to list
    Then the result should be empty
