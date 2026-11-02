Feature: mogwai addendum — onCreate may restate a per-driver merge map, never override it

  # `MergeVertexStep.onCreateMap` / `MergeEdgeStep.onCreateMap` fuse the merge map with the onCreate map
  # after `MergeElementStep.validateNoOverrides`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java:182-205,
  # .../MergeElementStep.java:325-334): a key both maps hold must carry an EQUAL value, and the union then
  # holds it ONCE. A map-valued driver (`inject(map).mergeV()`) or a computed search
  # (`mergeV(__.project(...))`) holds its merge map as DATA per driver, so the check runs per driver that
  # creates. Before: the onCreate value was appended beside the map's (a two-valued `name`), an equal
  # restatement was stored twice, a different label silently won, and an onCreate T.id was dropped.

  Scenario: g_injectXmapX_mergeV_optionXonCreate_overrideX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "x"]).mergeV().option(Merge.onCreate, ["name": "y"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (name, y)"

  Scenario: g_withSideEffectXk_mapX_injectXmapX_mergeV_optionXonCreate_selectXkXX_override_raises
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("k", ["name": "y"]).inject(["name": "x"]).mergeV().option(Merge.onCreate, __.select("k"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (name, y)"

  Scenario: g_withSideEffectXk_mapX_injectXmapX_mergeV_optionXonCreate_selectXkXX_restates_once
    Given the empty graph
    And the graph initializer of
      """
      g.withSideEffect("k", ["name": "x", "age": 3]).inject(["name": "x"]).mergeV().option(Merge.onCreate, __.select("k"))
      """
    And the traversal of
      """
      g.V().has("name", "x").properties()
      """
    When iterated to list
    Then the result should have a count of 2

  Scenario: g_injectXmap_mapX_mergeV_optionXonCreate_mapX_second_driver_overrides
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "x"], ["name": "z", "age": 1]).mergeV().option(Merge.onCreate, ["age": 3])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (age, 3)"

  Scenario: g_injectXmap_labelX_mergeV_optionXonCreate_labelX
    Given the empty graph
    And the traversal of
      """
      g.inject([(T.label): "dog", "name": "x"]).mergeV().option(Merge.onCreate, [(T.label): "cat"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (label, cat)"

  Scenario: g_injectXmap_labelX_mergeV_optionXonCreate_same_labelX_label
    Given the empty graph
    And the traversal of
      """
      g.inject([(T.label): "dog", "name": "x"]).mergeV().option(Merge.onCreate, [(T.label): "dog"]).label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | dog |

  Scenario: g_injectXmapX_mergeE_optionXonCreate_overrideX_raises
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "kk", (Direction.OUT): 1, (Direction.IN): 2, "w": 1]).mergeE().option(Merge.onCreate, ["w": 2])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (w, 2)"

  Scenario: g_injectXmapX_mergeE_optionXonCreate_labelX_raises
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "kk", (Direction.OUT): 1, (Direction.IN): 2]).mergeE().option(Merge.onCreate, [(T.label): "zz"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (label, zz)"

  Scenario: g_injectX1X_mergeVXprojectXnameX_byXconstantXzzXXX_optionXonCreate_overrideX
    Given the empty graph
    And the traversal of
      """
      g.inject(1).mergeV(__.project("name").by(__.constant("zz"))).option(Merge.onCreate, ["name": "q"])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (name, q)"

  Scenario: g_injectX1X_mergeVXprojectXnameX_byXconstantXzzXXX_optionXonCreate_restateX
    Given the empty graph
    And the graph initializer of
      """
      g.inject(1).mergeV(__.project("name").by(__.constant("zz"))).option(Merge.onCreate, ["name": "zz", "age": 1])
      """
    And the traversal of
      """
      g.V().properties()
      """
    When iterated to list
    Then the result should have a count of 2

  # A BigDecimal onCreate value over a map driver answers, and renders in the override sentence.
  Scenario: g_injectXmapX_mergeV_optionXonCreate_bigdecimalX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(["name": "x"]).mergeV().option(Merge.onCreate, ["n": 1.5m]).values("n").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectXmap_bigdecimalX_mergeV_optionXonCreate_other_bigdecimalX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["n": 1.5m]).mergeV().option(Merge.onCreate, ["n": 2.5m])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (n, 2.5)"

  # Objects.equals: an equal LIST restates (ordered); an equal MAP restates in any entry order.
  Scenario: g_injectXedge_map_listX_mergeE_optionXonCreate_same_listX
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label): "knows", (Direction.OUT): 1, (Direction.IN): 2, "l": ["a", "b"]]).mergeE().option(Merge.onCreate, ["l": ["a", "b"]]).values("l")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b] |

  Scenario: g_injectXmap_listX_mergeV_optionXonCreate_reordered_listX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["l": ["a", "b"]]).mergeV().option(Merge.onCreate, ["l": ["b", "a"]])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (l, [b, a])"

  Scenario: g_injectXmap_mapX_mergeV_optionXonCreate_reordered_mapX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(["m": ["x": 1, "y": 2]]).mergeV().option(Merge.onCreate, ["m": ["y": 2, "x": 1]]).properties("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  Scenario: g_injectXmap_mapX_mergeV_optionXonCreate_other_mapX_raises
    Given the empty graph
    And the traversal of
      """
      g.inject(["m": ["x": 1]]).mergeV().option(Merge.onCreate, ["m": ["x": 2]])
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "option(onCreate) cannot override values from merge() argument: (m, {x=2})"
