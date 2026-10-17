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

  # lop has no age, so its fold is []; ripple is the one traverser the limit pulls past lop, and it is
  # clean; marko, whose age would raise, is never pulled.
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
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_limitX2X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).limit(2).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

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
  Scenario: g_V_orderXbyXlabel_descXX_notXvaluesXageX_toUpper_foldX_limitX1X_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).not(__.values("age").toUpper().fold()).limit(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

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

  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_hasLabelXpersonX_limitX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).hasLabel("person").limit(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

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

  Scenario: g_V_orderXbyXlabel_descXX_whereXorXvaluesXlangX_valuesXageX_toUpper_foldXX_limitX3X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.or(__.values("lang"), __.values("age").toUpper().fold())).limit(3).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

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
  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_skipX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).skip(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_tailX1X
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).tail(1).values("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  Scenario: g_V_orderXbyXlabel_descXX_whereXvaluesXageX_toUpper_foldX_count
    Given the modern graph
    And the traversal of
      """
      g.V().order().by(T.label, Order.desc).where(__.values("age").toUpper().fold()).count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The toUpper() step can only take string as argument"

  # A body that MOVES is a correlated EXISTS whose raise rides inside it, where no host can carry it as
  # data, so before a limit it cannot be confined to the traversers the limit pulls: it declines.
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
