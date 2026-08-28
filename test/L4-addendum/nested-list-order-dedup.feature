Feature: mogwai addendum — order/dedup(Scope.local) over a NESTED list (JS ORDERABILITY barrier)

  # A bare order(Scope.local)/dedup(Scope.local) over a list whose MEMBERS are themselves lists sorts/
  # dedups by TinkerPop's ORDERABILITY — recursive, lexicographic over lists, numeric (NOT lexical) over
  # numbers, type-priority across kinds (GremlinValueComparator.ORDERABILITY). recursion-free SQL cannot
  # express that, so it runs as the SAME sync value-transform barrier reverse()/split()/regex use: a SQL
  # head reads the nested lists, a batched JS ORDERABILITY comparator sorts/dedups them, the result re-
  # injects (orderability.ts / order-dedup-local.ts). Scope: a nested list of SCALARS (or nested scalar
  # lists/maps). An ELEMENT-membered nested list DECLINES — the barrier ships materialized vertices to JS
  # and the rowid is gone, so the result cannot re-enter the graph (a rare, non-corpus shape; fail-closed,
  # never a wrong answer). @gap:nested-order.

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

  # ELEMENT-nested DECLINES (fail-closed): a Map<K,List<vertex>> value ordered whole cannot round-trip
  # through the barrier (the vertices lose their rowids). Kept as the reference answer for when a detached-
  # element re-entry substrate lands; today it must REFUSE, never answer.
  @gap:nested-order
  @Unsupported
  Scenario: g_V_group_selectValues_orderXlocalX_element_declines
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").group().by("name").by(__.out().fold()).select(Column.values).order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[],l[v[lop]],l[v[lop],v[ripple]],l[v[vadas],v[lop],v[josh]]] |
