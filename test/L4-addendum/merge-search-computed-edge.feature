Feature: mogwai addendum — a CORRELATED mergeE search (a computed criterion per driver)

  # mergeE(__.project('k').by(__.body)) is a whole MAP-PRODUCING traversal, so MergeElementStep.materializeMap
  # runs it ONCE per driver (vendor/tinkerpop/gremlin-core/.../util/TraversalUtil.java:41-53) and searches
  # edges on the CONCRETE per-driver values (vendor/tinkerpop/.../step/map/MergeEdgeStep.java:218). A
  # `project` search map admits only STRING property keys — no Direction/T.label token key — so a computed
  # edge search narrows by PROPERTIES alone (every edge, then the computed criterion); the create's
  # endpoints and label come from option(onCreate, …). Mirrors mergeVComputed on the edge host (a per-driver
  # carrier, a decorrelated has-join, create-per-distinct, crossed(correlate=true)).

  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX0_5XX_matches
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(0.5))).values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
    And the graph should return 6 for count of "g.E()"

  # The search narrows by the computed PROPERTY, not by endpoints — every edge of weight 1.0 (marko→josh
  # and josh→ripple), not only the driver's, so one driver matches both.
  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX1_0XX_is_not_endpoint_narrowed
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(1.0))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX9_9XX_miss_creates_via_onCreate
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(9.9))).option(Merge.onCreate,[T.label:"knows",Direction.from:1,Direction.to:4]).values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9.9].d |
    And the graph should return 7 for count of "g.E()"
    And the graph should return 1 for count of "g.E().has(\"weight\",9.9)"

  # A miss with no endpoints to create is a RAISE (MergeEdgeStep reaches its endpoint check only after an
  # empty search), not a decline.
  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX9_9XX_no_endpoints_raises
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(9.9)))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Vertex not specified in onCreate"

  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_since_by_by_X_multikey_create
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight","since").by(__.constant(9.9)).by(__.constant(2020))).option(Merge.onCreate,[T.label:"knows",Direction.from:1,Direction.to:4]).values("since")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2020].i |
    And the graph should return 1 for count of "g.E().has(\"weight\",9.9).has(\"since\",2020)"

  # onMatch CONSTANT arm over the matched edge.
  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX0_5XX_optionXonMatch_noteX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(0.5))).option(Merge.onMatch,["note":"seen"]).values("note")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | seen |
    And the graph should return 6 for count of "g.E()"

  # A property() TAIL over the merge output (here a matched edge).
  @gap:merge-search-computed-edge
  Scenario: g_V_hasXname_markoX_mergeEXproject_weight_by_constantX0_5XX_propertyXtagX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(0.5))).property("tag","m").values("tag")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m |

  # DISTINCT create — two drivers, the SAME computed map but PER-DRIVER endpoints (a self loop each, via
  # option(Merge.outV/inV, __.select('d'))) create two edges: the distinct key is (src, tgt, map).
  @gap:merge-search-computed-edge
  Scenario: g_V_hasLabelXpersonX_limitX2X_mergeEXproject_weightX_per_driver_self_edges
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").limit(2).as("d").mergeE(__.project("weight").by(__.constant(9.9))).option(Merge.onCreate,[T.label:"self",Direction.from:Merge.outV,Direction.to:Merge.inV]).option(Merge.outV,__.select("d")).option(Merge.inV,__.select("d")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 2 for count of "g.E().hasLabel(\"self\")"

  # A RUNTIME edge arm value is a separate deferred feature (AddPropertyStep take-first, no cardinality),
  # so a computed mergeE whose onMatch holds a __.trav value REFUSES — never mis-executes.
  @gap:merge-search-computed-edge
  @Unsupported
  Scenario: g_V_hasXname_markoX_mergeEXproject_weightX_optionXonMatch_runtimeX_is_refused
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").mergeE(__.project("weight").by(__.constant(0.5))).option(Merge.onMatch,["note":__.values("name")])
      """
    When iterated to list
    Then the result should be empty
