Feature: mogwai addendum — multi-term order().by() mixing property keys and traversals

  # A single order().by(__.trav) already lowers through the generic scalar child seam
  # (lowerElementOrderByTraversal). This extends it to MULTIPLE by() terms where any term
  # may be a property key OR a traversal — each traversal term computes its per-traverser
  # sort column through the same seam and the composite ORDER BY combines them in order.
  # @gap:order-traversal-multi marks the family for an upstream give-back.

  @gap:order-traversal-multi
  Scenario: g_V_hasLabelXpersonX_order_byXoutE_countX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by(__.out().count()).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | peter |
      | josh |
      | marko |

  @gap:order-traversal-multi
  Scenario: g_V_hasLabelXpersonX_order_byXnameX_byXoutE_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by("age").by(__.out().count()).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | vadas |
      | marko |
      | josh |
      | peter |

  @gap:order-traversal-multi
  Scenario: g_V_hasLabelXpersonX_order_byXinE_countX_byXoutE_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").order().by(__.in().count()).by(__.out().count()).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | peter |
      | marko |
      | vadas |
      | josh |
