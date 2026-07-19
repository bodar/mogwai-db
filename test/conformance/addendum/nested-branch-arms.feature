Feature: mogwai addendum — nested branch arms (a branch inside a branch arm)

  # choose/coalesce/union whose ARM is itself a choose/coalesce/union. The generic engine
  # re-dispatches the nested branch to the element-parent branch compilers (which recurse per
  # arm), so a nested branch composes at every fan-out-tolerant consumer — root scalar
  # projection and group().by(value). classifyScalarChild recognizes the nested-scalar-arm
  # shape (elementScalarBranchArm); the emit path was already recursive. @gap:nested-branch
  # marks the family for a possible gremlin-test PR.

  @gap:nested-branch
  Scenario: g_V_out_chooseXhasLabelXpersonX_coalesceXvaluesXnameX_constantXxXX_constantXzXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().choose(__.hasLabel("person"), __.coalesce(__.values("name"), __.constant("x")), __.constant("z"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | z |
      | z |
      | z |
      | z |

  @gap:nested-branch
  Scenario: g_V_out_coalesceXchooseXhasLabelXpersonX_valuesXnameX_constantXSWXX_constantXnoneXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().coalesce(__.choose(__.hasLabel("person"), __.values("name"), __.constant("SW")), __.constant("none"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | SW |
      | SW |
      | SW |
      | SW |

  @gap:nested-branch
  Scenario: g_V_out_unionXchooseXhasLabelXpersonX_constantXPX_constantXSXX_constantXZXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().union(__.choose(__.hasLabel("person"), __.constant("P"), __.constant("S")), __.constant("Z"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | P |
      | P |
      | S |
      | S |
      | S |
      | S |
      | Z |
      | Z |
      | Z |
      | Z |
      | Z |
      | Z |

  @gap:nested-branch
  Scenario: g_V_groupXbyXTlabelX_byXcoalesceXvaluesXlangX_constantXnaXXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.coalesce(__.values("lang"), __.constant("n/a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[n/a,n/a,n/a,n/a]","software":"l[java,java]"}] |
