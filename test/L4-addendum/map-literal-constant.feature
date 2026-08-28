Feature: mogwai addendum — a MAP LITERAL as a produced value (constant([k:v]))

  # G5 (map-support finishing plan): a [k:v] map literal as a PRODUCED value — constant([k:v]) is the
  # per-row twin of inject([k:v]) (injectMap). It replaces each traverser's value with the same
  # compile-time map (mapLiteralBlob, the self-describing pairs blob every map producer shares), so the
  # whole re-enterable map tail composes over it: unfold(), select(<key>), select(Column.*),
  # count(Scope.local), and as()/select() (the literal's string keys are the map's static key set, so a
  # constant([…]).as(m).select(m).select(k) resolves like every other aliased map — G4). @gap:map-literal.

  @gap:map-literal
  Scenario: g_injectX1X_constantX_a_1_b_2_X
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant(["a":1,"b":2])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i","b":"d[2].i"}] |

  @gap:map-literal
  Scenario: g_injectX1X_constantX_a_1_b_2_X_unfold
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant(["a":1,"b":2]).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"d[1].i"}] |
      | m[{"b":"d[2].i"}] |

  @gap:map-literal
  Scenario: g_injectX1X_constantX_a_1_b_2_X_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant(["a":1,"b":2]).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  @gap:map-literal
  Scenario: g_injectX1X_constantX_a_1_b_2_X_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.inject(1).constant(["a":1,"b":2]).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A constant map over an ELEMENT stream — one map per traverser, composing with unfold+select.
  @gap:map-literal
  Scenario: g_V_hasLabelXpersonX_limitX2X_constantX_x_9_X_unfold_selectXvaluesX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(2).constant(["x":9]).unfold().select(values)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].i |
      | d[9].i |
