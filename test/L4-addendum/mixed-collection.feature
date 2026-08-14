Feature: mogwai addendum — a named collection filled by sites of DIFFERENT member kinds

  # `aggregate("a")` RETAINS the traversers under a label and passes them through, so ANY two chain
  # positions can fill one label — a vertex site beside an edge site, an element site beside a value
  # site. The side effect lives on the ROOT traversal, so the label holds BOTH sites' members as one
  # BulkSet multiset (AggregateStep.java:57, processAllStarts drains each site's traversers in), and
  # `cap("a")` returns the whole set. The members are heterogeneous, so the collection is a MIXED one:
  # each member is a self-describing {t,v} node, framed by its own kind at the wire.
  #
  # The official corpus never mixes kinds into one label directly — its multi-site aggregate scenarios
  # use edge steps only as MOVEMENTS between vertex sites (…outE().inV().aggregate…), so the label
  # stays homogeneous. But a mixed label is valid Gremlin and single-pass SQL expresses it, so it is in
  # scope by logical completeness (legality-not-corpus-defines-support). @gap:mixed-collection marks it.
  #
  # Downstream of `cap("a").unfold()` the stream is heterogeneous — a vertex on one row, an edge on the
  # next — so it has no uniform continuation and is TERMINAL, exactly as a branch VARIANT is; a
  # follower (count/dedup/movement) declines rather than answering plausibly. See
  # test/compiler/mixed-collection.exec.test.ts for the terminal `cap("a")` list form and count(local).

  @gap:mixed-collection
  Scenario: g_V_aggregateXaX_outE_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().aggregate("a").outE().aggregate("a").cap("a").unfold()
      """
    # site 1 = all 6 vertices; site 2 = every vertex's out-edges (the 6 modern-graph edges). `outE()`
    # is a movement between the two aggregates, so the label holds 6 vertices AND 6 edges.
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |
      | v[vadas] |
      | v[lop] |
      | v[josh] |
      | v[ripple] |
      | v[peter] |
      | e[marko-knows->vadas] |
      | e[marko-knows->josh] |
      | e[marko-created->lop] |
      | e[josh-created->ripple] |
      | e[josh-created->lop] |
      | e[peter-created->lop] |

  @gap:mixed-collection
  Scenario: g_withSideEffectXa_1_2_3_addAllX_V_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("a", [1i,2i,3i], Operator.addAll).V().aggregate("a").cap("a").unfold()
      """
    # addAll([1,2,3], bulkSetOfVertices) = [1,2,3, v…]: the seed's items are ints and the members are
    # vertices, so the label is mixed and the seed prepends as site 0. TinkerPop's own scenarios only
    # ever seed a SCALAR-membered label; this is the same rule with a heterogeneous result.
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |
      | d[2].i |
      | d[3].i |
      | v[marko] |
      | v[vadas] |
      | v[lop] |
      | v[josh] |
      | v[ripple] |
      | v[peter] |

  @gap:mixed-collection
  Scenario: g_V_aggregateXaX_valuesXnameX_aggregateXaX_capXaX_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().aggregate("a").values("name").aggregate("a").cap("a").unfold()
      """
    # an ELEMENT site beside a VALUE site: 6 vertices, then their 6 names as strings.
    When iterated to list
    Then the result should be unordered
      | result |
      | v[marko] |
      | v[vadas] |
      | v[lop] |
      | v[josh] |
      | v[ripple] |
      | v[peter] |
      | marko |
      | vadas |
      | lop |
      | josh |
      | ripple |
      | peter |
