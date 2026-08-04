Feature: mogwai addendum — group() value lists preserve member arrival order

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
