Feature: mogwai addendum — a group value body's PRODUCTIVE null is a member, not an absence

  # `GroupStep` pools every value a value traversal PRODUCES, and a null is a produced value
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:108-123
  # `produce` → `TraversalProduct`; Grouping.java:74-125). The value lowering once read a NULL member as an
  # UNPRODUCTIVE one — the pooled fold() dropped it together with its empty-group seed — so
  # `group().by().by(__.constant([1,null,2]).unfold().fold())` answered [1,2] for [1,null,2].
  #
  # Presence is now carried APART from the value (`ChildValue.present`, src/compiler/rel/child.ts): a pooled
  # child ROW is a produced traverser whatever its value, so its member node is a `{t, v:null}` node for a null
  # and only the seed row (the one that produced nothing) is the SQL NULL the aggregate's FILTER drops
  # (`producedMemberNode`, src/compiler/rel/modulator.ts). Each scenario is the reference's answer.

  Scenario: g_VX1X_group_by_byXconstantXlist_1_null_2X_unfold_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([1,null,2]).unfold().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[d[1].i,null,d[2].i]"}] |

  Scenario: g_VX1X_group_by_byXunionXconstantXnullX_constantX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.union(__.constant(null), __.constant(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null,d[1].i]"}] |

  # `CoalesceStep` answers with the first arm that HAS a result, and a null is one — so the fallback never runs.
  Scenario: g_VX1X_group_by_byXcoalesceXconstantXnullX_constantX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.coalesce(__.constant(null), __.constant(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null]"}] |

  # A null-only pool is a list of nulls, not the empty list a body that produced nothing folds to.
  Scenario: g_V_group_byXlabelX_byXconstantXnullX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.constant(null).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null,null,null,null]","software":"l[null,null]"}] |

  # A null member survives the pool's own dedup() and order() — and a null orders FIRST.
  Scenario: g_VX1X_group_by_byXconstantXlist_null_1_nullX_unfold_dedup_order_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([1,null,1,null]).unfold().dedup().order().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null,d[1].i]"}] |

  # A reducer SKIPS null (`NumberHelper.max`/`SumGlobalStep`), and an all-null sum is null.
  Scenario: g_VX1X_group_by_byXconstantXlist_null_1X_unfold_maxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([null,1]).unfold().max())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[1].i"}] |

  Scenario: g_VX1X_group_by_byXconstantXlist_null_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([null,null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":null}] |

  # The side-effect form reaches the same pool.
  Scenario: g_VX1X_groupXmX_by_byXunionXconstantXnullX_constantX1XX_foldX_capXmX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group("m").by(T.label).by(__.union(__.constant(null), __.constant(1)).fold()).cap("m")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null,d[1].i]"}] |

  # A LIST-framed pooled member (the payload column is `list`, not `v`) is one member — this was an
  # internal error before the payload column came from the framing.
  Scenario: g_VX1X_group_by_byXconstantXlist_null_1X_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([null,1]).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[l[null,d[1].i]]"}] |

  Scenario: g_VX1X_group_by_byXconstantXnullX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant(null).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[1].l"}] |

  # `coalesce()` as a CHILD VALUE answers with the first arm that PRODUCED — a productive null sack is that
  # arm's answer, and the constant fallback never runs (`CoalesceStep`; `ProjectStep.java:66` keeps the key).
  Scenario: g_withSackXnullX_VX1X_project_byXcoalesceXsack_constantX1XXX
    Given the modern graph
    And the traversal of
      """
      g.withSack(null).V(1).project("x").by(__.coalesce(__.sack(), __.constant(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |
