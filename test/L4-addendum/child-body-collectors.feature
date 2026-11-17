Feature: mogwai addendum — a side effect collected inside a child traversal holds every host traverser's members

  # A child traversal runs once per host traverser (`TraversalUtil.apply`; `TraversalSideEffectStep`
  # drains its child and emits the traverser unchanged,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/TraversalSideEffectStep.java:46-49),
  # and the collection it fills is the ROOT's (`AggregateStep.java:57` resolves `getTraversal().getSideEffects()`),
  # so a collector in a body accumulates the body rows of EVERY host traverser into one collection. Both
  # `AggregateStep` (a `LocalBarrier`, AggregateStep.java:47) and the keyed `group`/`groupCount`
  # (`SideEffectBarrierStep`, which drains every start, SideEffectBarrierStep.java:49-57) drain the body, so a
  # first-row or filter host (`map`/`where`) still collects every body row. The connector keys the body and its
  # collector sites in one decorrelation (`keyedBody`, src/compiler/rel/lower/scoped.ts).

  @gap:child-body-collectors
  Scenario: g_V_sideEffectXout_aggregateXxXX_capXxX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().sideEffect(__.out().aggregate("x")).cap("x").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[vadas] |
      | v[josh] |
      | v[lop] |
      | v[lop] |
      | v[ripple] |
      | v[lop] |

  @gap:child-body-collectors
  Scenario: g_V_sideEffectXwhereXoutX_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().sideEffect(__.where(__.out()).aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:child-body-collectors
  Scenario: g_V_both_sideEffectXaggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().both().sideEffect(__.aggregate("x")).cap("x").unfold().count()
      """
    # Twelve traversers reach the body, each contributing itself once.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  @gap:child-body-collectors
  Scenario: g_V_sideEffectXout_groupCountXxX_byXnameXX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V().sideEffect(__.out().groupCount("x").by("name")).cap("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"vadas":"d[1].l", "josh":"d[1].l", "lop":"d[3].l", "ripple":"d[1].l"}] |

  @gap:child-body-collectors
  Scenario: g_V_localXout_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:child-body-collectors
  Scenario: g_withSideEffectXx_emptyX_V_sideEffectXout_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("x", []).V().sideEffect(__.out().aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:child-body-collectors
  Scenario: g_V_sideEffectXout_aggregateXxXX_propertyXseen_trueX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().sideEffect(__.out().aggregate("x")).property("seen", true).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:child-body-collectors
  Scenario: g_withSideEffectXa_1_2_3_assignX_V_order_byXageX_localXvaluesXageX_aggregateXaXX_capXaX
    Given the modern graph
    And the traversal of
      # `Aggregate.feature`'s per-traverser `assign` (the last traverser's members) with the collector behind a
      # value step, so the `local()` is a connector body rather than spliced away.
      """
      g.withSideEffect("a", [1i,2i,3i], Operator.assign).V().order().by("age").local(__.values("age").aggregate("a")).cap("a").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[35].i |

  @gap:child-body-collectors
  Scenario: g_withSideEffectXa_1_assignX_V_order_byXname_descX_localXout_aggregateXaX_byXnameXX_capXaX
    Given the modern graph
    And the traversal of
      # The LAST host with any body rows is josh, and `assign` keeps ALL of its body's members: one barrier per
      # host traverser, not per member.
      """
      g.withSideEffect("a", [1i], Operator.assign).V().order().by("name", desc).local(__.out().aggregate("a").by("name")).cap("a").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |

  @gap:child-body-collectors
  Scenario: g_V_sideEffectXout_sideEffectXout_aggregateXxXXX_capXxX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().sideEffect(__.out().sideEffect(__.out().aggregate("x"))).cap("x").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[ripple] |
      | v[lop] |

  @gap:child-body-collectors
  Scenario: g_V_whereXV_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      # The where() body runs once per host traverser and its aggregate drains V() each time.
      """
      g.V().where(__.V().aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[36].l |

  @gap:child-body-collectors
  Scenario: g_V_optionalXout_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:child-body-collectors
  Scenario: g_V_aggregateXxX_sideEffectXout_aggregateXxXX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().aggregate("x").sideEffect(__.out().aggregate("x")).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  @gap:child-body-collectors
  Scenario: g_V_mapXout_aggregateXxX_countX_capXxX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.out().aggregate("x").count()).cap("x").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
