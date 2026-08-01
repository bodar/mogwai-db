Feature: mogwai addendum — a group VALUE body's barrier observes the whole partition

  # `Grouping.determineBarrierStep` (vendor/tinkerpop/gremlin-core/.../step/Grouping.java:74) makes
  # the FIRST non-local Barrier in a group's value traversal the group's REDUCER, so it accumulates
  # across every traverser that landed on the key. `GroupStep.projectTraverser` feeds the value
  # traversal ONE traverser at a time — which is exactly our child scope — so a barrier compiled
  # there sees a single origin's rows and silently does nothing.
  #
  # The official corpus cannot see it. Its group scenarios assert `the result should be unordered`,
  # and an unordered assertion compares the MAP's entries, not the order INSIDE a value list — so
  # `by(__.values("name").order().by(desc).fold())` returned vertex-id order and still passed. These
  # scenarios pin the list order itself. They survive `mise run test:perturbed` by construction: the
  # order is an explicit aggregate ORDER BY, and PRAGMA reverse_unordered_selects leaves those alone.
  #
  # The dedup case is the same rule with a different aggregate (DISTINCT) and it WAS a wrong answer
  # the corpus could see: dedup per origin left duplicates in the partition's list.
  # @gap:group-value-partition-barrier marks the family.

  @gap:group-value-partition-barrier
  Scenario: g_V_group_byXlabelX_byXname_order_byXdescX_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.values("name").order().by(Order.desc).fold())
      """
    # Each vertex contributes exactly ONE name, so a child-scoped order() sorts a one-element list
    # and the partition comes out in vertex-id order (marko, vadas, josh, peter). Descending across
    # the whole partition is vadas, peter, marko, josh.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":["vadas","peter","marko","josh"],"software":["ripple","lop"]}] |

  @gap:group-value-partition-barrier
  Scenario: g_V_group_byXlabelX_byXname_order_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.values("name").order().fold())
      """
    # The ascending twin, so a direction-only by() is pinned in both directions rather than one.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":["josh","marko","peter","vadas"],"software":["lop","ripple"]}] |

  @gap:group-value-partition-barrier
  Scenario: g_V_group_byXlabelX_byXbothE_weight_dedup_foldX
    Given the modern graph
    And the traversal of
      """
      g.V().group().by(T.label).by(__.bothE().values("weight").dedup().fold())
      """
    # A bare dedup() keeps the FIRST occurrence, so the partition's order is the emission order it
    # already had — 0.5 (marko-knows-vadas) before 1.0, 0.4, then peter's 0.2. Per-origin dedup left
    # each of those repeated once per incident vertex.
    When iterated to list
    Then the result should be unordered
      | result |
      | m[{"person":[0.5,1.0,0.4,0.2],"software":[0.4,0.2,1.0]}] |
