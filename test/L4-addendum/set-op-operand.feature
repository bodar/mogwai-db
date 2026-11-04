Feature: mogwai addendum — a set op's operand is one value, read once, whatever form it is written in

  # The operand is TraversalUtil.apply's FIRST result (ListFunction.convertTraversalToCollection,
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/util/ListFunction.java),
  # lowered once as a relation and joined. `__.constant(c)` is the literal `c` it yields.

  Scenario: g_injectXlist_1_2X_mergeXconstantXlist_aXX
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2]).merge(__.constant(["a"]))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[d[1].i,d[2].i,a] |

  # The Map merge reads the same operand the same way: a List constant is not a Map.
  Scenario: g_injectXmap_a_1X_mergeXconstantXlist_aXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["a": 1]).merge(__.constant(["a"]))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "merge step expected provided argument to evaluate to a Map, encountered"

  Scenario: g_injectXlist_1_2X_mergeXconstantXmap_b_2XX
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2]).merge(__.constant(["b": 2]))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Provided traversal argument for merge step must yield an iterable type, encountered"

  # A scalar never equals an element (Object.equals across classes), so the cross-kind intersect is empty
  # and the cross-kind difference is the self's distinct members.
  Scenario: g_injectXlist_1_2X_intersectXV_foldX
    Given the modern graph
    And the traversal of
      """
      g.inject([1, 2]).intersect(__.V().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[] |

  Scenario: g_injectXlist_1_2_2X_differenceXV_foldX
    Given the modern graph
    And the traversal of
      """
      g.inject([1, 2, 2]).difference(__.V().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[d[1].i,d[2].i] |

  # A vertex never equals an edge (ElementHelper.areEqual demands the same class).
  Scenario: g_V_fold_differenceXE_foldX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().fold().difference(__.E().fold()).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_fold_intersectXlist_1X_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().fold().intersect([1]).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |

  # One operand relation serves every list row of the stream.
  Scenario: g_V_localXvaluesXnameX_foldX_intersectXV_hasXage_gtX30XX_valuesXnameX_foldX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().local(__.values("name").fold()).intersect(__.V().has("age", P.gt(30)).values("name").fold()).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[0].l |
      | d[0].l |
      | d[0].l |
      | d[1].l |
      | d[0].l |
      | d[1].l |

  Scenario: g_V_valuesXnameX_fold_disjunctXV_hasXage_gtX30XX_valuesXnameX_foldX_orderXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().disjunct(__.V().has("age", P.gt(30)).values("name").fold()).order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop,marko,ripple,vadas] |

  Scenario: g_V_valuesXnameX_fold_intersectXV_valuesXnameX_foldX_intersectXV_hasXage_ltX30XX_valuesXnameX_foldX_orderXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().intersect(__.V().values("name").fold()).intersect(__.V().has("age", P.lt(30)).values("name").fold()).order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,vadas] |

  Scenario: g_V_valuesXnameX_fold_productXV_hasXage_gtX30XX_valuesXnameX_foldX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().product(__.V().has("age", P.gt(30)).values("name").fold()).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[12].l |

  # A PER-ROW-typed operand is decided on its first result: a stored List is the operand.
  Scenario: g_injectXlist_a_b_xX_intersectXV_hasXname_yX_valuesXtagsXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("t").property("name", "x").property("tags", "solo").addV("t").property("name", "y").property("tags", ["b", "c", "d"])
      """
    And the traversal of
      """
      g.inject(["a", "b", "x"]).intersect(__.V().has("name", "y").values("tags"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[b] |

  Scenario: g_injectXlist_a_b_xX_differenceXV_hasXname_yX_valuesXtagsXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("t").property("name", "y").property("tags", ["b", "c", "d"])
      """
    And the traversal of
      """
      g.inject(["a", "b", "x"]).difference(__.V().has("name", "y").values("tags")).order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[a,x] |

  # ...and a first result that is not a collection is the reference's error, raised for that row.
  Scenario: g_injectXlist_a_b_xX_intersectXV_hasXname_xX_valuesXtagsXX
    Given the empty graph
    And the graph initializer of
      """
      g.addV("t").property("name", "x").property("tags", "solo")
      """
    And the traversal of
      """
      g.inject(["a", "b", "x"]).intersect(__.V().has("name", "x").values("tags"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Provided traversal argument for intersect step must yield an iterable type, encountered"

  Scenario: g_V_valuesXnameX_fold_intersectXV_valuesXnameXX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().intersect(__.V().values("name"))
      """
    When iterated to list
    Then the traversal will raise an error with message containing text of "Provided traversal argument for intersect step must yield an iterable type, encountered"

  # A nested collection member has no scalar member encoding in a set op yet, so it is refused rather than
  # read back as the String spelling its JSON.
  @Unsupported
  Scenario: g_injectXlist_1_2X_mergeXconstantXlist_aX_foldX
    Given the empty graph
    And the traversal of
      """
      g.inject([1, 2]).merge(__.constant(["a"]).fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[d[1].i,d[2].i,l[a]] |
