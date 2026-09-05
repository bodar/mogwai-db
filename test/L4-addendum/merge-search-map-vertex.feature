Feature: mogwai addendum — a map-VALUED mergeV driver (the traverser IS the merge map)

  # inject([k:v,…]).mergeV() / mergeV(__.identity()) — the incoming TRAVERSER is the merge map
  # (MergeElementStep.materializeMap with the identity/no-arg map traversal,
  # vendor/tinkerpop/gremlin-core/.../step/map/MergeElementStep.java:339-353). Its (key,value) entries are
  # decomposed PER DRIVER at runtime via json_each — the search key set is DATA. First sub-increment:
  # SCALAR-valued maps with STRING property keys (token keys T.label/T.id are a later sub-increment, so
  # these maps carry no label and the create takes onCreate's label or the default).

  @gap:merge-search-map-vertex
  Scenario: g_injectXname_markoX_mergeV_matches
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"marko"]).mergeV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
    And the graph should return 6 for count of "g.V()"

  @gap:merge-search-map-vertex
  Scenario: g_injectXname_markoX_mergeVXidentityX_matches
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"marko"]).mergeV(__.identity()).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
    And the graph should return 6 for count of "g.V()"

  @gap:merge-search-map-vertex
  Scenario: g_injectXname_kuzuX_mergeV_creates
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"kuzu"]).mergeV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | kuzu |
    And the graph should return 7 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"kuzu\")"

  # ALL entries must match — name matches marko but age 99 does not, so it is a miss and creates.
  @gap:merge-search-map-vertex
  Scenario: g_injectXname_marko_age_99X_mergeV_all_entries_must_match
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"marko",age:99]).mergeV().values("age")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[99].i |
    And the graph should return 7 for count of "g.V()"

  # Two drivers: marko matches (no create), stephen creates — each carries its own vertex.
  @gap:merge-search-map-vertex
  Scenario: g_injectXname_marko_name_stephenX_mergeV
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"marko"],[name:"stephen"]).mergeV().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | stephen |
    And the graph should return 7 for count of "g.V()"

  # onCreate supplies the created vertex's label and an extra constant property.
  @gap:merge-search-map-vertex
  Scenario: g_injectXname_kuzuX_mergeV_optionXonCreate_label_person_lang_gremlinX
    Given the modern graph
    And the traversal of
      """
      g.inject([name:"kuzu"]).mergeV().option(Merge.onCreate,[T.label:"person","lang":"gremlin"])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().has(\"person\",\"name\",\"kuzu\").has(\"lang\",\"gremlin\")"
