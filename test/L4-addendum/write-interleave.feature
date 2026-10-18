Feature: mogwai addendum — a write runs ONE TRAVERSER AT A TIME through every step after it

  # The lazy pipeline hands traverser 1 through EVERY later step before traverser 2 reaches the write —
  # no `NoOpBarrierStep` after a short id source or a first flat-map
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:93-130),
  # `AddVertexStep`/`AddEdgeStep` map and `AddPropertyStep` mutates per traverser object. So a later READ sees
  # only the earlier traversers' writes, and a write over traversers the reference MERGED runs once for the
  # merged one. Each @Unsupported scenario states the REFERENCE answer and must refuse (`readAfterWrite`,
  # `mergedOnceAlike` in src/compiler/rel/write.ts) — one statement per step answers 4, 4, [2,2], 6. The
  # trailing scenarios are what interleaving cannot change, or what a barrier orders, and must keep answering.

  @gap:write-interleave
  @Unsupported
  Scenario: g_injectX1_2X_addVXxX_V_hasLabelXxX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(1,2).addV("x").V().hasLabel("x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:write-interleave
  @Unsupported
  Scenario: g_VX1_2X_addEXkX_toXVX3XX_VX3X_inEXkX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).addE("k").to(__.V(3)).V(3).inE("k").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:write-interleave
  @Unsupported
  Scenario: g_injectX1_2X_asXaX_VX1X_propertyXsingle_w_selectXaXX_valuesXwX
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).property(Cardinality.single,"w",__.select("a")).values("w")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |

  @gap:write-interleave
  @Unsupported
  Scenario: g_V_out_addVXxX_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().addV("x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 4 for count of "g.V().hasLabel(\"x\")"

  @gap:write-interleave
  Scenario: g_V_propertyXx_1X_valuesXxX
    Given the modern graph
    And the traversal of
      """
      g.V().property("x",1).values("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  @gap:write-interleave
  Scenario: g_V_propertyXsingle_w_1X_out_propertyXsingle_w_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().property(Cardinality.single,"w",1).out().property(Cardinality.single,"w",2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 4 for count of "g.V().has(\"w\",2)"
    And the graph should return 2 for count of "g.V().has(\"w\",1)"

  @gap:write-interleave
  Scenario: g_injectX1_2X_asXaX_VX1X_propertyXsingle_w_selectXaXX_fold_unfold_valuesXwX
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V(1).property(Cardinality.single,"w",__.select("a")).fold().unfold().values("w")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[2].i |

  # READ BEFORE WRITE (`readBeforeWrite`): an EARLIER step, run for traverser 2, sees what the write already did
  # for traverser 1. Traverser 2's mid-chain V() re-reads traverser 1's six new vertices, so the reference
  # makes 6 + 12 — one statement per step makes 12.
  @gap:write-interleave
  @Unsupported
  Scenario: g_injectX1_2X_V_addVXxX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).V().addV("x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[18].l |

  # ripple's in() is josh, which traverser josh wrote first — so ripple fails the filter.
  @gap:write-interleave
  @Unsupported
  Scenario: g_VX4_5X_whereXin_hasNotXwXX_propertyXsingle_w_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V(4,5).where(__.in().hasNot("w")).property(Cardinality.single,"w",2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V().has(\"w\",2)"

  # Past the NoOpBarrierStep after out() the barrier emits vadas, josh, lop (bulk 3), ripple; ripple's in() is
  # josh, at w=2 by then — so ripple keeps w=1. Every step between the barrier and the second write runs per
  # traverser, so the filter is in that write's window.
  @gap:write-interleave
  @Unsupported
  Scenario: g_V_propertyXsingle_w_1X_out_whereXin_hasXw_1XX_propertyXsingle_w_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().property(Cardinality.single,"w",1).out().where(__.in().has("w",1)).property(Cardinality.single,"w",2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |
    And the graph should return 3 for count of "g.V().has(\"w\",2)"
    And the graph should return 3 for count of "g.V().has(\"w\",1)"

  # A write onto the element this traverser just made still meets another traverser's EARLIER write where that
  # write's feed re-reads the graph: traverser 2's V() reaches traverser 1's six x vertices and writes w=5 over
  # their w=9 (`streamSeesCreation`).
  @gap:write-interleave
  @Unsupported
  Scenario: g_injectX1_2X_asXaX_V_propertyXsingle_w_5X_filterXselectXaX_isX1XX_addVXxX_propertyXsingle_w_9X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).as("a").V().property(Cardinality.single,"w",5).filter(__.select("a").is(1)).addV("x").property(Cardinality.single,"w",9).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 12 for count of "g.V().has(\"w\",5)"

  # Each traverser's filter reads only its OWN vertex, and no vertex reaches it twice.
  @gap:write-interleave
  Scenario: g_V_hasNotXwX_propertyXsingle_w_1X_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasNot("w").property(Cardinality.single,"w",1).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 6 for count of "g.V().has(\"w\",1)"
