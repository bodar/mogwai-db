Feature: mogwai addendum — an onCreate null (a removal) overrides a merge key that holds a value

  # `MergeElementStep.validateNoOverrides`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeElementStep.java:325-334)
  # compares with `Objects.equals(v, mergeMap.get(k))` for every key the merge map CONTAINS — so
  # `['age': null]` against a merge map holding `age: 1` is an override, while null against null agrees
  # and a key the merge map does not hold is never compared. Before: both the static check (a constant
  # merge map) and the per-driver guard (an injected or computed map) skipped a null onCreate value, so
  # the creation silently dropped `age: 1` — a lost write.

  Scenario: g_injectXmapX_mergeV_optionXonCreate_nullX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "x", "age": 1]).mergeV().option(Merge.onCreate, ["age": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (age, null)"

  Scenario: g_mergeVXmapX_optionXonCreate_nullX_raises
    Given the empty graph
    And the traversal of
      """
      g.mergeV(["name": "x", "age": 1]).option(Merge.onCreate, ["age": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (age, null)"

  Scenario: g_mergeVXprojectX_optionXonCreate_nullX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(1).mergeV(__.project("name", "age").by(__.constant("x")).by(__.constant(1))).option(Merge.onCreate, ["age": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (age, null)"

  Scenario: g_injectXmap_mapX_mergeV_optionXonCreate_nullX_second_driver_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "x"], ["name": "y", "age": 1]).mergeV().option(Merge.onCreate, ["age": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (age, null)"

  Scenario: g_mergeVXmapX_optionXonCreate_null_absent_keyX_creates
    Given the empty graph
    And the graph initializer of
      """
      g.mergeV(["name": "x"]).option(Merge.onCreate, ["age": null])
      """
    And the traversal of
      """
      g.V().has("name", "x").properties()
      """
    When iterated to list
    Then the result should have a count of 1

  Scenario: g_injectXmap_nullX_mergeV_optionXonCreate_nullX_agrees
    Given the empty graph
    And the graph initializer of
      """
      g.inject(["name": "x", "age": null]).mergeV().option(Merge.onCreate, ["age": null])
      """
    And the traversal of
      """
      g.V().has("name", "x").properties()
      """
    When iterated to list
    Then the result should have a count of 1

  Scenario: g_mergeVXmap_nullX_optionXonCreate_nullX_agrees
    Given the empty graph
    And the graph initializer of
      """
      g.mergeV(["name": "x", "age": null]).option(Merge.onCreate, ["age": null])
      """
    And the traversal of
      """
      g.V().has("name", "x").properties()
      """
    When iterated to list
    Then the result should have a count of 1

  Scenario: g_injectXmapX_mergeV_optionXonCreate_nullX_matched_does_not_validate
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property("name", "x").property("age", 1)
      """
    And the traversal of
      """
      g.inject(["name": "x", "age": 1]).mergeV().option(Merge.onCreate, ["age": null]).values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_injectXmapX_mergeE_optionXonCreate_nullX_raises
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "kk", (Direction.OUT): 1, (Direction.IN): 2, "w": 1]).mergeE().option(Merge.onCreate, ["w": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (w, null)"

  Scenario: g_mergeEXmapX_optionXonCreate_nullX_raises
    Given the modern graph
    And the traversal of
      """
      g.mergeE([(T.label): "kk", (Direction.OUT): 1, (Direction.IN): 2, "w": 1]).option(Merge.onCreate, ["w": null])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (w, null)"

  Scenario: g_injectXmap_nullX_mergeE_optionXonCreate_nullX_agrees
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "kk", (Direction.OUT): 1, (Direction.IN): 2, "w": null]).mergeE().option(Merge.onCreate, ["w": null]).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | kk |
