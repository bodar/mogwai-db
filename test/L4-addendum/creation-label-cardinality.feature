Feature: mogwai addendum — a creation with no label of its own asks the GRAPH, not the step

  # `addV()` with no argument has two right answers and the graph's declared LabelCardinality picks
  # between them (`insertVertex`, and TinkerPop's own `Vertex.DEFAULT_LABEL` rule): where the
  # cardinality demands at least one label the new vertex takes `vertex`, and where it permits zero it
  # carries none at all.
  #
  # Pinned here because it is the rule the RelIR write route was missing, not a rule anything doubted.
  # That route declined a bare `addV()` on the grounds that the answer was "a property of the store" —
  # true, and one step short: the cardinality is request-scope configuration settled before a compile
  # starts, so it is a compile-time answer as soon as the lowering is handed it. These two scenarios
  # are what makes the answer OBSERVABLE from both regimes, so a route that guessed one of them (which
  # is what writing `vertex` unconditionally would be) fails rather than passing the single-label half.
  #
  # The official corpus reaches a bare `addV()` many times and a zero-label graph only through
  # @MultiLabel scenarios, and never the two together — so neither half pins the OTHER regime, which
  # is exactly where a route that hardcoded one of them survives.

  @gap:creation-label-cardinality
  Scenario: g_addV_bare_takes_the_default_label_under_one
    Given the empty graph
    And the traversal of
      """
      g.addV().property("name", "nobody")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"vertex\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"nobody\")"

  @gap:creation-label-cardinality
  @MultiLabel
  Scenario: g_addV_bare_carries_no_label_under_zero_or_more
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

  # A label COUNT the cardinality forbids is a REFUSAL, and it is the reference's own — so it must
  # still raise the message the conformance suite matches on rather than becoming a silent decline
  # that answers something else. Under ONE, two labels is that case.
  @gap:creation-label-cardinality
  Scenario: g_addV_two_labels_under_one_raises
    Given the empty graph
    And the traversal of
      """
      g.addV("person", "employee")
      """
    When iterated to list
    Then the traversal will raise an error
