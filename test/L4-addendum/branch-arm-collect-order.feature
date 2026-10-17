Feature: mogwai addendum — a collect inside a branch arm reads the branch INPUT's order

  # `BranchStep.standardAlgorithm` drains every option over the SAME starts
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:143-153),
  # and `FoldStep`'s `addAll` keeps arrival order
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FoldStep.java).
  # So a fold in each of two arms collects its members in the ONE order the branch's input arrives in —
  # the two lists LINE UP. Each arm sorting its own members by their own content (`[[marko,vadas],[27,29]]`
  # — marko is 29) answers a different question, and so did a result that changed with what read the
  # union afterwards (a `.limit(2)` used to restore the input order). The order a list holds is part of
  # its value, so `unordered` still pins it. @gap:branch-arm-collect-order marks the family.

  @gap:branch-arm-collect-order
  Scenario: g_VX1_2X_unionXvaluesXnameX_fold_valuesXageX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 2).union(__.values("name").fold(), __.values("age").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas] |
      | l[d[29].i,d[27].i] |

  @gap:branch-arm-collect-order
  Scenario: g_V_hasLabelXpersonX_unionXvaluesXnameX_fold_valuesXageX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").union(__.values("name").fold(), __.values("age").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,josh,peter] |
      | l[d[29].i,d[27].i,d[32].i,d[35].i] |

  @gap:branch-arm-collect-order
  Scenario: g_V_hasLabelXpersonX_unionXvaluesXnameX_fold_valuesXageX_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").union(__.values("name").fold(), __.values("age").fold()).limit(2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,josh,peter] |
      | l[d[29].i,d[27].i,d[32].i,d[35].i] |

  @gap:branch-arm-collect-order
  Scenario: g_VX1_4X_unionXvaluesXnameX_fold_valuesXageX_order_byXdescX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 4).union(__.values("name").fold(), __.values("age").order().by(Order.desc).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh] |
      | l[d[32].i,d[29].i] |

  @gap:branch-arm-collect-order
  Scenario: g_VX1_4X_unionXconstantXzX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1, 4).union(__.constant("z"), __.values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | z |
      | z |
      | l[marko,josh] |

  @gap:branch-arm-collect-order
  Scenario: g_V_unionXvaluesXnameX_dedup_fold_constantX1XX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("name").dedup().fold(), __.constant(1)).limit(1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,lop,josh,ripple,peter] |

  @gap:branch-arm-collect-order
  Scenario: g_V_hasLabelXpersonX_unionXvaluesXnameX_valuesXageX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").union(__.values("name"), __.values("age").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | l[d[29].i,d[27].i,d[32].i,d[35].i] |

  @gap:branch-arm-collect-order
  Scenario: g_VX1X_out_hasLabelXpersonX_unionXvaluesXnameX_fold_valuesXageX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().hasLabel("person").union(__.values("name").fold(), __.values("age").fold())
      """
    # The two lists line up whatever the provider's adjacency order: vadas is 27, josh is 32.
    When iterated to list
    Then the result should be unordered
      | result |
      | l[vadas,josh] |
      | l[d[27].i,d[32].i] |

  @gap:branch-arm-collect-order
  Scenario: g_VX1X_mapXout_hasLabelXpersonX_unionXvaluesXnameX_fold_valuesXageX_foldX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.out().hasLabel("person").union(__.values("name").fold(), __.values("age").fold()).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[vadas,josh],l[d[27].i,d[32].i]] |
