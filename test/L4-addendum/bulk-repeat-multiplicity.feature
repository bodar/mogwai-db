Feature: mogwai addendum — repeat() bulk arithmetic must carry the INPUT multiplicity

  # The bulkRepeatCount fast path computes `repeat(...).times(n).<reducer>` by walking a collapsed
  # (id, bulk) frontier instead of enumerating every walk. Its seed frontier weighted each starting
  # vertex by COUNT(*) — the number of ROWS on that id. That is only the traverser count when every
  # row is one traverser, and this path forces movementCollapse ON, so any prefix containing a
  # movement arrives ALREADY collapsed: `E().outV()` hands the seed marko as ONE row with bulk=3.
  # COUNT(*) scored that as 1, so the whole input multiset was flattened and the reducer undercounted.
  #
  # It was a SILENT WRONG ANSWER in the DEFAULT config (every fast path on, i.e. production):
  #   g.E().outV().repeat(__.both("knows")).times(2).count()  ->  4, where 10 is correct.
  # The seed now weights by SUM(bulk) when a bulk column is carried, which is the same rule the
  # per-hop frontiers below it already used.
  #
  # Found by L5's fast-path differential as a multiset disagreement on a groupCount(); the L5
  # generator reached it, the 2,298-traversal corpus did not. Each scenario below pairs the reducer
  # with a form that ENUMERATES the same multiset (values()/count() without the fast path's shape),
  # so the expected numbers are pinned by construction rather than by hand-arithmetic.
  @gap:bulk-repeat-multiplicity

  # E().outV() gives marko x3 (three out-edges), josh x2, peter x1. knows edges are 1-2 and 1-4, so
  # both("knows") from marko -> {vadas,josh}, from josh -> {marko}, from peter -> {}. Two iterations:
  # marko x3 -> marko x6; josh x2 -> vadas x2 + josh x2; peter drops. Total 10.
  Scenario: g_E_outV_repeatXbothXknowsXX_timesX2X_count
    Given the modern graph
    And the traversal of
      """
      g.E().outV().repeat(__.both("knows")).times(2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[10].l |

  # The same chain projected instead of reduced — the enumerated multiset the count above must equal.
  Scenario: g_E_outV_repeatXbothXknowsXX_timesX2X_values_name
    Given the modern graph
    And the traversal of
      """
      g.E().outV().repeat(__.both("knows")).times(2).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | marko |
      | marko |
      | marko |
      | marko |
      | vadas |
      | vadas |
      | josh |
      | josh |

  # groupCount() over the same frontier — this is the shape the differential actually flagged.
  Scenario: g_E_outV_repeatXbothXknowsXX_timesX2X_groupCount_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.E().outV().repeat(__.both("knows")).times(2).groupCount().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[6].l","vadas":"d[2].l","josh":"d[2].l"}] |

  # A bulk-free prefix must be unaffected: V() is one traverser per vertex, so COUNT(*) and
  # SUM(bulk) agree there. This is the regression guard on the fix itself.
  # marko -> {vadas,josh}, vadas -> {marko}, josh -> {marko}; second hop gives marko x2, vadas x2,
  # josh x2 = 6, pinned by the paired projection below.
  Scenario: g_V_repeatXbothXknowsXX_timesX2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.both("knows")).times(2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_repeatXbothXknowsXX_timesX2X_values_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.both("knows")).times(2).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |
      | vadas |
      | josh |
      | josh |

  # A movement prefix that COLLAPSES (out() converges three times onto lop) followed by the bulk
  # repeat: the multiplicity must survive the collapse boundary. out() gives lop x3, vadas, josh,
  # ripple; both("created") then gives 3 from lop (x3 = 9), 2 from josh, 1 from ripple, 0 from
  # vadas = 12.
  Scenario: g_V_out_repeatXbothXcreatedXX_timesX1X_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().repeat(__.both("created")).times(1).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |
