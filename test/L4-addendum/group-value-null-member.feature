Feature: mogwai addendum — a group value body that may yield a NULL declines until presence is carried

  # `GroupStep` pools every value a value traversal PRODUCES, and a null is a produced value
  # (vendor/tinkerpop/gremlin-core/.../process/traversal/util/TraversalProduct.java; Grouping.java:74-125).
  # The group value lowering still reads a NULL member as an UNPRODUCTIVE one — the pooled fold() drops it
  # together with its empty-group seed, the per-member child drops it as absent — so
  # `group().by().by(__.constant([1,null,2]).unfold().fold())` answered [1,2] for [1,null,2].
  #
  # The stopgap is a static "may be null" test over the value body (`mayYieldNull`,
  # src/compiler/ir/strategies.ts: a constant()/inject() literal that is or holds a null, at any depth,
  # coalesce/union/choose arms included). Each scenario below is the REFERENCE's answer and must refuse
  # until the value lowering carries presence apart from the value; a terminal count() counts the null and
  # stays exact.

  @Unsupported
  Scenario: g_VX1X_group_by_byXconstantXlist_1_null_2X_unfold_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant([1,null,2]).unfold().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[d[1].i,null,d[2].i]"}] |

  @Unsupported
  Scenario: g_VX1X_group_by_byXunionXconstantXnullX_constantX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.union(__.constant(null), __.constant(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null,d[1].i]"}] |

  @Unsupported
  Scenario: g_VX1X_group_by_byXcoalesceXconstantXnullX_constantX1XX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.coalesce(__.constant(null), __.constant(1)).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[null]"}] |

  Scenario: g_VX1X_group_by_byXconstantXnullX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by(T.label).by(__.constant(null).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[1].l"}] |
