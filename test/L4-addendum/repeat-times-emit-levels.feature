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
  # exception is a body of value-preserving steps only (`dedup()`, `has…`, GLOBAL `limit`/`range`/`order`):
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

  # A `Scope.local` slice is NOT a value-preserving filter — it is a value transform with a global
  # step's name. `[1,2,3]` → `[2,3]` → `[3]`: `[3]` is unseen by the shared dedup, so level 2 is not
  # empty. Declaring it empty (admitting the step by NAME) answered [] here.
  @Unsupported
  Scenario: g_injectX1_2_3X_repeatXrangeXlocal_1_3X_dedupX_timesX2X
    Given the empty graph
    And the traversal of
      """
      g.inject([1,2,3]).repeat(__.range(Scope.local,1,3).dedup()).times(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[3].i] |

  @Unsupported
  Scenario: g_injectX1_2_3X_timesX2X_repeatXrangeXlocal_1_3X_dedupX_emit
    Given the empty graph
    And the traversal of
      """
      g.inject([1,2,3]).times(2).repeat(__.range(Scope.local,1,3).dedup()).emit()
      """
    # Level 1 [2,3]; level 2 [3], emitted by the end step AND output by the until — twice.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[2].i,d[3].i] |
      | l[d[3].i] |
      | l[d[3].i] |

  # A SIDE EFFECT in the body is written once per traverser per iteration. The level-n double is the
  # ORIGINAL traverser handed back to `RepeatStep` and output by its `doUntil(true)` WITHOUT another body
  # pass (RepeatStep.java:265-278), so the stream carries level 1 twice and `aggregate` holds it once.
  Scenario: g_VX1X_timesX1X_repeatXout_aggregateXxXX_emit_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).times(1).repeat(__.out().aggregate("x")).emit().cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_VX1X_timesX1X_repeatXout_aggregateXxXX_emit_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).times(1).repeat(__.out().aggregate("x")).emit().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # Every other emit form unrolls to ≥ 2 INDEPENDENT union arms, each re-running the body prefix for
  # traversers the reference ran through it once (the arms answered 8). From marko the reference
  # aggregates level 1 (vadas, lop, josh) and level 2 (ripple, lop): 5 members.
  @Unsupported
  Scenario: g_VX1X_emit_repeatXout_aggregateXxXX_timesX2X_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).emit().repeat(__.out().aggregate("x")).times(2).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  @Unsupported
  Scenario: g_VX1X_timesX2X_repeatXout_aggregateXxXX_emit_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).times(2).repeat(__.out().aggregate("x")).emit().cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  # The unbounded walk: a recursive term cannot hold an aggregate (it used to leak an internal error).
  @Unsupported
  Scenario: g_VX1X_repeatXout_aggregateXxXX_emit_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).repeat(__.out().aggregate("x")).emit().cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |
