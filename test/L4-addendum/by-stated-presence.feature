Feature: mogwai addendum — a by() that STATES its presence still drops a null at order() and dedup()

  # A child body whose productivity is not its value's nullness states it (`{ when }`, `ChildValue.present`):
  # a map entry's value through `dedup()`, a re-sourced body's first value. Its null is ABSENT all the same
  # (`productivityFilter`, `src/compiler/rel/modulator.ts`; docs/feature-support-matrix.md §17 "A null `by()`
  # value"): `order()`/`dedup()` drop the traverser, as for every other null `by()` value. A deliberate
  # divergence from `OrderGlobalStep`/`DedupGlobalStep`, which keep a productive null
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/OrderGlobalStep.java`,
  # `.../step/filter/DedupGlobalStep.java`) — one SQL column per `by()` instead of a value plus presence pair.
  # The bare `select(values)` (and `limit(1)` over it) reads the entry's value side, which an entry always
  # has, so it keeps the null and sorts it first.

  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesX_dedupXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup())
      """
    When iterated to list
    Then the result should be ordered
      | result |
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

  # `is(null)` filters the 1 and the null is absent: nothing is left to order.
  Scenario: g_injectXa_null_b_1X_unfold_orderXbyXselectXvaluesX_dedup_isXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().order().by(__.select(values).dedup().is(P.eq(null)))
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_injectXa_null_b_1X_unfold_dedupXbyXselectXvaluesX_dedupXX
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1]).unfold().dedup().by(__.select(values).dedup())
      """
    When iterated to list
    Then the result should be unordered
      | result |
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

  # The two null entries drop; the two 1s are ONE key.
  Scenario: g_injectXa_null_b_1_c_null_d_1X_unfold_dedupXbyXselectXvaluesX_dedupXX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(['a':null,'b':1,'c':null,'d':1]).unfold().dedup().by(__.select(values).dedup()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # A RE-SOURCED body's first value: a null first value is absent and drops every traverser, as an EMPTY
  # re-source does.
  Scenario: g_V_hasLabelXsoftwareX_orderXbyXV_hasXname_markoX_constantXnullXX_byXnameX_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").order().by(__.V().has("name","marko").constant(null)).by("name").values("name")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_hasLabelXsoftwareX_dedupXbyXV_hasXname_markoX_constantXnullXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").dedup().by(__.V().has("name","marko").constant(null)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_hasLabelXsoftwareX_orderXbyXV_hasXname_nobodyX_constantXnullXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").order().by(__.V().has("name","nobody").constant(null)).values("name")
      """
    When iterated to list
    Then the result should be empty
