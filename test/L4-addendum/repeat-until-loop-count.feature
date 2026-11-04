Feature: mogwai addendum — until(loops().is(P)) on an unnamed repeat is the bounded count times(k*)

  # Every traverser enters a repeat at loops() == 0 and each body pass adds one, so `loops().is(P)`
  # reads the same count for every traverser at a level and the until fires at ONE level k* — which is
  # `times(k*)` (`times(n)` is `until(loops() >= n)`, vendor/tinkerpop/gremlin-core/src/main/java/org/
  # apache/tinkerpop/gremlin/process/traversal/lambda/LoopTraversal.java). An until BEFORE repeat is
  # tested on entry at loops() == 0, so k* = min{k >= 0 : P(k)}; an until AFTER repeat is first tested
  # once the body has run, so k* = min{k >= 1 : P(k)} (RepeatStep.java:265-278, :334-353). No such k is
  # the spec's loop-to-extinction, answered by the walk with no artificial cap.
  #
  # Only a body holding a per-iteration barrier (order/limit/range/…) is rewritten to times(k*): a
  # recursive term cannot host the barrier, so phases are its only lowering. A barrier-free body stays
  # the walk's, in SQL that does not grow with k*. The answers below are the same either way; the
  # barrier-free scenarios pin the walk, the order().by() ones the unroll.

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

  # A barrier-free body is the walk's, and the walk does not lower inside a where() child yet — for ANY
  # until (`where(repeat(out()).until(has('name','lop')))` declines the same way). Not a count question:
  # the barrier-body form below answers through the unroll.
  @Unsupported
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

  # A k-hop neighbourhood: emit + simplePath + a counted until. The body has no barrier, so it stays the
  # walk's — rewriting it into the emit unroll lost this answer to a decline.
  Scenario: g_VX1X_repeatXboth_simplePathX_emit_untilXloops_isX3XX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.both().simplePath()).emit().until(__.loops().is(3)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  # A large count with emit is the walk's constant-size SQL, not 64 spliced union arms.
  Scenario: g_VX1X_repeatXoutX_emit_untilXloops_isX64XX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.out()).emit().until(__.loops().is(64)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  # A BARRIER body needs phases: emit composes in both positions exactly as with times(2).
  Scenario: g_V_emit_repeatXout_order_byXnameXX_untilXloops_isXwithinX2_3XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().emit().repeat(__.out().order().by("name")).until(__.loops().is(P.within(2, 3))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[14].l |

  # until FIRST, emit LAST over a barrier body: level 2 is emitted AND exits — 6 + 2·2.
  Scenario: g_V_untilXloops_isX2XX_repeatXout_order_byXnameXX_emit_count
    Given the modern graph
    And the traversal of
      """
      g.V().until(__.loops().is(2)).repeat(__.out().order().by("name")).emit().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[10].l |

  Scenario: g_V_localXrepeatXout_limitX1XX_untilXloops_isX1XX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.repeat(__.out().limit(1)).until(__.loops().is(1)).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[0].l |
      | d[0].l |
      | d[1].l |
      | d[0].l |
      | d[1].l |

  Scenario: g_V_whereXrepeatXout_order_byXnameXX_untilXloops_isX2XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.repeat(__.out().order().by("name")).until(__.loops().is(2))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  Scenario: g_V_unionXrepeatXout_order_byXnameXX_untilXloops_isX2XX_constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.repeat(__.out().order().by("name")).until(__.loops().is(2)), __.constant("x")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8].l |

  # A barrier under a FAN-OUT host (local/map/flatMap), at any depth, also needs phases: the host's
  # child fuses into the recursive term, which refuses the window it lowers to. One-step neighbours of
  # Repeat.feature's g_VX250X_repeatXout_localXorder_byXperformancesX_tailX1XXX_timesX2X_valuesXnameX
  # and g_V_emit_repeatXlocalXout_order_byXnameXXX_timesX2X_valuesXnameX, the count spelled as an until.
  Scenario: g_VX1X_repeatXout_localXorder_byXnameX_tailX1XXX_untilXloops_isX2XX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.out().local(__.order().by("name").tail(1))).until(__.loops().is(2)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_VX1X_untilXloops_isX2XX_repeatXout_localXorder_byXnameX_tailX1XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).until(__.loops().is(2)).repeat(__.out().local(__.order().by("name").tail(1))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_emit_repeatXlocalXout_order_byXnameXXX_untilXloops_isX2XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().emit().repeat(__.local(__.out().order().by("name"))).until(__.loops().is(2)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | lop |
      | ripple |
      | lop |
      | vadas |
      | vadas |
      | lop |
      | josh |
      | lop |
      | ripple |
      | ripple |
      | peter |
      | lop |

  # "Follow the heaviest edge" per hop: marko -[1.0]-> josh -[1.0]-> ripple; every other start dies early.
  Scenario: g_V_repeatXlocalXoutE_order_byXweight_descX_limitX1XX_inVX_untilXloops_isX2XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.local(__.outE().order().by("weight", Order.desc).limit(1)).inV()).until(__.loops().is(2)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
