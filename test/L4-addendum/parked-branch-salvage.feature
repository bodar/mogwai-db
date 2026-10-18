Feature: mogwai addendum — the parked branches' target defects, on the substrate trunk landed

  # Each scenario below was a WRONG ANSWER (or an internal error) on trunk 6415964a, found by replaying
  # the parked branches' own scenarios (fanout-by-first, alias-select-residue, seeded-fold-aliasing,
  # branch-residue, union-columns-deferral, narrow-row-ops) against it. Each fix sits at the one authority
  # its fact belongs to; the scenarios pin it at several depths. An @Unsupported one is the fail-closed half:
  # the reference answer is recorded, and the traversal must REFUSE until a lowering can give it.

  # ---- choose(): an unproductive choice takes the IDENTITY pass-through, never Pick.none ----
  # ChooseStep installs identity for BOTH Pick.unproductive and Pick.none
  # (vendor/tinkerpop/gremlin-core/.../step/branch/ChooseStep.java:71-79), and BranchStep routes a
  # choice that produced nothing to the first (BranchStep.java:161-163). At depth the scalar CASE fell to
  # the written none arm: lop and ripple answered 'unknown'.

  Scenario: g_V_localXchooseXvaluesXageXX_optionXbetweenX26_30X_nameX_optionXnone_unknownXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.values("age")).option(between(26,30), __.values("name")).option(Pick.none, __.constant("unknown")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | unknown |
      | unknown |
      | v[lop] |
      | v[ripple] |

  # ---- map(): the child's ONE result opens a path entry ----
  # MapStep/FlatMapStep emit head.split(result): the pre-child path extended by the value
  # (vendor/tinkerpop/gremlin-core/.../step/map/FlatMapStep.java:42-52). The entry was dropped.

  Scenario: g_VX1X_mapXvaluesXageXX_path
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").map(__.values("age")).path()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[marko],d[29].i] |

  Scenario: g_VX1X_mapXout_countX_path
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").map(__.out().count()).path()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[marko],d[3].l] |

  Scenario: g_V_mapXvaluesXageXX_simplePath_count
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.values("age")).simplePath().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  # local() forwards the CHILD's traverser, whose path a reducing barrier mints afresh — not modelled.
  @Unsupported
  Scenario: g_VX1X_localXout_countX_path
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").local(__.out().count()).path()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[d[3].l] |

  # ---- a group value by(select(values)) is ASSIGNED, not collected ----
  # Pinned in map-value-element-reentry.feature (g_V_hasLabelXpersonX_group_byXnameX_byXout_foldX_unfold_group_byXkeysX_byXselect_valuesX).

  # ---- a branch's emission key does not depend on what its arms hold ----
  # Each start's arms in turn, so the fold interleaves each person's name with its age (the reference goes
  # arm-major because the where() arm holds a barrier — a deliberate divergence, feature-support-matrix.md).

  Scenario: g_V_unionXvaluesXnameX_whereXoutE_countX_valuesXageXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("name"), __.where(__.outE().count()).values("age")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,d[29].i,vadas,d[27].i,lop,josh,d[32].i,ripple,peter,d[35].i] |

  # ---- a BranchStep with a barrier drains NOTHING over no starts ----
  # BranchStep.standardAlgorithm throws FastNoSuchElement when hasBarrier and no starts
  # (BranchStep.java:143-147); a groupCount arm lowered over an empty relation emitted its seed {}.
  @Unsupported
  Scenario: g_V_hasLabelXnoneX_unionXgroupCountX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("none").union(__.groupCount())
      """
    When iterated to list
    Then the result should be empty

  @Unsupported
  Scenario: g_V_localXout_unionXgroupCount_byXlabelX_groupCount_byXlabelXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().union(__.groupCount().by(T.label), __.groupCount().by(T.label))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # ---- a BranchStep option's end merges nothing: each arm's rows reach the fold one per traverser ----
  Scenario: g_VX1_4_6X_unionXvaluesXnameX_order_out_valuesXnameXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1, 4, 6).union(__.values("name").order(), __.out().values("name")).fold()
      """
    When iterated to list
    Then the result should have a count of 1

  # ---- a group value body collects one member per traverser (no per-member TraverserSet merge) ----
  Scenario: g_VX1X_group_by_byXout_in_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").group().by("name").by(__.out().in().values("name").fold())
      """
    When iterated to list
    Then the result should have a count of 1

  # ---- a first-result child over a MULTI-valued property takes the first SURVIVOR ----
  # IsStep filters each value; TraversalUtil.produce/test take the first result
  # (vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:108-123). Testing only the first stored value
  # answered "unproductive".

  Scenario: g_V_projectXpX_byXvaluesXlocX_isXbXX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b").property(Cardinality.list, "loc", "c")
      """
    And the traversal of
      """
      g.V().project("p").by(__.values("loc").is(P.neq("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"p":"b"}] |

  Scenario: g_V_mapXvaluesXlocX_isXbXX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().map(__.values("loc").is("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |

  Scenario: g_V_whereXvaluesXlocX_isXbXX_count_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().where(__.values("loc").is("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_notXvaluesXlocX_isXbXX_count_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().not(__.values("loc").is("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_V_coalesceXvaluesXlocX_isXbX_constantXxXX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().coalesce(__.values("loc").is("b"), __.constant("x"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | b |

  Scenario: g_V_chooseXvaluesXlocX_isXbX_y_nX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().choose(__.values("loc").is("b"), __.constant("y"), __.constant("n"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | y |

  Scenario: g_V_group_byXlabelX_byXvaluesXlocX_isXbXX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().group().by(T.label).by(__.values("loc").is("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"m":"b"}] |

  # A transform between the read and the test is pushed into the property rows with it: the first value
  # whose TRANSFORMED form survives contributes that transformed form.
  Scenario: g_V_projectXpX_byXvaluesXlocX_toUpper_isXBXX_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().project("p").by(__.values("loc").toUpper().is("B"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"p":"B"}] |

  Scenario: g_V_whereXvaluesXlocX_toUpper_isXBXX_count_multi
    Given the empty graph
    And the graph initializer of
      """
      g.addV("m").property(Cardinality.list, "loc", "a").property(Cardinality.list, "loc", "b")
      """
    And the traversal of
      """
      g.V().where(__.values("loc").toUpper().is("B")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_V_hasLabelXpersonX_whereXvaluesXnameX_toUpper_isXMARKOXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").where(__.values("name").toUpper().is("MARKO"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |

  Scenario: g_V_notXvaluesXnameX_toUpper_isXMARKOXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.values("name").toUpper().is("MARKO")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |

  # ---- a by() on a SCOPE value runs on a NEW traverser ----
  # TraversalUtil.produce(S start, …) generates a fresh traverser (TraversalUtil.java:125-130;
  # SelectOneStep.java:64, SelectStep.java:70, WherePredicateStep.java:98,135, DedupGlobalStep.java:82,
  # MathStep.java:73): no path, no labels, the initial sack.
  @Unsupported
  Scenario: g_V_asXaX_selectXaX_byXselectXaXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").select("a").by(__.select("a"))
      """
    When iterated to list
    Then the result should be empty

  @Unsupported
  Scenario: g_V_asXaX_mathXa_plus_1X_byXselectXaX_valuesXageXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").math("a + 1").by(__.select("a").values("age"))
      """
    When iterated to list
    Then the result should be empty

  @Unsupported
  Scenario: g_withSackX1X_V_hasXageX_asXaX_sackXsumX_byXageX_selectXaX_byXsackX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().has("age").as("a").sack(Operator.sum).by("age").select("a").by(__.sack())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  # A by() on the CURRENT traverser (order().by()) is a split: it keeps the running sack.
  Scenario: g_withSackX1X_V_hasXageX_sackXsumX_byXageX_order_byXsackX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().has("age").sack(Operator.sum).by("age").order().by(__.sack()).sack()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[28].i |
      | d[30].i |
      | d[33].i |
      | d[36].i |

  # ---- a REPEATED select key: the ring stops at the first unproductive by() ----
  # (SelectStep.java:66-84): lop keeps {a:lop}. Not built: declines.
  @Unsupported
  Scenario: g_V_asXaX_selectXa_aX_byXnameX_byXageX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").select("a", "a").by("name").by("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[29].i"}] |
      | m[{"a":"d[27].i"}] |
      | m[{"a":"lop"}] |
      | m[{"a":"d[32].i"}] |
      | m[{"a":"ripple"}] |
      | m[{"a":"d[35].i"}] |

  # ---- a where() leg's leading select keeps its Pop ----
  # SelectOneStep hands the Pop to Scoping.getScopeValue (SelectOneStep.java:64); the leg read the last 'a'.
  Scenario: g_VX1X_asXaX_out_asXaX_whereXselectXfirst_aX_valuesXageX_isX29XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("a").where(__.select(Pop.first, "a").values("age").is(29))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[vadas] |
      | v[josh] |
      | v[lop] |

  # ---- a label past a hop in a FILTER body is the subject's, never an absent key ----
  # The child is the whole traverser split (TraversalUtil.prepare); the hop's fresh relation has no
  # alias channel, and select('a') read as unbound answered [] for every vertex. Not threaded: declines.
  @Unsupported
  Scenario: g_V_asXaX_whereXout_selectXaX_hasLabelXpersonXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").where(__.out().select("a").hasLabel("person")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  # ---- math(): a NaN result is not an unproductive by(); log(0) is -Infinity ----
  # MathStep emits whatever exp4j evaluates (MathStep.java:89-91); SQLite holds a NaN as NULL, which the
  # productivity filter dropped as if a by() had produced nothing.
  Scenario: g_injectX_4X_mathXsqrt__X
    Given the empty graph
    And the traversal of
      """
      g.inject(-4).math("sqrt _")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "math() producing NaN"

  Scenario: g_injectX_4X_mapXmathXsqrt__XX
    Given the empty graph
    And the traversal of
      """
      g.inject(-4).map(__.math("sqrt _"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "math() producing NaN"

  Scenario: g_injectX0X_mathXlogX__XX
    Given the empty graph
    And the traversal of
      """
      g.inject(0).math("log(_)")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[-Infinity].d |

  # ---- a numeric map key is a NUMBER ----
  # Gremlin.g4 mapKey numericLiteral; [1:'a'] has no key "1" (Scoping.getScopeValue's containsKey).
  @Unsupported
  Scenario: g_injectXm_1_aX_selectX1X
    Given the empty graph
    And the traversal of
      """
      g.inject([1:"a"]).select("1")
      """
    When iterated to list
    Then the result should be empty

  # ---- a wide integral sum stays exact ----
  # NumberHelper.add is exact in Long (NumberHelper.java:452-454); the SQL SUM was, its JS read was not.
  Scenario: g_injectX2e52L_2e52L_29X_sum
    Given the empty graph
    And the traversal of
      """
      g.inject(4503599627370496L, 4503599627370496L, 29).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254741021].l |

  Scenario: g_V_person_localXunionXconstantX2e52LX_constantX2e52LX_valuesXageXX_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.union(__.constant(4503599627370496L), __.constant(4503599627370496L), __.values("age")).sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254741021].l |
      | d[9007199254741019].l |
      | d[9007199254741024].l |
      | d[9007199254741027].l |

  # ---- a raise in a later coalesce() arm is met only where that arm runs ----
  # Every person has an age, so the second arm never runs; SQLite pushed the is() into the UNION ALL arm,
  # ahead of the arm's own guard. The raise test now fences the arm; the shape then declines.
  @Unsupported
  Scenario: g_V_person_coalesceXvaluesXageX_constantX0X_mathX1_divX_isXgtX30XX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").coalesce(__.values("age"), __.constant(0).math("1/_")).is(P.gt(30))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  # ---- a rebind whose entry the DATA decides ----
  # Without a PATH requirement the reference's labelled-path traverser adds a filter step's label to the
  # head entry when the object EQUALS it (B_LP_O_S_SE_SL_Traverser.java:82-87): both().both() back at
  # v[1] binds 'a' once. Declined; an as() directly after the split is exact.
  @Unsupported
  Scenario: g_VX1X_asXaX_both_both_hasXnameX_asXaX_selectXall_aX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").both().both().has("name").as("a").select(Pop.all, "a").count(Scope.local)
      """
    When iterated to list
    Then the result should have a count of 7

  Scenario: g_VX1X_asXaX_both_both_asXaX_selectXall_aX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").both().both().as("a").select(Pop.all, "a").count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
      | d[2].l |
