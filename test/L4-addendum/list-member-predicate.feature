Feature: mogwai addendum — all(P)/any(P)/none(P) test the MEMBER, and null-equality is null-aware

  # `all`/`any` shared a member-predicate builder that read `pred.value` — a field a parsed predicate
  # does not have (it is `{op, values}`) — so its "is this an eq(null)?" test was TRUE for EVERY
  # eq/neq, and both steps tested `<member> IS NULL` instead of the predicate the traversal wrote.
  # `all(P.eq("bcd"))` over `["bcd","bcd"]` therefore returned NOTHING where the list must survive.
  # A wrong answer with the right arity in the census's blind spot: an empty result and a plausible
  # one have the same digest length, and no ladder assertion named the family.
  #
  # `none` was the other half of the same concept and had the opposite gap: it went straight to the
  # ordinary predicate renderer, where `= NULL` is NULL, so `none(P.eq(null))` kept a list whose
  # member IS null. TinkerPop compares with `Objects.equals`, so all three read an eq/neq(null) as
  # `IS [NOT] NULL` — one builder, three hosts. @gap:list-member-predicate marks the family.

  @gap:list-member-predicate
  Scenario: g_injectXbcd_bcdX_allXeqXbcdXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["bcd","bcd"]).all(P.eq("bcd"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[bcd,bcd] |

  @gap:list-member-predicate
  Scenario: g_injectXabc_bcdX_allXeqXbcdXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["abc","bcd"]).all(P.eq("bcd"))
      """
    When iterated to list
    Then the result should be empty

  @gap:list-member-predicate
  Scenario: g_injectXabc_bcdX_anyXeqXbcdXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["abc","bcd"]).any(P.eq("bcd"))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[abc,bcd] |

  @gap:list-member-predicate
  Scenario: g_injectXabc_bcdX_anyXeqXzzzXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["abc","bcd"]).any(P.eq("zzz"))
      """
    When iterated to list
    Then the result should be empty

  @gap:list-member-predicate
  Scenario: g_injectXnull_nullX_allXeqXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject([null,null]).all(P.eq(null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[null,null] |

  @gap:list-member-predicate
  Scenario: g_injectXnull_abcX_allXeqXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject([null,"abc"]).all(P.eq(null))
      """
    When iterated to list
    Then the result should be empty

  @gap:list-member-predicate
  Scenario: g_injectXnull_abcX_noneXeqXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject([null,"abc"]).none(P.eq(null))
      """
    When iterated to list
    Then the result should be empty

  @gap:list-member-predicate
  Scenario: g_injectXabc_bcdX_noneXeqXnullXX
    Given the empty graph
    And the traversal of
      """
      g.inject(["abc","bcd"]).none(P.eq(null))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[abc,bcd] |
