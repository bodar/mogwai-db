Feature: mogwai addendum — global row ops over the STREAM of paths (path is a payload shape)

  # A Path is a first-class collection value (`GremlinValueComparator.Type.Path`, compared element-wise,
  # vendor/tinkerpop/gremlin-core/.../util/GremlinValueComparator.java:328) — so a global `dedup()` over a
  # path stream is the SAME row op as over a list stream: its LIST_COL json IS its identity, two paths are
  # equal iff their ordered positions are. `pathTail` used to decline every whole-stream barrier; it now
  # routes them through the shared `rowOp`/`payloadRowShape` the list stream uses (dedup here; bare order()
  # over element-wise ORDERABILITY is the JS-barrier increment). This is step one of making a Path flow
  # through downstream steps like any collection, per TinkerPop (a Path is just a value; there is no
  # pathTail).

  # ---- distinct paths are preserved ----

  @gap:path-stream-rowops
  Scenario: g_V_out_path_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().dedup().count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # ---- equal paths collapse (four person->software created-paths become one) ----

  @gap:path-stream-rowops
  Scenario: g_V_outXcreatedX_path_byXlabelX_dedup
    Given the modern graph
    And the traversal of
      """
      g.V().out('created').path().by(T.label).dedup()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[person,software] |

  @gap:path-stream-rowops
  Scenario: g_V_outXcreatedX_path_byXlabelX_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().out('created').path().by(T.label).dedup().count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |

  # ---- order() over the path STREAM: ORDERABILITY, element-wise (a ranked-order barrier) ----
  #
  # `order().by(asc|desc)` over paths compares them element-wise (`iterableComparator` for `Type.Path`),
  # each element position by `id()` (`elementComparator`) — a recursive compare SQL has no ORDER BY for, so
  # it is ranked in JS and joined back (src/compiler/rel/ranked-order.ts). The traverser never leaves SQL,
  # so its LABELS survive the sort: `select(x)` after the order reads the path label, exactly as
  # Orderability.feature's `g_V_out_out_asXheadX_path_order_byXascX_selectXheadX` does one hop deeper.

  @gap:path-stream-rowops
  Scenario: g_V_out_path_order_byXdescX
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().order().by(desc)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | p[v[peter],v[lop]] |
      | p[v[josh],v[ripple]] |
      | p[v[josh],v[lop]] |
      | p[v[marko],v[josh]] |
      | p[v[marko],v[lop]] |
      | p[v[marko],v[vadas]] |

  @gap:path-stream-rowops
  Scenario: g_V_out_asXxX_path_order_byXdescX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.V().out().as("x").path().order().by(desc).select("x")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | v[lop] |
      | v[ripple] |
      | v[lop] |
      | v[josh] |
      | v[lop] |
      | v[vadas] |

  # The sort re-mints the emission order, so a slice after it takes the window from the SORTED stream.
  @gap:path-stream-rowops
  Scenario: g_V_out_path_order_byXascX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().out().path().order().by(asc).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | p[v[marko],v[vadas]] |
      | p[v[marko],v[lop]] |
