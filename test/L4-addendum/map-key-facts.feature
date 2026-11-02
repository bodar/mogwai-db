Feature: mogwai addendum — a map's static key facts: `keys` MAY hold, `held` MUST hold

  # `select(k)` over a Map stream resolves `Scoping.getScopeValue`'s precedence — the traverser's own Map,
  # then the side effects, then the path labels
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # The compiler decides that on two compile-time facts per map stream (src/compiler/rel/framing.ts
  # `MapKeyFacts`): `keys`, the keys a row MAY hold (a too-narrow set skips a real entry), and `held`, the
  # keys EVERY row holds (a too-wide set drops a row the next scope answers). A branch merge MEETS them
  # (keys union, held intersection — `meetFraming`); a local entry slice re-states them (`slicedKeyFacts`).

  # A branch merge of map arms with DIFFERENT key sets: the merged stream may hold `b` (one arm does), so the
  # row lacking it reads the side effect. Before, the merge kept the FIRST arm's key set and read `7` twice.
  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa3X_constantXa1_b2XX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[2].i |

  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa1_b2X_constantXa3XX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 1, "b": 2]), __.constant(["a": 3])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[7].i |

  Scenario: g_withSideEffectXb_7X_V_chooseXhasLabelXpersonX_constantXa1_b2X_constantXa3XX_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("b", 7).V().choose(__.hasLabel("person"), __.constant(["a": 1, "b": 2]), __.constant(["a": 3])).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[2].i |
      | d[2].i |
      | d[2].i |
      | d[7].i |
      | d[7].i |

  # The merged facts ride an as() label too.
  Scenario: g_withSideEffectXb_7X_injectX1X_unionXconstantXa3X_constantXa1_b2XX_asXmX_selectXmX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 7).inject(1).union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).as("m").select("m").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[2].i |

  # The record-field twin: two record arms whose map-valued FIELD has different key sets. The meet recurses
  # through the record's fields, in either arm order.
  Scenario: g_withSideEffectXage_7X_V_hasLabelXpersonX_unionXprojectXmX_byXelementMapXnameXX_projectXmX_byXelementMapXname_ageXXX_selectXmX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("age", 7).V().hasLabel("person").union(__.project("m").by(__.elementMap("name")), __.project("m").by(__.elementMap("name", "age"))).select("m").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  Scenario: g_withSideEffectXage_7X_V_hasLabelXpersonX_unionXprojectXmX_byXelementMapXname_ageXX_projectXmX_byXelementMapXnameXXX_selectXmX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("age", 7).V().hasLabel("person").union(__.project("m").by(__.elementMap("name", "age")), __.project("m").by(__.elementMap("name"))).select("m").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  # A label bound in arms with different key sets: its history MEETS the facts too. `{a:1}` lacks `b` and
  # nothing else names `b`, so that row drops.
  Scenario: g_injectX1X_unionXconstantXa1X_asXxX_constantXa2_b3X_asXxXX_selectXxX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).union(__.constant(["a": 1]).as("x"), __.constant(["a": 2, "b": 3]).as("x")).select("x").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  # Literals sharing a key set HOLD it, so the map's entry answers every row ahead of the same-named label.
  Scenario: g_injectXa1_b2X_a3_b4X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[3].i |

  # A LOCAL ENTRY SLICE between a held producer and a same-named label: the window removes the key, so the
  # label answers (before: every row dropped). A literal's entry order is known, so the facts after the
  # window are exact and the label is read for every row.
  Scenario: g_injectXa1_b2X_a3_b4X_limitXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).limit(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | m[{"a":"d[3].i"}] |

  Scenario: g_injectXa1_b2X_a3_b4X_tailXlocal_1X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["a": 3, "b": 4]).tail(Scope.local, 1).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"d[2].i"}] |
      | m[{"b":"d[4].i"}] |

  Scenario: g_V_asXbX_constantXa1_b2X_limitXlocal_1X_selectXbX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").constant(["a": 1, "b": 2]).limit(Scope.local, 1).select("b").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |

  Scenario: g_withSideEffectXm_a1X_injectX1X_selectXmX_limitXlocal_0X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("m", ["a": 1]).inject(1).select("m").limit(Scope.local, 0).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |

  Scenario: g_injectXa1_b2X_rangeXlocal_1_2X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2]).range(Scope.local, 1, 2).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"d[2].i"}] |

  # The window keeps `b`, so the map still holds it and answers ahead of the label.
  Scenario: g_injectXa1_b2X_skipXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2]).skip(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # The same facts decide the label read inside a child body (an enclosing label) and behind math().
  Scenario: g_V_asXbX_localXconstantXa1_b2X_limitXlocal_1X_selectXbXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").local(__.constant(["a": 1, "b": 2]).limit(Scope.local, 1).select("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_valuesXageX_asXbX_constantXa1_b2X_limitXlocal_1X_mathXbX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").as("b").constant(["a": 1, "b": 2]).limit(Scope.local, 1).math("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29.0].d |
      | d[27.0].d |
      | d[32.0].d |
      | d[35.0].d |

  # A key some rows MAY hold behind a same-named label: the rows lacking it read the label, which is an
  # element-or-value stream this route cannot frame yet — so the query declines rather than drop them.
  @Unsupported
  Scenario: g_V_asXageX_elementMapXageX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").elementMap("age").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
      | v[lop] |
      | v[ripple] |

  # Literals whose entry ORDERS differ are not exact, so a slice spends `held` and the label select declines.
  @Unsupported
  Scenario: g_injectXa1_b2X_b3_a4X_limitXlocal_1X_asXbX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1, "b": 2], ["b": 3, "a": 4]).limit(Scope.local, 1).as("b").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | d[3].i |

  # EVERY map-first reader reads the facts through the one `mapKeyPresence`, not the chain select alone. After
  # a merge `b` is a key some rows only MAY hold; `format('%{b}')` reads the path label `b` for a row lacking it
  # (`FormatStep` → `getNullableScopeValue`), and reading the entry would DROP that row — so it declines.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b2XX_formatXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).format("%{b}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 10 |
      | 2 |

  @Unsupported
  Scenario: g_V_asXbX_unionXconstantXa3X_constantXa1_b2XX_formatXbX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).format("%{b}").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  # A key EVERY row holds answers from the entry even with a same-named label behind it.
  Scenario: g_injectX10X_asXbX_unionXconstantXa3_b5X_constantXa1_b2XX_formatXa_bX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3, "b": 5]), __.constant(["a": 1, "b": 2])).format("%{a}-%{b}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 3-5 |
      | 1-2 |

  # A keyed dedup over a merged map stream: `{a:3}` keys on its label `b` (10) and `{a:1,b:10}` on its entry
  # (10), so the two collide (`DedupGlobalStep` keys on `getSafeScopeValue`). An entry and a VALUE label
  # side by side never collide, so this declines rather than keep the duplicate — in either arm order.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b10XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 10])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa1_b10X_constantXa3XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 1, "b": 10]), __.constant(["a": 3])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # Every row holds `b`, so the entry is every row's key.
  Scenario: g_injectX10X_asXbX_unionXconstantXa3_b10X_constantXa1_b10XX_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3, "b": 10]), __.constant(["a": 1, "b": 10])).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # A by(select(k)) child body over a map host reads the same facts: the row lacking `b` reads the label.
  @Unsupported
  Scenario: g_injectX10X_asXbX_unionXconstantXa3X_constantXa1_b2XX_projectXxX_byXselectXbXX
    Given the empty graph
    And the traversal of
      """
      g.inject(10).as("b").union(__.constant(["a": 3]), __.constant(["a": 1, "b": 2])).project("x").by(__.select("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[10].i"}] |
      | m[{"x":"d[2].i"}] |

  # A label read behind a local slice of a record, after a keyed dedup: the label is outside the sliced
  # key set, so it answers from the path (the element re-entry is an ordered primary-key probe).
  Scenario: g_V_asXxX_out_asXyX_selectXx_yX_dedupXxX_limitXlocal_1X_selectXyX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").out().as("y").select("x", "y").dedup("x").limit(Scope.local, 1).select("y").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
