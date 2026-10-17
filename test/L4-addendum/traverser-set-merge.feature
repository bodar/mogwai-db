Feature: mogwai addendum — an explicit barrier()/order() merges equal traversers at the first arrival

  # `barrier()` (a `NoOpBarrierStep`) and `order()` (a `CollectingBarrierStep`) add every start into
  # ONE `TraverserSet`, which merges an EQUAL traverser into the slot of its first arrival
  # (vendor/tinkerpop/gremlin-core/.../traverser/util/TraverserSet.java:88-96). `barrier()` then
  # drains the set in slot order and `order()` stable-sorts it (OrderGlobalStep.java:78), so where
  # equal traversers are separated by an unequal one the emission order moves: `1,2,1,3` comes out
  # `1,1,2,3`. This spine keeps one row per traverser and never merges, so wherever a reader observes
  # that order and the stream may hold equal traversers it DECLINES (`referenceMergeObservableAt`,
  # src/compiler/ir/bulk.ts) until a first-occurrence regroup mint lowers the merge itself.
  # @gap:traverser-set-merge marks the family.

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_barrier_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # Every traverser ties on `constant(0)`, so the stable sort leaves the MERGED set's slot order.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # The same merge one level down: the decline is the step's own, so it holds in any body.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_mapXconstantXl1_2_1_3X_unfold_barrier_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.constant([1, 2, 1, 3]).unfold().barrier().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # Over a stream the scan can vouch is pairwise DISTINCT the set merges nothing, so these still answer.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_3X_barrier_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 3).barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[3].i] |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_dedup_barrier_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).dedup().barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[3].i] |

  # Nothing downstream reads the order a `barrier()` changes, so its merge is invisible to a count.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_barrier_count
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).barrier().count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |

  # A SLICE between an `order()` and an order-erasing reducer reads the merge: `RangeGlobalStep` trims the
  # merged `1(bulk 2)`'s BULK, so `limit(2)` keeps `1,1` (sum 2), where the unmerged `1,2,1,3` keeps `1,2`
  # (sum 3). The FIRST order-relevant step after the `order()` decides (`orderReadBeforeErased`), not
  # whether any eraser follows somewhere.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_tailX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).tail(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_groupCount
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[1].i":"d[2].l"}] |

  # The slice decides at every depth after it — through a per-traverser body, a filter body, a branch,
  # a bounded repeat and an as()/select() pair — and before it (two stacked tie-every orders).
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_localXidentityX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).local(__.identity()).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_whereXisXgtX0XXX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).where(__.is(P.gt(0))).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_chooseXisX1X_identity_identityX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).choose(__.is(1), __.identity(), __.identity()).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_limitX2X_repeatXidentityX_timesX1X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).limit(2).repeat(__.identity()).times(1).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_asXaX_limitX2X_selectXaX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).as("a").limit(2).select("a").sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_order_byXconstantX1XX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).order().by(__.constant(1)).limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # The rule is the step's own, so it holds where the order/slice/sum chain is itself a child body.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_localXconstantXl1_2_1_3X_unfold_order_byXconstantX0XX_limitX2X_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.constant([1, 2, 1, 3]).unfold().order().by(__.constant(0)).limit(2).sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # A key that ties every traverser need not be a BARE constant: any key that discards the traverser's
  # value for a computed one (`constant(…)` followed by more steps, a `math()` expression) may tie them
  # all, so the stable sort again leaves the merged set's slot order.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0X_isX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0).is(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXconstantXaX_concatXbXX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant("a").concat("b")).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX1_2_1_3X_order_byXmathX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.math("0")).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # A GLOBAL eraser reached before any reader still hides the merge, so these keep answering.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_3X_order_byXconstantX0XX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 3).order().by(__.constant(0)).limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |
