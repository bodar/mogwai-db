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
