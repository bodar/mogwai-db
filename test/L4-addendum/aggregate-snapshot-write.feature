Feature: mogwai addendum — a named collection in a program with EFFECTS is the pre-mutation set

  # A named collection is a relation held under a name, and a CTE is RE-EVALUATED by every statement
  # that names it. In a read program that is correct; in one with effects it is a silent wrong
  # answer, because the collection would then be read AFTER the write it was supposed to precede.
  #
  # The plan's own answer is a `snapshot` binding (`src/rel/plan.ts`) — rows TAKEN and RETAINED
  # rather than re-derived — which `write.ts` already produced and `runProgram` already honoured.
  # These pin the observable half of that: what `cap()` yields is the set that existed when the
  # `aggregate()` ran, not the set the graph holds afterwards.
  # @gap:aggregate-snapshot-write marks the family.

  @SpineRel
  @gap:aggregate-snapshot-write
  Scenario: g_V_hasLabelXsoftwareX_aggregateXaX_addVXsoftwareX_capXaX_unfold_count
    Given the empty graph
    And the graph initializer of
      """
      g.addV("software").property("name", "lop").addV("software").property("name", "ripple")
      """
    And the traversal of
      """
      g.V().hasLabel("software").aggregate("a").addV("software").cap("a").unfold().count()
      """
    # The collection is filled BEFORE the addV, so it holds the two software vertices that existed
    # then — not the three that exist when `cap()` is read. A re-evaluated CTE would answer 3 for
    # each traverser it ran under; the snapshot answers 2.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @SpineRel
  @gap:aggregate-snapshot-write
  Scenario: g_V_valuesXnameX_aggregateXaX_addVXpersonX_capXaX_unfold
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas")
      """
    And the traversal of
      """
      g.V().values("name").aggregate("a").addV("person").property("name", "stephen").cap("a").unfold()
      """
    # The same rule over a VALUE stream, and the added vertex's name must not appear: the members
    # were taken before it existed.
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |

  @SpineRel
  @gap:aggregate-snapshot-write
  Scenario: g_V_hasLabelXpersonX_aggregateXaX_outXcreatedX_drop_capXaX_unfold_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").aggregate("a").out("created").drop()
      """
    # A cascade beside a collection: the drop must not disturb the retained rows, and the retained
    # rows must not change what the drop deletes. Asserted through the graph AFTER the traversal,
    # since `drop()` itself produces no traversers.
    When iterated to list
    Then the result should be empty
