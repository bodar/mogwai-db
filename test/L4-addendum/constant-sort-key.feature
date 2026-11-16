Feature: mogwai addendum — a positional window inside a per-traverser scope

  # `local()` resets its child for every start (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:60-70`),
  # so a `limit`/`range`/`skip`/`tail` inside a `union()` arm of the body windows ONE traverser:
  # `limit(1)`/`tail(1)` keep it, `range(1,2)`/`skip(1)` drop it, and the `fold()` reduces each
  # start's arm output on its own. In the one-row scope the window's encounter is the constant 0,
  # which reached SQL as `ORDER BY 0` — a result-column ordinal to SQLite ("1st ORDER BY term out
  # of range"). A constant sort key orders nothing and is no longer emitted.

  Scenario: g_V_localXunionXlimitX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.limit(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[v[marko]] |
      | l[v[vadas]] |
      | l[v[lop]] |
      | l[v[josh]] |
      | l[v[ripple]] |
      | l[v[peter]] |

  Scenario: g_V_mapXunionXtailX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.union(__.tail(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[v[marko]] |
      | l[v[vadas]] |
      | l[v[lop]] |
      | l[v[josh]] |
      | l[v[ripple]] |
      | l[v[peter]] |

  Scenario: g_V_localXunionXrangeX1_2XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.range(1, 2)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[] |
      | l[] |
      | l[] |
      | l[] |
      | l[] |
      | l[] |
