Feature: mogwai addendum — a child-taking host as a scoped-relation CONNECTOR

  # The scoped-relation connector (`src/compiler/rel/lower/scoped.ts`, docs/2026-11-15-compositional-coverage-plan.md
  # Phase 2): a host scopes its input by a row number, lowers its body as the root lowers a chain, decorrelates it
  # against the scope (`src/rel/decorrelate.ts`) and reconnects on the key by its policy. Each scenario here is a
  # shape the ladder of correlated routes did not answer; together they pin the four connector rows the spike
  # built — `where`/`filter` (semi-join), `not` (anti-join), `map` (first per scope, inner join) and
  # `project().by` (first per scope, LEFT join) — over element and value hosts, and the path a body reads.

  # map(b) keeps a traverser exactly where its body is productive, with the body's FIRST result
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/TraversalMapStep.java:49-53).
  # A filter body's one result is the traverser itself.
  Scenario: g_V_mapXhasXageXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.has("age")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |

  # A key is put only where its by() is productive, with the by()'s first value
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/ProjectStep.java:64-67).
  # Only vadas and josh are known by someone, and each by exactly one person.
  Scenario: g_V_projectXn_mX_byXnameX_byXinXknowsX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("n","m").by("name").by(__.in("knows").values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"n":"marko"}] |
      | m[{"n":"vadas","m":"marko"}] |
      | m[{"n":"lop"}] |
      | m[{"n":"josh","m":"marko"}] |
      | m[{"n":"ripple"}] |
      | m[{"n":"peter"}] |

  # A child traversal starts from a split of the traverser, path and all
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/traverser/B_LP_O_S_SE_SL_Traverser.java:75-79),
  # so a path read in a where() body reads the HOST's path: one element long here, always simple.
  Scenario: g_V_whereXsimplePathX_count
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.simplePath()).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # ...and extended by the body's own hops: from marko, out() reaches lop, vadas and josh, and in() from each
  # comes back to marko — a repeat — except lop, which josh and peter also created.
  Scenario: g_V_hasXname_markoX_out_whereXin_simplePathX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").out().where(__.in().simplePath()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |

  # A LIST host: the body over the folded list is the root's own fold re-entry, keyed by the scope.
  Scenario: g_V_valuesXageX_fold_whereXcountXlocalX_isXgtX1XX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold().where(__.count(Scope.local).is(P.gt(1))).count(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |

  # map() over a list host, with a reducing body: SumGlobalStep over the unfolded members, per traverser.
  Scenario: g_V_valuesXageX_fold_mapXunfold_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold().map(__.unfold().sum())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[123].i |

  # A MAP host: valueMap() rows filtered by a body that reads the row's own entry.
  Scenario: g_V_valueMapXnameX_whereXselectXnameX_unfold_isXjoshXX
    Given the modern graph
    And the traversal of
      """
      g.V().valueMap("name").where(__.select("name").unfold().is("josh"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"name":["josh"]}] |

  # NotStep keeps a traverser iff its body has no result
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/NotStep.java),
  # here a nested where(): marko is the only vertex with an out-neighbour someone knows.
  Scenario: g_V_notXout_whereXinXknowsXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().not(__.out().where(__.in("knows"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |

  # Three filters deep: marko → josh → lop/ripple, and only those are software with lang java.
  Scenario: g_V_whereXout_whereXout_whereXhasXlang_javaXXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out().where(__.out().where(__.has("lang","java")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
