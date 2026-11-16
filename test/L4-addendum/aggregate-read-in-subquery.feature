Feature: mogwai addendum — a by() key subquery over a reduced value

  # `dedup().by(b)` keys each traverser by the first result of `b` run against it
  # (`vendor/tinkerpop/gremlin-core/src/main/java/org/apache/tinkerpop/gremlin/process/traversal/step/filter/DedupGlobalStep.java:77`,
  # `TraversalUtil.produce`). Over `g.V().count()` there is ONE traverser, `6L`; its key is
  # `is(gt(0)).count()` = 1, so the dedup keeps it. The key subquery reads the reduced value, and
  # fused into the block that computes it the read was re-inlined as `sum(1)` inside the subquery's
  # WHERE — "misuse of aggregate: sum()". Any node fusing over a grouped block now closes it first
  # when a subquery of its own reads an aggregate-valued column.

  Scenario: g_V_count_dedup_byXisXgtX0XX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().count().dedup().by(__.is(P.gt(0)).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |

  Scenario: g_V_count_dedup_byXfilterXisXgtX3XXX_countX
    Given the modern graph
    And the traversal of
      """
      g.V().count().dedup().by(__.filter(__.is(P.gt(3))).count())
      """
    When iterated to list
    Then the result should be unordered
      | result |
      | d[6].l |
