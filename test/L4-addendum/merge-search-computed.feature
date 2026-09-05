Feature: mogwai addendum — a CORRELATED mergeV search (a computed criterion per driver)

  # `mergeV(__.project('k').by(__.body))` gives the merge argument as a whole MAP-PRODUCING traversal,
  # so `MergeElementStep.materializeMap` runs it at the incoming traverser
  # (vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53) and searches on the CONCRETE
  # per-driver values (vendor/tinkerpop/.../MergeElementStep.java:397-404). The search therefore VARIES
  # per driver — mergeV's input-independent cross join is the wrong correlation — so a match returns the
  # found vertex and a miss creates one vertex per DISTINCT computed map. The corpus has no computed-merge
  # scenario; these pin ours.

  @gap:merge-search-computed
  Scenario: g_V_hasLabelXpersonX_mergeVXproject_name_by_valuesXnameXX_all_match
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").mergeV(__.project("name").by(__.values("name"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | marko |
      | vadas |
      | josh  |
      | peter |
    And the graph should return 6 for count of "g.V()"

  @gap:merge-search-computed
  Scenario: g_V_hasLabelXpersonX_mergeVXproject_handle_by_valuesXnameXX_all_create
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").mergeV(__.project("handle").by(__.values("name"))).values("handle")
      """
    When iterated to list
    Then the result should be unordered
      | marko |
      | vadas |
      | josh  |
      | peter |
    And the graph should return 10 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"handle\",\"marko\")"
    And the graph should return 4 for count of "g.V().has(\"handle\")"

  @gap:merge-search-computed
  Scenario: g_V_hasXname_markoX_mergeVXproject_age_by_constantX29XX_numeric_match
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.project("age").by(__.constant(29))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | marko |
    And the graph should return 6 for count of "g.V()"

  @gap:merge-search-computed
  Scenario: g_V_hasXname_markoX_mergeVXproject_name_by_constantXstephenXX_miss_creates
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.project("name").by(__.constant("stephen"))).values("name")
      """
    When iterated to list
    Then the result should be unordered
      | stephen |
    And the graph should return 7 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"stephen\")"

  # Two drivers computing the SAME map create ONE vertex (Map.equals), carried by both traversers.
  @gap:merge-search-computed
  Scenario: g_V_hasLabelXpersonX_limitX2X_mergeVXproject_tag_by_constantXsameXX_one_create
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(2).mergeV(__.project("tag").by(__.constant("same"))).values("tag")
      """
    When iterated to list
    Then the result should be unordered
      | same |
      | same |
    And the graph should return 7 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"tag\",\"same\")"

  # A MULTI-KEY project narrows by every criterion; a miss creates a vertex carrying them all.
  @gap:merge-search-computed
  Scenario: g_V_hasXname_markoX_mergeVXproject_a_b_by_constantsX_multi_key
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeV(__.project("a","b").by(__.constant("x")).by(__.constant("y"))).values("a")
      """
    When iterated to list
    Then the result should be unordered
      | x |
    And the graph should return 7 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"a\",\"x\").has(\"b\",\"y\")"

  # A property() TAIL after a computed merge is an ordinary AddPropertyStep over the merge OUTPUT —
  # matched and created alike — and composes with the correlated search.
  @gap:merge-search-computed
  Scenario: g_V_hasLabelXpersonX_mergeVXproject_handle_by_valuesXnameXX_propertyXkind_hX_tail
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").mergeV(__.project("handle").by(__.values("name"))).property("kind","h").values("kind")
      """
    When iterated to list
    Then the result should be unordered
      | h |
      | h |
      | h |
      | h |
    And the graph should return 10 for count of "g.V()"
    And the graph should return 4 for count of "g.V().has(\"handle\").has(\"kind\",\"h\")"
