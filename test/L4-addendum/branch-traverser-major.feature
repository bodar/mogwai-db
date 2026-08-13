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
  @Unsupported
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
  @Unsupported
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXvaluesXnameX_foldX_valuesXageX_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.values("name").fold(), __.values("age").fold()).limit(2)
      """
    # The LIST merge. Each arm folds per traverser (a scoped fold, not a batched barrier), so josh
    # contributes [josh] then [32] before marko's pair.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh] |
      | l[d[32].i] |

  @gap:branch-traverser-major
  @Unsupported
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_unionXvaluesXnameX_valuesXageX_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("name").union(__.values("name"), __.values("age").fold()).limit(2)
      """
    # The MIXED-SHAPE (variant) merge, whose arms carry no layout of their own — the fork is handed
    # to it explicitly. Same answer shape: josh's scalar then josh's list.
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | l[d[32].i] |

  @gap:branch-traverser-major
  @Unsupported
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

  @gap:branch-traverser-major
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
