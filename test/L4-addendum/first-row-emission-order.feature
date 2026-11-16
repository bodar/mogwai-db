Feature: mogwai addendum — a FIRST-row child keeps its body's first EMITTED result, not its least value

  # map(b) emits `mapTraversal.next()` — the child traversal's FIRST traverser in its own iteration order
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53,
  # the child applied per traverser by TraversalUtil.apply, vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java),
  # and project().by(b) puts the same first result under its key
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:64-67).
  # values(k) over a LIST-cardinality key emits its values in storage (insertion) order, so the first is the
  # first-inserted value — "zeta", where a pick by least value would answer "alpha". Pinned under both child
  # lowerings: the ladder's correlated read and the scoped-relation connector (`src/compiler/rel/lower/scoped.ts`
  # `lowerBody`/`correlatedFirst`), which sorts by the body's position keys (`src/rel/position.ts`).

  Scenario: g_V_mapXvaluesXkXX_listCardinality_firstInserted
    Given the empty graph
    And the graph initializer of
      """
      g.addV("thing").property(Cardinality.list, "k", "zeta").property(Cardinality.list, "k", "alpha").property(Cardinality.list, "k", "mid")
      """
    And the traversal of
      """
      g.V().map(__.values("k"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | zeta |

  Scenario: g_V_projectXfX_byXvaluesXkXX_listCardinality_firstInserted
    Given the empty graph
    And the graph initializer of
      """
      g.addV("thing").property(Cardinality.list, "k", "zeta").property(Cardinality.list, "k", "alpha").property(Cardinality.list, "k", "mid")
      """
    And the traversal of
      """
      g.V().project("f").by(__.values("k"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"f":"zeta"}] |

  # The same rule over a hop: josh created ripple (edge 10) before lop (edge 11), and an element's edges are
  # iterated in that order, so map()'s first is ripple — not lop, the lesser vertex id.
  Scenario: g_VX4X_mapXoutEXcreatedX_inVX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(4).map(__.outE("created").inV()).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | ripple |
