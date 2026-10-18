Feature: mogwai addendum — a group VALUE body with a barrier is pooled PER KEY, or declines

  # `Grouping.determineBarrierStep` returns the value traversal's FIRST non-local Barrier — reducing
  # (`fold`/`count`/`sum`…), FILTERING (`dedup`, `range`/`limit`/`skip`/`tail` — DedupGlobalStep,
  # RangeGlobalStepContract and TailGlobalStepContract are FilteringBarriers), collecting (`order`,
  # `sample`) — and every traverser of a KEY runs into one pool before `doFinalReduction` runs the rest
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125).
  # Without a barrier the value is `Operator.assign` — the LAST traverser's.
  #
  # The lowering pools with `child.rows`, whose origin is the member ELEMENT, so a barrier inside the pool
  # runs per element: right only where the key IS the element. Every other key used to `dedup`/`limit`
  # each member alone, and a `fold()` body the pool could not serve fell through to the per-member assign
  # arm (`json_extract(…, '$[#-1]')`) and kept ONE member. Both now pool or decline (`groupRows`,
  # src/compiler/rel/map.ts). Each @Unsupported scenario carries the reference answer.

  # A RECORD member pools: its map is collected per key (was: one member per key).
  Scenario: g_V_group_byXlabelX_byXprojectXaX_byXageX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.project("a").by(__.values("age")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":[{"a":29},{"a":27},{"a":32},{"a":35}],"software":[{},{}]}] |

  Scenario: g_VX1X_out_group_byXlabelX_byXconstantXnullX_projectXkX_byXidentityX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant(null).project("k").by(__.identity()).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":[{"k":null},{"k":null}],"software":[{"k":null}]}] |

  # A dedup() straight before the fold() is restored per key, so the key's members dedup together.
  Scenario: g_VX1X_out_group_byXlabelX_byXconstantX1X_dedup_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant(1).dedup().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[d[1].i]","software":"l[d[1].i]"}] |

  # A FilteringBarrier before a reducer dedups ACROSS the key: josh and vadas share one `1`.
  @Unsupported
  Scenario: g_VX1X_out_group_byXlabelX_byXconstantX1X_dedup_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant(1).dedup().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[1].l","software":"d[1].l"}] |

  @Unsupported
  Scenario: g_VX1X_out_group_byXlabelX_byXconstantX1X_limitX1X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant(1).limit(1).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[d[1].i]","software":"l[d[1].i]"}] |

  @Unsupported
  Scenario: g_VX1X_out_group_byXlabelX_byXconstantX1X_rangeX0_1X_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant(1).range(0,1).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[1].l","software":"d[1].l"}] |

  # A key the pool cannot recompute from the member element (a sack is per TRAVERSER) cannot pool; the
  # assign arm would keep only the last member, so it declines.
  @Unsupported
  Scenario: g_withSackXkX_VX1X_out_group_bySack_byXname_order_foldX
    Given the modern graph
    And the traversal of
      """
      g.withSack("k").V(1).out().group().by(__.sack()).by(__.values("name").order().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"k":["josh","lop","vadas"]}] |

  # A sort nested in a value body's branch is lowered over the key's pooled members at once: the members
  # are the reference's, sorted together rather than per member (docs/feature-support-matrix.md §17).
  Scenario: g_V_group_byXlabelX_byXunionXout_order_byXname_descXX_valuesXnameX_isXneqXxXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.union(__.out().order().by("name",Order.desc)).values("name").is(P.neq("x")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,ripple,lop,lop,lop,josh]","software":"l[]"}] |

  Scenario: g_V_group_byXlabelX_byXunionXout_order_byXname_descX_limitX2XX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.union(__.out().order().by("name",Order.desc).limit(2)).values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,ripple,lop,lop,lop]","software":"l[]"}] |

  Scenario: g_V_out_group_by_byXunionXin_order_byXname_descXX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().out().group().by().by(__.union(__.in().order().by("name",Order.desc)).values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v[vadas]":"l[marko]","v[lop]":"l[peter,peter,peter,marko,marko,marko,josh,josh,josh]","v[josh]":"l[marko]","v[ripple]":"l[josh]"}] |

  Scenario: g_V_group_byXlabelX_byXrepeatXout_order_byXname_descXX_timesX1X_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.repeat(__.out().order().by("name",Order.desc)).times(1).values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,ripple,lop,lop,lop,josh]","software":"l[]"}] |

  # A PER-START host's sort is already per member, and the pool keeps it: exact.
  Scenario: g_V_group_byXlabelX_byXoptionalXout_order_byXname_descXX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.optional(__.out().order().by("name",Order.desc)).values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,lop,josh,vadas,ripple,lop,lop]","software":"l[lop,ripple]"}] |

  # An order-free reducer reads the pool as a multiset, which the member-scoped sort does not move: exact.
  Scenario: g_V_group_byXlabelX_byXunionXout_order_byXname_descXX_valuesXnameX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.union(__.out().order().by("name",Order.desc)).values("name").count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[6].l","software":"d[0].l"}] |
