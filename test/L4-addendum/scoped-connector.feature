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

  # ---- coalesce / optional: PRIORITY per scope (the host anti-joined on each earlier arm's key) ----

  # CoalesceStep is a FlatMapStep: a result's path is the PRE-child path extended by exactly the emitted value
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52),
  # so an identity() arm appends the element a second time.
  Scenario: g_V_hasXname_vadasX_coalesceXout_identityX_path
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","vadas").coalesce(__.out(), __.identity()).path()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[vadas],v[vadas]] |

  # ...and the arm's own hops are hidden: marko → josh → lop/ripple is [marko, lop], [marko, ripple].
  Scenario: g_V_hasXname_markoX_coalesceXout_out_identityX_path
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").coalesce(__.out().out(), __.identity()).path()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[v[marko],v[lop]] |
      | p[v[marko],v[ripple]] |

  # head.split re-derives the traverser from the pre-child head
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52),
  # so a label bound in a coalesce arm does not escape it.
  Scenario: g_V_hasXname_markoX_coalesceXoutXknowsX_asXxX_identityX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").coalesce(__.out("knows").as("x"), __.identity()).select("x")
      """
    When iterated to list
    Then the result should be empty

  # CoalesceStep resets each arm per traverser (CoalesceStep.java:52-62): a REDUCING arm reduces one
  # traverser's sub-stream, and an unseeded sum() over an empty one emits nothing, so the next arm answers.
  Scenario: g_V_coalesceXout_valuesXageX_sum_constantXneg1XX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().values("age").sum(), __.constant(-1))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[59].i |
      | d[-1].i |
      | d[-1].i |
      | d[-1].i |
      | d[-1].i |
      | d[-1].i |

  # A dedup() in an arm sees ONE traverser, so it keeps it: six vertices, six results.
  Scenario: g_V_coalesceXdedup_identityX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.dedup(), __.identity()).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # The merge order a consumer reads is host position, then arm, then the result's own position in its arm.
  Scenario: g_V_hasXname_joshX_coalesceXout_orderXbyXname_descX_valuesXnameX_constantXxXX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","josh").coalesce(__.out().order().by("name", Order.desc).values("name"), __.constant("x")).fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[ripple,lop] |

  # OptionalStep forwards its child's traverser, or the traverser itself where the child has none
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/OptionalStep.java:47-57).
  # out() is six traversers; a dedup() in the body sees one of them at a time.
  Scenario: g_V_out_optionalXdedupX_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().optional(__.dedup()).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # ...nested: the inner optional's own identity arm and the outer one's meet on one multiplicity.
  Scenario: g_V_out_optionalXoptionalXdedupXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().optional(__.optional(__.dedup())).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # A reducing body over one value is that value: MinGlobalStep over a single start.
  Scenario: g_V_valuesXageX_optionalXminX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").optional(__.min())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[29].i |
      | d[27].i |
      | d[32].i |
      | d[35].i |

  # The body reads the HOST's path (a one-element path is always simple), so every vertex is its own result.
  Scenario: g_V_optionalXsimplePathX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.simplePath()).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # ---- by() values as JOIN COLUMNS: order().by / dedup().by / groupCount().by / group().by key ----

  # DedupGlobalStep keeps a traverser whose by() product it has not seen, and drops one whose by() is unproductive
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/DedupGlobalStep.java:77-78).
  # Only vadas and josh are known by someone, both by marko: one survivor.
  Scenario: g_V_dedupXbyXinXknowsXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().dedup().by(__.in("knows")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |

  # A LIST key is equal by its contents: marko, josh and peter reach distinct lists, the three leaves all [].
  Scenario: g_V_dedupXbyXout_foldXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().dedup().by(__.out().fold()).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |

  # A MAP key: no person has a lang, so every person's groupCount() is the same empty map.
  Scenario: g_V_hasLabelXpersonX_dedupXbyXgroupCount_byXlangXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").dedup().by(__.groupCount().by("lang")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].l |

  # A reducing by() over a value traverser: min() of one value is that value.
  Scenario: g_V_valuesXageX_orderXbyXminXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().by(__.min())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[27].i |
      | d[29].i |
      | d[32].i |
      | d[35].i |

  # GroupCountStep keys each traverser by its by() product (TraversalUtil.produce) and skips an unproductive one.
  Scenario: g_V_groupCountXbyXinXknowsX_valuesXnameXXX
    Given the modern graph
    And the traversal of
      """
      g.V().groupCount().by(__.in("knows").values("name"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"marko":"d[2].l"}] |

  # ---- group().by(k).by(b): the VALUE body pooled PER KEY ----

  # Grouping pools every traverser of a key into the value traversal's first barrier and reduces it once
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Grouping.java:74-125):
  # the persons' out() pool is six traversers, the software's is empty and count() seeds 0.
  Scenario: g_V_groupXbyXlabelX_byXout_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.out().count())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"person":"d[6].l","software":"d[0].l"}] |

  # ...a count() then a fold() after the barrier: the rest of the value traversal runs over the reduced value.
  Scenario: g_V_groupXbyXlabelX_byXcount_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.count().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"person":"l[d[4].l]","software":"l[d[2].l]"}] |

  # An UNSEEDED barrier over an empty pool emits nothing, so the key is absent (GroupStep.projectTraverser's
  # hasNextBarrier is false): software has no age.
  Scenario: g_V_groupXbyXlabelX_byXvaluesXageX_sumXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.values("age").sum())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"person":"d[123].i"}] |

  # A child KEY and a pooled value together: the key is landed per traverser, the value pooled per key.
  Scenario: g_V_groupXbyXout_countX_byXvaluesXnameX_order_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(__.out().count()).by(__.values("name").order().fold())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"d[0].l":"l[lop,ripple,vadas]","d[1].l":"l[peter]","d[2].l":"l[josh]","d[3].l":"l[marko]"}] |

  # ---- or / flatMap / local ----

  # OrStep keeps a traverser iff ANY child has a next
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/OrStep.java):
  # a one-element path is always simple, so every vertex passes.
  Scenario: g_V_orXsimplePath_outXknowsXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().or(__.simplePath(), __.out("knows")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |

  # A value host: the filter body over each name.
  Scenario: g_V_valuesXnameX_localXorXisXmarkoX_isXjoshXXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").local(__.or(__.is("marko"), __.is("josh")))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |

  # FlatMapStep emits every result of its body per traverser
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/FlatMapStep.java:42-52).
  Scenario: g_V_valuesXageX_flatMapXisXgtX30XXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").flatMap(__.is(P.gt(30)))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[32].i |
      | d[35].i |

  # LocalStep runs its body per traverser (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88):
  # a dedup() and a count() there scope to ONE person's out() — 3, 0, 2, 1.
  Scenario: g_V_hasLabelXpersonX_localXout_dedup_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.out().dedup().count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[2].l |
      | d[1].l |

  # A LIST host: the body over the one folded list.
  Scenario: g_V_out_fold_localXunfold_dedup_countX
    Given the modern graph
    And the traversal of
      """
      g.V().out().fold().local(__.unfold().dedup().count())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |

  # ---- choose: the CONDITION is a scoped local child; the options stay global ----

  # ChooseStep routes each traverser on whether its condition produced
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/ChooseStep.java):
  # only marko knows someone.
  Scenario: g_V_chooseXoutXknowsX_valuesXnameX_constantXnoneXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.out("knows"), __.values("name"), __.constant("none"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | none |
      | none |
      | none |
      | none |
      | none |

  # A reducing condition body, per traverser: marko and josh have more than one out().
  Scenario: g_V_chooseXlocalXout_count_isXgtX1XXX_constantXhubX_constantXleafXX_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.local(__.out().count().is(P.gt(1))), __.constant("hub"), __.constant("leaf")).groupCount()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"hub":"d[2].l","leaf":"d[4].l"}] |

  # The OPTIONS are global children (BranchStep.java:123-153): out().count() reduces every traverser routed to
  # the true option at once — marko's 3 and josh's 2 are one count of 5.
  Scenario: g_V_chooseXout_count_isXgtX1XX_out_count_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.out().count().is(P.gt(1)), __.out().count(), __.values("name"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].l |
      | vadas |
      | lop |
      | ripple |
      | peter |
