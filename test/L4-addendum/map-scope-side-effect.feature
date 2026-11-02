Feature: mogwai addendum — a Map traverser lacking select()'s key reads the side effect next

  # `Scoping.getScopeValue` asks the traverser's OWN Map first, then the side effects, then the path
  # (vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/Scoping.java:119-135).
  # So over a MAP stream (an injected map, a `valueMap()`, a `group()`), a row whose Map lacks `k` takes the
  # `withSideEffect` constant `k` rather than dropping. Before: the row dropped — `[]` for a lone map.
  # Only a PATH LABEL fallthrough still drops (docs/feature-support-matrix.md §17, "Map scope").

  Scenario: g_withSideEffectXb_5X_injectXa1X_asXxX_selectXxX_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 5).inject(["a": 1]).as("x").select("x").select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |

  Scenario: g_withSideEffectXb_5X_injectXa1_b2X_selectXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 5).inject(["a": 1], ["b": 2]).select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[2].i |

  # The constant can itself be a Map, and a select over it reads that Map's own key.
  Scenario: g_withSideEffectXb_mapX_injectXa1X_selectXbX_selectXxX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", ["x": 1]).inject(["a": 1]).select("b").select("x")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[1].i |

  # A keyed dedup reads the same scope: `[a:1]` and `[a:3]` both key on the side effect's 5.
  Scenario: g_withSideEffectXb_5X_injectXa1_b2_a3X_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 5).inject(["a": 1], ["b": 2], ["a": 3]).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  Scenario: g_withSideEffectXb_5X_injectXa1_b5_a3_b6X_dedupXbX_count
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 5).inject(["a": 1], ["b": 5], ["a": 3], ["b": 6]).dedup("b").count()
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[2].l |

  # A LIST-valued map (`valueMap()`) that may hold the key: the entry and the scalar constant would need two
  # framings per row, so this refuses rather than drop the rows lacking `b`.
  @Unsupported
  Scenario: g_withSideEffectXb_5X_V_valueMap_selectXbX
    Given the modern graph
    And the traversal of
      """
      g.withSideEffect("b", 5).V().valueMap().select("b")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |
      | d[5].i |

  # `format()`'s named token reads the same scope (`FormatStep.java:102-104`, `getNullableScopeValue`).
  @Unsupported
  Scenario: g_withSideEffectXb_5X_injectXa1_b2X_formatXbX
    Given the empty graph
    And the traversal of
      """
      g.withSideEffect("b", 5).inject(["a": 1], ["b": 2]).format("%{b}")
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | 5 |
      | 2 |
