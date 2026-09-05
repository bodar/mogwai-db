Feature: mogwai addendum — ordering theta over two SCALAR value aliases (COMPARABILITY, not the total order)

  # `where('b', P.gt('c'))` between two VALUE aliases is `GremlinValueComparator.COMPARABILITY`, NOT the
  # cross-type total order ORDERABILITY that order(Scope.local) uses. Compare.gt/gte/lt/lte guard with
  # `if (!COMPARABILITY.comparable(first, second)) return false;`
  # (`vendor/tinkerpop/gremlin-core/.../process/traversal/Compare.java:63-116`), and comparable() is true
  # ONLY within one Type bucket (`ft == st`, `.../util/GremlinValueComparator.java:314-363`). So an
  # ordering op is well-defined WITHIN a bucket and simply FALSE across buckets — never a wrong-answer
  # cross-type comparison. The eq/neq forms (COMPARABILITY.equals — value+type equality) already shipped;
  # this pins the ORDERING forms `comparableTheta` (src/compiler/rel/predicate.ts) now lowers, per-row, off
  # each alias's stored `t` tag. The reachable scalar buckets and the uuid-as-lexical treatment mirror
  # `orderability.ts` so the two comparators agree.

  # ---- Number bucket: two integer value aliases order numerically ----

  @gap:scalar-alias-ordering-theta
  Scenario: match_two_int_aliases_lt
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').values('age').as('b'), __.as('a').out('knows').values('age').as('c')).where('b', P.lt('c')).select('a').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |

  @gap:scalar-alias-ordering-theta
  Scenario: match_two_int_aliases_gt
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').values('age').as('b'), __.as('a').out('knows').values('age').as('c')).where('b', P.gt('c')).select('a').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |

  # ---- Number is ONE bucket across int and real: an int age vs a double weight is comparable ----

  @gap:scalar-alias-ordering-theta
  Scenario: match_int_vs_real_same_number_bucket
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').values('age').as('b'), __.as('a').outE('created').values('weight').as('c')).where('b', P.gt('c')).select('a').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |
      | josh   |
      | josh   |
      | peter  |

  # ---- String bucket: two string value aliases order lexically (natural order) ----

  @gap:scalar-alias-ordering-theta
  Scenario: match_two_string_aliases_lt
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').values('name').as('b'), __.as('a').out('knows').values('name').as('c')).where('b', P.lt('c')).select('a').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | marko  |

  # ---- CROSS-BUCKET: an int age vs a string name is NOT comparable → the ordering op is FALSE, so the
  #      whole match has no binding and the result is empty (the correctness crux — never a coerced compare) ----

  @gap:scalar-alias-ordering-theta
  Scenario: match_cross_bucket_int_vs_string_is_false
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').values('age').as('b'), __.as('a').values('name').as('c')).where('b', P.lt('c')).select('a')
      """
    When iterated to list
    Then the result should be empty
