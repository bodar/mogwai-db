Feature: mogwai addendum — a creation with no label of its own carries NO label

  # `addV()` with no argument stores NOTHING. That is the whole rule now, and it is the corpus's own:
  # `Labels.feature` `g_addV_labels` seeds `g.addV()` and asserts `labels()` has `count of 0`.
  # `Vertex.DEFAULT_LABEL` ("vertex") is only what a LABEL-LESS vertex REPORTS for `label()`; writing
  # it into `vertex_labels` would make that scenario answer 1.
  #
  # This file used to pin BOTH regimes, because the answer depended on the graph's declared
  # `LabelCardinality` and a route that hardcoded one of them would have passed the other half. That
  # ambiguity is gone: mogwai-db is multi-label only (`src/api.ts`), so there is one answer and this
  # is it. The single-label halves were deleted with the capability rather than left asserting a
  # regime nothing can construct.

  @gap:creation-label-cardinality
  Scenario: g_addV_bare_carries_no_label
    Given the empty graph
    And the traversal of
      """
      g.addV().property("name", "nobody")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().hasLabel(\"vertex\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"nobody\")"
    And the result should be unordered
      | result |
      | v[nobody] |

  # More than one label is ORDINARY now, not a refusal — the case that used to raise under ONE.
  @gap:creation-label-cardinality
  Scenario: g_addV_two_labels_creates_both
    Given the empty graph
    And the traversal of
      """
      g.addV("person", "employee")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"person\")"
    And the graph should return 1 for count of "g.V().hasLabel(\"employee\")"
