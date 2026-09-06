Feature: mogwai addendum — a GENERAL map-producing TRAVERSAL as the merge argument

  # mergeV(__.out().project(…)) / mergeV(__.select(dynMap)) — a whole map-producing traversal that is NOT a
  # leading project (the computed search) nor __.identity() (the map-valued driver). MergeElementStep
  # .materializeMap runs it at each driver and takes .next() — the FIRST map — raising "The provided
  # traverser does not map to a value" for a driver the body is unproductive on
  # (vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53). The body resolves correlated per
  # driver (childRows perRow), a record collapses to a map, and it feeds the map-valued merge driver.
  # Modern-graph ids: marko=1, vadas=2, lop=3, josh=4.

  # materializeMap takes .next() — the FIRST map — so the body is filtered to a single neighbor to keep
  # the produced map deterministic (marko knows both josh and vadas).
  @gap:merge-search-map-traversal
  Scenario: g_V_hasXname_markoX_mergeVXout_project_name_by_nameX_matches
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.out("knows").has("name","vadas").project("name").by(__.values("name"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
    And the graph should return 6 for count of "g.V()"

  @gap:merge-search-map-traversal
  Scenario: g_V_hasXname_markoX_mergeVXout_project_name_by_constant_kuzuX_creates
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.out("knows").limit(1).project("name").by(__.constant("kuzu"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | kuzu |
    And the graph should return 7 for count of "g.V()"

  # A driver the body is unproductive on raises TinkerPop's per-traverser materializeMap message.
  @gap:merge-search-map-traversal
  Scenario: g_V_hasXname_lopX_mergeVXout_project_name_by_nameX_unproductive_raises
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","lop").mergeV(__.out().project("name").by(__.values("name")))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "The provided traverser does not map to a value"

  # A multi-key produced map narrows on every key.
  @gap:merge-search-map-traversal
  Scenario: g_V_hasXname_markoX_mergeVXout_project_name_age_by_name_by_ageX_matches
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.out("knows").has("name","vadas").project("name","age").by(__.values("name")).by(__.values("age"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
    And the graph should return 6 for count of "g.V()"

  # A LEADING project is still the computed search rooted at the driver — unchanged.
  @gap:merge-search-map-traversal
  Scenario: g_V_hasXname_markoX_mergeVXproject_name_by_constant_markoX_computed_unchanged
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.project("name").by(__.constant("marko"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
    And the graph should return 6 for count of "g.V()"
