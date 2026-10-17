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
