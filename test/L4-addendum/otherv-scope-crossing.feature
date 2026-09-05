Feature: mogwai addendum — otherV() reads the entering vertex across a fan-out scope boundary

  # otherV() (EdgeOtherVertexStep) reads the nearest previous Vertex from path history
  # (`vendor/tinkerpop/gremlin-core/.../step/map/EdgeOtherVertexStep.java:44-55`). When the edge hop
  # sits INSIDE a fan-out body (local/coalesce/union arm) and the otherV() is in the enclosing chain,
  # the body's edge hop must mint the entering vertex (the fromV channel) for the outer otherV() to
  # read. The A/C-phase outbound-frame work threads that demand (ctx.needsFromV via childRows/inArmBody),
  # so these compositions — including with a following path() — now lower. Repeat-body otherV() stays
  # deferred (the repeat substrate, not this one). Pins the composition against regression.

  @gap:otherv-scope-crossing
  Scenario: g_V_peter_coalesceXoutE_knows__outE_createdX_otherV_path_byXnameX_byXlabelX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","peter").coalesce(__.outE("knows"), __.outE("created")).otherV().path().by("name").by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[peter,created,lop] |

  @gap:otherv-scope-crossing
  Scenario: g_V_peter_localXbothEXcreatedX_limitX1XX_otherV_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","peter").local(__.bothE("created").limit(1)).otherV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
