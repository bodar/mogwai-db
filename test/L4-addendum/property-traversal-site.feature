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

  # THE LOOP IS THE WHOLE LAZY PIPELINE, NOT ONE STEP. With no barrier between them (`LazyBarrierStrategy`
  # adds none after a short id source or a single flat-map, `LazyBarrierStrategy.java:93-125`), traverser 1
  # runs through EVERY mutating step before traverser 2's body in an earlier one resolves. Here the second
  # knows-edge's body counts the `b` the first edge's run has already written by the LATER step: one
  # edge gets 0, the other 1 — where a plan that runs each step for every traverser gives 0 to both.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1X_outEXknowsX_propertyXa_outV_outE_valuesXbX_countX_propertyXb_1X
    Given the modern graph
    And the traversal of
      """
      g.V(1).outE("knows").property("a", __.outV().outE().values("b").count()).property("b", 1)
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.E().has(\"a\",0)"
    And the graph should return 1 for count of "g.E().has(\"a\",1)"

  # The same race through the MAP form: vadas's body re-sources marko after marko's run wrote `b`.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_propertyXprojectXkX_byXV1_valuesXbX_countXX_propertyXb_xX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property(__.project("k").by(__.V(1).values("b").count())).property("b","x")
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"k\",0)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"vadas\").has(\"k\",1)"

  # …and through a runtime KEY.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_propertyXconstantXkX_V1_valuesXbX_countX_propertyXb_xX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property(__.constant("k"), __.V(1).values("b").count()).property("b","x")
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"k\",0)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"vadas\").has(\"k\",1)"

  # An EARLIER step's key, read on another element: marko's body runs before vadas's `m` exists, so
  # marko counts 0 — a plan that writes every `m` first counts vadas's.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_propertyXm_xX_propertyXc_out_valuesXmX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property("m","x").property("c", __.out().values("m").count())
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 2 for count of "g.V().has(\"c\",0)"

  # A later traverser's CREATION: the first new vertex counts itself, the second counts both.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_addVXxX_propertyXsingle_n_V_hasLabelXxX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).addV("x").property(Cardinality.single, "n", __.V().hasLabel("x").count())
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"n\",1)"
    And the graph should return 1 for count of "g.V().has(\"n\",2)"

  # A body that reads only its own element's keys, written by its own run, IS the loop: written.
  @gap:property-traversal-site
  Scenario: g_VX1_2X_propertyXa_valuesXnameXX_propertyXb_valuesXaXX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property("a", __.values("name")).property("b", __.values("a"))
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"b\",\"marko\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"vadas\").has(\"b\",\"vadas\")"

  # A LABEL MUTATION races the same way, and every spelling of a label read sees it. The multi-label
  # `labels()` (`LabelsStep`): the first knows-edge counts marko's one label, then marko gains `z` through
  # the later `addLabel` before the second edge's body runs — 1 and 2, not 1 and 1.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1X_outEXknowsX_propertyXn_outV_labels_countX_outV_addLabelXzX
    Given the modern graph
    And the traversal of
      """
      g.V(1).outE("knows").property("n", __.outV().labels().count()).outV().addLabel("z")
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.E().has(\"n\",1)"
    And the graph should return 1 for count of "g.E().has(\"n\",2)"

  # The three-argument `has(label, key, value)` reads the label too (`HasStep` with a `T.label` container):
  # marko's body finds no `z` vertex, then marko becomes one before vadas's body runs — 0 and 1.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_propertyXn_V_hasXz_name_markoX_countX_addLabelXzX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property("n", __.V().has("z","name","marko").count()).addLabel("z")
      """
    When iterated to list
    Then the result should have a count of 2
    And the graph should return 1 for count of "g.V().has(\"n\",0)"
    And the graph should return 1 for count of "g.V().has(\"n\",1)"

  # An UPSTREAM write behind a FILTER: the reference pulls vadas through `addLabel` only after marko has
  # gone through the site (lazy pull — no barrier for a short id source, `LazyBarrierStrategy.java:93-125`),
  # so marko counts ONE `z` vertex. The site's host is one row; the upstream write's stream is two.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_addLabelXzX_hasXname_markoX_propertyXn_V_hasLabelXzX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).addLabel("z").has("name","marko").property("n", __.V().hasLabel("z").count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"n\",1)"

  # …a `limit` after the upstream `property`: `EarlyLimitStrategy` (a default) moves it before the write
  # (`V(1,2).limit(1).property("a",1)…`, `strategy/optimization/EarlyLimitStrategy.java` `apply`), so only
  # marko is written and his body reads 1, not 2.
  @gap:property-traversal-site
  Scenario: g_VX1_2X_propertyXa_1X_limitX1X_propertyXn_V_valuesXaX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).property("a",1).limit(1).property("n", __.V().values("a").count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"n\",1)"

  # A CREATION upstream, the traverser re-selected behind it: marko's body sees only marko's new vertex.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_VX1_2X_asXsX_addVXxX_selectXsX_hasXname_markoX_propertyXn_V_hasLabelXxX_countX
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).as("s").addV("x").select("s").has("name","marko").property("n", __.V().hasLabel("x").count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"n\",1)"

  # A WRITE IN A UNION ARM: `BranchStep` drains its options one at a time, lazily
  # (`BranchStep.java:123-153`), so the first arm's vertex runs through `limit` and the site before the
  # second arm's `addV` runs — the body counts ONE `x`. The branch's input is one traverser; its writes ran
  # twice.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_unionXaddVXxX_addVXxXX_limitX1X_propertyXn_V_hasLabelXxX_countX
    Given the empty graph
    And the traversal of
      """
      g.union(__.addV("x"), __.addV("x")).limit(1).property("n", __.V().hasLabel("x").count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"n\",1)"

  # The same with the write over an ARM-INTERNAL stream: marko leaves the arm and goes through the site
  # before vadas is labelled.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_unionXV_1_2_addLabelXzXX_hasXname_markoX_propertyXn_V_hasLabelXzX_countX
    Given the modern graph
    And the traversal of
      """
      g.union(__.V(1,2).addLabel("z")).has("name","marko").property("n", __.V().hasLabel("z").count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"n\",1)"

  # A LITERAL id is no shield against a creation of the SAME kind: ids are sequential rowids, so on the
  # modern graph the next vertices are 7 and 8 and `V(8)` is the SECOND traverser's creation. The reference
  # runs traverser 1 to the site before traverser 2 creates: n = 0, then 1. One statement gave 1 to both.
  @gap:property-traversal-site
  @Unsupported
  Scenario: g_injectX1_2X_addVXxX_identity_propertyXn_VX8X_countX_valuesXnX
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).addV("x").identity().property("n", __.V(8).count()).values("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |
      | d[1].l |

  # An id that named a vertex BEFORE the program ran names no new one, so the same shape over `V(1)` answers.
  @gap:property-traversal-site
  Scenario: g_injectX1_2X_addVXxX_identity_propertyXn_VX1X_countX_valuesXnX
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).addV("x").identity().property("n", __.V(1).count()).values("n")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |

  # An addE endpoint traversal that yields nothing is `TraversalUtil.apply`'s refusal, rethrown naming the
  # side (`AddEdgeStepContract.getAdjacentVertex`) — not SQLite's NOT NULL constraint on the edge's end.
  @gap:property-traversal-site
  Scenario: g_VX1X_addEXeX_toXV_99X
    Given the modern graph
    And the traversal of
      """
      g.V(1).addE("e").to(__.V(99))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "addE(e) failed because the to() traversal (which should give a Vertex) failed with: The provided traverser does not map to a value"
