Feature: mogwai addendum — an is() that passes a null keeps it, in a child body at any depth

  # A child body's null is a VALUE the body produced (TraversalMapStep keeps a productive null,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53),
  # and FilterStep keeps every traverser whose test passes — so a predicate that HOLDS on null (neq,
  # without, eq(null), a negative TextP; Compare's null space,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:314-316)
  # passes the null through. Its presence rides as the body's tag (docs/2026-11-05-presence-is-the-tag-plan.md P3).

  Scenario: g_injectXnull_1X_mapXisXneqX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).map(__.is(P.neq(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_localXisXneqX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).local(__.is(P.neq(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_flatMapXisXneqX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).flatMap(__.is(P.neq(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_mapXmapXisXneqX1XXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).map(__.map(__.is(P.neq(1))))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_asXaX_selectXaX_mapXisXwithoutX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).as("a").select("a").map(__.is(P.without(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1_2X_localXisXneqX1XX_isXneqX2XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).local(__.is(P.neq(1)).is(P.neq(2)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  # A predicate FALSE on null drops it, so the null and the unmatched value both leave.
  Scenario: g_injectXnull_1_2X_localXisXneqX1XX_isXgtX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).local(__.is(P.neq(1)).is(P.gt(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_injectXnull_1X_mapXisXeqXnullXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).map(__.is(P.eq(null)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_mapXisXwithinX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).map(__.is(P.within(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_injectXnull_aX_mapXisXnotStartingWithXaXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, "a").map(__.is(TextP.notStartingWith("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXlistXnull_1XX_unfold_mapXisXneqX1XXX
    Given the empty graph
    And the traversal of
      """
      g.inject([null, 1]).unfold().map(__.is(P.neq(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1X_mapXisXneqX1XX_foldX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1).map(__.is(P.neq(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null] |
      | l[] |
