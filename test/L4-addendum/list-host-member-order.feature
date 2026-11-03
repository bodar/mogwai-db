Feature: mogwai addendum — a by() body's unfold() over an ELEMENT list keeps LIST order

  # `select(Pop.all, k).by(__.unfold()…fold())` opens a child body over ONE list host. `UnfoldStep`
  # iterates the List in order (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/
  # process/traversal/step/flatMap/UnfoldStep.java), so the re-collecting fold() keeps the members in
  # LIST order. The correlated element explode (`correlatedListMembers`, src/compiler/rel/list.ts) carries
  # the member position as the body's ENCOUNTER channel, as its scalar/map/list arms already did; without
  # it the fold fell back to VALUE (or scan) order — `[josh,marko]` for the path marko→josh.

  @gap:list-host-member-order
  Scenario: g_V_asXaX_out_asXaX_selectXall_aX_byXunfold_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('a').select(Pop.all, 'a').by(__.unfold().values('name').fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,lop] |
      | l[marko,vadas] |
      | l[marko,josh] |
      | l[josh,ripple] |
      | l[josh,lop] |
      | l[peter,lop] |

  # The order is the member's, not a value's: ids fold in list order too.
  @gap:list-host-member-order
  Scenario: g_V_asXaX_out_asXaX_selectXall_aX_byXunfold_id_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('a').select(Pop.all, 'a').by(__.unfold().id().fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[d[1].i,d[3].i] |
      | l[d[1].i,d[2].i] |
      | l[d[1].i,d[4].i] |
      | l[d[4].i,d[5].i] |
      | l[d[4].i,d[3].i] |
      | l[d[6].i,d[3].i] |

  # A slice in the body reads the same encounter: tail(1) is the LAST list member.
  @gap:list-host-member-order
  Scenario: g_V_asXaX_out_asXaX_selectXall_aX_byXunfold_tailX1X_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('a').select(Pop.all, 'a').by(__.unfold().tail(1).values('name').fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[lop] |
      | l[vadas] |
      | l[josh] |
      | l[ripple] |
      | l[lop] |
      | l[lop] |

  # At depth: the same body under local(), and the Pop.mixed three-hop form sliced by tail(local).
  @gap:list-host-member-order
  Scenario: g_V_asXaX_out_asXaX_localXselectXall_aX_byXunfold_valuesXnameX_foldXX
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('a').local(__.select(Pop.all, 'a').by(__.unfold().values('name').fold()))
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,lop] |
      | l[marko,vadas] |
      | l[marko,josh] |
      | l[josh,ripple] |
      | l[josh,lop] |
      | l[peter,lop] |

  @gap:list-host-member-order
  Scenario: g_V_asXaX_out_asXaX_out_asXaX_selectXmixed_aX_byXunfold_valuesXnameX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().as('a').out().as('a').out().as('a').select(Pop.mixed, 'a').by(__.unfold().values('name').fold())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | l[marko,josh,ripple] |
      | l[marko,josh,lop] |
