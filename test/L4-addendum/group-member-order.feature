Feature: mogwai addendum — group() values preserve member arrival order

  # The official corpus compares group maps without a repeated vertex member inside a value list,
  # so it cannot distinguish arrival order from rowid or scan order. both() revisits vertices and
  # makes that distinction observable. The map's entries remain unordered; each value list does not.
  @gap:group-member-order
  Scenario: g_V_both_group_byXlabelX_preserves_member_arrival_order
    Given the modern graph
    And the traversal of
      """
      g.V().both().group().by(T.label)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":["v[vadas]","v[josh]","v[marko]","v[marko]","v[josh]","v[peter]","v[marko]","v[josh]"],"software":["v[lop]","v[lop]","v[ripple]","v[lop]"]}] |

  # g.V().values("name").fold() establishes the modern graph's arrival order as
  # [marko,vadas,lop,josh,ripple,peter]. Every traverser lands under the same key here, and the child
  # value differs for each one, so Operator.assign's last-arriving rule must select peter rather than
  # collecting all six values (or choosing the highest/lowest value independently of encounter).
  @gap:group-child-value-assignment
  Scenario: g_V_group_byXconstantXallXX_byXvaluesXnameXX_last_arriving_wins
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(__.constant("all")).by(__.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"all":"peter"}] |
