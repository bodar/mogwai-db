Feature: mogwai addendum — a choose arm reading a withSideEffect constant answers at any depth

  # Over a non-Map traverser `select(k)` reads the side effect `k`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:126-127),
  # so a `choose` arm `select(k)` of a `withSideEffect` constant produces that constant for every row the
  # arm is chosen on. The constant's presence is its host's (`constantSelectChild`, `rel/lower/reduction.ts`):
  # over a host that is always there the arm is `'always'`, the choice's compile-time meet of its arms
  # (`meetPresence`, `rel/child.ts`) answers, and no per-row presence term is spent.

  Scenario: g_withSideEffectXk_5X_V_mapXchooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().map(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[0].i |
      | d[0].i |

  Scenario: g_withSideEffectXk_5X_V_projectXxX_byXchooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().project("x").by(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[5].i"}] |
      | m[{"x":"d[5].i"}] |
      | m[{"x":"d[5].i"}] |
      | m[{"x":"d[5].i"}] |
      | m[{"x":"d[0].i"}] |
      | m[{"x":"d[0].i"}] |

  # The option-map form reaches the same choice.
  Scenario: g_withSideEffectXk_5X_V_mapXchooseXlabelX_optionXperson_selectXkXX_optionXnone_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().map(__.choose(__.label()).option("person", __.select("k")).option(Pick.none, __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[0].i |
      | d[0].i |

  Scenario: g_withSideEffectXk_list12X_V_mapXchooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", [1, 2]).V().map(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i] |
      | l[d[1].i,d[2].i] |
      | l[d[1].i,d[2].i] |
      | l[d[1].i,d[2].i] |
      | d[0].i |
      | d[0].i |

  Scenario: g_withSideEffectXk_5X_V_localXchooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().local(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[0].i |
      | d[0].i |

  Scenario: g_withSideEffectXk_5X_V_mapXcoalesceXchooseXhasLabelXpersonX_selectXkX_constantX0XX_constantX9XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().map(__.coalesce(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)), __.constant(9)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[0].i |
      | d[0].i |

  Scenario: g_withSideEffectXk_5X_V_groupXX_byXnameX_byXchooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().group().by("name").by(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[5].i","vadas":"d[5].i","josh":"d[5].i","peter":"d[5].i","lop":"d[0].i","ripple":"d[0].i"}] |

  # The arm's value is the sort key: descending puts every person (5) before the software (0).
  Scenario: g_withSideEffectXk_5X_V_orderXX_byXchooseXhasLabelXpersonX_selectXkX_constantX0XX_descX_byXnameX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().order().by(__.choose(__.hasLabel("person"), __.select("k"), __.constant(0)), Order.desc).by("name").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | marko |
      | peter |
      | vadas |
      | lop |
      | ripple |

  # A stated-presence arm still declines: over a label bound on only some rows (`optional(…as('b'))`)
  # the constant's presence is the label's per-row predicate, and the choice's compile-time meet cannot
  # carry a stated arm (`meetPresence`). The reference drops the unbound rows and keeps the two bound ones.
  @Unsupported
  Scenario: g_withSideEffectXk_5X_V_optionalXoutXknowsX_asXbXX_mapXselectXbX_chooseXhasLabelXpersonX_selectXkX_constantX0XXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("k", 5).V().optional(__.out("knows").as("b")).map(__.select("b").choose(__.hasLabel("person"), __.select("k"), __.constant(0)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
