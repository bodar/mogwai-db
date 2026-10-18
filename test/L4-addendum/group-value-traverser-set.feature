Feature: mogwai addendum — a group value's FilteringBarrier reads a merged TraverserSet, not the arrival stream

  # `Grouping.determineBarrierStep` makes the value traversal's first non-local `Barrier` the group's
  # barrier (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-86).
  # A slice there (`range`/`limit`/`skip`/`tail`) gathers its starts with `nextBarrier` into a
  # `TraverserSet`, which MERGES equal traversers at the first one's place
  # (.../step/filter/RangeGlobalStepContract.java:95-103), and combines a key's members through
  # `RangeBiOperator`, which stops adding once the key holds `high` distinct traversers
  # (.../step/filter/RangeGlobalStep.java:220-238). The pool here is the un-merged arrival stream, so a
  # body with repeated values answered `[1,2,1]` for `[1,1,2]`. The pool's answer IS the reference's where
  # equal values arrive adjacent, where the cut keeps every row (then only the ORDER moves, restated by first
  # arrival), and where a key holds one traverser; anywhere else it DEFERS at run time (`poolMergeGuard`,
  # src/compiler/rel/map.ts). `by(tail())` — the same `RangeBiOperator(1)` — keeps the key's FIRST arrival.

  # The cut keeps all three: the merge only moves the second `person` up beside the first.
  Scenario: g_V_hasXname_markoX_group_by_byXout_label_tailX10X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.out().label().tail(10).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[person,person,software]"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_limitX3X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().limit(3).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[d[1].i,d[1].i,d[2].i]"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_tailX2X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().tail(2).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[d[2].i,d[3].i]"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_skipX1X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().skip(1).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[d[1].i,d[2].i,d[3].i]"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1X_unfold_limitX2X_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1]).unfold().limit(2).sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"d[2].i"}] |

  # The first-traverser window reads the same traverser merged or not, so it keeps answering.
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1X_unfold_limitX1X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1]).unfold().limit(1).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[d[1].i]"}] |

  # `RangeBiOperator(1)` keeps the key's first arrival: marko, not peter.
  Scenario: g_V_hasLabelXpersonX_group_byXlabelX_byXtailX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by(T.label).by(__.tail())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"v[marko]"}] |

  # The merge is on the traverser the CUT reads, and `EarlyLimitStrategy` runs on the value traversal too:
  # it moves the `RangeGlobalStep` ahead of the always-bound `label()` map
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/EarlyLimitStrategy.java:68-98,
  # .../strategy/util/StepOutputArityPredictor.java — `LabelStep` is DEFINITELY_SINGULAR), and
  # `resetBarrierFromValueTraversal` re-finds the barrier after strategies
  # (.../traversal/util/DefaultTraversal.java:155). So `out().label().limit(2)` cuts the three DISTINCT
  # vertices, not the labels, and nothing merges: marko keeps his first two out-neighbours' labels.
  Scenario: g_V_hasXname_markoX_group_by_byXout_label_limitX2X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.out().label().limit(2).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[person,software]"}] |

  # Without the strategy the cut reads the LABELS, merged — `[person, person]`, which the pool cannot state.
  @Unsupported
  Scenario: g_withoutStrategiesXEarlyLimitStrategyX_V_hasXname_markoX_group_by_byXout_label_limitX2X_foldX
    Given the modern graph
    And the traversal of
      """
      g.withoutStrategies(EarlyLimitStrategy).V().has("name","marko").group().by().by(__.out().label().limit(2).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"l[person,person]"}] |

  # A `count()` straight after the cut reads no member: `RangeGlobalStep` trims a merged slot's BULK
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/RangeGlobalStep.java:73-120),
  # so it keeps the same NUMBER of units however equal traversers were merged — `[1,1,2]` and `[1,2,1]` both
  # count 3. The merge guard is narrowed to the several-traversers-per-key case there (`poolMergeGuard`'s
  # `counted`, src/compiler/rel/map.ts); a `sum()` reads WHICH units survive and keeps the whole guard.
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_limitX3X_countX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().limit(3).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"d[3].l"}] |

  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_rangeX1_3X_countX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().range(1,3).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"d[2].l"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_by_byXconstantXl1_2_1_3X_unfold_limitX3X_isX1X_countX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by().by(__.constant([1,2,1,3]).unfold().limit(3).is(1).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[marko]":"d[2].l"}] |
