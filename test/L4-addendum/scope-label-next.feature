Feature: mogwai addendum — a path label beside a traverser's own Map is read as the label

  # `Scoping.getScopeValue` asks the traverser's OWN Map first, then the side effects, then the path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # Where the traverser MAY be a Map (a stored map property read by `values('m')`) and a path label of the
  # same name is live, mogwai reads the LABEL on every row: a path-label read is a column read, never a
  # per-row probe of the stream for a Map holding the key. A stored Map's own `k` is therefore not read
  # there — a deliberate divergence (docs/feature-support-matrix.md §17, "Map scope" and "Map-valued
  # property stream"). Where the key only MAY be in a map or record stream's own keys, the read DECLINES
  # instead: the query text names the collision, and reading either scope alone would drop rows.

  # --- a per-row scalar stream behind a VALUE label: the label answers every row ---

  Scenario: g_V_constantX7X_asXkX_V_valuesXmX_mathXk_plus_1X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.V().constant(7).as("k").V().values("m").math("k + 1")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |

  # math()'s variable reads a side-effect constant the same way: no per-row Map probe.
  Scenario: g_withSideEffectXk_5X_V_valuesXmX_mathXk_plus_1X
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.withSideEffect("k", 5).V().values("m").math("k + 1")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6.0].d |
      | d[6.0].d |
      | d[6.0].d |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  # The same reader at depth: map(), local(), flatMap(), a where() body, and math() inside map().
  Scenario: g_injectX7X_asXkX_V_valuesXmX_mapXselectXkXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").map(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_localXselectXkXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").local(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_flatMapXselectXkXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").flatMap(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_whereXselectXkX_isX7XX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").where(__.select("k").is(7)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_mapXmathXk_times_10XX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").map(__.math("k * 10"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[70.0].d |
      | d[70.0].d |
      | d[70.0].d |

  # A label bound in ONE union arm: the arm that never bound it drops.
  Scenario: g_injectX1X_unionXconstantX7X_asXkX_identityX_V_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(1).union(__.constant(7).as("k"), __.identity()).V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].i |
      | d[7].i |

  # With no label or side effect of that name the stream's own Map is the only scope; a row it does not hold
  # `k` for drops (Select.feature:578-596). A side-effect constant `k` WINS, like a label (§17 "Map scope").
  Scenario: g_V_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_withSideEffectXk_5X_V_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.withSideEffect("k", 5).V().values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |

  # --- a label BOUND TO NULL on some rows: presence is the BINDING, never the value's nullness ---
  # `Scoping.getScopeValue` answers `path.get(k)` whenever `path.hasLabel(k)`, null included
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:129-130),
  # and `SelectOneStep` splits a null traverser rather than filtering it
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java).
  # So the arm that bound `k` to null yields one null per row; the arm that never bound it drops.

  Scenario: g_V_asXvX_unionXconstantXnullX_asXkX_constantX0XX_selectXvX_valuesXmX_selectXkX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", 3).property("n", 1).addV("p").property("m", 4)
      """
    And the traversal of
      """
      g.V().as("v").union(__.constant(null).as("k"), __.constant(0)).select("v").values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | null |

  Scenario: g_V_asXvX_chooseXhasXnX_constantXnullX_asXkX_constantX0XX_selectXvX_valuesXmX_isX3X_selectXkX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", 3).property("n", 1).addV("p").property("m", 4)
      """
    And the traversal of
      """
      g.V().as("v").choose(__.has("n"), __.constant(null).as("k"), __.constant(0)).select("v").values("m").select("k").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_asXvX_unionXconstantXnullX_asXkX_constantX0XX_selectXvX_valuesXmX_unionXselectXkX_constantX1XX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", 3).property("n", 1).addV("p").property("m", 4)
      """
    And the traversal of
      """
      g.V().as("v").union(__.constant(null).as("k"), __.constant(0)).select("v").values("m").union(__.select("k"), __.constant(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | null |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  # A stored Map holding `k` does not answer behind the label: the null binding answers (the label wins).
  Scenario: g_V_asXvX_unionXconstantXnullX_asXkX_constantX0XX_selectXvX_valuesXmX_selectXkX_mapRow
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", 4)
      """
    And the traversal of
      """
      g.V().as("v").union(__.constant(null).as("k"), __.constant(0)).select("v").values("m").select("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | null |

  # --- the collision DECLINES where the key only MAY be the stream's own, rather than drop rows ---

  # A map stream whose key some rows only MAY hold (elementMap omits an absent property) behind a label.
  @Unsupported
  Scenario: g_V_hasXname_markoX_valuesXageX_asXageX_V_elementMapXageX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").values("age").as("age").V().elementMap("age").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
      | d[29].i |
      | d[29].i |

  # A record's OPTIONAL field beside a label of the same name: `project()` omits a key whose by() is
  # unproductive (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66),
  # so a software vertex's record lacks `age` and the reference reads the label. Every select form declines;
  # the tables are the reference answers.

  @Unsupported
  Scenario: g_V_asXageX_projectXage_nX_byXvaluesXageXX_byXnameX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").project("age", "n").by(__.values("age")).by("name").select("age")
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

  @Unsupported
  Scenario: g_V_hasLabelXsoftwareX_valuesXnameX_asXageX_V_hasLabelXsoftwareX_projectXage_nX_byXvaluesXageXX_byXnameX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").values("name").as("age").V().hasLabel("software").project("age", "n").by(__.values("age")).by("name").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | ripple |
      | ripple |

  @Unsupported
  Scenario: g_V_asXageX_projectXage_nX_byXvaluesXageXX_byXnameX_selectXage_nX
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").project("age", "n").by(__.values("age")).by("name").select("age", "n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"age":"d[29].i","n":"marko"}] |
      | m[{"age":"d[27].i","n":"vadas"}] |
      | m[{"age":"d[32].i","n":"josh"}] |
      | m[{"age":"d[35].i","n":"peter"}] |
      | m[{"age":"v[lop]","n":"lop"}] |
      | m[{"age":"v[ripple]","n":"ripple"}] |

  @Unsupported
  Scenario: g_V_asXageX_projectXage_nX_byXvaluesXageXX_byXnameX_mapXselectXageXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").project("age", "n").by(__.values("age")).by("name").map(__.select("age"))
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

  # count() needs no value: the record is kept whichever scope would answer, so it counts every traverser.
  Scenario: g_V_asXageX_projectXage_nX_byXvaluesXageXX_byXnameX_selectXageX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("age").project("age", "n").by(__.values("age")).by("name").select("age").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
