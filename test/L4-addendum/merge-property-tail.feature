Feature: mogwai addendum — a property() tail after mergeV/mergeE

  # `mergeV(map).property(k, v)` is not a merge feature: it is an ordinary AddPropertyStep over
  # whatever the merge emitted, matched or created alike. So it must behave exactly as a
  # `g.V(…).property(…)` tail does — same cardinality resolution, same meta-properties, same
  # correlated traversal values — and it must run on BOTH merge branches.
  #
  # The official corpus reaches the matched branch with a meta-property and the list-cardinality
  # form; the created branch, the mergeE host and a correlated traversal value are unpinned upstream.

  @gap:merge-property-tail
  @Unsupported
  Scenario: g_mergeVXlabel_person_name_markoX_propertyXname_vadas_acl_publicX_matched
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").property("age", 29)
      """
    And the traversal of
      """
      g.mergeV([(T.label): "person", "name": "marko"]).property("name", "vadas", "acl", "public")
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V()"
    And the graph should return 2 for count of "g.V().properties(\"name\")"
    And the graph should return 1 for count of "g.V().properties(\"name\").has(\"acl\",\"public\")"

  @gap:merge-property-tail
  Scenario: g_mergeVXlabel_person_name_stephenX_propertyXage_19X_created
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").property("age", 29)
      """
    And the traversal of
      """
      g.mergeV([(T.label): "person", "name": "stephen"]).property("age", 19)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 2 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"stephen\").has(\"age\",19)"

  # The tail's value resolves at the MERGED element, not at the incoming driver.
  @gap:merge-property-tail
  Scenario: g_V_mergeVXlabel_person_name_markoX_propertyXdeg_bothE_countX
    Given the modern graph
    And the traversal of
      """
      g.mergeV([(T.label): "person", "name": "marko"]).property(Cardinality.single, "deg", __.bothE().count())
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").has(\"deg\",3)"

  @gap:merge-property-tail
  Scenario: g_mergeE_propertyXweightX_on_both_branches
    Given the modern graph
    And the traversal of
      """
      g.mergeE([T.label: "knows", Direction.from: 1, Direction.to: 2]).property("since", 2009)
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 6 for count of "g.E()"
    And the graph should return 1 for count of "g.E().has(\"since\",2009)"

  # An edge property has neither cardinality nor meta, so both are refusals in a mergeE tail — the
  # same rule the inline addE/property() path enforces, reached through the same guard.
  @gap:merge-property-tail
  @Unsupported
  Scenario: g_mergeE_propertyXlist_weightX_is_refused
    Given the modern graph
    And the traversal of
      """
      g.mergeE([T.label: "knows", Direction.from: 1, Direction.to: 2]).property(Cardinality.list, "since", 2009)
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Cardinality is not valid on an edge property"
