Feature: mogwai addendum — a list-armed branch as an all-cardinality child-body value

  # A branch whose arms are UNIFORMLY list (union/coalesce/choose with `…fold()` arms) lowers to a
  # ListStream through the same engine over a pushed child scope (the list merge is parent-agnostic),
  # so it composes as a child body at the ALL-cardinality consumers local()/flatMap(). A union emits
  # one list per arm per input (multiset-faithful); coalesce emits the first productive arm's list.
  # map() (first-of-a-multi-output body) deliberately stays fail-closed and is not a caller here, so a
  # wrong count is never returned. Sizes (count(Scope.local)) keep the assertions order-independent.

  @gap:list-branch-child
  Scenario: g_V_1_flatMapXunionXout_fold__in_foldXX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).flatMap(__.union(__.out().fold(), __.in().fold())).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |

  @gap:list-branch-child
  Scenario: g_V_hasLabelXpersonX_localXunionXout_fold__in_foldXX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().hasLabel("person").local(__.union(__.out().fold(), __.in().fold())).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[3].l |
      | d[0].l |
      | d[2].l |
      | d[1].l |
      | d[0].l |
      | d[1].l |
      | d[1].l |
      | d[0].l |

  @gap:list-branch-child
  Scenario: g_V_1_flatMapXcoalesceXoutXknowsX_fold__outXcreatedX_foldXX_countXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V(1).flatMap(__.coalesce(__.out("knows").fold(), __.out("created").fold())).count(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A MIXED-shape branch (element + scalar arms) is likewise an all-cardinality child — it lowers to
  # a VariantStream. marko(1): out {vadas,josh,lop} + values('name') {marko} = 4 rows (global count).
  @gap:list-branch-child
  Scenario: g_V_1_localXunionXout__valuesXnameXXX_count
    Given the modern graph
    And the traversal of
      """
      g.V(1).local(__.union(__.out(), __.values("name"))).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
