Feature: mogwai addendum — shape-agnostic row-ops over a variant stream

  # A VariantStream is the heterogeneous per-row union produced when branch arms disagree
  # on shape (e.g. union(values(), out()) mixes a scalar arm with an element arm). Steps
  # that must look inside a row (movement, order, value filters) cannot apply across the
  # arms — but the SHAPE-AGNOSTIC steps compose fine: count, limit, skip, range, dedup.
  # The official suite never exercises these in variant position. @gap:variant-position
  # marks the family for a possible gremlin-test PR. Counts are terminal so the assertions
  # stay deterministic regardless of row order.

  @gap:variant-position
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
