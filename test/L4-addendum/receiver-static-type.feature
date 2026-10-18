Feature: mogwai addendum — a receiver's STATIC type reaches the receiver authority at every host

  # A Boolean is stored as SQLite's integer 1/0, so a check against the STORAGE class reads `true` as a
  # Number and `CAST(true AS TEXT)` as '1'. The reference decides both by the Java type:
  #
  #   * math() throws for a variable that does not resolve to a Number
  #     (vendor/tinkerpop/gremlin-core/.../step/map/MathStep.java:80-87);
  #   * asString() is String.valueOf (vendor/tinkerpop/gremlin-core/.../step/map/AsStringGlobalStep.java:46),
  #     so a Boolean renders "true"/"false", and a Double renders Double.toString.
  #
  # The fix is one carrier (`hostTag`, src/compiler/rel/child.ts): every scalar host that knows a static
  # tag carries it, so `evidenceOf` (src/compiler/rel/receiver.ts) reads it as static at the root, inside
  # a child value run, under an `as()` label and through a `by()`. `asString` renders from the same
  # evidence (`asStringOf`). A statically refuted math() receiver DECLINES (the reference's message names
  # the per-row Java class), so those scenarios are @Unsupported and assert the fail-closed half.

  @Unsupported
  Scenario: g_injectXtrueX_mathX_plus_1X
    Given the empty graph
    And the traversal of
      """
      g.inject(true).math("_ + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_localXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_mapXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_projectXxX_byXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_asXaX_selectXaX_byXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).as("a").select("a").by(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_group_by_byXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).group().by().by(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_VX1X_order_byXconstantXtrueX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V(1).order().by(__.constant(true).math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  @Unsupported
  Scenario: g_injectXtrueX_asXaX_mathXa_plus_1X
    Given the empty graph
    And the traversal of
      """
      g.inject(true).as("a").math("a+1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable a for math() step must resolve to a Number"

  Scenario: g_injectXtrue_falseX_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(true, false).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |
      | str[false] |

  Scenario: g_injectXtrue_1X_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(true, 1).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |
      | 1 |

  Scenario: g_VX1X_localXconstantXtrueX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.constant(true).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |

  Scenario: g_VX1X_mapXconstantXfalseX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.constant(false).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[false] |

  Scenario: g_VX1X_projectXxX_byXconstantXtrueX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V(1).project("x").by(__.constant(true).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"str[true]"}] |

  Scenario: g_VX1X_valuesXnameX_asXaX_constantXtrueX_asString
    Given the modern graph
    And the traversal of
      """
      g.V(1).values("name").as("a").constant(true).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |

  Scenario: g_addVXxX_propertyXb_trueX_valuesXbX_asString
    Given the empty graph
    And the traversal of
      """
      g.addV("x").property("b", true).values("b").asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |

  # A whole Double stored as an integer still renders as a Double ("1.0", not "1").
  Scenario: g_E_valuesXweightX_asString
    Given the modern graph
    And the traversal of
      """
      g.E().values("weight").asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 0.5 |
      | 1.0 |
      | 0.4 |
      | 1.0 |
      | 0.4 |
      | 0.2 |

  # A BARE list literal has no Boolean carrier (`constLit(true)` is the integer 1), so a Boolean member
  # declines rather than frame as 1 and stringify as "1".
  @Unsupported
  Scenario: g_injectXlistXtrue_1XX_asStringXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject([true,1]).asString(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[true,1] |

  # A Double prints SQLite's text of the REAL, not Java's Double.toString layout ("1.0E7") — a
  # deliberate divergence (docs/feature-support-matrix.md); a whole value keeps its ".0".
  Scenario: g_injectX1e7dX_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(1.0e7d).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 10000000.0 |

  # The per-row VALUE raises that were separate guard STATEMENTS (`Binding.guard`) are one in-statement
  # WHERE now (`raisingRows`/`projectRaising` in lower.ts, `raisingMembers` in list.ts). A consumer that
  # reads only how MANY rows there are must still evaluate it — the reference pulls every traverser
  # through the raising step before count() can answer.
  Scenario: g_injectX300X_sum_asNumberXGType_BYTEX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(300).sum().asNumber(GType.BYTE).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't convert number of type Long to Byte due to overflow."

  Scenario: g_injectXaX_concatXV_99999_valuesXnameXX_count
    Given the modern graph
    And the traversal of
      """
      g.inject("a").concat(__.V(99999).values("name")).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The provided traverser does not map to a value"

  Scenario: g_injectXlistXa_1XX_toUpperXlocalX_count
    Given the empty graph
    And the traversal of
      """
      g.inject(["a", 1]).toUpper(Scope.local).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper(local) step can only take string or list of strings"

  Scenario: g_injectXnullX_asString_count
    Given the empty graph
    And the traversal of
      """
      g.inject(null).asString().count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse null as String."

  # THE SACK carries its own type tag (`SACK_TYPE_COL`, src/compiler/rel/sack.ts) — the seed's declared
  # type, an `assign`'s by() evidence — and reaches every reader as a per-row `vtype`, so the root read,
  # the child `sack()` value run and a `group().by()` key all see a `withSack(true)` as the Boolean it is.
  # Before it, the sack was SQLite's integer 1 to every reader: `sack()` framed Int 1, `asString()` '1',
  # `math('_+1')` 2.0. The math() forms raise PER ROW with the reference's own message (the tag is a
  # column, so the check is in-statement rather than a compile-time decline).

  Scenario: g_withSackXtrueX_V_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | true |
      | true |
      | true |
      | true |
      | true |
      | true |

  Scenario: g_withSackXtrueX_V_sack_mathX_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().sack().math("_+1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_withSackXtrueX_V_localXsack_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().local(__.sack().math("_+1"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_injectXtrueX_sackXassignX_byXidentityX_sack_mathX_plus_1X
    Given the empty graph
    And the traversal of
      """
      g.inject(true).sack(Operator.assign).by(__.identity()).sack().math("_+1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_withSackXtrueX_V_sack_asString
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().sack().asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |
      | str[true] |
      | str[true] |
      | str[true] |
      | str[true] |
      | str[true] |

  Scenario: g_withSackXtrueX_VX1X_projectXsX_byXsack_asStringX
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V(1).project("s").by(__.sack().asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"s":"str[true]"}] |

  Scenario: g_injectXtrueX_sackXassignX_byXconstantXtrueXX_sack_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(true).sack(Operator.assign).by(__.constant(true)).sack().asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[true] |

  Scenario: g_withSackXtrueX_V_groupCount_byXsackX
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().groupCount().by(__.sack())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"true":"d[6].l"}] |

  # A child value's per-row tag reaches a MAP KEY too (`producedMemberNode`): a stored Boolean keyed `1`.
  Scenario: g_addVXxX_propertyXb_trueX_groupCount_byXvaluesXbXX
    Given the empty graph
    And the traversal of
      """
      g.addV("x").property("b", true).groupCount().by(__.values("b"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"true":"d[1].l"}] |

  # An ARITHMETIC sack operator casts both operands to Number (`Operator.java` sum/minus/mult/div), so a
  # Boolean sack or a String operand raises there; SQLite added 1 or 0. The raise is a run-time deferral
  # (the reference's message is a JVM cast message naming per-row classes); a by() value proven
  # non-Number at compile time declines.
  Scenario: g_withSackXtrueX_V_sackXsumX_byXageX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().sack(Operator.sum).by("age").sack()
      """
    When iterated to list
    Then the traversal will raise an error

  Scenario: g_withSackX1X_V_sackXsumX_byXnameX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by("name").sack()
      """
    When iterated to list
    Then the traversal will raise an error

  @Unsupported
  Scenario: g_withSackX1X_V_sackXsumX_byXconstantXtrueXX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by(__.constant(true)).sack()
      """
    When iterated to list
    Then the traversal will raise an error

  # A zero has no sign (a deliberate divergence, docs/feature-support-matrix.md): `-0.0` prints `0.0`, as SQLite does.
  Scenario: g_injectX_0_0dX_asString
    Given the empty graph
    And the traversal of
      """
      g.inject(-0.0d).asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[0.0] |

  # The sack operator's raise is a ROW PREDICATE (`raisingRows`, src/compiler/rel/receiver.ts), not a CASE
  # inside the folded value: a sack nobody reads afterwards is a select-list column SQLite prunes, and the
  # raise went with it — so whether the query failed depended on the step that came next. The reference
  # raises on every traverser whatever follows (`Operator.sum`'s `(Number)` cast,
  # vendor/tinkerpop/gremlin-core/.../process/traversal/Operator.java).
  Scenario: g_withSackX1X_V_sackXsumX_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  Scenario: g_withSackX1X_V_sackXsumX_byXnameX_count
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by("name").count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  Scenario: g_withSackX1X_V_sackXsumX_byXnameX_fold
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by("name").fold()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  Scenario: g_withSackX1X_V_sackXsumX_byXnameX_path
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().sack(Operator.sum).by("name").path()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  Scenario: g_withSackXtrueX_V_sackXsumX_byXageX_count
    Given the modern graph
    And the traversal of
      """
      g.withSack(true).V().sack(Operator.sum).by("age").count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  # The same raise inside a correlated child body, where the sack cannot be fenced and an existence-only
  # consumer (count) never reads it.
  Scenario: g_V_localXsackXassignX_byXageX_sackXsumX_byXnameX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.sack(Operator.assign).by("age").sack(Operator.sum).by("name").count())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "an operand that is not a Number"

  Scenario: g_withSackXzX_V_hasLabelXsoftwareX_sackXminX_byXnameX_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack("m").V().hasLabel("software").sack(Operator.min).by("name").sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | m |

  # An integral `div` by zero is the integral helper's ArithmeticException (NumberHelper.java:138-142); SQLite
  # answered NULL.
  Scenario: g_withSackX1X_injectX1X_sackXdivX_byXconstantX0XX_sack
    Given the empty graph
    And the traversal of
      """
      g.withSack(1).inject(1).sack(Operator.div).by(__.constant(0)).sack()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "/ by zero"

  Scenario: g_withSackX1X_injectX1X_sackXdivX_byXconstantX0XX_count
    Given the empty graph
    And the traversal of
      """
      g.withSack(1).inject(1).sack(Operator.div).by(__.constant(0)).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "/ by zero"

  # A by()-less fold of a NULL traverser folds the null — SackValueStep drops only for an unproductive by()
  # (vendor/tinkerpop/gremlin-core/.../step/sideEffect/SackValueStep.java:73-80) — and a null operand
  # leaves the sack (NumberHelper.java:402). The traverser was dropped.
  Scenario: g_withSackX1X_injectXnullX_sackXsumX_sack
    Given the empty graph
    And the traversal of
      """
      g.withSack(1).inject(null).sack(Operator.sum).sack()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  Scenario: g_withSackX1_5fX_V_sack_asString
    Given the modern graph
    And the traversal of
      """
      g.withSack(1.5f).V().hasLabel("software").sack().asString()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | str[1.5] |
      | str[1.5] |
