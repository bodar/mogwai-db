Feature: mogwai addendum — a LIST LITERAL as a produced value (constant([a, b, …]))

  # The list twin of the map `constant([k:v])` (map-literal-constant.feature). `constant([a,b,…])` is the
  # per-row twin of `inject([a,b,…])` (injectList) — the SAME listLiteralBlob, produced at a different
  # position. It replaces each traverser's value with the compile-time list, so the whole re-enterable
  # list tail composes over it: unfold(), count/sum(Scope.local), order(Scope.local), and as()/select().
  # @gap:list-literal.

  @gap:list-literal
  Scenario: g_injectX1X_constantX1_2_3X
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant([1,2,3])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i,d[3].i] |

  @gap:list-literal
  Scenario: g_injectX1X_constantX1_2_3X_unfold
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant([1,2,3]).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |
      | d[3].i |

  @gap:list-literal
  Scenario: g_injectX1X_constantX1_2_3X_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant([1,2,3]).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:list-literal
  Scenario: g_injectX1X_constantX1_2_3X_sumXlocalX
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant([1,2,3]).sum(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].i |

  # A constant list over an ELEMENT stream — one list per traverser, unfolding per row.
  @gap:list-literal
  Scenario: g_V_hasLabelXpersonX_limitX2X_constantXx_yX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(2).constant(["x","y"]).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | y |
      | x |
      | y |
