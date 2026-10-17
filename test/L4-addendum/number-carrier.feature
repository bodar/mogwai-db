Feature: mogwai addendum — every number carrier keeps its CLASS at every depth, or the traversal declines

  # The class is EXACT (build plan §6·7): a member inside a list, a map key, a by()-position fold and a
  # stored property each frame the Java class the reference holds. A BigDecimal reads its SCALE from its
  # carrier through ONE authority (`bigDecimalOfCarrier`, `src/gremlin/float.ts`) — an integral source is
  # `BigDecimal.valueOf(long)`, scale 0 (`NumberHelper.java:850-859`). A literal no carrier keeps (a NaN —
  # SQLite stores it as NULL — or a negative-scale BigDecimal) declines (`ir/uncarried-literal.ts`).

  Scenario: g_injectX1000X_asNumberXBIGDECIMALX_fold_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(1000).asNumber(GType.BIGDECIMAL).fold().asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | [1000] |

  Scenario: g_injectX10000000X_asNumberXBIGDECIMALX_projectXaX_byXidentityX_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(10000000).asNumber(GType.BIGDECIMAL).project("a").by(identity()).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | {a=10000000} |

  Scenario: g_VX1X_projectXaX_byXconstantXl1_2_1dX_unfold_barrier_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a").by(constant([1, 2, 1.0d]).unfold().barrier().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"l[d[1].i,d[2].i,d[1.0].d]"}] |

  @Unsupported
  Scenario: g_injectXNaN_1_NaNX_fold
    Given the empty graph
    And the traversal of
      """
      g.inject(NaN, 1, NaN).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[NaN],d[1].i,d[NaN]] |

  @Unsupported
  Scenario: g_injectX1dE7X_asNumberXBIGDECIMALX
    Given the empty graph
    And the traversal of
      """
      g.inject(1.0e7d).asNumber(GType.BIGDECIMAL).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 1.0E+7 |
