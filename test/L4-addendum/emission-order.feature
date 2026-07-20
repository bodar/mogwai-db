Feature: mogwai addendum — positional determinism (canonical emission order, Stage B)

  # limit/range/skip/tail/fold after a fan-out pick or order a DETERMINISTIC subset. Without a
  # threaded emission order they relied on incidental SQLite row order; a demand pre-pass now
  # seeds a canonical `encounter` (rowid at the source, refined at each fan-out; superseded by
  # order()), and these consumers ORDER BY it. The official corpus rarely pins the exact subset
  # a bare slice returns, so these fix the composition. @gap:emission-order marks the family.

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().limit(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[27].i |
      | d[29].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_tailX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().tail(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_order_skipX2X
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().skip(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @gap:emission-order
  Scenario: g_V_valuesXageX_orderXdescX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().by(desc).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[35].i,d[32].i,d[29].i,d[27].i] |

  # union emits arm 0 fully before arm 1 (TinkerPop's contract); limit after a mixed/element
  # union must not interleave arms. josh(4): out={lop,ripple} (arm 0), in={marko} (arm 1);
  # limit(2) is the two out-neighbours, never marko. Guards the branch-merge encounter re-mint.
  @gap:emission-order
  Scenario: g_V4_unionXout_inX_limitX2X_name
    Given the modern graph
    And the traversal of
      """
      g.V(4).union(__.out(), __.in()).limit(2).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |
