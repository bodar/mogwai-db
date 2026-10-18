Feature: mogwai addendum — a by() that yields a NULL is ABSENT at every consumer

  # PRESENCE IS VALUE NULLNESS (`ChildValue.present`, src/compiler/rel/child.ts): a by() body whose value
  # is NULL produced nothing, which is SQL's natural reading. A deliberate divergence from
  # `TraversalProduct`, which keeps a literal null (`constant([null]).unfold().sum()`) as a PRODUCTIVE value
  # (docs/feature-support-matrix.md, Deliberate divergences). Stored properties are never null, so this
  # only differs from the reference where a body manufactures a null from a literal.
  #
  # Each consumer drops the same way: project() omits the key, select()/order()/dedup()/sack()/where()
  # drop the traverser, aggregate() collects nothing, coalesce() falls through to its next arm.

  Scenario: g_VX1X_projectXxX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |

  Scenario: g_VX1X_projectXx_yX_byXconstantX1XX_byXconstantXlist_nullX_unfold_meanX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant(1)).by(__.constant([null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[1].i"}] |

  Scenario: g_VX1X_asXaX_out_asXbX_selectXa_bX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").select("a","b").by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_VX1X_out_dedupXbyXconstantXlist_nullX_unfold_sumXX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().dedup().by(__.constant([null]).unfold().sum()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  Scenario: g_VX1X_out_sackXassignX_byXconstantXlist_nullX_unfold_sumX_sack
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().sack(Operator.assign).by(__.constant([null]).unfold().sum()).sack()
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_VX1X_out_aggregateXxX_byXconstantXlist_nullX_unfold_sumX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().aggregate("x").by(__.constant([null]).unfold().sum()).cap("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[] |

  Scenario: g_VX1X_asXaX_out_asXbX_whereXa_eqXbXX_byXconstantXlist_nullX_unfold_sumX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").where("a", P.eq("b")).by(__.constant([null]).unfold().sum()).values("name")
      """
    When iterated to list
    Then the result should be empty

  # coalesce() is null-coalescing: a null sack falls through to the constant.
  Scenario: g_withSackXnullX_VX1X_projectXxX_byXcoalesceXsack_constantX1XXX
    Given the modern graph
    And the traversal of
      """
      g.withSack(null).V(1).project("x").by(__.coalesce(__.sack(), __.constant(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[1].i"}] |

  # A nested project() is a MAP field, embedded as one (it was an internal error).
  Scenario: g_VX1X_projectXxX_byXprojectXyX_byXconstantX1XXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.project("y").by(__.constant(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":{"y":1}}] |

  Scenario: g_VX1X_out_projectXxX_byXprojectXyX_byXageXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().project("x").by(__.project("y").by(__.values("age")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":{"y":27}}] |
      | m[{"x":{}}] |
      | m[{"x":{"y":32}}] |

  # A non-null mean takes the 17-digit repair (a 15-digit JSON number cannot round-trip 4/3).
  Scenario: g_VX1X_projectXxX_byXconstantXlist_1_1_2_nullX_unfold_meanX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([1,1,2,null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[1.3333333333333333].d"}] |
