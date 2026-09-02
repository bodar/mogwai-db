# mogwai addendum — a where() body on an edge stream that CARRIES otherV() context.
#
# A trailing `otherV()` makes the preceding `outE()` retain its entering vertex (the `fromV`
# channel, minted because the forward scan reaches an `otherV` through fromV-transparent steps —
# and `where`/`filter`/`not` are transparent, since an existence gate consumes the child's rows as
# a boolean and hands the parent edge on unchanged). So a `where()` between the edge and the
# `otherV()` composes: the gate filters, the edge keeps its `fromV`, and `otherV()` reads the OTHER
# endpoint. The body may itself move (`inV()`) or fan out (`union()`) — it is still an existence
# question over the edge, so nothing of the child survives to disturb the outer context.
@gap:where-under-otherv-context
Feature: Step - where() under otherV() context

  Scenario: g_V_outE_whereXhasXweight_gtX0_2XXX_otherV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().where(__.has("weight", P.gt(0.2))).otherV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | lop |
      | josh |
      | ripple |

  Scenario: g_V_outE_whereXhasXweight_gtX1XXX_otherV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().where(__.has("weight", P.gt(1))).otherV().values("name")
      """
    When iterated to list
    Then the result should be empty

  Scenario: g_V_outE_whereXinVXhasXname_joshXXX_otherV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().where(__.inV().has("name", "josh")).otherV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
