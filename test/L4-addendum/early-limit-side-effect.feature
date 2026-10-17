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
