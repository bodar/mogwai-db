Feature: mogwai addendum — a count over a nested branch counts every traverser, at every depth it is read

  # A count reads no emission order, so the branch under it merges positionless — and SQLite 3.51's
  # `countOfViewOptimization` (select.c) rewrites a literal `count(*)` over a `UNION ALL` derived table
  # into a sum of per-arm counts, which answers WRONG for a CORRELATED NESTED union: every start of
  # `local(union(constant(0), union(constant(9), in())).count())` read 2. The emitter spells an
  # argument-less count `count(1)` over anything but a lone base table (`countArgument`, src/rel/emit.ts),
  # which the rewrite never matches. Each scenario below is one depth the count can sit at: a per-start
  # body (local/map), a `by()` of a project, and an EXISTS gate (`where(… .count().is(n))`), over
  # union/coalesce/choose nested in a union. @gap:count-over-nested-branch marks the family.

  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXconstantX0X_unionXconstantX9X_in_valuesXnameXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.constant(0), __.union(__.constant(9), __.in().values("name"))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[3].l |
      | d[5].l |
      | d[3].l |
      | d[3].l |
      | d[2].l |

  @gap:count-over-nested-branch
  Scenario: g_V_out_localXunionXconstantX0X_unionXconstantX9X_in_valuesXnameXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().out().local(__.union(__.constant(0), __.union(__.constant(9), __.in().values("name"))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[5].l |
      | d[5].l |
      | d[5].l |
      | d[3].l |
      | d[3].l |

  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXconstantX0X_coalesceXin_valuesXnameX_constantX9XXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.constant(0), __.coalesce(__.in().values("name"), __.constant(9))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |
      | d[4].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |

  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXconstantX0X_chooseXhasLabelXpersonX_in_valuesXnameX_constantX9XXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.constant(0), __.choose(__.hasLabel("person"), __.in().values("name"), __.constant(9))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[1].l |

  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXidentity_unionXidentity_inXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.identity(), __.union(__.identity(), __.in())).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[3].l |
      | d[5].l |
      | d[3].l |
      | d[3].l |
      | d[2].l |

  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXunionXconstantX9X_in_valuesXnameXX_unionXconstantX9X_out_valuesXnameXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.union(__.constant(9), __.in().values("name")), __.union(__.constant(9), __.out().values("name"))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |
      | d[3].l |
      | d[5].l |
      | d[5].l |
      | d[3].l |
      | d[3].l |

  @gap:count-over-nested-branch
  Scenario: g_V_mapXunionXconstantX0X_unionXconstantX9X_in_valuesXnameXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.union(__.constant(0), __.union(__.constant(9), __.in().values("name"))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[3].l |
      | d[5].l |
      | d[3].l |
      | d[3].l |
      | d[2].l |

  @gap:count-over-nested-branch
  Scenario: g_V_projectXaX_byXunionXconstantX0X_unionXconstantX9X_in_valuesXnameXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().project("a").by(__.union(__.constant(0), __.union(__.constant(9), __.in().values("name"))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[2].l"}] |
      | m[{"a":"d[3].l"}] |
      | m[{"a":"d[5].l"}] |
      | m[{"a":"d[3].l"}] |
      | m[{"a":"d[3].l"}] |
      | m[{"a":"d[2].l"}] |

  @gap:count-over-nested-branch
  Scenario: g_V_out_whereXunionXconstantX0X_unionXconstantX9X_in_valuesXnameXXX_count_isX5XX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().out().where(__.union(__.constant(0), __.union(__.constant(9), __.in().values("name"))).count().is(5)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |

  @gap:count-over-nested-branch
  Scenario: g_V_whereXunionXidentity_unionXidentity_inXX_count_isXgtX3XXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.union(__.identity(), __.union(__.identity(), __.in())).count().is(P.gt(3))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  # A per-start body whose branch arm holds an `order()` (a merge-keyed sort) reads the per-start rows
  # unfenced: a fence is a named CTE, which cannot reference the start, and a correlated child declines on one
  # (`mergedOrder`, src/compiler/rel/lower.ts). The count reads no order; the fold reads the reference's.
  @gap:count-over-nested-branch
  Scenario: g_V_localXunionXflatMapXunionXout_order_byXname_descX_valuesXnameX_valuesXnameXXX_constantX0XX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.flatMap(__.union(__.out().order().by("name", Order.desc).values("name"), __.values("name"))), __.constant(0)).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |
      | d[2].l |
      | d[2].l |
      | d[4].l |
      | d[2].l |
      | d[3].l |

  @gap:count-over-nested-branch
  Scenario: g_V_hasLabelXpersonX_projectXpX_byXcoalesceXout_order_byXname_descX_valuesXnameX_constantX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").project("p").by(__.coalesce(__.out().order().by("name", Order.desc).values("name"), __.constant(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"p":"l[vadas,lop,josh]"}] |
      | m[{"p":"l[d[1].i]"}] |
      | m[{"p":"l[ripple,lop]"}] |
      | m[{"p":"l[lop]"}] |
