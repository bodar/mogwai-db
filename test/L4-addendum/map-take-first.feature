Feature: mogwai addendum — map() take-first over a fan-out arm (canonical emission order)

  # map() is first-result-only in TinkerPop. Over a FAN-OUT arm body (a nested union/choose/
  # coalesce, or a re-source projection) it takes the FIRST EMITTED result per input — arm 0
  # before arm 1 (union order, which TinkerPop fixes), a re-source in element-id order. This is
  # the canonical-emission-order substrate (Stage A): the scalar branch merge (unionScalarStreams)
  # synthesizes a per-origin `encounter = ROW_NUMBER() OVER (ORDER BY arm_idx, arm_encounter)`,
  # and the child `first` cardinality policy collapses to it. Previously map() over a fan-out arm
  # failed closed. The official corpus never combines map() with a fan-out scalar arm.
  # @gap:map-take-first marks the family for a possible gremlin-test PR.

  @gap:map-take-first
  @Unsupported
  Scenario: g_V_hasLabelXpersonX_valuesXageX_mapXunionXconstantXloX_constantXhiXXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").map(__.union(__.constant("lo"), __.constant("hi")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lo |
      | lo |
      | lo |
      | lo |

  @gap:map-take-first
  @Unsupported
  Scenario: g_V_hasLabelXpersonX_valuesXageX_mapXchooseXisXgtX30XX_constantXoldX_constantXyoungXXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("age").map(__.choose(__.is(gt(30)), __.constant("old"), __.constant("young")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | young |
      | young |
      | old |
      | old |

  @gap:map-take-first
  @Unsupported
  Scenario: g_V1_valuesXageX_mapXV_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).values("age").map(__.V().values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
