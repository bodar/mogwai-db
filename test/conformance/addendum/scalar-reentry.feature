Feature: mogwai addendum — scalar-stream re-entry

  # Valid traversals whose current object is a SCALAR (values()/count()/a projected value).
  # The official suite exercises these step families over ELEMENTS, but not consistently in
  # scalar position. Each scenario is a combination we implemented for combinatorial
  # completeness. @gap:scalar-position marks the family for a possible gremlin-test PR.

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_whereXisXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").where(__.is(gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXnameX_mapXtoUpperX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("name").map(__.toUpper())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | MARKO |
      | VADAS |
      | JOSH |
      | PETER |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_mapXcountX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").map(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_chooseXidentityX_optionXbetween_youngX_optionXnone_oldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").choose(__.identity()).option(between(26,30),__.constant("young")).option(Pick.none,__.constant("old"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | young |
      | young |
      | old |
      | old |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_mathX_x2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").math("_ * 2")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[58.0].d |
      | d[54.0].d |
      | d[64.0].d |
      | d[70.0].d |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_coalesceXisXgtX30XX_constantX0XX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").coalesce(__.is(gt(30)),__.constant(0))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |
      | d[0].i |
      | d[0].i |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_unionXconstantXaX_constantXbXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").union(__.constant("a"),__.constant("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | a |
      | a |
      | a |
      | b |
      | b |
      | b |
      | b |

  @gap:scalar-position
  Scenario: g_V_hasLabelXpersonX_valuesXageX_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").aggregate("a").cap("a").unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  @gap:scalar-position
  Scenario: g_injectXstrX_splitX_X
    Given an empty graph
    And the traversal of
      """
      g.inject("a,b,c").split(",")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c] |

  @gap:scalar-position
  Scenario: g_injectX0X_V_count
    Given the modern graph
    And the traversal of
      """
      g.inject(0).V().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:scalar-typed
  Scenario: g_injectXbiglongX
    Given an empty graph
    And the traversal of
      """
      g.inject(9007199254740993L)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740993].l |
