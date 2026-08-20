Feature: mogwai addendum — a group VALUE body's barrier observes the whole partition

  # `Grouping.determineBarrierStep` (vendor/tinkerpop/gremlin-core/.../step/Grouping.java:74) makes
  # the FIRST non-local Barrier in a group's value traversal the group's REDUCER, so it accumulates
  # across every traverser that landed on the key. A `by(<pre>.fold())` is a FoldStep reducer over
  # exactly that partition, and `groupCollected` (src/compiler/rel/map.ts) builds it by POOLING the
  # pre-fold body's rows through `child.rows` — the same pool `groupReduced` sums — then collecting
  # them into a list per key. So the value barrier sees the whole partition, not one origin's rows.
  #
  # The official corpus cannot see the ORDER inside a value list. Its group scenarios assert `the
  # result should be unordered`, which compares the MAP's entries — so a child-scoped
  # `by(__.values("name").order().by(desc).fold())` returning vertex-id order still passed. These
  # scenarios pin the list order itself. They survive `mise run test:perturbed` by construction: the
  # order is an explicit aggregate ORDER BY, and PRAGMA reverse_unordered_selects leaves those alone.
  # An `order()` before the fold is safe in the shared pool because a GLOBAL total order restricted to
  # a partition IS that partition's order — which is why it composes where a partition-relative barrier
  # would not: a `dedup()` before the fold DECLINES (it collapses the pool, dropping `child.rows`'
  # origin) rather than answering a global dedup for a per-partition one.
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

  # A BARE `dedup().fold()` group value is deduped across the partition too (DISTINCT with no
  # hoisted sort key keeps the first occurrence), but it is deliberately NOT pinned here: which
  # occurrence is first depends on the scan order of the underlying bothE() rows, so the assertion
  # fails under `mise run test:perturbed` — and test/CLAUDE.md is explicit that an ordered
  # assertion is only worth writing if it survives that. The deduped CONTENT is already pinned by
  # the vendored Dedup.feature:145 scenario, which sorts. See docs/outstanding-work.md item 20.
