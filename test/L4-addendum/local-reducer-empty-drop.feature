Feature: mogwai addendum — a NON-SEEDED reducer in local()/map() DROPS the empty-child traverser

  # `sum`/`mean`/`min`/`max` emit NOTHING over zero starts — `SumGlobalStep` (and Mean/Min/Max) override
  # `processAllStarts` to preserve `ReducingBarrierStep`'s NON_EMITTING_SEED when `!starts.hasNext()`
  # (vendor/tinkerpop/gremlin-core/.../step/map/SumGlobalStep.java:65-69), UNLIKE `count`→0 /
  # `fold`→[] which seed unconditionally. So `local(__.outE().values('weight').sum())` on a vertex with
  # no out-edges produces NO traverser — that vertex drops out of the result entirely.
  #
  # In our lowering this is a per-host correlated scalar, so a NULL subquery result is
  # indistinguishable from "one row whose value is NULL" (TraversalProduct: a productive null is a
  # value) — the productivity must be carried as its own EXISTS over the rows feeding the reducer, the
  # same signal the min/max argmax arm already computed. Before this, min/max worked in local() but
  # sum/mean declined for want of that `present`. The fan-out rejoin authority plan
  # (docs/2026-09-05-fan-out-rejoin-authority-plan.md §7 C3) owns it.

  # ---- sum: three vertices have out-edges (marko/josh/peter); vadas/lop/ripple drop ----

  Scenario: g_V_localXoutE_valuesXweightX_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.outE().values("weight").sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.9].d |
      | d[1.4].d |
      | d[0.2].d |

  # ---- map() has the SAME empty-drop policy (an unproductive body drops the traverser) ----

  Scenario: g_V_mapXoutE_valuesXweightX_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.outE().values("weight").sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.9].d |
      | d[1.4].d |
      | d[0.2].d |

  # ---- mean: same three survivors, per-vertex mean of the outgoing weights ----

  Scenario: g_V_localXoutE_valuesXweightX_meanX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.outE().values("weight").mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.6333333333333333].d |
      | d[0.7].d |
      | d[0.2].d |

  # ---- min/max in local() were already correct (argmax arm); pin them against regression ----

  Scenario: g_V_localXoutE_valuesXweightX_minX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.outE().values("weight").min())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.4].d |
      | d[0.4].d |
      | d[0.2].d |

  Scenario: g_V_localXoutE_valuesXweightX_maxX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.outE().values("weight").max())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |
      | d[1.0].d |
      | d[0.2].d |

  # ---- the empty-drop is observable through a downstream consumer too: where() over the sum ----

  Scenario: g_V_whereXoutE_valuesXweightX_sum_isXgtX1XXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.outE().values("weight").sum().is(P.gt(1.0))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
