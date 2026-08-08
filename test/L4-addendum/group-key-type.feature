Feature: mogwai addendum — a GROUP KEY keeps the stored property's type

  # `group()`/`groupCount()` keyed on a property emitted `gk` alone, with nowhere for the property's
  # stored `vtype` to ride — so the key framed by JS inference and everything the SQLite storage class
  # cannot recover came back wrong: a `datetime` key as raw MILLIS, a `uuid` key as a String. The
  # VALUES were right and the entry COUNT was right, which is what kept it out of every assertion.
  #
  # It stayed invisible for a different reason worth recording: `GroupKey.scalar` declared its type
  # OPTIONAL and the legacy producer simply omitted it. An omission reads as "no opinion" rather than
  # as "framed wrong", so nothing — not a reviewer, not the compiler — could tell the two apart. The
  # field is now REQUIRED, and this was the first defect that surfaced.
  #
  # `gkt` is the column name RelIR's own barrier already uses, and `propTypeFor` is the sibling read
  # `order().by(key)` and `aggregate().by(key)` spend, so the two spines cannot describe one key
  # differently. Grouping spans (value, type) for the reason `dedup()` does: equal values of
  # different stored types are distinct Gremlin keys.
  #
  # @gap:group-key-type marks the family.

  @gap:group-key-type
  Scenario: g_V_groupCountXX_byXdtX
    Given the typed graph
    And the traversal of
      """
      g.V().groupCount().by("dt")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"dt[2024-01-01T00:00:00Z]":"d[1].l"}] |

  @gap:group-key-type
  Scenario: g_V_groupXX_byXdtX_byXcountX
    Given the typed graph
    And the traversal of
      """
      g.V().group().by("dt").by(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"dt[2024-01-01T00:00:00Z]":"d[1].l"}] |

  # The exact int64 tail: a long past 2^53 is stored as decimal TEXT, so an untagged key hands the
  # wire a String where a Long belongs.
  @gap:group-key-type
  Scenario: g_V_groupCountXX_byXnX
    Given the typed graph
    And the traversal of
      """
      g.V().groupCount().by("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[9007199254740993].l":"d[1].l"}] |

  # A key whose type the storage class DOES determine is unaffected — the tag agrees with the
  # inference, so this pins that carrying it changed nothing where nothing needed changing.
  @gap:group-key-type
  Scenario: g_V_hasLabelXpersonX_groupCountXX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").groupCount().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[1].l","vadas":"d[1].l","josh":"d[1].l","peter":"d[1].l"}] |
