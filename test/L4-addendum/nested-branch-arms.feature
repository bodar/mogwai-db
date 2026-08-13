Feature: mogwai addendum — nested branch arms (a branch inside a branch arm)

  # choose/coalesce/union whose ARM is itself a choose/coalesce/union. The generic engine
  # re-dispatches the nested branch to the element-parent branch compilers (which recurse per
  # arm), so a nested branch composes at every fan-out-tolerant consumer — root scalar
  # projection and group().by(value). classifyScalarChild recognizes the nested-scalar-arm
  # shape (elementScalarBranchArm); the emit path was already recursive. @gap:nested-branch
  # marks the family for a possible gremlin-test PR.

  @gap:nested-branch
  Scenario: g_V_out_chooseXhasLabelXpersonX_coalesceXvaluesXnameX_constantXxXX_constantXzXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().choose(__.hasLabel("person"), __.coalesce(__.values("name"), __.constant("x")), __.constant("z"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | z |
      | z |
      | z |
      | z |

  @gap:nested-branch
  @Unsupported
  Scenario: g_V_out_coalesceXchooseXhasLabelXpersonX_valuesXnameX_constantXSWXX_constantXnoneXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().coalesce(__.choose(__.hasLabel("person"), __.values("name"), __.constant("SW")), __.constant("none"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | SW |
      | SW |
      | SW |
      | SW |

  @gap:nested-branch
  Scenario: g_V_out_unionXchooseXhasLabelXpersonX_constantXPX_constantXSXX_constantXZXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().union(__.choose(__.hasLabel("person"), __.constant("P"), __.constant("S")), __.constant("Z"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | P |
      | P |
      | S |
      | S |
      | S |
      | S |
      | Z |
      | Z |
      | Z |
      | Z |
      | Z |
      | Z |

  # Mixed-shape (variant) branches whose ARM is a nested scalar-armed branch: the element arm
  # + the nested-branch scalar arm merge into one variant stream (Layer 1's scalar-arm handler
  # feeds compileVariantArm). Counts are terminal so the assertions stay row-order-independent.

  @gap:nested-branch
  @Unsupported
  Scenario: g_V_hasXname_markoX_unionXout__chooseXhasLabelXpersonX_constantXPX_constantXSXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.out(), __.choose(__.hasLabel("person"), __.constant("P"), __.constant("S"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  @gap:nested-branch
  @Unsupported
  Scenario: g_V_out_chooseXhasLabelXpersonX_out__coalesceXvaluesXlangX_constantXSWXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().choose(__.hasLabel("person"), __.out(), __.coalesce(__.values("lang"), __.constant("SW"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:nested-branch
  @Unsupported
  Scenario: g_V_groupXbyXTlabelX_byXcoalesceXvaluesXlangX_constantXnaXXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.coalesce(__.values("lang"), __.constant("n/a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[n/a,n/a,n/a,n/a]","software":"l[java,java]"}] |

  # Option-map choose() is scalar-valued, but it must also be recognized when nested
  # inside the generic child scope used by map()/local()/flatMap().

  @gap:nested-branch
  @Unsupported
  Scenario: g_V_mapXchooseXvaluesXageX_optionXbetweenX26_30X_valuesXnameXX_optionXnone_constantXunknownXX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.choose(__.values("age")).option(between(26,30), __.values("name")).option(Pick.none, __.constant("unknown")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | unknown |
      | unknown |
      | unknown |
      | unknown |

  # ---- an UNPRODUCTIVE choice takes the Pick.none option ----
  #
  # `BranchStep.applyCurrentTraverser` maps a non-productive choice traversal to `Pick.unproductive`,
  # and `pickBranches` falls back to `traversalPickOptions.get(Pick.none)` whenever no option matched
  # — so a vertex with no `lang` property takes the none arm rather than being dropped. Pinned because
  # the work index filed this as "a real wrong answer"; it is the reference's answer. Verified against
  # vendor/tinkerpop/gremlin-core/.../step/branch/BranchStep.java:155-162, 206-220.
  @gap:nested-branch-arms
  # AN UNPRODUCTIVE CHOICE IS NOT `Pick.none`, and this scenario once asserted that it was — written
  # against an earlier lowering that routed both cases to one fallthrough.
  # `values("lang")` yields NOTHING for a person, so the choice is `Pick.unproductive`
  # (`BranchStep.applyCurrentTraverser`: `product.isProductive() ? product.get() : Pick.unproductive`),
  # and `ChooseStep`'s private constructor has installed an IDENTITY traversal for that token
  # (`gremlin-core/.../branch/ChooseStep.java:65-81`). `pickBranches` therefore returns that identity
  # and never reaches `Pick.none`, which it consults only when no branch matched at all. So a person
  # emits ITSELF. The official corpus pins the identical pattern for the `values("age")` shape —
  # `Choose.feature:371-387` expects `v[lop]`/`v[ripple]`, not the `Pick.none` body — so this is our
  # addendum agreeing with the reference rather than a new claim.
  #
  # ⚠️ Do NOT try to force the unproductive input to `Pick.none` by declining the CASE: that was tried
  # and REVERTED, because declining hands the shape to a `map()`-child position the lowering does not
  # cover, so the union floor would LOSE a shape rather than correct one (§6·1). The scenario states
  # the reference's answer, which the compiler gives directly.
  Scenario: g_V_chooseXvaluesXlangXX_optionXjavaX_optionXnoneX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.values("lang")).option("java", __.constant("j")).option(Pick.none, __.constant("n"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | j |
      | j |
      | v[marko] |
      | v[vadas] |
      | v[josh] |
      | v[peter] |
