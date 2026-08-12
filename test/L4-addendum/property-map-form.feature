Feature: mogwai addendum — property(Map) is sugar for one property() per entry

  # `GraphTraversal.property(Map)` loops the entries calling `property(null, k, v)`, and
  # `property(Cardinality, Map)` loops them calling `property(cardinality, k, v)` unless the value is
  # a `CardinalityValue`, which overrides for its own entry (gremlin-core .../dsl/graph/
  # GraphTraversal.java:4074-4132). It is sugar with no semantics of its own, so we expand it in a
  # Pass and no write host learns the form exists — which is also why these scenarios exercise it at
  # more than one host.
  #
  # The official corpus reaches the addV host and the mixed-cardinality map. The mutation host, the
  # empty map, a nested-traversal map value and the interaction with the graph's default cardinality
  # are unpinned upstream.

  @gap:property-map-form
  Scenario: g_addV_propertyXmapX
    Given the empty graph
    And the traversal of
      """
      g.addV().property(["name": "foo", "age": 42])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"foo\").has(\"age\",42)"
    And the graph should return 2 for count of "g.V().properties()"

  # The enclosing cardinality applies to every entry that does not override it — here `list`, so a
  # second map write over the same keys appends rather than replacing.
  @gap:property-map-form
  Scenario: g_V_propertyXlist_mapX_twice_appends
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property(Cardinality.list, ["name": "foo"])
      """
    And the traversal of
      """
      g.V().property(Cardinality.list, ["name": "bar"])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().properties(\"name\")"

  # …and `single` on the enclosing form replaces, for every entry that does not override it.
  @gap:property-map-form
  Scenario: g_V_propertyXsingle_mapX_replaces
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property(Cardinality.list, ["name": "foo"]).property(Cardinality.list, ["name": "bar"])
      """
    And the traversal of
      """
      g.V().property(Cardinality.single, ["name": "baz"])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"baz\")"

  # A CardinalityValue map value overrides the enclosing cardinality for its own entry only.
  @gap:property-map-form
  Scenario: g_V_propertyXlist_map_with_single_entryX
    Given the empty graph
    And the graph initializer of
      """
      g.addV().property(Cardinality.list, ["name": "foo", "age": 41])
      """
    And the traversal of
      """
      g.V().property(Cardinality.list, ["name": "bar", "age": Cardinality.single(42)])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().properties(\"age\")"
    And the graph should return 1 for count of "g.V().has(\"age\",42)"

  # An empty map adds no step at all, so the traversal is the bare read/write it wraps.
  @gap:property-map-form
  Scenario: g_addV_propertyXempty_mapX
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property([:])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties()"
    And the graph should return 1 for count of "g.V().hasLabel(\"animal\")"

  # A NULL in the map position is the SAME no-op, and it is the DSL's answer rather than a step's:
  # `property(Map)` is guarded `if (value != null)` and the cardinality overload says outright "Just
  # return the input if you pass a null" (GraphTraversal.java:4089-4091, 4122-4133). The official
  # corpus covers both forms; these are here because the ARITY rule that separates them from a real
  # null-VALUE write is ours, and nothing upstream exercises the three together.
  @gap:property-map-form
  Scenario: g_addV_propertyXnullX_is_a_no_op
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property(null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties()"
    And the graph should return 1 for count of "g.V().hasLabel(\"animal\")"

  @gap:property-map-form
  Scenario: g_addV_propertyXcardinality_nullX_is_a_no_op
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property(Cardinality.set, null)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().properties()"

  # ...and the ARITY is what separates that no-op from a real write of a NULL VALUE, which still
  # reaches the write and is NOT dropped. `property('k', null)` has one more argument than the map
  # form, which is the whole distinction — a set-membership test could not make it.
  @gap:property-map-form
  Scenario: g_addV_propertyXk_nullX_is_a_write_not_a_no_op
    Given the empty graph
    And the traversal of
      """
      g.addV("animal").property("name", null)
      """
    When iterated to list
    Then the result should have a count of 1

  # A map VALUE may be a nested traversal — `mapEntry : mapKey COLON genericLiteral` admits
  # `nestedTraversal` — and it resolves per driver element exactly as `property(k, __.trav)` does.
  @gap:property-map-form
  @Unsupported
  Scenario: g_V_propertyXmap_with_traversal_valueX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").property(Cardinality.single, ["degree": __.outE().count()])
      """
    When iterated to list
    Then the result should have a count of 4
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"degree\",3)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"peter\").has(\"degree\",1)"
