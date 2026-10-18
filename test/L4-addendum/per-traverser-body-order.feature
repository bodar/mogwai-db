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
