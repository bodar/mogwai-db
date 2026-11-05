Feature: mogwai addendum — a label BOUND TO NULL is present, with a null value

  # A label first bound inside a branch arm is unbound on the rows that took another arm, and a child body
  # that opens with `select()` of it sees nothing there (absent-label-body-input.feature). A label bound to a
  # NULL value is a different state: `Scoping.getScopeValue` answers `path.get(k)` whenever
  # `path.hasLabel(k)` (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:129-130),
  # so `select()` yields the null and `map()` keeps it as a productive null
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53).
  # The presence is the label history's own entry tag, never the value's nullness
  # (docs/2026-11-05-presence-is-the-tag-plan.md P4).

  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_mapXselectXkXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).map(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_hasXname_markoX_asXvX_unionXconstantXnullX_asXkX_constantX0XX_selectXvX_mapXselectXkXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").as("v").union(__.constant(null).as("k"), __.constant(0)).select("v").map(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_unionXconstantXnullX_asXkX_constantX0XX_localXselectXkXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.constant(null).as("k"), __.constant(0)).local(__.select("k")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_mapXselectXkX_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).map(__.select("k").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null] |
      | l[] |

  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_whereXselectXkXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).where(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_notXselectXkXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).not(__.select("k"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].i |

  # An `is()` over a label unbound on some rows tests nothing there, even with a predicate that holds on null.
  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_whereXselectXkX_isXeqXnullXXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).where(__.select("k").is(P.eq(null)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_hasXname_markoX_unionXconstantX1X_asXkX_constantX0XX_whereXselectXkX_isXneqX1XXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(1).as("k"), __.constant(0)).where(__.select("k").is(P.neq(1)))
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_hasXname_markoX_unionXconstantXnullX_asXkX_constantX0XX_mapXselectXkX_isXneqX1XXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").union(__.constant(null).as("k"), __.constant(0)).map(__.select("k").is(P.neq(1)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |
