Feature: mogwai addendum — a uniform-element branch as a child-body value

  # A branch (union/choose/coalesce/optional) whose arms are UNIFORMLY element folds through
  # lowerElementSteps' prefix exactly like a movement, so it is an element-preserving child step.
  # The classifier now admits it (isUniformElementBranch, gated by the ONE canonical arm triage
  # classifyBranchArms), so an element-valued branch composes at EVERY position that consumes the
  # child seam — map()/local()/flatMap(), where(), and group().by(value) — not one shape at a time.
  # The scalar-armed branch (union(constant,constant)) keeps its own path; only element/list arms
  # take this route. @gap:element-branch-child marks the family for a possible gremlin-test PR.

  @gap:element-branch-child
  Scenario: g_V_hasLabelXpersonX_whereXunionXout__inXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").where(__.union(__.out(), __.in())).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |

  @gap:element-branch-child
  Scenario: g_V_hasLabelXpersonX_mapXunionXout__inX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").map(__.union(__.out(), __.in()).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[1].l |
      | d[3].l |
      | d[1].l |

  @gap:element-branch-child
  Scenario: g_V_hasLabelXpersonX_localXcoalesceXoutXknowsX__outXcreatedXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.coalesce(__.out("knows"), __.out("created"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | ripple |
      | lop |

  @gap:element-branch-child
  Scenario: g_V_hasLabelXpersonX_localXchooseXhasXage_gtX30XX_outXcreatedX__outXknowsXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.choose(__.has("age", P.gt(30)), __.out("created"), __.out("knows"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |
      | lop |
      | ripple |
      | lop |

  @gap:element-branch-child
  Scenario: g_V_hasLabelXpersonX_groupXbyXnameX_byXunionXout__inX_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.union(__.out(), __.in()).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":"d[3].l","vadas":"d[1].l","josh":"d[3].l","peter":"d[1].l"}] |

  @gap:element-branch-child
  Scenario: g_V_groupXbyXTlabelX_byXunionXout__inX_countXX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.union(__.out(), __.in()).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":"d[8].l","software":"d[4].l"}] |

  # ---- a COLLAPSING arm of a BATCHING branch (docs/2026-08-01-branch-arm-barrier-scope-plan.md) ----
  #
  # `BranchStep.standardAlgorithm` injects EVERY start at once when any option contains a `Barrier`
  # (`hasBarrier`), so a reducer arm reduces over the branch's whole input. We provisioned every arm
  # as a per-origin child body, which is the `local(union(…))` reading — and `Union.feature` ships
  # both readings on one graph, so we answered the wrong one of its two halves.
  #
  # These pin the element-parent half. The scalar-parent half is in scalar-reentry.feature, and only
  # `union`/`choose` are affected: `CoalesceStep extends FlatMapStep` and `OptionalStep extends
  # AbstractStep` take one start at a time unconditionally, so their arms genuinely are per-traverser.

  @gap:element-branch-child
  Scenario: g_V_unionXcount__outXcreatedX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.count(), __.out("created").count())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |
      | d[4].l |

  # The barrier is NOT the terminal step here — `hasBarrier` asks whether the option CONTAINS one —
  # so `is(gt(0))` filters ONE collapsed value per arm, not one per vertex.
  @gap:element-branch-child
  Scenario: g_V_unionXoutXcreatedX_count_isXgtX0XX__inXcreatedX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.out("created").count().is(P.gt(0)), __.in("created").count())
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |
      | d[4].l |

  # An arm that received NO traversers emits nothing, even though its barrier has a seed value:
  # `count()` over an empty stream is 0 as a main chain, and `ChooseStep` never runs an option no
  # start was routed to. A `V()` re-source arm makes it unmissable — its rows do not come from the
  # arm's input at all.
  @gap:element-branch-child
  Scenario: g_V_hasLabelXnoneX_unionXcount__outXcreatedX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("nonexistent").union(__.count(), __.out("created").count())
      """
    When iterated to list
    Then the result should be empty

  # A label bound AFTER the collapsing barrier still survives the merge: the arm has LOST `bulk` and
  # GAINED its alias column, so the merge has to resolve the carried schema per COLUMN rather than
  # deciding "is this arm collapsed?" once.
  @gap:element-branch-child
  Scenario: g_V_unionXcount_asXxX__outXcreatedX_countX_selectXxX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.count().as("x"), __.out("created").count()).select("x")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[6].l |
