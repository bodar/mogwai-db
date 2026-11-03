Feature: mogwai addendum — a child body whose HEAD is a reducer reduces the host's ONE traverser

  # A per-traverser child (`local`/`map`/`by()`/`where`) begins from the host traverser itself at bulk 1
  # (`TraversalUtil.apply`, vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/TraversalUtil.java:185-192),
  # so a body that does not start by MOVING reduces exactly that one traverser — `count()` is 1
  # (Local.feature g_V_in_barrier_localXcountX), `fold()` is `[v]`, a numeric reducer is the value. The
  # SAME as `identity().count()`, which answered while `count()` declined; and the same over a SCALAR host
  # (a value stream) as over an element. One seed route (`hostSelfRow`), every head.

  Scenario: g_V_localXcountX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  Scenario: g_V_mapXfoldX_unfold_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").map(__.fold()).unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # ---- a SCALAR host: the traverser IS the value, and the reducer folds that one value ----

  Scenario: g_V_valuesXageX_localXfoldX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").local(__.fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[29].i] |
      | l[d[27].i] |
      | l[d[32].i] |
      | l[d[35].i] |

  Scenario: g_V_valuesXageX_localXsumX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").local(__.sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  Scenario: g_V_valuesXnameX_localXcountX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").local(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  # ---- a transform before the reducer runs over the seed row like any body step ----

  Scenario: g_V_valuesXageX_mapXmathX_plus1X_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").map(__.math("_+1").sum())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[30].d |
      | d[28].d |
      | d[33].d |
      | d[36].d |

  # ---- the same seed at the other child positions: by(), where(), after select() ----

  Scenario: g_V_valuesXageX_projectXs_fX_byXsumX_byXfoldX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").is(P.gt(30)).project("s","f").by(__.sum()).by(__.fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"s":"d[32].i","f":"l[d[32].i]"}] |
      | m[{"s":"d[35].i","f":"l[d[35].i]"}] |

  Scenario: g_V_valuesXageX_whereXsum_isXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").where(__.sum().is(P.gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  Scenario: g_V_asXaX_out_selectXaX_localXcountX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().select("a").local(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  # ---- not yet: min/max over a SCALAR seed. The correlated argmax re-inlines its value in an ORDER BY,
  # where SQLite resolves no outer column, so a value read straight off the host declines cleanly
  # (`valueColIsDetached`) rather than fail at run time. ----

  @gap:scalar-seed-argmax
  @Unsupported
  Scenario: g_V_valuesXageX_localXmaxX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").local(__.max())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |
