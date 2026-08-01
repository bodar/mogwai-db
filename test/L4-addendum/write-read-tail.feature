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

  # …and over SEVERAL it is not, so it fails closed rather than answering once per element. The
  # refusal fires before any mutation, so the graph is untouched.
  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_count_over_many_is_refused
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").property(Cardinality.single, "temp", "x").count()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "cannot observe the whole stream"

  # A MUTATING tail is a different question again (the write driver would have to re-enter the write
  # spine), and is refused with its own message.
  @gap:write-read-tail
  Scenario: g_V_propertyXtempX_addV_is_refused
    Given the modern graph
    And the traversal of
      """
      g.V(1).property(Cardinality.single, "temp", "x").addV("y")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "not yet supported"
