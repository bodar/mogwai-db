Feature: mogwai addendum — a where(P) operand is a SCOPE KEY, never a literal value

  # `WherePredicateStep` does not compare the traverser against its predicate's operands. Every
  # non-traversal leaf of the `P` is a SELECT KEY (`configurePredicates`/`getSelectKey`), resolved per
  # traverser through `Scoping.getSafeScopeValue`: the traverser's own Map, then the SIDE EFFECTS, then
  # the PATH labels, else IllegalArgumentException "Neither the map, sideEffects, nor path has a …-key"
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/WherePredicateStep.java,
  # …/traversal/step/Scoping.java:119-135,193). A NON-String key is refused when the step is CONSTRUCTED.
  #
  # The lowering compiled such an operand as a literal — `where(gt('a'))` as `is(gt('a'))` — which
  # answered every name; `withSideEffect('a','josh')…where(eq('a'))` answered []. The compile now raises
  # the construction refusal, and DECLINES a key it cannot resolve the reference's way (a side effect, or
  # a key no `as()` binds) — once, before lowering, at every depth (`unresolvableWhereKey`,
  # src/compiler/ir/labels.ts). Each @Unsupported scenario carries the REFERENCE answer.

  @Unsupported
  Scenario: g_withSideEffectXa_joshX_V_name_whereXeqXaXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "josh").V().values("name").where(P.eq("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  @Unsupported
  Scenario: g_withSideEffectXa_30X_V_age_whereXgtXaXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", 30).V().values("age").where(P.gt("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  @Unsupported
  Scenario: g_withSideEffectXa_nX_V_name_whereXgtXaX_andXneqXaXXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "n").V().values("name").where(P.gt("a").and(P.neq("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | ripple |
      | peter |

  @Unsupported
  Scenario: g_withSideEffectXa_joshX_V_name_unionXwhereXeqXaXXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "josh").V().values("name").union(__.where(P.eq("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  @Unsupported
  Scenario: g_withSideEffectXa_joshX_V_name_localXwhereXeqXaXXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "josh").V().values("name").local(__.where(P.eq("a")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  @Unsupported
  Scenario: g_V_aggregateXxX_out_whereXwithinXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().aggregate("x").out().where(P.within("x")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  # A key that is ALSO a path label still reads the SIDE EFFECT — the side effect wins.
  @Unsupported
  Scenario: g_withSideEffectXa_joshX_V_asXaX_name_whereXeqXaXX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", "josh").V().as("a").values("name").where(P.eq("a"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  # No side effect and no label: the reference reads no Map entry either, and throws.
  @Unsupported
  Scenario: g_V_name_whereXgtXaXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").where(P.gt("a"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Neither the map, sideEffects, nor path has a a-key"

  @Unsupported
  Scenario: g_V_name_whereXeqXjoshXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").where(P.eq("josh"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Neither the map, sideEffects, nor path has a josh-key"

  # A label bound only AFTER the where() is not on the path when it is read.
  @Unsupported
  Scenario: g_V_out_whereXneqXaXX_asXaX_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().where(P.neq("a")).as("a").count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Neither the map, sideEffects, nor path has a a-key"

  @Unsupported
  Scenario: g_V_name_chooseXwhereXeqXaXX_constantX1X_constantX2XX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").choose(__.where(P.eq("a")), __.constant(1), __.constant(2))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Neither the map, sideEffects, nor path has a a-key"

  # A NON-String key is refused at construction (`getSelectKey`), at any depth.
  Scenario: g_V_age_whereXgtX30XX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").where(P.gt(30))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "where(P) requires a String scope key but encountered Integer; use is(P) to compare values"

  Scenario: g_V_age_unionXwhereXwithinX27_29XXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").union(__.where(P.within(27, 29)))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "where(P) requires a String scope key but encountered Integer; use is(P) to compare values"

  Scenario: g_V_age_localXwhereXeqX1LXXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").local(__.where(P.eq(1L)))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "where(P) requires a String scope key but encountered Long; use is(P) to compare values"

  Scenario: g_V_name_whereXeqXaX_orXeqXnullXXX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").values("name").where(P.eq("a").or(P.eq(null)))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "where(P) requires a String scope key but encountered null; use is(P) to compare values"

  # A TRAVERSAL leaf is not a key: it resolves per traverser (`P.resolve`), exactly as is(P) does.
  Scenario: g_V_name_whereXneqXconstantXmarkoXXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").where(P.neq(__.constant("marko")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |

  # A key that IS a live path label keeps the alias compare.
  Scenario: g_V_asXaX_out_whereXneqXaXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().where(P.neq("a")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
