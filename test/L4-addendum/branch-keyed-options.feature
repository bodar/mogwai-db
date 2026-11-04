Feature: mogwai addendum — branch() and choose() keyed options share one lowering, under two match policies

  # `branch()` and `choose()` are both `BranchStep`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java):
  # a choice per start, every option whose key admits it collected (`pickBranches`), `Pick.none` taking a
  # start no key admitted — and an unproductive one where no `Pick.unproductive` is written — and
  # `Pick.any` taking every start. `ChooseStep` keeps only the FIRST admitting option, installs identity
  # pass-throughs for both `Pick` tokens, and refuses `Pick.any` and traversal keys
  # (.../branch/ChooseStep.java). One lowering (`chooseOptions`, `rel/lower/branch.ts`) serves both,
  # parametrized by `MatchPolicy` (`ir/option-map.ts`).

  Scenario: g_V_hasLabelXpersonX_branchXageX_optionXgtX26X__aX_optionXgtX30X__bX
    # Overlapping keys: a start runs EVERY admitting option, not the first.
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").branch(__.values("age")).option(P.gt(26), __.constant("a")).option(P.gt(30), __.constant("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | a |
      | a |
      | a |
      | a |
      | b |
      | b |

  Scenario: g_V_branchXlabelX_optionXperson__nameX_optionXperson__ageX
    # A repeated key is two options admitting the same starts — a multiset, by design.
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.label()).option("person", __.values("name")).option("person", __.values("age"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  Scenario: g_V_branchXageX_optionXgtX30X__oldX_optionXnone__otherX
    # No `Pick.unproductive` written: an unproductive choice (lop, ripple have no age) falls to `Pick.none`.
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.values("age")).option(P.gt(30), __.constant("old")).option(Pick.none, __.constant("other"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | old |
      | old |
      | other |
      | other |
      | other |
      | other |

  Scenario: g_V_branchXageX_optionXgtX30X__oldX_optionXunproductive__noageX_optionXnone__otherX
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.values("age")).option(P.gt(30), __.constant("old")).option(Pick.unproductive, __.constant("noage")).option(Pick.none, __.constant("other"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | old |
      | old |
      | other |
      | other |
      | noage |
      | noage |

  Scenario: g_V_branchXlabelX_optionXsoftware__nameX
    # No pass-through on a branch(): a start no option claims is dropped.
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.label()).option("software", __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  Scenario: g_V_branchXageX_optionXany__constantX1XX_count
    # `Pick.any` takes every start, unproductive ones included.
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.values("age")).option(Pick.any, __.constant(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_branchXidentityX_optionX1__hitX_optionXneqX1X__missX
    # An element equals no literal (equality never crosses a type space), whatever its id.
    Given the modern graph
    And the traversal of
      """
      g.V().branch(__.identity()).option(1, __.constant("hit")).option(P.neq(1), __.constant("miss"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | miss |
      | miss |
      | miss |
      | miss |
      | miss |
      | miss |

  Scenario: g_V_chooseXidentityX_optionX1__hitX_optionXnone__missX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.identity()).option(1, __.constant("hit")).option(Pick.none, __.constant("miss"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | miss |
      | miss |
      | miss |
      | miss |
      | miss |
      | miss |

  Scenario: g_V_valuesXnameX_chooseXlengthX_optionX5__fiveX
    # A keyed choose over a VALUE stream; an unclaimed value passes through.
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").choose(__.length()).option(5, __.constant("five"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | five |
      | five |
      | five |
      | lop |
      | josh |
      | ripple |

  Scenario: g_V_valuesXageX_branchXidentityX_optionXisXgtX30XX__oldX_optionXisXltX30XX__youngX
    # A traversal key is run on the CHOICE, here a value.
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").branch(__.identity()).option(__.is(P.gt(30)), __.constant("old")).option(__.is(P.lt(30)), __.constant("young"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | old |
      | old |
      | young |
      | young |

  Scenario: g_V_localXbranchXlabelX_optionXperson__nameX_optionXsoftware__langXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.branch(__.label()).option("person", __.values("name")).option("software", __.values("lang")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | java |
      | java |

  Scenario: g_V_asXaX_branchXselectXaX_ageX_optionXgtX30X__selectXaX_nameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").branch(__.select("a").values("age")).option(P.gt(30), __.select("a").values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |
      | peter |

  Scenario: g_V_localXlabel_isXpersonX_countX
    # The branch witnesses' choice: a value filter then a count, as a correlated child.
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.label().is("person").count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_unionXchooseXnameX_optionXisXmarkoX__ageXX
    # The reference's refusal of a traversal key holds at any depth.
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.choose(__.values("name")).option(__.is("marko"), __.values("age")))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Traversal is not allowed as a Pick token for choose().option()"

  Scenario: g_V_chooseXlabelX_optionXnameX
    # A one-argument option() IS Pick.any, which choose() refuses.
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.label()).option(__.values("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Choose step can not have an any-option"

  Scenario: g_V_localXdedup_byXnameX_byXageXX
    # A construction-time refusal nested in a child body is raised, not swallowed.
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.dedup().by("name").by("age"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Dedup step can only have one by modulator"
