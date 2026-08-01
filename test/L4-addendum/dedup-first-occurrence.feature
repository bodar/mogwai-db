Feature: mogwai addendum — dedup() keeps the FIRST occurrence, so an ordered stream stays ordered

  # `DedupGlobalStep` keeps the traverser it saw first and drops later duplicates, which means the
  # surviving traverser carries the FIRST occurrence's position in the stream — so
  # `order().by('name').dedup()` still emits in name order. We collapsed with `SELECT DISTINCT` and
  # cleared the carried encounter (a per-row-unique value cannot ride through DISTINCT without
  # defeating it), which made the whole family order-free and left the answer to SQLite's scan
  # order. It is now a GROUP BY with `MIN(encounter)`: the same set barrier, plus the order.
  #
  # These are `ordered` assertions deliberately — per test/CLAUDE.md that is only worth writing if
  # it survives `mise run test:perturbed`, and this family now does at root and in a child scope.
  # @gap:dedup-first-occurrence marks the family.

  @gap:dedup-first-occurrence
  Scenario: g_V_order_byXnameX_dedup_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by("name").dedup().values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | marko |
      | peter |
      | ripple |
      | vadas |

  @gap:dedup-first-occurrence
  Scenario: g_V_both_order_byXnameX_dedup_valuesXnameX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().both().order().by("name").dedup().values("name").limit(3)
      """
    # both() revisits vertices, so the dedup is doing real work here, and the slice reads the
    # order the dedup preserved rather than whichever three rows the scan reached first.
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | marko |

  @gap:dedup-first-occurrence
  Scenario: g_VX1X_localXout_in_order_byXnameX_dedupX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").local(__.out().in().order().by("name").dedup()).values("name")
      """
    # The CHILD-SCOPE twin: marko's co-authors revisit marko three times, and the ordered body's
    # order has to survive the collapse the same way.
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | marko |
      | peter |
