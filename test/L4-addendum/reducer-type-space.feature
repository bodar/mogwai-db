Feature: mogwai addendum — reducers use Gremlin type space rather than SQLite storage class

  # An exact long outside JavaScript's safe integer range rides through SQLite as decimal TEXT.
  # The official corpus never carries that representation through a reducer, so these scenarios
  # distinguish comparison/arithmetic on the Gremlin value from SQLite's storage-class policy.
  # Legacy still applies the storage-class guard/order; §14 permits RelIR to be ahead, so every
  # scenario pins the route whose answer this increment changes.

  @gap:reducer-type-space @SpineRel
  Scenario: g_injectXlarge_long_1LX_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 1L).sum()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740994].d |
    # `.d` pins the VALUE, and the TYPE is a KNOWN divergence: a sum of longs is a LONG in the
    # reference (NumberHelper keeps the narrowest common class and promotes only on overflow), where
    # we report SQLite's aggregate storage class. That is the numeric TOWER — §13g·4, deliberately a
    # separate increment — so this scenario locks in the value this change fixed (it was `1`) without
    # claiming the type is right.

  @gap:reducer-type-space @SpineRel
  Scenario: g_injectXlarge_long_1LX_meanX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 1L).mean()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4503599627370497].d |

  @gap:reducer-type-space @SpineRel
  Scenario: g_injectX10L_negative_large_longX_minX
    Given the empty graph
    And the traversal of
      """
      g.inject(10L, -9007199254740993L).min()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[-9007199254740993].l |

  @gap:reducer-type-space @SpineRel
  Scenario: g_injectX10L_negative_large_longX_maxX
    Given the empty graph
    And the traversal of
      """
      g.inject(10L, -9007199254740993L).max()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[10].l |

  # A MIXED type space fails closed. `NumberHelper.min`/`max` end in `a.compareTo(b)` for a non-Number
  # pair, so `Integer.compareTo(String)` throws and Orderability is never consulted in this position.
  # The refusal is a property of the ROWS, so it rides the reducer error channel out of the aggregate.
  @gap:reducer-type-space @SpineRel
  Scenario: g_injectX1_aX_minX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(1, "a").min()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "mixed Gremlin type spaces"

  @gap:reducer-type-space @SpineRel
  Scenario: g_injectX1_aX_maxX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(1, "a").max()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "mixed Gremlin type spaces"
