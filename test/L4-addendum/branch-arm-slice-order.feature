Feature: mogwai addendum — a drop-slice inside a branch-merge arm keeps the right COUNT

  # A slice that DROPS rows (limit/range) inside a branch-merge arm (union/choose/coalesce/optional)
  # keeps N of the traversers in the arm's stream. Over an UNORDERED incoming stream that is "some N":
  # which traverser survives is the plan's scan order (a fast path such as propertySeek may change it),
  # and that is an accepted divergence (docs/feature-support-matrix.md, Deliberate divergences). What
  # must hold is the count — a slice that lost or duplicated a row would be a wrong answer. With an
  # explicit order() before the branch the survivor is determined, and asserted.
  #
  # Modern graph: marko(29), vadas(27), lop(software), josh(32), ripple(software), peter(35).

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_unionXhasXnameX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).union(__.has("name").limit(1), __.identity()).values("name")
      """
    # age<=29 = {marko, vadas}; arm1 keeps one of them, arm2 keeps both.
    When iterated to list
    Then the result should have a count of 3

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_unionXlimitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).union(__.limit(1), __.identity()).values("name")
      """
    When iterated to list
    Then the result should have a count of 3

  @gap:branch-arm-slice-order
  Scenario: g_V_unionXhasXlangX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.has("lang").limit(1), __.identity()).values("name")
      """
    # has(lang) = {lop, ripple}, limit(1) keeps one; identity keeps all six.
    When iterated to list
    Then the result should have a count of 7

  @gap:branch-arm-slice-order
  Scenario: g_V_hasXage_lteX29XX_orderXX_unionXhasXnameX_limitX1X__identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.lte(29)).order().union(__.has("name").limit(1), __.identity()).values("name")
      """
    # An explicit order() before the branch pins the incoming order, so the arm slice keeps the
    # first in that order: marko.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |
