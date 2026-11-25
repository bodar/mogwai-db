Feature: mogwai addendum — tinker.search matches string property values only

  # The official Call.feature only searches SCALAR string properties on the modern graph.
  # `tinker.search` reads the `property_fts` index, which holds string values only (every other
  # reader of it, TextP and regex, is `P<String>`). TinkerGraph also matches the toString() of a
  # list or map value (`[a, b]`, `{k=v}`); we do not. That is a docs/limitations.md §3 row.
  # Matching is case-insensitive (a documented divergence — what lets the trigram index serve LIKE).
  # We walk each matched property to its owner and read a stable scalar ("title") so results compare.
  # @gap:search marks the family for an upstream gremlin-test give-back (no official coverage).

  @gap:search
  Scenario: a list-valued property is not matched by one of its elements
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "brave"]).element().values("title")
      """
    When iterated to list
    Then the result should be empty

  @gap:search
  Scenario: a nested map property is not matched by a leaf VALUE
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "london"]).element().values("title")
      """
    When iterated to list
    Then the result should be empty

  @gap:search
  Scenario: a scalar string title is searchable case-insensitively
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search").with("search", "CHAPTER").element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |
      | chapter two |
