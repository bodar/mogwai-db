Feature: mogwai addendum — a list nested in a map value keeps its member type

  # `ProjectStep` puts each `by()` value into the map as it is
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java),
  # so a `by(…fold())` value is a List whose members keep their own class: a Boolean stays a Boolean and a
  # `count()` stays a Long (`CountGlobalStep`). The official corpus folds a count at the root only.

  Scenario: g_V_hasXname_markoX_projectXcX_byXout_count_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").project("c").by(__.out().count().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"c":["d[3].l"]}] |

  Scenario: g_injectXtrueX_projectXbX_byXfoldX
    Given the empty graph
    And the traversal of
      """
      g.inject(true).project("b").by(__.fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"b":["true"]}] |
