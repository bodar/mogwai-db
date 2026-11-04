Feature: mogwai addendum — until(loops().is(P)) on an unnamed repeat is the bounded count times(k*)

  # Every traverser enters a repeat at loops() == 0 and each body pass adds one, so `loops().is(P)`
  # reads the same count for every traverser at a level and the until fires at ONE level k* — which is
  # `times(k*)` (`times(n)` is `until(loops() >= n)`, vendor/tinkerpop/gremlin-core/src/main/java/org/
  # apache/tinkerpop/gremlin/process/traversal/lambda/LoopTraversal.java). An until BEFORE repeat is
  # tested on entry at loops() == 0, so k* = min{k >= 0 : P(k)}; an until AFTER repeat is first tested
  # once the body has run, so k* = min{k >= 1 : P(k)} (RepeatStep.java:265-278, :334-353). No such k is
  # the spec's loop-to-extinction, answered by the walk with no artificial cap.

  # until-FIRST is(0) holds on entry: every traverser leaves untouched.
  Scenario: g_V_untilXloops_isX0XX_repeatXoutX_count
    Given the modern graph
    And the traversal of
      """
      g.V().until(__.loops().is(0)).repeat(__.out()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # until-LAST is(0) is never tested at loops() == 0, so it never holds: out() runs to extinction.
  Scenario: g_V_repeatXoutX_untilXloops_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.loops().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_untilXloops_isXgtX1XXX_repeatXoutX_name
    Given the modern graph
    And the traversal of
      """
      g.V().until(__.loops().is(P.gt(1))).repeat(__.out()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # between(2,5) first holds at 2.
  Scenario: g_VX1X_repeatXoutX_untilXloops_isXbetweenX2_5XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.out()).until(__.loops().is(P.between(2, 5))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # emit FIRST composes as with times(2): levels 0, 1 and 2 — 1 + 3 + 2.
  Scenario: g_VX1X_emit_repeatXoutX_untilXloops_isXwithinX2_3XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).emit().repeat(__.out()).until(__.loops().is(P.within(2, 3))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # until FIRST, emit LAST: the level-2 traverser is emitted AND exits, so it counts twice — 3 + 2·2.
  Scenario: g_VX1X_untilXloops_isX2XX_repeatXoutX_emit_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).until(__.loops().is(2)).repeat(__.out()).emit().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  Scenario: g_V_localXrepeatXoutX_untilXloops_isX1XX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.repeat(__.out()).until(__.loops().is(1)).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[0].l |
      | d[2].l |
      | d[0].l |
      | d[1].l |

  Scenario: g_V_whereXrepeatXoutX_untilXloops_isX2XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.repeat(__.out()).until(__.loops().is(2))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  # No integer loop count equals 2.5 (or -1): the until never fires and out() runs to extinction.
  Scenario: g_V_untilXloops_isX2_5XX_repeatXoutX_count
    Given the modern graph
    And the traversal of
      """
      g.V().until(__.loops().is(2.5)).repeat(__.out()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_repeatXoutX_untilXloops_isXneg1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.loops().is(-1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |
