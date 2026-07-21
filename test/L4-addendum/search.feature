Feature: mogwai addendum — tinker.search over collection + nested-JSON property values

  # The official Call.feature only searches SCALAR string properties on the modern graph. These
  # scenarios prove the ValueNode-aware write-path indexer (Step 6) handles COLLECTION and
  # NESTED-JSON values end-to-end: a list value is searchable both via its logical toString
  # (kind='value') and via an individual element (kind='jsonleaf'); a nested map value is
  # searchable via its keys (kind='jsonkey') and leaf values (kind='jsonleaf'). Matching is
  # case-insensitive (a documented divergence — what lets the trigram index serve LIKE). We walk
  # each matched property to its owner and read a stable scalar ("title") so results compare.
  # @gap:search marks the family for an upstream gremlin-test give-back (no official coverage).

  @gap:search
  Scenario: search a list-valued property by one of its elements
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "brave"]).element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |

  @gap:search
  Scenario: search a list-valued property by a case-insensitive element substring
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search").with("search", "BRAV").element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |

  @gap:search
  Scenario: search a nested map property by a KEY
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "zone"]).element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter two |

  @gap:search
  Scenario: search a nested map property by a leaf VALUE
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "london"]).element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter two |

  @gap:search
  Scenario: a scalar title is still searchable alongside the collections
    Given the search graph
    And the traversal of
      """
      g.call("tinker.search", ["search": "chapter"]).element().values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |
      | chapter two |
