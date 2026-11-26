Feature: mogwai addendum — a nested-traversal operand compares only within its own type

  # `has(k, P.gt(<traversal>))` compares against the operand's FIRST value (`P.resolve`). Gremlin's ordering
  # predicates are COMPARABILITY: a pair of different types (a String and a Number, a Boolean and a Number) is
  # simply FALSE (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Compare.java`,
  # `.../util/GremlinValueComparator.java` `comparable`). SQLite orders every TEXT after every number, so
  # before the guard `P.gt(3)` from a traversal also matched the String rows '10' and 'x', and `P.lt('x')`
  # matched every number. The guard is a separate conjunct (`sameBucket`, `src/compiler/rel/predicate.ts`),
  # so the stored `(key, value)` range seek survives it. A stored operand reads its row's comparable
  # `value`; a stream operand converts by its tag, so a BigDecimal still equals itself.

  Background:
    Given the empty graph
    And the graph initializer of
      """
      g.addV("n").property("k", "a").property("s", "10").
        addV("n").property("k", "b").property("s", 10).
        addV("n").property("k", "c").property("s", 10.00M).
        addV("n").property("k", "d").property("s", "x").
        addV("n").property("k", "e").property("s", 3).
        addV("n").property("k", "f").property("s", true).
        addV("n").property("k", "h").property("s", 1)
      """

  Scenario: g_V_hasXs_gtXV_hasXk_eX_valuesXsXXX_number_operand
    And the traversal of
      """
      g.V().has("s", P.gt(__.V().has("k", "e").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | c |

  Scenario: g_V_hasXs_ltXV_hasXk_dX_valuesXsXXX_string_operand
    And the traversal of
      """
      g.V().has("s", P.lt(__.V().has("k", "d").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |

  Scenario: g_V_hasXs_gteXV_hasXk_fX_valuesXsXXX_boolean_is_not_a_number
    And the traversal of
      """
      g.V().has("s", P.gte(__.V().has("k", "f").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | f |

  Scenario: g_V_hasXs_lteXV_hasXk_hX_valuesXsXXX_number_is_not_a_boolean
    And the traversal of
      """
      g.V().has("s", P.lte(__.V().has("k", "h").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | h |

  Scenario: g_V_hasXk_eX_valuesXsX_asXxX_V_hasXs_gtXselectXxXXX_label_operand
    And the traversal of
      """
      g.V().has("k", "e").values("s").as("x").V().has("s", P.gt(__.select("x"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | c |

  Scenario: g_V_hasXk_eX_asXxX_V_hasXs_gtXselectXxX_valuesXsXXX_stored_operand_by_label
    And the traversal of
      """
      g.V().has("k", "e").as("x").V().has("s", P.gt(__.select("x").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | c |

  Scenario: g_V_whereXhasXs_ltXV_hasXk_dX_valuesXsXXXX_under_a_filter
    And the traversal of
      """
      g.V().where(__.has("s", P.lt(__.V().has("k", "d").values("s")))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |

  Scenario: g_V_notXhasXs_gtXV_hasXk_eX_valuesXsXXXX_incomparable_is_kept_by_not
    And the traversal of
      """
      g.V().not(__.has("s", P.gt(__.V().has("k", "e").values("s")))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | d |
      | e |
      | f |
      | h |

  Scenario: g_V_hasXs_eqXV_hasXk_cX_valuesXsXXX_decimal_operand_meets_numbers
    And the traversal of
      """
      g.V().has("s", P.eq(__.V().has("k", "c").values("s"))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |
      | c |

  Scenario: g_V_hasXs_eqXvaluesXsXXX_count_every_row_equals_itself
    And the traversal of
      """
      g.V().has("s", P.eq(__.values("s"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  # `where(P.not(…))` over a LABEL is the same boolean complement `has()`/`is()`/`not()` use: `P.not` is `NotP`,
  # whose test is `!original.test` (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/NotP.java:108`,
  # built by `P.negate`, `.../traversal/P.java:247`). So an incomparable pair — `gt` false — is KEPT by its
  # `P.not`, as the `not(has(…))` scenario above keeps it. An unbound label still drops the row first
  # (`WherePredicateStep.setPredicateValues`).
  Scenario: g_V_hasXk_eX_valuesXsX_asXxX_V_asXvX_valuesXsX_whereXnotXgtXxXXX_selectXvX_valuesXkX
    And the traversal of
      """
      g.V().has("k", "e").values("s").as("x").V().as("v").values("s").where(P.not(P.gt("x"))).select("v").values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | d |
      | e |
      | f |
      | h |

  Scenario: g_V_hasXk_eX_valuesXsX_asXxX_V_valuesXkX_whereXnotXgtXxXXX_count_strings_against_a_number
    And the traversal of
      """
      g.V().has("k", "e").values("s").as("x").V().values("k").where(P.not(P.gt("x"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  Scenario: g_injectXxX_asXaX_constantX1X_whereXnotXltXaXXX
    And the traversal of
      """
      g.inject("x").as("a").constant(1).where(P.not(P.lt("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_injectXnullX_asXaX_constantX1X_whereXnotXltXaXXX
    And the traversal of
      """
      g.inject(null).as("a").constant(1).where(P.not(P.lt("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_V_hasXk_eX_valuesXsX_asXxX_V_localXvaluesXsX_whereXnotXgtXxXXXX_count
    And the traversal of
      """
      g.V().has("k", "e").values("s").as("x").V().local(__.values("s").where(P.not(P.gt("x")))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  Scenario: g_V_asXaX_V_hasXk_eX_asXbX_whereXa_notXgtXbXXX_byXkX_selectXaX_valuesXkX_comparable_pairs
    And the traversal of
      """
      g.V().as("a").V().has("k", "e").as("b").where("a", P.not(P.gt("b"))).by("k").select("a").values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | b |
      | c |
      | d |
      | e |

  Scenario: g_V_hasXk_eX_asXxX_V_hasXs_notXgtXselectXxX_valuesXsXXXX_valuesXkX
    And the traversal of
      """
      g.V().has("k", "e").as("x").V().has("s", P.not(P.gt(__.select("x").values("s")))).values("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | d |
      | e |
      | f |
      | h |
