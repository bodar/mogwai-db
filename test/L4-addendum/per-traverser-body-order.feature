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
    Then the result should have a count of 4

  # A start that arrives several times (`lop` x3 after `out()`) runs its body once per arrival: each run is
  # its own sorted block, start-major — no TraverserSet merges the three into one slot first (Java's
  # LazyBarrierStrategy does; docs/feature-support-matrix.md §17).
  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,marko,peter,marko,josh,marko,peter,josh,josh,marko,peter] |

  Scenario: g_V_out_flatMapXin_valuesXnameX_order_limitX2XX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order().limit(2)).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,marko,marko,josh,marko,josh,josh,marko] |

  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).limit(3)
      """
    When iterated to list
    Then the result should have a count of 3

  Scenario: g_V_both_flatMapXout_valuesXnameX_orderX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().both().flatMap(__.out().values("name").order()).limit(4)
      """
    When iterated to list
    Then the result should have a count of 4

  # A non-Barrier step after the flatMap merges nothing: the start-major run is what reaches the fold.
  Scenario: g_V_flatMapXout_valuesXnameX_orderX_isXneqXxXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).is(P.neq("x")).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas,lop,ripple,lop] |

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_isXneqXxXX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).is(P.neq("x")).limit(4)
      """
    When iterated to list
    Then the result should have a count of 4

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

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_mapXidentityX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).map(__.identity()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,vadas,lop,ripple,lop] |

  Scenario: g_V_flatMapXout_valuesXnameX_orderX_mapXidentityX_limitX4X
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.out().values("name").order()).map(__.identity()).limit(4)
      """
    When iterated to list
    Then the result should have a count of 4

  # A label after the flatMap reads the start-major run as it stands.
  Scenario: g_V_out_flatMapXin_valuesXnameX_orderX_asXyX_selectXyX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().flatMap(__.in().values("name").order()).as("y").select("y").fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,marko,peter,marko,josh,marko,peter,josh,josh,marko,peter] |

  # The OTHER per-start hosts. A bare terminal emission of a coalesce()/optional() reads no order the
  # query imposes, so it is asserted as the multiset; a reader that collects it (`fold()`) sees each
  # start's sorted run.
  Scenario: g_V_coalesceXout_valuesXnameX_order_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().values("name").order(), __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | lop |
      | ripple |
      | lop |
      | vadas |
      | lop |
      | ripple |

  Scenario: g_V_optionalXout_order_byXnameXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | lop |
      | ripple |
      | lop |
      | vadas |
      | lop |
      | ripple |

  Scenario: g_V_unionXcoalesceXout_valuesXnameX_order_valuesXnameXXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.coalesce(__.out().values("name").order(), __.values("name")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | lop |
      | ripple |
      | lop |
      | vadas |
      | lop |
      | ripple |
