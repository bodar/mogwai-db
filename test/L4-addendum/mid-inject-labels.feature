Feature: mogwai addendum — a mid-traversal inject() adds traversers that hold no label

  # `InjectStep` is a `StartStep`: each injected value is a NEW traverser with an EMPTY path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/sideEffect/StartStep.java),
  # so a label bound before the inject is held only by the incoming rows. `select()` drops the injected
  # traverser (SelectOneStep emits nothing for a missing key), while a `from()`/`to()` sub-path at that
  # label cannot be located on it — `Path.subPath` raises couldNotLocatePathFromLabel
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/Path.java).

  Scenario: g_V_hasXname_markoX_asXaX_valuesXageX_injectX1X_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").as("a").values("age").inject(1).select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |

  Scenario: g_V_hasXname_markoX_asXaX_valuesXageX_injectX1X_pathXX_fromXaX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").as("a").values("age").inject(1).path().from("a")
      """
    When iterated to list
    Then the traversal will raise an error

  Scenario: g_V_hasXname_markoX_asXaX_valuesXageX_injectX1X_simplePathXX_fromXaX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name", "marko").as("a").values("age").inject(1).simplePath().from("a")
      """
    When iterated to list
    Then the traversal will raise an error
