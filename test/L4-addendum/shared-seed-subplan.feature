Feature: mogwai addendum — a correlated body's seed row shared with its own subplan

  # A connector body that tests its own seed row (`where(union(identity(), identity()))` inside `map`) reads that
  # ONE row both as the filter's input and inside the filter's EXISTS. Re-homing the body onto the host
  # (`substRelId`, src/rel/walk.ts) rebuilt the shared row once per occurrence under one relation id, and the
  # checker refused the plan ("relation id 'ssN' names two different relations in one scope") — an internal
  # error, not an answer. The rewrite now keeps the DAG's sharing.
  #
  # `where(b)` keeps a traverser whose child has a next
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/TraversalFilterStep.java),
  # `union(identity(), identity())` always has one, and `map` emits its body's first result
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53).
  Scenario: g_injectX1X_mapXwhereXunionXidentity_identityXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).map(__.where(__.union(__.identity(), __.identity())))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_injectX1_2X_mapXnotXunionXidentity_identityXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2).map(__.not(__.union(__.identity(), __.identity())))
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_valuesXageX_flatMapXfilterXunionXidentity_identityXXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").flatMap(__.filter(__.union(__.identity(), __.identity())))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
