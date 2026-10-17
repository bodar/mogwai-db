Feature: mogwai addendum — reducing branch arms of DIFFERENT shapes merge, and a reducing option is gated per start

  # `ChooseStep` is a `BranchStep`: an arm holding a `fold()` makes it drain every option over the whole
  # input, and an option no start was routed to is skipped rather than emitting its seed
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/BranchStep.java:123-153).
  # Two fold arms whose MEMBERS differ in kind (names vs ids) are a variant merge; it compared the arms
  # against the branch INPUT's carried channels, which a barrier drops, and threw the channel core's bare
  # error at the user. Inside a per-start child (`local`) `LocalStep` runs the whole choose once per start
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/branch/LocalStep.java:80-88),
  # so "was a start routed to this option" is that start's question — an uncorrelated gate emitted the
  # untaken arm's `[]` beside every answer. @gap:branch-arm-reduction-channels marks the family.
  #
  # The variant's wire vocabulary has ONE declared list arm, so two fold arms whose MEMBERS differ (names vs
  # ids, vertices vs ids, vertices vs names) have no truthful shared descriptor: collapsing them to the first
  # arm's framed ids as vertices and vertices as bare ids. `variantVocabulary` (src/compiler/rel/variant.ts)
  # DECLINES them, so those scenarios are @Unsupported — each keeps the reference answer for the day a
  # per-row member descriptor lands. Fold arms whose members AGREE (names vs langs) answer exactly.

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_chooseXhasLabelXpersonX_valuesXnameX_fold_id_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.values("name").fold(), __.id().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,josh,peter] |
      | l[v[lop].id,v[ripple].id] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_hasLabelXpersonX_chooseXhasLabelXpersonX_valuesXnameX_fold_id_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").choose(__.hasLabel("person"), __.values("name").fold(), __.id().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,josh,peter] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_chooseXlabelX_optionXperson_valuesXnameX_foldX_optionXnone_id_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.label()).option("person", __.values("name").fold()).option(Pick.none, __.id().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,josh,peter] |
      | l[v[lop].id,v[ripple].id] |

  @gap:branch-arm-reduction-channels
  Scenario: g_V_localXchooseXhasLabelXpersonX_valuesXnameX_fold_valuesXlangX_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.hasLabel("person"), __.values("name").fold(), __.values("lang").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko] |
      | l[vadas] |
      | l[java] |
      | l[josh] |
      | l[java] |
      | l[peter] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_localXchooseXhasLabelXpersonX_valuesXnameX_fold_id_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.hasLabel("person"), __.values("name").fold(), __.id().fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko] |
      | l[vadas] |
      | l[v[lop].id] |
      | l[josh] |
      | l[v[ripple].id] |
      | l[peter] |

  @gap:branch-arm-reduction-channels
  Scenario: g_V_flatMapXchooseXhasLabelXpersonX_valuesXnameX_fold_valuesXlangX_foldXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().flatMap(__.choose(__.hasLabel("person"), __.values("name").fold(), __.values("lang").fold())).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  @gap:branch-arm-reduction-channels
  Scenario: g_V_localXchooseXlabelX_optionXperson_valuesXnameX_foldX_optionXnone_valuesXlangX_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.label()).option("person", __.values("name").fold()).option(Pick.none, __.values("lang").fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko] |
      | l[vadas] |
      | l[java] |
      | l[josh] |
      | l[java] |
      | l[peter] |

  @gap:branch-arm-reduction-channels
  Scenario: g_V_projectXaX_byXchooseXhasLabelXpersonX_valuesXnameX_fold_valuesXlangX_foldX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("software").project("a").by(__.choose(__.hasLabel("person"), __.values("name").fold(), __.values("lang").fold()).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":[["java"]]}] |
      | m[{"a":[["java"]]}] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_chooseXhasLabelXpersonX_out_fold_id_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().choose(__.hasLabel("person"), __.out().fold(), __.id().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[v[vadas],v[josh],v[lop],v[ripple],v[lop],v[lop]] |
      | l[v[lop].id,v[ripple].id] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_localXchooseXhasLabelXpersonX_out_fold_constantX1X_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.choose(__.hasLabel("person"), __.out().fold(), __.constant(1).fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[v[vadas],v[josh],v[lop]] |
      | l[] |
      | l[d[1].i] |
      | l[v[ripple],v[lop]] |
      | l[d[1].i] |
      | l[v[lop]] |

  @gap:branch-arm-reduction-channels
  @Unsupported
  Scenario: g_V_unionXvaluesXnameX_fold_out_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().union(__.values("name").fold(), __.out().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas,lop,josh,ripple,peter] |
      | l[v[lop],v[vadas],v[josh],v[ripple],v[lop],v[lop]] |
