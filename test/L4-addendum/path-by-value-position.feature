Feature: mogwai addendum — a modulated path by() dispatches on the position's KIND, never joins a value as a vertex

  # A path position is an ELEMENT (rejoined by rowid) or a VALUE (`values()`, a `map`/`flatMap`/`coalesce`
  # of a scalar, a `union`/`local` arm ending in one — `appendValuePosition`). Where the lowering could not
  # PROVE the path's kinds (`pathPositionKinds` answers cannot-say past a branch or a child host), a
  # modulated `by()` used to attempt only the vertex and edge hosts, so a value fell into the vertex arm
  # and was read as a ROWID: `map(constant(5))` answered `[marko, ripple]` (vertex 5), `map(out().count())`
  # answered `[marko, lop]` (vertex 3), `by(label)` answered `[person, null]`, and a filtering `by('age')`
  # answered `[]`. The reference RAISES — `ValueTraversal.addStart` for `by(key)` (and `by(values(key))`,
  # which `ByModulatorOptimizationStrategy` rewrites to it) and `TokenTraversal.addStart` for `by(T)`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/lambda/ValueTraversal.java:113-116,
  # .../lambda/TokenTraversal.java:59-60). Each message spells the value's Java class, which a position
  # does not carry faithfully, so the value arm (`valueByArm`, src/compiler/rel/path.ts) DEFERS when it is
  # reached; a path of elements answers exactly as before. Each scenario carries the reference's error.

  @Unsupported
  Scenario: g_VX1X_mapXconstantX5XX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.constant(5)).path().by("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  @Unsupported
  Scenario: g_VX1X_mapXout_countX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.out().count()).path().by("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  @Unsupported
  Scenario: g_VX1X_mapXvaluesXageXX_path_byXlabelX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.values("age")).path().by(T.label)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "TokenTraversal support of java.lang.Integer does not allow selection by label"

  @Unsupported
  Scenario: g_VX1X_mapXvaluesXageXX_path_byXageX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.values("age")).path().by("age")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  @Unsupported
  Scenario: g_VX1X_localXmapXvaluesXageXXX_path_byXvaluesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.map(__.values("age"))).path().by(__.values("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  @Unsupported
  Scenario: g_VX1X_unionXout_valuesXnameX__out_valuesXageXX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.out().values("name"), __.out().values("age")).path().by("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  @Unsupported
  Scenario: g_VX1X_mapXvaluesXageXX_simplePath_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).map(__.values("age")).simplePath().by("name")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "modulator can only be applied to a traverser that is an Element or a Map"

  # The element positions of an unproven path still answer — the value arm is reached only by a value.
  Scenario: g_VX1X_unionXoutX_path_byXnameX
    Given the modern graph
    And the traversal of
      """
      g.V(1).union(__.out()).path().by("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | p[marko,lop] |
      | p[marko,vadas] |
      | p[marko,josh] |
