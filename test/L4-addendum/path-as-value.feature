Feature: mogwai addendum — a path as a value (count(local), unfold)

  # A Path is an Iterable of its objects: `count(local)` is its length (CountLocalStep over an Iterable —
  # vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/map/CountLocalStep.java)
  # and `unfold()` streams its objects (UnfoldStep, same package). Answers derived from the modern graph.

  Scenario: g_V_hasLabelXpersonX_path_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").path().count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
      | d[1].l |
      | d[1].l |
      | d[1].l |

  # The positions are elements here — counting them never decodes one.
  Scenario: g_V_hasXname_markoX_outE_inV_path_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").outE().inV().path().count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[3].l |
      | d[3].l |

  Scenario: g_V_hasXname_markoX_repeatXoutX_emit_path_countXlocalX_groupCount
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").repeat(__.out()).emit().path().count(Scope.local).groupCount()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"d[2].l":"d[3].l","d[3].l":"d[2].l"}] |

  Scenario: g_V_out_out_path_unfold_dedup_count
    Given the modern graph
    And the traversal of
      """
      g.V().out().out().path().unfold().dedup().count()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |

  Scenario: g_V_hasXname_markoX_out_out_path_unfold_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").out().out().path().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | josh |
      | ripple |
      | marko |
      | josh |
      | lop |

  # Each path's objects stay in position order, and the paths in the order the query imposed.
  Scenario: g_V_hasXname_markoX_out_orderXX_byXnameX_path_unfold_valuesXnameX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").out().order().by("name").path().unfold().values("name").fold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[marko,josh,marko,lop,marko,vadas] |

  # An unfolded object is a split of the path's traverser, so its labels are still readable.
  Scenario: g_V_hasXname_markoX_asXaX_out_path_unfold_selectXaX_dedup_valuesXnameX
    Given the modern graph
    And the traversal of
      """
      g.V().has("name","marko").as("a").out().path().unfold().select("a").dedup().values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
