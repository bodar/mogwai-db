Feature: mogwai addendum — a merge downstream of a host that emits a sorted order

  # A host whose body sorts (`hostSortsBody`/`localSortsBody`/`armHoldsSortedLocal`, src/compiler/ir/bulk.ts)
  # states an emission order the client reads even at a bare terminal. A FlatMapStep after it (values/
  # properties/unfold/out) followed by no Barrier gets LazyBarrierStrategy's NoOpBarrierStep
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java:113-127),
  # whose TraverserSet folds equal traversers into the FIRST arrival's slot
  # (.../traverser/util/TraverserSet.java:88-96). Where the exact scan cannot place that merge
  # (optional/local/union/choose forward their body's own merged traversers), the traversal declines
  # (`sortedHostMergeAt`) rather than answer the unmerged per-start order. The expectations are the
  # reference's, kept for the day the merge is reproduced.

  @Unsupported
  Scenario: g_V_optionalXout_order_byXnameXX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | vadas |
      | vadas |
      | ripple |
      | ripple |

  @Unsupported
  Scenario: g_V_optionalXout_order_byXnameXX_valuesXnameX_asXnX_selectXnX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).values("name").as("n").select("n")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | vadas |
      | vadas |
      | ripple |
      | ripple |

  @Unsupported
  Scenario: g_V_optionalXout_order_byXnameXX_unfold_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).unfold().values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | vadas |
      | vadas |
      | ripple |
      | ripple |

  @Unsupported
  Scenario: g_V_localXout_order_byXnameXX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().order().by("name")).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | vadas |
      | ripple |

  @Unsupported
  Scenario: g_V_unionXout_order_byXnameX_identityX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.out().order().by("name"), __.identity()).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | ripple |
      | ripple |
      | vadas |
      | vadas |
      | marko |
      | peter |

  @Unsupported
  Scenario: g_V_chooseXhasLabelXpersonX_out_order_byXnameX_identityX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.out().order().by("name"), __.identity()).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | ripple |
      | ripple |
      | vadas |

  @Unsupported
  Scenario: g_V_localXunionXout_order_byXnameX_identityXX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.union(__.out().order().by("name"), __.identity())).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | vadas |
      | vadas |
      | marko |
      | ripple |
      | ripple |
      | peter |

  @Unsupported
  Scenario: g_V_unionXlocalXout_order_byXnameXX_outX_valuesXnameX_isXneqXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.out().order().by("name")), __.out()).values("name").is(P.neq("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | josh |
      | lop |
      | lop |
      | lop |
      | lop |
      | lop |
      | lop |
      | vadas |
      | vadas |
      | ripple |
      | ripple |

  # An order-free reduction reads no order, so the merge is unobservable and the traversal still answers.
  Scenario: g_V_optionalXout_order_byXnameXX_valuesXnameX_isXneqXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().order().by("name")).values("name").is(P.neq("x")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  # A sorted `local()` inside a batching arm (residue 5b): `LocalStep` runs its body once per UNIT — it
  # splits a merged slot into bulk-1 traversers (.../step/branch/LocalStep.java:80-88) — so the arm emits
  # (start, body order) and the BranchStep drains it whole (.../step/branch/BranchStep.java:85-88,123-153).
  # The merge owes that order (`branchOrderOwed`, src/compiler/rel/lower.ts, via `armHoldsSortedLocal`)
  # rather than emitting the plan's — which was the GLOBAL sort, [josh,lop,lop,lop,ripple,vadas].
  Scenario: g_V_unionXlocalXout_valuesXnameX_orderXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.out().values("name").order()))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | lop |
      | ripple |
      | lop |

  Scenario: g_V_unionXlocalXout_order_byXnameXX_identityX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.out().order().by("name")), __.identity()).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | lop |
      | ripple |
      | lop |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |

  Scenario: g_V_chooseXhasLabelXpersonX_localXout_valuesXnameX_orderX_constantXxXX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.local(__.out().values("name").order()), __.constant("x"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | vadas |
      | lop |
      | ripple |
      | lop |
      | x |
      | x |

  # The arm's starts merge in its own TraverserSet first (`armStartMerge`, BranchStep.java:87-88,143-148):
  # order() leaves vadas(v2), ripple(v5), lop(v3 x3), josh(v4), and the slot of bulk 3 runs the sorted body
  # three times in a row.
  Scenario: g_V_out_order_byXname_descX_unionXlocalXin_valuesXnameX_orderXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().order().by("name", Order.desc).union(__.local(__.in().values("name").order()))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
      | josh |
      | josh |
      | marko |
      | peter |
      | josh |
      | marko |
      | peter |
      | josh |
      | marko |
      | peter |
      | marko |

  # A READER past the branch (a slice, a fold) of a sorted-local arm's order still declines: the decline-only
  # stopgap keeps it where it was before that order was owed (`armEndMerges`' `readPast`, src/compiler/ir/bulk.ts).
  @Unsupported
  Scenario: g_V_unionXlocalXout_valuesXnameX_orderXX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.out().values("name").order())).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |

  # The option's EndStep merge (`armEndMerges`, src/compiler/ir/bulk.ts) follows the arm's LAST flat-map:
  # `values()` here, so the arm's names merge at their first arrival — not reproduced, so it declines.
  @Unsupported
  Scenario: g_V_unionXlocalXout_order_byXnameXX_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.local(__.out().order().by("name")).values("name"))
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | josh |
      | lop |
      | lop |
      | lop |
      | vadas |
      | ripple |

  # The SAME question at a CHILD traversal: `LazyBarrierStrategy` runs on every child too
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/DefaultTraversal.java:144-148),
  # and a group value child is reset and run once per member traverser, its runs concatenated by the fold
  # (.../step/map/GroupStep.java:111-139). In `out().optional(sorted).values("name").is(…)` the child's `out()`
  # is its first FlatMapStep, so `values()` gets a NoOpBarrierStep and each member's two `lop`s merge at the
  # first one's slot: v1 gives `[vadas,lop,lop,ripple]`. The pooled value (`groupCollected`,
  # src/compiler/rel/map.ts) asks `placedMergeBefore` -> `sortedHostMergeAt` (src/compiler/ir/bulk.ts) and declines.
  @Unsupported
  Scenario: g_V_group_byXlabelX_byXout_optionalXout_order_byXname_descXX_valuesXnameX_isXneqXxXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.out().optional(__.out().order().by("name",Order.desc)).values("name").is(P.neq("x")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,lop,lop,ripple,lop,ripple,lop]","software":"l[]"}] |

  @Unsupported
  Scenario: g_V_groupXmX_byXlabelX_byXout_optionalXout_order_byXname_descXX_propertiesXnameX_value_foldX_capXmX
    Given the modern graph
    And the traversal of
      """
      g.V().group("m").by(T.label).by(__.out().optional(__.out().order().by("name",Order.desc)).properties("name").value().fold()).cap("m")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,lop,lop,ripple,lop,ripple,lop]","software":"l[]"}] |

  @Unsupported
  Scenario: g_V_hasXname_markoX_group_byXlabelX_byXout_optionalXout_order_byXname_descXX_valuesXnameX_asXnX_selectXnX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by(T.label).by(__.out().optional(__.out().order().by("name",Order.desc)).values("name").as("n").select("n").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,lop,lop,ripple]"}] |

  # A child with NO flat-map before `values()` (the `optional()` host is an `AbstractStep`,
  # .../step/branch/OptionalStep.java:37) takes no barrier there: `values()` is its FIRST FlatMapStep
  # (LazyBarrierStrategy.java:111-127), so nothing merges and the member's sorted order is the answer.
  Scenario: g_V_hasXname_markoX_group_byXlabelX_byXoptionalXout_order_byXname_descXX_valuesXnameX_isXneqXxXX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").group().by(T.label).by(__.optional(__.out().order().by("name",Order.desc)).values("name").is(P.neq("x")).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"l[vadas,lop,josh]"}] |
