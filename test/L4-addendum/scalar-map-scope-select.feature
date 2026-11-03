Feature: mogwai addendum — a map-valued property stream is the first scope select() reads

  # `Scoping.getScopeValue` asks the traverser's OWN Map first, then the side effects, then the path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # A stored map property read by `values('m')` is a per-row scalar stream whose rows MAY be Maps, so where
  # no other scope names `k` a `select(k)` over it reads the row's own `k` where the row is a Map holding
  # it, and otherwise drops the row (Select.feature:578-596).
  #
  # A `withSideEffect` constant, a path label (of any kind) or a named collection `k` WINS: it keeps its own
  # answer without reading the Map's key, so no row pays a per-row Map probe — a §17 divergence
  # (docs/feature-support-matrix.md, "Map scope"). A merge driven by such a select follows the same rule in
  # both spellings (`mergeV(__.select("k"))` and `select("k").mergeV()`): it merges by the side effect.

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
      | m[{"name":"se"}] |

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

  Scenario: g_withSideEffectXk_seX_V_valuesXmX_selectXkX_side_effect_wins
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
      | se |
      | se |

  # The side-effect constant can itself be a map, and it frames as one.
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
      | se |
      | se |

  # …and the side effect reaches every host the child seam has, not only a value that may be a Map.
  Scenario: g_withSideEffectXk_seX_V_whereXselectXkX_isXseXX_mapXselectXkXX_count
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", "se").V().where(__.select("k").is("se")).map(__.select("k")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

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

  # A MERGE driven by a stream of MAPS: each Map is the first scope its own option select("k") reads, but a
  # Map that cannot hold "k" has no such entry, so the side effect answers and the merge writes by it.
  Scenario: g_withSideEffectXk_mapX_injectXmapX_mergeV_optionXonCreate_selectXkXX_valueMap
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("k", ["age": 5]).inject(["name": "x"]).mergeV().option(Merge.onCreate, __.select("k")).valueMap()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name": ["x"], "age": [5]}] |

  # Where a Map MAY hold "k" beside a side effect "k", the answer depends on which rows hold it: the merge
  # declines naming the collision.
  Scenario: g_withSideEffectXk_mapX_injectXmap_with_kX_mergeV_optionXonCreate_selectXkXX_declines
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("k", ["age": 5]).inject(["k": 6], ["name": "x"]).mergeV().option(Merge.onCreate, __.select("k")).valueMap()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "a Map stream MAY hold 'k' and a side effect 'k' is declared"

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

  # A side-effect map merged over a value stream that may hold stored Maps: the named scope WINS, exactly as
  # the chain spelling `values("name").select("k").mergeV()` (the §17 "Map scope" line) — six merges by the side effect.
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
      | se |
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
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

  # Maps that MAY hold `a` beside a same-named label: a collision the query text names, so it declines (the
  # key fact is a MAY set only, so even maps sharing ONE key set are not read as holding it on every row).
  @Unsupported
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
    And the decline should say "is ambiguous here: each Map may hold a key 'a' and a path label 'a' is also bound"

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
