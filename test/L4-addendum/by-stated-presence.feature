Feature: mogwai addendum — a by() that STATES its presence keeps a productive null at order() and dedup()

  # A child body whose productivity is not its value's nullness states it (`{ when }`, `ChildValue.present`):
  # a map entry's value through `dedup()`/`limit(1)`, a re-sourced body's first value. Its NULL is a
  # PRODUCTIVE null — `OrderGlobalStep`/`DedupGlobalStep` keep the traverser where the comparator traversal
  # was productive (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderGlobalStep.java`,
  # `.../step/filter/DedupGlobalStep.java`), and `DedupGlobalStep.filter` keeps the first null — so it sorts
  # first and keys as one null, exactly as the bare `select(values)` does. It is landed ONCE per row as the
  # body's `{t,v}` node (`landedOnce`, `src/compiler/rel/modulator.ts`), and its presence is that node's.
  # A body that produced NOTHING still drops the traverser.

  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesX_dedupXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"a":null}] |
      | m[{"b":"d[1].i"}] |

  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"a":null}] |
      | m[{"b":"d[1].i"}] |

  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesX_dedup_descXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup(), Order.desc)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"b":"d[1].i"}] |
      | m[{"a":null}] |

  Scenario: g_injectXa_null_b_1_c_nullX_unfold_orderXbyXselectXvaluesX_limitX1XX_byXselectXkeysX_descX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1,'c':null]).unfold().order().by(__.select(values).limit(1)).by(__.select(keys), Order.desc)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"c":null}] |
      | m[{"a":null}] |
      | m[{"b":"d[1].i"}] |

  # `is(null)` keeps the null and filters the 1: the null entry is productive, the other is not.
  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesX_dedup_isXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup().is(P.eq(null)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null}] |

  Scenario: g_injectXa_null_b_1X_unfold_dedupXbyXselectXvaluesX_dedupXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().dedup().by(__.select(values).dedup())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null}] |
      | m[{"b":"d[1].i"}] |

  Scenario: g_injectXa_null_b_1X_unfold_dedupXbyXselectXvaluesXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().dedup().by(__.select(values))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null}] |
      | m[{"b":"d[1].i"}] |

  # Two null entries are ONE key, as two equal values are.
  Scenario: g_injectXa_null_b_1_c_null_d_1X_unfold_dedupXbyXselectXvaluesX_dedupXX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1,'c':null,'d':1]).unfold().dedup().by(__.select(values).dedup()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A RE-SOURCED body's first value, stated by an EXISTS over the rows it read: a null first value keeps
  # every traverser (one key for dedup); an EMPTY re-source produced nothing and drops them.
  Scenario: g_V_hasLabelXsoftwareX_orderXbyXV_hasXname_markoX_constantXnullXX_byXnameX_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").order().by(__.V().has("name","marko").constant(null)).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_hasLabelXsoftwareX_dedupXbyXV_hasXname_markoX_constantXnullXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").dedup().by(__.V().has("name","marko").constant(null)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_hasLabelXsoftwareX_orderXbyXV_hasXname_nobodyX_constantXnullXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").order().by(__.V().has("name","nobody").constant(null)).values("name")
      """
    When iterated to list
    Then the result should be empty
