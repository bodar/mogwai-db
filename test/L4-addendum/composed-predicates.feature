Feature: mogwai addendum — infix-composed predicates (P/TextP .and()/.or()/.negate())

  # Gremlin.g4's `traversalPredicate` has three INFIX alternatives —
  #   traversalPredicate DOT K_AND    LPAREN traversalPredicate RPAREN
  #   traversalPredicate DOT K_OR     LPAREN traversalPredicate RPAREN
  #   traversalPredicate DOT K_NEGATE LPAREN RPAREN
  # — and none of them carries a `#label`, so ANTLR folds all three into
  # `TraversalPredicateContext` rather than minting a `TraversalPredicate_<op>Context`. The
  # front-end matched only the labelled prefix form, so a composed predicate was FLATTENED into two
  # sibling step args: `has(k, P1.or(P2))` reached the compiler as `has(k, P1, P2)`, and every
  # consumer reads args[1] and ignores args[2] — silently dropping the second operand and answering
  # a different question. Unwrapped it instead threw a raw SQLite bind error on the stray Pred.
  #
  # Found by L5's fast-path differential (test/L5-properties/), which caught it as a disagreement
  # between the inlined and generic predicate paths. Fixing it gained +11 L3 scenarios. The official
  # corpus covers the shape but thinly, and never at depth or across every host, so these scenarios
  # pin the composition rules the fix established: nests to any depth, works in every predicate
  # host, and negate() reuses the `not` op.
  @gap:composed-predicates

  @Unsupported
  Scenario: g_V_hasXname_startingWithXmX_or_startingWithXpXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", TextP.startingWith("m").or(TextP.startingWith("p"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | peter |

  # The presentation the differential actually flagged: the same predicate inside a filter() body,
  # where the inline predicate path lowers it rather than the top-level has().
  @Unsupported
  Scenario: g_V_filterXhasXname_startingWithXmX_or_startingWithXpXXX
    Given the modern graph
    And the traversal of
      """
      g.V().filter(__.has("name", TextP.startingWith("m").or(TextP.startingWith("p")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | peter |

  @Unsupported
  Scenario: g_V_whereXhasXname_startingWithXmX_or_startingWithXpXXX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.has("name", TextP.startingWith("m").or(TextP.startingWith("p")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | peter |

  # not() over a composed predicate — the arm must be the negation of the WHOLE composition, not of
  # its first operand.
  @Unsupported
  Scenario: g_V_notXhasXname_startingWithXmX_or_startingWithXpXXX
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.has("name", TextP.startingWith("m").or(TextP.startingWith("p")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | ripple |

  Scenario: g_V_hasXage_gtX20X_and_ltX30XX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.gt(20).and(P.lt(30))).values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |

  # negate() — the third infix form, lowered through the existing `not` op.
  Scenario: g_V_hasXage_gtX30X_negateX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.gt(30).negate()).values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |

  # Nesting: a composition whose own operand is a composition. Left-leaning tree, any depth.
  @Unsupported
  Scenario: g_V_hasXname_startingWithXmX_or_startingWithXpX_or_startingWithXrXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", TextP.startingWith("m").or(TextP.startingWith("p")).or(TextP.startingWith("r"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | peter |
      | ripple |

  # Mixed connectives: (gt AND lt) OR eq. Pins operator grouping, not just that both arms survive.
  Scenario: g_V_hasXage_gtX25X_andXltX33XX_orXeqX35XXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age", P.gt(25).and(P.lt(33)).or(P.eq(35))).values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
