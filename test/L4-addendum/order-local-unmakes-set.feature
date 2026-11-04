Feature: mogwai addendum — order(Scope.local) turns a Set into a List, wherever the value travels

  # dedup(Scope.local) makes a Set (DedupLocalStep yields a LinkedHashSet). order(Scope.local) collects any
  # Collection with Collectors.toList() (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/
  # gremlin/process/traversal/step/map/OrderLocalStep.java:73-76), so the sorted result is a List. That
  # holds after as()/select() and fold() too, because SelectStep and fold() pass the object through
  # unchanged. A local slice is the contrast: RangeLocalStep keeps a Set a LinkedHashSet.

  Scenario: g_V_out_valuesXnameX_fold_dedupXlocalX_orderXlocalX_asXaX_selectXaX
    Given the modern graph
    And the traversal of
      """
      g.V().out().values("name").fold().dedup(Scope.local).order(Scope.local).as("a").select("a")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[josh,lop,ripple,vadas] |

  Scenario: g_V_out_valuesXnameX_fold_dedupXlocalX_orderXlocalX_fold
    Given the modern graph
    And the traversal of
      """
      g.V().out().values("name").fold().dedup(Scope.local).order(Scope.local).fold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[josh,lop,ripple,vadas]] |

  Scenario: g_V_out_valuesXnameX_fold_dedupXlocalX_orderXlocalX_dedupXlocalX_limitXlocal_2X
    Given the modern graph
    And the traversal of
      """
      g.V().out().values("name").fold().dedup(Scope.local).order(Scope.local).dedup(Scope.local).limit(Scope.local, 2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | s[josh,lop] |
