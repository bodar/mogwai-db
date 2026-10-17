Feature: mogwai addendum — every by() consumer keeps a PRODUCTIVE null and drops only an unproductive by()

  # `TraversalUtil.produce` hands each by() consumer a `TraversalProduct`, and a null result is PRODUCTIVE
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:108-123).
  # Every consumer tests `isProductive()`, never the value: ProjectStep.java:66 keeps the key,
  # SelectOneStep.java:64-65 / SelectStep.java:72-74 emit it, OrderGlobalStep.java:183-184 and
  # DedupGlobalStep.java:77-78 keep the traverser, SackValueStep.java:78-80 assigns it and
  # AggregateStep.java:139 collects it. An all-null `sum()` is such a null: ReducingBarrierStep emits its
  # null seed (only NON_EMITTING_SEED is withheld).
  #
  # The lowering once decided by()-productivity as `key IS NOT NULL` at each consumer, so every one of
  # these dropped the null. Productivity is now ONE authority over the projection's PRESENCE
  # (`productivityFilter`, src/compiler/rel/modulator.ts), which declines where a producer cannot say.

  Scenario: g_VX1X_projectXxX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |

  # An unproductive by() OMITS its key; a productive null keeps its own.
  Scenario: g_VX1X_projectXx_yX_byXvaluesXnopeX_sumX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.values("nope").sum()).by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"y":null}] |

  Scenario: g_VX1X_unionXprojectXxX_byXconstantXlist_nullX_unfold_maxXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.project("x").by(__.constant([null]).unfold().max()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |

  Scenario: g_VX1X_asXaX_selectXaX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").select("a").by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_VX1X_asXaX_out_asXbX_selectXa_bX_byXconstantXlist_nullX_unfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").select("a","b").by(__.constant([null]).unfold().sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |

  # A null sack is a productive comparator: every traverser is kept (all tie).
  Scenario: g_withSackXnullX_VX1X_out_orderXbyXsackXX_count
    Given the modern graph
    And the traversal of
      """
      g.withSack(null).V(1).out().order().by(__.sack()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  Scenario: g_injectXlist_null_1X_orderXbyXunfoldXX
    Given the empty graph
    And the traversal of
      """
      g.inject([null,1]).order().by(__.unfold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,d[1].i] |

  # Three traversers share one productive-null dedup key, so one survives.
  Scenario: g_VX1X_out_dedupXbyXconstantXlist_nullX_unfold_sumXX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().dedup().by(__.constant([null]).unfold().sum()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_withSackXnullX_VX1X_out_dedupXbyXsackXX_count
    Given the modern graph
    And the traversal of
      """
      g.withSack(null).V(1).out().dedup().by(__.sack()).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_VX1X_out_sackXassignX_byXconstantXlist_nullX_unfold_sumX_sack
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().sack(Operator.assign).by(__.constant([null]).unfold().sum()).sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
      | null |
      | null |

  # `NumberHelper` arithmetic returns the SACK when the operand is null (mathOperationWithPromote).
  Scenario: g_withSackX1X_VX1X_out_sackXsumX_byXconstantXlist_nullX_unfold_sumX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V(1).out().sack(Operator.sum).by(__.constant([null]).unfold().sum()).sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  Scenario: g_VX1X_out_aggregateXxX_byXconstantXlist_nullX_unfold_sumX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().aggregate("x").by(__.constant([null]).unfold().sum()).cap("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null,null] |

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

  # Two productive nulls are EQUAL under Gremlin's comparability (GremlinValueComparator.java:313-316),
  # where SQL's `=` reads them as unknown and dropped every row.
  Scenario: g_VX1X_asXaX_out_asXbX_whereXa_eqXbXX_byXconstantXlist_nullX_unfold_sumX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").where("a", P.eq("b")).by(__.constant([null]).unfold().sum()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |

  Scenario: g_VX1X_asXaX_out_asXbX_whereXa_neqXbXX_byXconstantXlist_nullX_unfold_sumX_name
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").where("a", P.neq("b")).by(__.constant([null]).unfold().sum()).values("name")
      """
    When iterated to list
    Then the result should be empty

  # An all-null `mean()` is a productive null too: MeanGlobalStep skips nulls and seeds nothing, and
  # `generateFinalResult` returns null when the whole stream was null
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MeanGlobalStep.java:50-58,80-84).
  # Unlike sum/min/max its null carries a binary64 TAG, and the one JSON entry for a scalar
  # (`jsonMember` -> `asExactReal`, src/compiler/rel/build.ts) printed a NULL real as `0.0` — so every
  # container a by() feeds (project, select-many, aggregate, a group member, a map entry) answered 0.0.
  Scenario: g_VX1X_projectXxX_byXconstantXlist_nullX_unfold_meanX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |

  Scenario: g_VX1X_projectXxX_byXconstantXlist_null_nullX_unfold_meanX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant([null,null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |

  # A non-null mean still takes the 17-digit repair (a 15-digit JSON number cannot round-trip 4/3).
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

  Scenario: g_VX1X_asXaX_out_asXbX_selectXa_bX_byXconstantXlist_nullX_unfold_meanX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").select("a","b").by(__.constant([null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |

  Scenario: g_VX1X_out_aggregateXxX_byXconstantXlist_nullX_unfold_meanX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().aggregate("x").by(__.constant([null]).unfold().mean()).cap("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null,null] |

  Scenario: g_VX1X_out_groupXbyXlabelX_byXprojectXxX_byXconstantXlist_nullX_unfold_meanX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.project("x").by(__.constant([null]).unfold().mean()).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":[{"x":null},{"x":null}],"software":[{"x":null}]}] |

  Scenario: g_VX1X_unionXprojectXxX_byXconstantXlist_nullX_unfold_meanXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.project("x").by(__.constant([null]).unfold().mean()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null}] |

  Scenario: g_VX1X_projectXx_yX_byXconstantXlist_nullX_unfold_meanX_byXconstantX1XX_selectXx_yX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x","y").by(__.constant([null]).unfold().mean()).by(__.constant(1)).select("x","y")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":null,"y":"d[1].i"}] |

  Scenario: g_VX1X_projectXaX_byXprojectXxX_byXconstantXlist_nullX_unfold_meanXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("a").by(__.project("x").by(__.constant([null]).unfold().mean()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":{"x":null}}] |

  Scenario: g_VX1X_out_mapXconstantXlist_nullX_unfold_meanX_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().map(__.constant([null]).unfold().mean()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null,null] |

  Scenario: g_withSackX1X_VX1X_sackXassignX_byXconstantXlist_nullX_unfold_meanX_sack_fold
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V(1).sack(Operator.assign).by(__.constant([null]).unfold().mean()).sack().fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null] |

  # The group VALUE reducer pools per key and keeps the same null seed (Grouping.doFinalReduction).
  Scenario: g_VX1X_out_groupXbyXlabelX_byXconstantXlist_nullX_unfold_meanXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().group().by(T.label).by(__.constant([null]).unfold().mean())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":null,"software":null}] |

  # Every reducer's all-null seed reaches a container as null — min alongside the mean above.
  Scenario: g_VX1X_asXaX_out_asXbX_selectXa_bX_byXconstantXlist_nullX_unfold_minX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").out().as("b").select("a","b").by(__.constant([null]).unfold().min())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |
      | m[{"a":null,"b":null}] |

  Scenario: g_VX1X_out_aggregateXxX_byXconstantXlist_nullX_unfold_maxX_capXxX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().aggregate("x").by(__.constant([null]).unfold().max()).cap("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null,null] |
