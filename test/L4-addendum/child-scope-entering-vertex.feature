Feature: mogwai addendum — a child scope does not inherit the parent chain's entering-vertex context

  # The `otherV()` demand (`needsFromV`) is carried per SCOPE, not chain-global: `inBody` CLEARS it, so
  # no child body inherits it by default. The distinction that matters is whether the child's rows BECOME
  # the traverser. An existence gate (`where`/`not`/`filter`) consumes them as a boolean, so nothing of
  # the child survives to the outer `otherV()` and the demand stays cleared; a value host (`local`/
  # `flatMap`, and a `union`/`coalesce`/`choose` arm) HANDS its rows on, so the demand rides IN — the
  # host re-injects it (`childRows`'s parameter / `inArmBody`) and the body's own edge hop mints the
  # entering vertex the outer `otherV()` reads. The second scenario is the counterexample that proves it:
  # its body mentions no `otherV()`, yet its `bothE()` must mint `fromV` because the outer `otherV()` reads it.
  #
  # A body may also read the context IT minted (the barrier-split scenarios below): the forward scan to an
  # `otherV()` is transparent across `order`/`range`/a filter, so the edge before the barrier still mints,
  # and a correlated existence body roots that mint at the subject vertex. @gap:child-scope-entering-vertex
  # marks the family.

  @gap:child-scope-entering-vertex
  Scenario: g_V_hasLabelXpersonX_whereXoutE_unionXidentity_identityXX_outE_otherV
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").where(__.outE().union(__.identity(), __.identity())).outE().otherV()
      """
    # The union inside the where() body is a fork the child owns; the trailing otherV() belongs to
    # the outer chain. marko, josh and peter have out-edges; each contributes its out-edge targets.
    When iterated to list
    Then the result should be unordered
      | result |
      | v[lop] |
      | v[vadas] |
      | v[josh] |
      | v[lop] |
      | v[ripple] |
      | v[lop] |

  @gap:child-scope-entering-vertex
  Scenario: g_V_hasXname_within_marko_rippleX_localXbothEXcreatedX_limitX1XX_otherV_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", P.within("marko", "ripple")).local(__.bothE("created").limit(1)).otherV().values("name")
      """
    # The body mentions no otherV(), but its rows BECOME the traverser, so the demand must ride IN
    # and the body's own bothE() must mint the entering vertex the outer otherV() reads.
    #
    # Restricted to the two vertices with exactly ONE created edge each, so `limit(1)` has nothing
    # to choose between: marko has only marko→lop, ripple only josh→ripple. Over the whole graph
    # this traversal is legitimately non-deterministic (josh has two created edges, lop three), and
    # a pin on an arbitrary scan choice is the defect `mise run test:perturbed` exists to find.
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | josh |

  # ─── The BODY'S OWN entering-vertex context, across a barrier split ───
  #
  # The third facet of the same rule, and the one the two scenarios above do not reach: a body may
  # read the context IT minted. `lowerElementSteps` derives `trackFromV` from the STEPS IT IS HANDED,
  # which is exactly right at the root (one call, the whole chain) and wrong for a child body that a
  # BARRIER splits in two — `outE()` lands in the prefix and `otherV()` in the suffix, so the prefix
  # call sees no reader, mints no entering vertex, and the suffix's `otherV()` throws `requires a
  # preceding edge step`. The demand is now taken from the WHOLE body before the split.
  #
  # Found by L5's rotating seed. `range`/`limit`/`skip`/`dedup` before the `otherV()` threw on the
  # materialized gate while the inlined predicate answered — a disable-safety hole — and `order()`
  # threw on BOTH, which is a plain wrong answer no differential could have reported.
  #
  # Every scenario is an EXISTENCE question, so it is deterministic even where the barrier's own
  # choice is not: `range(0, 2)` keeps up to two of an arbitrary two edges, but "has at least one
  # out-edge" does not depend on which. That is the same care the `limit(1)` scenario above takes.

  @gap:child-scope-entering-vertex
  Scenario: g_V_whereXoutE_order_byXweightX_otherVX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.outE().order().by("weight").otherV()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:child-scope-entering-vertex
  Scenario: g_V_whereXoutE_rangeX0_2X_otherVX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.outE().range(0, 2).otherV()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:child-scope-entering-vertex
  Scenario: g_V_whereXbothE_order_otherV_hasLabelXpersonXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.bothE().order().otherV().hasLabel("person")).values("name")
      """
    # The context has to survive the WHOLE suffix, not just reach the otherV(): peter is excluded
    # because its only incident edge lands on lop, which is a software.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
