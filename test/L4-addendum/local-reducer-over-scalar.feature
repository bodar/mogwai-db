Feature: mogwai addendum — a Scope.local reducer, order or dedup over a value that may not be a collection

  # `sum`/`mean`/`min`/`max`/`order`/`dedup(local)` read their traverser through `IteratorUtils.asIterator`, so
  # a value that is not a collection is a ONE-element iterator: it reduces to itself (`mean` a Double), orders
  # to itself, and dedups to a one-member Set; a Map is its ENTRY set, which a reducer cannot add or compare
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/iterator/IteratorUtils.java`
  # `asIterator`; `.../step/map/SumLocalStep.java`, `MeanLocalStep.java`, `OrderLocalStep.java`,
  # `DedupLocalStep.java`). A per-row-typed stream (`values(k)` over a list-valued property) is split by each
  # row's stored tag (`perRowCollectionStep`, src/compiler/rel/lower.ts); a non-collection row is wrapped as a
  # one-member list (`oneMemberList`, src/compiler/rel/list.ts) so the list route's reducer is the one authority.

  Scenario: g_V_valuesXlX_sumXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 1, 3]).addV("p").property("l", 7L).addV("p").property("l", [2.5d, 1]).addV("p").property("l", [])
      """
    And the traversal of
      """
      g.V().values("l").sum(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |
      | d[7].l |
      | d[3.5].d |

  Scenario: g_V_valuesXlX_meanXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 1, 2]).addV("p").property("l", 7L)
      """
    And the traversal of
      """
      g.V().values("l").mean(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2.0].d |
      | d[7.0].d |

  Scenario: g_V_valuesXlX_maxXlocalX_minXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 1, 3]).addV("p").property("l", "str").addV("p").property("l", [])
      """
    And the traversal of
      """
      g.V().values("l").union(max(local), min(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |
      | d[1].i |
      | str |
      | str |

  Scenario: g_V_valuesXlX_sumXlocalX_raises_over_a_map_row
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [1, 2]).addV("p").property("l", ["a": 1])
      """
    And the traversal of
      """
      g.V().values("l").map(__.sum(local))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "cannot reduce a Map"

  Scenario: g_V_valuesXlX_orderXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 1, 2]).addV("p").property("l", ["b": 1, "a": 2]).addV("p").property("l", 9)
      """
    And the traversal of
      """
      g.V().values("l").order(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i,d[3].i] |
      | m[{"a":"d[2].i", "b":"d[1].i"}] |
      | d[9].i |

  Scenario: g_V_valuesXlX_dedupXlocalX_mixed_rows
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 1, 3]).addV("p").property("l", 9)
      """
    And the traversal of
      """
      g.V().values("l").dedup(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[d[3].i,d[1].i] |
      | s[d[9].i] |

  Scenario: g_V_valuesXlX_dedupXlocalX_unfold_map_row_entries
    Given the empty graph
    And the graph initializer of
      """
      g.addV("p").property("l", [3, 3]).addV("p").property("l", ["b": 1, "a": 2]).addV("p").property("l", 9)
      """
    And the traversal of
      """
      g.V().values("l").dedup(local).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |
      | m[{"b":"d[1].i"}] |
      | m[{"a":"d[2].i"}] |
      | d[9].i |

  Scenario: g_injectXmapX_dedupXlocalX_unfold
    Given the empty graph
    And the traversal of
      """
      g.inject(["b": 1, "a": 2]).dedup(local).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":"d[1].i"}] |
      | m[{"a":"d[2].i"}] |

  Scenario: g_injectX5X_meanXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(5).mean(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5.0].d |

  Scenario: g_V_count_sumXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().count().sum(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_injectX5X_dedupXlocalX_orderXlocalX_countXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(5).union(dedup(local).unfold(), order(local), count(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[1].l |

  Scenario: g_V_valuesXageX_projectXsX_byXmaxXlocalXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").project("s").by(max(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"s":"d[29].i"}] |
      | m[{"s":"d[27].i"}] |
      | m[{"s":"d[32].i"}] |
      | m[{"s":"d[35].i"}] |

  Scenario: g_V_localXvaluesXageX_meanXlocalXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(values("age").mean(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29.0].d |
      | d[27.0].d |
      | d[32.0].d |
      | d[35.0].d |

  Scenario: g_V_chooseXhasXage_gtX30XX_valuesXageX_meanXlocalX_valuesXageX_sumXlocalXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(has("age", gt(30)), values("age").mean(local), values("age").sum(local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32.0].d |
      | d[35.0].d |
      | d[29].i |
      | d[27].i |

  Scenario: g_V_valuesXageX_asXaX_selectXaX_minXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").as("a").select("a").min(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  Scenario: g_V_valuesXageX_whereXsumXlocalX_isXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").where(sum(local).is(gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |
