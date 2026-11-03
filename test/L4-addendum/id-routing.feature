Feature: mogwai addendum — a numeric id names the element whose id IS that number

  # An element's id is `COALESCE(uid, id)`: a vertex created with `property(T.id, "x")` has the id "x",
  # and its storage rowid is NOT an id it answers to. Every id question — `V(ids)`, `E(ids)`, `hasId`,
  # `has(T.id, …)` — goes through ONE routing (`idMembership`, `src/compiler/rel/source.ts`), which
  # matches a number on the rowid ONLY where `uid IS NULL`. Before it, `V(1)` here returned the "x"
  # vertex: the wrong element. The graph below gives the "x" vertex rowid 1 and the plain one rowid 2
  # (and likewise the edges), so each scenario asks about exactly that collision.

  Background:
    Given the empty graph
    And the graph initializer of
      """
      g.addV("a").property(T.id, "x").as("x").addV("b").as("b").addE("r").from("x").to("b").property(T.id, "ex").addE("s").from("b").to("x")
      """

  @gap:id-routing
  Scenario: g_VX1X_id_of_a_uid_vertex_rowid
    And the traversal of
      """
      g.V(1).id()
      """
    When iterated to list
    Then the result should be empty

  @gap:id-routing
  Scenario: g_VX2_xX_id
    And the traversal of
      """
      g.V(2, "x").id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | x |

  @gap:id-routing
  Scenario: g_V_hasIdX1X_id
    And the traversal of
      """
      g.V().hasId(1).id()
      """
    When iterated to list
    Then the result should be empty

  @gap:id-routing
  Scenario: g_V_hasIdXwithoutX2XX_id
    And the traversal of
      """
      g.V().hasId(without(2)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |

  @gap:id-routing
  Scenario: g_V_hasXT_id_ltX5XX_id
    And the traversal of
      """
      g.V().has(T.id, lt(5)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # After a re-source the subject is a bare id, not the scan row: the same routing, as an uncorrelated
  # membership.
  @gap:id-routing
  Scenario: g_V_asXaX_V_hasIdXwithinX1_2XX_id
    And the traversal of
      """
      g.V().as("a").V().hasId(within(1, 2)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |

  @gap:id-routing
  Scenario: g_V_outE_hasIdXwithinX1_2XX_id
    And the traversal of
      """
      g.V().outE().hasId(within(1, 2)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:id-routing
  Scenario: g_EX1X_id_of_a_uid_edge_rowid
    And the traversal of
      """
      g.E(1).id()
      """
    When iterated to list
    Then the result should be empty

  # A NULL id is one no element has, so it contributes nothing to the id set — and a set whose only
  # member is null matches NOTHING. The trap is the lone null: "no ids" (`V()`) is the whole graph, so
  # `V(null)` must not fall back to it. Corpus: `g_VXnullX`, `g_VX1_nullX`, `g_EX11_nullX`.
  @gap:id-routing
  Scenario: g_VXnullX_count_is_not_the_whole_graph
    And the traversal of
      """
      g.V(null).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @gap:id-routing
  Scenario: g_VXnull_nullX_count
    And the traversal of
      """
      g.V(null, null).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @gap:id-routing
  Scenario: g_EXnull_exX_id
    And the traversal of
      """
      g.E(null, "ex").id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ex |

  @gap:id-routing
  Scenario: g_V_localXVXnullXX_count
    And the traversal of
      """
      g.V().local(__.V(null)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @gap:id-routing
  Scenario: g_V_unionXVXnullX_VX2_nullXX_id
    And the traversal of
      """
      g.V().union(__.V(null), __.V(2, null)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |

  @gap:id-routing
  Scenario: g_V_hasIdXnullX_count
    And the traversal of
      """
      g.V().hasId(null).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @gap:id-routing
  Scenario: g_V_hasIdXwithoutXnullXX_id
    And the traversal of
      """
      g.V().hasId(without(null)).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | d[2].l |
