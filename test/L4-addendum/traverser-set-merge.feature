Feature: mogwai addendum — equal traversers merge into the first arrival's slot at every TraverserSet

  # `barrier()` (a `NoOpBarrierStep`), `order()` (a `CollectingBarrierStep`), `aggregate('x')`, a start
  # step's own iterator, and the implicit `NoOpBarrierStep(2500)`s that `LazyBarrierStrategy` puts after
  # every flat-map but the first (and `PathRetractionStrategy` after a `math()`) all add their starts into
  # ONE `TraverserSet`, which merges an EQUAL traverser into the slot of its first arrival
  # (vendor/tinkerpop/gremlin-core/.../traverser/util/TraverserSet.java:88-96). The set drains in slot
  # order (`order()` stable-sorts it, OrderGlobalStep.java:78), so where equal traversers are separated
  # by an unequal one the emission order moves: `1,2,1,3` comes out `1,1,2,3` — whatever the order key,
  # because the merge happens before the sort. `bulkingPositions` (src/compiler/ir/bulk.ts) places every
  # merge and `regroupFirstOccurrence` (src/compiler/rel/build.ts) reproduces it on the emission order.
  # @gap:traverser-set-merge marks the family.

  @gap:traverser-set-merge
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
  @gap:traverser-set-merge
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
  @gap:traverser-set-merge
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
  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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
  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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
  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  @gap:traverser-set-merge
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

  # An eraser is a STEP FORM, not a name: the side-effect `groupCount('x')` is a
  # GroupCountSideEffectStep, a SideEffectStep that passes every traverser through (merged bulk and all),
  # so the slice or collector after it still reads the merge (`erasesOrder`). Flat, under a modulator,
  # with a collector, and inside a union arm.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_groupCountXxX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).groupCount("x").limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_groupCountXxX_byXconstantX0XX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).groupCount("x").by(__.constant(0)).limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_groupCountXxX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).groupCount("x").fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_unionXorder_byXconstantX0XX_groupCountXxX_limitX2XX_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).union(__.order().by(__.constant(0)).groupCount("x").limit(2)).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # A GLOBAL eraser reached before any reader still hides the merge, so these keep answering — and a
  # pass-through side effect before it does not change that.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXconstantX0XX_groupCountXxX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.constant(0)).groupCount("x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

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

  # The merge is the SET's, not the key's: a key that ties traversers only on some data (here every
  # string of one length) still sorts the merged slots, so the two `a`s are adjacent.
  @gap:traverser-set-merge
  Scenario: g_injectXa_b_aX_order_byXlengthX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b", "a").order().by(__.length()).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[a,a,b] |

  # A key that reads the traverser yet is constant-VALUED ties every traverser as `constant(0)` does.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_order_byXmathX___mul_0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).order().by(__.math("_ * 0")).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # A start step drains its arguments into its iterator's set (ExpandableStepIterator.java:61-63).
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1_3X_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1, 3).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # `LazyBarrierStrategy` puts a `NoOpBarrierStep` after the SECOND flat-map (the next step is a filter,
  # not a `Barrier`), so `1,2,1,3` reaches the fold merged — the `flatMap()` is a counted `FlatMapStep`
  # even when its body is spliced away.
  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_1_3X_unfold_flatMapXidentityX_isXgtX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 1, 3]).unfold().flatMap(__.identity()).is(P.gt(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # …and a slice behind it trims the merged slot's BULK (RangeGlobalStep), so it keeps both 1s.
  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_1_3X_unfold_flatMapXidentityX_isXgtX0XX_limitX2X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 1, 3]).unfold().flatMap(__.identity()).is(P.gt(0)).limit(2).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # The first flat-map gets NO barrier — only the ones after it do — and neither does one whose next step is
  # a `Barrier` (the `fold()` here).
  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_1_3X_unfold_flatMapXidentityX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 1, 3]).unfold().flatMap(__.identity()).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[1].i,d[3].i] |

  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_1_3X_unfold_isXgtX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 1, 3]).unfold().is(P.gt(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[1].i,d[3].i] |

  # `aggregate('x')` is a LocalBarrier: it passes its starts on from its own TraverserSet.
  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_1_3X_unfold_aggregateXxX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 1, 3]).unfold().aggregate("x").fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[1].i,d[2].i,d[3].i] |

  # `PathRetractionStrategy` puts a `NoOpBarrierStep` after a `math()` whose next step is not a Barrier.
  @gap:traverser-set-merge
  Scenario: g_injectXl1_2_3_4X_unfold_mathX_mod_2X_isXgteX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 3, 4]).unfold().math("_ % 2").is(P.gte(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1.0].d,d[1.0].d,d[0.0].d,d[0.0].d] |

  # …and under a slice: math()'s possible raise is carried past the is() filter to the limit, which the
  # raise channel (`rel/raise-channel.ts`) cannot settle yet — a decline, never the unmerged [1.0, 0.0].
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectXl1_2_3_4X_unfold_mathX_mod_2X_isXgteX0XX_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2, 3, 4]).unfold().math("_ % 2").is(P.gte(0)).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1.0].d |
      | d[1.0].d |

  # `LocalStep` SPLITS a merged slot into unit traversers before running its body (LocalStep.java:80-88),
  # so a per-traverser reduction after the `both()` merge still answers once per unit: marko, josh and peter
  # are reached 3, 3 and 1 times with out-degrees 3, 2 and 1 — 9 + 6 + 1. (A merged slot folding ONCE would
  # give 3 + 2 + 1. `per-traverser-fanout-slice.feature` pins the per-unit `limit(1)` count, 7.)
  @gap:traverser-set-merge
  Scenario: g_V_both_localXout_fold_countXlocalXX_sum
    Given the modern graph
    And the traversal of
      """
      g.V().both().local(__.out().fold().count(Scope.local)).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[16].l |

  # `OptionalStep` hands its body the merged traverser WITH its bulk (OptionalStep.java:46-57): the six
  # merged slots each fold ONCE, where one row per unit folds twelve times — which this spine cannot state.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_V_both_optionalXout_foldX_count
    Given the modern graph
    And the traversal of
      """
      g.V().both().optional(__.out().fold()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A BRANCH emits its arms IN ORDER (BranchStep.java:123-158), and the set keeps the FIRST arrival's slot:
  # one start through `union(9, 5, 9)` arrives 9, 5, 9 and the barrier drains 9(2), 5. This spine does not
  # yet emit a branch in the reference's order (RelIR plan §10, cluster B), so every merge that would read
  # it refuses — behind the branch, inside a child that streams it, or where a merged order leaves through one.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_unionXconstantX9X_constantX5X_constantX9XX_barrier_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant(9), __.constant(5), __.constant(9)).barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[9].i,d[9].i,d[5].i] |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_unionXconstantX9X_constantX5X_constantX9XX_order_byXconstantX0XX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant(9), __.constant(5), __.constant(9)).order().by(__.constant(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[9].i,d[9].i,d[5].i] |

  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_localXunionXconstantX9X_constantX5X_constantX9XX_barrier_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.constant(9), __.constant(5), __.constant(9)).barrier().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[9].i,d[9].i,d[5].i] |

  # No two traversers are equal, but every one ties on the key: the stable sort keeps the arm order.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_VX1X_unionXconstantX9X_constantX5XX_order_byXconstantX0XX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant(9), __.constant(5)).order().by(__.constant(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[9].i,d[5].i] |

  # The order leaves THROUGH a branch: `union(identity())` re-emits the sorted stream one start at a time.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX3_2_3_1X_order_byXconstantX0XX_unionXidentityX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(3, 2, 3, 1).order().by(__.constant(0)).union(__.identity()).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[3].i,d[3].i,d[2].i,d[1].i] |

  # An arm holding a barrier runs ARM-major over its merged starts (BranchStep.java:87-88): 9(2), 5.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectX9_5_9X_unionXidentity_barrierX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(9, 5, 9).union(__.identity().barrier()).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[9].i,d[9].i,d[5].i] |

  # Where no two DIFFERENT traversers tie, the sort alone decides the order, whatever the arrival: answered.
  @gap:traverser-set-merge
  Scenario: g_V_unionXout_inX_order_byXnameX_valuesXnameX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.out(), __.in()).order().by('name').values('name').fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[josh,josh,josh,lop,lop,lop,marko,marko,marko,peter,ripple,vadas] |

  # EQUALITY IS TYPED: `AbstractTraverser.equals` is `Objects.equals(t, other.t)`
  # (vendor/tinkerpop/gremlin-core/.../traverser/util/AbstractTraverser.java:185-188), and an unsuffixed
  # `1.0` is a Double (GenericLiteralVisitor.java:490-511), so Integer 1 and Double 1.0 never share a slot
  # — at any merge (`typedEquality`, src/compiler/rel/build.ts). SQLite's PARTITION BY alone merged them.
  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1dX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1.0).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[1.0].d] |

  @gap:traverser-set-merge
  Scenario: g_injectX1d_2_1X_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject(1.0, 2, 1).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1.0].d |
      | d[2].i |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1dX_barrier_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1.0).barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[1.0].d] |

  @gap:traverser-set-merge
  Scenario: g_injectX1_2_1dX_order_byXconstantX0XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1.0).order().by(__.constant(0)).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[2].i,d[1.0].d] |

  # `Double.equals(-0.0, 0.0)` is false (it compares doubleToLongBits), so a signed zero keeps its slot.
  @gap:traverser-set-merge
  Scenario: g_injectXneg0d_2_0dX_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject(-0.0, 2, 0.0).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[-0.0].d |
      | d[2].i |

  # The same holds INSIDE a collection: `Map.equals` compares values, and `List.equals` members, with
  # `equals`. SQLite's JSON spells a negative zero `0.0`, so the literal tree and the JSON-entry authority
  # spell it `-0.0` (`stringifyExact`, src/json-exact.ts; `asExactReal`, src/compiler/rel/build.ts).
  @gap:traverser-set-merge
  Scenario: g_injectXmapXa_neg0dX_mapXa_2X_mapXa_0dXX_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject([a:-0.0], [a:2], [a:0.0]).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"a":"d[-0.0].d"}] |
      | m[{"a":"d[2].i"}] |

  @gap:traverser-set-merge
  Scenario: g_injectXmapXa_neg0dX_mapXa_2X_mapXa_0dXX_barrier_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([a:-0.0], [a:2], [a:0.0]).barrier().fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[m[{"a":"d[-0.0].d"}],m[{"a":"d[2].i"}],m[{"a":"d[0.0].d"}]] |

  @gap:traverser-set-merge
  Scenario: g_injectXlXneg0dX_lX2X_lX0dXX_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject([-0.0], [2], [0.0]).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[-0.0].d] |
      | l[d[2].i] |

  # `AbstractMap.equals` compares entries in NO order, so `[a:1,b:2]` and `[b:2,a:1]` share a slot.
  @gap:traverser-set-merge
  Scenario: g_injectXmapXa_1_b_2X_mapXc_3X_mapXb_2_a_1XX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject([a:1, b:2], [c:3], [b:2, a:1]).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[m[{"a":"d[1].i","b":"d[2].i"}],m[{"a":"d[1].i","b":"d[2].i"}],m[{"c":"d[3].i"}]] |

  # `List.equals` compares MEMBERS with `equals`, so `[1]` and `[1L]` are different traversers. A bare list
  # carries an Integer and a Long alike (its member type is inferred from the storage class), so a `[1L]`
  # literal declines rather than frame — and merge — as `[1]`.
  @gap:traverser-set-merge @Unsupported
  Scenario: g_injectXl1_l2_l1LX_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject([1], [2], [1L]).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i] |
      | l[d[2].i] |

  # A sack with no merge operator makes every traverser unequal to every other
  # (B_O_S_SE_SL_Traverser.java:131-156 `carriesUnmergeableSack`), so nothing merges, at any position.
  @gap:traverser-set-merge
  Scenario: g_withSackX1X_V_both_both_limitX4X_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().both().both().limit(4).sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  @gap:traverser-set-merge
  Scenario: g_withSackX1X_V_both_both_sackXsumX_byXconstantX1XX_sack_sum
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().both().both().sack(sum).by(__.constant(1)).sack().sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[60].i |
