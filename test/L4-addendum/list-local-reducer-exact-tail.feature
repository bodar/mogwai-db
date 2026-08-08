Feature: mogwai addendum — a LOCAL reducer orders by the member's own TYPE, not by its storage class

  # A value whose Gremlin type SQLite has no storage class for — a long past 2^53, a bigint, a
  # bigdecimal, a duration — is carried as decimal TEXT. Every ROW-level comparison already casts it
  # back into its numeric class before comparing (`storedCompareOn` / `compareKey`, the authority
  # `order().by()` and every range predicate share). A LIST MEMBER had no such authority, because a
  # list's member type was spelled in a second, lossier vocabulary than a row's — so `max(Scope.local)`
  # took a raw SQL `MAX()` over the payload and compared LEXICOGRAPHICALLY.
  #
  # Measured on BOTH spines before the fix: over [9007199254740993, 10007199254740993] the local
  # `max` answered the SMALLER value and `min` the larger, while the GLOBAL `max()` on the same values
  # answered correctly — one step name, two engines, and only one of them had ever been fixed. The
  # differential could not see it (§12: agreement between the two spines is evidence of a shared
  # cause, not of correctness) and no ladder assertion named the family.
  #
  # `sum(Scope.local)` had the other half of the same defect from the other direction: the eligibility
  # guard is a STORAGE-CLASS test, so a decimal-TEXT long is not `integer`/`real` and was silently
  # EXCLUDED from the total — `inject(9007199254740993L, 1L).fold().sum(Scope.local)` answered 1.
  #
  # @gap:list-local-reducer-type marks the family.

  @gap:list-local-reducer-type
  Scenario: g_injectXbig_biggerX_fold_maxXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 10007199254740993L).fold().max(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[10007199254740993].l |

  @gap:list-local-reducer-type
  Scenario: g_injectXbig_biggerX_fold_minXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 10007199254740993L).fold().min(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740993].l |

  # The exact tail must be INCLUDED in the total, and the total must come back exact — a JS number
  # would round 9007199254740994 to 9007199254740994 only by luck and 2^53+3 not at all, so the
  # result rides as decimal TEXT past 2^53 and the framer's `long` arm reads either form.
  @gap:list-local-reducer-type
  Scenario: g_injectXbig_1X_fold_sumXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(9007199254740993L, 1L).fold().sum(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[9007199254740994].l |

  # The ordinary cases keep their answers AND their exact wire class: a local min/max returns the
  # winning MEMBER, so its type is that member's own — an `int` here, not SQLite's `integer`.
  @gap:list-local-reducer-type
  Scenario: g_V_valuesXageX_fold_maxXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("age").fold().max(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[35].i |

  @gap:list-local-reducer-type
  Scenario: g_V_valuesXnameX_fold_maxXlocalX
    Given the modern graph
    And the traversal of
      """
      g.V().values("name").fold().max(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | vadas |

  # order(Scope.local) is the same authority at the other end of the family: sorting the members by
  # their raw payload puts "10007199254740993" before "9007199254740993" because a shorter digit
  # string sorts first.
  @gap:list-local-reducer-type
  Scenario: g_injectXbig_biggerX_fold_orderXlocalX
    Given the empty graph
    And the traversal of
      """
      g.inject(10007199254740993L, 9007199254740993L).fold().order(Scope.local)
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[9007199254740993].l,d[10007199254740993].l] |
