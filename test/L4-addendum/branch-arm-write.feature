Feature: mogwai addendum — a WRITE inside a SINGLE-arm branch

  # A mutation in a SINGLE-arm branch (union(__.addV(…)), union(__.mergeV(…)), union(__.property(…))) is a
  # set-based statement over that arm's input, so its effect bindings thread OUT through the branch merge to
  # become program bindings — the same effects-threading a top-level write does, and identical to a
  # top-level write followed by its tail (a single arm has no sibling to observe the mutation). Previously
  # such a traversal emitted a malformed plan; now it executes.
  #
  # A SOURCE union (g.union(…), no incoming stream) has ONE start traverser, so arm-major order coincides
  # with per-traverser order — even MULTIPLE write arms are correct there.
  #
  # A MULTI-arm CHAIN branch with a write, and choose/coalesce writes (always ≥2 arms), DECLINE cleanly —
  # effects run before the result query, so a sibling arm would observe another traverser's write and answer
  # a post-write state the reference does not. The @Unsupported scenarios below pin that fail-closed refusal.

  @gap:branch-arm-write
  Scenario: g_V_unionXaddVX_writes_and_passes_on
    Given the empty graph
    And the traversal of
      """
      g.addV("person").addV("person").V().union(__.addV("t")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 4 for count of "g.V()"
    And the graph should return 2 for count of "g.V().hasLabel(\"t\")"

  @gap:branch-arm-write
  Scenario: g_V_unionXpropertyX_mutates_through
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").union(__.property("seen",1)).values("seen")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  @gap:branch-arm-write
  Scenario: g_V_unionXmergeVX_matches
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").union(__.mergeV(__.project("name").by(__.values("name")))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
    And the graph should return 6 for count of "g.V()"

  @gap:branch-arm-write
  Scenario: g_unionXaddV_alice_addV_bob_addV_chrisX_source_union_creates_all
    Given the empty graph
    And the traversal of
      """
      g.union(__.addV("person").property("name","alice"),__.addV("person").property("name","bob")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | alice |
      | bob |
    And the graph should return 2 for count of "g.V()"

  # A write in a MULTI-arm CHAIN branch declines (a sibling arm would observe another traverser's mutation).
  @Unsupported
  @gap:branch-arm-write
  Scenario: g_V_unionXaddV_a_addV_bX_declines
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").union(__.addV("a"),__.addV("b")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  @Unsupported
  @gap:branch-arm-write
  Scenario: g_V_chooseXwriteX_declines
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.has("age",29),__.property("big",1),__.property("big",0))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |
