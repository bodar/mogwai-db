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
