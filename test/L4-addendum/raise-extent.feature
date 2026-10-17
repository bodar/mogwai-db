Feature: mogwai addendum — a per-traverser raise belongs to the traversers the reference PULLS

  # The reference evaluates a step lazily, one traverser at a time, as the step after it pulls. A
  # FilterStep runs its body on the traverser it is handed (step/filter/FilterStep.java), and a limit()
  # stops pulling ONE traverser past its bound: RangeGlobalStep.filter throws FastNoSuchElementException on
  # the first traverser it is handed once it holds `high` (step/filter/RangeGlobalStep.java). So a raise a
  # body, a transform or a sack operator would hit on a traverser past that point is never met, and one on
  # a traverser up to and including it always is. A draining step (skip/tail/count, an order()) meets
  # every one.
  #
  # One authority decides the extent (src/compiler/rel/raise-channel.ts): the raise rides the row as data
  # to the head slice that pulls it, through any run of filters (which keep a raising row), and the slice
  # settles it over exactly the rows the reference pulled; a reducing barrier in a child body escalates it
  # into the child value's raise, which the host carries in turn. Where a raise cannot be carried exactly
  # the traversal declines.
  #
  # FilterRankingStrategy REORDERS a run of filters before any of this applies: it bubbles each filter
  # ahead of a directly preceding filter of higher rank, and order() is ranked 10 against a traversal
  # filter's 4 and has()'s 2 (strategy/optimization/FilterRankingStrategy.java getStepRank). So in
  # `g.V().order().by(T.label, Order.desc).where(<raising body>)…` the where() runs FIRST, over every
  # vertex, before the order() barrier — it meets marko whatever slice follows. Every scenario below that
  # puts a raising filter body behind order(), or a has()/where() behind a raising where(), is therefore
  # @Unsupported: the lowering declines a raising filter the strategy moves (filterRankingMoves,
  # src/compiler/rel/raise-channel.ts) rather than settle its raise in the written order. The expectations
  # are the written-order ones and stay as the record of what the extent machinery computes.

  # lop has no age, so its fold is []; ripple is the one traverser the limit pulls past lop, and it is
  # clean; marko, whose age would raise, is never pulled.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # limit(2) holds lop and ripple and then pulls marko through the where() body: it raises.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX2X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(2).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_countX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().count()).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_filterXvaluesXageX_toUpper_foldX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).filter(__.values("age").toUpper().fold()).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # not() of an always-productive body drops lop and ripple, so the limit pulls on to marko.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_notXvaluesXageX_toUpper_foldX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).not(__.values("age").toUpper().fold()).limit(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_count_isX0XX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().count().is(0)).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpperX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper()).limit(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A FILTER between the raise and the limit keeps a raising traverser: the reference raised before the
  # filter ever saw it.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_hasXnameX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).has("name").limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_hasLabelXpersonX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).hasLabel("person").limit(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_whereXvaluesXnameXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).where(__.values("name")).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # A connective evaluates an arm only where the arms before it left the answer open (AndStep stops at the
  # first failure, OrStep at the first success): marko has no lang, so and() never reaches the raising
  # arm for him, and or() does.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXandXvaluesXlangX_valuesXageX_toUpper_foldXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.and(__.values("lang"), __.values("age").toUpper().fold())).limit(3).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |
      | ripple |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXorXvaluesXlangX_valuesXageX_toUpper_foldXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.or(__.values("lang"), __.values("age").toUpper().fold())).limit(3).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXandXvaluesXageX_toUpper_fold_valuesXnameXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.and(__.values("age").toUpper().fold(), __.values("name"))).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # The transform itself, at the root: the third traverser (marko's name) is clean, the fourth (his age)
  # raises.
  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | LOP |
      | RIPPLE |

  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().limit(3)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectXa_b_1X_toUpper_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b", 1).toUpper().limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | A |

  Scenario: g_injectXa_b_1X_toUpper_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b", 1).toUpper().limit(2)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A sack operator's raise (Operator.sum's (Number) cast) belongs to the traversers the limit pulls: the
  # people come first, and only limit(4) pulls lop, whose operand is its name.
  Scenario: g_withSackX1X_V_orderXbyXlabelX_sackXsumX_byXcoalesceXvaluesXageX_valuesXnameXX_limitX1X_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().order().by(T.label).sack(Operator.sum).by(__.coalesce(__.values("age"), __.values("name"))).limit(1).sack()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[30].i |

  Scenario: g_withSackX1X_V_orderXbyXlabelX_sackXsumX_byXcoalesceXvaluesXageX_valuesXnameXX_limitX4X_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().order().by(T.label).sack(Operator.sum).by(__.coalesce(__.values("age"), __.values("name"))).limit(4).sack()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "sack(sum): an operand that is not a Number is not supported yet"

  # A DRAINING consumer meets every traverser: skip() pulls the ones it discards, tail() and count() all.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_skipX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).skip(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_tailX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).tail(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_count
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A body that MOVES: its raise is not one the reference meets on every row under the limit, so the
  # eager EXISTS form is refused there and the body's raise is escalated as data like any other — lop and
  # ripple have no out(), so their fold is []; marko's out() reaches vadas' age only under limit(2).
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXout_valuesXageX_toUpper_foldX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.out().values("age").toUpper().fold()).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXout_valuesXageX_toUpper_foldX_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.out().values("age").toUpper().fold()).limit(2).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A RUN of head slices: the outer one stops asking first, so limit(a).limit(b) pulls min(a, b) + 1
  # (with k requests a limit(a) pulls min(k, a + 1)), which is also what EarlyLimitStrategy's merge of
  # adjacent RangeGlobalSteps gives. limit(2).limit(1) pulls lop and ripple; marko is never reached.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX2X_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(2).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX5X_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(5).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_rangeX0_2X_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).range(0, 2).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX2X_rangeX0_1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(2).range(0, 1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # The composed run still pulls one past ITS bound: limit(3).limit(2) pulls three.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX3X_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(3).limit(2).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_injectXa_b_1X_toUpper_limitX2X_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b", 1).toUpper().limit(2).limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | A |

  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_limitX3X_limitX2X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().limit(3).limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | LOP |
      | RIPPLE |

  # A label is no step of the reference's: it neither stops the raise riding to the slice nor the run.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_asXaX_limitX1X_selectXaX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).as("a").limit(1).select("a").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # A FILTER between two bounded slices makes how far the inner one is pulled depend on the data (the
  # filter may drop what the outer one would have counted), so the raise cannot be settled over a fixed
  # extent: it declines (the reference answers [lop] here).
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX2X_whereXvaluesXnameXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(2).where(__.values("name")).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # A raise inside a BODY is pulled no further than its host is: optional() and choose() iterate their
  # body one start per pull (OptionalStep.processNextStart; BranchStep iterates its arms in order), so
  # under a limit after the host the person arm is never run. The raise cannot be carried out of the
  # host's body to that limit, so these decline rather than raise where the reference answers [lop].
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_optionalXwhereXvaluesXageX_toUpper_foldXX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).optional(__.where(__.values("age").toUpper().fold())).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_optionalXwhereXvaluesXageX_toUpper_countXX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).optional(__.where(__.values("age").toUpper().count())).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_chooseXhasLabelXsoftwareX_identity_whereXvaluesXageX_toUpper_foldXX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).choose(__.hasLabel("software"), __.identity(), __.where(__.values("age").toUpper().fold())).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # A slice at the END of a union() body is NOT pulled n+1 times. union() is a BranchStep:
  # BranchStep.standardAlgorithm (step/branch/BranchStep.java) addStart()s every new start into a child it
  # never resets and re-asks option.hasNext() once per start, while the body's RangeGlobalStep keeps ONE
  # counter. Once it fills, each later start drags one more upstream traverser through the body before
  # the bound throws, so what the body evaluates depends on how many starts follow. Here the start 1 is
  # pushed into the body after 'a' filled the limit, and toUpper(1) runs before the counter check: the
  # reference raises. The raise cannot be settled at the body's slice, so the traversal declines.
  @Unsupported
  Scenario: g_injectXa_b_1_cX_unionXtoUpper_limitX1XX
    Given the empty graph
    And the traversal of
      """
      g.inject("a", "b", 1, "c").union(__.toUpper().limit(1))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # marko's leftover age (29) is pulled when vadas is applied to the non-reset body: the reference raises.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_unionXvaluesXname_ageX_toUpper_limitX1XX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).union(__.values("name", "age").toUpper().limit(1))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_unionXvaluesXname_ageX_toUpper_limitX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).union(__.values("name", "age").toUpper().limit(1)).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_unionXvaluesXname_ageX_toUpper_limitX1X_constantX1XX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).union(__.values("name", "age").toUpper().limit(1), __.constant(1))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # The same through a filter body: marko is applied to the non-reset child, so the where() body runs on
  # him before the limit's counter check.
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_unionXwhereXvaluesXageX_toUpper_foldX_limitX1XX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).union(__.where(__.values("age").toUpper().fold()).limit(1)).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_optionalXvaluesXageX_toUpperX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).optional(__.values("age").toUpper()).limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  # The same at a by(): a `ProjectStep` is an always-bound MapStep, so EarlyLimitStrategy moves the limit IN
  # FRONT of it (`order().limit(1).project(…)`) — project() runs for lop alone, never on to marko.
  Scenario: g_V_orderXbyXlabel_descXX_projectXaX_byXvaluesXageX_toUpper_foldX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).project("a").by(__.values("age").toUpper().fold()).limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | m[{"a":[]}] |

  # With nothing bounded after the host, the body's raise is met on every row, at any depth.
  Scenario: g_V_optionalXwhereXvaluesXageX_toUpper_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.where(__.values("age").toUpper().fold()))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A drain after the host pulls every start through it, so a later limit changes nothing.
  Scenario: g_V_orderXbyXlabel_descXX_optionalXwhereXvaluesXageX_toUpper_foldXX_fold_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).optional(__.where(__.values("age").toUpper().fold())).fold().limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # sum(local)'s text-operand deferral raises on every traverser it reaches, whether or not a consumer
  # reads the sum: count() does not.
  Scenario: g_V_valuesXnameX_fold_sumXlocalX_count
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().sum(Scope.local).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "sum/mean over a text or non-number value is not supported"

  # SQLite has no NaN — it stores one as NULL — so a NaN the sack may fold declines rather than answer
  # for a NULL operand: the reference adds 1.0 + NaN, and NumberHelper.max returns the Integer 1.
  @Unsupported
  Scenario: g_withSackX1_0X_injectXNaNX_sackXsumX_sack
    Given the empty graph
    And the traversal of
      """
      g.withSack(1.0).inject(NaN).sack(Operator.sum).sack()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[NaN] |

  @Unsupported
  Scenario: g_withSackXNaNX_injectX1X_sackXmaxX_sack
    Given the empty graph
    And the traversal of
      """
      g.withSack(NaN).inject(1).sack(Operator.max).sack()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].i |

  # A STREAMING step that is not a filter (a dedup(), a movement) between a raise and a bounded slice
  # stops pulling where the reference does, while the raise could only be evaluated on every row: it
  # declines rather than raise where the reference answers (here [lop]: ripple is the one more pulled).
  @Unsupported
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_dedup_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).dedup().limit(1).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | lop |

  @Unsupported
  Scenario: g_withSackX1X_V_orderXbyXlabelXX_sackXsumX_byXconstantX2XX_out_limitX1X_sack
    Given the modern graph
    And the traversal of
      """
      g.withSack(1).V().order().by(T.label).sack(Operator.sum).by(__.constant(2)).out().limit(1).sack()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[3].i |

  # A slice run that starts with a SKIP: asked k times, range(lo, hi) pulls min(lo + k, hi + 1) and
  # skip(lo) pulls lo + k, so skip(1).limit(1) and range(1, 2) each pull three — LOP, RIPPLE, MARKO — and
  # range(1, 3) pulls four, the fourth marko's age.
  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_skipX1X_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().skip(1).limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | RIPPLE |

  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_rangeX1_2X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().range(1, 2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | RIPPLE |

  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_rangeX1_3X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().range(1, 3)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A skip with nothing bounded after it pulls everything: the raise is met.
  Scenario: g_V_orderXbyXlabel_descXX_valuesXname_ageX_toUpper_skipX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).values("name", "age").toUpper().skip(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # math()'s variable must resolve to a Number (MathStep). But a `MathStep` is an always-bound `MapStep`
  # (StepOutputArityPredictor's DEFINITELY_SINGULAR list), so EarlyLimitStrategy — a default — moves the
  # slice IN FRONT of it (EarlyLimitStrategy.java `apply`/`isMapStepMovable`): the chain the reference runs
  # is `inject(1, 2, "a").limit(n).math("_+1")`, and `"a"` never reaches math() for either bound.
  Scenario: g_injectX1_2_aX_mathX___plus_1X_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, "a").math("_+1").limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2.0].d |

  Scenario: g_injectX1_2_aX_mathX___plus_1X_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject(1, 2, "a").math("_+1").limit(2)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2.0].d |
      | d[3.0].d |

  # The compile-time cast of an inject()'s values raises only for a value the reference casts: the limit
  # pulls "1" and "2" and stops, so "x" is never parsed; limit(2) pulls it.
  Scenario: g_injectX1_2_xX_asNumber_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject("1", "2", "x").asNumber().limit(1)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[1].i |

  Scenario: g_injectX1_2_xX_asNumber_limitX2X
    Given the empty graph
    And the traversal of
      """
      g.inject("1", "2", "x").asNumber().limit(2)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse string 'x' as number."

  # A filter between the cast and the slice makes how many values are pulled depend on the data: declines.
  @Unsupported
  Scenario: g_injectX1_2_xX_asNumber_whereXisXgtX5XXX_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject("1", "2", "x").asNumber().where(__.is(P.gt(5))).limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse string 'x' as number."

  # The first value is cast wherever the traversal runs at all.
  Scenario: g_injectXx_1X_asNumber_limitX1X
    Given the empty graph
    And the traversal of
      """
      g.inject("x", "1").asNumber().limit(1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Can't parse string 'x' as number."

  # A DateDiff subject is checked per value: the second, not the first, is the one that is no Date.
  Scenario: g_injectXdatetime_aX_dateDiffXdatetimeX
    Given the empty graph
    And the traversal of
      """
      g.inject(datetime("2020-01-01T00:00:00Z"), "a").dateDiff(datetime("2020-01-01T00:00:00Z"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "encountered String"

  # A ZERO-WIDTH slice still PULLS: RangeGlobalStep.filter runs only after FilterStep.processNextStart has
  # pulled a start, and no strategy short-circuits high == 0, so limit(0)/range(k,k) meet low + 1
  # traversers. SQLite evaluates nothing beneath a LIMIT 0, so a zero-width slice over anything that may
  # raise declines (src/compiler/rel/lower/slice.ts, evaluationMayRaise) — at every depth the slice is
  # lowered by the one sliceRows.
  @Unsupported
  Scenario: g_injectX1X_toUpper_limitX0X
    Given the empty graph
    And the traversal of
      """
      g.inject(1).toUpper().limit(0)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_injectXa_1X_toUpper_rangeX1_1X
    Given the empty graph
    And the traversal of
      """
      g.inject("a", 1).toUpper().range(1, 1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  @Unsupported
  Scenario: g_V_valuesXageX_toUpper_limitX0X_count
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").toUpper().limit(0).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # …but NOT past math(): a MathStep is an always-bound MapStep, so EarlyLimitStrategy (a default) moves the
  # zero-width slice IN FRONT of it — the reference runs inject("x").limit(0).math("_+1"), the limit pulls
  # "x" and discards it, and math() never meets a value (EarlyLimitStrategy.java `apply`/`isMapStepMovable`,
  # StepOutputArityPredictor's DEFINITELY_SINGULAR list; `src/compiler/ir/early-limit.ts`).
  Scenario: g_injectXxX_mathX_plus_1X_limitX0X
    Given the empty graph
    And the traversal of
      """
      g.inject("x").math("_+1").limit(0)
      """
    When iterated to list
    Then the result should be empty

  # Nothing below the zero-width slice can raise: it still answers.
  Scenario: g_V_valuesXnameX_limitX0X
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").limit(0)
      """
    When iterated to list
    Then the result should be empty
