Feature: mogwai addendum — a map-valued property stream is the first scope select() reads

  # `Scoping.getScopeValue` asks the traverser's OWN Map first, then the side effects, then the path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # A stored map property read by `values('m')` is a per-row scalar stream whose rows MAY be Maps, so a
  # `select(k)` over it reads the row's own `k` where the row is a Map holding it, and otherwise the
  # `withSideEffect` constant `k` — or, with no scope holding `k`, drops the row (Select.feature:578-596).
  # Before: the side-effect map answered over a Map holding `k` (wrong), and the other forms declined.
  #
  # A path label (of any kind) or a named collection `k` keeps its own answer without reading the Map's
  # key — a path-label read stays a column read (scope-label-next.feature), a §17 divergence
  # (docs/feature-support-matrix.md, "Map-valued property stream").

  Scenario: g_withSideEffectXk_mapX_VX1X_propertyXm_mapX_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": "mm"])
      """
    And the traversal of
      """
      g.withSideEffect("k", ["name": "se"]).V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | mm |

  Scenario: g_V_valuesXmX_selectXkX_no_scope
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": "mm"]).addV("p").property("m", ["j": "other"]).addV("p").property("m", "text")
      """
    And the traversal of
      """
      g.V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | mm |

  Scenario: g_withSideEffectXk_seX_V_valuesXmX_selectXkX_falls_through
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["j": 1]).addV("p").property("m", ["k": "mm"]).addV("p").property("m", 7)
      """
    And the traversal of
      """
      g.withSideEffect("k", "se").V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | se |
      | mm |
      | se |

  # The side-effect constant can itself be a map: it frames as a map where the row is no Map holding k.
  Scenario: g_withSideEffectXk_mapX_V_valuesXmX_selectXkX_map_fallback
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.withSideEffect("k", ["name": "se"]).V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":"se"}] |

  # Depth: the same scope order inside a per-traverser body, and a nested map read through two selects.
  Scenario: g_withSideEffectXk_seX_V_valuesXmX_mapXselectXkXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": "mm"]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.withSideEffect("k", "se").V().values("m").map(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | mm |
      | se |

  Scenario: g_V_valuesXmX_localXselectXkX_selectXjXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": ["j": "deep"]]).addV("p").property("m", ["k": "flat"])
      """
    And the traversal of
      """
      g.V().values("m").local(__.select("k").select("j"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | deep |

  Scenario: g_V_valuesXmX_selectXkX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["k": 2]).addV("p").property("m", ["x": 3])
      """
    And the traversal of
      """
      g.V().values("m").select("k").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A MERGE driven by an injected map literal: its static key set lacks "k", so the onCreate select("k")
  # reads past the Map to the side effect exactly as over a non-Map traverser.
  Scenario: g_withSideEffectXk_mapX_injectXmapX_mergeV_optionXonCreate_selectXkXX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("k", ["age": 5]).inject(["name": "x"]).mergeV().option(Merge.onCreate, __.select("k")).valueMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":["x"],"age":[5]}] |

  # A path label keeps its own answer over a value stream — no per-row Map probe (the §17 line).
  Scenario: g_V_asXaX_valuesXnameX_selectXaX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").values("name").select("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A side-effect map merged over a value stream still folds (no decline) — the regression guard.
  Scenario: g_withSideEffectXk_mapX_V_valuesXnameX_mergeVXselectXkXX_count
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", ["name": "se"]).V().values("name").mergeV(__.select("k")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A Map holding `k` -> null is a PRODUCTIVE null: SelectOneStep splits a null traverser
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java:62).
  # The chain and every child form agree; only a row with no scope holding `k` drops.
  Scenario: g_V_valuesXmX_mapXselectXkXX_null_entry
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": null]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.V().values("m").map(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_valuesXmX_flatMapXselectXkXX_count_null_entry
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": null]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.V().values("m").flatMap(__.select("k")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_valuesXmX_chooseXselectXkX_constantXyX_constantXnXX_null_entry
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": null]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.V().values("m").choose(__.select("k"), __.constant("y"), __.constant("n"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | y |
      | n |

  Scenario: g_withSideEffectXk_seX_V_valuesXmX_localXselectXkXX_null_entry
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": null]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.withSideEffect("k", "se").V().values("m").local(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | se |

  # A body continuing past the select sees the null entry as a null traverser; a row with no scope
  # holding `k` never reaches the body (so `math()` there cannot raise over it).
  Scenario: g_V_valuesXmX_mapXselectXkX_constantXxXX_null_entry
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": null]).addV("p").property("m", ["j": 1])
      """
    And the traversal of
      """
      g.V().values("m").map(__.select("k").constant("x"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |

  # An inject of maps with DIFFERENT key sets: a row lacking `a` falls through to the path label `a`
  # (Scoping.java:119-135), a map-or-label value per row — declined rather than drop the second row.
  @Unsupported
  Scenario: g_injectXa1_b2X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1], ["b": 2]).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | m[{"b":2}] |

  # Maps sharing ONE key set hold `a` in every row, so the Map answers and the label never does.
  Scenario: g_injectXa1_a2X_asXaX_selectXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1], ["a": 2]).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  # Without a label, a row lacking the key has no scope holding it and drops.
  Scenario: g_injectXa1_b2X_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1], ["b": 2]).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_V_valuesXmX_mapXselectXkX_mathX_plus1XX_absent_key_never_raises
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["j": null]).addV("p").property("m", ["k": 3])
      """
    And the traversal of
      """
      g.V().values("m").map(__.select("k").math("_+1"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4.0].d |
