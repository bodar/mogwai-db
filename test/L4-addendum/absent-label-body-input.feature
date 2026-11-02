Feature: mogwai addendum — a child body rerooted at an UNBOUND label has an empty input

  # A label first bound inside `optional()`/`union()` is unbound on the rows that took the other way.
  # A child body that opens with `select()` of it then sees NO traverser: `SelectOneStep` emits nothing
  # for a missing key (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/SelectOneStep.java:57-73),
  # `map()` drops a traverser whose child yields nothing (step/map/TraversalMapStep.java:52), a seeded
  # reducer still emits its seed (step/util/ReducingBarrierStep.java:143-148), `project()` omits the key
  # and `order().by()` filters (step/map/OrderGlobalStep.java:84).
  # Over the modern graph, `g.V().optional(__.out().as("a"))` is 9 rows; the 3 leaves leave `a` unbound.

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_labelX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").label())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | person |
      | person |
      | software |
      | software |
      | software |
      | software |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_constantX5X_countX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").constant(5).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_optionalXout_asXaXX_localXselectXaX_label_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).local(__.select("a").label().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[person] |
      | l[person] |
      | l[software] |
      | l[software] |
      | l[software] |
      | l[software] |
      | l[] |
      | l[] |
      | l[] |

  Scenario: g_V_optionalXout_asXaXX_flatMapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).flatMap(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_projectXxX_byXselectXaX_labelX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).project("x").by(__.select("a").label())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"person"}] |
      | m[{"x":"person"}] |
      | m[{"x":"software"}] |
      | m[{"x":"software"}] |
      | m[{"x":"software"}] |
      | m[{"x":"software"}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |

  Scenario: g_V_optionalXout_asXaXX_order_byXselectXaX_labelX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).order().by(__.select("a").label()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_group_byXselectXaX_labelX_byXcountX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).group().by(__.select("a").label()).by(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[2].l","software":"d[4].l"}] |

  Scenario: g_V_optionalXout_asXaXX_whereXselectXaX_labelX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).where(__.select("a").label()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_notXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).not(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  # A seeded continuation keeps the unbound rows — the presence is not conjoined onto it.
  Scenario: g_V_optionalXout_asXaXX_whereXselectXaX_valuesXnameX_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).where(__.select("a").values("name").count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_V_hasXname_markoX_unionXidentity_asXaX_outX_mapXselectXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.identity().as("a"), __.out()).map(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectX0X_unionXconstantX1X_asXaX_constantX2XX_localXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.inject(0).union(__.constant(1).as("a"), __.constant(2)).local(__.select("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  # A body that RE-SOURCES the graph after the unbound label (`select("a").V()…`) still has an EMPTY
  # input there: a mid-traversal GraphStep emits once PER incoming traverser (step/map/GraphStep.java),
  # so nothing for none. Its answer on those rows is the body's own answer over nothing — a seeded
  # `count()` is 0, a continuation after it computes on that 0, an unseeded tail is nothing at all —
  # never the whole graph's answer.
  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_V_countX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").V().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_V_count_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").V().count().math("_+1"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7.0].d |
      | d[7.0].d |
      | d[7.0].d |
      | d[7.0].d |
      | d[7.0].d |
      | d[7.0].d |
      | d[1.0].d |
      | d[1.0].d |
      | d[1.0].d |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_V_valuesXnameXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").V().values("name")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_localXselectXaX_V_countX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).local(__.select("a").V().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_optionalXout_asXaXX_localXselectXaX_E_countX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).local(__.select("a").E().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_optionalXout_asXaXX_projectXxX_byXselectXaX_V_countX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).project("x").by(__.select("a").V().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[6].l"}] |
      | m[{"x":"d[0].l"}] |
      | m[{"x":"d[0].l"}] |
      | m[{"x":"d[0].l"}] |

  Scenario: g_V_optionalXout_asXaXX_order_byXselectXaX_V_countX_byXnameX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).order().by(__.select("a").V().count()).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | ripple |
      | vadas |
      | josh |
      | lop |
      | lop |
      | lop |
      | ripple |
      | vadas |

  Scenario: g_V_optionalXout_asXaXX_localXmapXselectXaX_E_count_mathX_times_2XXX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).local(__.map(__.select("a").E().count().math("_*2")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12.0].d |
      | d[12.0].d |
      | d[12.0].d |
      | d[12.0].d |
      | d[12.0].d |
      | d[12.0].d |
      | d[0.0].d |
      | d[0.0].d |
      | d[0.0].d |

  # A record built over the possibly-absent label is gated ONCE; its by()s run under that gate.
  Scenario: g_V_optionalXout_asXaXX_projectXxX_byXselectXaX_projectXyX_byXconstantX1XXX_selectXxX_selectXyX_sum
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).project("x").by(__.select("a").project("y").by(__.constant(1))).select("x").select("y").sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].i |

  # A rooted count FILTERED by `is(P)` is at most one row, not exactly one: where `is` rejects, the body
  # yields NOTHING, so `map()` drops the traverser (step/map/TraversalMapStep.java:52), `group()` and
  # `order()` filter the unproductive key and `project()` omits it (step/map/ProjectStep.java). Only an
  # unfiltered reducing barrier is always present.
  Scenario: g_V_mapXV_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.V().count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_mapXV_count_isX6XX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.V().count().is(6))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  Scenario: g_V_groupXX_byXV_count_isX0XX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(__.V().count().is(0))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |

  Scenario: g_V_projectXxX_byXV_count_isX0XX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.V().count().is(0))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |

  Scenario: g_V_orderXX_byXV_count_isX0XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(__.V().count().is(0)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_optionalXout_asXaXX_mapXselectXaX_V_count_isX6XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).map(__.select("a").V().count().is(6)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_optionalXout_asXaXX_orderXX_byXselectXaX_V_count_isX6XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().as("a")).order().by(__.select("a").V().count().is(6)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_mapXV_countX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.V().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
