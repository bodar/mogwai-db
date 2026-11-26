Feature: mogwai addendum — a whole number past int64 sorts and compares by its value

  # A long/bigint, a datetime's epoch and a duration's nanos are WHOLE NUMBERS, and every carrier of one —
  # the stored row's `value`, a decimal-TEXT payload, a `{t,v}` list member — keys through ONE primitive,
  # `wholeNumber` = SQLite's `CAST(x AS NUMERIC)` (`src/compiler/rel/build.ts`). It is INTEGER inside int64
  # and REAL past it, never clamped. Before it, the compare key was `CAST(x AS INTEGER)`, which SATURATES
  # onto ±2^63: every bigint past int64 tied there, and the sort fell back to insertion order.
  #
  # Measured before the fix, over n = 3e20, 1e20, 2e20 inserted as c, a, b: `order().by('n')` answered
  # [c, a, b], `order().by('n', desc)` the same, and `where('a', gt('b')).by('n')` found no pair at all.
  # Ordering a Number is by its value (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/
  # gremlin/util/NumberHelper.java` `compare`). Past 2^53 the order is the double order — the documented
  # "a `bigint` outside the long range compares at double precision" (`docs/limitations.md` §3).

  Scenario: g_V_order_byXnX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().hasLabel("x").order().by("n").values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  Scenario: g_V_order_byXn_descX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().hasLabel("x").order().by("n", Order.desc).values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | c |
      | b |
      | a |

  # A negative value past int64 clamped onto Long.MIN_VALUE and tied there.
  Scenario: g_V_order_byXnX_negative_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", -100000000000000000000N).
        addV("x").property("k", "a").property("n", -300000000000000000000N).
        addV("x").property("k", "d").property("n", 5L).
        addV("x").property("k", "b").property("n", -200000000000000000000N)
      """
    And the traversal of
      """
      g.V().hasLabel("x").order().by("n").values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |
      | d |

  Scenario: g_V_properties_order_byXvalueX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().properties("n").order().by(T.value).element().values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  Scenario: g_V_valuesXnX_fold_orderXlocalX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().values("n").fold().order(Scope.local).unfold().is(P.gt(150000000000000000000N)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  Scenario: g_V_projectXk_nX_order_byXselectXnXX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().project("k", "n").by("k").by("n").order().by(__.select("n")).select("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  Scenario: g_V_asXaX_V_asXbX_whereXa_gtXbXX_byXnX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().as("a").V().as("b").where("a", P.gt("b")).by("n").select("a", "b").by("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"c","b":"a"}] |
      | m[{"a":"c","b":"b"}] |
      | m[{"a":"b","b":"a"}] |

  # Deeper: the stored sort key inside a child body, a branch arm and a group value.
  Scenario: g_V_fold_localXunfold_order_byXnX_valuesXkX_foldX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().fold().local(__.unfold().order().by("n").values("k").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,b,c] |

  Scenario: g_V_groupXbyXlabelX_byXorder_byXnX_valuesXkX_foldXX_wide_bigint
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("n", 300000000000000000000N).
        addV("x").property("k", "a").property("n", 100000000000000000000N).
        addV("x").property("k", "b").property("n", 200000000000000000000N)
      """
    And the traversal of
      """
      g.V().group().by(T.label).by(__.order().by("n").values("k").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"x":"l[a,b,c]"}] |

  Scenario: g_E_order_byXwX_wide_bigint_edge_property
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").as("p").addV("x").as("q").
        addE("e").from("p").to("q").property("k", "c").property("w", 300000000000000000000N).
        addE("e").from("p").to("q").property("k", "a").property("w", 100000000000000000000N).
        addE("e").from("p").to("q").property("k", "b").property("w", 200000000000000000000N)
      """
    And the traversal of
      """
      g.E().properties("w").order().element().values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  Scenario: g_V_order_byXdX_datetime
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "b").property("d", datetime("2021-01-01T00:00:00Z")).
        addV("x").property("k", "c").property("d", datetime("2022-01-01T00:00:00Z")).
        addV("x").property("k", "a").property("d", datetime("2019-01-01T00:00:00Z"))
      """
    And the traversal of
      """
      g.V().order().by("d").values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  # A duration's nanos ride as decimal TEXT (`storedOrderKey`); one of them is past int64.
  Scenario: g_V_order_byXuX_duration
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("u", Duration(400000000000, 0)).
        addV("x").property("k", "b").property("u", Duration(50, 0)).
        addV("x").property("k", "a").property("u", Duration(-3, 0))
      """
    And the traversal of
      """
      g.V().order().by("u").values("k")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | a |
      | b |
      | c |

  Scenario: g_V_asXaX_V_asXbX_whereXa_gtXbXX_byXuX_duration
    Given the empty graph
    And the graph initializer of
      """
      g.addV("x").property("k", "c").property("u", Duration(400000000000, 0)).
        addV("x").property("k", "b").property("u", Duration(50, 0)).
        addV("x").property("k", "a").property("u", Duration(-3, 0))
      """
    And the traversal of
      """
      g.V().as("a").V().as("b").where("a", P.gt("b")).by("u").select("a", "b").by("k")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"c","b":"a"}] |
      | m[{"a":"c","b":"b"}] |
      | m[{"a":"b","b":"a"}] |

  # The list.ts min/max pin: a long past 2^53 keyed by its value.
  Scenario: g_injectXbig_biggerX_order
    Given the empty graph
    And the traversal of
      """
      g.inject(10007199254740993L, 9007199254740993L).order()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[9007199254740993].l |
      | d[10007199254740993].l |
