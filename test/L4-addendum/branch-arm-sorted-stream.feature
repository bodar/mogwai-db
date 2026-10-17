Feature: mogwai addendum — a branch arm's global order() is the order of the result stream

  # An arm holding a `Barrier` makes the `BranchStep` feed it every start and then drain it whole
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:85-88,123-153),
  # so an arm's `order()` sorts across ALL starts and the client reads that order. The merge owed it only
  # where a later step read the order (`fold()`, a slice), so the bare result stream came back in start
  # order. `branchOrderOwed` (src/compiler/rel/lower.ts) now owes it wherever an arm sorts.

  Scenario: g_V_hasLabelXpersonX_chooseXhasLabelXpersonX_valuesXnameX_order_byXdescX__valuesXlangXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.hasLabel("person"), __.values("name").order().by(Order.desc), __.values("lang"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | peter |
      | marko |
      | josh |

  Scenario: g_V_unionXvaluesXnameX_orderX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("name").order())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | marko |
      | peter |
      | ripple |
      | vadas |
