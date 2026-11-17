Feature: mogwai addendum — an unbounded repeat()'s until/emit condition may lead with ANY step

  # An unbounded repeat() is one recursive CTE, and its until()/emit() condition is a predicate over the
  # walk's row. A condition led by a movement or a filter always lowered; one led by coalesce/local/union/
  # choose/optional/map declined. It now lowers as the existence connector's CORRELATED body over the walk
  # row — a nested SELECT, where SQLite admits the aggregates, windows, ORDER and LIMIT the recursive term
  # itself refuses (`src/rel/recursive.ts` P2). `RepeatStep` tests the condition per traverser
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/RepeatStep.java`
  # `doUntil`/`doEmit` → `TraversalUtil.test`), which is exactly an EXISTS per walk row.
  #
  # Modern graph: marko -> vadas, lop, josh; josh -> ripple, lop; peter -> lop. Walk rows after the first
  # step: vadas, lop, josh (from marko); ripple, lop (from josh, both starts); lop (from peter).
  @gap:repeat-condition-any-head

  # coalesce(out(), constant(1)) always produces, so the emit is every row past depth 0 — emit()'s count.
  Scenario: g_V_repeatXoutX_emitXcoalesceXout_constantX1XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).emit(__.coalesce(__.out(), __.constant(1))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8].l |

  # Only josh has an out-neighbour among the rows the walk reaches past depth 0.
  Scenario: g_V_repeatXoutX_emitXlocalXout_limitX1XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).emit(__.local(__.out().limit(1))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  # union(knows-out, created-in).count() > 1 holds of lop (three creators); marko is never re-tested.
  Scenario: g_V_repeatXoutX_untilXunionXoutXknowsX_inXcreatedXX_count_isXgtX1XXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.union(__.out("knows"), __.in("created")).count().is(P.gt(1))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |
      | lop |

  # The exit holds of ripple (has the name) — nothing reached past depth 0 knows anyone.
  Scenario: g_V_repeatXoutX_untilXcoalesceXoutXknowsX_hasXname_rippleXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.coalesce(__.out("knows"), __.has("name", "ripple"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | ripple |
      | ripple |

  # NEGATED: exit where the row has no out-neighbour and is not vadas — lop and ripple; vadas dies unemitted.
  Scenario: g_V_repeatXoutX_untilXnotXcoalesceXout_hasXname_vadasXXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.not(__.coalesce(__.out(), __.has("name", "vadas")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |
      | lop |
      | ripple |
      | ripple |

  # A per-row LIMIT inside the condition is a plain LIMIT in the nested SELECT (a one-row scope has one key),
  # so it stops at the first in-neighbour — O(1) per walk row even where many rows reach one hub. Which
  # in-neighbour is first is unordered, so the scenario asks only the one the filter makes order-free: every
  # walk row past depth 0 has a person in-neighbour, so all 8 are emitted.
  Scenario: g_V_repeatXoutX_emitXlocalXin_limitX1XX_hasLabelXpersonXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).emit(__.local(__.in().limit(1)).hasLabel("person")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[8].l |

  # count().is(P) in a walk condition counts only as far as P can tell (`CountStrategy`'s range insertion):
  # between(1,3) needs no more than 3 rows. vadas, josh and ripple (twice) have one creator-or-knower; lop three.
  Scenario: g_V_repeatXoutX_emitXin_count_isXbetweenX1_3XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).emit(__.in().count().is(P.between(1, 3))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  # A per-row ORDER inside the condition reads the WHOLE neighbourhood per walk row — a hub's degree for every
  # frontier row reaching it, quadratic in the walk. The linear form evaluates the condition once per DISTINCT
  # element, which a recursive term cannot hold (no aggregate, no keyed join) — so it declines rather than
  # landing a quadratic route.
  @Unsupported
  Scenario: g_V_repeatXoutX_untilXlocalXout_order_byXname_descX_limitX1X_hasXname_rippleXXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.local(__.out().order().by("name", Order.desc).limit(1).has("name", "ripple"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | josh |

  # optional(out('knows')) is the row itself where it knows no one: the exit holds of vadas.
  Scenario: g_V_repeatXoutX_untilXoptionalXoutXknowsXX_hasXname_vadasXX_name
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.optional(__.out("knows")).has("name", "vadas")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  # The condition composes inside a host: a walk under where() under local().
  Scenario: g_V_whereXrepeatXoutX_emitXlocalXout_limitX1XXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.repeat(__.out()).emit(__.local(__.out().limit(1)))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # A condition that DRAWS cannot stay correlated (one shared pick), and a recursive term cannot take the
  # keyed form — the recorded limit, a clean refusal.
  @Unsupported
  Scenario: g_V_repeatXoutX_untilXcoalesceXout_sampleX1X_constantX1XXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().repeat(__.out()).until(__.coalesce(__.out().sample(1), __.constant(1))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
