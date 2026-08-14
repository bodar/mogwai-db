Feature: mogwai addendum — as()/select(label) inside a child body

  # Labels are no longer confined to the root chain. `as()` is shape-preserving at every shape,
  # so it is an element-preserving child step like a movement; `select(label)` re-types the
  # stream to whatever the label holds, which the classifiers resolve through a threaded
  # LabelEnv (child-shape.ts). The env is seeded from the parent's carried aliases and extended
  # as a body is scanned, so a label bound anywhere up the chain — or earlier in the same body —
  # is visible inside a child body at ANY nesting depth. pushChildScope already projects the
  # alias columns into every frame, so the read is physically there to make.
  #
  # ESCAPE semantics fall out of the existing child boundaries rather than a per-position rule:
  # a MAPPING consumer pops the child stream (popChildScope carries the child's own carried, so
  # a bind inside map()/local()/flatMap()/a branch arm rides out), while a FILTER or by()
  # consumer re-projects the parent domain (so a bind inside where()/and()/or()/by() stays
  # confined). Both match TinkerPop. @gap:child-body-labels marks the family.

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_mapXoutXcreatedX_selectXxXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").map(__.out("created").select("x")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_localXoutXknowsX_selectXxXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").local(__.out("knows").select("x")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | marko |

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_localXoutXcreatedX_asXaX_selectXaXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.out("created").as("a").select("a")).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |
      | ripple |

  @gap:child-body-labels
  @Unsupported
  Scenario: a bind inside a MAPPING child escapes to the parent
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").map(__.out("created").as("a")).select("a").values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | lop |
      | lop |

  @gap:child-body-labels
  Scenario: a bind inside a FILTER child stays confined to it
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out("created").as("a")).select("a")
      """
    When iterated to list
    Then the result should be empty

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_whereXoutXcreatedX_whereXselectXxXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").where(__.out("created").where(__.select("x"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_groupXX_byXnameX_byXoutXcreatedX_selectXxX_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").as("x").group().by("name").by(__.out("created").select("x").values("name").fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"marko":["marko"],"vadas":[],"josh":["josh","josh"],"peter":["peter"]}] |

  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_mapXunionXoutXcreatedX_selectXxX__inXknowsX_selectXxXXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().as("x").map(__.union(__.out("created").select("x"), __.in("knows").select("x"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | peter |
      | vadas |

  # Every element here is productive under the by() (each created something), so this pins the
  # label read inside an order() modulator WITHOUT also pinning unproductive-by() ordering.
  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXxX_orderXX_byXoutXcreatedX_selectXxX_valuesXageXX_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().where(__.out("created")).as("x").order().by(__.out("created").select("x").values("age")).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
      | josh |
      | peter |

  @gap:child-body-labels
  @Unsupported
  Scenario: an unbound label inside a child body drops the traverser, it does not error
    Given the modern graph
    And the traversal of
      """
      g.V().map(__.out().select("nope"))
      """
    When iterated to list
    Then the result should be empty

  # ---- a label at the START of a body means different things under where() and filter() ----
  #
  # TinkerPop routes `where(traversal)` by VARIABLE LOCATION and only where(): `WhereTraversalStep`'s
  # `configureStartAndEndSteps` replaces a variable start step with a `WhereStartStep`, so
  # `where(__.as("a")…)` RE-ROOTS at label a. `filter()` builds a plain `TraversalFilterStep` — no
  # rewriting, no `getVariableLocations` — so the same body under filter() is an ordinary REBIND of the
  # current object and the label is inert.
  #
  # These two scenarios are the same body under the two hosts, and they MUST disagree. The work index
  # filed the filter() answer as a defect ("dropping rows TinkerPop keeps"); it is the reference's
  # answer, and pinning both here is what stops it being re-filed. Verified against
  # vendor/tinkerpop/gremlin-core/.../step/filter/WhereTraversalStep.java:60-83 and
  # .../dsl/graph/GraphTraversal.java:2578.

  @gap:child-body-labels
  Scenario: g_V_asXaX_out_asXbX_whereXasXaX_outXknowsXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").where(__.as("a").out("knows")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[3].l |

  # The SAME body under filter(): `as("a")` rebinds the current object (an out-neighbour), so the
  # body is `filter(__.out("knows"))` and no out-neighbour of anything has a knows edge.
  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXaX_out_asXbX_filterXasXaX_outXknowsXX_count
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().as("b").filter(__.as("a").out("knows")).count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[0].l |

  # The rebind is CONFINED to the child: a filter() consumer re-projects the parent domain, so the
  # outer "a" still holds the source vertex afterwards.
  @gap:child-body-labels
  @Unsupported
  Scenario: g_V_asXaX_out_filterXasXaX_outX_selectXaX_name
    Given the modern graph
    And the traversal of
      """
      g.V().as("a").out().filter(__.as("a").out()).select("a").values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
