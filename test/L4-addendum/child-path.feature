Feature: mogwai addendum — child bodies with movement under path tracking

  # A by()-modulator / reducer child whose body contains MOVEMENT (out()/in()/…), lowered
  # while the outer chain tracks a path (simplePath()/path()/cyclicPath()), is a valid
  # composition the official corpus never combines. It previously failed CLOSED: pushChildScope
  # appended the child ordinal physically last (after the path columns), desyncing the seed's
  # declared carried schema from its physical layout, and a scoped reduce barrier carried the
  # child's internally-extended path instead of the parent domain's. Both are fixed; these
  # combinations now compile and run. @gap:child-path marks the family for a gremlin-test PR.

  @gap:child-path
  @Unsupported
  Scenario: g_V_out_simplePath_groupXlabel_by_out_name_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().out().simplePath().group().by(T.label).by(__.out().values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[lop,ripple]","software":"l[]"}] |

  @gap:child-path
  @Unsupported
  Scenario: g_V1_out_simplePath_projectXoutsX_by_out_name_fold
    Given the modern graph
    And the traversal of
      """
      g.V(1).out().simplePath().project("outs").by(__.out().values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"outs":"l[]"}] |
      | m[{"outs":"l[lop,ripple]"}] |
      | m[{"outs":"l[]"}] |
