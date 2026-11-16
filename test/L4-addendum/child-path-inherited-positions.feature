Feature: mogwai addendum — a child body's path() frames the positions its PARENT appended

  # A `local()` body keeps its parent traverser's whole path: `LocalStep` hands the child the
  # incoming traverser itself (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:60-70`),
  # and a child's path read is `traverser.path()` (`.../traversal/step/Scoping.java:119-135`). So
  # the kinds a body's `path()` can hold are NOT what the body's own steps append: a body with no
  # movement (`local(__.path())`) still frames the parent's vertex, and an edge-rooted parent's
  # position stays an edge under a body that hops to a vertex. Proving the kinds from the body's
  # prefix alone built NO position arm (a raw TypeError) for the first, and framed the edge
  # position as null for the second. `simplePath()` keeps the path channel live, so both lower.

  Scenario: g_V_simplePath_localXpathX
    Given the modern graph
    And the traversal of
      """
      g.V().simplePath().local(__.path())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[marko]] |
      | p[v[vadas]] |
      | p[v[lop]] |
      | p[v[josh]] |
      | p[v[ripple]] |
      | p[v[peter]] |

  Scenario: g_V_simplePath_localXhasXageX_pathX
    Given the modern graph
    And the traversal of
      """
      g.V().simplePath().local(__.has("age").path())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[marko]] |
      | p[v[vadas]] |
      | p[v[josh]] |
      | p[v[peter]] |

  Scenario: g_E_simplePath_localXoutV_pathX
    Given the modern graph
    And the traversal of
      """
      g.E().simplePath().local(__.outV().path())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[e[marko-knows->vadas],v[marko]] |
      | p[e[marko-knows->josh],v[marko]] |
      | p[e[marko-created->lop],v[marko]] |
      | p[e[josh-created->ripple],v[josh]] |
      | p[e[josh-created->lop],v[josh]] |
      | p[e[peter-created->lop],v[peter]] |
