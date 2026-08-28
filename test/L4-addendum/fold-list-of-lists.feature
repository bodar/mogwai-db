Feature: mogwai addendum — folding a LIST stream into a list-of-lists (foldLists)

  # Folding a stream whose traverser is already a list produces a list-of-lists — `fold().fold()`,
  # `map(__.out().fold()).fold()`, `inject([…],[…]).fold()`. `foldLists` (the foldScalars/foldElements/
  # foldMaps twin) collects each member's own list whole and tags the result `{kind:'list', of: inputOf}`,
  # so the ALREADY-recursive `listNodeExpr` frames the nesting at any depth — no new framing. The nested
  # list unfolds and re-enters element ops at every level. @gap:fold-nested.

  @gap:fold-nested
  Scenario: g_injectXlists_X_fold
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4]).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[d[1].i,d[2].i],l[d[3].i,d[4].i]] |

  @gap:fold-nested
  Scenario: g_V_mapXoutFoldX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").map(__.out().fold()).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[v[vadas],v[lop],v[josh]]] |

  # The nested list unfolds one level per unfold(), the leaves re-entering the element loop.
  @gap:fold-nested
  Scenario: g_V_mapXoutFoldX_fold_unfold_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").map(__.out().fold()).fold().unfold().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |

  # count() over a LIST stream counts the list traversers (a list is one traverser); count(Scope.local)
  # over the folded list counts its members. Both compose after foldLists.
  @gap:fold-nested
  Scenario: g_V_outFold_count
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").out().fold().count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |

  @gap:fold-nested
  Scenario: g_V_valuesXnameX_fold_fold_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").values("name").fold().fold().count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].l |
