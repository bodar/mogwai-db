Feature: mogwai addendum — a bounded repeat().times(n) with emit() emits exactly the reference levels; a dedup body past one iteration declines

  # WHICH levels a `times(n)` + bare `emit()` outputs, and how often, is read off the reference:
  # `RepeatStep.processTraverser` and `RepeatEndStep.standardAlgorithm`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/RepeatStep.java:265-278, :334-353).
  # The traverser that satisfies `times(n)` at level n LEAVES the loop and is output whatever the emit
  # says, so level n is always in the result; the bounded unroll used to stop the emit-first union at
  # level n-1 (`g.V(1).emit().repeat(out()).times(2).count()` answered 4). With until FIRST
  # (`times(n)` before `repeat`) and emit LAST, the end step ALSO emits a split of the level-n
  # traverser, so level n appears twice.
  #
  # A `dedup` in a repeat body is ONE step instance whose seen-set spans every iteration
  # (`DedupGlobalStep.duplicateSet`, …/step/filter/DedupGlobalStep.java:59,78 — never reset between
  # loops, unlike `RangeGlobalStep`'s per-loop counters). The unroll's phase-local dedups cannot carry
  # it, so n ≥ 2 DECLINES; each @Unsupported scenario carries the reference answer. The one exact
  # exception is a body of value-preserving filters only (`dedup()`, `has…`, `limit`, `order`, …):
  # iteration 2's input is iteration 1's output, all already seen, so every level ≥ 2 is empty.

  Scenario: g_VX1X_emit_repeatXoutX_timesX2X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).emit().repeat(__.out()).times(2).count()
      """
    # level 0 marko; level 1 vadas, lop, josh; level 2 ripple, lop.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_VX1X_emit_repeatXoutX_timesX1X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).emit().repeat(__.out()).times(1).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  Scenario: g_VX1X_timesX2X_repeatXoutX_emit_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).times(2).repeat(__.out()).emit().count()
      """
    # levels 1, 2 and 2 again (until first, emit last).
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  Scenario: g_V_localXemit_repeatXoutX_timesX2XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.emit().repeat(__.out()).times(2)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[14].l |

  Scenario: g_V_emit_repeatXdedupX_timesX1X_count
    Given the modern graph
    And the traversal of
      """
      g.V().emit().repeat(__.dedup()).times(1).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  Scenario: g_V_repeatXdedupX_timesX2X_count_addendum
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.dedup()).times(2).count()
      """
    # Dedup.feature g_V_repeatXdedupX_timesX2X_count: iteration 2's dedup has seen every vertex.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @Unsupported
  Scenario: g_V_repeatXboth_dedupX_emit_timesX2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.both().dedup()).emit().times(2).count()
      """
    # Level 1: both() then dedup → all 6 vertices once. Level 2: both() of those, every one already
    # seen → nothing. Emitted: 6.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @Unsupported
  Scenario: g_V_unionXrepeatXdedup_bothX_timesX2X_outX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.repeat(__.dedup().both()).times(2), __.out()).count()
      """
    # The repeat arm is empty (Repeat.feature g_V_repeatXdedup_bothX_timesX2X); out() gives 6.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
