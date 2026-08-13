Feature: mogwai addendum — a read tail after an element-preserving write

  # `property()` and `addLabel()`/`dropLabel()` mutate an element and pass the SAME traverser on, so
  # anything after them is an ordinary read over the mutated elements. Both reach one continuation,
  # which re-reads the suffix per driver.
  #
  # That per-driver shape is exactly why the barrier case is pinned below: it is right only while
  # every suffix step is per-traverser, and it silently was not checked.

  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_valuesXtempX
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single, "temp", "x").values("temp")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | x |

  # The tail is a full read, not a property echo: it can move.
  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_outXknowsX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single, "temp", "x").out("knows").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | josh |

  @gap:write-read-tail
  Scenario: g_E_propertyXw2X_valuesXw2X
    Given the modern graph
    And the traversal of
      """
      g.E(7).property("w2", 9).values("w2")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9].i |

  # ONE element: a per-driver read IS the global answer, so a barrier is correct here…
  @gap:write-read-tail
  Scenario: g_VX1X_propertyXtempX_valuesXtempX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single, "temp", "x").values("temp").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  # …and over SEVERAL it is ALSO one answer, which is the point of a barrier: `count()` observes the
  # whole mutated stream, so a four-person write counts four. This scenario pinned a REFUSAL until
  # the RelIR spine made `property()` a step of the ordinary fold — the write's result is the same
  # element relation, so a barrier after it is the barrier that was already built. TinkerPop's answer
  # is the count, and the refusal was ours; a pin that records our own limitation moves the day the
  # limitation goes.
  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_count_over_many
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").property(Cardinality.single, "temp", "x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |

  # A MUTATING tail is the SAME question once a write is a program: `property()` hands its traversers
  # back and `addV()` creates one vertex per traverser, so the two compose the way any two steps do.
  # This scenario recorded an earlier write driver's inability to re-enter itself — a refusal that was
  # ours, not TinkerPop's, and moved when that limitation went.
  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_addV
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single, "temp", "x").addV("y")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"y\")"
    And the graph should return 1 for count of "g.V(1).values(\"temp\")"
