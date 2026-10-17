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

  # An option-map `choose` drains `getGlobalChildren`: the `Pick` options (`none`, `unproductive` — the
  # implicit identity ones included) FIRST, then the keyed options in declaration order
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:108-114).
  # The arms sit one level below the folded `optionArms` cluster, which `armSorts` read as `option` steps
  # and so never saw an `order()` in a `Pick.none` arm: the stream came back positionless, the none arm
  # unsorted (`[m, vadas, josh, peter]`).
  Scenario: g_V_hasLabelXpersonX_chooseXvaluesXageXX_optionX29_constantXmXX_optionXnone_valuesXnameX_order_byXdescXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.constant("m")).option(Pick.none, __.values("name").order().by(Order.desc))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | peter |
      | josh |
      | m |

  # Declaration order does not move a `Pick` arm: it still drains first.
  Scenario: g_V_hasLabelXpersonX_chooseXvaluesXageXX_optionX29_valuesXnameX_orderX_optionXnone_constantXzXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.values("name").order()).option(Pick.none, __.constant("z"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | z |
      | z |
      | z |
      | marko |

  # No `Pick.none` written: the IMPLICIT identity none arm (`ChooseStep.java:65-81`) is drained first too.
  Scenario: g_V_hasLabelXpersonX_chooseXvaluesXageXX_optionX29_valuesXnameX_orderX_optionX27_valuesXnameX_orderX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.values("age")).option(29, __.values("name").order()).option(27, __.values("name").order())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | v[josh] |
      | v[peter] |
      | marko |
      | vadas |
