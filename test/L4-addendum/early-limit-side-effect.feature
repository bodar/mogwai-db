Feature: mogwai addendum — a SLICE after a SIDE EFFECT

  # `EarlyLimitStrategy` is a DEFAULT optimization that moves every `limit`/`range`/`skip` LEFT past each
  # `SideEffectStep` (`AddPropertyStep`, `AddLabelStep`, `TraversalSideEffectStep`) and each always-bound map
  # step (`AddVertexStep`, `IdentityStep`, `EdgeVertexStep` one-sided, …) to just after the last step that is
  # neither (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/EarlyLimitStrategy.java).
  # So the reference performs the side effect for the sliced traversers ONLY — `ir/early-limit.ts` makes the
  # same move. A keyed `groupCount("a")`/`group("a")` is a `SideEffectBarrierStep` at the pin, not a
  # `SideEffectStep`: the strategy stops at it and it counts EVERY traverser.
  #
  # A slice the strategy cannot move leaves the reference's LAZY pull — `RangeGlobalStep` stops pulling one
  # traverser past its bound (step/filter/RangeGlobalStep.java `filter`) — and a body read for its FIRST
  # result abandons the rest; the plan performs a side effect for the whole stream, so those DECLINE before
  # anything is written (@Unsupported pins the refusal; the expectation is the reference's).

  @gap:early-limit-side-effect
  Scenario: g_V_propertyXx_1X_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().property("x",1).limit(1)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"x\")"

  @gap:early-limit-side-effect
  Scenario: g_V_addLabelXzX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().addLabel("z").limit(2)
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 2 for count of "g.V().hasLabel(\"z\")"

  @gap:early-limit-side-effect
  Scenario: g_injectX1_2_3X_addVXnX_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(1,2,3).addV("n").limit(1)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"n\")"

  # A nested body is a traversal of its own: the strategy moves the slice to just after `__.V()`.
  @gap:early-limit-side-effect
  Scenario: g_VX1X_unionXV_propertyXx_1X_limitX2XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.V().property("x",1).limit(2))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 2 for count of "g.V().has(\"x\")"

  # A reducing barrier between them reads every traverser before the slice sees one.
  @gap:early-limit-side-effect
  Scenario: g_V_propertyXx_1X_fold_limitX1X_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().property("x",1).fold().limit(1).count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 6 for count of "g.V().has(\"x\")"

  @gap:early-limit-side-effect
  Scenario: g_V_groupCountXaX_byXlabelX_limitX1X_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount("a").by(T.label).limit(1).cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[4].l","software":"d[2].l"}] |

  @gap:early-limit-side-effect
  Scenario: g_V_groupXaX_byXlabelX_byXcountX_rangeX1_2X_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().group("a").by(T.label).by(__.count()).range(1,2).cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[4].l","software":"d[2].l"}] |

  # A movement between: marko is written, then his first neighbour fills the slice.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_propertyXx_1X_out_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().property("x",1).out().limit(1)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"x\")"

  # The strategy turned off: the lazy pull runs one traverser past the bound through the write.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_withoutStrategiesXEarlyLimitStrategyX_V_propertyXx_1X_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.withoutStrategies(EarlyLimitStrategy).V().property("x",1).limit(1)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().has(\"x\")"

  # A write in a filter body: `where` reads ONE result of `out().property(...)` — marko's first neighbour.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_VX1X_whereXout_propertyXx_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).where(__.out().property("x",1))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"x\")"

  # A SIDE EFFECT INSIDE A PER-TRAVERSER BODY. `local`/`map`/`flatMap` feed their body ONE start at a time
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java
  # `processNextStart`), and none of them is a step `EarlyLimitStrategy` crosses (`LocalStep` is an
  # `AbstractStep`; `TraversalMapStep`/`TraversalFlatMapStep` have no always-bound arity). So `limit(1)`
  # pulls two starts — the second only to find it is past the bound (RangeGlobalStep.java:72-82) — and the
  # body's `aggregate("a")` holds two members, never six. The plan splices `local(__.aggregate("a"))` into
  # the chain (`inlineIdentityHostBody`), where it would drain the whole stream, so these DECLINE.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXaggregateXaXX_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXaggregateXaXX_limitX2X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).limit(2).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_mapXaggregateXaXX_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.aggregate("a")).limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_flatMapXaggregateXaXX_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.aggregate("a")).limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # Only marko and vadas enter the body.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXgroupCountXaX_byXlabelXX_limitX1X_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.groupCount("a").by(T.label)).limit(1).cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[2].l"}] |

  # `select` reads the side effect lazily, when only marko has been aggregated.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXaggregateXaXX_limitX1X_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).limit(1).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # A collector DEEPER in the body is the same side effect, run per start: marko's three neighbours.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXout_aggregateXaXX_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().aggregate("a")).limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  # A write spliced out of `local` is not crossed by the strategy either: two starts are written.
  @gap:early-limit-side-effect
  @Unsupported
  Scenario: g_V_localXsideEffectXpropertyXx_1XXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.sideEffect(__.property("x",1))).limit(1)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().has(\"x\")"

  # What stays exact: one start cannot be cut short, no slice cuts nothing, and a global barrier after
  # the body pulls every start before the slice sees one.
  @gap:early-limit-side-effect
  Scenario: g_VX1X_localXaggregateXaXX_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.aggregate("a")).limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  @gap:early-limit-side-effect
  Scenario: g_V_localXaggregateXaXX_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:early-limit-side-effect
  Scenario: g_V_localXaggregateXaXX_fold_unfold_limitX1X_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).fold().unfold().limit(1).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
