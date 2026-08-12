# mogwai addendum — a where() body on an edge stream that CARRIES otherV() context.
#
# A trailing `otherV()` turns `trackFromV` on for the whole prefix, so `outE()` carries the
# entering-vertex column. The generic child-existence gate used to decline ANY child body under a
# fromV-carrying parent, while the inline predicate compiled it happily — so the two lowerings
# disagreed with fast paths OFF, which L5's rotating seed found. The guard now asks whether the
# BODY reads that context (only `otherV()` does) rather than whether the parent carries it.
#
# The last scenario is the other half of the fix and matters as much: a body that DOES read the
# context still fails closed, because inside a child scope `otherV()` would see the PARENT's
# entering vertex. It must decline on BOTH lowerings, not just the generic one.
@gap:where-under-otherv-context
Feature: Step - where() under otherV() context

  @Unsupported
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

  @Unsupported
  Scenario: g_V_outE_whereXhasXweight_gtX1XXX_otherV_name
    Given the modern graph
    And the traversal of
      """
      g.V().outE().where(__.has("weight", P.gt(1))).otherV().values("name")
      """
    When iterated to list
    Then the result should be empty

  @Unsupported
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
