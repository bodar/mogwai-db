Feature: mogwai addendum — V(<traversal>)/E(<traversal>) resolve their ids per traverser

  # GraphStep with an id TRAVERSAL runs the child over each arriving traverser and looks up what it
  # yields (`vendor/tinkerpop/gremlin-core/.../step/map/GraphStep.java` `resolveTraversalIds`): an
  # Element gives its id, a Collection is unpacked, any other value IS an id. At the start it runs once
  # over a synthetic traverser. The lookup goes through the one external-id routing
  # (`externalIdIs`, `src/compiler/rel/source.ts`): a Number names the rowid of a row WITHOUT a uid, a
  # String names the uid, and nothing is coerced. The graph below gives the "x" vertex rowid 1 and the
  # plain one rowid 2 (and likewise the edges), so the routing scenarios ask about exactly that collision.

  Background:
    Given the empty graph
    And the graph initializer of
      """
      g.addV("a").property(T.id, "x").as("x").addV("b").as("b").addE("r").from("x").to("b").property(T.id, "ex").addE("s").from("b").to("x")
      """

  @gap:traversal-ids
  Scenario: g_injectX1X_VXidentityX_id_rowid_of_a_uid_vertex
    And the traversal of
      """
      g.inject(1).V(__.identity()).id()
      """
    When iterated to list
    Then the result should be empty

  @gap:traversal-ids
  Scenario: g_injectXx_2X_VXidentityX_id
    And the traversal of
      """
      g.inject("x", 2).V(__.identity()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | d[2].l |

  # A String is never coerced to the rowid it spells (docs/feature-support-matrix.md §17).
  @gap:traversal-ids
  Scenario: g_injectXstring_2X_VXidentityX_id
    And the traversal of
      """
      g.inject("2").V(__.identity()).id()
      """
    When iterated to list
    Then the result should be empty

  @gap:traversal-ids
  Scenario: g_injectXtrueX_VXidentityX
    And the traversal of
      """
      g.inject(true).V(__.identity())
      """
    When iterated to list
    Then the result should be empty

  @gap:traversal-ids
  Scenario: g_VX2X_VXout_idX_label
    And the traversal of
      """
      g.V(2).V(__.out().id()).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |

  # An edge's id names the vertex with that id, not the edge: "ex" names none, 2 names the plain vertex.
  @gap:traversal-ids
  Scenario: g_E_VXidX_id
    And the traversal of
      """
      g.E().V(__.id()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:traversal-ids
  Scenario: g_injectXexX_EXidentityX_id
    And the traversal of
      """
      g.inject("ex", 1).E(__.identity()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ex |

  # At the start, a collection result is unpacked.
  @gap:traversal-ids
  Scenario: g_VXV_id_foldX_id
    And the traversal of
      """
      g.V(__.V().id().fold()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | d[2].l |

  # A label the id child binds is the child's own: the elements found start fresh traversers.
  @gap:traversal-ids
  Scenario: g_VXVXxX_asXaX_idX_selectXaX
    And the traversal of
      """
      g.V(__.V("x").as("a").id()).select("a")
      """
    When iterated to list
    Then the result should be empty

  # A barrier in the child scopes to each head traverser: one per vertex, not one overall.
  @gap:traversal-ids
  Scenario: g_V_VXboth_id_limitX1XX_count
    And the traversal of
      """
      g.V().V(__.both().id().limit(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A repeated id is a repeated row (TinkerGraph maps every id it is handed).
  @gap:traversal-ids
  Scenario: g_V_VXboth_idX_id
    And the traversal of
      """
      g.V().V(__.both().id()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | x |
      | d[2].l |
      | d[2].l |

  @gap:traversal-ids
  Scenario: g_V_projectXnX_byXVXboth_idX_countX
    And the traversal of
      """
      g.V().project("n").by(__.V(__.both().id()).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"d[2].l"}] |
      | m[{"n":"d[2].l"}] |

  @gap:traversal-ids
  Scenario: g_V_chooseXhasLabelXaX_VXout_idX_identityX_id
    And the traversal of
      """
      g.V().choose(__.hasLabel("a"), __.V(__.out().id()), __.identity()).id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
      | d[2].l |

  @gap:traversal-ids
  Scenario: g_V_asXhX_VXout_idX_selectXhX_id
    And the traversal of
      """
      g.V().as("h").V(__.out().id()).select("h").id()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | d[2].l |
