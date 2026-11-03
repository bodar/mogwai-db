Feature: mogwai addendum — a label or id test on a JOINED element is a per-row probe

  # After a movement the subject of `hasLabel`/`hasId` is an id a join produced, and the test is a
  # correlated probe on the owner's key (`vertex_labels(node, label)`, the edge/vertex rowid) — not an
  # uncorrelated `id IN (<every element with the label / in the range>)`, which SQLite expands into
  # index probes per outer row (quadratic at production size). `BaseGraph.hasLabelPredicate` /
  # `hasTokenPredicate` in src/compiler/rel/source.ts. These pin the answers each position must keep,
  # including the NEGATED forms whose complement the probe must preserve.
  @gap:label-id-probe-after-movement

  Scenario: g_V_asXaX_outXcreatedX_whereXhasLabelXsoftwareX_inXcreatedX_whereXneqXaXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out("created").where(__.hasLabel("software").in("created").where(P.neq("a"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |

  Scenario: g_V_asXaX_outXcreatedX_inXcreatedX_hasLabelXpersonX_whereXneqXaXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out("created").in("created").hasLabel("person").where(P.neq("a")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | peter |
      | marko |
      | peter |
      | marko |
      | josh |

  Scenario: g_V_out_notXhasLabelXsoftwareXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().out().not(__.hasLabel("software")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |

  Scenario: g_V_outE_notXhasLabelXcreatedXX_inV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().not(__.hasLabel("created")).inV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |

  Scenario: g_V_outXcreatedX_inXcreatedX_hasIdXgtX4XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().out("created").in("created").hasId(P.gt(4)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | peter |
      | peter |
      | peter |

  Scenario: g_V_outXcreatedX_inXcreatedX_hasIdXwithoutX1_4XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().out("created").in("created").hasId(P.without(1, 4)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | peter |
      | peter |
      | peter |

  Scenario: g_V_outXcreatedX_inXcreatedX_notXhasIdX1_4XX_name
    Given the modern graph
    And the traversal of
      """
      g.V().out("created").in("created").not(__.hasId(1, 4)).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | peter |
      | peter |
      | peter |
