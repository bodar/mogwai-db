Feature: mogwai addendum — shape-agnostic row-ops over a variant stream

  # A VariantStream is the heterogeneous per-row union produced when branch arms disagree
  # on shape (e.g. union(values(), out()) mixes a scalar arm with an element arm). Steps
  # that must look inside a row (movement, order, value filters) cannot apply across the
  # arms — but the SHAPE-AGNOSTIC steps compose fine: count, limit, skip, range, dedup.
  # The official suite never exercises these in variant position. @gap:variant-position
  # marks the family for a possible gremlin-test PR. Counts are terminal so the assertions
  # stay deterministic regardless of row order.

  @gap:variant-position
  @Unsupported
  Scenario: g_V_hasXname_markoX_unionXvaluesXnameX_outX_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.values("name"), __.out()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  @gap:variant-position
  @Unsupported
  Scenario: g_V_hasXname_markoX_unionXvaluesXnameX_outX_limitX2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.values("name"), __.out()).limit(2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:variant-position
  @Unsupported
  Scenario: g_V_hasXname_markoX_unionXvaluesXnameX_outX_skipX1X_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.values("name"), __.out()).skip(1).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:variant-position
  @Unsupported
  Scenario: g_V_hasXname_markoX_unionXvaluesXnameX_outX_rangeX1_3X_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.values("name"), __.out()).range(1, 3).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:variant-position
  Scenario: g_V_hasXname_markoX_unionXout_outX_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.out(), __.out()).dedup().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  # ---------- the WINDOW a variant/record slice picks, not just its size ----------
  #
  # `variantSlice` and `recordSlice`'s global branch used to emit `LIMIT n` with no ORDER BY, so
  # the counts above were pinned but WHICH rows survived was arbitrary. They now order by the
  # carried emission encounter when the chain has one, which makes the window deterministic — a
  # user-visible semantic that shipped unspecified. These pin it.
  #
  # Every scenario below is deliberately SINGLE-traverser, so the expected prefix follows from
  # TinkerPop's own emission order and not from ours: with one input traverser "arm 0 fully, then
  # arm 1" is the reference's order (BranchStep.standardAlgorithm drains each option for the
  # current traverser). Do NOT add a MULTI-traverser union case here — we emit those arm-major
  # GLOBALLY where the reference is traverser-major, a separate open divergence, not a window to
  # pin. Each slice is paired with its UNSLICED form so the prefix relationship is checkable by
  # reading (the bulk-repeat-multiplicity.feature convention).
  #
  # These three hold under `mise run test:perturbed`, which is the whole reason they are written as
  # `ordered`: a variant slice's window is fixed by its `ORDER BY encounter`, not by SQLite's scan.
  # The RECORD half of the same change is NOT pinned here and must not be — measured, a record
  # stream carries no encounter at all, so `recordSlice`'s `orderByEncounter` is inert and
  # `g.V().project('n').by('name').limit(2)` picks a DIFFERENT PAIR under perturbation. See
  # outstanding-work; pinning it would assert a guarantee that does not exist.

  @gap:variant-position
  Scenario: g_VX1X_unionXvaluesXnameX_identityX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.values("name"), __.identity())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
      | v[marko] |

  @gap:variant-position
  @Unsupported
  Scenario: g_VX1X_unionXvaluesXnameX_identityX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.values("name"), __.identity()).limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |

  @gap:variant-position
  @Unsupported
  Scenario: g_VX1X_unionXvaluesXnameX_identityX_skipX1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.values("name"), __.identity()).skip(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | v[marko] |
