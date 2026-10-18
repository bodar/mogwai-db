Feature: mogwai addendum — a barrier-free branch emits traverser-major, arm-minor

  # `BranchStep.standardAlgorithm` injects ONE start at a time unless `hasBarrier` is set
  # (vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java:123), so a branch whose arms hold
  # no batched barrier runs every arm for input traverser 1, then every arm for input traverser 2.
  # We merged arm-major over the whole stream, which is only the same answer for a single input.
  #
  # That is not an ordering nicety: with a positional consumer after the branch the two keys select
  # a DIFFERENT WINDOW, so the multiset differs — which is what makes these scenarios pinnable at
  # all, since `the result should be unordered` cannot see a pure reorder. Each slice below is
  # chosen to fall on a TRAVERSER boundary, so the expected set is fixed by the grouping alone and
  # does not depend on within-arm movement order (which the reference leaves implementation-
  # defined). @gap:branch-traverser-major marks the family.
  #
  # coalesce/optional are not `BranchStep`s and never batch, so they take the same key for the same
  # reason. The batching case is the complement and is pinned in element-branch-child.feature.

  @gap:branch-traverser-major
  Scenario: g_V_hasXname_within_josh_markoX_order_byXnameX_unionXout_inX_valuesXnameX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", P.within("josh","marko")).order().by("name").union(__.out(), __.in()).values("name").limit(3)
      """
    # order() fixes the input sequence josh, marko. josh's arms yield {ripple, lop} (out) and
    # {marko} (in) — three rows, all of them before any of marko's {vadas, josh, lop} + {}. So the
    # first three ARE josh's three, whatever order the two arms and the movement put them in.
    # Arm-major returns both vertices' out-neighbours first, which drops marko and adds vadas.
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |
      | marko |

  @gap:branch-traverser-major
  Scenario: g_V_hasXname_within_josh_markoX_order_byXnameX_unionXout_inX_valuesXnameX_tailX3X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", P.within("josh","marko")).order().by("name").union(__.out(), __.in()).values("name").tail(3)
      """
    # The mirror of the above, read from the far end: marko contributes the last three rows
    # (out: vadas, josh, lop; in: none) because josh's three all precede them.
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |

  @gap:branch-traverser-major
  Scenario: g_V_hasXname_within_josh_markoX_order_byXnameX_unionXunionXoutXknowsX_outXcreatedXX_inX_valuesXnameX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", P.within("josh","marko")).order().by("name").union(__.union(__.out("knows"), __.out("created")), __.in()).values("name").limit(3)
      """
    # NESTED, so the frozen input order has to be a stack: the inner union freezes the order it was
    # handed inside the outer arm, and the outer one is still live underneath it. josh's outer
    # arm 0 yields {} (knows) then {ripple, lop} (created), arm 1 {marko} — three rows, all before
    # marko's three.
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |
      | marko |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_coalesceXoutXknowsX_outXcreatedXX_valuesXnameX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").coalesce(__.out("knows"), __.out("created")).values("name").limit(2)
      """
    # order() fixes the input sequence josh, marko, peter, vadas — so the divergence is visible
    # without depending on source order. josh has no knows(), takes the created() arm, and its two
    # rows {ripple, lop} come first. Arm-major returns marko's knows-arm rows [vadas, josh].
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_chooseXhasXname_markoX_outXknowsX_outXcreatedXX_valuesXnameX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").choose(__.has("name","marko"), __.out("knows"), __.out("created")).values("name").limit(2)
      """
    # Same shape through choose(): the predicate is not an arm, so only the option bodies decide
    # whether the arms run per traverser. josh takes the else-arm and is first in the input order,
    # so its {ripple, lop} lead; arm-major leads with the then-arm (marko's {vadas, josh}).
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXvaluesXnameX_valuesXageXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.values("name"), __.values("age")).limit(3)
      """
    # The SCALAR merge takes the same key. Input order josh, marko, peter, vadas; each traverser
    # emits its name then its age, so the first three are josh's two plus marko's name. Arm-major
    # returns every name first — [josh, marko, peter].
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | d[32].i |
      | marko |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_chooseXhasXname_markoX_valuesXnameX_valuesXageXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").choose(__.has("name","marko"), __.values("name"), __.values("age")).limit(1)
      """
    # One row, and which row it is IS the divergence: josh comes first and takes the else-arm, so
    # the answer is its age. Arm-major puts the then-arm first and answers "marko".
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXvaluesXnameX_foldX_valuesXageX_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.values("name").fold(), __.values("age").fold()).limit(2)
      """
    # The LIST merge. A `fold()` is a `Barrier`, so `hasBarrier` is set and the reference injects EVERY
    # start into both options before draining them ARM-major
    # (vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java:87-88,143-150): each arm reduces the
    # whole input — the shape Union.feature's g_VX1_2X_unionXoutE_count__inE_count__outE_weight_sumX pins.
    # (This scenario used to assert a per-traverser fold, [josh] then [32], which is not the reference.)
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,marko,peter,vadas] |
      | l[d[32].i,d[29].i,d[35].i,d[27].i] |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXvaluesXnameX_valuesXageX_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.values("name"), __.values("age").fold()).limit(2)
      """
    # The MIXED-SHAPE (variant) merge. The fold arm sets `hasBarrier`, so the options drain ARM-major
    # over the whole input: every name in input order before the one fold of every age — the slice takes
    # the first two names. (This scenario used to assert josh's scalar then josh's list, a per-traverser
    # order the reference does not have.)
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | marko |

  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXoutXcountX_valuesXageXX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.out().count(), __.values("age")).limit(2)
      """
    # The COMPLEMENT, and the reason the gate is not "always freeze": arm 0 holds a batched barrier,
    # so `hasBarrier` is set and the reference runs BOTH arms over the whole input — arm-major is
    # then its own answer. ONE count of all six out-edges (not four per-traverser counts), then the
    # ages in input order, so the first two are the count and josh's age.
    #
    # This slice is only determined because the merge key carries the arm's ORDINAL between
    # `arm_idx` and `arm_encounter`: arm 1 is a child-scoped projection whose encounter is
    # per-origin, so without the ordinal every age ties at 1 and the window picked whatever SQLite
    # scanned first. `mise run test:perturbed` is what says that out loud, and this scenario is
    # stable under it.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[32].i |

  # math()'s variable must resolve to a Number and a stored age is typed per row, so each arm carries an
  # in-statement raise test; every age is a Number, so none fires.
  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_valuesXageX_unionXmathX_plus_1X_mathX_times_2XX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").values("age").union(__.math("_+1"), __.math("_*2")).limit(3)
      """
    # A scalar PARENT, whose branches live in scalar-arm.ts and take the same key. Ages in input
    # order are 32, 29, 35, 27, so josh's two derived values come before marko's first.
    # Arm-major returns every +1 before any *2 — [33, 30, 36].
    When iterated to list
    Then the result should be unordered
      | result |
      | d[33].d |
      | d[64].d |
      | d[30].d |

  # The same scalar parent and key with arms that cannot raise: josh's 32 passes both arms, so his two
  # come before marko's first. Arm-major would return [32, 29, 35].
  @gap:branch-traverser-major
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_valuesXageX_unionXidentity_isXgtX30XXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").values("age").union(__.identity(), __.is(P.gt(30))).limit(3)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[32].i |
      | d[29].i |

  # @Unsupported: the arm's `limit(1)` must select per traverser, and the coalesce arm lowering has no
  # per-traverser slice — it ran the limit ONCE across every traverser's rows. That answered this
  # scenario only because marko is the one person with a knows() edge (so a global and a per-traverser
  # limit agree); `g.V().coalesce(__.out().limit(1), __.constant("x")).count()` answered 4 for a
  # reference 6. Now a clean decline (branch-arm-decline.feature).
  @gap:branch-traverser-major @Unsupported
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_coalesceXoutXknowsX_limitX1X_outXcreatedXX_valuesXnameX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").coalesce(__.out("knows").limit(1), __.out("created")).values("name").limit(2)
      """
    # A BATCHED barrier inside a coalesce arm, which is the case the batching rule does NOT reach:
    # `hasBarrier` is a `BranchStep` field and CoalesceStep is a FlatMapStep, so the arm still runs
    # per traverser and the merge is still traverser-major. josh has no knows(), so its created()
    # arm's two rows come first; arm-major would lead with marko's single knows() row.
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | lop |

  # A slice that lands INSIDE one parent's arm output reads the order THAT ARM emitted, which a
  # payload tie-break does not: `BranchStep` drains arm 1 for the start before arm 2
  # (vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java:123-158) and the unfold emits the
  # list in list order, so the first traverser is 3. The re-mint keys `[parent, arm, arm position]`.
  @gap:branch-traverser-major
  Scenario: g_VX1X_unionXconstantXl3_1X_unfold_constantX0XX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant([3, 1]).unfold(), __.constant(0)).limit(1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  # The same slice INSIDE a per-traverser body: the body's own `limit(1)` reads the branch merged in
  # that body, which the ROOT chain's slice demand cannot see — so each body re-entry asks
  # (`continueAs`). Arm 1 is drained first, so the one survivor is 2, not the payload-least 1.
  @gap:branch-traverser-major
  Scenario: g_VX1X_localXunionXconstantX2X_constantX1XX_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.constant(2), __.constant(1)).limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:branch-traverser-major
  Scenario: g_VX1X_flatMapXunionXconstantX2X_constantX1XX_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).flatMap(__.union(__.constant(2), __.constant(1)).limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:branch-traverser-major
  Scenario: g_VX1X_localXchooseXconstantXtrueX_constantXl3_1X_unfold_constantX0XX_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.choose(__.constant(true), __.constant([3, 1]).unfold(), __.constant(0)).limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  # The body's slice reads a branch the chain-global order demand does not see; the branch is the head
  # of a per-start body, so it is positioned by that body's per-row origin and numbered traverser-major.
  # (A positionless merge handed the slice a payload-order subset — 1.) A sum of Integers is an Integer.
  @gap:branch-traverser-major
  Scenario: g_VX1X_localXunionXconstantX2X_constantX1XX_limitX1XX_sum
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.constant(2), __.constant(1)).limit(1)).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  # A sliced branch NESTED inside another branch's arm: the inner merge freezes its own keys beside the
  # outer ones (the emission key STACK), and the limit inside `local` puts a Barrier in the outer arm,
  # so the outer union drains arm-major. (Trunk once answered [1, 9].)
  @gap:branch-traverser-major
  Scenario: g_VX1X_unionXlocalXunionXconstantX2X_constantX1XX_limitX1XX_constantX9XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.local(__.union(__.constant(2), __.constant(1)).limit(1)), __.constant(9))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[9].i |

  # ── THE EMISSION KEY READ BY A FOLD ─────────────────────────────────────────────────────────────────
  # A fold's MEMBER order is part of its answer, so a collect reads the branch's emission order exactly
  # as a slice does. These used to be numbered by the merged rows' content ("any deterministic order"):
  # [5,9], [marko,x], [josh,lop,vadas,z] — never the reference's.

  @gap:branch-traverser-major
  Scenario: g_VX1X_unionXconstantX9X_constantX5XX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant(9), __.constant(5)).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[9].i,d[5].i] |

  @gap:branch-traverser-major
  Scenario: g_VX1_2X_unionXconstantXxX_valuesXnameXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).union(__.constant("x"), __.values("name")).fold()
      """
    # Traverser-major, arm-minor: marko's two rows, then vadas's.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[x,marko,x,vadas] |

  # A child run ONCE PER START (`LocalStep`): the branch heads the body, so each start is its own parent.
  @gap:branch-traverser-major
  Scenario: g_VX1_2X_localXunionXconstantXxX_valuesXnameXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).local(__.union(__.constant("x"), __.values("name")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[x,marko] |
      | l[x,vadas] |

  # An `order()` in an arm is a Barrier: ARM-major, and the arm keeps the order it sorted into.
  @gap:branch-traverser-major
  Scenario: g_VX1X_unionXout_order_byXname_descX_valuesXnameX_constantXzXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.out().order().by("name", Order.desc).values("name"), __.constant("z")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[vadas,lop,josh,z] |

  # The emission key is the same whatever the arms hold: each start's arms in turn, so an arm's order()
  # sorts that start's output (the reference sorts across every start here — a deliberate divergence,
  # feature-support-matrix.md). Sort the merged stream with an order() after the branch.
  @gap:branch-traverser-major
  Scenario: g_VX1_4X_unionXout_order_byXname_descX_valuesXnameX_constantXzXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1, 4).union(__.out().order().by("name", Order.desc).values("name"), __.constant("z")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[vadas,lop,josh,z,ripple,lop,z] |

  # …but ARM-major PER START inside `local`: each start drains its own arms.
  @gap:branch-traverser-major
  Scenario: g_VX1_4X_localXunionXout_order_byXname_descX_valuesXnameX_constantXzXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 4).local(__.union(__.out().order().by("name", Order.desc).values("name"), __.constant("z")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[vadas,lop,josh,z] |
      | l[ripple,lop,z] |

  # The key STACK under a fold: the inner union numbers its own merge, which the outer reads as the arm's
  # own order.
  @gap:branch-traverser-major
  Scenario: g_VX1_2X_unionXunionXconstantXaX_constantXbXX_constantXxXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).union(__.union(__.constant("a"), __.constant("b")), __.constant("x")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,x,a,b,x] |

  @gap:branch-traverser-major
  Scenario: g_VX1_2X_unionXunionXconstantXaX_constantXbXX_constantXxXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).union(__.union(__.constant("a"), __.constant("b")), __.constant("x")).limit(3)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | b |
      | x |

  # `choose` routes each start to ONE option, in input order.
  @gap:branch-traverser-major
  Scenario: g_VX1_3_4X_chooseXhasLabelXpersonX_valuesXnameX_constantXsXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1, 3, 4).choose(__.hasLabel("person"), __.values("name"), __.constant("s")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,s,josh] |

  # A reducing option no start was routed to emits NOTHING, never its seed
  # (BranchStep.java:130-134 drains an option only once it `hasStarts()`): lop is software, so its count
  # option is empty and only the constant arrives.
  @gap:branch-traverser-major
  Scenario: g_VX3X_localXchooseXhasLabelXpersonX_out_count_constantXzXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(3).local(__.choose(__.hasLabel("person"), __.out().count(), __.constant("z")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[z] |

  # A slice INSIDE one parent's arm output reads that arm's own order, after a first-arrival merge.
  @gap:branch-traverser-major
  Scenario: g_VX1X_dedup_localXunionXconstantX2X_constantX1XX_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).dedup().local(__.union(__.constant(2), __.constant(1)).limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  @gap:branch-traverser-major
  Scenario: g_VX1X_localXunionXconstantXxX_valuesXnameXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.constant("x"), __.values("name")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[x,marko] |

  # ── THE SAME KEY AT EVERY DEPTH ─────────────────────────────────────────────────────────────────────
  # One authority (`branchOrderOwed` + the emission key), so a fold of a branch inside a `by()`, a `map()`,
  # a `group()` value or a `local(fold().limit(local))` reads the same order the root does.

  @gap:branch-traverser-major
  Scenario: g_VX1X_unionXconstantXxX_valuesXnameXX_fold_limitXlocal_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.constant("x"), __.values("name")).fold().limit(Scope.local, 1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[x] |

  @gap:branch-traverser-major
  Scenario: g_VX1X_mapXunionXconstantXxX_valuesXnameXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.union(__.constant("x"), __.values("name")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[x,marko] |

  @gap:branch-traverser-major
  Scenario: g_VX1X_projectXaX_byXunionXconstantXxX_valuesXnameXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a").by(__.union(__.constant("x"), __.values("name")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"l[x,marko]"}] |

  @gap:branch-traverser-major
  Scenario: g_VX1_2X_group_byXlabelX_byXunionXconstantXxX_valuesXnameXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).group().by(T.label).by(__.union(__.constant("x"), __.values("name")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[x,marko,x,vadas]"}] |

  @gap:branch-traverser-major
  Scenario: g_VX1X_localXchooseXhasLabelXpersonX_unionXconstantXxX_valuesXnameXX_constantXyXX_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.choose(__.hasLabel("person"), __.union(__.constant("x"), __.values("name")), __.constant("y")).limit(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |

  # An option-map `choose(…).option(…)` takes the same key: marko is the first start and takes the person
  # option, whose sorted out() fills the slice (the reference drains the `Pick` options first when an option
  # holds a barrier — a deliberate divergence, feature-support-matrix.md).
  @gap:branch-traverser-major
  Scenario: g_V_chooseXlabelX_optionXperson_out_order_byXnameXX_optionXnone_identityX_limitX3X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(T.label).option("person", __.out().order().by("name")).option(Pick.none, __.identity()).limit(3).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | lop |
      | vadas |
