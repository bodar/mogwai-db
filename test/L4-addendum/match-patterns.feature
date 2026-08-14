Feature: mogwai addendum — match() pattern shapes

  # The official corpus covers match() broadly but leaves these shapes to the addendum: a
  # recursive body inside a pattern, a FILTER argument (not/and/or/where binds nothing and
  # only constrains), a pattern set whose starts are all bound before the match(), and a
  # pattern whose end re-uses a bound variable (a back edge, which is a constraint fold).
  # Oracles are the modern graph: marko(1)-knows->vadas(2),josh(4); marko-created->lop(3);
  # josh-created->lop(3),ripple(5); peter(6)-created->lop(3).

  @gap:match-patterns
  @Unsupported
  Scenario: a repeat() body inside a match pattern
    # The two-hop frontier from marko: knows->josh->{lop,ripple} and created->lop (no out-edges).
    # Same answer as the explicit out().out() spelling below — a recursive body carries its own
    # `bulk`, which the binding table forwards as row multiplicity rather than a column.
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').repeat(__.out()).times(2).as('b')).select('a','b').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"marko","b":"ripple"}] |

  @gap:match-patterns
  Scenario: the same two hops spelled without repeat, as the oracle
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').out().out().as('b')).select('a','b').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"marko","b":"ripple"}] |

  @gap:match-patterns
  Scenario: every pattern start already bound before the match (no root variable)
    # marko out-degree 3; the in-degree of each of marko's neighbours: vadas 1, josh 1, lop 3.
    # So the shared 'c' constrains to the pair whose counts agree — marko(3)/lop(3).
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('b').match(__.as('a').out().count().as('c'),__.as('b').in().count().as('c')).select('a','b').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |

  @gap:match-patterns
  Scenario: a not() argument filters the binding table and binds nothing
    # marko's out-neighbours are vadas, josh (knows) and lop (created); excluding the created edge
    # leaves the two knows pairs. Only a and b come back — a filter introduces no variable.
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').out().as('b'),__.not(__.as('a').out('created').as('b'))).select('a','b').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"vadas"}] |
      | m[{"a":"marko","b":"josh"}] |

  @gap:match-patterns
  Scenario: a where(label, predicate) argument comparing two bound variables
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').has('name','marko'),__.as('a').in('knows').as('d'),__.where('d',neq('a'))).select('a','d').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |

  @gap:match-patterns
  Scenario: a where(traversal) argument reading a sibling argument's variable
    # marko-created->lop, and lop has 3 in-edges, so the existence check keeps the pair.
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.as('a').out('created').as('b'),__.where(__.as('b').in())).select('a','b').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","b":"lop"}] |
      | m[{"a":"josh","b":"lop"}] |
      | m[{"a":"josh","b":"ripple"}] |
      | m[{"a":"peter","b":"lop"}] |

  @gap:match-patterns
  Scenario: a filter written before the pattern that binds the variable it reads
    # The scheduler defers a filter until every variable it reads is bound, so argument ORDER
    # does not change the answer — the conjunction is solved as a set.
    Given the modern graph
    And the traversal of
      """
      g.V().match(__.where('a',neq('c')),__.as('a').out('created').as('b'),__.as('b').in('created').as('c')).select('a','c').by('name')
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"a":"marko","c":"josh"}] |
      | m[{"a":"marko","c":"peter"}] |
      | m[{"a":"josh","c":"marko"}] |
      | m[{"a":"josh","c":"peter"}] |
      | m[{"a":"peter","c":"marko"}] |
      | m[{"a":"peter","c":"josh"}] |
