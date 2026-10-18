Feature: mogwai addendum — a null is a value to within/without and to math(), and a set op keeps typed members apart

  # An all-null mean() is NULL, and a map() body whose value is NULL produced nothing (presence is value
  # nullness — a documented divergence from the reference's productive null, which math() then refuses).
  Scenario: g_VX1X_out_mapXconstantXlist_nullX_unfold_meanX_mathX___plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().map(__.constant([null]).unfold().mean()).math("_ + 1")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_VX1X_projectXxX_byXconstantXlist_nullX_unfold_meanX_mathXx_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null]).unfold().mean()).math("x + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable x for math() step must resolve to a Number"

  # Contains.within is Compare.eq per member, and comparable(null, null) is true
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/util/GremlinValueComparator.java:314-316).
  Scenario: g_injectXnullX_isXwithinX0_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null).is(P.within(0, null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnullX_isXwithinXlist_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null).is(P.within([null]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_injectXnull_1_2X_isXwithoutX1_nullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).is(P.without(1, null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |

  Scenario: g_injectXnull_1_2X_isXwithoutX1XX
    Given the empty graph
    And the traversal of
      """
      g.inject(null, 1, 2).is(P.without(1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | d[2].i |

  # Every list set op, dedup and group key compares by VALUE plus a coarse family (boolean / number /
  # string / other) — a deliberate divergence from Java's class-typed HashSet (IntersectStep.java:68-80):
  # Integer 1 and Double 1.0 are one member, a Boolean true and an Integer 1 are two.
  Scenario: g_injectXlist_1_2X_intersectXlist_1dXX
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2]).intersect([1.0])
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[d[1].i] |

  Scenario: g_injectXtrue_1_trueX_dedup
    Given the empty graph
    And the traversal of
      """
      g.inject(true, 1, true).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | true |
      | d[1].i |

  # A per-row tag is not a key of its own: an untagged identity() 1 and a constant(1) tagged int are ONE
  # Integer, so dedup()/dedup().by()/groupCount() collapse them (DedupGlobalStep.java:59,78 is a HashSet;
  # GroupCountStep keys a HashMap). Keying the raw tag split them into two.
  Scenario: g_injectX1_2_1X_unionXidentity_constantX1XX_dedup_byXidentityX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1).union(__.identity(), __.constant(1)).dedup().by(__.identity())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  Scenario: g_injectX1_2_1X_unionXidentity_constantX1XX_dedup
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1).union(__.identity(), __.constant(1)).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  Scenario: g_injectX1_2_1X_unionXidentity_constantX1XX_groupCount
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 1).union(__.identity(), __.constant(1)).groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[1].i":"d[5].l","d[2].i":"d[1].l"}] |

  # A child inject's injections surface for the FIRST host only (StartStep latches `first`), so an
  # all-results consumer is an arrival-order answer a per-row value cannot give — it refuses.
  @Unsupported
  Scenario: g_VX1X_out_localXinjectX1_2XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().local(__.inject(1, 2))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[lop] |

  # A label-keyed dedup keys on each label's value plus family, as every merge does: 3 and 3L are one
  # value (a deliberate divergence from Integer.equals(Long) being false, DedupGlobalStep.java:74-88).
  Scenario: g_injectX3_3LX_asXaX_dedupXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(3, 3L).as("a").dedup("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectX3_3LX_asXaX_dedup_byXselectXaXX
    Given the empty graph
    And the traversal of
      """
      g.inject(3, 3L).as("a").dedup().by(__.select("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectXtrue_1X_asXaX_dedupXaX
    Given the empty graph
    And the traversal of
      """
      g.inject(true, 1).as("a").dedup("a").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
