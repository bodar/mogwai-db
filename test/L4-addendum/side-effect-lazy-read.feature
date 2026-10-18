Feature: mogwai addendum — a read of a side effect sees the COMPLETED collection, and a collector in a CORRELATED body

  # `select("a")`, `where(within("a"))`, `math`, `dedup("a")` read a side effect. The reference reads it
  # AS IT IS NOW (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java
  # `getScopeValue`), so behind a collector its host runs once per traverser (`local`/`map`/`optional`/a
  # `union` arm's `local`) the n-th reader sees a growing prefix — an artifact of its pull order. A
  # set-based plan reads the COMPLETED collection, which is what `.barrier()` gives in the reference, and
  # that is the answer here (a deliberate divergence, docs/feature-support-matrix.md).
  #
  # A collector inside a CORRELATED body — a filter's, an `optional`'s, a `coalesce` arm's — after a
  # movement is not lowered (its member relation names the outer row); it must DECLINE, never surface an
  # internal error.

  @gap:side-effect-lazy-read
  Scenario: g_V_localXaggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  @gap:side-effect-lazy-read
  Scenario: g_V_mapXaggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  @gap:side-effect-lazy-read
  Scenario: g_V_localXaggregateXaX_byXnameXX_selectXaX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a").by("name")).select("a").unfold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[36].l |

  @gap:side-effect-lazy-read
  Scenario: g_VX1X_out_localXaggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().local(__.aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[3].l |
      | d[3].l |

  @gap:side-effect-lazy-read
  Scenario: g_V_optionalXaggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  @gap:side-effect-lazy-read
  Scenario: g_V_unionXlocalXaggregateXaXXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.aggregate("a"))).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  # A drain between the collector and the read: every reader sees the finished collection.
  @gap:side-effect-lazy-read
  Scenario: g_V_localXaggregateXaXX_barrier_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.aggregate("a")).barrier().select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  # A top-level `aggregate` is a barrier itself.
  @gap:side-effect-lazy-read
  Scenario: g_V_aggregateXaX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().aggregate("a").select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  # One traverser reaches the host: the one reader sees the one member.
  @gap:side-effect-lazy-read
  Scenario: g_VX1X_localXaggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # A `union` arm holding a barrier is fed every start first (`BranchStep.standardAlgorithm`), and the
  # arm's `aggregate` drains them all before the first result leaves the union.
  @gap:side-effect-lazy-read
  Scenario: g_V_unionXout_aggregateXaXX_selectXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.out().aggregate("a")).select("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |
      | d[6].l |

  # A collector in a CORRELATED body after a movement: declines (it raised an internal RelIR error).
  @gap:side-effect-lazy-read
  @Unsupported
  Scenario: g_V_whereXout_aggregateXaXX_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out().aggregate("a")).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:side-effect-lazy-read
  @Unsupported
  Scenario: g_V_notXout_aggregateXaXX_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.out().aggregate("a")).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:side-effect-lazy-read
  @Unsupported
  Scenario: g_V_whereXout_groupCountXaX_byXlabelXX_capXaX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out().groupCount("a").by(T.label)).cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"software":"d[4].l","person":"d[2].l"}] |

  @gap:side-effect-lazy-read
  @Unsupported
  Scenario: g_V_optionalXout_aggregateXaXX_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().aggregate("a")).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:side-effect-lazy-read
  @Unsupported
  Scenario: g_V_coalesceXout_aggregateXaX_identityX_capXaX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().aggregate("a"), __.identity()).cap("a").count(local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
