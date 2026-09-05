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
