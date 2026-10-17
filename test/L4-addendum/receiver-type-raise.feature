Feature: mogwai addendum — a type-demanding step RAISES over a receiver of the wrong type, at every depth

  # The reference throws, per traverser, where SQLite would silently coerce:
  #
  #   * the string family throws IllegalArgumentException on a non-null non-String receiver
  #     (vendor/tinkerpop/gremlin-core/.../step/map/ToUpperGlobalStep.java:45-49, TrimGlobalStep.java:47-50),
  #     and so does concat() (ConcatStep.java:71-76) — SQLite's upper(29) answers '29';
  #   * math() throws IllegalStateException for a PRODUCTIVE variable that is not a Number, null included
  #     (MathStep.java:80-87) — CAST('marko' AS REAL) answered 0, and a null was dropped as unproductive;
  #   * exp4j's `/` throws "Division by zero!" — SQLite answered NULL and the row was dropped;
  #   * aggregate() is a CollectingBarrierStep that drains every traverser through its by()
  #     (CollectingBarrierStep.java:66-76), so the by()'s raise is the answer even if the side effect is
  #     never read.
  #
  # One authority decides it (src/compiler/rel/receiver.ts): a statically refuted receiver DECLINES, a
  # per-row one raises the reference's message in-statement. The official corpus asserts only the LIST
  # receiver (ToUpper.feature g_injectXListXa_bXX_toUpper, Concat.feature g_injectXListXa_bXcX_concat_XdX);
  # these pin the scalar receiver at the root and inside each child host.

  Scenario: g_V_valuesXageX_toUpper
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").toUpper()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_V_mapXvaluesXageX_toUpperX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.values("age").toUpper())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_V_projectXxX_byXvaluesXageX_trimX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.values("age").trim())
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The trim() step can only take string as argument"

  Scenario: g_V_whereXvaluesXageX_toLower_isX29XX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.values("age").toLower().is("29"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toLower() step can only take string as argument"

  Scenario: g_V_coalesceXvaluesXageX_toUpper_constantXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.values("age").toUpper(), __.constant("x"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_V_valuesXageX_concatXxX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").concat("x")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "String concat() can only take string as argument"

  Scenario: g_V_projectXxX_byXvaluesXnameX_toUpperX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.values("name").toUpper())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"MARKO"}] |
      | m[{"x":"VADAS"}] |
      | m[{"x":"LOP"}] |
      | m[{"x":"JOSH"}] |
      | m[{"x":"RIPPLE"}] |
      | m[{"x":"PETER"}] |

  Scenario: g_injectXnullX_toUpper
    Given the empty graph
    And the traversal of
      """
      g.inject(null).toUpper()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | null |

  Scenario: g_V_hasXageX_projectXxX_byXmathX_plus_1X_byXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age").project("x").by(__.math("_ + 1").by("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_V_valuesXnameX_mathX_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").math("_ + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_injectXnullX_mathX_plus_1X
    Given the empty graph
    And the traversal of
      """
      g.inject(null).math("_ + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  # A STATIC Boolean receiver is refuted at compile time, so it declines rather than raising; the
  # reference raises the same IllegalStateException.
  @Unsupported
  Scenario: g_injectXtrueX_mathX_plus_1X
    Given the empty graph
    And the traversal of
      """
      g.inject(true).math("_ + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable _ for math() step must resolve to a Number"

  Scenario: g_V_mathX_plus_1X_byXageX
    Given the modern graph
    And the traversal of
      """
      g.V().math("_ + 1").by("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[30.0].d |
      | d[28.0].d |
      | d[33.0].d |
      | d[36.0].d |

  Scenario: g_injectX0X_mathX1_div_X
    Given the empty graph
    And the traversal of
      """
      g.inject(0).math("1 / _")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Division by zero!"

  Scenario: g_injectX2_1_0X_aggregateXxX_byXmathX1_div_XX_order_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(2, 1, 0).aggregate("x").by(__.math("1 / _")).order().limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Division by zero!"

  Scenario: g_injectX2_1X_aggregateXxX_byXmathX1_div_XX_order_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(2, 1).aggregate("x").by(__.math("1 / _")).order().limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].i |

  # A run-time String receiver of asNumber(GType) is parsed by NumberUtils.createNumber, which this
  # compiler does not reproduce, so a non-digit string RAISES a deferral (the reference raises
  # "Can't parse string 'marko' as number."); it no longer casts to 0.
  Scenario: g_V_valuesXnameX_asNumberXGType_INTX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").asNumber(GType.INT)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "asNumber()"

  # A FILTERED-OUT value is UNPRODUCTIVE, not a productive null. A mid-body is() NULLs the value where
  # its predicate fails, and narrows the body's productivity with it (valueRun, reduction.ts), so the
  # null-raising receiver checks — math()'s variables, asString() — read it as the reference does:
  # MathStep.java:75-78 treats an unproductive by() as a FILTER, and AsStringGlobalStep never sees the
  # traverser at all. Without the narrowing these raised where the reference answers.
  Scenario: g_V_mathX_plus_1X_byXvaluesXageX_isXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().math("_ + 1").by(__.values("age").is(P.gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[33.0].d |
      | d[36.0].d |

  Scenario: g_V_asXaX_mathXa_plus_1X_byXvaluesXageX_isXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").math("a + 1").by(__.values("age").is(P.gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[33.0].d |
      | d[36.0].d |

  Scenario: g_V_projectXxX_byXmathX_plus_1X_byXvaluesXageX_isXgtX30XXXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.math("_ + 1").by(__.values("age").is(P.gt(30))))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{"x":"d[33.0].d"}] |
      | m[{"x":"d[36.0].d"}] |

  Scenario: g_V_projectXaX_byXvaluesXnameX_isXeqXmarkoXX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V().project("a").by(__.values("name").is(P.eq("marko")).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko"}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |
      | m[{}] |

  Scenario: g_V_mapXvaluesXnameX_isXeqXmarkoXX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.values("name").is(P.eq("marko")).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |

  Scenario: g_V_whereXvaluesXnameX_isXeqXmarkoXX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.values("name").is(P.eq("marko")).asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |

  Scenario: g_V_coalesceXvaluesXnameX_isXeqXmarkoXX_toUpper_constantXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.values("name").is(P.eq("marko")).toUpper(), __.constant("x"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | MARKO |
      | x |
      | x |
      | x |
      | x |
      | x |

  Scenario: g_V_chooseXvaluesXnameX_isXeqXmarkoXX_asString_constantXyX_constantXnXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.values("name").is(P.eq("marko")).asString(), __.constant("y"), __.constant("n"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | y |
      | n |
      | n |
      | n |
      | n |
      | n |

  # An ABSENT property mid-body is unproductive too: the math() over it filters, it does not raise.
  Scenario: g_V_projectXxX_byXvaluesXageX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.values("age").math("_ + 1"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"d[30.0].d"}] |
      | m[{"x":"d[28.0].d"}] |
      | m[{}] |
      | m[{"x":"d[33.0].d"}] |
      | m[{}] |
      | m[{"x":"d[36.0].d"}] |

  # A math() mid-body whose by() is unproductive FILTERS (MathStep.java:75-78), so the asString() after
  # it never sees a null.
  Scenario: g_V_asXaX_mapXconstantX1X_mathXa_plus_1X_byXageX_asStringX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").map(__.constant(1).math("a + 1").by("age").asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 30.0 |
      | 28.0 |
      | 33.0 |
      | 36.0 |

  Scenario: g_V_projectXxX_byXmathX_plus_1X_byXageX_asStringXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("x").by(__.math("_ + 1").by("age").asString())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"30.0"}] |
      | m[{"x":"28.0"}] |
      | m[{}] |
      | m[{"x":"33.0"}] |
      | m[{}] |
      | m[{"x":"36.0"}] |

  # The raise is EAGER past a limit(): the reference pulls the next traverser through toUpper() to learn
  # the limit is met (RangeGlobalStep.filter only stops on the pull AFTER the high-th), and marko's age
  # is that traverser, so it raises too.
  Scenario: g_V_unionXvaluesXnameX_valuesXageXX_toUpper_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("name"), __.values("age")).toUpper().limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A concat() TRAVERSAL operand must yield a String too: ConcatStep.java:87-92 assigns its result to a
  # String, so an Integer is a ClassCastException there, where concat_ws answered "a29". The per-row
  # check raises a run-time deferral, not the JVM's cast message, so this stays @Unsupported.
  @Unsupported
  Scenario: g_injectXaX_concatXV_valuesXageXX
    Given the modern graph
    And the traversal of
      """
      g.inject("a").concat(__.V().values("age"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "cannot be cast"

  Scenario: g_injectXaX_concatXV_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.inject("a").concat(__.V().values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | amarko |

  # An UNBOUND scope key is a productive null to math(): MathStep resolves a variable through
  # getNullableScopeValue (Scoping.java:155-161), so the software vertices' missing "a" raises.
  Scenario: g_V_projectXaX_byXvaluesXageXX_mathXa_plus_1X
    Given the modern graph
    And the traversal of
      """
      g.V().project("a").by(__.values("age")).math("a + 1")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The variable a for math() step must resolve to a Number"
