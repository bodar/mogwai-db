Feature: mogwai addendum — a per-row-typed stream whose rows may be collections re-enters the map/list readers

  # A map/list-valued stored property read by `values(k)` (or a side-effect constant read by `select(k)`)
  # is ONE stream whose rows are a Map on one row, a List on the next, a String on a third. The compound
  # readers dispatch on each traverser's RUNTIME class, so the answer is decided per row
  # (`perRowCollectionStep`, src/compiler/rel/lower.ts):
  # - count(local) — CountLocalStep: a Map's/Collection's size, else 1;
  # - limit/range/tail(local) — RangeLocalStep.applyRange: a window of the entries/members, anything else unchanged;
  # - select(keys|values) — Column.apply: a Map's side, else IllegalArgumentException (raised, never a drop);
  # - select(k1, k2) — the Map's own entries first; a row that is no Map, with no other scope, drops.

  Scenario: g_V_valuesXmX_countXlocalX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3]).addV("p").property("m", ["x": 4, "y": 5])
      """
    And the traversal of
      """
      g.V().values("m").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[1].l |
      | d[2].l |

  Scenario: g_V_valuesXlX_countXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", 9).addV("p").property("l", ["p"]).addV("p").property("l", [1, 2, 3]).addV("p").property("l", ["a": 1, "b": 2])
      """
    And the traversal of
      """
      g.V().values("l").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[3].l |
      | d[2].l |

  Scenario: g_V_valuesXmX_selectXkeysX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3]).addV("p").property("m", ["x": 4, "y": 5])
      """
    And the traversal of
      """
      g.V().values("m").select(keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[k,x] |
      | s[x] |
      | s[x,y] |

  Scenario: g_V_valuesXmX_selectXvaluesX_unfold
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3])
      """
    And the traversal of
      """
      g.V().values("m").select(values).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |
      | d[3].i |

  Scenario: g_V_valuesXnameX_selectXkeysX_raises
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("name", "a").addV("p").property("name", "b")
      """
    And the traversal of
      """
      g.V().values("name").select(keys)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "does not have accessible keys"

  Scenario: g_V_valuesXmX_selectXkeysX_count_raises_over_a_non_map_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", "text")
      """
    And the traversal of
      """
      g.V().values("m").select(keys).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "does not have accessible keys"

  Scenario: g_V_valuesXmX_selectXx_yX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", "text").addV("p").property("m", ["y": 5, "x": 4, "z": 6])
      """
    And the traversal of
      """
      g.V().values("m").select("x", "y")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[4].i", "y":"d[5].i"}] |

  Scenario: g_V_valuesXmX_limitXlocal_1X_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", "text").addV("p").property("m", [7, 8])
      """
    And the traversal of
      """
      g.V().values("m").limit(local, 1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"k":"d[1].i"}] |
      | text |
      | l[d[7].i] |

  Scenario: g_V_valuesXmX_tailXlocal_1X_fold
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2])
      """
    And the traversal of
      """
      g.V().values("m").tail(local, 1).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[m[{"x":"d[2].i"}]] |

  Scenario: g_withSideEffectXk_mapX_V_valuesXnameX_selectXkX_mapXcountXlocalXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("name", "a").addV("p").property("name", "b")
      """
    And the traversal of
      """
      g.withSideEffect("k", ["x": 1, "y": 2]).V().values("name").select("k").map(__.count(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |

  Scenario: g_V_valuesXmX_whereXcountXlocalX_isX2XX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3]).addV("p").property("m", "text")
      """
    And the traversal of
      """
      g.V().values("m").where(__.count(local).is(2)).select(keys)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[k,x] |
