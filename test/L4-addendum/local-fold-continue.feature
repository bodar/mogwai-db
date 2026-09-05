Feature: mogwai addendum — a fold() that CONTINUES mid-body is scoped PER ORIGIN, and SEEDS empties

  # `local(__.out().fold().unfold())` folds the ENTERING traverser's sub-stream (not the whole frontier),
  # then re-expands it. LocalStep drains one entering start's localTraversal fully and reset()s before the
  # next (vendor/tinkerpop/gremlin-core/.../step/branch/LocalStep.java:59-97), so the fold's barrier
  # accumulator is per entering vertex. A GLOBAL fold would pool every vertex's out-neighbours into ONE
  # list and answer the whole frontier for each — the wrong answer this file pins against.
  #
  # Two forces shape the lowering (foldPerOrigin, list.ts):
  #  - `fold` is CHANNEL_GROUP_POLICY 'undefined', so it can never be a grouped-Aggregate passenger; the
  #    per-origin fold CONSULTS `origin` as a GROUP BY key and re-declares it as a channel on the output,
  #    then unfold()'s explode carries it forward.
  #  - `fold` is SEEDED — an empty sub-stream emits `[]`, not nothing (FoldStep's ArrayListSupplier). But
  #    GROUP BY origin drops an origin whose sub-stream is empty, so the fold LEFT JOINs the origin DOMAIN
  #    (ChainCtx.originDomain, one row per entering traverser) and COALESCEs the misses to `[]`.
  # A TERMINAL fold reaches this via scalarChild's correlated-list arm; this is the CONTINUING form.
  # Fan-out rejoin authority plan (docs/2026-09-05-fan-out-rejoin-authority-plan.md §7 C3, family 3).

  # ---- the sharpest distinguisher: list length per origin == out-degree, NOT the frontier size (6) ----

  Scenario: g_V_localXout_fold_countXlocalXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().fold().count(Scope.local))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[0].l |
      | d[2].l |
      | d[0].l |
      | d[1].l |

  # ---- a per-origin ORDER inside the fold survives the round-trip: first out-neighbour by name ----

  Scenario: g_V_localXout_orderXbyXnameXX_fold_unfold_limitX1XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().order().by("name").fold().unfold().limit(1)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | lop |
      | lop |

  # ---- nested round-trip: fold, unfold, retype, fold AGAIN — one name-list per PERSON, empty SEEDED [] ----

  Scenario: g_V_hasLabelXpersonX_localXout_fold_unfold_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.out().fold().unfold().values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[vadas,lop,josh] |
      | l[] |
      | l[lop,ripple] |
      | l[lop] |

  # ---- the flattened multiset (fold+unfold is per-origin identity): every out-neighbour, once per edge ----

  Scenario: g_V_localXout_fold_unfoldX_name
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().fold().unfold()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | lop |
      | ripple |
      | lop |
