Feature: mogwai addendum — order/dedup(Scope.local) over a NESTED list (JS ORDERABILITY barrier)

  # A bare order(Scope.local)/dedup(Scope.local) over a list whose MEMBERS are themselves lists sorts/
  # dedups by TinkerPop's ORDERABILITY — recursive, lexicographic over lists, numeric (NOT lexical) over
  # numbers, type-priority across kinds (GremlinValueComparator.ORDERABILITY). recursion-free SQL cannot
  # express that, so it runs as the SAME sync value-transform barrier reverse()/split()/regex use: a SQL
  # head reads the nested lists, a batched JS ORDERABILITY comparator sorts/dedups them, the result re-
  # injects (orderability.ts / order-dedup-local.ts). Scope: a nested list of SCALARS (or nested scalar
  # lists/maps) AND one whose members are ELEMENTS (a Map<K,List<vertex>> value ordered whole). The element
  # case carries the members' RAW ROWIDS through the barrier (the head demotes element leaves to raw
  # scalars, `rawListElements`) and materializes only at the edge, so the result re-enters the graph:
  # unfold/read/movement all compose. Sorting is by rowid (= id on a rowid graph), the flat-case
  # element convention. @gap:nested-order.

  @gap:nested-order
  Scenario: g_injectXnested_scalarsX_fold_orderXlocalX
    Given the modern graph
    And the traversal of
      """
      g.inject([3,1,10],[3,1,9],[2]).fold().order(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[l[d[2].i],l[d[3].i,d[1].i,d[9].i],l[d[3].i,d[1].i,d[10].i]] |

  # NUMERIC, not lexical — the whole reason this is not a text sort: [10] sorts BEFORE [100], and both
  # after [9]. A JSON-text order would give [[10],[100],[9]] (wrong).
  @gap:nested-order
  Scenario: g_injectXnumbersX_fold_orderXlocalX_is_numeric
    Given the modern graph
    And the traversal of
      """
      g.inject([10],[9],[100]).fold().order(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[l[d[9].i],l[d[10].i],l[d[100].i]] |

  # dedup(Scope.local): collection equality (ordered, element-wise), FIRST occurrence wins, order kept.
  @gap:nested-order
  Scenario: g_injectXdup_listsX_fold_dedupXlocalX
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[1,2],[3]).fold().dedup(Scope.local)
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[l[d[1].i,d[2].i],l[d[3].i]] |

  # The sorted nested list unfolds to its inner lists, in the new order.
  @gap:nested-order
  Scenario: g_injectXnestedX_fold_orderXlocalX_unfold
    Given the modern graph
    And the traversal of
      """
      g.inject([3,1],[2,9],[1,5]).fold().order(Scope.local).unfold()
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | l[d[1].i,d[5].i] |
      | l[d[2].i,d[9].i] |
      | l[d[3].i,d[1].i] |

  # ELEMENT-membered nested list — a Map<K,List<vertex>> value ordered whole. The barrier carries the
  # members as RAW ROWIDS and materializes at the edge, so the sorted/deduped list RE-ENTERS the graph.
  # The assertions are ORDER-INDEPENDENT (the name multiset after unfold/unfold/read), the reference-safe
  # claim: order(local)'s OUTER sort compares vertex-lists element-wise by id, but each inner list's order
  # is out()'s iteration order (unspecified in the reference), so only the multiset is conformance-stable —
  # the exact sorted structure is regression-locked in test/compiler/nested-element-order.exec.test.ts.
  # What these prove is the round-trip: element members survive order/dedup(Scope.local) and re-source.
  @gap:nested-order
  Scenario: g_V_group_byName_byXoutFoldX_selectValues_orderXlocalX_unfold_unfold_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).order(Scope.local).unfold().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | lop |
      | lop |
      | ripple |

  # dedup(Scope.local) over the same element-membered nested list — the collapse path re-sources too.
  @gap:nested-order
  Scenario: g_V_group_byName_byXoutFoldX_selectValues_dedupXlocalX_unfold_unfold_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).dedup(Scope.local).unfold().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
      | lop |
      | lop |
      | ripple |

  # MOVEMENT after the round-trip: the re-sourced vertices take out() — proving they re-entered as real
  # graph elements, not opaque objects. out() of {vadas,lop,josh,lop,lop,ripple} = josh's created edges.
  @gap:nested-order
  Scenario: g_V_group_byName_byXoutFoldX_selectValues_orderXlocalX_unfold_unfold_out_name
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).order(Scope.local).unfold().unfold().out().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | lop |
      | ripple |

  # T.label key variant — group().by(T.label).by(fold()) gives Map<label,List<vertex>>; select(values).
  # order(local) sorts the two vertex-lists, and every vertex re-sources.
  @gap:nested-order
  Scenario: g_V_group_byLabel_byXfoldX_selectValues_orderXlocalX_unfold_unfold_name
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.fold()).select(Column.values).order(Scope.local).unfold().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko |
      | vadas |
      | josh |
      | peter |
      | lop |
      | ripple |
