Feature: mogwai addendum — a list is unrolled only when it is the single id argument

  # TINKERPOP-3273 (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/dsl/graph/GraphTraversal.java
  # `hasId`, and `GraphStep` for `V()`/`E()`): `V([3,4])` ≡ `V(3,4)`, but in `V(2, [3,4])` the list is ONE
  # literal id — and an element id is never a list, so it matches nothing. One routing answers every id
  # question (`idMembership`, `src/compiler/rel/source.ts`), so each form below agrees.

  Background:
    Given the modern graph

  @gap:id-routing
  Scenario: g_V_hasIdX2_list3_4X_name
    And the traversal of
      """
      g.V().hasId(2, [3, 4]).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  @gap:id-routing
  Scenario: g_V_out_hasIdXwithinX2_list3_4XX_name
    And the traversal of
      """
      g.V().out().hasId(within(2, [3, 4])).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  @gap:id-routing
  Scenario: g_V_hasIdXwithoutX2_list3_4XX_name
    And the traversal of
      """
      g.V().hasId(without(2, [3, 4])).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | lop |
      | josh |
      | ripple |
      | peter |

  @gap:id-routing
  Scenario: g_VX2_list3_4X_name
    And the traversal of
      """
      g.V(2, [3, 4]).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  @gap:id-routing
  Scenario: g_VXlist3_4_list1X_name
    And the traversal of
      """
      g.V([3, 4], [1]).values("name")
      """
    When iterated to list
    Then the result should be empty

  @gap:id-routing
  Scenario: g_V_whereXout_hasIdXwithoutX4_list3XXX_name
    And the traversal of
      """
      g.V().where(out().hasId(without(4, [3]))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:id-routing
  Scenario: g_VXlist3_4X_name
    And the traversal of
      """
      g.V([3, 4]).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | josh |
