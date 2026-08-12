Feature: mogwai addendum — collection member filters are false on a non-collection traverser

  # The official corpus pins all() over scalar and null traversers, and none() over a scalar whose
  # predicate matches. It does not distinguish none() returning false because the host is not a
  # collection from a vacuous-truth implementation that could keep the row when the predicate does
  # not match. TinkerPop's NoneStep returns false for every non-collection host.
  @gap:non-collection-member-filter
  @Unsupported
  Scenario: g_injectX7X_noneXeqX8XX
    Given the empty graph
    And the traversal of
      """
      g.inject(7).none(P.eq(8))
      """
    When iterated to list
    Then the result should be empty
