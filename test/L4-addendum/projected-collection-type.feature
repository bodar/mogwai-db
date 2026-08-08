Feature: mogwai addendum — a PROJECTED collection keeps its members' types, and a productive NULL is a value

  # `aggregate('a').by(k)` folded its members BARE: the projection declared the value column and not
  # the type column beside it, so a per-row stored type had nowhere to ride. Everything the SQLite
  # storage class cannot recover was then re-inferred at the wire — a datetime came back as raw
  # millis, a UUID and a big long as Strings. `values(k).fold()` over the same property was already
  # right, which is what makes this a carriage gap rather than a semantics question.
  #
  # The reason it stayed open is worth recording: a `typed` list used to be a CONSTANT descriptor, so
  # claiming the type REPLACED the list's other fields — including `productiveNull`, which says a NULL
  # member is a real value under `ProductiveByStrategy`. That coupling was written down as an open
  # question about `MaxLocalStep`; it was never that. With the member type channel spelled as the same
  # union a row's type uses, the tag is a widening and the two travel together.
  #
  # @gap:projected-collection-type marks the family.

  @gap:projected-collection-type
  Scenario: g_V_aggregateXaX_byXdtX_capXaX
    Given the typed graph
    And the traversal of
      """
      g.V().aggregate("a").by("dt").cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[dt[2024-01-01T00:00:00Z]] |

  # The exact int64 tail: a long past 2^53 is stored as decimal TEXT, so an untyped fold hands the
  # wire a String rather than a Long.
  @gap:projected-collection-type
  Scenario: g_V_aggregateXaX_byXnX_capXaX
    Given the typed graph
    And the traversal of
      """
      g.V().aggregate("a").by("n").cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[9007199254740993].l] |

  # NB a UUID member is deliberately NOT asserted here: this harness stringifies a decoded UUID, so
  # such a scenario would pass under both encodings and pin nothing. `dt` and `n` are the two that
  # actually discriminate — a datetime that lost its tag comes back as raw millis and a big long as a
  # String, and both are visible in the table.

  # A by(TRAVERSAL) projection is the same fact through the other arm: the per-input window narrowed
  # to (value, ordinal, rank) and dropped the type column on the way.
  @gap:projected-collection-type
  Scenario: g_V_aggregateXaX_byXvaluesXdtXX_capXaX
    Given the typed graph
    And the traversal of
      """
      g.V().aggregate("a").by(__.values("dt")).cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[dt[2024-01-01T00:00:00Z]] |

  # A LOCAL reducer over a typed collection returns the member itself, so its exact class survives —
  # this is the argmax reading the winner's own tag rather than SQLite's storage class.
  @gap:projected-collection-type
  Scenario: g_V_aggregateXaX_byXnX_capXaX_maxXlocalX
    Given the typed graph
    And the traversal of
      """
      g.V().aggregate("a").by("n").cap("a").max(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740993].l |

  # ProductiveByStrategy keeps one explicit NULL member per unproductive traverser, and that NULL is a
  # REAL result to a reducer: `Operator.max` over an all-null input reduces to null and
  # `ReducingBarrierStep` has seen starts, so the reference emits ONE null traverser rather than
  # nothing (gremlin-core/.../step/map/MaxGlobalStep.java:43-46 + .../util/NumberHelper.java `max`;
  # `MaxLocalStep.java:45-56` splits on the same null).
  @gap:projected-collection-type
  Scenario: g_withStrategiesXProductiveByX_V_aggregateXaX_byXfooX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null,null,null,null,null] |

  @gap:projected-collection-type
  Scenario: g_withStrategiesXProductiveByX_V_aggregateXaX_byXfooX_capXaX_maxXlocalX
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").max(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  # The same null, one shape further on: unfolded back to a stream and reduced GLOBALLY. Every retype
  # between the collection and the reducer has to carry the flag, and each one that did not turned the
  # reference's single null into an empty result.
  @gap:projected-collection-type
  Scenario: g_withStrategiesXProductiveByX_V_aggregateXaX_byXfooX_capXaX_unfold_max
    Given the modern graph
    And the traversal of
      """
      g.withStrategies(ProductiveByStrategy).V().aggregate("a").by("foo").cap("a").unfold().max()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
