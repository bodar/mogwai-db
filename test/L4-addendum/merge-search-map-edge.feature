Feature: mogwai addendum — a map-VALUED mergeE driver (the traverser IS the merge map)

  # inject([T.label:…,(OUT):…,(IN):…]).mergeE() / mergeE(__.identity()) / select("m").mergeE() — the
  # incoming TRAVERSER is the merge map (MergeElementStep.materializeMap with the identity/no-arg map
  # traversal, vendor/tinkerpop/gremlin-core/.../step/map/MergeElementStep.java:339-353). Its entries are
  # decomposed PER DRIVER at runtime via json_each over MAP_COL — so the search (label, endpoints AND
  # property criteria) is DATA (MergeEdgeStep.searchEdges, .java:162-223). A miss creates one edge per
  # DISTINCT (src, tgt, map); a create needs both endpoints (else "Out/In Vertex not specified in
  # onCreate", .java:313-316) and resolves each endpoint external id to a vertex (else "Vertex does not
  # exist for mergeE", .java:398-409). Modern-graph ids: marko=1, vadas=2, lop=3, josh=4.

  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_vadasX_mergeE_matches
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):2]).mergeE().values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
    And the graph should return 6 for count of "g.E()"

  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_vadasX_mergeEXidentityX_matches
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):2]).mergeE(__.identity()).values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
    And the graph should return 6 for count of "g.E()"

  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_likes_out_marko_in_vadasX_mergeE_creates
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"likes",(OUT):1,(IN):2]).mergeE().label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | likes |
    And the graph should return 7 for count of "g.E()"
    And the graph should return 1 for count of "g.E().hasLabel(\"likes\")"

  # A property criterion narrows the search: weight 0.9 does not match the stored 0.5 knows edge, so a
  # second knows edge is created and its stored value is 0.9.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_vadas_weight_09X_mergeE_property_narrows
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):2,"weight":0.9]).mergeE().values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.9].d |
    And the graph should return 7 for count of "g.E()"

  # A matching property value matches the existing edge and creates nothing.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_vadas_weight_05X_mergeE_matches
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):2,"weight":0.5]).mergeE().values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
    And the graph should return 6 for count of "g.E()"

  # A create writes the map's string properties onto the new edge.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_rated_out_marko_in_josh_stars_5X_mergeE_creates_with_properties
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"rated",(OUT):1,(IN):4,"stars":5]).mergeE().values("stars")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
    And the graph should return 7 for count of "g.E()"

  # An endpoint that names no vertex raises the reference's per-traverser message.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_99X_mergeE_missing_vertex_raises
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):99]).mergeE()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Vertex does not exist for mergeE"

  # A map missing an endpoint raises before creating (search misses, no endpoints to create).
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_likes_in_vadasX_mergeE_no_out_raises
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"likes",(IN):2]).mergeE()
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Out Vertex not specified in onCreate"

  # Two identical drivers create ONE edge and both carry it (Distinct over (src, tgt, map)).
  @gap:merge-search-map-edge
  Scenario: g_injectXtwo_identicalX_mergeE_creates_one
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"likes",(OUT):1,(IN):2],[(T.label):"likes",(OUT):1,(IN):2]).mergeE().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 7 for count of "g.E()"

  # option(onCreate) adds constant properties on the create path.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_likes_out_marko_in_vadasX_mergeE_optionXonCreate_since_2020X
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"likes",(OUT):1,(IN):2]).mergeE().option(Merge.onCreate,["since":2020]).values("since")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2020].i |

  # option(onMatch) writes over the matched edge; no create happens.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_knows_out_marko_in_vadasX_mergeE_optionXonMatch_touched_1X
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"knows",(OUT):1,(IN):2]).mergeE().option(Merge.onMatch,["touched":1]).values("touched")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
    And the graph should return 6 for count of "g.E()"

  # A property() tail runs over the merged edge.
  @gap:merge-search-map-edge
  Scenario: g_injectXlabel_likes_out_marko_in_vadasX_mergeE_property_tail
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"likes",(OUT):1,(IN):2]).mergeE().property("extra","y").values("extra")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | y |

  # A withSideEffect CONSTANT map read by select("m") feeds the map-valued merge driver — the corpus's
  # own select("m").mergeE() shape (g_withSideEffectXlabel_knows_out_marko_in_vadasX_injectX1X_selectXmX_mergeE).
  @gap:merge-search-map-edge
  Scenario: g_withSideEffectXmX_injectX1X_selectXmX_mergeE_matches
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("m",[(T.label):"knows",(OUT):1,(IN):2]).inject(1).select("m").mergeE().values("weight")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0.5].d |
    And the graph should return 6 for count of "g.E()"

  @gap:merge-search-map-edge
  Scenario: g_withSideEffectXmX_injectX1X_selectXmX_mergeE_creates
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("m",[(T.label):"likes",(OUT):1,(IN):2]).inject(1).select("m").mergeE().label()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | likes |
    And the graph should return 7 for count of "g.E()"
