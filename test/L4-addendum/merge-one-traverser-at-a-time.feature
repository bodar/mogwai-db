Feature: mogwai addendum — a merge runs ONE TRAVERSER AT A TIME, so a later traverser sees an earlier one's write

  # `MergeVertexStep.flatMap` / `MergeEdgeStep.flatMap`
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeVertexStep.java:78-177,
  #  vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/MergeEdgeStep.java:255-338)
  # search, then `peek(onMatch)` over what was found, else create — PER incoming traverser, against the graph
  # as every earlier traverser left it. So over several traversers the first may CREATE and the rest MATCH that
  # creation and run onMatch on it; an onMatch that rewrites a searched key hides the element from the next
  # traverser; a list append (onMatch or the property() tail, `AddPropertyStep` per traverser) lands once per
  # traverser. The set-based merge searches once for every driver, so it cannot model that interleaving: each
  # scenario below states the REFERENCE answer and is @Unsupported — it must refuse (guardMergeInterleaving,
  # src/compiler/rel/write.ts), never answer the snapshot's question. The trailing scenarios are the cases
  # that interleaving cannot change, which must keep answering — and, last, the shared-creation onMatch the
  # set-based form answers exactly (shareOnMatch).

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_2X_values_m_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:2]).values("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",1).has(\"m\",2)"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2X_optionXonCreate_w_1X_optionXonMatch_w_2X_values_w
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onCreate,[w:1]).option(Merge.onMatch,[w:2]).values("w")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |
      | d[2].i |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",2)"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2X_optionXonMatch_w_2X_values_w_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onMatch,[w:2]).values("w").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",2)"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXproject_name_by_constant_zzX_optionXonMatch_m_2X_values_m_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV(__.project("name").by(__.constant("zz"))).option(Merge.onMatch,[m:2]).values("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"m\",2)"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeEXproject_weight_by_constant_9X_optionXonCreate_k_1_2X_optionXonMatch_q_2X_values_q_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE(__.project("weight").by(__.constant(9))).option(Merge.onCreate,[(T.label):"k",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onMatch,[q:2]).values("q").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"k\").has(\"q\",2)"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectXmap_mapX_mergeE_optionXonCreate_w_1X_optionXonMatch_w_2X_values_w
    Given the modern graph
    And the traversal of
      """
      g.inject([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2],[(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).mergeE().option(Merge.onCreate,[w:1]).option(Merge.onMatch,[w:2]).values("w")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",2)"

  # A mid-chain driver — the multi-row inject is not the only route to several traversers.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_VX1_2X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_2X_values_m_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:2]).values("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"m\",2)"

  # Inside a union arm — the same authority, one depth down.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXmergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_2XX_values_m_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:2])).values("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"m\",2)"

  # An onMatch that rewrites the SEARCHED key hides the element from the next traverser, which then creates:
  # marko → zz, a new marko, that marko → zz.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_markoX_optionXonMatch_name_zzX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"marko"]).option(Merge.onMatch,[name:"zz"]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 2 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 0 for count of "g.V().has(\"name\",\"marko\")"

  # A list append runs once per traverser — onMatch and the property() tail alike.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_markoX_optionXonMatch_m_listX2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"marko"]).option(Merge.onMatch,[m:Cardinality.list(2)]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 3 for count of "g.V().has(\"name\",\"marko\").properties(\"m\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_markoX_propertyXlist_m_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"marko"]).property(list,"m",2).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 3 for count of "g.V().has(\"name\",\"marko\").properties(\"m\")"

  # A vertex write that names NO cardinality APPENDS here (the element's default), so it repeats per traverser
  # exactly like an explicit list write — onMatch (MergeVertexStep.java:129 writes per traverser through the
  # default cardinality) and the property() tail (AddPropertyStep.java:94) alike. Traverser 1 creates zz,
  # 2 and 3 match it, and the tail appends once per traverser.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_propertyXtag_xX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).property("tag","x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 3 for count of "g.V().has(\"name\",\"zz\").properties(\"tag\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXmergeVXname_zzX_propertyXtag_xXX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.mergeV([name:"zz"]).property("tag","x")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 3 for count of "g.V().has(\"name\",\"zz\").properties(\"tag\")"

  # The default-cardinality tail appends to the SEARCHED key; name stays multi-valued and still holds zz, so
  # every later traverser matches the one vertex and appends again: [zz,yy,yy,yy].
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_propertyXname_yyX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).property("name","yy").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"yy\")"
    And the graph should return 4 for count of "g.V().has(\"name\",\"yy\").properties(\"name\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_VX1_2X_mergeVXname_markoX_optionXonMatch_age_30X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).mergeV([name:"marko"]).option(Merge.onMatch,[age:30]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 3 for count of "g.V().has(\"name\",\"marko\").properties(\"age\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_V_mergeVXname_markoX_optionXonMatch_m_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V().mergeV([name:"marko"]).option(Merge.onMatch,[m:2]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
    And the graph should return 6 for count of "g.V().has(\"name\",\"marko\").properties(\"m\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_markoX_optionXonMatch_m_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"marko"]).option(Merge.onMatch,[m:2]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 3 for count of "g.V().has(\"name\",\"marko\").properties(\"m\")"

  # A SINGLE tail write to a searched key: the pipeline is lazy (LazyBarrierStrategy puts no NoOpBarrierStep
  # after the merge), so traverser 1 renames zz to yy before traverser 2 searches, misses, and creates again.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_propertyXsingle_name_yyX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).property(single,"name","yy").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 3 for count of "g.V().has(\"name\",\"yy\")"
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\")"

  # ── What interleaving cannot change, which must keep answering ──

  # Three misses, ONE creation carried by all three, no onMatch to run on it.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_optionXonCreate_c_1X_values_c
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).values("c")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[1].i |
      | d[1].i |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"

  # A pre-existing match and an idempotent (SINGLE) onMatch: every traverser sees the same element and writes the same.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_markoX_optionXonMatch_m_single_2X_values_m
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"marko"]).option(Merge.onMatch,[m:Cardinality.single(2)]).values("m")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].i |
      | d[2].i |
      | d[2].i |
    And the graph should return 1 for count of "g.V().has(\"name\",\"marko\").properties(\"m\")"

  # A SINGLE tail write to an unsearched key: one creation, three idempotent writes.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_propertyXsingle_tag_xX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).property(single,"tag","x").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").properties(\"tag\")"

  # An EDGE property is single by spec, so an unstated-cardinality edge tail is idempotent.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2X_propertyXw_3X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).property("w",3).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\")"
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",3)"

  # Per-driver endpoints in the search: no driver can find another's creation, so onMatch never runs.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_VX1_2X_asXvX_mergeEXself_outV_inVX_optionXonMatch_w_2X_optionXoutV_select_vX_optionXinV_select_vX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).as("v").mergeE([(T.label):"self",(Direction.OUT):Merge.outV,(Direction.IN):Merge.inV]).option(Merge.onMatch,[w:2]).option(Merge.outV,__.select("v")).option(Merge.inV,__.select("v")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 2 for count of "g.E().hasLabel(\"self\")"
    And the graph should return 0 for count of "g.E().hasLabel(\"self\").has(\"w\")"

  # ANOTHER WRITE IN THE PROGRAM interleaves too (guardMergeInterleaving rule (0), mergeObservesOtherWrites).
  # The reference pipeline is lazy: a merge is a FlatMapStep, LazyBarrierStrategy inserts no NoOpBarrierStep
  # after the first flat-map and none at all in a traversal holding a DropStep
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/strategy/optimization/LazyBarrierStrategy.java,
  # the hasStepOfAssignableClass(DropStep.class, …) early return in apply), and a single-arm union hands its
  # arm one start at a time (…/process/traversal/step/branch/BranchStep.java, standardAlgorithm). So traverser
  # 1 runs every LATER write before traverser 2 searches, and traverser 2 runs every EARLIER write after
  # traverser 1 merged. Here each later search misses once the earlier traverser dropped the searched key.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_propertiesXnameX_drop
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).properties("name").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 9 for count of "g.V()"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_properties_drop
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).properties().drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 9 for count of "g.V()"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_VX1_2X_mergeVXname_zzX_propertiesXnameX_drop
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).mergeV([name:"zz"]).properties("name").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 8 for count of "g.V()"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXmergeVXname_zzXX_propertiesXnameX_drop
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.mergeV([name:"zz"])).properties("name").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 9 for count of "g.V()"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2_w_1X_propertiesXwX_drop
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2,w:1]).properties("w").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 3 for count of "g.E().hasLabel(\"zz\")"

  # An EARLIER write: traverser 1 adds and merges (finds 1), traverser 2 adds and merges (finds 2).
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2X_addVXpX_propertyXname_zzX_mergeVXname_zzX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).addV("p").property("name","zz").mergeV([name:"zz"]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 2 for count of "g.V().has(\"name\",\"zz\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2X_addEXzzX_fromXV1X_toXV2X_mergeEXzz_1_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2).addE("zz").from(__.V(1)).to(__.V(2)).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 2 for count of "g.E().hasLabel(\"zz\")"

  # Controls: a later write the search cannot observe (an edge creation under a VERTEX search, a vertex
  # property under an EDGE search), and one traverser, keep answering.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_addEXkX_toXV1X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).addE("k").to(__.V(1)).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 3 for count of "g.E().hasLabel(\"k\")"

  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2X_inV_propertyXname_yyX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).inV().property(single,"name","yy").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\")"
    And the graph should return 1 for count of "g.V().has(\"name\",\"yy\")"

  @gap:merge-one-traverser-at-a-time
  Scenario: g_VX1X_mergeVXname_zzX_propertiesXnameX_drop
    Given the modern graph
    And the traversal of
      """
      g.V(1).mergeV([name:"zz"]).properties("name").drop()
      """
    When iterated to list
    Then the result should be empty
    And the graph should return 7 for count of "g.V()"

  # A CREATION SHARED BY LATER TRAVERSERS, answered set-based (shareOnMatch, src/compiler/rel/write.ts): the
  # first traverser creates, every later one whose search finds that creation runs onMatch over it
  # (MergeVertexStep.java:78-116 / MergeEdgeStep.java:255-292). An IDEMPOTENT onMatch (a stated single, or any
  # edge write) that NO step reads leaves one final state however many later traversers ran it, so it is applied
  # once over each creation a second traverser shares. The lazy-read forms above (values("m") after the merge)
  # stay refused: the first traverser reads before the second one matches.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 7 for count of "g.V()"
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",1).has(\"m\",2)"

  @gap:merge-one-traverser-at-a-time
  Scenario: g_VX1_2X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",1).has(\"m\",2)"

  # One depth down — a union arm over a distinct, unbulked stream.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_unionXmergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",1).has(\"m\",2)"

  # onMatch BEFORE the property() tail, per traverser: the tail's single write is the last one each time.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_c_single_2X_propertyXsingle_c_7X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[c:Cardinality.single(2)]).property(single,"c",7).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",7)"
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").properties(\"c\")"

  @gap:merge-one-traverser-at-a-time
  Scenario: g_injectX1_2_3X_mergeEXzz_1_2X_optionXonCreate_w_1X_optionXonMatch_w_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onCreate,[w:1]).option(Merge.onMatch,[w:2]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\")"
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",2)"

  # Per-traverser pairs: lop (3) is reached three times and its self edge is matched twice; ripple (5) once.
  @gap:merge-one-traverser-at-a-time
  Scenario: g_VX1_4_6X_outXcreatedX_asXvX_mergeEXself_outV_inVX_optionXonCreate_w_1X_optionXonMatch_w_2X_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,4,6).out("created").as("v").mergeE([(T.label):"self",(Direction.OUT):Merge.outV,(Direction.IN):Merge.inV]).option(Merge.onCreate,[w:1]).option(Merge.onMatch,[w:2]).option(Merge.outV,__.select("v")).option(Merge.inV,__.select("v")).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
    And the graph should return 2 for count of "g.E().hasLabel(\"self\")"
    And the graph should return 1 for count of "g.V(3).outE(\"self\").has(\"w\",2)"
    And the graph should return 1 for count of "g.V(5).outE(\"self\").has(\"w\",1)"

  # A MERGED SLOT is one traverser: inject(1,1,1) drains into ONE bulk-3 traverser (StartStep adds into a
  # TraverserSet), so the merge's flatMap runs once — it creates and never runs onMatch. Rows are not
  # traversers here, so the shared onMatch is refused (shareOnMatch needs an unbulked stream, unbulkedAt).
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_1_1X_mergeVXname_zzX_optionXonMatch_m_single_2X_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,1,1).mergeV([name:"zz"]).option(Merge.onMatch,[m:Cardinality.single(2)]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\")"
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  # The onMatch key READ downstream: the first traverser passes has("m") (no m yet) before the second one
  # matches — no barrier sits between a filter and the merge — so the shared onMatch is refused
  # (ProgramWrites.reads).
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_mergeVXname_zzX_optionXonMatch_m_single_2X_hasXmX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).mergeV([name:"zz"]).option(Merge.onMatch,[m:Cardinality.single(2)]).has("m").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A BARRIER INSIDE A BRANCH ARM merges what came from DIFFERENT starts. With a Barrier in any arm the
  # BranchStep sets hasBarrier and pushes EVERY start into the arm before reading anything back
  # (BranchStep.java:87-88, 143-148), so constant(1) makes three equal traversers and barrier()/order()/
  # aggregate() collects them through a TraverserSet into ONE of bulk 3. The merge's flatMap then runs once:
  # it creates c:1 and never runs onMatch — the vertex has no m. An arm-major arm is a child fed all its
  # starts at once (ChainCtx.traversal.allStarts), not one parent traverser, so unbulkedAt says bulked here
  # and the shared onMatch is refused, never applied.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXconstantX1X_barrier_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.constant(1).barrier().mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.V().has(\"name\",\"zz\").has(\"c\",1)"
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXconstantX1X_order_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.constant(1).order().mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXconstantX1X_aggregateXaX_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.constant(1).aggregate("a").mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  # Two depths down: the outer union holds the inner one's barrier recursively, so it too is arm-major.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXunionXconstantX1X_barrier_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XXX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.union(__.constant(1).barrier().mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)]))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  # An element-valued start stream, and a sample() as the collecting barrier.
  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_VX1_2_4X_unionXconstantX1X_sampleX5X_mergeVXname_zzX_optionXonCreate_c_1X_optionXonMatch_m_single_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1,2,4).union(__.constant(1).sample(5).mergeV([name:"zz"]).option(Merge.onCreate,[c:1]).option(Merge.onMatch,[m:Cardinality.single(2)])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 0 for count of "g.V().has(\"name\",\"zz\").has(\"m\")"

  @gap:merge-one-traverser-at-a-time
  @Unsupported
  Scenario: g_injectX1_2_3X_unionXconstantX1X_barrier_mergeEXzz_1_2X_optionXonCreate_w_1X_optionXonMatch_w_2XX_count
    Given the modern graph
    And the traversal of
      """
      g.inject(1,2,3).union(__.constant(1).barrier().mergeE([(T.label):"zz",(Direction.OUT):1,(Direction.IN):2]).option(Merge.onCreate,[w:1]).option(Merge.onMatch,[w:2])).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
    And the graph should return 1 for count of "g.E().hasLabel(\"zz\").has(\"w\",1)"
