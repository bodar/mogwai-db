Feature: mogwai addendum — a repeat() inside a filter body

  # The inline correlated predicate renderer (`predicateInlining`) is a nested-derived query with
  # no shared WITH, so it cannot host the recursive CTE a repeat() body needs — and its kernel
  # guard THREW rather than declining, while the materialized generic gate compiled the same body
  # fine. A fast path that throws where the generic path answers is a CAPABILITY switch, not an
  # optimization, which is the FastPath law (src/compiler/CLAUDE.md).
  #
  # Found by L5's fast-path differential once its seed began rotating per commit: nobody writes
  # `where(__.out().repeat(__.identity()).times(1))` by hand, and "compile the corpus with the flag
  # off and diff" — the check that caught the OTHER direction of this same law in 2026-07-27 —
  # structurally cannot see a shape the fast path claims and then fails.
  #
  # A repeat FIRST in the body never reached the inline renderer, which is why nothing caught this;
  # the scenarios below therefore all put a movement before it. `compileCorrelatedChild` now asks
  # `needsRecursiveCte` up front and declines to the materialized gate.
  @gap:repeat-in-filter-body

  # marko's out() is {vadas, josh, lop}; repeat(identity()).times(1) is the identity walk, so the
  # body is productive and marko survives.
  Scenario: g_VX1X_whereXout_repeatXidentityX_timesX1XX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).where(__.out().identity().repeat(__.identity()).times(1)).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  # filter() takes the same body through the same renderer.
  Scenario: g_VX1X_filterXout_repeatXidentityX_timesX1XX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).filter(__.out().repeat(__.identity()).times(1)).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  # not() is the negation: the body IS productive, so marko is dropped and nothing comes back.
  Scenario: g_VX1X_notXout_repeatXidentityX_timesX1XX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).not(__.out().repeat(__.identity()).times(1)).values('name')
      """
    When iterated to list
    Then the result should be empty

  # A walking body, not just the identity: out() then one more hop keeps every vertex that has an
  # out-neighbour with an out-neighbour — marko (via josh/lop? lop has none; josh -> ripple/lop).
  Scenario: g_V_whereXout_repeatXoutX_timesX1XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out().repeat(__.out()).times(1)).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
