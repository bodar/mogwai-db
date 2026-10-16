Feature: mogwai addendum — WHICH traverser a traversal-valued property() reads, and WHEN

  # A `property()` value traversal runs against one of two traversers, and the step's text does not say
  # which: an ordinary `AddPropertyStep` reads the element it MUTATES (`AddPropertyStep.sideEffect`), but a
  # `property()` FOLDED into the `addV`/`addE` before it (no cardinality, no meta — every one after an
  # `addE`) becomes a creation PARAMETER that `Parameters.getKeyValues(traverser)` resolves against the
  # INCOMING traverser, before the element exists (`GraphTraversal.property`,
  # `dsl/graph/GraphTraversal.java:3996-4044`; `AddVertexStep.map`). A parameter is `TraversalUtil.apply`
  # — the first result, and a RAISE on none. Either way the body is read BEFORE the mutation it feeds.
  #
  # The corpus pins one folded value (`g_V_addVXanimalX_…`) and the single-cardinality error class; the
  # message's count, the read-before-replace order, repeated traversers on one element, the `addE` fold,
  # a runtime KEY's checks and the map form's optional entry are unpinned upstream.

  # The reference's sentence carries the count (`AddPropertyStep.java:178-181`).
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXsingle_friend_outXknowsX_valuesXnameXX_count_in_message
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(Cardinality.single, "friend", __.out("knows").values("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Single-cardinality property requires exactly one value, but traversal produced 2 results"

  # The body reads the OLD age: deleting the displaced value first left nothing to add one to.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXsingle_age_valuesXageX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(Cardinality.single, "age", __.values("age").math("_+1"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"age\",30.0)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"age\")"

  # No result is no mutation — and a `single` write that writes nothing displaces nothing either.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXsingle_age_outXnosuchX_valuesXageXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(Cardinality.single, "age", __.out("nosuch").values("age"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"age\",29)"

  # Two traversers on ONE vertex are the step run twice: each yields one value, so `single` does not
  # raise, and the second run replaces the first — one property, not two.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXsingle_seen_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.single, "seen", __.values("name"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"seen\")"

  # …and the same for a CONSTANT value, where each run writes an equal value.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXsingle_seen_1X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.single, "seen", 1)
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"seen\")"

  # `list` keeps every run's value.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXlist_seen_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.list, "seen", __.values("name"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 2 for count of "g.V().has(\"name\",\"marko\").properties(\"seen\")"

  # Every property() after an addE is a creation parameter: it reads the INCOMING vertex, and reads it
  # before the edge exists — vadas has no out-edge until this one.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_vadasX_addEXxX_toXlopX_propertyXouts_out_countX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","vadas").addE("x").to(__.V().has("name","lop")).property("by", __.values("name")).property("outs", __.out().count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.E().hasLabel(\"x\").has(\"by\",\"vadas\").has(\"outs\",0)"

  # A creation parameter with no value is `TraversalUtil.apply`'s refusal, not a skipped write.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_vadasX_addVXcopyX_propertyXfirst_out_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","vadas").addV("copy").property("first", __.out().values("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The provided traverser does not map to a value"

  # A property() with a CARDINALITY is not folded, so it reads the NEW vertex — which has no name.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_addVXcopyX_propertyXlist_n_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").addV("copy").property(Cardinality.list, "n", __.values("name"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().hasLabel(\"copy\").properties()"

  # The folded parameters are applied by the creation, BEFORE any property() step that stayed a step:
  # `k` is created as 2 and then replaced by the `single` 1.
  @gap:property-traversal-site
  Scenario: g_addVXxX_propertyXsingle_k_1X_propertyXk_2X
    Given the empty graph
    And the traversal of
      """
      g.addV("x").property(Cardinality.single, "k", 1).property("k", 2)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"x\").properties(\"k\")"
    And the graph should return 1 for count of "g.V().hasLabel(\"x\").has(\"k\",1)"

  # A runtime KEY is resolved like a value.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXvaluesXnameX_valuesXageXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(__.values("name"), __.values("age"))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"marko\",29)"

  # …and a key that is not a String is refused (`ElementHelper.legalPropertyKeyValueArray`).
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXvaluesXageX_1X
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(__.values("age"), 1)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "must have a String or T on even array indices"

  # The MAP form writes each entry the map HAS — `ProjectStep` omits an unproductive by()'s key.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXprojectXa_bX_byXnosuchX_byXlabelXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(__.project("a","b").by(__.values("nosuch")).by(__.label()))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"b\",\"person\")"
    And the graph should return 0 for count of "g.V().has(\"name\",\"marko\").properties(\"a\")"

  # …and refuses a body that produces more than one map.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXout_projectXnX_byXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(__.out().project("n").by(__.values("name")))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "property(traversal) requires the traversal to produce a Map"

  # ---- one traverser at a time: where a single statement cannot stand for the reference's loop ----
  #
  # `AddPropertyStep.sideEffect` resolves a traverser's body and writes before the next traverser is
  # pulled, and a single `in()` gets no barrier (`LazyBarrierStrategy` inserts one after a SECOND flat-map),
  # so marko's second visit reads what his first wrote. A body read once for every traverser answers a
  # different question; until the write runs per traverser these REFUSE (`sequentialGuard`).

  # The second visit reads the 30.0 the first one wrote.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXsingle_age_valuesXageX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.single, "age", __.values("age").math("_+1"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"age\",31.0)"

  # …and a `list` second visit copies BOTH ages the first one left: 4, not 3.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXlist_age_valuesXageXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.list, "age", __.values("age"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 4 for count of "g.V().has(\"name\",\"marko\").properties(\"age\")"

  # A body that walks to ANOTHER element reads what an earlier traverser wrote there: josh's `knows`
  # neighbour is marko, whose age marko's own run has already made 32.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_V_hasXname_withinXmarko_joshXX_propertyXsingle_age_bothXknowsX_valuesXageX_maxX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("marko","josh")).property(Cardinality.single, "age", __.both("knows").values("age").max())
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 2 for count of "g.V().has(\"age\",32)"

  # A body that only reads OTHER keys reads the same values whichever run goes first, so it is written.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_withinXvadas_joshXX_inXknowsX_propertyXsingle_seen_valuesXageX_mathX_plus_1XX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name",within("vadas","josh")).in("knows").property(Cardinality.single, "seen", __.values("age").math("_+1"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"seen\",30.0)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"age\",29)"

  # ---- a null value is a REMOVAL (`ElementHelper.attachProperties` on a graph without null values) ----
  #
  # A null the body resolves cannot be told from "no result" by the row that carries it, so these REFUSE
  # rather than store a null — which is neither answer.

  @gap:property-traversal-site
  @Unsupported
  Scenario: g_E_hasXweight_0d5X_propertyXweight_inV_valuesXnameX_constantXnullXX
    Given the modern graph
    And the traversal of
      """
      g.E().has("weight",0.5).property("weight", __.inV().values("name").constant(null))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.E().has(\"weight\",0.5)"
    And the graph should return 5 for count of "g.E().has(\"weight\")"

  # A folded null removes what an EARLIER parameter of the same creation set, so the copy has no `n`.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_V_hasXname_markoX_addVXcX_propertyXn_aX_propertyXn_valuesXnameX_constantXnullXX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").addV("c").property("n", "a").property("n", __.values("name").constant(null))
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 0 for count of "g.V().hasLabel(\"c\").properties()"

  # ---- a CONSTANT traversal key is still a traversal key ----

  # `GraphTraversal.property` folds a `Traversal` key whatever cardinality came with it and DROPS the
  # cardinality (`PropertiesHolder.addProperty(key, value)`), so both writes are creation parameters under
  # the graph's default — the `single` is not a replace.
  @gap:property-traversal-site
  Scenario: g_addVXxX_propertyXsingle_constantXkX_aX_propertyXk_bX
    Given the empty graph
    And the traversal of
      """
      g.addV("x").property(Cardinality.single, __.constant("k"), "a").property("k", "b")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V().hasLabel(\"x\").properties(\"k\")"

  # A constant key that is not a String is refused, not folded to the text it is stored as.
  @gap:property-traversal-site
  Scenario: g_V_hasXname_markoX_propertyXconstantXUUIDX_xX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").property(__.constant(UUID("2c8e5c1e-0f1a-4d1a-9b7e-1a2b3c4d5e6f")), "x")
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "must have a String or T on even array indices"
