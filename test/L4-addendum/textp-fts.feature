Feature: mogwai addendum — TextP substring predicates over the property_fts trigram index

  # containing/startingWith/endingWith with a >=3-char term over a stored property are served
  # by the property_fts trigram index (a fast path over the generic LIKE, result-equivalent).
  # These scenarios pin two mogwai characteristics the official corpus does not cover:
  #   1. Matching is CASE-INSENSITIVE (a documented divergence from TinkerPop's case-sensitive
  #      String.contains — it is what lets the trigram index serve LIKE), and
  #   2. an anchored op (startingWith) confirms POSITION, excluding a mid-string hit.
  # A <3-char term stays a (correct, unindexed) LIKE scan — never fail-closed. @gap:textp marks
  # the family for an upstream give-back.

  @gap:textp
  Scenario: containing matches case-insensitively (documented divergence)
    Given the search graph
    And the traversal of
      """
      g.V().has("title", TextP.containing("CHAPTER")).values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |
      | chapter two |

  @gap:textp
  Scenario: startingWith confirms position (excludes a mid-string hit)
    Given the search graph
    And the traversal of
      """
      g.V().has("title", TextP.startingWith("chapter")).values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |
      | chapter two |

  @gap:textp
  Scenario: endingWith over the index
    Given the search graph
    And the traversal of
      """
      g.V().has("title", TextP.endingWith("one")).values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |

  @gap:textp
  Scenario: a sub-3-char substring still matches via the unindexed LIKE fallback
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", TextP.endingWith("as")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
