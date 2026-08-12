Feature: mogwai addendum — TextP substring predicates

  # containing/startingWith/endingWith over a stored property use the generic typed LIKE predicate.
  # These scenarios pin two mogwai characteristics the official corpus does not cover:
  #   1. Matching is CASE-INSENSITIVE (a documented divergence from TinkerPop's case-sensitive
  #      String.contains), and
  #   2. an anchored op (startingWith) confirms POSITION, excluding a mid-string hit.
  # A <3-char term is the same correct LIKE check — never fail-closed.

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

  Scenario: endingWith
    Given the search graph
    And the traversal of
      """
      g.V().has("title", TextP.endingWith("one")).values("title")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | chapter one |

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
