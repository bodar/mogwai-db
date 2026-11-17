Feature: mogwai addendum — where(P.within/without(<side effect>))

  # A `where(P)` operand is a SCOPE KEY, and `Scoping.getScopeValue` resolves it against the side effects
  # before the path labels; `within`/`without` over the collection it returns is membership
  # (WherePredicateStep `getSelectKey`'s "hack for within("x")" —
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java).
  # `aggregate` is a barrier, so the collection is complete before the filter reads it.

  Scenario: g_V_hasLabelXpersonX_aggregateXallX_outXknowsX_whereXwithinXallXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").aggregate("all").out("knows").where(P.within("all")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |

  Scenario: g_V_hasXname_markoX_outXcreatedX_aggregateXxX_inXcreatedX_outXcreatedX_whereXwithoutXxXX_groupCount_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").out("created").aggregate("x").in("created").out("created").where(P.without("x")).groupCount().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"ripple":"d[1].l"}] |

  # A collection of VALUES: membership is typed value equality.
  Scenario: g_V_hasXname_markoX_valuesXageX_aggregateXaX_V_valuesXageX_whereXwithoutXaXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").values("age").aggregate("a").V().values("age").where(P.without("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  # A vertex is never a member of a collection of edges.
  Scenario: g_V_outE_aggregateXeX_V_whereXwithinXeXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().outE().aggregate("e").V().where(P.within("e")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[0].l |

  # The same filter nested in a `not()` body.
  Scenario: g_V_hasXname_joshX_out_aggregateXxX_V_notXwhereXwithinXxXXX_dedup_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","josh").out().aggregate("x").V().not(__.where(P.within("x"))).dedup().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |

  # Membership is `GremlinValueComparator` equality (the `eq` every value compare uses): `1.0` is a member of
  # [1], `true` is not `1`. A member whose type is its value's own (an `inject`'s natural int) is typed by its
  # value, exactly as a subject is.
  Scenario: g_injectX1_a_trueX_aggregateXxX_fold_unfold_unionXconstantsX_whereXwithinXxXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, "a", true).aggregate("x").fold().limit(1).union(__.constant(1.0d), __.constant(true), __.constant(1), __.constant("b"), __.constant(2)).where(P.within("x"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1.0].d |
      | true |
      | d[1].i |

  Scenario: g_injectX1_a_trueX_aggregateXxX_fold_unfold_unionXconstantsX_whereXwithoutXxXX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, "a", true).aggregate("x").fold().limit(1).union(__.constant(1.0d), __.constant(true), __.constant(1), __.constant("b"), __.constant(2)).where(P.without("x"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | d[2].i |
