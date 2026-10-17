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
