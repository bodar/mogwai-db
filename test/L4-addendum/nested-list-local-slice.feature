Feature: mogwai addendum — a POSITION slice over a NESTED list (list-of-lists)

  # A local position slice (limit/range/tail/skip(Scope.local)) and reverse() over a list whose MEMBERS
  # are themselves lists keep each member WHOLE — `RangeLocalStep.applyRangeIterable` / `ReverseStep`
  # iterate by position and `resultCollection.add(item)` the member unchanged, whatever it is
  # (`vendor/tinkerpop/gremlin-core/.../step/map/RangeLocalStep.java`,
  # `.../step/map/ReverseStep.java`). So these ops admit a nested member (the door opens; the value-reading
  # arms — a string transform, order/dedup, a numeric reducer — still decline it). The sliced inner lists
  # unfold and re-enter their own member ops. @gap:nested-slice.

  @gap:nested-slice
  Scenario: g_injectXlistsX_fold_limitXlocal_2X
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4],[5,6]).fold().limit(Scope.local,2)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[d[1].i,d[2].i],l[d[3].i,d[4].i]] |

  @gap:nested-slice
  Scenario: g_injectXlistsX_fold_tailXlocal_1X
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4],[5,6]).fold().tail(Scope.local,1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[d[5].i,d[6].i]] |

  @gap:nested-slice
  Scenario: g_injectXlistsX_fold_skipXlocal_1X
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4],[5,6]).fold().skip(Scope.local,1)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[d[3].i,d[4].i],l[d[5].i,d[6].i]] |

  @gap:nested-slice
  Scenario: g_injectXlistsX_fold_reverse
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4],[5,6]).fold().reverse()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[l[d[5].i,d[6].i],l[d[3].i,d[4].i],l[d[1].i,d[2].i]] |

  # A sliced nested list still unfolds to its inner lists — the member stayed whole through the slice.
  @gap:nested-slice
  Scenario: g_injectXlistsX_fold_limitXlocal_2X_unfold
    Given the modern graph
    And the traversal of
      """
      g.inject([1,2],[3,4],[5,6]).fold().limit(Scope.local,2).unfold()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[2].i] |
      | l[d[3].i,d[4].i] |

  # An ELEMENT-list-of-lists (from a Map<K,List<vertex>>) slices with the vertices intact.
  @gap:nested-slice
  Scenario: g_V_group_selectValues_limitXlocal_1X_unfold
    Given the modern graph
    And the traversal of
      """
      g.V().has("person","name","marko").group().by("name").by(__.out().fold()).select(Column.values).limit(Scope.local,1).unfold().unfold().values("name")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |
      | lop |
      | josh |
