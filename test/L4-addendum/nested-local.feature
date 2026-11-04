Feature: mogwai addendum — a per-traverser host nested inside another one's body

  # local()/map()/flatMap() run their body once per ENTERING traverser
  # (vendor/tinkerpop/gremlin-core/.../step/branch/LocalStep.java:80-88,
  #  .../step/map/FlatMapStep.java:42-52), and that holds at every depth: a local() inside a local()
  # body runs per row of the OUTER body, not per outer traverser. Two lowerings answer it
  # (src/compiler/rel/lower/reduction.ts):
  #
  #   - a ONE-value inner body (ending in a reducer or fold()) is a correlated scalar over the row's
  #     element — `nestedHostChild` where the host LEADS a child value (a choose() key, a by()), and
  #     `perTraverserChild`'s scalar route inside a fan-out body;
  #   - a FAN-OUT inner body is inlined over the enclosing origin, or, where it holds a per-origin
  #     window of its own (limit/dedup/order…), run under a NESTED origin (`nestRowOrigin`) so the
  #     window scopes per INNER row.
  #
  # A grouping barrier (fold()/group() continuing mid-body) inside a nested fan-out body has no nested
  # form and declines.

  # ---- a one-value inner body, at depth ----

  Scenario: g_V_localXout_localXout_localXcountXXXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().local(__.out().local(__.count())))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |

  Scenario: g_V_localXout_mapXlocalXout_countXXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().map(__.local(__.out().count()))).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[0].l,d[0].l,d[2].l,d[0].l,d[0].l,d[0].l] |

  # ---- a nested host LEADING a child value: a choose() key, a by(), a where() ----

  Scenario: g_V_hasLabelXpersonX_chooseXlocalXoutXcreatedX_countXX_optionX1_oneX_optionXnone_otherX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.local(__.out("created").count())).option(1L, __.constant("one")).option(Pick.none, __.constant("other"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | one |
      | one |
      | other |
      | other |

  Scenario: g_V_projectXn_cX_byXnameX_byXlocalXout_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("n","c").by("name").by(__.local(__.out().count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","c":3}] |
      | m[{"n":"vadas","c":0}] |
      | m[{"n":"lop","c":0}] |
      | m[{"n":"josh","c":2}] |
      | m[{"n":"ripple","c":0}] |
      | m[{"n":"peter","c":1}] |

  Scenario: g_V_hasLabelXpersonX_projectXn_uX_byXnameX_byXmapXvaluesXnameXX_toUpperX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").project("n","u").by("name").by(__.map(__.values("name")).toUpper())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","u":"MARKO"}] |
      | m[{"n":"vadas","u":"VADAS"}] |
      | m[{"n":"josh","u":"JOSH"}] |
      | m[{"n":"peter","u":"PETER"}] |

  Scenario: g_V_whereXlocalXout_countX_isXgtX1XXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.local(__.out().count()).is(P.gt(1))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |

  # ---- a nested host MID-run, over the value the run reached: per value of a multi-valued key (the
  #      by() takes the first result), and never run where the run produced nothing ----

  Scenario: g_VX1_2X_projectXn_dX_byXnameX_byXvaluesXdietX_localXfoldXX
    Given the zoo graph
    And the traversal of
      """
      g.V(1,2).project("n","d").by("name").by(__.values("diet").local(__.fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"tux","d":["fish"]}] |
      | m[{"n":"atlas","d":["seagrass"]}] |

  Scenario: g_VX1_2X_localXvaluesXdietX_localXfoldXX
    Given the zoo graph
    And the traversal of
      """
      g.V(1,2).local(__.values("diet").local(__.fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[fish] |
      | l[krill] |
      | l[squid] |
      | l[seagrass] |
      | l[algae] |

  Scenario: g_VX1X_projectXaX_byXvaluesXnopeX_localXfoldXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a").by(__.values("nope").local(__.fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |

  # ---- a fan-out inner body: labels and path through two levels ----

  Scenario: g_V_localXout_localXout_asXbXXX_selectXbX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().local(__.out().as("b"))).select("b").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_localXout_flatMapXout_asXbXXX_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().flatMap(__.out().as("b"))).select("b")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_hasXname_markoX_localXout_localXoutXX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").local(__.out().local(__.out())).path().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[marko,josh,ripple] |
      | p[marko,josh,lop] |

  # ---- a per-origin window inside a nested fan-out body scopes per INNER row ----

  @gap:nested-local
  Scenario: g_V_local_out_local_out_order_limit
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.out().local(__.out().order().by('name').limit(1))).values('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop    |

  Scenario: g_V_hasXname_markoX_localXboth_localXboth_order_byXnameX_limitX1XX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").local(__.both().local(__.both().order().by("name").limit(1)).values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | marko |
      | lop |

  Scenario: g_V_localXboth_localXboth_limitX1XX_limitX2XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.both().local(__.both().limit(1)).limit(2)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  Scenario: g_V_groupXX_byXnameX_byXlocalXboth_localXboth_limitX1XXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by("name").by(__.local(__.both().local(__.both().limit(1))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[3].l","vadas":"d[1].l","lop":"d[3].l","josh":"d[3].l","ripple":"d[1].l","peter":"d[1].l"}] |
