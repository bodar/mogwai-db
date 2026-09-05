Feature: mogwai addendum — branch-arm label escape

  # BranchStep forwards an arm's end traverser, including labels bound inside that arm
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:123-153`).
  # These branch-local labels must therefore be available to the continuation.

  @gap:branch-arm-label-escape
  Scenario: g_V_asXaX_unionXoutXcreatedX_asXbX_outXknowsX_asXbXX_selectXa_bX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").union(__.out("created").as("b"), __.out("knows").as("b")).select("a", "b").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"marko","b":"vadas"}] |
      | m[{"a":"marko","b":"josh"}] |
      | m[{"a":"josh","b":"lop"}] |
      | m[{"a":"josh","b":"ripple"}] |
      | m[{"a":"peter","b":"lop"}] |

  # The unlabelled arm still contributes rows to the union, but `select("b")` is unproductive
  # there: its NULL-padded history drops those rows rather than borrowing another arm's binding.
  @gap:branch-arm-label-escape
  Scenario: g_V_asXaX_unionXoutXcreatedX_asXbX_outXknowsXX_selectXa_bX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").union(__.out("created").as("b"), __.out("knows")).select("a", "b").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"josh","b":"lop"}] |
      | m[{"a":"josh","b":"ripple"}] |
      | m[{"a":"peter","b":"lop"}] |

  @gap:branch-arm-label-escape
  Scenario: g_V_asXaX_coalesceXoutXcreatedX_asXbX_outXknowsX_asXbXX_selectXa_bX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").coalesce(__.out("created").as("b"), __.out("knows").as("b")).select("a", "b").by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"josh","b":"lop"}] |
      | m[{"a":"josh","b":"ripple"}] |
      | m[{"a":"peter","b":"lop"}] |
