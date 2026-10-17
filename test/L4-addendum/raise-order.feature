Feature: mogwai addendum — a raise is met BEFORE the filter after it, and where FilterRankingStrategy puts it

  # The reference evaluates a step on each traverser before the step after it sees that traverser
  # (step/filter/FilterStep.java processNextStart), so a filter AFTER a raising map step never gets the
  # chance to drop the row first: `g.inject(1).toUpper().is('x')` raises. SQL fixes no evaluation order
  # inside a statement — SQLite splits a WHERE on AND, codes a constant term once before the scan, and
  # evaluates the rest in the order its planner picks — so a raise test and the filter above it, fused
  # into one WHERE, used to answer []. The emitter now fuses a filter over a raising one IN ORDER, as one
  # CASE term (conjoinInOrder, src/rel/emit.ts), and raiseOrdered (src/compiler/rel/raise-channel.ts)
  # declines every plan that ordering cannot reach (a constant-false filter over a raise skips the scan).
  #
  # FilterRankingStrategy reorders a run of filters by rank before any of this
  # (strategy/optimization/FilterRankingStrategy.java getStepRank: is 1, has 2, a traversal filter 4, …,
  # order 10), at every depth. A raising filter the strategy moves meets different traversers than the
  # written order would hand it, so the lowering declines it (filterRankingMoves): the expectations below
  # are the reference's, tagged @Unsupported until the reorder is modelled.

  Scenario: g_injectX1X_toUpper_isXxX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().is("x")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_toUpper_isXeqXxXX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().is(P.eq("x")).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_toUpper_isXgtXaXX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().is(P.gt("a")).fold()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_toUpper_whereXisXxXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().where(__.is("x"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_asXaX_selectXaX_toUpper_isXxX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).as("a").select("a").toUpper().is("x")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_unionXtoUpper_isXxX_constantX2XX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).union(__.toUpper().is("x"), __.constant(2))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1X_length_isX5X
    Given the empty graph
    And the traversal of
      """
      g.inject(1).length().is(5)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The length() step can only take string as argument"

  Scenario: g_V_valuesXageX_toUpper_isXxX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").toUpper().is("x")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectX1_2X_mathXdiv0X_isX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2).math("_ / 0").is(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Division by zero!"

  # A clean stream still filters.
  Scenario: g_V_valuesXnameX_toUpper_isXMARKOX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").toUpper().is("MARKO")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | MARKO |

  # A statically empty predicate is a constant FALSE term SQLite codes once and skips the scan with, so
  # the raise beneath is never met; the lowering declines rather than answer [].
  @Unsupported
  Scenario: g_injectX1X_toUpper_isXwithinXXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().is(P.within())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # has() is written FIRST, rank 2 before where()'s 4: nothing moves, and only lop reaches the body.
  Scenario: g_V_hasXname_lopX_whereXvaluesXageX_toUpper_foldX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "lop").where(__.values("age").toUpper().fold()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  # hasId() is ranked ahead of where(): it runs first, so the raising body only ever sees v[3].
  @Unsupported
  Scenario: g_V_whereXvaluesXageX_toUpper_foldX_hasIdX3X
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.values("age").toUpper().fold()).hasId(3)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[lop] |

  @Unsupported
  Scenario: g_V_asXaX_whereXvaluesXageX_toUpper_foldX_hasXname_rippleX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").where(__.values("age").toUpper().fold()).has("name", "ripple").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[ripple] |

  # The strategy applies to every child traversal too.
  @Unsupported
  Scenario: g_V_localXwhereXvaluesXageX_toUpper_foldX_hasXname_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.where(__.values("age").toUpper().fold()).has("name", "lop"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[lop] |

  @Unsupported
  Scenario: g_V_unionXwhereXvaluesXageX_toUpper_foldX_hasXname_lopXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.where(__.values("age").toUpper().fold()).has("name", "lop"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[lop] |
