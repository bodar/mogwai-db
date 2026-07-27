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
