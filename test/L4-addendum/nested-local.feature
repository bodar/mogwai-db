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
  #     window (limit/dedup/order…) or a branch anywhere — a union()/choose() arm included — run under
  #     a NESTED origin (`nestRowOrigin`) so the window scopes per INNER row.
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

  # ---- a mid-run nested host followed by a step the nested-host seam cannot answer DECLINES ----
  # The mid-run host arm (`valueRun`) asks `nestedHostChild` directly. It once re-entered the whole seam
  # instead, whose scalar-host arm handed the same body straight back to `valueRun`, so any follow-on step
  # the seam declined (unfold, limit, count(local), index, is) recursed until a bare RangeError reached
  # the user. Each scenario carries the REFERENCE answer and pins that the refusal is the clean one.

  @Unsupported
  Scenario: g_V_projectXn_cX_byXnameX_byXvaluesXnameX_localXfoldX_unfoldX
    Given the modern graph
    And the traversal of
      """
      g.V().project("n","c").by("name").by(__.values("name").local(__.fold()).unfold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","c":"marko"}] |
      | m[{"n":"vadas","c":"vadas"}] |
      | m[{"n":"lop","c":"lop"}] |
      | m[{"n":"josh","c":"josh"}] |
      | m[{"n":"ripple","c":"ripple"}] |
      | m[{"n":"peter","c":"peter"}] |
    And the decline should say "no lowering covers"

  @Unsupported
  Scenario: g_V_projectXn_cX_byXnameX_byXvaluesXageX_localXisXgtX30XX_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("n","c").by("name").by(__.values("age").local(__.is(P.gt(30)).count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","c":"d[0].l"}] |
      | m[{"n":"vadas","c":"d[0].l"}] |
      | m[{"n":"lop"}] |
      | m[{"n":"josh","c":"d[1].l"}] |
      | m[{"n":"ripple"}] |
      | m[{"n":"peter","c":"d[1].l"}] |
    And the decline should say "no lowering covers"

  @Unsupported
  Scenario: g_V_mapXvaluesXageX_localXfoldX_countXlocalXX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.values("age").local(__.fold()).count(Scope.local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
    And the decline should say "no lowering covers"

  @Unsupported
  Scenario: g_V_hasLabelXpersonX_order_byXvaluesXnameX_localXfoldX_countXlocalXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by(__.values("name").local(__.fold()).count(Scope.local)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
    And the decline should say "no lowering covers"

  @Unsupported
  Scenario: g_V_whereXvaluesXnameX_localXfoldX_unfold_isXmarkoXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.values("name").local(__.fold()).unfold().is("marko")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
    And the decline should say "no lowering covers"

  # ---- a nested host whose body may produce NOTHING, followed by a SEEDED barrier ----
  # fold()/count() over zero traversers emit []/0: FoldStep and CountGlobalStep supply a seed
  # (vendor/tinkerpop/gremlin-core/.../step/map/FoldStep.java, CountGlobalStep.java). So the steps after
  # the host still answer where the host's body produced nothing; gating them on the host's presence
  # dropped these rows and keys.

  Scenario: g_V_localXmapXvaluesXageXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.map(__.values("age")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[29].i] |
      | l[d[27].i] |
      | l[] |
      | l[d[32].i] |
      | l[] |
      | l[d[35].i] |

  Scenario: g_V_whereXmapXvaluesXageXX_count_isX0XX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.map(__.values("age")).count().is(0)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_projectXn_aX_byXnameX_byXlocalXinE_valuesXweightX_meanX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().project("n","a").by("name").by(__.local(__.inE().values("weight").mean()).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko","a":"l[]"}] |
      | m[{"n":"vadas","a":"l[d[0.5].d]"}] |
      | m[{"n":"lop","a":"l[d[0.3333333333333333].d]"}] |
      | m[{"n":"josh","a":"l[d[1.0].d]"}] |
      | m[{"n":"ripple","a":"l[d[1.0].d]"}] |
      | m[{"n":"peter","a":"l[]"}] |

  Scenario: g_V_chooseXlocalXoutE_valuesXweightX_sumX_fold__constantXtX__constantXfXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.local(__.outE().values("weight").sum()).fold(), __.constant("t"), __.constant("f"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | t |
      | t |
      | t |
      | t |
      | t |
      | t |

  # ---- a mid-run nested host whose value is a LIST, as a group() value: a vertex with no age has no
  #      value, so its key is omitted, as for the sibling by(__.values("age")) ----

  Scenario: g_V_groupXX_byXnameX_byXvaluesXageX_localXfoldXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by("name").by(__.values("age").local(__.fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"l[d[29].i]","vadas":"l[d[27].i]","josh":"l[d[32].i]","peter":"l[d[35].i]"}] |

  # Under ProductiveByStrategy the unproductive value is KEPT as null; the list-valued map framing has no
  # null value to frame, so this one form declines (it once framed {t:'list', v:null} and crashed).
  @Unsupported
  Scenario: g_withStrategiesXProductiveByStrategyX_V_groupXX_byXnameX_byXvaluesXageX_localXfoldXX
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().group().by("name").by(__.values("age").local(__.fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"l[d[29].i]","vadas":"l[d[27].i]","lop":null,"josh":"l[d[32].i]","ripple":null,"peter":"l[d[35].i]"}] |
    And the decline should say "no lowering covers"

  Scenario: g_V_groupXX_byXidX_byXlocalXvaluesXageX_mapXfoldXXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.id).by(__.local(__.values("age").map(__.fold())))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[1].i":"l[d[29].i]","d[2].i":"l[d[27].i]","d[4].i":"l[d[32].i]","d[6].i":"l[d[35].i]"}] |

  # ---- a per-origin window inside a BRANCH ARM of a nested body scopes per INNER row, exactly as the
  #      flat g.V().out().local(<same body>) does ----

  Scenario: g_V_localXout_localXunionXout_limitX1X__in_limitX1XXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().local(__.union(__.out().limit(1), __.in().limit(1)))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].l |

  Scenario: g_V_localXout_localXchooseXout_count_isXgtX0XX__out_limitX1X__in_limitX1XXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().local(__.choose(__.out().count().is(P.gt(0)), __.out().limit(1), __.in().limit(1)))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_localXout_localXunionXboth_rangeX0_1X__identityXXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().local(__.union(__.both().range(0,1), __.identity()))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  Scenario: g_V_projectXv_cX_byXidX_byXlocalXout_localXunionXout_limitX1X__in_limitX1XXXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().project("v","c").by(T.id).by(__.local(__.out().local(__.union(__.out().limit(1), __.in().limit(1)))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"v":"d[1].i","c":"d[4].l"}] |
      | m[{"v":"d[2].i","c":"d[0].l"}] |
      | m[{"v":"d[3].i","c":"d[0].l"}] |
      | m[{"v":"d[4].i","c":"d[2].l"}] |
      | m[{"v":"d[5].i","c":"d[0].l"}] |
      | m[{"v":"d[6].i","c":"d[1].l"}] |
