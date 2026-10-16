Feature: mogwai addendum — fold(seed, Operator.x) is a seeded left fold at every depth

  # `fold(seed, foldFunction)` builds a `FoldStep` whose seed is the literal and whose `FoldBiOperator`
  # applies the operator and nothing else (vendor/tinkerpop/gremlin-core/.../step/map/FoldStep.java:51-101);
  # `ReducingBarrierStep.processAllStarts` draws the seed BEFORE the first start and folds every start
  # into it (.../step/util/ReducingBarrierStep.java:99-111). A non-collection seed makes it a VALUE fold
  # (`listFold` false), so each start is handed to the operator whole.
  #
  # The official corpus (map/Fold.feature:53-84) pins three scenarios, each a ROOT fold over a non-empty
  # stream: `fold(0, Operator.sum)` over the modern ages and `fold([:], Operator.addAll)` over two and
  # three injected maps. What it never asks:
  #
  #   * an EMPTY input — the answer is the seed, not nothing (the seeded-barrier rule `count()` follows);
  #   * the operators' own arithmetic — `mult`, integer `div`, a real seed promoting an integer stream;
  #   * a non-numeric `min` (a `Comparable`, so strings fold too);
  #   * the fold PER TRAVERSER — under `project().by()`, `local()`, `coalesce()` — where every host whose
  #     sub-stream is empty still answers the seed;
  #   * a `union()` arm, whose barrier reduces over the WHOLE input (`BranchStep`), not per traverser;
  #   * a NON-EMPTY map seed: `putAll` keeps the LAST value put for a key at the FIRST key's position
  #     (`LinkedHashMap`), and an empty stream answers the seed map;
  #   * `fold([], Operator.addAll)` — the no-argument constructor's own seed and function, so `fold()`.
  #
  # @gap:seeded-fold marks the family for a possible gremlin-test PR.

  @gap:seeded-fold
  Scenario: g_V_valuesXnopeX_foldX7_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().values("nope").fold(7, Operator.sum)
      """
    # Nothing reaches the fold, so the answer is the seed the supplier provided before any start.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[7].i |

  @gap:seeded-fold
  Scenario: g_V_valuesXageX_foldX1_multX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold(1, Operator.mult)
      """
    # 29 × 27 × 32 × 35. There is no SQL aggregate for a product, which is why the fold is a walk.
    When iterated to list
    Then the result should be unordered
      | result      |
      | d[876960].i |

  @gap:seeded-fold
  Scenario: g_injectX4_2X_foldX25_divX
    Given the empty graph
    And the traversal of
      """
      g.inject(4, 2).fold(25, Operator.div)
      """
    # Integer operands divide as integers (`NumberHelper.div` in the highest common class): 25/4 = 6,
    # then 6/2 = 3 — not 3.125.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  @gap:seeded-fold
  Scenario: g_V_valuesXageX_foldX0_5d_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold(0.5d, Operator.sum)
      """
    # A double seed promotes every later sum to a double.
    When iterated to list
    Then the result should be unordered
      | result     |
      | d[123.5].d |

  @gap:seeded-fold
  Scenario: g_V_valuesXnameX_foldXzz_minX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold("zz", Operator.min)
      """
    # `Operator.min` takes a `Comparable`, so a string seed folds a string stream.
    When iterated to list
    Then the result should be unordered
      | result |
      | josh   |

  @gap:seeded-fold
  Scenario: g_V_hasLabelXpersonX_projectXn_sX_byXnameX_byXout_valuesXageX_foldX0_sumXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").project("n","s").by("name").by(__.out().values("age").fold(0, Operator.sum))
      """
    # Per traverser. Only marko reaches an aged vertex (vadas 27, josh 32); josh and peter reach only
    # software and vadas reaches nothing — each still answers the seed, so every row keeps its `s`.
    When iterated to list
    Then the result should be unordered
      | result                          |
      | m[{"n":"marko","s":"d[59].i"}]  |
      | m[{"n":"vadas","s":"d[0].i"}]   |
      | m[{"n":"josh","s":"d[0].i"}]    |
      | m[{"n":"peter","s":"d[0].i"}]   |

  @gap:seeded-fold
  Scenario: g_V_localXout_valuesXageX_foldX0_maxXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out().values("age").fold(0, Operator.max))
      """
    When iterated to list
    Then the result should be unordered
      | result  |
      | d[32].i |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |

  @gap:seeded-fold
  Scenario: g_V_coalesceXout_valuesXageX_foldX0_sumX__constantXnoneXX
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().values("age").fold(0, Operator.sum), __.constant("none"))
      """
    # A seeded fold ALWAYS fires, so it exhausts the coalesce and the constant is a dead fallback.
    When iterated to list
    Then the result should be unordered
      | result  |
      | d[59].i |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |
      | d[0].i  |

  @gap:seeded-fold
  Scenario: g_V_unionXvaluesXageX_foldX0_sumX__valuesXageX_foldX0_maxXX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("age").fold(0, Operator.sum), __.values("age").fold(0, Operator.max))
      """
    # `UnionStep extends BranchStep`, which hands a barrier arm EVERY start at once
    # (.../step/branch/BranchStep.java:87,143), so each arm folds the whole stream exactly once.
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[123].i |
      | d[35].i  |

  @gap:seeded-fold
  Scenario: g_injectXa1_b2_b4X_foldXb9_c3_addAllX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a":1], ["b":2], ["b":4]).fold(["b":9,"c":3], Operator.addAll)
      """
    # `putAll` into the seed: `b` keeps the LAST value put (4), `c` survives from the seed untouched.
    When iterated to list
    Then the result should be unordered
      | result                                          |
      | m[{"b":"d[4].i","c":"d[3].i","a":"d[1].i"}]     |

  @gap:seeded-fold
  Scenario: g_injectXa1X_limitX0X_foldXz0_addAllX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a":1]).limit(0).fold(["z":0], Operator.addAll)
      """
    When iterated to list
    Then the result should be unordered
      | result             |
      | m[{"z":"d[0].i"}]  |

  @gap:seeded-fold
  Scenario: g_injectXa1_b2_b4X_foldXm_addAllX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a":1], ["b":2], ["b":4]).fold([:], Operator.addAll).select("b")
      """
    # The merged map is an ordinary map traverser, so the map tail continues past it.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].i |

  @gap:seeded-fold
  Scenario: g_V_valuesXageX_order_foldXlist_addAllX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").order().fold([], Operator.addAll)
      """
    # The no-argument `FoldStep` constructor IS `(ArrayListSupplier, Operator.addAll)`
    # (.../step/map/FoldStep.java:46-48), so this is `fold()`.
    When iterated to list
    Then the result should be unordered
      | result                             |
      | l[d[27].i,d[29].i,d[32].i,d[35].i] |

  @Unsupported
  Scenario: g_V_groupXlabelX_byXvaluesXageX_foldX0_sumXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(label).by(__.values("age").fold(0, Operator.sum))
      """
    # A group's value traversal POOLS its key's members into ONE barrier (`GroupStep`'s reducing value
    # traversal), so `software` — no ages — answers the seed. Neither pooled group arm reduces to a
    # seeded value yet, and folding each member alone would be a plausible wrong map, so it declines.
    When iterated to list
    Then the result should be unordered
      | result                                       |
      | m[{"person":"d[123].i","software":"d[0].i"}] |

  @Unsupported
  Scenario: g_V_groupXlabelX_byXvaluesXageX_foldX0_sumX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(label).by(__.values("age").fold(0, Operator.sum).fold())
      """
    # `Grouping.determineBarrierStep` pools at the FIRST non-local Barrier — the seeded fold, not the
    # trailing `fold()` — and `doFinalReduction` runs `fold()` over the pooled value
    # (vendor/tinkerpop/gremlin-core/.../step/Grouping.java:74-125). Reducing each member alone and
    # collecting would answer `person:[35]`; no pooled arm cuts the body at a non-terminal barrier yet.
    When iterated to list
    Then the result should be unordered
      | result                                             |
      | m[{"person":"l[d[123].i]","software":"l[d[0].i]"}] |

  @gap:seeded-fold
  Scenario: g_injectXbig_1X_foldX0L_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 1L).fold(0L, Operator.sum)
      """
    # A long past 2^53 rides as exact decimal text, and must still be a `Number` to `Operator.sum` —
    # the sum stays exact and leaves as a long, as `sum()` does.
    When iterated to list
    Then the result should be unordered
      | result                |
      | d[9007199254740994].l |

  @gap:seeded-fold
  Scenario: g_injectXbig_1X_foldX0_maxX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 1L).fold(0, Operator.max)
      """
    # The text-carried long compares as a NUMBER, not as a string, and frames as the long it is.
    When iterated to list
    Then the result should be unordered
      | result                |
      | d[9007199254740993].l |

  @gap:seeded-fold
  Scenario: g_withSideEffectXa_0L_sumX_injectXbig_1X_aggregateXaX_capXaX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("a", 0L, Operator.sum).inject(9007199254740993L, 1L).aggregate("a").cap("a")
      """
    # The side-effect reduction is the same left fold, so it is exact past 2^53 for the same reason.
    When iterated to list
    Then the result should be unordered
      | result                |
      | d[9007199254740994].l |

  @gap:seeded-fold
  Scenario: g_injectXtrue_falseX_foldXtrue_andX
    Given the empty graph
    And the traversal of
      """
      g.inject(true, false).fold(true, Operator.and)
      """
    # `Operator.and` is `(boolean) a && (boolean) b` (Operator.java). An injected boolean is declared
    # BOOLEAN on the type channel, so the fold can tell it from the integer it is stored as.
    When iterated to list
    Then the result should be unordered
      | result |
      | false  |

  @gap:seeded-fold
  Scenario: g_injectXfalse_trueX_foldXfalse_orX
    Given the empty graph
    And the traversal of
      """
      g.inject(false, true).fold(false, Operator.or)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | true   |

  @gap:seeded-fold
  Scenario: g_withSideEffectXa_true_andX_injectXtrue_falseX_aggregateXaX_capXaX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("a", true, Operator.and).inject(true, false).aggregate("a").cap("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | false  |

  @gap:seeded-fold
  Scenario: g_V_label_foldXz_minX
    Given the modern graph
    And the traversal of
      """
      g.V().label().fold("z", Operator.min)
      """
    # A string seed over a stream statically of strings compares by `compareTo`.
    When iterated to list
    Then the result should be unordered
      | result |
      | person |

  # ---- BULK. A non-list fold applies its operator ONCE per traverser whatever its bulk
  # (FoldStep.projectTraverser, .../step/map/FoldStep.java:58-68), and the default LazyBarrierStrategy
  # merges equal traversers after every flat-map but the first (.../strategy/optimization/
  # LazyBarrierStrategy.java:105-127), as does a start step's TraverserSet
  # (.../step/util/ExpandableStepIterator.java:61-63). So a bulk-SENSITIVE operator over a stream the
  # reference may have bulked has an answer the rows cannot give: it declines. ----

  @Unsupported
  Scenario: g_V_both_valuesXageX_foldX0_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().both().values("age").fold(0, Operator.sum)
      """
    # A barrier lands after `both()` (the second flat-map); marko and josh arrive x3 and add once.
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[123].i |

  @Unsupported
  Scenario: g_V_both_barrier_valuesXageX_foldX0_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().both().barrier().values("age").fold(0, Operator.sum)
      """
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[123].i |

  @Unsupported
  Scenario: g_V_hasXname_markoX_projectXsX_byXboth_both_valuesXageX_foldX0_sumXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").project("s").by(__.both().both().values("age").fold(0, Operator.sum))
      """
    # The by() child is its own traversal: a barrier lands after its second `both()`, so marko x3,
    # josh and peter add once each — 29 + 32 + 35.
    When iterated to list
    Then the result should be unordered
      | result             |
      | m[{"s":"d[96].i"}] |

  @Unsupported
  Scenario: g_injectX1_1_2X_foldX0_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 1, 2).fold(0, Operator.sum)
      """
    # inject drains its arguments into ONE TraverserSet, so the two 1s arrive as one traverser of bulk 2.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].i |

  @gap:seeded-fold
  Scenario: g_V_both_valuesXageX_foldX0_maxX
    Given the modern graph
    And the traversal of
      """
      g.V().both().values("age").fold(0, Operator.max)
      """
    # max is idempotent, so where the reference bulked does not change the answer.
    When iterated to list
    Then the result should be unordered
      | result  |
      | d[35].i |

  @gap:seeded-fold
  Scenario: g_V_hasXname_markoX_projectXsX_byXboth_valuesXageX_foldX0_sumXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").project("s").by(__.both().values("age").fold(0, Operator.sum))
      """
    # One flat-map in the child before the fold: no barrier, so every traverser adds — 27 + 32.
    When iterated to list
    Then the result should be unordered
      | result             |
      | m[{"s":"d[59].i"}] |

  # ---- PATH PROCESSORS. PathRetractionStrategy, also a default strategy (.../TraversalStrategies.java:286),
  # inserts a NoOpBarrierStep after EVERY PathProcessor step (math, where, simplePath, …) whose next step
  # is not a Barrier, labels or no (.../strategy/optimization/PathRetractionStrategy.java:134-141). Its
  # keepLabels retraction can make traversers whose paths differed equal there, so they merge. ----

  @Unsupported
  Scenario: g_injectX1_2_3X_mathX_x0_plus5X_isXgtX0XX_foldX0_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 3).math("_ * 0 + 5").is(P.gt(0)).fold(0, Operator.sum)
      """
    # The barrier after math merges 5.0 x3 into one traverser, which the fold adds once.
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[5.0].d |

  @Unsupported
  Scenario: g_V_mathX5X_isXgtX0XX_foldX0_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().math("5").is(P.gt(0)).fold(0, Operator.sum)
      """
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[5.0].d |

  @Unsupported
  Scenario: g_V_asXaX_constantX1X_whereXasXaX_outX_constantX5X_foldX0_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").constant(1).where(__.as("a").out()).constant(5).fold(0, Operator.sum)
      """
    # Nothing after the where() reads 'a', so its keepLabels is empty: the three surviving traversers
    # are all `1` with a retracted path, and the barrier after where() merges them into 1 x3.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |

  @gap:seeded-fold
  Scenario: g_injectX1_2_3X_mathX_x0_plus5X_foldX0_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, 3).math("_ * 0 + 5").fold(0, Operator.sum)
      """
    # The next step after math is the fold, itself a Barrier, so no NoOpBarrierStep lands: all three add.
    When iterated to list
    Then the result should be unordered
      | result    |
      | d[15.0].d |

  @gap:seeded-fold
  Scenario: g_V_hasXageX_whereXoutX_valuesXageX_foldX0_sumX
    Given the modern graph
    And the traversal of
      """
      g.V().has("age").where(__.out()).values("age").fold(0, Operator.sum)
      """
    # A barrier does land after where(), but over three DISTINCT vertices it merges nothing — 29 + 32 + 35.
    When iterated to list
    Then the result should be unordered
      | result  |
      | d[96].i |

  # ---- ARITHMETIC EDGES. NumberHelper.mathOperationWithPromote promotes int -> long on overflow and
  # RETHROWS at 64 bits (.../util/NumberHelper.java:400-425); the long helpers throw `long overflow`
  # (:167-177) and Java's integer division throws `/ by zero`. ----

  @gap:seeded-fold
  Scenario: g_injectXmax_1X_foldX0L_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(9223372036854775807L, 1L).fold(0L, Operator.sum)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "long overflow"

  @gap:seeded-fold
  Scenario: g_injectXhalf_4X_foldX1L_multX
    Given the empty graph
    And the traversal of
      """
      g.inject(4611686018427387904L, 4L).fold(1L, Operator.mult)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "long overflow"

  @gap:seeded-fold
  Scenario: g_injectX0_5X_foldX1_divX
    Given the empty graph
    And the traversal of
      """
      g.inject(0, 5).fold(1, Operator.div)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "/ by zero"

  @gap:seeded-fold
  Scenario: g_injectXintmax_1X_foldX0_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(2147483647, 1).fold(0, Operator.sum)
      """
    # An int overflow at 32 bits is retried as a long, and the result stays a long.
    When iterated to list
    Then the result should be unordered
      | result          |
      | d[2147483648].l |

  @gap:seeded-fold
  Scenario: g_injectX1_2X_foldX0L_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2).fold(0L, Operator.sum)
      """
    # The highest common class of a long seed and int members is long, whatever the magnitude.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |

  @gap:seeded-fold
  Scenario: g_injectX1_2_5X_foldX0_minX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2.5).fold(0, Operator.min)
      """
    # min(0, 2.5) is computed in the common class, Double, so the int seed answers as 0.0.
    When iterated to list
    Then the result should be unordered
      | result   |
      | d[0.0].d |

  @Unsupported
  Scenario: g_injectX0X_foldX0_0_divX
    Given the empty graph
    And the traversal of
      """
      g.inject(0).fold(0.0, Operator.div)
      """
    # A double operand makes it floating point, which answers NaN rather than raise; SQLite has no NaN.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[NaN] |

  @gap:seeded-fold
  Scenario: g_injectX1_a_2X_foldX0_sumX
    Given the empty graph
    And the traversal of
      """
      g.inject(1, "a", 2).fold(0, Operator.sum)
      """
    # Operator.sum casts each member to Number.
    When iterated to list
    Then the traversal will raise an error with message containing text of "ClassCastException"

  @gap:seeded-fold
  Scenario: g_V_valuesXageX_foldXz_minX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold("z", Operator.min)
      """
    # "z".compareTo(29) is the reference's ClassCastException.
    When iterated to list
    Then the traversal will raise an error with message containing text of "ClassCastException"
