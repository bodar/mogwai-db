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

  # A VALUE FILTER in front of the reader (`is`/`where(is)`/`not(is)`) keeps a non-JSON row (`'text'`) in a
  # relation every arm reads behind its tag test. Each route reads that relation behind a HARD fence
  # (`fencedWhereSelfContained(…, hard)`), so the filter's `CASE … json(value)` never runs on a row the tag
  # test drops — flattened, it surfaced as a bare `malformed JSON`.
  Scenario: g_V_valuesXmX_isXneqXtextXX_countXlocalX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3]).addV("p").property("m", "text").addV("p").property("m", [7, 8, 9]).addV("p").property("m", 5)
      """
    And the traversal of
      """
      g.V().values("m").is(P.neq("text")).count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[1].l |
      | d[3].l |
      | d[1].l |

  Scenario: g_V_valuesXmX_whereXisXneqX5XXX_limitXlocal_1X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", "text").addV("p").property("m", [7, 8, 9]).addV("p").property("m", 5)
      """
    And the traversal of
      """
      g.V().values("m").where(__.is(P.neq(5))).limit(local, 1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"k":"d[1].i"}] |
      | text |
      | l[d[7].i] |

  Scenario: g_V_valuesXmX_notXisXtextXX_selectXk_xX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).addV("p").property("m", ["x": 3]).addV("p").property("m", "text").addV("p").property("m", [7, 8, 9])
      """
    And the traversal of
      """
      g.V().values("m").not(__.is("text")).select("k", "x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"k":"d[1].i", "x":"d[2].i"}] |

  Scenario: g_V_valuesXmX_isXneqXtextXX_selectXkeysX_raises_over_a_list_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", "text").addV("p").property("m", [7, 8])
      """
    And the traversal of
      """
      g.V().values("m").is(P.neq("text")).select(keys)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "does not have accessible keys"

  # The same filter-then-reader DOWNSTREAM OF A CLOSED WALK (an `emit()`/`until()` repeat lowers to a
  # `Recursive`). A whole walk binds its own reference, so it is self-contained and the reader's hard fence
  # still stands (`isSelfContained`, src/rel/walk.ts) — asking whether the input merely CONTAINS a walk
  # reference refused the fence and leaked a bare `malformed JSON` on the 'text' row.
  Scenario: g_V_emit_repeatXout_simplePathX_valuesXmX_isXneqXtextXX_countXlocalX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).as("a").addV("p").property("m", "text").as("b").addV("p").property("m", [7, 8, 9]).as("c").addV("p").property("m", 5).as("d").addE("e").from("a").to("b").addE("e").from("b").to("c").addE("e").from("c").to("d").addE("e").from("a").to("a").addE("e").from("a").to("c")
      """
    And the traversal of
      """
      g.V().emit().repeat(__.out().simplePath()).values("m").is(P.neq("text")).count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[3].l |
      | d[3].l |
      | d[3].l |
      | d[3].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  Scenario: g_V_repeatXout_simplePathX_emit_valuesXmX_isXneqXtextXX_limitXlocal_1X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).as("a").addV("p").property("m", "text").as("b").addV("p").property("m", [7, 8, 9]).as("c").addV("p").property("m", 5).as("d").addE("e").from("a").to("b").addE("e").from("b").to("c").addE("e").from("c").to("d").addE("e").from("a").to("a").addE("e").from("a").to("c")
      """
    And the traversal of
      """
      g.V().repeat(__.out().simplePath()).emit().values("m").is(P.neq("text")).limit(local, 1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[7].i] |
      | l[d[7].i] |
      | l[d[7].i] |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |

  Scenario: g_V_emit_repeatXout_simplePathX_valuesXmX_whereXisXneqXtextXXX_selectXk_xX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).as("a").addV("p").property("m", "text").as("b").addV("p").property("m", [7, 8, 9]).as("c").addV("p").property("m", 5).as("d").addE("e").from("a").to("b").addE("e").from("b").to("c").addE("e").from("c").to("d").addE("e").from("a").to("a").addE("e").from("a").to("c")
      """
    And the traversal of
      """
      g.V().emit().repeat(__.out().simplePath()).values("m").where(__.is(P.neq("text"))).select("k", "x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"k":"d[1].i", "x":"d[2].i"}] |

  Scenario: g_V_emit_repeatXout_simplePathX_valuesXmX_notXisXtextXX_tailXlocal_1X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1, "x": 2]).as("a").addV("p").property("m", "text").as("b").addV("p").property("m", [7, 8, 9]).as("c").addV("p").property("m", 5).as("d").addE("e").from("a").to("b").addE("e").from("b").to("c").addE("e").from("c").to("d").addE("e").from("a").to("a").addE("e").from("a").to("c")
      """
    And the traversal of
      """
      g.V().emit().repeat(__.out().simplePath()).values("m").not(__.is("text")).tail(local, 1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[2].i"}] |
      | l[d[9].i] |
      | l[d[9].i] |
      | l[d[9].i] |
      | l[d[9].i] |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
