Feature: mogwai addendum — a null is a value to within/without and to math(), and a set op keeps typed members apart

  # An all-null mean() is a productive null (MeanGlobalStep.java:50-58,80-84) tagged as one at its producer,
  # so math() refuses it exactly as it refuses the all-null sum()
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MathStep.java:72-88).
  Scenario: g_VX1X_out_mapXconstantXlist_nullX_unfold_meanX_mathX___plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().map(__.constant([null]).unfold().mean()).math("_ + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_VX1X_projectXxX_byXconstantXlist_nullX_unfold_meanX_mathXx_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null]).unfold().mean()).math("x + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable x for math() step must resolve to a Number"

  # Contains.within is Compare.eq per member, and comparable(null, null) is true
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:314-316).
  Scenario: g_injectXnullX_isXwithinX0_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null).is(P.within(0, null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnullX_isXwithinXlist_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null).is(P.within([null]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1_2X_isXwithoutX1_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).is(P.without(1, null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_injectXnull_1_2X_isXwithoutX1XX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).is(P.without(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | d[2].i |

  # Every list set op builds a HashSet, which is Objects.equals: Integer(1) is not Double(1.0)
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/IntersectStep.java:68-80).
  Scenario: g_injectXlist_1_2X_intersectXlist_1dXX
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2]).intersect([1.0])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[] |

  # merge/disjunct/dedup(local) keeping `1` and `1.0` apart is pinned TYPED in
  # test/compiler/typed-equality-sites.exec.test.ts: the JS client decodes an Int and a Double to one number,
  # so a set holding both reads back here as one member.
