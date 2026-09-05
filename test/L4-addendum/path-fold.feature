Feature: mogwai addendum — fold() over a path stream is a List<Path> (Path is a collection member)

  # A Path is a first-class GraphBinary value (`GremlinValueComparator.Type.Path`), so `path().fold()`
  # collects the stream of paths into ONE List<Path> — each member serializes as a PATH (labels +
  # objects, execute.ts framePath), NOT a bare list. `pathTail` used to decline every collecting barrier;
  # it now folds through a `path` member arm in the collection vocabulary (render.ts ListOf,
  # listItemBuffers/frameTypedNode, listPayloadExpr/listNodeExpr, foldPaths). This is the keystone that
  # makes a Path flow through downstream steps like any collection (per TinkerPop: a Path is just a value)
  # and, over a federated source, unblocks the path+encounter async seed.

  @gap:path-fold
  Scenario: g_V_hasXmarkoX_out_out_path_byXnameX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().has('name','marko').out().out().path().by('name').fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[p[marko,josh,lop],p[marko,josh,ripple]] |

  @gap:path-fold
  Scenario: g_V_hasXmarkoX_out_out_path_byXnameX_fold_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().has('name','marko').out().out().path().by('name').fold().count(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[2].l |

  @gap:path-fold
  Scenario: g_V_outXcreatedX_path_byXlabelX_fold_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().out('created').path().by(T.label).fold().count(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | d[4].l |
