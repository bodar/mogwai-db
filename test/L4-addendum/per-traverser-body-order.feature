Feature: mogwai addendum — a per-traverser body's global order() sorts ONE start's results

  # `FlatMapStep`/`LocalStep` take one start, emit every result of its body, then take the next
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52,
  # .../step/branch/LocalStep.java:80-88), so the host's output is START-major and the body's `order()`
  # orders within one start. The body's sort was minted over every start at once, interleaving them —
  # `flatMap(out().values('name').order()).fold()` answered the six names globally sorted.
  # `originMajor` (src/compiler/rel/lower/reduction.ts) re-ranks the rejoin by (start, body order).

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas,lop,ripple,lop] |

  Scenario: g_V_flatMapXout_valuesXnameX_order_byXdescXX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order().by(Order.desc)).limit(4)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | lop |
      | josh |
      | ripple |

  # A MERGED start. `LazyBarrierStrategy` puts a `NoOpBarrierStep` after the non-first flat-map `out()`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:105-127),
  # so the three `lop` traversers reach `flatMap` as ONE bulk-3 traverser at the first one's place. The body
  # runs once over it (the child start is bulk 1, .../traversal/util/TraversalUtil.java:185-191) and each
  # result is split from the head with its bulk (FlatMapStep.java:42-52): `josh,josh,josh,marko,…`, not the
  # three copies' sorted runs one after another. A slice then trims a result's bulk (RangeGlobalStep).
  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,josh,josh,marko,marko,marko,peter,peter,peter,marko,josh] |

  Scenario: g_V_out_flatMapXin_valuesXnameX_order_limitX2XX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order().limit(2)).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,josh,josh,marko,marko,marko,marko,josh] |

  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).limit(3)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
      | josh |
      | josh |

  Scenario: g_V_both_flatMapXout_valuesXnameX_orderX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().both().flatMap(__.out().values("name").order()).limit(4)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | lop |
      | lop |
      | ripple |

  # A step after the flatMap that is no `Barrier` takes `LazyBarrierStrategy`'s `NoOpBarrierStep` after the
  # flatMap (`g.V()` counts as the first flat-map, LazyBarrierStrategy.java:113-127), which MERGES the equal
  # names at the first one's place before `is()` sees them — so the start-major run is NOT what reaches the
  # fold here. `identity()` is removed (IdentityRemovalStrategy) and leaves the flatMap's next step the fold.
  Scenario: g_V_flatMapXout_valuesXnameX_orderX_isXneqXxXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).is(P.neq("x")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,lop,lop,vadas,ripple] |

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_isXneqXxXX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).is(P.neq("x")).limit(4)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_identity_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).identity().fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas,lop,ripple,lop] |

  # `map(identity())` is spliced away here, but in the reference it is a `TraversalMapStep` no strategy
  # removes — a non-`Barrier` next step, so the merge lands after the flatMap (`nextReferenceStep`, ir/bulk.ts).
  Scenario: g_V_flatMapXout_valuesXnameX_orderX_mapXidentityX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).map(__.identity()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,lop,lop,vadas,ripple] |

  # …but `EarlyLimitStrategy` moves a `limit` left past that always-bound map, and a `RangeGlobalStep` IS a
  # `Barrier`, so with a limit nothing merges after the flatMap.
  Scenario: g_V_flatMapXout_valuesXnameX_orderX_mapXidentityX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).map(__.identity()).limit(4)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | lop |

  # The merged host with a label: the label rides to the `NoOpBarrierStep` after the flatMap, which the
  # strategy still places (labels are read AFTER the step's own check, LazyBarrierStrategy.java:116-133).
  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_asXyX_selectXyX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).as("y").select("y").fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,marko,marko,marko,marko,josh,josh,josh,josh,peter,peter,peter] |

  # The OTHER per-start hosts. `CoalesceStep` is a `FlatMapStep` and `OptionalStep.processNextStart` drains
  # its child for one start before the next (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/OptionalStep.java),
  # so a sorted arm's order is the result stream's own, read at a bare terminal too (`hostSortsBody`,
  # src/compiler/ir/bulk.ts). Both used to emit the arm's rows in scan order.
  Scenario: g_V_coalesceXout_valuesXnameX_order_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().values("name").order(), __.values("name"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | vadas |
      | lop |
      | lop |
      | ripple |
      | ripple |
      | lop |

  Scenario: g_V_optionalXout_order_byXnameXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | vadas |
      | lop |
      | lop |
      | ripple |
      | ripple |
      | lop |

  Scenario: g_V_unionXcoalesceXout_valuesXnameX_order_valuesXnameXXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.coalesce(__.out().values("name").order(), __.values("name")))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | vadas |
      | lop |
      | lop |
      | ripple |
      | ripple |
      | lop |
