Feature: mogwai addendum — a merge emits the DRIVER crossed with what it merged, and the tail keeps folding

  # `mergeV` runs once per incoming traverser and emits everything its search found each time, so a
  # driver of N rows over a search matching M elements is N×M traversers. Upstream states that as a
  # loop; the RelIR route states it as a CROSS JOIN, which is the same answer and needs no branch.
  # `MergeVertex.feature`'s `g_V_mergeVXemptyX_two_exist` pins the COUNT (4 over two vertices) and
  # nothing else — not the ORDER of those four, and not that a read may follow the merge at all.
  #
  # Both of those are what this file adds, and the second is a capability the legacy spine does not
  # have: it parses everything after `mergeV()` as the merge's own `option()`/`property()` cluster and
  # refuses any other step. So the read-tail scenarios carry @RelIR — with RelIR off they assert that
  # refusal rather than being skipped, which is what keeps the divergence a declared fact instead of an
  # assumption.

  @gap:merge-driver-cross
  @RelIR
  Scenario: g_V_mergeVXemptyX_values_is_the_driver_crossed_with_the_matches
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas")
      """
    And the traversal of
      """
      g.V().mergeV([:]).values("name")
      """
    When iterated to list
    Then the result should have a count of 4
    And the result should be unordered
      | result |
      | marko |
      | marko |
      | vadas |
      | vadas |

  # THE ORDER of those four, which the count assertion cannot see. It is the loop's own: the outer
  # iteration first, and within one iteration the search's rowid order — so the first two traversers
  # are the first driver's pair, not one from each driver. A slice is what makes it observable, and a
  # slice is exactly the consumer that would silently take a different window if the position were
  # minted from a scan's incidental order instead of stated.
  @gap:merge-driver-cross
  @RelIR
  Scenario: g_V_mergeVXemptyX_limit_takes_the_first_drivers_matches
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas")
      """
    And the traversal of
      """
      g.V().mergeV([:]).limit(2).values("name")
      """
    When iterated to list
    Then the result should be ordered
      | result |
      | marko |
      | vadas |

  # A merge that CREATES gives its new vertex the same labels a creation with no label of its own
  # gets — the graph's, not the step's. `g_mergeVXemptyX_no_existing` pins that one vertex appears and
  # says nothing about what it is called, which under LabelCardinality.ONE is `vertex`.
  @gap:merge-driver-cross
  Scenario: g_mergeVXemptyX_creates_with_the_graph_default_label
    Given the empty graph
    And the traversal of
      """
      g.mergeV([:])
      """
    When iterated to list
    Then the result should have a count of 1
    And the graph should return 1 for count of "g.V().hasLabel(\"vertex\")"

  # And the read tail folds over whatever the merge emitted, matched or created — the property the
  # legacy route cannot express at all, and the reason the merge's result is an ordinary element
  # relation rather than a write response.
  @gap:merge-driver-cross
  @RelIR
  Scenario: g_mergeV_count_folds_over_the_merged_element
    Given the empty graph
    And the graph initializer of
      """
      g.addV("person").property("name", "marko").addV("person").property("name", "vadas")
      """
    And the traversal of
      """
      g.V().mergeV([:]).count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[4].l |
