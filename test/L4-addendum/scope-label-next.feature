Feature: mogwai addendum — a path label is the scope a traverser's own Map falls back to

  # `Scoping.getScopeValue` asks the traverser's OWN Map first, then the side effects, then the path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # Where the traverser MAY be a Map (a stored map property read by `values('m')`, a record with an optional
  # field) and a path label of the same name is live, a row holding the key reads its entry and a row
  # lacking it reads the label. Before: the label answered every row (a stored Map's `k` was never read),
  # or a record's optional field dropped the rows the label answers.

  # --- a per-row scalar stream behind a VALUE label: one `{t,v}` node per row, entry-else-label ---

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
      | d[2.0].d |
      | d[2.0].d |
      | d[2.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |
      | d[8.0].d |

  # A side-effect constant is the next scope the same way (it used to answer the Map row too).
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
      | d[2.0].d |
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
      | d[1].i |
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
      | d[1].i |
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
      | d[1].i |
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
      | d[1].i |
      | d[7].i |
      | d[7].i |

  Scenario: g_injectX7X_asXkX_V_valuesXmX_whereXselectXkX_isX1XX_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("m", ["k": 1]).addV("p").property("m", ["j": 5]).addV("p").property("m", 3)
      """
    And the traversal of
      """
      g.inject(7).as("k").V().values("m").where(__.select("k").is(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

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
      | d[10.0].d |
      | d[70.0].d |
      | d[70.0].d |

  # A label bound in ONE union arm: a row from the other arm whose Map lacks `k` has no scope and drops.
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
      | d[1].i |
      | d[1].i |
      | d[7].i |
      | d[7].i |

  # A map stream whose key some rows only MAY hold (elementMap omits an absent property) behind a VALUE label.
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

  # --- a record's OPTIONAL field beside a live label of the same name ---
  # `project()` omits a key whose by() is unproductive (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:66),
  # so a software vertex's record lacks `age` and `select('age')` reads the label.

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

  Scenario: g_V_hasLabelXsoftwareX_valuesXnameX_asXageX_V_hasXname_markoX_projectXage_nX_byXvaluesXageXX_byXnameX_selectXageX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").values("name").as("age").V().has("name", "marko").project("age", "n").by(__.values("age")).by("name").select("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[29].i |

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

  # The CHILD form needs a per-traverser body over a RECORD stream (map/local/flatMap over project()),
  # which no lowering covers yet — `map(select('n'))` declines there too. It refuses rather than answer.
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
