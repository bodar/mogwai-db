Feature: mogwai addendum — user input never reaches a RelIR internal error; a branch arm the lowering cannot lay out or scope DECLINES

  # Three ways a union/coalesce/optional arm used to reach the user as something other than the
  # reference answer or a clean refusal. Each @Unsupported scenario below carries the REFERENCE
  # answer, so the day the shape lands the refusal stops and the scenario fails loudly as the prompt
  # to drop the tag.
  #
  # (1) ARMS WHOSE COLUMNS DISAGREE IN TYPE OR NULLABILITY. A `UNION ALL` is positional, and the
  # RelIR checker holds every input to the output's columns name, storage type AND nullability
  # (`unionColumnsViolation`, src/rel/structure.ts). The branch merge used to compare NAMES only, so
  # two string arms — `labels()` (`v any NULL`) and `constant("x")` (`v text NOT NULL`) — were
  # admitted and the checker's internal "Union inputs and output must have identical columns" reached
  # the user. The merge now asks the checker's own question first and declines.
  #
  # (2) A SUBSET-SELECTING SLICE IN A PER-TRAVERSER ARM. `CoalesceStep.flatMap` resets its arm for
  # every start (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CoalesceStep.java:52-60),
  # as does `OptionalStep.processNextStart` (…/step/branch/OptionalStep.java:47-57), so a `limit`/
  # `range`/`skip`/`tail`/`sample`/`dedup` in the arm selects WITHIN one traverser's sub-stream. The
  # ordinary arm lowering runs the body once over EVERY traverser's rows, so it selected across all
  # of them — `coalesce(out().limit(1), constant("x")).count()` answered 4 where the reference is 6.
  # A per-traverser slice is a per-origin lowering that route does not have, so it declines, at any
  # depth a stream-wide child (`union`/`choose`/`repeat`) carries the slice to.
  #
  # (3) THE TYPE TAG OF A SCALAR COALESCE CHILD. A `local()`/`map()`/`flatMap()`/`by()` coalesce over
  # scalar arms is one SQL `COALESCE`; its per-row type tag was a `COALESCE` of the arms' TAGS, which
  # picks the first arm that HAS a tag rather than the arm that produced — `"x"` from an untagged
  # constant arm was framed as the count arm's `long` and threw at serialization. The tag now follows
  # the same non-null test the value does.

  @Unsupported
  Scenario: g_VX1X_outEXknowsX_unionXoutV_labels__constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).outE("knows").union(__.outV().labels(), __.constant("x")).count()
      """
    # Two knows edges; each yields its outV's one label (marko is a person) and an "x".
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  @Unsupported
  Scenario: g_V_coalesceXout_limitX1X__constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().limit(1), __.constant("x")).count()
      """
    # marko, josh and peter each keep ONE out(); the other three fall back to "x".
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @Unsupported
  Scenario: g_V_coalesceXout_sampleX1X__constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().sample(1), __.constant("x")).count()
      """
    # SampleGlobalStep is a CollectingBarrierStep, but CoalesceStep feeds it one start at a time.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @Unsupported
  Scenario: g_V_coalesceXout_dedup__constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.out().dedup(), __.constant("x")).count()
      """
    # Per traverser: marko 3, josh 2, peter 1, and "x" for the other three — a global dedup gives 7.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].l |

  @Unsupported
  Scenario: g_V_coalesceXrepeatXout_limitX1XX_timesX1X__constantXxXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().coalesce(__.repeat(__.out().limit(1)).times(1), __.constant("x")).count()
      """
    # The slice sits inside a repeat() body — still one start per coalesce application.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @Unsupported
  Scenario: g_V_optionalXout_limitX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().limit(1)).count()
      """
    # marko, josh and peter each keep ONE out(); the other three pass through themselves.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @Unsupported
  Scenario: g_V_optionalXout_sampleX1XX_count
    Given the modern graph
    And the traversal of
      """
      g.V().optional(__.out().sample(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_localXcoalesceXconstantXxX__out_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.coalesce(__.constant("x"), __.out().count()))
      """
    # constant() always produces, so the count arm is dead — and "x" is a string, not a long.
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | x |
      | x |
      | x |
      | x |
      | x |

  Scenario: g_V_flatMapXcoalesceXconstantXxX__out_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.coalesce(__.constant("x"), __.out().count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |
      | x |
      | x |
      | x |
      | x |
      | x |

  Scenario: g_V_projectXaX_byXcoalesceXconstantXxX__out_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().project("a").by(__.coalesce(__.constant("x"), __.out().count()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"x"}] |
      | m[{"a":"x"}] |
      | m[{"a":"x"}] |
      | m[{"a":"x"}] |
      | m[{"a":"x"}] |
      | m[{"a":"x"}] |

  Scenario: g_V_localXcoalesceXout_valuesXnameX__out_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.coalesce(__.out().values("name"), __.out().count()))
      """
    # A scalar child takes the FIRST value of a fan-out arm (local() over a coalesce is one value
    # per traverser here only where the arm yields one) — so pin the per-row TAG, not the fan-out:
    # vadas, lop and ripple have no out() and answer their count, a long.
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | lop |
      | lop |
      | d[0].l |
      | d[0].l |
      | d[0].l |

  Scenario: g_V_localXcoalesceXconstantX1X__out_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.coalesce(__.constant(1), __.out().count()))
      """
    # The constant arm answers, so the tag is the constant's (an int), never the dead count arm's long.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |
      | d[1].i |

  # (4) A HOST BUILT BEFORE A PATH DROP. An unkeyed `group`/`groupCount` and a `dedup` DROP a carried
  # path (a barrier consumes it — `simplePath()` has already filtered the stream), but their `by()`
  # host was built over the PRE-drop relation, so the plan named a relation the barrier no longer
  # reads and the checker threw "no relation 'spf…' is in scope" at the user. The host is now read
  # off the relation that survived the drop, so the answer is the path-free one.

  Scenario: g_V_simplePath_groupCount_byXageX
    Given the modern graph
    And the traversal of
      """
      g.V().simplePath().groupCount().by("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[27].i":"d[1].l","d[29].i":"d[1].l","d[32].i":"d[1].l","d[35].i":"d[1].l"}] |

  Scenario: g_V_out_simplePath_groupXbyXlabelX_byXcountXX
    Given the modern graph
    And the traversal of
      """
      g.V().out().simplePath().group().by(T.label).by(__.count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[2].l","software":"d[4].l"}] |

  Scenario: g_V_simplePath_dedup_byXageX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().simplePath().dedup().by("age").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
