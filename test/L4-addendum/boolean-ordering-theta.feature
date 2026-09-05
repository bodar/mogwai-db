Feature: mogwai addendum — ordering predicates over the BOOLEAN bucket (false < true)

  # `is(P.gt(false))` over a stored boolean routes through `ordered()` (src/compiler/rel/predicate.ts).
  # That comparator split subject types only two ways — numeric vs string — so a boolean subject fell to
  # the `else` and every ORDERING op folded to false: `is(P.gt(false))` was EMPTY where TinkerPop keeps
  # the `true`s. `Compare.gt/lt/gte/lte` route through GremlinValueComparator.COMPARABILITY, whose Boolean
  # bucket compares by natural order — false < true
  # (vendor/tinkerpop/gremlin-core/.../util/GremlinValueComparator.java Type.Boolean + naturalOrder;
  # Compare.java:63-116). A stored boolean rides as 0/1, so SQLite's own compare IS that order. eq/neq
  # (value equality) were always correct; this pins the ordering ops.

  @gap:boolean-ordering-theta
  Scenario: g_V_valuesXcaptiveBornX_isXgtXfalseXX_count
    Given the zoo graph
    And the traversal of
      """
      g.V().has('captiveBorn').values('captiveBorn').is(P.gt(false)).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[5].l |

  @gap:boolean-ordering-theta
  Scenario: g_V_valuesXcaptiveBornX_isXgteXfalseXX_count
    Given the zoo graph
    And the traversal of
      """
      g.V().has('captiveBorn').values('captiveBorn').is(P.gte(false)).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[10].l |

  @gap:boolean-ordering-theta
  Scenario: g_V_valuesXcaptiveBornX_isXltXtrueXX_count
    Given the zoo graph
    And the traversal of
      """
      g.V().has('captiveBorn').values('captiveBorn').is(P.lt(true)).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[5].l |

  @gap:boolean-ordering-theta
  Scenario: g_V_valuesXcaptiveBornX_isXgtXtrueXX_count
    Given the zoo graph
    And the traversal of
      """
      g.V().has('captiveBorn').values('captiveBorn').is(P.gt(true)).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[0].l |
