Feature: mogwai addendum — typed property values (extended serializers)

  # Read back each stored property type end-to-end: our write channel → SQLite (typed `vtype`
  # column) → our hand-rolled GraphBinary serializers → decode by the real gremlin client.
  # This exercises the serializers the client leaves as TODOs (BigDecimal/Char/Duration) plus
  # long > 2^53, datetime and uuid — as SCENARIOS, not just byte vectors. @gap:typed marks
  # them for a gremlin-test PR (the serializers are the client's own unchecked TODOs).

  @gap:typed
  Scenario: g_V_valuesXnX_bigLong
    Given the typed graph
    And the traversal of
      """
      g.V().values("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740993].l |

  @gap:typed
  Scenario: g_V_valuesXbdX_bigDecimal
    Given the typed graph
    And the traversal of
      """
      g.V().values("bd")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bd[3.141592653589793238462643383279] |

  @gap:typed
  Scenario: g_V_valuesXduX_duration
    Given the typed graph
    And the traversal of
      """
      g.V().values("du")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | du[90500000000] |

  @gap:typed
  Scenario: g_V_valuesXdtX_datetime
    Given the typed graph
    And the traversal of
      """
      g.V().values("dt")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | dt[2024-01-01T00:00:00Z] |

  @gap:typed
  Scenario: g_V_valuesXuX_uuid
    Given the typed graph
    And the traversal of
      """
      g.V().values("u")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 0263f28b-eff9-4c17-8e33-0b41c74b6d4c |

  @gap:typed
  Scenario: g_V_valuesXbdX_isXtypeOfXBIGDECIMALXX
    Given the typed graph
    And the traversal of
      """
      g.V().values("bd").is(typeOf(GType.BIGDECIMAL))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | bd[3.141592653589793238462643383279] |
